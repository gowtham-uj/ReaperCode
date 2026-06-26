import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadContextFiles,
  type ContextFileLoadOptions,
} from "../../src/resources/context-files.js";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

test("loads project context files in priority order", async () => {
  const workspaceRoot = await tempDir("reaper-context-");
  await mkdir(path.join(workspaceRoot, ".reaper"), { recursive: true });
  await writeFile(path.join(workspaceRoot, ".reaper/context.md"), "# Project context\nUse tabs.");
  const result = await loadContextFiles({ workspaceRoot, trusted: true });
  assert.equal(result.files.length, 1);
  const first = result.files[0]!;
  assert.equal(first.source, ".reaper/context.md");
  assert.ok(first.content.includes("Use tabs"));
  assert.ok(result.combined.includes("<<<PROJECT_CONTEXT"));
});

test("excludes project context files when workspace is not trusted", async () => {
  const workspaceRoot = await tempDir("reaper-context-");
  await mkdir(path.join(workspaceRoot, ".reaper"), { recursive: true });
  await writeFile(path.join(workspaceRoot, ".reaper/context.md"), "secret");
  const result = await loadContextFiles({ workspaceRoot, trusted: false });
  assert.equal(result.files.length, 0);
  assert.ok(result.diagnostics[0]?.includes("not trusted"));
});

test("loads user context files when provided", async () => {
  const workspaceRoot = await tempDir("reaper-context-");
  const userHome = await tempDir("reaper-user-");
  await mkdir(path.join(userHome, ".config/reaper"), { recursive: true });
  await writeFile(path.join(userHome, ".config/reaper/context.md"), "# User context\nSoft tabs.");
  const result = await loadContextFiles({ workspaceRoot, userHome, trusted: true });
  assert.equal(result.files.length, 1);
  const first = result.files[0]!;
  assert.equal(first.source, path.join("~/.config/reaper/context.md"));
});

test("truncates oversized context files and records diagnostics", async () => {
  const workspaceRoot = await tempDir("reaper-context-");
  await mkdir(path.join(workspaceRoot, ".reaper"), { recursive: true });
  await writeFile(path.join(workspaceRoot, ".reaper/context.md"), "x".repeat(5000));
  const result = await loadContextFiles({ workspaceRoot, trusted: true, maxFileBytes: 1000 });
  const first = result.files[0]!;
  assert.ok(first.content.length < 2000);
  assert.ok(result.diagnostics.some((d) => d.includes("truncated")));
});

test("prioritizes project .reaper/context.md over AGENTS.md and CLAUDE.md", async () => {
  const workspaceRoot = await tempDir("reaper-context-");
  await mkdir(path.join(workspaceRoot, ".reaper"), { recursive: true });
  await writeFile(path.join(workspaceRoot, ".reaper/context.md"), "reaper");
  await writeFile(path.join(workspaceRoot, "AGENTS.md"), "agents");
  await writeFile(path.join(workspaceRoot, "CLAUDE.md"), "claude");
  const result = await loadContextFiles({ workspaceRoot, trusted: true });
  const names = result.files.map((f) => f.source);
  assert.equal(names[0], ".reaper/context.md");
  assert.equal(names[1], "AGENTS.md");
  assert.equal(names[2], "CLAUDE.md");
});
