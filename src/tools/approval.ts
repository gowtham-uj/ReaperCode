import type { PermissionMode } from "../policy/classifier.js";
import type { ToolCall } from "./types.js";

export type ToolApprovalDecision = "approved" | "denied" | "cancelled" | "timeout";

export interface ToolApprovalRequest {
  approvalId: string;
  runId: string;
  sessionId: string;
  toolCall: ToolCall;
  workspaceRoot: string;
  workingDirectory: string;
  permissionMode: PermissionMode;
  reason: string;
  ruleMatch?: string;
}

export interface ToolApprovalRequester {
  requestApproval(request: ToolApprovalRequest, signal?: AbortSignal): Promise<ToolApprovalDecision>;
}
