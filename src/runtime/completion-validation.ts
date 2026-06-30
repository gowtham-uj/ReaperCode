import { createHash } from "node:crypto";

import type { ToolCall, ToolResult } from "../tools/types.js";
import { classifyGroundedVerificationSignal } from "../verify/runner.js";
import type { TaskContract } from "./task-contract.js";
import type { VerificationState } from "./verification-state.js";
import type { ToolCallLike } from "./tool-validation.js";

export type CompletionValidationBlockerCode =
  | "missing_complete_task"
  | "missing_contract_evidence"
  | "verification_ladder_not_eligible"
  | "repeated_completion_without_new_evidence";

export interface CompletionValidationBlocker {
  code: CompletionValidationBlockerCode;
  message: string;
  toolCallId?: string;
  details?: string[];
}

export interface CompletionEvidenceRecord {
  source: "tool_result" | "verification_state" | "completion_contract";
  label: string;
  text: string;
  strictVerification: boolean;
}

export interface CompletionValidationResult {
  ok: boolean;
  blockers: CompletionValidationBlocker[];
  completionSignal?: Extract<ToolCall, { name: "complete_task" }>;
  evidence: {
    records: CompletionEvidenceRecord[];
    contractCovered: boolean;
    verificationEligible: boolean;
    fingerprint: string;
  };
}

export interface CompletionValidationOptions {
  toolCalls?: ToolCallLike[];
  completionSignal?: Extract<ToolCall, { name: "complete_task" }>;
  taskContract?: TaskContract;
  verificationState?: VerificationState;
  toolResults?: ToolResult[];
  requireVerificationLadder?: boolean;
  previousAttemptEvidenceFingerprints?: string[];
}

type ResolvedCompletionValidationOptions = {
  toolCalls?: ToolCallLike[];
  completionSignal?: Extract<ToolCall, { name: "complete_task" }>;
  taskContract?: TaskContract | undefined;
  verificationState?: VerificationState | undefined;
  toolResults?: ToolResult[];
  requireVerificationLadder?: boolean;
  previousAttemptEvidenceFingerprints?: string[];
};

export function validateStrictCompletion(options: CompletionValidationOptions): CompletionValidationResult {
  const toolResults = options.toolResults ?? [];
  const completionSignal = options.completionSignal ?? findCompletionSignal(options.toolCalls);
  const resolved: ResolvedCompletionValidationOptions = options;
  const evidenceRecords = collectCompletionEvidence({
    toolResults,
    verificationState: resolved.verificationState,
    completionSignal,
  });
  const evidenceFingerprint = createCompletionEvidenceFingerprint(evidenceRecords);
  const contractCovered = hasContractEvidence(resolved.taskContract, evidenceRecords);
  const verificationEligible = isVerificationLadderEligible({
    verificationState: resolved.verificationState,
    evidenceRecords,
    requireVerificationLadder: options.requireVerificationLadder ?? true,
  });
  const blockers: CompletionValidationBlocker[] = [];

  if (!completionSignal) {
    blockers.push({
      code: "missing_complete_task",
      message: "Completion requires an explicit complete_task tool call. Final-looking assistant text is not a completion signal.",
    });
  }

  if (completionSignal && !contractCovered) {
    const details = contractEvidenceRequirements(resolved.taskContract);
    blockers.push({
      code: "missing_contract_evidence",
      message: "Completion is blocked because no successful evidence matches the task contract deliverables or acceptance criteria.",
      toolCallId: completionSignal.id,
      ...(details.length ? { details } : {}),
    });
  }

  if (completionSignal && !verificationEligible) {
    const details = resolved.verificationState?.missingEvidence;
    blockers.push({
      code: "verification_ladder_not_eligible",
      message: "Completion is blocked because the verification ladder has no passed required check, strict command-backed evidence, or explicit completion evidence.",
      toolCallId: completionSignal.id,
      ...(details && details.length ? { details } : {}),
    });
  }

  if (
    completionSignal &&
    evidenceFingerprint &&
    (options.previousAttemptEvidenceFingerprints ?? []).includes(evidenceFingerprint)
  ) {
    blockers.push({
      code: "repeated_completion_without_new_evidence",
      message: "Completion is blocked because this complete_task attempt repeats without new evidence since the prior blocked attempt.",
      toolCallId: completionSignal.id,
      details: [`evidence fingerprint: ${evidenceFingerprint}`],
    });
  }

  return {
    ok: blockers.length === 0,
    blockers,
    ...(completionSignal ? { completionSignal } : {}),
    evidence: {
      records: evidenceRecords,
      contractCovered,
      verificationEligible,
      fingerprint: evidenceFingerprint,
    },
  };
}

