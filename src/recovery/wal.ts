import { readdir, readFile, stat, writeFile, rm, mkdir, cp, symlink } from "node:fs/promises";
import path from "node:path";
import { applyPatch, merge as mergePatchesRaw, structuredPatch, type ParsedDiff } from "diff";

import { normalizeWorkspacePath, relativeWorkspacePath } from "../policy/paths.js";
import { collectGrepMatches, compileGrepPattern } from "../tools/read/grep-search.js";
import { assertDeletableTarget } from "../tools/write/delete-file.js";
import { replaceExactString, replaceLineRange } from "../tools/write/replace-in-file.js";
import { findOwningRoot } from "../workspace/roots.js";

/*
 * The runtime `merge` takes two parsed patches and a base and returns a merged
 * patch; the shipped `@types/diff` still declares the older
 * `(mine: string, theirs: string, base: string): ParsedDiff` shape, which does
 * not match the installed jsdiff v7. The cast is to the real runtime signature,
 * verified by calling it: two non-overlapping hunks combine, an overlap leaves
 * conflict markers.
 */
const mergePatches = mergePatchesRaw as unknown as (
  mine: ParsedDiff,
  theirs: ParsedDiff,
  base: string,
) => ParsedDiff;

/**
 * Try to reconcile two independent changes to the same file.
 *
 * The situation this exists for: the model edits a file with `file_edit`
 * (staged in the WAL, not yet on disk), then runs `bash` that also writes that
 * file — a heredoc, `sed -i`, a formatter, a codegen step. Bash is not routed
 * through the WAL, so disk now holds the bash version while `baseContent` holds
 * the pre-edit version and `stagedContent` holds the model's edit. The old flush
 * called that a hard conflict and threw, and the model-loop catch reported it as
 * "the model call failed and the run was stopped" — a turn killed mid-work for
 * two edits that in fact touched different lines.
 *
 * A three-way merge says whether they *actually* conflict. Both sides are turned
 * into a patch against `base`; jsdiff's `merge` combines non-overlapping hunks
 * and, where they overlap, emits the usual conflict markers, which
 * `applyPatch` then refuses. So a clean merge returns the combined text, and a
 * real overlap throws — which is exactly the distinction the caller needs.
 *
 * Returns undefined when either side produced no textual patch (a pure
 * create/delete, or a binary/unmergeable pair) so the caller keeps its
 * conflict path rather than guessing.
 */
