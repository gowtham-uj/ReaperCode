import { z } from "zod";

// ── Schemas ──
export const TaskCreateArgsSchema = z.object({
  subject: z.string().min(1).describe("Brief imperative title (e.g., 'Fix auth bug')"),
  description: z.string().min(1).describe("What needs to be done"),
  status: z.enum(["pending", "in_progress", "completed"]).default("pending"),
}).strict();

export const TaskUpdateArgsSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  subject: z.string().min(1).optional(),
  description: z.string().optional(),
}).strict();

export const TaskListArgsSchema = z.object({
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
}).strict();

export type TaskCreateArgs = z.infer<typeof TaskCreateArgsSchema>;
export type TaskUpdateArgs = z.infer<typeof TaskUpdateArgsSchema>;
export type TaskListArgs = z.infer<typeof TaskListArgsSchema>;

// ── Per-run task store ──
// Tasks are scoped per runId so concurrent eval runs don't share state.
export interface TaskEntry {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  createdAt: string;
}

interface RunTaskState {
  tasks: Map<string, TaskEntry>;
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

export function createTask(args: TaskCreateArgs, runId: string = DEFAULT_RUN): TaskEntry {
  const store = getStore(runId);
  const id = String(store.nextId++);
  const entry: TaskEntry = {
    id,
    subject: args.subject,
    description: args.description,
    status: args.status,
    createdAt: new Date().toISOString(),
  };
  store.tasks.set(id, entry);
  return entry;
}

export function updateTask(args: TaskUpdateArgs, runId: string = DEFAULT_RUN): TaskEntry | null {
  const store = getStore(runId);
  const task = store.tasks.get(args.taskId);
  if (!task) return null;
  if (args.status) task.status = args.status;
  if (args.subject) task.subject = args.subject;
  if (args.description) task.description = args.description;
  return task;
}

export function listTasks(status?: string, runId: string = DEFAULT_RUN): TaskEntry[] {
  const store = stores.get(runId);
  if (!store) return [];
  const tasks = [...store.tasks.values()];
  return status ? tasks.filter((t) => t.status === status) : tasks;
}

export function clearTasks(runId: string): void {
  stores.delete(runId);
}
