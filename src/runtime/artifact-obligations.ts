import type { ToolResult } from "../tools/types.js";

export type ArtifactObligationState = "required" | "producer_created" | "produced" | "contract_verified";

export interface ArtifactObligation {
  path: string;
  source: "task_contract" | "runtime_failure";
  state: ArtifactObligationState;
  producerEvidence?: string;
  productionEvidence?: string;
  verificationEvidence?: string;
}

export interface ArtifactObligationLedger {
  obligations: ArtifactObligation[];
  complete: number;
  total: number;
}

export function buildArtifactObligationLedger(prompt: string, results: ToolResult[]): ArtifactObligationLedger {
  const requested = extractRequestedArtifactPaths(prompt).map((path) => ({ path, source: "task_contract" as const, index: -1 }));
  const failed = results.flatMap((result, index) =>
    extractMissingArtifactPaths(result).map((path) => ({ path, source: "runtime_failure" as const, index })),
  );
  const required = dedupeObligations([...requested, ...failed]);
  const obligations = required.map((requirement) => evaluateArtifactObligation(requirement, results));
  return {
    obligations,
    complete: obligations.filter((item) => item.state === "contract_verified").length,
    total: obligations.length,
  };
}

export function getArtifactObligationBlocker(prompt: string, results: ToolResult[]): string | undefined {
  const ledger = buildArtifactObligationLedger(prompt, results);
  const incomplete = ledger.obligations.filter((item) => item.state !== "contract_verified");
  if (incomplete.length === 0) return undefined;
  const preview = incomplete
    .slice(0, 6)
    .map((item) => `${item.path} (${item.state.replace(/_/g, " ")})`)
    .join("; ");
  return (
    `Completion is blocked because ${incomplete.length}/${ledger.total} required artifact obligation(s) lack producer-to-contract verification: ${preview}. ` +
    "Create each artifact through its intended producer, then run a strict content/schema/behavior check or an authoritative test suite. File existence, directory listings, and print-only checks are insufficient."
  );
}

export function renderArtifactObligationLedger(prompt: string, results: ToolResult[]): string {
  const ledger = buildArtifactObligationLedger(prompt, results);
  if (ledger.total === 0) return "# Artifact Obligation Ledger\nnone";
  return [
    "# Artifact Obligation Ledger",
    "Every required deliverable must move through producer evidence, production evidence, and strict contract verification before completion.",
    JSON.stringify(ledger),
  ].join("\n");
}

function evaluateArtifactObligation(
  requirement: { path: string; source: ArtifactObligation["source"]; index: number },
  results: ToolResult[],
): ArtifactObligation {
  const later = results.slice(requirement.index + 1);
  const producer = later.find((result) => isSuccessfulProducerForArtifact(result, requirement.path));
  const producerIndex = producer ? results.indexOf(producer) : requirement.index;
  const afterProducer = results.slice(producerIndex + 1);
  const production = afterProducer.find((result) => isSuccessfulArtifactObservation(result, requirement.path));
  const verification =
    (producer && isSuccessfulArtifactContractVerification(producer, requirement.path) ? producer : undefined) ??
    afterProducer.find((result) => isSuccessfulArtifactContractVerification(result, requirement.path));

  const state: ArtifactObligationState = verification
    ? "contract_verified"
    : production
      ? "produced"
      : producer
        ? "producer_created"
        : "required";
  return {
    path: requirement.path,
    source: requirement.source,
    state,
    ...(producer ? { producerEvidence: summarizeEvidence(producer) } : {}),
    ...(production ? { productionEvidence: summarizeEvidence(production) } : {}),
    ...(verification ? { verificationEvidence: summarizeEvidence(verification) } : {}),
  };
}

function isSuccessfulProducerForArtifact(result: ToolResult, artifact: string): boolean {
  if (!result.ok) return false;
  const args = recordArgs(result);
  if (["write_file", "replace_in_file", "edit_file", ].includes(result.name)) {
    return typeof args.path === "string" && artifactPathMatches(args.path, artifact);
  }
  if (result.name !== "bash") return false;
  const command = commandOf(result);
  return commandMentionsArtifact(command, artifact) && isProducerCommand(command);
}

