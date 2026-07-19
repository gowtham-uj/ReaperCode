import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { redactSecrets } from "./redaction.js";
import { defaultRotationPolicy, planRotation, type RotationPolicy } from "./rotation.js";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

export interface JsonlStorageOptions {
  workspaceRoot: string;
  filename: string;
  runId?: string;
  maxBytes?: number;
  /**
   * Phase T3.13: full rotation policy. When supplied, overrides
   * the size cap with the structured policy (size + age +
   * multi-rotation). When omitted, falls back to `maxBytes` with
   * the legacy single-rotation behavior for backward compatibility.
   */
  rotationPolicy?: RotationPolicy;
  devMode?: boolean;
  sampleRate?: number;
}

export class JsonlStorage {
  private readonly filePath: string;
  private readonly rawFilePath: string;
  private readonly maxBytes: number;
  private readonly rotationPolicy: RotationPolicy;
  private readonly devMode: boolean;
  private readonly sampleRate: number;

  private lastEntryHash: string | undefined;
  private currentOffset = 0;
  private currentMtimeMs = 0;
  // `chainHealthy` — false when initializeStateIfNeeded observed a
  // malformed tail but chose to fall back to "root" anyway so writes
  // don't stall. A subsequent audit entry ("chain_unhealthy") is
  // emitted once so the operator knows the in-memory chain forked and
  // the next batch's `prev_hash` will no longer match what an
  // independent reader sees. This trades guaranteed chain integrity
  // (which we already lacked: see comment on `append`) for at least a
  // visible-to-trajectory signal.
  private chainHealthy = true;
  private initializingPromise: Promise<void> | undefined;
  // Per-instance write chain. Every append/appendBatch is queued onto
  // this promise so concurrent callers serialise on the same chain and
  // the in-memory `lastEntryHash` / `currentOffset` updates land in
  // arrival order. Without this, two near-simultaneous appends read the
  // same prev_hash, both write the same chain link, and the audit log
  // forks into two branches that never reconcile (the bug that
  // produced two same-prev_hash audit entries ~0.8 ms apart in
  // production).
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: JsonlStorageOptions) {
    const scratchpad = getReaperScratchpadPaths(options.workspaceRoot);
    const logsRoot = options.runId ? path.join(scratchpad.runs, options.runId, "logs") : scratchpad.logs;
    this.filePath = path.join(logsRoot, options.filename);
    this.rawFilePath = path.join(logsRoot, `raw_${options.filename}`);
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    this.rotationPolicy = options.rotationPolicy ?? {
      ...defaultRotationPolicy(),
      maxBytes: this.maxBytes,
    };
    this.devMode = options.devMode ?? false;
    this.sampleRate = options.sampleRate ?? 1.0;
  }

  private async initializeStateIfNeeded(): Promise<void> {
    if (this.lastEntryHash !== undefined) {
      return;
    }

    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    this.initializingPromise = (async () => {
      try {
        const existing = await readFile(this.filePath, "utf8");
        this.currentOffset = Buffer.byteLength(existing, "utf8");
        this.lastEntryHash = this.readLastHash(existing);
        try {
          const s = await stat(this.filePath);
          this.currentMtimeMs = s.mtimeMs;
        } catch {
          this.currentMtimeMs = Date.now();
        }
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno?.code === "ENOENT") {
          // Fresh log file — chainHealthy stays true.
          this.currentOffset = 0;
          this.lastEntryHash = "root";
          this.currentMtimeMs = Date.now();
          return;
        }
        // Other read errors (EACCES, EIO): chain is unsynced. Emit a
        // trajectory-shaped warning via stderr so it's visible. The
        // append path will start a "root" chain as a recovery fallback
        // — see `chainUnhealthyDetectedOnce`.
        this.chainHealthy = false;
        console.warn(`[reaper][storage] failed to read existing trajectory file '${this.filePath}': ${errno?.code ?? "UNKNOWN"} ${error instanceof Error ? error.message : String(error)} — starting a new root chain`);
        this.currentOffset = 0;
        this.lastEntryHash = "root";
        this.currentMtimeMs = Date.now();
      }
    })();

    return this.initializingPromise;
  }

  private shouldSample(traceId?: string): boolean {
    if (this.sampleRate >= 1.0) return true;
    if (this.sampleRate <= 0.0) return false;
    if (!traceId) return Math.random() < this.sampleRate;
    
    // Simple deterministic hash of trace_id for consistent sampling
    let hash = 0;
    for (let i = 0; i < traceId.length; i++) {
      hash = Math.imul(31, hash) + traceId.charCodeAt(i) | 0;
    }
    const normalized = Math.abs(hash) / 2147483647; // Max 32-bit int
    return normalized < this.sampleRate;
  }

  async append(entry: unknown): Promise<{ offset: number; serialized: string } | null> {
    const next = this.writeChain.then(() => this.appendInternal(entry));
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async appendInternal(entry: unknown): Promise<{ offset: number; serialized: string } | null> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    const payloadRaw = entry as Record<string, unknown>;
    const traceId = typeof payloadRaw.trace_id === "string" ? payloadRaw.trace_id : undefined;

    if (!this.devMode && !this.shouldSample(traceId)) {
      return null;
    }

    await this.initializeStateIfNeeded();
    await this.rotateIfNeeded();

    const offset = this.currentOffset;
    const lastHash = this.lastEntryHash || "root";

    const payload = redactSecrets(entry) as Record<string, unknown>;
    const withPrev = { ...payload, prev_hash: lastHash };
    const entryHash = createHash("sha256").update(JSON.stringify(withPrev)).digest("hex");
    const serialized = `${JSON.stringify({ ...withPrev, entry_hash: entryHash })}\n`;
    await appendFile(this.filePath, serialized, "utf8");

    this.lastEntryHash = entryHash;
    this.currentOffset += Buffer.byteLength(serialized, "utf8");
    this.currentMtimeMs = Date.now();

    if (this.devMode) {
      await appendFile(this.rawFilePath, `${JSON.stringify(entry)}\n`, "utf8");
    }

    return { offset, serialized };
  }

  /**
   * Batched append: serialize + append many entries in a single
   * `appendFile` syscall. Returns the offset for each entry so the
   * caller can write per-entry index entries. Used by
   * `TrajectoryLogger.writeBatch` to avoid one fs round-trip per
   * event during bursty phases (tool dispatch produces 3-4 envelopes).
   */
  async appendBatch(entries: unknown[]): Promise<Array<{ offset: number; serialized: string } | null>> {
    const next = this.writeChain.then(() => this.appendBatchInternal(entries));
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async appendBatchInternal(entries: unknown[]): Promise<Array<{ offset: number; serialized: string } | null>> {
    if (entries.length === 0) return [];
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.initializeStateIfNeeded();
    await this.rotateIfNeeded();

    const lines: string[] = [];
    const out: Array<{ offset: number; serialized: string } | null> = [];
    for (const entry of entries) {
      const payloadRaw = entry as Record<string, unknown>;
      const traceId = typeof payloadRaw.trace_id === "string" ? payloadRaw.trace_id : undefined;
      if (!this.devMode && !this.shouldSample(traceId)) {
        out.push(null);
        continue;
      }
      const offset = this.currentOffset;
      const lastHash = this.lastEntryHash || "root";
      const payload = redactSecrets(entry) as Record<string, unknown>;
      const withPrev = { ...payload, prev_hash: lastHash };
      const entryHash = createHash("sha256").update(JSON.stringify(withPrev)).digest("hex");
      const serialized = `${JSON.stringify({ ...withPrev, entry_hash: entryHash })}\n`;
      lines.push(serialized);
      this.lastEntryHash = entryHash;
      this.currentOffset += Buffer.byteLength(serialized, "utf8");
      this.currentMtimeMs = Date.now();
      out.push({ offset, serialized });
    }
    if (lines.length > 0) {
      await appendFile(this.filePath, lines.join(""), "utf8");
      this.currentMtimeMs = Date.now();
      if (this.devMode) {
        const raws = entries
          .map((e) => `${JSON.stringify(e)}\n`)
          .join("");
        await appendFile(this.rawFilePath, raws, "utf8");
      }
    }
    return out;
  }

  get path() {
    return this.filePath;
  }

  /**
   * Has this storage observed a chain-healthy state since the last
   * `initializeStateIfNeeded`? Returns `true` on fresh files and on
   * a clean reload from a valid tail. Returns `false` when the
   * reloaded tail was missing `entry_hash`, had unparseable JSON, or
   * could not be read for filesystem reasons — the in-memory chain
   * forked from the on-disk one. Callers should emit a `chain_unhealthy`
   * trajectory event on the next append so the operator can
   * review-repair the file.
   */
  isChainHealthy(): boolean {
    return this.chainHealthy;
  }


  /**
   * Phase T3.13: structured rotation policy. Replaces the legacy
   * single-rename path. When size or age cap is hit, the active file
   * is renamed to `<file>.1.bak`, existing rotated files are
   * bumped to `.N+1.bak`, and anything past `maxRotatedFiles` is
   * deleted.
   *
   * Best-effort: if any fs op fails, we swallow the error so a
   * partial rotation doesn't break subsequent appends. The active
   * file may end up with the old name in that case — visible to
   * operators via the unchanged file path.
   */
  private async rotateIfNeeded(): Promise<void> {
    const plan = planRotation({
      activeFilePath: this.filePath,
      currentSizeBytes: this.currentOffset,
      currentMtimeMs: this.currentMtimeMs || Date.now(),
      nowMs: Date.now(),
      policy: this.rotationPolicy,
      existingRotatedFiles: await this.listRotatedFiles(),
    });
    if (!plan) return;
    try {
      // Bump existing rotations first (highest index first) so a
      // failed bump of an older file doesn't shadow the new one.
      for (const { from, to } of plan.filesToRename) {
        if (from === to) continue;
        await rename(from, to);
      }
      // Delete files past the keep window.
      for (const dead of plan.filesToDelete) {
        await unlink(dead).catch(() => undefined);
      }
      // Move the active file to .1.bak and recreate empty.
      await rename(this.filePath, plan.newRotationTarget);
      await writeFile(this.filePath, "", "utf8");
      this.currentOffset = 0;
      this.lastEntryHash = "root";
      this.currentMtimeMs = Date.now();
    } catch {
      // Best-effort — see method docstring.
    }
  }

  /**
   * List existing rotated files for the active file path. Returns
   * full paths matching `<filePath>.<N>.bak`. Reads the directory
   * non-recursively; best-effort (returns empty on error).
   */
  private async listRotatedFiles(): Promise<string[]> {
    try {
      const dir = path.dirname(this.filePath);
      const base = path.basename(this.filePath);
      const entries = await readdir(dir);
      const pattern = new RegExp(`^${escapeRegExp(base)}\\.(\\d+)\\.bak$`);
      const matched: string[] = [];
      for (const entry of entries) {
        if (pattern.test(entry)) {
          matched.push(path.join(dir, entry));
        }
      }
      return matched;
    } catch {
      return [];
    }
  }

  private readLastHash(existing: string): string {
    const lines = existing.trimEnd().split("\n").filter(Boolean);
    if (lines.length === 0) {
      return "root";
    }

    try {
      const lastEntry = JSON.parse(lines.at(-1) ?? "{}") as { entry_hash?: unknown };
      if (typeof lastEntry.entry_hash === "string" && lastEntry.entry_hash.length > 0) {
        return lastEntry.entry_hash;
      }
    } catch (error) {
      // The last line is unparseable. Returning "root" here would
      // silently fork the chain — the corrupted tail would be followed
      // by a brand-new root-anchored chain that never reconciles with
      // the valid prefix. We still proceed (so the agent isn't blocked)
      // but flip `chainHealthy=false` so a `chain_unhealthy` audit
      // event can be emitted on the next append.
      const message = error instanceof Error ? error.message : String(error);
      this.chainHealthy = false;
      console.warn(`[reaper][storage] trajectory tail is malformed: ${message}; restarting chain at root and will emit chain_unhealthy on next append`);
      return "root";
    }
    // Last line had no `entry_hash`. Same fork risk — mark unhealthy.
    this.chainHealthy = false;
    console.warn(`[reaper][storage] trajectory tail lacks entry_hash field; restarting chain at root and will emit chain_unhealthy on next append`);
    return "root";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
