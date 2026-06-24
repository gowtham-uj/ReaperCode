import { readdir, readFile, stat, writeFile, rm, mkdir, cp, symlink } from "node:fs/promises";
import path from "node:path";

import { normalizeWorkspacePath, relativeWorkspacePath } from "../policy/paths.js";
import { replaceExactString, replaceLineRange } from "../tools/write/replace-in-file.js";
import { findOwningRoot } from "../workspace/roots.js";

export class MergeConflictError extends Error {
  constructor(
    message: string,
    public readonly conflicts: Array<{ path: string; summary: string; conflictText: string }>,
  ) {
    super(message);
    this.name = "MergeConflictError";
  }
}

interface StagedEntry {
  path: string;
  baseContent: string | null;
  stagedContent: string | null;
}

export class WriteAheadLog {
  private readonly entries = new Map<string, StagedEntry>();
  private readonly workspaceRoots: string[];

  constructor(workspaceRoots: string | string[]) {
    this.workspaceRoots = Array.isArray(workspaceRoots) ? workspaceRoots : [workspaceRoots];
  }

  get primaryRoot(): string {
    return this.workspaceRoots[0]!;
  }

  hasEntries(): boolean {
    return this.entries.size > 0;
  }

  getStagedEntries(): Array<{ path: string; stagedContent: string | null }> {
    return [...this.entries.values()].map((entry) => ({ path: entry.path, stagedContent: entry.stagedContent }));
  }

  getCreatedPaths(): string[] {
    return [...this.entries.values()]
      .filter((entry) => entry.baseContent === null && entry.stagedContent !== null)
      .map((entry) => entry.path);
  }

  private resolvePath(targetPath: string): string {
    if (path.isAbsolute(targetPath)) {
      return findOwningRoot(this.workspaceRoots, targetPath);
    }
    // If relative, assume it's relative to the primary root
    return normalizeWorkspacePath(this.primaryRoot, targetPath);
  }

  private getAbsolutePath(targetPath: string): string {
    if (path.isAbsolute(targetPath)) {
      const root = this.resolvePath(targetPath);
      return normalizeWorkspacePath(root, targetPath);
    }
    return normalizeWorkspacePath(this.primaryRoot, targetPath);
  }

  async stageWrite(targetPath: string, content: string): Promise<void> {
    const absolutePath = this.getAbsolutePath(targetPath);
    const existing = this.entries.get(absolutePath);
    const baseContent = existing?.baseContent ?? (await this.readDiskOrNull(absolutePath));
    this.entries.set(absolutePath, { path: absolutePath, baseContent, stagedContent: content });
  }

  async stageDelete(targetPath: string): Promise<void> {
    const absolutePath = this.getAbsolutePath(targetPath);
    const existing = this.entries.get(absolutePath);
    const baseContent = existing?.baseContent ?? (await this.readDiskOrNull(absolutePath));
    this.entries.set(absolutePath, { path: absolutePath, baseContent, stagedContent: null });
  }

  async stageReplace(targetPath: string, oldString: string, newString: string, allowMultiple = false): Promise<void> {
    const current = await this.readText(targetPath);
    const { next } = replaceExactString(current, oldString, newString, allowMultiple, targetPath);
    await this.stageWrite(targetPath, next);
  }

  async stageLineReplace(targetPath: string, startLine: number, endLine: number, content: string): Promise<void> {
    const current = await this.readText(targetPath);
    await this.stageWrite(targetPath, replaceLineRange(current, startLine, endLine, content, targetPath).next);
  }

  async readText(targetPath: string): Promise<string> {
    const absolutePath = this.getAbsolutePath(targetPath);
    const entry = this.entries.get(absolutePath);
    if (entry) {
      if (entry.stagedContent === null) {
        throw new Error(`File '${targetPath}' is staged for deletion`);
      }
      return entry.stagedContent;
    }

    return readFile(absolutePath, "utf8");
  }

  async listDirectory(targetPath: string, includeHidden = false): Promise<{ path: string; entries: string[]; absolutePath: string }> {
    const absolutePath = this.getAbsolutePath(targetPath);
    const diskEntries = new Map<string, string>();
    const dirEntries = await readdir(absolutePath, { withFileTypes: true }).catch(() => []);
    for (const entry of dirEntries) {
      if (!includeHidden && entry.name.startsWith(".")) {
        continue;
      }
      diskEntries.set(entry.name, `${entry.name}${entry.isDirectory() ? "/" : ""}`);
    }

    for (const staged of this.entries.values()) {
      const rel = path.relative(absolutePath, staged.path);
      if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
        if (rel === "") {
          const name = path.basename(staged.path);
          if (!includeHidden && name.startsWith(".")) {
            continue;
          }
          if (staged.stagedContent === null) {
            diskEntries.delete(name);
          } else {
            diskEntries.set(name, name);
          }
        }
        continue;
      }

      const [firstSegment, secondSegment] = rel.split(path.sep);
      if (!firstSegment || (!includeHidden && firstSegment.startsWith("."))) {
        continue;
      }

      if (secondSegment) {
        diskEntries.set(firstSegment, `${firstSegment}/`);
      } else if (staged.stagedContent === null) {
        diskEntries.delete(firstSegment);
      } else {
        diskEntries.set(firstSegment, firstSegment);
      }
    }

