/**
 * tools/eval.ts — Code Mode.
 *
 * One tool, `eval`, that hands the model a real JavaScript runtime with
 * Reaper's own tools reachable inside it as `tools.*`. The model decides for
 * itself whether a task wants a direct tool call or a program; there is no
 * router, no planner, and no classifier in this path.
 *
 * The three things worth knowing about this file:
 *
 * 1. It is thin on purpose. `ReaperNodeRuntime` owns the worker, the bridge owns
 *    authorization, and this owns the contract the model sees — the schema, the
 *    wording of a failure, and the shape of what comes back. Anything thicker
 *    here would be a second place for those decisions to be made.
 *
 * 2. A failed script is a *successful* eval call. A script that threw, looped
 *    forever, or was cancelled is information the model needs in order to act,
 *    so it comes back as an ordinary result carrying `status` and `error` —
 *    alongside the console output, the inner tool calls, and whatever value the
 *    script did manage to produce. Throwing instead would strip exactly the
 *    context that makes the failure diagnosable. The tool-level error channel
 *    is reserved for eval itself being unable to run at all.
 *
 * 3. Nothing here is a permission check. `ReaperToolBridge` re-validates every
 *    inner call against the registry and hands it to the normal executor, and
 *    the runtime is only *offered* tools the bridge will accept. What the
 *    script does with raw Node — `fs`, `fetch`, `exec` — is outside that
 *    path by design: see the note in `node-runtime.ts` for the tradeoff.
 */

import { z } from "zod";

import { runInSession } from "./code/session.js";
import { DEFAULT_CODE_RUNTIME_LIMITS } from "./code/types.js";
import type {
  CodeOutputChunk,
  CodeRuntimeResult,
  CodeToolCallRecord,
  CodeToolDescriptor,
  CodeToolHost,
} from "./code/types.js";

/**
 * The default deadline for one eval, and the ceiling a script may ask for.
 *
 * Two minutes, raised from thirty seconds. The old default was chosen when a
 * script's slowest legitimate operation was a file read; the environment now
 * runs model calls and child processes whose own timeouts are measured in tens
 * of seconds, and a deadline shorter than the operations it bounds turns a
 * working script into a timeout with no way to complain.
 */
export const EVAL_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The ceiling. Thirty minutes.
 *
 * High enough that no honest script meets it — the longest legitimate thing a
 * script does is wait on a slow provider, and that is measured in minutes, not
 * tens of them. Low enough that a script stuck in a state the runtime cannot
 * see through still ends the turn rather than holding it forever.
 */
export const EVAL_MAX_TIMEOUT_MS = 30 * 60_000;

/**
 * The model-facing schema.
 *
 * `timeout_ms` exists because the model is better placed than this file to know
 * how long its own script needs, and the default was getting in the way of work
 * that is legitimate. A model call on some providers takes 45-60 seconds to
 * first token — measured, not assumed — so a script that awaits one, or awaits
 * several in sequence, needs minutes rather than the 30 seconds this used to
 * allow, and it was being killed mid-call with a message about a budget it had
 * no way to raise. Making the deadline the model's to set is the honest fix.
 *
 * The ceiling stays. It is not there to second-guess the model's estimate; it
 * is what keeps the runtime's one guarantee true — that a turn comes back.
 * `terminate()` kills a script that has stopped making progress, and an
 * unbounded deadline would mean a script could hold a turn open for as long as
 * somebody was willing to wait, which is the failure this whole runtime exists
 * to prevent.
 */
export const EvalArgsSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .describe(
        "JavaScript to run. The value of the last expression is the result — no return statement needed, and `await` works at the top level. End with the value: a trailing declaration, loop, or `console.log` produces no result even when the work succeeded.",
      ),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(EVAL_MAX_TIMEOUT_MS)
      .optional()
      .describe(
        `How long this script may run, in milliseconds. Defaults to ${EVAL_DEFAULT_TIMEOUT_MS} (2 minutes); maximum ${EVAL_MAX_TIMEOUT_MS}. Raise it when the script waits on something slow — a model call, a build, a long network fetch.`,
      ),
  })
  .strict();

export type EvalArgs = z.infer<typeof EvalArgsSchema>;


