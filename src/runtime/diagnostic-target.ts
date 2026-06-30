import path from "node:path";

import {
  extractFilePathsFromFailure,
  isGeneratedOrBuildPath,
  normalizeArtifactPathForMatch,
  stripWorkspacePrefix,
  uniqueStrings,
} from "./file-hints.js";
import {
  getToolResultCommand, 
  isBuildCommand, 
  isDependencyManifestPath, 
  isInstallOrUpgradeCommand, 
  isTestCommand, 
  isVerificationLikeCommand, 
  isSourceLikePath, 
  isProjectConfigPath} from "./relevance-gate.js";
import {
  escapeRegExp,
  hasShellWriteToLikelyPath,
  isBroadSourceWriteTarget,
  splitUnquotedShellSegments,
  stripQuotedShellText,
} from "./shell-parser.js";
import {
  isCompileOrBuildError, 
  isExternalRuntimeLibraryPath, 
  isRuntimeOrVerificationFailure, 
  isSemanticFailedCheckResult, 
  isToolchainOrDependencyDiagnosticPath} from "./engine.js";
import {
  getShellCommandArg,
  isMutatingToolCall,
} from "./tool-call-utils.js";
import type { ToolCall, ToolResult } from "../tools/types.js";

export function shouldAllowSetupDespiteDiagnosticTarget(command: string, toolResults: ToolResult[]): boolean {
  const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
  if (!isInstallOrUpgradeCommand(normalized)) return false;
  const recentFailureText = toolResults
    .slice(-12)
    .filter((result) => !result.ok)
    .map((result) => `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`)
    .join("\n");
  return /(?:modulenotfounderror|importerror|cannot import|no module named|command not found|not found|missing|requires .*package|cython|setuptools|wheel|pkg-config|compiler|headers?)/i.test(
    recentFailureText,
  );
}

export function shouldAllowRuntimeInspectionDespiteDiagnosticTarget(command: string, toolResults: ToolResult[]): boolean {
  if (!isReadOnlyRuntimeInspectionCommand(command)) return false;
  const recentFailureText = toolResults
    .slice(-14)
    .filter((result) => !result.ok)
    .map((result) => `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`)
    .join("\n");
  return /(?:environmentlocationnotfound|not a conda environment|conda environment|virtualenv|venv|modulenotfounderror|importerror|cannot import|no module named|command not found|not found|missing|no such file|shared object|dynamic librar|library not loaded|connection refused|failed to connect|remote end closed|fetch failed|service unavailable|name or service not known|temporary failure in name resolution|dns)/i.test(
    recentFailureText,
  );
}

export function isReadOnlyRuntimeInspectionCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (hasShellWriteToLikelyPath(command, isBroadSourceWriteTarget)) return false;
  if (
    /(?:^|[;&|]\s*)(?:rm|rmdir|mv|cp|install|touch|mkdir|chmod|chown|truncate|ln)\b/i.test(normalized) ||
    /\b(?:pip|pip3|python3?\s+-m\s+pip|npm|pnpm|yarn|bun|cargo|go|apt(?:-get)?|apk|yum|dnf|brew)\s+(?:install|i|add|update|upgrade|remove|uninstall)\b/i.test(
      normalized,
    ) ||
    /\b(?:conda|mamba|micromamba)\s+(?:env\s+)?(?:create|remove|update|install|uninstall|clean)\b/i.test(normalized) ||
    /\bsed\b[^;&|]*\s-i\b/i.test(normalized) ||
    /\btee\b/i.test(normalized)
  ) {
    return false;
  }
  return splitUnquotedShellSegments(command).every((segment) => isReadOnlyRuntimeInspectionSegment(segment));
}

