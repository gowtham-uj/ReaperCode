/**
 * Phase T3.11 unit tests for the file-hints extraction.
 *
 * Covers:
 *   - `normalizeArtifactPathForMatch` handles backslashes, leading
 *     `./`, and trim.
 *   - `stripWorkspacePrefix` strips each Reaper sandbox layout:
 *     `/app/`, `/workspaces/<task>/workspace/`, `/reaper_eval/...`,
 *     and the generic `/<root>/workspace/` form.
 *   - `uniqueStrings` dedupes and trims.
 *   - `isGeneratedOrBuildPath` matches node_modules, .git,
 *     scratchpad, dist, build, coverage, etc.
 *   - `extractFilePathsFromFailure` finds paths in error messages
 *     and args; filters generated/build paths upstream.
 *   - `inferFilesHintFromResults` aggregates args.path / message
 *     paths, caps at 10.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  extractFilePathsFromFailure,
  inferFilesHintFromResults,
  isGeneratedOrBuildPath,
  normalizeArtifactPathForMatch,
  stripWorkspacePrefix,
  uniqueStrings,
} from "../../../src/runtime/file-hints.js";
import type { ToolResult } from "../../../src/tools/types.js";

function makeResult(overrides: Partial<ToolResult> & Pick<ToolResult, "name">): ToolResult {
  return {
    toolCallId: "tc-1",
    name: overrides.name,
    ok: overrides.ok ?? false,
    durationMs: 12,
    args: overrides.args,
    ...(overrides.output !== undefined ? { output: overrides.output } : {}),
    ...(overrides.error ? { error: overrides.error } : {}),
  };
}

test("normalizeArtifactPathForMatch replaces backslashes and strips leading ./", () => {
  assert.equal(normalizeArtifactPathForMatch("src\\foo.c"), "src/foo.c");
  assert.equal(normalizeArtifactPathForMatch("./src/foo.c"), "src/foo.c");
  assert.equal(normalizeArtifactPathForMatch("  src/foo.c  "), "src/foo.c");
  assert.equal(normalizeArtifactPathForMatch("src/foo.c"), "src/foo.c");
});

test("stripWorkspacePrefix strips /app/", () => {
  assert.equal(stripWorkspacePrefix("/app/src/foo.c"), "src/foo.c");
});

test("stripWorkspacePrefix strips /workspaces/<task>/workspace/", () => {
  assert.equal(
    stripWorkspacePrefix("/workspaces/terminal-bench-abc123/workspace/src/foo.c"),
    "src/foo.c",
  );
});

test("stripWorkspacePrefix strips /reaper_eval/workspaces/<task>/workspace/", () => {
  assert.equal(
    stripWorkspacePrefix("/reaper_eval/workspaces/terminal-bench-abc/workspace/src/foo.c"),
    "src/foo.c",
  );
});

test("stripWorkspacePrefix strips generic /<root>/workspace/", () => {
  assert.equal(
    stripWorkspacePrefix("/home/coder/workspace/src/foo.c"),
    "src/foo.c",
  );
});

test("stripWorkspacePrefix returns input unchanged when no known prefix matches", () => {
  assert.equal(stripWorkspacePrefix("src/foo.c"), "src/foo.c");
  assert.equal(stripWorkspacePrefix("relative/path.txt"), "relative/path.txt");
});

test("uniqueStrings dedupes, trims, and drops empty entries", () => {
  assert.deepEqual(uniqueStrings(["a", "b", "a", "  c  ", "", "  "]), ["a", "b", "c"]);
});

test("isGeneratedOrBuildPath matches generated/build dirs", () => {
  for (const path of [
    "node_modules/foo.js",
    ".git/config",
    "scratchpad/notes.md",
    ".reaper/state.json",
    "dist/bundle.js",
    "build/output.o",
    "coverage/lcov.info",
    ".next/cache/data",
    ".cache/foo",
    "CMakeFiles/foo.o",
    "__pycache__/foo.pyc",
    "target/release/foo",
    "a/node_modules/b",
  ]) {
    assert.equal(isGeneratedOrBuildPath(path), true, `expected true for ${path}`);
  }
});

test("isGeneratedOrBuildPath does NOT match source files", () => {
  for (const path of [
    "src/foo.ts",
    "src/components/Button.tsx",
    "tests/foo.test.ts",
    "package.json",
    "README.md",
  ]) {
    assert.equal(isGeneratedOrBuildPath(path), false, `expected false for ${path}`);
  }
});

test("isGeneratedOrBuildPath normalizes Windows backslashes", () => {
  assert.equal(isGeneratedOrBuildPath("a\\node_modules\\b"), true);
});

test("extractFilePathsFromFailure finds paths in error messages", () => {
  const result = makeResult({
    name: "bash",
    error: {
      code: "command_failed",
      message: "fatal error: src/foo.c:12:5 — undefined reference to bar",
    },
  });
  const paths = extractFilePathsFromFailure(result);
  assert.ok(paths.includes("src/foo.c"), `expected 'src/foo.c' in ${JSON.stringify(paths)}`);
});

test("extractFilePathsFromFailure includes args.path when present", () => {
  const result = makeResult({
    name: "write_file",
    args: { path: "src/foo.ts" },
    error: { code: "ENOENT", message: "no such file" },
  });
  const paths = extractFilePathsFromFailure(result);
  assert.ok(paths.includes("src/foo.ts"));
});

test("extractFilePathsFromFailure strips the workspace prefix", () => {
  const result = makeResult({
    name: "bash",
    error: {
      code: "command_failed",
      message: "fatal error: /workspaces/abc/workspace/src/foo.c:12:5 — boom",
    },
  });
  const paths = extractFilePathsFromFailure(result);
  assert.ok(paths.includes("src/foo.c"), `expected 'src/foo.c' in ${JSON.stringify(paths)}`);
});

test("extractFilePathsFromFailure dedupes when message and patterns repeat", () => {
  const result = makeResult({
    name: "bash",
    error: {
      code: "command_failed",
      message: "error: src/foo.c:1 — src/foo.c:2 — src/foo.c:3",
    },
  });
  const paths = extractFilePathsFromFailure(result);
  const occurrences = paths.filter((p) => p === "src/foo.c").length;
  assert.equal(occurrences, 1, `expected dedup'd, got ${JSON.stringify(paths)}`);
});

test("inferFilesHintFromResults aggregates paths from args across many results", () => {
  const results = [
    makeResult({ name: "read_file", args: { path: "src/a.ts" }, ok: true }),
    makeResult({ name: "read_file", args: { path: "src/b.ts" }, ok: true }),
    makeResult({ name: "write_file", args: { targetPath: "src/c.ts" }, ok: true }),
    makeResult({ name: "write_file", args: { file: "src/d.ts" }, ok: true }),
  ];
  const hint = inferFilesHintFromResults(results);
  assert.deepEqual(hint.sort(), ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
});

test("inferFilesHintFromResults filters out node_modules paths from args", () => {
  const results = [
    makeResult({ name: "read_file", args: { path: "node_modules/lodash/index.js" }, ok: true }),
    makeResult({ name: "read_file", args: { path: "src/foo.ts" }, ok: true }),
  ];
  const hint = inferFilesHintFromResults(results);
  assert.deepEqual(hint, ["src/foo.ts"]);
});

test("inferFilesHintFromResults caps at 10 entries", () => {
  const results = Array.from({ length: 20 }, (_, i) =>
    makeResult({ name: "read_file", args: { path: `src/file${i}.ts` }, ok: true }),
  );
  const hint = inferFilesHintFromResults(results);
  assert.equal(hint.length, 10);
});

test("inferFilesHintFromResults dedupes across results", () => {
  const results = [
    makeResult({ name: "read_file", args: { path: "src/foo.ts" }, ok: true }),
    makeResult({ name: "read_file", args: { path: "src/foo.ts" }, ok: true }),
    makeResult({ name: "read_file", args: { path: "src/foo.ts" }, ok: true }),
  ];
  const hint = inferFilesHintFromResults(results);
  assert.deepEqual(hint, ["src/foo.ts"]);
});

test("inferFilesHintFromResults surfaces error-message paths too", () => {
  const results = [
    makeResult({
      name: "bash",
      error: {
        code: "command_failed",
        message: "error: src/diagnostic.c:1 — undefined reference",
      },
    }),
  ];
  const hint = inferFilesHintFromResults(results);
  assert.deepEqual(hint, ["src/diagnostic.c"]);
});

test("inferFilesHintFromResults ignores non-string args.path", () => {
  const results = [
    makeResult({ name: "read_file", args: { path: 42 }, ok: true }),
    makeResult({ name: "read_file", args: { path: "" }, ok: true }),
    makeResult({ name: "read_file", args: {}, ok: true }),
  ];
  const hint = inferFilesHintFromResults(results);
  assert.deepEqual(hint, []);
});
