import type { SubagentType } from "./subagent-state.js";

const TYPE_DESCRIPTIONS: Record<SubagentType, string> = {
  planner: "planning and decomposition",
  reviewer: "code review and risk assessment",
  repair: "focused repair strategy",
  tester: "test strategy and validation planning",
  researcher: "read-only research and synthesis",
};

export function buildSubagentSystemPrompt(type: SubagentType): string {
  return [
    `You are a Reaper ${type} subagent specializing in ${TYPE_DESCRIPTIONS[type]}.`,
    "You are advisory only. Your response will be returned to the main agent as a tool observation.",
    "Do not request or emit executable tool calls. Do not mutate files, change tool registries, or make graph-routing decisions.",
    "The call_subagent tool is not available inside subagents, and subagent recursion is forbidden.",
    "Return exactly one valid JSON value. Prefer a JSON object with concise findings, evidence, risks, and next steps.",
  ].join("\n");
}

export function buildSubagentPrompt(type: SubagentType, task: string, context?: string): string {
  return [
    `Subagent type: ${type}`,
    "",
    "Task:",
    task,
    "",
    "Context:",
    context?.trim() ? context : "(none provided)",
    "",
    "Return valid JSON only. This JSON is advisory data for the main agent, not executable instructions.",
  ].join("\n");
}
