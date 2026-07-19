import { parseTrajectoryEntry, type TrajectoryEntry } from "./schema.js";
import { LogIndexFile } from "./index-file.js";
import { JsonlStorage } from "./storage.js";
import { logLangfuseEvent } from "./langfuse.js";
import { emitStreamEvent } from "./stream-events.js";

export class TrajectoryLogger {
  private readonly storage: JsonlStorage;
  private readonly index: LogIndexFile;
  private readonly workspaceRoot: string;
  // Tracks whether we've already surfaced the chain-unhealthy signal
  // for the current process lifetime. We only want to spam a single
  // `chain_unhealthy` audit entry per storage fork — once flagged,
  // operators know.
  private chainUnhealthyReported = false;

  constructor(workspaceRoot: string, options?: { devMode?: boolean; sampleRate?: number; runId?: string }) {
    this.workspaceRoot = workspaceRoot;
    this.storage = new JsonlStorage({
      workspaceRoot,
      filename: "reaper-trajectory.jsonl",
      ...(options?.runId !== undefined ? { runId: options.runId } : {}),
      ...(options?.devMode !== undefined ? { devMode: options.devMode } : {}),
      ...(options?.sampleRate !== undefined ? { sampleRate: options.sampleRate } : {}),
    });
    this.index = new LogIndexFile(workspaceRoot, "reaper-trajectory.index.json", options?.runId);
  }

  async write(entry: TrajectoryEntry): Promise<void> {
    const parsed = parseTrajectoryEntry(entry);
    // Live event stream: mirror every entry to stdout as JSONL when
    // REAPER_STREAM_EVENTS is enabled. Emitted before the disk write
    // so downstream consumers see the event with minimal latency.
    emitStreamEvent(parsed);
    // Latency optimization: parallelize storage.append + index.append
    // (different files, no data dependency on each other beyond
    // `appended.offset`). Previously the index write waited for the
    // jsonl write to finish; now they overlap.
    await this.maybeReportChainUnhealthy(parsed);
    const indexAppendPromise = this.storage.append(parsed).then((appended) => {
      if (appended) {
        // Fire-and-forget the index write — losing an index entry on
        // crash is acceptable; the jsonl file is the source of truth.
        return this.index.append({ event_id: parsed.event_id, offset: appended.offset }).catch(() => undefined);
      }
      return undefined;
    });
    const statusMessage = "error" in parsed ? parsed.error?.message : undefined;
    // Defer Langfuse to a setImmediate background tick so a slow HTTP
    // POST never blocks the engine's hot path. Observability is
    // best-effort; losing one event under crash is acceptable.
    setImmediate(() => {
      logLangfuseEvent({
        workspaceRoot: this.workspaceRoot,
        name: `reaper.${parsed.kind}`,
        type: parsed.kind === "tool_call" ? "tool" : parsed.kind === "session_start" ? "agent" : "event",
        input: "args" in parsed ? parsed.args : undefined,
        output: "output" in parsed ? parsed.output : parsed,
        level: "level" in parsed && parsed.level === "debug" ? "DEBUG" : "DEFAULT",
        ...(statusMessage ? { statusMessage } : {}),
        metadata: parsed as unknown as Record<string, unknown>,
        trace: { runId: parsed.run_id, sessionId: parsed.session_id, traceId: parsed.trace_id },
      }).catch(() => undefined);
    });
    await indexAppendPromise;
  }

  /**
   * Batched write: append multiple entries to the jsonl in a single
   * syscall and fan out their index updates in parallel. Used by
   * engine code that emits many events for one logical action (e.g.
   * a tool call produces 3-4 envelopes).
   */
  async writeBatch(entries: TrajectoryEntry[]): Promise<void> {
    if (entries.length === 0) return;
    if (entries.length === 1 && entries[0]) {
      return this.write(entries[0]);
    }
    const parsed = entries.map((e) => parseTrajectoryEntry(e));
    for (const p of parsed) emitStreamEvent(p);
    await this.maybeReportChainUnhealthy(parsed[0] ?? { run_id: "", session_id: "", trace_id: "" });
    const appended = await this.storage.appendBatch(parsed);
    const indexAppends: Array<Promise<void>> = [];
    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i];
      const a = appended[i];
      if (!p || !a) continue;
      indexAppends.push(
        this.index.append({ event_id: p.event_id, offset: a.offset }).catch(() => undefined),
      );
      const statusMessage = "error" in p ? p.error?.message : undefined;
      const kind = p.kind;
      const runId = p.run_id;
      const sessionId = p.session_id;
      const traceId = p.trace_id;
      const eventForLangfuse = parsed[i];
      setImmediate(() => {
        logLangfuseEvent({
          workspaceRoot: this.workspaceRoot,
          name: `reaper.${kind}`,
          type: kind === "tool_call" ? "tool" : kind === "session_start" ? "agent" : "event",
          input: "args" in p ? p.args : undefined,
          output: "output" in p ? p.output : eventForLangfuse,
          level: "level" in p && p.level === "debug" ? "DEBUG" : "DEFAULT",
          ...(statusMessage ? { statusMessage } : {}),
          metadata: eventForLangfuse as unknown as Record<string, unknown>,
          trace: { runId, sessionId, traceId },
        }).catch(() => undefined);
      });
    }
    await Promise.all(indexAppends);
  }

  get path() {
    return this.storage.path;
  }

  /**
   * Surface a single trajectory `chain_unhealthy` event when the
   * underlying JsonlStorage's in-memory chain is known to have
   * forked from the on-disk file. The signal is emitted at most once
   * per process lifetime — operators do not need N redundant entries
   * for one corruption episode. The entry kind piggy-backs on
   * `recovery_summary` (already a known observer-only event) since
   * the trajectory schema has a discriminated-union `kind` and adding
   * `chain_unhealthy` would require a schema bump. The `cause` field
   * (`chain_unhealthy`) carries the durable signal and is what
   * downstream log readers should filter on.
   */
  private async maybeReportChainUnhealthy(
    seed: { run_id: string; session_id: string; trace_id: string },
  ): Promise<void> {
    if (this.chainUnhealthyReported) return;
    if (this.storage.isChainHealthy()) return;
    this.chainUnhealthyReported = true;
    try {
      await this.storage.append({
        event_id: crypto.randomUUID(),
        run_id: seed.run_id,
        session_id: seed.session_id,
        trace_id: seed.trace_id,
        timestamp: new Date().toISOString(),
        log_schema_version: 1,
        kind: "recovery_summary",
        level: "info",
        recovery_type: "chain_unhealthy",
        cause: "chain_unhealthy",
        outcome: "failure",
      });
      console.warn(
        "[reaper][trajectory] chain_unhealthy emitted — reaper-trajectory.jsonl tail was malformed or unreadable; the in-memory chain restarted at root and may diverge from a replay reader",
      );
    } catch (error) {
      console.warn(
        `[reaper][trajectory] failed to emit chain_unhealthy (best-effort): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
