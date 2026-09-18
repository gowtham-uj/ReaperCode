/**
 * Running one browser program inside the sandbox, and coming back with its value.
 *
 * The program is model-written Playwright. It runs in the same bubblewrap
 * namespace `eval` uses, in a worker with no browser connection, holding proxies
 * whose every call travels back over IPC to be replayed against this thread's
 * page. See `remote-page.ts` for why that arrangement and not a connection.
 *
 * This is the piece that owns the worker's lifetime for one step, which is where
 * the failure modes live. A program can finish, throw, hang, or ignore the
 * abort signal, and each of those has to end with the worker gone: it holds a
 * thread, and a leaked thread holds a warped bwrap child process. The `finally`
 * is not tidiness, it is the only thing that stops a step from leaking.
 *
 * ## What it returns
 *
 * The program's value, or an error. Deliberately not a receipt: the transaction
 * around the step already builds one from the page, and a second opinion about
 * "did it work" from inside the runner would disagree with it eventually.
 */

import { createWorkerTransport, type WorkerTransport, type WorkerMessage } from "../tools/code/transport.js";
import { CODE_MODE_WORKER_SOURCE } from "../tools/code/worker-source.js";
import { DEFAULT_CODE_RUNTIME_LIMITS } from "../tools/code/types.js";
import { wrapWithoutTail } from "../tools/code/transform.js";
import type { BrowserProgramHost } from "./browser-program.js";

export interface RunProgramOptions {
  /** The compiled program body: a complete async IIFE expression. */
  compiled: string;
  /** The host that answers the program's page calls. */
  host: BrowserProgramHost;
  /** The thread's workspace, which the sandbox confines the program to. */
  workspace: string;
  /** How long the program may run. */
  timeoutMs?: number | undefined;
  /** Cancels the program, for a turn that was stopped or timed out. */
  signal?: AbortSignal | undefined;
}

export interface ProgramOutcome {
  /** The program's value, when it produced one. */
  value: unknown;
  /** The error it threw, when it threw. Named so the tool can classify it. */
  error: { name: string; message: string; stack?: string | undefined } | undefined;
  /**
   * Whether the run was confined by bubblewrap.
   *
   * Reported rather than assumed, and surfaced to the model: a step that ran
   * unconfined is a fact about the environment, not a detail, because it is the
   * difference between a program that could read the filesystem and one that
   * could not.
   */
  sandboxed: boolean;
}

/**
 * Run a program in the sandbox and wait for its value.
 *
 * Every exit path terminates the worker. The four that matter:
 *
 *   - the program finishes, with or without a value
 *   - it throws; the error is the model's and is returned rather than rethrown
 *   - it exceeds the deadline; the worker is killed and the model told
 *   - the signal aborts; same, because a stopped turn must not keep a thread
 *
 * A transport that cannot start is not a program failure and is thrown, so the
 * caller can tell "your program is wrong" from "the sandbox is broken" — two
 * facts that want different things from the model.
 */
export async function runProgram(options: RunProgramOptions): Promise<ProgramOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CODE_RUNTIME_LIMITS.timeoutMs;

  const { transport, sandboxed } = await createWorkerTransport({
    workspaceRoot: options.workspace,
    request: {
      workerSource: CODE_MODE_WORKER_SOURCE,
      workerData: {
        compiled: options.compiled,
        workspace: options.workspace,
        tools: [],
        schemas: {},
        aliases: [],
        /*
         * The limits the worker enforces for itself. The deadline is enforced
         * here as well, and both are needed: this one stops a step from holding
         * the turn open, and the worker's own stops a runaway loop from
         * starving the thread before this ever fires.
         */
        limits: { maxConsoleBytes: DEFAULT_CODE_RUNTIME_LIMITS.maxConsoleBytes, timeoutMs, maxToolCalls: 0 },
        /*
         * The browser profile. `enabled` is what binds `page` and the rest into
         * the script's scope, and `roots` is where they resolve: handles the
         * host owns, not objects the worker could hold.
         */
        browser: { enabled: true, roots: options.host.roots() },
      },
      resourceLimits: {
        // Derived from the same limit the eval runtime uses, so a browser
        // program and a script are bounded identically rather than by a second
        // number someone has to remember to keep in step.
        maxOldGenerationSizeMb: Math.max(16, Math.floor(DEFAULT_CODE_RUNTIME_LIMITS.memoryBytes / (1024 * 1024))),
        maxYoungGenerationSizeMb: 32,
      },
      execArgv: [],
      env: {},
    },
  });

  try {
    return await new Promise<ProgramOutcome>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: ProgramOutcome | { failure: Error }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener("abort", onAbort);
        transport.terminate();
        if ("failure" in outcome) reject(outcome.failure);
        else resolve(outcome);
      };

      const timer = setTimeout(() => {
        /*
         * A timeout is the model's program running too long, which is
         * information rather than a fault. It comes back named so the receipt
         * can say the program was cut off and show the page as it was left.
         */
        finish({ value: undefined, error: { name: "ProgramTimeout", message: `the program was still running after ${timeoutMs}ms` }, sandboxed });
      }, timeoutMs);
      timer.unref?.();

      const onAbort = (): void => {
        finish({ value: undefined, error: { name: "AbortError", message: "the step was cancelled" }, sandboxed });
      };
      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      transport.onMessage((message: WorkerMessage) => {
        switch (message.type) {
          case "page":
            /*
             * One Playwright call from inside the sandbox. Answered on the same
             * channel it arrived on, and deliberately not counted against any
             * limit: a browsing program makes many small calls, and a cap on
             * them would fail a program that is doing exactly what it should.
             */
            void options.host
              .call(
                message.handle,
                message.path.map(([method, called, ...args]) => ({ method, args, called: called === 1 })),
              )
              .then((reply) => transport.postMessage({ type: "pageResult", id: message.id, reply }))
              .catch((error: unknown) =>
                transport.postMessage({
                  type: "pageResult",
                  id: message.id,
                  reply: { kind: "error", name: "BridgeError", message: error instanceof Error ? error.message : String(error) },
                }),
              );
            return;
          case "done":
            finish({ value: message.value, error: undefined, sandboxed });
            return;
          case "failed":
            finish({ value: undefined, error: message.error, sandboxed });
            return;
          default:
            /*
             * Console output and child-process reports have nowhere to go in
             * this profile: the model writes a program and reads its value, and
             * the receipt is the feedback. Swallow them rather than dropping
             * the frame, because a frame nobody handles is the failure the relay
             * is most exposed to.
             */
            return;
        }
      });

      transport.onError((error) => finish({ failure: error }));
      transport.onExit((code) => {
        finish({
          value: undefined,
          error: { name: "WorkerExit", message: `the program ended unexpectedly (exit ${code})` },
          sandboxed,
        });
      });
    });
  } finally {
    /*
     * Belt to the `finish` braces. Every path above already terminates, but a
     * throw from `postMessage` or from the promise machinery would otherwise
     * leave the worker running, and a leaked sandboxed worker is a leaked bwrap
     * process holding a mount namespace.
     */
    transport.terminate();
  }
}

/**
 * The program body the worker runs.
 *
 * A browser program is the same shape as an eval body, so the same wrapper is
 * what it needs. `wrapWithoutTail` is the one that returns the last expression's
 * value, which is how a program reads data out of a page.
 */
export function wrapProgram(code: string): string {
  return `(async () => {\n${wrapWithoutTail(code)}\n})()`;
}
