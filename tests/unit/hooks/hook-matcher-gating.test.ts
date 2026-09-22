/**
 * Hook matcher gating and the block contract.
 *
 * Four defects, each reproduced by executing the tool rather than by reading the
 * code, and each fixed in `src/hooks/lifecycle.ts`, `src/hooks/sandbox.ts` or
 * `src/tools/executor.ts`:
 *
 *   1. `path_glob` did not gate. A hook naming the file one way did not stop a
 *      call that named it the other way, so `**` coverage depended on how the
 *      model happened to spell the path.
 *   2. `cmd_pattern` did not read every shape a command arrives in.
 *   3. `return false` blocked, but the model was told only "blocked by hook",
 *      with nothing naming the hook that refused.
 *   4. A non-enforcing handler's `note` reached nobody.
 *
 * Every case below drives a real `ToolExecutor` or a real `HookRunner` carrying
 * a real `HookLifecycle`, because a hook that is read back from `list_hooks`
 * proves nothing about what happens to a tool call.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HookLifecycle } from "../../../src/hooks/lifecycle.js";
import { HookRunner } from "../../../src/extensions/hook-runner.js";
import { compileHookSource } from "../../../src/hooks/sandbox.js";
import { runnerAsHooks } from "../../../src/runtime/hook-bridge.js";
import { ToolExecutor } from "../../../src/tools/executor.js";
import { buildAgentToolDescriptor } from "../../../src/runtime/agent-tools.js";
import { toolRegistry } from "../../../src/tools/registry.js";

interface Ctx {
  tmp: string;
  workspaceRoot: string;
  userHome: string;
  runner: HookRunner;
  lifecycle: HookLifecycle;
  cleanup(): void;
}

function setup(): Ctx {
  const tmp = mkdtempSync(join(tmpdir(), "reaper-hook-matcher-"));
  const userHome = join(tmp, "home");
  const workspaceRoot = join(tmp, "ws");
  mkdirSync(join(userHome, ".reaper"), { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const runner = new HookRunner();
  return {
    tmp,
    workspaceRoot,
    userHome,
    runner,
    lifecycle: new HookLifecycle({ runner, workspaceRoot, userHome }),
    cleanup: () => {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** Block with words, so a refusal is attributable to the hook that made it. */
const BLOCK_SOURCE = `return { allow: false, reason: "BLOCKED" };`;

function addHook(ctx: Ctx, matcher: Record<string, string>): void {
  const created = ctx.lifecycle.create({
    id: "gate",
    event: "PreToolUse",
    description: "gates one call",
    matcher,
    source: BLOCK_SOURCE,
    enforce: true,
    scope: "user",
  });
  assert.equal(created.ok, true, `hook creation failed: ${created.error ?? ""}`);
}

/** A real executor whose PreToolUse gate is the runner the hook was written to. */
function executorFor(ctx: Ctx): ToolExecutor {
  return new ToolExecutor({
    workspaceRoot: ctx.workspaceRoot,
    runId: "matcher-run",
    sessionId: "matcher-session",
    traceId: "matcher-trace",
    logLevel: "info",
    safetyProfile: "allow_all",
    hooks: runnerAsHooks(ctx.runner),
  } as never);
}

async function refused(tool: ToolExecutor, name: string, args: Record<string, unknown>): Promise<boolean> {
  const result = await tool.execute({ id: "call", name, args } as never);
  return !result.ok && result.error?.code === "hook_blocked";
}

/* -------------------------------------------------------------------------- */
/* path_glob                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The same file, spelled two ways, has to hit the same hook.
 *
 * A hook is written against a path, and the model writes whatever path it likes.
 * `write_file({path: "config/blocked.txt"})` and
 * `write_file({path: "<root>/config/blocked.txt"})` are the same write, so a
 * glob that gated one and not the other is a guard with a spelling-shaped hole
 * in it. The relative form is compared as written and against the workspace
 * root, which is what makes the two equal.
 */
