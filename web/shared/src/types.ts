/**
 * Client-side mirror of the app-server's thread model.
 *
 * These types are hand-mirrored from `src/app-server/session-projection.ts`
 * rather than imported: the server package resolves modules with NodeNext,
 * the web packages use bundler resolution, and crossing that boundary would
 * drag the whole server tree into a browser bundle.
 *
 * `tests/unit/protocol-store-parity.test.ts` asserts the two stay in step.
 */

export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export type AppTurnStatus = "inProgress" | "completed" | "interrupted" | "failed";
export type ItemStatus = "inProgress" | "completed" | "failed";

/**
 * One line of sandbox output, as it arrives.
 *
 * `kind` is a `console` level, `"tool"` for a Reaper tool the script crossed,
 * or `"error"` for the failure that ended it — the same vocabulary the runtime
 * uses, so a reader never has to translate between two names for the same
 * thing.
 */
export interface CodeModeLiveLine {
  kind: "log" | "info" | "warn" | "error" | "debug" | "tool";
  text: string;
}

/** One step of the agent's typed plan, mirrored from `src/runtime/plan-state.ts`. */
export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  detail?: string;
  evidence?: string;
  acceptanceCriteria?: string;
  updatedAt?: number;
}

/** One working-memory todo item, mirrored from `src/runtime/plan-state.ts`. */
export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  priority?: "low" | "medium" | "high" | undefined;
  evidence?: string | undefined;
  updatedAt?: number | undefined;
}

export type AppThreadItem =
  | { type: "userMessage"; id: string; content: Array<{ type: "text"; text: string }> }
  | { type: "agentMessage"; id: string; text: string; phase: "commentary" | "final_answer" }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd?: string;
      status: ItemStatus;
      aggregatedOutput?: string;
      exitCode?: number;
      durationMs?: number;
    }
  | {
      type: "fileChange";
      id: string;
      changes: Array<{
        path: string;
        kind: string;
        diff?: string;
        /**
         * Line counts, carried rather than counted from `diff`.
         *
         * The client can count `+` and `-` lines itself, and did, but only
         * while the diff was complete: a long change is truncated on the
         * server, and a truncated diff no longer contains every added line, so
         * counting it under-reports the change on exactly the rows where the
         * size matters most.
         */
        additions?: number;
        removals?: number;
        /** True when `diff` is a preview of a larger change. */
        truncated?: boolean;
      }>;
      status: ItemStatus;
      /** Sandbox time for the call, so a thread loaded from history shows
       *  timings too. Live calls also get a wall-clock figure from the client. */
      durationMs?: number;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      tool: string;
      arguments: Record<string, unknown>;
      status: ItemStatus;
      result?: unknown;
      error?: string;
      /**
       * Wall-clock time on the client's own clock, from the moment the call
       * started to the moment it finished.
       *
       * Measured here rather than sent by the server because the two answer
       * different questions. The result payload already carries the *sandbox's*
       * duration, which excludes queueing and transport; this includes them, so
       * a row can show a number that is still correct when the call is merely
       * slow to arrive. Absent until the call finishes — an item that is still
       * running has no duration, only a start.
       */
      durationMs?: number;
      /**
       * Sandbox output that arrived while the call was still running.
       *
       * Present only between "started" and "completed", and only for Code Mode:
       * a `eval` call streams what the script prints and every tool it crosses,
       * which is what makes a long loop legible while it runs. It is dropped
       * the moment the result lands, because the result carries the same output
       * with its structure intact.
       */
      liveOutput?: CodeModeLiveLine[];
      /** Set by the client when the call starts, and read back when it ends. */
      startedAt?: number;
    }
  | {
      /**
       * One context-management technique, as a transcript row.
       *
       * The technique is named rather than summarized as "compacted", because
       * the techniques are not interchangeable: shaking stale tool output and
       * rewriting the conversation with a model call free similar amounts of
       * context and mean very different things about what the agent still knows.
       */
      type: "contextManagement";
      id: string;
      technique: ContextTechnique;
      status: "inProgress" | "completed" | "failed";
      savedChars?: number;
      savedTokens?: number;
      messagesBefore?: number;
      messagesAfter?: number;
      usedTokens?: number;
      softCap?: number;
      detail?: string;
      error?: string;
      /** Set by the client when the row appears, used to show a live elapsed. */
      startedAt?: number;
    };

