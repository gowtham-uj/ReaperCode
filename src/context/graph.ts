import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";

import { readIndexedFile, type CodebaseIndex, type IndexedFile } from "./indexer.js";

export interface SymbolInfo {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "method" | "unknown";
  startIndex: number;
  endIndex: number;
  source: "tree-sitter" | "regex";
}

export interface FileGraphNode {
  path: string;
  imports: string[];
  importedBy: string[];
  symbols: SymbolInfo[];
  source: "tree-sitter" | "regex";
}

export interface DependencyGraph {
  fingerprint: string;
  nodes: Map<string, FileGraphNode>;
}

const parserCache = new Map<string, Parser>();
const graphCache = new Map<string, DependencyGraph>();
const fileInfoCache = new Map<string, { cacheKey: string; node: FileGraphNode }>();

// Hard cap on the size of any single file we feed to tree-sitter.
// Files larger than this are still indexed (so the model can read
// them) but get only the regex-based extraction. tree-sitter parse
// time scales superlinearly with file size — a 5 MB auto-generated
// TS file can stall the parser for many seconds.
const MAX_TREE_SITTER_BYTES = 200_000;

// Bounded concurrency for the parallel file-read fan-out. libuv's
// default thread pool is small (~4); 64-way Promise.all on an 8000-
// file index saturates it nicely without thrashing.
const MAX_CONCURRENCY = 64;

export async function buildDependencyGraph(index: CodebaseIndex): Promise<DependencyGraph> {
  const cached = graphCache.get(`${index.workspaceRoot}:${index.fingerprint}`);
  if (cached) {
    return cached;
  }

  const nodes = new Map<string, FileGraphNode>();

  // Phase 1: classify each file as cached or needing a re-read.
  const needsRead: IndexedFile[] = [];
  for (const file of index.files) {
    const cacheKey = `${index.workspaceRoot}:${file.relativePath}:${file.sizeBytes}:${file.modifiedMs}`;
    const cachedNode = fileInfoCache.get(`${index.workspaceRoot}:${file.relativePath}`);
    if (cachedNode?.cacheKey === cacheKey) {
      nodes.set(file.relativePath, { ...cachedNode.node, imports: [...cachedNode.node.imports], importedBy: [] });
      continue;
    }
    needsRead.push(file);
  }

  // Phase 2: read + parse files in bounded-parallel batches. The
  // previous implementation did this one at a time, which on an
  // 8000-file workspace hangs Content Prep for tens of seconds.
  for (let i = 0; i < needsRead.length; i += MAX_CONCURRENCY) {
    const batch = needsRead.slice(i, i + MAX_CONCURRENCY);
    await Promise.all(
      batch.map(async (file) => {
        const cacheKey = `${index.workspaceRoot}:${file.relativePath}:${file.sizeBytes}:${file.modifiedMs}`;
        const content = await readIndexedFile(file);
        if (!content) return;
        const extracted = extractFileGraphNode(file, content);
        fileInfoCache.set(`${index.workspaceRoot}:${file.relativePath}`, { cacheKey, node: extracted });
        nodes.set(file.relativePath, { ...extracted, imports: [...extracted.imports], importedBy: [] });
      }),
    );
  }

  for (const node of nodes.values()) {
    for (const target of node.imports) {
      const imported = nodes.get(target);
      if (imported && !imported.importedBy.includes(node.path)) {
        imported.importedBy.push(node.path);
      }
    }
  }

  const graph = { fingerprint: index.fingerprint, nodes };
  graphCache.set(`${index.workspaceRoot}:${index.fingerprint}`, graph);
  return graph;
}