function isSuccessfulArtifactObservation(result: ToolResult, artifact: string): boolean {
  if (!result.ok) return false;
  const args = recordArgs(result);
  if (result.name === "read_file" || result.name === "view_file") {
    return typeof args.path === "string" && artifactPathMatches(args.path, artifact);
  }
  if (result.name !== "bash") return false;
  const command = commandOf(result);
  return commandMentionsArtifact(command, artifact) && /\b(?:cat|head|tail|stat|file|test\s+-[efs]|open\s*\(|readFile|read_text)\b/i.test(command);
}

function isSuccessfulArtifactContractVerification(result: ToolResult, artifact: string): boolean {
  if (!result.ok || isSemanticFailure(result)) return false;
  if (result.name !== "bash") return false;
  const command = commandOf(result);
  if (isBroadAuthoritativeTest(command)) return true;
  return commandMentionsArtifact(command, artifact) && isStrictCheck(command);
}

function extractRequestedArtifactPaths(prompt: string): string[] {
  const paths: string[] = [];
  for (const line of prompt.split(/\r?\n/)) {
    for (const match of line.matchAll(/(?:\/app\/|\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,12}/g)) {
      if (!match[0]) continue;
      const prefix = line.slice(0, match.index ?? 0);
      if (!/\b(?:create|write|save|produce|generate|convert|export|render|output|deliver|place|store)\b/i.test(prefix)) continue;
      paths.push(normalizePath(match[0]));
    }
  }
  return unique(paths).filter(isLikelyArtifactPath);
}

function extractMissingArtifactPaths(result: ToolResult): string[] {
  if (result.ok) return [];
  const message = `${result.error?.message ?? ""}`;
  const paths: string[] = [];
  const args = recordArgs(result);
  if (result.name === "read_file" && typeof args.path === "string" && /ENOENT|no such file/i.test(message)) paths.push(args.path);
  for (const pattern of [
    /No such file or directory: ['"]([^'"]+)['"]/gi,
    /FileNotFoundError[^'"\n]*['"]([^'"]+)['"]/gi,
    /(?:file|artifact|output)\s+['"]?([^'"\n ]+)['"]?\s+(?:does not exist|is missing)/gi,
    /ENOENT: no such file or directory, open ['"]([^'"]+)['"]/gi,
  ]) {
    for (const match of message.matchAll(pattern)) {
      if (match[1]) paths.push(match[1]);
    }
  }
  return unique(paths.map(normalizePath).filter(isLikelyArtifactPath));
}

function dedupeObligations(
  obligations: Array<{ path: string; source: ArtifactObligation["source"]; index: number }>,
): Array<{ path: string; source: ArtifactObligation["source"]; index: number }> {
  const output = new Map<string, { path: string; source: ArtifactObligation["source"]; index: number }>();
  for (const obligation of obligations) {
    const key = normalizePath(obligation.path).toLowerCase();
    const previous = output.get(key);
    if (!previous || obligation.source === "runtime_failure") output.set(key, { ...obligation, path: normalizePath(obligation.path) });
  }
  return [...output.values()];
}

function isLikelyArtifactPath(value: string): boolean {
  const path = normalizePath(value);
  if (!path || path.startsWith("/tmp/") || /(?:^|\/)(?:node_modules|\.git|dist|build|coverage)\//.test(path)) return false;
  return /\.[A-Za-z0-9]{1,12}$/.test(path);
}

function isProducerCommand(command: string): boolean {
  return /\b(?:create|write|generate|produce|convert|export|render|serialize|compile|build|cp|mv|tee)\b|>{1,2}/i.test(command);
}

function isStrictCheck(command: string): boolean {
  return (
    isBroadAuthoritativeTest(command) ||
    /\b(?:assert|diff|cmp|grep\s+-q|jq\s+-e|sha1sum|sha256sum|md5sum|test\s+-[efs])\b/i.test(command) ||
    /(?:^|[;&|]\s*)test\s+\S+/i.test(command) ||
    /(?:^|[;&|]\s*)\[\s+/i.test(command) ||
    /\b(?:raise\s+SystemExit|sys\.exit|process\.exit|throw\s+new\s+Error)\b/i.test(command)
  );
}

function isBroadAuthoritativeTest(command: string): boolean {
  return /\b(?:pytest|node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|bun\s+(?:run\s+)?test|go\s+test|cargo\s+test|ctest|mvn\s+test|gradle\s+test)\b/i.test(command);
}

function isSemanticFailure(result: ToolResult): boolean {
  const text = renderOutput(result.output);
  return /\b(?:FAILED|FAILURES|AssertionError|expected\b.*\bactual|mismatch|does not match)\b/i.test(text);
}

function commandMentionsArtifact(command: string, artifact: string): boolean {
  const normalizedCommand = normalizePath(command);
  const normalizedArtifact = normalizePath(artifact);
  const relativeArtifact = normalizedArtifact.replace(/^\/app\//, "");
  return normalizedCommand.includes(normalizedArtifact) || normalizedCommand.includes(relativeArtifact);
}

function artifactPathMatches(candidate: string, artifact: string): boolean {
  const left = normalizePath(candidate).replace(/^\/app\//, "");
  const right = normalizePath(artifact).replace(/^\/app\//, "");
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function commandOf(result: ToolResult): string {
  const args = recordArgs(result);
  return typeof args.cmd === "string" ? args.cmd : "";
}

function recordArgs(result: ToolResult): Record<string, unknown> {
  return result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
}

function summarizeEvidence(result: ToolResult): string {
  return result.name === "bash" ? `${result.name}: ${commandOf(result).slice(0, 300)}` : `${result.name}: ${JSON.stringify(recordArgs(result)).slice(0, 300)}`;
}

function renderOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
