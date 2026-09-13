/**
 * One-line labels for transcript items.
 *
 * A compact fallback label: a tool call named by the one argument that
 * identifies it — a path, a command, a pattern. This is what a row shows when
 * it is collapsed, dense, or has no richer representation.
 *
 * It is *not* the primary rendering. The protocol carries far more than a
 * line of text — `fileChange.changes[]` has real diffs, `commandExecution` has
 * `exitCode` and `durationMs`, every item has an `ItemStatus` — and a surface
 * with room should render those directly rather than flatten them to a string.
 *
 * Framework-agnostic by design, like the rest of this package: a terminal
 * client and the web app want the same words for the same call.
 *
 * Tool names are the real ones from `src/tools/registry.ts`. An unrecognized
 * tool falls back to its most identifying argument rather than rendering
 * bare — a new tool should still read as something.
 */

import type { AppThreadItem, ContextTechnique } from "./types.js";

const MAX_COMMAND_CHARS = 80;

/**
 * What each context-management technique is called on screen.
 *
 * Named for the mechanism rather than the outcome, and deliberately not
 * collapsed into a single "compacted" label. "Shook out 12 stale results" and
 * "summarized the conversation" both shrink the context, but only the second
 * can lose a detail the user was relying on, and a person reading a long
 * session needs to be able to tell which happened.
 *
 * These strings are the one vocabulary the web transcript, the CLI printer, and
 * the collapsed-row summary all read, so a terminal and a browser never
 * describe the same event with different words.
 */
export const CONTEXT_TECHNIQUE_LABELS: Record<ContextTechnique, string> = {
  supersede: "Dropped superseded results",
  tool_output_prune: "Trimmed stale output",
  bash_head_tail: "Moved output to disk",
  shake: "Shook out stale results",
  microcompact: "Cleared idle results",
  tool_history: "Summarized tool history",
  snapcompact: "Collapsed image clusters",
  full_summary: "Summarized conversation",
  handoff_summary: "Summarized for handoff",
  idle_compaction: "Compacted while idle",
  incomplete_recovery: "Compacted after interruption",
  ptl_recovery: "Shortened to fit the model",
  model_promotion: "Switched to a larger model",
};

/** Human name for a technique, falling back to the raw name if unknown. */
export function contextTechniqueLabel(technique: string): string {
  return (
    CONTEXT_TECHNIQUE_LABELS[technique as ContextTechnique] ??
    technique.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase())
  );
}

/**
 * "12k characters" / "1.0MB" — the unit a person reads a saving in.
 *
 * Decimals stop at 100M: a figure like "1.0MB" is useful and "1247.3MB" is
 * noise. The CLI and the web badge both read this, so one number never appears
 * two ways on two surfaces.
 */
export function formatSavedChars(chars: number): string {
  if (chars >= 1_000_000) {
    const millions = chars / 1_000_000;
    return `${millions >= 100 ? Math.round(millions) : millions.toFixed(1)}MB`;
  }
  if (chars >= 1_000) return `${Math.round(chars / 1_000)}k characters`;
  return `${chars} characters`;
}

/**
 * The one-line "what it did" for a context row.
 *
 * Prefers the measured saving, then the message-count delta, then the
 * technique's own note. A row that reports nothing at all is better than a row
 * that invents a zero, so this returns an empty string rather than "saved 0".
 */
export function summarizeContextRun(item: {
  savedChars?: number;
  savedTokens?: number;
  messagesBefore?: number;
  messagesAfter?: number;
  detail?: string;
  error?: string;
}): string {
  if (item.error) return item.error;
  const parts: string[] = [];
  if (typeof item.savedChars === "number" && item.savedChars > 0) {
    parts.push(`saved ${formatSavedChars(item.savedChars)}`);
  } else if (typeof item.savedTokens === "number" && item.savedTokens > 0) {
    parts.push(`saved ${item.savedTokens.toLocaleString()} tokens`);
  }
  if (
    typeof item.messagesBefore === "number" &&
    typeof item.messagesAfter === "number" &&
    item.messagesAfter < item.messagesBefore
  ) {
    parts.push(`${item.messagesBefore} → ${item.messagesAfter} messages`);
  } else if (item.detail) {
    parts.push(item.detail);
  }
  return parts.join(" · ");
}

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
    case "skim_file":
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
    /*
     * Code Mode. The detail line is the script's *shape*, not its text — a
     * one-line summary of a 200-line program is not a summary, and the full
     * source is in the expanded body where it can be read at a readable width.
     * "3 lines" tells a reader scanning the transcript whether this was a
     * one-liner or a real program, which is the question the row has to
     * answer.
     */
    case "eval": {
      const code = str(args.code).trim();
      if (!code) return "";
      const firstLine = code.split("\n").find((line) => line.trim()) ?? "";
      const lines = code.split("\n").length;
      return truncate(lines > 1 ? `${firstLine.trim()} (+${lines - 1} more lines)` : firstLine.trim());
    }
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

/**
 * A tool's name, as words a person reads.
 *
 * The label is the tool's *own name*, beautified — `write_file` reads "Write
 * file", `grep_search` reads "Grep search", `eval` reads "Eval". It is not a
 * synonym: an earlier version mapped names to phrases ("Write", "Read",
 * "Search"), which is prettier and worse, because the transcript then used words
 * that appear nowhere else — not in the tool list, not in the docs, not in an
 * error message the model might quote. A person reading a transcript and a
 * person reading `tools.list()` should be looking at the same vocabulary.
 *
 * The transformation is the whole feature: underscores are a fact about how
 * tools are keyed, not something a reader should have to decode, and
 * `apply_patch_edit` on screen is a worse transcript than "Apply patch edit".
 *
 * Sentence case rather than title case: a transcript of titles is harder to
 * scan than a transcript of phrases, and the first word is already the verb.
 */
export function toolLabel(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
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
      /*
       * `toolLabel`, not `item.tool`. The raw key went straight into the
       * label, so every row read `write_file` / `grep_search` / `search_tools`
       * — the registry talking to itself in front of a person.
       */
      return { label: toolLabel(item.tool), detail: summarizeToolArgs(item.tool, item.arguments) };
    case "contextManagement":
      return { label: contextTechniqueLabel(item.technique), detail: summarizeContextRun(item) };
  }
}

/**
 * Label for a collapsed exploration step: "7 exploration actions".
 * Pluralized here rather than in the view so every call site agrees.
 */
export function summarizeExplorationStep(count: number): string {
  return `${count} exploration ${count === 1 ? "action" : "actions"}`;
}
