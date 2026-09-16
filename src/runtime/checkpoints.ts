import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isMutatingTool } from "./tool-taxonomy.js";
import { getGitStatusState, parseGitStatusShort, type GitStatusEntry } from "./diff-state.js";
import type { ToolCall } from "../tools/types.js";
import { isGitRepository } from "../workspace/git.js";

const execFileAsync = promisify(execFile);

export interface Checkpoint {
  id: string;
  createdAt: string;
  baseRevision: string;
  dirtyFilesBefore: string[];
  reason: string;
  toolCallIds: string[];
  restoreAvailable: boolean;
}

export interface CreateCheckpointInput {
  workspaceRoot: string;
  reason: string;
  toolCallIds?: string[];
}

export interface RestoreCheckpointResult {
  checkpoint: Checkpoint;
  restored: boolean;
  statusAfterRestore: string;
}

export function batchNeedsMutationCheckpoint(toolCalls: Pick<ToolCall, "name">[]): boolean {
  return toolCalls.some((call) => isMutatingTool(call.name) && call.name !== "create_checkpoint" && call.name !== "restore_checkpoint");
}

export async function createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint> {
  const checkpoint: Checkpoint = {
    id: createCheckpointId(),
    createdAt: new Date().toISOString(),
    baseRevision: "unavailable",
    dirtyFilesBefore: [],
    reason: input.reason,
    toolCallIds: input.toolCallIds ?? [],
    restoreAvailable: false,
  };

  let status: Awaited<ReturnType<typeof getGitStatusState>> | undefined;
  if (await isGitRepository(input.workspaceRoot)) {
    status = await getGitStatusState(input.workspaceRoot);
    checkpoint.baseRevision = status.baseRevision;
    checkpoint.dirtyFilesBefore = status.entries.map(entryToDirtyFile);
    checkpoint.restoreAvailable = status.baseRevision !== "unavailable";
  }

  const checkpointDir = getCheckpointDir(input.workspaceRoot, checkpoint.id);
  await mkdir(checkpointDir, { recursive: true });

  if (checkpoint.restoreAvailable) {
    try {
      await writeGitPatch(input.workspaceRoot, checkpointDir, "staged.patch", ["diff", "--cached", "--binary"]);
      await writeGitPatch(input.workspaceRoot, checkpointDir, "worktree.patch", ["diff", "--binary"]);
      /*
       * A third patch, built from a throwaway index, so untracked files are in
       * the snapshot too.
       *
       * `git diff` cannot describe an untracked file: it compares against the
       * index, and a path the index has never seen has no other side. So the two
       * patches above are silent about one, and restore was a partial undo — a
       * file that was untracked at checkpoint time and then edited came back
       * with the edit intact. Reproduced directly: checkpoint, append to an
       * untracked `showcase/stats.js`, restore, and the edit was still there.
       *
       * The fix uses git rather than a parallel copy scheme. `GIT_INDEX_FILE`
       * points a scratch index outside the workspace, `read-tree HEAD` seeds it
       * from the base revision, and `add -A` stages the whole working tree into
       * it — untracked files included, ignored files excluded, because `add`
       * honours `.gitignore` exactly as it always does. `diff --cached` against
       * that index is then a complete picture of the workspace at checkpoint
       * time, in the format `git apply` already knows how to restore.
       *
       * The real index is never touched: `GIT_INDEX_FILE` redirects every index
       * operation for the child, so the user's staged changes stay staged.
       */
      await writeUntrackedInclusivePatch(input.workspaceRoot, checkpointDir, status?.entries ?? []);
    } catch (error) {
      // Oversized parent repo or pathological diffs: keep a metadata-only checkpoint
      // so the engine can continue, but do not advertise it as restorable.
      checkpoint.restoreAvailable = false;
      const message = error instanceof Error ? error.message : String(error);
      await writeFile(
        path.join(checkpointDir, "restore-skipped.txt"),
        `Checkpoint patch capture failed: ${message}\n`,
        "utf8",
      );
    }
  }

  await writeFile(path.join(checkpointDir, "metadata.json"), JSON.stringify(checkpoint, null, 2), "utf8");
  return checkpoint;
}

