import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { isThemeFileName, listThemeFiles, resolveTheme, type ResolvedTheme } from "./themes.js";

export type ResourceKind = "extensions" | "skills" | "prompts" | "themes";
export type ResourceScope = "project" | "user" | "temporary";
export type ResourceOrigin = "top-level" | "package";
export type ResourceSource = "local" | "auto" | string;

export interface ResourceMetadata {
  source: ResourceSource;
  scope: ResourceScope;
  origin: ResourceOrigin;
  baseDir?: string;
}

export interface ResolvedResource {
  id: string;
  kind: ResourceKind;
  path: string;
  enabled: boolean;
  metadata: ResourceMetadata;
  disabledReason?: "shadowed-by-higher-precedence-resource";
}

export interface ResolvedResources {
  extensions: ResolvedResource[];
  skills: ResolvedResource[];
  prompts: ResolvedResource[];
  themes: ResolvedTheme[];
}

export interface ResourceAccumulator {
  extensions: Map<string, ResolvedResource[]>;
  skills: Map<string, ResolvedResource[]>;
  prompts: Map<string, ResolvedResource[]>;
  themes: Map<string, ResolvedResource[]>;
}

export interface PackageResourceInput {
  root: string;
  source: string;
  scope: ResourceScope;
}

export interface ResolveResourcesInput {
  workspaceRoot: string;
  userHome: string;
  packages?: PackageResourceInput[];
}

interface ReaperPackageManifest {
  extensions: string[] | undefined;
  skills: string[] | undefined;
  prompts: string[] | undefined;
  themes: string[] | undefined;
}

const RESOURCE_KINDS: ResourceKind[] = ["extensions", "skills", "prompts", "themes"];
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export function createEmptyResourceAccumulator(): ResourceAccumulator {
  return {
    extensions: new Map(),
    skills: new Map(),
    prompts: new Map(),
    themes: new Map(),
  };
}

export function resourcePrecedenceRank(metadata: ResourceMetadata): number {
  if (metadata.origin === "package") return 4;
  const scopeBase = metadata.scope === "project" ? 0 : 2;
  return scopeBase + (metadata.source === "local" ? 0 : 1);
}

export async function resolveResources(input: ResolveResourcesInput): Promise<ResolvedResources> {
  const accumulator = createEmptyResourceAccumulator();
  const projectBase = path.join(input.workspaceRoot, ".reaper");
  const userBase = path.join(input.userHome, ".reaper");

  await collectLocalTopLevelResources(accumulator, projectBase, "project", "local");
  await collectLocalTopLevelResources(accumulator, userBase, "user", "local");
  await collectPackageResources(accumulator, input.packages ?? []);

  return finalizeAccumulator(accumulator);
}

async function collectLocalTopLevelResources(
  accumulator: ResourceAccumulator,
  baseDir: string,
  scope: ResourceScope,
  source: ResourceSource,
): Promise<void> {
  for (const kind of RESOURCE_KINDS) {
    if (kind === "themes") {
      const dir = path.join(baseDir, "themes");
      const files = await listThemeFiles(dir);
      for (const filePath of files) {
        await addResource(accumulator, "themes", filePath, {
          scope,
          source,
          origin: "top-level",
          baseDir,
        });
      }
      continue;
    }
    const dir = path.join(baseDir, kind);
    const files = await collectResourceFiles(dir, kind, dir);
    for (const filePath of files) {
      await addResource(accumulator, kind, filePath, {
        scope,
        source,
        origin: "top-level",
        baseDir,
      });
    }
  }
}

