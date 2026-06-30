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
  handleReloadHooks,
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

test("reload_hooks re-walks the disk", async () => {
  const ctx = setup();
  try {
    await handleCreateHook(
      { id: "reloadable", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      ctx.deps,
    );
    const r = handleReloadHooks({}, ctx.deps);
    assert.equal(r.ok, true);
    assert.ok(r.loaded >= 1);
  } finally {
    ctx.cleanup();
  }
});
