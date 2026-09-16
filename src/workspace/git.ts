import { execFile } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class GitWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitWorkspaceError";
  }
}

function runGit(workspaceRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Reaper Tests",
          GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "reaper-tests@example.com",
          GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Reaper Tests",
          GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "reaper-tests@example.com",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new GitWorkspaceError(stderr.trim() || error.message));
          return;
        }

        resolve(stdout.trim());
      },
    );
  });
}

export async function git(args: string[], workspaceRoot: string): Promise<string> {
  return runGit(workspaceRoot, args);
}

export async function getGitHead(workspaceRoot: string): Promise<string> {
  return runGit(workspaceRoot, ["rev-parse", "HEAD"]);
}

export async function restoreGitHead(workspaceRoot: string, head: string): Promise<void> {
  const trackedFiles = await runGit(workspaceRoot, ["ls-tree", "-r", "--name-only", head]);
  if (!trackedFiles) {
    return;
  }
  await runGit(workspaceRoot, ["restore", "--source", head, "--staged", "--worktree", "."]);
}

export async function isGitRepository(workspaceRoot: string): Promise<boolean> {
  try {
    return (await runGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

/**
 * Names that are Reaper's own bookkeeping, not the user's project.
 *
 * A thread workspace always contains `.reaper/` (scratchpad, sessions, logs)
 * the moment a turn runs. Treating that as "the user put something here" is what
 * stopped auto-init from ever firing — see `ensureGitRepo`.
 */
const REAPER_OWN_ENTRIES = new Set([".reaper", ".git", ".gitignore"]);

/**
 * Give `workspaceRoot` a git repository if it does not already have one.
 *
 * Returns true when a repo exists afterwards, false when none was created.
 *
 * This is the fix for "checkpoints do not work until git is initialized, and
 * nothing initializes it". Two things had to be true and neither was:
 *
 *   1. The decision cannot be "is the directory empty". Every thread workspace
 *      holds `.reaper/` from its first turn, so an emptiness test was always
 *      false and init never ran. The test is instead "does it hold any entry
 *      that is not Reaper's own", which is what "the user has not put anything
 *      here yet" actually means.
 *   2. It has to run before the engine needs a repo — before checkpoints, before
 *      the diff surface — not as a side effect of a lazy read that never fires
 *      on a fresh thread.
 *
 * A workspace holding a cloned repo, or its own files, is left alone: it either
 * already has a repo or a repo is not wanted, and the directory-with-`.reaper`-
 * only case is the one this exists for. Best-effort: a machine without git, or
 * an unreadable directory, gets no repo and no throw.
 */
export async function ensureGitRepo(workspaceRoot: string): Promise<boolean> {
  if (await isGitRepository(workspaceRoot)) return true;
  let entries: string[];
  try {
    entries = await readdir(workspaceRoot);
  } catch {
    return false;
  }
  // Any entry that is not Reaper's own means the user put something here; do
  // not impose a repo on their files, and do not fight a clone that is coming.
  if (entries.some((name) => !REAPER_OWN_ENTRIES.has(name))) return false;
  try {
    await runGit(workspaceRoot, ["init", "--quiet"]);
    /*
     * Write a `.gitignore` (never overwriting one the user has) so the diff
     * surface and any later commit show the user's work rather than the
     * scratchpad, session logs, and checkpoints. `wx` fails if the file exists,
     * and the failure is swallowed, so an existing file is left exactly as it
     * is.
     */
    await writeFile(path.join(workspaceRoot, ".gitignore"), DEFAULT_GITIGNORE, { flag: "wx" }).catch(() => undefined);
    /*
     * An initial commit gives the repo a HEAD, which `stash`, `reset --hard`,
     * and the checkpoint before-image all require — a repo with no HEAD fails
     * every one of them. Committing `.gitignore` alone leaves the working tree
     * otherwise untouched, so the user's first real file still shows as an
     * addition.
     */
    await runGit(workspaceRoot, ["add", ".gitignore"]);
    await runGit(workspaceRoot, ["commit", "-m", "Reaper: initialize workspace"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `.gitignore` a freshly initialized workspace gets.
 *
 * Two jobs. First, `.reaper/` is Reaper's own state — scratchpad, session
 * journals, checkpoints, logs — and must never appear in the user's history or
 * their diff. Second, the rest of the file is the ordinary set of build and
 * dependency artifacts almost every project produces, so a workspace that grows
 * into a real project does not commit `node_modules`, a `dist/`, or a Python
 * `__pycache__` before the user gets around to a `.gitignore` of their own. It
 * is a starting point, not a policy: it is written once, with `wx`, and any
 * value the user already has is respected.
 */
const DEFAULT_GITIGNORE = `# Reaper's own state: scratchpad, sessions, checkpoints, logs.
.reaper/

# Dependencies
node_modules/
.pnp
.pnp.js
.pnp.cjs
vendor/
bower_components/
jspm_packages/

# Build output
dist/
build/
out/
target/
bin/
obj/
lib/
*.tsbuildinfo
.next/
.nuxt/
.output/
.parcel-cache/
.turbo/
.vite/

# Caches
.cache/
.npm/
.yarn/
.eslintcache
.stylelintcache
.pytest_cache/
.mypy_cache/
.ruff_cache/
.tox/
__pycache__/
*.py[cod]
*.egg-info/
.venv/
venv/
env/

# Coverage and test artifacts
coverage/
.nyc_output/
*.lcov
test-results/
playwright-report/
blob-report/

# Logs and temp
*.log
logs/
tmp/
temp/
*.tmp
*.swp
*.swo
.DS_Store
Thumbs.db

# Environment and secrets
.env
.env.*
!.env.example
*.pem
*.key
!.gitkeep
`;

export async function currentBranch(workspaceRoot: string): Promise<string> {
  return runGit(workspaceRoot, ["branch", "--show-current"]);
}

export async function createBranch(workspaceRoot: string, branchName: string, fromRef = "HEAD"): Promise<void> {
  await runGit(workspaceRoot, ["branch", branchName, fromRef]);
}

export async function deleteBranch(workspaceRoot: string, branchName: string): Promise<void> {
  await runGit(workspaceRoot, ["branch", "-D", branchName]);
}

export async function createWorktree(workspaceRoot: string, branchName: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reaper-worktree-"));
  await runGit(workspaceRoot, ["worktree", "add", tempDir, branchName]);
  return tempDir;
}

export async function removeWorktree(workspaceRoot: string, worktreePath: string): Promise<void> {
  await runGit(workspaceRoot, ["worktree", "remove", "--force", worktreePath]);
}

export async function mergeBranch(workspaceRoot: string, branchName: string): Promise<void> {
  await runGit(workspaceRoot, ["merge", "--no-edit", branchName]);
}

export async function gitStatus(workspaceRoot: string): Promise<string> {
  return runGit(workspaceRoot, ["status", "--short"]);
}

/**
 * Untracked, non-ignored paths relative to `workspaceRoot`. Uses
 * `--others --exclude-standard` (rather than parsing `status --short`) so
 * the output is one NUL-free path per line with no status prefix to strip
 * and no quoting applied to paths containing spaces.
 */
export async function listUntrackedFiles(workspaceRoot: string): Promise<string[]> {
  const out = await runGit(workspaceRoot, ["ls-files", "--others", "--exclude-standard"]);
  return out ? out.split("\n").filter((line) => line.length > 0) : [];
}

export async function commitAll(workspaceRoot: string, message: string): Promise<void> {
  await runGit(workspaceRoot, ["add", "-A", "."]);
  await runGit(workspaceRoot, ["reset", "--", ".reaper"]).catch(() => undefined);
  await runGit(workspaceRoot, ["reset", "--", "scratchpad"]).catch(() => undefined);
  const staged = await runGit(workspaceRoot, ["diff", "--cached", "--name-only"]);
  if (!staged) {
    return;
  }
  await runGit(workspaceRoot, ["commit", "-m", message]);
}
