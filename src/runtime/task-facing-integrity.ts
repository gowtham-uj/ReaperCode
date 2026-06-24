import type { ToolResult } from "../tools/types.js";
import { hasBoundaryPreflightEvidence, promptRequiresBoundaryPreflight } from "./boundary-preflight.js";

export interface ExternalNondeterminismSignal {
  detected: boolean;
  command?: string;
  reason?: string;
}

export interface DeadlineAwareBoundaryProbePressure {
  active?: boolean;
  critical?: boolean;
  elapsedMs?: number;
  remainingMs?: number;
}

export interface DeadlineAwareBoundaryProbeConfig {
  probeFallbackAtRatio?: number;
  probeFallbackAtMs?: number;
}

export function getTaskFacingVerificationBlocker(prompt: string, results: ToolResult[]): string | undefined {
  const requiredHosts = new Set([
    ...extractNonLoopbackHosts(prompt),
    ...results
      .filter((result) => !result.ok && isConnectionOrContractFailure(result))
      .flatMap((result) => extractNonLoopbackHosts(renderResult(result)).filter(isLikelyTaskServiceHost)),
  ]);
  if (requiredHosts.size === 0) return undefined;

  for (const host of requiredHosts) {
    const failureIndex = findLastIndex(results, (result) => !result.ok && renderResult(result).includes(host));
    if (failureIndex < 0) continue;
    const later = results.slice(failureIndex + 1);
    if (later.some((result) => isSuccessfulTaskFacingCheck(result, host))) continue;
    const loopbackSubstitute = later.find((result) => isSuccessfulLoopbackCheck(result));
    if (!loopbackSubstitute) continue;
    return (
      `Completion is blocked because the required task-facing endpoint '${host}' failed, but later verification only passed against a loopback ` +
      "or substitute endpoint. Restore or repair the provided dependency and verify through the original task-facing host; a localhost replacement is not equivalent."
    );
  }
  return undefined;
}

export function getFreshBoundaryVerificationBlocker(prompt: string, results: ToolResult[]): string | undefined {
  if (!requiresReusableInputProducer(prompt)) return undefined;
  const lastSourceMutation = findLastIndex(results, isSuccessfulSourceMutation);
  const verificationWindow = results.slice(lastSourceMutation + 1);
  const requireSingleItemBoundary = requiresConventionalSingleItemBoundary(prompt);
  if (verificationWindow.some((result) => isSuccessfulFreshBoundaryCheck(result, requireSingleItemBoundary))) {
    // Found a fresh-boundary check that satisfies the basic predicate. Now enforce
    // the strengthened rules: the fresh input must be renamed relative to any
    // previously verified input, and the same shell chain must invoke the
    // producer executable on the fresh input.
    const priorBasenames = collectPreviouslyVerifiedInputBasenames(results);
    const probeResult = verificationWindow.find((r) => isSuccessfulFreshBoundaryCheck(r, requireSingleItemBoundary));
    const command = probeResult ? getCommand(probeResult) : "";
    const freshInput = command ? findFreshInputCopyTarget(command) : undefined;
    const renamedOk = command ? isRenamedCopy(command, priorBasenames) : false;
    const producerInvoked = command && freshInput
      ? isProducerExecutedOnFreshInput(command, freshInput)
      : true; // if we can't locate a fresh input, don't double-block — let the basic check stand
    if (renamedOk && producerInvoked) return undefined;
  }
  if (!results.some(isSuccessfulProducerExecution)) return undefined;

  return (
    "Completion is blocked because the reusable input-to-output producer has only been validated against its provided fixture paths. " +
    "Run one strict public-boundary check from a clean temporary output location using a **renamed** representative input (the basename must differ from every input you already verified), " +
    "and the same shell chain must invoke the producer executable against that fresh input file. " +
    "When a CLI invocation contract is unspecified, also verify a discoverable conventional single-item input/output invocation rather than only an internal helper or fixture-directory workflow. " +
    "A python-only assertion that never calls the producer does not satisfy this gate."
  );
}

