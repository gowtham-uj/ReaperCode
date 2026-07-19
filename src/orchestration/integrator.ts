import { currentBranch, git, mergeBranch } from "../workspace/git.js";

export interface IntegratorResult {
  ok: boolean;
  mergedBranches: string[];
  conflictSummary?: string;
  /**
   * Set when the merge could not be diagnosed because git itself was
   * unreachable or returned an error. Consumers should treat this as a
   * transient infrastructure failure, not a code conflict.
   */
  diagnosticError?: string;
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
    let conflictSummary: string | undefined;
    let diagnosticError: string | undefined;
    try {
      conflictSummary = (await git(["status", "--short"], workspaceRoot)).trim();
    } catch (statusError) {
      diagnosticError = statusError instanceof Error ? statusError.message : String(statusError);
    }
    try {
      await git(["merge", "--abort"], workspaceRoot);
    } catch {
      // Best effort — merge --abort fails when no merge is in progress.
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const result: IntegratorResult = {
      ok: false,
      mergedBranches,
      ...(diagnosticError ? { diagnosticError } : {}),
      ...(!diagnosticError && conflictSummary ? { conflictSummary: `${errorMessage}\n${conflictSummary}`.trim() } : {}),
    };
    return result;
  }
}
