/**
 * Per-run typed state store.
 *
 * Replaces the legacy `globalThis[\`${runId}::...\`]` slots that used
 * to carry per-run lifecycle state for the context-engineering wiring
 * and the runtime engine. The same isolation property is preserved
 * (one key per runId) and concurrent runs can no longer collide.
 *
 * OBSERVABLE BEHAVIOR: this is a structural refactor. Every call site
 * keeps the same read/write/delete semantics the previous globalThis
 * slots had.
 */
import type { CompactionCheckpoint } from "../context/compaction-checkpoint.js";

export interface SessionResumeStash {
  resume: {
    reAnchor: string;
    rehydratedMessages: unknown[];
    summary: unknown;
    stats: { recentTurns: number; recentChars: number; summariesAvailable: number };
    seededFromJournal?: boolean;
  };
  namedSession: string | null;
  sessionId: string;
  stashedAt: number;
}

export interface FullSummaryAppliedSlot {
  messages: unknown[];
  summaryText?: string;
  checkpoint?: CompactionCheckpoint;
  appliedAt: number;
}

export interface FullSummaryCooldownSlot {
  baselineTokens: number;
  toolBatchesSince: number;
  appliedAt: number;
}

export interface FullSummaryInflightSlot {
  promise: Promise<string>;
}

export interface IncompleteRecoverySlot {
  triggeredAt: number;
  stopReason: string;
  tokensUsed: number;
}

export interface IdleCompactionSlot {
  triggeredAt: number;
  tokensUsed: number;
}

export interface LastFullSummarySlot {
  summaryText: string;
  preChars: number;
  postChars: number;
  checkpoint: CompactionCheckpoint;
  epoch: number;
  appliedAt: number;
}

/**
 * Per-run state entry. Every field corresponds to a previous
 * `${runId}::<name>` globalThis slot. All fields are optional +
 * `undefined`-able so consumers can clear them via simple `= undefined`
 * assignments without `delete`.
 */
export interface RunState {
  // Session resume (engine consumes in mainAgentNode)
  sessionResume?: SessionResumeStash | undefined;
  // Number of rehydrated messages prepended on session resume.
  // Engine writes on consume, wiring reads on onRunComplete.
  rehydratedCount?: number | undefined;
  // Full-summary applied (next-call replacement messages)
  fullSummaryApplied?: FullSummaryAppliedSlot | undefined;
  // In-flight full-summary promise (shared between async paths and PTL)
  fullSummary?: FullSummaryInflightSlot | undefined;
  // Cooldown after a full-summary (prevents thrash)
  fullSummaryCooldown?: FullSummaryCooldownSlot | undefined;
  // Marker set when a PTL recovery consumed the in-flight summary
  fullSummaryPtlConsumed?: number | undefined;
  // Last applied full summary (used by onRunComplete journal write-back)
  lastFullSummary?: LastFullSummarySlot | undefined;
  // Last reported provider input tokens (used as floor in compaction gate)
  lastInputTokens?: number | undefined;
  // T1: Idle-compaction trigger flag (consumed by next onBeforeModelCall)
  idleCompaction?: IdleCompactionSlot | undefined;
  // T2: Incomplete-recovery trigger flag (consumed by next onBeforeModelCall)
  incompleteRecovery?: IncompleteRecoverySlot | undefined;
  // T1: Timer handle; cleared after firing
  idleCompactionTimer?: ReturnType<typeof setTimeout> | undefined;
}

/** Process-singleton registry keyed by runId. */
const RUN_STATES = new Map<string, RunState>();

/**
 * Obtain the per-run state object, creating it lazily on first access.
 * The state is mutable in place; callers read/write typed fields
 * directly. Cleared by `clearRunState(runId)` on run completion or
 * failure.
 */
export function getRunState(runId: string): RunState {
  let state = RUN_STATES.get(runId);
  if (!state) {
    state = {};
    RUN_STATES.set(runId, state);
  }
  return state;
}

/** Test-only: peek at the underlying map without creating entries. */
export function hasRunState(runId: string): boolean {
  return RUN_STATES.has(runId);
}

/**
 * Clear all typed slots and pending idle-compaction timer for a run.
 * Mirrors the previous `delete globalThis[`${runId}::*`]` cleanup
 * that ran in `onRunComplete`. Safe to call multiple times.
 */
export function clearRunState(runId: string): void {
  const state = RUN_STATES.get(runId);
  if (!state) return;
  if (state.idleCompactionTimer) {
    try {
      clearTimeout(state.idleCompactionTimer);
    } catch {
      /* best-effort */
    }
    state.idleCompactionTimer = undefined;
  }
  RUN_STATES.delete(runId);
}

/** Test-only helper: number of currently tracked runs. */
export function getRunStateCount(): number {
  return RUN_STATES.size;
}
