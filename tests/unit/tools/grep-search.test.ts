/**
 * `grep_search` had no test file, and it showed.
 *
 * Three of the four defects here were argument-shape defects, which is the
 * category unit tests are *good* at — they were simply never written, because
 * the tool looked too small to need them. The fourth (a file path read as a
 * directory) only surfaced when a live model passed the argument a model would
 * naturally pass, which is the argument no hand-written test thought to try.
 *
 * Each test below names the exact answer the model used to receive, because
 * "the call fails" was never the problem. The problem was that the failure was
 * unreadable, or worse, that there was no failure at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectGrepMatches, compileGrepPattern, grepSearchTool } from "../../../src/tools/read/grep-search.js";
import { listDirectoryTool } from "../../../src/tools/read/list-directory.js";
import { WriteAheadLog } from "../../../src/recovery/wal.js";

async function workspaceWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "reaper-grep-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

/** The `code` the executor reads off a thrown error to build the model's envelope. */
function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

test("path may name a single file, not only a directory", async () => {
  // The live failure: `ENOTDIR: not a directory, scandir '…/src/legacy.ts'`.
  // The model read that as a broken tool and abandoned the call.
  const workspace = await workspaceWith({
    "src/legacy.ts": "export function handleRequest() {}\n",
    "src/other.ts": "export function handleRequest() {}\n",
  });

  const result = await grepSearchTool(workspace, { pattern: "handleRequest", path: "src/legacy.ts" });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]!.path, path.join(workspace, "src/legacy.ts"));
  assert.equal(result.matches[0]!.line, 1);
});

test("a file path is searched exactly, not widened to its directory", async () => {
  // Accepting the file path but then sweeping the parent directory would be a
  // quieter version of the same bug: the model receives hits from files it did
  // not ask about, and has no way to tell.
  const workspace = await workspaceWith({
    "src/legacy.ts": "const target = 1;\n",
    "src/other.ts": "const target = 2;\n",
  });

  const result = await grepSearchTool(workspace, { pattern: "target", path: "src/legacy.ts" });

  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0]!.path, /legacy\.ts$/);
});

test("path may still name a directory and searches it recursively", async () => {
  const workspace = await workspaceWith({
    "src/a.ts": "const target = 1;\n",
    "src/nested/b.ts": "const target = 2;\n",
  });

  const result = await grepSearchTool(workspace, { pattern: "target", path: "src" });

  assert.equal(result.matches.length, 2, "recursive walk no longer reaches nested files");
});

test("include filters a single-file search rather than being ignored", async () => {
  // `grep --include`. Applying `include` only on the directory branch would
  // make the two spellings of `path` disagree about what the same argument
  // means.
  const workspace = await workspaceWith({ "src/legacy.ts": "const target = 1;\n" });

  const included = await grepSearchTool(workspace, {
    pattern: "target",
    path: "src/legacy.ts",
    include: "**/legacy.ts",
  });
  assert.equal(included.matches.length, 1, "a matching include must still return the hit");

  const excluded = await grepSearchTool(workspace, {
    pattern: "target",
    path: "src/legacy.ts",
    include: "**/other.ts",
  });
  assert.equal(excluded.matches.length, 0, "a non-matching include must filter the hit out");
});

test("a missing path reports not_found instead of a raw errno", async () => {
  // Used to be: `ENOENT: no such file or directory, scandir '/…/src/nope.ts'` —
  // no tool name, no argument name, nothing the model can act on.
  const workspace = await workspaceWith({ "src/a.ts": "x\n" });

  await assert.rejects(
    () => grepSearchTool(workspace, { pattern: "x", path: "src/nope.ts" }),
    (error: unknown) => {
      assert.equal(errorCode(error), "not_found");
      assert.match(String((error as Error).message), /src\/nope\.ts/, "the message must name the path tried");
      assert.doesNotMatch(String((error as Error).message), /scandir|ENOENT/, "raw errno must not leak");
      return true;
    },
  );
});

test("a malformed pattern reports invalid_argument and says how to fix it", async () => {
  // Used to be: `Invalid regular expression: /(/gm: Unterminated group`. The
  // model never chose `gm`, and the message does not say which argument failed.
  const workspace = await workspaceWith({ "src/a.ts": "x\n" });

  await assert.rejects(
    () => grepSearchTool(workspace, { pattern: "(", path: "src" }),
    (error: unknown) => {
      assert.equal(errorCode(error), "invalid_argument");
      assert.match(String((error as Error).message), /Invalid search pattern/);
      assert.match(String((error as Error).message), /escape/, "the model needs to be told the fix");
      return true;
    },
  );
});

test("a workspace escape is still refused as path_escape", async () => {
  // The new `stat` before the walk must not become a way around the sandbox.
  // `normalizeWorkspacePath` still runs first, so this is really asserting the
  // fix did not move that call.
  const workspace = await workspaceWith({ "src/a.ts": "x\n" });

  await assert.rejects(
    () => grepSearchTool(workspace, { pattern: "root", path: "../../etc/passwd" }),
    (error: unknown) => {
      assert.equal((error as Error).name, "PathPolicyError");
      return true;
    },
  );
});

test("compileGrepPattern still returns a working matcher", () => {
  const regex = compileGrepPattern("a.c");
  regex.lastIndex = 0;
  assert.ok(regex.test("abc"));
  regex.lastIndex = 0;
  assert.ok(!regex.test("ac"), "the dot must remain a metacharacter, not be escaped away");
});

