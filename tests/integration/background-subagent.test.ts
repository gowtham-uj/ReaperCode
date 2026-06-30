import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import { createSubagentJob, subagentJobs } from "../../src/runtime/subagent-state.js";
import { SubagentPool } from "../../src/runtime/subagent-pool.js";
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
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";

test("background subagent result is injected before main agent turn", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-bg-subagent-"));
  try {
    subagentJobs.clear();
    const file = path.join(workspaceRoot, "tracked.txt");
    await writeFile(file, "initial", "utf8");

    const pool = await SubagentPool.create({
      config: createValidConfig(),
      workspaceRoot,
      runDir: workspaceRoot,
      workerPath: path.resolve(import.meta.dirname, "fixtures", "fake-subagent-worker-complete.mjs"),
      workerExecArgv: [],
    });
    await pool.run(
      createSubagentJob({
        type: "researcher",
        task: "Explore patterns",
        mode: "background",
        observedFiles: [file],
      }),
    );

    let injected = false;
    const gateway: ModelGateway = {
      async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
        return {
          role,
          profileName: role,
          provider: "static",
          model: "static",
          capabilities: {
            streaming: false,
            toolCalling: true,
            jsonMode: true,
            structuredOutput: true,
            embeddings: false,
          },
        };
      },
      async generate(request: GenerateRequest): Promise<GenerateResult> {
        if ((request.source ?? "").includes("main_agent")) {
          injected = true;
          assert.match(request.messages[0]?.content ?? "", /Completed Subagent Results/);
          assert.match(request.messages[0]?.content ?? "", /subagent-/);
        }
        return {
          role: request.role,
          profileName: request.role,
          provider: "static",
          model: "static",
          finishReason: "stop",
          content: JSON.stringify({ assistant_message: "ack", tool_calls: [{ id: "tc-1", name: "complete_task", args: { summary: "done" } }] }),
          raw: null,
        };
      },
      async *stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {
        yield { type: "message_end" };
      },
      async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
        return {
          role: "embedder",
          profileName: "embedder",
          provider: "static",
          model: "static",
          vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
          raw: {},
        };
      },
      async countTokens(request: TokenCountRequest): Promise<number> {
        return request.text.length;
      },
    };

    const request = createValidRequestEnvelope();
    request.payload = { prompt: "Run background subagent and finish" };

    const engine = new RuntimeEngine({
      workspaceRoot,
      modelGateway: gateway,
      config: createValidConfig(),
      requestEnvelope: request,
    });

    await engine.run();
    assert.equal(injected, true);

    await pool.close();
  } finally {
    subagentJobs.clear();
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
