/**
 * Cleanup registry with one LIFO scope per async Reaper run.
 *
 * Callers outside a managed run keep using the legacy process scope. Crash
 * handlers drain every live scope because an uncaught process error affects
 * all runs, while normal run completion drains only its own scope.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isReaperDevMode } from "./dev-mode.js";

export type CleanupFn = () => Promise<void>;

interface CleanupScope {
  registry: Set<CleanupFn>;
  runDir?: string;
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

/** Run work in an isolated cleanup scope and always drain it on exit. */
export async function runWithCleanupScope<T>(
  runDir: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const scope: CleanupScope = {
    registry: new Set<CleanupFn>(),
    ...(runDir ? { runDir } : {}),
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

  process.on("uncaughtException", async (error) => {
    console.error("[reaper] uncaughtException:", error);
    await writeCrashResults(error, "uncaughtException");
    await runAllCleanupFunctions();
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    console.error("[reaper] unhandledRejection:", reason);
    const error = reason instanceof Error ? reason : new Error(String(reason));
    await writeCrashResults(error, "unhandledRejection");
    await runAllCleanupFunctions();
    process.exit(1);
  });

  const onSignal = (signal: NodeJS.Signals): void => {
    void handleSignal(signal);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", onSignal);
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
