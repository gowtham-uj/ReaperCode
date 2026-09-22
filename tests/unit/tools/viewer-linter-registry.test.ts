/**
 * Unit tests for LinterRegistry.
 *
 * Tries to keep network and shelling to a minimum by using:
 *   - a synthetic pinned-package entry that uses `node`-built-in modules
 *     where possible (jsonc-parser is a real, ~30KB pkg, fetched once)
 *   - a runtime_command entry that points at `node --check` for in-tree
 *     JavaScript syntax checks
 *
 * Tests cover:
 *  - missing manifest is permissive-pass
 *  - manifest with one entry that is parsed correctly
 *  - timeout / exit-code semantics
 *  - pinned-package cache_hit path
 *  - install_failed gracefully reports `lint_unavailable`
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LinterRegistry } from "../../../src/tools/viewer/linter-registry.js";

/**
 * A workspace the linter registry will honour a manifest in.
 *
 * A `.reaper/linters/manifest.json` names a package that `file_edit` `require`s
 * into the app-server process, so it is only read in a trusted workspace: that
 * directory is on the trust-requiring list now, and an untrusted workspace falls
 * back to the built-in manifest. These tests are about dispatch, so they
 * establish trust the way a real user does, rather than being rewritten around a
 * rule they are not testing. `host-rce-paths.test.ts` covers the rule.
 */
async function withWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>, options: { trusted?: boolean } = { trusted: true }): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "reaper-linter-"));
  const home = path.join(root, "home");
  if (options.trusted) {
    const { mkdirSync, realpathSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.join(home, ".reaper"), { recursive: true });
    writeFileSync(
      path.join(home, ".reaper", "project-trust.json"),
      JSON.stringify({ entries: [{ workspaceRoot: realpathSync(root), trusted: true, updatedAt: Date.now() }] }),
    );
  }
  const previousHome = process.env.HOME;
  // The registry reads trust from the process home when given no store, so the
  // fixture points HOME at its own directory for the duration.
  process.env.HOME = home;
  try {
    return await fn(root);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
}

test("no linter for the requested extension returns permissive-pass verdict", async () => {
  await withWorkspace(async (workspaceRoot) => {
    // The bundled manifest only registers linters for a handful of
    // languages (.ts/.mts/.cts in this build). For any other extension
    // the dispatcher returns a permissive-pass with a `fallback_permissive`
    // source note so the model knows the edit was not linted.
    const reg = new LinterRegistry();
    const r = await reg.dispatch({
      workspaceRoot,
      absPath: "/never/used",
      content: "anything",
      extension: ".totally-unknown-extension",
      timeoutMs: 1_000,
    });
    assert.equal(r.verdict.ok, true);
    assert.equal(r.verdict.source, "fallback_permissive");
    assert.match(r.verdict.message ?? "", /falling back to permissive pass/);
  });
});

/**
 * A file with no extension must be named, not interpolated as a blank.
 *
 * `file_edit` derives the extension with `path.extname`, which is the empty
 * string for a file with no suffix. The fallback verdict used that value
 * directly, so the model was told `language: ""` and "no linter manifest entry
 * for ; falling back to permissive pass": a sentence that reads as truncated
 * because the word after "for" was nothing at all. The verdict was still a
 * pass; only its words were wrong, which is why this asserts on the text.
 */
test("a file with no extension names the case instead of interpolating a blank", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const reg = new LinterRegistry();
    const r = await reg.dispatch({
      workspaceRoot,
      absPath: path.join(workspaceRoot, "Makefile"),
      content: "all:\n\techo hi\n",
      extension: "",
      timeoutMs: 1_000,
    });
    assert.equal(r.verdict.ok, true);
    assert.equal(r.verdict.source, "fallback_permissive");
    assert.notEqual(r.verdict.language, "", "the language must not be an empty string");
    assert.match(
      r.verdict.message ?? "",
      /no extension/,
      `the message must say what was missing, got: ${JSON.stringify(r.verdict.message)}`,
    );
    assert.doesNotMatch(r.verdict.message ?? "", /entry for ;/);
  });
});

test("matchExtension returns the right entry from a hand-written manifest", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const manifestPath = path.join(workspaceRoot, ".reaper", "linters", "manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        defaultTimeoutMs: 1000,
        installTimeoutMs: 1000,
        entries: [
          {
            kind: "runtime_command",
            extensions: [".injected"],
            languages: ["injected"],
            command: ["node", "-e", "process.exit(0)"],
            fileArgIndex: 99,
          },
        ],
      }),
      "utf8",
    );
    const reg = new LinterRegistry();
    const m = await reg.matchExtension(workspaceRoot, ".injected");
    assert.ok(m);
    assert.equal(m?.languages[0], "injected");
  });
});

test("runtime_command path returns ok on clean exit", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const manifestPath = path.join(workspaceRoot, ".reaper", "linters", "manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        defaultTimeoutMs: 5000,
        entries: [
          {
            kind: "runtime_command",
            extensions: [".ok"],
            languages: ["ok"],
            command: ["node", "-e", "process.exit(0)"],
            fileArgIndex: 99,
          },
        ],
      }),
      "utf8",
    );
    const reg = new LinterRegistry();
    const r = await reg.dispatch({
      workspaceRoot,
      absPath: "/never/used",
      content: "irrelevant",
      extension: ".ok",
      timeoutMs: 5_000,
    });
    assert.equal(r.verdict.ok, true);
    assert.equal(r.verdict.source, "manifest_runtime");
  });
});

test("runtime_command captures exit code + line on failure", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const manifestPath = path.join(workspaceRoot, ".reaper", "linters", "manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        defaultTimeoutMs: 5000,
        entries: [
          {
            kind: "runtime_command",
            extensions: [".bad"],
            languages: ["bad"],
            command: [
              "node",
              "-e",
              'process.stderr.write("parse error on line 7\\n"); process.exit(2)',
            ],
            fileArgIndex: 99,
          },
        ],
      }),
      "utf8",
    );
    const reg = new LinterRegistry();
    const r = await reg.dispatch({
      workspaceRoot,
      absPath: "/never/used",
      content: "irrelevant",
      extension: ".bad",
      timeoutMs: 5_000,
    });
    assert.equal(r.verdict.ok, false);
    assert.match(r.verdict.message ?? "", /exited with code 2/);
    assert.equal(r.verdict.line, 7);
  });
});

test("extension not in manifest → permissive-pass", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const manifestPath = path.join(workspaceRoot, ".reaper", "linters", "manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            kind: "runtime_command",
            extensions: [".known"],
            languages: ["known"],
            command: ["node", "-e", "process.exit(0)"],
            fileArgIndex: 99,
          },
        ],
      }),
      "utf8",
    );
    const reg = new LinterRegistry();
    const r = await reg.dispatch({
      workspaceRoot,
      absPath: "/never/used",
      content: "irrelevant",
      extension: ".unknown",
      timeoutMs: 1_000,
    });
    assert.equal(r.verdict.ok, true);
    assert.equal(r.verdict.source, "fallback_permissive");
  });
});

test("malformed manifest raises — caller surfaces lint_unavailable", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const manifestPath = path.join(workspaceRoot, ".reaper", "linters", "manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, "{ not valid json", "utf8");
    const reg = new LinterRegistry();
    await assert.rejects(
      () =>
        reg.dispatch({
          workspaceRoot,
          absPath: "/never/used",
          content: "irrelevant",
          extension: ".ts",
          timeoutMs: 1_000,
        }),
      /manifest at .*manifest\.json is not valid JSON/,
    );
  });
});
