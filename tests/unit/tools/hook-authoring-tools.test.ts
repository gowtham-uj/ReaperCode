/**
 * Unit tests for the 6 model-callable hook authoring tools.
 *
 * Covers the 12 cases listed in the plan §8.2 (Hooks block).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  /*
   * The workspace is trusted, which is the state a real user reaches by
   * approving a hook. These tests are about the authoring tools rather than
   * about trust, and a project-scope hook in an untrusted workspace is refused
   * at discovery now: an untrusted project's hook must not run unattended,
   * which is the same rule the extension registry already applied to the
   * sibling directory. `hook-approval.test.ts` covers that rule directly.
   */
  mkdirSync(join(userHome, ".reaper"), { recursive: true });
  writeFileSync(
    join(userHome, ".reaper", "project-trust.json"),
    JSON.stringify({ entries: [{ workspaceRoot: realpathSync(workspaceRoot), trusted: true, updatedAt: Date.now() }] }),
  );
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
/** Blocks, and carries a hint. Used to check the enforce adapter keeps one and drops the other. */
const VALID_BLOCK_WITH_HINT = `return { allow: false, reason: "blocked by hook", message: "careful with rm -rf" };`;

test("create_hook lands as trusted JSON on disk, registered immediately", async () => {
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
    /*
     * Trusted on creation, and already attached to the runner. There is no
     * draft state: a hook the model was asked to write is a hook that should
     * run, and the draft tier existed only to gate it behind an approval step
     * the agent could not reach.
     */
    assert.equal(r.record?.trust, "user-trusted");
    assert.ok(
      ctx.runner.handlerIds().includes("hook:warn-on-rm"),
      "a created hook must be registered, or creating it does nothing",
    );
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

test("list_hooks returns the registry with correct fields", async () => {
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
    // `registered` reports the runner's actual subscription, not a copy of the
    // `trust` label — there are no trust tiers, so there is nothing for the
    // inventory to report about them.
    assert.equal(r.hooks[0]?.registered, true);
  } finally {
    ctx.cleanup();
  }
});

test("approve_hook reports success for a hook that is already live", async () => {
  /*
   * There are no trust tiers. A hook is live when it is created, so there is
   * nothing to approve and nothing that can deny it. `approve_hook` stays as a
   * success answer because a caller written against the old workflow will still
   * call it, and "already live, go ahead" beats a refusal that implies
   * something is missing.
   */
  const ctx = setup();
  try {
    const created = await handleCreateHook(
      { id: "created", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      ctx.deps,
    );
    assert.equal(created.ok, true);
    assert.ok(ctx.runner.handlerIds().includes("hook:created"), "the hook must be live without any approval step");

    const r = await handleApproveHook({ id: "created" }, ctx.deps);
    assert.equal(r.ok, true, `approve should report the hook is already usable: ${r.error ?? ""}`);
    assert.equal(r.record?.trust, "user-trusted");
  } finally {
    ctx.cleanup();
  }
});

test("enforce decides whether a hook can block, and it is the only thing that decides", async () => {
  /*
   * `enforce` is the one flag on a hook that changes behaviour, and it is a
   * capability flag, not a trust one. The two hooks below have identical source,
   * identical scope, and identical trust; the only difference is the flag. The
   * observer's `allow: false` must be discarded and its `message` surfaced; the
   * blocker's `allow: false` must stop the call.
   *
   * Dispatching through the runner rather than reading `record.enforce` back is
   * the point: the field being set proves nothing about what happens to a real
   * tool call, and the adapter in `wrapHandler` is where the flag is acted on.
   */
  const ctx = setup();
  const payload = { toolName: "bash", cmd: "rm -rf /tmp/x" };
  try {
    // enforce: false, and the source asks to block. The outcome is still allow.
    await handleCreateHook(
      { id: "observer", event: "PreToolUse", description: "observes", source: VALID_BLOCK_WITH_HINT, enforce: false, scope: "project" },
      ctx.deps,
    );
    const observed = await ctx.runner.dispatch("PreToolUse", payload);
    assert.equal(observed.allow, true, "an observation-only hook must not be able to block a tool call");
    const observerResult = observed.results.find((r) => r.extensionId === "hook:observer");
    assert.ok(observerResult, "the observer should still have run and been reported");
    assert.equal(observerResult.outcome, "message", "the block is dropped and the hook is reported as advice");
    assert.equal(observerResult.message, "careful with rm -rf", "the hint reaches the model");
    assert.equal(
      (observerResult as { reason?: string }).reason,
      undefined,
      "the reason is what justified a block that did not happen, so it must not be reported",
    );

    /*
     * Same source, same scope, same trust; `enforce: true` is the only
     * difference, and it is added as a *second* hook so the dispatch below
     * carries both. The observer runs first and is overruled.
     */
    await handleCreateHook(
      { id: "blocker", event: "PreToolUse", description: "blocks", source: VALID_BLOCK_WITH_HINT, enforce: true, scope: "project" },
      ctx.deps,
    );
    const blocked = await ctx.runner.dispatch("PreToolUse", payload);
    assert.equal(blocked.allow, false, "an enforce: true hook must be able to block");
    assert.equal(blocked.firstDenyReason, "blocked by hook");
  } finally {
    ctx.cleanup();
  }
});

test("update_hook re-compiles and re-registers", async () => {
  const ctx = setup();
  try {
    const autoLifecycle = new HookLifecycle({
      runner: ctx.runner,
      workspaceRoot: ctx.workspaceRoot,
      userHome: ctx.userHome,
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

/**
 * `update` must apply the fields it advertises, not just `source`/`enforce`.
 *
 * Two separate holes made an update silently partial. `requireHookId` returned
 * `{ id }` and dropped every other argument before the handler saw it, and
 * `UpdateHookInput` had no `description` or `event` field for the handler to set
 * even when it had them. Both were invisible because `update` returned
 * `ok: true` and bumped `updatedAt` either way, so an update that changed
 * nothing looked exactly like one that worked.
 *
 * This drives the manager (the path the model actually calls, where the
 * `requireHookId` drop happened) and asserts every field landed.
 */
test("update_hook applies description, event, matcher and enforce, not just source", async () => {
  const ctx = setup();
  try {
    await handleHookManager(
      { action: "create", id: "upd-all", event: "PreToolUse", description: "before", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      ctx.deps,
    );
    const updated = await handleHookManager(
      {
        action: "update",
        id: "upd-all",
        description: "after",
        event: "PostToolUse",
        matcher: { tool_name: "bash" },
        enforce: true,
        source: VALID_BLOCK_SOURCE,
      },
      ctx.deps,
    ) as { ok: boolean; record?: { description: string; event: string; matcher: unknown; enforce: boolean; source: string } };
    assert.equal(updated.ok, true, "update reported failure");
    assert.equal(updated.record?.description, "after", "description was not applied");
    assert.equal(updated.record?.event, "PostToolUse", "event was not applied");
    assert.deepEqual(updated.record?.matcher, { tool_name: "bash" }, "matcher was not applied");
    assert.equal(updated.record?.enforce, true, "enforce was not applied");
    assert.equal(updated.record?.source, VALID_BLOCK_SOURCE, "source was not applied");
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

    // A no-op that reports success. No approval requester is wired into this
    // harness and none is needed: there are no trust tiers to promote.
    const approved = await handleHookManager({ action: "approve", id: "managed-hook" }, ctx.deps);
    assert.equal((approved as { ok: boolean }).ok, true);

    /*
     * Uninstall is ungated, and reaches a hook this lifecycle did not create.
     *
     * This used to assert a refusal: removal was behind an approval gate, so a
     * hook could be created but not removed, and because the live runner held
     * it in memory, deleting the file did not stop it either. The second
     * lifecycle here is the point — it never called `create`, so it only knows
     * about the hook through the manager's own discovery walk, which is
     * exactly the state a fresh session is in.
     */
    const hookFile = join(ctx.workspaceRoot, ".reaper", "hooks", "managed-hook.json");
    assert.ok(existsSync(hookFile), "the created hook should have been persisted");
    const reloaded = new HookLifecycle({ runner: ctx.runner, workspaceRoot: ctx.workspaceRoot, userHome: ctx.userHome });
    const uninstalled = await handleHookManager({ action: "uninstall", id: "managed-hook" }, { lifecycle: reloaded });
    assert.equal((uninstalled as { ok: boolean }).ok, true, `uninstall failed: ${(uninstalled as { error?: string }).error ?? ""}`);
    assert.equal(existsSync(hookFile), false, "uninstall must remove the hook file from disk");
    assert.ok(
      !ctx.runner.handlerIds().includes("hook:managed-hook"),
      "uninstall must also detach it from the live runner",
    );

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

/**
 * The `trust` field on a hook file is inert.
 *
 * It used to decide everything: `discover()` only compiled and registered a
 * record whose trust was not `draft`, so a hook file carrying `draft` or
 * `project-untrusted` was loaded, listed as present, and attached to nothing.
 * Nothing outside `HookLifecycle` writes a hook to disk, and nothing reachable
 * promoted a loaded record, so a hook that arrived with the wrong label was
 * quietly dead for the life of the session.
 *
 * These tests write files carrying each label and assert the hook runs anyway.
 * The labels still parse — an old file must not break — but nothing reads them
 * to decide anything.
 */
test("a hook file on disk is registered whatever trust label it carries", async () => {
  const ctx = setup();
  try {
    const projectHooks = join(ctx.workspaceRoot, ".reaper", "hooks");
    mkdirSync(projectHooks, { recursive: true });
    for (const [id, trust] of [["legacy-draft", "draft"], ["legacy-untrusted", "project-untrusted"]] as const) {
      writeFileSync(join(projectHooks, `${id}.json`), JSON.stringify({
        id,
        event: "PreToolUse",
        description: "test fixture",
        source: "return { allow: true };",
        scope: "project",
        trust,
        enforce: false,
      }));
    }

    new HookLifecycle({ runner: ctx.runner, workspaceRoot: ctx.workspaceRoot, userHome: ctx.userHome });
    const registrations = ctx.runner.handlerIds();
    assert.ok(
      registrations.includes("hook:legacy-draft"),
      `a hook labelled "draft" was not registered (registered: ${registrations.join(", ")})`,
    );
    assert.ok(
      registrations.includes("hook:legacy-untrusted"),
      `a hook labelled "project-untrusted" was not registered (registered: ${registrations.join(", ")})`,
    );
  } finally {
    ctx.cleanup();
  }
});

test("a hook whose source does not compile is listed but not registered", async () => {
  /*
   * The one thing that legitimately keeps a hook off the runner is source that
   * cannot be compiled. `list` must say so rather than reporting the hook as
   * present and live: the inventory asks the subscription map, so the panel
   * cannot disagree with what will actually run.
   */
  const ctx = setup();
  try {
    const projectHooks = join(ctx.workspaceRoot, ".reaper", "hooks");
    mkdirSync(projectHooks, { recursive: true });
    writeFileSync(join(projectHooks, "broken-hook.json"), JSON.stringify({
      id: "broken-hook",
      event: "PreToolUse",
      description: "test fixture",
      source: "return { allow: ",
      scope: "project",
      trust: "user-trusted",
      enforce: false,
    }));

    const lifecycle = new HookLifecycle({ runner: ctx.runner, workspaceRoot: ctx.workspaceRoot, userHome: ctx.userHome });
    const listed = handleListHooks({ scope: "all" }, { lifecycle });
    const broken = listed.hooks.find((h) => h.id === "broken-hook");
    assert.ok(broken, "a hook with unparseable source should still be listed");
    assert.equal(broken.registered, false, "an uncompilable hook must not report itself as registered");
    assert.ok(
      !ctx.runner.handlerIds().includes("hook:broken-hook"),
      "nothing should be attached for a hook that failed to compile",
    );
  } finally {
    ctx.cleanup();
  }
});

test("approve reports success and leaves a live hook live", async () => {
  const ctx = setup();
  try {
    const projectHooks = join(ctx.workspaceRoot, ".reaper", "hooks");
    mkdirSync(projectHooks, { recursive: true });
    writeFileSync(join(projectHooks, "project-hook.json"), JSON.stringify({
      id: "project-hook",
      event: "PreToolUse",
      description: "test fixture",
      source: "return { allow: true };",
      scope: "project",
      trust: "draft",
      enforce: false,
    }));

    const lifecycle = new HookLifecycle({ runner: ctx.runner, workspaceRoot: ctx.workspaceRoot, userHome: ctx.userHome });
    assert.ok(
      ctx.runner.handlerIds().includes("hook:project-hook"),
      "discovery should already have attached it — approve is not what makes a hook live",
    );

    const approved = await lifecycle.approve("project-hook");
    assert.equal(approved.ok, true, `approve failed: ${approved.error ?? ""}`);
    assert.equal(
      approved.record?.trust,
      "user-trusted",
      "approve rewrites the label to the single trusted state",
    );
    assert.ok(
      ctx.runner.handlerIds().includes("hook:project-hook"),
      "and it stays registered",
    );
  } finally {
    ctx.cleanup();
  }
});

test("deleting a hook's file unregisters it on the next discovery", async () => {
  const ctx = setup();
  try {
    const projectHooks = join(ctx.workspaceRoot, ".reaper", "hooks");
    mkdirSync(projectHooks, { recursive: true });
    const file = join(projectHooks, "removable-hook.json");
    writeFileSync(file, JSON.stringify({
      id: "removable-hook",
      event: "PreToolUse",
      description: "test fixture",
      source: "return { allow: true };",
      scope: "project",
      trust: "user-trusted",
      enforce: false,
    }));

    const lifecycle = new HookLifecycle({ runner: ctx.runner, workspaceRoot: ctx.workspaceRoot, userHome: ctx.userHome });
    assert.ok(
      ctx.runner.handlerIds().includes("hook:removable-hook"),
      "the trusted hook should start registered",
    );

    /*
     * Delete the file, then re-walk. `discover()` used to only ever add, so the
     * hook stayed live for the rest of the session with no reachable way to stop
     * it — `uninstall` is behind an approval gate. Removing the file is the one
     * action a user outside the agent can always take.
     */
    rmSync(file, { force: true });
    lifecycle.reload();

    assert.equal(lifecycle.get("removable-hook"), null, "the record survived its file being deleted");
    assert.ok(
      !ctx.runner.handlerIds().includes("hook:removable-hook"),
      "deleting a hook's file left it running on the live runner",
    );
  } finally {
    ctx.cleanup();
  }
});


/*
 * A hook's manifestSha256 survives a rediscovery.
 *
 * `recordToDisk` does not persist the hash and `recordFromDisk` hardcoded `""`,
 * and every manager action re-runs `discover()` first — so the hash a `create`
 * returned was wiped by the very next call. The audit saw it as `approve`
 * "corrupting" the record (blank hash, unchanged updatedAt). Recomputing it from
 * the file's own bytes keeps the field honest across a reload.
 */
test("a hook's manifestSha256 is intact after a rediscovery", async () => {
  const ctx = setup();
  try {
    const created = await handleCreateHook(
      { id: "hash-hook", event: "PreToolUse", description: "x", source: VALID_OBSERVE_SOURCE, enforce: false, scope: "project" },
      ctx.deps,
    );
    const before = created.record?.manifestSha256 ?? "";
    assert.ok(before.length > 0, "create must return a real hash");

    // A fresh lifecycle over the same roots can only learn the hook by discovering it.
    const reloaded = new HookLifecycle({ runner: ctx.runner, workspaceRoot: ctx.workspaceRoot, userHome: ctx.userHome });
    const after = reloaded.get("hash-hook")?.manifestSha256 ?? "";
    assert.equal(after, before, "the hash must survive a rediscovery, not be blanked");

    // And `approve` (a documented no-op) must not blank it either.
    const approved = await handleApproveHook({ id: "hash-hook" }, { lifecycle: reloaded });
    assert.equal(approved.record?.manifestSha256, before, "approve must not blank the hash");
  } finally {
    ctx.cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* Matchers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The matcher has to find the value in the envelope the runtime actually sends.
 *
 * A real tool call reports its arguments nested under `args` — `payload.args.path`,
 * `payload.args.cmd` — and the first version of the matcher read the top level.
 * The field it looked at was always absent, so `matcherAllows` returned false on
 * every call and the hook silently never fired. That is a hook that looks
 * correct, saves, loads, and does nothing, which is the worst shape a bug can
 * take here. So these cases use the nested envelope the executor builds.
 */
test("a path_glob matcher matches the path in the nested tool arguments", async () => {
  const ctx = setup();
  try {
    await handleCreateHook(
      {
        id: "block-secret-path",
        event: "PreToolUse",
        description: "blocks writes to secrets",
        source: VALID_BLOCK_SOURCE,
        enforce: true,
        scope: "project",
        matcher: { path_glob: "**/secrets/*.txt" },
      },
      ctx.deps,
    );

    // The nested shape the executor emits, matching path.
    const blocked = await ctx.runner.dispatch("PreToolUse", { toolName: "write_file", args: { path: "config/secrets/token.txt", content: "x" } });
    assert.equal(blocked.allow, false, "a matching nested path must reach the hook and block");

    // A non-matching path must not be touched by this hook.
    const allowed = await ctx.runner.dispatch("PreToolUse", { toolName: "write_file", args: { path: "src/index.ts", content: "x" } });
    assert.equal(allowed.allow, true, "a non-matching path must not fire the hook");
  } finally {
    ctx.cleanup();
  }
});

test("a cmd_pattern matcher matches the command in the nested tool arguments", async () => {
  const ctx = setup();
  try {
    await handleCreateHook(
      {
        id: "block-dangerous-rm",
        event: "PreToolUse",
        description: "blocks rm -rf",
        source: VALID_BLOCK_SOURCE,
        enforce: true,
        scope: "project",
        matcher: { cmd_pattern: "rm\\s+-rf" },
      },
      ctx.deps,
    );

    const blocked = await ctx.runner.dispatch("PreToolUse", { toolName: "bash", args: { cmd: "rm -rf /tmp/scratch" } });
    assert.equal(blocked.allow, false, "a matching nested command must block");

    const allowed = await ctx.runner.dispatch("PreToolUse", { toolName: "bash", args: { cmd: "ls -la" } });
    assert.equal(allowed.allow, true, "a non-matching command must not block");
  } finally {
    ctx.cleanup();
  }
});

test("a bare `return false` from an enforcing hook blocks the call", async () => {
  const ctx = setup();
  try {
    /*
     * The documented contract is `{ allow: false }`, but a bare boolean is the
     * natural reading of "the result decides the outcome". It used to be a
     * silent no-op: the call went through and nothing reported a problem. A
     * blocking hook that does not block is the failure this test exists for.
     */
    await handleCreateHook(
      { id: "bare-false", event: "PreToolUse", description: "block", source: "return false;", enforce: true, scope: "project" },
      ctx.deps,
    );
    const result = await ctx.runner.dispatch("PreToolUse", { toolName: "bash", args: { cmd: "echo hi" } });
    assert.equal(result.allow, false, "`return false` must block");
  } finally {
    ctx.cleanup();
  }
});
