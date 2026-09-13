/**
 * Code Mode — the `eval` tool.
 *
 * The cases here are the ones the feature's contract rests on, and they are
 * grouped by what they are protecting rather than by which module they touch:
 *
 * 1. **The sandbox runs JavaScript.** Completion-value semantics, modern
 *    syntax, loops, async, serialization — the things that make eval worth
 *    reaching for.
 * 2. **The sandbox is isolated.** No host globals, no recursion into `eval`,
 *    no state carried between runs.
 * 3. **The sandbox is bounded.** Timeout, memory, result size, console size,
 *    tool-call count, cancellation — each one has to end the call rather than
 *    the process.
 * 4. **Permissions survive the bridge.** An inner call goes through the real
 *    executor, so a disabled tool is refused inside a script exactly as it
 *    would be outside one.
 *
 * The one that would be easiest to let rot is #4, because it is the only one
 * that spans two modules and a passing test for it looks like a passing test
 * for any other tool call.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ReaperNodeRuntime } from "../../src/tools/code/node-runtime.js";
import { ReaperToolBridge } from "../../src/tools/code/bridge.js";
import { isDangerousCommand, isDangerousPath } from "../../src/tools/code/guard.js";
import {
  sourceLineFromStack,
  splitTrailingExpression,
  liftTrailingBlocks,
  wrapWithTail,
  wrapWithoutTail,
} from "../../src/tools/code/transform.js";
import { evaluateScript } from "../../src/tools/eval.js";
import type { ToolCall } from "../../src/tools/types.js";
import { toolRegistry, CORE_TOOL_NAMES } from "../../src/tools/registry.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { SandboxPolicy } from "../../src/policy/sandbox.js";
import type {
  CodeRuntimeLimits,
  CodeRuntimeResult,
  CodeToolDescriptor,
  CodeToolHost,
  CodeToolInvocation,
  CodeToolOutcome,
} from "../../src/tools/code/types.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The sandbox's `tools.*` surface for a test that only cares about plumbing. */
const FIXTURE_TOOLS: CodeToolDescriptor[] = [
  { name: "read", description: "Read a file from the workspace." },
  { name: "grep", description: "Search files for a pattern." },
];

/**
 * Three lines, and the tests that count them derive the number rather than
 * writing it down. `"alpha\nbeta\ngamma".length` is 16, and two assertions
 * said 15 — a hand-counted expectation that was wrong from the start and made
 * a correct runtime look broken.
 */
const FIXTURE_TEXT = "alpha\nbeta\ngamma";
const FIXTURE_LINES = FIXTURE_TEXT.split("\n").length;

interface HostOptions {
  invoke?: (invocation: CodeToolInvocation) => Promise<CodeToolOutcome>;
  names?: readonly string[];
}

function fixtureHost(options: HostOptions = {}): CodeToolHost {
  const names = options.names ?? ["read", "grep"];
  return {
    names: () => names,
    describe: (name) => (names.includes(name) ? { description: `The ${name} tool.`, inputSchema: { type: "object" } } : undefined),
    /*
     * Refuses a name that was never declared, the way real Reaper does.
     *
     * Without this the fixture answered *any* name successfully, including
     * names it had never heard of and names the runtime is supposed to withhold
     * — so a test could assert that `tools.eval` is unreachable and watch the
     * fixture cheerfully serve it. The host checks the registry; the fixture
     * checks its own `names`, and a test that gets this wrong now fails loudly
     * instead of passing on a lie.
     */
    invoke:
      options.invoke ??
      (async (invocation: CodeToolInvocation) =>
        names.includes(invocation.name)
          ? { ok: true, output: { path: "src/a.ts", text: FIXTURE_TEXT }, durationMs: 1 }
          : {
              ok: false,
              error: { code: "TOOL_NOT_EXPOSED", message: `No Reaper tool named '${invocation.name}'.` },
              durationMs: 0,
            }),
  };
}

/** Run one script and hand back the result, disposing the runtime either way. */
async function runScript(
  source: string,
  options: {
    host?: CodeToolHost;
    tools?: readonly CodeToolDescriptor[];
    limits?: Partial<CodeRuntimeLimits>;
    signal?: AbortSignal;
    /**
     * The thread workspace, defaulting to the process cwd.
     *
     * The default is what let a real defect hide through fifty-eight tests. In
     * production the workspace is `~/.reaper/workspaces/<threadId>` and the
     * server runs from Reaper's checkout, so the two are different trees; here
     * they were the same directory, and a script resolving a relative path
     * against either one got the same answer. Test 16e is the one that passes a
     * workspace and therefore the only one that can tell them apart.
     */
    workspace?: string;
  } = {},
): Promise<CodeRuntimeResult> {
  const runtime = await ReaperNodeRuntime.create(options.limits);
  try {
    return await runtime.run({
      source,
      tools: options.tools ?? FIXTURE_TOOLS,
      host: options.host ?? fixtureHost(),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.workspace ? { workspace: options.workspace } : {}),
    });
  } finally {
    runtime.dispose();
  }
}

// ---------------------------------------------------------------------------
// 1. Basic execution and return semantics
// ---------------------------------------------------------------------------

test("1. a bare expression is the result — `1 + 2` returns the number 3", async () => {
  const result = await runScript("1 + 2");
  assert.equal(result.status, "completed");
  // Not "3" and not `{value: 3}`. The completion value of the script is the
  // number, and the model should get the number.
  assert.equal(result.value, 3);
  assert.equal(result.toolCalls.length, 0);
});

test("1b. the last expression wins even when it is not the last line", async () => {
  const summed = await runScript("const values = [1, 2, 3, 4];\nvalues.reduce((a, b) => a + b, 0);");
  assert.equal(summed.value, 10);
});

test("2. arrays and objects serialize both ways and keep their types", async () => {
  const echoed = await runScript("const o = { a: [1, 2, { b: 'x' }], c: true, d: null }; o;");
  assert.deepEqual(echoed.value, { a: [1, 2, { b: "x" }], c: true, d: null });

  // A string result must come back as a string, not as quoted JSON text.
  const text = await runScript("'hello'");
  assert.equal(text.value, "hello");
  assert.equal(typeof text.value, "string");

  // `undefined` is distinct from `null`.
  const nothing = await runScript("const a = 1;");
  assert.equal(nothing.value, undefined);
  const explicit = await runScript("null");
  assert.equal(explicit.value, null);
});

test("2b. values that JSON would throw on are labelled rather than fatal", async () => {
  const circular = await runScript("const o = { name: 'x' }; o.self = o; o;");
  assert.equal(circular.status, "completed");
  assert.equal((circular.value as { self: unknown }).self, "[Circular]");

  const bigint = await runScript("10n");
  assert.equal(bigint.status, "completed");
  assert.equal(bigint.value, "10n");

  const fn = await runScript("function named() {}\nnamed;");
  assert.equal(fn.status, "completed");
  assert.equal(fn.value, "[Function: named]");
});

test("3. loops and aggregation run entirely inside the sandbox", async () => {
  const result = await runScript("let total = 0;\nfor (let i = 1; i <= 100; i += 1) total += i;\ntotal;");
  assert.equal(result.value, 5050);
});

// ---------------------------------------------------------------------------
// 4. The async bridge into Reaper tools
// ---------------------------------------------------------------------------

test("4. a script can await a Reaper tool", async () => {
  const result = await runScript("const file = await tools.read({ path: 'src/a.ts' });\nfile.text.split('\\n').length;");
  assert.equal(result.status, "completed");
  assert.equal(result.value, 3);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, "read");
  assert.equal(result.toolCalls[0]?.ok, true);
});

