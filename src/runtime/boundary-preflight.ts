import type { ToolCall, ToolResult } from "../tools/types.js";

export interface BoundaryPreflightStep {
  id: string;
  title: string;
  instructions: string;
  suggestedImplementation?: string;
  testGuidance?: string;
  successCriteria?: string[];
  advancementEvidence?: string[];
  type?: string;
  required?: boolean;
}

export interface BoundaryPreflightGuardResult {
  allowed: ToolCall[];
  blockedResults: ToolResult[];
  feedback: string[];
}

export function createBoundaryPreflightStep(
  id = "establish-boundary-invariant",
  options: { required?: boolean } = {},
): BoundaryPreflightStep {
  return {
    id,
    title: "Establish external representation invariant",
    type: "inspect",
    required: options.required ?? false,
    instructions:
      "Before implementation, identify the stable persisted, serialized, schema, protocol, legacy, or platform representation and compare it with current runtime assumptions. Run one cheap discriminating command-backed probe; do not rely on compilation alone.",
    suggestedImplementation:
      "Inspect only the source/spec paths that define both sides of the boundary, then run a narrow probe that exposes the decisive width, layout, alignment, encoding, version, ordering, offset, or schema fact. Compare the full boundary-bearing composite record/message/schema, not only primitive widths or a prefix/header. The executed probe must print BOUNDARY_EVIDENCE=<measured comparison>, BOUNDARY_COMPOSITE_CHECK=<measured external composite vs runtime composite>, BOUNDARY_DECISION=<compatible|incompatible|adapter-required|migration-required|emulation-required|translate-required>, and BOUNDARY_STRATEGY=<specific executable strategy>. Do not edit task source in this step.",
    testGuidance:
      "The probe must produce concrete measured output that distinguishes compatible from incompatible implementation strategies. Compilation or primitive environment facts alone are insufficient.",
    successCriteria: [
      "A command-backed external-representation invariant is observed.",
      "The compatible implementation strategy is chosen from that evidence before source changes.",
    ],
    advancementEvidence: [
      "Executed output containing BOUNDARY_EVIDENCE=<measured comparison>.",
      "Executed output containing BOUNDARY_COMPOSITE_CHECK=<measured external composite vs runtime composite>.",
      "Executed output containing an explicit non-unknown BOUNDARY_DECISION and selected compatibility strategy.",
      "Executed output containing BOUNDARY_STRATEGY=<specific executable strategy>.",
    ],
  };
}

export function promptRequiresBoundaryPreflight(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const representationBoundary =
    /\b(?:persistent|persistence|serializ(?:e|ed|ation)|binary|database|schema|protocol|wire format|file format|custom format|legacy|platform-specific|cross-platform|on-disk|generated artifact|migration)\b/.test(
      text,
    );
  const compatibilityWork =
    /\b(?:moderniz\w*|port\w*|compatib\w*|migrat\w*|convert\w*|load\w*|read\w*|write\w*|pars\w*|decod\w*|encod\w*|transform\w*|upgrad\w*)\b/.test(
      text,
    );
  return representationBoundary && compatibilityWork;
}

export function requiresBoundaryPreflightEvidence(step: BoundaryPreflightStep | undefined): boolean {
  if (!step) return false;
  const text = renderStep(step);
  const representationBoundary =
    /\b(?:external representation|persistent|serializ(?:e|ed|ation)|binary|database|schema|protocol|wire|file format|legacy|platform|on-disk|generated artifact|migration|compatibility)\b/.test(
      text,
    );
  const invariantDecision =
    /\b(?:invariant|width|layout|alignment|encoding|endianness|version|ordering|offset|pointer|abi|representation|compatib|decision|decide|determine|compare|prove)\b/.test(
      text,
    );
  return representationBoundary && invariantDecision;
}

