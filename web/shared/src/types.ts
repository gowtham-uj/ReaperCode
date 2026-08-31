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
    }
  | { type: "contextCompaction"; id: string };

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
}

export interface AppThread {
  id: string;
  sessionId?: string;
  preview?: string;
  ephemeral?: boolean;
  cwd?: string;
  modelProvider?: string | null;
  model?: string | null;
  createdAt?: string;
  updatedAt?: string;
  name?: string;
  status?: AppThreadStatus;
  approvalPolicy?: string;
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
