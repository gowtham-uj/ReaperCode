/**
 * Read-only inventory of a workspace's installed skills and extensions.
 *
 * This is the app-server's answer to "what can this agent do, and how much do
 * I trust each of those things?". The trust/discovery logic lives in
 * `src/skills/trust.ts` and `src/extensions/trust.ts` and is nontrivial and
 * security-sensitive (a trust.json next to a project skill must never be able
 * to elevate its own trust) — so the UI reads through it instead of
 * reimplementing it.
 *
 * Everything here is derived from the same discovery walks the CLI uses
 * (`discoverSkills`, `ExtensionRegistry.discover`). Nothing writes, nothing
 * activates, nothing loads an extension's main module. Bodies are never
 * returned — only the manifest summary the `activate_skill` tool would gate on.
 *
 * `userHome` is always resolved via `os.homedir()`, never a repo-local `.env`.
 */

import { join } from "node:path";
import os from "node:os";

import { ExtensionRegistry } from "../extensions/registry.js";
import type { ExtensionStatus, ExtensionTrust } from "../extensions/types.js";
import { discoverSkills } from "../skills/discovery.js";
import { TrustResolver } from "../skills/trust.js";
import type { SkillTrust } from "../skills/types.js";
import { builtinSkillsRoot } from "../skills/built-in/index.js";
import { readDisabledSkills } from "../context/pinned-skills.js";

export interface WorkspaceSkillSummary {
  name: string;
  description: string;
  category: string;
  trust: SkillTrust;
  /** "builtin" | "user" | "project" | "extension" — the install location. */
  scope: string;
  disabled: boolean;
  disabledReason?: string;
  /** The owning extension id, when scope === "extension". */
  extensionId?: string;
  /** True when `skill test` has validated this skill at least once. */
  validated: boolean;
}

export interface WorkspaceExtensionSummary {
  id: string;
  version: string;
  description: string;
  trust: ExtensionTrust;
  status: ExtensionStatus;
  /** Permission names only — never granted state that could imply trust. */
  permissions: string[];
  error?: string;
}

export interface WorkspaceInventoryResult<T> {
  data: T[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * List installed skills across all four locations (built-in, user, project,
 * extension), deduplicated by name with project winning over built-in.
 * Sorted by name for a stable UI.
 */
export function listWorkspaceSkills(workspaceRoot: string): WorkspaceInventoryResult<WorkspaceSkillSummary> {
  const userHome = os.homedir();
  const resolver = new TrustResolver({
    builtinRoot: builtinSkillsRoot(),
    userHomeSkillsDir: join(userHome, ".reaper", "skills"),
    projectSkillsDir: join(workspaceRoot, ".reaper", "skills"),
  });
  const discovered = discoverSkills({
    builtinRoot: builtinSkillsRoot(),
    userHomeSkillsDir: join(userHome, ".reaper", "skills"),
    projectSkillsDir: join(workspaceRoot, ".reaper", "skills"),
    workspaceRoot,
    resolver,
    // The browser's /skills list must agree with the CLI's. Both read the same
    // settings list, so a skill switched off in either place shows as off in
    // the other without a restart.
    disabledNames: new Set(readDisabledSkills(userHome)),
  });

  const data: WorkspaceSkillSummary[] = discovered.records
    .map((record) => ({
      name: record.manifest.name,
      description: record.manifest.description,
      category: record.manifest.category,
      trust: record.trust,
      scope: record.scope,
      disabled: record.disabled === true,
      ...(record.disabledReason !== undefined ? { disabledReason: record.disabledReason } : {}),
      ...(record.extensionId !== undefined ? { extensionId: record.extensionId } : {}),
      validated: record.lastValidatedAt !== undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { data, errors: discovered.errors };
}

/**
 * List installed extensions across the three locations (built-in, user,
 * project). Built-in has no on-disk directory today, so the walk is a no-op
 * there — consistent with the CLI's own `extensions-builtin` placeholder.
 */
export function listWorkspaceExtensions(workspaceRoot: string): WorkspaceInventoryResult<WorkspaceExtensionSummary> {
  const userHome = os.homedir();
  const registry = new ExtensionRegistry({
    workspaceRoot,
    userHome,
    // Matches `AdaptiveCLI.ensureExtensionRegistry` so the two never disagree
    // about where built-in extensions would live.
    builtinRoot: join(workspaceRoot, ".reaper", "extensions-builtin"),
  });
  const loaded = registry.discover();
  const data: WorkspaceExtensionSummary[] = loaded
    .map((record) => ({
      id: record.id,
      version: record.manifest.version,
      description: record.manifest.description,
      trust: record.trust,
      status: record.status,
      permissions: record.manifest.permissions,
      ...(record.error !== undefined ? { error: record.error } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { data, errors: registry.getLoadErrors() };
}
