import type { ToolCall, ToolResult } from "../tools/types.js";
import path from "node:path";

export interface ProgressGuardDecision {
  allowed: ToolCall[];
  blockedResults: ToolResult[];
  feedback: string[];
  negativeConstraints: string[];
  tripped: boolean;
  trips: ProgressGuardTrip[];
}

export interface ProgressGuardTrip {
  sig: string;
  count: number;
  reason: string;
  planStepId?: string;
  observationHash?: string;
}

export interface ProgressGuardConfig {
  enabled?: boolean;
  actionRepeatLimit?: number;
  observationRepeatLimit?: number;
  sameFailedActionLimit?: number;
  recoveryStrategyRepeatLimit?: number;
}

export interface StepBudgetDecision {
  tripped: boolean;
  feedback: string[];
  negativeConstraints: string[];
}

export function detectAlternatingNoProgressPattern(
  results: ToolResult[],
  patternLength = 6,
): { tripped: boolean; pattern?: [string, string]; reason?: string } {
  const minimum = Math.max(4, patternLength);
  const recent = results
    .filter((result) => !isGuardBlockedFailure(result))
    .slice(-minimum)
    .map((result) => `${makeToolResultActionSignature(result)}=>${makeToolResultObservationSignature(result)}`);
  if (recent.length < minimum) return { tripped: false };
  const [left, right] = recent;
  if (!left || !right || left === right) return { tripped: false };
  const alternating = recent.every((signature, index) => signature === (index % 2 === 0 ? left : right));
  return alternating
    ? {
        tripped: true,
        pattern: [left, right],
        reason: `Alternating no-progress action/observation loop detected across ${minimum} recent results.`,
      }
    : { tripped: false };
}

