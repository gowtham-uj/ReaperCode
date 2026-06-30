/**
 * SkillRegistry — the in-memory index of all discovered skills,
 * with persistence delegated to the existing `SkillMemoryRegistry`.
 *
 * The new registry is the *first-class* skills surface that:
 *   - holds InstalledSkillRecord (manifest + body + trust)
 *   - delegates persistence to SkillMemoryRegistry (so existing
 *     `skill list` / `skill show` continue to work)
 *   - routes selection through SkillRouter (so the model only sees
 *     summaries, never bodies)
 *   - sets `disableModelInvocation` on every record with trust
 *     below user-trusted, so the hardened `activate_skill` tool
 *     refuses to load the body
 *
 * Lifecycle methods (`installFromPath`, `uninstall`, `createDraft`,
 * `approveDraft`, `testSkill`) live in lifecycle.ts and call into
 * the registry here for persistence.
 */

import type { SkillMemoryRegistry } from "../adaptive/skill-memory-registry.js";
import type { ReaperSkill } from "../adaptive/types.js";
import type { ToolMetadata } from "../governance/tool-metadata.js";
import { SkillRouter } from "./router.js";
import type { InstalledSkillRecord, SkillSummary } from "./types.js";
import { ALL_SKILL_CATEGORIES, SEMVER_REGEX, SKILL_NAME_REGEX } from "./types.js";

export interface SkillRegistryOptions {
  /** Live tool metadata for the validator + extension tool list. */
  builtinMetadata: Record<string, ToolMetadata>;
  /** Extension-registered tools keyed by name. */
  extensionTools?: Record<string, ToolMetadata>;
}

export class SkillRegistry {
  private readonly opts: SkillRegistryOptions;
  private readonly router = new SkillRouter();
  /** name → record. Last write wins (project > user > built-in by
   *  caller ordering; the caller controls the order). */
  private readonly records = new Map<string, InstalledSkillRecord>();

  constructor(opts: SkillRegistryOptions) {
    this.opts = opts;
  }

  /** Add or replace a record. */
  register(record: InstalledSkillRecord): void {
    this.records.set(record.manifest.name, record);
  }

  /**
   * Enable a skill — clears `disableModelInvocation` on the legacy
   * ReaperSkill via SkillMemoryRegistry, and updates the in-memory
   * record so future syncTo() writes carry the change. The trust
   * value is preserved; only the invocation gate flips.
   */
  enable(name: string): boolean {
    const r = this.records.get(name);
    if (!r) return false;
    this.records.set(name, { ...r, disabled: false });
    // No re-sync needed: the body still has disableModelInvocation
    // tied to trust; enable() here is a runtime gate override.
    return true;
  }

  /**
   * Disable a skill — sets the runtime gate so `activate_skill`
   * refuses to load the body, even for trusted skills. Persisted
   * via the memory registry on next syncTo().
   */
  disable(name: string, reason?: string): boolean {
    const r = this.records.get(name);
    if (!r) return false;
    const next: InstalledSkillRecord = { ...r, disabled: true, ...(reason !== undefined ? { disabledReason: reason } : {}) };
    this.records.set(name, next);
    return true;
  }

  /** Remove a record. Returns true if removed. */
  unregister(name: string): boolean {
    return this.records.delete(name);
  }

  /** Get a record by name. */
  get(name: string): InstalledSkillRecord | null {
    return this.records.get(name) ?? null;
  }

  /** List all records, optionally filtered by trust tier. */
  list(opts?: { includeUntrusted?: boolean }): InstalledSkillRecord[] {
    const out = [...this.records.values()];
    if (opts?.includeUntrusted) return out;
    return out.filter((r) => r.trust === "builtin" || r.trust === "user-trusted" || r.trust === "extension-inherited");
  }

  /** Run the router and return summaries (no body). */
  selectTopN(input: { query: string; paths?: string[] | undefined; n?: number | undefined; workspaceRoot?: string | undefined }): SkillSummary[] {
    return this.router.selectTopN({
      query: input.query,
      ...(input.paths ? { paths: input.paths } : {}),
      candidates: [...this.records.values()],
      ...(input.n !== undefined ? { n: input.n } : {}),
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    });
  }

  /** Render a short prompt-injectable block of the selected summaries. */
  formatForPrompt(summaries: SkillSummary[]): string {
    return this.router.renderForPrompt(summaries);
  }

