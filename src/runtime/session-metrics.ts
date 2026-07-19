import type { ToolResult } from "../tools/types.js";

export const sessionStopReasons = ["solved", "no_progress_stop", "gate_exhausted", "harness_timeout", "infra_failed", "error"] as const;
export type SessionStopReason = (typeof sessionStopReasons)[number];

export interface SessionMetricsSummary {
  total_tool_calls: number;
  max_action_repeat: number;
  no_progress_trips: number;
  completion_gate_attempts: number;
  verified_completion: boolean;
  stop_reason: SessionStopReason;
}

export interface BuildSessionMetricsSummaryInput {
  toolResults: ToolResult[];
  completionGateAttempts: number;
  taskCompleted: boolean;
  verifiedCompletion: boolean;
  stuckTripped?: boolean | undefined;
  gateExhausted?: boolean | undefined;
  stopReasonOverride?: SessionStopReason | undefined;
}

export function buildSessionMetricsSummary(input: BuildSessionMetricsSummaryInput): SessionMetricsSummary {
  const noProgressTrips = countNoProgressTrips(input.toolResults);
  // Natural no-tool stop marks taskCompleted, but that is not the same as
  // verified success. Only report verified_completion/solved when the
  // caller explicitly affirms verification (ok === true), not merely
  // "verification was not false".
  const verifiedCompletion = Boolean(input.taskCompleted && input.verifiedCompletion === true);
  return {
    total_tool_calls: input.toolResults.length,
    max_action_repeat: computeMaxActionRepeat(input.toolResults),
    no_progress_trips: noProgressTrips,
    completion_gate_attempts: Math.max(0, Math.floor(input.completionGateAttempts || 0)),
    verified_completion: verifiedCompletion,
    stop_reason: inferStopReason({
      taskCompleted: input.taskCompleted,
      verifiedCompletion,
      noProgressTrips,
      stuckTripped: input.stuckTripped,
      gateExhausted: input.gateExhausted,
      completionGateAttempts: input.completionGateAttempts,
      stopReasonOverride: input.stopReasonOverride,
    }),
  };
}

export function computeMaxActionRepeat(results: ToolResult[]): number {
  const counts = new Map<string, number>();
  let max = 0;
  for (const result of results) {
    const signature = makeActionSignature(result);
    const count = (counts.get(signature) ?? 0) + 1;
    counts.set(signature, count);
    max = Math.max(max, count);
  }
  return max;
}

export function countNoProgressTrips(results: ToolResult[]): number {
  // A no-progress trip is N consecutive failed tool calls with the
  // same action signature and an empty or zero-byte error message
  // (i.e. the tool was unable to advance the task because it kept
  // retrying the same dead end). We treat three consecutive repeats
  // as one trip — small enough not to flag ordinary "rerun after
  // fix" debugging, large enough to surface genuine deadlocks.
  //
  // The previous implementation returned a hardcoded 0, which made
  // the dashboard metric silently meaningless; downstream consumers
  // had no way to distinguish a stuck run from a fast one.
  const REPEAT_THRESHOLD = 3;
  let trips = 0;
  let runLength = 0;
  let lastSig: string | undefined;
  for (const result of results) {
    if (result.ok) {
      runLength = 0;
      lastSig = undefined;
      continue;
    }
    const sig = makeActionSignature(result);
    if (sig === lastSig) {
      runLength += 1;
      if (runLength === REPEAT_THRESHOLD) {
        trips += 1;
        // Continue counting — a long stuck run counts multiple trips.
        runLength = 0;
      }
    } else {
      lastSig = sig;
      runLength = 1;
    }
  }
  return trips;
}

export function makeActionSignature(result: ToolResult): string {
  return `${result.name}::${normalizeArgs(result.name, result.args)}`;
}

export function normalizeArgs(toolName: string, args: unknown): string {
  const record = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (toolName === "bash") {
    return stableJson({ cmd: normalizeVolatileText(typeof record.cmd === "string" ? record.cmd : "") });
  }
  if (toolName === "read_file") {
    return stableJson({ path: normalizeVolatileText(typeof record.path === "string" ? record.path : "") });
  }
  return stableJson(normalizeValue(record));
}

function inferStopReason(input: {
  taskCompleted: boolean;
  verifiedCompletion: boolean;
  noProgressTrips: number;
  stuckTripped?: boolean | undefined;
  gateExhausted?: boolean | undefined;
  completionGateAttempts: number;
  stopReasonOverride?: SessionStopReason | undefined;
}): SessionStopReason {
  if (input.stopReasonOverride) return input.stopReasonOverride;
  if (input.taskCompleted && input.verifiedCompletion) return "solved";
  // Natural stop without verified success is not "solved".
  if (input.taskCompleted && !input.verifiedCompletion) return "error";
  if (input.noProgressTrips > 0 || input.stuckTripped) return "no_progress_stop";
  if (input.gateExhausted || input.completionGateAttempts > 0) return "gate_exhausted";
  return "error";
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeVolatileText(value);
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeValue(item)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

function normalizeVolatileText(value: string): string {
  return value
    .replace(/\/tmp\/reaper-tbench-[A-Za-z0-9_-]+/g, "/tmp/reaper-tbench-<id>")
    .replace(/\/tmp\/reaper-[A-Za-z0-9_.-]+/g, "/tmp/reaper-<id>")
    .replace(/\/workspace\/reaper_eval\/terminal-bench-runs\/[^\s'")]+/g, "/workspace/reaper_eval/terminal-bench-runs/<run>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\b\d{13,}\b/g, "<timestamp>")
    .replace(/\s+/g, " ")
    .trim();
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}