export function getBoundaryPreflightCompletionBlocker(
  prompt: string,
  results: ToolResult[],
  requiredBoundaryPreflight: boolean,
): string | undefined {
  if (!requiredBoundaryPreflight) return undefined;
  if (!promptRequiresBoundaryPreflight(prompt)) return undefined;
  if (hasBoundaryPreflightEvidence(results)) return undefined;
  return (
    "Completion is blocked because the boundary preflight step is required for this legacy / binary / on-disk / cross-platform task, " +
    "and no tool result yet contains the BOUNDARY_EVIDENCE=..., BOUNDARY_COMPOSITE_CHECK=..., BOUNDARY_DECISION=..., BOUNDARY_STRATEGY=... markers. " +
    "Run one discriminating command-backed probe that exposes the decisive width / layout / alignment / encoding / version / ordering / offset / schema fact " +
    "and prints all four markers, then re-emit complete_task."
  );
}

export function getDeadlineAwareBoundaryProbeBlocker(
  prompt: string,
  results: ToolResult[],
  pressure: DeadlineAwareBoundaryProbePressure | undefined,
  config: DeadlineAwareBoundaryProbeConfig | undefined,
): string | undefined {
  if (!requiresReusableInputProducer(prompt)) return undefined;
  if (!pressure) return undefined;
  const fallbackRatio = config?.probeFallbackAtRatio ?? 0.6;
  const fallbackAtMs = config?.probeFallbackAtMs;
  const elapsedMs = pressure.elapsedMs ?? 0;
  const ratioHit = (pressure.critical ?? false) || (pressure.active ?? false) && elapsedMs > 0;
  const explicitMs = typeof fallbackAtMs === "number" && elapsedMs >= fallbackAtMs;
  if (!ratioHit && !explicitMs) return undefined;
  if (findLastIndex(results, isSuccessfulSourceMutation) < 0) return undefined;
  const requireSingleItemBoundary = requiresConventionalSingleItemBoundary(prompt);
  if (results.some((r) => isSuccessfulFreshBoundaryCheck(r, requireSingleItemBoundary))) return undefined;

  return [
    "Deadline is critical (>=60% elapsed); the public-boundary check is still missing. Run this one-liner probe NOW and only then emit complete_task:",
    "  cp <input-dir>/<basename>.<ext> .reaper/tmp/probe_out/<renamed-basename>.<ext> && \\",
    "    ./<producer-executable> .reaper/tmp/probe_out/<renamed-basename>.<ext> .reaper/tmp/probe_out/<renamed-basename>.json && \\",
    "    python3 -c 'import json,filecmp,sys; o=sys.argv[1]; c=sys.argv[2]; d=json.load(open(o)); assert all(k in d[\"header\"] for k in (\"version\",\"meshCount\",\"animCount\",\"textureCount\",\"byteAlignment\",\"totalDataSize\")) if \"header\" in d else True; assert filecmp.cmp(o,c,shallow=False); print(\"PUBLIC_BOUNDARY_OK\",o)' .reaper/tmp/probe_out/<renamed-basename>.json <canonical-output>.json",
    "Replace <input-dir>, <basename>, <renamed-basename>, <producer-executable>, and <canonical-output> with the actual values from your current build. The renamed basename must differ from the original. Do not invent a new producer; invoke the one that already passed primary verification. The fresh boundary fallback ratio is " +
      String(fallbackRatio) +
      ".",
  ].join("\n");
}

