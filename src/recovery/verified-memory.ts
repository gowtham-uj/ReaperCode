import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { VerificationGroundedSignal } from "../verify/runner.js";
import type { ToolResult } from "../tools/types.js";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";
import { commitVerifiedSkill } from "../context/skills.js";

export interface VerifiedLesson {
  id: string;
  runId: string;
  lesson: string;
  tags: string[];
  importance: number;
  upvotes: number;
  downvotes: number;
  createdAt: string;
  lastVerifiedAt: string;
  provenance: {
    verificationCommand?: string;
    groundedSignalKind?: string;
    changedFileTypes: string[];
  };
}

export interface VerifiedKnowledgeCommitResult {
  lesson?: VerifiedLesson;
  skill?: { name: string; filePath: string };
}

const MAX_LESSONS = 200;
const MAX_FILE_BYTES = 768 * 1024;

export async function loadVerifiedLessons(workspaceRoot: string, query: string, limit = 5): Promise<string[]> {
  const lessons = await readVerifiedLessons(workspaceRoot);
  const queryTerms = tokenize(query);
  return lessons
    .map((lesson) => ({ lesson, score: scoreLesson(lesson, queryTerms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ lesson }) => formatLessonForPrompt(lesson));
}

export async function commitVerifiedRunKnowledge(input: {
  workspaceRoot: string;
  runId: string;
  prompt: string;
  assistantMessage: string;
  toolResults: ToolResult[];
  verification?: {
    ok: boolean;
    command?: string;
    groundedSignal?: VerificationGroundedSignal;
  };
}): Promise<VerifiedKnowledgeCommitResult> {
  if (input.verification?.ok !== true) return {};

  const changedFileTypes = inferChangedFileTypes(input.toolResults);
  const tags = inferKnowledgeTags(input.prompt, input.toolResults, input.verification).slice(0, 14);
  const signalKind = input.verification.groundedSignal?.kind ?? "grounded_check";
  const commandFamily = classifyCommandFamily(input.verification.command ?? input.verification.groundedSignal?.command ?? "");
  const fileTypeText = changedFileTypes.length ? changedFileTypes.join(", ") : "task-facing workspace files";
  const lessonText = [
    `Verified pattern for ${tags.slice(0, 5).join(", ") || "similar coding tasks"}: use focused edits to ${fileTypeText}.`,
    `Prove completion with a grounded ${signalKind} check${commandFamily ? ` (${commandFamily})` : ""}.`,
    "Do not persist this as an answer template; reuse only the workflow pattern and verification standard.",
  ].join(" ");

  const lesson = await recordVerifiedLesson(input.workspaceRoot, {
    runId: input.runId,
    lesson: lessonText,
    tags,
    importance: inferImportance(input.toolResults, input.verification),
    provenance: {
      ...(input.verification.command ? { verificationCommand: input.verification.command } : {}),
      groundedSignalKind: signalKind,
      changedFileTypes,
    },
  });

  const skill = await commitVerifiedSkill(input.workspaceRoot, {
    runId: input.runId,
    description: `Verified workflow for ${tags.slice(0, 5).join(", ") || signalKind} tasks`,
    tags,
    importance: lesson.importance,
    verifiedAt: lesson.lastVerifiedAt,
    body: [
      "# Verified Workflow",
      "",
      `Use when the current task resembles: ${tags.slice(0, 10).join(", ") || "a verified prior coding task"}.`,
      "",
      "- Inspect the specific failing or requested behavior first; avoid broad rereads.",
      `- Prefer focused edits to ${fileTypeText}.`,
      `- Before completion, run a grounded ${signalKind} check${commandFamily ? ` such as ${commandFamily}` : ""}.`,
      "- Treat this as workflow memory only. Do not copy prior task outputs, constants, or answers.",
    ].join("\n"),
  });

  return { lesson, skill };
}

export async function recordVerifiedLesson(
  workspaceRoot: string,
  input: {
    runId: string;
    lesson: string;
    tags: string[];
    importance: number;
    provenance: VerifiedLesson["provenance"];
  },
): Promise<VerifiedLesson> {
  const now = new Date().toISOString();
  const lessons = await readVerifiedLessons(workspaceRoot);
  const normalized = normalizeLesson(input.lesson);
  const existing = lessons.find((lesson) => normalizeLesson(lesson.lesson) === normalized);
  if (existing) {
    existing.upvotes += 1;
    existing.importance = Math.max(existing.importance, clampImportance(input.importance));
    existing.lastVerifiedAt = now;
    existing.runId = input.runId;
    existing.tags = uniqueStrings([...existing.tags, ...input.tags]).slice(0, 20);
    existing.provenance = {
      ...input.provenance,
      changedFileTypes: uniqueStrings([...existing.provenance.changedFileTypes, ...input.provenance.changedFileTypes]),
    };
    await writeVerifiedLessons(workspaceRoot, lessons);
    return existing;
  }

  const lesson: VerifiedLesson = {
    id: createHash("sha256").update(`${normalized}:${now}`).digest("hex").slice(0, 16),
    runId: input.runId,
    lesson: sanitizeText(input.lesson, 1200),
    tags: uniqueStrings(input.tags.map(sanitizeTag).filter(Boolean)).slice(0, 20),
    importance: clampImportance(input.importance),
    upvotes: 1,
    downvotes: 0,
    createdAt: now,
    lastVerifiedAt: now,
    provenance: input.provenance,
  };
  lessons.push(lesson);
  await writeVerifiedLessons(workspaceRoot, lessons);
  return lesson;
}

async function readVerifiedLessons(workspaceRoot: string): Promise<VerifiedLesson[]> {
  let text: string;
  try {
    text = await readFile(lessonFile(workspaceRoot), "utf8");
  } catch {
    return [];
  }
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) text = text.slice(-MAX_FILE_BYTES);
  const lessons: VerifiedLesson[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as VerifiedLesson;
      if (typeof parsed.lesson === "string" && Array.isArray(parsed.tags)) lessons.push(parsed);
    } catch {
      continue;
    }
  }
  return lessons;
}

