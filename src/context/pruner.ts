import path from "node:path";

import { estimateTextTokens, applyDeterministicTruncation, type BudgetedItem } from "./budget.js";
import type { CodebaseIndex, IndexedFile } from "./indexer.js";
import { readIndexedFile } from "./indexer.js";
import type { MentionResolution } from "./mentions.js";

export interface ContextChunk {
  path: string;
  tier: "guardrail" | "pinned" | "always_include";
  content: string;
  tokenCost: number;
}

export interface PreparedContext {
  fingerprint: string;
  fileTree: string[];
  chunks: ContextChunk[];
  droppedPaths: string[];
  usedTokens: number;
}

export interface PrepareContextInput {
  index: CodebaseIndex;
  prompt: string;
  mentions: MentionResolution;
  maxTokens: number;
  guardrailExcludes?: string[];
}

export async function prepareContext(input: PrepareContextInput): Promise<PreparedContext> {
  const excluded = new Set(input.guardrailExcludes ?? []);
  // Names that are loaded as INSTRUCTIONS via the context-file
  // loader (see `loadContextFiles`). Excluded from pinned and
  // always-include tiers so the cockpit does not double-ingest them
  // as data excerpts in addition to the project-context block.
  const instructionFileNames = new Set([
    "AGENTS.md", "AGENTS.MD",
    "CLAUDE.md", "CLAUDE.MD",
    "REAPER.md", "REAPER.MD",
    ".cursorrules",
  ]);
  const isInstructionFile = (relPath: string) => instructionFileNames.has(path.basename(relPath));
  const pinnedFiles = resolvePinnedFiles(input.index, input.mentions.fileMentions)
    .filter((file) => !excluded.has(file.relativePath) && !isInstructionFile(file.relativePath));
  const pinnedPaths = new Set(pinnedFiles.map((file) => file.relativePath));
  const alwaysInclude = input.index.alwaysInclude.filter(
    (file) => !excluded.has(file.relativePath) && !pinnedPaths.has(file.relativePath) && !isInstructionFile(file.relativePath),
  );

  const budgetItems: BudgetedItem<() => Promise<ContextChunk>>[] = [];

  pinnedFiles.forEach((file, rank) => {
    budgetItems.push(toBudgetItem(file, "pinned", 1, rank));
  });
  alwaysInclude.forEach((file, rank) => {
    budgetItems.push(toBudgetItem(file, "always_include", 2, rank));
  });

  const truncation = applyDeterministicTruncation(budgetItems, input.maxTokens);
  const chunks = await Promise.all(truncation.kept.map((item) => item.item()));

  return {
    fingerprint: input.index.fingerprint,
    fileTree: input.index.fileTree,
    chunks,
    droppedPaths: truncation.dropped.map((item) => item.stableKey),
    usedTokens: truncation.usedTokens,
  };
}

function toBudgetItem(
  file: IndexedFile,
  tier: ContextChunk["tier"],
  priority: number,
  rank: number,
): BudgetedItem<() => Promise<ContextChunk>> {
  return {
    item: async () => {
      const content = await readIndexedFile(file);
      const rendered = `FILE: ${file.relativePath}\n${content}`;
      return {
        path: file.relativePath,
        tier,
        content: rendered,
        tokenCost: estimateTextTokens(rendered),
      };
    },
    tokenCost: estimateFileTokens(file),
    priority,
    rank,
    stableKey: file.relativePath,
  };
}

function estimateFileTokens(file: IndexedFile): number {
  return Math.max(1, Math.ceil((`FILE: ${file.relativePath}\n`.length + file.sizeBytes) / 4));
}

function resolvePinnedFiles(index: CodebaseIndex, mentions: string[]): IndexedFile[] {
  const normalizedMentions = new Set(mentions.map((mention) => mention.replace(/^\.\//, "")));
  return index.files.filter((file) => normalizedMentions.has(file.relativePath) || normalizedMentions.has(path.basename(file.relativePath)));
}
