import { readFile } from "node:fs/promises";
import { parseTrajectoryEntry, type TrajectoryEntry } from "./schema.js";
import { isSessionHeader, isSessionMutation } from "./session-format.js";

export interface ReplayTimelineEvent {
  id: string;
  timestamp: Date;
  kind: string;
  details: Record<string, unknown>;
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
      if (lines.length === 0) return null;

      const first = JSON.parse(lines[0]!);
      if (isSessionHeader(first) || isSessionMutation(first)) {
        return this.loadSessionFile(lines, first);
      }
      return this.loadLegacy(lines);
    } catch {
      return null;
    }
  }

  private loadSessionFile(lines: string[], first: unknown): ReplaySessionState | null {
    const header = isSessionHeader(first) ? first : undefined;
    const meta = header?.metadata ?? {};
    const state: ReplaySessionState = {
      runId: typeof meta.runId === "string" ? meta.runId : header?.id ?? "unknown",
      sessionId: typeof meta.sessionId === "string" ? meta.sessionId : header?.id ?? "unknown",
      startedAt: new Date(header?.createdAt ?? Date.now()),
      toolsStarted: 0,
      toolsCompleted: 0,
      toolsFailed: 0,
      verificationAttempts: 0,
      verificationsPassed: 0,
      verificationsFailed: 0,
      timeline: [],
    };

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (isSessionHeader(parsed)) continue;
      if (!isSessionMutation(parsed)) continue;

      const id = "id" in parsed && typeof parsed.id === "string" ? parsed.id : `seq-${parsed.seq}`;
      const timestamp = "timestamp" in parsed ? new Date(parsed.timestamp) : state.startedAt;
      const kind =
        parsed.kind === "entry" && parsed.type === "custom" && "customType" in parsed
          ? String(parsed.customType)
          : parsed.kind === "entry"
            ? parsed.type
            : parsed.kind === "record"
              ? parsed.type
              : parsed.kind;

      state.timeline.push({
        id,
        timestamp,
        kind,
        details: parsed as unknown as Record<string, unknown>,
      });

      if (parsed.kind === "record" && parsed.type === "tool_started") state.toolsStarted += 1;
      if (parsed.kind === "entry" && parsed.type === "custom") {
        const customType = "customType" in parsed ? parsed.customType : "";
        if (customType === "tool_end") {
          const data = "data" in parsed && parsed.data && typeof parsed.data === "object" ? parsed.data : {};
          const status = "status" in data ? data.status : undefined;
          if (status === "completed") state.toolsCompleted += 1;
          if (status === "failed") state.toolsFailed += 1;
        }
        if (customType === "verification_summary") {
          state.verificationAttempts += 1;
          const data = "data" in parsed && parsed.data && typeof parsed.data === "object" ? parsed.data : {};
          if ("pass_fail" in data && data.pass_fail === "pass") state.verificationsPassed += 1;
          if ("pass_fail" in data && data.pass_fail === "fail") state.verificationsFailed += 1;
        }
        if (customType === "state_transition") {
          const data = "data" in parsed && parsed.data && typeof parsed.data === "object" ? parsed.data : {};
          if ("to_step" in data && typeof data.to_step === "string") state.currentStep = data.to_step;
        }
      }
      if (parsed.kind === "record" && parsed.type === "operation_started") {
        if ("user_intent_summary" in parsed && typeof parsed.user_intent_summary === "string") {
          state.intentSummary = parsed.user_intent_summary;
        }
      }
    }

    return state.timeline.length === 0 && !header ? null : state;
  }

  private loadLegacy(lines: string[]): ReplaySessionState | null {
    const entries: TrajectoryEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(parseTrajectoryEntry(JSON.parse(line)));
      } catch {
        /* skip */
      }
    }
    if (entries.length === 0) return null;
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
      const { event_id, timestamp, kind, log_schema_version: _v, run_id: _r, session_id: _s, trace_id: _t, ...details } = entry;
      state.timeline.push({
        id: event_id,
        timestamp: new Date(timestamp),
        kind,
        details: details as Record<string, unknown>,
      });
      if (entry.kind === "session_start") state.intentSummary = entry.user_intent_summary;
      else if (entry.kind === "state_transition") state.currentStep = entry.to_step;
      else if (entry.kind === "tool_call") {
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
