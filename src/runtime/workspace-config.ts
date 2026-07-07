/**
 * src/runtime/workspace-config.ts — single source of truth for loading
 * Reaper's workspace-level config file.
 *
 * Reaper reads its runtime defaults from a workspace-level JSON file so users
 * can override things like the default context window without rebuilding the
 * runtime. This is the only module that knows how to read that file. Other
 * Reaper code should call `loadReaperConfigFromWorkspace` (async) or
 * `loadReaperConfigFromWorkspaceSync` (sync, used at boot).
 *
 * Search order (first existing + parseable JSON file wins):
 *   1. `<workspaceRoot>/reaper.config.json`
 *   2. `<workspaceRoot>/.reaper/config.json`
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export function ReaperConfigSearchPaths(workspaceRoot: string): string[] {
  return [path.join(workspaceRoot, ".reaper", "config.json")];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function loadReaperConfigFromWorkspace(workspaceRoot: string): Promise<Record<string, unknown>> {
  for (const candidate of ReaperConfigSearchPaths(workspaceRoot)) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isPlainObject(parsed)) {
        return parsed;
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "ENOENT") continue;
      // Parse/EACCES/EISDIR: skip to the next candidate so a broken file
      // doesn't brick startup.
      continue;
    }
  }
  return {};
}

export function loadReaperConfigFromWorkspaceSync(workspaceRoot: string): Record<string, unknown> {
  for (const candidate of ReaperConfigSearchPaths(workspaceRoot)) {
    try {
      if (!existsSync(candidate)) continue;
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isPlainObject(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return {};
}

/**
 * Merge a workspace-level config on top of an explicit config.
 * Explicit values win over on-disk defaults.
 */
export async function mergeWorkspaceConfig(explicit: unknown, workspaceRoot: string): Promise<unknown> {
  const fromDisk = await loadReaperConfigFromWorkspace(workspaceRoot);
  if (!fromDisk) return explicit;
  if (!isPlainObject(explicit)) {
    return fromDisk;
  }
  return { ...fromDisk, ...explicit };
}

/**
 * Sync version of `mergeWorkspaceConfig` for callers that cannot await
 * (e.g. the engine constructor). Same precedence: explicit > on-disk.
 */
/**
 * Deep-merge two configs. The disk config provides the base; explicit
 * overrides apply on top, but for nested objects (e.g. `models`),
 * per-key merging preserves any sibling profiles defined on disk
 * that aren't present in `explicit`. This is critical for the
 * Promote-Context-Model layer (#21): it needs the engine to expose
 * every sibling profile from the workspace config, not just the
 * one explicit config builder happens to know about.
 */
export function mergeWorkspaceConfigSync(explicit: unknown, workspaceRoot: string): unknown {
  const fromDisk = loadReaperConfigFromWorkspaceSync(workspaceRoot);
  if (!fromDisk) return explicit;
  if (!isPlainObject(explicit)) {
    return fromDisk;
  }
  const merged = deepMerge(fromDisk, explicit as Record<string, unknown>);
  // DEBUG
  if (process.env.REAPER_DEBUG_CONFIG_MERGE) {
    process.stderr.write(
      `[merge:debug] fromDisk.models=${Object.keys((fromDisk as any).models || {}).length} ` +
      `explicit.models=${Object.keys(((explicit as any)?.models) || {}).length} ` +
      `merged.models=${Object.keys((merged as any).models || {}).length}\n`,
    );
  }
  return merged;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}