export async function restoreCheckpoint(workspaceRoot: string, checkpointId: string): Promise<RestoreCheckpointResult> {
  const checkpoint = await readCheckpoint(workspaceRoot, checkpointId);
  if (!checkpoint.restoreAvailable || checkpoint.baseRevision === "unavailable") {
    // Defense-in-depth: even if a corrupted metadata.json claims restoreAvailable,
    // refuse to attempt a restore without a real base revision.
    throw new Error(`Checkpoint '${checkpointId}' is not restorable`);
  }

  const dirtyBefore = new Set(checkpoint.dirtyFilesBefore);
  const preRestoreHead = await runGit(workspaceRoot, ["rev-parse", "HEAD"]);

  // Ordering matters here. This used to reset --hard to the checkpoint base
  // and only then try to reapply the saved patches: if the reapply failed
  // (e.g. the trailing-newline bug above, or any other corrupt patch) the
  // tree was already wiped to base and the user's pre-restore edits were
  // gone for good, with no way back. The invariant we need is that a failed
  // restore leaves the working tree exactly as it was before the call.
  //
  // Verifying the patches against a throwaway checkout would avoid touching
  // the real tree at all, but that means a second full checkout of the base
  // revision on every restore. Instead, stash the current tree (tracked
  // changes and untracked files, `.reaper/` excluded so we don't sweep away
  // the checkpoint data we're about to read) before doing anything
  // destructive. On success the stash is dropped. On failure, resetting back
  // to `preRestoreHead` and popping the stash reproduces the pre-call tree
  // exactly, because the stash's base commit *is* `preRestoreHead`.
  const stashed = await stashWorkingTree(workspaceRoot);
  // Where new untracked files are parked (not deleted) so a failed restore can
  // put them back. Lives under the checkpoint dir, which the untracked walk
  // skips because it is inside `.reaper/`.
  const quarantineDir = path.join(getCheckpointDir(workspaceRoot, checkpoint.id), "quarantine");
  try {
    await runGit(workspaceRoot, ["reset", "--hard", checkpoint.baseRevision]);
    /*
     * Every untracked path is moved aside, not just the new ones.
     *
     * This used to skip paths listed in `dirtyFilesBefore` — untracked files
     * that already existed at checkpoint time — on the reasoning that quarantine
     * exists to remove files created *after* the checkpoint. That left them in
     * place with whatever edits had happened since, and the patches could not
     * correct them: `git diff` has no side to compare an untracked file
     * against, so a file the model edited after the checkpoint came back
     * unchanged. The audit reproduced it — checkpoint, edit an untracked
     * `showcase/stats.js`, restore, and the edit was still there.
     *
     * Moving them all aside makes the two paths symmetric: `untracked.patch`
     * recreates the pre-existing ones from the checkpoint's own record, and the
     * ones created since (which the patch does not mention, because they did not
     * exist when it was taken) stay aside and are dropped on success. It also
     * sidesteps `git apply`'s refusal to create a file that already exists,
     * without needing a `git clean` that would have to re-derive which paths are
     * safe.
     */
    await quarantineNewUntrackedFiles(workspaceRoot, quarantineDir);
    /*
     * `--index`, not `--cached`.
     *
     * The two patches are ordered: `staged.patch` is HEAD→index and
     * `worktree.patch` is index→worktree, so the second is a diff *against the
     * files the first creates* and expects them to be present on disk.
     * `--cached` writes only the index — the tree stays empty — so the worktree
     * patch then failed with `edit_probe.txt: No such file or directory` and the
     * restore aborted on a checkpoint it had reported as restorable. `--index`
     * applies to the index and the working tree together, which is what makes
     * the second patch applicable and leaves the tree in the checkpoint's exact
     * state.
     */
    await applyPatchIfPresent(workspaceRoot, getCheckpointPatchPath(workspaceRoot, checkpoint.id, "staged.patch"), ["apply", "--index", "--binary"]);
    await applyPatchIfPresent(workspaceRoot, getCheckpointPatchPath(workspaceRoot, checkpoint.id, "worktree.patch"), ["apply", "--binary"]);
    /*
     * Then the untracked patch, which recreates the files the quarantine above
     * moved aside.
     *
     * It goes last so it is the final writer: a path that appears in both a
     * tracked patch and this one ends at the checkpoint's own recorded content
     * rather than at the patch's reconstruction of it.
     */
    await applyPatchIfPresent(
      workspaceRoot,
      getCheckpointPatchPath(workspaceRoot, checkpoint.id, "untracked.patch"),
      ["apply", "--binary"],
    );
  } catch (error) {
    /*
     * Undo in the reverse order of the forward steps: put the quarantined
     * untracked files back, return tracked files to the pre-restore revision,
     * then pop the tracked safety stash. The result is the working tree exactly
     * as it was before the call.
     */
    await restoreQuarantinedFiles(workspaceRoot, quarantineDir);
    await runGit(workspaceRoot, ["reset", "--hard", preRestoreHead]);
    if (stashed) {
      await runGit(workspaceRoot, ["stash", "pop"]);
    }
    throw error;
  }

  // Success: the quarantined files were never part of the checkpoint state, so
  // they are dropped now. Dropping them here (rather than deleting in place) is
  // what made their recovery possible on the failure path above.
  await rm(quarantineDir, { recursive: true, force: true }).catch(() => undefined);

  if (stashed) {
    await runGit(workspaceRoot, ["stash", "drop"]);
  }

  const statusAfterRestore = (await getGitStatusState(workspaceRoot)).statusShort;

  return {
    checkpoint,
    restored: true,
    statusAfterRestore,
  };
}

