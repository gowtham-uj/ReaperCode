import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

export interface FailureMemoryEntry {
  runId: string;
  source: string;
  summary: string;
  failureClasses?: string[];
  negativeConstraints?: string[];
  createdAt?: string;
}

interface StoredFailureMemoryEntry extends FailureMemoryEntry {
  createdAt: string;
}

const MAX_ENTRY_CHARS = 1600;
const MAX_FILE_BYTES = 512 * 1024;

export async function loadRecentFailureMemory(workspaceRoot: string, limit = 5): Promise<string[]> {
  const filePath = memoryFile(workspaceRoot);
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    text = text.slice(-MAX_FILE_BYTES);
  }
  const entries: StoredFailureMemoryEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as StoredFailureMemoryEntry;
      if (typeof parsed.summary === "string" && parsed.summary.trim()) {
        entries.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return entries
    .slice(-limit)
    .map((entry) => {
      const classes = entry.failureClasses?.length ? ` classes=${entry.failureClasses.join(",")}.` : "";
      const constraints = entry.negativeConstraints?.length ? ` do_not_repeat=${entry.negativeConstraints.slice(-3).join(" | ")}.` : "";
      return `[${entry.source}] ${entry.summary}${classes}${constraints}`.slice(0, MAX_ENTRY_CHARS);
    });
}

export async function appendFailureMemory(workspaceRoot: string, entry: FailureMemoryEntry): Promise<void> {
  const filePath = memoryFile(workspaceRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const stored: StoredFailureMemoryEntry = {
    runId: entry.runId,
    source: entry.source,
    summary: sanitize(entry.summary, MAX_ENTRY_CHARS),
    ...(entry.failureClasses?.length ? { failureClasses: entry.failureClasses.slice(0, 8).map((item) => sanitize(item, 160)) } : {}),
    ...(entry.negativeConstraints?.length ? { negativeConstraints: entry.negativeConstraints.slice(-8).map((item) => sanitize(item, 240)) } : {}),
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };
  await appendFile(filePath, `${JSON.stringify(stored)}\n`, "utf8");
}

function memoryFile(workspaceRoot: string): string {
  return path.join(getReaperScratchpadPaths(workspaceRoot).memory, "failure-memory.jsonl");
}

function sanitize(value: string, maxChars: number): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .replace(/\/tests\/[^\s'")]+/g, "/tests/<verifier-path>")
    .replace(/[A-Za-z]:\\[^\s'")]+/g, "<absolute-path>")
    .trim()
    .slice(0, maxChars);
}
