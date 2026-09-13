/**
 * File policy — the UI-driven half of bolt.diy's best idea.
 *
 * `src/policy/local-rules.ts` already parses `- allow:` / `- deny:` lines from
 * `<workspaceRoot>/rules.local.md`; `evaluateCommandPolicy` honors them in
 * every safety profile, so a local `deny` is a hard denial even under yolo.
 * This module is the write side that turns a lock icon in the file tree into
 * an enforced boundary.
 *
 * Safety properties:
 *  - Every rule value is a string validated as a JavaScript RegExp before it
 *    is written. A pattern that cannot compile is rejected — the agent's
 *    policy engine constructs `new RegExp(pattern)` from these lines and a
 *    broken pattern would throw at evaluation time.
 *  - Patterns are never *executed* here. Validation is `new RegExp(text)`
 *    only, so a pattern is inert data.
 *  - Rules are always written to the workspace root's `rules.local.md`,
 *    resolved via `path.resolve` against the root with a trailing-separator
 *    check. The client supplies only the rule text, never a path.
 *  - The write replaces the existing `- allow:` / `- deny:` block and
 *    preserves every other line verbatim. Local rules are first-match-wins in
 *    file order, so order is the caller's meaning and must not be re-sorted.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

import { loadLocalRules } from "../policy/local-rules.js";

export interface FilePolicyRule {
  outcome: "allow" | "deny";
  pattern: string;
}

export interface FilePolicyReadResult {
  /** False when no rules.local.md exists yet. */
  fileExists: boolean;
  rules: FilePolicyRule[];
}

const RULES_FILE = "rules.local.md";
const MAX_RULES = 500;
const MAX_PATTERN_LENGTH = 2_000;

/** A client supplied rules that cannot be written (bad regex, too many, etc.).
 *  `code` maps through message-processor's numeric-code branch to -32602. */
export class InvalidFilePolicyError extends Error {
  readonly code = -32602;
  constructor(message: string) {
    super(message);
    this.name = "InvalidFilePolicyError";
  }
}

export async function readFilePolicy(workspaceRoot: string): Promise<FilePolicyReadResult> {
  const loaded = await loadLocalRules(workspaceRoot);
  if (!loaded) return { fileExists: false, rules: [] };
  return {
    fileExists: true,
    rules: loaded.rules.map((rule) => ({ outcome: rule.outcome, pattern: rule.raw.slice(rule.raw.indexOf(":") + 1).trim() })),
  };
}

/**
 * Replace the entire allow/deny block with `rules`, preserving other lines.
 * `rules` is a flat list — each `{outcome, pattern}` becomes one line.
 */
export async function writeFilePolicy(workspaceRoot: string, rules: FilePolicyRule[]): Promise<FilePolicyReadResult> {
  if (rules.length > MAX_RULES) {
    throw new InvalidFilePolicyError(`Too many rules (${rules.length}); the maximum is ${MAX_RULES}`);
  }
  for (const rule of rules) {
    if (rule.outcome !== "allow" && rule.outcome !== "deny") {
      throw new InvalidFilePolicyError(`Invalid rule outcome: ${String(rule.outcome)}`);
    }
    if (typeof rule.pattern !== "string" || !rule.pattern.trim()) {
      throw new InvalidFilePolicyError("Each rule needs a non-empty pattern");
    }
    if (rule.pattern.length > MAX_PATTERN_LENGTH) {
      throw new InvalidFilePolicyError(`Rule pattern is too long (${rule.pattern.length} chars; max ${MAX_PATTERN_LENGTH})`);
    }
    // Compile-only validation. Never executed — `new RegExp` is what the
    // policy engine itself will do with this line, so a pattern that fails
    // here would throw mid-turn.
    try {
      void new RegExp(rule.pattern);
    } catch {
      throw new InvalidFilePolicyError(`Invalid regular expression: ${rule.pattern}`);
    }
  }

  const target = path.resolve(workspaceRoot, RULES_FILE);
  const existing = readExisting(target);
  const lines = [...existing.header];
  for (const rule of rules) {
    lines.push(`- ${rule.outcome}: ${rule.pattern.trim()}`);
  }
  lines.push(...existing.footer);

  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf8");
  renameSync(tmp, target);

  return await readFilePolicy(workspaceRoot);
}

function readExisting(target: string): { header: string[]; footer: string[] } {
  let content = "";
  try {
    content = readFileSync(target, "utf8");
  } catch {
    return { header: [], footer: [] };
  }
  const all = content.replace(/\r\n/g, "\n").split("\n");
  const header: string[] = [];
  const footer: string[] = [];
  const isRuleLine = (line: string): boolean =>
    /^-\s+(allow|deny):\s+/.test(line.trim());
  // The rule block is everything from the first rule line to the last rule
  // line; surrounding prose is preserved. This is the simplest replacement
  // rule that keeps the user's explanatory markdown intact.
  const first = all.findIndex((line) => isRuleLine(line));
  const last = all.reduce((acc, line, index) => (isRuleLine(line) ? index : acc), -1);
  if (first === -1) {
    return { header: all, footer: [] };
  }
  for (let i = 0; i < first; i++) header.push(all[i]!);
  for (let i = last + 1; i < all.length; i++) footer.push(all[i]!);
  return { header, footer };
}
