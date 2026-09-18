/**
 * Cleanup registry with one LIFO scope per async Reaper run.
 *
 * Callers outside a managed run keep using the legacy process scope. A crash
 * inside a run drains that run's scope and fails that run; only a failure that
 * belongs to no run is treated as a process-level fault. See
 * `installCrashHandlers` for why that distinction is load-bearing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isReaperDevMode } from "./dev-mode.js";

export type CleanupFn = () => Promise<void>;

interface CleanupScope {
  registry: Set<CleanupFn>;
  runDir?: string;
  /**
   * Called when a process-level fault is attributed to this run.
   *
   * The run is cancelled rather than the process being killed, which is the
   * whole point: the app-server hosts many threads in one process, and an
   * escaped error in one of them must not take the others down with it.
   */
  onFault?: (error: Error, cause: string) => void;
}

const cleanupStorage = new AsyncLocalStorage<CleanupScope>();
const legacyScope: CleanupScope = { registry: new Set<CleanupFn>() };
const activeScopes = new Set<CleanupScope>();
let handlersInstalled = false;

function currentScope(): CleanupScope {
  return cleanupStorage.getStore() ?? legacyScope;
}

async function drainScope(scope: CleanupScope): Promise<void> {
  const entries = Array.from(scope.registry);
  scope.registry.clear();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    try {
      await entries[index]!();
    } catch {
      // Individual cleanup failures must not stop the chain.
    }
  }
}

/**
 * Run work in an isolated cleanup scope and always drain it on exit.
 *
 * `onFault` is how a run opts into being cancelled instead of the process being
 * killed when an error escapes it. The app-server passes one; a CLI run does
 * not, and keeps the fail-fast behaviour that is right for a single-agent
 * process.
 */
export async function runWithCleanupScope<T>(
  runDir: string | undefined,
  fn: () => Promise<T>,
  options: { onFault?: (error: Error, cause: string) => void } = {},
): Promise<T> {
  const scope: CleanupScope = {
    registry: new Set<CleanupFn>(),
    ...(runDir ? { runDir } : {}),
    ...(options.onFault ? { onFault: options.onFault } : {}),
  };
  activeScopes.add(scope);
  try {
    return await cleanupStorage.run(scope, fn);
  } finally {
    await drainScope(scope);
    activeScopes.delete(scope);
  }
}

export function registerCleanup(fn: CleanupFn): () => void {
  const scope = currentScope();
  scope.registry.add(fn);
  return () => {
    scope.registry.delete(fn);
  };
}

/** Drain the active run scope, or the legacy scope outside a managed run. */
export async function runCleanupFunctions(): Promise<void> {
  await drainScope(currentScope());
}

/** Drain every live run plus the legacy scope after a process-level failure. */
export async function runAllCleanupFunctions(): Promise<void> {
  const scopes = new Set<CleanupScope>([legacyScope, ...activeScopes]);
  await Promise.all(Array.from(scopes, (scope) => drainScope(scope)));
}

export function getRegisteredCleanupCount(): number {
  return currentScope().registry.size;
}

export function clearCleanupRegistry(): void {
  currentScope().registry.clear();
}

export function setActiveRunDir(runDir: string | undefined): void {
  const scope = currentScope();
  if (runDir) scope.runDir = runDir;
  else delete scope.runDir;
}

export function getActiveRunDir(): string | undefined {
  return currentScope().runDir;
}

export function installCrashHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  /*
   * A failure inside a run cancels that run. It does not kill the process.
   *
   * This handler used to do `writeCrashResults` then `runAllCleanupFunctions`
   * then `process.exit(1)`, unconditionally, for both kinds of error. That is
   * correct for the CLI, where the process is one agent doing one thing and
   * limping on would be worse than stopping. It is wrong for the app-server,
   * which hosts every thread in a single process: an error that escapes one
   * thread's tool call took the whole server down, and with it every other
   * thread, the gateway and the UI. Measured on a live mission: a
   * `downloadAfter` call that timed out raised an unhandled rejection, the
   * server exited, the UI went to "reconnecting", and every thread vanished
   * from the sidebar while the browser and its ten tabs were untouched.
   *
   * The AsyncLocalStorage run scope is visible from these handlers, which is
   * what makes the attribution possible: an error raised by a promise created
   * inside a run is handled with that run's scope on the stack. So the rule is:
   *
   *   - a run scope is on the stack  -> cancel that run, keep the process alive
   *   - no run scope                 -> a genuine process fault, exit as before
   *
   * Only a scope that supplied `onFault` can be cancelled, and only the
   * app-server supplies one. A CLI run therefore keeps its fail-fast behaviour
   * exactly, and this change is invisible to it.
   */
  process.on("uncaughtException", (error) => {
    void handleFatalError(error, "uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    void handleFatalError(reason instanceof Error ? reason : new Error(String(reason)), "unhandledRejection");
  });

  const onSignal = (signal: NodeJS.Signals): void => {
    void handleSignal(signal);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", onSignal);
}

/**
 * Route an escaped error to the run that caused it, or end the process.
 *
 * The scope is read synchronously, before the first await, because
 * AsyncLocalStorage is only on the stack for the synchronous part of the
 * handler. Everything after that runs on a fresh microtask without it.
 */
function handleFatalError(error: Error, cause: string): Promise<void> {
  const scope = cleanupStorage.getStore();
  if (scope?.onFault) {
    /*
     * Attributed to a run. Report it, drain that run, and cancel it. The
     * process, the other threads and the gateway are all left alone.
     */
    console.error(`[reaper] ${cause} in a run; cancelling that run:`, error);
    try {
      scope.onFault(error, cause);
    } catch (nested) {
      // A fault handler that throws must not become the new crash.
      console.error("[reaper] the run's fault handler threw:", nested);
    }
    void (async () => {
      // Order matters: the crash result is keyed by the run dirs of the live
      // scopes, so this scope must still be registered when it is written.
      await writeCrashResults(error, cause).catch(() => undefined);
      await drainScope(scope).catch(() => undefined);
      activeScopes.delete(scope);
    })();
    return Promise.resolve();
  }
  /*
   * No run to blame: a genuine process-level fault, which is the only case
   * where the process ends. This is the path a CLI run and a corrupt handler
   * take, and it is deliberately the same as before.
   */
  console.error(`[reaper] ${cause}:`, error);
  return (async () => {
    await writeCrashResults(error, cause);
    await runAllCleanupFunctions();
    process.exit(1);
  })();
}

async function handleSignal(signal: NodeJS.Signals): Promise<void> {
  try {
    process.removeAllListeners(signal);
  } catch {
    // Ignore listener cleanup failures during shutdown.
  }
  const error = new Error(`received ${signal}`);
  error.name = "SignalInterruption";
  await writeCrashResults(error, signal);
  await runAllCleanupFunctions();
  const code = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129;
  process.exit(code);
}

async function writeCrashResults(error: Error, cause: string): Promise<void> {
  if (!isReaperDevMode()) return;
  const runDirs = new Set<string>();
  if (legacyScope.runDir) runDirs.add(legacyScope.runDir);
  for (const scope of activeScopes) {
    if (scope.runDir) runDirs.add(scope.runDir);
  }
  await Promise.all(Array.from(runDirs, (runDir) => writeCrashResult(runDir, error, cause)));
}

async function writeCrashResult(runDir: string, error: Error, cause: string): Promise<void> {
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "result.json"),
      JSON.stringify(
        {
          status: "crashed",
          crashedAt: new Date().toISOString(),
          cause,
          error: {
            name: error.name,
            message: error.message,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // Best-effort crash write.
  }
}