async function collectPackageResources(accumulator: ResourceAccumulator, packages: PackageResourceInput[]): Promise<void> {
  for (const pkg of packages) {
    const manifest = await readReaperManifest(pkg.root);
    if (manifest) {
      for (const kind of RESOURCE_KINDS) {
        if (kind === "themes") {
          const entries = manifest.themes ?? [];
          for (const entry of entries) {
            const filePath = path.resolve(pkg.root, entry);
            if (await isFile(filePath)) {
              await addResource(accumulator, "themes", filePath, {
                scope: pkg.scope,
                source: pkg.source,
                origin: "package",
                baseDir: pkg.root,
              });
            }
          }
          continue;
        }
        const entries = manifest[kind] ?? [];
        for (const entry of entries) {
          const filePath = path.resolve(pkg.root, entry);
          if (await isFile(filePath)) {
            await addResource(accumulator, kind, filePath, {
              scope: pkg.scope,
              source: pkg.source,
              origin: "package",
              baseDir: pkg.root,
            });
          }
        }
      }
      continue;
    }

    for (const kind of RESOURCE_KINDS) {
      if (kind === "themes") {
        const dir = path.join(pkg.root, "themes");
        const files = await listThemeFiles(dir);
        for (const filePath of files) {
          await addResource(accumulator, "themes", filePath, {
            scope: pkg.scope,
            source: pkg.source,
            origin: "package",
            baseDir: pkg.root,
          });
        }
        continue;
      }
      const dir = path.join(pkg.root, kind);
      const files = await collectResourceFiles(dir, kind, dir);
      for (const filePath of files) {
        await addResource(accumulator, kind, filePath, {
          scope: pkg.scope,
          source: pkg.source,
          origin: "package",
          baseDir: pkg.root,
        });
      }
    }
  }
}

async function addResource(
  accumulator: ResourceAccumulator,
  kind: ResourceKind,
  filePath: string,
  metadata: ResourceMetadata,
): Promise<void> {
  const id = await inferResourceId(kind, filePath);
  const resource: ResolvedResource = {
    id,
    kind,
    path: filePath,
    enabled: true,
    metadata,
  };
  const target = accumulator[kind];
  const existing = target.get(id) ?? [];
  existing.push(resource);
  target.set(id, existing);
}

function finalizeAccumulator(accumulator: ResourceAccumulator): ResolvedResources {
  const themes: ResolvedTheme[] = [];
  for (const group of accumulator.themes.values()) {
    const sorted = [...group].sort((a, b) => {
      const byRank = resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata);
      if (byRank !== 0) return byRank;
      return a.path.localeCompare(b.path);
    });
    sorted.forEach((resource, index) => {
      if (index === 0) resource.enabled = true;
      else {
        resource.enabled = false;
        resource.disabledReason = "shadowed-by-higher-precedence-resource";
      }
    });
    // Highest precedence theme wins for the resolved theme list.
    const winner = sorted[0];
    if (winner) {
      themes.push({
        id: themeIdFromPath(winner.path),
        path: winner.path,
        format: themeFormatFromPath(winner.path),
        parsed: true,
      });
    }
  }
  themes.sort((a, b) => a.id.localeCompare(b.id));
  return {
    extensions: finalizeKind(accumulator.extensions),
    skills: finalizeKind(accumulator.skills),
    prompts: finalizeKind(accumulator.prompts),
    themes,
  };
}

function finalizeKind(resourcesById: Map<string, ResolvedResource[]>): ResolvedResource[] {
  const all: ResolvedResource[] = [];
  for (const group of resourcesById.values()) {
    const sorted = [...group].sort((a, b) => {
      const byRank = resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata);
      if (byRank !== 0) return byRank;
      return a.path.localeCompare(b.path);
    });
    sorted.forEach((resource, index) => {
      if (index === 0) {
        resource.enabled = true;
      } else {
        resource.enabled = false;
        resource.disabledReason = "shadowed-by-higher-precedence-resource";
      }
      all.push(resource);
    });
  }
  return all.sort((a, b) => {
    const byRank = resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata);
    if (byRank !== 0) return byRank;
    const byId = a.id.localeCompare(b.id);
    if (byId !== 0) return byId;
    return a.path.localeCompare(b.path);
  });
}

