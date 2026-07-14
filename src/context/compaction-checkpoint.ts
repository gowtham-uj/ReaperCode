import { createHash } from "node:crypto";

import { redactSecrets } from "../adaptive/redact.js";

export const COMPACTION_CHECKPOINT_MESSAGE_NAME = "reaper_compaction_checkpoint";
export const COMPACTION_SUMMARY_MESSAGE_NAME = "reaper_compaction_summary";
export const COMPACTION_CHECKPOINT_PREFIX = "[Reaper session checkpoint v1]";
export const COMPACTION_SUMMARY_PREFIX = "Summary of prior context:";

const GENERATED_CONTEXT_PREFIXES = [
  "[Reaper context boundary]",
  "# Prior session context (compacted)",
  COMPACTION_CHECKPOINT_PREFIX,
  COMPACTION_SUMMARY_PREFIX,
  "[Post-compact progress]",
  "[Post-compact re-anchor]",
  "[Re-attached deferred tools]",
  "[Runtime verification failed]",
  "Your previous tool_calls were rejected by the runtime schema",
  "Your previous response promised a concrete action but emitted no structured tool_calls",
  "Your previous turn returned no tool_calls and an empty assistant_message",
];

const FILE_TOOLS = new Set([
  "file_view",
  "file_scroll",
  "file_find",
  "read_file",
  "view_file",
  "file_edit",
  "write_file",
  "replace_in_file",
]);

export interface CompactionFileObservation {
  path: string;
  sha256?: string;
  startLine?: number;
  endLine?: number;
}

export interface CompactionCheckpoint {
  schemaVersion: 1;
  epoch: number;
  originalTask: string;
  currentTask: string;
  goldenFacts: string[];
  completedSteps: string[];
  decisions: string[];
  failures: string[];
  files: CompactionFileObservation[];
  nextAction: string;
  summarySha256: string;
}

export interface CompactionCheckpointOptions {
  goldenFactsMaxChars?: number;
  maxFiles?: number;
}

export interface CompactionMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: unknown };
  }>;
}

export interface SummaryEpochInput {
  epoch: number;
  priorSummary?: string;
  priorCheckpoint?: CompactionCheckpoint;
  deltaMessages: CompactionMessage[];
}

function stringContent(message: CompactionMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

function stripHarnessPreamble(value: string): string {
  const cockpitRequest = /(?:^|\n)## User Request\s*\n([\s\S]*?)(?=\n## |\s*$)/.exec(value);
  if (cockpitRequest?.[1]?.trim()) return cockpitRequest[1].trim();
  const promptMarker = /(?:^|\n)\s*User prompt:\s*\n?/i.exec(value);
  if (promptMarker) {
    const after = value.slice(promptMarker.index + promptMarker[0].length).trim();
    if (after) return after;
  }
  return value.replace(/\[(?:exec|end exec) environment[^\]]*\]/gi, "").trim() || value;
}

function isGeneratedContextMessage(message: CompactionMessage): boolean {
  if (
    message.name === COMPACTION_CHECKPOINT_MESSAGE_NAME ||
    message.name === COMPACTION_SUMMARY_MESSAGE_NAME
  ) {
    return true;
  }
  const content = stringContent(message).trimStart();
  return GENERATED_CONTEXT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

function findUserTask(messages: CompactionMessage[], fromEnd: boolean): string {
  const indices = Array.from({ length: messages.length }, (_, index) => index);
  if (fromEnd) indices.reverse();
  for (const index of indices) {
    const message = messages[index];
    if (!message || message.role !== "user" || isGeneratedContextMessage(message)) continue;
    const content = stringContent(message).trim();
    if (!content) continue;
    return stripHarnessPreamble(content);
  }
  return "";
}

function normalizeBoundedLine(value: string, maxChars = 320): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function uniqueBounded(values: string[], maxItems: number, maxCharsPerItem = 320): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeBoundedLine(value, maxCharsPerItem);
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function parseSummarySections(summary: string): Map<number, string> {
  const sections = new Map<number, string>();
  const matches = [...summary.matchAll(/^\s*([1-9])\.\s+[^\n]+\n?/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const sectionNumber = Number(match[1]);
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1]!.index ?? summary.length) : summary.length;
    sections.set(sectionNumber, summary.slice(start, end).trim());
  }
  return sections;
}

function sectionLines(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
}

function redactFact(value: string): string {
  return redactSecrets(value).redacted;
}

