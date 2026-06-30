import { RuntimeEngine, type RuntimeEngineResult } from "../runtime/engine.js";
import type { ToolCall } from "../tools/types.js";
import { selectVerificationCommand, runVerificationCommand } from "../verify/runner.js";
import { enforceDelegationDepth } from "./depth.js";
import { assertLeaseAllowsFile, type FileLeaseMap } from "./leases.js";
import { buildRepoMapSnapshot } from "./return.js";
import { cleanupSandboxWorkspace, createSandboxWorkspace } from "./sandbox.js";
import { detectPlanCycle, nextSchedulableTasks, type SubTaskContract } from "./scheduler.js";
import { runIntegratorMerge } from "./integrator.js";
import { commitAll } from "../workspace/git.js";

interface ExecutableSubTask extends SubTaskContract {
  prompt: string;
  verificationCommand?: string;
}
export interface OrchestrationResult {
  ok: boolean;
  completedSubtasks: string[];
  failedSubtasks: Array<{ id: string; reason: string }>;
  repoMapSnapshot?: Awaited<ReturnType<typeof buildRepoMapSnapshot>>;
  conflictSummary?: string;
}

export interface SubAgentRunnerInput {
  workspaceRoot: string;
  config: unknown;
  prompt: string;
  toolCalls: ToolCall[];
}

export type SubAgentRunner = (input: SubAgentRunnerInput) => Promise<RuntimeEngineResult>;

export async function runDelegatedPlan(input: {
  workspaceRoot: string;
  config: unknown;
  sessionId: string;
  prompt: string;
  plan: SubTaskContract[];
  toolCallsBySubtask: Record<string, ToolCall[]>;
  fileLeases: FileLeaseMap;
  maxConcurrency?: number;
  depth?: number;
  runner?: SubAgentRunner;
}): Promise<OrchestrationResult> {
  enforceDelegationDepth(input.depth ?? 0, 2);
  detectPlanCycle(input.plan);

  const completed = new Set<string>();
  const failed: Array<{ id: string; reason: string }> = [];
  const running = new Set<string>();
  const sandboxHandles = new Map<string, Awaited<ReturnType<typeof createSandboxWorkspace>>>();
  const runner = input.runner ?? defaultSubAgentRunner;
  const maxConcurrency = input.maxConcurrency ?? 3;

  while (completed.size + failed.length < input.plan.length) {
    const next = nextSchedulableTasks(input.plan, completed, running, maxConcurrency) as ExecutableSubTask[];
    if (next.length === 0) {
      break;
    }

    const batchResults = await Promise.all(
      next.map(async (task) => {
        running.add(task.id);
        try {
          for (const file of task.files) {
            assertLeaseAllowsFile(task.id, file, input.fileLeases);
          }

          const sandbox = await createSandboxWorkspace(input.workspaceRoot, input.sessionId, task.id);
          sandboxHandles.set(task.id, sandbox);
          const result = await runner({
            workspaceRoot: sandbox.worktreePath,
            config: input.config,
            prompt: task.prompt,
            toolCalls: input.toolCallsBySubtask[task.id] ?? [],
          });

          const verification = await selectVerificationCommand(sandbox.worktreePath, { command: task.verificationCommand ?? "" } as { command: string });
          const verificationResult = verification ? await runVerificationCommand(sandbox.worktreePath, verification) : undefined;
          if (!verificationResult?.ok) {
            throw new Error(verificationResult?.output ?? "Subtask verification failed");
          }

          await commitAll(sandbox.worktreePath, `reaper subtask ${task.id}`);

          return { task, ok: true, result } as const;
        } catch (error) {
          return { task, ok: false, reason: error instanceof Error ? error.message : "Unknown subtask failure" } as const;
        } finally {
          running.delete(task.id);
        }
      }),
    );

    const successfulBranches: string[] = [];
    for (const item of batchResults) {
      if (item.ok) {
        completed.add(item.task.id);
        successfulBranches.push(sandboxHandles.get(item.task.id)!.branchName);
      } else {
        failed.push({ id: item.task.id, reason: item.reason });
      }
    }

    if (successfulBranches.length > 0) {
      const merge = await runIntegratorMerge(input.workspaceRoot, successfulBranches);
      if (!merge.ok) {
        return {
          ok: false,
          completedSubtasks: [...completed],
          failedSubtasks: failed,
          ...(merge.conflictSummary ? { conflictSummary: merge.conflictSummary } : {}),
        };
      }

      for (const taskId of next.filter((task) => completed.has(task.id)).map((task) => task.id)) {
        const sandbox = sandboxHandles.get(taskId);
        if (sandbox) {
          await cleanupSandboxWorkspace(input.workspaceRoot, sandbox);
          sandboxHandles.delete(taskId);
        }
      }
    }
  }

  const repoMapSnapshot = await buildRepoMapSnapshot(input.workspaceRoot, input.prompt);
  return {
    ok: failed.length === 0,
    completedSubtasks: [...completed],
    failedSubtasks: failed,
    repoMapSnapshot,
  };
}

async function defaultSubAgentRunner(input: SubAgentRunnerInput): Promise<RuntimeEngineResult> {
  const requestEnvelope = {
    connection_id: "orchestrator",
    session_id: `sub-${Date.now()}`,
    turn_id: "turn-1",
    request_id: "request-1",
    message_type: "user_prompt",
    timestamp: new Date().toISOString(),
    trace_id: `trace-${Date.now()}`,
    payload: {
      prompt: input.prompt,
      tool_calls: input.toolCalls,
    },
    metadata: {},
  };

  return new RuntimeEngine({
    config: input.config,
    workspaceRoot: input.workspaceRoot,
    requestEnvelope,
  }).run();
}
