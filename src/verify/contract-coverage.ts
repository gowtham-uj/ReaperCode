import type { ToolResult } from "../tools/types.js";

export interface ContractCoverageRequirement {
  id: string;
  requirement: string;
  evidence: string[];
  covered: boolean;
}

export interface ContractCoverageMatrix {
  requirements: ContractCoverageRequirement[];
  covered: number;
  total: number;
}

export function buildContractCoverageMatrix(prompt: string, results: ToolResult[]): ContractCoverageMatrix {
  const requirements = extractContractRequirements(prompt);
  const successfulChecks = results.filter(isSuccessfulStrictCheck);
  const broadAuthoritativeCheck = successfulChecks.find((result) => isBroadTest(commandOf(result)));
  const rows = requirements.map((requirement, index) => {
    const terms = requirementTerms(requirement);
    const evidence = successfulChecks
      .filter((result) => broadAuthoritativeCheck === result || terms.some((term) => renderResult(result).toLowerCase().includes(term)))
      .map((result) => summarizeCheck(result))
      .slice(0, 3);
    return {
      id: `C${index + 1}`,
      requirement,
      evidence,
      covered: evidence.length > 0,
    };
  });
  return {
    requirements: rows,
    covered: rows.filter((row) => row.covered).length,
    total: rows.length,
  };
}

export function getContractCoverageBlocker(prompt: string, results: ToolResult[]): string | undefined {
  const matrix = buildContractCoverageMatrix(prompt, results);
  if (matrix.total < 2) return undefined;
  const uncovered = matrix.requirements.filter((row) => !row.covered);
  if (uncovered.length === 0) return undefined;
  return (
    `Completion is blocked because ${uncovered.length}/${matrix.total} explicit task-contract requirement(s) have no strict executable evidence: ` +
    `${uncovered.slice(0, 4).map((row) => `${row.id} ${row.requirement.slice(0, 180)}`).join("; ")}. ` +
    "Add or run assertions, invariant/property checks, artifact comparisons, task-facing readiness probes, or an authoritative test suite that covers them."
  );
}

export function renderContractCoverageMatrix(prompt: string, results: ToolResult[]): string {
  const matrix = buildContractCoverageMatrix(prompt, results);
  return matrix.total === 0 ? "# Task Contract Coverage\nnone" : `# Task Contract Coverage\n${JSON.stringify(matrix)}`;
}

function extractContractRequirements(prompt: string): string[] {
  const candidates = prompt
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length >= 12 && line.length <= 600)
    .filter((line) =>
      /\b(?:must|should|ensure|require|acceptance|create|produce|generate|write|save|output|return|support|respond|match|equal|faster|less than|all|every)\b/i.test(line),
    )
    .filter((line) => !/^(?:objective|task|requirements?|acceptance criteria)\s*:?\s*$/i.test(line));
  return [...new Set(candidates)].slice(0, 20);
}

function isSuccessfulStrictCheck(result: ToolResult): boolean {
  if (!result.ok || result.name !== "run_shell_command") return false;
  const command = commandOf(result);
  const output = renderResult(result);
  if (/\b(?:FAILED|FAILURES|AssertionError|mismatch|does not match)\b/i.test(output)) return false;
  return (
    isBroadTest(command) ||
    /\b(?:assert|diff|cmp|grep\s+-q|jq\s+-e|sha1sum|sha256sum|md5sum|test\s+-[efs])\b/i.test(command) ||
    /(?:^|[;&|]\s*)test\s+\S+/i.test(command) ||
    /(?:^|[;&|]\s*)\[\s+/i.test(command) ||
    /\b(?:raise\s+SystemExit|sys\.exit|process\.exit|throw\s+new\s+Error)\b/i.test(command)
  );
}

function isBroadTest(command: string): boolean {
  return /\b(?:pytest|node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|bun\s+(?:run\s+)?test|go\s+test|cargo\s+test|ctest|mvn\s+test|gradle\s+test)\b/i.test(command);
}

function requirementTerms(requirement: string): string[] {
  const paths = [...requirement.matchAll(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,12}/g)].map((match) => match[0]!.toLowerCase());
  const words = requirement
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{3,}/g)
    ?.filter((word) => !STOP_WORDS.has(word))
    .slice(0, 10) ?? [];
  return [...new Set([...paths, ...words])];
}

function commandOf(result: ToolResult): string {
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  return typeof args.cmd === "string" ? args.cmd : "";
}

function summarizeCheck(result: ToolResult): string {
  return `${result.name}: ${commandOf(result).slice(0, 300)}`;
}

function renderResult(result: ToolResult): string {
  let output = "";
  try {
    output = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
  } catch {
    output = String(result.output);
  }
  return `${commandOf(result)}\n${output}`;
}

const STOP_WORDS = new Set([
  "must",
  "should",
  "ensure",
  "require",
  "required",
  "create",
  "produce",
  "generate",
  "write",
  "save",
  "output",
  "return",
  "support",
  "respond",
  "match",
  "equal",
  "every",
  "with",
  "from",
  "that",
  "this",
  "into",
  "when",
  "then",
  "task",
]);
