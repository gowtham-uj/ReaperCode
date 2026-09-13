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
      changes: Array<{ path: string; kind: string; diff?: string }>;
      status: ItemStatus;
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
   * `browser_control` tool completion. Present only after the agent has used
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
 * surfacing of `browser_control`'s `describePage()`. It lives in `shared` so
 * the reducer can fold the `tool.completed` result for a `browser_control` call
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
export const BROWSER_SURFACE_TOOL = "browser_control";
