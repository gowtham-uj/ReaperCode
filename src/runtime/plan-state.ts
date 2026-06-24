export interface PlanState {
  activeMarkdown?: string;
  candidates: string[];
}

export interface TodoItem {
  id: string;
  content: string;
  done: boolean;
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
  return {
    items: state.items.map((item) => (item.id === id ? { ...item, done: true } : item)),
  };
}

export function renderTodoForCockpit(state: TodoState | undefined): string {
  if (!state || state.items.length === 0) return "None.";
  return state.items.map((item) => `- [${item.done ? "x" : " "}] ${item.id}: ${item.content}`).join("\n");
}

function normalizeTodoItems(items: TodoItem[]): TodoItem[] {
  const byId = new Map<string, TodoItem>();
  for (const item of items) {
    const id = item.id.trim();
    const content = item.content.trim();
    if (!id || !content) continue;
    byId.set(id, { id, content, done: item.done });
  }
  return [...byId.values()];
}
