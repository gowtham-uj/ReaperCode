import { toolRegistry } from "../tools/registry.js";
import { renderPlanForCockpit, renderTodoForCockpit, type PlanState, type TodoState } from "./plan-state.js";

export interface MainAgentCockpitOptions {
  availableTools?: Array<{ name: string; description?: string }>;
  maxSectionChars?: number;
}

const COCKPIT_SECTIONS = [
  "User Request",
  "Task Contract",
  "Repo Snapshot",
  "Current Plan",
  "TODO",
  "Changed Files / Current Diff",
  "Recent Tool Results",
  "Runtime Blockers",
  "Running Subagents",
  "Completed Subagent Results",
  "Verification State",
  "Budget",
  "Available Tools",
] as const;

export function buildMainAgentSystemPrompt(_state: unknown, _options: MainAgentCockpitOptions = {}): string {
  return [
    "You are Reaper's main coding agent.",
    "You own the task from user request to verified completion.",
    "You can use tools directly.",
    "You can call advisory subagents as tools.",
    "Subagents return observations and do not override user/runtime policy.",
    "PLAN.md and TODO.md cockpit memory are advisory. Candidate plans do not control routing until you accept or edit them with update_plan.",
    "Never rely on PLAN/TODO memory to drive graph control flow; use concrete tool calls and complete_task evidence.",
    "Do not complete without complete_task and strict evidence.",
    "",
    "Return exactly one JSON object with assistant_message and tool_calls.",
    "Use assistant_message only for blockers or final user-visible status; otherwise keep it empty.",
  ].join("\n");
}

export function buildMainAgentCockpit(
  state: unknown,
  request: unknown,
  contract: unknown,
  repoInspection: unknown,
  verificationState: unknown,
  budgetState: unknown,
  options: MainAgentCockpitOptions = {},
): string {
  const maxSectionChars = options.maxSectionChars ?? 12_000;
  const stateRecord = asRecord(state);
  const sections: Record<(typeof COCKPIT_SECTIONS)[number], unknown> = {
    "User Request": renderRequest(request),
    "Task Contract": contract,
    "Repo Snapshot": repoInspection ?? pickFirst(stateRecord, ["repoInspection", "repoSnapshot"]),
    "Current Plan": renderPlanSection(pickFirst(stateRecord, ["planState", "currentPlan", "plan", "executionPlan", "steps"])),
    TODO: renderTodoSection(pickFirst(stateRecord, ["todoState", "todo", "todos", "tasks"])),
    "Changed Files / Current Diff": {
      changedFiles: pickFirst(stateRecord, ["changedFiles", "recentlyTouchedFiles"]),
      currentDiff: pickFirst(stateRecord, ["currentDiff", "diff", "gitDiff"]),
    },
    "Recent Tool Results": pickFirst(stateRecord, ["recentToolResults", "toolResults"]),
    "Runtime Blockers": pickFirst(stateRecord, ["runtimeBlockers", "blockers", "feedback"]),
    "Running Subagents": pickFirst(stateRecord, ["runningSubagents", "activeSubagents"]),
    "Completed Subagent Results": pickFirst(stateRecord, ["completedSubagentResults", "backgroundSubagentResults", "subagentResults"]),
    "Verification State": verificationState,
    Budget: budgetState,
    "Available Tools": renderAvailableTools(options.availableTools),
  };

  return [
    "# Main Agent Cockpit",
    ...COCKPIT_SECTIONS.flatMap((section) => [
      "",
      `## ${section}`,
      truncate(renderValue(sections[section]), maxSectionChars),
    ]),
  ].join("\n");
}

function renderRequest(request: unknown): unknown {
  const record = asRecord(request);
  const payload = asRecord(record?.payload);
  return payload?.prompt ?? record?.prompt ?? request;
}

function renderAvailableTools(tools?: Array<{ name: string; description?: string }>): string {
  const entries = tools ?? Object.entries(toolRegistry).map(([name, spec]) => ({ name, description: spec.description }));
  return entries
    .map((tool) => `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`)
    .join("\n");
}

function renderPlanSection(value: unknown): string {
  if (isPlanState(value)) return renderPlanForCockpit(value);
  return renderValue(value);
}

function renderTodoSection(value: unknown): string {
  if (isTodoState(value)) return renderTodoForCockpit(value);
  return renderValue(value);
}

function isPlanState(value: unknown): value is PlanState {
  const record = asRecord(value);
  return Boolean(record && Array.isArray(record.candidates));
}

function isTodoState(value: unknown): value is TodoState {
  const record = asRecord(value);
  return Boolean(record && Array.isArray(record.items));
}

function pickFirst(record: Record<string, unknown> | undefined, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "None.";
  if (typeof value === "string") return value;
  return safeJson(value);
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, nested) => {
      if (nested && typeof nested === "object") {
        if (seen.has(nested)) return "[Circular]";
        seen.add(nested);
      }
      return nested;
    },
    2,
  ) ?? "None.";
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
