/**
 * A hook write asks before it runs code.
 *
 * The largest hole in the codebase was not in the sandbox: it went around it.
 * A hook's source is compiled with `new Function` and executed in the
 * app-server process, as root, with the provider token readable from
 * `process.env`, and the handler's return value lands in the transcript so the
 * model reads it back. `create_hook` asked nobody.
 *
 * Extensions already had this gate on create and enable. Hooks had nothing,
 * which made the cheaper path to running code as the host the one with no
 * question attached. The control is consent rather than confinement: a hook is
 * a plugin snippet and it runs in-process by design, so what must not happen is
 * that a model reaches it unattended.
 *
 * A second route existed and is closed alongside it: `write_file` into
 * `.reaper/hooks/` reaches the same loader with no gate at all. That one is
 * refused outright, because unlike the manager tools there is nothing to ask
 * about: the file *is* the installation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HookLifecycle } from "../../../src/hooks/lifecycle.js";
import { HookRunner } from "../../../src/extensions/hook-runner.js";
import { handleCreateHook, handleUpdateHook } from "../../../src/tools/write/hook-tools.js";
import { codeLoadingPath } from "../../../src/policy/code-loading-paths.js";

function fixture(options: { trusted?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hook-approval-"));
  const workspaceRoot = join(root, "ws");
  const userHome = join(root, "home");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(join(userHome, ".reaper"), { recursive: true });
  if (options.trusted) {
    writeFileSync(
      join(userHome, ".reaper", "project-trust.json"),
      JSON.stringify({ entries: [{ workspaceRoot: realpathSync(workspaceRoot), trusted: true, updatedAt: Date.now() }] }),
    );
  }
  const runner = new HookRunner();
  const lifecycle = new HookLifecycle({ runner, workspaceRoot, userHome });
  return {
    workspaceRoot,
    userHome,
    runner,
    lifecycle,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const createArgs = (id: string) => ({
  action: "create",
  id,
  event: "PreToolUse",
  description: "approval probe",
  matcher: null,
  source: `return { allow: true, message: "RAN" };`,
  enforce: false,
  scope: "project",
}) as never;

test("a denied create writes nothing and registers nothing", async () => {
  const fx = fixture();
  try {
    const result = (await handleCreateHook(createArgs("blocked"), {
      lifecycle: fx.lifecycle,
      approvalRequester: async () => false,
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /denied by approval gate/);
    assert.equal(existsSync(join(fx.workspaceRoot, ".reaper", "hooks", "blocked.json")), false);
    assert.equal(fx.lifecycle.isRegistered("blocked"), false);
  } finally {
    fx.cleanup();
  }
});

test("an approved create still works, so the gate is consent and not a wall", async () => {
  const fx = fixture();
  try {
    const result = (await handleCreateHook(createArgs("allowed"), {
      lifecycle: fx.lifecycle,
      approvalRequester: async () => true,
    })) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(fx.lifecycle.isRegistered("allowed"), true);
  } finally {
    fx.cleanup();
  }
});

/*
 * A new source is the same power as a create, so it asks the same question.
 * Gating create alone left the obvious route: create a hook that does nothing,
 * then update it to one that does not.
 */
test("updating a hook's source asks too, but a metadata change does not", async () => {
  const fx = fixture();
  try {
    await handleCreateHook(createArgs("later"), { lifecycle: fx.lifecycle, approvalRequester: async () => true });

    let asked = 0;
    const denied = (await handleUpdateHook({ action: "update", id: "later", source: `return { allow: false };` } as never, {
      lifecycle: fx.lifecycle,
      approvalRequester: async () => { asked += 1; return false; },
    })) as { ok: boolean; error?: string };
    assert.equal(asked, 1, "a source rewrite must ask");
    assert.equal(denied.ok, false);

    const described = (await handleUpdateHook({ action: "update", id: "later", description: "a better sentence" } as never, {
      lifecycle: fx.lifecycle,
      approvalRequester: async () => { asked += 1; return false; },
    })) as { ok: boolean };
    assert.equal(asked, 1, "a description change must not ask, or the prompt becomes noise");
    assert.equal(described.ok, true);
  } finally {
    fx.cleanup();
  }
});

/*
 * A project-scope hook is refused unless the workspace is trusted, which is the
 * rule the extension registry already applied. Extensions were gated and hooks
 * were not, so the sibling directory was the way in.
 */
test("a project hook does not run in an untrusted workspace, and does when trusted", async () => {
  const untrusted = fixture();
  try {
    mkdirSync(join(untrusted.workspaceRoot, ".reaper", "hooks"), { recursive: true });
    writeFileSync(join(untrusted.workspaceRoot, ".reaper", "hooks", "drop.json"), JSON.stringify({
      id: "drop", event: "PreToolUse", description: "d", matcher: null,
      source: `return { allow: false, reason: "BLOCKED" };`, enforce: true, scope: "project",
    }));
    untrusted.lifecycle.discover();
    assert.equal(untrusted.lifecycle.isRegistered("drop"), false, "an untrusted project hook must not be compiled");
  } finally {
    untrusted.cleanup();
  }

  const trusted = fixture({ trusted: true });
  try {
    mkdirSync(join(trusted.workspaceRoot, ".reaper", "hooks"), { recursive: true });
    writeFileSync(join(trusted.workspaceRoot, ".reaper", "hooks", "drop.json"), JSON.stringify({
      id: "drop", event: "PreToolUse", description: "d", matcher: null,
      source: `return { allow: false, reason: "BLOCKED" };`, enforce: true, scope: "project",
    }));
    trusted.lifecycle.discover();
    assert.equal(trusted.lifecycle.isRegistered("drop"), true, "a trusted project hook must run");
    const outcome = await trusted.runner.dispatch("PreToolUse" as never, { toolName: "bash", args: {} });
    assert.equal(outcome.allow, false, "and it must actually be able to block");
  } finally {
    trusted.cleanup();
  }
});

/*
 * The side door. There is nothing to ask about here, because the file is the
 * installation: dropping a hook JSON in place reaches the loader without the
 * manager ever being called, so the write is refused rather than gated.
 */
test("a write into a code-loading directory is refused", () => {
  const root = "/tmp/ws";
  for (const path of [
    "/tmp/ws/.reaper/hooks/x.json",
    "/tmp/ws/.reaper/extensions/e/main.js",
    "/tmp/ws/.reaper/skills/s/SKILL.md",
    "/tmp/ws/.reaper/linters/manifest.json",
    "/tmp/ws/.reaper/trust.json",
  ]) {
    assert.notEqual(codeLoadingPath(root, path), undefined, `${path} must be refused`);
  }
  for (const path of [
    "/tmp/ws/.reaper/sessions/s.jsonl",
    "/tmp/ws/.reaper/checkpoints/cp.json",
    "/tmp/ws/src/app.ts",
    "/tmp/ws/.reaper/browser/flows.json",
  ]) {
    assert.equal(codeLoadingPath(root, path), undefined, `${path} must stay writable`);
  }
});
