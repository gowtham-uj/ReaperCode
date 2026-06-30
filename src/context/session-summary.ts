/**
 * Session-level compaction with a durable summary.
 *
 * Reaper already has `compactToolHistory` (per-turn tool result
 * compaction) and micro/reactive compaction strategies. What it does
 * NOT yet have is a session-level summary that survives across many
 * turns and gets fed back into the cockpit as a stable section. This
 * is the equivalent of Claude Code's "task memory" / Codex's
 * "task progress" — a small structured object the agent reads at the
 * start of each turn so it does not have to re-derive intent, decisions,
 * failures, and verification status from the raw tool history.
 *
 * The summary is:
 *
 * - stored in the run directory under `session-summary.json` so it
 *   survives process restarts and can be re-loaded on session resume.
 * - rendered into the cockpit as the "Session Summary" section
 *   (see `renderSessionSummaryForCockpit`).
 * - small enough to keep prompt tokens bounded (a few KB at most).
 *
 * When the session grows too long, the runtime calls
 * `summarizeSessionForCompaction` to derive a fresh summary from the
 * recent tool history. The summary is appended, not overwritten, so
 * the agent retains the long-term intent even as the session evolves.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

export interface SessionSummarySection {
  /** A short bullet point the agent will see; one string per line. */
  bullets: string[];
  /** Last update time (epoch ms). */
  updatedAt: number;
}

export interface SessionSummary {
  intent: SessionSummarySection;
  filesTouched: SessionSummarySection;
  decisions: SessionSummarySection;
  failedAttempts: SessionSummarySection;
  verification: SessionSummarySection;
  openTodos: SessionSummarySection;
  /**
   * Free-form notes the agent (or the operator) wants to keep across
   * turns. Useful for "remember to also test foo" reminders.
   */
  notes: SessionSummarySection;
}

const EMPTY_SECTION: SessionSummarySection = { bullets: [], updatedAt: 0 };

export function createEmptySessionSummary(): SessionSummary {
  return {
    intent: { ...EMPTY_SECTION },
    filesTouched: { ...EMPTY_SECTION },
    decisions: { ...EMPTY_SECTION },
    failedAttempts: { ...EMPTY_SECTION },
    verification: { ...EMPTY_SECTION },
    openTodos: { ...EMPTY_SECTION },
    notes: { ...EMPTY_SECTION },
  };
}

export const SESSION_SUMMARY_MAX_BULLETS = 20;

function clipBullets(bullets: string[]): string[] {
  if (bullets.length <= SESSION_SUMMARY_MAX_BULLETS) return bullets;
  return [
    ...bullets.slice(0, SESSION_SUMMARY_MAX_BULLETS - 1),
    `…(+${bullets.length - SESSION_SUMMARY_MAX_BULLETS + 1} earlier)`,
  ];
}

function normalizeSection(section: SessionSummarySection | undefined): SessionSummarySection {
  if (!section) return { ...EMPTY_SECTION };
  return {
    bullets: clipBullets((section.bullets ?? []).map((b) => b.trim()).filter((b) => b.length > 0)),
    updatedAt: section.updatedAt ?? Date.now(),
  };
}

export function normalizeSessionSummary(input: unknown): SessionSummary {
  const record = (input && typeof input === "object" ? input : {}) as Partial<SessionSummary>;
  return {
    intent: normalizeSection(record.intent),
    filesTouched: normalizeSection(record.filesTouched),
    decisions: normalizeSection(record.decisions),
    failedAttempts: normalizeSection(record.failedAttempts),
    verification: normalizeSection(record.verification),
    openTodos: normalizeSection(record.openTodos),
    notes: normalizeSection(record.notes),
  };
}

/**
 * Append a single bullet to a section, de-duplicating against the most
 * recent N bullets and clipping to SESSION_SUMMARY_MAX_BULLETS.
 */
export function appendBullet(
  summary: SessionSummary,
  section: keyof SessionSummary,
  bullet: string,
  now: number = Date.now(),
): SessionSummary {
  const trimmed = bullet.trim();
  if (!trimmed) return summary;
  const current = summary[section];
  const dedupWindow = new Set(current.bullets.slice(-8));
  const next: string[] = [...current.bullets];
  if (!dedupWindow.has(trimmed)) next.push(trimmed);
  const updated: SessionSummary = {
    ...summary,
    [section]: {
      bullets: clipBullets(next),
      updatedAt: now,
    },
  };
  return updated;
}

export interface SessionSummaryPath {
  workspaceRoot: string;
  /** Stable identifier for the run; defaults to "default". */
  runId?: string;
}

function summaryPath(input: SessionSummaryPath): string {
  const paths = getReaperScratchpadPaths(input.workspaceRoot);
  const runId = input.runId ?? "default";
  return path.join(paths.runs, runId, "session-summary.json");
}

export async function saveSessionSummary(
  input: SessionSummaryPath,
  summary: SessionSummary,
): Promise<void> {
  const filePath = summaryPath(input);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(summary, null, 2), "utf8");
}

