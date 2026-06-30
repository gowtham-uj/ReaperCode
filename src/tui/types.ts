/**
 * Local types for the Reaper TUI. These types are intentionally
 * narrow — they describe what the TUI needs from the engine, not
 * what the engine has.
 */

export type TuiPhase =
  | "idle"
  | "streaming"
  | "tool-running"
  | "verifying"
  | "done";

export interface TuiStatus {
  phase: TuiPhase;
  model: string;
  provider: string;
  sessionId: string;
  /** Last known input-token count (best-effort from the model usage envelope). */
  tokens: number;
  /** 0..1 — best-effort context-window fill. */
  ctxPct: number;
  /** Phase T2.7: per-turn token usage. `last.input` is the tokens
   *  consumed by the just-finished turn; `cumulative.input` is the
   *  running total for the run. Both are best-effort — undefined when
   *  the engine didn't surface a `token_budget` event yet. */
  tokensLastTurn?: { input: number; output: number } | undefined;
  tokensCumulative?: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined;
  /** Transient UI hint (e.g. "press Ctrl-C again to exit"). Cleared
   *  by App after a short timeout. */
  hint?: string | undefined;
  /** Elapsed milliseconds since the current prompt started. */
  elapsedMs?: number | undefined;
  /** Number of open (in-flight) tool cards. */
  activeToolCount?: number | undefined;
  /** Outcome of the most recently completed tool call. */
  lastToolOutcome?: "ok" | "err" | "none";
  /** Whether the rendering layer should suppress the reasoning
   *  block above assistant chat bubbles. Toggled by `Ctrl+T`. The
   *  flag lives on TuiStatus so consumers can read it off the
   *  cached snapshot without a separate getter. */
  hideThinkingBlock: boolean;
  /** Debug mode reveals system messages, raw tool cards, and other
   *  internal details that stay hidden in the compact default view. */
  debugMode: boolean;
}

export interface TuiUserMessage {
  kind: "user";
  id: string;
  text: string;
  ts: number;
}

export interface TuiAssistantMessage {
  kind: "assistant";
  id: string;
  text: string;
  ts: number;
  /** Optional model reasoning ("thinking") text that accompanied
   *  this assistant turn. Rendered as a collapsible block above the
   *  chat bubble. Default collapsed to keep the chat scroll position
   *  close to the latest content; user toggles via Enter. */
  reasoning?: string | undefined;
  /** Elapsed milliseconds the model spent reasoning before emitting
   *  the chat text. Optional; zero or undefined means "unknown". */
  reasoningDurationMs?: number | undefined;
}

export interface TuiSystemMessage {
  kind: "system";
  id: string;
  text: string;
  ts: number;
}

export interface TuiErrorMessage {
  kind: "error";
  id: string;
  text: string;
  ts: number;
}

export type TuiMessage =
  | TuiUserMessage
  | TuiAssistantMessage
  | TuiSystemMessage
  | TuiErrorMessage;

/** A tool call card. The TUI captures the call's args and result and
 *  renders a collapsible block. */
export interface TuiToolCard {
  id: string;
  callId: string;
  name: string;
  args: unknown;
  result: unknown;
  ok: boolean;
  durationMs: number;
  ts: number;
  /** Toggle inline vs side-by-side diff for mutating tools. */
  diffMode: "inline" | "side-by-side";
  /** Default true; the user collapses/expands with Enter. */
  collapsed: boolean;
  error?: { code: string; message: string };
}

/** A diff hunk computed client-side from disk for write_file / edit_file / replace_in_file. */
export interface TuiDiffLine {
  /** "+", "-", " ", or "@@" header. */
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
  /** Old file line number (1-based) for ctx/del; null for hunk/add. */
  oldLine?: number | null;
  /** New file line number (1-based) for ctx/add; null for hunk/del. */
  newLine?: number | null;
}

export interface TuiDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: TuiDiffLine[];
}

export interface TuiDiff {
  path: string;
  before: string;
  after: string;
  hunks: TuiDiffHunk[];
  /** shiki lang id (e.g. "ts", "json") derived from the file extension.
   *  Optional so non-file diffs can omit it; DiffCard falls back to
   *  `langForPath(path)` when this is missing. */
  language?: string;
}

export interface TuiSnapshot {
  messages: TuiMessage[];
  toolCards: TuiToolCard[];
  status: TuiStatus;
}
