import { rm } from "node:fs/promises";

import { getGitHead, isGitRepository, restoreGitHead } from "../workspace/git.js";

export class ShadowCheckpoint {
  constructor(
    public readonly workspaceRoot: string,
    public readonly head: string,
  ) {}

  static async create(workspaceRoot: string): Promise<ShadowCheckpoint> {
    const gitRepo = await isGitRepository(workspaceRoot);
    if (!gitRepo) {
      throw new Error(`Workspace '${workspaceRoot}' is not a git repository`);
    }

    const head = await getGitHead(workspaceRoot);
    return new ShadowCheckpoint(workspaceRoot, head);
  }

  async restore(extraCleanupPaths: string[] = []): Promise<void> {
    await restoreGitHead(this.workspaceRoot, this.head);

    const cleanupFailures: { path: string; code: string; message: string }[] = [];
    for (const cleanupPath of extraCleanupPaths) {
      try {
        await rm(cleanupPath, { force: true, recursive: true });
      } catch (error) {
        // Cleanup is best-effort — restore must continue even if a
        // mutation-generated temp dir lingered — but failures must be
        // visible so partial restores don't pass silently. `force:true`
        // means ENOENT is not an error; anything else (permission
        // denied, EBUSY, EIO) is worth surfacing.
        const errno = error as NodeJS.ErrnoException;
        if (errno?.code !== "ENOENT") {
          cleanupFailures.push({
            path: cleanupPath,
            code: errno?.code ?? "UNKNOWN",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (cleanupFailures.length > 0) {
      const summary = cleanupFailures
        .map((f) => `  ${f.path}: ${f.code} ${f.message}`)
        .join("\n");
      // We can't `throw` here without losing the rolled-back HEAD on
      // callers that don't re-check the state — surface as a
      // best-effort console warn so the user sees it in the run
      // transcript.
      console.warn(`[reaper] checkpoint restore: ${cleanupFailures.length} cleanup path(s) failed:\n${summary}`);
    }
  }
}
