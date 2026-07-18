/**
 * Engine-internal task tracking.
 *
 * The runtime maintains its own per-run todo list (the "backfill" tasks it
 * creates when verification fails) so the engine can track "what's still
 * outstanding before the model can claim completion." This list is NOT
 * exposed to the model — the model cannot call task_create / task_update /
 * task_list. Only the engine reads and writes this store.
 *
 * The previous home of this store was `src/tools/write/task.ts` alongside the
 * dead model-callable task tools. When the dead model-callable tools were
 * removed, the engine-internal store moved here.
 */

export interface EngineTaskEntry {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  createdAt: string;
}

interface RunTaskState {
  tasks: Map<string, EngineTaskEntry>;
  nextId: number;
}

const DEFAULT_RUN = "__default__";
const stores = new Map<string, RunTaskState>();

function getStore(runId: string): RunTaskState {
  let store = stores.get(runId);
  if (!store) {
    store = { tasks: new Map(), nextId: 1 };
    stores.set(runId, store);
  }
  return store;
}

export interface EngineTaskCreateInput {
  subject: string;
  description: string;
  status?: "pending" | "in_progress" | "completed";
}

export function createEngineTask(
  args: EngineTaskCreateInput,
  runId: string = DEFAULT_RUN,
): EngineTaskEntry {
  const store = getStore(runId);
  const id = String(store.nextId++);
  const entry: EngineTaskEntry = {
    id,
    subject: args.subject,
    description: args.description,
    status: args.status ?? "pending",
    createdAt: new Date().toISOString(),
  };
  store.tasks.set(id, entry);
  return entry;
}

export interface EngineTaskUpdateInput {
  taskId: string;
  status?: "pending" | "in_progress" | "completed";
  subject?: string;
  description?: string;
}

export function updateEngineTask(
  args: EngineTaskUpdateInput,
  runId: string = DEFAULT_RUN,
): EngineTaskEntry | null {
  const store = getStore(runId);
  const task = store.tasks.get(args.taskId);
  if (!task) return null;
  if (args.status) task.status = args.status;
  if (args.subject) task.subject = args.subject;
  if (args.description) task.description = args.description;
  return task;
}

export function listEngineTasks(
  status?: string,
  runId: string = DEFAULT_RUN,
): EngineTaskEntry[] {
  const store = stores.get(runId);
  if (!store) return [];
  const tasks = [...store.tasks.values()];
  return status ? tasks.filter((t) => t.status === status) : tasks;
}

export function clearEngineTasks(runId: string): void {
  stores.delete(runId);
}