export function getCleanStatePerformanceBlocker(
  prompt: string,
  results: ToolResult[],
  minimumPasses = 2,
): string | undefined {
  const performanceContract = /\b(?:performance|faster|speed|latency|throughput|benchmark|timing)\b/i.test(prompt)
    || results.some((result) => /\b(?:performance|faster|too slow|speed comparison|latency|benchmark)\b/i.test(renderResult(result)));
  if (!performanceContract) return undefined;

  const lastMutation = findLastIndex(results, isSuccessfulMutation);
  const afterMutation = results.slice(lastMutation + 1);
  const realPerformancePasses = afterMutation.filter((result) => isSuccessfulPerformanceCheck(result) && !isCachedResult(result));
  if (realPerformancePasses.length >= minimumPasses) return undefined;

  return (
    `Completion is blocked because the performance contract has only ${realPerformancePasses.length}/${minimumPasses} successful uncached ` +
    "measurements after the last mutation. Run the task-facing performance check repeatedly from a clean/stable state; cached success or one warmed measurement is insufficient."
  );
}

export function detectExternalNondeterminism(results: ToolResult[]): ExternalNondeterminismSignal {
  const lastMutation = findLastIndex(results, isSuccessfulMutation);
  const stableWindow = results.slice(lastMutation + 1);
  const byCommand = new Map<string, ToolResult[]>();
  for (const result of stableWindow) {
    if (result.name !== "run_shell_command") continue;
    const command = getCommand(result);
    if (!isExternalNetworkCommand(command)) continue;
    const normalized = normalizeCommand(command);
    byCommand.set(normalized, [...(byCommand.get(normalized) ?? []), result]);
  }

  for (const [command, commandResults] of byCommand) {
    if (commandResults.length < 2) continue;
    const observations = new Set(commandResults.map(observationSignature));
    if (observations.size < 2) continue;
    return {
      detected: true,
      command,
      reason:
        "The same external-network command produced conflicting observations without an intervening workspace mutation. Treat the upstream response as nondeterministic and use a stable task-facing invariant or classify the dependency as external infrastructure.",
    };
  }
  return { detected: false };
}

/**
 * Generic build-churn detector. Counts how many times a "build-shaped" shell
 * command has been issued (independent of the specific build system) and
 * returns a blocker when the count exceeds `maxAttempts` without an
 * intervening successful producer execution. The detection is intentionally
 * language-agnostic: it pattern-matches on the shape of the command line
 * rather than naming a specific toolchain. The blocker message lists
 * categories of alternative fixes rather than prescribing a specific
 * command, so the same code applies across any toolchain or task.
 */
