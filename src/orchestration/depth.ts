import type { ToolCall } from "../tools/types.js";

export function enforceDelegationDepth(depth: number, maxDepth = 2): void {
  if (!Number.isFinite(depth) || depth < 0) {
    return;
  }
  if (depth > maxDepth) {
    throw new Error(`Delegation depth ${depth} exceeds max depth ${maxDepth}`);
  }
}

export function truncateToolsetForDepth(toolCalls: ToolCall[], depth: number, maxDepth = 2): ToolCall[] {
  if (depth >= maxDepth) {
    return toolCalls.filter((call) => (call.name as string) !== "delegate_to_plan" && (call.name as string) !== "complete_task");
  }

  if (depth > 0) {
    return toolCalls.filter((call) => (call.name as string) !== "delegate_to_plan");
  }

  return toolCalls;
}
