/**
 * Code Mode's runtime: the model's JavaScript, run as real Node in a worker.
 *
 * This replaces a QuickJS-based runtime that ran the same scripts in a WASM
 * sandbox with no filesystem, no network, and no modules. That sandbox was
 * secure and too small: the live model kept writing `await import('node:fs')`
 * and `require('lodash')` because that is what JavaScript that does real work
 * looks like, and every one of those scripts failed. The decision was to give
 * eval the whole language and the whole platform, and to accept what that costs.
 *
 * **What it costs.** A script that reads a file through `node:fs` does not pass
 * through Reaper's permission checks, approval prompts, or audit log. Code Mode
 * is therefore no longer a security boundary, and anything relying on it to be
 * one is wrong. `tools.*` still goes through the real executor with every check
 * intact — so the audited path exists and is the better one — but it is now a
 * convenience rather than the only door.
 *
 * **What survives.** Everything about *liveness*, which is what a worker thread
 * is actually good at:
 *
 *   - `while (true) {}` is killed by `terminate()`, because the spinning code
 *     is on a thread that is not the event loop. Under QuickJS this needed an
 *     interrupt handler and a spin budget; here it is free and it is instant.
 *   - Memory is capped by V8 itself through `resourceLimits`, and exceeding it
 *     kills the worker rather than the process.
 *   - Cancellation is `terminate()`, which is immediate and unconditional
 *     rather than cooperative.
 *   - Timeouts, result-size limits, console limits, and tool-call limits are
 *     all enforced here on the host side, where the untrusted code cannot see
 *     or influence them.
 *
 * The class implements the same four-method shape the session layer already
 * expected of the QuickJS runtime — `create`, `run`, `dispose`, `alive` — which
 * is the whole reason this swap touches so little else. That interface was
 * written to make the runtime replaceable; this is it being replaced.
 */

import { Worker } from "node:worker_threads";

import { buildChildEnv } from "../child-env.js";

import { aliasesForTool } from "../normalize.js";
import { CODE_MODE_WORKER_SOURCE } from "./worker-source.js";
import { liftTrailingBlocks, splitTrailingExpression, wrapWithTail, wrapWithoutTail } from "./transform.js";
import { DEFAULT_CODE_RUNTIME_LIMITS } from "./types.js";
import type {
  CodeConsoleEntry,
  CodeOutputChunk,
  CodeRuntimeLimits,
  CodeRuntimeResult,
  CodeRuntimeStatus,
  CodeToolCallRecord,
  CodeToolDescriptor,
  CodeToolHost,
} from "./types.js";

export interface NodeRuntimeRunOptions {
  source: string;
  tools: readonly CodeToolDescriptor[];
  host: CodeToolHost;
  signal?: AbortSignal | undefined;
  limits?: Partial<CodeRuntimeLimits> | undefined;
  onOutput?: ((chunk: CodeOutputChunk) => void) | undefined;
  onToolCall?: ((record: CodeToolCallRecord) => void) | undefined;
  /** Directory the script's `require` and relative paths resolve against. */
  workspace?: string | undefined;
}

/** What the worker sends us. Mirrors the postMessage shapes in worker-source. */
type WorkerMessage =
  | { type: "console"; level: CodeConsoleEntry["level"]; text: string }
  | { type: "consoleTruncated" }
  | { type: "tool"; id: number; name: string; args: unknown }
  | { type: "model"; id: number; args: unknown }
  | { type: "child"; pid: number }
  | { type: "done"; value: unknown }
  | { type: "failed"; error: { name: string; message: string; stack?: string; code?: string; tool?: string } };

export class ReaperNodeRuntime {
  private readonly limits: CodeRuntimeLimits;
  private worker: Worker | undefined;
  private disposed = false;

  /**
   * Every child process any eval in this run has started, so the run can outlive
   * them cleanly.
   *
   * On the *runtime* rather than on a single `run()` call, and that placement is
   * the whole design. A worker is not a process group — `terminate()` ends the
   * thread and leaves everything it spawned running — so without a record, a
   * script's background process outlives the object that knows it exists and
   * nothing can ever stop it.
   *
   * Reaping it at the end of each eval was the first attempt and it was wrong:
   * a model that starts a dev server in one eval and curls it in the next would
   * find it dead, which is a restriction on what the model can write that
   * nothing in the feature's contract asks for. `bash` cleans up at the end of
   * the *run* — `cleanupBackgroundProcesses` — and this is the same boundary, so
   * the two surfaces agree and a process started either way lives exactly as
   * long as its turn.
   *
   * A `Set` because the worker reports a pid on every async spawn and the same
   * handle can be reported more than once.
   */
  private readonly childPids = new Set<number>();

