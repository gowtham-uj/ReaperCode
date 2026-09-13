/**
 * Always-on skills — the ones whose full body rides in every turn.
 *
 * A skill is normally an *offer*: one line in `<available_skills>`, and the
 * body only when the model or a human asks for it. That is the right default —
 * it keeps the prompt small and lets relevance ranking pick. It is the wrong
 * default for the handful of skills that are simply true all the time, where
 * "the model might notice the offer and decide to load it" is a step that can
 * fail for no good reason.
 *
 * So a pinned skill's body is injected the same way a `/name` invocation is,
 * minus the fact that a human has to type it each turn.
 *
 * Three things this module is deliberate about:
 *
 * **The pin is by name, and names are resolved against the already-gated skill
 * list.** This is the security-relevant part, and it is why the resolution
 * takes a `Skill[]` rather than doing its own discovery. A pinned `deploy`
 * resolves only if `deploy` is in the list the turn was going to use anyway —
 * and that list is the one where project skills already require a trusted
 * workspace. Pinning cannot reach past the trust gate, because it never
 * consults a registry the gate has not already filtered. It is also why the
 * caller passes the *filtered* list: the pin selects from what is offered, it
 * does not add to it.
 *
 * **A missing name is not an error.** Pins are references, and references go
 * stale: a skill gets deleted, renamed, or lives in a project you have moved
 * away from. Refusing the turn, or throwing, would turn a harmless drifted
 * reference into a broken workspace. The pin is dropped and the turn proceeds.
 *
 * **Reading config is tolerant by construction.** The turn path runs on the
 * CLI, in the app-server, and in tests, and none of them should fail because
 * `settings.json` is absent, mid-write, or hand-edited into something
 * malformed. Anything unreadable reads as "nothing is pinned".
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { readRawUserSettings } from "../config/settings-file.js";
import type { Skill } from "./skills.js";

/**
 * How many skills one user may pin.
 *
 * A bound rather than a policy: every pin costs its whole body on every turn,
 * so an unbounded list is an unbounded standing prompt. Fifty is far more than
 * anyone wants — the feature is for the handful of skills that are simply true
 * — and it lives here, next to the code that pays the cost, so the RPC bound
 * and the file bound cannot drift apart.
 */
export const MAX_PINNED_SKILLS = 50;

/**
 * How many skills one user may switch off.
 *
 * A bound for the same reason `MAX_PINNED_SKILLS` has one, though the cost
 * profile is the opposite: a disabled skill is one that never reaches the
 * prompt, so the list's length is bounded only by how many skills a person
 * could plausibly want gone. It exists so a corrupt or hostile settings file
 * cannot carry a list of a million names into every turn's discovery.
 */
export const MAX_DISABLED_SKILLS = 500;

/**
 * Pinned names, cleaned to the one shape all three readers agree on.
 *
 * Trim, drop anything that is not a non-empty string, drop duplicates, and
 * keep the first occurrence's position. Applied on read of a hand-edited file,
 * on the browser's write, and on the CLI's write — so "what is pinned" has a
 * single answer regardless of which door the change came through.
 */
export function normalizePinnedNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Pinned skill names from the user's global settings.
 *
 * Read fresh on every call rather than cached: the app-server is long-lived and
 * a pin toggled in the browser must take effect on the very next turn. The file
 * is small and read once per turn, which is the same order of cost as the skill
 * discovery it sits next to.
 */
export function readPinnedSkills(home: string = homedir()): string[] {
  try {
    const { raw } = readRawUserSettings(home);
    const tunables = raw.runtimeTunables;
    if (!tunables || typeof tunables !== "object" || Array.isArray(tunables)) return [];
    return normalizePinnedNames((tunables as Record<string, unknown>).pinnedSkills);
  } catch {
    // A malformed settings file is a settings problem, not a turn problem. The
    // write path is what refuses bad config; this path only needs to not crash.
    return [];
  }
}

/**
 * Switched-off skill names from the user's global settings.
 *
 * The twin of `readPinnedSkills`, and read the same way for the same reasons:
 * fresh on every call, tolerant of a missing or malformed file, and cleaned
 * through `normalizePinnedNames` so a hand-edited list behaves like one the
 * CLI wrote.
 *
 * This is the *only* place the disabled set is stored. It used to be a marker
 * file inside the skill's own directory, which is not a directory the user
 * necessarily owns — for a built-in skill it is the shipped source tree or a
 * temp directory the bundle regenerates — so `skill disable <builtin>` either
 * edited the installation or quietly did nothing by the next run.
 */
export function readDisabledSkills(home: string = homedir()): string[] {
  try {
    const { raw } = readRawUserSettings(home);
    const tunables = raw.runtimeTunables;
    if (!tunables || typeof tunables !== "object" || Array.isArray(tunables)) return [];
    return normalizePinnedNames((tunables as Record<string, unknown>).disabledSkills);
  } catch {
    // Same tolerance as pinning: an unreadable settings file means "nothing is
    // disabled", never a failed discovery.
    return [];
  }
}

/**
 * The pinned skills that actually exist, paired with the body to inject.
 *
 * Returns `{ name, body }` rather than `Skill` because that is what the cockpit
 * renders and nothing downstream needs the rest. Order follows the pin list, so
 * the prompt is stable across turns — a reordering would invalidate the
 * provider's prompt cache on every request for no benefit.
 */
export function resolvePinnedSkills(
  pinnedNames: readonly string[],
  available: readonly Skill[],
): Array<{ name: string; body: string }> {
  const byName = new Map(available.map((skill) => [skill.name.toLowerCase(), skill]));
  const out: Array<{ name: string; body: string }> = [];
  for (const pinned of pinnedNames) {
    const skill = byName.get(pinned.toLowerCase());
    if (!skill) continue;
    // A skill marked model-invocation-disabled is authoritative about not being
    // loaded automatically; a pin does not override it.
    if (skill.disableModelInvocation) continue;
    const body = readSkillBody(skill.filePath);
    if (body) out.push({ name: skill.name, body });
  }
  return out;
}

/**
 * A skill's markdown, with any YAML frontmatter removed.
 *
 * Frontmatter is a wrapper, not content. If it leaked through, the model would
 * read `---\nname: ...` as the skill's instructions — the same rule the
 * packaged-skill bridge follows, and the reason both strip rather than pass the
 * file through whole.
 */
export function readSkillBody(filePath: string): string | undefined {
  try {
    const raw = readFileSync(filePath, "utf8");
    const withoutFrontmatter = raw.startsWith("---\n")
      ? (() => {
          const end = raw.indexOf("\n---\n", 4);
          return end === -1 ? raw : raw.slice(end + 5);
        })()
      : raw;
    const body = withoutFrontmatter.trim();
    return body.length > 0 ? body : undefined;
  } catch {
    return undefined;
  }
}
