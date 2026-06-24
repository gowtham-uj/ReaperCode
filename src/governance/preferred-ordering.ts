/**
 * Preferred tool ordering rules.
 *
 * The model sometimes issues tool calls in a poor order: editing a
 * file it never read, taking a screenshot before knowing the screen
 * size, calling computer_control when a browser_control would do,
 * etc. The engine doesn't *block* these (the order can be valid
 * for some tasks), but it can surface *advisories* that the model
 * can use to self-correct.
 *
 * The advisory surface is intentionally separate from the policy
 * engine's allow/deny surface. The policy engine returns
 * `{ allow, reason, code, requires_approval }`; the ordering
 * engine returns `{ advisories: OrderingAdvisory[] }` where each
 * advisory is a human-readable suggestion to add to the
 * trajectory.
 *
 * The rules in this file are sequenced as: discover → read → plan
 * → write → run → verify → complete. Cross-tool preferences
 * (browser over computer) are encoded explicitly.
 */

import type { ToolMetadata } from "./tool-metadata.js";
import { getToolMetadata } from "./tool-metadata.js";

/* -------------------------------------------------------------------------- */
/*                                Types                                       */
/* -------------------------------------------------------------------------- */

export type AdvisorySeverity = "info" | "warn";

export interface OrderingAdvisory {
  severity: AdvisorySeverity;
  message: string;
  /** A stable id so trajectories and tests can reference the rule. */
  ruleId: string;
}

export interface OrderingContext {
  /** The name of the tool call currently being considered. */
  currentTool: string;
  /**
   * The ordered history of tool names the agent has issued so far
   * in this run. Most recent call is last.
   */
  recentTools: readonly string[];
  /**
   * True if the call originates from a subagent. The ordering
   * engine still emits advisories, but the engine may choose to
   * suppress them to keep subagent contexts short.
   */
  isSubagentCall: boolean;
}

const EMPTY: OrderingAdvisory[] = Object.freeze([]) as unknown as OrderingAdvisory[];

/* -------------------------------------------------------------------------- */
/*                                Per-tool rules                              */
/* -------------------------------------------------------------------------- */

/**
 * For each tool, the set of ordering advisories to emit given a
 * history of recent tool calls. We index by tool name and return
 * an array of predicates. The predicates are applied in order; a
 * matching predicate yields an advisory.
 */
type Predicate = (recentTools: readonly string[], currentTool: string) => OrderingAdvisory | null;

const RULES: Record<string, Predicate[]> = {
  // ---- Write tools: warn if a write happens before a read of the same path ----
  write_file: [
    (history) => {
      if (history.length === 0) {
        return { severity: "info", ruleId: "ordering.write_first_no_history", message: "Writing a file before any read; consider inspecting the target path first." };
      }
      const lastRead = findLast(history, (t) => t === "read_file" || t === "view_file" || t === "grep_search" || t === "skim_file" || t === "list_directory" || t === "inspect_environment");
      if (lastRead === null) {
        return { severity: "warn", ruleId: "ordering.write_without_read", message: "write_file called without any prior read/list/grep in this run. Verify the target path before overwriting." };
      }
      return null;
    },
  ],

  edit_file: [
    (history) => {
      const lastRead = findLast(history, (t) => t === "read_file" || t === "view_file" || t === "grep_search" || t === "skim_file");
      if (lastRead === null) {
        return { severity: "warn", ruleId: "ordering.edit_without_read", message: "edit_file called without a prior read of the target file. Read the file first to confirm context." };
      }
      return null;
    },
  ],

  replace_in_file: [
    (history) => {
      const lastRead = findLast(history, (t) => t === "read_file" || t === "view_file");
      if (lastRead === null) {
        return { severity: "warn", ruleId: "ordering.replace_without_read", message: "replace_in_file called without a prior read of the target file." };
      }
      return null;
    },
  ],

  replace_symbol: [
    (history) => {
      const lastRead = findLast(history, (t) => t === "read_file" || t === "view_file" || t === "grep_search");
      if (lastRead === null) {
        return { severity: "warn", ruleId: "ordering.replace_symbol_without_read", message: "replace_symbol called without a prior read." };
      }
      return null;
    },
  ],

  delete_file: [
    (history) => {
      const lastRead = findLast(history, (t) => t === "read_file" || t === "view_file" || t === "list_directory");
      if (lastRead === null) {
        return { severity: "warn", ruleId: "ordering.delete_without_read", message: "delete_file called without a prior read or listing." };
      }
      return null;
    },
  ],

  // ---- Shell: warn if a shell command is issued before inspecting the environment ----
  run_shell_command: [
    (history) => {
      const lastInspect = findLast(history, (t) => t === "inspect_environment" || t === "list_directory" || t === "read_file" || t === "view_file");
      if (lastInspect === null && history.length > 0) {
        return { severity: "info", ruleId: "ordering.shell_no_inspect", message: "Running a shell command without a prior inspect_environment / list_directory. Consider inspecting first." };
      }
      return null;
    },
  ],

  // ---- Test runners: prefer running after a write ----
  // (Handled per-tool: classifyCommandRisk already covers 'test runner' as medium.)

  // ---- Browser / computer preference ----
  browser_control: [
    (history) => {
      const lastComputer = findLast(history, (t) => t === "computer_control" || t === "mouse_move" || t === "mouse_click" || t === "keyboard_type" || t === "keyboard_press");
      if (lastComputer !== null) {
        return { severity: "warn", ruleId: "ordering.computer_preferred_over_browser", message: "browser_control is being called after computer_control. Prefer browser_control (DOM-level) for web tasks; use computer_control only when DOM refs are unavailable." };
      }
      return null;
    },
  ],

  computer_control: [
    (history) => {
      const lastBrowser = findLast(history, (t) => t === "browser_control");
      if (lastBrowser === null) {
        return { severity: "info", ruleId: "ordering.browser_preferred_over_computer", message: "computer_control targets the host desktop. Prefer browser_control when the task is web-based — it has DOM refs and is more reliable." };
      }
      return null;
    },
  ],

  // ---- Screenshots: prefer before mouse actions ----
  mouse_move: [
    (history) => {
      const lastScreen = findLast(history, (t) => t === "screenshot" || t === "get_screen_size");
      if (lastScreen === null) {
        return { severity: "info", ruleId: "ordering.mouse_no_screenshot", message: "mouse_move without a recent screenshot or get_screen_size. Capture the screen first to confirm coordinates." };
      }
      return null;
    },
  ],
  mouse_click: [
    (history) => {
      const lastScreen = findLast(history, (t) => t === "screenshot" || t === "get_screen_size");
      if (lastScreen === null) {
        return { severity: "info", ruleId: "ordering.click_no_screenshot", message: "mouse_click without a recent screenshot or get_screen_size. Capture the screen first." };
      }
      return null;
    },
  ],
  keyboard_type: [
    (history) => {
      const lastScreen = findLast(history, (t) => t === "screenshot");
      if (lastScreen === null) {
        return { severity: "info", ruleId: "ordering.type_no_screenshot", message: "keyboard_type without a recent screenshot. Confirm focus first." };
      }
      return null;
    },
  ],

  // ---- completion: prefer a final test run ----
  complete_task: [
    (history) => {
      const lastTest = findLast(history, (t) => t === "run_shell_command");
      if (lastTest === null) {
        return { severity: "warn", ruleId: "ordering.complete_no_test", message: "complete_task called without any shell command in this run. Run tests / verification before completing." };
      }
      return null;
    },
  ],
};

