import type { RepoInspection } from "./repo-inspection.js";

export interface TaskContract {
  userGoal: string;
  deliverables: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  forbiddenActions: string[];
  likelyValidation: string[];
}

type TaskKind = "implementation" | "bugfix" | "refactor" | "docs" | "readonly";

const DEFAULT_CONSTRAINTS = [
  "Preserve existing behavior unless the request explicitly asks for a behavior change.",
  "Keep changes focused on the requested task.",
];

const DEFAULT_FORBIDDEN_ACTIONS = ["Do not remove unrelated behavior.", "Do not fake verification."];

const ACTION_VERBS = [
  "add",
  "build",
  "create",
  "document",
  "enable",
  "extract",
  "fix",
  "implement",
  "improve",
  "make",
  "refactor",
  "repair",
  "support",
  "update",
  "write",
];

export function extractTaskContract(request: string, repoInspection?: RepoInspection): TaskContract {
  const intent = extractUserIntentText(request);
  const userGoal = normalizeWhitespace(intent) || "Unspecified user request";
  const taskKind = classifyTask(userGoal);
  const deliverables = extractDeliverables(userGoal, taskKind);

  return {
    userGoal,
    deliverables,
    constraints: unique([...DEFAULT_CONSTRAINTS, ...extractConstraints(userGoal)]),
    acceptanceCriteria: buildAcceptanceCriteria(taskKind, deliverables),
    forbiddenActions: unique([...DEFAULT_FORBIDDEN_ACTIONS, ...extractForbiddenActions(userGoal)]),
    likelyValidation: suggestValidation(userGoal, taskKind, repoInspection),
  };
}

/**
 * Strip harness-injected environment preambles so the contract reflects the
 * user's actual request. The exec runner wraps prompts as:
 *   [exec environment ...]\n...\n[end exec environment]\n\nUser prompt:\n<intent>
 * Deliverables extracted from that boilerplate poison the model's view of
 * intent (e.g. a forbidden action parsed as a deliverable).
 */
export function extractUserIntentText(request: string): string {
  const promptMarker = /(?:^|\n)\s*User prompt:\s*\n?/i.exec(request);
  if (promptMarker) {
    const after = request.slice(promptMarker.index + promptMarker[0].length).trim();
    if (after) return after;
  }
  const withoutEnvBlocks = request.replace(/\[(?:exec|end exec) environment[^\]]*\]/gi, "");
  return withoutEnvBlocks.trim() || request;
}

export function renderTaskContractForCockpit(contract: TaskContract): string {
  return [
    "# Task Contract",
    `User goal: ${contract.userGoal}`,
    `Deliverables: ${renderList(contract.deliverables)}`,
    `Constraints: ${renderList(contract.constraints)}`,
    `Acceptance criteria: ${renderList(contract.acceptanceCriteria)}`,
    `Forbidden actions: ${renderList(contract.forbiddenActions)}`,
    `Likely validation: ${renderList(contract.likelyValidation)}`,
  ].join("\n");
}

function classifyTask(request: string): TaskKind {
  const lower = request.toLowerCase();
  if (/\b(read[- ]only|inspect|analy[sz]e|explain|review|plan)\b/.test(lower) && !hasImplementationVerb(lower)) return "readonly";
  if (/\b(docs?|documentation|readme|changelog)\b/.test(lower) && !/\b(code|implement|fix|bug|refactor|runtime|tests?)\b/.test(lower)) return "docs";
  if (/\b(fix|bug|bugfix|regression|repair|broken|crash|failing|failure)\b/.test(lower)) return "bugfix";
  if (/\b(refactor|cleanup|clean up|restructure|simplify)\b/.test(lower)) return "refactor";
  return "implementation";
}

function hasImplementationVerb(lower: string): boolean {
  return /\b(add|build|create|enable|extract|fix|implement|improve|make|refactor|repair|support|update|write)\b/.test(lower);
}

