/**
 * A script sees every tool the agent may call.
 *
 * This is a requirement rather than an implementation detail: the eval
 * environment exposes all of Reaper's tools and the *model* decides whether to
 * reach for one. That is what separates Code Mode from a two-tier tool system
 * where scripts get a privileged subset — and it is the kind of property that
 * erodes silently, because narrowing `ReaperToolBridge.names()` to
 * `CORE_TOOL_NAMES` would look like a tidy-up and would break nothing that
 * exercises the bridge with core tools only.
 *
 * Exactly one tool is withheld: `eval` itself. A script calling eval nests one
 * timeout budget inside a runtime the level above cannot interrupt, so a
 * recursive eval is a turn that hangs with no way to see what it was doing.
 * That is the cyclic case and it is the only one.
 *
 * Everything else in the registry must be both listed and describable. This
 * used to withhold `search_tools` as well, on the reasoning that `tools.list()`
 * and `tools.describe()` cover it — which is true as far as it goes, but it is
 * a judgement about which tools are *useful* inside a script, and this
 * environment is not in the business of making those. The model decides.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ReaperToolBridge } from "../../src/tools/code/bridge.js";
import type { CodeModelInvocation } from "../../src/tools/code/types.js";
import type { ToolCall } from "../../src/tools/types.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { CORE_TOOL_NAMES, toolRegistry } from "../../src/tools/registry.js";
import { EVAL_TOOL_DESCRIPTION, evaluateScript } from "../../src/tools/eval.js";

const WITHHELD_DELIBERATELY: readonly string[] = ["eval"];

/** How many inner Reaper tool calls a result recorded, whatever its typing. */
function countCalls(result: { toolCalls?: unknown } | undefined): number {
  return Array.isArray(result?.toolCalls) ? result.toolCalls.length : 0;
}

