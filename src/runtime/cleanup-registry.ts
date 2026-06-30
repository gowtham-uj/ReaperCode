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
    await writeCrashResult(error);
    await runCleanupFunctions();
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    console.error("[reaper] unhandledRejection:", reason);
    const error = reason instanceof Error ? reason : new Error(String(reason));
    await writeCrashResult(error);
    await runCleanupFunctions();
    process.exit(1);
  });
}

async function writeCrashResult(error: Error): Promise<void> {
  if (!activeRunDir) return;
  try {
    await mkdir(activeRunDir, { recursive: true });
    await writeFile(
      path.join(activeRunDir, "result.json"),
      JSON.stringify(
        {
          status: "crashed",
          crashedAt: new Date().toISOString(),
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
