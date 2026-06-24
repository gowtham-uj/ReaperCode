import { z } from "zod";

export const VerificationCheckStatusSchema = z.enum(["passed", "failed", "skipped"]);

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

  return uniqueNonEmpty(state.requiredChecks).filter((check) => !completedPassedCommands.has(check) && !explicitEvidence.has(check));
}

export function renderVerificationStateForCockpit(state: VerificationState): string {
  return [
    "# Verification State",
    `Required checks: ${renderList(state.requiredChecks)}`,
    `Completed checks: ${renderCompletedChecks(state.completedChecks)}`,
    `Last verification: ${state.lastVerificationAt ?? "never"}`,
    `Completion evidence: ${renderList(state.completionEvidence)}`,
    `Missing evidence: ${renderList(state.missingEvidence.length ? state.missingEvidence : deriveMissingEvidence(state))}`,
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
