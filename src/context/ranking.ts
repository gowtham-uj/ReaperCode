import type { DependencyGraph } from "./graph.js";

const DAMPING_FACTOR = 0.85;
const MAX_ITERATIONS = 20;
const CONVERGENCE_THRESHOLD = 0.0001;

export function rankFilesByStructureAndLexical(prompt: string, graph: DependencyGraph): Array<{ path: string; score: number }> {
  const promptTerms = tokenize(prompt);
  const nodes = [...graph.nodes.values()];
  const n = nodes.length;

  if (n === 0) {
    return [];
  }

  const lexicalScores = new Map<string, number>();
  let totalLexicalScore = 0;

  for (const node of nodes) {
    const score =
        lexicalScore(node.path, promptTerms) * 2 +
        node.symbols.reduce((sum, symbol) => sum + lexicalScore(symbol.name, promptTerms) * 3, 0) +
        1;
    
    lexicalScores.set(node.path, score);
    totalLexicalScore += score;
  }

  const teleportDist = new Map<string, number>();
  for (const [path, score] of lexicalScores.entries()) {
    teleportDist.set(path, score / totalLexicalScore);
  }

  let pr = new Map<string, number>();
  for (const node of nodes) {
    pr.set(node.path, 1 / n);
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const nextPr = new Map<string, number>();
    let danglingSum = 0;

    for (const node of nodes) {
      if (node.imports.length === 0) {
        danglingSum += pr.get(node.path)!;
      }
    }

    let diff = 0;
    for (const node of nodes) {
      let sumIn = 0;
      for (const tPath of node.importedBy) {
        const tNode = graph.nodes.get(tPath);
        if (tNode) {
          sumIn += pr.get(tPath)! / Math.max(1, tNode.imports.length);
        }
      }

      const danglingVal = danglingSum / n;
      const newScore = (1 - DAMPING_FACTOR) * teleportDist.get(node.path)! + 
                       DAMPING_FACTOR * (sumIn + danglingVal);
      
      nextPr.set(node.path, newScore);
      diff += Math.abs(newScore - pr.get(node.path)!);
    }

    pr = nextPr;
    if (diff < CONVERGENCE_THRESHOLD) {
      break;
    }
  }

  return nodes
    .map((node) => {
       const rawLexical = lexicalScores.get(node.path)! - 1;
       const pageRankScore = pr.get(node.path)! * 1000;
       const combinedScore = pageRankScore * (1 + Math.log1p(rawLexical));
       
       return {
         path: node.path,
         score: combinedScore
       };
    })
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path.localeCompare(b.path)));
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter(Boolean);
}

function lexicalScore(value: string, terms: string[]): number {
  const lower = value.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? Math.max(1, term.length) : 0), 0);
}
