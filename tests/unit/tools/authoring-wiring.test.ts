/**
 * The join between the executor and the three authoring manager tools.
 *
 * `skill_manager`, `extension_manager`, and `hook_manager` each have two
 * halves that were separately written and separately tested:
 *
 *   - the handler (`handleSkillManager` and friends), exercised directly with
 *     hand-built dependencies;
 *   - the executor's dispatch switch, which forwards to
 *     `ToolExecutorOptions.authoringTools`.
 *
 * Nothing supplied that option. Every caller constructed a `ToolExecutor`
 * without it, so all three tools were advertised to the model, promotable by
 * `search_tools`, returned a schema, and then answered every call with "not
 * wired for this run" — from the day they were added. Both halves passed their
 * own tests the whole time, because each test built what the other was supposed
 * to provide.
 *
 * The same shape of gap sat next to it: the executor's PreToolUse /
 * PostToolUse / PreSkillInvoke gates read `options.hooks`, and no caller set
 * that either, so an approved hook registered on a runner that no gate ever
 * consulted.
 *
 * So these tests deliberately do not build dependencies by hand. They build the
 * runtime the engine builds, hand it to a real `ToolExecutor`, and assert that
 * a manager call comes back with an answer rather than a wiring error. If the
 * option is dropped again, the first test fails.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AuthoringRuntime } from "../../../src/tools/write/authoring-deps.js";
import { runnerAsHooks } from "../../../src/runtime/hook-bridge.js";
import { HookRunner } from "../../../src/extensions/hook-runner.js";
import { ToolExecutor } from "../../../src/tools/executor.js";

async function withWorkspace<T>(fn: (workspaceRoot: string, userHome: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "reaper-authoring-ws-"));
  const userHome = await mkdtemp(path.join(tmpdir(), "reaper-authoring-home-"));
  try {
    return await fn(workspaceRoot, userHome);
  } finally {
    /*
     * `maxRetries` rather than a bare recursive rm. A manager call can leave a
     * background write (an index flush, a discovery walk) still settling, and
     * the cleanup then loses the race and fails the *test* — reporting a
     * filesystem timing artifact as a product failure. Cleanup is not what is
     * being asserted here.
     */
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    await rm(userHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

test("the authoring runtime supplies all three managers, not undefined", () => {
  // The exact assertion that would have caught the original defect in one line.
  // `build()` returning a record whose keys are present but undefined is the
  // failure mode: the executor's `?.` then falls through to the same
  // "not wired" throw as an absent option.
  return withWorkspace(async (workspaceRoot, userHome) => {
    const deps = new AuthoringRuntime({ workspaceRoot, userHome }).build();

    for (const key of ["handleSkillManager", "handleExtensionManager", "handleHookManager"] as const) {
      assert.equal(
        typeof deps[key],
        "function",
        `${key} is not supplied; a call through it will throw "not wired for this run"`,
      );
    }
  });
});

test("skill_manager runs through the supplied deps instead of refusing", () =>
  withWorkspace(async (workspaceRoot, userHome) => {
    const deps = new AuthoringRuntime({ workspaceRoot, userHome }).build();

    // `uninstall` of a skill that does not exist, deliberately. It is the
    // cheapest action that reaches the lifecycle and comes back with a normal
    // domain answer ("no such skill") rather than a wiring error — and unlike
    // `create` it writes nothing, so the test has no fixture to clean up.
    //
    // `skill_manager` has no `list` action at all; an earlier version of this
    // test asked for one and the handler returned `undefined`, which looked
    // like a wiring failure and was not. The action set is the schema's:
    // create, test, approve, uninstall.
    const result = (await deps.handleSkillManager!({ action: "uninstall", name: "no-such-skill" })) as {
      ok?: boolean;
      error?: string;
    };

    assert.notEqual(
      typeof result,
      "string",
      "the handler returned a bare string, which is how the executor reports an unwired tool",
    );
    assert.doesNotMatch(
      String(result.error ?? ""),
      /not wired|no authoringTools/i,
      `skill_manager is still unwired: ${result.error}`,
    );
  }));

test("hook_manager runs against the runner the executor gates will dispatch to", () =>
  withWorkspace(async (workspaceRoot, userHome) => {
    const runner = new HookRunner();
    const deps = new AuthoringRuntime({ workspaceRoot, userHome, hookRunner: runner }).build();

    const created = (await deps.handleHookManager!({
      action: "create",
      id: "wiring-probe",
      event: "PreToolUse",
      description: "proves the manager shares the executor's runner",
      source: "export default async function (event) { return { decision: 'observe' }; }",
      enforce: false,
      scope: "project",
    })) as { ok?: boolean; error?: string };

    // The create may legitimately be refused by a policy that is not under test
    // here (approval, trust, source validation) — but a *wiring* failure speaks
    // in its own words and must never be the reason.
    assert.doesNotMatch(
      String(created.error ?? ""),
      /not wired|no authoringTools/i,
      `hook_manager is still unwired: ${created.error}`,
    );
  }));

test("an approved enforce hook can veto through the forwarder the executor uses", () =>
  withWorkspace(async (workspaceRoot, userHome) => {
    const runner = new HookRunner();
    const deps = new AuthoringRuntime({ workspaceRoot, userHome, hookRunner: runner }).build();
    void deps;

    // Register directly rather than approving a draft: the property under test
    // is the forwarder's veto pass-through, and routing it through approval
    // would make the test depend on the approval policy instead.
    runner.register("test-hook", "PreToolUse", async () => ({ allow: false, reason: "blocked by test hook" }), {
      blockable: true,
    });

    const hooks = runnerAsHooks(runner);
    assert.ok(hooks, "runnerAsHooks must forward the runner, not drop it");

    const outcome = await hooks.emit({ name: "PreToolUse", payload: { toolName: "bash" }, blockable: true });

    assert.equal(
      outcome.allow,
      false,
      "an enforce hook's refusal was discarded; the executor would have run the tool anyway",
    );
    assert.match(String(outcome.reason ?? ""), /blocked by test hook/);
  }));

test("an allow hook does not block through the forwarder", () =>
  withWorkspace(async (workspaceRoot) => {
    const runner = new HookRunner();
    runner.register("observe-hook", "PreToolUse", async () => ({ allow: true }), { blockable: false });

    const outcome = await runnerAsHooks(runner)!.emit({
      name: "PreToolUse",
      payload: { toolName: "bash" },
      blockable: true,
    });

    assert.equal(outcome.allow, true, "an observing hook must not veto");
  }));

test("runnerAsHooks returns undefined for no runner so the option stays absent", () => {
  // The engine spreads this into the executor options. Returning an object that
  // silently allows everything would make a missing runner indistinguishable
  // from a runner with no hooks, which is the same "confident answer it did not
  // earn" shape this codebase keeps having to unlearn.
  assert.equal(runnerAsHooks(undefined), undefined);
});

test("a real ToolExecutor runs skill_manager when authoringTools is supplied", () =>
  withWorkspace(async (workspaceRoot, userHome) => {
    // The end-to-end version of the first test, and the one that matches how
    // the bug was found: a model calling the tool. The executor is the layer
    // that threw "not wired for this run", so a test that stops short of it
    // would not have caught the defect and would not catch a regression.
    const executor = new ToolExecutor({
      workspaceRoot,
      runId: "authoring-wiring-run",
      sessionId: "authoring-wiring-session",
      traceId: "authoring-wiring-trace",
      logLevel: "info",
      safetyProfile: "allow_all",
      authoringTools: new AuthoringRuntime({ workspaceRoot, userHome }).build(),
    });

    const result = await executor.execute({
      id: "unwire-check",
      name: "skill_manager",
      args: { action: "uninstall", name: "no-such-skill" },
    });

    // Before the fix this was `ok: false` with "skill_manager is not wired for
    // this run". Any other outcome means the call reached the handler.
    const text = `${result.ok ? "" : (result.error?.message ?? "")} ${result.output ?? ""}`;
    assert.doesNotMatch(
      text,
      /not wired for this run|no authoringTools/i,
      `the executor still refuses the tool: ${text.slice(0, 300)}`,
    );
  }));

test("extension_manager is reachable through the supplied deps", () =>
  withWorkspace(async (workspaceRoot, userHome) => {
    const deps = new AuthoringRuntime({ workspaceRoot, userHome }).build();

    // `validate` names an extension that is not installed. Like the skill test
    // above, the point is that the call returns a domain answer from a real
    // registry walk rather than a wiring error, without installing anything.
    const result = (await deps.handleExtensionManager!({ action: "validate", id: "no-such-extension" })) as {
      ok?: boolean;
      error?: string;
    };

    assert.notEqual(typeof result, "string", "the handler was never reached");
    assert.doesNotMatch(
      String(result.error ?? ""),
      /not wired|no authoringTools/i,
      `extension_manager is still unwired: ${result.error}`,
    );
  }));