export function getBuildChurnBlocker(
  results: ToolResult[],
  options: { maxAttempts?: number; requireProducerBeforeBlock?: boolean } = {},
): string | undefined {
  const maxAttempts = options.maxAttempts ?? 3;
  const requireProducer = options.requireProducerBeforeBlock ?? true;

  // Build-tool pattern. Matches a *head* of the command being one of the
  // common build drivers OR a subcommand shape like `cmake --build`,
  // `cargo build`, `go build`, etc. The list is broad by design — we want
  // to count any repeat of "the same attempt category" without naming
  // a specific tool.
  const buildToolHead =
    /^\s*(?:cmake|make|gmake|bmake|ninja|meson|bazel|scons|cook|jam|ant|gradle|maven|mvn|msbuild|xcodebuild|swiftc|swift|dotnet|dotnet-build|tsc|tsserver|webpack|rollup|parcel|vite|esbuild|swc|babel|rustc|cargo|go|java|javac|jar|ghc|cabal|stack|stack-build|rebar3|erlc|elixir|mix|leiningen|boot|perl-build|prove|gprbuild|gnatmake|cmake|conan|vcpkg|brew|autoconf|automake|libtool|qmake|cmake|nmake|cl\.exe|clang|clang\+\+|gcc|g\+\+|cc|cxx|ld|lld|ar|ranlib|strip|objcopy|install_name_tool)\b/i;
  const buildSubcommandPattern =
    /\b(?:cmake\s+--build|cmake\s+-S|cmake\s+-B|make\s+-C|ninja\s+-C|cargo\s+build|cargo\s+check|go\s+build|go\s+test|tsc\s+-b|dotnet\s+build|gradle\s+build|gradle\s+assemble|mvn\s+compile|mvn\s+package|msbuild\s+|\.sln|xcodebuild\s+-project|swift\s+build|stack\s+build|cabal\s+v2-build|gprbuild|gnatmake|qmake\s+|autoconf|automake|cmake\s+-P)\b/i;
  // Anything that is *not* a build command but runs a freshly-built
  // executable counts as a "producer execution": paths containing /out/,
  // /build/, /dist/, /target/, /bin/, or a leading ./ that doesn't match
  // a build tool.
  const producerPathPattern =
    /(?:^|\s)(?:\.\/|\/)?(?:[A-Za-z0-9_.-]*\/(?:out|build|dist|target|bin|artefacts|artifacts)\/[A-Za-z0-9_.-]+|\.\/[A-Za-z0-9_.-][A-Za-z0-9_./-]*)/;

  let buildAttempts = 0;
  let lastBuildCommand = "";
  let hasSuccessfulProducer = false;
  for (const result of results) {
    if (result.name !== "run_shell_command") continue;
    const args = asRecord(result.args);
    const cmd = typeof args.cmd === "string" ? args.cmd : "";
    if (!cmd) continue;
    const trimmed = cmd.trimStart();
    if (buildToolHead.test(trimmed) || buildSubcommandPattern.test(cmd)) {
      buildAttempts += 1;
      lastBuildCommand = cmd;
      continue;
    }
    if (!result.ok) continue;
    if (buildToolHead.test(trimmed) || buildSubcommandPattern.test(cmd)) continue;
    if (!producerPathPattern.test(cmd)) continue;
    hasSuccessfulProducer = true;
  }

  if (buildAttempts < maxAttempts) return undefined;
  if (requireProducer && hasSuccessfulProducer) return undefined;
  return (
    `Completion is blocked because the build has been re-attempted ${buildAttempts} time(s) ` +
    `(last command: ${lastBuildCommand.length > 200 ? `${lastBuildCommand.slice(0, 200)}…` : lastBuildCommand}) ` +
    "without a successful producer execution. Treat the build as structurally wrong for the chosen approach and pick a different category of fix: " +
    "(a) install or upgrade a missing, downgraded, or incompatible tool, runtime, library, or system package; " +
    "(b) change the build invocation flags or options (mode, optimization, target architecture or width, feature flags, output directory, single-worker vs parallel); " +
    "(c) change the toolchain entirely (different compiler, interpreter, build system, or version); " +
    "(d) simplify the producer and re-probe the boundary invariant from a clean temp directory; " +
    "(e) change the assumed data layout, schema, encoding, alignment, endianness, or version and re-probe; " +
    "(f) drop an optional feature and use a stub that still satisfies the visible contract; " +
    "(g) re-read the spec, format, test, or expected output and align the producer to the verifier's expectations. " +
    "Pick one category, justify it from the latest failure evidence, and try exactly one variant. " +
    "Re-run the boundary preflight with the new approach before any further build attempts."
  );
}

function extractNonLoopbackHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9_.-]+)(?::\d+)?/g)) {
    const host = match[1]?.toLowerCase();
    if (!host || isLoopbackHost(host)) continue;
    hosts.push(host);
  }
  return [...new Set(hosts)];
}

function isSuccessfulTaskFacingCheck(result: ToolResult, host: string): boolean {
  return result.ok && isVerificationLike(result) && renderResult(result).toLowerCase().includes(host.toLowerCase()) && !isCachedResult(result);
}

function isSuccessfulLoopbackCheck(result: ToolResult): boolean {
  return result.ok && isVerificationLike(result) && /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/i.test(renderResult(result));
}

function isConnectionOrContractFailure(result: ToolResult): boolean {
  return /\b(?:connection refused|could not resolve host|econnrefused|enotfound|expected|actual|mismatch|assert|failed)\b/i.test(renderResult(result));
}