export async function loadSessionSummary(
  input: SessionSummaryPath,
): Promise<SessionSummary | undefined> {
  try {
    const raw = await readFile(summaryPath(input), "utf8");
    return normalizeSessionSummary(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Derive a fresh summary from a tool-result history. This is the
 * counterpart to `compactToolHistory`: instead of dropping old
 * results, it extracts the durable parts (intent, files, decisions,
 * failures, verification, open todos) and folds them into a small
 * summary that the agent can re-read on every turn.
 *
 * The current implementation is heuristic and conservative — it pulls
 * out the highest-signal facts rather than asking the LLM to summarize.
 * Future work: plug a model call into the gap to produce richer
 * natural-language summaries for very long sessions.
 */
export function summarizeSessionForCompaction(input: {
  toolResults: Array<{ name: string; ok: boolean; args?: Record<string, unknown>; output?: unknown; error?: { message?: string } }>;
  prompt?: string;
  previous?: SessionSummary;
}): SessionSummary {
  const base = input.previous ? normalizeSessionSummary(input.previous) : createEmptySessionSummary();
  const now = Date.now();

  // 1. Intent: derive from the original prompt if provided, else leave
  // the previous intent untouched.
  if (input.prompt && input.prompt.trim().length > 0) {
    const intent = base.intent.bullets.length ? base.intent : { bullets: [], updatedAt: now };
    if (!intent.bullets.includes(input.prompt.trim())) {
      base.intent = {
        bullets: clipBullets([input.prompt.trim(), ...intent.bullets]),
        updatedAt: now,
      };
    } else {
      base.intent = { ...intent, updatedAt: now };
    }
  }

  // 2. Files touched: collect from write_* / replace_*/ delete_file / read_file
  // (last 30 unique paths, ordered by recency).
  const fileWriteTools = new Set([
    "write_file",
    "replace_in_file",
    "edit_file",
    "replace_symbol",
    "delete_file",
    "create_checkpoint",
    "restore_checkpoint",
  ]);
  const fileReadTools = new Set(["read_file", "view_file", "skim_file", "grep_search", "list_directory"]);
  const seen = new Set<string>();
  const filesTouched: string[] = [];
  for (let i = input.toolResults.length - 1; i >= 0; i -= 1) {
    const r = input.toolResults[i]!;
    const args = (r.args ?? {}) as { path?: unknown };
    if (typeof args.path === "string" && (fileWriteTools.has(r.name) || fileReadTools.has(r.name))) {
      if (!seen.has(args.path)) {
        seen.add(args.path);
        filesTouched.push(args.path);
      }
    }
    if (filesTouched.length >= 30) break;
  }
  base.filesTouched = {
    bullets: clipBullets(filesTouched),
    updatedAt: now,
  };

  // 3. Decisions: the agent's plan/todo writes are decisions. Capture
  // update_plan / update_todo calls.
  const decisions: string[] = [];
  for (let i = input.toolResults.length - 1; i >= 0; i -= 1) {
    const r = input.toolResults[i]!;
    if (!r.ok) continue;
    if (r.name === "update_plan" || r.name === "update_todo") {
      const args = (r.args ?? {}) as { plan?: unknown; items?: unknown };
      if (typeof args.plan === "string" && args.plan.trim()) {
        decisions.push(`plan: ${args.plan.trim().slice(0, 200)}`);
      } else if (Array.isArray(args.items)) {
        for (const item of args.items) {
          if (item && typeof item === "object") {
            const record = item as { content?: unknown; status?: unknown };
            if (typeof record.content === "string" && record.content.trim()) {
              decisions.push(`${record.status ?? "item"}: ${record.content.trim().slice(0, 200)}`);
            }
          }
        }
      }
    }
    if (decisions.length >= 10) break;
  }
  base.decisions = {
    bullets: clipBullets(decisions),
    updatedAt: now,
  };

  // 4. Failed attempts: collect recent failed tool calls (last 10).
  const failures: string[] = [];
  for (let i = input.toolResults.length - 1; i >= 0; i -= 1) {
    const r = input.toolResults[i]!;
    if (r.ok) continue;
    const message = r.error?.message ?? "(no error message)";
    failures.push(`${r.name}: ${message.slice(0, 200)}`);
    if (failures.length >= 10) break;
  }
  base.failedAttempts = {
    bullets: clipBullets(failures),
    updatedAt: now,
  };

  // 5. Verification: capture the most recent passing/failing verification.
  const verification: string[] = [];
  for (let i = input.toolResults.length - 1; i >= 0; i -= 1) {
    const r = input.toolResults[i]!;
    if (r.name !== "bash") continue;
    const args = (r.args ?? {}) as { cmd?: unknown };
    if (typeof args.cmd === "string" && /npm\s+(?:run\s+)?(?:test|run\s+test)|pytest|cargo\s+test/.test(args.cmd)) {
      verification.push(
        r.ok
          ? `PASS ${args.cmd.slice(0, 120)}`
          : `FAIL ${args.cmd.slice(0, 120)} (exitCode=${(r.output as { exitCode?: number } | undefined)?.exitCode ?? "?"})`,
      );
      break;
    }
  }
  base.verification = {
    bullets: clipBullets(verification),
    updatedAt: now,
  };

  return base;
}

/**
 * Render the session summary as a markdown-style block suitable for
 * the cockpit. Empty sections are skipped.
 */
export function renderSessionSummaryForCockpit(summary: SessionSummary | undefined): string {
  if (!summary) return "None.";
  const sections: Array<[string, SessionSummarySection]> = [
    ["Intent", summary.intent],
    ["Files Touched", summary.filesTouched],
    ["Decisions", summary.decisions],
    ["Failed Attempts", summary.failedAttempts],
    ["Verification", summary.verification],
    ["Open Todos", summary.openTodos],
    ["Notes", summary.notes],
  ];
  const lines: string[] = [];
  for (const [title, section] of sections) {
    if (section.bullets.length === 0) continue;
    lines.push(`### ${title}`);
    for (const bullet of section.bullets) {
      lines.push(`- ${bullet}`);
    }
    lines.push("");
  }
  return lines.length === 0 ? "None." : lines.join("\n").trim();
}