export function isReadOnlyRuntimeInspectionSegment(segment: string): boolean {
  const normalized = stripQuotedShellText(segment).replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  if (/\b(?:curl|wget)\b/i.test(normalized) && /\b(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE)|--data|--data-raw|--data-binary|-d)\b/i.test(normalized)) {
    return false;
  }
  if (
    /\bpython3?\s+-c\b/i.test(normalized) &&
    /\b(?:write_text|write_bytes|unlink|remove|rmtree|rename|replace|subprocess|os\.system|open\s*\([^)]*[,]\s*["']?[wa+])/i.test(segment)
  ) {
    return false;
  }
  return (
    /^(?:cd\s+[^;&|]+\s+)?$/i.test(normalized) ||
    /^echo\b/i.test(normalized) ||
    /^(?:cat|sed\s+-n|head|tail|grep|rg|find|wc)\b/i.test(normalized) ||
    /^(?:ls|test|stat|file|pwd|whoami|id|uname|which|type|command\s+-v)\b/i.test(normalized) ||
    /^(?:env|printenv)\b/i.test(normalized) ||
    /^(?:ps|pgrep|ss|netstat|lsof)\b/i.test(normalized) ||
    /^(?:curl|wget|nc|python3?\s+-c)\b/i.test(normalized) ||
    /^(?:conda|mamba|micromamba)\s+(?:info|list|env\s+list|config\s+--show|run\s+(?:-[A-Za-z0-9-]+\s+\S+\s+)*python(?:3)?\s+(?:-V|--version))\b/i.test(
      normalized,
    )
  );
}

export function shouldAllowDependencyManifestRepairDespiteDiagnosticTarget(call: ToolCall, toolResults: ToolResult[]): boolean {
  if (!isDependencyManifestMutation(call)) return false;
  const recentFailureText = toolResults
    .slice(-16)
    .filter((result) => !result.ok)
    .map((result) => `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`)
    .join("\n");
  return /(?:modulenotfounderror|importerror|cannot import|no module named|package|dependency|version|requires|requirement|resolution|resolve|unsatisfiable|conflict|incompatible|conda|mamba|pip|poetry|lockfile|environment\.ya?ml)/i.test(
    recentFailureText,
  );
}

export function isDependencyManifestMutation(call: ToolCall): boolean {
  if (!["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(call.name)) return false;
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  return typeof args.path === "string" && isDependencyManifestPath(args.path);
}

export function isDiagnosticClearingCheck(call: ToolCall): boolean {
  if (call.name !== "bash") return false;
  const command = getShellCommandArg(call);
  return isBuildCommand(command) || isTestCommand(command) || isVerificationLikeCommand(command);
}

export function getUnresolvedDiagnosticTarget(toolResults: ToolResult[]): { path: string; basename: string; relatedPaths: string[]; commandOrSource: string } | undefined {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const result = toolResults[index]!;
    if (result.ok || result.name !== "bash") continue;
    if (isInternalGuardBlockedResult(result)) continue;
    const command = getToolResultCommand(result);
    const message = result.error?.message ?? "";
    if (isMissingShellFileOperationSource(command, message)) continue;
    const text = `${command}\n${message}`;
    if (!isBuildCommand(command) && !isTestCommand(command) && !isVerificationLikeCommand(command) && !isCompileOrBuildError(text) && !isRuntimeOrVerificationFailure(result)) {
      continue;
    }
    if (isArchiveExtractionFailure(command, message)) continue;
    if (hasLaterSuccessfulSameClassCheck(command, result, toolResults.slice(index + 1))) continue;
    const candidates = extractFilePathsFromFailure(result)
      .map((item) => stripWorkspacePrefix(normalizeArtifactPathForMatch(item)))
      .filter((item) => item && !isGeneratedOrBuildPath(item) && isActionableDiagnosticPath(item));
    for (const candidate of candidates) {
      if (hasDiagnosticTargetBeenAddressedSince(candidate, command, toolResults.slice(index + 1))) continue;
      // For test failures, the implementation under test is also a
      // legitimate fix target. Expand the related paths so the model is
      // not forced to edit the test file just because the test runner
      // output mentions it.
      const related = uniqueStrings([
        candidate,
        ...expandDiagnosticTargetRelatedPaths(candidate, result),
        ...candidates,
      ]);
      return {
        path: candidate,
        basename: path.basename(candidate),
        relatedPaths: related,
        commandOrSource: command || result.name,
      };
    }
  }
  return undefined;
}

export function isInternalGuardBlockedResult(result: ToolResult): boolean {
  const code = result.error?.code ?? "";
  return /(?:_blocked$|policy_block|path_escape|same_batch_|relevance_gate|diagnostic_target_gate|no_progress_loop|repeated_failed_action|repeated_low_information|unsafe_|stale_write|verifier_owned|source_shell_write|synthetic_result)/i.test(
    code,
  );
}

export function hasLaterSuccessfulSameClassCheck(failingCommand: string, failingResult: ToolResult, laterResults: ToolResult[]): boolean {
  return laterResults.some((result) => {
    if (!result.ok || result.name !== "bash") return false;
    if (isSemanticFailedCheckResult(result)) return false;
    const command = getToolResultCommand(result);
    if (isBuildCommand(failingCommand) || isCompileOrBuildError(failingResult.error?.message ?? "")) {
      return isBuildCommand(command);
    }
    if (isTestCommand(failingCommand)) return isTestCommand(command);
    if (isVerificationLikeCommand(failingCommand) || isRuntimeOrVerificationFailure(failingResult)) {
      return isVerificationLikeCommand(command) || isTestCommand(command);
    }
    return false;
  });
}

export function isMissingShellFileOperationSource(command: string, message: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return (
    /(?:^|[;&|]\s*)(?:mv|cp|rm)\b/i.test(normalized) &&
    /(?:cannot stat|no such file or directory|cannot remove).*?(?:source|file|directory)?/i.test(message)
  );
}

export function isArchiveExtractionFailure(command: string, message: string): boolean {
  const text = `${command}\n${message}`;
  const archiveOperation =
    /\b(?:7z|unzip|zip|tar|gzip|gunzip|xz|python3?\s+-m\s+zipfile)\b/i.test(command) ||
    /\b(?:ZipFile|extractall|extract\(|pyzipper|libarchive|patoolib)\b/i.test(command);
  if (!archiveOperation) return false;
  return /(?:wrong password|bad password|incorrect password|password.*(?:wrong|incorrect|failed)|data error|encrypted|unsupported compression|cannot open file as archive|end-of-central-directory signature|not a zip file|crc failed|headers error)/i.test(
    text,
  );
}

export function hasDiagnosticTargetBeenAddressedSince(targetPath: string, failingCommand: string, laterResults: ToolResult[]): boolean {
  const target = normalizeArtifactPathForMatch(stripWorkspacePrefix(targetPath));
  const basename = path.basename(target);
  const normalizedFailingCommand = normalizeDiagnosticCommand(failingCommand);
  const failingCwd = extractLeadingCdDirectory(failingCommand);
  for (const result of laterResults) {
    if (result.name === "write_file" || result.name === "replace_in_file" || result.name === "edit_file" || result.name === "replace_symbol" || result.name === "delete_file") {
      const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
      const changedPath = typeof args.path === "string" ? normalizeArtifactPathForMatch(stripWorkspacePrefix(args.path)) : "";
      if (result.ok && changedPath && (changedPath === target || path.basename(changedPath) === basename)) return true;
    }
    if (result.ok && result.name === "bash") {
      const command = getToolResultCommand(result);
      if (command.includes(target) || command.includes(basename)) return true;
      const normalizedCommand = normalizeDiagnosticCommand(command);
      if (normalizedFailingCommand && normalizedCommand === normalizedFailingCommand) return true;
      if (isBuildCommand(command) && isBuildCommand(failingCommand)) return true;
      const commandCwd = extractLeadingCdDirectory(command);
      if (
        isBuildOrVerificationSuccessThatClearsFailure(command, failingCommand) &&
        failingCwd &&
        commandCwd &&
        normalizeArtifactPathForMatch(stripWorkspacePrefix(commandCwd)) === normalizeArtifactPathForMatch(stripWorkspacePrefix(failingCwd))
      ) {
        return true;
      }
    }
  }
  return false;
}

export function normalizeDiagnosticCommand(command: string): string {
  return command
    .replace(/\s+2>&1\b/g, "")
    .replace(/\s+>/g, " >")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractLeadingCdDirectory(command: string): string {
  const match = command.match(/^\s*cd\s+(['"]?)([^'";&|]+)\1\s*&&/);
  return match?.[2]?.trim() ?? "";
}

/**
 * For test-file diagnostic targets, derive the implementation files the
 * test imports. The model must be allowed to fix the implementation, not
 * just the cited test file, otherwise a failing test about a buggy
 * implementation becomes unsolvable.
 */
export function expandDiagnosticTargetRelatedPaths(targetPath: string, result: ToolResult): string[] {
  if (!isTestFilePath(targetPath)) return [];
  const message = result.error?.message ?? "";
  const candidates = new Set<string>();
  // Common convention: foo.test.js imports foo.js
  const basename = path.basename(targetPath);
  const baseNoTest = basename.replace(/\.test\.[A-Za-z0-9_]+$/i, "").replace(/\.spec\.[A-Za-z0-9_]+$/i, "");
  if (baseNoTest && baseNoTest !== basename) {
    const dir = path.dirname(targetPath);
    for (const ext of [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java"]) {
      candidates.add(normalizeArtifactPathForMatch(stripWorkspacePrefix(path.join(dir, baseNoTest + ext))));
      candidates.add(normalizeArtifactPathForMatch(stripWorkspacePrefix(path.join(dir, "src", baseNoTest + ext))));
    }
  }
  // Capture import / from paths mentioned in the failure message
  for (const match of message.matchAll(/(?:from|require|import)\s+['"]([^'"]+)['"]/g)) {
    if (match[1]) candidates.add(normalizeArtifactPathForMatch(stripWorkspacePrefix(match[1])));
  }
  return [...candidates].filter(Boolean);
}

export function isTestFilePath(filePath: string): boolean {
  const base = path.basename(filePath);
  if (/\.(test|spec)\.[A-Za-z0-9_]+$/i.test(base)) return true;
  // Python: test_*.py or *_test.py
  if (/^test_.*\.py$/i.test(base) || /.*_test\.py$/i.test(base)) return true;
  // Go: *_test.go
  if (/_test\.go$/i.test(base)) return true;
  return false;
}

export function isBuildOrVerificationSuccessThatClearsFailure(successCommand: string, failingCommand: string): boolean {
  return (
    (isBuildCommand(successCommand) && isBuildCommand(failingCommand)) ||
    (isTestCommand(successCommand) && isTestCommand(failingCommand)) ||
    (isVerificationLikeCommand(successCommand) && isVerificationLikeCommand(failingCommand))
  );
}

export function toolCallTouchesDiagnosticTarget(call: ToolCall, target: { path: string; basename: string; relatedPaths?: string[] }): boolean {
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  const pathArg = typeof args.path === "string" ? normalizeArtifactPathForMatch(stripWorkspacePrefix(args.path)) : "";
  const relatedPaths = target.relatedPaths?.length ? target.relatedPaths : [target.path];
  if (
    pathArg &&
    relatedPaths.some((relatedPath) => {
      const normalizedRelated = normalizeArtifactPathForMatch(stripWorkspacePrefix(relatedPath));
      return pathArg === normalizedRelated || path.basename(pathArg) === path.basename(normalizedRelated);
    })
  ) {
    return true;
  }
  if (call.name === "bash") {
    const command = getShellCommandArg(call);
    return relatedPaths.some((relatedPath) => {
      const normalizedRelated = normalizeArtifactPathForMatch(stripWorkspacePrefix(relatedPath));
      return command.includes(normalizedRelated) || command.includes(path.basename(normalizedRelated));
    });
  }
  return false;
}

export function toolCallPreparesDiagnosticTargetParent(call: ToolCall, target: { path: string; relatedPaths?: string[] }): boolean {
  if (call.name !== "bash") return false;
  const command = getShellCommandArg(call);
  const relatedPaths = target.relatedPaths?.length ? target.relatedPaths : [target.path];
  return relatedPaths.some((relatedPath) => {
    const normalizedRelated = normalizeArtifactPathForMatch(stripWorkspacePrefix(relatedPath));
    const parent = path.posix.dirname(normalizedRelated);
    if (!parent || parent === "." || parent === "/") return false;
    return shellCommandCreatesOrChecksDirectory(command, parent);
  });
}

export function shellCommandCreatesOrChecksDirectory(command: string, relativeDirectory: string): boolean {
  const normalizedDirectory = normalizeArtifactPathForMatch(stripWorkspacePrefix(relativeDirectory)).replace(/\/+$/, "");
  if (!normalizedDirectory) return false;
  const directoryPattern = escapeRegExp(normalizedDirectory).replace(/\\\//g, String.raw`[/\\]+`);
  const withOptionalAppPrefix = String.raw`(?:(?:/app|\.|)\s*[/\\]+)?${directoryPattern}(?:[/\\]+)?`;
  const normalizedCommand = command.replace(/\\\n/g, " ");
  return new RegExp(String.raw`\bmkdir\b[^;&|]*\s(?:-[A-Za-z]*p[A-Za-z]*\s+)?["']?${withOptionalAppPrefix}["']?(?:\s|$|[;&|)])`, "i").test(normalizedCommand) ||
    new RegExp(String.raw`\binstall\b[^;&|]*\s-d\b[^;&|]*\s["']?${withOptionalAppPrefix}["']?(?:\s|$|[;&|)])`, "i").test(normalizedCommand) ||
    new RegExp(String.raw`\b(?:test\s+-d|ls\s+-la|ls\s+-l|ls|find)\s+["']?${withOptionalAppPrefix}["']?(?:\s|$|[;&|)])`, "i").test(normalizedCommand);
}

export function isCheapDiagnosticInspection(call: ToolCall): boolean {
  return ["read_file", "view_file", "grep_search", "skim_file", "list_directory", "inspect_environment", "get_tool_output"].includes(call.name);
}

export function isExpensiveOrMutatingFollowup(call: ToolCall): boolean {
  return isMutatingToolCall(call) || call.name === "bash";
}

export function isActionableDiagnosticPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/tmp/")) return false;
  if (isGeneratedOrBuildPath(normalized)) return false;
  if (isExternalRuntimeLibraryPath(normalized)) return false;
  if (isToolchainOrDependencyDiagnosticPath(normalized)) return false;
  if (/(?:^|\/)(?:Makefile|build\.make|CMakeCache\.txt|cmake_install\.cmake|rules\.ninja)$/i.test(normalized)) return false;
  if (/\.(?:o|obj|a|so|dll|dylib|exe|class|pyc|pyo|map|log|d|ninja)$/i.test(normalized)) return false;
  if (/\.(?:mdf|bin|dat|csv|tsv|png|jpe?g|gif|webp|pdf|zip|gz|tar|7z|mp[34]|wav|ogg)$/i.test(normalized)) return false;
  if (!normalized.includes("/") && !isSourceLikePath(normalized) && !isProjectConfigPath(normalized)) return false;
  return isSourceLikePath(normalized) || isProjectConfigPath(normalized) || /\.(?:json|ya?ml|toml|ini|cfg|conf|txt|md)$/i.test(normalized);
}

export function renderCompilerDiagnosticGuidance(toolResults: ToolResult[]): string {
  const latest = [...toolResults].reverse().find((result) => {
    if (result.ok || result.name !== "bash") return false;
    const text = `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`;
    return isBuildCommand(getToolResultCommand(result)) || isCompileOrBuildError(text);
  });
  if (!latest) return "# Latest Compiler Diagnostic Guidance\nnone";
  const command = getToolResultCommand(latest);
  const message = latest.error?.message ?? "";
  const diagnosticLines = extractPrimaryDiagnosticLines(message);
  const suggestionLines = extractCompilerSuggestionLines(message);
  return [
    "# Latest Compiler Diagnostic Guidance",
    `Command: ${command || "(unknown)"}`,
    diagnosticLines.length ? `Primary diagnostics:\n${diagnosticLines.map((line) => `- ${line}`).join("\n")}` : "Primary diagnostics: unavailable",
    suggestionLines.length ? `Compiler suggestions:\n${suggestionLines.map((line) => `- ${line}`).join("\n")}` : "Compiler suggestions: none",
    "Repair rules:",
    "- Fix the first real error before warnings or cleanup.",
    "- If the compiler suggests an include/import/module/header, apply that exact targeted fix before reverting unrelated code.",
    "- Do not revert to code that already produced the same error; compare against the latest diagnostic and make a materially different focused repair.",
    "- If the latest errors are brace/scope/parser errors after an edit, read a small range around the first cited line and replace the complete enclosing block with syntactically valid code, then rerun the same narrow build/check.",
  ].join("\n");
}

export function renderApiMismatchRecoveryGuidance(toolResults: ToolResult[]): string {
  const latest = [...toolResults].reverse().find((result) => {
    if (result.ok || result.name !== "bash") return false;
    return hasApiMismatchDiagnostic(`${getToolResultCommand(result)}\n${result.error?.message ?? ""}`);
  });
  if (!latest) return "# API Mismatch Recovery\nnone";
  const message = latest.error?.message ?? "";
  const missingSymbols = extractApiMismatchSymbols(message);
  const sourceFiles = extractDiagnosticSourceFiles(message);
  return [
    "# API Mismatch Recovery",
    "The latest build failed because generated or edited code called APIs, fields, operators, imports, modules, or symbols that the actual codebase does not expose.",
    missingSymbols.length ? `Missing or mismatched symbols:\n${missingSymbols.map((symbol) => `- ${symbol}`).join("\n")}` : "Missing or mismatched symbols: see primary diagnostics.",
    sourceFiles.length ? `Cited files:\n${sourceFiles.map((filePath) => `- ${filePath}`).join("\n")}` : "Cited files: unavailable",
    "Required next behavior:",
    "- Do not guess replacement APIs or keep expanding the generated source.",
    "- Inspect the actual declarations/exports/schema/types around the cited symbols first using grep_search or bounded read_file.",
    "- Patch only the adapter/call site or smallest declaration-compatible region.",
    "- Prefer a minimal compiling adapter/skeleton before adding more behavior.",
    "- Rerun the same narrow build/typecheck/runtime command that produced the diagnostic.",
    "- Treat compiler suggestions such as 'did you mean' as leads to inspect, not as proof that argument shape/order is compatible.",
    "This rule is language-agnostic: apply it to C/C++, Python, JavaScript/TypeScript, Go, Rust, Java, schemas, configs, and generated code.",
  ].join("\n");
}

export function extractPrimaryDiagnosticLines(message: string): string[] {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const diagnostics = lines.filter((line) =>
    /(?:^|[:\s])(?:fatal error|error|undefined reference|cannot find|no such file|not found|expected|does not name a type|was not declared|has no member|no member named|SyntaxError|TypeError|ReferenceError)[:\s]/i.test(line),
  );
  return uniqueStrings(diagnostics).slice(0, 8);
}

export function extractCompilerSuggestionLines(message: string): string[] {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const suggestions = lines.filter((line) =>
    /(?:did you forget|did you mean|note: .*defined in header|help:|suggestion:|try|consider)/i.test(line),
  );
  return uniqueStrings(suggestions).slice(0, 6);
}

export function hasApiMismatchDiagnostic(message: string): boolean {
  return /(?:has no member|no member named|no match for|was not declared in this scope|does not name a type|cannot convert|undefined reference|is not a function|is not callable|Property .* does not exist|TS2339|TS2304|AttributeError|NameError|ImportError|ModuleNotFoundError|cannot find symbol|method .* cannot be applied|unresolved import|unresolved name)/i.test(
    message,
  );
}

export function extractApiMismatchSymbols(message: string): string[] {
  const symbols: string[] = [];
  const patterns = [
    /(?:has no member named|has no member|no member named)\s+['"`]?([A-Za-z_][\w:$.-]*)['"`]?/gi,
    /['"`]([A-Za-z_][\w:$.-]*)['"`]\s+was not declared in this scope/gi,
    /undefined reference to\s+['"`]?([^'"`\n]+)['"`]?/gi,
    /no match for\s+['"`]?([^'"`\n]+)['"`]?/gi,
    /Property\s+['"`]?([A-Za-z_][\w:$.-]*)['"`]?\s+does not exist/gi,
    /AttributeError:\s+[^:\n]+ has no attribute\s+['"`]?([A-Za-z_][\w:$.-]*)['"`]?/gi,
    /NameError:\s+name\s+['"`]?([A-Za-z_][\w:$.-]*)['"`]?\s+is not defined/gi,
    /cannot find symbol\s+(?:symbol:\s*)?(?:method|variable|class)?\s*([A-Za-z_][\w:$.-]*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      const symbol = match[1]?.trim();
      if (symbol) symbols.push(symbol);
    }
  }
  return uniqueStrings(symbols).slice(0, 12);
}

export function extractDiagnosticSourceFiles(message: string): string[] {
  const files: string[] = [];
  const patterns = [
    /(?:^|\n)(\/?[A-Za-z0-9_./-]+\.(?:c|cc|cpp|cxx|h|hpp|hh|m|mm|java|kt|go|rs|py|rb|php|js|jsx|ts|tsx|mjs|cjs|vue|svelte|swift|scala|cs|json|ya?ml|toml)):\d+(?::\d+)?/g,
    /(?:File\s+["'])([^"'\n]+\.(?:py|js|ts|tsx|jsx|go|rs|java|rb|php|cs))["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      const filePath = match[1]?.trim();
      if (filePath) files.push(filePath);
    }
  }
  return uniqueStrings(files.map((filePath) => stripWorkspacePrefix(filePath))).slice(0, 8);
}

