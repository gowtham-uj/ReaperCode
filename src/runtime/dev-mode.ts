/**
 * Dev-mode gate for extra on-disk artifacts.
 *
 * Managed runs use AsyncLocalStorage so one dev-mode thread does not enable
 * extra logging for every other thread in the process. Legacy CLI callers can
 * still promote the process environment through promoteDevModeFromConfig().
 */

import { AsyncLocalStorage } from "node:async_hooks";

const devModeStorage = new AsyncLocalStorage<boolean>();

export function isReaperDevMode(): boolean {
  const scoped = devModeStorage.getStore();
  if (scoped !== undefined) return scoped;
  return process.env.REAPER_DEV === "1" || process.env.REAPER_DEV === "true";
}

/** Run work with the config's dev-mode setting isolated to this async tree. */
export function runWithReaperDevMode<T>(devMode: boolean | undefined, fn: () => T): T {
  const environmentEnabled = process.env.REAPER_DEV === "1" || process.env.REAPER_DEV === "true";
  return devModeStorage.run(environmentEnabled || Boolean(devMode), fn);
}

/** Promote config dev mode for legacy callers outside managed run scopes. */
export function promoteDevModeFromConfig(devMode: boolean | undefined): void {
  if (devMode && !isReaperDevMode()) {
    process.env.REAPER_DEV = "1";
  }
}