async function writeVerifiedLessons(workspaceRoot: string, lessons: VerifiedLesson[]): Promise<void> {
  const filePath = lessonFile(workspaceRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const retained = lessons.slice(-MAX_LESSONS);
  await writeFile(filePath, `${retained.map((lesson) => JSON.stringify(lesson)).join("\n")}\n`, "utf8");
}

function lessonFile(workspaceRoot: string): string {
  return path.join(getReaperScratchpadPaths(workspaceRoot).memory, "verified-lessons.jsonl");
}

function formatLessonForPrompt(lesson: VerifiedLesson): string {
  const tags = lesson.tags.length ? ` tags=${lesson.tags.slice(0, 8).join(",")}.` : "";
  const provenance = lesson.provenance.groundedSignalKind ? ` verified_by=${lesson.provenance.groundedSignalKind}.` : "";
  return `[verified_lesson:${lesson.id}] ${lesson.lesson}${tags}${provenance}`.slice(0, 1600);
}

function scoreLesson(lesson: VerifiedLesson, queryTerms: string[]): number {
  const lessonTerms = tokenize([lesson.lesson, ...lesson.tags].join(" "));
  const relevance = overlapScore(queryTerms, lessonTerms);
  if (queryTerms.length > 0 && relevance === 0) return 0;
  const recency = recencyScore(lesson.lastVerifiedAt);
  const votes = Math.max(0.1, 1 + lesson.upvotes * 0.2 - lesson.downvotes * 0.35);
  return (relevance || 0.05) * lesson.importance * votes * recency;
}

function inferKnowledgeTags(
  prompt: string,
  toolResults: ToolResult[],
  verification: { command?: string; groundedSignal?: VerificationGroundedSignal },
): string[] {
  const writePaths = toolResults.flatMap((result) => {
    if (!["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name)) return [];
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    return typeof args.path === "string" ? [args.path] : [];
  });
  return uniqueStrings([
    ...tokenize(prompt).slice(0, 12),
    ...writePaths.flatMap(pathTags),
    verification.groundedSignal?.kind ?? "",
    classifyCommandFamily(verification.command ?? ""),
  ].map(sanitizeTag).filter(Boolean));
}

function inferChangedFileTypes(toolResults: ToolResult[]): string[] {
  return uniqueStrings(
    toolResults.flatMap((result) => {
      if (!result.ok || !["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name)) return [];
      const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
      const targetPath = typeof args.path === "string" ? args.path : "";
      const extension = path.extname(targetPath).toLowerCase();
      return extension ? [extension] : [];
    }),
  ).slice(0, 8);
}

function inferImportance(toolResults: ToolResult[], verification: { groundedSignal?: VerificationGroundedSignal }): number {
  const writeCount = toolResults.filter((result) => result.ok && ["write_file", "replace_in_file", "edit_file", "replace_symbol"].includes(result.name)).length;
  const groundedBoost = verification.groundedSignal?.grounded ? 0.75 : 0;
  return clampImportance(1 + Math.min(2, writeCount * 0.2) + groundedBoost);
}

function pathTags(targetPath: string): string[] {
  const normalized = targetPath.replace(/\\/g, "/");
  const extension = path.extname(normalized).replace(/^\./, "");
  return uniqueStrings([
    ...normalized.split(/[/.\\_-]+/).filter((item) => item.length >= 3),
    extension ? `${extension}-files` : "",
  ]);
}

function classifyCommandFamily(command: string): string {
  if (/\b(pytest|python\s+-m\s+pytest)\b/i.test(command)) return "pytest";
  if (/\bnpm\s+(?:test|run test)|\bvitest\b|\bjest\b|\bnode\s+--test\b/i.test(command)) return "javascript-tests";
  if (/\btsc\b/i.test(command)) return "typescript-typecheck";
  if (/\bcargo\s+test\b/i.test(command)) return "cargo-test";
  if (/\bgo\s+test\b/i.test(command)) return "go-test";
  if (/\bmake\b/i.test(command)) return "make";
  if (/\bgrep\s+-q|\bdiff\b|\bcmp\b|\bjq\s+-e\b/i.test(command)) return "artifact-check";
  return "";
}

function tokenize(input: string): string[] {
  return uniqueStrings(input.toLowerCase().match(/[a-z0-9_+-]{3,}/g) ?? []);
}

function overlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  const matches = a.filter((term) => bSet.has(term)).length;
  return matches / Math.sqrt(a.length * b.length);
}

function recencyScore(iso: string): number {
  const ageMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1.1;
  return Math.max(0.35, 1 / (1 + ageMs / 30 / 86_400_000));
}

function normalizeLesson(value: string): string {
  return sanitizeText(value, 1200).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sanitizeText(value: string, maxChars: number): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function sanitizeTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_+-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function clampImportance(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(5, Math.max(0.1, Math.round(value * 100) / 100));
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
