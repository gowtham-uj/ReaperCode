import { readFile } from "node:fs/promises";
import { parseTrajectoryEntry, type TrajectoryEntry } from "./schema.js";

export interface ReplayTimelineEvent {
  id: string;
  timestamp: Date;
  kind: TrajectoryEntry["kind"];
  details: Omit<TrajectoryEntry, "kind" | "event_id" | "timestamp" | "log_schema_version" | "run_id" | "session_id" | "trace_id">;
}

export interface ReplaySessionState {
  runId: string;
  sessionId: string;
  startedAt: Date;
  intentSummary?: string;
  toolsStarted: number;
  toolsCompleted: number;
  toolsFailed: number;
  verificationAttempts: number;
  verificationsPassed: number;
  verificationsFailed: number;
  currentStep?: string;
  timeline: ReplayTimelineEvent[];
}

export class SessionReplayer {
  constructor(private readonly logFilePath: string) {}

  async load(): Promise<ReplaySessionState | null> {
    try {
      const content = await readFile(this.logFilePath, "utf8");
      const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
      
      const entries: TrajectoryEntry[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          entries.push(parseTrajectoryEntry(parsed));
        } catch {
          // Skip malformed entries
        }
      }

      if (entries.length === 0) {
        return null;
      }

      entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      const state: ReplaySessionState = {
        runId: entries[0]!.run_id,
        sessionId: entries[0]!.session_id,
        startedAt: new Date(entries[0]!.timestamp),
        toolsStarted: 0,
        toolsCompleted: 0,
        toolsFailed: 0,
        verificationAttempts: 0,
        verificationsPassed: 0,
        verificationsFailed: 0,
        timeline: [],
      };

      for (const entry of entries) {
        const { event_id, timestamp, kind, log_schema_version, run_id, session_id, trace_id, ...details } = entry;
        
        state.timeline.push({
          id: event_id,
          timestamp: new Date(timestamp),
          kind,
          details: details as ReplayTimelineEvent["details"],
        });

        if (entry.kind === "session_start") {
          state.intentSummary = entry.user_intent_summary;
        } else if (entry.kind === "state_transition") {
          state.currentStep = entry.to_step;
        } else if (entry.kind === "tool_call") {
          if (entry.status === "started") state.toolsStarted += 1;
          if (entry.status === "completed") state.toolsCompleted += 1;
          if (entry.status === "failed") state.toolsFailed += 1;
        } else if (entry.kind === "verification_summary") {
          state.verificationAttempts += 1;
          if (entry.pass_fail === "pass") state.verificationsPassed += 1;
          if (entry.pass_fail === "fail") state.verificationsFailed += 1;
        }
      }

      return state;
    } catch {
      return null;
    }
  }

  async printReport(): Promise<string> {
    const state = await this.load();
    if (!state) return "No valid replay data found.";

    let report = `Replay Report for Session ${state.sessionId}\n`;
    report += `Run ID: ${state.runId}\n`;
    report += `Started: ${state.startedAt.toISOString()}\n`;
    report += `Intent: ${state.intentSummary ?? "N/A"}\n\n`;
    
    report += `=== Metrics ===\n`;
    report += `Tools Started: ${state.toolsStarted} | Completed: ${state.toolsCompleted} | Failed: ${state.toolsFailed}\n`;
    report += `Verifications: ${state.verificationAttempts} | Passed: ${state.verificationsPassed} | Failed: ${state.verificationsFailed}\n\n`;
    
    report += `=== Timeline ===\n`;
    for (const event of state.timeline) {
      report += `[${event.timestamp.toISOString()}] ${event.kind.padEnd(22)} | ${JSON.stringify(event.details)}\n`;
    }

    return report;
  }
}