  /**
   * Globals the model set in a previous eval of this run.
   *
   * The QuickJS runtime kept one context alive across a run so `const x = ...`
   * in one call was visible in the next. A worker cannot do that and stay
   * killable — the thread that holds the state is the thread `terminate()`
   * destroys — so persistence is not carried forward, and the session layer's
   * per-run key now buys process-level reuse of nothing. That is a real
   * regression from the QuickJS version and it is noted in the tool result
   * rather than hidden: see `PERSISTENCE_NOTE`.
   */
  static readonly PERSISTENCE_NOTE =
    "Each eval runs in a fresh worker, so variables from a previous eval in this run are not visible. Keep what you need inside one script, or write it to a file with tools.write.";

  private constructor(limits: CodeRuntimeLimits) {
    this.limits = limits;
  }

  /** Matches the QuickJS runtime's factory so the session layer is unchanged. */
  static async create(limits?: Partial<CodeRuntimeLimits>): Promise<ReaperNodeRuntime> {
    return new ReaperNodeRuntime({ ...DEFAULT_CODE_RUNTIME_LIMITS, ...limits });
  }

  get alive(): boolean {
    return !this.disposed;
  }

  /**
   * End the run: stop the thread, and stop what it started.
   *
   * The reaping is here, at the run boundary, rather than at the end of each
   * `run()` call — see `childPids` for why that distinction matters. This is the
   * same moment `BackgroundProcessManager.terminateAll` fires for `bash`, so a
   * process started from a script and one started from a shell now live exactly
   * as long as each other: the length of the turn.
   *
   * Fire and forget. The caller is tearing down and has no use for a promise,
   * and a child that ignores SIGTERM should cost a `kill -9`'s delay in the
   * background rather than a teardown that hangs on it.
   */
  dispose(): void {
    this.disposed = true;
    void this.worker?.terminate();
    this.worker = undefined;
    if (this.childPids.size > 0) {
      const pids = [...this.childPids];
      this.childPids.clear();
      void reapChildren(pids);
    }
  }

  /** Cancellation from outside. Kills the thread; the run settles as cancelled. */
  requestDispose(): void {
    void this.worker?.terminate();
  }