export function guardNoProgressToolCalls(
  toolCalls: ToolCall[],
  previousResults: ToolResult[],
  options: ({ currentStepId?: string; runId?: string } & ProgressGuardConfig) = {},
): ProgressGuardDecision {
  if (options.enabled === false) {
    return { allowed: toolCalls, blockedResults: [], feedback: [], negativeConstraints: [], tripped: false, trips: [] };
  }
  if (toolCalls.length === 0 || previousResults.length === 0) {
    return { allowed: toolCalls, blockedResults: [], feedback: [], negativeConstraints: [], tripped: false, trips: [] };
  }

  const maxSameAction = resolveLimit(options.actionRepeatLimit, "REAPER_PROGRESS_MAX_SAME_ACTION", 3);
  const maxSameFailedAction = resolveLimit(options.sameFailedActionLimit, "REAPER_PROGRESS_MAX_SAME_FAILED_ACTION", 3);
  const maxSameObservation = resolveLimit(options.observationRepeatLimit, "REAPER_PROGRESS_MAX_SAME_OBSERVATION", 3);
  const lastProgressIndex = findLastIndex(previousResults, isProgressResult);
  const recentSinceProgress = previousResults.slice(Math.max(0, lastProgressIndex + 1));
  const actionableRecentSinceProgress = recentSinceProgress.filter((result) => !isGuardBlockedFailure(result));
  const actionablePreviousResults = previousResults.filter((result) => !isGuardBlockedFailure(result));
  const lastObservationLoop = getTrailingObservationLoop(actionablePreviousResults, maxSameObservation);
  const repeatedFailedObservation = getRepeatedFailedObservation(actionableRecentSinceProgress, maxSameObservation);

  const allowed: ToolCall[] = [];
  const blockedResults: ToolResult[] = [];
  const feedback: string[] = [];
  const negativeConstraints: string[] = [];
  const trips: ProgressGuardTrip[] = [];
  const blockedSignatures = new Set<string>();

  const recoveryStrategyLimit = resolveLimit(options.recoveryStrategyRepeatLimit, "REAPER_PROGRESS_MAX_RECOVERY_STRATEGY", 2);
  for (const call of toolCalls) {
    const signature = makeToolCallActionSignature(call);
    const samePrior = actionableRecentSinceProgress.filter((result) => makeToolResultActionSignature(result) === signature);
    const sameFailedPrior = samePrior.filter((result) => !result.ok);
    const isSameObservationLoop =
      lastObservationLoop.count + 1 >= maxSameObservation &&
      lastObservationLoop.actionSignature === signature &&
      !isClearlyProgressCall(call);
    const isRepeatedFailedObservationLoop =
      repeatedFailedObservation.count + 1 >= maxSameObservation &&
      repeatedFailedObservation.family === toolCallFamily(call) &&
      repeatedFailedObservation.intent === toolCallIntent(call) &&
      !isClearlyProgressCall(call);
    const failedRepeat = sameFailedPrior.length + 1 >= maxSameFailedAction;
    const actionRepeat = samePrior.length + 1 >= maxSameAction && !isClearlyProgressCall(call);
    const recoveryStrategy = makeRecoveryStrategySignature(call);
    const repeatedRecoveryStrategy = recoveryStrategy
      ? actionableRecentSinceProgress.filter((result) => makeRecoveryStrategySignature(result) === recoveryStrategy).length + 1
      : 0;
    const recoveryStrategyRepeat = repeatedRecoveryStrategy >= recoveryStrategyLimit;

    if (!failedRepeat && !actionRepeat && !isSameObservationLoop && !isRepeatedFailedObservationLoop && !recoveryStrategyRepeat) {
      allowed.push(call);
      continue;
    }

    const reason = recoveryStrategyRepeat
      ? `same root-cause hypothesis and recovery-action class reached ${repeatedRecoveryStrategy} attempts without verified progress`
      : failedRepeat
      ? `unchanged failed action reached ${sameFailedPrior.length + 1} repeat(s) since the last observed progress`
      : isSameObservationLoop
        ? `same observation reached ${lastObservationLoop.count + 1} repeat(s) without progress`
        : isRepeatedFailedObservationLoop
          ? `same failed observation reached ${repeatedFailedObservation.count + 1} repeat(s) across ${repeatedFailedObservation.family} actions without a state-changing repair`
        : `same action reached ${samePrior.length + 1} repeat(s) since the last observed progress`;
    const message =
      `Progress guard blocked '${call.name}' because ${reason}. ` +
      "Do not retry the same action unchanged. Change a file/config/env first, inspect a different target, run a narrower diagnostic, or replan the current approach.";
    blockedResults.push(makeBlockedResult(call, "no_progress_loop_blocked", message));
    trips.push({
      sig: signature,
      count: failedRepeat
        ? sameFailedPrior.length + 1
        : isSameObservationLoop
          ? lastObservationLoop.count + 1
          : isRepeatedFailedObservationLoop
            ? repeatedFailedObservation.count + 1
            : recoveryStrategyRepeat
              ? repeatedRecoveryStrategy
              : samePrior.length + 1,
      reason,
      ...(options.currentStepId ? { planStepId: options.currentStepId } : {}),
      ...(isSameObservationLoop && lastObservationLoop.observationSignature ? { observationHash: lastObservationLoop.observationSignature } : {}),
      ...(isRepeatedFailedObservationLoop && repeatedFailedObservation.observationSignature ? { observationHash: repeatedFailedObservation.observationSignature } : {}),
    });
    if (!blockedSignatures.has(signature)) {
      blockedSignatures.add(signature);
      feedback.push(
        [
          `Progress guard blocked a no-progress loop${options.currentStepId ? ` in step '${options.currentStepId}'` : ""}: ${reason}.`,
          "Next action must be materially different: patch a cited file/config, inspect a new high-signal target, run a narrower check, or replan from the failure evidence.",
          recoveryStrategyRepeat
            ? "Change diagnostic layer or root-cause hypothesis; for container failures compare mounted state with the underlying image before another recovery action."
            : "",
        ].join(" "),
      );
      negativeConstraints.push(`Do not repeat unchanged action '${signature}' until new state-changing evidence exists.`);
    }
  }

  return {
    allowed,
    blockedResults,
    feedback,
    negativeConstraints,
    tripped: blockedResults.length > 0,
    trips,
  };
}