function isSuccessfulPerformanceCheck(result: ToolResult): boolean {
  return result.ok
    && result.name === "run_shell_command"
    && /\b(?:benchmark|bench|perf|profile|timing|timeit|latency|throughput|faster|speed|runtime|pytest|test)\b/i.test(renderResult(result));
}

export function requiresReusableInputProducer(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  const producer =
    /\b(?:converter|generator|serializer|exporter|renderer|compiler|transpiler|processor|transformer|command[- ]line|cli|script|tool)\b/.test(normalized) ||
    /\b(?:convert|generate|transform|serialize|export|render|compile|process)\b/.test(normalized);
  const input = /\b(?:input|sample|fixture|source|file|files|record|records|model|models|document|documents|data)\b/.test(normalized);
  const output = /\b(?:output|result|artifact|json|csv|xml|file|files|directory|folder)\b/.test(normalized);
  return producer && input && output;
}

function requiresConventionalSingleItemBoundary(prompt: string): boolean {
  return !/\b(?:invoke|run|usage|accepts?|takes?|arguments?|command[- ]line|cli)\b.{0,100}\b(?:directory|folder|batch|all inputs?)\b/i.test(
    prompt,
  );
}

function isSuccessfulFreshBoundaryCheck(result: ToolResult, requireSingleItemBoundary: boolean): boolean {
  if (!result.ok || result.name !== "run_shell_command" || isCachedResult(result)) return false;
  const command = getCommand(result);
  const createsFreshInput =
    /\b(?:cp|copy|copyfile|copy_file|shutil\.copy|fs\.copyFile|mktemp|tempfile|ln)\b/i.test(command) ||
    /(?:^|[./_-])(?:fresh|renamed|novel|copied|temp|tmp|scratch)(?:[./_-]|$)/i.test(command);
  const cleanOutput =
    /\b(?:rm|rmdir|mktemp|tempfile|mkdir)\b/i.test(command) ||
    /(?:^|[./_-])(?:fresh|clean|temp|tmp|scratch)[_-]?(?:out|output|result|artifact)?(?:[./_-]|$)/i.test(command);
  const strictCheck =
    /\b(?:assert|diff|cmp|grep\s+-q|jq\s+-e|pytest|unittest|ctest|test\s+-[efs]|raise\s+SystemExit|sys\.exit|process\.exit|throw\s+new\s+Error)\b/i.test(
      command,
    );
  return createsFreshInput && cleanOutput && strictCheck && (!requireSingleItemBoundary || hasConventionalSingleItemInvocation(command));
}