async function collectResourceFiles(dir: string, kind: ResourceKind, rootDir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const ignores = await readIgnoreRules(dir);
  const files: string[] = [];
  await walk(dir, rootDir, ignores, async (filePath, entryName) => {
    if (kind === "skills") {
      if (entryName === "SKILL.md") files.push(filePath);
      return;
    }
    if (kind === "prompts") {
      if (entryName.endsWith(".md")) files.push(filePath);
      return;
    }
    if (kind === "extensions") {
      if (entryName === "extension.json" || entryName === "index.js" || entryName === "index.ts" || entryName.endsWith(".js")) {
        files.push(filePath);
      }
    }
  });

  // If an extension directory has both extension.json and index.js, the executable entrypoint is more useful.
  if (kind === "extensions") {
    const byDir = new Map<string, string[]>();
    for (const filePath of files) {
      const list = byDir.get(path.dirname(filePath)) ?? [];
      list.push(filePath);
      byDir.set(path.dirname(filePath), list);
    }
    const preferred: string[] = [];
    for (const list of byDir.values()) {
      preferred.push(list.find((filePath) => path.basename(filePath) === "index.js") ?? list[0]!);
    }
    return preferred;
  }

  return files;
}

async function walk(
  dir: string,
  rootDir: string,
  ignores: string[],
  onFile: (filePath: string, entryName: string) => Promise<void> | void,
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    const rel = toPosix(path.relative(rootDir, fullPath));
    if (isIgnored(rel, entry.isDirectory(), ignores)) continue;
    if (entry.isDirectory()) {
      await walk(fullPath, rootDir, ignores, onFile);
      continue;
    }
    if (entry.isFile()) await onFile(fullPath, entry.name);
  }
}

async function readIgnoreRules(dir: string): Promise<string[]> {
  const rules: string[] = [];
  for (const name of IGNORE_FILE_NAMES) {
    const filePath = path.join(dir, name);
    if (!(await isFile(filePath))) continue;
    try {
      const raw = await readFile(filePath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        rules.push(toPosix(trimmed.replace(/^\//, "")));
      }
    } catch {
      // ignore unreadable ignore files
    }
  }
  return rules;
}

function isIgnored(rel: string, isDirectory: boolean, rules: string[]): boolean {
  const target = isDirectory ? `${rel}/` : rel;
  return rules.some((rule) => {
    if (rule.endsWith("/")) return target === rule || target.startsWith(rule);
    return target === rule || target.startsWith(`${rule}/`);
  });
}

async function inferResourceId(kind: ResourceKind, filePath: string): Promise<string> {
  if (kind === "themes") return themeIdFromPath(filePath);
  if (kind === "prompts") return stripExtension(path.basename(filePath));
  if (kind === "skills") {
    const frontmatterName = await readFrontmatterName(filePath);
    return frontmatterName ?? path.basename(path.dirname(filePath));
  }
  const manifestPath = path.basename(filePath) === "extension.json" ? filePath : path.join(path.dirname(filePath), "extension.json");
  const manifestId = await readJsonStringField(manifestPath, "id");
  return manifestId ?? stripExtension(path.basename(path.dirname(filePath) === path.dirname(path.dirname(filePath)) ? filePath : path.dirname(filePath)));
}

async function readFrontmatterName(filePath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const match = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
    if (!match) return undefined;
    const name = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(match[1] ?? "");
    return name?.[1]?.trim();
  } catch {
    return undefined;
  }
}

async function readJsonStringField(filePath: string, field: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function themeIdFromPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function themeFormatFromPath(filePath: string): ResolvedTheme["format"] {
  return path.extname(filePath).toLowerCase() === ".json" ? "json" : "css";
}

async function readReaperManifest(packageRoot: string): Promise<ReaperPackageManifest | null> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!(await isFile(packageJsonPath))) return null;
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as { reaper?: unknown };
    if (!parsed.reaper || typeof parsed.reaper !== "object") return null;
    const record = parsed.reaper as Record<string, unknown>;
    return {
      extensions: arrayOfStrings(record.extensions),
      skills: arrayOfStrings(record.skills),
      prompts: arrayOfStrings(record.prompts),
      themes: arrayOfStrings(record.themes),
    };
  } catch {
    return null;
  }
}

function arrayOfStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