    return {
      path: absolutePath,
      absolutePath,
      entries: [...diskEntries.values()].sort((a, b) => a.localeCompare(b)),
    };
  }

  async grepSearch(args: { pattern: string; path?: string; include?: string }): Promise<{ root: string; matches: Array<{ path: string; line: number; text: string }> }> {
    const searchRoot = args.path ? this.getAbsolutePath(args.path) : this.primaryRoot;
    const regex = new RegExp(args.pattern, "gm");
    const includeMatcher = args.include ? globToRegExp(args.include) : undefined;
    const files = await this.walk(searchRoot);
    const matches: Array<{ path: string; line: number; text: string }> = [];

    const owningRoot = this.resolvePath(searchRoot);

    for (const filePath of files) {
      const rel = relativeWorkspacePath(owningRoot, filePath);
      if (includeMatcher && !includeMatcher.test(rel)) {
        continue;
      }

      const content = await this.readText(filePath); // Absolute
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        regex.lastIndex = 0;
        if (regex.test(line)) {
          matches.push({ path: filePath, line: index + 1, text: line });
        }
      }
    }

    return { root: searchRoot, matches };
  }

  async flush(): Promise<{ written: number; deleted: number }> {
    const plans: Array<{ type: "write" | "delete"; path: string; content?: string }> = [];
    const conflicts: Array<{ path: string; summary: string; conflictText: string }> = [];

    for (const entry of this.entries.values()) {
      const current = await this.readDiskOrNull(entry.path);
      if (entry.stagedContent === null) {
        if (entry.baseContent !== current) {
          conflicts.push({
            path: entry.path,
            summary: "Delete conflict: file changed on disk after staging",
            conflictText: createConflictText(entry.baseContent, current, null),
          });
          continue;
        }
        plans.push({ type: "delete", path: entry.path });
        continue;
      }

      if (current !== entry.baseContent && current !== entry.stagedContent) {
        conflicts.push({
          path: entry.path,
          summary: "Write conflict: file changed on disk after staging",
          conflictText: createConflictText(entry.baseContent, current, entry.stagedContent),
        });
        continue;
      }

      plans.push({ type: "write", path: entry.path, content: entry.stagedContent });
    }

    if (conflicts.length > 0) {
      throw new MergeConflictError("Unable to flush WAL because of direct file conflicts", conflicts);
    }

    let written = 0;
    let deleted = 0;
    for (const plan of plans) {
      if (plan.type === "delete") {
        await rm(plan.path, { force: true, recursive: true });
        deleted += 1;
      } else {
        await mkdir(path.dirname(plan.path), { recursive: true });
        await writeFile(plan.path, plan.content ?? "", "utf8");
        written += 1;
      }
    }

    this.entries.clear();
    return { written, deleted };
  }

  rollback(): void {
    this.entries.clear();
  }

  async createMaterializedView(targetRoot: string): Promise<void> {
    await rm(targetRoot, { recursive: true, force: true });
    await mkdir(path.dirname(targetRoot), { recursive: true });
    
    // Copy all roots into targetRoot? Or just primary? 
    // Materialized view is typically for the primary root or the single worktree
    await cp(this.primaryRoot, targetRoot, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(this.primaryRoot, source);
        if (!relative) {
          return true;
        }
        const first = relative.split(path.sep)[0] ?? "";
        return ![".git", ".reaper", "scratchpad", "node_modules", "dist", "build", "coverage"].includes(first);
      },
    });

    await linkDependencyDirectories(this.primaryRoot, targetRoot);

    for (const entry of this.entries.values()) {
      // Only materialize entries belonging to primary root for now
      try {
        const root = this.resolvePath(entry.path);
        if (root !== this.primaryRoot) continue;
      } catch {
        continue;
      }

      const relativePath = path.relative(this.primaryRoot, entry.path);
      const targetPath = path.join(targetRoot, relativePath);
      if (entry.stagedContent === null) {
        await rm(targetPath, { force: true, recursive: true }).catch(() => undefined);
        continue;
      }

      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, entry.stagedContent, "utf8");
    }
  }

  private async readDiskOrNull(filePath: string): Promise<string | null> {
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        return null;
      }
      return await readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  private async walk(dir: string): Promise<string[]> {
    const disk = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const diskFiles = await Promise.all(
      disk.map(async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if ([".git", "node_modules", ".reaper", "scratchpad"].includes(entry.name)) {
            return [] as string[];
          }
          return this.walk(full);
        }
        return [full];
      }),
    );

    const stagedFiles = [...this.entries.values()]
      .filter((entry) => entry.stagedContent !== null)
      .map((entry) => entry.path)
      .filter((filePath) => filePath === dir || filePath.startsWith(`${dir}${path.sep}`));

    return [...new Set([...diskFiles.flat(), ...stagedFiles])]
      .filter((filePath) => !this.entries.get(filePath) || this.entries.get(filePath)?.stagedContent !== null)
      .sort((a, b) => a.localeCompare(b));
  }
}

async function linkDependencyDirectories(sourceRoot: string, targetRoot: string): Promise<void> {
  for (const name of ["node_modules", ".venv", "venv", ".tox", "vendor", "target"]) {
    const source = path.join(sourceRoot, name);
    const target = path.join(targetRoot, name);
    const sourceStat = await stat(source).catch(() => undefined);
    if (!sourceStat?.isDirectory()) continue;
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    await symlink(source, target, "dir").catch(() => undefined);
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function createConflictText(base: string | null, current: string | null, intended: string | null): string {
  return [
    "<<<<<<< CURRENT_DISK",
    current ?? "",
    "======= BASE_AT_STAGE =======",
    base ?? "",
    "======= INTENDED_WAL =======",
    intended ?? "",
    ">>>>>>> INTENDED_WAL",
  ].join("\n");
}