// Snapshots the current *tracked* tree (staged + unstaged edits) into the git
// stash so a failed restore can undo its changes to tracked files. Returns
// false when there was nothing to stash (a clean tracked tree), so the caller
// knows a bare HEAD reset is enough to roll back.
//
// It deliberately does NOT use `--include-untracked`. It used to, and that was
// the data-loss bug: `--include-untracked` moves untracked files out of the
// working tree into the stash, and on a *successful* restore the stash is
// dropped — taking those files with it. The files lost were exactly the ones
// the checkpoint had recorded as `dirtyFilesBefore`, the pre-existing untracked
// files a restore is supposed to leave alone, so the exclusion in the removal
// walk below could never save them: they were already gone, moved into the
// stash by this call and deleted with it. Untracked files are handled on their
// own now, by quarantine (moved aside, recoverable), and the safety stash only
// needs to cover tracked changes.
async function stashWorkingTree(workspaceRoot: string): Promise<boolean> {
  const countStashes = async (): Promise<number> => {
    const list = await runGit(workspaceRoot, ["stash", "list"]);
    return list.length === 0 ? 0 : list.split("\n").length;
  };
  const before = await countStashes();

  await runGit(workspaceRoot, ["stash", "push", "--message", "reaper-restore-checkpoint-safety"]);
  return (await countStashes()) > before;
}

