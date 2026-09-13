/**
 * `~/.reaper/settings.json` — the one place that reads and writes it.
 *
 * This module exists because there turned out to be two callers: the browser's
 * `settings/write` RPC, and the CLI's `/skills pin`. Two implementations of
 * "load, merge one field, validate, write atomically" would be two chances to
 * get the atomicity or the validation wrong, and the failure mode is nasty —
 * a truncated config, or a file that passes at write time and fails at boot.
 *
 * Three invariants, stated once:
 *
 *  1. **The document is a partial config, not a whole one.** A file containing
 *     only `runtimeTunables` is valid user settings even though
 *     `ReaperConfigSchema` would reject it standalone, because `models` has no
 *     default. Everything here validates against `.partial()`.
 *  2. **A mutator sees the whole document and returns the whole document.**
 *     Merging happens on a JSON-level copy of the raw object, so a key this
 *     build has no opinion about passes through the mutator untouched instead
 *     of being reconstructed from the parsed config and lost.
 *  3. **A write is all-or-nothing.** Validation runs both *before* (so a
 *     broken file is reported rather than silently merged into) and *after*
 *     (so a bug in a mutator cannot commit an invalid config). The file itself
 *     is replaced by `rename` of a same-directory temp file.
 *
 * What validation does *not* do is accept unknown keys: `ReaperConfigSchema` is
 * `.strict()` at every level, so a file carrying a key this build does not know
 * — a newer Reaper's setting, or a typo — refuses to be written at all rather
 * than being silently dropped or silently kept. That is deliberate: a write is
 * the one moment Reaper can tell the user their file disagrees with this build,
 * and doing it at the loud moment beats doing it at next boot. The cost is that
 * adding a settings key means adding it to the schema; the `.strict()` failure
 * is what makes forgetting that impossible to miss.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { ReaperConfigSchema } from "./model-config.js";

export const USER_SETTINGS_FILE = "settings.json";

export function userSettingsPath(home: string = homedir()): string {
  return path.join(home, ".reaper", USER_SETTINGS_FILE);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function describe(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string {
  const issue = error.issues[0];
  if (!issue) return "parse failed";
  const where = issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
  return `${where}${issue.message}`;
}

/**
 * The raw JSON object on disk, without interpretation.
 *
 * Read structurally rather than through a schema, because the caller decides
 * which fields it understands and everything else must survive untouched.
 */
export function readRawUserSettings(home: string = homedir()): { raw: Record<string, unknown>; fileExists: boolean } {
  const target = userSettingsPath(home);
  if (!existsSync(target)) return { raw: {}, fileExists: false };
  const text = readFileSync(target, "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!isPlainObject(parsed)) return { raw: {}, fileExists: false };
  return { raw: parsed, fileExists: true };
}

/**
 * Merge one change into the user's settings and commit it.
 *
 * `patch` receives the current document and returns the next one. It is called
 * exactly once, after the existing file has been validated, and its result is
 * validated before anything touches disk — so a mutator that produces nonsense
 * raises instead of persisting it.
 */
export function updateUserSettings(
  home: string,
  patch: (before: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const { raw, fileExists } = readRawUserSettings(home);
  const before = fileExists ? raw : {};

  // Validate what is already there before mutating. A broken file must be
  // fixed by hand — merging into it could mask the error and produce a file
  // that still fails to parse at next boot.
  if (fileExists) {
    const parsed = ReaperConfigSchema.partial().safeParse(before);
    if (!parsed.success) {
      throw new Error(`The existing config is invalid and was left untouched: ${describe(parsed.error)}`);
    }
  }

  const next = patch(before);

  const parsed = ReaperConfigSchema.partial().safeParse(next);
  if (!parsed.success) {
    throw new Error(`Refusing to write an invalid config: ${describe(parsed.error)}`);
  }

  const target = userSettingsPath(home);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // Same directory as the target, so the rename is atomic on the same
  // filesystem. A cross-device rename would silently degrade to copy+unlink.
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
  return next;
}