test("a path_glob matcher gates the call whether the argument is relative or absolute", async () => {
  const relative = setup();
  try {
    addHook(relative, { path_glob: "blocked.txt" });
    const tool = executorFor(relative);
    assert.equal(
      await refused(tool, "write_file", { path: join(relative.workspaceRoot, "blocked.txt"), content: "x" }),
      true,
      "an absolute argument must satisfy a relative path_glob: it is the same file",
    );
    assert.equal(
      await refused(tool, "write_file", { path: "unrelated.txt", content: "x" }),
      false,
      "a glob must not gate a file it does not name",
    );
  } finally {
    relative.cleanup();
  }

  const absolute = setup();
  try {
    addHook(absolute, { path_glob: join(absolute.workspaceRoot, "blocked.txt") });
    const tool = executorFor(absolute);
    assert.equal(
      await refused(tool, "write_file", { path: "blocked.txt", content: "x" }),
      true,
      "a relative argument must satisfy an absolute path_glob: it is the same file",
    );
  } finally {
    absolute.cleanup();
  }
});

/**
 * A leading star-star segment covers no directory as well as any number of them.
 *
 * The glob is how a hook says "this file anywhere in the tree", and the first
 * translation required a separator after the star-star, so a glob of star-star,
 * slash, `secrets/*.txt` matched `config/secrets/token.txt` and skipped the bare
 * `secrets/token.txt`. Whether the hook protected a file came down to how deep
 * the model wrote the path, which is not something the matcher's author chose.
 */
