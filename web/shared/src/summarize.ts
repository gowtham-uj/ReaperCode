/**
 * One-line labels for transcript items.
 *
 * The CLI already has a label vocabulary in `src/runtime/session-printer.ts`
 * (`summarizeToolCall`): a tool call reads as its name plus the one argument
 * that identifies it — a path, a command, a pattern. That is the product's
 * existing convention for naming the agent's work, and the web UI uses the
 * same words so a transcript reads the same in both places.
 *
 * Tool names are the real ones from `src/tools/registry.ts`. An unrecognized
 * tool falls back to its most identifying argument rather than rendering
 * bare — a new tool should still read as something.
 */

import type { AppThreadItem } from "./types.js";

const MAX_COMMAND_CHARS = 80;

function truncate(text: string, max = MAX_COMMAND_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The argument that identifies a tool call, matching the CLI's choices. */
export function summarizeToolArgs(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "write_file":
    case "delete_file":
    case "file_edit":
    case "edit_file":
    case "apply_patch_edit":
    case "file_view":
    case "view_file":
    case "skim_file":
    case "file_scroll":
    case "list_directory":
      return str(args.path);
    case "bash":
      return truncate(str(args.command) || str(args.cmd));
    case "grep_search":
    case "file_find":
    case "glob": {
      const pattern = str(args.pattern) || str(args.query);
      const where = str(args.path);
      return where ? `${pattern} in ${where}` : pattern;
    }
    case "web_search":
    case "search_memory":
    case "search_tools":
      return str(args.query);
    case "web_fetch":
      return str(args.url);
    default: {
      // Prefer a recognizable identifier over dumping every argument.
      for (const key of ["path", "command", "query", "pattern", "url", "name"]) {
        const value = str(args[key]);
        if (value) return truncate(value);
      }
      return "";
    }
  }
}

export interface ItemSummary {
  /** Short label naming the action — the accessible name for the row. */
  label: string;
  /** The identifying detail: a path, command, or pattern. May be empty. */
  detail: string;
}

/**
 * A transcript row's label and detail. Kept separate so the UI can style them
 * independently without parsing a concatenated string back apart.
 */
export function summarizeItem(item: AppThreadItem): ItemSummary {
  switch (item.type) {
    case "userMessage":
      return { label: "You", detail: item.content.map((part) => part.text).join("") };
    case "agentMessage":
      return { label: "Agent", detail: item.text };
    case "reasoning":
      return { label: "Thinking", detail: item.content.join("") };
    case "commandExecution":
      return { label: "Ran", detail: truncate(item.command) };
    case "fileChange": {
      const paths = item.changes.map((change) => change.path);
      const first = paths[0] ?? "";
      return {
        label: item.changes.length === 1 ? "Edited" : `Edited ${item.changes.length} files`,
        detail: item.changes.length === 1 ? first : paths.join(", "),
      };
    }
    case "dynamicToolCall":
      return { label: item.tool, detail: summarizeToolArgs(item.tool, item.arguments) };
    case "contextCompaction":
      return { label: "Compacted context", detail: "" };
  }
}

/**
 * Label for a collapsed exploration step: "7 exploration actions".
 * Pluralized here rather than in the view so every call site agrees.
 */
export function summarizeExplorationStep(count: number): string {
  return `${count} exploration ${count === 1 ? "action" : "actions"}`;
}