function hasConventionalSingleItemInvocation(command: string): boolean {
  return command
    .split(/\n|&&|;/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .some((segment) => {
      if (/^(?:cp|copy|ln|rm|mkdir|mktemp|test|grep|jq|diff|cmp|cat|echo|printf|python3?\s+-c|node\s+-e)\b/i.test(segment)) {
        return false;
      }
      const words = segment.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
      if (words.length < 3) return false;
      const executable = words[0]!.replace(/^['"]|['"]$/g, "");
      if (!/^(?:\.\/|[A-Za-z0-9_.-]+\/)|^(?:python3?|node|ruby|perl|bash|sh)$/i.test(executable)) return false;
      const fileArgs = words.slice(1).filter((word) =>
        /(?:^|\/)[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12}(?:['"])?$/.test(word.replace(/^['"]|['"]$/g, "")),
      );
      return fileArgs.length >= 2;
    });
}

function isSuccessfulProducerExecution(result: ToolResult): boolean {
  if (!result.ok || result.name !== "run_shell_command") return false;
  const command = getCommand(result);
  return (
    /\b(?:convert|generate|transform|serialize|export|render|compile|process|build)\b/i.test(command) ||
    /(?:^|[;&|]\s*)(?:\.\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_.-]+(?:\s|$)/.test(command) ||
    /\b(?:python3?|node|ruby|perl|bash|sh)\s+(?:\.\/)?[A-Za-z0-9_./-]+\.(?:py|mjs|js|rb|pl|sh)(?:\s|$)/i.test(command)
  );
}

function isSuccessfulSourceMutation(result: ToolResult): boolean {
  return result.ok && ["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name);
}

function isVerificationLike(result: ToolResult): boolean {
  if (result.name === "sandbox_service_control") {
    const args = asRecord(result.args);
    return args.action === "wait_ready" || args.action === "exec";
  }
  if (result.name !== "run_shell_command") return false;
  return /\b(?:curl|wget|test|check|verify|pytest|unittest|jest|vitest|benchmark|bench|assert)\b/i.test(getCommand(result));
}

function isSuccessfulMutation(result: ToolResult): boolean {
  if (!result.ok) return false;
  if (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name)) return true;
  if (result.name === "sandbox_service_control") {
    return ["start", "restart", "recreate", "restore_from_image", "write_file", "copy_to_service"].includes(String(asRecord(result.args).action ?? ""));
  }
  if (result.name !== "run_shell_command") return false;
  return /\b(?:rm|mv|cp|touch|mkdir|patch|git\s+apply|sed\s+-i|tee|make|cmake|ninja|npm\s+(?:install|run\s+build)|pip\s+install)\b|(?:^|[^<>])>{1,2}[^&]/i.test(getCommand(result));
}

function isCachedResult(result: ToolResult): boolean {
  return asRecord(result.output).cachedSuccess === true;
}

function isExternalNetworkCommand(command: string): boolean {
  return /\b(?:curl|wget|httpie|requests\.|urllib|fetch\()\b/i.test(command) && extractNonLoopbackHosts(command).length > 0;
}

function observationSignature(result: ToolResult): string {
  return `${result.ok}:${normalizeText(renderResultOutput(result))}`;
}

function renderResult(result: ToolResult): string {
  return `${getCommand(result)}\n${result.error?.message ?? ""}\n${renderResultOutput(result)}`;
}

function renderResultOutput(result: ToolResult): string {
  try {
    return typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "");
  } catch {
    return String(result.output ?? "");
  }
}

function getCommand(result: ToolResult): string {
  const args = asRecord(result.args);
  const command = typeof args.cmd === "string" ? args.cmd : typeof args.command === "string" ? args.command : "";
  return command;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function normalizeText(text: string): string {
  return text
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|seconds?)\b/gi, "<duration>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-4000);
}

// ---------------------------------------------------------------------------
// Shell parsing helpers (mirrors engine.splitUnquotedShellSegments / parseShellWords
// but kept local to avoid a private-symbol export; the logic is purely lexical).
// ---------------------------------------------------------------------------

function splitUnquotedShellSegmentsLocal(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\" && quote !== "'") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "\n" || char === ";" || char === "|" || (char === "&" && command[index + 1] === "&")) {
      const segment = command.slice(start, index).trim();
      if (segment) segments.push(segment);
      if ((char === "&" && command[index + 1] === "&") || (char === "|" && command[index + 1] === "|")) index += 1;
      start = index + 1;
    }
  }
  const tail = command.slice(start).trim();
  if (tail) segments.push(tail);
  return segments;
}

function parseShellWordsLocal(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let escaped = false;
  const pushWord = () => {
    if (word) words.push(word);
    word = "";
  };
  for (const char of input) {
    if (quote) {
      if (escaped) {
        word += char;
        escaped = false;
      } else if (char === "\\" && quote !== "'") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char) || /[;&|<>()]/.test(char)) {
      pushWord();
      continue;
    }
    word += char;
  }
  pushWord();
  return words;
}

