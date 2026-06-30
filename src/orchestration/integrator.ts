import { currentBranch, git, mergeBranch } from "../workspace/git.js";

export interface IntegratorResult {
  ok: boolean;
  mergedBranches: string[];
  conflictSummary?: string;
}

export async function runIntegratorMerge(workspaceRoot: string, branches: string[]): Promise<IntegratorResult> {
  const mergedBranches: string[] = [];
  try {
    const baseBranch = await currentBranch(workspaceRoot);
    for (const branch of branches) {
      await mergeBranch(workspaceRoot, branch);
      mergedBranches.push(branch);
    }
    return { ok: true, mergedBranches: [baseBranch, ...mergedBranches] };
  } catch (error) {
    const conflictSummary = await git(["status", "--short"], workspaceRoot).catch(() => "merge failed");
    await git(["merge", "--abort"], workspaceRoot).catch(() => undefined);
    return {
      ok: false,
      mergedBranches,
      conflictSummary: error instanceof Error ? `${error.message}\n${conflictSummary}` : conflictSummary,
    };
  }
}
