import { runEvalTask, type EvalTask } from "../reaper_eval/runtime/eval-lib.js";
import { loadWorkspaceEnv } from "../reaper_eval/runtime/load-env.js";
import os from "node:os";

// Force the currently validated parity provider before .env is loaded.
// DeepInfra + DeepSeek-V3.1 passed structured JSON smoke; fallback is disabled in .env
// so failed providers do not mask regressions.
process.env.REAPER_LIVE_PROVIDER = "deepinfra";
process.env.REAPER_EVAL_PROVIDER = "deepinfra";
process.env.REAPER_EVAL_MODEL = process.env.REAPER_EVAL_MODEL ?? "Qwen/Qwen2.5-7B-Instruct";
process.env.REAPER_EVAL_API_KEY_ENV = process.env.REAPER_EVAL_API_KEY_ENV ?? "DEEPINFRA_API_KEY";

const tasks: EvalTask[] = [
  {
    id: "initial-task-1",
    title: "Full-stack Task Management App",
    prompt: `Build a full-stack task management web application completely from scratch using any modern tech stack. The application must support user authentication, task creation, editing, deletion, filtering, persistent database storage, responsive UI, automated tests, Docker setup, and complete documentation. Plan the architecture, create the entire project structure, implement all features, debug runtime issues, and ensure the final application runs successfully end-to-end.`,
    verification: { command: "npm test", maxIterations: 3, allowJudgeRetry: false }
  },
  {
    id: "initial-task-2",
    title: "Real-time Chat Application",
    prompt: `Create a real-time chat application from scratch with frontend, backend, database, and WebSocket communication. Implement user accounts, live messaging, online status indicators, chat history persistence, reconnection handling, automated testing, containerization, and deployment configuration. The system should recover gracefully from runtime errors and maintain stable communication between multiple clients.`,
    verification: { command: "npm test", maxIterations: 3, allowJudgeRetry: false }
  },
  {
    id: "initial-task-3",
    title: "E-commerce Platform",
    prompt: `Build a complete e-commerce platform from scratch including product catalog, authentication, shopping cart, checkout flow, order tracking, admin dashboard, payment simulation, database integration, API layer, frontend UI, automated tests, and deployment setup. The project should include proper architecture planning, error handling, logging, and documentation.`,
    verification: { command: "npm test", maxIterations: 3, allowJudgeRetry: false }
  },
  {
    id: "initial-task-4",
    title: "Collaborative Note-taking Platform",
    prompt: `Create a collaborative note-taking platform from scratch where multiple users can edit notes simultaneously in real time. Implement authentication, synchronization logic, persistent storage, version history, conflict handling, automated testing, responsive frontend, API backend, and production-ready Docker configuration.`,
    verification: { command: "npm test", maxIterations: 3, allowJudgeRetry: false }
  },
  {
    id: "initial-task-5",
    title: "Kanban Project Management System",
    prompt: `Build a complete Kanban-style project management system from scratch supporting multiple workspaces, drag-and-drop boards, task assignments, due dates, comments, notifications, authentication, database persistence, automated tests, API documentation, and responsive UI. Design the entire architecture and ensure all workflows operate correctly.`,
    verification: { command: "npm test", maxIterations: 3, allowJudgeRetry: false }
  }
];

async function main() {
  loadWorkspaceEnv("/workspace");
  const missingEnv = getMissingProviderEnv();
  if (missingEnv) {
    console.error(
      `[preflight] Missing ${missingEnv}; live initial-task eval cannot run. ` +
        `Set ${missingEnv} or REAPER_EVAL_API_KEY_ENV to the provider key env var before launching.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Starting ${tasks.length} tasks with adaptive scheduling...`);
  const scheduler = new AdaptiveEvalScheduler(tasks);
  const results = await scheduler.run();

  console.log("\n=== All Tasks Completed ===");
  console.log(JSON.stringify(results, null, 2));
}

class AdaptiveEvalScheduler {
  private active = 0;
  private cursor = 0;
  private concurrency: number;
  private readonly results: PromiseSettledResult<Awaited<ReturnType<typeof runEvalTask>>>[] = [];
  private readonly recentDurations: number[] = [];
  private readonly recentFailures: string[] = [];

  constructor(private readonly queue: EvalTask[]) {
    this.concurrency = this.initialConcurrency();
  }

  async run(): Promise<PromiseSettledResult<Awaited<ReturnType<typeof runEvalTask>>>[]> {
    return await new Promise((resolve) => {
      const pump = () => {
        while (this.active < this.concurrency && this.cursor < this.queue.length) {
          const index = this.cursor++;
          const task = this.queue[index]!;
          this.active += 1;
          console.log(`[scheduler] launching ${task.id}; active=${this.active}; concurrency=${this.concurrency}`);
          void this.runOne(task, index).finally(() => {
            this.active -= 1;
            this.adjust();
            if (this.results.length === this.queue.length) {
              resolve(this.results);
              return;
            }
            pump();
          });
        }
      };
      pump();
    });
  }

  private async runOne(task: EvalTask, index: number): Promise<void> {
    const startedAt = Date.now();
    try {
      console.log(`[${task.id}] Starting...`);
      const summary = await runEvalTask(task);
      console.log(`[${task.id}] Finished with status: ${summary.status}`);
      this.results[index] = { status: "fulfilled", value: summary };
      this.recentDurations.push(Date.now() - startedAt);
      if (summary.status !== "passed") {
        this.recentFailures.push(summary.error ?? summary.status);
      }
    } catch (reason) {
      this.results[index] = { status: "rejected", reason };
      this.recentDurations.push(Date.now() - startedAt);
      this.recentFailures.push(reason instanceof Error ? reason.message : String(reason));
    }
    this.trimTelemetry();
  }

  private adjust(): void {
    const previous = this.concurrency;
    const remaining = this.queue.length - this.results.length;
    const hasModelPressure = this.recentFailures.some((message) => /litellm|timed out|429|rate limit|fetch failed/i.test(message));
    const hasVerificationPressure = this.recentFailures.some((message) => /missing script|cannot find module|verification|npm/i.test(message));
    const medianDuration = median(this.recentDurations);
    const target = process.env.REAPER_EVAL_TARGET_TASK_MS ? Number(process.env.REAPER_EVAL_TARGET_TASK_MS) : medianDuration || 0;

    if (hasModelPressure && this.concurrency > 1) {
      this.concurrency -= 1;
    } else if (!hasModelPressure && !hasVerificationPressure && remaining > this.concurrency && target > 0 && medianDuration < target * 0.8) {
      this.concurrency += 1;
    }

    if (previous !== this.concurrency) {
      console.log(`[scheduler] adjusted concurrency ${previous} -> ${this.concurrency}`);
    }
  }

  private initialConcurrency(): number {
    const explicit = Number(process.env.REAPER_EVAL_INITIAL_CONCURRENCY);
    if (Number.isFinite(explicit) && explicit > 0) {
      return Math.min(this.queue.length, Math.floor(explicit));
    }
    const available = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    return Math.max(1, Math.min(this.queue.length, Math.floor(Math.sqrt(Math.max(1, available)))));
  }

  private trimTelemetry(): void {
    this.recentDurations.splice(0, Math.max(0, this.recentDurations.length - 5));
    this.recentFailures.splice(0, Math.max(0, this.recentFailures.length - 5));
  }
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function getMissingProviderEnv(): string | undefined {
  const apiKeyEnv = process.env.REAPER_EVAL_API_KEY_ENV ?? "DEEPINFRA_API_KEY";
  return process.env[apiKeyEnv] ? undefined : apiKeyEnv;
}

main().catch(console.error);