export async function readCheckpoint(workspaceRoot: string, checkpointId: string): Promise<Checkpoint> {
  const raw = await readFile(path.join(getCheckpointDir(workspaceRoot, checkpointId), "metadata.json"), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Checkpoint '${checkpointId}' metadata.json is malformed: ${message}`);
  }
  if (!isCheckpointShape(parsed)) {
    throw new Error(`Checkpoint '${checkpointId}' metadata.json failed shape validation`);
  }
  return parsed;
}

function isCheckpointShape(value: unknown): value is Checkpoint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Checkpoint>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.baseRevision === "string" &&
    Array.isArray(candidate.dirtyFilesBefore) &&
    candidate.dirtyFilesBefore.every((entry) => typeof entry === "string") &&
    typeof candidate.reason === "string" &&
    Array.isArray(candidate.toolCallIds) &&
    candidate.toolCallIds.every((entry) => typeof entry === "string") &&
    typeof candidate.restoreAvailable === "boolean"
  );
}

export function getCheckpointDir(workspaceRoot: string, checkpointId: string): string {
  assertSafeCheckpointId(checkpointId);
  return path.join(workspaceRoot, ".reaper", "checkpoints", checkpointId);
}

function getCheckpointPatchPath(workspaceRoot: string, checkpointId: string, fileName: string): string {
  return path.join(getCheckpointDir(workspaceRoot, checkpointId), fileName);
}

function createCheckpointId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `cp-${timestamp}-${randomUUID()}`;
}

function assertSafeCheckpointId(checkpointId: string): void {
  if (!/^cp-[A-Za-z0-9_-]+$/.test(checkpointId)) {
    throw new Error(`Invalid checkpoint id '${checkpointId}'`);
  }
}

function entryToDirtyFile(entry: GitStatusEntry): string {
  return entry.originalPath ? `${entry.originalPath} -> ${entry.path}` : entry.path;
}


/**
 * A patch that includes untracked files, built from a throwaway index.
 *
 * `git diff` cannot describe a file the index has never seen, so an untracked
 * file produces no hunk and the restore misses it. Pointing `GIT_INDEX_FILE` at
 * a scratch index outside the workspace and staging the entire working tree
 * into it solves that with git's own machinery rather than a parallel copy
 * scheme: `add -A` picks up untracked files and skips ignored ones exactly as a
 * user's `git add -A` would, and `diff --cached` then yields one patch
 * describing the whole workspace, in the format `git apply` restores.
 *
 * The scratch index lives in the checkpoint directory rather than the workspace
 * so it cannot appear in a status listing or be swept into a commit. The real
 * index is untouched: `GIT_INDEX_FILE` redirects index access for the child
 * process only.
 *
 * Ignored files are deliberately absent. A checkpoint is about the work the
 * agent is doing, and `node_modules` is not that; `.gitignore` is the user's own
 * statement of what does not belong in the repository, and this honours it
 * instead of inventing a second opinion.
 */
/*
 * Untracked file paths, non-ignored, as a NUL-separated buffer.
 *
 * `--exclude-standard` is what makes this honour `.gitignore` the way the
 * header promises: a build artefact or a `node_modules` tree is not something a
 * checkpoint should carry, and the user's ignore rules are the statement of
 * that. `.reaper/` is dropped here rather than by a pathspec for the reason in
 * the caller: naming an ignored path in a pathspec makes git fail.
 *
 * NUL separation rather than newlines because a path may contain a newline, and
 * `-z` plus `--pathspec-file-nul` is the pair that survives it. The return is
 * `undefined` when there is nothing untracked, so the caller can skip the git
 * work entirely.
 */
async function untrackedPathspecBuffer(workspaceRoot: string, env: Record<string, string>): Promise<string | undefined> {
  const raw = await runGitRawWithEnv(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z"], env);
  const paths = raw.split("\0").filter((entry) => entry.length > 0);
  const keep = paths.filter((entry) => entry !== ".reaper" && !entry.startsWith(".reaper/"));
  if (keep.length === 0) return undefined;
  return `${keep.join("\0")}\0`;
}

/*
 * A pathspec file holding the untracked list, written beside the scratch index.
 *
 * A file rather than stdin because the obvious stdin form does not work here and
 * fails in the worst way: `execFile`'s `input` option is `execFileSync` only and
 * is silently ignored by the async `execFile`, so `git add
 * --pathspec-from-file=-` sat waiting on a stdin nobody would ever write to. The
 * test suite hung for minutes with no output rather than erroring, which is a
 * much worse failure to debug than a wrong result.
 *
 * The file lives in the checkpoint directory, beside the index, so it is outside
 * the workspace and cannot appear in a status listing. The caller removes it.
 */
async function writePathspecFile(checkpointDir: string, contents: string): Promise<string> {
  const filePath = path.join(checkpointDir, "untracked.pathspec");
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

async function writeUntrackedInclusivePatch(
  workspaceRoot: string,
  checkpointDir: string,
  entries: GitStatusEntry[],
): Promise<void> {
  // Nothing untracked means the two patches above already cover the tree, and a
  // third would be an empty file.
  if (!entries.some((entry) => entry.code === "??")) return;

  const indexPath = path.join(checkpointDir, "untracked.index");
  await rm(indexPath, { force: true });
  try {
    const env = { GIT_INDEX_FILE: indexPath };
    await runGitWithEnv(workspaceRoot, ["read-tree", "HEAD"], env);
    /*
     * Stage exactly the untracked paths, by name, from a NUL-separated list.
     *
     * Two earlier forms of this line were wrong, and both looked correct, so
     * both are worth keeping written down.
     *
     * The first was `add -A -- . ':(exclude).reaper'`. `add -A -- .` skips an
     * ignored path silently, so an exclude pathspec looks like just a more
     * explicit way to say the same thing. It is not: naming an ignored path in a
     * pathspec makes git fail --
     *
     *   The following paths are ignored by one of your .gitignore files:
     *   .reaper
     *
     * -- exit 1 on git 2.39.5, for `:(exclude).reaper`, `:(exclude).reaper/`
     * and `:(exclude).reaper/**` alike. `.reaper/` is gitignored in every
     * standard Reaper workspace, so this failed everywhere, the catch below
     * marked the whole checkpoint `restoreAvailable: false`, and no checkpoint
     * could be restored at all, not even its tracked files.
     *
     * The second was `add -A -- .` on its own, which fixes that but stages the
     * entire worktree, making this patch a diff of tracked edits too. On restore
     * `worktree.patch` has already written those edits, so reapplying them from
     * here fails with "patch does not apply" and aborts the restore of a
     * checkpoint that reported itself restorable. The earlier tests missed it
     * because their fixtures never modified a tracked file, so the tracked hunks
     * were absent and the two patches did not overlap.
     *
     * Naming the untracked paths avoids both. `--pathspec-from-file=-` with
     * `--pathspec-file-nul` reads the list from stdin, so a workspace with more
     * untracked files than fit in argv still works and a path containing a
     * newline still parses. `.reaper/` is filtered in `untrackedPathspecBuffer`
     * rather than excluded here, which is what keeps the ignored name out of the
     * pathspec. Without that filter, a workspace that does not gitignore
     * `.reaper` sweeps the checkpoint's own patch files into the patch, and
     * restoring it fails with "already exists in working directory" as the patch
     * recreates the files it is being read from.
     */
    const pathspec = await untrackedPathspecBuffer(workspaceRoot, env);
    if (pathspec === undefined) return;
    const pathspecFile = await writePathspecFile(checkpointDir, pathspec);
    await runGitWithEnv(
      workspaceRoot,
      ["add", `--pathspec-from-file=${pathspecFile}`, "--pathspec-file-nul"],
      env,
    );
    await rm(pathspecFile, { force: true });
    const patch = await runGitRawWithEnv(workspaceRoot, ["diff", "--cached", "--binary"], env);
    if (patch.trim().length === 0) return;
    const normalized = patch.endsWith("\n") ? patch : `${patch}\n`;
    await writeFile(path.join(checkpointDir, "untracked.patch"), normalized, "utf8");
  } finally {
    // The index is a build artifact of this function, not state worth keeping;
    // the patch it produced is the durable part.
    await rm(indexPath, { force: true }).catch(() => undefined);
  }
}

