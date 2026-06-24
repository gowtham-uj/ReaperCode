/**
 * planner/schema.ts — the typed plan schema that the Planner and
 * Replanner sub-agents produce. The shape is the contract Reaper uses
 * to drive the executor; both sub-agents must return a value that
 * conforms to this schema, and validation rejects anything that does
 * not. See docs/planner.md for the schema in human-readable form.
 *
 * The schema is intentionally narrow:
 *   - task_type / complexity / confidence give the executor a one-line
 *     picture of the task before it reads anything else.
 *   - needs_decomposition / needs_initial_inspection let the executor
 *     short-circuit on simple work.
 *   - plan[].type ∈ {inspection, implementation, test, documentation,
 *     verification, cleanup} mirrors the user-facing verbs the
 *     executor already understands.
 *   - depends_on / suggested_tools / suggested_files are hints only —
 *     the executor inspects the repo and may override.
 *   - verification_strategy + done_definition are the contract the
 *     completion gate uses. complete_task still requires the executor
 *     to have actually run a real command; the plan only describes what
 *     the executor *should* do.
 *
 * The validators below are pure (no I/O) so they can be unit-tested
 * and reused by both sub-agents.
 */

export type TaskType =
  | "from_scratch_project"
  | "existing_project_change"
  | "bug_fix"
  | "refactor"
  | "test_addition"
  | "docs_only"
  | "inspection_only"
  | "research_then_implementation"
  | "unknown";

export type Complexity = "low" | "medium" | "high";
export type Confidence = "low" | "medium" | "high";

export type PlanStepType =
  | "inspection"
  | "implementation"
  | "test"
  | "documentation"
  | "verification"
  | "cleanup";

export interface PlanStep {
  id: string;
  title: string;
  goal: string;
  type: PlanStepType;
  depends_on: string[];
  suggested_tools: string[];
  suggested_files: string[];
  success_criteria: string[];
  failure_signals: string[];
}

export interface VerificationStrategy {
  required: boolean;
  commands: string[];
  success_signal: string;
  minimum_evidence: string[];
}

export interface PlannerPlan {
  task_summary: string;
  task_type: TaskType;
  complexity: Complexity;
  needs_decomposition: boolean;
  needs_initial_inspection: boolean;
  confidence: Confidence;
  assumptions: string[];
  ambiguities: string[];
  risks: string[];
  plan: PlanStep[];
  verification_strategy: VerificationStrategy;
  done_definition: string[];
  executor_guidance: string[];
}

const TASK_TYPES = new Set<TaskType>([
  "from_scratch_project",
  "existing_project_change",
  "bug_fix",
  "refactor",
  "test_addition",
  "docs_only",
  "inspection_only",
  "research_then_implementation",
  "unknown",
]);

const COMPLEXITIES = new Set<Complexity>(["low", "medium", "high"]);
const CONFIDENCES = new Set<Confidence>(["low", "medium", "high"]);
const STEP_TYPES = new Set<PlanStepType>([
  "inspection",
  "implementation",
  "test",
  "documentation",
  "verification",
  "cleanup",
]);

export class PlannerSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerSchemaError";
  }
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PlannerSchemaError(`Field '${path}' must be a non-empty string`);
  }
  return value;
}

function asOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new PlannerSchemaError(`Field '${path}' must be a string when present`);
  }
  return value;
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new PlannerSchemaError(`Field '${path}' must be an array of strings`);
  }
  return value.map((item, idx) => asString(item, `${path}[${idx}]`));
}

function asEnum<T extends string>(
  value: unknown,
  set: Set<T>,
  path: string,
  label: string,
): T {
  if (typeof value !== "string" || !set.has(value as T)) {
    throw new PlannerSchemaError(
      `Field '${path}' must be one of [${[...set].join(", ")}] (got ${JSON.stringify(value)})`,
    );
  }
  return value as T;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new PlannerSchemaError(`Field '${path}' must be a boolean`);
  }
  return value;
}