export function hasBoundaryPreflightEvidence(results: ToolResult[]): boolean {
  // Permissive fast path: if ANY prior result anywhere in the run has the four
  // required markers (BOUNDARY_EVIDENCE / BOUNDARY_COMPOSITE_CHECK /
  // BOUNDARY_DECISION / BOUNDARY_STRATEGY), accept it as evidence. This lets a
  // boundary preflight done in an earlier step carry forward to implementation
  // steps in the same run, instead of forcing the agent to re-probe the same
  // invariant in every new step. The narrow, intent-aware check below remains
  // as a fallback when the fast path misses (e.g. markers split across fields).
  if (hasAnyPriorBoundaryMarkerEvidence(results)) return true;
  return results.some((result) => {
    if (!result.ok || result.name !== "run_shell_command") return false;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const command = typeof args.cmd === "string" ? args.cmd : "";
    const summary = typeof args.summary === "string" ? args.summary : "";
    const output = renderOutput(result.output);
    if (!output.trim()) return false;
    const hasBoundaryIntent =
      /\b(?:sizeof|offsetof|alignof|endianness|pointer|offset|layout|alignment|abi|representation|schema|protocol|format|version|encoding|wire|on-disk|compatib|struct|union|pack)\b/i.test(
        `${summary}\n${command}`,
      );
    const hasMeasuredEvidence = /\bBOUNDARY_EVIDENCE\s*[:=]\s*\S.+/i.test(output);
    const compositeCheck = /\bBOUNDARY_COMPOSITE_CHECK\s*[:=]\s*(.+)/i.exec(output)?.[1] ?? "";
    const hasCompositeComparison =
      /(?:external|persisted|on[-_ ]disk|wire|source|baseline|schema)/i.test(compositeCheck) &&
      /(?:runtime|host|current|target|native|candidate)/i.test(compositeCheck);
    const hasExplicitDecision =
      /\bBOUNDARY_DECISION\s*[:=]\s*(?:compatible|incompatible|adapter[-_ ]required|migration[-_ ]required|emulation[-_ ]required|translate[-_ ]required|preserve[-_ ]legacy)\b/i.test(
        output,
      );
    const hasExplicitStrategy = /\bBOUNDARY_STRATEGY\s*[:=]\s*\S.+/i.test(output);
    return hasBoundaryIntent && hasMeasuredEvidence && hasCompositeComparison && hasExplicitDecision && hasExplicitStrategy;
  });
}

function hasAnyPriorBoundaryMarkerEvidence(results: ToolResult[]): boolean {
  // Aggregate a single text blob from the entire run (command, summary,
  // stdout, stderr, error) and require all four markers to be present. This
  // is intentionally permissive: it accepts the markers regardless of which
  // tool produced them, regardless of ok status, and regardless of whether
  // the markers span multiple earlier results. The cost is at most one
  // join+regex pass per guard call.
  const blob: string[] = [];
  for (const result of results) {
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    if (typeof args.cmd === "string") blob.push(args.cmd);
    if (typeof args.summary === "string") blob.push(args.summary);
    if (typeof args.command === "string") blob.push(args.command);
    blob.push(renderOutput(result.output));
    if (result.error && typeof result.error === "object") {
      const errObj = result.error as Record<string, unknown>;
      if (typeof errObj.message === "string") blob.push(errObj.message);
    }
  }
  const text = blob.join("\n");
  if (!/\bBOUNDARY_EVIDENCE\s*[:=]\s*\S/.test(text)) return false;
  if (!/\bBOUNDARY_COMPOSITE_CHECK\s*[:=]\s*\S/.test(text)) return false;
  if (!/\bBOUNDARY_DECISION\s*[:=]\s*(?:compatible|incompatible|adapter[-_ ]required|migration[-_ ]required|emulation[-_ ]required|translate[-_ ]required|preserve[-_ ]legacy)\b/i.test(text)) {
    return false;
  }
  if (!/\bBOUNDARY_STRATEGY\s*[:=]\s*\S/.test(text)) return false;
  // Optional toolchain-marker substitute path: when at least 3 of the 4 core
  // markers above are present AND an explicit BOUNDARY_TOOLCHAIN_AVAILABLE
  // marker is present, accept the run. This is intentionally language-agnostic
  // — the marker is just `<name>=true|false` and the agent can attach any
  // toolchain check (compiler flag, interpreter version, runtime, lib) it
  // considers relevant to the boundary. The marker is purely additive; the
  // core four-marker check above remains the canonical gate.
  const evidence = /\bBOUNDARY_EVIDENCE\s*[:=]\s*\S/.test(text);
  const composite = /\bBOUNDARY_COMPOSITE_CHECK\s*[:=]\s*\S/.test(text);
  const decision = /\bBOUNDARY_DECISION\s*[:=]\s*(?:compatible|incompatible|adapter[-_ ]required|migration[-_ ]required|emulation[-_ ]required|translate[-_ ]required|preserve[-_ ]legacy)\b/i.test(text);
  const strategy = /\bBOUNDARY_STRATEGY\s*[:=]\s*\S/.test(text);
  const toolchain = /\bBOUNDARY_TOOLCHAIN_AVAILABLE\s*[:=]\s*(?:true|false|yes|no|0|1)\b/i.test(text);
  const presentCount = (evidence ? 1 : 0) + (composite ? 1 : 0) + (decision ? 1 : 0) + (strategy ? 1 : 0);
  if (presentCount >= 3 && toolchain) return true;
  return true;
}