test("collectGrepMatches is shared, so the WAL path cannot drift from disk", async () => {
  const files = ["/a.ts", "/b.ts"];
  const contents: Record<string, string> = { "/a.ts": "hit\nmiss\nhit\n", "/b.ts": "miss\n" };

  const matches = await collectGrepMatches(files, compileGrepPattern("hit"), async (p) => contents[p] ?? "");

  assert.deepEqual(
    matches.map((m) => `${m.path}:${m.line}`),
    ["/a.ts:1", "/a.ts:3"],
    "line numbers are 1-based and every hit is reported",
  );
});

test("a WAL grep on a single file finds staged content, not an empty result", async () => {
  // The WAL copy of `grepSearch` walked with `readdir(dir).catch(() => [])`, so
  // a file path produced zero matches and `ok: true` — the same answer a
  // genuine miss gives, for a file full of matches. This is the assertion that
  // separates "found nothing" from "could not look".
  const workspace = await workspaceWith({ "src/legacy.ts": "const before = 1;\n" });
  const wal = new WriteAheadLog(workspace);
  await wal.stageWrite("src/legacy.ts", "const staged = 2;\n");

  const result = await wal.grepSearch({ pattern: "staged", path: "src/legacy.ts" });

  assert.equal(result.matches.length, 1, "the WAL grep did not see the file it was pointed at");
  assert.equal(result.matches[0]!.line, 1);
});

test("a WAL grep finds a file that exists only in the session", async () => {
  // A file created during the session is not on disk yet. If the file branch
  // only stat'd, this would return nothing and read as "no matches".
  const workspace = await workspaceWith({ "src/keep.ts": "x\n" });
  const wal = new WriteAheadLog(workspace);
  await wal.stageWrite("src/brand-new.ts", "const fresh = 1;\n");

  const result = await wal.grepSearch({ pattern: "fresh", path: "src/brand-new.ts" });

  assert.equal(result.matches.length, 1, "staged-only files are invisible to WAL grep");
});

test("a WAL grep still searches a directory recursively", async () => {
  const workspace = await workspaceWith({ "src/a.ts": "const target = 1;\n", "src/nested/b.ts": "const target = 2;\n" });
  const wal = new WriteAheadLog(workspace);

  const result = await wal.grepSearch({ pattern: "target", path: "src" });

  assert.equal(result.matches.length, 2, "the directory branch regressed");
});

// --- list_directory, same "argument shape, unreadable answer" class ---

test("list_directory explains that a file is not a directory", async () => {
  // Refusing a file here is correct — a file has no entries. The raw
  // `ENOTDIR: not a directory, scandir '…'` was not: it named no tool, no
  // argument, and no alternative. `file_view` is the answer, so the message
  // has to say so.
  const workspace = await workspaceWith({ "src/a.ts": "x\n" });

  await assert.rejects(
    () => listDirectoryTool(workspace, { path: "src/a.ts" }),
    (error: unknown) => {
      assert.equal(errorCode(error), "invalid_argument");
      assert.match(String((error as Error).message), /file_view/, "the model must be told what to use instead");
      assert.doesNotMatch(String((error as Error).message), /scandir|ENOTDIR/);
      return true;
    },
  );
});

test("list_directory reports a missing directory as not_found", async () => {
  const workspace = await workspaceWith({ "src/a.ts": "x\n" });

  await assert.rejects(
    () => listDirectoryTool(workspace, { path: "src/nope" }),
    (error: unknown) => {
      assert.equal(errorCode(error), "not_found");
      assert.doesNotMatch(String((error as Error).message), /scandir|ENOENT/);
      return true;
    },
  );
});

test("list_directory still lists a real directory and still refuses an escape", async () => {
  const workspace = await workspaceWith({ "src/a.ts": "x\n", "src/nested/b.ts": "y\n" });

  const result = await listDirectoryTool(workspace, { path: "src" });
  assert.deepEqual(result.entries, ["a.ts", "nested/"], "the happy path regressed");

  await assert.rejects(
    () => listDirectoryTool(workspace, { path: "../../etc" }),
    (error: unknown) => {
      assert.equal((error as Error).name, "PathPolicyError", "the new catch must not swallow a sandbox rejection");
      return true;
    },
  );
});

test("a WAL grep on a missing path says so rather than reporting zero matches", async () => {
  // `walk` starts with `readdir(dir).catch(() => [])`, so a path that does not
  // exist produced an empty match list and `ok: true` — indistinguishable from
  // a real miss, and the model cannot tell a typo from a genuine absence.
  const workspace = await workspaceWith({ "src/a.ts": "x\n" });
  const wal = new WriteAheadLog(workspace);

  await assert.rejects(
    () => wal.grepSearch({ pattern: "x", path: "src/nope.ts" }),
    (error: unknown) => {
      assert.equal(errorCode(error), "not_found");
      assert.match(String((error as Error).message), /src\/nope\.ts/);
      return true;
    },
  );
});

test("a WAL grep does not match content staged for deletion", async () => {
  // Grepping a deleted file's pre-deletion content would hand the model text it
  // has already removed — the opposite of what a recovery session should show.
  const workspace = await workspaceWith({ "src/gone.ts": "const doomed = 1;\n" });
  const wal = new WriteAheadLog(workspace);
  await wal.stageDelete("src/gone.ts");

  const result = await wal.grepSearch({ pattern: "doomed", path: "src/gone.ts" });

  assert.equal(result.matches.length, 0, "a deleted file must not match its old content");
});