export function evaluateStepBudget(input: {
  currentStepToolResultCount: number;
  totalToolResultCount: number;
  results: ToolResult[];
  currentStep?: { id?: string; title?: string; type?: string };
}): StepBudgetDecision {
  const budget = readPositiveIntEnv("REAPER_STEP_TOOL_BUDGET", 40);
  if (budget <= 0 || input.currentStepToolResultCount < budget) {
    return { tripped: false, feedback: [], negativeConstraints: [] };
  }

  const stepResults = input.results.slice(-input.currentStepToolResultCount);
  const recentWindow = stepResults.slice(-Math.min(24, stepResults.length));
  const recentSuccessfulVerification = recentWindow.some(isSuccessfulVerificationResult);
  const recentSuccessfulProducer = recentWindow.some(isSuccessfulStateChangingResult);
  if (recentSuccessfulVerification) {
    return { tripped: false, feedback: [], negativeConstraints: [] };
  }

  const stepLabel = input.currentStep?.id
    ? `step '${input.currentStep.id}'`
    : input.currentStep?.title
      ? `step '${input.currentStep.title}'`
      : "the current step";
  const producerText = recentSuccessfulProducer
    ? "Recent edits/build artifacts exist, so the next move should be the smallest verification command or final repair from the latest failure."
    : "No recent state-changing progress was observed, so the next move should be a strategy change rather than more broad inspection.";
  return {
    tripped: true,
    feedback: [
      `${stepLabel} reached the per-step tool budget (${input.currentStepToolResultCount}/${budget}) without a passing verification signal. ${producerText} Replan into fewer, higher-signal actions and avoid broad loops.`,
    ],
    negativeConstraints: [
      `Do not keep executing ${stepLabel} past ${budget} tool results without a passing build/test/runtime check or a concrete state-changing repair.`,
    ],
  };
}

function makeBlockedResult(call: ToolCall, code: string, message: string): ToolResult {
  return {
    toolCallId: call.id,
    name: call.name,
    ok: false,
    durationMs: 0,
    args: call.args,
    error: { code, message },
  };
}

function getTrailingObservationLoop(results: ToolResult[], threshold: number): { actionSignature?: string; observationSignature?: string; count: number } {
  const recent = results.slice(-Math.max(3, threshold + 2));
  if (recent.length === 0) return { count: 0 };
  const last = recent.at(-1)!;
  const lastAction = makeToolResultActionSignature(last);
  const lastObservation = makeToolResultObservationSignature(last);
  let count = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const result = recent[index]!;
    if (makeToolResultActionSignature(result) !== lastAction) break;
    if (makeToolResultObservationSignature(result) !== lastObservation) break;
    count += 1;
  }
  return {
    actionSignature: lastAction,
    observationSignature: lastObservation,
    count,
  };
}

export function makeToolCallActionSignature(call: ToolCall): string {
  return `${call.name}::${stableJson(relevantArgsForSignature(call.name, call.args))}`;
}

export function makeToolResultActionSignature(result: ToolResult): string {
  return `${result.name}::${stableJson(relevantArgsForSignature(result.name, result.args))}`;
}

export function makeToolResultObservationSignature(result: ToolResult): string {
  const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
  if (!result.ok) {
    return `${toolResultFamily(result)}:failed:${result.error?.code ?? "error"}:${stableHash(normalizeFailureText(result.error?.message ?? "").slice(0, 1800))}`;
  }
  if (result.name === "run_shell_command") {
    return `${toolResultFamily(result)}:ok:${output.exitCode ?? "n/a"}:${stableHash(`${tailText(output.stdout)}\n${tailText(output.stderr)}`)}`;
  }
  return `${toolResultFamily(result)}:ok:${stableHash(normalizeText(renderValue(result.output)).slice(-4000))}`;
}

