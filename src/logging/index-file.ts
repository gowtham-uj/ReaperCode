import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

export interface LogIndexEntry {
  event_id: string;
  offset: number;
}

/**
 * Per-file index for `.jsonl` log streams.
 *
 * The index is stored as a JSON array and is rewritten atomically
 * (tmp-file + rename) on every append so a crash never leaves a
 * partially-written index on disk. A per-instance promise chain
 * serialises concurrent `append()` callers so two simultaneous events
 * cannot read the same baseline, both push, and lose the slower
 * writer's entry — the previous behaviour that corrupted 137/161
 * offsets and dropped 29 events in production audit runs.
 *
 * Format compatibility: existing readers parse this file as a JSON
 * array. We preserve that shape. The atomic write path is the only
 * behavioural change.
 */
export class LogIndexFile {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string, filename: string, runId?: string) {
    const scratchpad = getReaperScratchpadPaths(workspaceRoot);
    this.filePath = path.join(runId ? path.join(scratchpad.runs, runId, "logs") : scratchpad.logs, filename);
  }

  /**
   * Append one entry to the index. Concurrent callers are serialised so
   * they observe each other's writes in arrival order. The on-disk file
   * is rewritten atomically via `writeFile(tmp); rename(tmp, target)`.
   */
  async append(entry: LogIndexEntry): Promise<void> {
    const next = this.writeChain.then(() => this.appendInternal(entry));
    // Swallow rejections in the chain so one failure doesn't poison
    // every subsequent append; surface the rejection to the immediate
    // caller instead.
    this.writeChain = next.catch(() => undefined);
    await next;
  }

  private async appendInternal(entry: LogIndexEntry): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const current = await this.readAllInternal();
    current.push(entry);
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now().toString(36)}`;
    await writeFile(tmpPath, JSON.stringify(current, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
  }

  async readAll(): Promise<LogIndexEntry[]> {
    return this.readAllInternal();
  }

  private async readAllInternal(): Promise<LogIndexEntry[]> {
    try {
      const text = await readFile(this.filePath, "utf8");
      // Discard any half-written `.tmp.*` file a crashed earlier
      // process left behind. The atomic rename inside `appendInternal`
      // means the canonical file is always valid JSON when present;
      // the cleanup below is purely defensive against a SIGKILL
      // between `writeFile` and `rename`.
      return JSON.parse(text) as LogIndexEntry[];
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      // Corrupt or truncated index: surface empty array (mirrors prior
      // behaviour) rather than throwing, so an index problem never
      // breaks an in-progress trajectory append.
      return [];
    }
  }

  get path() {
    return this.filePath;
  }
}