/**
 * The description the model routes on.
 *
 * This text is the entire routing mechanism, so it is written as a decision
 * rather than a capability list: what eval is good at, what it is not for, and
 * where the tools live. "Do not use eval merely to wrap a single ordinary tool
 * call" is the line doing the most work — without it, a model that has just
 * been handed a code interpreter will use it for everything, and every ordinary
 * tool call gains a layer of JavaScript between the model and the work.
 *
 * The `codemode` skill line names the skill rather than describing it, and that
 * is deliberate: the skill is a document, and its body costs context in every
 * turn of every conversation if it is inlined here. Naming it lets the model
 * decide whether it needs the fifteen worked examples, which is a decision it
 * is better placed to make than this string is.
 *
 * **The tool-surface paragraph is the whole Cloudflare trick, in one sentence.**
 * Every other way of making a large tool set available pays for it on every
 * turn: the deferred list in the system prompt costs about 35 tokens per tool
 * per turn, so a hundred tools is 3,500 tokens of standing context that the
 * model usually does not need. This description costs the same whether Reaper
 * has thirty tools or three thousand, because the catalogue is not in the
 * prompt — it travels into the worker's `workerData` and the model reaches into
 * it with `tools.search_tools`, `tools.describe` and `tools.list`, which return
 * only what was asked for.
 *
 * That property already held. What was missing was the model being *told*,
 * which is what the paragraph adds: without it a model that can see the
 * deferred list in its prompt reasonably concludes those tools need unlocking
 * before eval can use them, and the whole advantage goes unused. It is one
 * sentence at fixed cost, and it is the difference between a capability that
 * exists and one that gets used.
 */
export const EVAL_TOOL_DESCRIPTION =
  "Execute JavaScript in a real Node.js runtime: the full language and the full platform, including npm packages, node:* builtins, network access, child processes, and parallel execution.\n" +
  /*
   * The "not for this" list goes first, and it is doing more work than any other
   * sentence here.
   *
   * A model handed a code interpreter reaches for it constantly, and for most
   * tasks that is a straight loss: creating a file, reading one file, running a
   * test, a git command — each already has a tool that does it in one step, and
   * wrapping it in a script adds a layer between the model and the work, hides
   * the operation from the transcript, and buys nothing. Naming those cases
   * explicitly is what keeps the routing decision honest.
   */
  "Do not use eval for a single ordinary operation: creating or editing a file, reading one file, listing a directory, searching, running a build, a test, or a git command. Call that tool directly — same round trips, clearer transcript.\n" +
  "Do not use eval when you need to see a result before deciding the next step. Call the tool and look.\n" +
  "Use eval when the user asks for it, or when the task needs what a single call cannot express: the same operation over many items, a loop or fan-out, filtering or aggregating a large result to a small answer, or dependent steps that chain with no reasoning needed between them.\n" +
  "It is a real Node runtime, and Reaper's own tools are available inside it through `tools.*` — every tool this agent can call, including any whose schema is not in your context, with nothing to unlock first. Use whichever fits each step; reading with `tools.file_view` and parsing with a package is one script, not two styles. `tools.search_tools({ query })` finds a tool by capability, `tools.describe(name)` gives its arguments, `tools.list()` gives the catalogue. `eval` itself is the one exception: a script cannot call eval.\n" +
  "`await models.call({ messages: [...] })` reaches this thread's chat model, and `Promise.all` over several is real concurrency — for when one program needs several answers to compare or combine.\n" +
  "End with the value: the result is the last *expression*'s value, and a trailing declaration, loop, or `console.log` returns nothing even when the work succeeded. `const r = await tools.grep_search(…); r.matches.length` works; stopping after the `const` does not. Keep intermediate data in JavaScript and return a compact final result.\n" +
  "A `tools.*` call carries the workspace, the permission checks, and the audit log, so it is the better choice when one does the job — and when none does, write the code.\n" +
  "Load the `codemode` skill with activate_skill before writing a script that loops or batches more than a couple of calls: it has the return semantics, the tools.* and models.* APIs, and worked examples.\n" +
  "Pass `timeout_ms` if the script waits on something slow: the default is 2 minutes and a model call can take a minute.\n" +
  "Each eval starts with a fresh environment, so variables from an earlier eval are not visible here. The script runs with your access and its effects are real, so writes outside the workspace are refused. Destructive operations are irreversible.";

