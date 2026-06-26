import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ProjectTrustStore } from "./project-trust.js";
import {
  parseResourceSource,
  resolveResourcePath,
  sourceMatchKeyForInput,
  sourceMatchKeyForSettings,
  type ResourceSource,
} from "./source-parser.js";
import type { PackageResourceInput, ResourceKind } from "./resource-loader.js";

export interface ResourcePackageCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ResourcePackageCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<ResourcePackageCommandResult>;

export interface PackageSettingsEntry {
  source: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
}

export interface ConfiguredPackage {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  installedPath: string | undefined;
}

export interface DefaultResourcePackageManagerOptions {
  workspaceRoot: string;
  userHome: string;
  runner: ResourcePackageCommandRunner;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const RESOURCE_KINDS: ResourceKind[] = ["extensions", "skills", "prompts"];

export class DefaultResourcePackageManager {
  private readonly workspaceRoot: string;
  private readonly userHome: string;
  private readonly runner: ResourcePackageCommandRunner;
  private readonly timeoutMs: number;

  constructor(options: DefaultResourcePackageManagerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.userHome = path.resolve(options.userHome);
    this.runner = options.runner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async install(source: string, options: { scope: "user" | "project" }): Promise<void> {
    const parsed = requireParsedSource(source);
    await this.assertTrustedForScope(options.scope);
    if (parsed.type === "local") {
      const resolved = this.getInstalledPath(source, options.scope);
      if (!existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`);
      return;
    }

    if (parsed.type === "npm") {
      const root = this.getNpmInstallRoot(options.scope);
      ensureIgnoredDir(root);
      await this.runner("npm", ["install", "--prefix", root, parsed.spec], {
        cwd: this.workspaceRoot,
        timeoutMs: this.timeoutMs,
      });
      return;
    }

    const installPath = this.getInstalledPath(source, options.scope);
    ensureIgnoredDir(path.dirname(path.dirname(path.dirname(installPath))));
    ensureInsideRoot(installPath, this.getGitInstallRoot(options.scope));
    await this.runner("git", ["clone", "--depth", "1", ...(parsed.ref ? ["--branch", parsed.ref] : []), parsed.repo, installPath], {
      cwd: this.workspaceRoot,
      timeoutMs: this.timeoutMs,
    });
  }

  async addSourceToSettings(source: string, options: { scope: "user" | "project" }): Promise<boolean> {
    await this.assertTrustedForScope(options.scope);
    const filePath = this.getSettingsPath(options.scope);
    const settings = readSettings(filePath);
    const entries = settings.packages ?? [];
    const baseDir = this.getBaseDirForScope(options.scope);
    const inputKey = sourceMatchKeyForInput(source);
    const normalized = normalizeSourceForSettings(source, baseDir);
    let changed = false;
    const next = entries.map((entry) => {
      const existingSource = getPackageSourceString(entry);
      const existingKey = sourceMatchKeyForSettings(existingSource, baseDir);
      if (inputKey && existingKey === inputKey) {
        changed = true;
        return typeof entry === "string" ? normalized : { ...entry, source: normalized };
      }
      return entry;
    });
    if (!changed) next.push(normalized);
    settings.packages = next;
    writeSettings(filePath, settings);
    return true;
  }

  async removeSourceFromSettings(source: string, options: { scope: "user" | "project" }): Promise<boolean> {
    await this.assertTrustedForScope(options.scope);
    const filePath = this.getSettingsPath(options.scope);
    const settings = readSettings(filePath);
    const baseDir = this.getBaseDirForScope(options.scope);
    const inputKey = sourceMatchKeyForInput(source);
    const before = settings.packages ?? [];
    const after = before.filter((entry) => sourceMatchKeyForSettings(getPackageSourceString(entry), baseDir) !== inputKey);
    settings.packages = after;
    writeSettings(filePath, settings);
    return after.length !== before.length;
  }

  listConfiguredPackages(): ConfiguredPackage[] {
    const result: ConfiguredPackage[] = [];
    for (const scope of ["user", "project"] as const) {
      const settings = readSettings(this.getSettingsPath(scope));
      for (const entry of settings.packages ?? []) {
        const source = getPackageSourceString(entry);
        const installedPath = this.getInstalledPath(source, scope);
        result.push({ source, scope, filtered: typeof entry === "object", installedPath: existsSync(installedPath) ? installedPath : undefined });
      }
    }
    return result;
  }

  resolvePackageResourceInputs(): PackageResourceInput[] {
    return this.listConfiguredPackages()
      .filter((entry): entry is ConfiguredPackage & { installedPath: string } => Boolean(entry.installedPath))
      .map((entry) => ({ root: entry.installedPath, source: entry.source, scope: entry.scope }));
  }

  getInstalledPath(source: string, scope: "user" | "project"): string {
    const parsed = requireParsedSource(source);
    if (parsed.type === "npm") {
      return safeJoin(this.getNpmInstallRoot(scope), "node_modules", ...parsed.name.split("/"));
    }
    if (parsed.type === "git") {
      return safeJoin(this.getGitInstallRoot(scope), parsed.host, ...parsed.path.split("/"));
    }
    const baseDir = this.getBaseDirForScope(scope);
    return resolveResourcePath(parsed.path, baseDir);
  }

  private async assertTrustedForScope(scope: "user" | "project"): Promise<void> {
    if (scope !== "project") return;
    const trusted = await ProjectTrustStore.create(this.userHome).get(this.workspaceRoot);
    if (trusted !== true) {
      throw new Error("Project resources are not trusted; refusing project package operation");
    }
  }

  private getNpmInstallRoot(scope: "user" | "project"): string {
    return scope === "project"
      ? path.join(this.workspaceRoot, ".reaper", "packages", "npm")
      : path.join(this.userHome, ".reaper", "packages", "npm");
  }

  private getGitInstallRoot(scope: "user" | "project"): string {
    return scope === "project"
      ? path.join(this.workspaceRoot, ".reaper", "packages", "git")
      : path.join(this.userHome, ".reaper", "packages", "git");
  }

  private getBaseDirForScope(scope: "user" | "project"): string {
    return scope === "project" ? path.join(this.workspaceRoot, ".reaper") : path.join(this.userHome, ".reaper");
  }

  private getSettingsPath(scope: "user" | "project"): string {
    return path.join(this.getBaseDirForScope(scope), "settings.json");
  }
}

export function applyResourcePatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
  if (patterns.length === 0) return new Set();
  const includes: string[] = [];
  const excludes: string[] = [];
  const forceIncludes: string[] = [];
  const forceExcludes: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("+")) forceIncludes.push(pattern.slice(1));
    else if (pattern.startsWith("-")) forceExcludes.push(pattern.slice(1));
    else if (pattern.startsWith("!")) excludes.push(pattern.slice(1));
    else includes.push(pattern);
  }

  let result = includes.length === 0 ? [...allPaths] : allPaths.filter((filePath) => includes.some((pattern) => matchesPattern(filePath, pattern, baseDir)));
  result = result.filter((filePath) => !excludes.some((pattern) => matchesPattern(filePath, pattern, baseDir)));
  for (const filePath of allPaths) {
    if (forceIncludes.some((pattern) => matchesExact(filePath, pattern, baseDir)) && !result.includes(filePath)) {
      result.push(filePath);
    }
  }
  result = result.filter((filePath) => !forceExcludes.some((pattern) => matchesExact(filePath, pattern, baseDir)));
  return new Set(result);
}

function requireParsedSource(source: string): ResourceSource {
  const parsed = parseResourceSource(source);
  if (!parsed) throw new Error(`Unsupported or unsafe package source: ${source}`);
  return parsed;
}

function normalizeSourceForSettings(source: string, baseDir: string): string {
  const parsed = requireParsedSource(source);
  if (parsed.type !== "local") return source;
  const resolved = resolveResourcePath(parsed.path);
  return path.relative(baseDir, resolved) || ".";
}

interface ResourceSettings {
  packages?: Array<string | PackageSettingsEntry>;
}

function readSettings(filePath: string): ResourceSettings {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ResourceSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(filePath: string, settings: ResourceSettings): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf8");
}

function getPackageSourceString(entry: string | PackageSettingsEntry): string {
  return typeof entry === "string" ? entry : entry.source;
}

function ensureIgnoredDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const ignorePath = path.join(dir, ".gitignore");
  if (!existsSync(ignorePath)) writeFileSync(ignorePath, "*\n!.gitignore\n", "utf8");
}

function safeJoin(root: string, ...parts: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...parts);
  ensureInsideRoot(target, resolvedRoot);
  return target;
}

function ensureInsideRoot(target: string, root: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing to use path outside package install root: ${resolvedTarget}`);
  }
}

function matchesExact(filePath: string, pattern: string, baseDir: string): boolean {
  const normalized = normalizePattern(pattern);
  const rel = toPosix(path.relative(baseDir, filePath));
  return rel === normalized || toPosix(filePath) === normalized;
}

function matchesPattern(filePath: string, pattern: string, baseDir: string): boolean {
  const normalized = normalizePattern(pattern);
  const rel = toPosix(path.relative(baseDir, filePath));
  if (!normalized.includes("*")) return rel === normalized || rel.startsWith(`${normalized}/`);
  const regex = new RegExp(`^${escapeRegex(normalized).replace(/\*/g, "[^/]*")}$`);
  return regex.test(rel);
}

function normalizePattern(pattern: string): string {
  return toPosix(pattern.replace(/^\.\//, ""));
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