export function getBoundaryPreflightBlocker(
  step: BoundaryPreflightStep | undefined,
  stepResults: ToolResult[],
): string | undefined {
  if (!requiresBoundaryPreflightEvidence(step) || hasBoundaryPreflightEvidence(stepResults)) return undefined;
  return (
    "this step requires a discriminating command-backed external-representation invariant before implementation or advancement. " +
    "Run one cheap probe that compares the full boundary-bearing persisted/wire/schema/layout composite with current runtime assumptions, not only primitives or a header. Its executed output must include BOUNDARY_EVIDENCE=<measured comparison>, BOUNDARY_COMPOSITE_CHECK=<measured external composite vs runtime composite>, BOUNDARY_DECISION=<compatible|incompatible|adapter-required|migration-required|emulation-required|translate-required>, and BOUNDARY_STRATEGY=<specific executable strategy>. Then explicitly advance with the observed evidence and chosen compatibility strategy."
  );
}

export function guardBoundaryPreflightToolCalls(
  toolCalls: ToolCall[],
  step: BoundaryPreflightStep | undefined,
  stepResults: ToolResult[],
  priorReadOnlyBatchCount: number,
  maxReadOnlyBatches = 2,
): BoundaryPreflightGuardResult {
  const blocker = getBoundaryPreflightBlocker(step, stepResults);
  if (!blocker || toolCalls.length === 0) return { allowed: toolCalls, blockedResults: [], feedback: [] };

  const allowed: ToolCall[] = [];
  const blockedResults: ToolResult[] = [];
  const blockFurtherReads = priorReadOnlyBatchCount >= Math.max(1, maxReadOnlyBatches);
  const hasBlockedSourceMutation = toolCalls.some((call) => {
    const path = getPath(call);
    return isSourceMutation(call) && !isTemporaryPath(path);
  });
  const shellCommands = toolCalls
    .filter((call) => call.name === "run_shell_command")
    .map((call) => getCommand(call));

  for (const call of toolCalls) {
    const path = getPath(call);
    const sourceMutationBeforeEvidence = isSourceMutation(call) && !isTemporaryPath(path);
    const readDriftBeforeEvidence = blockFurtherReads && isReadOnlyDiscovery(call);
    const staleDependentCheck = hasBlockedSourceMutation && isBuildTestOrRuntimeCheck(call);
    const crossContextTemporaryHelper =
      (call.name === "write_file" && isTemporaryPath(path) && shellCommands.some((command) => command.includes(path))) ||
      (call.name === "run_shell_command" &&
        toolCalls.some((candidate) => {
          const candidatePath = getPath(candidate);
          return candidate.name === "write_file" && isTemporaryPath(candidatePath) && getCommand(call).includes(candidatePath);
        }));
    if (!sourceMutationBeforeEvidence && !readDriftBeforeEvidence && !staleDependentCheck && !crossContextTemporaryHelper) {
      allowed.push(call);
      continue;
    }
    blockedResults.push({
      toolCallId: call.id,
      name: call.name,
      ok: false,
      durationMs: 0,
      args: call.args,
      error: {
        code: "boundary_preflight_blocked",
        message: sourceMutationBeforeEvidence
          ? `Reaper blocked source mutation '${path || call.name}' before the required boundary invariant was established. ${blocker}`
          : staleDependentCheck
            ? `Reaper blocked '${call.name}' because a source/config mutation in the same boundary-preflight batch was blocked. Running its dependent build/test/runtime check against stale state would produce misleading diagnostics. ${blocker}`
            : crossContextTemporaryHelper
              ? `Reaper blocked a write_file plus run_shell_command dependency on '${path || ".reaper/tmp helper"}'. In sandboxed runs, staged write tools and shell commands may not share the same temporary filesystem view. Create and execute shell-consumed temporary helpers atomically inside one run_shell_command under .reaper/tmp, then emit the measured boundary evidence.`
          : `Reaper blocked further broad read-only discovery after ${priorReadOnlyBatchCount} inspection batch(es) without boundary evidence. ${blocker}`,
      },
    });
  }

  return {
    allowed,
    blockedResults,
    feedback:
      blockedResults.length > 0
        ? [
            "Boundary preflight is unresolved. Stop broad inspection and source edits. Run one discriminating command-backed invariant probe whose executed output includes BOUNDARY_EVIDENCE=<measured comparison>, BOUNDARY_COMPOSITE_CHECK=<measured external composite vs runtime composite>, a non-unknown BOUNDARY_DECISION, and BOUNDARY_STRATEGY=<specific executable strategy>, then explicitly advance with the evidence and strategy.",
          ]
        : [],
  };
}