function extractGoldenFactCandidates(messages: CompactionMessage[], summary: string): string[] {
  const candidates: string[] = [];
  const taggedFact = /<golden-fact>([\s\S]*?)<\/golden-fact>/gi;
  const signal = /\b(codeword|passcode|golden fact|must survive|must remember|acceptance criteri(?:on|a)|critical (?:decision|invariant|fact)|root cause)\b/i;

  for (const message of messages) {
    if (message.role !== "user" || isGeneratedContextMessage(message)) continue;
    const content = stripHarnessPreamble(stringContent(message));
    for (const match of content.matchAll(taggedFact)) candidates.push(match[1] ?? "");
    for (const line of content.split(/\r?\n|(?<=[.!?])\s+(?=[A-Z0-9])/)) {
      if (signal.test(line)) candidates.push(line);
    }
  }
  for (const match of summary.matchAll(taggedFact)) candidates.push(match[1] ?? "");
  for (const line of summary.split(/\r?\n|(?<=[.!?])\s+(?=[A-Z0-9])/)) {
    if (signal.test(line)) candidates.push(line);
  }
  return candidates.map(redactFact).filter(Boolean);
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function pathFromArgs(args: unknown): string | undefined {
  const parsed = parseJsonObject(args);
  const value = parsed?.path ?? parsed?.file ?? parsed?.file_path ?? parsed?.filename;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numericField(record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  }
  return undefined;
}

function stringField(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function collectFileObservations(
  messages: CompactionMessage[],
  prior: CompactionFileObservation[],
  maxFiles: number,
): CompactionFileObservation[] {
  const callMeta = new Map<string, { path: string; name: string }>();
  const collected: CompactionFileObservation[] = [];

  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      const name = call.function?.name ?? "";
      if (!FILE_TOOLS.has(name)) continue;
      const filePath = pathFromArgs(call.function?.arguments);
      if (!filePath) continue;
      if (call.id) callMeta.set(call.id, { path: filePath, name });
      collected.push({ path: filePath });
    }
    if (message.role !== "tool") continue;
    const output = parseJsonObject(message.content);
    const metadata = message.tool_call_id ? callMeta.get(message.tool_call_id) : undefined;
    const filePath = metadata?.path ?? stringField(output, "path", "file", "filePath");
    if (!filePath) continue;
    const sha256 = stringField(output, "sha256", "sha");
    const startLine = numericField(output, "startLine", "start_line");
    const endLine = numericField(output, "endLine", "end_line");
    collected.push({
      path: filePath,
      ...(sha256 ? { sha256 } : {}),
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
    });
  }

  const out: CompactionFileObservation[] = [];
  const seen = new Set<string>();
  for (const observation of [...prior, ...collected].reverse()) {
    const key = observation.path.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(observation);
    if (out.length >= maxFiles) break;
  }
  return out.reverse();
}

function normalizeCheckpoint(value: unknown): CompactionCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.epoch !== "number") return null;
  if (typeof record.originalTask !== "string" || typeof record.summarySha256 !== "string") return null;
  const strings = (key: string): string[] =>
    Array.isArray(record[key]) ? (record[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
  const files = Array.isArray(record.files)
    ? (record.files as unknown[])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .filter((item) => typeof item.path === "string")
        .map((item) => ({
          path: item.path as string,
          ...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}),
          ...(typeof item.startLine === "number" ? { startLine: item.startLine } : {}),
          ...(typeof item.endLine === "number" ? { endLine: item.endLine } : {}),
        }))
    : [];
  return {
    schemaVersion: 1,
    epoch: Math.max(1, Math.floor(record.epoch)),
    originalTask: record.originalTask,
    currentTask: typeof record.currentTask === "string" ? record.currentTask : record.originalTask,
    goldenFacts: strings("goldenFacts"),
    completedSteps: strings("completedSteps"),
    decisions: strings("decisions"),
    failures: strings("failures"),
    files,
    nextAction: typeof record.nextAction === "string" ? record.nextAction : "",
    summarySha256: record.summarySha256,
  };
}

function sanitizeCheckpoint(checkpoint: CompactionCheckpoint): CompactionCheckpoint {
  return {
    ...checkpoint,
    originalTask: redactFact(checkpoint.originalTask),
    currentTask: redactFact(checkpoint.currentTask),
    goldenFacts: checkpoint.goldenFacts.map(redactFact),
    completedSteps: checkpoint.completedSteps.map(redactFact),
    decisions: checkpoint.decisions.map(redactFact),
    failures: checkpoint.failures.map(redactFact),
    files: checkpoint.files.map((file) => ({ ...file, path: redactFact(file.path) })),
    nextAction: redactFact(checkpoint.nextAction),
  };
}

