/**
 * Orphan-reap wire-up: at the start of every Reaper run, find the
 * previous run's `processes.json` manifest (via `latest-run.json`
 * pointer) and SIGTERM/SIGKILL any children the OS still records
 * there. This is the safety net for "Reaper crashed mid-run and left
 * a `npm run dev` orphan behind" scenarios.
 *
 * Design notes:
 *
 *  - Discovery is via `<scratchpadRoot>/latest-run.json`, not by
 *    listing the runs dir. The pointer is already maintained by
 *    `writeLatestRunPointer` so we don't need to add a new file or
 *    a "second-most-recent" selection heuristic.
 *
 *  - Read is synchronous (`readFileSync`) so we can do it BEFORE
 *    `writeLatestRunPointer(this)` overwrites the pointer. Once
 *    we've read the old pointer, the rest of the work is async and
 *    parallel-safe with the other startup writes.
 *
 *  - The actual reap is delegated to
 *    `BackgroundProcessManager.reapOrphansFromManifest` so all the
 *    pid-existence, SIGTERM-then-SIGKILL, and audit-log logic lives
 *    in one place.
 *
 *  - `REAPER_DISABLE_ORPHAN_REAP=1` skips the work entirely. Useful
 *    for tests that don't want surprise process kills, and for users
 *    who deliberately background long-lived watchers.
 *
 *  - We never throw. A reap failure must not block Reaper startup.
 *    Worst case: orphans leak, same as before this module existed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { BackgroundProcessManager } from "../tools/background-process-manager.js";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

export interface OrphanReapOutcome {
  status: "skipped" | "no-previous-run" | "manifest-missing" | "reaped";
  reason?: string;
  previousRunId?: string;
  reaped?: number;
  skipped?: number;
  missing?: number;
  /** Wall-clock ms spent in this helper. Mostly for tests. */
  durationMs?: number;
}

export interface OrphanReapOptions {
  /** Override the runs dir discovery. Tests use this. */
  scratchpadRoot?: string;
  /** Override the opt-out env name. Tests use this. */
  envVar?: string;
  /** Override the env read. Tests use this. */
  env?: NodeJS.ProcessEnv;
  /** Optional logger for the audit line. Defaults to a single console.warn. */
  logger?: (line: string) => void;
}

/**
 * Read the previous run pointer, find the manifest, and reap any
 * orphans. Returns a structured outcome rather than throwing.
 */
