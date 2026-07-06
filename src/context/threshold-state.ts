/**
 * context/threshold-state.ts — context-usage warning states.
 *
 * Maps `used / softCap` to a four-state severity level that downstream
 * UIs and telemetry can surface. Mirrors cc-haha's
 * `calculateTokenWarningState` (`autoCompact.ts:127-169`).
 *
 *   - "ok":       < 70% of softCap
 *   - "warning":  70% - 85% of softCap
 *   - "error":    85% - 95% of softCap
 *   - "blocking": ≥ 95% of softCap
 */

export type ContextWarningState = "ok" | "warning" | "error" | "blocking";

export interface ContextUsage {
  /** Approximate tokens used (or chars/4). */
  used: number;
  /** Token softCap (e.g. 270_000). */
  softCap: number;
}

export interface ContextState {
  state: ContextWarningState;
  /** 0.0 – 1.0 utilization. */
  ratio: number;
  /** Tokens remaining until softCap. */
  remaining: number;
  /** Warning at this ratio; UI may show a "context full" banner. */
  message: string;
}

const WARNING_RATIO = 0.70;
const ERROR_RATIO = 0.85;
const BLOCKING_RATIO = 0.95;

export function calculateContextWarningState(usage: ContextUsage): ContextState {
  const ratio = usage.softCap > 0 ? usage.used / usage.softCap : 0;
  let state: ContextWarningState = "ok";
  if (ratio >= BLOCKING_RATIO) state = "blocking";
  else if (ratio >= ERROR_RATIO) state = "error";
  else if (ratio >= WARNING_RATIO) state = "warning";
  return {
    state,
    ratio,
    remaining: Math.max(0, usage.softCap - usage.used),
    message: stateMessage(state, ratio),
  };
}

function stateMessage(state: ContextWarningState, ratio: number): string {
  switch (state) {
    case "ok":
      return `Context usage at ${(ratio * 100).toFixed(1)}% — normal operation.`;
    case "warning":
      return `Context usage at ${(ratio * 100).toFixed(1)}% — approaching softCap.`;
    case "error":
      return `Context usage at ${(ratio * 100).toFixed(1)}% — compaction will run soon.`;
    case "blocking":
      return `Context usage at ${(ratio * 100).toFixed(1)}% — at or above softCap.`;
  }
}