test("a leading ** segment matches a path with no directory part", async () => {
  const ctx = setup();
  try {
    addHook(ctx, { path_glob: "**/secrets/*.txt" });
    const tool = executorFor(ctx);
    assert.equal(
      await refused(tool, "write_file", { path: "secrets/token.txt", content: "x" }),
      true,
      "**/secrets/*.txt must match the bare secrets/token.txt",
    );
    assert.equal(
      await refused(tool, "write_file", { path: "config/secrets/token.txt", content: "x" }),
      true,
      "and must still match it below a directory",
    );
    assert.equal(
      await refused(tool, "write_file", { path: "secrets/token.md", content: "x" }),
      false,
      "and must not match a different extension",
    );
  } finally {
    ctx.cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* cmd_pattern                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A command arrives in more than one shape, and the matcher reads all of them.
 *
 * The executor nests arguments under `args` as an object; a provider that sends
 * `arguments` as a JSON string is parsed by `normalizeToolCall` for exactly this
 * reason, and an extension emitting its own `PreToolUse` on the bus chooses its
 * own payload shape. Reading only the object form left the string form unmatched
 * and silent, which is the same failure as a hook that never fired.
 */
test("a cmd_pattern matcher reads the command from the nested argument shapes", async () => {
  const ctx = setup();
  try {
    addHook(ctx, { cmd_pattern: "MARKER" });
    const runner = ctx.runner;

    const nested = await runner.dispatch("PreToolUse", { toolName: "bash", args: { cmd: "echo MARKER" } });
    assert.equal(nested.allow, false, "a nested cmd must be matched");

    const asJsonString = await runner.dispatch("PreToolUse", { toolName: "bash", args: '{"cmd":"echo MARKER"}' });
    assert.equal(asJsonString.allow, false, "a string-encoded argument bag must be parsed and matched");

    const spelledCommand = await runner.dispatch("PreToolUse", { toolName: "bash", args: { command: "echo MARKER" } });
    assert.equal(spelledCommand.allow, false, "the `command` spelling must be matched");

    const unrelated = await runner.dispatch("PreToolUse", { toolName: "bash", args: { cmd: "ls -la" } });
    assert.equal(unrelated.allow, true, "a command without the pattern must pass");
  } finally {
    ctx.cleanup();
  }
});

/**
 * The tool name is matched under the key the matcher's own schema uses.
 *
 * `tool_name` is the field name in `HookMatcher` and in the create schema, so a
 * payload carrying `tool_name` is the natural pairing. Reading only `toolName`
 * made such a hook inert, and an inert enforcing hook is indistinguishable from
 * one that approved the call.
 */
test("a tool_name matcher matches a payload that spells the tool snake_case", async () => {
  const ctx = setup();
  try {
    addHook(ctx, { tool_name: "bash" });
    const blocked = await ctx.runner.dispatch("PreToolUse", { tool_name: "bash", cmd: "echo hi" });
    assert.equal(blocked.allow, false, "a snake_case tool_name payload must be matched");
    const other = await ctx.runner.dispatch("PreToolUse", { tool_name: "write_file", cmd: "echo hi" });
    assert.equal(other.allow, true, "a different tool must not be gated");
  } finally {
    ctx.cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* The block contract                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A bare `false` from an enforcing hook blocks, and the refusal names the hook.
 *
 * `false` is the natural reading of "the result decides the outcome", and it
 * blocks. What it did not do was say which hook refused: the model was told
 * "blocked by hook", which leaves it with a call it cannot make and no way to
 * find out what it broke. The hook id is the one fact that makes the message
 * actionable, so it is added when the handler supplied no words of its own.
 */
test("a bare false from an enforcing hook blocks with a message naming the hook", async () => {
  const ctx = setup();
  try {
    const created = ctx.lifecycle.create({
      id: "bare-false",
      event: "PreToolUse",
      description: "refuses without explaining",
      matcher: { tool_name: "bash" },
      source: "return false;",
      enforce: true,
      scope: "user",
    });
    assert.equal(created.ok, true, `hook creation failed: ${created.error ?? ""}`);

    const outcome = await ctx.runner.dispatch("PreToolUse", { toolName: "bash", args: { cmd: "echo hi" } });
    assert.equal(outcome.allow, false, "`return false` from an enforcing hook must block");
    assert.match(
      String(outcome.firstDenyReason ?? ""),
      /bare-false/,
      `the refusal must name the hook that made it, got ${JSON.stringify(outcome.firstDenyReason)}`,
    );
  } finally {
    ctx.cleanup();
  }
});

/**
 * The documented contract is the one the tool advertises.
 *
 * The description said only that the handler's "result decides the outcome",
 * which left the reader to guess between `return false`, `return {blocked:true}`
 * and a thrown error. A hook author reads the description and the schema and
 * nothing else, so both have to state what actually happens: `enforce: true` is
 * what lets a hook block, `return false` is a block, and `{allow:false, reason}`
 * is the form that carries a reason.
 */
test("the hook tool description and matcher schema state the block contract", () => {
  const description = toolRegistry.hook_manager.description;
  assert.match(description, /allow: false/, "the description must name the { allow: false } form");
  assert.match(description, /return false/i, "and must say that a bare `false` blocks");
  assert.match(description, /enforce: true/, "and must say that only an enforcing hook can block");
  assert.match(description, /matcher/, "and must say what the matcher fields do");

  /*
   * Read through `buildAgentToolDescriptor`, which is the schema the model is
   * actually handed. Asserting on the zod object would test a structure rather
   * than the wire: `describe` reaches the model only because `toJSONSchema` in
   * `agent-tools.ts` renders it, so a matcher field that carries a description
   * zod drops would still leave the model guessing.
   */
  const descriptor = buildAgentToolDescriptor("hook_manager");
  assert.ok(descriptor, "hook_manager must have a model-facing descriptor");
  const matcher = findMatcherSchema(descriptor.inputSchema);
  assert.ok(matcher, "the wire schema must carry the matcher object");
  for (const field of ["path_glob", "tool_name", "cmd_pattern"]) {
    const property = (matcher.properties as Record<string, { description?: string }>)[field];
    assert.ok(property, `${field} must be in the wire schema`);
    assert.ok(
      typeof property.description === "string" && property.description.length > 20,
      `${field} must describe what it matches on the wire, got ${JSON.stringify(property.description)}`,
    );
  }
});

/**
 * The matcher object as it appears on the wire, under whichever action branch.
 *
 * `HookManagerArgsSchema` is a discriminated union, so the JSON schema is an
 * `anyOf` of one full object per action and the matcher sits at the same path in
 * each. Searching rather than indexing keeps this test about the descriptions
 * instead of about the union's layout.
 */
function findMatcherSchema(schema: unknown): { properties: Record<string, unknown> } | undefined {
  const visit = (node: unknown): { properties: Record<string, unknown> } | undefined => {
    if (!node || typeof node !== "object") return undefined;
    const record = node as Record<string, unknown>;
    const properties = record.properties as Record<string, unknown> | undefined;
    const candidate = properties?.matcher as { properties?: Record<string, unknown> } | undefined;
    if (candidate?.properties) return { properties: candidate.properties };
    for (const value of Object.values(record)) {
      const found = visit(value);
      if (found) return found;
    }
    return undefined;
  };
  return visit(schema);
}

/* -------------------------------------------------------------------------- */
/* Advice from an observe-only hook                                           */
/* -------------------------------------------------------------------------- */

/**
 * A non-enforcing hook's `note` has to reach the model.
 *
 * `message` is the field the runtime carries and the executor shows as the tool
 * result's `hint`. A handler that writes its advice under `note` has written
 * advice nothing reads: the hook runs, returns a sentence, and the tool result
 * is unchanged. Both spellings mean the same thing to the person writing the
 * hook, so both arrive as `message`.
 */
test("a note from an observe-only hook appears in the tool result of the call it matched", async () => {
  const ctx = setup();
  try {
    const created = ctx.lifecycle.create({
      id: "advise",
      event: "PreToolUse",
      description: "advises",
      // `tool_name` alone, so this case is about the note reaching the result
      // and not about the glob: a matcher that fails would stop the handler and
      // the hint would be missing for an unrelated reason.
      matcher: { tool_name: "write_file" },
      source: `return { allow: true, note: "prefer edit_file for this file" };`,
      enforce: false,
      scope: "user",
    });
    assert.equal(created.ok, true, `hook creation failed: ${created.error ?? ""}`);

    const matched = await executorFor(ctx).execute({
      id: "call",
      name: "write_file",
      args: { path: "notes.txt", content: "x" },
    } as never);
    assert.equal(matched.ok, true, "an observe-only hook must not block the call");
    assert.equal(
      (matched as { hint?: string }).hint,
      "prefer edit_file for this file",
      "the hook's note must reach the tool result as its hint",
    );
  } finally {
    ctx.cleanup();
  }
});

/**
 * The advice survives a call that failed.
 *
 * An observer speaks before the call, and a call that then fails is where its
 * sentence matters most. The hint was built inside the success path, so it was
 * dropped in exactly the case the hook was written for.
 */
test("an observe-only hook's advice is attached to a failed call too", async () => {
  const ctx = setup();
  try {
    const created = ctx.lifecycle.create({
      id: "advise-failure",
      event: "PreToolUse",
      description: "advises",
      matcher: { tool_name: "bash" },
      source: `return { allow: true, note: "run the focused test, not the whole suite" };`,
      enforce: false,
      scope: "user",
    });
    assert.equal(created.ok, true, `hook creation failed: ${created.error ?? ""}`);

    const failed = await executorFor(ctx).execute({
      id: "call",
      name: "bash",
      args: { cmd: "command-that-does-not-exist-anywhere" },
    } as never);
    assert.equal(failed.ok, false, "the command must fail, so the failure path is the one under test");
    assert.equal(
      (failed as { hint?: string }).hint,
      "run the focused test, not the whole suite",
      "advice given before a call must survive the call failing",
    );
  } finally {
    ctx.cleanup();
  }
});

/**
 * `compileHookSource` is where the note becomes a message, and it is reachable
 * without a runner — so the normalization is asserted directly, including the
 * async path, which no other test in this file covers.
 */
test("a compiled handler normalizes note, bare boolean and async results", async () => {
  const noted = compileHookSource(`return { allow: true, note: "n" };`);
  assert.equal(noted.ok, true);
  assert.deepEqual(noted.handler!({ name: "PreToolUse", payload: {}, blockable: true }), {
    allow: true,
    message: "n",
  });

  const bare = compileHookSource("return false;");
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.handler!({ name: "PreToolUse", payload: {}, blockable: true }), { allow: false });

  const asyncNoted = compileHookSource(`return Promise.resolve({ allow: true, note: "later" });`);
  assert.equal(asyncNoted.ok, true);
  const resolved = await asyncNoted.handler!({ name: "PreToolUse", payload: {}, blockable: true });
  assert.deepEqual(resolved, { allow: true, message: "later" });
});