export interface ExecuteEvalOptions {
  args: EvalArgs;
  /** The tool-call id, so the result joins its trace row. */
  toolCallId: string;
  /** Identity of the run whose eval session this call belongs to. */
  runId: string;
  /** The same executor instance the model's own calls go through. */
  host: CodeToolHost;
  /**
   * The thread's workspace, and the root every relative path in the script
   * resolves against — `fs.readFileSync('src/app.ts')`, `execSync('ls src')`,
   * and `require('./local.js')` alike.
   *
   * Optional in the type only because the tests build option objects by hand.
   * In production it must be set: omitting it falls back to `process.cwd()`,
   * which for a Reaper server is Reaper's own checkout rather than the thread's
   * — observed live as a script dying on
   * `ENOENT: no such file or directory, open '/work/src/sample/expected.json'`
   * for a file that existed in its workspace the whole time.
   */
  workspace?: string | undefined;
  /** Names the thread switched off; removed from the offered surface. */
  disabledTools?: ReadonlySet<string>;
  signal?: AbortSignal;
  /** Cap on inner Reaper tool calls for this eval. */
  maxToolCalls?: number;
  /**
   * Called as the script produces output, so a transcript can show it moving
   * rather than waiting for the call to finish. See `CodeRuntimeRunOptions`.
   */
  onOutput?: (chunk: CodeOutputChunk) => void;
  /** Called as each inner tool call finishes, for the same live view. */
  onToolCall?: (record: CodeToolCallRecord) => void;
}

/**
 * Run one Code Mode call.
 *
 * Exported as the payload rather than as a `ToolResult` because that is what
 * every other arm of the executor's `executeInner` switch returns: the
 * dispatcher builds the envelope, so a tool that builds its own gets wrapped
 * twice and the real value ends up one level deeper than anything is looking
 * for. That is not a cosmetic difference — the UI, the traces, and the model
 * all read `output.value`, and all of them would have read `output.output.value`.
 *
 * The `undefined` in the signature is the failure channel the executor already
 * understands: several other tools return it to mean "the arguments were
 * rejected", and it is what makes an eval that could not start at all — no
 * workspace, a runtime that will not start — come back as a thrown tool error rather than a
 * successful result with an error inside it.
 */