function extractDeliverables(request: string, taskKind: TaskKind): string[] {
  const clauses = request
    // Split on newlines, semicolons, list dashes, and sentence-ending periods.
    // A period directly between non-space characters (marker.txt, v1.2) is
    // part of a token, not a clause boundary.
    .split(/(?:\n+|;|[.](?=\s|$)|(?:\s+-\s+))/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
  const deliverables: string[] = [];

  for (const clause of clauses) {
    const match = new RegExp(`\\b(${ACTION_VERBS.join("|")})\\b\\s+(.*)`, "i").exec(clause);
    if (!match) continue;
    const verb = match[1];
    const target = cleanDeliverableTarget(match[2] ?? "");
    if (!target) continue;
    deliverables.push(`${capitalize(verb)} ${target}`);
  }

  if (deliverables.length > 0) return unique(deliverables);

  if (taskKind === "bugfix") return ["Fix the reported bug."];
  if (taskKind === "refactor") return ["Refactor the requested code while preserving behavior."];
  if (taskKind === "docs") return ["Update the requested documentation."];
  if (taskKind === "readonly") return ["Provide the requested analysis without modifying files."];
  return ["Implement the requested change."];
}

function cleanDeliverableTarget(target: string): string {
  return normalizeWhitespace(target)
    .replace(/^(?:a|an|the)\s+/i, "")
    .replace(/\s+(?:while|without|unless|but do not|do not|and do not)\b.*$/i, "")
    .replace(/\s+(?:with|using)\s+tests?\b.*$/i, "")
    .replace(/[,:]\s*$/g, "");
}

function extractConstraints(request: string): string[] {
  const constraints: string[] = [];
  const lower = request.toLowerCase();

  if (/\bpreserve\b|\bbehavior-preserving\b|\bdo not rewrite\b|\bdon't rewrite\b/.test(lower)) {
    constraints.push("Honor requested behavior-preservation constraints.");
  }
  if (/\bwithout\b/.test(lower)) constraints.push("Respect any requested 'without' constraints.");
  if (/\bsmall\b|\bfocused\b|\bminimal\b/.test(lower)) constraints.push("Keep the change small and focused.");
  if (/\bread[- ]only\b|\bdo not modify\b|\bdon't modify\b|\bno edits\b/.test(lower)) constraints.push("Do not modify files for read-only work.");

  return constraints;
}

function extractForbiddenActions(request: string): string[] {
  const forbidden: string[] = [];
  const doNotMatches = request.match(/\b(?:do not|don't|never)\s+[^.;\n]+/gi) ?? [];
  for (const item of doNotMatches) {
    forbidden.push(sentenceCase(item.replace(/^don't\b/i, "do not")));
  }
  return forbidden;
}

function buildAcceptanceCriteria(taskKind: TaskKind, deliverables: string[]): string[] {
  const criteria = ["All requested deliverables are addressed.", "Verification is run, or any skipped verification is explicitly reported."];

  if (taskKind === "bugfix") {
    criteria.unshift("The reported bug is fixed or the behavioral cause is clearly identified.");
    criteria.push("A regression test or targeted validation covers the bug when feasible.");
  } else if (taskKind === "refactor") {
    criteria.unshift("Behavior remains unchanged except where the request explicitly asks otherwise.");
  } else if (taskKind === "docs") {
    criteria.unshift("Documentation changes are accurate and scoped to the request.");
  } else if (taskKind === "readonly") {
    criteria.unshift("The response answers the request without changing workspace files.");
  } else if (deliverables.some((deliverable) => /\bbuild\b/i.test(deliverable))) {
    criteria.unshift("The requested build-related workflow is implemented or updated.");
  }

  return unique(criteria);
}

function suggestValidation(request: string, taskKind: TaskKind, repoInspection: RepoInspection | undefined): string[] {
  if (taskKind === "readonly") return [];
  if (taskKind === "docs") return ["Review documentation changes for accuracy."];
  if (!repoInspection) return [];

  const lower = request.toLowerCase();
  const commands: string[] = [];

  if (taskKind === "bugfix" || taskKind === "refactor" || taskKind === "implementation") {
    commands.push(...repoInspection.testCommands);
  }
  if (taskKind === "refactor" || taskKind === "implementation" || /\b(build|compile|typecheck|typescript|full[- ]stack)\b/.test(lower)) {
    commands.push(...repoInspection.buildCommands);
  }
  if (taskKind === "refactor" || /\b(lint|format|style|cleanup|clean up)\b/.test(lower)) {
    commands.push(...repoInspection.lintCommands);
  }

  return unique(commands);
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function capitalize(value: string | undefined): string {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function sentenceCase(value: string): string {
  const normalized = normalizeWhitespace(value);
  return normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}.` : normalized;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function renderList(values: string[]): string {
  return values.length ? values.join(", ") : "none";
}