async function writeGitPatch(workspaceRoot: string, checkpointDir: string, fileName: string, args: string[]): Promise<void> {
  // `runGit` trimEnds its output for display/plumbing callers, which strips the
  // trailing newline `git diff` puts on the last line. `git apply` rejects a
  // patch whose final line is unterminated ("corrupt patch at line N"), so a
  // trimmed patch could never be reapplied on restore. Patch bytes must be
  // captured raw and, defensively, end with a newline even if some future git
  // version or flag combination ever omits one.
  const patch = await runGitRaw(workspaceRoot, args);
  const normalized = patch.length > 0 && !patch.endsWith("\n") ? `${patch}\n` : patch;
  await writeFile(path.join(checkpointDir, fileName), normalized, "utf8");
}

/**
 * `runGit` with extra environment, for the scratch-index operations.
 *
 * A separate function rather than an option on `runGit` because the environment
 * it injects (`GIT_INDEX_FILE`) changes what git *means* — every index read and
 * write goes somewhere else — and that is worth being visible at the call site
 * rather than hidden behind a parameter.
 */
async function runGitWithEnv(workspaceRoot: string, args: string[], env: Record<string, string>): Promise<string> {
  return String(await runGitRawWithEnv(workspaceRoot, args, env)).trimEnd();
}