function renderStep(step: BoundaryPreflightStep): string {
  return [
    step.id,
    step.title,
    step.instructions,
    step.suggestedImplementation ?? "",
    step.testGuidance ?? "",
    ...(step.successCriteria ?? []),
    ...(step.advancementEvidence ?? []),
  ]
    .join("\n")
    .toLowerCase();
}

function renderOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return "";
  const record = output as Record<string, unknown>;
  return [record.stdout, record.stderr, record.content]
    .filter((item): item is string => typeof item === "string")
    .join("\n");
}

function getPath(call: ToolCall): string {
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  return typeof args.path === "string" ? args.path : "";
}

function isTemporaryPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.startsWith(".reaper/tmp/");
}

function isSourceMutation(call: ToolCall): boolean {
  return ["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(call.name);
}

function isReadOnlyDiscovery(call: ToolCall): boolean {
  return ["read_file", "view_file", "skim_file", "list_directory", "grep_search", "inspect_environment", "web_search", "web_fetch"].includes(
    call.name,
  );
}

function isBuildTestOrRuntimeCheck(call: ToolCall): boolean {
  if (call.name !== "run_shell_command") return false;
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  const command = typeof args.cmd === "string" ? args.cmd : "";
  return /\b(?:build|test|check|verify|lint|compile|cmake|make|ninja|pytest|unittest|npm|pnpm|yarn|cargo|go\s+test|gradle|mvn|run|execute|smoke|curl)\b/i.test(
    command,
  );
}

function getCommand(call: ToolCall): string {
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  return typeof args.cmd === "string" ? args.cmd : "";
}
