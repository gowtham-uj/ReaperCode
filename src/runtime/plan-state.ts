/**
 * Plan + Todo state for the general coding agent.
 *
 * `PlanState` holds the agent's long-form plan markdown plus any
 * candidate plans the prep pipeline generated for it. The agent accepts
 * a candidate with `applyCandidatePlan` to promote it to active.
 *
 * `TodoState` holds the agent's working memory — a list of typed todo
 * items with statuses, priorities, and optional evidence. The list is
 * the Claude Code / Codex equivalent of `update_todo`: a durable,
 * resumable working memory that the agent updates as work progresses.
 */

export interface PlanState {
  /** Optional free-form markdown plan (used as fallback rendering). */
  activeMarkdown?: string;
  candidates: string[];
  /**
   * Optional typed plan steps. When populated, this is the canonical
   * source of truth for the agent's plan and the cockpit renders it
   * in preference to `activeMarkdown`. The Codex/Claude-style plan
   * protocol:
   *
   * - The agent issues `update_plan` with `steps: PlanStepInput[]`
   * - Each step carries a status, an evidence field, and an optional
   *   acceptance criteria. Steps advance through pending -> in_progress
   *   -> completed (or blocked).
   * - The runtime can derive a deterministic plan status from the
   *   step statuses (e.g. "3/5 steps completed").
   */
  steps?: PlanStep[];
}

/**
 * Status of a single plan step. Mirrors the TodoStatus taxonomy so the
 * agent can use a single mental model for both plans and todos.
 */
export type PlanStepStatus = "pending" | "in_progress" | "completed" | "blocked";

/**
 * One typed plan step. The `id` is supplied by the agent and used to
 * advance/regress the step across turns. `acceptanceCriteria` is the
 * test/verification that proves the step is done.
 */
export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  /** Optional one-line detail (e.g. file path, test name, scope). */
  detail?: string;
  /** Optional evidence the agent attached when marking the step completed. */
  evidence?: string;
  /** Optional acceptance test/command. */
  acceptanceCriteria?: string;
  /** Last update time (epoch ms); set automatically. */
  updatedAt?: number;
}

export interface PlanStepInput {
  id: string;
  title: string;
  status?: PlanStepStatus | undefined;
  detail?: string | undefined;
  evidence?: string | undefined;
  acceptanceCriteria?: string | undefined;
}

export function createPlanSteps(steps: PlanStepInput[] = []): PlanStep[] {
  const byId = new Map<string, PlanStep>();
  for (const step of steps) {
    const id = step.id.trim();
    const title = step.title.trim();
    if (!id || !title) continue;
    const status: PlanStepStatus = step.status ?? "pending";
    byId.set(id, {
      id,
      title,
      status,
      ...(step.detail ? { detail: step.detail } : {}),
      ...(step.evidence ? { evidence: step.evidence } : {}),
      ...(step.acceptanceCriteria ? { acceptanceCriteria: step.acceptanceCriteria } : {}),
      updatedAt: Date.now(),
    });
  }
  return [...byId.values()];
}

export function setPlanSteps(state: PlanState, steps: PlanStepInput[]): PlanState {
  return { ...state, steps: createPlanSteps(steps) };
}

export function advancePlanStep(
  state: PlanState,
  stepId: string,
  patch: { status?: PlanStepStatus; evidence?: string },
): PlanState {
  if (!state.steps) return state;
  let changed = false;
  const next: PlanStep[] = state.steps.map((step) => {
    if (step.id !== stepId) return step;
    changed = true;
    const nextStatus = patch.status ?? step.status;
    return {
      ...step,
      status: nextStatus,
      ...(patch.evidence !== undefined || step.evidence !== undefined
        ? { evidence: patch.evidence ?? step.evidence }
        : {}),
      updatedAt: Date.now(),
    };
  });
  if (!changed) return state;
  return { ...state, steps: next };
}

export interface PlanProgress {
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
  pending: number;
  ratio: number;
  isComplete: boolean;
}

export function planProgress(state: PlanState | undefined): PlanProgress | undefined {
  if (!state?.steps?.length) return undefined;
  let completed = 0;
  let inProgress = 0;
  let blocked = 0;
  let pending = 0;
  for (const step of state.steps) {
    switch (step.status) {
      case "completed":
        completed += 1;
        break;
      case "in_progress":
        inProgress += 1;
        break;
      case "blocked":
        blocked += 1;
        break;
      default:
        pending += 1;
        break;
    }
  }
  const total = state.steps.length;
  return {
    total,
    completed,
    inProgress,
    blocked,
    pending,
    ratio: total === 0 ? 0 : completed / total,
    isComplete: total > 0 && completed === total,
  };
}

/**
 * Status of a single todo item. `blocked` is for items that cannot be
 * completed in the current state (e.g. waiting on a human approval or
 * an external dependency) — the model should move on and revisit.
 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked";

export type TodoPriority = "low" | "medium" | "high";

export interface TodoItem {
  id: string;
  content: string;
  /** @deprecated use `status` instead. */
  done?: boolean;
  status?: TodoStatus;
  priority?: TodoPriority;
  /** Optional short evidence (test name, file path, log line) supporting the current status. */
  evidence?: string;
  /** Last update time (epoch ms); set automatically by `updateTodoItem`. */
  updatedAt?: number;
}