export interface CachedSuccessDecision {
  allowed: ToolCall[];
  cachedResults: ToolResult[];
  feedback: string[];
}

export function reuseCachedSuccessfulActions(toolCalls: ToolCall[], previousResults: ToolResult[]): CachedSuccessDecision {
  const allowed: ToolCall[] = [];
  const cachedResults: ToolResult[] = [];
  const feedback: string[] = [];
  for (const call of toolCalls) {
    if (!isCacheableSuccessfulAction(call)) {
      allowed.push(call);
      continue;
    }
    const signature = makeToolCallActionSignature(call);
    const index = findLastIndex(previousResults, (result) => result.ok && makeToolResultActionSignature(result) === signature);
    if (index < 0 || previousResults.slice(index + 1).some(isSuccessfulStateChangingResult)) {
      allowed.push(call);
      continue;
    }
    const prior = previousResults[index]!;
    cachedResults.push({
      ...prior,
      toolCallId: call.id,
      args: call.args,
      durationMs: 0,
      output: annotateCachedOutput(prior.output),
    });
    feedback.push(`Reused still-valid successful result for '${signature}'. Treat that check/inspection as complete and advance instead of repeating it.`);
  }
  return { allowed, cachedResults, feedback };
}

function getRepeatedFailedObservation(results: ToolResult[], threshold: number): { family?: string; intent?: string; observationSignature?: string; count: number } {
  const failures = results.filter((result) => !result.ok && !isGuardBlockedFailure(result));
  if (failures.length === 0) return { count: 0 };
  const last = failures.at(-1)!;
  const family = toolResultFamily(last);
  const intent = toolResultIntent(last);
  const observationSignature = makeToolResultObservationSignature(last);
  let count = 0;
  for (const result of failures) {
    if (toolResultFamily(result) !== family) continue;
    if (toolResultIntent(result) !== intent) continue;
    if (makeToolResultObservationSignature(result) === observationSignature) count += 1;
  }
  return count >= threshold ? { family, intent, observationSignature, count } : { count };
}

function toolCallFamily(call: ToolCall): string {
  if (call.name !== "run_shell_command") return call.name;
  return shellCommandFamily(getCommand(call.args));
}

function toolResultFamily(result: ToolResult): string {
  if (result.name !== "run_shell_command") return result.name;
  return shellCommandFamily(getCommand(result.args));
}

function toolCallIntent(call: ToolCall): string {
  if (call.name !== "run_shell_command") return call.name;
  return shellCommandIntent(getCommand(call.args));
}

function toolResultIntent(result: ToolResult): string {
  if (result.name !== "run_shell_command") return result.name;
  return shellCommandIntent(getCommand(result.args));
}

function shellCommandFamily(command: string): string {
  const normalized = normalizeCommand(command).toLowerCase();
  if (isVerificationShellCommand(normalized)) return "shell:verification";
  if (isStateChangingShellCommand(normalized)) {
    if (/\b(?:pip|pip3|python3?\s+-m\s+pip|npm|pnpm|yarn|bun|cargo\s+(?:add|install|update)|go\s+(?:get|install)|mvn|gradle|conda|mamba|apt-get|apk|yum|dnf)\b/i.test(normalized)) {
      return "shell:dependency-setup";
    }
    if (/\b(?:make|cmake|ninja|meson|gcc|g\+\+|clang|clang\+\+|cargo\s+build|go\s+build|npm\s+run\s+build)\b/i.test(normalized)) {
      return "shell:build";
    }
    return "shell:mutation";
  }
  if (/^(?:cd\s+\S+\s+&&\s+)?(?:cat|sed\s+-n|head|tail|ls|grep|rg)\b/i.test(normalized)) return "shell:read";
  return "shell:other";
}

