import type { ToolResult } from "../tools/types.js";

export interface BestOfNVerification {
  ok: boolean;
  command?: string;
  feedback?: string[];
}

export interface BestOfNResultLike {
  assistantMessage: string;
  toolResults: ToolResult[];
  verification?: BestOfNVerification;
}

export interface RolloutCandidate<T extends BestOfNResultLike = BestOfNResultLike> {
  id: string;
  result: T;
  workspaceRoot?: string;
}

export interface RankedRollout<T extends BestOfNResultLike = BestOfNResultLike> extends RolloutCandidate<T> {
  verified: boolean;
  agreementCount: number;
  failedToolResults: number;
  toolResultCount: number;
  executionSignature: string;
}

export function selectBestRollout<T extends BestOfNResultLike>(candidates: Array<RolloutCandidate<T>>): RankedRollout<T> | undefined {
  if (candidates.length === 0) return undefined;
  const signatures = new Map<string, number>();
  for (const candidate of candidates) {
    const signature = buildExecutionSignature(candidate.result);
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }
  const ranked = candidates.map((candidate) => {
    const executionSignature = buildExecutionSignature(candidate.result);
    return {
      ...candidate,
      verified: candidate.result.verification?.ok === true,
      agreementCount: signatures.get(executionSignature) ?? 1,
      failedToolResults: candidate.result.toolResults.filter((item) => !item.ok).length,
      toolResultCount: candidate.result.toolResults.length,
      executionSignature,
    } satisfies RankedRollout<T>;
  });
  ranked.sort((left, right) => {
    if (left.verified !== right.verified) return left.verified ? -1 : 1;
    if (left.agreementCount !== right.agreementCount) return right.agreementCount - left.agreementCount;
    if (left.failedToolResults !== right.failedToolResults) return left.failedToolResults - right.failedToolResults;
    if (left.toolResultCount !== right.toolResultCount) return left.toolResultCount - right.toolResultCount;
    return left.id.localeCompare(right.id);
  });
  return ranked[0];
}

export function buildExecutionSignature(result: BestOfNResultLike): string {
  const shellEvidence = result.toolResults
    .filter((item) => item.name === "run_shell_command")
    .slice(-5)
    .map((item) => {
      const args = item.args && typeof item.args === "object" ? (item.args as Record<string, unknown>) : {};
      const output = item.output && typeof item.output === "object" ? (item.output as Record<string, unknown>) : {};
      return {
        command: normalizeText(typeof args.cmd === "string" ? args.cmd : ""),
        ok: item.ok,
        exitCode: typeof output.exitCode === "number" ? output.exitCode : undefined,
        stdout: normalizeText(typeof output.stdout === "string" ? output.stdout.slice(-2000) : ""),
        stderr: normalizeText(typeof output.stderr === "string" ? output.stderr.slice(-2000) : ""),
      };
    });
  return JSON.stringify({
    verified: result.verification?.ok === true,
    verificationCommand: normalizeText(result.verification?.command ?? ""),
    shellEvidence,
    assistantMessage: normalizeText(result.assistantMessage).slice(0, 1000),
  });
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
