/**
 * AC2: Loads user-global skills from ~/.reaper/skills/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills } from "../../../src/skills/discovery.js";
import { TrustResolver } from "../../../src/skills/trust.js";
import { builtinSkillsRoot } from "../../../src/skills/built-in/index.js";

test("AC2: loads user-global skills", () => {
  const tmp = mkdtempSync(join(tmpdir(), "reaper-skill-user-"));
  const userDir = join(tmp, ".reaper", "skills");
  const skillDir = join(userDir, "test-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "skill.json"),
    JSON.stringify({
      name: "test-skill",
      version: "1.0.0",
      description: "Test skill.",
      category: "bug-fixing",
      whenToUse: "always",
      allowedTools: ["read_file"],
      trust: "user-trusted",
    }),
  );
  writeFileSync(join(skillDir, "SKILL.md"), "# Test Skill\n\nSteps.\n");

  const resolver = new TrustResolver({
    builtinRoot: builtinSkillsRoot(),
    userHomeSkillsDir: userDir,
    projectSkillsDir: join(tmp, "project", ".reaper", "skills"),
  });
  const out = discoverSkills({
    builtinRoot: builtinSkillsRoot(),
    userHomeSkillsDir: userDir,
    projectSkillsDir: join(tmp, "project", ".reaper", "skills"),
    workspaceRoot: tmp,
    resolver,
  });
  const found = out.records.find((r) => r.manifest.name === "test-skill");
  assert.ok(found, "user-global skill not discovered");
  assert.equal(found?.trust, "user-trusted");
  rmSync(tmp, { recursive: true, force: true });
});