export async function reapOrphansFromPreviousRun(
  workspaceRoot: string,
  currentRunId: string,
  options: OrphanReapOptions = {},
): Promise<OrphanReapOutcome> {
  const startedAt = Date.now();
  const env = options.env ?? process.env;
  const envName = options.envVar ?? "REAPER_DISABLE_ORPHAN_REAP";
  const log =
    options.logger ??
    ((line: string) => {
      // console.warn is the right surface: the user wants to see this
      // if they're investigating a leaked child, but it shouldn't
      // flood stdout on the happy path (no orphans → no log line).
      console.warn(`[reaper] orphan-reap: ${line}`);
    });

  if (env[envName] === "1") {
    return { status: "skipped", reason: `${envName}=1`, durationMs: Date.now() - startedAt };
  }

  const scratchpadRoot =
    options.scratchpadRoot ?? getReaperScratchpadPaths(workspaceRoot).root;
  const pointerPath = path.join(scratchpadRoot, "latest-run.json");

  let previousRunId: string | undefined;
  let previousRunDir: string | undefined;
  let parseError: string | undefined;
  try {
    const raw = readFileSync(pointerPath, "utf8");
    const parsed = JSON.parse(raw) as { runId?: string; runDir?: string };
    if (typeof parsed.runId === "string" && typeof parsed.runDir === "string") {
      previousRunId = parsed.runId;
      previousRunDir = parsed.runDir;
    } else {
      parseError = "pointer missing runId or runDir fields";
    }
  } catch (error) {
    // Distinguish "no pointer" (legitimate first run) from "corrupt
    // pointer" (user needs to know). Without this distinction a
    // truncated latest-run.json silently skips the reap and leaks
    // orphans from the previous run indefinitely.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "no-previous-run", durationMs: Date.now() - startedAt };
    }
    parseError = error instanceof Error ? error.message : String(error);
    log(`latest-run.json at ${pointerPath} is unreadable: ${parseError}; falling back to mtime scan of .reaper/runs/*/processes.json`);
  }
  if (parseError) {
    return await fallbackReapFromRunsDir(scratchpadRoot, currentRunId, log, startedAt, parseError);
  }

  if (!previousRunDir || !previousRunId) {
    return { status: "no-previous-run", durationMs: Date.now() - startedAt };
  }

  if (previousRunId === currentRunId) {
    // Either the same run is being resumed (REAPER_RESUME_RUN_ID)
    // or the pointer hasn't moved yet (first-ever run). Nothing to
    // reap — any tracked children are still our own.
    return { status: "no-previous-run", durationMs: Date.now() - startedAt };
  }

  const manifestPath = path.join(previousRunDir, "processes.json");
  const currentRunDir = path.join(scratchpadRoot, "runs", currentRunId);
  const result = await BackgroundProcessManager.reapOrphansFromManifest(manifestPath, {
    logDir: currentRunDir,
  });

  const outcome: OrphanReapOutcome = {
    status:
      result.reaped + result.skipped + result.missing === 0
        ? "manifest-missing"
        : "reaped",
    previousRunId,
    reaped: result.reaped,
    skipped: result.skipped,
    missing: result.missing,
    durationMs: Date.now() - startedAt,
  };

  if (outcome.status === "reaped" && result.reaped > 0) {
    log(
      `reaped ${result.reaped} orphan process(es) from previous run ${previousRunId} ` +
        `(skipped=${result.skipped} missing=${result.missing} durationMs=${outcome.durationMs})`,
    );
  }

  return outcome;
}

/**
 * Fallback when latest-run.json is missing or unreadable: scan the
 * .reaper/runs directory for processes.json manifests by mtime and
 * reap the most recent previous run. This keeps orphan-reap working
 * when the pointer file is corrupt or was hand-edited.
 */
async function fallbackReapFromRunsDir(
  scratchpadRoot: string,
  currentRunId: string,
  log: (line: string) => void,
  startedAt: number,
  pointerError: string,
): Promise<OrphanReapOutcome> {
  const { readdirSync, statSync } = await import("node:fs");
  const runsRoot = path.join(scratchpadRoot, "runs");
  let entries: { runId: string; runDir: string; mtimeMs: number }[] = [];
  try {
    const names = readdirSync(runsRoot);
    for (const name of names) {
      if (name === currentRunId) continue;
      const manifestPath = path.join(runsRoot, name, "processes.json");
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(manifestPath).mtimeMs;
      } catch {
        continue;
      }
      entries.push({ runId: name, runDir: path.join(runsRoot, name), mtimeMs });
    }
  } catch (error) {
    log(`runs-dir scan failed: ${error instanceof Error ? error.message : String(error)}`);
    return { status: "no-previous-run", reason: pointerError, durationMs: Date.now() - startedAt };
  }
  if (entries.length === 0) {
    return { status: "no-previous-run", reason: pointerError, durationMs: Date.now() - startedAt };
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const mostRecent = entries[0]!;
  const manifestPath = path.join(mostRecent.runDir, "processes.json");
  const currentRunDir = path.join(runsRoot, currentRunId);
  const result = await BackgroundProcessManager.reapOrphansFromManifest(manifestPath, {
    logDir: currentRunDir,
  });
  log(`reaped ${result.reaped} orphan process(es) via runs-dir fallback from ${mostRecent.runId}`);
  return {
    status: result.reaped + result.skipped + result.missing === 0 ? "manifest-missing" : "reaped",
    reason: pointerError,
    previousRunId: mostRecent.runId,
    reaped: result.reaped,
    skipped: result.skipped,
    missing: result.missing,
    durationMs: Date.now() - startedAt,
  };
}
