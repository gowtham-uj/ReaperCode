import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

export interface StoredArtifact {
  artifactId: string;
  kind: "tool_output" | "verification_log" | "attachment" | "search_results" | "spillover";
  path: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  /** Optional source tool name for `kind: "spillover"` artifacts. */
  sourceTool?: string;
}

export interface ArtifactContentResult {
  artifactId: string;
  kind: StoredArtifact["kind"];
  bytes: number;
  sha256: string;
  createdAt: string;
  /** Total number of lines in the artifact. */
  totalLines: number;
  /** Lines (or fragments) actually returned. */
  lines: Array<{ line: number; content: string }>;
  /** Whether the returned content was truncated against `maxBytes`. */
  truncated: boolean;
}

const DEFAULT_MAX_BYTES = 50 * 1024;

export class ArtifactStore {
  private readonly root: string;
  private readonly indexPath: string;

  constructor(workspaceRoot: string) {
    this.root = getReaperScratchpadPaths(workspaceRoot).artifacts;
    this.indexPath = path.join(this.root, "index.json");
  }

  async put(
    kind: StoredArtifact["kind"],
    content: string,
    options: { sourceTool?: string } = {},
  ): Promise<StoredArtifact> {
    await mkdir(this.root, { recursive: true });
    const artifactId = randomUUID();
    const filePath = path.join(this.root, `${artifactId}.txt`);
    await writeFile(filePath, content, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const artifact: StoredArtifact = {
      artifactId,
      kind,
      path: filePath,
      bytes,
      sha256,
      createdAt: new Date().toISOString(),
      ...(options.sourceTool ? { sourceTool: options.sourceTool } : {}),
    };
    const index = await this.readIndex();
    index.push(artifact);
    await writeFile(this.indexPath, JSON.stringify(index, null, 2), "utf8");
    return artifact;
  }

  /**
   * Legacy get: returns the raw stored artifact plus full content. Kept for
   * backward compatibility with code that already uses ArtifactStore.
   */
  async get(artifactId: string): Promise<StoredArtifact & { content: string }> {
    const index = await this.readIndex();
    const artifact = index.find((item) => item.artifactId === artifactId);
    if (!artifact) {
      throw new Error(`Artifact '${artifactId}' not found`);
    }
    const content = await readFile(artifact.path, "utf8");
    return { ...artifact, content };
  }

  /**
   * Codex/Claude-style retrieval API: returns just the requested window of
   * the artifact, with line numbers, against a `maxBytes` cap so the model
   * never accidentally re-pastes a giant log.
   */
  async read(
    artifactId: string,
    options: {
      startLine?: number | undefined;
      endLine?: number | undefined;
      pattern?: string | undefined;
      jsonPath?: string | undefined;
      maxBytes?: number | undefined;
    } = {},
  ): Promise<ArtifactContentResult> {
    const stored = await this.get(artifactId);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const lineCount = countLines(stored.content);

    // JSON-path resolution takes precedence; it returns a synthetic single
    // line (with the JSON fragment) regardless of source formatting.
    if (options.jsonPath) {
      const fragment = extractJsonPath(stored.content, options.jsonPath);
      const truncated = Buffer.byteLength(fragment, "utf8") > maxBytes;
      const lines: Array<{ line: number; content: string }> = truncated
        ? [{ line: 1, content: fragment.slice(0, maxBytes) + "\n...[truncated; maxBytes exceeded]..." }]
        : [{ line: 1, content: fragment }];
      return {
        artifactId: stored.artifactId,
        kind: stored.kind,
        bytes: stored.bytes,
        sha256: stored.sha256,
        createdAt: stored.createdAt,
        totalLines: 1,
        lines,
        truncated,
      };
    }

    let selected = stored.content;
    let startLine = options.startLine ?? 1;
    let endLine = options.endLine ?? lineCount;
    if (options.pattern) {
      const regex = new RegExp(options.pattern);
      const lines: Array<{ line: number; content: string }> = [];
      const allLines = stored.content.split("\n");
      for (let i = 0; i < allLines.length; i += 1) {
        if (regex.test(allLines[i]!)) {
          lines.push({ line: i + 1, content: allLines[i]! });
        }
      }
      return {
        artifactId: stored.artifactId,
        kind: stored.kind,
        bytes: stored.bytes,
        sha256: stored.sha256,
        createdAt: stored.createdAt,
        totalLines: lineCount,
        lines: truncateLines(lines, maxBytes),
        truncated: lineByteSize(lines) > maxBytes,
      };
    }

    // Plain line-range window.
    startLine = Math.max(1, Math.min(startLine, lineCount));
    endLine = Math.max(startLine, Math.min(endLine, lineCount));
    const allLines = selected.split("\n");
    const window = allLines.slice(startLine - 1, endLine);
    const lines: Array<{ line: number; content: string }> = window.map((content, index) => ({
      line: startLine + index,
      content,
    }));
    return {
      artifactId: stored.artifactId,
      kind: stored.kind,
      bytes: stored.bytes,
      sha256: stored.sha256,
      createdAt: stored.createdAt,
      totalLines: lineCount,
      lines: truncateLines(lines, maxBytes),
      truncated: lineByteSize(lines) > maxBytes,
    };
  }

  async pruneOlderThan(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    const index = await this.readIndex();
    const kept: StoredArtifact[] = [];
    for (const artifact of index) {
      if (new Date(artifact.createdAt).getTime() < cutoff) {
        await rm(artifact.path, { force: true }).catch(() => undefined);
      } else {
        kept.push(artifact);
      }
    }
    await mkdir(this.root, { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(kept, null, 2), "utf8");
  }

  async stats(): Promise<{ count: number; bytes: number }> {
    const index = await this.readIndex();
    let bytes = 0;
    for (const artifact of index) {
      try {
        bytes += (await stat(artifact.path)).size;
      } catch {
        continue;
      }
    }
    return { count: index.length, bytes };
  }

  private async readIndex(): Promise<StoredArtifact[]> {
    try {
      return JSON.parse(await readFile(this.indexPath, "utf8")) as StoredArtifact[];
    } catch {
      return [];
    }
  }
}

function countLines(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length;
}

function lineByteSize(lines: Array<{ content: string }>): number {
  let bytes = 0;
  for (const line of lines) bytes += Buffer.byteLength(line.content, "utf8") + 1; // +1 for newline
  return bytes;
}

function truncateLines(
  lines: Array<{ line: number; content: string }>,
  maxBytes: number,
): Array<{ line: number; content: string }> {
  const result: Array<{ line: number; content: string }> = [];
  let used = 0;
  for (const entry of lines) {
    const cost = Buffer.byteLength(entry.content, "utf8") + 1;
    if (used + cost > maxBytes) {
      result.push({
        line: entry.line,
        content: entry.content.slice(0, Math.max(0, maxBytes - used - 60)) + "\n...[truncated; maxBytes exceeded]...",
      });
      return result;
    }
    result.push(entry);
    used += cost;
  }
  return result;
}

/**
 * Tiny JSON-path resolver. Supports dot-paths (`a.b.c`) and bracket
 * indexing (`a[0].b`, `a["key"]`). Returns a JSON-stringified fragment
 * for the selected node, or the original content when the path does not
 * match anything (so the caller can decide what to do).
 */
function extractJsonPath(content: string, path: string): string {
  let node: unknown;
  try {
    node = JSON.parse(content);
  } catch {
    return content;
  }
  const segments = parseJsonPath(path);
  for (const segment of segments) {
    if (node === null || node === undefined) {
      return JSON.stringify(node);
    }
    if (typeof node !== "object") {
      return JSON.stringify(node);
    }
    if (typeof segment === "number") {
      node = Array.isArray(node) ? node[segment] : undefined;
      continue;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  if (node === undefined) {
    return "null";
  }
  try {
    return JSON.stringify(node, null, 2);
  } catch {
    return String(node);
  }
}

function parseJsonPath(path: string): Array<string | number> {
  const segments: Array<string | number> = [];
  const re = /([^.[\]]+)|\[(\d+)\]|\["([^"]+)"\]|\['([^']+)'\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) !== null) {
    if (match[1] !== undefined) {
      segments.push(match[1]);
    } else if (match[2] !== undefined) {
      segments.push(Number(match[2]));
    } else if (match[3] !== undefined) {
      segments.push(match[3]);
    } else if (match[4] !== undefined) {
      segments.push(match[4]);
    }
  }
  return segments;
}
