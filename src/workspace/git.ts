import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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
