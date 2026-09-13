import type { SkillEntry } from "./settings.js";

/**
 * The `/skills` command grammar, shared by the composer and the overlay.
 *
 * This exists as a module rather than inline in `SkillsOverlay.tsx` because
 * three places need to agree on it and disagreeing is a bug that only shows up
 * in a specific keyboard order: Enter submits a message, `/skills` opens the
 * overlay, and the subcommands (`list`, `show`, `pin`) are *actions inside the
 * overlay*, not text that ever gets sent. If the overlay's own parser and the
 * composer's guard drifted, a user could pin a skill and then have `/skills
 * pin codemode` submitted to the model as a prompt.
 */

/** A command the user typed at the head of the composer. */
export type SkillsCommand =
  | { kind: "overlay"; filter?: string }
  | { kind: "pin"; name: string }
  | { kind: "unpin"; name: string }
  | { kind: "show"; name: string };

/**
 * A single line, so that a `/skills` the user kept typing after is a *message*
 * and gets sent rather than silently swallowed. `[^\n]*` and not `[\s\S]*` —
 * the multiline case is exactly the one where deleting the draft would lose
 * something the user wrote on purpose.
 */
const TOKEN = /^\/skills(?:[ \t]+([^\n]*))?$/;

/**
 * Parse a composer draft as a `/skills` command, or return undefined.
 *
 * Anchored to the whole draft: the composer is a message box, and a command
 * that has already grown a second line is not a command any more.
 */
export function parseSkillsCommand(draft: string): SkillsCommand | undefined {
  const match = TOKEN.exec(draft.trim());
  if (!match) return undefined;
  const rest = (match[1] ?? "").trim();
  if (!rest) return { kind: "overlay" };

  const [head, ...tail] = rest.split(/[ \t]+/);
  const name = tail[0];
  switch (head) {
    case "pin":
      return name ? { kind: "pin", name } : { kind: "overlay" };
    case "unpin":
      return name ? { kind: "unpin", name } : { kind: "overlay" };
    case "show":
      return name ? { kind: "show", name } : { kind: "overlay" };
    default:
      // Anything else after `/skills` is a search, which is the most useful
      // reading of `/skills github` and costs no extra syntax to learn.
      return { kind: "overlay", filter: rest };
  }
}

/**
 * The suffix a composer draft adds after a recognized `/skillname ` prefix.
 *
 * Mirrors `resolveInvokedSkill` on the server (`runtime/content-prep.ts`), and
 * deliberately says the same thing: only the first token, only at the very
 * start. That is what keeps `run ls /tmp` and `/usr/bin is missing` from
 * matching a skill named `usr`.
 */
export function skillInvocationSuffix(draft: string, skills: readonly SkillEntry[]): { skill: SkillEntry; suffix: string } | undefined {
  if (/^\s*\/skills(?:\s|$)/.test(draft)) return undefined; // the command, not an invocation
  // Leading whitespace is allowed because the server's own matcher allows it
  // (`/^\s*\//`): the composer sends the draft untrimmed, so a stray space
  // would otherwise load the skill server-side while the UI showed no hint.
  const head = /^\s*(\/[A-Za-z0-9._-]+)(\s[\s\S]*)?$/.exec(draft);
  const name = head?.[1]?.slice(1);
  if (!name) return undefined;
  const skill =
    skills.find((candidate) => candidate.name === name) ??
    skills.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!skill) return undefined;
  return { skill, suffix: head?.[2] ?? "" };
}

/**
 * A label for what a skill body costs, in the unit a person can act on.
 *
 * Characters rather than tokens: the honest number is tokens, but a character
 * count is exact, instant, and off by a stable factor. Rounding to a friendly
 * phrase would be inventing precision in the other direction.
 */
export function describeSkillCost(body: string | undefined): string {
  if (body === undefined) return "always on";
  const chars = body.length;
  if (chars < 1_000) return `${chars} chars in every turn`;
  return `${(chars / 1_000).toFixed(1)}k chars in every turn`;
}

/** Why a skill cannot be turned on, or undefined if it can. */
export function pinBlockReason(skill: SkillEntry): string | undefined {
  if (skill.disabled) return skill.disabledReason ?? "disabled";
  if (skill.trust === "project-untrusted") return "this project is not trusted";
  if (skill.trust === "draft") return "drafts are not loaded into turns";
  return undefined;
}
