/**
 * Skills and extensions are read from disk, not from a cache.
 *
 * The bug this pins is the one the user hit directly: the codemode skill's
 * sandbox description was corrected in `src/skills/built-in/codemode/SKILL.md`,
 * and `activate_skill` still served the old text, because the body came from
 * `.reaper/skills/index.json`, which had been written before the edit. Editing a
 * file and getting the old content back is the worst kind of staleness: nothing
 * reports an error and the only way to notice is to already know what the file
 * says.
 *
 * So a skill's body and an extension's manifest are read on every access. What
 * stays in memory is *runtime state*: whether an extension is active, whether a
 * skill's invocation counter has moved. That distinction is the whole test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillMemoryRegistry } from "../../../src/adaptive/skill-memory-registry.js";
import type { InstalledSkillRecord } from "../../../src/skills/types.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function skillRecord(name: string, skillDir: string, body: string): InstalledSkillRecord {
  const file = join(skillDir, "SKILL.md");
  writeFileSync(file, body);
  return {
    manifest: {
      name,
      version: "1.0.0",
      description: "x",
      category: "repo-understanding",
      whenToUse: "x",
      allowedTools: [],
      trust: "builtin",
    },
    body,
    sourcePath: file,
    skillDir,
    trust: "builtin",
    scope: "builtin",
    installedAt: 1,
    manifestSha256: "x",
  };
}

test("a skill's body is re-read from disk after the file changes", () => {
  const home = tempDir("live-skill-");
  try {
    const skillDir = join(home, "skills", "drifted");
    mkdirSync(skillDir, { recursive: true });
    const file = join(skillDir, "SKILL.md");

    const memory = new SkillMemoryRegistry({ workspaceRoot: home, userHome: home });
    const record = skillRecord("drifted", skillDir, "ORIGINAL BODY");
    memory.upsertSkill({
      name: "drifted",
      description: "x",
      type: "prompt",
      scope: "builtin",
      whenToUse: "x",
      disableAutoInvocation: false,
      arguments: [],
      allowedTools: [],
      memoryPolicy: {
        mayReadProjectMemory: true,
        mayWriteProjectMemory: false,
        mayReadUserMemory: false,
        mayWriteUserMemory: false,
      },
      body: record.body,
      references: [],
      sourcePath: file,
      version: 1,
      createdBy: "test",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      skillDir,
    });

    // The edit that used to be invisible: the file changes, the index does not.
    writeFileSync(file, "CORRECTED BODY");

    assert.equal(memory.getSkill("drifted")?.body, "CORRECTED BODY", "getSkill must read the file");
    assert.equal(memory.listSkills()[0]?.body, "CORRECTED BODY", "listSkills must read the file too");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a skill whose file is gone still lists, with its indexed body", () => {
  /*
   * The fallback is for a legacy record, not a cache preference: a skill that
   * was installed from a folder that has since been deleted should not vanish
   * from `listSkills` and leave the user unable to see that it exists. Its body
   * is whatever the index last recorded, which is the only copy left.
   */
  const home = tempDir("gone-skill-");
  try {
    const skillDir = join(home, "skills", "vanished");
    mkdirSync(skillDir, { recursive: true });
    const file = join(skillDir, "SKILL.md");
    const memory = new SkillMemoryRegistry({ workspaceRoot: home, userHome: home });
    const record = skillRecord("vanished", skillDir, "INDEXED BODY");
    memory.upsertSkill({
      name: "vanished",
      description: "x",
      type: "prompt",
      scope: "builtin",
      whenToUse: "x",
      disableAutoInvocation: false,
      arguments: [],
      allowedTools: [],
      memoryPolicy: {
        mayReadProjectMemory: true,
        mayWriteProjectMemory: false,
        mayReadUserMemory: false,
        mayWriteUserMemory: false,
      },
      body: record.body,
      references: [],
      sourcePath: file,
      version: 1,
      createdBy: "test",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      skillDir,
    });

    rmSync(file, { force: true });
    assert.equal(memory.getSkill("vanished")?.body, "INDEXED BODY");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
