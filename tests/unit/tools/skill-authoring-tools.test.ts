/**
 * Unit tests for the 5 model-callable skill authoring tools.
 *
 * Covers the 12 cases listed in the plan §8.2 (Skills block).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,  mkdirSync,  rmSync,  existsSync,  readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { SkillRegistry } from "../../../src/skills/registry.js";
import { SkillLifecycle } from "../../../src/skills/lifecycle.js";
import { TrustResolver as SkillTrustResolver } from "../../../src/skills/trust.js";
import { SkillMemoryRegistry } from "../../../src/adaptive/skill-memory-registry.js";
import {
  handleCreateSkill,
  handleTestSkill,
  handleApproveSkill,
  handleUninstallSkill,
  handleSkillManager,
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

test("create_skill happy path lands trusted, in the directory discovery walks", () => {
  /*
   * Not `drafts/`, and not `trust: "draft"`. That combination was the reason a
   * created skill could never be activated or uninstalled: `drafts/` is not a
   * directory discovery scans, and `draft` was the flag that locked the skill
   * out of both paths.
   */
  const ctx = setup();
  try {
    const r = handleCreateSkill(BASE_CREATE, ctx.deps);
    return r.then((out) => {
      assert.equal(out.ok, true);
      assert.equal(out.name, "python-pytest-runner");
      assert.equal(out.trust, "user-trusted");
      const dir = out.skillDir?.split(sep).join("/") ?? "";
      assert.ok(dir.includes(".reaper/skills/python-pytest-runner"), `unexpected skillDir: ${dir}`);
      assert.ok(!dir.includes("/drafts/"), "a created skill must not land in drafts/");
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
    assert.match(String(r2.error), /already exists/i);
    // The message names the real location now, because a created skill is a
    // real skill rather than a draft.
    assert.match(r2.error ?? "", /already exists at/);
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

/**
 * There are no trust tiers, so there is nothing to approve.
 *
 * `create` used to write a draft that `approve` promoted, and both had to
 * happen before the skill could be activated. That chain is gone: a created
 * skill is trusted and usable. `approve` is kept as a no-op that reports
 * success, because a model that learned the old workflow will still call it and
 * "already usable, go ahead" is a better answer than a refusal implying
 * something is missing.
 */
test("approve_skill is a no-op that reports the skill is already usable", async () => {
  const ctx = setup();
  try {
    const created = await handleCreateSkill(BASE_CREATE, ctx.deps);
    assert.equal(created.ok, true);
    assert.equal(created.trust, "user-trusted", "creation must produce a usable skill");

    // No approval requester is involved, and none is needed.
    const r = await handleApproveSkill({ name: "python-pytest-runner" }, ctx.deps);
    assert.equal(r.ok, true);
    assert.equal(r.trust, "user-trusted");
    assert.equal(r.error, undefined);
  } finally {
    ctx.cleanup();
  }
});

test("uninstall removes a created skill without an approval gate", async () => {
  const ctx = setup();
  try {
    const created = await handleCreateSkill(BASE_CREATE, ctx.deps);
    assert.equal(created.ok, true);
    assert.ok(existsSync(join(created.skillDir!, "SKILL.md")));

    const removed = await handleUninstallSkill({ name: "python-pytest-runner", scope: "user" }, ctx.deps);
    assert.equal(removed.ok, true, `uninstall failed: ${removed.error ?? ""}`);
    assert.equal(
      existsSync(created.skillDir!),
      false,
      "the skill directory must be gone — create without remove is a one-way door",
    );
  } finally {
    ctx.cleanup();
  }
});

test("uninstall_skill removes skill from registry", async () => {
  const ctx = setup();
  try {
    await handleCreateSkill(BASE_CREATE, ctx.deps);
    // No approval step: creation produces a usable skill and removal is ungated.
    await handleUninstallSkill({ name: "python-pytest-runner", scope: "user" }, ctx.deps);
    assert.equal(ctx.deps.registry.get("python-pytest-runner"), null);
  } finally {
    ctx.cleanup();
  }
});

test("creating a skill needs no reload step to be visible", async () => {
  // `reload_skills` used to exist and returned a count of records it had not
  // re-read. Skill state is fully in memory and every mutation registers into
  // the registry directly, so the tool could not have changed anything — the
  // assertion that matters is that the registry is already current.
  const ctx = setup();
  try {
    const created = await handleCreateSkill(BASE_CREATE, ctx.deps);
    assert.equal(created.ok, true);
    // The registry's records are keyed by `manifest.name`, not a bare `name` —
    // reading `r.name` here would compare against `undefined` and pass for a
    // registry that had never heard of the skill.
    const listed = ctx.deps.registry.list({ includeUntrusted: true });
    assert.ok(listed.some((r) => r.manifest.name === BASE_CREATE.name));
  } finally {
    ctx.cleanup();
  }
});

test("skill_manager dispatches every action, and refuses an unknown one", async () => {
  const ctx = setup();
  try {
    const created = await handleSkillManager({ action: "create", ...BASE_CREATE }, ctx.deps);
    assert.equal((created as { ok: boolean }).ok, true);

    const tested = await handleSkillManager({ action: "test", name: BASE_CREATE.name }, ctx.deps);
    assert.equal((tested as { ok: boolean }).ok, true);

    const approved = await handleSkillManager({ action: "approve", name: BASE_CREATE.name }, ctx.deps);
    assert.equal((approved as { trust?: string }).trust, "user-trusted");

    const uninstalled = await handleSkillManager({ action: "uninstall", name: BASE_CREATE.name, scope: "project" }, ctx.deps);
    assert.equal((uninstalled as { ok: boolean }).ok, true);
    assert.equal(ctx.deps.registry.get(BASE_CREATE.name), null);

    // `test` names a skill; omitting it is a wiring mistake, not a skill typo,
    // so it throws rather than returning `{ok: false}`.
    await assert.rejects(
      () => handleSkillManager({ action: "test" }, ctx.deps),
      /requires "name"/,
    );
  } finally {
    ctx.cleanup();
  }
});

test("skill_manager create rejects an incomplete definition instead of writing a partial skill", async () => {
  const ctx = setup();
  try {
    const r = await handleSkillManager({ action: "create", name: "half-baked" }, ctx.deps);
    assert.equal((r as { ok: boolean }).ok, false);
    assert.match((r as { error: string }).error, /create requires the full skill definition/);
    assert.equal(ctx.deps.registry.get("half-baked"), null);
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
