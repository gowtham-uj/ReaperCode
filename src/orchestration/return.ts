import { buildCodebaseIndex } from "../context/indexer.js";
import { buildDependencyGraph } from "../context/graph.js";
import { rankFilesByStructureAndLexical } from "../context/ranking.js";

export async function buildRepoMapSnapshot(workspaceRoot: string, prompt: string) {
  const index = await buildCodebaseIndex(workspaceRoot);
  const graph = await buildDependencyGraph(index);
  const ranking = rankFilesByStructureAndLexical(prompt, graph).slice(0, 20);
  return {
    fingerprint: index.fingerprint,
    topFiles: ranking,
    fileTree: index.fileTree.slice(0, 200),
  };
}
