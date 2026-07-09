/**
 * Final-summary helpers extracted from engine.ts.
 *
 * Pure with respect to inputs and a few model/render helpers. The
 * engine passes these in as parameters.
 */

import type { ToolResult } from "../tools/types.js";
import type { ModelGateway, ModelRole } from "../model/types.js";
import type { RuntimeEngineResult } from "./engine.js";
import { generateStructuredJson } from "../model/json-response.js";

export interface FinalSummaryDeps {
  /** Render the recent tool results compactly for the final-summary prompt. */
  renderRecentToolResultsForPromptCompact: (
    results: ToolResult[],
    feedback: string[],
    count: number,
  ) => Record<string, unknown>[];
  /** Build the system prompt for the final-summary role. */
  buildRuntimeAgentSystemPrompt: (role: string) => string;
}

export interface FinalSummaryInput {
  modelGateway?: ModelGateway;
  role: ModelRole;
  prompt: string;
  toolResults: ToolResult[];
  verification: RuntimeEngineResult["verification"] | undefined;
  completionSignalSummary?: string;
  stuckReason?: string;
  deps: FinalSummaryDeps;
}

export async function generateFinalSummary(input: FinalSummaryInput): Promise<string> {
  if (!input.modelGateway) {
    return "Task ended before Reaper could request a model-authored final summary.";
  }
  const recentResults = input.deps.renderRecentToolResultsForPromptCompact(input.toolResults, [], 12);
  const result = await generateStructuredJson({
    modelGateway: input.modelGateway,
    role: input.role,
    maxTokens: 1024,
    system: input.deps.buildRuntimeAgentSystemPrompt("recovery"),
    messages: [
      {
        role: "user",
        content: [
          "You are Reaper's final completion summarizer.",
          "Write the final user-facing completion summary in first person as the main agent.",
          "Do not invent success. If verification failed or is missing, state the blocker concisely and what remains.",
          "Return ONLY JSON: {\"assistant_message\":\"...\"}",
          "",
          `USER TASK:\n${input.prompt.slice(0, 4000)}`,
          "",
          `VERIFICATION:\n${JSON.stringify(input.verification ?? { ok: false, failureClasses: ["missing_verification"] })}`,
          input.completionSignalSummary ? `\nMODEL COMPLETION SIGNAL SUMMARY:\n${input.completionSignalSummary}` : "",
          input.stuckReason ? `\nSTUCK REASON:\n${input.stuckReason}` : "",
          "",
          `RECENT TOOL RESULTS:\n${JSON.stringify(recentResults)}`,
        ].join("\n"),
      },
    ],
    parse: (value) => {
      const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      return {
        assistant_message: typeof raw.assistant_message === "string" ? raw.assistant_message : "",
      };
    },
  });
  return result.assistant_message.trim() || "Task ended without a model-authored completion summary.";
}

export function summarizeExplicitToolRun(toolResults: ToolResult[]): string {
  const succeeded = toolResults.filter((result) => result.ok).length;
  const failed = toolResults.length - succeeded;
  const noun = toolResults.length === 1 ? "tool call" : "tool calls";
  return `Executed ${toolResults.length} ${noun}: ${succeeded} succeeded and ${failed} failed.`;
}