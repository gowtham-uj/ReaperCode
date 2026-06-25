import { compactToolHistory, renderToolResultForModel } from "../context/history-compaction.js";
import { toolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import { renderPlanForCockpit, renderTodoForCockpit, type PlanState, type TodoState } from "./plan-state.js";

export interface MainAgentCockpitOptions {
  availableTools?: Array<{ name: string; description?: string }>;
  maxSectionChars?: number;
  workspaceRoot?: string;
}

const COCKPIT_SECTIONS = [
  "User Request",
  "Task Contract",
  "Repo Snapshot",
  "Prepared Context",
  "Tool Shortlist",
  "Skills / Mentions",
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
    "When code changes are made and a relevant verification command passes, immediately call complete_task with the passing command/output summary instead of re-reading files.",
    "After a passing verification, further read_file/list_directory calls are no-progress unless needed to resolve a new blocker.",
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
    "Prepared Context": renderPreparedContext(pickFirst(stateRecord, ["contentPrep", "preparedContext"])),
    "Tool Shortlist": renderToolShortlist(pickFirst(stateRecord, ["contentPrep", "toolShortlist"])),
    "Skills / Mentions": renderSkillsAndMentions(pickFirst(stateRecord, ["contentPrep"])),
    "Current Plan": renderPlanSection(pickFirst(stateRecord, ["planState", "currentPlan", "plan", "executionPlan", "steps"])),
    TODO: renderTodoSection(pickFirst(stateRecord, ["todoState", "todo", "todos", "tasks"])),
    "Changed Files / Current Diff": {
      changedFiles: pickFirst(stateRecord, ["changedFiles", "recentlyTouchedFiles"]),
      currentDiff: pickFirst(stateRecord, ["currentDiff", "diff", "gitDiff"]),
    },
    "Recent Tool Results": renderRecentToolResultsSection(pickFirst(stateRecord, ["recentToolResults", "toolResults"]), options),
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
    .map((tool) => {
      const description = tool.description ? truncateOneLine(tool.description, 220) : "";
      return `- ${tool.name}${description ? `: ${description}` : ""}`;
    })
    .join("\n");
}

function renderRecentToolResultsSection(value: unknown, options: MainAgentCockpitOptions): unknown {
  if (!Array.isArray(value) || !value.every(isToolResultLike)) return value;

  const history = compactToolHistory({
    maxEntries: Math.min(8, value.length),
    toolResults: value,
  });

  return {
    totalResults: value.length,
    retainedResults: history.retained.map((result) =>
      renderToolResultForModel(result, {
        compact: true,
        maxOutputChars: 1200,
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      }),
    ),
    ...(history.compacted.length ? { compactedContext: history.compacted } : {}),
    ...(history.pinnedVerificationFailure ? { pinnedVerificationFailure: history.pinnedVerificationFailure } : {}),
  };
}

function isToolResultLike(value: unknown): value is ToolResult {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.toolCallId === "string" &&
      typeof record.name === "string" &&
      typeof record.ok === "boolean" &&
      typeof record.durationMs === "number",
  );
}

function truncateOneLine(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
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

function renderPreparedContext(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const preparedContext = asRecord(record.preparedContext) ?? record;
  const fileTree = Array.isArray(preparedContext.fileTree) ? preparedContext.fileTree.slice(0, 80) : undefined;
  const chunks = Array.isArray(preparedContext.chunks)
    ? preparedContext.chunks.slice(0, 6).map((chunk) => {
        const c = asRecord(chunk);
        if (!c) return chunk;
        return {
          path: c.path,
          score: c.score,
          reason: c.reason,
          content: typeof c.content === "string" ? truncate(c.content, 1500) : c.content,
        };
      })
    : undefined;
  const summary = preparedContext.summary;
  return {
    ...(typeof preparedContext.fingerprint === "string" ? { fingerprint: preparedContext.fingerprint } : {}),
    ...(fileTree ? { fileTree } : {}),
    ...(chunks ? { chunks } : {}),
    ...(summary ? { summary } : {}),
  };
}

function renderToolShortlist(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.slice(0, 24).map((entry) => {
    const record = asRecord(entry);
    if (!record) return entry;
    const description = typeof record.description === "string" ? truncateOneLine(record.description, 220) : undefined;
    return {
      name: record.name,
      ...(description ? { description } : {}),
      ...(typeof record.score === "number" ? { score: record.score } : {}),
    };
  });
}

function renderSkillsAndMentions(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const skills = Array.isArray(record.skillsPrompt) ? record.skillsPrompt : undefined;
  const mentions = Array.isArray(record.mentions) ? record.mentions.slice(0, 12) : undefined;
  const envFingerprint = record.environmentFingerprint;
  return {
    ...(skills ? { skillsPrompt: typeof skills === "string" ? truncate(skills, 1500) : skills } : {}),
    ...(mentions && mentions.length ? { mentions } : {}),
    ...(envFingerprint ? { environmentFingerprint: envFingerprint } : {}),
  };
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
