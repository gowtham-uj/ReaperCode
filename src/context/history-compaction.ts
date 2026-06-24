import type { ToolResult } from "../tools/types.js";
import { microcompact } from "./compaction/microcompact.js";
import { reactiveCompact } from "./compaction/reactive-compact.js";
import { classifyReadFileTrust, classifyToolResultTrust, markTrust } from "./trust.js";

export interface HistoryCompactionInput {
  maxEntries: number;
  latestVerificationFailure?: string | undefined;
  toolResults: ToolResult[];
  /** Enable multi-strategy compaction pipeline (default true) */
  enableStrategies?: boolean | undefined;
}

export interface CompactedHistory {
  compacted: string[];
  retained: ToolResult[];
  pinnedVerificationFailure?: string;
}

export function compactToolHistory(input: HistoryCompactionInput): CompactedHistory {
  const enableStrategies = input.enableStrategies !== false;
  let workingResults = input.toolResults;

  // Phase 1: Microcompact - lightweight in-process reduction
  if (enableStrategies) {
    const micro = microcompact({ toolResults: workingResults });
    workingResults = micro.toolResults;
  }

  // Phase 2: Reactive compact - drop low-importance groups
  if (enableStrategies) {
    const reactive = reactiveCompact({ toolResults: workingResults });
    workingResults = reactive.toolResults;
  }

  // Phase 3: Traditional compact - summarize remaining middle entries
  return traditionalCompact({
    maxEntries: input.maxEntries,
    toolResults: workingResults,
    latestVerificationFailure: input.latestVerificationFailure,
  });
}

function traditionalCompact(input: HistoryCompactionInput): CompactedHistory {
  const writeTools = new Set(["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file", "run_shell_command"]);
  const maxEntries = Math.max(0, input.maxEntries);
  const fileOpsSummary = summarizeFileOps(input.toolResults);
  const latestFailureSummary = summarizeLatestFailure(input.toolResults);

  let lastWriteIndex = -1;
  for (let i = input.toolResults.length - 1; i >= 0; i--) {
    const r = input.toolResults[i]!;
    if (
      r.ok &&
      writeTools.has(r.name) &&
      (r.name !== "run_shell_command" ||
        /\b(mkdir|touch|rm|mv|cp|npm|yarn|pnpm|cargo|pip|go|prisma|npx|generate)\b/.test(
          (r.output as any)?.cmd?.toLowerCase() || "",
        ))
    ) {
      lastWriteIndex = i;
      break;
    }
  }

  const total = input.toolResults.length;
  if (total <= maxEntries) {
    return {
      compacted: [
        ...(fileOpsSummary ? [fileOpsSummary] : []),
        ...(latestFailureSummary ? [latestFailureSummary] : []),
      ],
      retained: input.toolResults,
      ...(input.latestVerificationFailure ? { pinnedVerificationFailure: input.latestVerificationFailure } : {}),
    };
  }

  if (maxEntries === 0) {
    return {
      compacted: [
        ...(fileOpsSummary ? [fileOpsSummary] : []),
        ...(latestFailureSummary ? [latestFailureSummary] : []),
        ...compactRepeatedObservations(
          input.toolResults.map((result, index) => {
            const isStale = index < lastWriteIndex && ["read_file", "view_file", "list_directory", "grep_search", "skim_file"].includes(result.name);
            const prefix = isStale ? "[STALE Observation]" : "[Observation]";
            return `${prefix} ${summarizeToolResult(result, 600)}`;
          }),
        ),
      ],
      retained: [],
      ...(input.latestVerificationFailure ? { pinnedVerificationFailure: input.latestVerificationFailure } : {}),
    };
  }

  // Surrounding Context Pattern: keep a small prefix and the most recent entries.
  const firstCount = Math.min(5, Math.max(0, Math.floor(maxEntries / 3)));
  const lastCount = maxEntries - firstCount;

  let retained: ToolResult[];
  let compacted: string[];

  const firstPart = firstCount > 0 ? input.toolResults.slice(0, firstCount) : [];
  const middleEnd = lastCount > 0 ? -lastCount : undefined;
  const middlePart = input.toolResults.slice(firstCount, middleEnd);
  const lastPart = lastCount > 0 ? input.toolResults.slice(-lastCount) : [];

  retained = [...firstPart, ...lastPart];

  // Aggressively limit the number of compacted summaries to the last 20 middle items.
  const truncatedMiddle = middlePart.slice(-20);
  compacted = compactRepeatedObservations(
    truncatedMiddle.map((result, idx) => {
      const actualIdx = idx + (middlePart.length - truncatedMiddle.length) + firstCount;
      const isStale = actualIdx < lastWriteIndex && ["read_file", "view_file", "list_directory", "grep_search", "skim_file"].includes(result.name);
      const prefix = isStale ? "[STALE Observation]" : "[Observation]";
      return `${prefix} ${summarizeToolResult(result, 600)}`;
    }),
  );

  if (middlePart.length > truncatedMiddle.length) {
    compacted.unshift(`[Compacted ${middlePart.length - truncatedMiddle.length} older observations to save context]`);
  }
  if (fileOpsSummary) {
    compacted.unshift(fileOpsSummary);
  }
  if (latestFailureSummary) {
    compacted.unshift(latestFailureSummary);
  }

  return {
    compacted,
    retained,
    ...(input.latestVerificationFailure ? { pinnedVerificationFailure: input.latestVerificationFailure } : {}),
  };
}

