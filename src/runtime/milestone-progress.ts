import type { ToolResult } from "../tools/types.js";
import { detectSemanticFailureText } from "../verify/semantic-failure.js";

export type VerifiedMilestone = "none" | "build_passed" | "runtime_passed" | "verification_passed";

export interface MilestoneProgressOptions {
  failureLimit?: number;
  readOnlyLimit?: number;
  deadlinePressureActive?: boolean;
}

export interface MilestoneProgressDecision {
  shouldEscalate: boolean;
  milestone: VerifiedMilestone;
  failuresSinceMilestone: number;
  readOnlySinceMilestone: number;
  reason?: string;
  feedback?: string;
}

export function evaluateMilestoneProgress(
  results: ToolResult[],
  options: MilestoneProgressOptions = {},
): MilestoneProgressDecision {
  const failureLimit = options.failureLimit ?? 2;
  const readOnlyLimit = options.readOnlyLimit ?? 10;
  const progressGuardV2 = process.env.REAPER_PROGRESS_GUARD_V2 !== "0";
  const lastMilestoneIndex = findLastIndex(results, isSuccessfulMilestoneResult);
  const milestone = lastMilestoneIndex >= 0 ? classifySuccessfulMilestone(results[lastMilestoneIndex]!) : "none";
  const window = results.slice(lastMilestoneIndex + 1);
  const highSignalFailures = window.filter(isHighSignalFailure);
  const readOnlySinceMilestone = window.filter(isReadOnlyResult).length;
  const successfulMutations = window.filter(isSuccessfulMutation).length;
  // v2: read-only observations since last forward progress (mutation OR milestone), so post-mutation read-thrash is still caught.
  const lastMutationIndex = findLastIndex(results, isSuccessfulMutation);
  const lastProgressIndex = Math.max(lastMilestoneIndex, lastMutationIndex);
  const readOnlySinceProgress = results.slice(lastProgressIndex + 1).filter(isReadOnlyResult).length;
  const blockedDiagnostic = [...window].reverse().find(isBlockedDiagnostic);
  const runtimeCrash = [...window].reverse().find(isRuntimeCrash);

  const base = {
    milestone,
    failuresSinceMilestone: highSignalFailures.length,
    readOnlySinceMilestone,
  };

  if (runtimeCrash) {
    return escalation(
      base,
      "a runtime crash occurred without a later verified milestone",
      "Stop the current implementation strategy. Replan from the crash evidence, use a discriminating diagnostic, and choose a materially different boundary or implementation path.",
    );
  }
  if (blockedDiagnostic) {
    return escalation(
      base,
      "a discriminating diagnostic or required execution action was blocked",
      "Promote to planner/rescue mode. Replace the blocked diagnostic with a legal equivalent before making architecture-changing edits.",
    );
  }
  if (highSignalFailures.length >= failureLimit) {
    return escalation(
      base,
      `${highSignalFailures.length} build/runtime/verification failures occurred without advancing a verified milestone`,
      "Promote to planner/rescue mode. Preserve the evidence, replace the current root-cause hypothesis or recovery strategy, and require a narrow passing milestone before returning to normal execution.",
    );
  }
  if (progressGuardV2 && milestone === "none" && readOnlySinceProgress >= readOnlyLimit) {
    return escalation(
      { ...base, readOnlySinceMilestone: Math.max(readOnlySinceMilestone, readOnlySinceProgress) },
      `${readOnlySinceProgress} read-only observations occurred since the last forward progress (mutation or verified milestone) without advancing a verified milestone`,
      "Promote to planner mode now. Convert the gathered evidence into a bounded diagnostic and the smallest implementation step instead of continuing broad inspection.",
    );
  }
  if (!progressGuardV2 && milestone === "none" && successfulMutations === 0 && readOnlySinceMilestone >= readOnlyLimit) {
    return escalation(
      base,
      `${readOnlySinceMilestone} read-only observations occurred before any verified milestone or implementation mutation`,
      "Promote to planner mode now. Convert the gathered evidence into a bounded diagnostic and the smallest implementation step instead of continuing broad inspection.",
    );
  }
  if (options.deadlinePressureActive && milestone === "none") {
    return escalation(
      base,
      "the implementation deadline checkpoint was reached without a verified milestone",
      "Promote to planner/rescue mode and switch to the smallest acceptance-first implementation path with an immediate build or behavioral check.",
    );
  }

  return { shouldEscalate: false, ...base };
}

export function getAtomicExecutionFeedback(results: ToolResult[]): string | undefined {
  const successfulBuild = [...results].reverse().find((result) => result.ok && result.name === "bash" && isBuildCommand(commandOf(result)));
  if (!successfulBuild) return undefined;
  const output = renderResult(successfulBuild);
  const candidates = extractBuildArtifactCandidates(output);
  const observed = candidates.length > 0 ? ` Observed build target(s): ${candidates.join(", ")}.` : "";
  return (
    "Build milestone passed. Keep the next stages atomic: execute the produced public artifact separately, then run strict verification separately." +
    `${observed} Do not guess an executable name or combine build, runtime, and verification into one opaque command; inspect the build output/directory when the artifact path is unclear.`
  );
}

