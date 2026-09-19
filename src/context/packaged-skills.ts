/**
 * Packaged skills, in the shape the prompt wants.
 *
 * Two registries describe the same folders. `src/skills/discovery.ts` produces
 * an `InstalledSkillRecord` — trust, manifest, body — and is what
 * `activate_skill` gates on. `src/context/skills.ts` produces the `Skill`
 * summary the prompt block and the router consume. This module is the one-way
 * bridge between them, so a skill that ships with Reaper is both *offered* in
 * the prompt and *servable* by activation without anyone maintaining the same
 * list twice.
 *
 * Only packaged skills go through here. User and project skills are still read
 * by `context/skills.ts`'s own walk of the workspace, because that walk is the
 * one that respects project trust.
 */

import { readFileSync } from "node:fs";

import { builtinSkillsRoot } from "../skills/built-in/index.js";
import { discoverSkills } from "../skills/discovery.js";
import { TrustResolver } from "../skills/trust.js";
import { readDisabledSkills } from "./pinned-skills.js";
import type { Skill } from "./skills.js";

/*
 * Both caches are keyed by the user's switched-off list.
 *
 * The comment above says these are "read once per process: they are compiled
 * into the binary and cannot change while it runs". That is true of the
 * *skills* and false of what this module now answers, because whether a
 * packaged skill is offered depends on the user's settings, and the app-server
 * is long-lived by design — a skill switched off in the browser would still
 * have been offered on every turn until the process restarted. The skill files
 * are immutable; the filter over them is not. Keying on the filter is what
 * makes one cache serve both facts correctly.
 */
let cachedKey: string | undefined;
let cached: Skill[] | undefined;
let cachedBodiesKey: string | undefined;
let cachedBodies: Map<string, string> | undefined;

/** The disabled set, as a stable cache key. */
function disabledKey(): string {
  return readDisabledSkills().slice().sort().join("\u0000");
}

/**
 * The packaged skills, as prompt summaries. Read once per process: they are
 * compiled into the binary and cannot change while it runs.
 */
export function packagedSkills(): Skill[] {
  const key = disabledKey();
  if (cached && cachedKey === key) return cached;
  const builtinRoot = builtinSkillsRoot();
  let out: Skill[] = [];
  try {
    const { records } = discoverSkills({
      builtinRoot,
      // Empty, on purpose. A user- or project-scoped copy of a packaged skill
      // shadows it at activation time; duplicating that precedence here would
      // put the same name in the prompt twice.
      userHomeSkillsDir: "",
      projectSkillsDir: "",
      workspaceRoot: "",
      resolver: new TrustResolver({ builtinRoot, userHomeSkillsDir: "", projectSkillsDir: "" }),
      disabledNames: new Set(readDisabledSkills()),
    });
    out = records
      .filter((record) => record.trust === "builtin" && record.disabled !== true)
      .map((record) => ({
        name: record.manifest.name,
        description: record.manifest.description,
        filePath: record.sourcePath,
        disableModelInvocation: false,
        /*
         * The manifest's `whenToUse`, carried across the bridge.
         *
         * This is the missing hop, and it is the whole reason `activate_skill`
         * never fired: every built-in skill declares when it should be loaded
         * ("Before any browser_use call", for the browser skill), the manifest
         * parsing read it, and this mapping did not copy it. The catalogue then
         * rendered name and description alone, so the model had a list of skills
         * it could load and no line saying when.
         */
        ...(record.manifest.whenToUse ? { whenToUse: record.manifest.whenToUse } : {}),
        ...(record.manifest.triggers ? { tags: record.manifest.triggers } : {}),
      }));
  } catch {
    // A packaged skill that fails to parse must not take the turn down with
    // it; the same rule discovery itself follows.
    out = [];
  }
  cached = out;
  cachedKey = key;
  return out;
}

/**
 * The body `activate_skill` would serve for a packaged skill, or undefined.
 *
 * Kept separate from `packagedSkills` because the two are used at different
 * moments and the body is the expensive half: the summaries go into every
 * turn's prompt, the body only when someone actually asks for that skill.
 */
export function packagedSkillBody(name: string): string | undefined {
  const key = disabledKey();
  if (!cachedBodies || cachedBodiesKey !== key) {
    const bodies = new Map<string, string>();
    try {
      const builtinRoot = builtinSkillsRoot();
      const { records } = discoverSkills({
        builtinRoot,
        userHomeSkillsDir: "",
        projectSkillsDir: "",
        workspaceRoot: "",
        resolver: new TrustResolver({ builtinRoot, userHomeSkillsDir: "", projectSkillsDir: "" }),
        disabledNames: new Set(readDisabledSkills()),
      });
      /*
       * `record.body` is empty when `SKILL.md` has no `---` frontmatter — the
       * loader only extracts a body through `parseFrontmatter`, which returns
       * null and contributes nothing when there is nothing to strip. Packaged
       * skills carry their metadata in `skill.json` and their prose in a plain
       * markdown file, so the empty-bodied case is the *normal* one, not an
       * error. Reading the file directly covers both shapes.
       */
      for (const record of records) {
        if (record.trust !== "builtin" || record.disabled === true) continue;
        const body = record.body || readFileSync(record.sourcePath, "utf8");
        if (body.trim()) bodies.set(record.manifest.name, body.trim());
      }
    } catch {
      /* same rule as above: a broken packaged skill is not a failed turn */
    }
    cachedBodies = bodies;
    cachedBodiesKey = key;
  }
  return cachedBodies.get(name);
}
