/**
 * Lifecycle: install / draft / test / trust via SkillLifecycle class.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillLifecycle } from "../../../src/skills/lifecycle.js";
import { SkillRegistry } from "../../../src/skills/registry.js";
import { TrustResolver } from "../../../src/skills/trust.js";
import { builtinSkillsRoot } from "../../../src/skills/built-in/index.js";
import { SkillMemoryRegistry } from "../../../src/adaptive/skill-memory-registry.js";
import type { ToolMetadata } from "../../../src/governance/tool-metadata.js";

const EMPTY_META: Record<string, ToolMetadata> = {};

function setupEnv() {
  const userHome = mkdtempSync(join(tmpdir(), "reaper-lifecycle-"));
  const builtin = builtinSkillsRoot();
  const resolver = new TrustResolver({
    builtinRoot: builtin,
    userHomeSkillsDir: join(userHome, ".reaper", "skills"),
    projectSkillsDir: join(userHome, "project", ".reaper", "skills"),
  });
  const registry = new SkillRegistry({ builtinMetadata: EMPTY_META });
  const memory = new SkillMemoryRegistry({ workspaceRoot: userHome, userHome });
  const lc = new SkillLifecycle({
    registry,
    memory,
    resolver,
    workspaceRoot: userHome,
    userHome,
    builtinRoot: builtin,
    runCommand: () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  return { userHome, lc, registry };
}

test("LC1: installFromPath writes manifest and trust.json", () => {
  const tmp = mkdtempSync(join(tmpdir(), "reaper-install-"));
  const srcDir = join(tmp, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "skill.json"), JSON.stringify({
    name: "inst-skill",
    version: "1.0.0",
    description: "Install test",
    category: "bug-fixing",
    whenToUse: "always",
    allowedTools: ["read_file"],
    trust: "user-trusted",
  }));
  writeFileSync(join(srcDir, "SKILL.md"), "# Install\n");

  const env = setupEnv();
  const result = env.lc.installFromPath({ srcPath: srcDir, scope: "user" });
  assert.ok(result.ok, `install failed: ${result.error}`);
  assert.equal(result.trust, "user-trusted");
  assert.ok(existsSync(join(env.userHome, ".reaper", "skills", "inst-skill", "skill.json")));
  rmSync(tmp, { recursive: true, force: true });
  rmSync(env.userHome, { recursive: true, force: true });
});

test("LC2: createDraft lands in drafts/ with trust=draft", () => {
  const env = setupEnv();
  const draft = env.lc.createDraft({
    name: "lifecycle-draft",
    version: "0.1.0",
    description: "Lifecycle test",
    category: "bug-fixing",
    whenToUse: "always",
    allowedTools: ["read_file"],
    trust: "draft",
  }, "# Lifecycle\n");
  assert.equal(draft.trust, "draft");
  assert.ok(existsSync(join(env.userHome, ".reaper", "skills", "drafts", "lifecycle-draft", "skill.json")));
  rmSync(env.userHome, { recursive: true, force: true });
});

test("LC3: testSkill runs validation commands and reports ok", async () => {
  const env = setupEnv();
  env.lc.createDraft({
    name: "testable-skill",
    version: "0.1.0",
    description: "Testable",
    category: "bug-fixing",
    whenToUse: "always",
    allowedTools: ["read_file"],
    trust: "draft",
    validation: { commands: [{ id: "noop", command: "true" }] },
  }, "# Testable\n");
  const out = await env.lc.testSkill("testable-skill");
  assert.equal(out.ok, true);
  rmSync(env.userHome, { recursive: true, force: true });
});
