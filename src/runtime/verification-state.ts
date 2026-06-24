import { z } from "zod";

export const VerificationCheckStatusSchema = z.enum(["passed", "failed", "skipped"]);

export const ReviewerVerdictSchema = z.enum(["approved", "request_changes", "block"]);
export type ReviewerVerdict = z.infer<typeof ReviewerVerdictSchema>;

export const ReviewerResultSchema = z
  .object({
    verdict: ReviewerVerdictSchema,
    evidence: z.string(),
  })
  .strict();

export const VerificationCompletedCheckSchema = z
  .object({
    command: z.string(),
    status: VerificationCheckStatusSchema,
    evidence: z.string(),
  })
  .strict();

export const VerificationStateSchema = z
  .object({
    requiredChecks: z.array(z.string()),
    completedChecks: z.array(VerificationCompletedCheckSchema),
    lastVerificationAt: z.string().optional(),
    completionEvidence: z.array(z.string()),
    missingEvidence: z.array(z.string()),
    reviewerVerdict: ReviewerVerdictSchema.optional(),
    reviewerEvidence: z.string().optional(),
  })
  .strict();

export type VerificationCheckStatus = z.infer<typeof VerificationCheckStatusSchema>;
export type VerificationCompletedCheck = z.infer<typeof VerificationCompletedCheckSchema>;
export type VerificationState = z.infer<typeof VerificationStateSchema>;

export interface VerificationCheckInput extends VerificationCompletedCheck {
  verifiedAt?: string;
}

export function createVerificationState(requiredChecks: string[] = []): VerificationState {
  const state: VerificationState = {
    requiredChecks: uniqueNonEmpty(requiredChecks),
    completedChecks: [],
    completionEvidence: [],
    missingEvidence: [],
  };

  return {
    ...state,
    missingEvidence: deriveMissingEvidence(state),
  };
}

export function recordVerificationCheck(state: VerificationState, check: VerificationCheckInput): VerificationState {
  const completedCheck: VerificationCompletedCheck = {
    command: check.command.trim(),
    status: check.status,
    evidence: check.evidence.trim(),
  };
  const completedChecks = [...state.completedChecks, completedCheck];
  const completionEvidence =
    completedCheck.status === "passed" && completedCheck.evidence
      ? uniqueNonEmpty([...state.completionEvidence, completedCheck.evidence])
      : [...state.completionEvidence];
  const nextState: VerificationState = {
    ...state,
    completedChecks,
    completionEvidence,
    ...(check.verifiedAt ? { lastVerificationAt: check.verifiedAt } : {}),
  };

  return {
    ...nextState,
    missingEvidence: deriveMissingEvidence(nextState),
  };
}

export function applyReviewerVerdict(state: VerificationState, verdict: ReviewerVerdict, evidence: string): VerificationState {
  const nextState: VerificationState = {
    ...state,
    reviewerVerdict: verdict,
    reviewerEvidence: evidence.trim(),
  };

  return {
    ...nextState,
    missingEvidence: deriveMissingEvidence(nextState),
  };
}

export function ingestReviewerVerdicts(state: VerificationState, toolResults: unknown[]): VerificationState {
  if (!toolResults.length) return state;
  let nextState = state;
  for (const result of toolResults) {
    const record = result as { ok?: boolean; name?: string; output?: unknown } | undefined;
    if (!record || record.ok === false || record.name !== "call_subagent") continue;
    const output = record.output as Record<string, unknown> | undefined;
    if (!output || output.type !== "reviewer" || output.status !== "completed") continue;
    const verdictResult = output.result as Record<string, unknown> | undefined;
    if (!verdictResult) continue;
    const parse = ReviewerResultSchema.safeParse({ verdict: verdictResult.verdict, evidence: verdictResult.evidence });
    if (!parse.success) continue;
    nextState = applyReviewerVerdict(nextState, parse.data.verdict, parse.data.evidence);
  }
  return nextState;
}

export function isReviewerBlocking(state: VerificationState): boolean {
  return state.reviewerVerdict === "block";
}

export function addCompletionEvidence(state: VerificationState, evidence: string): VerificationState {
  const nextState: VerificationState = {
    ...state,
    completionEvidence: uniqueNonEmpty([...state.completionEvidence, evidence]),
  };

  return {
    ...nextState,
    missingEvidence: deriveMissingEvidence(nextState),
  };
}

export function deriveMissingEvidence(state: VerificationState): string[] {
  const completedPassedCommands = new Set(
    state.completedChecks.filter((check) => check.status === "passed").map((check) => check.command.trim()).filter(Boolean),
  );
  const explicitEvidence = new Set(state.completionEvidence.map((evidence) => evidence.trim()).filter(Boolean));

  const missing = uniqueNonEmpty(state.requiredChecks).filter((check) => !completedPassedCommands.has(check) && !explicitEvidence.has(check));

  if (state.reviewerVerdict && state.reviewerVerdict !== "approved") {
    return [...missing, `reviewer_${state.reviewerVerdict}`];
  }

  return missing;
}

export function renderVerificationStateForCockpit(state: VerificationState): string {
  return [
    "# Verification State",
    `Required checks: ${renderList(state.requiredChecks)}`,
    `Completed checks: ${renderCompletedChecks(state.completedChecks)}`,
    `Last verification: ${state.lastVerificationAt ?? "never"}`,
    `Completion evidence: ${renderList(state.completionEvidence)}`,
    `Missing evidence: ${renderList(state.missingEvidence.length ? state.missingEvidence : deriveMissingEvidence(state))}`,
    state.reviewerVerdict
      ? `Reviewer verdict: ${state.reviewerVerdict}${state.reviewerEvidence ? ` - ${state.reviewerEvidence}` : ""}`
      : "Reviewer verdict: none",
  ].join("\n");
}

function renderCompletedChecks(checks: VerificationCompletedCheck[]): string {
  if (!checks.length) return "none";
  return checks.map((check) => `${check.command} [${check.status}]${check.evidence ? ` - ${check.evidence}` : ""}`).join("; ");
}

function renderList(values: string[]): string {
  const normalized = uniqueNonEmpty(values);
  return normalized.length ? normalized.join(", ") : "none";
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}