export async function evaluateScript(options: ExecuteEvalOptions): Promise<Record<string, unknown> | undefined> {
  try {
    const session = await runInSession(options.runId, {
      source: options.args.code,
      tools: catalogueFor(options.host, options.disabledTools),
      host: options.host,
      ...(options.workspace ? { workspace: options.workspace } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      /*
       * The deadline and the tool-call cap are merged into one `limits` object
       * because that is the shape `SessionRunOptions` takes, and it merges what
       * it receives over the runtime's defaults. Both are per-call overrides of
       * a default rather than a new configuration surface.
       */
      ...(options.maxToolCalls !== undefined || options.args.timeout_ms !== undefined
        ? {
            limits: {
              ...(options.maxToolCalls !== undefined ? { maxToolCalls: options.maxToolCalls } : {}),
              ...(options.args.timeout_ms !== undefined ? { timeoutMs: options.args.timeout_ms } : {}),
            },
          }
        : {}),
      ...(options.onOutput ? { onOutput: options.onOutput } : {}),
      ...(options.onToolCall ? { onToolCall: options.onToolCall } : {}),
    });
    return shapeOutput(session.result, session.surfaceChanged);
  } catch (error) {
    /*
     * The one case that does throw. A runtime that will not start is not the
     * model's mistake and not something its next script can work around, so it
     * belongs in the tool-error channel rather than in a result the model is
     * invited to interpret. Everything else — a syntax error, a timeout, a
     * denied tool — is a *successful* eval that produced information.
     */
    throw new SandboxUnavailableError(
      `The JavaScript runtime could not be started: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * A distinct type so the executor's error mapping gives it its own code.
 *
 * The executor reads `error.code` off anything thrown, so a bare `Error` would
 * arrive at the model as `tool_error` — true but uninformative. This names the
 * one failure mode where the feature itself is broken rather than the script.
 */
export class SandboxUnavailableError extends Error {
  readonly code = "runtime_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/** How many outer tools the runtime offers, for the trace and for tests. */
export function catalogueFor(host: CodeToolHost, disabledTools?: ReadonlySet<string>): CodeToolDescriptor[] {
  const names = host.names().filter((name) => !disabledTools?.has(name));
  return names.map((name) => ({
    name,
    description: describeVia(host, name),
  }));
}

function describeVia(host: CodeToolHost, name: string): string {
  return host.describe(name)?.description ?? `${name} — provided by Reaper.`;
}

/**
 * Build the model-facing payload.
 *
 * Two properties matter more than the field list. Every field is bounded —
 * console text, the result, the error message, the per-call list — because the
 * whole point of Code Mode is that a large intermediate result does not reach
 * the model, and a report that re-imported it would undo that. And the report
 * always names what the script *did*: which tools it called, how many, how
 * long each took. A model reading a failed eval needs that to tell "my loop was
 * wrong" apart from "the file it read was not there".
 */
function shapeOutput(result: CodeRuntimeResult, surfaceChanged: boolean): Record<string, unknown> {
  const toolCalls = result.toolCalls.map((call) => ({
    name: call.name,
    ok: call.ok,
    durationMs: call.durationMs,
    ...(call.error ? { error: `${call.error.code}: ${truncate(call.error.message, 240)}` } : {}),
  }));

  const output: Record<string, unknown> = {
    status: result.status,
    durationMs: result.durationMs,
    toolCallCount: toolCalls.length,
    toolCalls,
    ...(result.console.length > 0 ? { console: result.console.map((entry) => ({ level: entry.level, text: entry.text })) } : {}),
    ...(result.consoleTruncated ? { consoleTruncated: true } : {}),
    ...(result.truncated ? { resultTruncated: true, resultBytes: result.resultBytes } : {}),
    ...(result.error ? { error: describeFailure(result) } : {}),
    ...(result.toolError ? { failedTool: result.toolError.toolName } : {}),
    ...(result.note ? { note: result.note } : {}),
    ...(surfaceChanged ? { note: surfaceChangedNote() } : {}),
  };

  /*
   * `value` is present only when the script was trying to return something.
   * For a timeout or a `while (true)` there is no value, and emitting
   * `value: undefined` would make `JSON.stringify` drop the key anyway —
   * better to be explicit about when it exists.
   */
  if (result.status === "completed") output.value = result.value;
  return output;
}

function describeFailure(result: CodeRuntimeResult): Record<string, unknown> {
  const error = result.error;
  if (!error) return { name: "Error", message: "The script failed." };
  const hint = result.toolError
    ? `A Reaper tool rejected this call and the rejection escaped the script. Wrap it — try { await tools.${result.toolError.toolName}(...) } catch (e) { ... } — to handle it and keep going.`
    : undefinedVariableHint(error);
  return {
    name: error.name,
    message: error.message,
    ...(result.toolError ? { tool: result.toolError.toolName, code: result.toolError.code } : {}),
    ...(hint ? { hint } : {}),
  };
}

/**
 * The correction for a script that used a variable it did not define.
 *
 * Observed live: the model split work across two eval calls — `const files =
 * await tools.glob(...)` in one, then a loop over `files` in the next — and got
 * `files is not defined`. The message is accurate and useless, because the
 * model's mental model was that the environment persists, and nothing in a
 * bare ReferenceError contradicts that.
 *
 * The environment does not persist, and cannot: the worker holding those
 * variables is the thread that gets killed to stop a runaway script, so
 * keeping it alive between calls would mean keeping a script that was killed
 * mid-run alive for the next one. `PERSISTENCE_NOTE` came from that tradeoff.
 *
 * Two caveats kept this narrower than the note. `e` and `error` in a catch,
 * and the loop variables of a `for`, are undefined exactly when they are out
 * of scope, so a hint about persistence would be nonsense there — those names
 * are skipped. And a `ReferenceError` from a typo in the *same* script is the
 * more common case, so the sentence names the variable and stays short enough
 * to read as "here is your mistake" rather than as a lecture.
 */
function undefinedVariableHint(error: { name?: string; message?: string }): string | undefined {
  if (error.name !== "ReferenceError") return undefined;
  const name = /^(\w+) is not defined$/.exec(error.message ?? "")?.[1];
  if (!name || COMMON_SCOPE_NAMES.has(name)) return undefined;
  /*
   * `__reaper*` names never belong to the model — they are the bridge's own
   * plumbing. Telling a model that `__reaperCall` is not defined would be
   * Reaper narrating a bug in Reaper, and the model cannot act on it.
   */
  if (name.startsWith("__reaper")) return undefined;
  return `\`${name}\` is not defined in this script. Each eval runs in a fresh environment, so a variable from an earlier eval is not visible here — declare it in this script, or write it to a file with tools.write and read it back.`;
}

/**
 * Names a ReferenceError reports that are almost always a scoping mistake in
 * the script being run rather than a missing variable from an earlier call.
 */
const COMMON_SCOPE_NAMES: ReadonlySet<string> = new Set(["e", "err", "error", "ex", "cause", "i", "j", "k", "v", "x"]);

function surfaceChangedNote(): string {
  return (
    "The available tool list changed earlier in this run, but this runtime was already started with the previous one, " +
    "so `tools.*` in this call reflects that earlier list. Call tools.list() to see exactly what is bound."
  );
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Exported for the runtime-limit documentation the Settings page renders. */
export const EVAL_DEFAULT_LIMITS = DEFAULT_CODE_RUNTIME_LIMITS;
