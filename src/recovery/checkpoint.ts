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

    for (const cleanupPath of extraCleanupPaths) {
      await rm(cleanupPath, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}
