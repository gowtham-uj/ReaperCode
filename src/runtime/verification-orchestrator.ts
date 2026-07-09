/**
 * Verification orchestrator for the Reaper runtime.
 *
 * Wraps `verification-state.ts` (the underlying typed state) and adds
 * the Codex/Claude-style "completion gate" logic: a tool cannot mark
 * the task complete unless there is matching verification evidence in
 * the verification state.
 *
 * The orchestrator is a pure, deterministic module. It does not
 * spawn subprocesses, call the model, or hit the filesystem; it only
 * inspects tool results and produces a verdict that the engine then
 * uses to gate `complete_task`.
 *
 * The class is intentionally side-effect free so it can be tested in
 * isolation, and so the engine can decide whether to run the gate on
 * the main thread or off (e.g. in a verifier subagent).
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
  /**
   * When true, only require the FIRST required check to be passed
   * before `complete_task` is allowed. When false (default), all
   * required checks must pass.
   */
  requireAllChecks?: boolean;
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
  private readonly options: Required<OrchestratorOptions>;

  constructor(options: OrchestratorOptions = {}) {
    this.options = {
      verificationPatterns: options.verificationPatterns ?? DEFAULT_VERIFICATION_PATTERNS,
      requireAllChecks: options.requireAllChecks ?? false,
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
   * Classify a tool result as a verification check or not. A run_shell_command
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

  /**
   * Determine whether the agent is allowed to call `complete_task`.
   * The rule:
   *
   * - If there are no required checks, allow (the agent did not opt
   *   into verification; trust the task contract).
   * - Otherwise, at least one passed check must exist; if
   *   requireAllChecks is true, every required check must have a
   *   passing entry.
   *
   * Returns the verdict + the reason.
   */
  evaluateCompletion(state: VerificationState): {
    allowed: boolean;
    reason: string;
    missingRequiredChecks: string[];
  } {
    if (state.requiredChecks.length === 0) {
      return { allowed: true, reason: "no required checks defined; complete_task allowed", missingRequiredChecks: [] };
    }
    const passedByCommand = new Set<string>();
    for (const check of state.completedChecks) {
      if (check.status === "passed") passedByCommand.add(check.command);
    }
    const missing: string[] = [];
    for (const required of state.requiredChecks) {
      if (!requiredCommandMatches(required, passedByCommand)) missing.push(required);
    }
    if (missing.length === 0) {
      return {
        allowed: true,
        reason: this.options.requireAllChecks
          ? `all ${state.requiredChecks.length} required checks passed`
          : "at least one required check passed",
        missingRequiredChecks: [],
      };
    }
    return {
      allowed: false,
      reason: this.options.requireAllChecks
        ? `${missing.length}/${state.requiredChecks.length} required checks still missing`
        : "no passing required check; run one of: " + missing.join(", "),
      missingRequiredChecks: missing,
    };
  }
}

/**
 * Loose matching between a required-check pattern and a passing command.
 * The required check might be `npm test` while the agent actually ran
 * `npm test --watch=false`. Normalize both sides by lowercasing and
 * stripping trailing whitespace before comparing the required command
 * as a prefix of the observed command.
 */
function requiredCommandMatches(required: string, passing: Set<string>): boolean {
  if (passing.has(required)) return true;
  const r = required.trim().toLowerCase();
  for (const candidate of passing) {
    if (candidate.trim().toLowerCase().startsWith(r)) return true;
  }
  return false;
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