/** As `runGitRaw`, with extra environment (see `runGitWithEnv`). */
async function runGitRawWithEnv(
  workspaceRoot: string,
  args: string[],
  extraEnv: Record<string, string>,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      ...extraEnv,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Reaper Tests",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "reaper-tests@example.com",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Reaper Tests",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "reaper-tests@example.com",
    },
    maxBuffer: 1024 * 1024 * 1024,
  });
  return String(stdout);
}

async function applyPatchIfPresent(workspaceRoot: string, patchPath: string, args: string[]): Promise<void> {
  const patchStat = await stat(patchPath).catch(() => undefined);
  if (!patchStat || patchStat.size === 0) return;
  await runGit(workspaceRoot, [...args, patchPath]);
}

/**
 * Move every untracked file aside, clearing the way for the patches.
 *
 * Two jobs, and they are why it takes all of them rather than only the new
 * ones. A restore returns the tree to the checkpoint's moment, so a file that
 * did not exist then must not exist afterwards — and a file that *did* exist
 * then must come back with its checkpoint content, not the version on disk now.
 * `untracked.patch` recreates the ones the checkpoint recorded; this clears the
 * disk so that apply can create them, since `git apply` refuses a path that
 * already exists.
 *
 * Moving rather than deleting keeps a failed restore recoverable: this runs
 * before the patches, and `restoreQuarantinedFiles` puts everything back if one
 * fails. A file that survived the quarantine step but not the restore is only
 * dropped on success, when the patch has already recreated the checkpoint's
 * version.
 *
 * `.reaper/` is skipped so a restore never sweeps away the checkpoint store it
 * is reading from.
 */
async function quarantineNewUntrackedFiles(workspaceRoot: string, quarantineDir: string): Promise<void> {
  const status = await runGit(workspaceRoot, ["status", "--short", "--untracked-files=all"]);
  const untracked = parseGitStatusShort(status).filter((entry) => entry.code === "??");
  for (const entry of untracked) {
    if (entry.path.startsWith(".reaper/")) continue;
    const src = path.join(workspaceRoot, entry.path);
    const dst = path.join(quarantineDir, entry.path);
    // Guard against a path that would escape the workspace (a hostile filename
    // or a crafted status line); moving outside the tree is never intended.
    if (!dst.startsWith(quarantineDir + path.sep)) continue;
    await mkdir(path.dirname(dst), { recursive: true });
    await rename(src, dst);
  }
}

/** Move everything in `quarantineDir` back into the workspace, then remove it. */
async function restoreQuarantinedFiles(workspaceRoot: string, quarantineDir: string): Promise<void> {
  if (!existsSync(quarantineDir)) return;
  const walk = async (rel: string): Promise<void> => {
    const abs = path.join(quarantineDir, rel);
    const entries = await readdir(abs, { withFileTypes: true });
    for (const dirent of entries) {
      const childRel = rel ? path.join(rel, dirent.name) : dirent.name;
      if (dirent.isDirectory()) {
        await walk(childRel);
      } else {
        const dst = path.join(workspaceRoot, childRel);
        await mkdir(path.dirname(dst), { recursive: true });
        await rename(path.join(quarantineDir, childRel), dst);
      }
    }
  };
  await walk("");
  await rm(quarantineDir, { recursive: true, force: true }).catch(() => undefined);
}

async function runGit(workspaceRoot: string, args: string[]): Promise<string> {
  return String(await runGitRaw(workspaceRoot, args)).trimEnd();
}

// Like `runGit`, but preserves stdout exactly as git produced it. Only use
// this for output that will be reapplied byte-for-byte later (patch files);
// everything else should go through `runGit` so callers don't have to deal
// with trailing-newline noise.
async function runGitRaw(workspaceRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Reaper Tests",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "reaper-tests@example.com",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Reaper Tests",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "reaper-tests@example.com",
    },
    maxBuffer: 1024 * 1024 * 1024,
  });
  return String(stdout);
}
