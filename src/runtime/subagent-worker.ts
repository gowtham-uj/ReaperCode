import {once} from "node:events";
import {readFile} from "node:fs/promises";

import {ConfiguredModelGateway} from "../model/gateway.js";
import {ProviderMultiplexerClient} from "../model/providers/provider-client.js";
import {buildSubagentPrompt, buildSubagentSystemPrompt} from "./subagent-prompts.js";
import type {SubagentJob} from "./subagent-state.js";
import type {SubagentWorkerMessage} from "./subagent-pool.js";

const SUBAGENT_SOURCE: Record<SubagentJob["type"], string> = {
  planner: "planner_subagent",
  reviewer: "reviewer_subagent",
  repair: "repair_subagent",
  tester: "tester_subagent",
  researcher: "researcher_subagent",
};

async function main(): Promise<void> {
  const [configPath, jobId] = process.argv.slice(2);
  if (!configPath || !jobId) {
    throw new Error("Usage: subagent-worker <configPath> <jobId>");
  }

  const config = JSON.parse(await readFile(configPath, "utf8"));
  const gateway = new ConfiguredModelGateway(config, new ProviderMultiplexerClient());

  const {job, workspaceRoot}: {job: SubagentJob; workspaceRoot: string} = await once(process, "message") as any;

  if (job.id !== jobId) {
    sendError(jobId, "Job ID mismatch");
    process.exit(1);
  }

  try {
    const response = await gateway.generate({
      role: roleForSubagent(job.type),
      source: SUBAGENT_SOURCE[job.type],
      system: buildSubagentSystemPrompt(job.type),
      messages: [{role: "user", content: buildSubagentPrompt(job.type, job.task, job.context)}],
      responseFormat: "json",
    });
    const parsed = JSON.parse(response.content);
    sendComplete(job.id, parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(job.id, message);
  } finally {
    await gateway.dispose?.().catch(() => undefined);
    process.disconnect?.();
  }

  function roleForSubagent(type: SubagentJob["type"]): any {
    return type === "planner" ? "planner" : "main_reasoner";
  }

  function sendComplete(id: string, result: unknown) {
    const message: SubagentWorkerMessage = {type: "complete", jobId: id, result};
    process.send?.(message);
  }

  function sendError(id: string, error: string) {
    const message: SubagentWorkerMessage = {type: "error", jobId: id, error};
    process.send?.(message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
