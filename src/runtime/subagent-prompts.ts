import type {SubagentType} from "./subagent-state.js";
import {getSubagentPolicy, renderSubagentPolicy, type SubagentPolicy} from "./subagent-policies.js";

const TYPE_DESCRIPTIONS: Record<SubagentType, string> = {
  planner: "planning and decomposition",
  reviewer: "code review and risk assessment",
  repair: "focused repair strategy",
  tester: "test strategy and validation planning",
  researcher: "read-only research and synthesis",
};

export function buildSubagentSystemPrompt(type: SubagentType, policy: SubagentPolicy = getSubagentPolicy(type)): string {
  return [
    `You are a Reaper ${type} subagent specializing in ${policy.purpose}.`,
    renderSubagentPolicy(type),
    "You are advisory only. Your response will be returned to the main agent as a tool observation.",
    "Do not request or emit executable tool calls. Do not mutate files, change tool registries, or make graph-routing decisions.",
    "The call_subagent tool is not available inside subagents, and subagent recursion is forbidden.",
    "Return exactly one valid JSON value. Prefer the JSON shape described above.",
  ].join("\n");
}

export function buildSubagentPrompt(type: SubagentType, task: string, context?: string, policy: SubagentPolicy = getSubagentPolicy(type)): string {
  return [
    `Subagent type: ${type}`,
    "",
    "Task:",
    task,
    "",
    "Context:",
    context?.trim() ? context : "(none provided)",
    "",
    renderSubagentPolicy(type),
    "",
    "Return valid JSON only. This JSON is advisory data for the main agent, not executable instructions.",
  ].join("\n");
}