test("a script is offered the whole registry, not the core subset", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "code-mode-surface-"));
  const executor = new ToolExecutor({
    workspaceRoot,
    runId: "code-mode-surface",
    sessionId: "code-mode-surface",
    traceId: "code-mode-surface",
    logLevel: "info",
    safetyProfile: { mode: "permissive", policy: "default" },
  } as never);

  try {
    const bridge = new ReaperToolBridge({ executor, disabledTools: new Set<string>() });
    const offered = new Set(bridge.names());
    const registry = Object.keys(toolRegistry);

    /*
     * Everything except the two deliberate withholdings. Asserted as set
     * equality rather than "the core tools are present", which is the weaker
     * claim that would pass while nineteen tools silently disappeared.
     */
    const expected = registry.filter((name) => !WITHHELD_DELIBERATELY.includes(name));
    assert.deepEqual(
      [...offered].sort(),
      [...expected].sort(),
      "the script surface must be the whole registry minus the two deliberate withholdings",
    );

    /*
     * And the surface must be *wider* than the core set, which is the specific
     * regression this exists to catch: `CORE_TOOL_NAMES` is what the model can
     * call without discovery, and mistaking it for the Script surface would be
     * a plausible simplification that breaks the requirement.
     */
    const beyondCore = [...offered].filter((name) => !CORE_TOOL_NAMES.has(name));
    assert.ok(
      beyondCore.length > 0,
      `a script must reach past the core tools; it was offered only ${[...offered].length} tool(s)`,
    );

    // Listed is not the same as usable. Every offered name must resolve.
    for (const name of offered) {
      assert.ok(bridge.describe(name), `${name} is offered but cannot be described`);
    }
    assert.equal(bridge.describe("eval"), undefined, "eval must not be callable from a script");
  } finally {
    await executor.cleanupBackgroundProcesses("code-mode-surface").catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a script can call a tool that is not in the core set", async () => {
  /*
   * The end-to-end half. The test above reads the surface off the bridge; this
   * one runs a script that calls a non-core tool and checks it produced a real
   * result, because a bridge that lists a tool and refuses to invoke it would
   * pass the first test and fail every model that believed the list.
   *
   * `glob` is core and `file_find` is not, so `file_find` is the name that
   * proves the point — and it is a tool a script would plausibly want, not one
   * picked for being outside a set.
   */
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "code-mode-noncore-"));
  const executor = new ToolExecutor({
    workspaceRoot,
    runId: "code-mode-noncore",
    sessionId: "code-mode-noncore",
    traceId: "code-mode-noncore",
    logLevel: "info",
    safetyProfile: { mode: "permissive", policy: "default" },
  } as never);

  try {
    const result = await evaluateScript({
      args: { code: `const listed = await tools.list(); listed.some((t) => t.name === 'file_find');` },
      toolCallId: "surface-1",
      runId: "code-mode-noncore",
      host: new ReaperToolBridge({ executor, disabledTools: new Set<string>() }),
      workspace: workspaceRoot,
    });

    assert.equal(result?.status, "completed", String(result?.error ?? ""));
    assert.equal(result?.value, true, "file_find must appear in tools.list()");
  } finally {
    await executor.cleanupBackgroundProcesses("code-mode-noncore").catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a script can discover, inspect, and chain a tool it was never told about", async () => {
  /*
   * The Cloudflare Code Mode flow, which is the point of the whole arrangement:
   * the model does not need a tool's schema in its prompt in order to use it,
   * because the catalogue lives in the sandbox and the script reaches into it.
   *
   * Four steps, in the order a model would actually take them, and each is
   * asserted separately so a break in one does not read as a break in the
   * others:
   *
   *   1. `search_tools` finds a tool by capability. This is the step that makes
   *      the arrangement scale — it returns names and one-line descriptions, so
   *      asking "is there a tool for this" costs a fraction of `tools.list()`.
   *   2. `describe` gives that one tool's real argument names, which the model
   *      cannot guess — `glob` takes `pattern`, not `query`.
   *   3. The call itself works, and so do two more chained onto its result.
   *   4. The reduction comes back, not the data — asserted by checking none of
   *      the file contents are in the returned value.
   *
   * The whole script is one eval call, so the five inner tool calls cost the
   * model one round trip and 76 characters of returned value between them.
   */
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "code-mode-flow-"));
  const executor = new ToolExecutor({
    workspaceRoot,
    runId: "code-mode-flow",
    sessionId: "code-mode-flow",
    traceId: "code-mode-flow",
    logLevel: "info",
    safetyProfile: { mode: "permissive", policy: "default" },
  } as never);

  try {
    for (const name of ["alpha", "beta", "gamma"]) {
      await writeFile(path.join(workspaceRoot, `${name}.ts`), `export const ${name} = "${name}";\n`, "utf8");
    }

    const result = await evaluateScript({
      args: {
        code: [
          "const found = await tools.search_tools({ query: 'find files matching a pattern' });",
          "const chosen = found.matches.find((m) => m.name === 'glob') ?? found.matches[0];",
          "const spec = await tools.describe(chosen.name);",
          "const argKeys = Object.keys(spec?.input?.properties ?? {});",
          "const { files } = await tools.glob({ pattern: '**/*.ts' });",
          "const reads = await Promise.all(files.map((f) => tools.file_view({ path: f.relativePath ?? f.path })));",
          "({ chosen: chosen.name, argKeys, matched: files.length, totalLines: reads.reduce((n, r) => n + (r.totalLines ?? 0), 0) });",
        ].join("\n"),
      },
      toolCallId: "flow-1",
      runId: "code-mode-flow",
      host: new ReaperToolBridge({ executor, disabledTools: new Set<string>() }),
      workspace: workspaceRoot,
    });

    assert.equal(result?.status, "completed", String(result?.error ?? ""));
    const value = result?.value as { chosen: string; argKeys: string[]; matched: number; totalLines: number };

    // 1 + 2: discovery found a real tool and its real argument names.
    assert.equal(value.chosen, "glob");
    assert.ok(value.argKeys.includes("pattern"), `glob's args were ${value.argKeys.join(", ")}`);

    // 3: the call worked, and so did the two chained onto it.
    assert.equal(value.matched, 3, "glob must have found the three fixture files");
    assert.ok(value.totalLines > 0, "the chained file_view calls must have returned content");

    // 4: the reduction came back. The file bodies did not.
    assert.ok(!/alpha = "alpha"/.test(JSON.stringify(result?.value)), "the file contents must not cross back");

    // Every step is a real tool call, and the ledger shows them.
    const calls: Array<{ name: string }> = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
    const called = calls.map((call) => call.name);
    assert.deepEqual(called.slice(0, 2), ["search_tools", "glob"], `called ${called.join(", ")}`);
    assert.equal(called.filter((name) => name === "file_view").length, 3);
  } finally {
    await executor.cleanupBackgroundProcesses("code-mode-flow").catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("the eval description tells the model the whole surface is available", async () => {
  /*
   * The capability existed before this sentence did, and went unused: a model
   * that can see a deferred list in its system prompt reasonably reads it as
   * "these tools are not available yet", so it calls `search_tools` to unlock
   * one and then calls it natively — never discovering that `eval` could have
   * reached all of them from the first line of its script.
   *
   * So this asserts the wording, not the behaviour, because the wording is the
   * part that was missing. It is deliberately a loose match on the load-bearing
   * claims — all tools available, discoverable by search, eval the one
   * exception — rather than a snapshot of the whole string, which would fail on
   * every rewording and teach nobody anything.
   */
  assert.match(EVAL_TOOL_DESCRIPTION, /Reaper's own tools are available inside it through `tools\.\*`/);
  assert.match(EVAL_TOOL_DESCRIPTION, /every tool this agent can call/);
  assert.match(EVAL_TOOL_DESCRIPTION, /tools\.search_tools\(\{ query \}\)/);
  assert.match(EVAL_TOOL_DESCRIPTION, /tools\.describe\(name\)/);
  assert.match(EVAL_TOOL_DESCRIPTION, /`eval` itself is the one exception/);

  /*
   * Both halves of the contract have to be offered, not just the tools one.
   *
   * The environment run the model writes plain Node — read a file, parse it,
   * compute, call a package, write the result — is the more fundamental of the
   * two, and a description that only advertises `tools.*` reads as "this is a
   * way to call tools", which is the smaller idea. A model that concludes it
   * must reach for a Reaper tool whenever one exists writes worse code than one
   * that knows it can just write the program.
   */
  assert.match(EVAL_TOOL_DESCRIPTION, /It is a real Node runtime/);
  assert.match(EVAL_TOOL_DESCRIPTION, /the full language and the full platform/);

  /*
   * And it must stay bounded, because it is in context on every single turn.
   *
   * The number is not a round one, and that is deliberate. It was 2,000, which
   * the description reached at 2,008; then 2,200, which it reached at 2,340
   * when the routing rules were rewritten to lead with what eval is *not* for.
   * Each raise was a deliberate trade rather than a drift — the routing lines
   * measurably change what the model reaches for, and a description that does
   * not route correctly is not cheap at any length. Shaving words to satisfy a
   * round number is how a limit stops meaning anything.
   *
   * The constraint that actually matters is comparative: this string must cost
   * about what two tool schemas cost, so Code Mode's fixed overhead never
   * becomes the reason a large tool set is expensive. Reaper's core schemas
   * average roughly 1,200 characters, so 2,600 is close to two of them while
   * still failing loudly if someone inlines the skill body here or starts
   * listing tool names one per line.
   *
   * The invariant underneath: this number must not grow when the tool count
   * does. Nothing in the string derives from the catalogue — the model is told
   * the catalogue exists and how to search it, never what is in it — and that
   * is the property the Cloudflare arrangement is built on. If this limit is
   * ever raised *because the catalogue grew*, the invariant has been broken and
   * the raise is a bug rather than a trade.
   */
  assert.ok(
    EVAL_TOOL_DESCRIPTION.length <= 2_600,
    `the description is ${EVAL_TOOL_DESCRIPTION.length} chars; at ~2.2k it rivals a tool schema, and past that its fixed cost is the thing making a large catalogue expensive`,
  );
});

test("the same environment does the work with plain Node or with tools.*", async () => {
  /*
   * Both halves of the contract, in one run, because a test of either alone
   * passes while the other is broken.
   *
   * The more fundamental half is that a model can simply write a program: read
   * a file, parse it, compute, write the result, call an npm package. No Reaper
   * tool involved, and nothing checking whether one *should* have been. The
   * other half is that the same environment also reaches every Reaper tool, so a
   * task Reaper already has a tool for can be done that way instead.
   *
   * Which one a given task wants is the model's decision. There is no router,
   * no planner and no classifier in this path — `grep` finds no reference to
   * `eval` anywhere in `runtime/engine.ts` — and this test asserts the outcome
   * of that: both routes are reachable and both produce the same answer, so the
   * choice is a real one rather than a coin flip between a working path and a
   * broken one.
   */
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "code-mode-both-"));
  await mkdir(path.join(workspaceRoot, "data"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "data", "a.txt"), "one\ntwo\nthree\n", "utf8");
  await writeFile(path.join(workspaceRoot, "data", "b.txt"), "four\nfive\n", "utf8");

  const executor = new ToolExecutor({
    workspaceRoot,
    runId: "code-mode-both",
    sessionId: "code-mode-both",
    traceId: "code-mode-both",
    logLevel: "info",
    safetyProfile: { mode: "permissive", policy: "default" },
  } as never);

  const run = (code: string, id: string) =>
    evaluateScript({
      args: { code },
      toolCallId: id,
      runId: "code-mode-both",
      host: new ReaperToolBridge({ executor, disabledTools: new Set<string>() }),
      workspace: workspaceRoot,
    });

  try {
    /*
     * Pure Node. The `wroteWithNode` half matters as much as the count: reading
     * through `fs` proves the platform is real, and *writing* through it proves
     * the effect is real too — a sandbox that allowed reads and quietly dropped
     * writes would pass a read-only test.
     */
    const pure = await run(
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const files = fs.readdirSync('data').filter((f) => f.endsWith('.txt'));",
        "const counts = {};",
        "for (const f of files) counts[f] = fs.readFileSync(path.join('data', f), 'utf8').trim().split('\\n').length;",
        "fs.writeFileSync('summary.json', JSON.stringify(counts));",
        "({ counts, wroteWithNode: fs.existsSync('summary.json') });",
      ].join("\n"),
      "both-pure",
    );

    assert.equal(pure?.status, "completed", String(pure?.error ?? ""));
    assert.deepEqual(pure?.value, { counts: { "a.txt": 3, "b.txt": 2 }, wroteWithNode: true });
    assert.equal(countCalls(pure), 0, "the pure-Node route must call no Reaper tool");
    assert.equal(
      await readFile(path.join(workspaceRoot, "summary.json"), "utf8").catch(() => "MISSING"),
      JSON.stringify({ "a.txt": 3, "b.txt": 2 }),
      "a write from Node must land in the workspace",
    );

    // The same work through Reaper's own tools, in the same session.
    const viaTools = await run(
      [
        "const { entries } = await tools.list_directory({ path: 'data' });",
        "const txt = entries.filter((e) => e.endsWith('.txt'));",
        "let lines = 0;",
        "for (const name of txt) {",
        "  const { window } = await tools.file_view({ path: 'data/' + name });",
        "  lines += window.join('\\n').trim().split('\\n').length;",
        "}",
        "({ files: txt.length, lines });",
      ].join("\n"),
      "both-tools",
    );

    assert.equal(viaTools?.status, "completed", String(viaTools?.error ?? ""));
    /*
     * `files` is asserted exactly; `lines` is asserted as a range, because the
     * window is line-numbered and keeps a trailing entry — `"1: one"`, `"2: two"`,
     * `"3: three"`, `"4: "` — so three content lines arrive as four window
     * entries and the two fixtures give seven rather than the five a plain
     * `split("\n")` would count. Pinning 7 would be pinning `file_view`'s
     * numbering convention inside a test about whether the tools route works at
     * all, and the next change to that convention would fail this for no reason.
     */
    assert.equal((viaTools?.value as { files?: number })?.files, 2);
    const lines = (viaTools?.value as { lines?: number })?.lines ?? 0;
    assert.ok(lines >= 5, `expected at least the 5 content lines, got ${lines}`);
    assert.ok(countCalls(viaTools) > 0, "the tools route must show its inner calls");
  } finally {
    await executor.cleanupBackgroundProcesses("code-mode-both").catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("models.* lets a script call the thread's chat model", async () => {
  /*
   * The Code Mode environment lends the thread's models the way it lends its
   * tools, so a program can orchestrate model calls instead of the model making
   * one round trip per call.
   *
   * Five properties, each one a thing that would make the surface useless if it
   * were false:
   *
   *   1. `models.list()` describes what is reachable.
   *   2. `models.call()` resolves to the *text*, not an envelope — a script
   *      should not have to write `.text` on every call.
   *   3. `Promise.all` over model calls is real concurrency, measured by peak
   *      in-flight rather than by wall clock, because wall clock on a stub is
   *      a timing coin flip.
   *   4. A provider failure arrives as a catchable error inside the script.
   *   4. There is no call cap: a script that makes many calls makes many calls.
   *
   * The runner is stubbed, so this measures the plumbing. That the runner is
   * reached at all is the whole claim being tested.
   */
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "code-mode-models-"));
  let inFlight = 0;
  let peak = 0;
  let invocations = 0;

  const executor = new ToolExecutor({
    workspaceRoot,
    runId: "code-mode-models",
    sessionId: "code-mode-models",
    traceId: "code-mode-models",
    logLevel: "info",
    safetyProfile: { mode: "permissive", policy: "default" },
    codeModels: [{ id: "stub/echo-1", provider: "stub", model: "echo-1", contextTokens: 8_000 }],
    codeModelRunner: async (invocation: CodeModelInvocation) => {
      invocations += 1;
      const prompt = invocation.messages[invocation.messages.length - 1]?.content ?? "";
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 120));
      inFlight -= 1;
      if (prompt.includes("FAIL")) {
        return { ok: false, error: { code: "provider_error", message: "upstream said no" }, durationMs: 120 };
      }
      return { ok: true, text: `echo:${prompt}`, model: "echo-1", durationMs: 120 };
    },
  } as never);

  const run = (code: string, id: string) =>
    executor.execute({ id, name: "eval", args: { code } } as unknown as ToolCall);

  try {
    // 1. Discovery.
    const listed = await run("models.list().map((m) => m.id);", "models-list");
    assert.deepEqual((listed.output as { value?: unknown } | undefined)?.value, ["stub/echo-1"]);

    // 2. The call resolves to text.
    const single = await run(
      "await models.call({ messages: [{ role: 'user', content: 'hi' }] });",
      "models-single",
    );
    assert.equal((single.output as { value?: unknown } | undefined)?.value, "echo:hi");

    // 3. Real concurrency.
    peak = 0;
    const parallel = await run(
      "await Promise.all(['a', 'b', 'c'].map((p) => models.call({ messages: [{ role: 'user', content: p }] })));",
      "models-parallel",
    );
    assert.deepEqual((parallel.output as { value?: unknown } | undefined)?.value, ["echo:a", "echo:b", "echo:c"]);
    assert.equal(peak, 3, `expected three calls in flight at once, saw ${peak}`);

    // 4. A failure is catchable, and named so it can be told from a tool error.
    const caught = await run(
      "try { await models.call({ messages: [{ role: 'user', content: 'FAIL' }] }); 'not caught'; } catch (e) { e.name; }",
      "models-caught",
    );
    assert.equal((caught.output as { value?: unknown } | undefined)?.value, "ReaperModelError");

    /*
     * 5. No cap. Asserted with `maxToolCalls` set to a number far below the
     * call count, because that is the cap that *would* apply if model calls
     * were counted as tools — and `maxToolCalls` counts `tools.*` calls only.
     * If someone later routes model calls through the tool counter, this fails
     * rather than silently limiting a feature that was asked to be unlimited.
     */
    invocations = 0;
    const many = await run(
      "(await Promise.all(Array.from({ length: 20 }, (_, i) => models.call({ messages: [{ role: 'user', content: 'n' + i }] })))).length;",
      "models-many",
    );
    assert.equal((many.output as { value?: unknown } | undefined)?.value, 20);
    assert.equal(invocations, 20, "every call must reach the runner");

    // 6. Bad arguments are explained rather than crashing the bridge.
    const malformed = await run("await models.call({ nope: true });", "models-malformed");
    assert.equal((malformed.output as { status?: string } | undefined)?.status, "error");
    assert.match(
      String((malformed.output as { error?: { message?: string } } | undefined)?.error?.message ?? ""),
      /requires `messages`/,
    );

    /*
     * Model calls are auditable. They join the same ledger as tool calls, so a
     * person reading a transcript sees the spend rather than an eval that
     * reached a provider with nothing recorded.
     */
    assert.ok(
      (parallel.output as { toolCalls?: Array<{ name: string }> } | undefined)?.toolCalls?.every(
        (call) => call.name === "echo-1",
      ),
      "model calls must appear in the eval's tool ledger, named by the model that ran",
    );
  } finally {
    await executor.cleanupBackgroundProcesses("code-mode-models").catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a host with no models leaves the surface unbound rather than empty", async () => {
  /*
   * `models` must be absent, not present-and-empty. An empty list reads as
   * "this thread has no models configured", which is a different and misleading
   * claim from "this environment does not lend you models" — and a fixture with
   * no gateway should not have to pretend it has one.
   */
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "code-mode-nomodels-"));
  const executor = new ToolExecutor({
    workspaceRoot,
    runId: "code-mode-nomodels",
    sessionId: "code-mode-nomodels",
    traceId: "code-mode-nomodels",
    logLevel: "info",
    safetyProfile: { mode: "permissive", policy: "default" },
  } as never);

  try {
    const result = await executor.execute({
      id: "no-models",
      name: "eval",
      args: { code: "typeof models;" },
    } as unknown as ToolCall);
    assert.equal((result.output as { value?: unknown } | undefined)?.value, "undefined");
  } finally {
    await executor.cleanupBackgroundProcesses("code-mode-nomodels").catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
