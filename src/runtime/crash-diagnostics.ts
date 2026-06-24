import type { ToolCall, ToolResult } from "../tools/types.js";

const CRASH_EVIDENCE =
  /(?:code 13[49]|exit(?:ed)?(?:\s+with)?(?:\s+code)?\s*[:=]?\s*13[49]\b|segmentation fault|segfault|core dumped|access violation|bus error|panic:|fatal runtime error|addresssanitizer|undefinedbehaviorsanitizer)/i;

const CRASH_DIAGNOSTIC_COMMAND =
  /\b(?:gdb|lldb|valgrind|strace|coredumpctl|addr2line|readelf|objdump|hexdump|xxd|od|file|nm|sanitizer|asan|ubsan|tsan|msan|backtrace|stack trace|core dump|sizeof|offsetof)\b|-(?:fsanitize|g|ggdb)\b/i;

export function hasUnresolvedRuntimeCrash(results: ToolResult[]): boolean {
  const crashIndex = findLastIndex(results, isRuntimeCrashResult);
  if (crashIndex < 0) return false;
  return !results.slice(crashIndex + 1).some(isSuccessfulRuntimeOrVerificationResult);
}

export function isCrashDiagnosticToolCall(call: ToolCall): boolean {
  if (["read_file", "view_file", "skim_file", "grep_search", "list_directory", "inspect_environment", "web_search", "web_fetch"].includes(call.name)) {
    return true;
  }
  if (call.name !== "run_shell_command") return false;
  const command = typeof call.args.cmd === "string" ? call.args.cmd : "";
  return CRASH_DIAGNOSTIC_COMMAND.test(command);
}

export function buildCrashDiagnosticFeedback(results: ToolResult[]): string | undefined {
  if (!hasUnresolvedRuntimeCrash(results)) return undefined;
  return [
    "Crash diagnostic mode is active because a runtime crash remains unresolved.",
    "Prioritize one discriminating diagnostic before further implementation: capture a sanitizer/debugger/backtrace/core trace, inspect external representation or memory-layout invariants, or reduce to a minimal reproduction.",
    "Crash and fatal-error evidence outranks warnings. Keep build, runtime, and verification stages atomic and preserve each stage's nonzero exit status.",
  ].join(" ");
}

export function isRuntimeCrashResult(result: ToolResult): boolean {
  const text = renderResult(result);
  return CRASH_EVIDENCE.test(text);
}

function isSuccessfulRuntimeOrVerificationResult(result: ToolResult): boolean {
  if (!result.ok || result.name !== "run_shell_command") return false;
  if (/\b(?:BUILD|COMPILE|CC|RUN|TEST|VERIFY|CHECK|EXIT(?:_CODE)?)\s*[:=]\s*[1-9]\d*\b/i.test(renderResult(result))) return false;
  const command = commandOf(result);
  return (
    /\b(?:pytest|node\s+--test|jest|vitest|mocha|ctest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|npm\s+(?:run\s+)?test)\b/i.test(command) ||
    /\b(?:assert|diff|cmp|grep\s+-q|jq\s+-e|test\s+-[efsd]|sys\.exit|process\.exit|raise\s+SystemExit)\b/i.test(command) ||
    /(?:^|[;&|]\s*|\bdo\s+)(?:\.\/|build\/|\.\/build\/|dist\/|target\/|bin\/)[A-Za-z0-9_./-]+/i.test(command)
  );
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
