/**
 * Tests for the activate_skill tool (S1 hardening).
 *
 * Verifies:
 *   1. Path-traversal protection (rejects .., absolute, slashes, hidden)
 *   2. Registry allowlist (unregistered skill is rejected)
 *   3. disableModelInvocation guard
 *   4. Symlink escape detection (rejected)
 *   5. Happy path: registered + on-disk file is read
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { activateSkillTool } from "../../src/tools/read/activate-skill.js";
import { SkillMemoryRegistry } from "../../src/adaptive/skill-memory-registry.js";
import type { ReaperSkill } from "../../src/adaptive/types.js";

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "reaper-activate-skill-"));
}

function register(workspaceRoot: string, skill: Partial<ReaperSkill>): void {
  const reg = new SkillMemoryRegistry({ workspaceRoot });
  reg.upsertSkill({
    name: skill.name ?? "default",
    description: skill.description ?? "test",
    type: skill.type ?? "behavioral",
    scope: skill.scope ?? "project",
    whenToUse: skill.whenToUse ?? "test",
    disableAutoInvocation: skill.disableAutoInvocation ?? false,
    arguments: skill.arguments ?? [],
    allowedTools: skill.allowedTools ?? [],
    memoryPolicy: skill.memoryPolicy ?? { type: "ephemeral" },
    body: skill.body ?? "# body",
    references: skill.references ?? [],
    ...(skill.disableModelInvocation !== undefined ? { disableModelInvocation: skill.disableModelInvocation } : {}),
  } as ReaperSkill);
}

test("S1: rejects .. in the name (path traversal)", async () => {
  const ws = makeWorkspace();
  try {
    await assert.rejects(
      () => activateSkillTool(ws, { name: "../etc/passwd" }),
      /path separators|relative-path component/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("S1: rejects absolute paths in the name", async () => {
  const ws = makeWorkspace();
  try {
    await assert.rejects(
      () => activateSkillTool(ws, { name: "/etc/passwd" }),
      /path separators|must be relative/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("S1: rejects names with slashes", async () => {
  const ws = makeWorkspace();
  try {
    await assert.rejects(
      () => activateSkillTool(ws, { name: "sub/dir" }),
      /path separators/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("S1: rejects names starting with .", async () => {
  const ws = makeWorkspace();
  try {
    await assert.rejects(
      () => activateSkillTool(ws, { name: ".hidden" }),
      /relative-path component/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("S1: rejects an empty name", async () => {
  const ws = makeWorkspace();
  try {
    await assert.rejects(
      () => activateSkillTool(ws, { name: "" }),
      /non-empty string/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("S1: rejects a non-string name", async () => {
  const ws = makeWorkspace();
  try {
    await assert.rejects(
      // @ts-expect-error - intentional bad input
      () => activateSkillTool(ws, { name: 42 }),
      /non-empty string/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("S1: rejects an unregistered skill (registry allowlist)", async () => {
  const ws = makeWorkspace();
  try {
    // On-disk file exists but not in the registry.
    mkdirSync(path.join(ws, ".reaper", "skills"), { recursive: true });
    writeFileSync(path.join(ws, ".reaper", "skills", "ghost.md"), "# ghost");
    await assert.rejects(
      () => activateSkillTool(ws, { name: "ghost" }),
      /not registered in the SkillMemoryRegistry/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("S1: rejects a skill with disableModelInvocation=true", async () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(path.join(ws, ".reaper", "skills"), { recursive: true });
    writeFileSync(path.join(ws, ".reaper", "skills", "locked.md"), "# locked");
    register(ws, { name: "locked", disableModelInvocation: true });
    await assert.rejects(
      () => activateSkillTool(ws, { name: "locked" }),
      /disableModelInvocation=true/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("S1: rejects a skill with disableAutoInvocation=true (legacy alias)", async () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(path.join(ws, ".reaper", "skills"), { recursive: true });
    writeFileSync(path.join(ws, ".reaper", "skills", "legacy.md"), "# legacy");
    register(ws, { name: "legacy", disableAutoInvocation: true });
    await assert.rejects(
      () => activateSkillTool(ws, { name: "legacy" }),
      /disableModelInvocation=true/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("S1: rejects a symlink that escapes the workspace", async (t) => {
  const ws = makeWorkspace();
  const outsideDir = mkdtempSync(path.join(tmpdir(), "reaper-activate-skill-outside-"));
  try {
    // Create a target file outside the workspace.
    writeFileSync(path.join(outsideDir, "evil.md"), "# evil");
    // Create a symlink inside the workspace skill dir that points to it.
    mkdirSync(path.join(ws, ".reaper", "skills"), { recursive: true });
    try {
      symlinkSync(path.join(outsideDir, "evil.md"), path.join(ws, ".reaper", "skills", "evil.md"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symlink creation requires elevated privileges on this platform");
        return;
      }
      throw error;
    }
    // Register the skill.
    register(ws, { name: "evil" });
    await assert.rejects(
      () => activateSkillTool(ws, { name: "evil" }),
      /outside the allowed skill directories/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("S1: happy path — registered skill with on-disk .md is returned", async () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(path.join(ws, ".reaper", "skills"), { recursive: true });
    writeFileSync(
      path.join(ws, ".reaper", "skills", "happy.md"),
      "---\ntitle: happy\n---\n# body content\n",
    );
    register(ws, { name: "happy", body: "# body content" });
    const out = await activateSkillTool(ws, { name: "happy" });
    assert.match(out, /^<activated_skill>/);
    assert.match(out, /body content/);
    // Frontmatter should be stripped.
    assert.doesNotMatch(out, /title: happy/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("S1: happy path — registered skill with SKILL.md in a directory is returned", async () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(path.join(ws, ".opencode", "skills", "dirskill"), { recursive: true });
    writeFileSync(path.join(ws, ".opencode", "skills", "dirskill", "SKILL.md"), "# from dir");
    register(ws, { name: "dirskill" });
    const out = await activateSkillTool(ws, { name: "dirskill" });
    assert.match(out, /from dir/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("S1: registered skill with no on-disk file gives a clear error", async () => {
  const ws = makeWorkspace();
  try {
    register(ws, { name: "ghost-file" });
    await assert.rejects(
      () => activateSkillTool(ws, { name: "ghost-file" }),
      /registered in the registry but no on-disk file was found/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
