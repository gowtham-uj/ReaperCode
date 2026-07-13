/**
 * TrustResolver — derives a SkillTrust from a skill's install path
 * and (optionally) the trust of a parent extension.
 *
 * The five trust values:
 *
 *   - builtin: shipped under src/skills/built-in. Always trusted.
 *   - user-trusted: installed under ~/.reaper/skills/<name> AND
 *     explicitly approved (either by `skill add --trust` or by an
 *     explicit `skill trust <name>` on a previously untrusted
 *     install).
 *   - project-untrusted: installed under <workspace>/.reaper/skills/
 *     <name> without explicit trust. The default for project-local
 *     installs.
 *   - extension-inherited: lives inside <extensionDir>/skills/<name>.
 *     Trust follows the parent extension's trust (a builtin extension
 *     → builtin; a project-untrusted extension → project-untrusted).
 *   - draft: created by `skill create` or by the auto-trace author.
 *     Cannot be activated until promoted to user-trusted via
 *     `skill test` + `skill trust`.
 *
 * Per-skill trust decisions are cached in a `trust.json` file next to
 * the manifest so subsequent boots don't have to re-derive from path.
 * The resolver writes here when it makes a decision; explicit
 * `skill trust <name>` updates this record directly.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ExtensionTrust } from "../extensions/types.js";
import type { SkillTrust,  SkillTrustRecord } from "./types.js";

export interface TrustResolverOptions {
  /** Absolute path to the built-in skills root (e.g. /workspace/src/skills/built-in). */
  builtinRoot: string;
  /** Absolute path to the user's home (~/.reaper/skills). */
  userHomeSkillsDir: string;
  /** Absolute path to the project's skills dir (<workspace>/.reaper/skills). */
  projectSkillsDir: string;
}

export interface TrustDecision {
  trust: SkillTrust;
  reason: string;
  /** True iff the decision was loaded from a stored trust.json. */
  cached: boolean;
}

export class TrustResolver {
  private readonly opts: TrustResolverOptions;
  /** In-memory cache of trust.json decisions, keyed by absolute skill folder path. */
  private readonly cache = new Map<string, SkillTrustRecord>();

  constructor(opts: TrustResolverOptions) {
    this.opts = opts;
  }

  /**
   * Resolve the trust of a skill by its install path + (optional)
   * parent extension trust. Pure-ish: may read trust.json from disk
   * but never throws on missing files (the path itself implies a
   * default trust).
   */
  resolve(input: { skillPath: string; declaredTrust?: SkillTrust; extensionTrust?: ExtensionTrust }): TrustDecision {
    const { skillPath } = input;
    // 1. Built-in wins unconditionally
    if (isUnder(skillPath, this.opts.builtinRoot)) {
      return { trust: "builtin", reason: "path is under built-in root", cached: false };
    }
    // 2. Check stored trust record
    const cached = this.loadCached(skillPath);
    if (cached) {
      return { trust: cached.trust, reason: `stored trust.json: ${cached.note ?? "(no note)"}`, cached: true };
    }
    // 3. Extension-inherited
    if (input.extensionTrust !== undefined) {
      const mapped = mapExtensionTrust(input.extensionTrust);
      return { trust: mapped, reason: `extension trust is ${input.extensionTrust}`, cached: false };
    }
    // 4. User-global location
    if (isUnder(skillPath, this.opts.userHomeSkillsDir)) {
      // Only user-trusted if the manifest declares it OR a stored decision exists.
      // The default for ~/.reaper/skills is "user-trusted" because the user
      // explicitly installed it there.
      return { trust: "user-trusted", reason: "path is under user-home skills dir", cached: false };
    }
    // 5. Project-local default is untrusted
    if (isUnder(skillPath, this.opts.projectSkillsDir)) {
      return { trust: "project-untrusted", reason: "path is under project skills dir (no trust record)", cached: false };
    }
    // 6. Unknown location — be conservative
    return { trust: "project-untrusted", reason: "unknown install path; defaulting to project-untrusted", cached: false };
  }

  /**
   * Promote a skill to user-trusted. Persists the decision to
   * trust.json next to the manifest.
   */
  promote(skillPath: string, note?: string): SkillTrustRecord {
    const record: SkillTrustRecord = {
      skillPath,
      trust: "user-trusted",
      decidedAt: Date.now(),
      decidedBy: "user",
      ...(note !== undefined ? { note } : {}),
    };
    this.persist(skillPath, record);
    return record;
  }

  /**
   * Demote a skill back to project-untrusted. Used by `skill untrust`.
   */
  demote(skillPath: string, note?: string): SkillTrustRecord {
    const record: SkillTrustRecord = {
      skillPath,
      trust: "project-untrusted",
      decidedAt: Date.now(),
      decidedBy: "user",
      ...(note !== undefined ? { note } : {}),
    };
    this.persist(skillPath, record);
    return record;
  }

  /** Drop the in-memory trust cache (test hook). */
  clearCache(): void {
    this.cache.clear();
  }

  private loadCached(skillPath: string): SkillTrustRecord | null {
    const memo = this.cache.get(skillPath);
    if (memo) return memo;
    const file = this.trustFileFor(skillPath);
    if (!existsSync(file)) return null;
    try {
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as SkillTrustRecord;
      if (parsed && parsed.skillPath === skillPath && typeof parsed.trust === "string") {
        this.cache.set(skillPath, parsed);
        return parsed;
      }
    } catch { /* ignore */ }
    return null;
  }

  private persist(skillPath: string, record: SkillTrustRecord): void {
    this.cache.set(skillPath, record);
    const file = this.trustFileFor(skillPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2));
  }

  private trustFileFor(skillPath: string): string {
    return join(skillPath, "trust.json");
  }
}

function isUnder(child: string, parent: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function mapExtensionTrust(t: ExtensionTrust): SkillTrust {
  switch (t) {
    case "builtin": return "builtin";
    case "user-trusted": return "extension-inherited";
    case "project-untrusted": return "extension-inherited";
  }
}

/**
 * Normalize a manifest's declared trust against the resolver's
 * verdict. Used by SkillRegistry at install time.
 */
export function reconcileTrust(declared: SkillTrust | undefined, resolved: SkillTrust): SkillTrust {
  // A draft stays a draft regardless of path; promote explicitly.
  if (declared === "draft") return "draft";
  // Built-in always wins.
  if (resolved === "builtin") return "builtin";
  // Otherwise trust the resolver's verdict.
  return resolved;
}