  /**
   * Return the trusted-only set of records. Trusted = the body can
   * be loaded by `activate_skill`. This is the gate the hardened
   * tool consults.
   */
  trusted(): InstalledSkillRecord[] {
    return [...this.records.values()].filter((r) => r.trust === "builtin" || r.trust === "user-trusted" || r.trust === "extension-inherited");
  }

  /**
   * Persist records to the on-disk SkillMemoryRegistry so the
   * existing CLI and tests see them. Sets `disableModelInvocation`
   * for everything below user-trusted (or extension-inherited).
   */
  syncTo(memory: SkillMemoryRegistry): void {
    for (const r of this.records.values()) {
      const skill = recordToReaperSkill(r);
      memory.upsertSkill(skill);
    }
  }

  /** Drop all in-memory records. Test hook. */
  clear(): void {
    this.records.clear();
  }

  /** Get the router for advanced callers. */
  getRouter(): SkillRouter {
    return this.router;
  }

  /**
   * Validate one or all skills. The doctor walks the validator and
   * trust layer; returns a flat report. Used by the `skill doctor`
   * CLI and the `/skills doctor` slash command.
   */
  doctor(name?: string): { name: string; ok: boolean; errors: string[] }[] {
    const out: { name: string; ok: boolean; errors: string[] }[] = [];
    const targets = name ? [this.records.get(name)].filter(Boolean) as InstalledSkillRecord[] : [...this.records.values()];
    for (const r of targets) {
      const errs: string[] = [];
      const m = r.manifest;
      if (!m.name || !SKILL_NAME_REGEX.test(m.name)) errs.push(`bad name "${m.name}"`);
      if (!m.version || !SEMVER_REGEX.test(m.version)) errs.push(`bad version "${m.version}"`);
      if (!m.description) errs.push("missing description");
      if (!ALL_SKILL_CATEGORIES.includes(m.category)) errs.push(`unknown category "${m.category}"`);
      if (!Array.isArray(m.allowedTools)) errs.push("allowedTools missing or not array");
      if (r.trust === "draft") errs.push("trust is draft; run `skill test` then `skill trust`");
      if (r.disabled) errs.push("skill is disabled");
      out.push({ name: r.manifest.name, ok: errs.length === 0, errors: errs });
    }
    return out;
  }

  /** Validation context for the validator. */
  getValidatorContext(): SkillRegistryOptions {
    return this.opts;
  }
}

function recordToReaperSkill(r: InstalledSkillRecord): ReaperSkill {
  // Map the new InstalledSkillRecord → the legacy ReaperSkill shape
  // that SkillMemoryRegistry persists. Trust below user-trusted means
  // disableModelInvocation is set, so activate_skill refuses the body.
  const trusted = r.trust === "builtin" || r.trust === "user-trusted" || r.trust === "extension-inherited";
  const scope: ReaperSkill["scope"] =
    r.scope === "builtin" ? "builtin" : r.scope === "user" ? "user" : "project";
  const allowedTools = r.manifest.allowedTools ?? [];
  const args = (r.manifest.arguments ?? []).map((a) => a.name);
  const description = r.manifest.description;
  const whenToUse = r.manifest.whenToUse ?? description;
  const pathPatterns = r.manifest.pathPatterns ?? [];
  const triggers = r.manifest.triggers ?? [];
  const memoryPolicy = r.manifest.memoryPolicy ?? {
    mayReadProjectMemory: true,
    mayWriteProjectMemory: true,
    mayReadUserMemory: false,
    mayWriteUserMemory: false,
  };
  // The legacy ReaperSkill carries allowedTools + arguments as string arrays;
  // newer fields like triggers/pathPatterns go into body via a JSON footer so
  // they survive round-trips through SkillMemoryRegistry. SkillRegistry is
  // the canonical read path; the legacy registry is just persistence.
  const footer = ["<!-- reaper:triggers " + JSON.stringify(triggers) + " -->",
                  "<!-- reaper:pathPatterns " + JSON.stringify(pathPatterns) + " -->"].join("\n");
  return {
    name: r.manifest.name,
    description,
    type: "prompt",
    scope,
    whenToUse,
    disableAutoInvocation: !trusted,
    disableModelInvocation: !trusted,
    arguments: args,
    allowedTools,
    memoryPolicy,
    body: r.body + (footer ? "\n" + footer : ""),
    references: [],
    sourcePath: r.sourcePath,
    version: 1,
    createdBy: "skill-registry",
    createdAt: new Date(r.installedAt).toISOString(),
    updatedAt: new Date(r.installedAt).toISOString(),
    skillDir: r.skillDir,
  };
}
