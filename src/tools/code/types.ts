/**
 * The contract between Code Mode's JavaScript and Reaper.
 *
 * `ReaperNodeRuntime` knows how to run JavaScript and how to call out
 * to *something* that can run a Reaper tool. It deliberately does not know what
 * a `ToolExecutor` is, what the registry contains, or that permission modes
 * exist. Everything it needs to reach the outside world is one method —
 * `invoke` — and the runtime holds no opinion about how that method authorizes
 * what it is asked to do.
 *
 * That split is what keeps the security story checkable. The runtime cannot
 * grant a capability because it never has one to grant; it can only ask the
 * host, and the host is Reaper's normal execution path. A bug in this file can
 * hang a script, return the wrong value, or leak memory — it cannot let a
 * model run a tool it was not allowed to run.
 */

/** One tool as the model's script sees it. */
export interface CodeToolDescriptor {
  name: string;
  description: string;
}

/**
 * What a tool call returned, in the two shapes a script can act on.
 *
 * Failure is a value rather than an exception so the host never has to decide
 * whether a thrown error was a rejected tool or a broken bridge; the bridge
 * translates this into a JS rejection at the boundary, where the model's own
 * `try`/`catch` can see it.
 *
 * `resolvedName` is the registry key the script's name meant, and it exists
 * because the two names serve two different readers. The script writes
 * `tools.read` and must be answered in its own vocabulary; the transcript and
 * the trajectory record describe a *tool that ran*, and `file_view` is what
 * ran. Only the bridge knows both, so only the bridge can say so — the runtime
 * holds the name the script typed and has no way to resolve it. It is optional
 * because a name that resolved to nothing has no canonical form, and in that
 * case the script's spelling is the only name there is.
 */
export type CodeToolOutcome =
  | { ok: true; output: unknown; durationMs: number; resolvedName?: string }
  | { ok: false; error: { code: string; message: string }; durationMs: number; resolvedName?: string };

export interface CodeToolInvocation {
  /** Stable id for this inner call, so its trace can be joined to the outer eval. */
  callId: string;
  name: string;
  args: unknown;
  /** Aborted when the turn is cancelled or the eval call runs out of time. */
  signal: AbortSignal;
}

/** The outside world, as the runtime sees it. */
export interface CodeToolHost {
  /** Tool names this agent may actually call. Already filtered by policy. */
  names(): readonly string[];
  /** One-line description plus JSON Schema, for `tools.list()` and `tools.describe()`. */
  describe(name: string): { description: string; inputSchema: unknown } | undefined;
  invoke(invocation: CodeToolInvocation): Promise<CodeToolOutcome>;
  /**
   * The chat models this thread may use, for `models.list()`.
   *
   * Optional, and `undefined` is a meaningful answer rather than an empty one:
   * a host with no conversation behind it has no models to lend, and the
   * runtime leaves `models` unbound in that case. Returning `[]` instead would
   * bind the surface and make `models.list()` read as "this thread has no
   * models configured", which is a different and misleading claim.
   */
  models?(): Promise<readonly CodeModelDescriptor[] | undefined>;
  /**
   * One model call, for `models.call()`.
   *
   * Separate from `invoke` because it is not a tool: it has no registry entry,
   * it is not offered to the model as a schema, and its result is prose. Keeping
   * it a distinct method means the tool path cannot accidentally route it
   * through policy checks meant for tools, and it makes the audit story explicit
   * — a host that implements this knows it is spending tokens.
   */
  callModel?(invocation: CodeModelInvocation): Promise<CodeModelOutcome>;
}

/** One model as a script sees it. */
export interface CodeModelDescriptor {
  /** The provider-qualified id a script passes to `models.call`. */
  id: string;
  provider: string;
  model: string;
  /** Input context window, so a script can judge whether its prompt fits. */
  contextTokens?: number;
}

export interface CodeModelInvocation {
  /** Correlates the call with its transcript row, like a tool call id. */
  callId: string;
  /** `provider/model`, or a bare model id to use the thread's own provider. */
  model?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  system?: string;
  signal?: AbortSignal;
}

/**
 * What a model call returned.
 *
 * A failure is a value here for the same reason it is on the tool path: the
 * script's own `try`/`catch` should be able to handle a provider outage without
 * the bridge having to decide whether the throw was a rejected call or a bug.
 */
export type CodeModelOutcome =
  | { ok: true; text: string; model: string; durationMs: number; usage?: { inputTokens?: number; outputTokens?: number } }
  | { ok: false; error: { code: string; message: string }; durationMs: number; model?: string };

export interface CodeRuntimeLimits {
  /**
   * Heap ceiling for the script's worker thread.
   *
   * Enforced by V8 through `resourceLimits`, not by a counter of our own:
   * exceeding it raises an `ERR_WORKER_OUT_OF_MEMORY` exit on that thread
   * alone, and the host maps it to a readable "your script used too much
   * memory" rather than letting it read as a crash.
   */
  memoryBytes: number;
  /**
   * Retained for compatibility; the worker runtime does not use it.
   *
   * It bounded the QuickJS *interpreter* stack, which was a real ceiling
   * because runaway recursion could exhaust the wasm heap. V8 imposes its own
   * limit and raises a catchable `RangeError` when it is reached, which the
   * runtime surfaces as an ordinary script error — so there is nothing left
   * for this number to configure.
   */
  stackBytes: number;
  /**
   * Wall clock for one eval call, including the time its tool calls take.
   *
   * The model can override this per call with `timeout_ms`; see
   * `EVAL_DEFAULT_TIMEOUT_MS` and `EVAL_MAX_TIMEOUT_MS` in `tools/eval.ts`,
   * which are the numbers that actually reach a model. This constant is the
   * fallback for a script that does not say.
   */
  timeoutMs: number;
  /**
   * Retained for compatibility; the worker runtime does not use it.
   *
   * It existed because QuickJS ran on the calling thread, so a script that
   * never yielded froze the whole process — no other conversation, no
   * WebSocket traffic, no Stop button — and a short budget was the only way to
   * bound that. A script now runs on its own thread, which `terminate()` kills
   * instantly, so the constraint it was written for is gone. `timeoutMs`
   * covers the same ground.
   */
  spinBudgetMs: number;
  /** Bytes of return value retained; anything past this is replaced by a preview. */
  maxResultBytes: number;
  /** Bytes of captured console output retained across the whole call. */
  maxConsoleBytes: number;
  /** Cap on inner tool calls, so a loop `await`ing a tool cannot run forever. */
  maxToolCalls: number;
  /** Cap on a single inner tool result before it crosses into the worker. */
  maxToolResultBytes: number;
}