  async run(options: NodeRuntimeRunOptions): Promise<CodeRuntimeResult> {
    const limits = { ...this.limits, ...options.limits };
    const started = Date.now();
    const consoleEntries: CodeConsoleEntry[] = [];
    const toolCalls: CodeToolCallRecord[] = [];

    let consoleBytes = 0;
    let consoleTruncated = false;
    let toolCallCount = 0;
    let settled = false;
    let status: CodeRuntimeStatus = "completed";
    let value: unknown;
    let failure: CodeRuntimeResult["error"];
    let toolError: CodeRuntimeResult["toolError"];
    let note: string | undefined;


    /*
     * Keyed by the canonical name *and* every alias the bridge accepts, because
     * the bridge accepts both and this map is the only thing `tools.describe`
     * can answer from. Indexing one spelling would make `tools.read(...)` work
     * while `tools.describe("read")` returned `undefined` — which a script reads
     * as "this tool takes no arguments", not as "try the other name".
     */
    const schemas: Record<string, unknown> = {};
    const aliases: string[] = [];
    for (const tool of options.tools) {
      const described = options.host.describe(tool.name);
      if (!described) continue;
      const entry = { description: described.description, input: described.inputSchema };
      schemas[tool.name] = entry;
      for (const alias of aliasesForTool(tool.name)) {
        schemas[alias] = entry;
        aliases.push(alias);
      }
    }

    const plan = planCompletion(options.source);
    /*
     * Hoisted out of the `workerData` literal below because the message handler
     * needs to compare against it — see the `failed` case, where it is what
     * distinguishes "the script threw" from "the script was out of time".
     */
    const deadlineAt = started + limits.timeoutMs;

    /*
     * The model catalogue is fetched once, before the worker starts, so the
     * script sees a stable list and `models.list()` is synchronous inside the
     * worker rather than another round trip per call.
     *
     * A host that throws here — no catalog, no credentials — leaves `models`
     * unbound rather than failing the eval. A script that never calls a model
     * should not be stopped because the model surface could not be built, which
     * is the same reason every other optional capability in this runtime
     * degrades to absence rather than to an error.
     */
    let models: readonly unknown[] | undefined;
    if (options.host.models) {
      try {
        models = await options.host.models();
      } catch {
        models = undefined;
      }
    }

    const worker = new Worker(CODE_MODE_WORKER_SOURCE, {
      eval: true,
      workerData: {
        source: options.source,
        compiled: plan.source,
        tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description })),
        schemas,
        // Only so `'read' in tools` agrees with `tools.read(...)` actually
        // working. `tools.list()` stays canonical.
        aliases,
        workspace: options.workspace ?? process.cwd(),
        limits: { maxConsoleBytes: limits.maxConsoleBytes },
        // Undefined when the host offers no models; the worker binds `models`
        // to nothing in that case, so `models.list()` fails loudly and locally.
        models,
        /*
         * When this eval's budget runs out, as an absolute timestamp.
         *
         * The worker cannot compute it: the timer below is the host's, and the
         * thread has no way to ask what it was set to. Its only use is to hand a
         * deadline to a *synchronous* child process, which is the one thing
         * `terminate()` cannot interrupt — a thread parked in a blocking syscall
         * never reaches the safepoint where termination is checked, so a script
         * calling `execSync('sleep 300')` ignored the 30-second limit entirely.
         * Giving the child the remaining budget makes it exit, which unblocks
         * the thread, which lets the termination finally land.
         */
        deadlineAt,
      },
      /*
       * The memory ceiling, enforced by V8 rather than by us. Exceeding it
       * raises an `ERR_WORKER_OUT_OF_MEMORY` exit on this thread alone — the
       * host keeps running, which is the entire reason the script is over here
       * and not on the main thread.
       */
      resourceLimits: {
        maxOldGenerationSizeMb: Math.max(16, Math.floor(limits.memoryBytes / (1024 * 1024))),
        maxYoungGenerationSizeMb: 32,
      },
      /*
       * stdout/stderr stay with the parent so a `process.stdout.write` from the
       * script — or from a package it imported — lands in Reaper's own output
       * instead of vanishing. Console is captured separately and structured;
       * this is the catch-all for everything that writes to the fd directly.
       */
      stdout: false,
      stderr: false,
      /*
       * The same environment a `bash` child gets, and for the same reason.
       *
       * A Worker inherits the parent's environment by default, which would
       * hand the model's script `process.env` complete with Reaper's own
       * provider keys — the ones the credential store exists to keep out of
       * reach. `bash` has been sanitised since the beginning; Code Mode is the
       * same class of surface (Reaper's own process running code Reaper did
       * not write) and reaching it through `eval` instead of through a shell
       * should not be the way around that.
       *
       * This is not a sandbox and is not meant to be one. Everything an
       * ordinary child process sees — PATH, HOME, the project's own
       * variables — still arrives. What is withheld is Reaper's credentials
       * and anything else shaped like a secret. A script that genuinely needs
       * a provider key should get it the way the model does: by asking for it.
       */
      env: buildChildEnv({ workspaceRoot: options.workspace ?? process.cwd() }).env,
      /*
       * `await import('node:fs')` is what the live model writes, and without
       * this flag it fails with "A dynamic import callback was invoked without
       * --experimental-vm-modules" — a message about vm internals, raised at
       * the model's most natural line, that no amount of rewriting its script
       * would fix.
       *
       * Set on the worker rather than on the host process: `execArgv` applies
       * to this thread alone, so Code Mode gets the capability without Reaper
       * itself having to be launched with an experimental flag.
       */
      execArgv: ["--experimental-vm-modules"],
    });
    this.worker = worker;

    /*
     * A worker holds the process open. Code Mode must not be the reason a CLI
     * invocation refuses to exit, and the run has its own timeout, so the
     * thread is not allowed a vote on process lifetime.
     */
    worker.unref();

    const abortListener = () => {
      status = "cancelled";
      void worker.terminate();
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });

    const timer = setTimeout(() => {
      status = "timeout";
      void worker.terminate();
    }, limits.timeoutMs);
    timer.unref?.();

    const pushConsole = (level: CodeConsoleEntry["level"], text: string) => {
      if (consoleTruncated) return;
      if (consoleBytes + text.length > limits.maxConsoleBytes) {
        consoleTruncated = true;
        return;
      }
      consoleBytes += text.length;
      consoleEntries.push({ level, text });
      // Same rule as the tool sinks above: an observer cannot fail the run.
      try {
        options.onOutput?.({ kind: level, text });
      } catch {
        // Ignored on purpose.
      }
    };

    /*
     * Every sink is called inside its own try/catch, and that is not defensive
     * habit — it is a bug fix.
     *
     * The dispatchers post their answer to the worker *after* this closure
     * returns, so a transcript sink that throws escaped upward, skipped the
     * post, and left the script's `await tools.x()` pending forever: the run
     * then died on the timeout instead of finishing, because something whose
     * only job is to draw a line in a UI had failed. The display is not the
     * task. A sink that throws must not turn a script that worked into a script
     * that hung.
     *
     * Shared by the tool and model dispatchers rather than written twice,
     * because the failure it guards against is identical for both and a second
     * copy is a second place for the guard to be dropped.
     */
    const recordCall = (entry: CodeToolCallRecord): void => {
      toolCalls.push(entry);
      for (const sink of [
        () => options.onToolCall?.(entry),
        () =>
          options.onOutput?.({
            kind: "tool",
            text: `${entry.name} ${entry.ok ? "ok" : `failed: ${entry.error?.message ?? "error"}`} (${entry.durationMs}ms)`,
          }),
      ]) {
        try {
          sink();
        } catch {
          // A broken observer is not a broken run.
        }
      }
    };

    await new Promise<void>((resolve) => {
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      worker.on("message", (message: WorkerMessage) => {
        switch (message.type) {
          case "console":
            pushConsole(message.level, message.text);
            return;

          case "consoleTruncated":
            consoleTruncated = true;
            return;

          case "child":
            /*
             * Recorded, never killed here. A child may be one the script is
             * waiting on, one a later eval in the same run will talk to, or a
             * server the user asked for; all three are legitimate and stopping
             * any of them at the moment they are reported would break work the
             * model is entitled to do. The run decides when they are done.
             */
            if (typeof message.pid === "number") this.childPids.add(message.pid);
            return;

          case "tool": {
            void this.dispatchTool(message, {
              host: options.host,
              limits,
              worker,
              signal: options.signal,
              count: () => ++toolCallCount,
              record: recordCall,
              onLimit: () => {
                status = "tool_call_limit";
                void worker.terminate();
              },
            });
            return;
          }

          case "model":
            /*
             * No cap, deliberately.
             *
             * `tools.*` has one because a tool call is cheap and a loop over
             * one is usually a mistake. A model call is expensive enough that a
             * script making thousands of them is a decision somebody made on
             * purpose, and the deadline is what stops a runaway — a script that
             * is still going after two minutes is stopped regardless of how
             * many calls it made. Adding a second, invisible ceiling on top of
             * the deadline would mean a script that is doing exactly what it was
             * asked to do fails for a reason nobody wrote down.
             */
            void this.dispatchModel(message, {
              host: options.host,
              worker,
              signal: options.signal,
              record: recordCall,
            });
            return;

          case "done":
            value = message.value;
            finish();
            return;

          case "failed": {
            /*
             * A script killed by its own deadline reports a child-process error
             * instead of a timeout, and the host has to correct for that.
             *
             * The worker hands each synchronous child process the eval's
             * remaining budget, because `terminate()` cannot interrupt a thread
             * parked in a blocking syscall — that is the fix that makes
             * `execSync('sleep 300')` stop at 30 seconds at all. The side
             * effect is that the child dies with `ETIMEDOUT`, the script's own
             * catch reports it, and that `failed` message can reach the host
             * *before* the timer that was set for the same moment.
             *
             * Which one wins is a race. Measured over six identical runs, four
             * produced "The script ran longer than 1500ms and was stopped" and
             * two produced "spawnSync /bin/sh ETIMEDOUT (line 1)" — and the
             * second is actively misleading. It says a command failed, so the
             * model retries the command, which fails the same way, because the
             * budget was the problem and nothing in that message mentions it.
             *
             * So the host stops racing: if the deadline has passed, the
             * deadline is the answer, whatever the script managed to report on
             * its way out. A small window past the deadline rather than exactly
             * at it, because the timer may still be queued behind this message.
             */
            if (Date.now() >= deadlineAt - 50) {
              status = "timeout";
              failure = { name: "Error", message: statusMessage("timeout", limits) };
              finish();
              return;
            }
            /*
             * A failure does not get to overrule a verdict the host has already
             * reached.
             *
             * The host stops a run in three ways — the timer, the tool-call cap,
             * cancellation — and each of them terminates a worker that may be
             * mid-script. Terminating makes any `tools.*` promise the script is
             * parked on reject, the script's `await` throws uncaught, and the
             * worker posts a `failed` on its way out. That message races the
             * cleanup that caused it.
             *
             * Observed: test 9b, an unbounded loop with a tool-call cap. The cap
             * fires, `onLimit` sets `tool_call_limit` and terminates, and the
             * rejection of the in-flight tool call arrives right behind it —
             * turning a limit the model asked to be told about into a generic
             * `error`. It passed in isolation and failed in the full suite,
             * which is the shape of a race rather than of a broken assertion.
             *
             * The race is narrow and load-dependent, so it needed proving
             * rather than asserting: instrumenting this branch and running 24
             * caps under heavy contention caught it firing twice. Without the
             * guard those two runs report `error` — the original failure.
             *
             * The host's decision is the one that knows *why*; the worker only
             * knows that something threw. So the worker's report is kept only
             * when the host has not already spoken.
             */
            if (status !== "completed") {
              /*
               * The sentence is attached here rather than left to the `exit`
               * handler, because `finish()` resolves the run and the handler
               * may never get its turn — which produced a result with
               * `status: "tool_call_limit"` and no message at all. A status
               * without an explanation is the one thing this channel must never
               * emit: the model can act on "you reached your tool-call limit"
               * and can do nothing with a bare label.
               */
              if (!failure) {
                failure = { name: "Error", message: statusMessage(status, limits) };
              }
              finish();
              return;
            }
            status = "error";
            const line = lineFromStack(message.error.stack);
            failure = {
              name: message.error.name,
              /*
               * The line is appended to the message, not only carried in the
               * field beside it. The model reads the message; a position it
               * has to go looking for in a sibling key is a position it will
               * not use, and "boom" without a line means re-reading the whole
               * script to find which `boom` it was.
               */
              message: line === undefined ? message.error.message : `${message.error.message} (line ${line})`,
              ...(message.error.stack ? { stack: message.error.stack } : {}),
              ...(line !== undefined ? { line } : {}),
              ...(message.error.code ? { code: message.error.code } : {}),
            };
            if (message.error.tool) {
              toolError = {
                toolName: message.error.tool,
                code: message.error.code ?? "tool_error",
                message: message.error.message,
              };
            }
            finish();
            return;
          }
        }
      });

      worker.on("error", (error: Error & { code?: string }) => {
        /*
         * A worker `error` is the thread dying rather than the script throwing
         * — the script's own throw arrives as a `failed` message. The case that
         * matters is the heap ceiling, which Node reports here and which has to
         * be named as a memory limit rather than as a mystery crash, because
         * "your script used too much memory" is actionable and
         * "ERR_WORKER_OUT_OF_MEMORY" is not.
         */
        if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
          status = "memory";
          failure = {
            name: "RangeError",
            message: `The script exceeded its memory limit of ${Math.round(limits.memoryBytes / (1024 * 1024))} MB and was stopped.`,
          };
        } else if (status === "completed") {
          status = "error";
          failure = { name: error.name || "Error", message: error.message || String(error) };
        }
        finish();
      });

      worker.on("exit", () => {
        /*
         * Reached when the thread was terminated — timeout, cancellation, the
         * tool-call cap — since a clean finish has already resolved through
         * `done` or `failed`. `status` was set by whoever called terminate,
         * and this turns it into the message the model reads.
         */
        if (status === "completed" && !settled) {
          status = "error";
          failure = { name: "Error", message: "The script's worker exited before returning a result." };
        }
        if (!failure && status !== "completed") failure = { name: status === "cancelled" ? "AbortError" : "Error", message: statusMessage(status, limits) };
        finish();
      });
    });

    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortListener);
    void worker.terminate();
    this.worker = undefined;


    const { value: bounded, truncated, bytes } = boundResult(value, limits.maxResultBytes);
    /*
     * Said only when the *rewrite* could not find a value to return, not
     * whenever the value happens to be undefined. Those are different
     * situations: a script whose last statement is a `for` loop produced no
     * value and the model probably meant to end with one, while a script
     * ending in an expression that evaluated to `undefined` did exactly what
     * it said. Guessing from the source text confuses the two; `returnsValue`
     * is the analysis that already knows.
     */
    if (status === "completed" && !plan.returnsValue) {
      note = "The script produced no value. The result is the last expression — end with the value you want back, not with a declaration or a loop.";
    }

    return {
      status,
      value: status === "completed" ? bounded : undefined,
      truncated,
      resultBytes: bytes,
      console: consoleEntries,
      consoleTruncated,
      toolCalls,
      durationMs: Date.now() - started,
      ...(failure ? { error: failure } : {}),
      ...(toolError ? { toolError } : {}),
      ...(note ? { note } : {}),
    };
  }

  /**
   * Run one `tools.*` call and post the answer back.
   *
   * Deliberately not awaited by the message handler: several of these can be in
   * flight at once, which is what makes `Promise.all` inside the script real
   * concurrency rather than a queue wearing a promise's clothes. Ordering is
   * carried by the call id, so out-of-order completion is the normal case.
   */
  private async dispatchTool(
    message: { id: number; name: string; args: unknown },
    context: {
      host: CodeToolHost;
      limits: CodeRuntimeLimits;
      worker: Worker;
      signal: AbortSignal | undefined;
      count: () => number;
      record: (entry: CodeToolCallRecord) => void;
      onLimit: () => void;
    },
  ): Promise<void> {
    const index = context.count();
    if (index > context.limits.maxToolCalls) {
      context.worker.postMessage({
        type: "toolResult",
        id: message.id,
        ok: false,
        error: { code: "tool_call_limit", message: `This eval reached its limit of ${context.limits.maxToolCalls} tool calls.`, tool: message.name },
      });
      context.onLimit();
      return;
    }

    const started = Date.now();
    try {
      const outcome = await context.host.invoke({
        callId: `${message.id}`,
        name: message.name,
        args: message.args,
        signal: context.signal ?? new AbortController().signal,
      });

      /*
       * What the record calls the call, and what the script's rejection calls it
       * are deliberately different names.
       *
       * `message.name` is whatever the script typed — `read`, `grep`, `ls`. The
       * record is not for the script; it is the transcript row and the
       * trajectory entry, and it says which *tool ran*. Those two are the same
       * thing only when the model used a registry name. Recording `read` would
       * put a name in the audit trail that no tool has, and would make `eval`
       * the one call whose trace disagrees with the forty `file_view` rows
       * sitting next to it.
       *
       * The error message is the mirror image and keeps `message.name` for the
       * reason the bridge's own comment gives: a script that asked for
       * `tools.read` is being answered, and being told about `file_view` is
       * being told about a call it did not make.
       */
      const recorded = outcome.resolvedName ?? message.name;

      if (outcome.ok) {
        const output = boundResult(outcome.output, context.limits.maxToolResultBytes);
        context.record({ name: recorded, ok: true, durationMs: outcome.durationMs });
        context.worker.postMessage({ type: "toolResult", id: message.id, ok: true, output: output.value });
      } else {
        context.record({ name: recorded, ok: false, durationMs: outcome.durationMs, error: outcome.error });
        context.worker.postMessage({
          type: "toolResult",
          id: message.id,
          ok: false,
          error: { ...outcome.error, tool: message.name },
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      context.record({ name: message.name, ok: false, durationMs: Date.now() - started, error: { code: "bridge_error", message: reason } });
      /*
       * The worker is blocked on this promise, so a throw here has to become a
       * rejection over there or the script hangs until the outer timeout. Every
       * exit from this function posts exactly one result.
       */
      try {
        context.worker.postMessage({ type: "toolResult", id: message.id, ok: false, error: { code: "bridge_error", message: reason, tool: message.name } });
      } catch {
        // The worker is already gone; nothing is waiting for this answer.
      }
    }
  }

  /**
   * Run one `models.*` call and post the answer back.
   *
   * Not awaited by the message handler, for the same reason `dispatchTool` is
   * not: a script that fans out over several models gets real concurrency, and
   * the call id is what keeps the answers matched to their promises.
   *
   * There is no counter and no limit here. The deadline bounds the whole script,
   * which is the honest bound — a script making a thousand model calls is doing
   * something someone asked for, and stopping it partway through on a rule the
   * script was never told about produces a failure nobody can explain.
   */
  private async dispatchModel(
    message: { id: number; args: unknown },
    context: {
      host: CodeToolHost;
      worker: Worker;
      signal: AbortSignal | undefined;
      record: (entry: CodeToolCallRecord) => void;
    },
  ): Promise<void> {
    const started = Date.now();
    const args = (message.args ?? {}) as {
      model?: unknown;
      messages?: unknown;
      system?: unknown;
    };

    /*
     * Validated here rather than in the worker so the script gets a real error
     * sentence instead of a shape mismatch deep inside a provider SDK. The
     * worker is JavaScript with no schema library, and the host is the layer
     * that already knows what a model call takes.
     */
    const messages = Array.isArray(args.messages)
      ? args.messages.filter(
          (entry): entry is { role: "system" | "user" | "assistant"; content: string } =>
            Boolean(entry)
            && typeof entry === "object"
            && typeof (entry as { content?: unknown }).content === "string"
            && ["system", "user", "assistant"].includes(String((entry as { role?: unknown }).role)),
        )
      : [];

    if (messages.length === 0) {
      const error = {
        code: "invalid_argument",
        message: "models.call requires `messages`: an array of { role, content }.",
      };
      this.recordModelFailure(context, message.id, started, error);
      return;
    }

    if (!context.host.callModel) {
      const error = { code: "MODEL_NOT_EXPOSED", message: "This run has no model surface." };
      this.recordModelFailure(context, message.id, started, error);
      return;
    }

    try {
      const outcome = await context.host.callModel({
        callId: `${message.id}`,
        ...(typeof args.model === "string" ? { model: args.model } : {}),
        messages,
        ...(typeof args.system === "string" ? { system: args.system } : {}),
        signal: context.signal ?? new AbortController().signal,
      });

      /*
       * The ledger names the model that ran, not the alias the script used —
       * the same rule the tool path follows, and for the same reason: the
       * transcript is a record of what happened, and `models.call({ model: "fast" })`
       * is not a model anybody can look up.
       */
      const label = outcome.ok ? outcome.model : (outcome.model ?? String(args.model ?? "model"));

      if (outcome.ok) {
        context.record({
          name: label,
          ok: true,
          durationMs: outcome.durationMs,
          ...(outcome.usage ? { modelUsage: outcome.usage } : {}),
        } as CodeToolCallRecord);
        context.worker.postMessage({
          type: "modelResult",
          id: message.id,
          ok: true,
          text: outcome.text,
        });
      } else {
        context.record({ name: label, ok: false, durationMs: outcome.durationMs, error: outcome.error });
        context.worker.postMessage({
          type: "modelResult",
          id: message.id,
          ok: false,
          error: outcome.error,
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.recordModelFailure(context, message.id, started, { code: "model_error", message: reason });
    }
  }

  /**
   * Report a model call that never reached the provider.
   *
   * Every exit from `dispatchModel` posts exactly one result, because the worker
   * is blocked on the promise: a path that returns without posting hangs the
   * script until the deadline, which is the failure mode that reads as "eval is
   * broken" rather than "your model call was rejected".
   */
  private recordModelFailure(
    context: { worker: Worker; record: (entry: CodeToolCallRecord) => void },
    id: number,
    started: number,
    error: { code: string; message: string },
  ): void {
    context.record({ name: "model", ok: false, durationMs: Date.now() - started, error });
    try {
      context.worker.postMessage({ type: "modelResult", id, ok: false, error });
    } catch {
      // The worker is already gone; nothing is waiting for this answer.
    }
  }
}

/**
 * Decide how to get a value out of the model's last statement.
 *
 * The tool's central promise is that the final expression is the result, with
 * no `return` and no `console.log`. Delivering that means rewriting the source
 * so the last statement's value is returned — and doing it without ever
 * changing what the script *does*.
 *
 * `transform.ts` owns the search and is shared with the previous runtime; the
 * only thing supplied here is the verifier, which is V8 rather than QuickJS.
 * That is the whole point of the callback: a candidate rewrite is used only if
 * the engine that will run it agrees it parses, so a mis-read of the source is
 * rejected at this step instead of running as something the model did not
 * write. When every candidate is rejected the script is wrapped unchanged and
 * `returnsValue` is false — a script that genuinely produces no value, run
 * exactly as written.
 */
/**
 * Stop the processes an eval left behind.
 *
 * SIGTERM, a short grace window, then SIGKILL for the holdouts — the same
 * escalation `BackgroundProcessManager.terminateAll` uses, kept here rather than
 * shared because the lifetime is different. Those are children of a `bash` call
 * that the executor tracks across a whole run; these are children of a single
 * eval, and the run they belong to is already over by the time this is called.
 *
 * `treeKill` rather than `process.kill` because a child may itself have
 * children: `spawn('npm', ['run', 'dev'])` gives a shell that gives a server,
 * and killing only the shell would leave the port held.
 *
 * The liveness check is not decoration. By the time this runs the process may
 * have exited normally and its pid been handed to something unrelated, and
 * `kill -9` on that is Reaper damaging a process it has never met. `signal 0`
 * is the portable way to ask "does this still exist".
 */
async function reapChildren(pids: number[]): Promise<void> {
  const { default: treeKill } = await import("tree-kill");
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const kill = (pid: number, signal: NodeJS.Signals) =>
    new Promise<void>((resolve) => {
      try {
        treeKill(pid, signal, () => resolve());
      } catch {
        // Already gone, or not ours. Either way there is nothing to do.
        resolve();
      }
    });

  const living = pids.filter(alive);
  if (living.length === 0) return;
  await Promise.all(living.map((pid) => kill(pid, "SIGTERM")));
  await new Promise((resolve) => setTimeout(resolve, 750));
  const stubborn = living.filter(alive);
  if (stubborn.length === 0) return;
  await Promise.all(stubborn.map((pid) => kill(pid, "SIGKILL")));
}

function planCompletion(source: string): { source: string; returnsValue: boolean } {
  const verify = (candidate: string): boolean => {
    try {
      new Function(candidate);
      return true;
    } catch {
      return false;
    }
  };

  /*
   * Each candidate is verified in the exact form the worker will compile —
   * `return <wrapped>;` — not in some equivalent-looking shape. The first
   * version verified a differently-nested wrapper than it ran, which let
   * candidates pass here and behave differently there.
   */
  const split = splitTrailingExpression(source, (candidate) => verify(`return ${wrapWithoutTail(candidate)};`));
  if (split) return { source: wrapWithTail(split.prefix, split.tail), returnsValue: true };

  /*
   * The awkward shape: a script ending in `try { … } catch { … }`, where the
   * value is produced inside a block and there is no trailing expression to
   * lift. `liftTrailingBlocks` puts the `return` inside each branch instead.
   * Verified wrapped, because the rewritten text is a fragment containing
   * `await` and `return` that cannot compile on its own.
   */
  const lifted = liftTrailingBlocks(source, (candidate) => verify(`return ${wrapWithoutTail(candidate)};`));
  if (lifted) return { source: wrapWithoutTail(lifted), returnsValue: true };
  return { source: wrapWithoutTail(source), returnsValue: false };
}

/** The sentence that explains a non-`completed` status to the model. */
function statusMessage(status: CodeRuntimeStatus, limits: CodeRuntimeLimits): string {
  switch (status) {
    case "timeout":
      return `The script ran longer than ${limits.timeoutMs}ms and was stopped.`;
    case "cancelled":
      return "The script was cancelled.";
    case "memory":
      return `The script exceeded its memory limit of ${Math.round(limits.memoryBytes / (1024 * 1024))} MB and was stopped.`;
    case "tool_call_limit":
      return `The script reached its limit of ${limits.maxToolCalls} tool calls and was stopped.`;
    default:
      return "The script did not finish.";
  }
}

/**
 * Keep a value under a byte budget.
 *
 * The point of Code Mode is that a large intermediate result stays inside the
 * script, so the one thing that must not happen is the *report* carrying it
 * back. Oversized values become a preview that says what was dropped, which is
 * information the model can act on; silently returning half an object is not.
 */
function boundResult(value: unknown, maxBytes: number): { value: unknown; truncated: boolean; bytes: number } {
  if (value === undefined) return { value: undefined, truncated: false, bytes: 0 };
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    return { value: String(value), truncated: false, bytes: 0 };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= maxBytes) return { value, truncated: false, bytes };
  return {
    value: `[result too large: ${bytes} bytes, limit ${maxBytes}. Return a summary instead — a count, a filtered list, or the few fields you need.] ${serialized.slice(0, 2000)}…`,
    truncated: true,
    bytes,
  };
}

/** The line in the model's own script, dug out of V8's stack trace. */
function lineFromStack(stack: string | undefined): number | undefined {
  if (!stack) return undefined;
  const match = /codemode\.js:(\d+):/.exec(stack);
  if (!match?.[1]) return undefined;
  const line = Number(match[1]);
  /*
   * Reported as-is, with no arithmetic.
   *
   * The `- 1` that used to be here was carried over from the QuickJS runtime,
   * where the wrapper's opening brace sat on its own line and pushed the
   * model's first line down. `WRAP_OPEN` deliberately does not end in a
   * newline for exactly that reason, and `vm.compileFunction` adds no line of
   * its own — so a throw on line 1 really is line 1, and subtracting one
   * would send the model to a line it did not write.
   */
  return Number.isFinite(line) && line > 0 ? line : undefined;
}
