import { chmodSync, existsSync, mkdirSync, realpathSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type ProjectTrustDecision = "trusted" | "untrusted" | "session";

export interface ProjectTrustStoreEntry {
  workspaceRoot: string;
  trusted: boolean;
  updatedAt: number;
}

export type ProjectTrustResolutionSource =
  | "no-project-resources"
  | "remembered-trusted"
  | "remembered-untrusted"
  | "default-always"
  | "default-never"
  | "ask-persisted"
  | "ask-denied"
  | "ask-session";

export interface ProjectTrustResolution {
  trusted: boolean;
  source: ProjectTrustResolutionSource;
  requiresTrust: boolean;
}

export interface ResolveProjectTrustedOptions {
  workspaceRoot: string;
  store?: ProjectTrustStore;
  defaultDecision?: "ask" | "always" | "never";
  ask?: () => Promise<ProjectTrustDecision>;
}

const TRUST_REQUIRING_PROJECT_PATHS = [
  [".reaper", "settings.json"],
  [".reaper", "extensions"],
  [".reaper", "hooks"],
  [".reaper", "packages"],
  [".reaper", "prompts"],
  [".reaper", "skills"],
  [".reaper", "themes"],
  [".agents", "skills"],
  [".agents", "extensions"],
];

/**
 * Find the nearest ancestor directory that contains an `.agents` folder
 * (or `.reaper`-equivalent trust anchor) and return its absolute path. This
 * mirrors the reference agent's "ancestor .agents/skills" detection so we
 * recognize sibling agent directories without loading them as project
 * resources until the user explicitly trusts the project.
 */
export async function findNearestAncestorAgentsRoot(workspaceRoot: string): Promise<string | null> {
  const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
  let current: string | null = canonical;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    for (const anchor of [".agents", ".reaper"]) {
      const candidate = path.join(current, anchor);
      if (await pathExistsWithContent(candidate)) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export class ProjectTrustStore {
  static create(userHome: string = homedir()): ProjectTrustStore {
    return new ProjectTrustStore(userHome);
  }

  private readonly filePath: string;

  private constructor(private readonly userHome: string) {
    this.filePath = path.join(userHome, ".reaper", "project-trust.json");
  }

  async get(workspaceRoot: string): Promise<boolean | null> {
    const key = canonicalizeWorkspaceRoot(workspaceRoot);
    const entries = this.readEntries();
    const entry = entries.find((candidate) => canonicalizeWorkspaceRoot(candidate.workspaceRoot) === key);
    return entry ? entry.trusted : null;
  }

  async set(workspaceRoot: string, trusted: boolean): Promise<void> {
    const key = canonicalizeWorkspaceRoot(workspaceRoot);
    const entries = this.readEntries().filter((entry) => canonicalizeWorkspaceRoot(entry.workspaceRoot) !== key);
    entries.push({ workspaceRoot: key, trusted, updatedAt: Date.now() });
    this.writeEntries(entries);
  }

  async setMany(entries: ProjectTrustStoreEntry[]): Promise<void> {
    const current = this.readEntries();
    const byRoot = new Map<string, ProjectTrustStoreEntry>();
    for (const entry of current) byRoot.set(canonicalizeWorkspaceRoot(entry.workspaceRoot), entry);
    for (const entry of entries) {
      const key = canonicalizeWorkspaceRoot(entry.workspaceRoot);
      byRoot.set(key, { workspaceRoot: key, trusted: entry.trusted, updatedAt: entry.updatedAt ?? Date.now() });
    }
    this.writeEntries([...byRoot.values()]);
  }

  /**
   * Walk parent directories upward from `workspaceRoot` and return the
   * nearest-ancestor trust entry, if any. This matches the reference
   * agent's behavior of looking up `.pi`-equivalent trust at the closest
   * enclosing project root.
   */
  async getNearestAncestor(workspaceRoot: string): Promise<ProjectTrustStoreEntry | null> {
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    let current = path.dirname(canonical);
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const entries = this.readEntries();
      const entry = entries.find((candidate) => canonicalizeWorkspaceRoot(candidate.workspaceRoot) === current);
      if (entry) return entry;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    // Also check the exact canonical path before giving up.
    const entries = this.readEntries();
    return entries.find((candidate) => canonicalizeWorkspaceRoot(candidate.workspaceRoot) === canonical) ?? null;
  }

  /**
   * Lock the trust file to read-only so the user has to opt in to any
   * future trust changes. Idempotent. Useful for shared CI environments
   * where a trusted policy should not silently change at runtime.
   */
  lockReadOnly(): void {
    if (!existsSync(this.filePath)) return;
    try {
      chmodSync(this.filePath, 0o444);
    } catch {
      // chmod may not be supported on every platform; ignore failures.
    }
  }

  isLocked(): boolean {
    if (!existsSync(this.filePath)) return false;
    try {
      const s = statSync(this.filePath);
      // Owner write bit cleared == effectively locked.
      return (s.mode & 0o200) === 0;
    } catch {
      return false;
    }
  }

  private readEntries(): ProjectTrustStoreEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      const rawEntries = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
          ? (parsed as { entries: unknown[] }).entries
          : [];
      return rawEntries
        .filter((entry): entry is ProjectTrustStoreEntry => {
          return Boolean(
            entry &&
              typeof entry === "object" &&
              typeof (entry as ProjectTrustStoreEntry).workspaceRoot === "string" &&
              typeof (entry as ProjectTrustStoreEntry).trusted === "boolean",
          );
        })
        .map((entry) => ({
          workspaceRoot: canonicalizeWorkspaceRoot(entry.workspaceRoot),
          trusted: entry.trusted,
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
        }));
    } catch {
      return [];
    }
  }

  private writeEntries(entries: ProjectTrustStoreEntry[]): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify({ entries }, null, 2), "utf8");
  }
}

