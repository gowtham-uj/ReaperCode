import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TrajectoryLogger } from "../logging/trajectory.js";
import { ShadowCheckpoint } from "./checkpoint.js";
import { MergeConflictError, WriteAheadLog } from "./wal.js";
import { getEngineTunables } from "../config/config-tunables.js";


export interface RecoverySessionOptions {
  workspaceRoot: string;
  runId: string;
  sessionId: string;
  traceId: string;
  logLevel: "info" | "debug" | "trace";
  trajectoryLogger?: TrajectoryLogger;
}

export class RecoverySession {
  readonly wal: WriteAheadLog;
  private readonly trajectoryLogger: TrajectoryLogger;
  private checkpoint?: ShadowCheckpoint;
  private barrierFlushed = false;

  constructor(private readonly options: RecoverySessionOptions) {
    this.wal = new WriteAheadLog(options.workspaceRoot);
    this.trajectoryLogger = options.trajectoryLogger ?? new TrajectoryLogger(options.workspaceRoot);
  }

  async ensureCheckpoint(): Promise<void> {
    if (this.checkpoint) {
      return;
    }
    try {
      this.checkpoint = await ShadowCheckpoint.create(this.options.workspaceRoot);
    } catch (error) {
      // Plain directories and freshly initialized git repositories have no
      // restorable HEAD. That should not block normal file writes; the WAL can
      // still roll back unflushed writes inside the current session.
      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: this.options.runId,
        session_id: this.options.sessionId,
        trace_id: this.options.traceId,
        timestamp: new Date().toISOString(),
        log_schema_version: 1,
        kind: "recovery_summary",
        level: this.options.logLevel,
        recovery_type: "retry",
        cause: error instanceof Error ? error.message : String(error),
        outcome: "success",
      });
    }
  }

  async flushFinal(): Promise<{ written: number; deleted: number }> {
    try {
      return await this.wal.flush();
    } catch (error) {
      if (error instanceof MergeConflictError) {
        // Report the actual outcome, not a hard-coded "success". The
        // previous code wrote outcome: "success" while re-throwing a
        // real merge conflict, so downstream consumers reading the
        // trajectory would think the workspace was safely recovered
        // when it wasn't.
        await this.trajectoryLogger.write({
          event_id: randomUUID(),
          run_id: this.options.runId,
          session_id: this.options.sessionId,
          trace_id: this.options.traceId,
          timestamp: new Date().toISOString(),
          log_schema_version: 1,
          kind: "recovery_summary",
          level: this.options.logLevel,
          recovery_type: "wal_rollback",
          cause: error.message,
          outcome: "merge_conflict",
        });
      }
      throw error;
    }
  }

  async flushForBarrier(): Promise<{ written: number; deleted: number }> {
    const result = await this.flushFinal();
    this.barrierFlushed = true;
    return result;
  }

  async rollback(cause: string): Promise<void> {
    this.wal.rollback();
    await this.trajectoryLogger.write({
      event_id: randomUUID(),
      run_id: this.options.runId,
      session_id: this.options.sessionId,
      trace_id: this.options.traceId,
      timestamp: new Date().toISOString(),
      log_schema_version: 1,
      kind: "recovery_summary",
      level: this.options.logLevel,
      recovery_type: "wal_rollback",
      cause,
      outcome: "success",
    });
  }

  async abort(cause: string): Promise<void> {
    if (this.barrierFlushed && this.checkpoint) {
      await this.restoreCheckpoint(cause);
      return;
    }
    await this.rollback(cause);
  }

  async restoreCheckpoint(cause: string): Promise<void> {
    if (!this.checkpoint) {
      throw new Error("No shadow checkpoint exists for restore");
    }

    await this.checkpoint.restore(this.wal.getCreatedPaths());
    this.wal.rollback();
    this.barrierFlushed = false;
    await this.trajectoryLogger.write({
      event_id: randomUUID(),
      run_id: this.options.runId,
      session_id: this.options.sessionId,
      trace_id: this.options.traceId,
      timestamp: new Date().toISOString(),
      log_schema_version: 1,
      kind: "recovery_summary",
      level: this.options.logLevel,
      recovery_type: "shadow_restore",
      cause,
      outcome: "success",
    });
  }

  hasPendingWrites(): boolean {
    return this.wal.hasEntries();
  }

  async createNonBarrierCommandView(): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-wal-view-"));
    await this.wal.createMaterializedView(tempRoot);
    return {
      path: tempRoot,
      cleanup: async () => {
        await removeTempRootWithRetry(tempRoot);
      },
    };
  }
}

async function removeTempRootWithRetry(targetPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
  if (lastError && getEngineTunables().strictTempCleanup === true) {
    throw lastError;
  }
}
