import type { ToolCall } from "../tools/types.js";

export interface CompletionToolCall {
  id: string;
  name: "complete_task";
  args: {
    summary: string;
    confidence?: "high" | "low" | undefined;
    clarification?: string | undefined;
    known_issues?: string[] | undefined;
    verificationContract?: {
      intent?: string | undefined;
      commands?: Array<{ id?: string | undefined; command: string; purpose?: string | undefined; required?: boolean | undefined }> | undefined;
      expectedArtifacts?: string[] | undefined;
    } | undefined;
  };
}

function isCompletionToolCall(call: ToolCall): call is ToolCall & CompletionToolCall {
  return call.name === "complete_task" && typeof (call as CompletionToolCall).args?.summary === "string";
}

export function getCompletionSummary(toolCalls: ToolCall[]): string | undefined {
  const completion = toolCalls.find(isCompletionToolCall);
  return completion?.args.summary;
}

export function isLowConfidenceCompletion(completion: CompletionToolCall): boolean {
  return (
    completion.args.confidence === "low" ||
    Boolean(completion.args.clarification?.trim()) ||
    Boolean(completion.args.known_issues?.length)
  );
}
