import type { CodebaseIndex } from "./indexer.js";

const indexCache = new Map<string, CodebaseIndex>();

export function getCachedIndex(workspaceRoot: string): CodebaseIndex | undefined {
  return indexCache.get(workspaceRoot);
}

export function setCachedIndex(index: CodebaseIndex): void {
  indexCache.set(index.workspaceRoot, index);
}

export function clearCachedIndex(workspaceRoot: string): void {
  indexCache.delete(workspaceRoot);
}