function tryMergeText(base: string, ours: string, theirs: string): { merged: string } | { conflict: string } | undefined {
  try {
    const oursPatch = structuredPatch("f", "f", base, ours, "", "", { context: 3 });
    const theirsPatch = structuredPatch("f", "f", base, theirs, "", "", { context: 3 });
    const combined = mergePatches(oursPatch, theirsPatch, base);
    const applied = applyPatch(base, combined, { fuzzFactor: 0 });
    if (typeof applied !== "string") return undefined;
    /*
     * `applyPatch` returns the text with conflict markers left in when the
     * "patch" was an unresolved merge — it does not throw for that. Markers are
     * the signal that the two edits really did touch the same lines, and they
     * must not be written to the user's file.
     */
    if (applied.includes("<<<<<<<") || applied.includes(">>>>>>>")) {
      return { conflict: applied };
    }
    return { merged: applied };
  } catch {
    return undefined;
  }
}

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

  hasEntry(targetPath: string): boolean {
    return this.entries.has(this.getAbsolutePath(targetPath));
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

  /**
   * The workspace root a path will live under, whether the caller named it
   * absolutely or relative to the primary root. (`resolvePath` above answers a
   * different question — for a relative path it returns the absolute path, not
   * a root — so it cannot be reused here without lying about which is which.)
   */
  private rootFor(targetPath: string): string {
    return path.isAbsolute(targetPath) ? findOwningRoot(this.workspaceRoots, targetPath) : this.primaryRoot;
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

    // The WAL is what actually runs `rm(…, { recursive: true })` at flush time,
    // so the WAL has to own the guard. The executor refuses a directory before
    // it stages one — but that is a caller in a different file, and guarding
    // one route while the writable one lives elsewhere is the exact arrangement
    // that kept `grep_search`'s bug alive in this same recovery twin after the
    // direct copy would have been fixed. Verified before this line existed:
    // `stageDelete("src")` + `flush()` removed `src/a.ts` and `src/nested/b.ts`.
    await assertDeletableTarget(this.rootFor(targetPath), absolutePath, targetPath);

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

    // `path` may name a single file, which `walk` below cannot see: it starts
    // with `readdir(dir).catch(() => [])`, so a file path read as a directory
    // yielded an empty list and the call returned `ok: true` with zero
    // matches — the same answer a genuine miss gives. A model searching one
    // file was told "nothing found" for a file full of matches.
    const targets = await this.grepTargets(searchRoot);
    const includeMatcher = args.include ? globToRegExp(args.include) : undefined;
    const owningRoot = this.resolvePath(searchRoot);

    const searchable = includeMatcher
      ? targets.filter((filePath) => includeMatcher.test(relativeWorkspacePath(owningRoot, filePath)))
      : targets;

    const matches = await collectGrepMatches(searchable, compileGrepPattern(args.pattern), (filePath) =>
      // `readText` overlays staged content on disk content, which is what keeps
      // a grep inside a recovery session consistent with the edits it has made.
      this.readText(filePath),
    );

    return { root: searchRoot, matches };
  }

  /**
   * The files a `grepSearch` should read: either the single file `path` named,
   * or everything under the directory it named.
   *
   * The file case has to consult the staged entries as well as the disk,
   * because a file created during the session exists only in the WAL. Missing
   * that would make grep blind to the model's own new files while a recovery
   * session is open — the same class of confidently-empty answer this method
   * exists to prevent.
   */
  private async grepTargets(searchRoot: string): Promise<string[]> {
    const staged = this.entries.get(searchRoot);
    if (staged) {
      // Staged for deletion: the file is gone as far as this session is
      // concerned, so there is nothing to match. Falling through to disk would
      // grep the pre-deletion content, which is the version the model is
      // actively editing away from.
      if (staged.stagedContent === null) return [];
      return [searchRoot];
    }

    const info = await stat(searchRoot).catch(() => undefined);
    if (info?.isFile()) return [searchRoot];

    const targets = await this.walk(searchRoot);

    // A path that is neither on disk nor staged matched nothing because it does
    // not exist — not because it was searched and came up empty. `walk` starts
    // with `readdir(dir).catch(() => [])`, so without this check the two are
    // the same answer, and the model cannot tell a typo from a miss.
    if (targets.length === 0 && !info) {
      throw Object.assign(new Error(`No such file or directory: '${searchRoot}'.`), { code: "not_found" });
    }

    return targets;
  }

  async flush(): Promise<{ written: number; deleted: number }> {
    const plans: Array<{ type: "write" | "delete"; path: string; content?: string }> = [];
    const conflicts: Array<{ path: string; summary: string; conflictText: string }> = [];

    for (const entry of this.entries.values()) {
      const current = await this.readDiskOrNull(entry.path);
      if (entry.stagedContent === null) {
        /*
         * A staged delete whose file is already gone is satisfied, not
         * conflicted. `rm` in bash after `delete_file` staged the removal, or a
         * cleanup step, leaves disk null — the intended end state exactly. Only
         * a file that is still present *and changed* is a real delete conflict,
         * because then the staged delete would discard edits it never saw.
         */
        if (current === null) {
          continue;
        }
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

      /*
       * The file was deleted on disk after the write was staged.
       *
       * The delete wins. It is the later action — the caller removed the file
       * on purpose — and resurrecting it from a staged in-memory copy would be
       * the surprising outcome, not the safe one. This is the live shape that
       * fired in a real thread: an eval did `writeFileSync` → `tools.edit_file`
       * (staged) → `unlinkSync`, and the flush reported a phantom "direct file
       * conflict" against a file the same call had just deleted. Not a
       * conflict, and nothing to write.
       */
      if (current === null && entry.baseContent !== null) {
        continue;
      }

      if (current !== entry.baseContent && current !== entry.stagedContent) {
        /*
         * Disk moved under the staged write. This is the normal case when bash
         * and a file tool both touched the same file, and it is usually not a
         * real conflict — the two edits are on different lines. Merge them. Only
         * a genuine overlap (or a merge we cannot represent) stays a conflict.
         */
        if (entry.baseContent !== null && current !== null) {
          const merged = tryMergeText(entry.baseContent, entry.stagedContent, current);
          if (merged && "merged" in merged) {
            plans.push({ type: "write", path: entry.path, content: merged.merged });
            continue;
          }
        }
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

  /**
   * Materialize every configured workspace root, staged writes included, so
   * a non-barrier shell command observes pending edits instead of stale
   * disk content.
   *
   * The primary root is materialized at `targetRoot`; each additional root
   * gets a sibling directory. Previously only the primary root was copied
   * and non-primary entries were skipped outright, so in a multi-root
   * workspace a command would silently read pre-edit content for every
   * secondary root.
   *
   * Returns the root -> view mapping so callers can rewrite absolute paths
   * for *all* roots and clean up every directory that was created.
   */
  async createMaterializedView(targetRoot: string): Promise<Array<{ root: string; viewPath: string }>> {
    const views = this.workspaceRoots.map((root, index) => ({
      root,
      viewPath: index === 0 ? targetRoot : `${targetRoot}-root-${index}`,
    }));

    for (const { root, viewPath } of views) {
      await this.materializeRoot(root, viewPath);
    }

    return views;
  }

  private async materializeRoot(root: string, viewPath: string): Promise<void> {
    await rm(viewPath, { recursive: true, force: true });
    await mkdir(path.dirname(viewPath), { recursive: true });

    await cp(root, viewPath, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(root, source);
        if (!relative) {
          return true;
        }
        const first = relative.split(path.sep)[0] ?? "";
        return ![".git", ".reaper", "scratchpad", "node_modules", "dist", "build", "coverage"].includes(first);
      },
    });

    await linkDependencyDirectories(root, viewPath);

    for (const entry of this.entries.values()) {
      let owningRoot: string;
      try {
        owningRoot = this.resolvePath(entry.path);
      } catch {
        continue;
      }
      if (owningRoot !== root) continue;

      const relativePath = path.relative(root, entry.path);
      const targetPath = path.join(viewPath, relativePath);
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