function shellCommandIntent(command: string): string {
  const normalized = stripShellPrefix(normalizeCommand(command).toLowerCase());
  const first = normalized.match(/^([a-z0-9_.+-]+)/i)?.[1] ?? "shell";
  if (/^(python|python3|node|ruby|perl|awk)$/.test(first)) {
    if (/\b(?:csv|json|parse|sum|hash|compute|print)\b/i.test(normalized)) return `${first}:compute`;
    if (/\b(?:open|write|replace|truncate|rename)\b/i.test(normalized)) return `${first}:mutation`;
    return `${first}:script`;
  }
  if (/^(7z|unzip|zip|tar|gzip|gunzip|xz)$/.test(first)) return `${first}:archive`;
  if (/^(curl|wget)$/.test(first)) return `${first}:network`;
  if (/^(cat|sed|head|tail|ls|grep|rg|find|stat|wc)$/.test(first)) return `${first}:read`;
  if (/^(pip|pip3|npm|pnpm|yarn|bun|cargo|go|mvn|gradle|conda|mamba|apt|apt-get|apk|yum|dnf)$/.test(first)) return `${first}:setup`;
  if (/^(make|cmake|ninja|meson|gcc|g\+\+|clang|clang\+\+|cc|c\+\+)$/.test(first)) return `${first}:build`;
  return first;
}

function stripShellPrefix(command: string): string {
  let current = command.trim();
  for (let index = 0; index < 4; index += 1) {
    const cdMatch = current.match(/^cd\s+[^;&|]+\s*&&\s*(.*)$/i);
    if (cdMatch?.[1]) {
      current = cdMatch[1].trim();
      continue;
    }
    const envMatch = current.match(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+(.*)$/);
    if (envMatch?.[1]) {
      current = envMatch[1].trim();
      continue;
    }
    break;
  }
  return current;
}

function isGuardBlockedFailure(result: ToolResult): boolean {
  const code = result.error?.code ?? "";
  return /(?:_blocked$|no_progress_loop|same_state_failed_action_retry|repeated_failed_action|repeated_low_information|same_batch_|unsafe_|relevance_gate|diagnostic_target_gate)/i.test(
    code,
  );
}

function normalizePathForSignature(value: string): string {
  if (!value) return value;
  let normalized = value.replace(/\/+/g, "/").replace(/\/$/, "");
  if (path.isAbsolute(normalized)) {
    try {
      normalized = path.resolve(normalized);
    } catch {
      // ignore: best-effort
    }
  }
  return normalized;
}

function relevantArgsForSignature(toolName: string, args: unknown): Record<string, unknown> {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (toolName === "run_shell_command") {
    const command = typeof record.cmd === "string" ? normalizeCommand(record.cmd) : "";
    const readLike = canonicalReadOnlyShellSignature(command);
    if (readLike) return readLike;
    return {
      cmd: command,
      cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    };
  }
  if (toolName === "read_file") {
    // Normalize the path so workspace-relative vs absolute variants collapse
    // to the same signature (otherwise the model can loop by re-reading the
    // same conceptual file with different path strings).
    return {
      path:
        typeof record.path === "string" ? normalizePathForSignature(record.path) : "",
      startLine: record.startLine,
      endLine: record.endLine,
    };
  }
  if (toolName === "grep_search") {
    return { pattern: record.pattern, path: record.path, include: record.include };
  }
  if (toolName === "list_directory") {
    return { path: record.path, includeHidden: record.includeHidden };
  }
  if (toolName === "skim_file") {
    return { path: record.path, goalHint: record.goalHint };
  }
  if (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(toolName)) {
    return {
      path: record.path,
      symbolName: record.symbolName,
      startLine: record.startLine,
      endLine: record.endLine,
      contentHash:
        typeof record.content === "string"
          ? stableHash(record.content)
          : typeof record.newString === "string"
            ? stableHash(record.newString)
            : typeof record.newCode === "string"
              ? stableHash(record.newCode)
              : undefined,
    };
  }
  if (toolName === "browser_control" || toolName === "computer_control") {
    return { action: record.action, url: record.url, selector: record.selector, ref: record.ref, key: record.key };
  }
  if (toolName === "search_tools") {
    return { query: record.query };
  }
  if (toolName === "sandbox_service_control") {
    return {
      action: record.action,
      service: record.service,
      command: typeof record.command === "string" ? normalizeCommand(record.command) : undefined,
      targetPath: record.targetPath,
      sourcePath: record.sourcePath,
      contentHash: typeof record.content === "string" ? stableHash(record.content) : undefined,
    };
  }
  if (toolName === "get_tool_output") {
    return { artifactId: record.artifactId };
  }
  if (toolName === "task_update") {
    return { taskId: record.taskId, status: record.status };
  }
  if (toolName === "task_create") {
    return { subject: record.subject, status: record.status };
  }
  return Object.fromEntries(Object.entries(record).filter(([key]) => ["path", "pattern", "query", "url", "action", "pid"].includes(key)));
}