export async function hasTrustRequiringProjectResources(workspaceRoot: string): Promise<boolean> {
  for (const parts of TRUST_REQUIRING_PROJECT_PATHS) {
    const candidate = path.join(workspaceRoot, ...parts);
    if (await pathExistsWithContent(candidate)) return true;
  }
  return false;
}

export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<ProjectTrustResolution> {
  const store = options.store ?? ProjectTrustStore.create();
  const requiresTrust = await hasTrustRequiringProjectResources(options.workspaceRoot);
  if (!requiresTrust) {
    return { trusted: true, source: "no-project-resources", requiresTrust: false };
  }

  const remembered = await store.get(options.workspaceRoot);
  if (remembered === true) return { trusted: true, source: "remembered-trusted", requiresTrust: true };
  if (remembered === false) return { trusted: false, source: "remembered-untrusted", requiresTrust: true };

  // Inherit from the nearest ancestor's remembered trust decision before
  // falling back to defaults or asking the user.
  const ancestor = await store.getNearestAncestor(options.workspaceRoot);
  if (ancestor && ancestor.workspaceRoot !== canonicalizeWorkspaceRoot(options.workspaceRoot)) {
    return { trusted: ancestor.trusted, source: "remembered-trusted", requiresTrust: true };
  }

  const defaultDecision = options.defaultDecision ?? "never";
  if (defaultDecision === "always") return { trusted: true, source: "default-always", requiresTrust: true };
  if (defaultDecision === "never") return { trusted: false, source: "default-never", requiresTrust: true };

  const decision = options.ask ? await options.ask() : "untrusted";
  if (decision === "trusted") {
    await store.set(options.workspaceRoot, true);
    return { trusted: true, source: "ask-persisted", requiresTrust: true };
  }
  if (decision === "session") {
    return { trusted: true, source: "ask-session", requiresTrust: true };
  }
  return { trusted: false, source: "ask-denied", requiresTrust: true };
}

export function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

async function pathExistsWithContent(candidate: string): Promise<boolean> {
  try {
    const s = await stat(candidate);
    if (s.isFile()) return true;
    if (!s.isDirectory()) return false;
    if (path.basename(candidate) === "packages") return true;
    const entries = await readdir(candidate);
    return entries.some((entry) => entry !== ".gitkeep" && entry !== ".gitignore");
  } catch {
    return false;
  }
}

