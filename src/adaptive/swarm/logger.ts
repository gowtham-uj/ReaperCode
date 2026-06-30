/**
 * Lightweight structured logger for the swarm module.
 *
 * Emits a `SwarmLogEvent` to the configured sink. The default sink
 * is `console.debug` so the engine's own trajectory log is not
 * polluted unless `REAPER_SWARM_DEBUG=1` is set. Production code
 * can replace the sink with a trajectory writer.
 */

export type SwarmLogEvent =
  | { kind: "swarm_started"; spec_id: string; decision: boolean; reason: string; mode: "off" | "on" | "auto" }
  | { kind: "swarm_round_failed"; spec_id: string; round: number; reason: string }
  | { kind: "swarm_completion_blocked"; spec_id: string; reason: string }
  | { kind: "swarm_finished"; spec_id: string; status: string; agents: number }
  | { kind: "swarm_agent_validated"; spec_id: string; role: string; accepted: boolean; validation_error: string | null }
  | { kind: "swarm_conflict_detected"; spec_id: string; topic: string; decided_by: string }
  | { kind: "swarm_fallback"; spec_id: string; reason: string }
  | { kind: "swarm_toggle_resolved"; spec_id: string; mode: "off" | "on" | "auto"; reason: string };

export type SwarmLogSink = (event: SwarmLogEvent) => void;

let activeSink: SwarmLogSink = (e) => {
  if (process.env.REAPER_SWARM_DEBUG === "1") {
    // eslint-disable-next-line no-console
    console.debug(`[swarm] ${e.kind}`, e);
  }
};

export function setSwarmLogSink(sink: SwarmLogSink): void {
  activeSink = sink;
}

export function logSwarmEvent(event: SwarmLogEvent): void {
  try {
    activeSink(event);
  } catch {
    // never let a log error break the run
  }
}
