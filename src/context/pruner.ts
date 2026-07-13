import path from "node:path";

import { estimateTextTokens, applyDeterministicTruncation, type BudgetedItem } from "./budget.js";
import { buildDependencyGraph } from "./graph.js";
import type { CodebaseIndex, IndexedFile } from "./indexer.js";
import { readIndexedFile } from "./indexer.js";
import type { MentionResolution } from "./mentions.js";
import { rankFilesByStructureAndLexical } from "./ranking.js";
import { pruneWithSwePruner, type SwePrunerConfig } from "./swe-pruner.js";

export interface ContextChunk {
  path: string;
  tier: "guardrail" | "pinned" | "discovery" | "always_include";
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
  prunerConfig?: SwePrunerConfig;
}

export async function prepareContext(input: PrepareContextInput): Promise<PreparedContext> {
  const excluded = new Set(input.guardrailExcludes ?? []);
  const pinnedFiles = resolvePinnedFiles(input.index, input.mentions.fileMentions).filter((file) => !excluded.has(file.relativePath));
  const pinnedPaths = new Set(pinnedFiles.map((file) => file.relativePath));
  const alwaysInclude = input.index.alwaysInclude.filter(
    (file) => !excluded.has(file.relativePath) && !pinnedPaths.has(file.relativePath),
  );
  const graph = await buildDependencyGraph(input.index);
  const discovery = rankDiscoveryFiles(
    input.index,
    rankFilesByStructureAndLexical(input.prompt, graph),
    excluded,
    new Set([...pinnedFiles, ...alwaysInclude].map((file) => file.relativePath)),
  );

  const budgetItems: BudgetedItem<() => Promise<ContextChunk>>[] = [];

  for (const file of pinnedFiles) {
    budgetItems.push(toBudgetItem(file, "pinned", 1, input.prompt, input.prunerConfig));
  }
  for (const file of alwaysInclude) {
    budgetItems.push(toBudgetItem(file, "always_include", 2, input.prompt, input.prunerConfig));
  }
  for (const file of discovery) {
    budgetItems.push(toBudgetItem(file, "discovery", 3, input.prompt, input.prunerConfig));
  }

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
  prompt: string,
  prunerConfig?: SwePrunerConfig,
): BudgetedItem<() => Promise<ContextChunk>> {
  return {
    item: async () => {
      const content = await readIndexedFile(file);
      const maybePruned = file.sizeBytes > 16_000
        ? await pruneWithSwePruner({
            config: prunerConfig ?? { enabled: true, localOnly: true, threshold: 0.5 },
            query: prompt,
            code: content,
          })
        : undefined;
      const rendered = `FILE: ${file.relativePath}\n${maybePruned?.prunedCode ?? content}`;
      return {
        path: file.relativePath,
        tier,
        content: rendered,
        tokenCost: estimateTextTokens(rendered),
      };
    },
    tokenCost: estimateFileTokens(file),
    priority,
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

function rankDiscoveryFiles(
  index: CodebaseIndex,
  ranking: Array<{ path: string; score: number }>,
  excluded: Set<string>,
  alreadyIncluded: Set<string>,
): IndexedFile[] {
  const byPath = new Map(index.files.map((file) => [file.relativePath, file]));
  return ranking
    .filter((entry) => !excluded.has(entry.path) && !alreadyIncluded.has(entry.path))
    .slice(0, 20)
    .map((entry) => byPath.get(entry.path))
    .filter((file): file is IndexedFile => Boolean(file));
}
