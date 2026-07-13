/**
 * Pure verification-evidence classifier for cockpit observability.
 *
 * It classifies command results and records matching checks. It never gates
 * tool execution or the model-owned natural-stop path.
 */

import {
  createVerificationState,
  recordVerificationCheck,
  type VerificationCompletedCheck,
  type VerificationState,
} from "./verification-state.js";

export interface VerificationCheckClassifierInput {
  /** Tool name, e.g. "bash", "list_directory". */
  toolName: string;
  /** Tool args, with the command for shell-style tools. */
  args: Record<string, unknown>;
  /** Whether the tool result was `ok: true`. */
  ok: boolean;
  /** Tool output, used to extract exitCode, stdout snippets, etc. */
  output?: unknown;
  /** Tool error, if any. */
  error?: { code?: string; message?: string } | undefined;
}

export interface VerificationCheckCandidate {
  /** True if this tool result qualifies as a verification check. */
  isCheck: boolean;
  /** Shell command (or other canonical test command). Only set when isCheck. */
  command?: string;
  /** "passed" | "failed" | "skipped". Only set when isCheck. */
  status?: "passed" | "failed" | "skipped";
  /** Short evidence string the cockpit can display. */
  evidence?: string;
  /** Optional command regex this check matched against. */
  matchedPattern?: string;
}

export interface OrchestratorOptions {
  /**
   * Patterns that count as "verification" tools. Default: `npm|pnpm|yarn|bun
   * (run )?test`, `pytest`, `cargo test`, `go test`, `make test`, plain
   * `vitest`, `jest`. Override to add custom test runners.
   */
  verificationPatterns?: RegExp[];
}

const DEFAULT_VERIFICATION_PATTERNS: RegExp[] = [
  /\bnpm\s+(?:run\s+)?(?:test|run\s+test|run\s+build)\b/,
  /\bpnpm\s+(?:run\s+)?(?:test|run\s+build)\b/,
  /\byarn\s+(?:run\s+)?(?:test|run\s+build)\b/,
  /\bbun\s+(?:run\s+)?(?:test|run\s+build)\b/,
  /\bpytest\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bmake\s+(?:test|check|build)\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bnode\s+--test\b/,
];

export class VerificationOrchestrator {
  private readonly options: { verificationPatterns: RegExp[] };

  constructor(options: OrchestratorOptions = {}) {
    this.options = {
      verificationPatterns: options.verificationPatterns ?? DEFAULT_VERIFICATION_PATTERNS,
    };
  }

  /**
   * Initialize a new orchestrator state with the agent's required
   * checks. The required checks are the test/build commands the agent
   * must run before completion is allowed.
   */
  initialize(requiredChecks: string[] = []): VerificationState {
    return createVerificationState(requiredChecks);
  }

  /**
   * Classify a tool result as a verification check or not. A bash call
   * that matches one of the verification patterns becomes a check;
   * everything else is not a check.
   */
  classifyToolResult(input: VerificationCheckClassifierInput): VerificationCheckCandidate {
    if (input.toolName !== "bash") {
      return { isCheck: false };
    }
    const cmd = typeof input.args?.cmd === "string" ? input.args.cmd : "";
    if (!cmd.trim()) {
      return { isCheck: false };
    }
    const matchedPattern = this.options.verificationPatterns.find((pattern) => pattern.test(cmd))?.source;
    if (!matchedPattern) {
      return { isCheck: false };
    }
    if (!input.ok) {
      return {
        isCheck: true,
        command: cmd,
        status: "failed",
        evidence: input.error?.message ?? "command failed",
        matchedPattern,
      };
    }
    const exitCode = readExitCode(input.output);
    const status: "passed" | "failed" | "skipped" = exitCode === 0 ? "passed" : "failed";
    const evidence = status === "passed" ? `exitCode=0 ${cmd}` : `exitCode=${exitCode ?? "?"} ${cmd}`;
    return {
      isCheck: true,
      command: cmd,
      status,
      evidence,
      matchedPattern,
    };
  }

  /**
   * Apply a classified check to the verification state. Returns the
   * updated state.
   */
  apply(state: VerificationState, candidate: VerificationCheckCandidate): VerificationState {
    if (!candidate.isCheck || !candidate.command || !candidate.status || !candidate.evidence) {
      return state;
    }
    return recordVerificationCheck(state, {
      command: candidate.command,
      status: candidate.status,
      evidence: candidate.evidence,
    });
  }

  /**
   * Convenience: classify + apply in one call. Returns the updated
   * state plus the candidate for logging.
   */
  ingest(state: VerificationState, input: VerificationCheckClassifierInput): {
    state: VerificationState;
    candidate: VerificationCheckCandidate;
  } {
    const candidate = this.classifyToolResult(input);
    const next = candidate.isCheck ? this.apply(state, candidate) : state;
    return { state: next, candidate };
  }

}


function readExitCode(output: unknown): number | undefined {
  if (!output || typeof output !== "object") return undefined;
  const record = output as { exitCode?: unknown };
  return typeof record.exitCode === "number" ? record.exitCode : undefined;
}

/**
 * Extract every verification check from a list of recent tool results.
 * Pure helper used by both the engine and the cockpit.
 */
export function findVerificationChecks(
  orchestrator: VerificationOrchestrator,
  results: VerificationCheckClassifierInput[],
): VerificationCompletedCheck[] {
  const out: VerificationCompletedCheck[] = [];
  for (const result of results) {
    const candidate = orchestrator.classifyToolResult(result);
    if (
      candidate.isCheck &&
      candidate.command &&
      candidate.status &&
      candidate.evidence
    ) {
      out.push({
        command: candidate.command,
        status: candidate.status,
        evidence: candidate.evidence,
      });
    }
  }
  return out;
}
