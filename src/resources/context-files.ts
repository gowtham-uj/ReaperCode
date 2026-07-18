import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface ContextFile {
  source: string;
  content: string;
  truncated: boolean;
  bytes: number;
  kind: "project" | "user";
}

export interface ContextFileLoadOptions {
  workspaceRoot: string;
  userHome?: string;
  /** Defaults to true. */
  trusted?: boolean;
  /** Per-file byte cap. Defaults to 8KB. */
  maxFileBytes?: number;
  /** Total combined byte cap. Defaults to 32KB. */
  maxTotalBytes?: number;
}

export interface ContextFileLoadResult {
  files: ContextFile[];
  combined: string;
  diagnostics: string[];
}

const TRUSTED_PROJECT_CANDIDATES = [
  ".reaper/context.md",
  ".reaper/project.md",
  ".reaper/.config/system.md",
  ".pi/context.md",
];

/** Project rule filenames loaded at workspace root and each ancestor. */
const PROJECT_RULE_CANDIDATES = [
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
  "REAPER.md",
  "REAPER.MD",
  ".cursorrules",
];

const USER_CANDIDATES = [".config/reaper/context.md", ".pi/context.md", ".reaper/AGENTS.md", ".reaper/AGENTS.MD"];

const DEFAULT_MAX_FILE_BYTES = 8 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024;

export async function loadContextFiles(options: ContextFileLoadOptions): Promise<ContextFileLoadResult> {
  const { workspaceRoot, userHome, trusted = true } = options;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const files: ContextFile[] = [];
  const diagnostics: string[] = [];
  /** Content-hash dedup for monorepo ancestor walks (same body → skip). */
  const seenContentHashes = new Set<string>();

  if (trusted) {
    for (const relative of TRUSTED_PROJECT_CANDIDATES) {
      const absolute = path.join(workspaceRoot, relative);
      await maybeLoad(absolute, relative, "project");
    }
  } else {
    diagnostics.push(
      "Protected project context files were not loaded because the workspace is not trusted.",
    );
  }

  // Project rule files carry instruction authority, so they are loaded
  // only after the workspace has been explicitly trusted. Repository
  // source remains available separately as data through indexed excerpts.
  if (trusted) {
    for (const dir of collectAncestorDirs(workspaceRoot)) {
      for (const name of PROJECT_RULE_CANDIDATES) {
        const absolute = path.join(dir, name);
        const source =
          path.resolve(dir) === path.resolve(workspaceRoot)
            ? name
            : path.relative(workspaceRoot, absolute) || name;
        await maybeLoad(absolute, source, "project");
      }
    }
  } else {
    diagnostics.push("Project rule files were not loaded because the workspace is not trusted.");
  }

  if (userHome) {
    for (const relative of USER_CANDIDATES) {
      const absolute = path.join(userHome, relative);
      await maybeLoad(absolute, `~/${relative}`, "user");
    }
  }

  // User-home instructions have higher authority than project rules, so
  // reserve their share first when the combined budget is tight. The cockpit
  // still renders project context before user context so authority increases
  // toward the exact task at the recency edge.
  const combined = renderCombined(
    [...files].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "user" ? -1 : 1)),
    maxTotalBytes,
  );
  if (combined.truncated) {
    diagnostics.push(`Combined context files were truncated to ${maxTotalBytes} bytes.`);
  }
  return { files: combined.files, combined: combined.text, diagnostics };

  async function maybeLoad(absolute: string, source: string, kind: "project" | "user") {
    try {
      if (!existsSync(absolute)) return;
      const info = await stat(absolute);
      if (!info.isFile()) return;
      const raw = await readFile(absolute, "utf8");
      const hash = createHash("sha256").update(raw).digest("hex");
      if (seenContentHashes.has(hash)) {
        diagnostics.push(`Skipped duplicate context file '${source}' (same content as an earlier file).`);
        return;
      }
      seenContentHashes.add(hash);
      const bytes = Buffer.byteLength(raw, "utf8");
      const truncated = bytes > maxFileBytes;
      const content = truncated ? truncateBytes(raw, maxFileBytes) : raw;
      if (truncated) {
        diagnostics.push(`Context file '${source}' was truncated to ${maxFileBytes} bytes.`);
      }
      files.push({ source, content, truncated, bytes, kind });
    } catch {
      // ignore unreadable files
    }
  }
}

/**
 * Directories from `start` up to filesystem root, stopping after the
 * nearest directory that contains `.git` (inclusive of that dir's parents
 * are not walked — git root is the ceiling).
 */
export function collectAncestorDirs(start: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(start);
  const root = path.parse(current).root;
  while (true) {
    dirs.push(current);
    if (existsSync(path.join(current, ".git"))) break;
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function truncateBytes(text: string, maxBytes: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low);
}

function renderCombined(
  files: ContextFile[],
  maxTotalBytes: number,
): { files: ContextFile[]; text: string; truncated: boolean } {
  const parts: string[] = [];
  let truncated = false;
  let used = 0;
  const kept: ContextFile[] = [];

  for (const file of files) {
    const open = `<<<${file.kind.toUpperCase()}_CONTEXT: ${file.source}>>>`;
    const close = `<<<END_${file.kind.toUpperCase()}_CONTEXT>>>`;
    const chunk = `${open}\n${file.content}\n${close}\n\n`;
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (used + chunkBytes > maxTotalBytes) {
      truncated = true;
      break;
    }
    parts.push(chunk);
    used += chunkBytes;
    kept.push({ ...file });
  }

  return { files: kept, text: parts.join("").trimEnd(), truncated };
}
