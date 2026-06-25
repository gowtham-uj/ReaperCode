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
  activeMarkdown?: string;
  candidates: string[];
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
  const sections: string[] = ["### Active Plan", state.activeMarkdown?.trim() || "None."];
  if (state.candidates.length > 0) {
    sections.push("", "### Candidate Plans");
    for (const [index, candidate] of state.candidates.entries()) {
      sections.push(`Candidate ${index + 1}:`, candidate.trim());
    }
  }
  return sections.join("\n");
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

function statusGlyph(status: TodoStatus): string {
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