export function extractFileGraphNode(file: IndexedFile, content: string): FileGraphNode {
  const parser = getParserForFile(file.relativePath, file.sizeBytes);
  if (!parser) {
    return regexExtractFileGraphNode(file.relativePath, content);
  }

  try {
    const tree = parser.parse(content);
    const symbols: SymbolInfo[] = [];
    const imports = new Set<string>();
    walk(tree.rootNode, (node) => {
      if (["function_declaration", "class_declaration", "interface_declaration", "type_alias_declaration"].includes(node.type)) {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          symbols.push({
            name: content.slice(nameNode.startIndex, nameNode.endIndex),
            kind: mapNodeKind(node.type),
            startIndex: node.startIndex,
            endIndex: node.endIndex,
            source: "tree-sitter",
          });
        }
      }

      if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
        const text = content.slice(node.startIndex, node.endIndex);
        for (const match of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
          symbols.push({
            name: match[1]!,
            kind: "const",
            startIndex: node.startIndex,
            endIndex: node.endIndex,
            source: "tree-sitter",
          });
        }
      }

      if (node.type === "import_statement") {
        const sourceNode = node.childForFieldName("source");
        if (sourceNode) {
          const raw = content.slice(sourceNode.startIndex, sourceNode.endIndex).replace(/^['"]|['"]$/g, "");
          const resolved = resolveImportPath(file.relativePath, raw);
          if (resolved) {
            imports.add(resolved);
          }
        }
      }
    });

    return {
      path: file.relativePath,
      imports: [...imports],
      importedBy: [],
      symbols,
      source: "tree-sitter",
    };
  } catch {
    return regexExtractFileGraphNode(file.relativePath, content);
  }
}

function regexExtractFileGraphNode(relativePath: string, content: string): FileGraphNode {
  const imports = [...content.matchAll(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g)]
    .map((match) => match[1] ?? match[2])
    .filter((value): value is string => Boolean(value))
    .map((value) => resolveImportPath(relativePath, value))
    .filter((value): value is string => Boolean(value));
  const symbols = [...content.matchAll(/(?:function|class|interface|type|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((match) => ({
    name: match[1]!,
    kind: "unknown" as const,
    startIndex: match.index ?? 0,
    endIndex: (match.index ?? 0) + match[0].length,
    source: "regex" as const,
  }));

  return {
    path: relativePath,
    imports,
    importedBy: [],
    symbols,
    source: "regex",
  };
}

function getParserForFile(relativePath: string, sizeBytes: number): Parser | undefined {
  // Skip tree-sitter on huge files — see MAX_TREE_SITTER_BYTES above.
  if (sizeBytes > MAX_TREE_SITTER_BYTES) return undefined;
  if (relativePath.endsWith(".ts") || relativePath.endsWith(".tsx")) {
    return getOrCreateParser("typescript", TypeScript.typescript);
  }
  if (relativePath.endsWith(".js") || relativePath.endsWith(".jsx") || relativePath.endsWith(".mjs") || relativePath.endsWith(".cjs")) {
    return getOrCreateParser("javascript", JavaScript);
  }
  return undefined;
}

function getOrCreateParser(key: string, language: unknown): Parser {
  const existing = parserCache.get(key);
  if (existing) {
    return existing;
  }
  const parser = new Parser();
  parser.setLanguage(language as Parameters<Parser["setLanguage"]>[0]);
  parserCache.set(key, parser);
  return parser;
}

function walk(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void): void {
  visit(node);
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (child) {
      walk(child, visit);
    }
  }
}

function mapNodeKind(type: string): SymbolInfo["kind"] {
  switch (type) {
    case "function_declaration":
      return "function";
    case "class_declaration":
      return "class";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type";
    default:
      return "unknown";
  }
}

function resolveImportPath(fromPath: string, raw: string): string | undefined {
  if (!raw.startsWith(".")) {
    return undefined;
  }

  const normalized = new URL(raw, `file:///${fromPath}`).pathname.replace(/^\//, "");
  const candidates = [normalized, `${normalized}.ts`, `${normalized}.tsx`, `${normalized}.js`, `${normalized}.jsx`, `${normalized}/index.ts`, `${normalized}/index.js`];
  return candidates[0];
}
