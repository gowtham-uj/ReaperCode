/**
 * Cleanup Registry: global LIFO registry for graceful shutdown resources.
 * Pattern borrowed from cc-haha's cleanupRegistry.ts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type CleanupFn = () => Promise<void>;

const registry = new Set<CleanupFn>();
let activeRunDir: string | undefined;
let handlersInstalled = false;

export function registerCleanup(fn: CleanupFn): () => void {
  registry.add(fn);
  return () => {
    registry.delete(fn);
  };
}

export async function runCleanupFunctions(): Promise<void> {
  const entries = Array.from(registry);
  registry.clear();
  // Drain in LIFO order
  for (let i = entries.length - 1; i >= 0; i--) {
    try {
      await entries[i]!();
    } catch {
      // Individual cleanup failures must not stop the chain
    }
  }
}

export function getRegisteredCleanupCount(): number {
  return registry.size;
}

export function clearCleanupRegistry(): void {
  registry.clear();
}

export function setActiveRunDir(runDir: string | undefined): void {
  activeRunDir = runDir;
}

export function getActiveRunDir(): string | undefined {
  return activeRunDir;
}

export function installCrashHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.on("uncaughtException", async (error) => {
    console.error("[reaper] uncaughtException:", error);
    await writeCrashResult(error, "uncaughtException");
    await runCleanupFunctions();
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    console.error("[reaper] unhandledRejection:", reason);
    const error = reason instanceof Error ? reason : new Error(String(reason));
    await writeCrashResult(error, "unhandledRejection");
    await runCleanupFunctions();
    process.exit(1);
  });

  // Signal handlers: SIGTERM/SIGINT/SIGHUP leave orphan run dirs with
  // no result.json unless we synthesize one. Without these, the next
  // orphan-reap scan picks up a half-written run dir and the user has
  // no record of why their run died.
  const onSignal = (signal: NodeJS.Signals): void => {
    void handleSignal(signal);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", onSignal);
}

async function handleSignal(signal: NodeJS.Signals): Promise<void> {
  // Avoid recursion if a signal fires during shutdown.
  try {
    process.removeAllListeners(signal);
  } catch {
    // ignore
  }
  const error = new Error(`received ${signal}`);
  error.name = "SignalInterruption";
  await writeCrashResult(error, signal);
  await runCleanupFunctions();
  // 128 + conventional signal number so shell sees the right code.
  const code = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129;
  process.exit(code);
}

async function writeCrashResult(error: Error, cause: string): Promise<void> {
  if (!activeRunDir) return;
  try {
    await mkdir(activeRunDir, { recursive: true });
    await writeFile(
      path.join(activeRunDir, "result.json"),
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
    // Best-effort crash write
  }
}
