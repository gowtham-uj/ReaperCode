/**
 * diff-capture.test.ts — smoke tests for the unified-diff
 * reconstruction in `diffForToolCall` and the language-id
 * mapping in `langForExt`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { diffForToolCall, langForExt, isMutatingTool } from "../../../src/tui/diff-capture.js";

function tmpWorkspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "tui-diff-"));
  return {
    dir,
    cleanup: () => {
      try {
        const { rmSync } = require("node:fs") as typeof import("node:fs");
        rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    },
  };
}

test("diff-capture: write_file produces a diff with one add hunk", () => {
  const ws = tmpWorkspace();
  const args = { path: "new.ts", content: "const x = 1\nconst y = 2\n" };
  const diff = diffForToolCall("write_file", args, ws.dir);
  assert.ok(diff);
  assert.equal(diff.path, "new.ts");
  assert.equal(diff.before, "");
  assert.equal(diff.after, "const x = 1\nconst y = 2\n");
  assert.ok(diff.hunks.length >= 1, "expected at least one hunk");
  // All non-hunk lines should be adds.
  const lines = diff.hunks[0]!.lines;
  const adds = lines.filter((l) => l.kind === "add");
  assert.equal(adds.length, 2);
  assert.equal(diff.language, "ts");
});

test("diff-capture: edit_file produces ctx + del + add", () => {
  const ws = tmpWorkspace();
  writeFileSync(join(ws.dir, "hello.js"), "line a\nline b\nline c\n", "utf8");
  const args = {
    path: "hello.js",
    find: "line b",
    new_string: "LINE B",
  };
  const diff = diffForToolCall("edit_file", args, ws.dir);
  assert.ok(diff);
  assert.equal(diff.language, "js");
  // Walk all hunks for the kinds we expect.
  const all = diff.hunks.flatMap((h) => h.lines);
  const kinds = new Set(all.map((l) => l.kind));
  assert.ok(kinds.has("ctx"));
  assert.ok(kinds.has("del"));
  assert.ok(kinds.has("add"));
});

test("diff-capture: replace_in_file is the same as edit_file for our purposes", () => {
  const ws = tmpWorkspace();
  writeFileSync(join(ws.dir, "x.md"), "old\n", "utf8");
  const diff = diffForToolCall("replace_in_file", { path: "x.md", find: "old", replace: "new" }, ws.dir);
  assert.ok(diff);
  assert.equal(diff.language, "md");
});

test("diff-capture: non-mutating tool returns null", () => {
  assert.equal(diffForToolCall("run_shell_command", { command: "ls" }, "/tmp"), null);
  assert.equal(diffForToolCall("read_file", { path: "x" }, "/tmp"), null);
});

test("diff-capture: isMutatingTool returns the right tool names", () => {
  assert.equal(isMutatingTool("write_file"), true);
  assert.equal(isMutatingTool("edit_file"), true);
  assert.equal(isMutatingTool("replace_in_file"), true);
  assert.equal(isMutatingTool("create_file"), true);
  assert.equal(isMutatingTool("read_file"), false);
  assert.equal(isMutatingTool("run_shell_command"), false);
});

test("diff-capture: langForExt maps common extensions", () => {
  assert.equal(langForExt(".ts"), "ts");
  assert.equal(langForExt(".tsx"), "ts");
  assert.equal(langForExt(".js"), "js");
  assert.equal(langForExt(".json"), "json");
  assert.equal(langForExt(".py"), "python");
  assert.equal(langForExt(".md"), "md");
  assert.equal(langForExt(".yaml"), "yaml");
  assert.equal(langForExt(".yml"), "yaml");
  assert.equal(langForExt(".rs"), "rust");
  assert.equal(langForExt(".go"), "go");
  assert.equal(langForExt(".sh"), "bash");
  assert.equal(langForExt(".bash"), "bash");
  assert.equal(langForExt(".diff"), "diff");
  assert.equal(langForExt(".unknown_ext"), undefined);
  assert.equal(langForExt(""), undefined);
  assert.equal(langForExt("."), undefined);
});