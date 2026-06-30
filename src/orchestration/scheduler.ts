export interface SubTaskContract {
  id: string;
  files: string[];
  dependsOn: string[];
}

export function detectPlanCycle(plan: SubTaskContract[]): void {
  const byId = new Map(plan.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string) => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error("Circular dependency detected in delegated plan");
    }
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of plan) {
    visit(task.id);
  }
}

export function nextSchedulableTasks(plan: SubTaskContract[], completed: Set<string>, running: Set<string>, limit: number): SubTaskContract[] {
  return plan
    .filter((task) => !completed.has(task.id) && !running.has(task.id))
    .filter((task) => task.dependsOn.every((dep) => completed.has(dep)))
    .sort((a, b) => dependencyDepth(plan, b.id) - dependencyDepth(plan, a.id) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function dependencyDepth(plan: SubTaskContract[], id: string): number {
  const byId = new Map(plan.map((task) => [task.id, task]));
  const task = byId.get(id);
  if (!task || task.dependsOn.length === 0) {
    return 0;
  }
  return 1 + Math.max(...task.dependsOn.map((dep) => dependencyDepth(plan, dep)));
}
