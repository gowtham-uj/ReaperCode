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

test("omits project AGENTS/CLAUDE context files when workspace is not trusted", async () => {
  const workspaceRoot = await tempDir("reaper-context-");
  await mkdir(path.join(workspaceRoot, ".reaper"), { recursive: true });
  await writeFile(path.join(workspaceRoot, ".reaper/context.md"), "protected");
  await writeFile(path.join(workspaceRoot, "AGENTS.MD"), "agent rules");
  await writeFile(path.join(workspaceRoot, "CLAUDE.md"), "claude rules");
  const result = await loadContextFiles({ workspaceRoot, trusted: false });
  assert.deepEqual(result.files.map((f) => f.source.toLowerCase()), []);
  assert.ok(!result.combined.includes("agent rules"));
  assert.ok(!result.combined.includes("protected"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes("not trusted")));
});

test("loads user context files when provided", async () => {
  const workspaceRoot = await tempDir("reaper-context-");
  const userHome = await tempDir("reaper-user-");
  await mkdir(path.join(userHome, ".config/reaper"), { recursive: true });
  await writeFile(path.join(userHome, ".config/reaper/context.md"), "# User context\nSoft tabs.");
  const result = await loadContextFiles({ workspaceRoot, userHome, trusted: true });
  assert.equal(result.files.length, 1);
  const first = result.files[0]!;
  assert.equal(first.source, "~/.config/reaper/context.md");
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

test("walks ancestor dirs for AGENTS.md with content-hash dedup", async () => {
  const parent = await tempDir("reaper-context-parent-");
  // Ceiling so we do not walk past the fixture into the host filesystem.
  await mkdir(path.join(parent, ".git"), { recursive: true });
  const workspaceRoot = path.join(parent, "pkg");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(parent, "AGENTS.md"), "shared monorepo rules");
  await writeFile(path.join(workspaceRoot, "AGENTS.md"), "shared monorepo rules");
  await writeFile(path.join(workspaceRoot, "REAPER.md"), "local reaper rules");
  await writeFile(path.join(parent, ".cursorrules"), "cursor rules");

  const result = await loadContextFiles({ workspaceRoot, trusted: true });
  const sources = result.files.map((f) => f.source);
  // Duplicate AGENTS.md content: only first (workspace) kept.
  assert.equal(sources.filter((s) => s === "AGENTS.md" || s.endsWith("AGENTS.md")).length, 1);
  assert.ok(sources.includes("REAPER.md"));
  assert.ok(sources.some((s) => s.includes(".cursorrules")));
  assert.ok(result.diagnostics.some((d) => d.includes("duplicate")));
});

test("defaults allow larger project-rule budgets (8KB/32KB)", async () => {
  const workspaceRoot = await tempDir("reaper-context-");
  const body = "y".repeat(5000);
  await writeFile(path.join(workspaceRoot, "AGENTS.md"), body);
  const result = await loadContextFiles({ workspaceRoot, trusted: true });
  const agents = result.files.find((f) => f.source === "AGENTS.md");
  assert.ok(agents);
  assert.equal(agents!.truncated, false);
  assert.ok(agents!.content.length >= 5000);
});

test("preserves user instructions before project rules when total budget is tight", async () => {
  const workspaceRoot = await tempDir("reaper-context-");
  const userHome = await tempDir("reaper-user-");
  await mkdir(path.join(userHome, ".config/reaper"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "AGENTS.md"), "PROJECT_RULES");
  await writeFile(path.join(userHome, ".config/reaper/context.md"), "USER_RULES_MUST_SURVIVE");
  const result = await loadContextFiles({
    workspaceRoot,
    userHome,
    trusted: true,
    maxTotalBytes: 120,
  });
  assert.ok(!result.combined.includes("PROJECT_RULES"));
  assert.ok(result.combined.includes("USER_RULES_MUST_SURVIVE"));
  assert.ok(result.diagnostics.some((d) => d.includes("truncated")));
});
