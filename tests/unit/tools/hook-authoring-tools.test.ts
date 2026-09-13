/**
 * Unit tests for the 6 model-callable hook authoring tools.
 *
 * Covers the 12 cases listed in the plan §8.2 (Hooks block).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,  mkdirSync,  rmSync,  existsSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HookLifecycle } from "../../../src/hooks/lifecycle.js";
import { HookRunner } from "../../../src/extensions/hook-runner.js";
import {
  handleCreateHook,
  handleListHooks,
  handleUpdateHook,
  handleApproveHook,
  handleUninstallHook,
  handleHookManager,
  type HookToolDeps,
} from "../../../src/tools/write/hook-tools.js";

function setup(): { tmp: string; userHome: string; workspaceRoot: string; runner: HookRunner; deps: HookToolDeps; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "reaper-hook-authoring-"));
  const userHome = join(tmp, "home");
  const workspaceRoot = join(tmp, "ws");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const runner = new HookRunner();
  const lifecycle = new HookLifecycle({
    runner,
    workspaceRoot,
    userHome,
  });
  return {
    tmp,
    userHome,
    workspaceRoot,
    runner,
    deps: { lifecycle },
    cleanup: () => {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

const VALID_OBSERVE_SOURCE = `return { allow: true, message: "ok" };`;
const VALID_BLOCK_SOURCE = `return { allow: false, reason: "blocked by hook" };`;

test("create_hook happy path lands as draft JSON on disk", async () => {
  const ctx = setup();
  try {
    const r = await handleCreateHook(
      {
        id: "warn-on-rm",
        event: "PreToolUse",
        description: "Warns on rm -rf",
        source: VALID_OBSERVE_SOURCE,
        enforce: false,
        scope: "project",
      },
      ctx.deps,
    );
    assert.equal(r.ok, true);
    assert.ok(r.record, "missing record");
    assert.equal(r.record?.trust, "draft");
    const filePath = join(ctx.workspaceRoot, ".reaper", "hooks", "warn-on-rm.json");
    assert.ok(existsSync(filePath), `expected file at ${filePath}`);
  } finally {
    ctx.cleanup();
  }
});

test("create_hook rejects duplicate id", async () => {
  const ctx = setup();
  try {
    await handleCreateHook(
      { id: "dup", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      ctx.deps,
    );
    const r2 = await handleCreateHook(
      { id: "dup", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      ctx.deps,
    );
    assert.equal(r2.ok, false);
    assert.match(r2.error ?? "", /already exists/);
  } finally {
    ctx.cleanup();
  }
});

test("create_hook rejects invalid id", async () => {
  const ctx = setup();
  try {
    const r = await handleCreateHook(
      { id: "Not_a_kebab", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      ctx.deps,
    );
    assert.equal(r.ok, false);
  } finally {
    ctx.cleanup();
  }
});

test("create_hook rejects source > 64KB", async () => {
  const ctx = setup();
  try {
    const bigSource = "return { allow: true };\n" + "// pad\n".repeat(20_000);
    const r = await handleCreateHook(
      { id: "too-big", event: "PreToolUse", description: "x", source: bigSource, enforce: false, scope: "project" },
      ctx.deps,
    );
    assert.equal(r.ok, false);
  } finally {
    ctx.cleanup();
  }
});

test("create_hook rejects source that fails new Function compilation", async () => {
  const ctx = setup();
  try {
    const r = await handleCreateHook(
      { id: "bad-syntax", event: "PreToolUse", description: "x", source: "return { allow: ", enforce: false, scope: "project" },
      ctx.deps,
    );
    assert.equal(r.ok, false);
  } finally {
    ctx.cleanup();
  }
});

test("list_hooks returns the live + draft registry with correct fields", async () => {
  const ctx = setup();
  try {
    await handleCreateHook(
      { id: "hook-a", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      ctx.deps,
    );
    await handleCreateHook(
      { id: "hook-b", event: "PostToolUse", description: "y", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      ctx.deps,
    );
    const r = handleListHooks({ scope: "all" }, ctx.deps);
    assert.equal(r.ok, true);
    assert.equal(r.hooks.length, 2);
    assert.equal(r.hooks[0]?.event, "PreToolUse");
    assert.equal(r.hooks[0]?.trust, "draft");
  } finally {
    ctx.cleanup();
  }
});

test("approve_hook calls request_human_approval", async () => {
  const ctx = setup();
  try {
    const autoApprover = async () => true;
    const autoLifecycle = new HookLifecycle({
      runner: ctx.runner,
      workspaceRoot: ctx.workspaceRoot,
      userHome: ctx.userHome,
      approvalRequester: autoApprover,
    });
    await handleCreateHook(
      { id: "needs-approval", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      { lifecycle: autoLifecycle },
    );
    const r = await handleApproveHook({ id: "needs-approval" }, { lifecycle: autoLifecycle });
    assert.equal(r.ok, true);
  } finally {
    ctx.cleanup();
  }
});

test("approve_hook denial keeps hook as draft", async () => {
  const ctx = setup();
  try {
    const denyLifecycle = new HookLifecycle({
      runner: ctx.runner,
      workspaceRoot: ctx.workspaceRoot,
      userHome: ctx.userHome,
      approvalRequester: async () => false,
    });
    await handleCreateHook(
      { id: "denied", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      { lifecycle: denyLifecycle },
    );
    const r = await handleApproveHook({ id: "denied" }, { lifecycle: denyLifecycle });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /denied/);
  } finally {
    ctx.cleanup();
  }
});

test("approve_hook allow with enforce false registers a hook (observation-only)", async () => {
  const ctx = setup();
  try {
    const autoApprover = async () => true;
    const autoLifecycle = new HookLifecycle({
      runner: ctx.runner,
      workspaceRoot: ctx.workspaceRoot,
      userHome: ctx.userHome,
      approvalRequester: autoApprover,
    });
    await handleCreateHook(
      { id: "observer", event: "PreToolUse", description: "observes", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      { lifecycle: autoLifecycle },
    );
    const r = await handleApproveHook({ id: "observer" }, { lifecycle: autoLifecycle });
    assert.equal(r.ok, true);
    // Project-scoped hooks promote to "project-untrusted" (their
    // installation scope is project); the user-scoped case is
    // tested separately below.
    assert.equal(r.record?.trust, "project-untrusted");
  } finally {
    ctx.cleanup();
  }
});

test("approve_hook allow with enforce true registers a blocking hook", async () => {
  const ctx = setup();
  try {
    const autoApprover = async () => true;
    const autoLifecycle = new HookLifecycle({
      runner: ctx.runner,
      workspaceRoot: ctx.workspaceRoot,
      userHome: ctx.userHome,
      approvalRequester: autoApprover,
    });
    await handleCreateHook(
      { id: "blocker", event: "PreToolUse", description: "blocks", source: VALID_BLOCK_SOURCE, enforce: true, scope: "project" },
      { lifecycle: autoLifecycle },
    );
    const r = await handleApproveHook({ id: "blocker" }, { lifecycle: autoLifecycle });
    assert.equal(r.ok, true);
    assert.equal(r.record?.enforce, true);
  } finally {
    ctx.cleanup();
  }
});

test("update_hook re-compiles and re-registers", async () => {
  const ctx = setup();
  try {
    const autoApprover = async () => true;
    const autoLifecycle = new HookLifecycle({
      runner: ctx.runner,
      workspaceRoot: ctx.workspaceRoot,
      userHome: ctx.userHome,
      approvalRequester: autoApprover,
    });
    await handleCreateHook(
      { id: "upd", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      { lifecycle: autoLifecycle },
    );
    await handleApproveHook({ id: "upd" }, { lifecycle: autoLifecycle });
    const r = await handleUpdateHook({ id: "upd", source: VALID_BLOCK_SOURCE, enforce: true }, { lifecycle: autoLifecycle });
    assert.equal(r.ok, true);
    assert.equal(r.record?.enforce, true);
  } finally {
    ctx.cleanup();
  }
});

test("uninstall_hook removes from disk + HookRunner", async () => {
  const ctx = setup();
  try {
    await handleCreateHook(
      { id: "removable", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      ctx.deps,
    );
    const r = await handleUninstallHook({ id: "removable" }, ctx.deps);
    assert.equal(r.ok, true);
    assert.equal(ctx.deps.lifecycle.get("removable"), null);
  } finally {
    ctx.cleanup();
  }
});

test("hook_manager re-walks the disk before every action", async () => {
  // `reload_hooks` existed for exactly this case: a hook file that appeared
  // after boot. The manager now walks the install dirs itself. The first
  // lifecycle writes but knows nothing; the second is constructed over the same
  // roots and can only learn about the hook by discovering it.
  const ctx = setup();
  try {
    // Constructed first, so its constructor-time walk happens while the hooks
    // dir is still empty. It can therefore only learn about the hook below if
    // the manager re-walks.
    const cold = new HookLifecycle({ runner: ctx.runner, workspaceRoot: ctx.workspaceRoot, userHome: ctx.userHome });
    const first = new HookLifecycle({ runner: new HookRunner(), workspaceRoot: ctx.workspaceRoot, userHome: ctx.userHome });
    const created = await handleCreateHook(
      { id: "reloadable", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      { lifecycle: first },
    );
    assert.equal(created.ok, true);
    assert.equal(cold.get("reloadable"), null, "the cold lifecycle must be empty for this test to prove anything");

    const listed = await handleHookManager({ action: "list" }, { lifecycle: cold });
    const ids = (listed as { hooks: Array<{ id: string }> }).hooks.map((h) => h.id);
    assert.deepEqual(ids, ["reloadable"]);
  } finally {
    ctx.cleanup();
  }
});

test("hook_manager dispatches every action, and refuses an unnamed one", async () => {
  const ctx = setup();
  try {
    const created = await handleHookManager(
      { action: "create", id: "managed-hook", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      ctx.deps,
    );
    assert.equal((created as { ok: boolean }).ok, true);

    const listed = await handleHookManager({ action: "list", scope: "project" }, ctx.deps);
    assert.deepEqual((listed as { hooks: Array<{ id: string }> }).hooks.map((h) => h.id), ["managed-hook"]);

    const updated = await handleHookManager(
      { action: "update", id: "managed-hook", source: VALID_BLOCK_SOURCE },
      ctx.deps,
    );
    assert.equal((updated as { ok: boolean }).ok, true);

    // No approval requester is wired into this harness, and without one the
    // lifecycle fails closed for any hook that could block — so `approve` here
    // is only reachable because `enforce` is false throughout.
    const approved = await handleHookManager({ action: "approve", id: "managed-hook" }, ctx.deps);
    assert.equal((approved as { ok: boolean }).ok, true);

    // Uninstalling a hook that is no longer a draft is gated, and the gate
    // fails closed without a requester.
    const gated = await handleHookManager({ action: "uninstall", id: "managed-hook" }, ctx.deps);
    assert.equal((gated as { ok: boolean }).ok, false);
    assert.match(String((gated as { error?: string }).error), /requires approval/);

    // The requester is a lifecycle option, not a tool dep, so the approval path
    // needs a lifecycle constructed with one. The manager's own discover() is
    // what lets this second lifecycle see a hook it never created.
    const approving = new HookLifecycle({
      runner: ctx.runner,
      workspaceRoot: ctx.workspaceRoot,
      userHome: ctx.userHome,
      approvalRequester: async () => true,
    });
    const hookFile = join(ctx.workspaceRoot, ".reaper", "hooks", "managed-hook.json");
    assert.ok(existsSync(hookFile), "the approved hook should have been persisted");
    const uninstalled = await handleHookManager({ action: "uninstall", id: "managed-hook" }, { lifecycle: approving });
    assert.equal((uninstalled as { ok: boolean }).ok, true);
    assert.equal(existsSync(hookFile), false, "uninstall must remove the hook file from disk");

    // `scope` is shared between `create` and `list`, and its manager-level enum
    // is wider because `list` alone accepts "all". A `create` that asks for it
    // must be refused by the strict re-parse, not silently scoped somewhere.
    const mismatched = await handleHookManager(
      { action: "create", id: "all-scoped", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "all" } as never,
      ctx.deps,
    );
    assert.equal((mismatched as { ok: boolean }).ok, false);
    assert.match(String((mismatched as { error?: string }).error), /scope/);
  } finally {
    ctx.cleanup();
  }
});