export interface TodoState {
  items: TodoItem[];
}

export function createPlanState(candidates: string[] = []): PlanState {
  return { candidates: candidates.filter((candidate) => candidate.trim().length > 0) };
}

export function applyCandidatePlan(state: PlanState, candidate: string): PlanState {
  const markdown = candidate.trim();
  return {
    ...(markdown || state.activeMarkdown ? { activeMarkdown: markdown || state.activeMarkdown } : {}),
    candidates: markdown ? state.candidates.filter((item) => item !== markdown) : state.candidates,
  };
}

export function renderPlanForCockpit(state: PlanState | undefined): string {
  if (!state) return "None.";
  const sections: string[] = [];
  // Typed steps render first when present so the agent sees the
  // canonical plan structure.
  if (state.steps && state.steps.length > 0) {
    const progress = planProgress(state);
    sections.push("### Plan Steps");
    for (const step of state.steps) {
      const status = step.status;
      const detail = step.detail ? ` — ${step.detail}` : "";
      const evidence = step.evidence ? ` ✓ ${step.evidence}` : "";
      const acceptance = step.acceptanceCriteria ? ` (acceptance: ${step.acceptanceCriteria})` : "";
      sections.push(`- [${statusGlyph(status)}] ${step.id}: ${step.title}${detail}${evidence}${acceptance}`);
    }
    if (progress) {
      sections.push(
        "",
        `### Progress: ${progress.completed}/${progress.total} (${Math.round(progress.ratio * 100)}%)`,
        progress.blocked > 0 ? `${progress.blocked} blocked, ${progress.inProgress} in_progress, ${progress.pending} pending` : `${progress.inProgress} in_progress, ${progress.pending} pending`,
      );
    }
  }
  sections.push("### Active Plan", state.activeMarkdown?.trim() || "None.");
  if (state.candidates.length > 0) {
    sections.push("", "### Candidate Plans");
    for (const [index, candidate] of state.candidates.entries()) {
      sections.push(`Candidate ${index + 1}:`, candidate.trim());
    }
  }
  return sections.join("\n");
}

function statusGlyph(status: PlanStepStatus | TodoStatus): string {
  switch (status) {
    case "completed":
      return "x";
    case "in_progress":
      return ">";
    case "blocked":
      return "!";
    case "pending":
    default:
      return " ";
  }
}

export function createTodoState(items: TodoItem[] = []): TodoState {
  return { items: normalizeTodoItems(items) };
}

export function addTodoItem(state: TodoState, item: TodoItem): TodoState {
  const items = state.items.filter((existing) => existing.id !== item.id);
  return { items: normalizeTodoItems([...items, item]) };
}

export function completeTodoItem(state: TodoState, id: string): TodoState {
  return updateTodoItem(state, { id, status: "completed" });
}

export function updateTodoItem(
  state: TodoState,
  patch: { id: string; content?: string; status?: TodoStatus; priority?: TodoPriority; evidence?: string },
): TodoState {
  const items: TodoItem[] = [];
  let found = false;
  for (const existing of state.items) {
    if (existing.id !== patch.id) {
      items.push(existing);
      continue;
    }
    found = true;
    found = true;
    const priority: TodoPriority | undefined = patch.priority ?? existing.priority;
    const next: TodoItem = {
      id: existing.id,
      content: patch.content ?? existing.content,
      status: patch.status ?? existing.status ?? (existing.done ? "completed" : "pending"),
      ...(priority ? { priority } : {}),
      ...(patch.evidence !== undefined || existing.evidence !== undefined
        ? { evidence: patch.evidence ?? existing.evidence }
        : {}),
      updatedAt: Date.now(),
    };
    items.push(next);
  }
  if (!found) {
    items.push({
      id: patch.id,
      content: patch.content ?? patch.id,
      status: patch.status ?? "pending",
      ...(patch.priority ? { priority: patch.priority } : {}),
      ...(patch.evidence ? { evidence: patch.evidence } : {}),
      updatedAt: Date.now(),
    });
  }
  return { items: normalizeTodoItems(items) };
}

export function renderTodoForCockpit(state: TodoState | undefined): string {
  if (!state || state.items.length === 0) return "None.";
  return state.items
    .map((item) => {
      const status = resolveStatus(item);
      const priority = item.priority ? ` (${item.priority})` : "";
      const evidence = item.evidence ? ` — ${item.evidence}` : "";
      return `- [${statusGlyph(status)}] ${item.id}${priority}: ${item.content}${evidence}`;
    })
    .join("\n");
}

export function statusForTodoItem(item: TodoItem): TodoStatus {
  return resolveStatus(item);
}

function resolveStatus(item: TodoItem): TodoStatus {
  if (item.status) return item.status;
  if (item.done) return "completed";
  return "pending";
}

function normalizeTodoItems(items: TodoItem[]): TodoItem[] {
  const byId = new Map<string, TodoItem>();
  for (const item of items) {
    const id = item.id.trim();
    const content = item.content.trim();
    if (!id || !content) continue;
    const status = resolveStatus(item);
    byId.set(id, {
      id,
      content,
      status,
      ...(item.priority ? { priority: item.priority } : {}),
      ...(item.evidence ? { evidence: item.evidence } : {}),
      ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
      // Keep legacy `done` for any consumer that still reads it.
      done: status === "completed",
    });
  }
  return [...byId.values()];
}
