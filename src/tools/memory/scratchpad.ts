/**
 * tools/memory/scratchpad.ts — model-facing working notes.
 *
 * Durable append/read/clear for `.reaper/memory/scratch.md` so intermediate
 * decisions survive shake / full-summary compaction across long runs.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { redactSecrets } from "../../logging/redaction.js";

export type ScratchpadAction = "append" | "read" | "clear";

export interface ScratchpadArgs {
  action: ScratchpadAction;
  note?: string;
  label?: string;
}

export interface ScratchpadResult {
  action: ScratchpadAction;
  path: string;
  content?: string;
  bytes: number;
  appended?: boolean;
  cleared?: boolean;
}

const SCRATCH_RELATIVE = path.join(".reaper", "memory", "scratch.md");
const MAX_SCRATCH_BYTES = 64 * 1024;

export function scratchpadPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, SCRATCH_RELATIVE);
}

export async function executeScratchpad(
  args: ScratchpadArgs,
  options: { workspaceRoot: string },
): Promise<ScratchpadResult> {
  const filePath = scratchpadPath(options.workspaceRoot);
  await mkdir(path.dirname(filePath), { recursive: true });

  switch (args.action) {
    case "append": {
      if (typeof args.note !== "string" || args.note.trim().length === 0) {
        throw new Error("scratchpad append requires a non-empty note");
      }
      const redacted = String(redactSecrets(args.note));
      const label = typeof args.label === "string" && args.label.trim() ? args.label.trim() : undefined;
      const stamp = new Date().toISOString();
      const header = label ? `## [${stamp}] ${label}` : `## [${stamp}]`;
      const block = `${header}\n${redacted.trim()}\n\n`;

      let existing = "";
      if (existsSync(filePath)) {
        existing = await readFile(filePath, "utf8");
      }
      let next = existing + block;
      if (Buffer.byteLength(next, "utf8") > MAX_SCRATCH_BYTES) {
        // Keep the newest tail within the cap.
        const buf = Buffer.from(next, "utf8");
        next = buf.subarray(buf.length - MAX_SCRATCH_BYTES).toString("utf8");
        const firstNl = next.indexOf("\n");
        if (firstNl > 0 && firstNl < 200) next = next.slice(firstNl + 1);
      }
      await writeFile(filePath, next, "utf8");
      return {
        action: "append",
        path: SCRATCH_RELATIVE,
        bytes: Buffer.byteLength(next, "utf8"),
        appended: true,
      };
    }
    case "read": {
      if (!existsSync(filePath)) {
        return { action: "read", path: SCRATCH_RELATIVE, content: "", bytes: 0 };
      }
      const content = await readFile(filePath, "utf8");
      return {
        action: "read",
        path: SCRATCH_RELATIVE,
        content,
        bytes: Buffer.byteLength(content, "utf8"),
      };
    }
    case "clear": {
      await writeFile(filePath, "", "utf8");
      return { action: "clear", path: SCRATCH_RELATIVE, bytes: 0, cleared: true };
    }
    default: {
      const _exhaustive: never = args.action;
      throw new Error(`Unknown scratchpad action: ${String(_exhaustive)}`);
    }
  }
}