export const DEFAULT_CODE_RUNTIME_LIMITS: CodeRuntimeLimits = {
  memoryBytes: 64 * 1024 * 1024,
  // Unused by the worker runtime; see the field's note above.
  stackBytes: 256 * 1024,
  /*
   * Two minutes, raised from thirty seconds, and the model can raise it further
   * per call with `timeout_ms`. Thirty seconds was chosen when a script's
   * slowest legitimate operation was a file read. It now runs model calls and
   * child processes whose own timeouts are measured in tens of seconds, so a
   * deadline shorter than the operations it bounds kills working scripts with a
   * message about a budget the caller could not have known about.
   */
  timeoutMs: 120_000,
  // Unused by the worker runtime; see the field's note above.
  spinBudgetMs: 2_000,
  maxResultBytes: 256 * 1024,
  /*
   * Raised from 32 KB now that console output is also the live view rather
   * than only an end-of-call diagnostic. Forty files logged at a line each is
   * a few kilobytes, and the old figure was chosen when the only reader was a
   * model that had already finished the script. Truncation still happens, and
   * still says so in the output.
   */
  maxConsoleBytes: 128 * 1024,
  maxToolCalls: 200,
  maxToolResultBytes: 4 * 1024 * 1024,
};

/** Why a run stopped, when it stopped for a reason other than finishing. */
export type CodeRuntimeStatus =
  | "completed"
  | "timeout"
  | "cancelled"
  | "memory"
  | "tool_call_limit"
  | "error";

export interface CodeConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
}

/**
 * One piece of output produced while a script runs.
 *
 * Kinds match the levels `console.*` offers, plus the two events that are not
 * a `console` call at all but read the same way in a transcript: a Reaper tool
 * being crossed, and the failure that ended the script.
 *
 * Lives here rather than next to the runtime because the session layer and the
 * tool that surfaces it both need the type, and neither should import the
 * runtime: the worker is loaded lazily behind `RuntimeLike` so `worker_threads`
 * stays off the boot path.
 */
export interface CodeOutputChunk {
  kind: CodeConsoleEntry["level"] | "tool" | "error";
  text: string;
}

export interface CodeToolCallRecord {
  name: string;
  ok: boolean;
  durationMs: number;
  /** Set when the tool failed, so the trace names the reason without the output. */
  error?: { code: string; message: string };
}

export interface CodeRuntimeResult {
  status: CodeRuntimeStatus;
  /**
   * The final evaluated expression, already reduced to JSON-safe data by the
   * worker. `undefined` when the script produced no value — which is a normal
   * outcome for a script whose last statement is a declaration or a `while`.
   */
  value: unknown;
  /** True when `value` was replaced by a bounded preview. */
  truncated: boolean;
  /** Serialized size of the value the script returned, before any truncation. */
  resultBytes: number;
  console: CodeConsoleEntry[];
  consoleTruncated: boolean;
  toolCalls: CodeToolCallRecord[];
  durationMs: number;
  /**
   * The JavaScript error that ended the run, when there was one. Kept separate
   * from `status` because a tool-call limit and a `throw` are both "failed" but
   * need different words in front of the model.
   */
  error?: {
    name: string;
    message: string;
    stack?: string;
    /**
     * Line in the model's own script, when the engine reported a position.
     *
     * Present because the primary way a model fixes its code is by being told
     * where the code went wrong. The message also carries it in prose; this
     * field is here so the UI can link to the line and so a caller is not
     * reduced to parsing it back out.
     */
    line?: number;
    /**
     * The error's own `code`, when it had one.
     *
     * `REAPER_REFUSED` is the one that matters: it means Code Mode's guard
     * declined the operation rather than the script being broken, which is a
     * different sentence in front of the model and a different colour in the
     * transcript. Without this the code was dropped on the way out of the
     * worker and a refusal was indistinguishable from any other throw.
     */
    code?: string;
  };
  /** Set when the JS error was caused by a Reaper tool rejecting. */
  toolError?: { code: string; message: string; toolName: string };
  /**
   * Whether the script ran inside the bubblewrap sandbox.
   *
   * `false` means it ran as a thread of the Reaper process and could see the
   * whole machine, which is what eval did before the sandbox existed and what
   * it still does on a host where bubblewrap cannot run. It is reported rather
   * than assumed because the difference is a security property, and a caller
   * (or a model) that needs to know whether a script could have read something
   * outside its workspace has to be able to ask.
   */
  sandboxed?: boolean;
  /**
   * Non-fatal information about the run that the model needs and cannot infer.
   *
   * The motivating case: a script that needed the async wrapper for its
   * top-level `await` and ended in a statement the tail-lifter could not lift.
   * The code ran and the tool calls happened, but no value came back — which
   * looks exactly like a script that deliberately returned nothing. Without
   * this the model has no way to tell those apart.
   */
  note?: string;
}
