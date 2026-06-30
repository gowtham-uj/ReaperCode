import type { ToolResult } from "../tools/types.js";
import { classifyVerificationOutput } from "../verify/failure-classifier.js";

export interface RescueHypothesis {
  id: string;
  cause: string;
  evidence: string[];
  discriminatingCheck: string;
  status: "untested" | "supported" | "rejected";
}

export interface RescueHypothesisLedger {
  problemStatement: string;
  hypotheses: RescueHypothesis[];
}

export function buildRescueHypothesisLedger(results: ToolResult[]): RescueHypothesisLedger {
  const failures = results.filter((result) => !result.ok).slice(-6);
  const text = failures.map(renderFailure).join("\n\n");
  const classification = classifyVerificationOutput(text || "unknown failure");
  const hypotheses = classification.classes.slice(0, 5).map((failureClass, index) => ({
    id: `H${index + 1}`,
    cause: hypothesisCause(failureClass),
    evidence: classification.facts.filter((fact) => fact.trim()).slice(0, 3),
    discriminatingCheck: discriminatingCheck(failureClass),
    status: "untested" as const,
  }));
  if (hypotheses.length === 0) {
    hypotheses.push({
      id: "H1",
      cause: "The latest failure is caused by an unresolved implementation or environment contract.",
      evidence: text ? [text.slice(-800)] : [],
      discriminatingCheck: "Run the smallest command that reproduces the latest failure and isolates one subsystem.",
      status: "untested",
    });
  }
  return {
    problemStatement: classification.facts[0] ?? failures.at(-1)?.error?.message?.slice(0, 500) ?? "Latest blocker is not yet localized.",
    hypotheses,
  };
}

export function renderRescueHypothesisLedger(results: ToolResult[]): string {
  return [
    "# Rescue Hypothesis Ledger",
    "Before editing, select one hypothesis and run its discriminating check. Every rescue turn must support, reject, or revise a hypothesis from new evidence; do not repeat the prior strategy with different wording.",
    JSON.stringify(buildRescueHypothesisLedger(results)),
  ].join("\n");
}

function hypothesisCause(failureClass: string): string {
  const causes: Record<string, string> = {
    missing_artifact: "The intended producer never ran successfully, wrote to the wrong path, or produced incomplete deliverables.",
    external_service: "The required service is absent, crashed, misconfigured, or running but not ready from the task-facing network.",
    exact_output_mismatch: "The producer is nondeterministic or implements a different output contract than the strict verifier expects.",
    assertion_failure: "The implementation behavior diverges from an explicit acceptance invariant.",
    compile_error: "The active build path contains an API, include, type, or linker incompatibility.",
    build_config: "The build is invoked from the wrong source root or its declared targets/inputs are incomplete.",
    missing_dependency: "The active runtime or build environment lacks a required dependency.",
    environment_missing: "The requested execution environment was not materialized or selected.",
    timeout: "The workflow is blocked on an unready service, unbounded operation, or excessive work.",
  };
  return causes[failureClass] ?? `The ${failureClass.replace(/_/g, " ")} failure reflects an unresolved task contract.`;
}

function discriminatingCheck(failureClass: string): string {
  const checks: Record<string, string> = {
    missing_artifact: "Identify the intended producer command, run it once, then strictly validate the exact required paths and contents.",
    external_service: "Inspect service status and logs, then use a bounded task-facing readiness probe; running alone is not ready.",
    exact_output_mismatch: "Run the strict comparator against one deterministic sample and inspect expected-versus-actual data at the first divergence.",
    assertion_failure: "Run only the first failing assertion with full diagnostics and trace its inputs to the responsible producer.",
    compile_error: "Run the narrowest build target and patch the first compiler/linker diagnostic before addressing later errors.",
    build_config: "Locate the authoritative build manifest and configure from that source root into a clean task-local build directory.",
    missing_dependency: "Prove the missing import/tool in the active environment, then repair only that environment or manifest.",
    environment_missing: "List/select the requested environment and execute one import/runtime check inside it.",
    timeout: "Run a bounded narrow probe and inspect process/service logs to distinguish waiting, crash, and excessive computation.",
  };
  return checks[failureClass] ?? "Run one bounded reproduction that can falsify the current root-cause hypothesis.";
}

function renderFailure(result: ToolResult): string {
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  const command = typeof args.cmd === "string" ? args.cmd : "";
  return `${result.name} ${command}\n${result.error?.message ?? ""}`.slice(0, 5000);
}