export function parseCompactionCheckpoint(message: CompactionMessage): CompactionCheckpoint | null {
  if (message.name !== COMPACTION_CHECKPOINT_MESSAGE_NAME) return null;
  const content = stringContent(message);
  if (!content.startsWith(COMPACTION_CHECKPOINT_PREFIX)) return null;
  const json = content.slice(COMPACTION_CHECKPOINT_PREFIX.length).trim();
  const checkpoint = normalizeCheckpoint(parseJsonObject(json));
  return checkpoint ? sanitizeCheckpoint(checkpoint) : null;
}

export function findLatestCompactionCheckpoint(messages: CompactionMessage[]): CompactionCheckpoint | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const checkpoint = parseCompactionCheckpoint(messages[index]!);
    if (checkpoint) return checkpoint;
  }
  return undefined;
}

export function renderCompactionCheckpoint(checkpoint: CompactionCheckpoint): string {
  return `${COMPACTION_CHECKPOINT_PREFIX}\n${JSON.stringify(sanitizeCheckpoint(checkpoint), null, 2)}`;
}

export function buildCompactionCheckpoint(
  summary: string,
  messages: CompactionMessage[],
  options: CompactionCheckpointOptions = {},
): CompactionCheckpoint {
  const previous = findLatestCompactionCheckpoint(messages);
  const sections = parseSummarySections(summary);
  const goldenFactsMaxChars = Math.max(0, options.goldenFactsMaxChars ?? 4_000);
  const goldenCandidates = [
    ...(previous?.goldenFacts ?? []),
    ...extractGoldenFactCandidates(messages, summary),
  ];
  const goldenFacts: string[] = [];
  let goldenChars = 0;
  for (const fact of uniqueBounded(goldenCandidates, 20, 500)) {
    if (goldenChars + fact.length > goldenFactsMaxChars) break;
    goldenFacts.push(fact);
    goldenChars += fact.length;
  }

  const originalTask = previous?.originalTask || findUserTask(messages, false);
  const currentTask = findUserTask(messages, true) || previous?.currentTask || originalTask;
  const completedSteps = uniqueBounded(
    [
      ...sectionLines(sections.get(8)),
      ...sectionLines(sections.get(3)).filter((line) => /\b(done|complete|implemented|fixed|wrote|created|passed|verified|updated|removed|added)\b/i.test(line)),
    ],
    10,
  );
  const decisions = uniqueBounded(sectionLines(sections.get(2)), 8);
  const failures = uniqueBounded(sectionLines(sections.get(4)), 8);
  const nextAction = normalizeBoundedLine(sectionLines(sections.get(9))[0] ?? "", 500);
  const files = collectFileObservations(messages, previous?.files ?? [], Math.max(1, options.maxFiles ?? 20));

  return sanitizeCheckpoint({
    schemaVersion: 1,
    epoch: (previous?.epoch ?? 0) + 1,
    originalTask,
    currentTask,
    goldenFacts,
    completedSteps,
    decisions,
    failures,
    files,
    nextAction,
    summarySha256: createHash("sha256").update(summary).digest("hex"),
  });
}

function extractSummaryContent(message: CompactionMessage): string | undefined {
  const content = stringContent(message);
  if (message.name === COMPACTION_SUMMARY_MESSAGE_NAME && content.startsWith(COMPACTION_SUMMARY_PREFIX)) {
    return content.slice(COMPACTION_SUMMARY_PREFIX.length).trim();
  }
  if (content.startsWith(COMPACTION_SUMMARY_PREFIX)) {
    return content.slice(COMPACTION_SUMMARY_PREFIX.length).trim();
  }
  if (content.startsWith("# Prior session context (compacted)")) {
    const marker = "Treat this summary as the authoritative record of everything before the turns that follow.";
    const markerIndex = content.indexOf(marker);
    if (markerIndex >= 0) return content.slice(markerIndex + marker.length).trim();
  }
  return undefined;
}

export function splitSummaryEpoch(messages: CompactionMessage[]): SummaryEpochInput {
  let summaryIndex = -1;
  let priorSummary: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const extracted = extractSummaryContent(messages[index]!);
    if (!extracted) continue;
    summaryIndex = index;
    priorSummary = extracted;
    break;
  }
  const priorCheckpoint = findLatestCompactionCheckpoint(messages);
  const source = summaryIndex >= 0 ? messages.slice(summaryIndex + 1) : [...messages];
  const deltaMessages = source.filter((message) => !isGeneratedContextMessage(message));
  return {
    epoch: (priorCheckpoint?.epoch ?? (priorSummary ? 1 : 0)) + 1,
    ...(priorSummary ? { priorSummary } : {}),
    ...(priorCheckpoint ? { priorCheckpoint } : {}),
    deltaMessages,
  };
}