export function createCompletionEvidenceFingerprint(records: CompletionEvidenceRecord[]): string {
  const normalized = records
    .map((record) => `${record.source}:${record.label}:${normalizeWhitespace(record.text)}:${record.strictVerification}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function findCompletionSignal(toolCalls: ToolCallLike[] | undefined): Extract<ToolCall, { name: "complete_task" }> | undefined {
  return toolCalls?.find((call): call is Extract<ToolCall, { name: "complete_task" }> => call.name === "complete_task" && hasCompleteTaskShape(call));
}

function hasCompleteTaskShape(call: ToolCallLike): call is Extract<ToolCall, { name: "complete_task" }> {
  const raw = call as Partial<ToolCall>;
  return typeof raw.id === "string" && raw.name === "complete_task" && Boolean(raw.args);
}

function collectCompletionEvidence(input: {
  toolResults: ToolResult[];
  verificationState: VerificationState | undefined;
  completionSignal: Extract<ToolCall, { name: "complete_task" }> | undefined;
}): CompletionEvidenceRecord[] {
  const records: CompletionEvidenceRecord[] = [];

  for (const result of input.toolResults) {
    if (!result.ok) continue;

    // Promote reviewer verdicts into verification state so missingEvidence reflects them.
    if (result.name === "call_subagent") {
      const subagentResult = result.output as Record<string, unknown> | undefined;
      if (
        subagentResult &&
        typeof subagentResult === "object" &&
        subagentResult.type === "reviewer" &&
        (subagentResult.verdict === "approved" || subagentResult.verdict === "request_changes" || subagentResult.verdict === "block")
      ) {
        continue;
      }
    }

    const command = getToolResultCommand(result);
    const text = renderToolResultEvidence(result);
    records.push({
      source: "tool_result",
      label: result.toolCallId || result.name,
      text,
      strictVerification: result.name === "bash" && isStrictVerificationCommand(command),
    });
  }

  for (const check of input.verificationState?.completedChecks ?? []) {
    if (check.status !== "passed") continue;
    records.push({
      source: "verification_state",
      label: check.command,
      text: `${check.command}\n${check.evidence}`,
      strictVerification: true,
    });
  }

  for (const evidence of input.verificationState?.completionEvidence ?? []) {
    records.push({
      source: "verification_state",
      label: "completionEvidence",
      text: evidence,
      strictVerification: false,
    });
  }

  for (const command of input.completionSignal?.args.verificationContract?.commands ?? []) {
    records.push({
      source: "completion_contract",
      label: command.command,
      text: [command.command, command.purpose ?? ""].join("\n"),
      strictVerification: isStrictVerificationCommand(command.command),
    });
  }

  return records;
}

function hasContractEvidence(contract: TaskContract | undefined, records: CompletionEvidenceRecord[]): boolean {
  if (!contract) return records.length > 0;
  const requirements = contractEvidenceRequirements(contract);
  if (requirements.length === 0) return records.length > 0;
  if (records.some((record) => record.strictVerification && isBroadAuthoritativeEvidence(record.text))) return true;
  const evidenceText = records.map((record) => record.text.toLowerCase()).join("\n");
  return requirements.every((requirement) => requirementCoveredByEvidence(requirement, evidenceText));
}

function contractEvidenceRequirements(contract: TaskContract | undefined): string[] {
  if (!contract) return [];
  const source = contract.deliverables.length ? contract.deliverables : contract.acceptanceCriteria;
  return unique(source).slice(0, 8);
}

function requirementCoveredByEvidence(requirement: string, evidenceText: string): boolean {
  const terms = requirementTerms(requirement);
  if (terms.length === 0) return true;
  const pathTerms = terms.filter((term) => term.includes(".") || term.includes("/"));
  if (pathTerms.length > 0) return pathTerms.some((term) => evidenceText.includes(term));
  return terms.some((term) => evidenceText.includes(term));
}

function isVerificationLadderEligible(input: {
  verificationState: VerificationState | undefined;
  evidenceRecords: CompletionEvidenceRecord[];
  requireVerificationLadder: boolean;
}): boolean {
  if (!input.requireVerificationLadder) return true;
  const state = input.verificationState;
  if (state) {
    const hasPassedRequiredCheck = state.completedChecks.some((check) => check.status === "passed");
    const hasExplicitEvidence = state.completionEvidence.some((evidence) => evidence.trim());
    const hasNoMissingEvidence = state.missingEvidence.length === 0;
    if (hasNoMissingEvidence && (hasPassedRequiredCheck || hasExplicitEvidence)) return true;
  }
  return input.evidenceRecords.some((record) => record.strictVerification);
}

function isStrictVerificationCommand(command: string): boolean {
  if (!command.trim()) return false;
  if (classifyGroundedVerificationSignal(command).grounded) return true;
  return (
    /\b(?:assert|diff|cmp|grep\s+-q|jq\s+-e|sha1sum|sha256sum|md5sum|test\s+-[efs])\b/i.test(command) ||
    /(?:^|[;&|]\s*)test\s+\S+/i.test(command) ||
    /(?:^|[;&|]\s*)\[\s+/i.test(command) ||
    /\b(?:raise\s+SystemExit|sys\.exit|process\.exit|throw\s+new\s+Error)\b/i.test(command)
  );
}

function isBroadAuthoritativeEvidence(text: string): boolean {
  return /\b(?:pytest|node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|bun\s+(?:run\s+)?test|go\s+test|cargo\s+test|ctest|mvn\s+test|gradle\s+test)\b/i.test(text);
}

function getToolResultCommand(result: ToolResult): string {
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  return typeof args.cmd === "string" ? args.cmd : "";
}

function renderToolResultEvidence(result: ToolResult): string {
  return [
    result.name,
    getToolResultCommand(result),
    stringifyUnknown(result.args),
    stringifyUnknown(result.output),
    result.error?.message ?? "",
  ].join("\n");
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function requirementTerms(value: string): string[] {
  const paths = [...value.matchAll(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,12}/g)].map((match) => match[0]!.toLowerCase());
  const words =
    value
      .toLowerCase()
      .match(/[a-z][a-z0-9_-]{3,}/g)
      ?.filter((word) => !STOP_WORDS.has(word))
      .slice(0, 8) ?? [];
  return unique([...paths, ...words]);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value).toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

const STOP_WORDS = new Set([
  "acceptance",
  "addressed",
  "artifact",
  "criteria",
  "deliverable",
  "ensure",
  "implemented",
  "requested",
  "require",
  "required",
  "should",
  "task",
  "that",
  "with",
]);