/**
 * Mirrors the runtime's set so a technique added there is a type error here
 * until it has a label, rather than rendering as its raw snake_case name.
 */
export type ContextTechnique =
  | "supersede"
  | "tool_output_prune"
  | "bash_head_tail"
  | "shake"
  | "microcompact"
  | "tool_history"
  | "snapcompact"
  | "full_summary"
  | "handoff_summary"
  | "idle_compaction"
  | "incomplete_recovery"
  | "ptl_recovery"
  | "model_promotion";

export type AppThreadItemType = AppThreadItem["type"];

export interface AppTurn {
  id: string;
  status: AppTurnStatus;
  items: AppThreadItem[];
  error?: { message: string; additionalDetails?: string };
}

export type AppThreadStatus =
  | "notLoaded"
  | "idle"
  | "systemError"
  | { type: "active"; activeFlags: string[] };

export interface TokenUsageCounts {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenUsage {
  total: TokenUsageCounts;
  last: TokenUsageCounts;
  modelContextWindow: number | null;
  /** Reaper's soft context budget, distinct from the model's window. */
  contextSoftCap?: number | undefined;
  /**
   * Prompt pressure, computed on the server. Optional because an older payload
   * (or a run whose model limit could not be resolved) may not carry it; the
   * meter falls back to the raw count rather than inventing a percentage.
   */
  contextUsage?: ContextUsage | undefined;
}

/**
 * How full the context window is, as a first-class value.
 *
 * Computed on the server rather than in the client, so every surface renders
 * the same number from the same inputs instead of each re-deriving a
 * percentage and disagreeing about the denominator.
 *
 * ### Why this is not simply `last.totalTokens / window`
 *
 * The quantity that matters is *context pressure*: how much of the next
 * request's prompt budget is already spoken for. Accounting counters are not
 * that. Summing input, output, reasoning, and cache reads gives a number for
 * how much was billed, which is not the same as how many tokens will occupy
 * the prompt, and it is how a context meter ends up reporting over 100%.
 *
 * Two corrections make the difference:
 *
 *  - `reservedOutputTokens` is subtracted from the limit. A request declares a
 *    maximum output length, and that reservation is part of the budget: a
 *    200k window with a 32k output reservation holds about 168k of prompt. A
 *    meter that divides by the raw window reports a window that is fuller
 *    than it can actually be.
 *  - `percent` is clamped to 100. A value above 100 is never information; it
 *    means the accounting model is wrong, and showing it blames the user for
 *    arithmetic they cannot see.
 *
 * ### `estimated`
 *
 * While a prompt is being assembled its size can only be tokenizer-estimated.
 * Once the provider answers, its reported usage replaces the estimate. A
 * renderer must distinguish the two, because a meter that silently mixes them
 * makes an estimate look authoritative and a real count look uncertain.
 */
export interface ContextUsage {
  /** The model this measurement belongs to, when known. */
  model?: string | undefined;
  /** Provider-reported prompt tokens, or the tokenizer estimate. */
  promptTokens: number;
  /**
   * The budget the percentage is against: the model's context window minus any
   * reserved output. `limitSource` says where the window came from.
   */
  contextLimit: number | null;
  /** Portion of `contextLimit` held back for the model's own output. */
  reservedOutputTokens: number;
  /** Whole percent, 0 to 100, or null when the limit is unknown. */
  percent: number | null;
  /** `contextLimit - promptTokens`, floored at 0, or null when unknown. */
  remaining: number | null;
  /** True when `promptTokens` is a tokenizer estimate rather than a real count. */
  estimated: boolean;
  /**
   * Where `contextLimit` came from. Resolved in this order, and `unknown` is a
   * real answer: a meter with no limit must render as "unknown" rather than
   * inventing a denominator, because a wrong window is worse than none. It
   * shows a confidently wrong percentage that no one can trace.
   */
  limitSource: "config" | "catalog" | "registry" | "unknown";
}

/**
 * The latest verification verdict, folded from `verification.completed`.
 * `ok` means every command exited 0; `verified` additionally means the
 * evidence was grounded in a real test/build/typecheck/lint/artifact signal.
 * `verified` is the trust-relevant bit — the panel exists to distinguish
 * "actually passed" from "echo done".
 */
export interface VerificationSurface {
  ok: boolean;
  verified: boolean;
  command?: string;
  summary?: string;
  groundedSignal?: { kind: string; command: string; grounded: boolean };
  failureClasses?: string[];
  feedback?: string[];
  attemptCount?: number;
  selfDebugExplanation?: string;
  diffReviewExplanation?: string;
}

export interface AppThread {
  id: string;
  sessionId?: string;
  preview?: string;
  ephemeral?: boolean;
  cwd?: string;
  modelProvider?: string | null;
  model?: string | null;
  reasoningEffort?: "low" | "medium" | "high";
  /** Extra instructions appended after the built-in agent prompt. */
  systemPrompt?: string;
  /** Tool names this thread's agent must not call. */
  disabledTools?: string[];
  /**
   * Whether this thread's shell commands are confined to its workspace.
   * Always stated by the server, so `undefined` means only that no snapshot
   * has arrived yet.
   */
  filesystemSandbox?: boolean;
  /**
   * Whether any turn has ever run here. A thread with none is an unused
   * scratch thread, which is what makes it safe to reuse instead of creating
   * another one on the next visit.
   */
  hasTurns?: boolean;
  createdAt?: string;
  updatedAt?: string;
  name?: string;
  status?: AppThreadStatus;
  approvalPolicy?: string;
  /**
   * Latest browser surface for this thread, folded from the most recent
   * `browser_use` tool completion. Present only after the agent has used
   * the browser; the Browser panel renders this without knowing which tool
   * produced it.
   */
  browser?: BrowserSurface | undefined;
  /**
   * The typed plan and todo checklists, folded from `plan.updated` /
   * `todo.updated` events. These mirror the cockpit the model itself sees.
   */
  plan?: PlanStep[] | undefined;
  todo?: TodoItem[] | undefined;
  /**
   * The latest verification verdict, folded from `verification.completed`.
   * Present only after the agent has run a verifier; the panel renders the
   * ok-vs-verified distinction the transcript alone cannot carry.
   */
  verification?: VerificationSurface | undefined;
  turns: AppTurn[];
  /**
   * Highest event sequence folded into this thread. Used as the
   * `afterSequence` cursor when resubscribing after a reconnect.
   */
  latestSequence: number;
  tokenUsage?: TokenUsage;
}

/**
 * A step is one model request plus the tools it called. The protocol has no
 * step concept — turns are a flat item list — so this is derived client-side
 * to keep a 40-tool-call turn from rendering as one undifferentiated wall.
 */
export interface AppStep {
  id: string;
  items: AppThreadItem[];
}

export interface ApprovalRequest {
  requestId: JsonRpcId;
  method: string;
  threadId: string;
  turnId?: string;
  approvalId: string;
  params: Record<string, unknown>;
  availableDecisions: string[];
}

export const DEFAULT_APPROVAL_DECISIONS = ["approved", "denied", "cancelled"] as const;

/**
 * One interactive element on the page the browser controller most recently
 * described. Mirrors `InteractiveElement` in
 * `src/tools/browser/computer-browser.ts`: coordinates are in CSS pixels
 * relative to the page viewport, so an overlay drawn over a viewport-sized
 * screenshot lines up with them.
 */
export interface BrowserInteractiveElement {
  ref: string;
  index: number;
  tag: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  role?: string | undefined;
  type?: string | undefined;
}

/**
 * The state a tab renders in the Browser panel — the clickable-overlay
 * surfacing of a completed `browser_use`. It lives in `shared` so
 * the reducer can fold the `tool.completed` result for a `browser_use` call
 * into it without the UI ever understanding which tool produced the data.
 */
export interface BrowserSurface {
  /** Page URL as reported by the browser controller. */
  url: string;
  title: string;
  /**
   * Viewport size the controller observed. The interactive coordinates are in
   * CSS pixels relative to this viewport, so an overlay drawn over a
   * viewport-sized screenshot divides by it to get percentages.
   */
  viewport?: { width: number; height: number } | undefined;
  /** Screenshot path, if the action captured one (navigate/click/snapshot do). */
  screenshotPath?: string | undefined;
  interactive: BrowserInteractiveElement[];
}

/** The tool name the shared reducer watches for browser surfacing. */
export const BROWSER_SURFACE_TOOL = "browser_use";
