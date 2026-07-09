import { compactToolHistory, renderToolResultForModel } from "../context/history-compaction.js";
import { renderSessionSummaryForCockpit, type SessionSummary } from "../context/session-summary.js";
import { toolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import { renderPlanForCockpit, renderTodoForCockpit, type PlanState, type TodoState } from "./plan-state.js";

export interface MainAgentCockpitOptions {
  availableTools?: Array<{ name: string; description?: string }>;
  maxSectionChars?: number;
  workspaceRoot?: string;
}

/** System prompt lives in system-prompt.ts (single source of truth). */
export { buildMainAgentSystemPrompt, MAIN_AGENT_SYSTEM_PROMPT_TEXT, REAPER_MAIN_SYSTEM_PROMPT } from "./system-prompt.js";

/**
 * Cockpit section metadata used to drive prompt-cache-aware layout.
 *
 * Cache tier semantics:
 *
 * - `system` is the role prompt and is stable across every turn. It must
 *   come first so the model can cache it as a prefix.
 * - `stable` sections change only when the underlying state changes
 *   (task contract, repo snapshot, available tools). Place them after
 *   the system prompt so the model can cache them as the next prefix
 *   layer.
 * - `volatile` sections change every turn (user request, recent tool
 *   results, runtime blockers, plan, todo). Place them last so the
 *   cached prefix can be reused as long as the stable layer is intact.
 *
 * Providers that support prompt caching (Anthropic via `cache_control`,
 * OpenAI via implicit prefix caching) benefit from this ordering
 * because each turn the cached prefix up to the volatile boundary is
 * reused without re-tokenizing.
 */
const SYSTEM_TIER_SECTIONS: ReadonlyArray<{ name: string; kind: "system" | "stable" | "volatile" }> = [
  { name: "User Request", kind: "volatile" },
  { name: "Build Task Guidance", kind: "volatile" },
  { name: "Session Summary", kind: "stable" },
  { name: "Task Contract", kind: "stable" },
  { name: "Repo Snapshot", kind: "stable" },
  { name: "Prepared Context", kind: "stable" },
  { name: "Tool Shortlist", kind: "stable" },
  { name: "Skills / Mentions", kind: "stable" },
  { name: "Context Files", kind: "stable" },
  { name: "Current Plan", kind: "volatile" },
  { name: "TODO", kind: "volatile" },
  { name: "Changed Files / Current Diff", kind: "volatile" },
  { name: "Recent Tool Results", kind: "volatile" },
  { name: "Runtime Blockers", kind: "volatile" },
  { name: "Running Subagents", kind: "volatile" },
  { name: "Completed Subagent Results", kind: "volatile" },
  { name: "Verification State", kind: "volatile" },
  { name: "Budget", kind: "volatile" },
  { name: "Available Tools", kind: "stable" },
];

const COCKPIT_SECTIONS = SYSTEM_TIER_SECTIONS.map((section) => section.name) as readonly string[];

export function cockpitSectionKind(name: string): "system" | "stable" | "volatile" | undefined {
  for (const section of SYSTEM_TIER_SECTIONS) {
    if (section.name === name) return section.kind;
  }
  return undefined;
}

export interface CockpitTier {
  kind: "system" | "stable" | "volatile";
  text: string;
}

export interface CockpitLayout {
  system: string;
  stable: string;
  volatile: string;
  /** Tiers already joined with blank lines — suitable as the model's input message body. */
  combined: string;
  /** Per-section rendering for the cockpit UI / debugging. */
  sections: Array<{ name: string; kind: "system" | "stable" | "volatile"; text: string }>;
}

export function buildMainAgentCockpitLayout(
  state: unknown,
  request: unknown,
  contract: unknown,
  repoInspection: unknown,
  verificationState: unknown,
  budgetState: unknown,
  options: MainAgentCockpitOptions = {},
): CockpitLayout {
  const built = buildMainAgentCockpit(state, request, contract, repoInspection, verificationState, budgetState, options);
  const sections = parseCockpitSections(built);
  const byKind: Record<"system" | "stable" | "volatile", string[]> = {
    system: [],
    stable: [],
    volatile: [],
  };
  for (const section of sections) byKind[section.kind].push(section.text);
  const system = byKind.system.join("\n\n");
  const stable = byKind.stable.join("\n\n");
  const volatile = byKind.volatile.join("\n\n");
  return {
    system,
    stable,
    volatile,
    combined: [system, stable, volatile].filter((text) => text.length > 0).join("\n\n"),
    sections,
  };
}

/**
 * Parse a built cockpit into individual sections with their cache tier.
 * The output is a stable array suitable for prefix-level cache
 * segmentation: the system tier should always be sent first, then the
 * stable tier, then the volatile tier.
 */
function parseCockpitSections(built: string): Array<{ name: string; kind: "system" | "stable" | "volatile"; text: string }> {
  const lines = built.split("\n");
  const result: Array<{ name: string; kind: "system" | "stable" | "volatile"; text: string }> = [];
  let current: { name: string; kind: "system" | "stable" | "volatile"; lines: string[] } | null = null;
  for (const line of lines) {
    const match = line.match(/^## (.+?)$/);
    if (match) {
      if (current) result.push({ name: current.name, kind: current.kind, text: current.lines.join("\n") });
      const name = match[1]!;
      current = { name, kind: cockpitSectionKind(name) ?? "volatile", lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) result.push({ name: current.name, kind: current.kind, text: current.lines.join("\n") });
  return result;
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
  const buildLike = detectBuildLikeTask(request);
  const sections: Record<(typeof COCKPIT_SECTIONS)[number], unknown> = {
    "User Request": renderRequest(request),
    "Build Task Guidance": buildLike
      ? renderBuildTaskGuidance()
      : "None — this is not a build task.",
    // Pi does not have a "Build Progress" section that ranks which
    // package/app area is missing — the model picks the next package itself
    // from the user's prompt. The "Changed Files / Current Diff" section
    // below already gives the model a list of files it has shipped, which
    // is the only signal both Pi and Reaper actually need.
    "Session Summary": renderSessionSummary(pickFirst(stateRecord, ["sessionSummary"])),
    "Task Contract": contract,
    "Repo Snapshot": repoInspection ?? pickFirst(stateRecord, ["repoInspection", "repoSnapshot"]),
    "Prepared Context": renderPreparedContext(pickFirst(stateRecord, ["contentPrep", "preparedContext"])),
    "Tool Shortlist": renderToolShortlist(pickFirst(stateRecord, ["contentPrep", "toolShortlist"])),
    "Skills / Mentions": renderSkillsAndMentions(pickFirst(stateRecord, ["contentPrep"])),
    "Context Files": renderContextFiles(pickFirst(stateRecord, ["contentPrep", "contextFiles"])),
    "Current Plan": renderPlanSection(pickFirst(stateRecord, ["planState", "currentPlan", "plan", "executionPlan", "steps"])),
    TODO: renderTodoSection(pickFirst(stateRecord, ["todoState", "todo", "todos", "tasks"])),
    "Changed Files / Current Diff": {
      changedFiles: renderChangedFiles(pickFirst(stateRecord, ["changedFiles", "recentlyTouchedFiles"]) ?? pickFirst(stateRecord, ["recentToolResults", "toolResults"])),
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

const BUILD_TASK_KEYWORDS = [
  "build",
  "implement",
  "create ",
  "scaffold",
  "monorepo",
  "set up",
  "set up ",
  "add a ",
  "set up the ",
] as const;

/**
 * Detect whether the user request looks like a build / scaffold task
 * (as opposed to a question, an analysis, or a small edit). Build tasks
 * benefit from a build-first checklist; analysis / small-edit tasks do not.
 * The check is intentionally lenient and only used to add an *advisory*
 * "Build Task Guidance" section to the cockpit; it never blocks any tool.
 */
export function detectBuildLikeTask(request: unknown): boolean {
  const record = asRecord(request);
  const payload = asRecord(record?.payload);
  const prompt = typeof payload?.prompt === "string"
    ? payload.prompt
    : typeof record?.prompt === "string"
      ? record.prompt
      : "";
  if (!prompt) return false;
  const lower = prompt.toLowerCase();
  // Numbered feature lists (## Feature 1: ..., 1. ..., - [ ] ...)
  if (/^\s*\d+\.\s/m.test(prompt)) return true;
  if (/^\s*-\s*\[[ x]\]/m.test(prompt)) return true;
  if (/^##\s+feature\s+\d+/im.test(prompt)) return true;
  // Explicit build keywords
  for (const keyword of BUILD_TASK_KEYWORDS) {
    if (lower.includes(keyword)) return true;
  }
  return false;
}

function renderBuildTaskGuidance(): string {
  return [
    "BUILD task: ship the codebase, not a plan.",
    "- Skip update_plan / update_todo; ignore plan/todo cockpit sections.",
    "- First message: short numbered checklist (5–12 artifacts) in assistant_message.",
    "- Prefer many small write_file / file_edit calls; do not re-read files you just wrote.",
    "- bash for install/test/build/smoke only — not cat/ls of your own writes.",
    "- Verify every few writes; run the spec's required commands before the final summary.",
    "- Finish with a concise final assistant_message (files, commands, status) and no tool_calls.",
  ].join("\n");
}

function renderSessionSummary(value: unknown): string {
  if (!value) return "None.";
  return renderSessionSummaryForCockpit(value as SessionSummary | undefined);
}

function renderAvailableTools(tools?: Array<{ name: string; description?: string }>): string {
  const entries = tools ?? Object.entries(toolRegistry).map(([name, spec]) => ({ name, description: spec.description }));
  // Names only — full schemas already ship on the API tools[] surface.
  return entries.map((tool) => `- ${tool.name}`).join("\n");
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

/**
 * Derive a per-file change summary from the run's tool results so the
 * cockpit can show what the model has shipped without making the model
 * re-read each file to verify. This is the dedupe mechanism that breaks
 * the read-amplification loop on long build tasks: instead of calling
 * `read_file` 17 times to "remember" what it wrote, the model can scan
 * the changed-files block at the start of each turn.
 */

function collectMutatedPaths(value: unknown, workspaceRoot?: string): string[] {
  const results = Array.isArray(value) ? value : [];
  const mutationTools = new Set(["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"]);
  const seen = new Set<string>();
  const paths: string[] = [];
  const rootPrefix = workspaceRoot ? workspaceRoot.replace(/\/$/, "") + "/" : undefined;
  for (const result of results) {
    if (!isToolResultLike(result) || !mutationTools.has(result.name) || !result.ok) continue;
    const args = result.args as Record<string, unknown> | undefined;
    const raw = typeof args?.path === "string"
      ? args.path
      : typeof args?.file === "string"
        ? args.file
        : undefined;
    if (!raw) continue;
    const normalized = rootPrefix && raw.startsWith(rootPrefix) ? raw.slice(rootPrefix.length) : raw.replace(/^\.\//, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

function renderChangedFiles(toolResults: unknown): string | unknown {
  if (!Array.isArray(toolResults)) return toolResults;
  const MUTATION_TOOLS = new Set([
    "write_file",
    "replace_in_file",
    "edit_file",
    "replace_symbol",
    "delete_file",
  ]);
  const seen = new Map<string, { tool: string; bytes?: number; ok: boolean }>();
  for (const result of toolResults) {
    if (!isToolResultLike(result)) continue;
    if (!MUTATION_TOOLS.has(result.name)) continue;
    const args = result.args as Record<string, unknown> | undefined;
    const path = typeof args?.path === "string"
      ? args.path
      : typeof args?.file === "string"
        ? args.file
        : undefined;
    if (!path) continue;
    const output = result.output as Record<string, unknown> | undefined;
    const bytes = typeof output?.bytes === "number"
      ? output.bytes
      : typeof output?.bytesStaged === "number"
        ? output.bytesStaged
        : undefined;
    seen.set(path, { tool: result.name, ...(bytes !== undefined ? { bytes } : {}), ok: result.ok });
  }
  if (seen.size === 0) return "No files written yet.";
  const lines: string[] = [];
  for (const [path, info] of seen) {
    const status = info.ok ? "ok" : "FAILED";
    const byteInfo = info.bytes !== undefined ? ` (${info.bytes}B)` : "";
    lines.push(`- ${status}  ${info.tool}  ${path}${byteInfo}`);
  }
  return `Shipped so far (${seen.size} files):\n${lines.join("\n")}`;
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
  const lines: string[] = [];
  if (typeof preparedContext.fingerprint === "string") lines.push(`fingerprint: ${preparedContext.fingerprint}`);
  const summary = preparedContext.summary;
  if (typeof summary === "string" && summary.trim()) lines.push(`summary: ${truncateOneLine(summary, 360)}`);
  const fileTree = Array.isArray(preparedContext.fileTree)
    ? preparedContext.fileTree.filter((path): path is string => typeof path === "string").slice(0, 60)
    : [];
  if (fileTree.length > 0) {
    lines.push(`files (${fileTree.length}${Array.isArray(preparedContext.fileTree) && preparedContext.fileTree.length > fileTree.length ? `/${preparedContext.fileTree.length}` : ""}): ${fileTree.join(", ")}`);
  }
  const chunks = Array.isArray(preparedContext.chunks) ? preparedContext.chunks.slice(0, 4) : [];
  if (chunks.length > 0) {
    lines.push("snippets:");
    for (const chunk of chunks) {
      const c = asRecord(chunk);
      if (!c) continue;
      const path = typeof c.path === "string" ? c.path : "unknown";
      const score = typeof c.score === "number" ? ` score=${Number(c.score.toFixed(3))}` : "";
      const reason = typeof c.reason === "string" && c.reason.trim() ? ` reason=${truncateOneLine(c.reason, 140)}` : "";
      lines.push(`--- ${path}${score}${reason}`);
      if (typeof c.content === "string") lines.push(truncate(c.content.trim(), 1200));
    }
  }
  return lines.length > 0 ? lines.join("\n") : "No prepared context.";
}

function renderToolShortlist(value: unknown): unknown {
  const maybeRecord = asRecord(value);
  const shortlist = Array.isArray(value)
    ? value
    : maybeRecord && Array.isArray(maybeRecord.toolShortlist)
      ? maybeRecord.toolShortlist
      : undefined;
  if (!shortlist) return value;
  const lines = shortlist.slice(0, 24).flatMap((entry) => {
    const record = asRecord(entry);
    if (!record || typeof record.name !== "string") return [];
    const description = typeof record.description === "string" ? ` — ${truncateOneLine(record.description, 180)}` : "";
    const score = typeof record.score === "number" ? ` [${Number(record.score.toFixed(2))}]` : "";
    return [`- ${record.name}${score}${description}`];
  });
  return lines.length > 0 ? lines.join("\n") : "No shortlisted tools.";
}

function renderSkillsAndMentions(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const skills = typeof record.skillsPrompt === "string" || Array.isArray(record.skillsPrompt) ? record.skillsPrompt : undefined;
  const mentions = Array.isArray(record.mentions) ? record.mentions.slice(0, 12) : undefined;
  const envFingerprint = record.environmentFingerprint;
  const resourceTrust = record.resourceTrust;
  const resources = record.resources;
  return {
    ...(skills ? { skillsPrompt: typeof skills === "string" ? truncate(skills, 1500) : skills } : {}),
    ...(mentions && mentions.length ? { mentions } : {}),
    ...(resourceTrust ? { resourceTrust } : {}),
    ...(resources ? { resources: renderResourceSummary(resources) } : {}),
    ...(envFingerprint ? { environmentFingerprint: envFingerprint } : {}),
  };
}

function renderResourceSummary(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const summarize = (items: unknown): unknown => {
    if (!Array.isArray(items)) return items;
    return items.slice(0, 16).map((item) => {
      const r = asRecord(item);
      if (!r) return item;
      return {
        id: r.id,
        enabled: r.enabled,
        scope: asRecord(r.metadata)?.scope,
        source: asRecord(r.metadata)?.source,
        origin: asRecord(r.metadata)?.origin,
        path: r.path,
        ...(r.disabledReason ? { disabledReason: r.disabledReason } : {}),
      };
    });
  };
  return {
    extensions: summarize(record.extensions),
    skills: summarize(record.skills),
    prompts: summarize(record.prompts),
  };
}

function renderContextFiles(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const combined = typeof record.combined === "string" ? record.combined : "";
  if (!combined) return "No context files loaded.";
  return {
    loaded: Array.isArray(record.files) ? record.files.map((f) => asRecord(f)?.source) : [],
    diagnostics: record.diagnostics,
    content: truncate(combined, 8000),
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