function validateStep(raw: unknown, index: number): PlanStep {
  const path = `plan[${index}]`;
  if (!raw || typeof raw !== "object") {
    throw new PlannerSchemaError(`Field '${path}' must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const id = asString(obj.id, `${path}.id`);
  const title = asString(obj.title, `${path}.title`);
  const goal = asString(obj.goal, `${path}.goal`);
  const type = asEnum(obj.type, STEP_TYPES, `${path}.type`, "PlanStepType");
  const depends_on = asStringArray(obj.depends_on ?? [], `${path}.depends_on`);
  const suggested_tools = asStringArray(
    obj.suggested_tools ?? [],
    `${path}.suggested_tools`,
  );
  const suggested_files = asStringArray(
    obj.suggested_files ?? [],
    `${path}.suggested_files`,
  );
  const success_criteria = asStringArray(
    obj.success_criteria ?? [],
    `${path}.success_criteria`,
  );
  const failure_signals = asStringArray(
    obj.failure_signals ?? [],
    `${path}.failure_signals`,
  );
  return {
    id,
    title,
    goal,
    type,
    depends_on,
    suggested_tools,
    suggested_files,
    success_criteria,
    failure_signals,
  };
}

function validateVerificationStrategy(raw: unknown): VerificationStrategy {
  const path = "verification_strategy";
  if (!raw || typeof raw !== "object") {
    throw new PlannerSchemaError(`Field '${path}' must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  return {
    required: asBoolean(obj.required, `${path}.required`),
    commands: asStringArray(obj.commands ?? [], `${path}.commands`),
    success_signal: asString(
      obj.success_signal,
      `${path}.success_signal`,
    ),
    minimum_evidence: asStringArray(
      obj.minimum_evidence ?? [],
      `${path}.minimum_evidence`,
    ),
  };
}

/**
 * Validate a parsed Planner / Replanner JSON object against the typed
 * plan schema. Throws {@link PlannerSchemaError} on the first
 * structural failure. Pure — does not perform any I/O.
 */
export function validatePlannerPlan(raw: unknown): PlannerPlan {
  if (!raw || typeof raw !== "object") {
    throw new PlannerSchemaError("Planner plan must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const task_summary = asString(obj.task_summary, "task_summary");
  const task_type = asEnum(
    obj.task_type,
    TASK_TYPES,
    "task_type",
    "TaskType",
  );
  const complexity = asEnum(
    obj.complexity,
    COMPLEXITIES,
    "complexity",
    "Complexity",
  );
  const needs_decomposition = asBoolean(
    obj.needs_decomposition,
    "needs_decomposition",
  );
  const needs_initial_inspection = asBoolean(
    obj.needs_initial_inspection,
    "needs_initial_inspection",
  );
  const confidence = asEnum(
    obj.confidence,
    CONFIDENCES,
    "confidence",
    "Confidence",
  );

  const planRaw = obj.plan;
  if (!Array.isArray(planRaw)) {
    throw new PlannerSchemaError("Field 'plan' must be an array of steps");
  }
  const plan = planRaw.map((step, idx) => validateStep(step, idx));

  const verification_strategy = validateVerificationStrategy(
    obj.verification_strategy,
  );
  const done_definition = asStringArray(
    obj.done_definition ?? [],
    "done_definition",
  );
  const executor_guidance = asStringArray(
    obj.executor_guidance ?? [],
    "executor_guidance",
  );

  const assumptions = asStringArray(obj.assumptions ?? [], "assumptions");
  const ambiguities = asStringArray(obj.ambiguities ?? [], "ambiguities");
  const risks = asStringArray(obj.risks ?? [], "risks");

  // Light semantic checks that aren't covered by per-field validation.
  if (plan.length === 0 && needs_decomposition) {
    throw new PlannerSchemaError(
      "needs_decomposition=true requires plan to contain at least one step",
    );
  }
  if (task_type === "inspection_only") {
    const hasEditStep = plan.some(
      (step) => step.type === "implementation" || step.type === "cleanup",
    );
    if (hasEditStep) {
      throw new PlannerSchemaError(
        "task_type=inspection_only must not include implementation or cleanup steps",
      );
    }
  }
  if (task_type === "docs_only") {
    const hasTestStep = plan.some(
      (step) => step.type === "test" && step.success_criteria.length > 0,
    );
    // docs_only may include a verification step (docs build, lint) but
    // should not include test-execution steps unless the user asked for
    // them. We allow verification steps here because docs CI is common.
    if (hasTestStep) {
      throw new PlannerSchemaError(
        "task_type=docs_only must not include test-execution steps",
      );
    }
  }
  // Step ids must be unique and referenced by depends_on.
  const ids = new Set<string>();
  for (const step of plan) {
    if (ids.has(step.id)) {
      throw new PlannerSchemaError(`Duplicate plan step id: '${step.id}'`);
    }
    ids.add(step.id);
  }
  for (const step of plan) {
    for (const dep of step.depends_on) {
      if (!ids.has(dep)) {
        throw new PlannerSchemaError(
          `Step '${step.id}' depends on unknown step '${dep}'`,
        );
      }
    }
  }

  // Behavior-changing task types must include a test or verification step.
  const behaviorChanging = new Set<TaskType>([
    "from_scratch_project",
    "existing_project_change",
    "bug_fix",
    "refactor",
    "test_addition",
    "research_then_implementation",
  ]);
  if (behaviorChanging.has(task_type)) {
    const hasTestOrVerify = plan.some(
      (step) => step.type === "test" || step.type === "verification",
    );
    if (!hasTestOrVerify) {
      throw new PlannerSchemaError(
        `task_type=${task_type} must include at least one test or verification step`,
      );
    }
    if (verification_strategy.required === false) {
      throw new PlannerSchemaError(
        `task_type=${task_type} requires verification_strategy.required=true`,
      );
    }
    if (verification_strategy.commands.length === 0) {
      throw new PlannerSchemaError(
        `task_type=${task_type} requires verification_strategy.commands to be non-empty`,
      );
    }
  }

  return {
    task_summary,
    task_type,
    complexity,
    needs_decomposition,
    needs_initial_inspection,
    confidence,
    assumptions,
    ambiguities,
    risks,
    plan,
    verification_strategy,
    done_definition,
    executor_guidance,
  };
}

/**
 * Best-effort coercion when the model produced near-correct JSON.
 * Used as a fallback after {@link validatePlannerPlan} throws — never
 * silences real schema breaks. Returns `null` when the input is too
 * damaged to repair safely.
 */
export function tryRepairPlannerPlan(raw: unknown): PlannerPlan | null {
  if (raw && typeof raw === "object") {
    try {
      return validatePlannerPlan(raw);
    } catch {
      // fall through to repair
    }
  }
  if (typeof raw === "string") {
    let text = raw.trim();
    // Strip code fences the model sometimes wraps the JSON in.
    text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try {
      const parsed = JSON.parse(text);
      return validatePlannerPlan(parsed);
    } catch {
      // fall through
    }
  }
  return null;
}

export function safeRefString(value: unknown): string | undefined {
  return asOptionalString(value, "value");
}