function isProgressResult(result: ToolResult): boolean {
  return isSuccessfulStateChangingResult(result) || isSuccessfulVerificationResult(result);
}

function isSuccessfulStateChangingResult(result: ToolResult): boolean {
  if (!result.ok) return false;
  if (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file", "task_create", "task_update"].includes(result.name)) {
    return true;
  }
  if (["browser_control", "computer_control", "mouse_move", "mouse_click", "mouse_scroll", "keyboard_type", "keyboard_press", "wait"].includes(result.name)) {
    return true;
  }
  if (result.name === "sandbox_service_control") {
    return isSuccessfulSandboxServiceProgressResult(result);
  }
  if (result.name !== "run_shell_command") return false;
  return isStateChangingShellCommand(getCommand(result.args));
}

function isSuccessfulVerificationResult(result: ToolResult): boolean {
  if (!result.ok) return false;
  if (result.name === "sandbox_service_control") {
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
    if (args.action === "wait_ready") return output.lifecycle === "ready";
    return args.action === "exec" && output.exitCode === 0 && isVerificationShellCommand(typeof args.command === "string" ? args.command : "");
  }
  if (result.name !== "run_shell_command") return false;
  const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
  const exitCode = typeof output.exitCode === "number" ? output.exitCode : undefined;
  return exitCode === 0 && isVerificationShellCommand(getCommand(result.args));
}

function isClearlyProgressCall(call: ToolCall): boolean {
  if (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file", "task_create", "task_update"].includes(call.name)) {
    return true;
  }
  if (call.name === "run_shell_command") {
    const cmd = getCommand(call.args);
    return isStateChangingShellCommand(cmd) || isVerificationShellCommand(cmd);
  }
  if (call.name === "sandbox_service_control") {
    const action = call.args.action;
    if (action === "wait_ready") return true;
    if (["write_file", "copy_to_service", "restore_from_image"].includes(action)) return true;
    if (action === "exec") {
      const command = typeof call.args.command === "string" ? call.args.command : "";
      return isStateChangingShellCommand(command) || isVerificationShellCommand(command);
    }
  }
  return false;
}

function isSuccessfulSandboxServiceProgressResult(result: ToolResult): boolean {
  if (!result.ok) return false;
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  const action = args.action;
  if (action === "wait_ready") {
    const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
    return output.lifecycle === "ready";
  }
  if (["write_file", "copy_to_service", "restore_from_image"].includes(String(action))) return true;
  if (action !== "exec") return false;
  const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
  return output.exitCode === 0 && isStateChangingShellCommand(typeof args.command === "string" ? args.command : "");
}

