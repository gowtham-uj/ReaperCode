import test from "node:test";
import assert from "node:assert/strict";

import { buildSubagentPrompt, buildSubagentSystemPrompt } from "../../src/runtime/subagent-prompts.js";
import {
  cancelSubagentJob,
  completeSubagentJob,
  createSubagentJob,
  failSubagentJob,
  subagentJobs,
} from "../../src/runtime/subagent-state.js";
import { executeSubagentTool } from "../../src/tools/subagent-tools.js";
import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ModelGateway,
  ModelRole,
  ResolvedModelProfile,
  StreamEvent,
  TokenCountRequest,
} from "../../src/model/types.js";

test("subagent prompt builders mark subagents advisory and non-executable", () => {
  const system = buildSubagentSystemPrompt("planner");
  const prompt = buildSubagentPrompt("planner", "Plan the work", "Use tests");

  assert.match(system, /advisory only/);
  assert.match(system, /Do not request or emit executable tool calls/);
  assert.match(system, /subagent recursion is forbidden/);
  assert.match(prompt, /Subagent type: planner/);
  assert.match(prompt, /Plan the work/);
  assert.match(prompt, /Use tests/);
});

test("subagent job helpers transition registry state", () => {
  subagentJobs.clear();
  const job = createSubagentJob({ type: "reviewer", task: "Review this", context: "diff" });

  assert.equal(subagentJobs.get(job.id)?.status, "running");
  assert.equal(subagentJobs.get(job.id)?.context, "diff");

  const completed = completeSubagentJob(job.id, { ok: true });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, { ok: true });

  const failed = failSubagentJob(job.id, "bad json");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "bad json");

  const cancelled = cancelSubagentJob(job.id, "stopped");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error, "stopped");
});

test("executeSubagentTool wraps valid JSON as advisory output without parsing tool_calls", async () => {
  subagentJobs.clear();
  const gateway = new StaticJsonGateway({
    findings: ["planner-result"],
    tool_calls: [{ id: "mutate", name: "write_file", args: { path: "x", content: "bad" } }],
  });

  const result = await executeSubagentTool(
    { type: "planner", task: "Plan safely", mode: "blocking" },
    { modelGateway: gateway, toolCallId: "call-1", pool: undefined },
  );

  assert.equal(result.ok, true);
  assert.equal(result.name, "call_subagent");
  assert.equal((result.output as { advisory: boolean }).advisory, true);
  assert.equal((result.output as { type: string }).type, "planner");
  assert.deepEqual((result.output as { result: { tool_calls: unknown[] } }).result.tool_calls, [
    { id: "mutate", name: "write_file", args: { path: "x", content: "bad" } },
  ]);
  assert.equal(gateway.requests[0]?.source, "planner_subagent");
  assert.equal(gateway.requests[0]?.tools, undefined);
  assert.equal([...subagentJobs.values()][0]?.status, "completed");
});

test("executeSubagentTool fails invalid JSON", async () => {
  subagentJobs.clear();
  const gateway = new StaticJsonGateway("not json", { rawContent: true });

  const result = await executeSubagentTool(
    { type: "tester", task: "Suggest tests" },
    { modelGateway: gateway, toolCallId: "call-2", pool: undefined },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "subagent_failed");
  assert.match(result.error?.message ?? "", /invalid JSON/);
  assert.equal([...subagentJobs.values()][0]?.status, "failed");
});

class StaticJsonGateway implements ModelGateway {
  readonly requests: GenerateRequest[] = [];

  constructor(
    private readonly response: unknown,
    private readonly options: { rawContent?: boolean } = {},
  ) {}

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "static-json",
      capabilities: {
        streaming: false,
        toolCalling: true,
        jsonMode: true,
        structuredOutput: true,
        embeddings: false,
      },
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(request);
    const content = this.options.rawContent ? String(this.response) : JSON.stringify(this.response);
    return {
      role: request.role,
      profileName: request.role,
      provider: "test",
      model: "static-json",
      content,
      finishReason: "stop",
      raw: this.response,
    };
  }

  async *stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {}

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    // `role` is "default_model" since the `embedder` role was
    // removed in v0.2; the embeddings capability now lives on the
    // default profile.
    return {
      role: "default_model",
      profileName: "default_model",
      provider: "test",
      model: "static-json",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return request.text.length;
  }
}
