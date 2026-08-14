import { parseTrajectoryEntry, type TrajectoryEntry } from "./schema.js";
import { logLangfuseEvent } from "./langfuse.js";
import { emitStreamEvent } from "./stream-events.js";
import { SessionLogWriter } from "./session-writer.js";
import { ConversationLog } from "./conversation.js";
import type { SessionMutation } from "./session-format.js";

export class TrajectoryLogger {
  private readonly session: SessionLogWriter;
  private readonly conversation: ConversationLog;
  private readonly workspaceRoot: string;
  private turnIndex: number | undefined;

  constructor(workspaceRoot: string, options?: { devMode?: boolean; sampleRate?: number; runId?: string }) {
    this.workspaceRoot = workspaceRoot;
    this.session = new SessionLogWriter(workspaceRoot, {
      filename: "session.jsonl",
      ...(options?.runId ? { runId: options.runId } : {}),
    });
    this.conversation = new ConversationLog(workspaceRoot, options?.runId);
  }

  setTurnIndex(turnIndex: number): void {
    this.turnIndex = turnIndex;
  }

  async write(entry: TrajectoryEntry): Promise<void> {
    const withTurn =
      this.turnIndex !== undefined && entry.turn_index === undefined
        ? { ...entry, turn_index: this.turnIndex }
        : entry;
    const parsed = parseTrajectoryEntry(withTurn);
    const mutations = await this.session.writeTrajectory(parsed);
    await this.conversation.append(parsed);
    for (const mutation of mutations) {
      emitStreamEvent(mutation);
    }
    const statusMessage = "error" in parsed ? parsed.error?.message : undefined;
    setImmediate(() => {
      void logLangfuseEvent({
        workspaceRoot: this.workspaceRoot,
        name: `reaper.trajectory.${parsed.kind}`,
        type: "event",
        output: parsed,
        ...(statusMessage ? { statusMessage } : {}),
        metadata: parsed as unknown as Record<string, unknown>,
        trace: { runId: parsed.run_id, sessionId: parsed.session_id, traceId: parsed.trace_id },
      });
    });
  }

  async writeBatch(entries: TrajectoryEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.write(entry);
    }
  }

  get path() {
    return this.session.path;
  }
}

export type { SessionMutation };