function makeRecoveryStrategySignature(value: ToolCall | ToolResult): string | undefined {
  if (value.name !== "sandbox_service_control") return undefined;
  const args = value.args && typeof value.args === "object" ? (value.args as Record<string, unknown>) : {};
  const action = String(args.action ?? "");
  if (!["start", "restart", "recreate", "wait_ready", "restore_from_image"].includes(action)) return undefined;
  const diagnosticLayer = action === "restore_from_image" ? "image" : action === "wait_ready" ? "readiness" : "lifecycle";
  return `service-recovery::${String(args.service ?? "unknown")}::${diagnosticLayer}::${action}`;
}

function isCacheableSuccessfulAction(call: ToolCall): boolean {
  if (["read_file", "view_file", "skim_file", "list_directory", "grep_search", "get_tool_output"].includes(call.name)) return true;
  if (call.name === "sandbox_service_control") return ["logs", "snapshot", "inspect_image", "list"].includes(String(call.args.action));
  if (call.name !== "run_shell_command") return false;
  const command = getCommand(call.args);
  return !isStateChangingShellCommand(command) && (isVerificationShellCommand(command) || shellCommandFamily(command) === "shell:read");
}

function annotateCachedOutput(output: unknown): unknown {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return { ...(output as Record<string, unknown>), cachedSuccess: true };
  }
  return { cachedSuccess: true, value: output };
}

function isStateChangingShellCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  return (
	    /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|run\s+build|build)\b/i.test(normalized) ||
	    /\b(python3?|pip3?)\s+(-m\s+pip\s+)?(install|uninstall|wheel|build)\b/i.test(normalized) ||
	    /\b(conda|mamba)\s+(install|update|upgrade|env\s+(?:create|update))\b/i.test(normalized) ||
	    /\b(cargo\s+(build|install|update|fix)|go\s+(build|mod\s+tidy|install|get)|mvn\s+(package|install)|gradle\s+(build|assemble))\b/i.test(normalized) ||
	    /\b(make|cmake|ninja|meson)\b/i.test(normalized) ||
	    /\b(touch|mkdir|cp|mv|rm|ln|patch|git\s+apply|sed\s+-i|perl\s+-pi)\b/i.test(normalized) ||
	    /(?:^|[^<>])>{1,2}[^&]|\btee\s+/i.test(command) ||
	    /\b(gcc|g\+\+|clang|clang\+\+|cc|c\+\+)\b/i.test(normalized)
	  );
}

function isVerificationShellCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  return (
    /\b(test|tests|pytest|unittest|nosetests|jest|vitest|mocha|ava|tap|ctest|check|verify|lint)\b/i.test(normalized) ||
    /\b(go\s+test|cargo\s+test|npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|mvn\s+test|gradle\s+test)\b/i.test(normalized) ||
    /\b(python3?\s+-m\s+(pytest|unittest|compileall|py_compile))\b/i.test(normalized)
  );
}