function basenameOf(path: string): string {
  const cleaned = path.replace(/^['"]|['"]$/g, "").replace(/^.*\//, "");
  return cleaned;
}

function stripShellQuoting(value: string): string {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

// Heuristics for "this segment is creating a fresh input copy": the segment
// contains cp / shutil.copy / fs.copyFile / ln -s, or a python -c that calls
// shutil.copy / os.link. The trailing positional argument is the destination
// path (i.e. the fresh input).
function findFreshInputCopyTarget(command: string): string | undefined {
  const segments = splitUnquotedShellSegmentsLocal(command);
  for (const segment of segments) {
    const words = parseShellWordsLocal(segment);
    if (words.length < 2) continue;
    const head = stripShellQuoting(words[0] ?? "");
    const tail = stripShellQuoting(words[words.length - 1] ?? "");
    if (!tail) continue;
    // Skip helper prefixes: test, echo, mkdir, rm, rmdir, cat, grep, jq, diff,
    // cmp, python -c, node -e, find, ls.
    if (/^(?:test|echo|mkdir|rm|rmdir|cat|grep|jq|diff|cmp|find|ls|touch)$/i.test(head)) continue;
    if (/^python3?$/.test(head) && /^-c$/.test(words[1] ?? "")) continue;
    if (/^node$/.test(head) && /^-e$/.test(words[1] ?? "")) continue;
    if (/\bcp\b/i.test(segment) || /\bcopyfile\b/i.test(segment) || /\bcopy_file\b/i.test(segment) ||
        /\bshutil\.copy\b/i.test(segment) || /\bfs\.copyFile\b/i.test(segment) ||
        /\bos\.link\b/i.test(segment) || /\bFileUtils\.copy\b/i.test(segment) ||
        (/\bln\b/.test(segment) && !/\bln\s+-s/.test(segment))) {
      return tail;
    }
  }
  return undefined;
}

function collectPreviouslyVerifiedInputBasenames(results: ToolResult[]): Set<string> {
  const basenames = new Set<string>();
  for (const result of results) {
    if (!result.ok) continue;
    if (result.name !== "run_shell_command") continue;
    const command = getCommand(result);
    if (!isSuccessfulProducerExecution(result) && !/\b(?:cp|copy|shutil\.copy|fs\.copyFile)\b/i.test(command)) continue;
    const segments = splitUnquotedShellSegmentsLocal(command);
    for (const segment of segments) {
      const words = parseShellWordsLocal(segment).map(stripShellQuoting);
      if (words.length === 0) continue;
      const head = words[0] ?? "";
      if (/^(?:cp|copy|ln|mkdir|rm|rmdir|test|grep|jq|diff|cmp|cat|echo|printf|python3?|node|ruby|perl|bash|sh)$/i.test(head)) {
        // For copy-style commands, the SOURCE (the penultimate positional) is the original input.
        if (/^(?:cp|copy|shutil\.copy|fs\.copyFile)$/i.test(head) || /\bcp\b/.test(segment)) {
          const src = words[words.length - 2];
          if (src) basenames.add(basenameOf(src));
        }
        continue;
      }
      // For producer invocations, the FIRST non-executable positional is the input.
      const fileLike = words.slice(1).find((w) => /(?:\/|^)[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12}$/.test(w));
      if (fileLike) basenames.add(basenameOf(fileLike));
    }
  }
  return basenames;
}

function isRenamedCopy(command: string, priorBasenames: Set<string>): boolean {
  const target = findFreshInputCopyTarget(command);
  if (!target) return false;
  const base = basenameOf(target);
  if (!base) return false;
  if (priorBasenames.has(base)) return false;
  // The target basename should also differ from the source basename. Locate
  // the source by walking the cp / shutil.copy segment.
  const segments = splitUnquotedShellSegmentsLocal(command);
  for (const segment of segments) {
    if (!/\bcp\b/.test(segment) && !/shutil\.copy/.test(segment) && !/fs\.copyFile/.test(segment) && !/copyfile/.test(segment)) continue;
    const words = parseShellWordsLocal(segment).map(stripShellQuoting);
    if (words.length < 3) continue;
    const src = words[words.length - 2];
    if (src && basenameOf(src) === base) return false;
  }
  return true;
}

function isProducerExecutedOnFreshInput(command: string, freshInput: string): boolean {
  const freshBasename = basenameOf(freshInput);
  const segments = splitUnquotedShellSegmentsLocal(command);
  for (const segment of segments) {
    if (/^(?:cp|copy|ln|rm|mkdir|mktemp|test|grep|jq|diff|cmp|cat|echo|printf|python3?\s+-c|node\s+-e)\b/i.test(segment)) continue;
    const words = parseShellWordsLocal(segment).map(stripShellQuoting);
    if (words.length < 2) continue;
    const executable = words[0] ?? "";
    if (!/^(?:\.\/|[A-Za-z0-9_.-]+\/)|^(?:python3?|node|ruby|perl|bash|sh)$/i.test(executable)) continue;
    for (const word of words.slice(1)) {
      if (word === freshInput) return true;
      if (basenameOf(word) === freshBasename && /\.[A-Za-z0-9]{1,12}$/.test(word)) return true;
    }
  }
  return false;
}

// Re-exports of the private helpers so other modules (engine boundary_probe
// emission, tests) can compose with the same logic. Names with `Public` suffix
// are intentional: they are part of the module's public surface.
export const findFreshInputCopyTargetPublic = findFreshInputCopyTarget;
export const collectPreviouslyVerifiedInputBasenamesPublic = collectPreviouslyVerifiedInputBasenames;
export const isRenamedCopyPublic = isRenamedCopy;
export const isProducerExecutedOnFreshInputPublic = isProducerExecutedOnFreshInput;
export const isSuccessfulFreshBoundaryCheckPublic = isSuccessfulFreshBoundaryCheck;
export const hasConventionalSingleItemInvocationPublic = hasConventionalSingleItemInvocation;
export const requiresConventionalSingleItemBoundaryPublic = requiresConventionalSingleItemBoundary;

function extractProducerExecutable(command: string): string | undefined {
  const segments = splitUnquotedShellSegmentsLocal(command);
  for (const segment of segments) {
    if (/^(?:cp|copy|ln|rm|mkdir|mktemp|test|grep|jq|diff|cmp|cat|echo|printf|python3?\s+-c|node\s+-e)\b/i.test(segment)) continue;
    const words = parseShellWordsLocal(segment).map(stripShellQuoting);
    if (words.length < 2) continue;
    const executable = words[0] ?? "";
    if (!/^(?:\.\/|[A-Za-z0-9_.-]+\/)|^(?:python3?|node|ruby|perl|bash|sh)$/i.test(executable)) continue;
    return executable;
  }
  return undefined;
}

function extractCleanOutputDir(command: string): string | undefined {
  const segments = splitUnquotedShellSegmentsLocal(command);
  for (const segment of segments) {
    const m = /(?:\.\/|\/)?([A-Za-z0-9_./-]*?(?:tmp|temp|scratch|probe)[A-Za-z0-9_./-]*)/i.exec(segment);
    if (m && m[1]) return m[1];
  }
  return undefined;
}

function inferRenamedFrom(freshInput: string, priorBasenames: Set<string>): string | undefined {
  const freshBase = basenameOf(freshInput);
  for (const prior of priorBasenames) {
    if (prior && prior !== freshBase) return prior;
  }
  return undefined;
}

export const extractProducerExecutablePublic = extractProducerExecutable;
export const extractCleanOutputDirPublic = extractCleanOutputDir;
export const inferRenamedFromPublic = inferRenamedFrom;

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
}

function isLikelyTaskServiceHost(host: string): boolean {
  return !host.includes(".") || host.endsWith(".local") || host.endsWith(".internal");
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}
