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
    allowedTools: ["file_view"],
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

test("LC2: createDraft lands in the user skills root, trusted and ready to use", () => {
  /*
   * It used to land in `drafts/` with `trust: "draft"`, and that was the bug:
   * discovery does not walk `drafts/`, so `activate_skill` could not find a
   * skill that had just been created, and `uninstall` — which searches the user
   * root — could not remove it either. Creating worked and nothing downstream
   * did.
   *
   * There is no approval step. A skill the user asked for is a skill the user
   * wants, and it is usable the moment this returns.
   */
  const env = setupEnv();
  const created = env.lc.createDraft({
    name: "lifecycle-skill",
    version: "0.1.0",
    description: "Lifecycle test",
    category: "bug-fixing",
    whenToUse: "always",
    allowedTools: ["file_view"],
    trust: "user-trusted",
  }, "# Lifecycle\n");
  assert.equal(created.trust, "user-trusted");
  assert.ok(
    existsSync(join(env.userHome, ".reaper", "skills", "lifecycle-skill", "skill.json")),
    "the skill must land where discovery walks, or activation cannot see it",
  );
  assert.equal(
    existsSync(join(env.userHome, ".reaper", "skills", "drafts", "lifecycle-skill")),
    false,
    "nothing should be written to drafts/ — that directory is why create was a dead end",
  );
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
    allowedTools: ["file_view"],
    trust: "draft",
    validation: { commands: [{ id: "noop", command: "true" }] },
  }, "# Testable\n");
  const out = await env.lc.testSkill("testable-skill");
  assert.equal(out.ok, true);
  rmSync(env.userHome, { recursive: true, force: true });
});

/**
 * The default command runner must actually be a shell.
 *
 * Every other test in this file injects `runCommand`, so the default was never
 * executed by anything — and it was broken. It called
 * `require("node:child_process")` inside an ESM module, where `require` does not
 * exist, so it threw and the catch reported `{ exitCode: 127, stderr: "require
 * is not defined" }`. Every validation command failed regardless of its text,
 * and the message pointed at the user's command rather than at this function.
 *
 * Found by a user running `skill_manager test` on a skill whose entire
 * validation was `echo probe-skill-ok`: exit 127, "require is not defined".
 * The fix is a real import, and this test is the one that would have caught it,
 * so it deliberately does NOT inject a runner.
 */
test("LC9: the default runCommand executes through a shell", async () => {
  const userHome = mkdtempSync(join(tmpdir(), "reaper-default-runner-"));
  try {
    const builtin = builtinSkillsRoot();
    const resolver = new TrustResolver({
      builtinRoot: builtin,
      userHomeSkillsDir: join(userHome, ".reaper", "skills"),
      projectSkillsDir: join(userHome, "project", ".reaper", "skills"),
    });
    const registry = new SkillRegistry({ builtinMetadata: EMPTY_META });
    const memory = new SkillMemoryRegistry({ workspaceRoot: userHome, userHome });
    // No `runCommand`: this is the default path, which is the point.
    const lc = new SkillLifecycle({
      registry,
      memory,
      resolver,
      workspaceRoot: userHome,
      userHome,
      builtinRoot: builtin,
    });

    const dir = join(userHome, ".reaper", "skills", "shell-skill");
    mkdirSync(dir, { recursive: true });
    const manifest = {
      name: "shell-skill",
      version: "1.0.0",
      description: "proves the validation runner is a shell",
      triggers: [],
      trust: "user-trusted" as const,
      validation: { commands: [{ id: "echo-check", command: "echo probe-skill-ok" }] },
    };
    writeFileSync(join(dir, "skill.json"), JSON.stringify(manifest, null, 2));
    registry.register({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      triggers: [],
      trust: "user-trusted",
      scope: "user",
      skillDir: dir,
      sourcePath: dir,
      manifest,
    } as never);

    const out = await lc.testSkill("shell-skill");
    assert.equal(
      out.error,
      undefined,
      `the default runner failed: ${out.error ?? ""} ${JSON.stringify(out.results)}`,
    );
    assert.equal(out.ok, true);
    assert.equal(out.results[0]?.exitCode, 0, "`echo` must exit 0 — a shell finds it, a JS evaluator does not");
    assert.doesNotMatch(
      out.results[0]?.stderr ?? "",
      /require is not defined/,
      "the runner is evaluating JavaScript instead of running a shell command",
    );
  } finally {
    rmSync(userHome, { recursive: true, force: true });
  }
});
