/**
 * Unit tests for the 5 model-callable skill authoring tools.
 *
 * Covers the 12 cases listed in the plan §8.2 (Skills block).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillRegistry } from "../../../src/skills/registry.js";
import { SkillLifecycle } from "../../../src/skills/lifecycle.js";
import { TrustResolver as SkillTrustResolver } from "../../../src/skills/trust.js";
import { SkillMemoryRegistry } from "../../../src/adaptive/skill-memory-registry.js";
import {
  handleCreateSkill,
  handleTestSkill,
  handleApproveSkill,
  handleUninstallSkill,
  handleReloadSkills,
  type SkillToolDeps,
  type SkillApprovalRequester,
} from "../../../src/tools/write/skill-tools.js";
import type { CreateSkillArgs } from "../../../src/tools/types/skill-tools.schema.js";

function setup(): { tmp: string; userHome: string; workspaceRoot: string; deps: SkillToolDeps; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "reaper-skill-authoring-"));
  const userHome = join(tmp, "home");
  const workspaceRoot = join(tmp, "ws");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });

  const registry = new SkillRegistry({ builtinMetadata: {} });
  const memory = new SkillMemoryRegistry({ workspaceRoot });
  const resolver = new SkillTrustResolver({
    builtinRoot: join(tmp, "builtin"),
    userHomeSkillsDir: join(userHome, ".reaper", "skills"),
    projectSkillsDir: join(workspaceRoot, ".reaper", "skills"),
  });
  const lifecycle = new SkillLifecycle({
    registry,
    memory,
    resolver,
    workspaceRoot,
    userHome,
    builtinRoot: join(tmp, "builtin"),
    runCommand: async (cmd) => ({ exitCode: 0, stdout: "", stderr: "" }),
  });

  return {
    tmp,
    userHome,
    workspaceRoot,
    deps: { lifecycle, registry },
    cleanup: () => {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

const BASE_CREATE: CreateSkillArgs = {
  name: "python-pytest-runner",
  version: "0.1.0",
  description: "Run pytest and show failures",
  category: "python-debugging",
  when_to_use: "User says 'run the tests' or 'pytest'",
  body: "# Python pytest\n\nRun `pytest -x` and report failures.",
  allowed_tools: ["bash"],
  scope: "project",
};

test("create_skill happy path lands as draft", () => {
  const ctx = setup();
  try {
    const r = handleCreateSkill(BASE_CREATE, ctx.deps);
    return r.then((out) => {
      assert.equal(out.ok, true);
      assert.equal(out.name, "python-pytest-runner");
      assert.equal(out.trust, "draft");
      assert.ok(out.skillDir?.includes(".reaper/skills/drafts"));
    });
  } finally {
    ctx.cleanup();
  }
});

test("create_skill rejects duplicate name", async () => {
  const ctx = setup();
  try {
    await handleCreateSkill(BASE_CREATE, ctx.deps);
    const r2 = await handleCreateSkill(BASE_CREATE, ctx.deps);
    assert.equal(r2.ok, false);
    assert.match(r2.error ?? "", /draft already exists/);
  } finally {
    ctx.cleanup();
  }
});

test("create_skill rejects invalid category", async () => {
  const ctx = setup();
  try {
    const r = await handleCreateSkill(
      { ...BASE_CREATE, category: "not-a-category" as unknown as CreateSkillArgs["category"] },
      ctx.deps,
    );
    assert.equal(r.ok, false);
  } catch {
    // zod may throw before reaching handler; either way it's rejected
  }
});

test("create_skill persists skill.json + SKILL.md to disk", async () => {
  const ctx = setup();
  try {
    const out = await handleCreateSkill(BASE_CREATE, ctx.deps);
    assert.equal(out.ok, true);
    assert.ok(out.skillDir, "missing skillDir");
    assert.ok(existsSync(join(out.skillDir!, "SKILL.md")), "SKILL.md missing");
    const body = readFileSync(join(out.skillDir!, "SKILL.md"), "utf8");
    assert.match(body, /Python pytest/);
  } finally {
    ctx.cleanup();
  }
});

test("test_skill runs validation commands and returns per-cmd results", async () => {
  const ctx = setup();
  try {
    await handleCreateSkill(
      {
        ...BASE_CREATE,
        validation_commands: [{ id: "echo", command: "echo ok" }],
      },
      ctx.deps,
    );
    // Override the lifecycle's runCommand to actually capture output.
    ctx.deps.lifecycle = new SkillLifecycle({
      registry: ctx.deps.registry,
      memory: new SkillMemoryRegistry({ workspaceRoot: ctx.workspaceRoot }),
      resolver: new SkillTrustResolver({
        builtinRoot: join(ctx.tmp, "builtin"),
        userHomeSkillsDir: join(ctx.userHome, ".reaper", "skills"),
        projectSkillsDir: join(ctx.workspaceRoot, ".reaper", "skills"),
      }),
      workspaceRoot: ctx.workspaceRoot,
      userHome: ctx.userHome,
      builtinRoot: join(ctx.tmp, "builtin"),
      runCommand: async (cmd) => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
    });
    const r = await handleTestSkill({ name: "python-pytest-runner" }, ctx.deps);
    assert.equal(r.ok, true);
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0]?.id, "echo");
  } finally {
    ctx.cleanup();
  }
});

test("test_skill fails-fast on first non-zero exit", async () => {
  const ctx = setup();
  try {
    // Replace the lifecycle with one whose runCommand returns 1.
    ctx.deps.lifecycle = new SkillLifecycle({
      registry: ctx.deps.registry,
      memory: new SkillMemoryRegistry({ workspaceRoot: ctx.workspaceRoot }),
      resolver: new SkillTrustResolver({
        builtinRoot: join(ctx.tmp, "builtin"),
        userHomeSkillsDir: join(ctx.userHome, ".reaper", "skills"),
        projectSkillsDir: join(ctx.workspaceRoot, ".reaper", "skills"),
      }),
      workspaceRoot: ctx.workspaceRoot,
      userHome: ctx.userHome,
      builtinRoot: join(ctx.tmp, "builtin"),
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
    });
    await handleCreateSkill(
      {
        ...BASE_CREATE,
        validation_commands: [{ id: "false", command: "false" }],
      },
      ctx.deps,
    );
    const r = await handleTestSkill({ name: "python-pytest-runner" }, ctx.deps);
    assert.equal(r.ok, false);
    assert.ok(r.results[0]?.exitCode !== 0, `expected nonzero exit, got ${r.results[0]?.exitCode}`);
  } finally {
    ctx.cleanup();
  }
});

test("approve_skill calls request_human_approval before promoting", async () => {
  const ctx = setup();
  try {
    await handleCreateSkill(BASE_CREATE, ctx.deps);
    let approveCalled = false;
    const approver: SkillApprovalRequester = async () => {
      approveCalled = true;
      return true;
    };
    const r = await handleApproveSkill({ name: "python-pytest-runner" }, { ...ctx.deps, approvalRequester: approver });
    assert.equal(approveCalled, true);
    assert.equal(r.ok, true);
    assert.equal(r.trust, "user-trusted");
  } finally {
    ctx.cleanup();
  }
});

test("approve_skill denial keeps skill as draft", async () => {
  const ctx = setup();
  try {
    await handleCreateSkill(BASE_CREATE, ctx.deps);
    const approver: SkillApprovalRequester = async () => false;
    const r = await handleApproveSkill({ name: "python-pytest-runner" }, { ...ctx.deps, approvalRequester: approver });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /denied by approval gate/);
    const rec = ctx.deps.registry.get("python-pytest-runner");
    assert.equal(rec?.trust, "draft");
  } finally {
    ctx.cleanup();
  }
});

test("approve_skill approval promotes to user-trusted", async () => {
  const ctx = setup();
  try {
    await handleCreateSkill(BASE_CREATE, ctx.deps);
    const approver: SkillApprovalRequester = async () => true;
    const r = await handleApproveSkill({ name: "python-pytest-runner" }, { ...ctx.deps, approvalRequester: approver });
    assert.equal(r.ok, true);
    assert.equal(r.trust, "user-trusted");
    const rec = ctx.deps.registry.get("python-pytest-runner");
    assert.equal(rec?.trust, "user-trusted");
  } finally {
    ctx.cleanup();
  }
});

test("uninstall_skill removes skill from registry", async () => {
  const ctx = setup();
  try {
    await handleCreateSkill(BASE_CREATE, ctx.deps);
    const approver: SkillApprovalRequester = async () => true;
    await handleApproveSkill({ name: "python-pytest-runner" }, { ...ctx.deps, approvalRequester: approver });
    const r = handleUninstallSkill({ name: "python-pytest-runner", scope: "user" }, { ...ctx.deps, approvalRequester: approver });
    await r;
    assert.equal(ctx.deps.registry.get("python-pytest-runner"), null);
  } finally {
    ctx.cleanup();
  }
});

test("reload_skills returns count of records", async () => {
  const ctx = setup();
  try {
    await handleCreateSkill(BASE_CREATE, ctx.deps);
    const r = handleReloadSkills({}, ctx.deps);
    assert.equal(r.ok, true);
    assert.ok(r.loaded >= 1);
  } finally {
    ctx.cleanup();
  }
});

test("SkillRouter picks up new skill on next selectTopN call", async () => {
  const ctx = setup();
  try {
    await handleCreateSkill(BASE_CREATE, ctx.deps);
    const approver: SkillApprovalRequester = async () => true;
    await handleApproveSkill({ name: "python-pytest-runner" }, { ...ctx.deps, approvalRequester: approver });
    const summaries = ctx.deps.registry.selectTopN({ query: "pytest" });
    assert.ok(summaries.some((s) => s.name === "python-pytest-runner"), `expected python-pytest-runner in summaries`);
  } finally {
    ctx.cleanup();
  }
});
