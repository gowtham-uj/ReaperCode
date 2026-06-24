/**
 * Phase T3.11 Wave 1c-i — relevance-gate extraction from engine.ts.
 *
 * Pure helpers + guard functions that decide which tool calls are
 * allowed in the current turn (relevance gate) and shape the user-
 * facing feedback when a call is blocked.
 *
 * Extracted from engine.ts (Wave 1c-i). Behavior must be identical.
 * All call sites in engine.ts switch to imports from this module.
 *
 * Cross-dependency helpers (still in engine.ts) are imported from
 * "./engine.js". Already-extracted helpers are imported from
 * "./file-hints.js" and "./rescue-watchdog.js".
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ToolCall, ToolResult } from "../tools/types.js";
import type { ExecutionPlanStep } from "./engine.js";
import { classifyShellCommandSemantics } from "../tools/command-semantics.js";import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";
import { getShellCommandArg, isMutatingToolCall } from "./engine.js";
import { renderToolResultForModel } from "../context/history-compaction.js";
import {
  extractFilePathsFromFailure,
  inferFilesHintFromResults,
  isGeneratedOrBuildPath,
  normalizeArtifactPathForMatch,
  stripWorkspacePrefix,
  uniqueStrings,
} from "./file-hints.js";

export function guardRelevanceGatedActions(
  toolCalls: ToolCall[],
  input: {
    prompt: string;
    currentStep?: ExecutionPlanStep;
    toolResults: ToolResult[];
    feedback: string[];
    negativeConstraints: string[];
  },
): { allowed: ToolCall[]; blockedResults: ToolResult[] } {
  const allowed: ToolCall[] = [];
  const blockedResults: ToolResult[] = [];
  for (const call of toolCalls) {
    const decision = classifyActionRelevance(call, input);
    if (decision.relevance === "IRRELEVANT") {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "relevance_gate_blocked",
          message:
            `Reaper blocked this action as irrelevant to the current problem contract: ${decision.reason}. ` +
            "Return to the primary objective and success conditions. Do not fix legacy noise, lint/format warnings, dependency drift, or unrelated build failures unless they directly block the requested task.",
        },
      });
      continue;
    }
    allowed.push(call);
  }
  return { allowed, blockedResults };
}



export function isProjectConfigPath(filePath: string): boolean {
  return /(?:^|\/)(?:CMakeLists\.txt|Makefile|package\.json|tsconfig\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|requirements(?:-[^/]*)?\.txt|Dockerfile|docker-compose\.ya?ml)$/i.test(filePath);
}



export function buildRelevanceGateFeedback(
  blockedResults: ToolResult[],
  input: { prompt: string; currentStep?: ExecutionPlanStep },
): string[] {
  if (blockedResults.length === 0) return [];
  const blockedDescriptions = blockedResults
    .map((result) => {
      const target = describeToolResultTarget(result);
      return `- ${result.name}${target ? ` ${target}` : ""}: ${result.error?.message ?? "blocked as irrelevant"}`;
    })
    .slice(0, 5)
    .join("\n");
  return [
    [
      "Relevance gate redirected the trajectory.",
      `Primary objective: ${input.prompt.slice(0, 500)}`,
      input.currentStep ? `Current step: ${input.currentStep.title} - ${input.currentStep.instructions}` : "Current step: none",
      "Blocked actions:",
      blockedDescriptions,
      "Next action must be problem-solving, not cleanup: inspect the specific visible spec/test/error that defines success, create or repair the task-facing deliverable, or run the narrowest check that proves the requested task is closer to done.",
      "If you believe the blocked action is truly required, first gather concrete evidence tying it to the success conditions, then retry with a narrow scoped action.",
    ].join("\n"),
  ];
}



export function classifyActionRelevance(
  call: ToolCall,
  input: {
    prompt: string;
    currentStep?: ExecutionPlanStep;
    toolResults: ToolResult[];
    feedback: string[];
    negativeConstraints: string[];
  },
): { relevance: "DIRECTLY_RELEVANT" | "INDIRECTLY_RELEVANT" | "IRRELEVANT"; reason: string } {
  if (["read_file", "view_file", "list_directory", "grep_search", "skim_file", "inspect_environment", "get_tool_output"].includes(call.name)) {
    return { relevance: "DIRECTLY_RELEVANT", reason: "cheap inspection is allowed" };
  }
  const contractText = buildProblemContractText(input);
  const recentText = buildRecentDiagnosticText(input.toolResults, input.feedback, input.negativeConstraints);
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  const pathArg = typeof args.path === "string" ? args.path : "";
  const command = call.name === "run_shell_command" ? getShellCommandArg(call) : "";
  if (call.name === "run_shell_command") {
    const verifierOnlyLiteral = findVerifierOnlyExpectedLiteralInResults(command, input.toolResults, input.prompt);
    if (verifierOnlyLiteral && shellCommandDirectlyWritesLiteral(command, verifierOnlyLiteral)) {
      return {
        relevance: "IRRELEVANT",
        reason:
          `shell command directly writes verifier-only expected literal '${verifierOnlyLiteral.slice(0, 80)}'. ` +
          "Do not copy official validation feedback into outputs or services. Derive the value from workspace inputs or from a real runtime command, then write the derived result.",
      };
    }
    return classifyShellCommandRelevance(command, contractText, recentText, input.currentStep);
  }
  if (isMutatingToolCall(call)) {
    return classifyMutationRelevance(pathArg, call, contractText, recentText, input.prompt, input.toolResults, input.currentStep);
  }
  return { relevance: "INDIRECTLY_RELEVANT", reason: "non-expensive control or runtime action" };
}



export function classifyShellCommandRelevance(
  command: string,
  contractText: string,
  recentText: string,
  currentStep?: ExecutionPlanStep,
): { relevance: "DIRECTLY_RELEVANT" | "INDIRECTLY_RELEVANT" | "IRRELEVANT"; reason: string } {
  const normalized = command.toLowerCase();
  const stepText = renderStepText(currentStep);
  const objectiveText = `${contractText}\n${stepText}`.toLowerCase();
  if (isInstallOrUpgradeCommand(normalized)) {
    if (/(install|dependency|package|setup|toolchain|missing module|module not found|command not found|cannot find package|no module named)/i.test(`${objectiveText}\n${recentText}`)) {
      return { relevance: "INDIRECTLY_RELEVANT", reason: "dependency/tool installation is tied to current diagnostics" };
    }
    return { relevance: "IRRELEVANT", reason: "dependency install/upgrade has no evidence tying it to the requested success conditions" };
  }
  if (isLintFormatCleanupCommand(normalized)) {
    if (/(lint|format|eslint|prettier|ruff|black|gofmt|clang-format|style)/i.test(`${objectiveText}\n${recentText}`)) {
      return { relevance: "INDIRECTLY_RELEVANT", reason: "lint/format command is requested or blocking" };
    }
    return { relevance: "IRRELEVANT", reason: "lint/format cleanup is a non-goal unless it directly blocks task completion" };
  }
  if (isFrameworkMigrationCommand(normalized)) {
    if (/(migrat|upgrade|framework|version|compatibility|breaking change)/i.test(`${objectiveText}\n${recentText}`)) {
      return { relevance: "INDIRECTLY_RELEVANT", reason: "migration/upgrade is requested or supported by diagnostics" };
    }
    return { relevance: "IRRELEVANT", reason: "framework/package migration is too expensive without root-cause evidence" };
  }
  if (isVerificationLikeCommand(command) || isBuildCommand(command)) {
    return { relevance: "DIRECTLY_RELEVANT", reason: "build/test/verification command provides success evidence" };
  }
  if (isGeneratedBuildCleanupCommand(command)) {
    return { relevance: "DIRECTLY_RELEVANT", reason: "task-local generated build/cache cleanup before rebuild is allowed" };
  }
  if (isRequiredSourceAcquisitionCommand(command, objectiveText)) {
    return { relevance: "DIRECTLY_RELEVANT", reason: "command refreshes or clones a source tree explicitly required by the task" };
  }
  if (/\b(?:rm\s+-rf|git\s+clean|git\s+reset|npm\s+update|pnpm\s+update|yarn\s+upgrade)\b/i.test(command)) {
    return { relevance: "IRRELEVANT", reason: "destructive or broad dependency action requires explicit task evidence" };
  }
  return { relevance: "INDIRECTLY_RELEVANT", reason: "shell action is not classified as broad cleanup or migration" };
}




export function isGeneratedBuildCleanupCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!/\brm\s+-rf\b/i.test(normalized)) return false;
  const rmTargets = extractRmTargets(normalized).map((target) => target.replace(/^['"]|['"]$/g, "").replace(/^\.\//, ""));
  if (rmTargets.length === 0) return false;
  return rmTargets.every((target) =>
    /^\/tmp\/[^;&|]*(?:build|cmake)[^;&|]*$/i.test(target) ||
    /^\/tmp\/[A-Za-z0-9._-]+$/i.test(target) && /\b(?:cmake|make|ninja|build|compile|test|verify)\b/i.test(command) ||
    /(^|\/)(build|dist|coverage|target|out|\.cache|CMakeFiles)(\/|$)/i.test(target) ||
    /(^|\/)(CMakeCache\.txt|cmake_install\.cmake|Makefile)$/i.test(target),
  );
}



export function isRequiredSourceAcquisitionCommand(command: string, objectiveText: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!/\bgit\s+clone\b/i.test(normalized)) return false;
  if (!/(?:clone|checkout|repository|repo|source|from source|git)/i.test(objectiveText)) return false;
  const cloneTarget = extractGitCloneTarget(normalized);
  const cloneUrl = extractGitCloneUrl(normalized);
  const targetTokens = uniqueStrings([
    ...pathTokensForRelevance(cloneTarget ?? ""),
    ...pathTokensForRelevance(cloneUrl ?? ""),
  ]).filter((token) => token.length >= 4);
  return targetTokens.length === 0 || targetTokens.some((token) => tokenMatchesProblemText(token, objectiveText));
}



export function extractGitCloneTarget(command: string): string | undefined {
  const match = command.match(/\bgit\s+clone\b(?:\s+--[^\s]+(?:\s+[^\s]+)?)*\s+(\S+)(?:\s+(\S+))?/i);
  return stripShellToken(match?.[2]);
}



export function extractGitCloneUrl(command: string): string | undefined {
  const match = command.match(/\bgit\s+clone\b(?:\s+--[^\s]+(?:\s+[^\s]+)?)*\s+(\S+)/i);
  return stripShellToken(match?.[1]);
}



export function stripShellToken(value: string | undefined): string | undefined {
  return value?.trim().replace(/^['"]|['"]$/g, "");
}



export function classifyMutationRelevance(
  filePath: string,
  call: ToolCall,
  contractText: string,
  recentText: string,
  promptText: string,
  toolResults: ToolResult[],
  currentStep?: ExecutionPlanStep,
): { relevance: "DIRECTLY_RELEVANT" | "INDIRECTLY_RELEVANT" | "IRRELEVANT"; reason: string } {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedPathLower = normalizedPath.toLowerCase();
  const basename = path.basename(normalizedPath).toLowerCase();
  const stepText = renderStepText(currentStep);
  const combined = `${contractText}\n${stepText}\n${recentText}`.toLowerCase();
  const mutationText = getMutationLiteralText(call);
  const verifierOnlyLiteral = findVerifierOnlyExpectedLiteralInResults(mutationText, toolResults, promptText);
  if (verifierOnlyLiteral && (isSourceLikePath(normalizedPath) || isLikelyFinalOutputPath(normalizedPath))) {
    return {
      relevance: "IRRELEVANT",
      reason:
        `mutation embeds verifier-only expected literal '${verifierOnlyLiteral.slice(0, 80)}'. ` +
        "Do not hardcode validation oracle strings into source, services, or final artifacts. Derive the output from task inputs or a real runtime command first.",
    };
  }
  if (isLintOrFormattingConfigPath(normalizedPath) && !/(lint|format|eslint|prettier|ruff|black|style)/i.test(combined)) {
    return { relevance: "IRRELEVANT", reason: `editing lint/format config '${normalizedPath}' is outside the problem contract` };
  }
  if (isDependencyManifestPath(normalizedPath) && !/(dependency|package|install|missing module|module not found|command not found|cannot find package|toolchain)/i.test(combined)) {
    return { relevance: "IRRELEVANT", reason: `editing dependency manifest '${normalizedPath}' has no dependency-related evidence` };
  }
  if (basename && combined.includes(basename)) {
    return { relevance: "DIRECTLY_RELEVANT", reason: `target file '${normalizedPath}' appears in task/step/diagnostics` };
  }
  if (normalizedPathLower && (combined.includes(normalizedPathLower) || combined.includes(normalizedPathLower.replace(/\//g, path.sep)))) {
    return { relevance: "DIRECTLY_RELEVANT", reason: `target path '${normalizedPath}' appears in recent tool evidence` };
  }
  if (call.name === "write_file" && isTemporaryValidationSourcePath(normalizedPath) && /(build|compile|test|verify|check|g\+\+|gcc|clang|pytest|node --test|go test|cargo test)/i.test(combined)) {
    return { relevance: "DIRECTLY_RELEVANT", reason: `temporary validation source '${normalizedPath}' is tied to current build/test/check evidence` };
  }
  if (isTaskFacingDeliverableMutation(normalizedPath, call, combined)) {
    return { relevance: "DIRECTLY_RELEVANT", reason: `target '${normalizedPath}' is a task-facing deliverable for the current objective/step` };
  }
  if (currentStep && textSimilarity(normalizePlanStepText(normalizedPath), normalizePlanStepText(`${currentStep.title} ${currentStep.instructions}`)) >= 0.18) {
    return { relevance: "INDIRECTLY_RELEVANT", reason: `target file '${normalizedPath}' is plausibly related to current step` };
  }
  if (call.name === "write_file" && !recentText.includes(basename) && isSourceLikePath(normalizedPath) && !/(implement|create|generate|write|convert|adapter|wrapper|shim|tool|script)/i.test(stepText)) {
    return { relevance: "IRRELEVANT", reason: `new/source edit '${normalizedPath}' lacks locality evidence for the current step` };
  }
  return { relevance: "INDIRECTLY_RELEVANT", reason: "mutation is not broad cleanup and is not clearly unrelated" };
}



export function getMutationLiteralText(call: ToolCall): string {
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  const chunks: string[] = [];
  for (const key of ["content", "newString", "newCode", "oldString"] as const) {
    const value = args[key];
    if (typeof value === "string") chunks.push(value);
  }
  const edits = args.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === "object") {
        const record = edit as Record<string, unknown>;
        if (typeof record.newString === "string") chunks.push(record.newString);
        if (typeof record.oldString === "string") chunks.push(record.oldString);
      }
    }
  }
  return chunks.join("\n");
}



export function findVerifierOnlyExpectedLiteralInResults(mutationText: string, toolResults: ToolResult[], promptText: string): string | undefined {
  if (!mutationText.trim()) return undefined;
  const literals = extractExpectedOracleLiteralsFromResults(toolResults)
    .map((literal) => literal.replace(/\\n/g, "\n").trim())
    .filter((literal) => literal.length >= 8 && !promptText.includes(literal));
  return literals.find((literal) => mutationText.includes(literal) && !hasTrustedLiteralEvidenceBefore(toolResults, literal));
}



export function extractExpectedOracleLiteralsFromResults(toolResults: ToolResult[]): string[] {
  const literals: string[] = [];
  for (const result of toolResults) {
    if (result.ok) continue;
    const text = `${result.error?.message ?? ""}\n${renderUnknownValue(result.output)}`;
    if (!isVerifierOrTestFailureText(result, text)) continue;
    literals.push(...extractExpectedOracleLiterals(text));
  }
  return uniqueStrings(literals);
}



export function isVerifierOrTestFailureText(result: ToolResult, text: string): boolean {
  if (result.name === "run_shell_command") {
    const command = getToolResultCommand(result);
    return isTestCommand(command) || isVerificationLikeCommand(command) || /(?:expected|expecting|assert|diff|mismatch|got|actual)/i.test(text);
  }
  return /(?:expected|expecting|assert|diff|mismatch|got|actual)/i.test(text);
}



export function hasTrustedLiteralEvidenceBefore(toolResults: ToolResult[], literal: string): boolean {
  const normalizedLiteral = normalizeLiteralEvidence(literal);
  if (!normalizedLiteral) return false;
  const firstOracleIndex = toolResults.findIndex((result) => {
    if (result.ok) return false;
    return extractExpectedOracleLiterals(`${result.error?.message ?? ""}\n${renderUnknownValue(result.output)}`)
      .map(normalizeLiteralEvidence)
      .includes(normalizedLiteral);
  });
  const candidateResults = firstOracleIndex >= 0 ? toolResults.slice(0, firstOracleIndex) : toolResults;
  return candidateResults.some((result) => {
    if (!result.ok) return false;
    if (result.name === "run_shell_command") {
      const command = getToolResultCommand(result);
      if (isVerificationLikeCommand(command) || isTestCommand(command)) return false;
    }
    return normalizeLiteralEvidence(getToolResultVisibleOutput(result)).includes(normalizedLiteral);
  });
}



export function getToolResultVisibleOutput(result: ToolResult): string {
  const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
  const chunks: string[] = [];
  if (typeof output.content === "string") chunks.push(output.content);
  if (typeof output.stdout === "string") chunks.push(output.stdout);
  if (typeof output.stderr === "string") chunks.push(output.stderr);
  if (typeof result.output === "string") chunks.push(result.output);
  return chunks.join("\n");
}



export function renderUnknownValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}



export function normalizeLiteralEvidence(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}



export function extractExpectedOracleLiterals(text: string): string[] {
  const literals: string[] = [];
  const patterns = [
    /\bexpected\s*=\s*"([^"\n]{4,240}(?:\\n)?)"/gi,
    /\bexpected\s*=\s*'([^'\n]{4,240}(?:\\n)?)'/gi,
    /\bexpected(?:\s+output)?\s*:?\s*"([^"\n]{4,240}(?:\\n)?)"/gi,
    /\bexpected(?:\s+output)?\s*:?\s*'([^'\n]{4,240}(?:\\n)?)'/gi,
    /\bExpected\s+'([^'\n]{4,240})'\s+but got/gi,
    /\bExpected\s+"([^"\n]{4,240})"\s+but got/gi,
    /\bexpect(?:ed|ing)\s+exactly\s+'([^'\n]{4,240})'/gi,
    /\bexpect(?:ed|ing)\s+exactly\s+"([^"\n]{4,240})"/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const literal = match[1]?.trim();
      if (literal) literals.push(literal);
    }
  }
  return uniqueStrings(literals);
}



export function isLikelyFinalOutputPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return /(?:^|\/)(?:results?|answers?|output|final|solution|message|report)[\w.-]*\.(?:txt|json|csv|tsv|md|html)$/.test(normalized);
}



export function isTaskFacingDeliverableMutation(filePath: string, call: ToolCall, combinedText: string): boolean {
  if (!["write_file", "replace_in_file", "edit_file", "replace_symbol"].includes(call.name)) return false;
  const normalized = stripWorkspacePrefix(normalizeArtifactPathForMatch(filePath));
  if (!normalized || isGeneratedOrBuildPath(normalized)) return false;
  if (isLintOrFormattingConfigPath(normalized) || isDependencyManifestPath(normalized)) return false;
  const lowerText = combinedText.toLowerCase();
  const deliverableIntent =
    /\b(?:create|write|generate|produce|emit|output|deliverable|artifact|implement|build|repair|fix|convert|export|parse|adapter|wrapper|shim|tool|script|binary|executable|schema|report|migration)\b/i.test(
      lowerText,
    );
  if (!deliverableIntent) return false;
  if (!isDeliverableFilePath(normalized)) return false;
  const tokens = pathTokensForRelevance(normalized);
  if (tokens.some((token) => tokenMatchesProblemText(token, lowerText))) return true;
  const base = path.basename(normalized).toLowerCase();
  const rootLevel = !normalized.includes("/");
  return rootLevel && isSourceLikePath(base) && /\b(?:create|write|generate|implement|build|repair|fix)\b/i.test(lowerText);
}



export function isDeliverableFilePath(filePath: string): boolean {
  return (
    isSourceLikePath(filePath) ||
    isProjectConfigPath(filePath) ||
    /\.(?:json|ya?ml|toml|ini|cfg|conf|txt|md|csv|tsv|html|css|xml|svg)$/i.test(filePath)
  );
}



export function pathTokensForRelevance(filePath: string): string[] {
  const generic = new Set([
    "app",
    "src",
    "lib",
    "libs",
    "test",
    "tests",
    "spec",
    "specs",
    "file",
    "files",
    "main",
    "index",
    "build",
    "dist",
    "out",
    "output",
    "outputs",
  ]);
  return uniqueStrings(
    filePath
      .toLowerCase()
      .split(/[\/._\-\s]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !generic.has(token)),
  );
}



export function tokenMatchesProblemText(token: string, lowerText: string): boolean {
  if (lowerText.includes(token)) return true;
  const stems = new Set<string>();
  if (token.endsWith("er") && token.length > 5) stems.add(token.slice(0, -2));
  if (token.endsWith("or") && token.length > 5) stems.add(token.slice(0, -2));
  if (token.endsWith("ed") && token.length > 5) stems.add(token.slice(0, -2));
  if (token.endsWith("ing") && token.length > 6) stems.add(token.slice(0, -3));
  if (token.endsWith("s") && token.length > 4) stems.add(token.slice(0, -1));
  return [...stems].some((stem) => stem.length >= 4 && lowerText.includes(stem));
}



export function isTemporaryValidationSourcePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.basename(normalized).toLowerCase();
  if (!isSourceLikePath(normalized)) return false;
  return normalized.startsWith("/tmp/") || /(?:^|\/)(?:test|check|verify|compile)[-_a-z0-9]*\.(?:c|cc|cpp|cxx|h|hpp|py|js|ts|go|rs|java)$/i.test(normalized) || /(?:^|\/)tmp[-_a-z0-9]*\.(?:c|cc|cpp|cxx|py|js|ts)$/i.test(normalized) || /^(?:test|check|verify|compile)/i.test(base);
}



export function renderStepText(step?: ExecutionPlanStep): string {
  if (!step) return "";
  return [
    step.id,
    step.title,
    step.instructions,
    step.suggestedImplementation ?? "",
    step.testGuidance ?? "",
    ...(step.successCriteria ?? []),
  ].join("\n");
}



export function isInstallOrUpgradeCommand(normalizedCommand: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|update|upgrade)\b|\b(?:pip|pip3)\s+install\b|\bpoetry\s+(?:add|install|update)\b|\bcargo\s+(?:add|install|update)\b|\bgo\s+get\b|\b(?:conda|mamba)\s+(?:install|update|upgrade|env\s+(?:create|update))\b|\bapt(?:-get)?\s+(?:install|upgrade|dist-upgrade)\b|\bbrew\s+(?:install|upgrade)\b/.test(normalizedCommand);
}



export function isLintFormatCleanupCommand(normalizedCommand: string): boolean {
  return /\b(?:eslint|prettier|ruff|black|isort|gofmt|rustfmt|clang-format|stylelint)\b/.test(normalizedCommand);
}



export function isFrameworkMigrationCommand(normalizedCommand: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:update|upgrade)\b|\b(?:ng|rails|django-admin|next|vite)\s+(?:update|upgrade|migrate)\b|\b(?:alembic|prisma)\s+migrate\b/.test(normalizedCommand);
}



export function isLintOrFormattingConfigPath(filePath: string): boolean {
  return /(?:^|\/)(?:\.eslintrc|eslint\.config|\.prettierrc|prettier\.config|\.ruff\.toml|ruff\.toml|pyproject\.toml|\.editorconfig|\.stylelintrc|\.clang-format)(?:\.|$)/i.test(filePath);
}



export function isDependencyManifestPath(filePath: string): boolean {
  return /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements(?:-[^/]*)?\.txt|pyproject\.toml|poetry\.lock|Pipfile|Pipfile\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile|Gemfile\.lock|composer\.json|composer\.lock|environment\.ya?ml|conda(?:-[^/]*)?\.ya?ml)$/i.test(filePath);
}



export function isSourceLikePath(filePath: string): boolean {
  return /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|rs|go|java|kt|kts|swift|py|rb|php|js|jsx|ts|tsx|mjs|cjs|vue|svelte|scala|cs|sh|bash|zsh|fish|sql)$/i.test(
    filePath,
  );
}



export function extractRmTargets(command: string): string[] {
  const targets: string[] = [];
  for (const match of command.matchAll(/\brm\s+(?:-[A-Za-z]+\s+)*([^;&|]+)/g)) {
    const chunk = match[1] ?? "";
    targets.push(...chunk.split(/\s+/).filter(Boolean));
  }
  return targets;
}



export function getToolResultCommand(result: ToolResult): string {
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  return typeof args.cmd === "string" ? args.cmd : "";
}



export function isBuildCommand(command: string): boolean {
  return /\b(?:cmake\s+--build|make(?:\s|$)|ninja(?:\s|$)|g\+\+|gcc|clang\+\+|clang|cargo\s+build|go\s+build|npm\s+(?:run\s+)?build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build|bun\s+(?:run\s+)?build)\b/i.test(command);
}



export function isTestCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:jest|vitest|mocha|ava|tap|pytest|node\s+--test)\b/i.test(command);
}



export function normalizePlanStepText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|and|or|to|for|with|using|use|run|create|update|fix)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}



export function textSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

export async function persistExecutionPlanProgress(
  workspaceRoot: string,
  runId: string,
  progress: { currentStepIndex: number; completedStepIds: string[]; failed: boolean },
): Promise<void> {
  const runDir = path.join(getReaperScratchpadPaths(workspaceRoot).runs, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "progress.json"),
    JSON.stringify({ runId, ...progress, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}



export function normalizeVerificationCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}



export function isVerificationLikeCommand(command: string): boolean {
  const semantic = classifyShellCommandSemantics(command);
  if (semantic.kind === "weak_check" || semantic.kind === "inspect" || semantic.kind === "producer") return false;
  if (semantic.kind === "strict_verifier") return true;
  const normalized = normalizeVerificationCommand(command);
  if (
    /\b(npm\s+(run\s+)?(test|build|lint|check)|pnpm\s+(run\s+)?(test|build|lint|check)|yarn\s+(run\s+)?(test|build|lint|check)|bun\s+(run\s+)?(test|build|lint|check)|node\s+--test|pytest|ruff|mypy|go\s+test|go\s+vet|cargo\s+(test|check|clippy)|mvn\s+test|gradle\s+test|jest|vitest|mocha|playwright|cypress|tap|tsc|eslint|smoke)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/\bpython3?\s+-c\b/i.test(normalized)) {
    return hasInlineAssertionOrFailureExit(normalized);
  }
  if (/\b(?:curl|wget)\b/i.test(normalized)) {
    return /\b(?:grep\s+-q|jq\s+-e|python3?\s+-c|test\s+|\[\s+|diff|cmp|assert)\b/i.test(normalized);
  }
  return false;
}



export function hasInlineAssertionOrFailureExit(command: string): boolean {
  return /\b(?:assert|raise\s+SystemExit|sys\.exit\s*\(\s*[1-9]|exit\s*\(\s*[1-9]|throw\s+new\s+Error|process\.exit\s*\(\s*[1-9])/i.test(command);
}



export function buildRecentDiagnosticText(toolResults: ToolResult[], feedback: string[], negativeConstraints: string[]): string {
  return [
    ...toolResults.slice(-18).map((result) => renderToolResultForModel(result)),
    ...feedback.slice(-6),
    ...negativeConstraints.slice(-6),
  ]
    .join("\n")
    .slice(0, 16000);
}



export function buildProblemContractText(input: {
  prompt: string;
  currentStep?: ExecutionPlanStep;
  feedback: string[];
  negativeConstraints: string[];
}): string {
  return [
    "PRIMARY OBJECTIVE:",
    input.prompt.slice(0, 1200),
    "CURRENT STEP:",
    renderStepText(input.currentStep),
    "NON-GOALS:",
    "lint cleanup, formatting churn, dependency upgrades, framework migrations, unrelated legacy failures, warnings, and broad refactors unless directly required by success conditions.",
    input.feedback.slice(-4).join("\n"),
    input.negativeConstraints.slice(-4).join("\n"),
  ].join("\n");
}



export function shellCommandDirectlyWritesLiteral(command: string, literal: string): boolean {
  if (!command.includes(literal) && !command.includes(literal.replace(/\n/g, "\\n"))) return false;
  if (!/\b(?:printf|echo|cat|tee|python3?|node|ruby|perl|awk)\b/i.test(command)) return false;
  return /(?:>|>>|\btee\s+-?a?\s+|open\s*\(|writeFileSync\s*\(|writeFile\s*\()[^;&|]*(?:result|results|answer|output|final|solution|flag|message|server|service|src|app|lib|main|index|\.py|\.js|\.ts|\.go|\.rs|\.java|\.c|\.cpp|\.txt|\.json)/i.test(
    command,
  );
}



export function describeToolResultTarget(result: ToolResult): string {
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  if (typeof args.path === "string") return args.path;
  if (typeof args.cmd === "string") return args.cmd.slice(0, 160);
  return "";
}