function summarizeLatestFailure(results: ToolResult[]): string | undefined {
  const latest = [...results].reverse().find((result) => !result.ok);
  return latest ? `[Context Memory: latest failure] ${summarizeToolResult(latest, 900)}` : undefined;
}

function compactRepeatedObservations(observations: string[]): string[] {
  const compacted: string[] = [];
  let previous = "";
  let repeated = 0;
  const flush = () => {
    if (!previous) return;
    compacted.push(repeated > 1 ? `[Repeated Observation x${repeated}] ${previous}` : previous);
  };

  for (const observation of observations) {
    if (observation === previous) {
      repeated += 1;
      continue;
    }
    flush();
    previous = observation;
    repeated = 1;
  }
  flush();
  return compacted;
}

function summarizeFileOps(results: ToolResult[]): string | undefined {
  const read = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();
  for (const result of results) {
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const path = typeof args.path === "string" ? args.path : undefined;
    if (!path) continue;
    if (["read_file", "view_file", "skim_file"].includes(result.name)) read.add(path);
    if (["write_file", "replace_in_file", "edit_file", "replace_symbol"].includes(result.name)) modified.add(path);
    if (result.name === "delete_file") deleted.add(path);
  }
  const parts = [
    read.size ? `read=${[...read].slice(-30).join(", ")}` : "",
    modified.size ? `modified=${[...modified].slice(-30).join(", ")}` : "",
    deleted.size ? `deleted=${[...deleted].slice(-30).join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? `[Context Memory: file operations] ${parts.join(" | ")}` : undefined;
}

export function summarizeToolResult(result: ToolResult, maxChars = 1200): string {
  const base = result.ok
    ? `${result.name} succeeded in ${result.durationMs}ms`
    : `${result.name} failed in ${result.durationMs}ms: ${result.error?.message ?? "unknown error"}`;
  const preview = result.ok ? previewValue(result.output, maxChars) : result.error?.message;
  // Phase T2.5: prompt-injection defense. External-content tools
  // (web_search / web_fetch / MCP) get their preview wrapped in
  // untrusted-content markers so the model can structurally
  // distinguish "data" from "instruction". Trusted tools (workspace
  // reads, shell commands) pass through unmarked.
  const trust = classifyToolResultTrust(result);
  const sourceLabel = `tool ${result.name}`;
  const wrappedPreview = preview ? markTrust(preview, trust, sourceLabel) : preview;
  return wrappedPreview ? `${base}. Output: ${wrappedPreview}` : base;
}

function previewValue(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  if (!rendered) {
    return undefined;
  }
  return truncateMiddle(rendered, maxChars);
}

export interface RenderToolResultForModelOptions {
  compact?: boolean;
  maxOutputChars?: number;
  /**
   * Phase T2.5: workspace root used by `classifyReadFileTrust` to
   * distinguish in-workspace file reads (trusted) from
   * out-of-workspace reads (untrusted). When omitted, the
   * `read_file` family falls back to the tool-name-only heuristic
   * (trusted). Always pass this from the engine so external reads
   * are correctly classified.
   */
  workspaceRoot?: string;
}

export function renderToolResultForModel(result: ToolResult, options: RenderToolResultForModelOptions = {}): Record<string, unknown> {
  const output = renderOutputForModel(result.output, result, options);
  const workspacePathAliases = collectWorkspacePathAliases(result, output);
  return {
    toolCallId: result.toolCallId,
    name: result.name,
    ok: result.ok,
    durationMs: result.durationMs,
    ...(output !== undefined ? output : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(workspacePathAliases ? { workspacePathAliases } : {}),
  };
}

function collectWorkspacePathAliases(result: ToolResult, renderedOutput: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const hostRoot = stripTrailingSlashes(process.env.REAPER_TBENCH_HOST_WORKSPACE ?? "");
  const aliasRoot = (process.env.REAPER_WORKSPACE_PATH_ALIASES ?? "")
    .split(/[:;]/)
    .map((item) => stripTrailingSlashes(item.trim()))
    .find((item) => item.startsWith("/"));
  if (!hostRoot || !aliasRoot || hostRoot === aliasRoot) return undefined;

  const aliases = new Map<string, string>([[hostRoot, aliasRoot]]);
  const hostPathPattern = new RegExp(`${escapeRegExp(hostRoot)}(?:/[A-Za-z0-9._~+=,@%:-]+)*`, "g");
  const visit = (value: unknown): void => {
    if (aliases.size >= 12) return;
    if (typeof value === "string") {
      for (const match of value.matchAll(hostPathPattern)) {
        if (aliases.size >= 12) break;
        aliases.set(match[0], `${aliasRoot}${match[0].slice(hostRoot.length)}`);
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const item of Object.values(value as Record<string, unknown>)) visit(item);
  };

  visit(result.args);
  visit(result.output);
  visit(result.error);
  visit(renderedOutput);
  return aliases.size > 1 ? Object.fromEntries(aliases) : undefined;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderOutputForModel(
  output: unknown,
  result: ToolResult,
  options: RenderToolResultForModelOptions,
): Record<string, unknown> | undefined {
  if (output === undefined) {
    return undefined;
  }

  if (options.compact) {
    return renderCompactOutputForModel(output, result, options.maxOutputChars ?? 1800);
  }

  // Phase T2.5: classify trust and wrap string output with markers
  // for external-content tools. MCP, web_search, web_fetch, and
  // out-of-workspace read_file are marked untrusted. Object output
  // (e.g. read_file with structured metadata) is rendered as JSON
  // and the JSON itself is wrapped — the marker boundary is the
  // string level since the model sees the rendered string.
  const trust = options.workspaceRoot
    ? classifyReadFileTrust(result, options.workspaceRoot)
    : classifyToolResultTrust(result);
  const sourceLabel = `tool ${result.name}`;
  const wrap = (s: string): string => markTrust(s, trust, sourceLabel);

  const rendered = typeof output === "string" ? output : JSON.stringify(output);
  if (rendered.length <= 6000) {
    return { output: trust === "untrusted" && typeof output === "string" ? wrap(rendered) : output };
  }

  const metadata =
    output && typeof output === "object"
      ? Object.fromEntries(
          Object.entries(output as Record<string, unknown>).filter(([key]) =>
            ["path", "absolutePath", "artifactId", "artifactBytes", "artifactSha256", "truncated", "pid", "status", "exitCode"].includes(key),
          ),
        )
      : {};

  return {
    outputPreview: wrap(truncateMiddle(rendered, 6000)),
    outputTruncatedForModel: true,
    ...metadata,
  };
}

function renderCompactOutputForModel(output: unknown, result: ToolResult, maxChars: number): Record<string, unknown> {
  const metadata = output && typeof output === "object" ? extractModelMetadata(output as Record<string, unknown>) : {};
  if (result.name === "read_file" && output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : metadata.path;
    const startLine = record.startLine;
    const endLine = record.endLine;
    const content = typeof record.content === "string" ? record.content : "";
    return {
      ...metadata,
      ...(path ? { path } : {}),
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      outputPreview: truncateMiddle(content, Math.min(maxChars, 1400)),
      outputCompactedForModel: true,
      contextInstruction:
        "Large read_file content was compacted. If exact code is needed, use grep_search or read_file with a narrow line range around the cited symbol/diagnostic.",
    };
  }

  if (result.name === "run_shell_command" && output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    const stdout = typeof record.stdout === "string" ? record.stdout : "";
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    const combined = [
      stdout ? `stdout:\n${stdout}` : "",
      stderr ? `stderr:\n${stderr}` : "",
    ].filter(Boolean).join("\n\n");
    return {
      ...metadata,
      cmd: typeof (result.args as Record<string, unknown> | undefined)?.cmd === "string" ? (result.args as Record<string, unknown>).cmd : undefined,
      exitCode: record.exitCode,
      wouldBlock: record.wouldBlock,
      outputPreview: truncateMiddle(combined, maxChars),
      outputCompactedForModel: combined.length > maxChars,
    };
  }

  const rendered = typeof output === "string" ? output : JSON.stringify(output);
  return {
    ...metadata,
    outputPreview: truncateMiddle(rendered, maxChars),
    outputCompactedForModel: rendered.length > maxChars,
  };
}

function extractModelMetadata(output: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(output).filter(([key]) =>
      ["path", "absolutePath", "artifactId", "artifactBytes", "artifactSha256", "truncated", "pid", "status", "exitCode", "startLine", "endLine"].includes(key),
    ),
  );
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const notice = "\n...[middle truncated for context budget]...\n";
  if (maxChars <= notice.length) return notice.slice(0, maxChars);
  const remaining = maxChars - notice.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${value.slice(0, head)}${notice}${value.slice(-tail)}`;
}
