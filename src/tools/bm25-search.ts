/**
 * tools/bm25-search.ts — Phase 2: BM25 tool discovery.
 *
 * Replaces the simple keyword scoring in `context/tool-search.ts` with
 * an indexed BM25 catalog that searches over ToolDescriptor fields:
 * name, aliases, summary, description, examples, family, capabilityTier.
 *
 * The index is built once (lazily) from the descriptor map and rebuilt
 * if the descriptor set changes.
 */

import { getAllToolDescriptors, type ToolDescriptor } from "./descriptor.js";

// ---------------------------------------------------------------------------
// BM25 implementation
// ---------------------------------------------------------------------------

interface BM25Document {
  toolName: string;
  tokens: string[];
  fieldWeights: Record<string, number>; // per-field boost
}

interface BM25Index {
  documents: BM25Document[];
  avgDocLength: number;
  termFreq: Map<string, number>; // term → document frequency
  totalDocs: number;
}

const K1 = 1.5; // term frequency saturation
const B = 0.75; // document length normalization

/**
 * Tokenize a string for BM25 indexing.
 * Lowercases, splits on non-alphanumeric, filters empty.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Build the BM25 index from all registered ToolDescriptors.
 *
 * Each tool becomes one "document" whose tokens are drawn from:
 * - name (weight: 5x)
 * - aliases (weight: 3x)
 * - summary (weight: 2x)
 * - description (weight: 1x)
 * - examples (weight: 2x)
 * - family (weight: 1x)
 * - capabilityTier (weight: 1x)
 */
function buildBM25Index(descriptors: readonly ToolDescriptor[]): BM25Index {
  const documents: BM25Document[] = [];
  const termDocFreq = new Map<string, Set<string>>(); // term → set of doc names

  for (const d of descriptors) {
    // Build weighted token list (repeat tokens by field weight)
    const allTokens: string[] = [];

    // Name: 5x boost
    for (let i = 0; i < 5; i++) allTokens.push(...tokenize(d.name));

    // Aliases: 3x boost each
    for (const alias of d.aliases) {
      for (let i = 0; i < 3; i++) allTokens.push(...tokenize(alias));
    }

    // Summary: 2x boost
    for (let i = 0; i < 2; i++) allTokens.push(...tokenize(d.summary));

    // Description: 1x
    allTokens.push(...tokenize(d.description));

    // Examples: 2x each
    for (const example of d.examples) {
      for (let i = 0; i < 2; i++) allTokens.push(...tokenize(example));
    }

    // Family: 1x
    allTokens.push(...tokenize(d.family));

    // Capability tier: 1x
    allTokens.push(...tokenize(d.capabilityTier));

    // Track document frequencies
    const uniqueTokens = new Set(allTokens);
    for (const token of uniqueTokens) {
      if (!termDocFreq.has(token)) termDocFreq.set(token, new Set());
      termDocFreq.get(token)!.add(d.name);
    }

    documents.push({
      toolName: d.name,
      tokens: allTokens,
      fieldWeights: {},
    });
  }

  const avgDocLength =
    documents.length > 0
      ? documents.reduce((sum, d) => sum + d.tokens.length, 0) / documents.length
      : 0;

  const termFreq = new Map<string, number>();
  for (const [term, docSet] of termDocFreq) {
    termFreq.set(term, docSet.size);
  }

  return {
    documents,
    avgDocLength,
    termFreq,
    totalDocs: documents.length,
  };
}

/**
 * Score a single document against a query using BM25.
 */
function scoreBM25(queryTokens: string[], doc: BM25Document, index: BM25Index): number {
  if (doc.tokens.length === 0) return 0;

  // Count term frequencies in this document
  const docTermFreq = new Map<string, number>();
  for (const token of doc.tokens) {
    docTermFreq.set(token, (docTermFreq.get(token) ?? 0) + 1);
  }

  let score = 0;
  for (const qToken of queryTokens) {
    const tf = docTermFreq.get(qToken) ?? 0;
    if (tf === 0) continue;

    const df = index.termFreq.get(qToken) ?? 0;
    if (df === 0) continue;

    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((index.totalDocs - df + 0.5) / (df + 0.5) + 1);

    // BM25 term score with saturation and length normalization
    const tfComponent = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.tokens.length / index.avgDocLength)));

    score += idf * tfComponent;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Cached index
// ---------------------------------------------------------------------------

let _cachedIndex: BM25Index | null = null;
let _cachedDescriptorCount = -1;

function getIndex(): BM25Index {
  const descriptors = getAllToolDescriptors();
  if (_cachedIndex && _cachedDescriptorCount === descriptors.length) {
    return _cachedIndex;
  }
  _cachedIndex = buildBM25Index(descriptors);
  _cachedDescriptorCount = descriptors.length;
  return _cachedIndex;
}

/**
 * Reset the cached index (for tests).
 */
export function resetBM25Index(): void {
  _cachedIndex = null;
  _cachedDescriptorCount = -1;
}

// ---------------------------------------------------------------------------
// Public search API
// ---------------------------------------------------------------------------

export interface BM25SearchResult {
  name: string;
  description: string;
  score: number;
}

/**
 * Search all tool descriptors using BM25 ranking.
 *
 * @param query - Natural language search query
 * @param limit - Max results (default 6)
 * @returns Ranked matches with scores
 */
export function bm25SearchTools(query: string, limit: number = 6): BM25SearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const index = getIndex();
  if (index.documents.length === 0) return [];

  const results = index.documents
    .map((doc) => {
      const descriptor = getAllToolDescriptors().find((d) => d.name === doc.toolName);
      if (!descriptor) return null;
      return {
        name: descriptor.name,
        description: descriptor.description,
        score: scoreBM25(queryTokens, doc, index),
      };
    })
    .filter((r): r is BM25SearchResult => r !== null && r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return results;
}

/**
 * Get the total number of indexed tools.
 */
export function getIndexedToolCount(): number {
  return getIndex().totalDocs;
}