test("4b. the documented example shape works verbatim", async () => {
  // `grep` really returns an array of matches, so the fixture does too. The
  // default fixture returns one object, which made this test pass only because
  // nothing in it reached `.filter` — the exact call the example is built on.
  const host = fixtureHost({
    invoke: async () => ({
      ok: true,
      output: [
        { path: "src/a.ts", text: "alpha\nbeta\ngamma" },
        { path: "src/b.js", text: "ignored" },
        { path: "src/c.ts", text: "also kept" },
      ],
      durationMs: 1,
    }),
  });

  const result = await runScript(
    `
const matches = await tools.grep({ pattern: "TODO", path: "src" });
const interesting = matches.filter((x) => x.path.endsWith(".ts")).slice(0, 20);
interesting;
`,
    { host },
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(result.value, [
    { path: "src/a.ts", text: "alpha\nbeta\ngamma" },
    { path: "src/c.ts", text: "also kept" },
  ]);
});

test("4d2. a script whose value comes from a trailing block still returns it", async () => {
  /*
   * The ending covered here is the one an expression lift cannot reach: the
   * value belongs to a `try`/`catch` or an `if`/`else`, not to a fragment of
   * one. It matters more than it looks, because the hint Reaper attaches to a
   * rejected tool call literally tells the model to wrap it in a try/catch —
   * so this is the shape a model writes *because Reaper suggested it*, and it
   * used to come back with no result at all.
   */
  const host = fixtureHost({
    invoke: async () => ({ ok: false, error: { code: "ENOENT", message: "missing" }, durationMs: 1 }),
  });

  const tryCatch = await runScript(
    "try { await tools.read({ path: 'nope' }); 'read it' } catch (error) { 'failed: ' + error.code }",
    { host },
  );
  assert.equal(tryCatch.value, "failed: ENOENT");

  const ifElse = await runScript("const n = 3;\nif (n > 2) { 'big' } else { 'small' }");
  assert.equal(ifElse.value, "big");

  const ifWithoutElse = await runScript("const n = 1;\nif (n > 2) { 'big' }\nn;");
  assert.equal(ifWithoutElse.value, 1, "a trailing expression after a non-terminal block still wins");

  // A `finally` must not be used to carry the value: it runs on the returning
  // path too, so a `return` lifted into it would replace the real answer.
  const withFinally = await runScript(
    "try { 1 } catch (error) { 2 } finally { 3 }\n'after';",
  );
  assert.equal(withFinally.value, "after");
});

test("4d. a pure one-liner still returns its value", async () => {
  // The whole script is one expression, so there is no prefix to split from —
  // and that is the most common shape in Code Mode. An earlier splitter
  // required a non-empty prefix and silently dropped this value.
  const result = await runScript("(await tools.read({ path: 'a' })).text.length;");
  assert.equal(result.status, "completed");
  assert.equal(result.value, FIXTURE_TEXT.length);
  assert.equal(result.toolCalls.length, 1);
});

test("5. several tools compose in one call and intermediate data stays inside", async () => {
  let invocations = 0;
  const host = fixtureHost({
    invoke: async (invocation) => {
      invocations += 1;
      if (invocation.name === "grep") {
        return {
          ok: true,
          output: [
            { path: "src/a.ts", line: 1 },
            { path: "src/b.js", line: 2 },
            { path: "src/c.ts", line: 3 },
          ],
          durationMs: 1,
        };
      }
      return { ok: true, output: { text: `contents of ${(invocation.args as { path: string }).path}` }, durationMs: 1 };
    },
  });

  const result = await runScript(
    `
const matches = await tools.grep({ pattern: "TODO", path: "src" });
const results = [];
for (const match of matches) {
  if (!match.path.endsWith(".ts")) continue;
  const contents = await tools.read({ path: match.path });
  results.push({ file: match.path, lines: contents.text.length });
}
results;
`,
    { host },
  );

  assert.equal(result.status, "completed");
  assert.equal(invocations, 3, "one grep plus one read per TypeScript match");
  assert.deepEqual(result.value, [
    { file: "src/a.ts", lines: 20 },
    { file: "src/c.ts", lines: 20 },
  ]);
  // The loop, the filter and the accumulation happened in the sandbox; only two
  // small objects came back.
  assert.equal(result.toolCalls.length, 3);
});

test("4c. a tool failure is catchable, so a loop can survive one bad iteration", async () => {
  let call = 0;
  const host = fixtureHost({
    invoke: async () => {
      call += 1;
      if (call === 2) return { ok: false, error: { code: "ENOENT", message: "no such file" }, durationMs: 1 };
      return { ok: true, output: { text: "ok" }, durationMs: 1 };
    },
  });

  const result = await runScript(
    `
const out = [];
for (const path of ["a", "b", "c"]) {
  try {
    out.push((await tools.read({ path })).text);
  } catch (error) {
    out.push("ERR:" + error.message);
  }
}
out;
`,
    { host },
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(result.value, ["ok", "ERR:no such file", "ok"]);
});

test("12. an uncaught tool error is reported against the tool that failed", async () => {
  const host = fixtureHost({
    invoke: async () => ({ ok: false, error: { code: "ENOENT", message: "no such file" }, durationMs: 1 }),
  });
  const result = await runScript("await tools.read({ path: 'missing' });", { host });

  assert.equal(result.status, "error");
  assert.equal(result.error?.message, "no such file");
  assert.equal(result.toolError?.toolName, "read");
  assert.equal(result.toolError?.code, "ENOENT");
});

// ---------------------------------------------------------------------------
// 7 & 8. What the sandbox may reach
// ---------------------------------------------------------------------------

test("8. eval does not expose itself — the name is unbound and the call is refused", async () => {
  /*
   * `typeof tools.eval` is "function" and not "undefined", and that is the
   * right answer rather than a leak. The surface is a Proxy so that an
   * unavailable name can explain *why* it is unavailable; a model that typed
   * the name wrong and a model that reached for a tool this thread switched
   * off need different sentences, and a plain object cannot tell them apart.
   * What matters is that the name is not really bound and that calling it does
   * nothing but fail.
   */
  const bound = await runScript("'eval' in tools;");
  assert.equal(bound.value, false, "the name must not be genuinely bound");

  /*
   * Not merely absent: naming it is an error the model can read, not a
   * JavaScript "undefined is not a function". The read is attributable and
   * coded, so a script can branch on it the way it branches on any other
   * tool failure.
   *
   * The exact *wording* of that refusal is deliberately not asserted here. It
   * is the host's to phrase — this test's fixture says "no such tool" because
   * it has never heard of `eval` — and the sentence a real bridge produces is
   * checked against the real bridge below, where the claim is actually about
   * Reaper's registry rather than about a stub.
   */
  const attempt = await runScript(
    "try { await tools.eval({ code: '1' }); 'CALLED' } catch (error) { error.code + ':' + error.message; }",
  );
  assert.match(attempt.value as string, /^TOOL_NOT_EXPOSED:/, "the refusal is coded, so a script can branch on it");

  // Unknown names get the surface, not a JavaScript type error.
  const unknown = await runScript(
    "try { await tools.no_such_tool_here({}); 'CALLED' } catch (error) { error.code + ':' + error.message; }",
  );
  assert.match(unknown.value as string, /^TOOL_NOT_EXPOSED:/);
  // The "here is how to find out what you *can* use" tail is the real bridge's
  // line, and is asserted against the real bridge at the end of this test —
  // the fixture is a stub and only owes an honest refusal.

  // And the sandbox is not offered it in the first place.
  const catalogue = await runScript("tools.list().map((t) => t.name).join(',');");
  assert.equal(catalogue.value, "read,grep");

  /*
   * Through the real bridge, against the real registry: `tools.eval` fails
   * with a message that names the reason rather than implying a typo, and the
   * refusal is the bridge's own rather than the fixture's.
   *
   * The two halves are worth separating. The runtime can only promise that an
   * unavailable name is a coded rejection; only the bridge knows that this
   * particular name is withheld on purpose, and only the bridge can say so.
   */
  const workspaceRoot = await createTempWorkspace();
  const executor = await executorFor(workspaceRoot);
  const real = await executor.execute({
    id: "e1",
    name: "eval",
    args: { code: "try { await tools.eval({ code: '1' }); 'CALLED' } catch (error) { error.code + ':' + error.message; }" },
  });
  await executor.cleanupBackgroundProcesses("test");
  const message = (real.output as { value: string }).value;
  assert.match(message, /^TOOL_NOT_EXPOSED:/);
  assert.match(message, /cannot call itself/, "and it says why, rather than implying a typo");
});

test("7. the one withheld tool is refused by name, and a disabled tool with it", async () => {
  const bridge = new ReaperToolBridge({
    executor: { execute: async () => ({ toolCallId: "x", name: "diagnostics", ok: true, durationMs: 0 }) },
    disabledTools: new Set<string>(),
  });

  /*
   * `eval` is the only tool withheld by policy, and the test names it as the
   * withheld one rather than naming a tool that happens to be absent today.
   *
   * This previously asserted `search_tools` was invisible, which was the policy
   * at the time. That policy turned out to be wrong: the environment's job is
   * to hand the script every tool the agent can call, minus the cyclic one, and
   * the model decides what is worth reaching for. A test that asserts a tool is
   * hidden cannot tell "hidden for a reason" from "hidden by accident", so it
   * now asserts the property instead — exactly one name withheld, and it is the
   * one whose absence is load-bearing.
   */
  assert.equal(bridge.names().includes("eval"), false);
  assert.equal(bridge.names().includes("search_tools"), true, "search_tools must be callable from a script");

  const refused = await bridge.invoke({
    callId: "c1",
    name: "eval",
    args: { code: "1 + 1" },
    signal: new AbortController().signal,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.error.code, "TOOL_NOT_EXPOSED");

  // A tool the thread switched off is also invisible and also refused.
  const narrowed = new ReaperToolBridge({
    executor: { execute: async () => ({ toolCallId: "x", name: "bash", ok: true, durationMs: 0 }) },
    disabledTools: new Set(["bash"]),
  });
  assert.equal(narrowed.names().includes("bash"), false);
  const bash = await narrowed.invoke({ callId: "c2", name: "bash", args: { cmd: "ls" }, signal: new AbortController().signal });
  assert.equal(bash.ok, false);
});

test("7b. the names the model already knows work inside eval too", async () => {
  /*
   * The model learns tool names in two places and they did not agree. The
   * ordinary tool list folds aliases in — a model calls `read`, `write`,
   * `grep` — while `tools.*` was keyed strictly on registry names, so the very
   * next call it wrote, `await tools.read(...)`, came back "there is no Reaper
   * tool called 'read'" with `file_view` sitting in `tools.list()` directly
   * above it. Making the model maintain a second vocabulary for the same tools
   * is a tax on exactly what makes eval worth reaching for.
   */
  const seen: string[] = [];
  const bridge = new ReaperToolBridge({
    executor: {
      execute: async (call) => {
        seen.push(call.name);
        return { toolCallId: call.id, name: call.name, ok: true, durationMs: 0, output: "ok" } as never;
      },
    },
    disabledTools: new Set<string>(),
  });

  /*
   * Real arguments, because the bridge validates before it dispatches — which
   * is a second thing this pins. An alias that resolved but then failed its
   * schema would be an alias that half-works, and `{}` for `file_view` is a
   * schema error, not a resolution one.
   */
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ["read", "file_view", { path: "a.ts" }],
    ["write", "write_file", { path: "a.ts", content: "x" }],
    ["grep", "grep_search", { pattern: "x" }],
    ["ls", "list_directory", { path: "." }],
    ["edit", "file_edit", { path: "a.ts", start_line: 1, end_line: 1, new_content: "b" }],
    ["replace", "file_edit", { path: "a.ts", start_line: 1, end_line: 1, new_content: "b" }],
    ["search", "grep_search", { pattern: "x" }],
  ];
  for (const [alias, canonical, args] of cases) {
    const result = await bridge.invoke({
      callId: `c-${alias}`,
      name: alias,
      args,
      signal: new AbortController().signal,
    });
    assert.equal(result.ok, true, `tools.${alias} must reach the executor: ${JSON.stringify(result)}`);
    assert.equal(seen.at(-1), canonical, `tools.${alias} must dispatch as ${canonical}`);
  }

  /*
   * And the surface still advertises one name per tool. A transcript showing
   * `tools.read` called `file_view` is fine — that is what the alias is for —
   * but `tools.list()` naming both would suggest they are two tools.
   */
  const names = bridge.names();
  for (const alias of ["read", "write", "grep", "ls"]) {
    assert.equal(names.includes(alias), false, `tools.list() must not advertise the alias '${alias}'`);
  }
  assert.ok(names.includes("file_view") && names.includes("write_file"));

  // `describe` answers under either spelling, because a script that called
  // `tools.read` will ask about `read`.
  assert.deepEqual(bridge.describe("read"), bridge.describe("file_view"));
  assert.ok(bridge.describe("read"));
});

test("7c. an alias cannot reach a tool the thread switched off", async () => {
  /*
   * The order of operations is the whole security content of alias support:
   * withheld first, then alias, then check the *resolved* name against the
   * disabled list. Resolving before checking would mean a thread that switched
   * off `file_view` still served it to `tools.read` — the alias quietly
   * becoming a second name for something the user turned off.
   */
  const bridge = new ReaperToolBridge({
    executor: { execute: async () => ({ toolCallId: "x", name: "file_view", ok: true, durationMs: 0 }) as never },
    disabledTools: new Set(["file_view"]),
  });

  assert.equal(bridge.names().includes("file_view"), false);
  const viaAlias = await bridge.invoke({
    callId: "c1",
    name: "read",
    args: { path: "a.ts" },
    signal: new AbortController().signal,
  });
  assert.equal(viaAlias.ok, false, "a disabled tool must not be reachable by an alias");
  assert.equal(viaAlias.ok === false && viaAlias.error.code, "TOOL_DISABLED");
  assert.equal(bridge.describe("read"), undefined);
});

test("7d. no alias can name the sandbox's way out of itself", async () => {
  // `eval` is withheld by name today and has no alias, so this passes trivially
  // — which is the point of asserting it. It is the test that fails if someone
  // later adds `codemode: "eval"` to the alias table, and it fails *before* the
  // recursion guard is reachable, because the withheld check runs on the name
  // the script wrote.
  const bridge = new ReaperToolBridge({
    executor: { execute: async () => ({ toolCallId: "x", name: "eval", ok: true, durationMs: 0 }) as never },
    disabledTools: new Set<string>(),
  });

  for (const name of ["eval", "codemode", "code_mode", "javascript"]) {
    const result = await bridge.invoke({
      callId: `c-${name}`,
      name,
      args: { code: "1" },
      signal: new AbortController().signal,
    });
    assert.equal(result.ok, false, `'${name}' must not reach the executor`);
  }
  assert.equal(bridge.names().includes("eval"), false);
});

// ---------------------------------------------------------------------------
// 6. Permissions survive the bridge — through the real executor
// ---------------------------------------------------------------------------

/**
 * An executor on its own run.
 *
 * The run id is unique per call, and that is not incidental. Code Mode keeps a
 * sandbox per run, so a fixed id shared between tests would hand the second
 * test the first test's context — globals, frozen tool surface, and a queue the
 * first test's release had already closed. Real runs do not share ids either;
 * the fixture was simply lying.
 */
async function executorFor(workspaceRoot: string, extra: Record<string, unknown> = {}): Promise<ToolExecutor> {
  return new ToolExecutor({
    workspaceRoot,
    runId: `code-mode-${randomUUID()}`,
    sessionId: "code-mode-session",
    traceId: "code-mode-trace",
    logLevel: "info",
    safetyProfile: "allow_all",
    ...extra,
  });
}

test("6. a disabled tool is refused inside a script exactly as it is outside one", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await executorFor(workspaceRoot, { disabledTools: new Set(["grep_search"]) });

  // Outside: the executor refuses it.
  const direct = await executor.execute({ id: "d1", name: "grep_search", args: { pattern: "x" } });
  assert.equal(direct.ok, false);
  assert.equal(direct.error?.code, "TOOL_DISABLED");

  // Inside: the same refusal, with the same code, reached through the bridge.
  const inside = await executor.execute({
    id: "e1",
    name: "eval",
    args: { code: "try { await tools.grep_search({ pattern: 'x' }); 'called' } catch (error) { error.code; }" },
  });
  assert.equal(inside.ok, true, "eval itself ran");
  const output = inside.output as { status: string; value: string };
  assert.equal(output.status, "completed");
  assert.equal(output.value, "TOOL_DISABLED", "the inner call must fail with the executor's own error code");

  await executor.cleanupBackgroundProcesses("test");
});

test("6b. a write from inside a script meets exactly the policy it would meet outside one", async () => {
  /*
   * The assertion is *equality*, not a fixed expectation, and that is the
   * point of the test rather than a shortcut.
   *
   * `read_only` does not hard-deny a write — it classifies one as
   * `needs_human_approval` and defers to the approval path, which under
   * `permissionMode: "yolo"` grants it. Hardcoding "the write must fail" was
   * therefore asserting something Reaper does not promise, and it failed for
   * the same reason a direct `write_file` call would have: the mode allows it
   * once approval is automatic.
   *
   * What Code Mode does promise is that an inner call is subject to the same
   * decision as an outer one. That is a claim about two outcomes agreeing, so
   * it is tested by producing both and comparing them — and it holds whatever
   * the policy happens to say, which makes it a check on the bridge instead of
   * a restatement of the mode table.
   */
  const workspaceRoot = await createTempWorkspace();
  const makeExecutor = (): Promise<ToolExecutor> =>
    executorFor(workspaceRoot, {
      sandboxMode: "read_only",
      permissionMode: "yolo",
      sandboxPolicy: new SandboxPolicy({ mode: "read_only" }),
    });

  // Outside: the model calls the tool itself.
  const outsideExecutor = await makeExecutor();
  const outside = await outsideExecutor.execute({ id: "d1", name: "write_file", args: { path: "direct.txt", content: "x" } });
  await outsideExecutor.cleanupBackgroundProcesses("test");

  // Inside: the same call, from a script. Its own outcome is irrelevant, which
  // is why it is read out of the script rather than taken from the result.
  const insideExecutor = await makeExecutor();
  const inside = await insideExecutor.execute({
    id: "e1",
    name: "eval",
    args: {
      code:
        "let o; try { await tools.write_file({ path: 'direct.txt', content: 'x' }); o = 'ok'; } " +
        "catch (error) { o = error.code; } o;",
    },
  });
  await insideExecutor.cleanupBackgroundProcesses("test");

  const inner = (inside.output as { value: string }).value;
  const expected = outside.ok ? "ok" : (outside.error?.code ?? "error");
  assert.equal(inner, expected, "the inner call must land on the same decision as the outer one");

  // And the container is still allowed, or read-only analysis could never use
  // Code Mode at all — which is the reason the composite classification exists.
  const container = await makeExecutor();
  const ran = await container.execute({ id: "e2", name: "eval", args: { code: "'ran';" } });
  await container.cleanupBackgroundProcesses("test");
  assert.equal(ran.ok, true, `eval must be allowed under read_only: ${JSON.stringify(ran.error)}`);
  assert.equal((ran.output as { value: string }).value, "ran");
});

test("6f. the whole path — real runtime, real bridge, real executor — takes an alias", async () => {
  /*
   * The three tests above this one exercise the bridge in isolation. This one
   * goes through everything a real eval call goes through: the worker thread,
   * `postMessage` marshalling, the proxy in `worker-source.ts`, the bridge, and
   * the executor. The unit-level alias tests would all pass if the runtime
   * dropped `aliases` on the way into `workerData`, or if the proxy's `has`
   * trap disagreed with its `get` — and that failure would only ever show up in
   * a live run.
   */
  const workspaceRoot = await createTempWorkspace();
  const executor = await executorFor(workspaceRoot);
  const written = await executor.execute({
    id: "w0",
    name: "write_file",
    args: { path: "alias-probe.txt", content: "one\ntwo\nthree" },
  });
  assert.equal(written.ok, true, JSON.stringify(written.error));

  const result = await executor.execute({
    id: "e-alias",
    name: "eval",
    args: {
      code:
        // `read` → file_view, `grep` → grep_search, `ls` → list_directory.
        "const f = await tools.read({ path: 'alias-probe.txt' });\n" +
        "const hits = await tools.grep({ pattern: 'two', path: '.' });\n" +
        "const dir = await tools.ls({ path: '.' });\n" +
        "({ lines: f.window.length, hits: hits.matches.length, sawFile: JSON.stringify(dir).includes('alias-probe.txt'), inTools: 'read' in tools });",
    },
  });
  await executor.cleanupBackgroundProcesses("test");

  assert.equal(result.ok, true, JSON.stringify(result.error));
  const value = (result.output as { value: Record<string, unknown> }).value;
  assert.equal(value.lines, 3, "tools.read must have read the file");
  /*
   * `hits.matches.length`, and the shape is the point: `grep_search` returns
   * `{ root, matches }` and the script reads it as the object it is. Writing
   * `hits.length` here was an earlier version of this test guessing that it
   * returned an array — the guess a `JSON.parse` in the middle would have
   * hidden rather than caught.
   */
  assert.ok((value.hits as number) >= 1, "tools.grep must have found the match");
  assert.equal(value.sawFile, true, "tools.ls must have listed the directory");
  assert.equal(value.inTools, true, "`'read' in tools` must agree with tools.read being callable");

  // And the transcript names the real tools, not the aliases: a reader looking
  // at this row should see what ran, and the model's own vocabulary is the
  // thing that should be normalised away — not the audit record.
  const calls = (result.output as { toolCalls: Array<{ name: string }> }).toolCalls.map((c) => c.name);
  assert.deepEqual(calls, ["file_view", "grep_search", "list_directory"]);
});

test("6c. an inner call shows up as a real tool execution, not an invisible one", async () => {
  const workspaceRoot = await createTempWorkspace();
  const events: { type: string; name?: string }[] = [];
  const executor = await executorFor(workspaceRoot, {
    // A sink is a *function*, not an object with `emit` — `emitRuntimeEvent`
    // calls it directly. Handing it `{ emit }` produces a sink that throws on
    // every event, which `emitRuntimeEvent` swallows by design, so the run
    // looks fine and records nothing.
    eventSink: (async (event: { type: string; toolCall?: { name: string } }) => {
      events.push(event.toolCall?.name === undefined ? { type: event.type } : { type: event.type, name: event.toolCall.name });
    }) as never,
  });

  await executor.execute({ id: "e1", name: "eval", args: { code: "await tools.list_directory({ path: '.' }); 'done';" } });

  const started = events.filter((event) => event.type === "tool.started").map((event) => event.name);
  assert.ok(started.includes("eval"), `expected an eval tool.started, saw ${started.join(", ")}`);
  assert.ok(started.includes("list_directory"), `expected the inner call to emit its own tool.started, saw ${started.join(", ")}`);

  await executor.cleanupBackgroundProcesses("test");
});

// ---------------------------------------------------------------------------
// Live output — the script narrating itself while it runs
// ---------------------------------------------------------------------------

test("6d. output arrives while the script runs, not only when it ends", async () => {
  /*
   * The reason this exists: a script that reads forty files and logs a line
   * each has nothing to show until the fortieth finishes, and "is this working
   * or hung?" is exactly the question the display must not leave open. The
   * assertion that matters is not that the text arrives — it is *when*.
   */
  const arrivals: { kind: string; text: string; atToolCall: number }[] = [];
  let toolCallsSeen = 0;

  const host = fixtureHost({
    invoke: async (invocation) => {
      if (invocation.name === "read") {
        toolCallsSeen += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true, output: { text: FIXTURE_TEXT }, durationMs: 5 };
      }
      if (invocation.name === "grep") {
        toolCallsSeen += 1;
        return { ok: true, output: { matches: [] }, durationMs: 1 };
      }
      return { ok: false, error: { code: "TOOL_NOT_EXPOSED", message: "no" }, durationMs: 0 };
    },
  });

  const runtime = await ReaperNodeRuntime.create();
  try {
    const result = await runtime.run({
      source: `
        console.log("starting");
        for (const name of ["a", "b", "c"]) {
          console.log("checking " + name);
          await tools.read({ path: name });
        }
        console.log("done");
        "finished";
      `,
      tools: FIXTURE_TOOLS,
      host,
      onOutput: (chunk) => arrivals.push({ kind: chunk.kind, text: chunk.text, atToolCall: toolCallsSeen }),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.value, "finished");

    /*
     * `atToolCall` is the whole test. Every line was recorded with a note of
     * how many tool calls had completed when it arrived, so a runtime that
     * buffered everything and flushed at the end would show every line
     * arriving at 3. The first line has to arrive before any call has
     * finished — that is what "live" means.
     */
    const first = arrivals[0];
    assert.ok(first, "expected at least one live chunk");
    assert.equal(first.text, "starting");
    assert.equal(first.atToolCall, 0, "the first line was buffered until tool calls had already run");

    const kinds = arrivals.map((arrival) => arrival.kind);
    assert.ok(kinds.includes("log"), `expected console lines in the stream, saw ${JSON.stringify(arrivals)}`);

    // Ordering is preserved: the reader sees what happened in the order it
    // happened, which is the only reason to stream at all.
    const texts = arrivals.filter((arrival) => arrival.kind === "log").map((arrival) => arrival.text);
    assert.deepEqual(texts, ["starting", "checking a", "checking b", "checking c", "done"]);

    // The batch on the result is still the record, and still complete.
    assert.equal(result.console.length, 5);
  } finally {
    runtime.dispose();
  }
});

test("6e. a tool crossing is reported as it happens, and a sink that throws cannot fail the script", async () => {
  const runtime = await ReaperNodeRuntime.create();
  try {
    const result = await runtime.run({
      source: 'await tools.read({ path: "a" }); await tools.grep({ pattern: "x" }); "ok";',
      tools: FIXTURE_TOOLS,
      host: fixtureHost(),
      /*
       * Deliberately hostile. The display is not the task: a transcript sink
       * that throws must not turn a script that worked into one that failed,
       * for the same reason a runtime event sink never fails a turn.
       */
      onOutput: () => {
        throw new Error("sink exploded");
      },
      onToolCall: () => {
        throw new Error("sink exploded");
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.value, "ok");
    assert.equal(result.toolCalls.length, 2);
  } finally {
    runtime.dispose();
  }
});

// ---------------------------------------------------------------------------
// 9, 10, 13, 15. Resource limits
// ---------------------------------------------------------------------------

test("9. `while (true) {}` terminates instead of hanging the process", async () => {
  const started = Date.now();
  const result = await runScript("while (true) {}", { limits: { timeoutMs: 700 } });
  const elapsed = Date.now() - started;

  assert.equal(result.status, "timeout");
  assert.match(result.error?.message ?? "", /longer than 700ms and was stopped/);
  // The point is that it came back at all, and roughly on time.
  assert.ok(elapsed < 8000, `took ${elapsed}ms`);
});

test("9b. an unbounded loop that awaits a tool is stopped by the same budget", async () => {
  const result = await runScript("while (true) { await tools.read({ path: 'x' }); }", {
    limits: { timeoutMs: 900, maxToolCalls: 1000 },
  });
  /*
   * The message is asserted as well as the status, and that is a second bug
   * caught by the first one's fix.
   *
   * Stopping a run terminates a worker that may be mid-script. Terminating
   * makes any `tools.*` promise the script is parked on reject, its `await`
   * throws, and the worker posts a `failed` on the way out — racing the verdict
   * that caused it and overwriting `tool_call_limit` with a generic `error`.
   * This test passed in isolation and failed in the full suite, which is the
   * shape of a race rather than of a broken assertion.
   *
   * Once the host's verdict was made to win, a second problem appeared behind
   * it: the early return skipped the `exit` handler that attaches the sentence,
   * so the result came back as `status: "tool_call_limit"` with no message. A
   * status without an explanation is useless to the model — it can act on "you
   * reached your tool-call limit" and can do nothing with a bare label.
   *
   * The assertion is deliberately on the *message* as well as the status, and
   * it accepts any of the three ways this run can legitimately stop. Two
   * stop-reasons race here by construction: the cap fires while a tool call is
   * in flight, so the host terminating the worker and the script's own `await`
   * rejecting are concurrent, and which lands first is machine- and load-
   * dependent. A run that lost the race reports `error` — which would fail a
   * bare status check while the model was told exactly the right thing. So the
   * check is the invariant: it stopped, and it said why, naming a budget.
   */
  assert.ok(
    ["timeout", "tool_call_limit", "error"].includes(result.status),
    `got ${result.status}`,
  );
  assert.match(result.error?.message ?? "", /tool calls and was stopped|longer than 900ms/);
});

test("9c. a stopped run keeps the host's verdict, not the worker's dying throw", async () => {
  /*
   * This asserts the invariant. It does not, on its own, prove the fix is
   * load-bearing, and saying otherwise would be the kind of claim that gets
   * found out later.
   *
   * The race is real — instrumenting the branch it guards and running 24 caps
   * under heavy contention caught it firing twice, and without the guard those
   * two runs report `error` instead of `tool_call_limit`. But it is narrow and
   * load-dependent, and attempts here run on a quiet machine, so this test
   * passes with the guard removed. Measured: eight attempts never hit the
   * window.
   *
   * So the value of what follows is that it pins the *contract* — a stopped run
   * reports the reason it was stopped, and always with a message — and that a
   * future change breaking it deterministically fails here. The proof that the
   * race exists lives in the comment on the branch, with its numbers, rather
   * than in an assertion that pretends to reproduce it.
   */
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await runScript("while (true) { await tools.read({ path: 'x' }); }", {
      host: fixtureHost({
        invoke: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return { ok: true, output: { window: [] }, durationMs: 150 };
        },
      }),
      limits: { timeoutMs: 30_000, maxToolCalls: 1 },
    });
    assert.equal(result.status, "tool_call_limit", `attempt ${attempt + 1} reported ${result.status}`);
    // The message, not just the status. The failure mode was a correct status
    // whose explanation had been dropped by an early return.
    assert.match(result.error?.message ?? "", /limit of 1 tool call/, `attempt ${attempt + 1}`);
  }
});

test("10. the memory ceiling stops a runaway allocation and the tool call survives it", async () => {
  const result = await runScript("const a = [];\nwhile (true) { a.push(new Array(5000).fill(0)); }", {
    limits: { memoryBytes: 8 * 1024 * 1024, timeoutMs: 15_000 },
  });
  assert.equal(result.status, "memory");
  assert.match(result.error?.message ?? "", /exceeded its memory limit/i);

  // The process is still healthy: a fresh runtime runs normal code.
  const after = await runScript("2 + 2");
  assert.equal(after.value, 4);
});

test("10b. runaway recursion is a catchable error, and the sandbox survives it", async () => {
  /*
   * The size here is above the runtime's ceiling, deliberately. In this build
   * a stack larger than the host's own is the difference between a reported
   * error and a process-ending Emscripten abort — the overflow escapes as an
   * unwinding failure, no handle is released, and the next `dispose()` kills
   * everything. So the assertion is not "recursion overflows" but the two
   * properties that make it safe: the runtime clamps what it was asked for,
   * and the sandbox is still usable afterwards.
   */
  const result = await runScript("function f() { return f(); }\nf();", { limits: { stackBytes: 8 * 1024 * 1024 } });
  assert.equal(result.status, "error");
  assert.match(result.error?.name ?? "", /RangeError|InternalError/);

  // The same runtime object, after the overflow: a second script runs normally.
  const runtime = await ReaperNodeRuntime.create();
  try {
    const first = await runtime.run({ source: "function f() { return f(); }\nf();", tools: FIXTURE_TOOLS, host: fixtureHost() });
    assert.equal(first.status, "error");
    const second = await runtime.run({ source: "1 + 2", tools: FIXTURE_TOOLS, host: fixtureHost() });
    assert.equal(second.status, "completed", "a stack overflow must not poison the runtime");
    assert.equal(second.value, 3);
  } finally {
    runtime.dispose();
  }
});

test("10c. the tool-call budget is enforced and reported", async () => {
  const result = await runScript(
    "for (let i = 0; i < 50; i += 1) { await tools.read({ path: 'x' }); }\n'done';",
    { limits: { maxToolCalls: 5, timeoutMs: 10_000 } },
  );
  assert.equal(result.status, "tool_call_limit");
  assert.match(result.error?.message ?? "", /reached its limit of 5 tool calls/);
  assert.ok(result.toolCalls.length <= 6, `made ${result.toolCalls.length} calls against a budget of 5`);
});

test("13. an oversized result is truncated with its true size stated", async () => {
  const result = await runScript("'x'.repeat(50000);", { limits: { maxResultBytes: 4096 } });
  assert.equal(result.status, "completed");
  assert.equal(result.truncated, true);
  assert.equal(result.resultBytes, 50002);
  assert.equal(typeof result.value, "string");
  assert.match(result.value as string, /\[result too large: 50002 bytes, limit 4096\./);
  assert.ok((result.value as string).length < 4500);
});

test("13b. console output is bounded separately from the result", async () => {
  const result = await runScript(
    "for (let i = 0; i < 200; i += 1) console.log('line ' + i, 'x'.repeat(200));\n'ok';",
    { limits: { maxConsoleBytes: 2048 } },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.value, "ok");
  assert.equal(result.consoleTruncated, true);
  const total = result.console.reduce((sum, entry) => sum + entry.text.length, 0);
  assert.ok(total < 2600, `captured ${total} characters against a 2048 ceiling`);
});

test("15. cancelling a script that never yields is reported as a cancellation", async () => {
  /*
   * The timer is armed *before* the script starts, and that is not a detail of
   * the test — it is the whole shape of the limitation.
   *
   * `run()` reaches QuickJS on its first synchronous tick, so from the moment
   * it is called nothing else on this thread executes until the burst is over.
   * A `setTimeout` registered afterwards therefore cannot fire during the run,
   * and the cancellation it was supposed to deliver arrives too late to be
   * observed. Arming first is what a real Stop button does: the signal exists
   * for the whole turn, and the abort is raised from a click that was already
   * pending when the script started.
   *
   * What this asserts is the part that genuinely works — a script that never
   * yields still stops, promptly, and is reported as cancelled rather than as
   * a slow script. What it does not assert, because it is not true, is that
   * the abort is noticed *during* the burst; see the limitation note in the
   * runtime. A script that yields on anything — a tool call, `sleep` — is
   * cancellable at the moment it yields, which is what test 15b covers.
   */
  const controller = new AbortController();
  const armed = setTimeout(() => controller.abort(), 150);

  const started = Date.now();
  const result = await runScript("while (true) {}", {
    limits: { timeoutMs: 30_000, spinBudgetMs: 800 },
    signal: controller.signal,
  });
  clearTimeout(armed);

  assert.equal(result.status, "cancelled", "a cancelled run must not be reported as a slow one");
  assert.match(result.error?.name ?? "", /Abort/);
  assert.ok(
    Date.now() - started < 5_000,
    "and it must stop on the burst budget, not run out the timeout",
  );
});

test("15b. cancelling while a script is parked on a tool call also stops it", async () => {
  const controller = new AbortController();
  const host = fixtureHost({
    invoke: async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { ok: true, output: { text: "late" }, durationMs: 400 };
    },
  });

  const pending = runScript("await tools.read({ path: 'x' });\n'finished';", {
    host,
    limits: { timeoutMs: 30_000 },
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();

  const result = await pending;
  assert.equal(result.status, "cancelled");
});

// ---------------------------------------------------------------------------
// 11. JavaScript errors
// ---------------------------------------------------------------------------

test("11. a thrown error comes back concisely, with the code intact", async () => {
  const result = await runScript("throw new Error('bad input');");
  assert.equal(result.status, "error");
  assert.equal(result.error?.name, "Error");
  // The message carries its position, so a model reading a failure does not
  // have to scan its own script to find the line.
  assert.match(result.error?.message ?? "", /^bad input \(line 1\)$/);
  assert.equal(result.error?.line, 1, "the position is also a structured field");
  assert.ok(result.error?.stack, "the raw stack is kept for debugging");

  const ranged = await runScript("\n\nthrow new RangeError('out of range');");
  assert.equal(ranged.error?.name, "RangeError");
  assert.match(ranged.error?.message ?? "", /^out of range \(line 3\)$/, "the reported line is the model's own, not the wrapper's");
});

test("11b. a syntax error reports its own position, not a wrapper's", async () => {
  const result = await runScript("const = ;");
  assert.equal(result.status, "error");
  assert.equal(result.error?.name, "SyntaxError");
  assert.match(result.error?.stack ?? "", /codemode\.js/);
});

// ---------------------------------------------------------------------------
// 8, 14. Isolation
// ---------------------------------------------------------------------------

test("8b. the script runs on the real platform, with Node's own globals in scope", async () => {
  /*
   * This asserted the opposite until the runtime changed.
   *
   * Under QuickJS the point of the test was that *nothing* of the host was
   * reachable — no `process`, no `require`, no `fetch` — and it passed, because
   * the sandbox genuinely had none. That is no longer the design: Code Mode
   * runs real JavaScript on the real platform, which is what lets a script use
   * a package it needs, spawn a subprocess, or fetch a URL.
   *
   * What is still worth asserting is that these are Node's own, not Reaper's
   * internals bolted into a scope. `process.env` is checked for a Reaper
   * secret specifically: the worker inherits the host environment, and a
   * script that can read provider credentials has found the one leak that
   * would matter.
   */
  const probe = await runScript(`
({
  isNode: typeof process === 'object' && typeof process.version === 'string',
  hasRequire: typeof require === 'function',
  hasBuffer: typeof Buffer === 'function',
  hasFetch: typeof fetch === 'function',
  hasTools: typeof tools === 'object',
  evalIsCallable: typeof tools.eval === 'function',
  evalIsInList: tools.list().some((t) => t.name === 'eval'),
});
`);
  assert.equal(probe.status, "completed");
  assert.deepEqual(probe.value, {
    isNode: true,
    hasRequire: true,
    hasBuffer: true,
    hasFetch: true,
    hasTools: true,
    /*
     * The surface is a Proxy, so an unavailable name is a callable that
     * refuses rather than a JavaScript `undefined` — test 8 above explains why
     * that is the better design. `evalIsInList` is the substantive check:
     * recursion is prevented by the name never being *offered*, and a script
     * that reaches for it anyway is refused at the bridge.
     */
    evalIsCallable: true,
    evalIsInList: false,
  });
});

test("8c. the platform is genuine, not an API that exists only to be refused", async () => {
  /*
   * The failure mode this guards against is a runtime that *reports* Node and
   * then refuses to be one — a `require` that exists but throws, a `fetch`
   * that is present but stubbed. The live model wrote `await import('node:fs')`
   * into a script twice in one run and was told the module did not exist, in a
   * runtime where it did not. Existence is not the contract; working is.
   */
  const result = await runScript(`
const os = require('node:os');
const path = await import('node:path');
const combined = path.join('a', 'b');
({ platform: typeof os.platform(), combined, spawned: typeof require('node:child_process').execFileSync });
`);
  assert.equal(result.status, "completed", result.error?.message ?? "");
  const value = result.value as { platform: string; combined: string; spawned: string };
  assert.equal(typeof value.platform, "string");
  assert.equal(value.combined, "a/b");
  assert.equal(value.spawned, "function", "child_process must be reachable, not merely mentioned");
});

test("14. state does not leak between runs", async () => {
  // Two separate runtimes, as two separate agent runs would get.
  const first = await runScript("globalThis.leaked = 'from run one';\n'set';");
  assert.equal(first.value, "set");

  const second = await runScript("typeof globalThis.leaked;");
  assert.equal(second.value, "undefined", "a global from one run must not be visible in another");
});

test("14b. a value from one eval cannot leak into the next as a result", async () => {
  /*
   * The old version of this test asserted that a `globalThis` assignment in
   * one eval was visible in the next. It was true — the run kept one QuickJS
   * context and reused it — and it is not true now, because the worker that
   * holds those globals is the thread `terminate()` destroys at the end of
   * every eval.
   *
   * The persistence was convenient and it was deliberately given up: a context
   * that survives between calls is a context that has to survive across
   * *cancellation* too, and a script killed mid-run leaves the next one
   * reading whatever it left behind. Correctness over convenience, as the
   * brief put it.
   *
   * What must hold regardless is the thing the model actually depends on: a
   * script that produces no value returns no value, rather than inheriting
   * whatever the previous call returned. That is asserted here, and the
   * per-eval isolation is asserted in 14 above.
   */
  const runtime = await ReaperNodeRuntime.create();
  try {
    const host = fixtureHost();
    const one = await runtime.run({ source: "globalThis.kept = 41;\n'first';", tools: FIXTURE_TOOLS, host });
    assert.equal(one.value, "first");

    const two = await runtime.run({ source: "typeof globalThis.kept;", tools: FIXTURE_TOOLS, host });
    assert.equal(two.value, "undefined", "a global from a previous eval must not survive into this one");

    const three = await runtime.run({ source: "const nothing = 1;", tools: FIXTURE_TOOLS, host });
    assert.equal(three.value, undefined, "a valueless script must not inherit the previous result");
  } finally {
    runtime.dispose();
  }
});

// ---------------------------------------------------------------------------
// The public entry point
// ---------------------------------------------------------------------------

test("a script that failed is still a successful eval call, so the model sees why", async () => {
  const output = (await evaluateScript({
    args: { code: "throw new Error('boom');" },
    toolCallId: "call-1",
    runId: `eval-${Math.random().toString(36).slice(2)}`,
    host: fixtureHost(),
  })) as { status: string; error: { name: string; message: string }; toolCallCount: number };

  assert.equal(output.status, "error");
  // The position is appended, and that is the point: a model told only "boom"
  // has to re-read its whole script to find the line. The bare message is
  // still in there, so a caller matching on it is not broken.
  assert.match(output.error.message, /^boom \(line \d+\)$/);
  assert.equal(output.toolCallCount, 0);
});

test("a successful script reports its value and its tool calls", async () => {
  const output = (await evaluateScript({
    args: { code: "const file = await tools.read({ path: 'a' });\nfile.text.length;" },
    toolCallId: "call-2",
    runId: `eval-${Math.random().toString(36).slice(2)}`,
    host: fixtureHost(),
  })) as { status: string; value: number; toolCallCount: number; toolCalls: { name: string }[] };

  assert.equal(output.status, "completed");
  assert.equal(output.value, FIXTURE_TEXT.length);
  assert.equal(output.toolCallCount, 1);
  assert.equal(output.toolCalls[0]?.name, "read");
});

test("a tool error that escapes the script names the tool that failed", async () => {
  const output = (await evaluateScript({
    args: { code: "await tools.read({ path: 'missing' });" },
    toolCallId: "call-3",
    runId: `eval-${Math.random().toString(36).slice(2)}`,
    host: fixtureHost({ invoke: async () => ({ ok: false, error: { code: "ENOENT", message: "no such file" }, durationMs: 1 }) }),
  })) as { status: string; failedTool: string; error: { tool: string; code: string; hint: string } };
  assert.equal(output.status, "error");
  assert.equal(output.failedTool, "read");
  assert.equal(output.error.tool, "read");
  assert.equal(output.error.code, "ENOENT");
  assert.match(output.error.hint, /try \{ await tools\.read/);
});

/*
 * These four replace a set that asserted the opposite.
 *
 * The old tests came from a live run where the model wrote
 * `await import('node:fs')` twice and got `could not load module 'node:fs'`
 * both times, and they locked in the *hint* that redirected it to `tools.read`
 * — the best available answer when the sandbox genuinely had no modules.
 *
 * It has them now. The runtime is a Node worker, so the script the model kept
 * writing is the script that should have worked all along, and a test suite
 * asserting that it fails would be pinning down the limitation rather than the
 * behaviour. What is worth pinning down is that the capability is real: the
 * builtins resolve, npm packages resolve, and both syntaxes work.
 */
test("the node builtin the model reaches for actually loads", async () => {
  const output = (await evaluateScript({
    args: { code: "const os = await import('node:os');\ntypeof os.platform;" },
    toolCallId: "call-4",
    runId: `eval-${Math.random().toString(36).slice(2)}`,
    host: fixtureHost(),
  })) as { status: string; value: unknown };

  assert.equal(output.status, "completed");
  assert.equal(output.value, "function");
});

test("both module syntaxes work, and the bare specifier resolves too", async () => {
  // `require` and `import` are the same intent wearing different syntax, and a
  // runtime that supported only one would send the model hunting for the other.
  for (const code of ["typeof require('path').join;", "typeof (await import('path')).join;"]) {
    const output = (await evaluateScript({
      args: { code },
      toolCallId: `call-${code.length}`,
      runId: `eval-${Math.random().toString(36).slice(2)}`,
      host: fixtureHost(),
    })) as { status: string; value: unknown };
    assert.equal(output.status, "completed", code);
    assert.equal(output.value, "function", code);
  }
});

test("an npm package installed in the project is importable", async () => {
  // Resolution is against the workspace, not the bundle: `zod` is a real
  // dependency here, and if the resolver pointed at the wrong tree this is the
  // test that would notice.
  const output = (await evaluateScript({
    args: { code: "const { z } = require('zod');\ntypeof z.string;" },
    toolCallId: "call-5",
    runId: `eval-${Math.random().toString(36).slice(2)}`,
    host: fixtureHost(),
  })) as { status: string; value: unknown };

  assert.equal(output.status, "completed");
  assert.equal(output.value, "function");
});

test("a module that genuinely does not exist fails as Node would say it", async () => {
  const output = (await evaluateScript({
    args: { code: "require('definitely-not-a-real-package-xyz');" },
    toolCallId: "call-6",
    runId: `eval-${Math.random().toString(36).slice(2)}`,
    host: fixtureHost(),
  })) as { status: string; error: { message: string } };

  assert.equal(output.status, "error");
  assert.match(output.error.message, /Cannot find module/);
});

test("an ordinary exception is not dressed up with a module hint", async () => {
  const output = (await evaluateScript({
    args: { code: "throw new Error('bad input');" },
    toolCallId: "call-6",
    runId: `eval-${Math.random().toString(36).slice(2)}`,
    host: fixtureHost(),
  })) as { status: string; error: { message: string; hint?: string } };

  assert.equal(output.status, "error");
  assert.equal(output.error.message, "bad input (line 1)");
  assert.equal(output.error.hint, undefined);
});

// ---------------------------------------------------------------------------
// The guard — the short list of things Code Mode will not do
// ---------------------------------------------------------------------------

/*
 * These are unit tests of the predicate, not of the runtime.
 *
 * The guard is applied by patching the module cache inside the worker, so a
 * test that went through a script would be asserting the patch *and* the
 * predicate at once; when it failed there would be no way to tell which half
 * had broken. `GUARD_SOURCE` is built from these very functions, so testing
 * them here is testing the table the worker actually runs — and the executable
 * case is covered separately by 16c below.
 */
test("16a. the guard refuses the paths whose every use is a disaster", () => {
  const home = os.homedir();
  for (const target of [
    "/etc/passwd",
    "/etc/../etc/shadow",
    "/etc/sudoers",
    "/usr/bin/node",
    "/bin/sh",
    "/boot/vmlinuz",
    "/sys/kernel",
    `${home}/.ssh/id_rsa`,
    `${home}/.aws/credentials`,
    `${home}/.docker/config.json`,
    `${home}/.npmrc`,
  ]) {
    assert.ok(isDangerousPath(target, "write"), `${target} must not be writable from Code Mode`);
  }

  // Secrets are refused on *read* as well — that is the half a write-only
  // guard would miss, and the reason the two operations are separate lists.
  assert.ok(isDangerousPath(`${home}/.ssh/id_rsa`, "read"));
  assert.ok(isDangerousPath(`${home}/.aws/credentials`, "read"));

  /*
   * And the negations that keep it from being useless. Each of these is
   * ordinary work for an agent editing a project, which is why it cannot be on
   * the list: a guard that fires on real work is a guard the model routes
   * around, and the audited path through `tools.*` loses to the raw one.
   */
  for (const allowed of ["/dev/null", "/dev/stdout", "/dev/urandom", "/tmp/scratch.txt", "/work/src/a.ts"]) {
    assert.equal(isDangerousPath(allowed, "write"), undefined, `${allowed} is ordinary work and must be allowed`);
  }
  // Reading /etc/passwd is not catastrophic; writing it is.
  assert.equal(isDangerousPath("/etc/passwd", "read"), undefined);
  // A path that merely *starts* like a system directory is a different path.
  assert.equal(isDangerousPath("/etcetera/file", "write"), undefined);
  assert.equal(isDangerousPath("/usrlocal/bin/x", "write"), undefined);
});

test("16b. the guard refuses the commands whose every use is a disaster", () => {
  for (const command of [
    "rm -rf /",
    "rm -fr /",
    "sudo rm -rf /",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    ":(){ :|:& };:",
    "shutdown -h now",
    "reboot",
    "chmod 777 /",
  ]) {
    assert.ok(isDangerousCommand(command), `${command} must be refused`);
  }

  /*
   * The negations carry as much weight as the matches. `rm -rf node_modules`
   * and `rm -rf ./build` are the two most common destructive-but-intended
   * commands an agent runs; if the pattern for "delete everything" caught
   * them, the guard would be worse than nothing, because it would teach the
   * model that raw shell is unreliable and push it somewhere unaudited.
   */
  for (const allowed of [
    "rm -rf node_modules",
    "rm -rf ./build",
    "rm -rf /tmp/scratch",
    "npm run build",
    "dd if=image.iso of=out.img",
    "mkdisk --help",
  ]) {
    assert.equal(isDangerousCommand(allowed), undefined, `${allowed} is ordinary work and must be allowed`);
  }
});

test("16c. a refusal is attributed to the guard, not read as a broken script", async () => {
  /*
   * The code matters as much as the message. A `REAPER_REFUSED` throw means
   * the *operation* was declined — the script is fine and a different approach
   * will work — while any other throw means the script is wrong. The worker
   * sets the code and the host used to drop it, so the distinction existed
   * inside the worker and vanished before the model could see it.
   */
  const result = await runScript(`
const fs = require('node:fs');
try {
  fs.writeFileSync('/etc/reaper-guard-probe', 'x');
  'WROTE';
} catch (error) {
  error.name + ':' + error.code;
}
`);
  assert.equal(result.status, "completed");
  assert.equal(result.value, "CodeModeRefusal:REAPER_REFUSED", "the guard must refuse through the patched module");
});

test("16d. the guard leaves the platform otherwise intact", async () => {
  /*
   * The counterpart to 16c, and the one that would catch a guard written too
   * broadly. If patching the module cache broke `fs` in general — a wrapper
   * that dropped variadic arguments, a `promises` object left half-patched —
   * this fails while 16c still passes.
   */
  const result = await runScript(`
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'reaper-guard-'));
const file = path.join(dir, 'a.txt');
fs.writeFileSync(file, 'hello');
await fsp.appendFile(file, ' world');
const text = await fsp.readFile(file, 'utf8');
const entries = fs.readdirSync(dir);
await fsp.rm(dir, { recursive: true, force: true });
({ text, entries, gone: !fs.existsSync(dir) });
`);
  assert.equal(result.status, "completed", result.error?.message ?? "");
  assert.deepEqual(result.value, { text: "hello world", entries: ["a.txt"], gone: true });
});

test("16e. a relative path means the workspace, for fs and for a shell alike", async () => {
  /*
   * The bug this exists to keep closed was found by a screenshot rather than by
   * a test, and it was two bugs wearing one cause.
   *
   * A Worker cannot have a cwd of its own: `process.chdir()` raises
   * `ERR_WORKER_UNSUPPORTED_OPERATION` in a thread, and `new Worker(…, { cwd })`
   * accepts the option and ignores it. So the thread's cwd is the parent's —
   * for a Reaper server that is wherever `npm run web` was typed, which is
   * Reaper's own checkout, while the thread's *workspace* is
   * `~/.reaper/workspaces/<threadId>`. Code Mode was carrying both facts at
   * once and using each one in a different place.
   *
   * The visible half: a script asked to read `src/sample/expected.json` died on
   * `ENOENT`, because the file was in the workspace and the lookup went to the
   * checkout. The half that never surfaced: a script writing a relative path
   * wrote into Reaper's own source tree, and did it under a tool call that read
   * as though it had stayed in the workspace. A test that passes the same
   * directory as both cwd and workspace cannot see either, which is why the
   * helper's default was not enough and this one names a workspace that is
   * deliberately somewhere else.
   */
  // `mkdtemp` directly rather than `createTempWorkspace`: that fixture builds a
  // committed git repo, which this test has no use for and would pay a `git
  // init` and three subprocesses to get.
  const workspace = await mkdtemp(path.join(os.tmpdir(), "code-mode-cwd-"));
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "data.json"), JSON.stringify({ where: "workspace" }), "utf8");

    /*
     * The marker is cleared before the run and asserted after it, rather than
     * assumed absent. A checkout where an earlier buggy run left one behind
     * would otherwise fail here for the right reason at the wrong time — which
     * is exactly what happened the first time this test was run against the
     * reverted code, and the file it found was the bug's own signature.
     */
    const marker = path.join(process.cwd(), "written.txt");
    await rm(marker, { force: true });

    const result = await runScript(
      `
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const cp = require('node:child_process');
fs.writeFileSync('written.txt', 'x');
const sync = JSON.parse(fs.readFileSync('src/data.json', 'utf8'));
const promised = JSON.parse(await fsp.readFile('src/data.json', 'utf8'));
const shell = JSON.parse(cp.execSync('cat src/data.json').toString());
({ sync, promised, shell, wrote: fs.existsSync('written.txt') });
`,
      { workspace },
    );

    assert.equal(result.status, "completed", result.error?.message ?? "");
    assert.deepEqual(result.value, {
      sync: { where: "workspace" },
      promised: { where: "workspace" },
      shell: { where: "workspace" },
      wrote: true,
    });

    // The write must be in the workspace, and not in the directory the server
    // was started from. Without this the assertion above would pass for a
    // script that wrote into the repo and read its own file back.
    assert.equal(existsSync(path.join(workspace, "written.txt")), true, "the write belongs in the workspace");
    assert.equal(
      existsSync(marker),
      false,
      "a relative write must never land in the server's own directory",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("16f. an absolute path is still absolute", async () => {
  /*
   * The counterweight to 16e. Resolving every path against the workspace would
   * be simpler to write and would quietly break the model's ordinary ability to
   * work outside it — writing a scratch file in /tmp, reading a package out of
   * node_modules by absolute path, touching a file the user named by full path.
   * Those are normal, `tools.*` allows them, and the guard's job is to judge an
   * absolute path rather than to redirect it.
   */
  const workspace = await mkdtemp(path.join(os.tmpdir(), "code-mode-abs-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "code-mode-outside-"));
  try {
    const target = path.join(outside, "absolute.txt");
    const result = await runScript(
      `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(target)}, 'absolute');
fs.readFileSync(${JSON.stringify(target)}, 'utf8');
`,
      { workspace },
    );
    assert.equal(result.status, "completed", result.error?.message ?? "");
    assert.equal(result.value, "absolute");
    assert.equal(existsSync(target), true, "an absolute path must be honoured as written");
    assert.equal(existsSync(path.join(workspace, "absolute.txt")), false, "and not silently redirected");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Per-call limits
// ---------------------------------------------------------------------------

test("16l. a per-call timeout applies to that call and never to the next", async () => {
  /*
   * The session layer builds one runtime per run key and reuses it, so limits
   * passed when the runtime was *created* became that session's standing
   * configuration. `evaluateScript` forwarded the first call's `limits` into
   * creation, which meant a model that asked for a short deadline on a quick
   * probe left every later script in the same conversation with that deadline.
   *
   * Measured before the fix: a call with `timeout_ms: 1000` followed by a
   * plain three-second script killed the second call at 1010ms. Nothing in the
   * transcript said why — the model saw a timeout on a script with no loop and
   * no obvious hazard, which is the worst shape a bug can have, because there
   * is no way to reason from the symptom to the cause.
   *
   * Four calls in one run key, asserting all four outcomes: the override
   * applies, does not outlive its call, applies again when asked, and the
   * default is restored for a call that asks for nothing.
   */
  const runId = "per-call-limits";
  const host = fixtureHost();

  const tight = await evaluateScript({
    args: { code: "while (true) {}", timeout_ms: 1_000 },
    toolCallId: "tight",
    runId,
    host,
  });
  assert.equal(tight?.status, "timeout", "a 1s override must still stop a loop");

  // The one that leaked. Three seconds clears the 1s override and fits inside
  // the default by a wide margin, so either outcome is unambiguous.
  const afterLeak = await evaluateScript({
    args: { code: "await new Promise((resolve) => setTimeout(resolve, 3000)); 'survived';" },
    toolCallId: "after-leak",
    runId,
    host,
  });
  assert.equal(afterLeak?.status, "completed", "the next call must not inherit the previous override");
  assert.equal(afterLeak?.value, "survived");

  // And the override still works when asked for a second time.
  const tightAgain = await evaluateScript({
    args: { code: "await new Promise((resolve) => setTimeout(resolve, 5000)); 'never';", timeout_ms: 1_500 },
    toolCallId: "tight-again",
    runId,
    host,
  });
  assert.equal(tightAgain?.status, "timeout", "a second override must apply too");
});

// ---------------------------------------------------------------------------
// Child processes — the deadline, and what outlives the eval
// ---------------------------------------------------------------------------

test("16g. the timeout stops a script blocked in a synchronous child call", async () => {
  /*
   * The bug was invisible for as long as nobody measured the wall clock: the
   * limit fired, `terminate()` was called, and the eval went on running.
   * `terminate()` stops a thread at a V8 safepoint, and a thread parked inside
   * a blocking syscall never reaches one. Observed in the browser drive as a
   * Code Mode row reading `3m 18s` next to "The script ran longer than 30000ms
   * and was stopped".
   *
   * The assertion is the wall clock, and only the wall clock, because that is
   * the invariant the fix restores and the status is genuinely two-valued here.
   * `execSync` and `execFileSync` throw on timeout, so their scripts die before
   * reaching a value and the host reports `timeout`. `spawnSync` does not — it
   * hands the error back in `result.error` and returns — so a script that
   * ignores that field finishes normally, at the deadline, and `completed` is
   * the honest answer for it. Asserting `timeout` for all three would be the
   * test demanding a preference the code has a real reason not to have.
   */
  for (const source of [
    `require('node:child_process').execSync('sleep 30'); 'done'`,
    `require('node:child_process').execFileSync('sleep', ['30']); 'done'`,
    `require('node:child_process').spawnSync('sleep', ['30']); 'done'`,
  ]) {
    const started = Date.now();
    const result = await runScript(source, { limits: { timeoutMs: 1_500 } });
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 8_000,
      `${source} ran ${elapsed}ms against a 1500ms limit — the child ignored the deadline`,
    );
    assert.ok(
      result.status === "timeout" || result.status === "completed",
      `${source} reported ${result.status}`,
    );
  }
});

test("16h. a child process lives exactly as long as the run, like bash's does", async () => {
  /*
   * Two claims, and the second is the one that keeps this from being a
   * restriction.
   *
   * A worker is not a process group: `terminate()` ends the thread and leaves
   * whatever the thread spawned running, so without a record a script's
   * background process outlives the object that knows it exists and nothing can
   * ever stop it. So the runtime tracks what its scripts start and reaps it when
   * the run ends — `bash` has done exactly this through
   * `BackgroundProcessManager.terminateAll` since the beginning.
   *
   * But it reaps at the end of the **run**, not the end of each eval. The first
   * version reaped per-eval, which meant a model that started a dev server in
   * one call and curled it in the next found it dead — a restriction on what the
   * model can write that the feature's contract does not ask for, and the one
   * the user would never have been told about. So: alive after its eval, gone
   * after `dispose()`.
   *
   * Measured through /proc rather than `pgrep -f`, which matches the shell
   * wrapper it runs under and reports a fresh pid every sample. The state is
   * read for the same reason: a reaped child shows as `Z` (the kernel holding
   * the slot) and counting that as "running" would fail a working fix.
   */
  const childState = (pid: number): string => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "?";
    } catch {
      return "gone";
    }
  };

  for (const spawnLine of [
    `const child = cp.spawn('sleep', ['30'], { detached: true, stdio: 'ignore' }); child.unref();`,
    `const child = cp.spawn('sleep', ['30'], { stdio: 'ignore' });`,
  ]) {
    const runtime = await ReaperNodeRuntime.create({ timeoutMs: 5_000 });
    let pid = 0;
    try {
      const result = await runtime.run({
        source: `\nconst cp = require('node:child_process');\n${spawnLine}\nchild.pid;\n`,
        tools: FIXTURE_TOOLS,
        host: fixtureHost(),
      } as never);
      assert.equal(result.status, "completed", result.error?.message ?? "");
      pid = Number(result.value);
      assert.ok(Number.isInteger(pid) && pid > 0, `expected a pid, got ${String(result.value)}`);

      /*
       * Still alive after its own eval finished. This is the assertion that
       * would fail under per-eval reaping, and it is here so that turning the
       * cleanup back into a restriction is a test failure rather than a
       * discovery a user makes when their dev server stops.
       */
      await new Promise((resolve) => setTimeout(resolve, 300));
      const afterEval = childState(pid);
      if (afterEval !== "S" && afterEval !== "R") {
        assert.fail(`child ${pid} was stopped at the end of its eval; a run-lifetime process must survive it`);
      }
    } finally {
      runtime.dispose();
    }

    // SIGTERM, a 750ms grace, then SIGKILL — so a little over a second.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const afterRun = childState(pid);
    if (afterRun === "S" || afterRun === "R") {
      process.kill(pid, "SIGKILL");
      assert.fail(`child ${pid} outlived the run that started it`);
    }
  }
});

test("16i. a synchronous child killed at the deadline says it was a timeout", async () => {
  /*
   * The correction the model needs depends on which of two things it is told,
   * and the message it got was the wrong one — half the time.
   *
   * Handing the child the eval's remaining budget is what makes 16g possible,
   * and it means the child dies with `ETIMEDOUT`. The script's own `catch` then
   * reports that, and that report can reach the host before the timer set for
   * the same instant. Measured over six identical runs: four produced the
   * timeout sentence, two produced `spawnSync /bin/sh ETIMEDOUT (line 1)`.
   *
   * The second is not a cosmetic difference. It says a command failed, so the
   * model retries the command; the retry fails identically, because the budget
   * was the problem and nothing in that message mentions a budget. Six runs
   * rather than one, because a race that fires two times in three can pass a
   * single sample by luck.
   */
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await runScript(`require('node:child_process').execSync('sleep 20'); 'done'`, {
      limits: { timeoutMs: 1_200 },
    });
    seen.add(result.status);
    assert.equal(result.status, "timeout", `run ${attempt + 1} reported ${result.status}`);
    assert.match(result.error?.message ?? "", /ran longer than 1200ms/);
  }
  assert.deepEqual([...seen], ["timeout"]);
});

test("16k. the guard preserves every callback arity of the spawn family", async () => {
  /*
   * The guard inserts an options object — for the workspace cwd, and for the
   * deadline — and the position of that object is not uniform across the four
   * functions. `exec(cmd, cb)` has the callback at index 1; `execFile(file,
   * args, cb)` has it at 2. An early version hardcoded the index and replaced
   * the callback with the options object, which does not throw: the script
   * awaits a callback that will never be called, and hangs until the eval times
   * out. Node would have said `callback is not a function`; the model got a
   * timeout and nothing else, on code that was correct.
   *
   * Each case asserts the *value the command printed*, not merely that the call
   * returned. A callback silently dropped produces a script that never
   * resolves, and a hang is caught by the timeout — but a callback invoked with
   * the wrong arguments produces a wrong answer, and only the value catches
   * that.
   */
  const cases: Array<[string, string, string]> = [
    ["exec(cmd, cb)", "A", `await new Promise((r) => require('node:child_process').exec('echo A', (e, out) => r(e ? 'ERR' : out.trim())));`],
    ["exec(cmd, opts, cb)", "B", `await new Promise((r) => require('node:child_process').exec('echo B', { encoding: 'utf8' }, (e, out) => r(e ? 'ERR' : out.trim())));`],
    ["execFile(file, args, cb)", "C", `await new Promise((r) => require('node:child_process').execFile('echo', ['C'], (e, out) => r(e ? 'ERR' : out.trim())));`],
    ["execFile(file, args, opts, cb)", "D", `await new Promise((r) => require('node:child_process').execFile('echo', ['D'], { encoding: 'utf8' }, (e, out) => r(e ? 'ERR' : out.trim())));`],
    ["spawn(file, args, opts)", "E", `await new Promise((r) => { const c = require('node:child_process').spawn('echo', ['E'], { stdio: ['ignore','pipe','ignore'] }); let s=''; c.stdout.on('data', (d) => s += d); c.on('close', () => r(s.trim())); });`],
    ["execSync(cmd)", "F", `require('node:child_process').execSync('echo F').toString().trim();`],
    ["execFileSync(file, args, opts)", "H", `require('node:child_process').execFileSync('echo', ['H'], { encoding: 'utf8' }).trim();`],
    ["spawnSync(file, args, opts)", "I", `require('node:child_process').spawnSync('echo', ['I'], { encoding: 'utf8' }).stdout.trim();`],
  ];

  for (const [label, expected, source] of cases) {
    const result = await runScript(source, { limits: { timeoutMs: 8_000 } });
    assert.equal(result.status, "completed", `${label}: ${result.error?.message ?? result.status}`);
    assert.equal(result.value, expected, label);
  }
});

test("16j. eval through the executor resolves against the executor's workspace", async () => {
  /*
   * The test that would have caught the whole bug, and the reason 16e was not
   * enough.
   *
   * 16e proves the worker resolves a relative path against `workerData.workspace`
   * and passed the moment that code was written. It was still broken in the
   * browser, because nothing was *setting* that field: `evaluateScript` was
   * called without a workspace, the runtime fell back to `process.cwd()`, and
   * the drive went on producing `ENOENT: open '/work/src/sample/expected.json'`
   * for a file that was in the thread's workspace all along.
   *
   * A unit test at the layer that was fixed cannot see a value missing from the
   * layer that supplies it. This one goes through `ToolExecutor` — the real
   * call path, with the real option object — so a future refactor that drops
   * the wiring fails here rather than in a screenshot three weeks later.
   */
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-mode-eval-ws-"));
  await mkdir(path.join(workspaceRoot, "src", "sample"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "src", "sample", "expected.json"),
    JSON.stringify({ where: "workspace" }),
    "utf8",
  );

  const executor = new ToolExecutor({
    workspaceRoot,
    runId: "code-mode-eval-workspace",
    sessionId: "code-mode-eval-workspace",
    traceId: "code-mode-eval-workspace",
    logLevel: "info",
    safetyProfile: { mode: "permissive", policy: "default" },
  } as never);

  try {
    const result = await executor.execute({
      id: randomUUID(),
      name: "eval",
      args: {
        code: `const fs = require('fs'); JSON.parse(fs.readFileSync('src/sample/expected.json', 'utf8'));`,
      },
    } as unknown as ToolCall);

    assert.equal(result.ok, true);
    const output = result.output as { value?: unknown } | undefined;
    assert.deepEqual(output?.value, { where: "workspace" });
  } finally {
    await executor.cleanupBackgroundProcesses("code-mode-eval-workspace").catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Parallelism — the reason the runtime is a thread and not a sandbox
// ---------------------------------------------------------------------------

test("17. Promise.all over tools.* is genuine concurrency, not a queue", async () => {
  /*
   * The claim under test is about wall-clock time, because that is the only
   * thing that distinguishes real concurrency from a sequential loop wearing
   * promises. Five calls that each take 120ms finish in a little over 120ms
   * when they overlap and in 600ms when they do not; the threshold below sits
   * between those with room for a slow machine.
   *
   * It also records the peak number in flight on the host side rather than
   * trusting the script, so a runtime that quietly serialised the dispatches
   * would fail here rather than pass by being lucky about timing.
   */
  let inFlight = 0;
  let peak = 0;
  const host = fixtureHost({
    invoke: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 120));
      inFlight -= 1;
      return { ok: true, output: { text: FIXTURE_TEXT }, durationMs: 120 };
    },
  });

  const started = Date.now();
  const result = await runScript(
    "const rs = await Promise.all([1, 2, 3, 4, 5].map((n) => tools.read({ path: 'f' + n }))); rs.length;",
    { host, limits: { timeoutMs: 20_000 } },
  );
  const elapsed = Date.now() - started;

  assert.equal(result.status, "completed");
  assert.equal(result.value, 5);
  assert.equal(peak, 5, `expected all five calls in flight at once, saw at most ${peak}`);
  assert.ok(elapsed < 450, `five 120ms calls took ${elapsed}ms, which is sequential rather than concurrent`);
});

test("17b. a tool failure inside Promise.all is still attributable", async () => {
  /*
   * Concurrency must not cost diagnosability. `Promise.all` rejects with the
   * first failure; the guard is that the rejection still says *which* tool
   * failed, because a script fanning out over twenty calls and being told only
   * "it failed" has no way to narrow it down.
   */
  const host = fixtureHost({
    invoke: async (invocation) =>
      invocation.name === "grep"
        ? { ok: false, error: { code: "TOOL_DENIED", message: "grep is disabled" }, durationMs: 1 }
        : { ok: true, output: { text: FIXTURE_TEXT }, durationMs: 1 },
  });

  const result = await runScript(
    "await Promise.all([tools.read({ path: 'a' }), tools.grep({ pattern: 'x' })]);",
    { host, limits: { timeoutMs: 20_000 } },
  );

  assert.equal(result.status, "error");
  assert.equal(result.toolError?.toolName, "grep");
  assert.equal(result.error?.code, "TOOL_DENIED");
  assert.equal(result.toolCalls.length, 2, "both calls ran, even though one failed");
});

// ---------------------------------------------------------------------------
// Tail lifting
// ---------------------------------------------------------------------------

test("the trailing-expression splitter keeps the last expression as the tail", () => {
  const source = "const values = [1, 2, 3];\nvalues.filter((v) => v > 1).length;";
  const split = splitTrailingExpression(source, () => true);
  assert.ok(split);
  assert.equal(split.tail, "values.filter((v) => v > 1).length");
  assert.match(split.prefix, /const values/);
});

test("a mis-split is rejected when the rewrite does not compile", () => {
  // `verify` is what makes the search safe: with a verifier that rejects
  // everything, no split is returned and the caller falls back to the plain
  // wrapper rather than running a broken rewrite.
  const split = splitTrailingExpression("const a = 1;\na + 1;", () => false);
  assert.equal(split, undefined);
});

test("both wrappers produce source that parses", () => {
  assert.doesNotThrow(() => new Function(wrapWithoutTail("await tools.read({});")));
  assert.doesNotThrow(() => new Function(wrapWithTail("const a = 1;", "a + 1")));
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("eval is registered, is core, and is described for routing", () => {
  assert.ok("eval" in toolRegistry, "eval must be in the registry");
  assert.ok(CORE_TOOL_NAMES.has("eval"), "eval must be a core tool");

  const description = toolRegistry.eval.description;
  assert.equal(
    description,
    [
      /*
       * This line replaced "Reaper tools available to the current agent can be
       * called from JavaScript through `tools.*`", which said the surface exists
       * without saying how large it is or how to reach it. A model reading the
       * old line, with a deferred-tool list in its system prompt, reasonably
       * concludes those tools must be unlocked first — so it calls search_tools
       * natively, unlocks one, and never learns that a single eval could have
       * reached all of them.
       *
       * Both halves are named because either alone is misleading: "write plain
       * Node" without the tools paragraph reads as a sandbox with no tools, and
       * the tools paragraph alone reads as a way to call tools rather than a way
       * to write programs.
       */
      /*
       * The order changed on purpose. It used to lead with what eval is good at
       * and bury "prefer a direct tool" three lines down; the measured result
       * was a model reaching for eval for single-step work — creating a
       * hello-world file, reading one file — where the direct tool is a round
       * trip cheaper and shows up in the transcript. Leading with the cases
       * eval is *not* for is what fixes that, so those lines come first now.
       */
      "Execute JavaScript in a real Node.js runtime: the full language and the full platform, including npm packages, node:* builtins, network access, child processes, and parallel execution.",
      "Do not use eval for a single ordinary operation: creating or editing a file, reading one file, listing a directory, searching, running a build, a test, or a git command. Call that tool directly — same round trips, clearer transcript.",
      "Do not use eval when you need to see a result before deciding the next step. Call the tool and look.",
      "Use eval when the user asks for it, or when the task needs what a single call cannot express: the same operation over many items, a loop or fan-out, filtering or aggregating a large result to a small answer, or dependent steps that chain with no reasoning needed between them.",
      "It is a real Node runtime, and Reaper's own tools are available inside it through `tools.*` — every tool this agent can call, including any whose schema is not in your context, with nothing to unlock first. Use whichever fits each step; reading with `tools.file_view` and parsing with a package is one script, not two styles. `tools.search_tools({ query })` finds a tool by capability, `tools.describe(name)` gives its arguments, `tools.list()` gives the catalogue. `eval` itself is the one exception: a script cannot call eval.",
      "`await models.call({ messages: [...] })` reaches this thread's chat model, and `Promise.all` over several is real concurrency — for when one program needs several answers to compare or combine.",
      "Keep intermediate data inside JavaScript when useful and return a compact final result.",
      "A `tools.*` call carries the workspace, the permission checks, and the audit log, so it is the better choice when one does the job — and when none does, write the code.",
      "Load the `codemode` skill with activate_skill before writing a script that loops or batches more than a couple of calls: it has the return semantics, the tools.* and models.* APIs, and worked examples.",
      "Pass `timeout_ms` if the script waits on something slow: the default is 2 minutes and a model call can take a minute.",
      "Each eval starts with a fresh environment, so variables from an earlier eval are not visible here. The script runs with your access and its effects are real, so keep writes inside the workspace and treat destructive operations as irreversible.",
    ].join("\n"),
    "the description is the routing mechanism; it is pinned so it cannot drift silently",
  );
});

test("the eval schema accepts only the code argument", () => {
  const schema = toolRegistry.eval.argsSchema;
  assert.equal(schema.safeParse({ code: "1 + 1" }).success, true);
  assert.equal(schema.safeParse({ code: "" }).success, false);
  assert.equal(schema.safeParse({ code: "1", language: "python" }).success, false, "eval runs JavaScript only");
});

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The language surface
// ---------------------------------------------------------------------------

test("modern JavaScript works, including the syntax that needs the async wrapper", async () => {
  const cases: [string, string, unknown][] = [
    ["optional chaining", "const o = { a: { b: null } }; o?.a?.b?.c ?? 'fallback';", "fallback"],
    ["nullish assign", "let a = null; a ??= 5; a;", 5],
    ["destructuring", "const { a, b = 2 } = { a: 1 }; a + b;", 3],
    ["spread", "const f = (a, b, c) => a + b + c; f(...[1, 2, 3]);", 6],
    ["template literal", "const n = 3; `count=${n * 2}`;", "count=6"],
    ["private class fields", "class A { #p = 7; get v() { return this.#p; } } new A().v;", 7],
    ["generators", "function* g() { yield 1; yield 2; } [...g()];", [1, 2]],
    ["async iteration", "async function* ag() { yield 1; yield 2; } const out = []; for await (const v of ag()) out.push(v); out;", [1, 2]],
    ["top-level await", "const r = await tools.read({ path: 'a' }); r.text.split('\\n').length;", 3],
    ["await inside a loop", "let n = 0; for (const p of ['a', 'b']) { n += (await tools.read({ path: p })).text.length; } n;", FIXTURE_TEXT.length * 2],
    ["await inside try/catch", "let v; try { v = (await tools.read({ path: 'a' })).path; } catch { v = 'err'; } v;", "src/a.ts"],
    ["Promise.all over awaitables", "const rs = await Promise.all(['a', 'b'].map((p) => tools.read({ path: p }))); rs.length;", 2],
    ["dynamic code via new Function", "new Function('a', 'b', 'return a + b')(1, 2);", 3],
    ["dynamic code via eval", "eval('1 + 1');", 2],
    ["structured errors", "class Custom extends Error { constructor(m) { super(m); this.name = 'Custom'; } } try { throw new Custom('x'); } catch (e) { e.name + ':' + e.message; }", "Custom:x"],
    ["BigInt arithmetic", "(2n ** 64n).toString();", "18446744073709551616"],
    ["Map and Set", "new Set([1, 1, 2]).size + new Map([[1, 2]]).size;", 3],
    ["Proxy and Reflect", "new Proxy({ a: 1 }, { get: (t, k) => Reflect.get(t, k) * 2 }).a;", 2],
    ["WeakRef and FinalizationRegistry", "typeof WeakRef + typeof FinalizationRegistry;", "functionfunction"],
    ["regex lookbehind and named groups", "'2024-01'.match(/(?<y>\\d{4})/).groups.y;", "2024"],
    ["String.replaceAll and matchAll", "'a-b'.replaceAll('-', '+') + [...'a1b2'.matchAll(/\\d/g)].length;", "a+b2"],
    ["Array newer methods", "[1, [2, [3]]].flat(2).at(-1) + [1, 2, 3].findLast((x) => x < 3);", 5],
    ["Object.fromEntries", "Object.fromEntries(Object.entries({ a: 1 })).a;", 1],
    ["numeric separators and exponent", "1_000_000 + 2 ** 10;", 1001024],
    ["labeled continue", "let r; outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j === 1) continue outer; r = i; } } r;", 2],
    ["try without a catch binding", "try { JSON.parse('{'); } catch { 'caught'; }", "caught"],
  ];

  const failures: string[] = [];
  for (const [label, source, expected] of cases) {
    const result = await runScript(source);
    const got = result.status === "completed" ? result.value : `[${result.status}] ${result.error?.message}`;
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    }
  }
  assert.deepEqual(failures, [], `language failures:\n  ${failures.join("\n  ")}`);
});
