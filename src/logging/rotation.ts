/**
 * Log rotation policy for JsonlStorage.
 *
 * Phase T3.13: trajectory logs grow unbounded on long sessions. The
 * existing `JsonlStorage.rotateIfNeeded` only renames once
 * (`<file>.<ts>.bak`), doesn't keep a history, and has no age policy.
 * This module owns the policy decisions:
 *
 *   - **Size cap**: when the active file exceeds `maxBytes`, rotate.
 *   - **Multi-rotation**: keep up to `maxRotatedFiles` of `<file>.<idx>.bak`,
 *     deleting the oldest.
 *   - **Age cap**: rotate when the active file's mtime is older than
 *     `maxAgeMs`, even if it's under the size cap. Catches idle / stale
 *     logs from prior runs that were never closed.
 *   - **Naming**: `<file>.1.bak` is the most recent rotation,
 *     `<file>.<N>.bak` the oldest. Mirrors logrotate(8) and nginx.
 *
 * Why separate from JsonlStorage? Two reasons:
 *
 *   1. The policy is data-driven (env vars, run-time config) — easier
 *      to test in isolation than to mock fs operations inside the
 *      storage class.
 *   2. The audit log uses the same shape; reuse is straightforward.
 *
 * The functions here are pure with respect to file paths — they take
 * the active file path and return the list of rotated paths to keep
 * / delete. The caller does the actual fs.rename / fs.unlink.
 */

export interface RotationPolicy {
  maxBytes: number;
  maxRotatedFiles: number;
  maxAgeMs: number;
}

/**
 * Default rotation policy. Overridable via env vars:
 *
 *   - `REAPER_LOG_MAX_BYTES` (default 100 MiB)
 *   - `REAPER_LOG_MAX_ROTATED_FILES` (default 5)
 *   - `REAPER_LOG_MAX_AGE_MS` (default 7 days)
 */
export function defaultRotationPolicy(): RotationPolicy {
  const maxBytes = readPositiveIntEnv("REAPER_LOG_MAX_BYTES", 100 * 1024 * 1024);
  const maxRotatedFiles = readPositiveIntEnv("REAPER_LOG_MAX_ROTATED_FILES", 5);
  const maxAgeMs = readPositiveIntEnv("REAPER_LOG_MAX_AGE_MS", 7 * 24 * 60 * 60 * 1000);
  return { maxBytes, maxRotatedFiles, maxAgeMs };
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Decide whether a rotation should fire, given the active file's
 * current size in bytes and its mtime (epoch ms). Returns the
 * reason for the rotation (or null when no rotation is needed).
 *
 * Exposed for tests; production callers should use `planRotation`.
 */
export function shouldRotate(
  currentSizeBytes: number,
  currentMtimeMs: number,
  nowMs: number,
  policy: RotationPolicy,
): RotationReason | null {
  if (currentSizeBytes >= policy.maxBytes) {
    return currentSizeBytes >= policy.maxBytes * 2 ? "size_double" : "size";
  }
  if (nowMs - currentMtimeMs >= policy.maxAgeMs) {
    return "age";
  }
  return null;
}

export type RotationReason = "size" | "size_double" | "age";

/**
 * Plan a rotation. Given the active file path, the current rotated
 * files on disk, current size, and current mtime, return the list of
 * files to delete (oldest first) and the new active-file rotation
 * target.
 *
 * The caller is responsible for:
 *   1. Renaming the active file to `nextRotatedPath`.
 *   2. Deleting `filesToDelete` in order (oldest first is fine; they
 *      are not in the keep set anyway).
 *   3. Recreating the active file (empty).
 *
 * Returns `null` when no rotation is needed.
 */
export function planRotation(input: {
  activeFilePath: string;
  currentSizeBytes: number;
  currentMtimeMs: number;
  nowMs: number;
  policy: RotationPolicy;
  /** Existing rotated files on disk, full paths. Order doesn't matter;
   *  the planner will sort them by index. */
  existingRotatedFiles: string[];
}): RotationPlan | null {
  const reason = shouldRotate(input.currentSizeBytes, input.currentMtimeMs, input.nowMs, input.policy);
  if (reason === null) return null;

  const keepCount = Math.max(1, input.policy.maxRotatedFiles);
  // Sort existing rotated files by their trailing index (1-based,
  // where `.1.bak` is most recent). Files without a parseable index
  // go to the end (treated as oldest).
  const indexed = input.existingRotatedFiles
    .map((p) => ({ path: p, index: parseRotationIndex(p) }))
    .sort((a, b) => {
      const ai = a.index ?? Number.POSITIVE_INFINITY;
      const bi = b.index ?? Number.POSITIVE_INFINITY;
      return bi - ai; // descending: highest index first
    });

  // The new rotation will land at index 1; existing `.1.bak` is
  // bumped to `.2.bak`, etc. Compute next index for each existing
  // file and the target for the new one.
  const nextActivePath = input.activeFilePath;

  // Bumped versions: existing `.N.bak` becomes `.N+1.bak`. After
  // bumping, we keep `keepCount` of the most-recent ones (indices
  // 1..keepCount) and delete the rest.
  const bumped = indexed.map((item) => ({
    from: item.path,
    to: item.index === undefined ? item.path : bumpPath(item.path, item.index + 1),
  }));

  const filesToDelete: string[] = [];
  const filesToRename: Array<{ from: string; to: string }> = [];

  // After bumping, the most recent keepCount indices stay.
  // Anything above keepCount is deleted.
  for (const { from, to, index } of bumped.map((b) => ({ ...b, index: parseRotationIndex(b.to) }))) {
    if (index !== undefined && index > keepCount) {
      filesToDelete.push(to);
    } else {
      filesToRename.push({ from, to });
    }
  }

  return {
    reason,
    nextActivePath,
    newRotationTarget: appendRotationSuffix(input.activeFilePath, 1),
    filesToDelete,
    filesToRename,
  };
}

export interface RotationPlan {
  reason: RotationReason;
  nextActivePath: string;
  /** The path the active file will be renamed TO. */
  newRotationTarget: string;
  filesToDelete: string[];
  filesToRename: Array<{ from: string; to: string }>;
}

/**
 * Parse the trailing rotation index from a path. Returns `undefined`
 * when the path doesn't match the `.N.bak` pattern.
 *
 * Examples:
 *   `/a/b/foo.1.bak` → 1
 *   `/a/b/foo.12.bak` → 12
 *   `/a/b/foo.bak` → undefined
 *   `/a/b/foo` → undefined
 */
export function parseRotationIndex(filePath: string): number | undefined {
  const base = filePath.split("/").pop() ?? filePath;
  const match = base.match(/\.(\d+)\.bak$/);
  if (!match) return undefined;
  const n = Number.parseInt(match[1]!, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build the path for the Nth rotation of `activeFilePath`.
 *
 * Example: appendRotationSuffix("/a/foo.jsonl", 1) → "/a/foo.jsonl.1.bak"
 */
export function appendRotationSuffix(activeFilePath: string, index: number): string {
  return `${activeFilePath}.${index}.bak`;
}

/**
 * Bump an existing rotated path's index by `delta` (typically +1).
 * If the input doesn't match the rotation pattern, returns it
 * unchanged.
 */
export function bumpPath(filePath: string, newIndex: number): string {
  const idx = parseRotationIndex(filePath);
  if (idx === undefined) return filePath;
  return appendRotationSuffix(filePath.replace(/\.\d+\.bak$/, ""), newIndex);
}