function escalation(
  base: Omit<MilestoneProgressDecision, "shouldEscalate" | "reason" | "feedback">,
  reason: string,
  feedback: string,
): MilestoneProgressDecision {
  return { shouldEscalate: true, ...base, reason, feedback };
}

function isSuccessfulMilestoneResult(result: ToolResult): boolean {
  return classifySuccessfulMilestone(result) !== "none";
}

function classifySuccessfulMilestone(result: ToolResult): VerifiedMilestone {
  if (!result.ok || result.name !== "bash") return "none";
  if (detectSemanticFailureText(renderResult(result))) return "none";
  const command = commandOf(result);
  if (isStrictVerificationCommand(command)) return "verification_passed";
  if (isRuntimeCommand(command) && !isBuildCommand(command)) return "runtime_passed";
  if (isBuildCommand(command)) return "build_passed";
  return "none";
}

function isHighSignalFailure(result: ToolResult): boolean {
  const semanticFailure = detectSemanticFailureText(renderResult(result));
  if (result.ok && !semanticFailure) return false;
  if (isBlockedDiagnostic(result) || isRuntimeCrash(result)) return true;
  if (result.name !== "bash") return false;
  const command = commandOf(result);
  return isBuildCommand(command) || isRuntimeCommand(command) || isStrictVerificationCommand(command);
}

function isBlockedDiagnostic(result: ToolResult): boolean {
  if (result.ok) return false;
  return /^(?:synthetic_result)$/.test(
    result.error?.code ?? "",
  );
}

function isRuntimeCrash(result: ToolResult): boolean {
  return /(?:code 13[49]|(?:RUN|EXIT(?:_CODE)?)\s*[:=]\s*13[49]\b|segmentation fault|segfault|core dumped|access violation|bus error|panic:|fatal runtime error|addresssanitizer|undefinedbehaviorsanitizer)/i.test(
    renderResult(result),
  );
}

function isReadOnlyResult(result: ToolResult): boolean {
  if (!result.ok) return false;
  return ["read_file", "view_file", "skim_file", "list_directory", "grep_search", "inspect_environment", "web_search", "web_fetch"].includes(result.name);
}

function isSuccessfulMutation(result: ToolResult): boolean {
  if (!result.ok) return false;
  if (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name)) return true;
  return result.name === "bash" && /\b(?:mkdir|cp|mv|rm|ln|patch|sed\s+-i|perl\s+-pi|npm\s+install|pip\s+install)\b/i.test(commandOf(result));
}

function isBuildCommand(command: string): boolean {
  return /\b(?:cmake\s+(?:--build|-S\b)|make\b|ninja\b|meson\s+(?:compile|setup)|g\+\+|gcc|clang\+\+|clang|(?:npx\s+)?tsc\b|python3?\s+-m\s+py_compile|cargo\s+(?:build|check)|go\s+build|npm\s+(?:run\s+)?build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build|bun\s+(?:run\s+)?build|mvn\s+(?:package|compile)|gradle\s+(?:build|assemble))\b/i.test(
    command,
  );
}

function isRuntimeCommand(command: string): boolean {
  if (isBuildCommand(command)) return /(?:^|[;&|]\s*|\bdo\s+)(?:\.\/|build\/|\.\/build\/|dist\/|target\/|bin\/)[A-Za-z0-9_./-]+/i.test(command);
  return (
    /(?:^|[;&|]\s*|\bdo\s+)(?:\.\/|build\/|\.\/build\/|dist\/|target\/|bin\/)[A-Za-z0-9_./-]+/i.test(command) ||
    /\b(?:python3?|node|ruby|perl|java|dotnet)\s+(?:\.\/)?[A-Za-z0-9_./-]+\.(?:py|m?js|cjs|rb|pl|jar|dll)\b/i.test(command)
  );
}

function isStrictVerificationCommand(command: string): boolean {
  return (
    /\b(?:pytest|node\s+--test|jest|vitest|mocha|ctest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test)\b/i.test(command) ||
    /\b(?:assert|diff|cmp|grep\s+-q|jq\s+-e|test\s+-[efsd]|sys\.exit|process\.exit|raise\s+SystemExit)\b/i.test(command)
  );
}

function extractBuildArtifactCandidates(output: string): string[] {
  const candidates = new Set<string>();
  for (const match of output.matchAll(/\b(?:Built target|Linking [^\n]* executable|Creating executable|executable:)\s+([A-Za-z0-9_./+-]+)/gi)) {
    if (match[1]) candidates.add(match[1]);
  }
  return [...candidates].slice(0, 8);
}

function commandOf(result: ToolResult): string {
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  return typeof args.cmd === "string" ? args.cmd : "";
}

function renderResult(result: ToolResult): string {
  const output = result.output && typeof result.output === "object" ? JSON.stringify(result.output) : String(result.output ?? "");
  return `${commandOf(result)}\n${result.error?.message ?? ""}\n${output}`;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}
