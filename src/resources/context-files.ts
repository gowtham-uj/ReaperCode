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
  /** Per-file byte cap. Defaults to 4KB. */
  maxFileBytes?: number;
  /** Total combined byte cap. Defaults to 16KB. */
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
  ".pi/context.md",
];

const PROJECT_CANDIDATES = [
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
];

const USER_CANDIDATES = [".config/reaper/context.md", ".pi/context.md", ".reaper/AGENTS.md", ".reaper/AGENTS.MD"];

export async function loadContextFiles(options: ContextFileLoadOptions): Promise<ContextFileLoadResult> {
  const { workspaceRoot, userHome, trusted = true } = options;
  const maxFileBytes = options.maxFileBytes ?? 4 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 16 * 1024;
  const files: ContextFile[] = [];
  const diagnostics: string[] = [];

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

  for (const relative of PROJECT_CANDIDATES) {
    const absolute = path.join(workspaceRoot, relative);
    await maybeLoad(absolute, relative, "project");
  }

  if (userHome) {
    for (const relative of USER_CANDIDATES) {
      const absolute = path.join(userHome, relative);
      await maybeLoad(absolute, `~/${relative}`, "user");
    }
  }

  const combined = renderCombined(files, maxTotalBytes);
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