function canonicalReadOnlyShellSignature(command: string): Record<string, unknown> | undefined {
  const normalized = normalizeCommand(command);
  if (!normalized) return undefined;
  if (/[>;|&]|`|\$\(/.test(normalized)) return undefined;

  const catMatch = normalized.match(/^(?:cd\s+(\S+)\s+&&\s+)?cat\s+(.+)$/i);
  if (catMatch) return { readOnlyShell: "cat", cwd: stripShellQuotes(catMatch[1]), target: canonicalShellTarget(catMatch[2] ?? "") };

  const sedMatch = normalized.match(/^(?:cd\s+(\S+)\s+&&\s+)?sed\s+-n\s+(['"]?)(\d+),(\d+)p\2\s+(.+)$/i);
  if (sedMatch) {
    return {
      readOnlyShell: "sed-range",
      cwd: stripShellQuotes(sedMatch[1]),
      target: canonicalShellTarget(sedMatch[5] ?? ""),
      startLine: Number(sedMatch[3]),
      endLine: Number(sedMatch[4]),
    };
  }

  const headTailMatch = normalized.match(/^(?:cd\s+(\S+)\s+&&\s+)?(head|tail)(?:\s+-n\s+(\d+))?\s+(.+)$/i);
  if (headTailMatch) {
    return {
      readOnlyShell: headTailMatch[2]?.toLowerCase(),
      cwd: stripShellQuotes(headTailMatch[1]),
      target: canonicalShellTarget(headTailMatch[4] ?? ""),
      lines: Number(headTailMatch[3] ?? 10),
    };
  }

  const lsMatch = normalized.match(/^(?:cd\s+(\S+)\s+&&\s+)?ls(?:\s+-[A-Za-z0-9]+)?\s*(.*)$/i);
  if (lsMatch) return { readOnlyShell: "ls", cwd: stripShellQuotes(lsMatch[1]), target: canonicalShellTarget(lsMatch[2] || ".") };

  const grepMatch = normalized.match(/^(?:cd\s+(\S+)\s+&&\s+)?(?:grep|rg)\s+(.+)$/i);
  if (grepMatch && !/\s-(?:r|-replace|-files-with-matches=)/i.test(grepMatch[2] ?? "")) {
    return { readOnlyShell: "grep", cwd: stripShellQuotes(grepMatch[1]), query: normalizeCommand(grepMatch[2] ?? "") };
  }

  return undefined;
}

function canonicalShellTarget(value: string): string {
  return (stripShellQuotes(value) ?? "")
    .replace(/\s+/g, " ")
    .replace(/^\.\//, "")
    .trim();
}

function stripShellQuotes(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().replace(/^['"]|['"]$/g, "") || undefined;
}

function getCommand(args: unknown): string {
  return args && typeof args === "object" && typeof (args as Record<string, unknown>).cmd === "string"
    ? String((args as Record<string, unknown>).cmd)
    : "";
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function tailText(value: unknown): string {
  return typeof value === "string" ? normalizeText(value).slice(-2400) : "";
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function normalizeFailureText(value: string): string {
  return normalizeText(value)
    .replace(/\bCommand:\s.*?(?=\s(?:stdout:|stderr:|$))/gi, "Command: <normalized>")
    .replace(/\blogPath['"]?:\s*['"]?[^'"\s]+/gi, "logPath:<path>")
    .replace(/\/tmp\/reaper-[^\s'")]+/g, "/tmp/reaper-<run>")
    .replace(/\/workspace\/reaper_eval\/terminal-bench-runs\/[^\s'")]+/g, "/workspace/reaper_eval/terminal-bench-runs/<run>")
    .replace(/\s+/g, " ")
    .trim();
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stableJson(value: Record<string, unknown>): string {
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries.map(([key, item]) => [key, normalizeSignatureValue(item)])));
}

function normalizeSignatureValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeVolatileText(value);
  if (Array.isArray(value)) return value.map((item) => normalizeSignatureValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeSignatureValue(item)]),
    );
  }
  return value;
}

function normalizeVolatileText(value: string): string {
  return value
    .replace(/\/tmp\/reaper-tbench-[A-Za-z0-9_-]+/g, "/tmp/reaper-tbench-<id>")
    .replace(/\/tmp\/reaper-[A-Za-z0-9_.-]+/g, "/tmp/reaper-<id>")
    .replace(/\/workspace\/reaper_eval\/terminal-bench-runs\/[^\s'")]+/g, "/workspace/reaper_eval/terminal-bench-runs/<run>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\b\d{13,}\b/g, "<timestamp>")
    .replace(/\s+/g, " ")
    .trim();
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function resolveLimit(configured: number | undefined, envName: string, fallback: number): number {
  const envValue = readPositiveIntEnv(envName, configured ?? fallback);
  return envValue <= 0 ? Number.POSITIVE_INFINITY : envValue;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}
