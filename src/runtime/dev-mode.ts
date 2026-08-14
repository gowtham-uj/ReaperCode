/**
 * Dev-mode gate for extra on-disk artifacts.
 *
 * Core session logging (session.jsonl + conversation.md) is ALWAYS on.
 * Everything else — result/manifest/progress/metrics/observability dumps,
 * per-call model I/O, per-command process logs — is written only in dev
 * mode so production runs stay lean.
 *
 * Enable via:
 *   - env: REAPER_DEV=1 (or "true")
 *   - config: .reaper/config.json → logging.devMode: true
 *     (the engine promotes config devMode to the env flag at run start)
 */
export function isReaperDevMode(): boolean {
  return process.env.REAPER_DEV === "1" || process.env.REAPER_DEV === "true";
}

/** Promote a config-level devMode into the process env flag once per run. */
export function promoteDevModeFromConfig(devMode: boolean | undefined): void {
  if (devMode && !isReaperDevMode()) {
    process.env.REAPER_DEV = "1";
  }
}
