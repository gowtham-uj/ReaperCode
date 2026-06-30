/**
 * Discovery — walks the 4 skill locations and produces a flat list
 * of InstalledSkillRecord.
 *
 *   1. Built-in: src/skills/built-in/<name>/{skill.json, SKILL.md}
 *   2. User-global: <userHome>/.reaper/skills/<name>/{skill.json, SKILL.md}
 *   3. Project-local: <workspaceRoot>/.reaper/skills/<name>/{skill.json, SKILL.md}
 *   4. Extension-provided: <extensionRoot>/skills/<name>/{skill.json, SKILL.md}
 *      (passed as `extensionSkillsDirs` at activate time; trust is
 *      `extension-inherited`)
 *
 * `discoverSkills` is the read-only walk used by the registry at boot.
 * `lifecycle.installFromPath` is the write side.
 *
 * Built-in and project skills are walked in this fixed order so
 * duplicates resolve consistently (project wins over built-in).
 * Extension-provided skills are merged last with extension-inherited
 * trust.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import { parseFrontmatter } from "../adaptive/skill-author.js";
import { parseSkillManifest, sha256OfManifest } from "./manifest.js";
import { TrustResolver } from "./trust.js";
import type { ExtensionTrust } from "../extensions/types.js";
import type { InstalledSkillRecord, SkillManifest } from "./types.js";

export interface DiscoveryInput {
  builtinRoot: string;
  userHomeSkillsDir: string;
  projectSkillsDir: string;
  workspaceRoot: string;
  resolver: TrustResolver;
  /** Optional: extra skill directories owned by extensions. */
  extensionSkillsDirs?: Array<{ dir: string; extensionId: string; extensionTrust: ExtensionTrust }>;
}

export interface DiscoveryResult {
  records: InstalledSkillRecord[];
  errors: Array<{ path: string; error: string }>;
}

export function discoverSkills(input: DiscoveryInput): DiscoveryResult {
  const records: InstalledSkillRecord[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  for (const folder of enumerateSkillFolders(input.builtinRoot)) {
    const r = loadSkillFolder(folder, "builtin", input);
    if (r.ok && r.record) records.push(r.record);
    else if (r.error && r.error !== "manifest missing") errors.push({ path: folder, error: r.error });
  }
  for (const folder of enumerateSkillFolders(input.userHomeSkillsDir)) {
    const r = loadSkillFolder(folder, "user", input);
    if (r.ok && r.record) records.push(r.record);
    else if (r.error && r.error !== "manifest missing") errors.push({ path: folder, error: r.error });
  }
  for (const folder of enumerateSkillFolders(input.projectSkillsDir)) {
    const r = loadSkillFolder(folder, "project", input);
    if (r.ok && r.record) records.push(r.record);
    else if (r.error && r.error !== "manifest missing") errors.push({ path: folder, error: r.error });
  }
  for (const ext of input.extensionSkillsDirs ?? []) {
    for (const folder of enumerateSkillFolders(ext.dir)) {
      const r = loadSkillFolder(folder, "extension", input, { extensionId: ext.extensionId, extensionTrust: ext.extensionTrust });
      if (r.ok && r.record) records.push(r.record);
      else if (r.error && r.error !== "manifest missing") errors.push({ path: folder, error: r.error });
    }
  }

  // Dedupe by name. Later wins (project > user > built-in by ordering above).
  const dedup = new Map<string, InstalledSkillRecord>();
  for (const r of records) dedup.set(r.manifest.name, r);
  return { records: [...dedup.values()], errors };
}

function enumerateSkillFolders(root: string): string[] {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const ent of entries) {
    if (ent.startsWith(".")) continue;
    const full = join(root, ent);
    try {
      const st = statSync(full);
      if (st.isDirectory()) out.push(full);
      else if (st.isFile() && ent === "SKILL.md") out.push(root); // a SKILL.md living directly in the dir
    } catch { /* ignore */ }
  }
  return out;
}

interface LoadResult {
  ok: boolean;
  record?: InstalledSkillRecord;
  error?: string;
}

function loadSkillFolder(
  folder: string,
  scope: "builtin" | "user" | "project" | "extension",
  input: DiscoveryInput,
  extension?: { extensionId: string; extensionTrust: ExtensionTrust },
): LoadResult {
  const manifestPath = join(folder, "skill.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, error: "manifest missing" };
  }
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (e) {
    return { ok: false, error: `cannot read manifest: ${(e as Error).message}` };
  }
  let manifest: SkillManifest;
  try {
    manifest = parseSkillManifest(raw);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const skillMdPath = join(folder, "SKILL.md");
  let body = "";
  if (existsSync(skillMdPath)) {
    const mdRaw = readFileSync(skillMdPath, "utf8");
    const parsed = parseFrontmatter(mdRaw);
    if (parsed) body = parsed.body;
  }
  const decision = input.resolver.resolve({
    skillPath: folder,
    declaredTrust: manifest.trust,
    ...(extension ? { extensionTrust: extension.extensionTrust } : {}),
  });
  const record: InstalledSkillRecord = {
    manifest,
    body,
    sourcePath: skillMdPath,
    skillDir: folder,
    trust: decision.trust,
    scope,
    installedAt: Date.now(),
    manifestSha256: sha256OfManifest(manifest),
  };
  if (extension) record.extensionId = extension.extensionId;
  return { ok: true, record };
}

/** Compute the four canonical paths used by discovery. Pure function. */
export function defaultSkillLocations(input: { workspaceRoot: string; userHome: string; builtinRoot: string }): {
  builtin: string;
  user: string;
  project: string;
} {
  return {
    builtin: input.builtinRoot,
    user: join(input.userHome, ".reaper", "skills"),
    project: join(input.workspaceRoot, ".reaper", "skills"),
  };
}

/** Ensure the parent dir of `path` exists; helper for tests + CLI. */
export function ensureDir(path: string): void {
  if (!isAbsolute(path)) throw new Error(`ensureDir requires an absolute path (got ${path})`);
  const parent = path.endsWith(sep) ? path : path;
  // The actual mkdirSync happens in writeSkillManifest — this helper
  // is a typed no-op for symmetry with the discovery API.
  void parent;
}