/* -------------------------------------------------------------------------- */
/*                            Public API                                      */
/* -------------------------------------------------------------------------- */

/**
 * Return the advisories for the current tool call. An empty array
 * means the call passes the ordering rules cleanly. Advisories are
 * advisory-only; the policy engine never blocks on them.
 */
export function getOrderingAdvisories(ctx: OrderingContext): OrderingAdvisory[] {
  const rules = RULES[ctx.currentTool];
  if (!rules || rules.length === 0) return EMPTY;
  const out: OrderingAdvisory[] = [];
  for (const r of rules) {
    const a = r(ctx.recentTools, ctx.currentTool);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Returns true iff the given tool has any ordering rules. Used by
 * the policy engine to short-circuit on tools that are unordered
 * (most reads, most process control tools, etc.).
 */
export function hasOrderingRules(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(RULES, toolName);
}

/* -------------------------------------------------------------------------- */
/*                            Internal helpers                                */
/* -------------------------------------------------------------------------- */

function findLast<T>(arr: readonly T[], pred: (t: T) => boolean): T | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== undefined && pred(v)) return v;
  }
  return null;
}

/**
 * Re-export the type for callers that want to build their own
 * predicate pipeline. Not used by the policy engine; exists for
 * future extensions.
 */
export type { Predicate as OrderingPredicate };

/* -------------------------------------------------------------------------- */
/*                            Tool metadata interop                           */
/* -------------------------------------------------------------------------- */

/**
 * Walk the metadata map and return advisories inferred directly
 * from the tool's `preferred_before` / `preferred_after` lists.
 * The static rules in `RULES` cover the structured cases; this
 * surfaces the dynamic ones. Currently a no-op (the structured
 * rules above cover all the cases) but kept as a hook for future
 * auto-generation of rules from the metadata map.
 *
 * The semantic is "at least one of the preferred_before tools
 * must be in recent history for the call to be considered
 * ordered". If any of the preferred tools has been called, no
 * advisories fire — the agent has done *a* read, even if not
 * the specific one the metadata names first.
 */
export function getMetadataDrivenAdvisories(
  currentTool: string,
  recentTools: readonly string[],
): OrderingAdvisory[] {
  const meta: ToolMetadata | null = getToolMetadata(currentTool);
  if (!meta) return [];
  if (meta.preferred_before.length === 0) return [];
  const recent = new Set(recentTools);
  const anySatisfied = meta.preferred_before.some((p) => recent.has(p));
  if (anySatisfied) return [];
  // None of the preferred tools have been called; surface a
  // single advisory listing the first preferred tool as a hint.
  const first = meta.preferred_before[0];
  if (first === undefined) return [];
  return [
    {
      severity: "info",
      ruleId: `metadata.preferred_before.${currentTool}`,
      message: `Consider calling ${first} (or one of: ${meta.preferred_before.join(", ")}) before ${currentTool}.`,
    },
  ];
}
