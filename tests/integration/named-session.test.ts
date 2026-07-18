/**
 * Named-session continuity — the `exec run --session <name>` contract.
 *
 * 1. A run with `namedSession` journals its user/assistant turns under
 *    `.reaper/sessions/<name>.jsonl`.
 * 2. The next run with the same name rehydrates the prior conversation:
 *    the model's first call sees the earlier turns before the new prompt.
 * 3. runExec rejects invalid session names before touching the engine.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import { runExec } from "../../src/adaptive/exec-runner.js";
import {
  appendEntry,
  buildActiveBranchMessages,
  initJournal,
  lastEntryId,
} from "../../src/context/session-journal.js";
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
import { createTempWorkspace } from "../fixtures/workspace.js";

/** Static gateway that also captures the messages of every generate call. */
class CapturingJsonGateway implements ModelGateway {
  generateCount = 0;
  readonly capturedMessages: GenerateRequest["messages"][] = [];
  private readonly responses: unknown[];

  constructor(response: unknown | unknown[]) {
    this.responses = Array.isArray(response) ? response : [response];
  }

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "static-json",
      capabilities: {
        streaming: false,
        toolCalling: false,
        jsonMode: true,
        structuredOutput: true,
        embeddings: false,
      },
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.generateCount += 1;
    this.capturedMessages.push(request.messages.map((m) => ({ ...m })));
    const response = this.responses[Math.min(this.generateCount - 1, this.responses.length - 1)];
    return {
      role: request.role,
      profileName: request.role,
      provider: "test",
      model: "static-json",
      content: JSON.stringify(response),
      finishReason: "stop",
      raw: response,
    };
  }

  async *stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {}

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
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

test("named session journals turns and rehydrates them on the next run", async () => {
  const workspaceRoot = await createTempWorkspace();
  const sessionName = "sess-continuity";

  // ── Run 1: natural stop, journal the exchange ────────────────────────
  const request1 = createValidRequestEnvelope();
  request1.payload = { prompt: "Remember the codeword AMBER-CANYON-41." };
  const gateway1 = new CapturingJsonGateway([
    { assistant_message: "Noted: the codeword is AMBER-CANYON-41.", tool_calls: [] },
  ]);
  const engine1 = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request1,
    modelGateway: gateway1,
    namedSession: sessionName,
  });
  await engine1.run();

  const journalPath = path.join(workspaceRoot, ".reaper", "sessions", `${sessionName}.jsonl`);
  assert.ok(existsSync(journalPath), "named run must create the session journal");
  const afterRun1 = buildActiveBranchMessages(workspaceRoot, sessionName);
  assert.equal(afterRun1.length, 2, "run 1 must journal exactly user + assistant turns");
  assert.equal(afterRun1[0]?.role, "user");
  assert.match(afterRun1[0]?.content ?? "", /AMBER-CANYON-41/);
  assert.equal(afterRun1[1]?.role, "assistant");
  assert.match(afterRun1[1]?.content ?? "", /AMBER-CANYON-41/);

  // ── Run 2: same session name — prior turns must reach the model ─────
  const request2 = createValidRequestEnvelope();
  request2.payload = { prompt: "What was the codeword?" };
  const gateway2 = new CapturingJsonGateway([
    { assistant_message: "The codeword is AMBER-CANYON-41.", tool_calls: [] },
  ]);
  const engine2 = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request2,
    modelGateway: gateway2,
    namedSession: sessionName,
  });
  await engine2.run();

  assert.ok(gateway2.capturedMessages.length >= 1, "run 2 must call the model");
  const firstCall = gateway2.capturedMessages[0]!;
  const serialized = JSON.stringify(firstCall);
  assert.match(serialized, /AMBER-CANYON-41/, "prior turns must be rehydrated into the model call");
  const priorUserIdx = firstCall.findIndex(
    (m) => m.role === "user" && m.content.includes("Remember the codeword"),
  );
  const priorAssistantIdx = firstCall.findIndex(
    (m) => m.role === "assistant" && m.content.includes("AMBER-CANYON-41"),
  );
  const newPromptIdx = firstCall.findIndex(
    (m) => m.role === "user" && m.content.includes("What was the codeword?"),
  );
  assert.ok(priorUserIdx >= 0, "prior user turn present");
  assert.ok(priorAssistantIdx > priorUserIdx, "prior assistant turn follows prior user turn");
  assert.ok(newPromptIdx > priorAssistantIdx, "new prompt comes after the rehydrated history");

  // Run 2 appends its own exchange to the same journal.
  const afterRun2 = buildActiveBranchMessages(workspaceRoot, sessionName);
  assert.equal(afterRun2.length, 4, "run 2 must append its user + assistant turns");
  assert.equal(afterRun2[2]?.role, "user");
  assert.equal(afterRun2[3]?.role, "assistant");
});

test("unnamed runs do not create session journals", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = { prompt: "No session here." };
  const gateway = new CapturingJsonGateway([{ assistant_message: "Done.", tool_calls: [] }]);
  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });
  await engine.run();
  // The harness sends one mutable cockpit followed by the exact task.
  const first = gateway.capturedMessages[0] ?? [];
  assert.equal(first[0]?.role, "user");
  assert.match(first[0]?.content ?? "", /REAPER_COCKPIT v1/);
  assert.equal(first[1]?.role, "user");
  assert.equal(first[1]?.content, "No session here.");
  assert.equal(first.length, 2);
  assert.doesNotMatch(
    JSON.stringify(gateway.capturedMessages[0]),
    /Main Agent Cockpit|Repo Snapshot|Prepared Context/,
  );
  assert.equal(
    existsSync(path.join(workspaceRoot, ".reaper", "sessions")),
    false,
    "no journal directory without --session",
  );
});

test("runExec rejects invalid session names before running the engine", async () => {
  const workspaceRoot = await createTempWorkspace();
  const result = await runExec({
    workspaceRoot,
    prompt: "irrelevant",
    provider: "minimax",
    session: "bad name!",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.trajectoryPath, "", "engine must not run for an invalid session name");
  assert.match(result.notices[0]?.message ?? "", /invalid --session name/);
});

test("grown session context triggers full summary and writes compaction back to the journal", async () => {
  // Local HTTP stub playing the out-of-band summarizer provider.
  const SUMMARY_TEXT =
    "The session refactored the auth module across many turns; codeword ZEBRA-PLUM-77 was established as the durable fact.";
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: `<summary>${SUMMARY_TEXT}</summary>` } }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  process.env.REAPER_TEST_SUMMARY_KEY = "stub-key";

  try {
    const workspaceRoot = await createTempWorkspace();
    const sessionName = "sess-compaction";

    // Seed a LARGE prior session history (simulating many earlier runs):
    // ~45k chars ≈ 11k tokens, far past the softCap-2000 compact gate.
    await initJournal({ name: sessionName, workspaceRoot, cwd: workspaceRoot });
    for (let i = 0; i < 15; i += 1) {
      for (const role of ["user", "assistant"] as const) {
        await appendEntry(workspaceRoot, sessionName, {
          id: randomUUID(),
          parentId: lastEntryId(workspaceRoot, sessionName),
          type: "message",
          ts: new Date().toISOString(),
          payload: { role, content: `FILLER-TURN-${i}-${role} ` + "lorem ipsum ".repeat(120), ts: Date.now() },
        });
      }
    }

    const config = createValidConfig();
    (config.contextManagement as { softCap: number }).softCap = 2000;
    (config.models as Record<string, unknown>).summarizer = {
      provider: "openai",
      model: "stub-summarizer",
      apiKeyEnv: "REAPER_TEST_SUMMARY_KEY",
      apiBase: `http://127.0.0.1:${port}/v1`,
      timeoutMs: 30_000,
      maxRetries: 0,
      capabilities: {
        streaming: false,
        toolCalling: false,
        jsonMode: true,
        structuredOutput: true,
        embeddings: false,
        maxContextTokens: 262128,
        maxOutputTokens: 32000,
      },
    };

    // ── Run 1: rehydrates the big history → compact gate fires ─────────
    const request1 = createValidRequestEnvelope();
    request1.payload = { prompt: "Continue the refactor." };
    const gateway1 = new CapturingJsonGateway([
      { assistant_message: "Continuing from the compacted context.", tool_calls: [] },
    ]);
    const engine1 = new RuntimeEngine({
      config,
      workspaceRoot,
      requestEnvelope: request1,
      modelGateway: gateway1,
      namedSession: sessionName,
    });
    await engine1.run();

    // Journal must now hold a compaction entry with the stub summary.
    const journalPath = path.join(workspaceRoot, ".reaper", "sessions", `${sessionName}.jsonl`);
    const entries = readFileSync(journalPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e): e is { type: string; payload?: { summary?: string } } => Boolean(e));
    const compactions = entries.filter((e) => e.type === "compaction");
    assert.equal(compactions.length, 1, "run must write exactly one compaction entry back to the journal");
    assert.match(compactions[0]?.payload?.summary ?? "", /ZEBRA-PLUM-77/);

    // Rehydration = boundary + checkpoint + canonical summary + this run's raw exchange.
    const rehydrated = buildActiveBranchMessages(workspaceRoot, sessionName);
    assert.match(rehydrated[0]?.content ?? "", /Prior session context \(compacted\)/);
    assert.ok(rehydrated.some((message) => message.content.includes("[Reaper session checkpoint v1]")));
    assert.ok(rehydrated.some((message) => message.content.includes("ZEBRA-PLUM-77")));
    assert.ok(
      !rehydrated.some((m) => m.content.includes("FILLER-TURN-7-user")),
      "intermediate pre-compaction turns must be summary-mediated, not raw",
    );

    // ── Run 2: boots from the compacted state ───────────────────────────
    const request2 = createValidRequestEnvelope();
    request2.payload = { prompt: "What codeword did we establish?" };
    const gateway2 = new CapturingJsonGateway([
      { assistant_message: "ZEBRA-PLUM-77.", tool_calls: [] },
    ]);
    const engine2 = new RuntimeEngine({
      config,
      workspaceRoot,
      requestEnvelope: request2,
      modelGateway: gateway2,
      namedSession: sessionName,
    });
    await engine2.run();

    const firstCall = JSON.stringify(gateway2.capturedMessages[0] ?? []);
    assert.match(firstCall, /ZEBRA-PLUM-77/, "run 2 must see the summary");
    assert.ok(
      !firstCall.includes("FILLER-TURN-7-user"),
      "run 2 must not re-pay intermediate raw pre-compaction history",
    );
  } finally {
    server.close();
    delete process.env.REAPER_TEST_SUMMARY_KEY;
  }
});

test("named session journals tool turns and rehydrates the full multi-turn conversation", async () => {
  const workspaceRoot = await createTempWorkspace();
  const sessionName = "sess-multiturn";

  // ── Run 1: a real tool-using run (write_file, then natural stop) ─────
  const request1 = createValidRequestEnvelope();
  request1.payload = { prompt: "Create notes.txt with TOOL-TURN-OK inside." };
  const gateway1 = new CapturingJsonGateway([
    {
      assistant_message: "Creating the file.",
      tool_calls: [{ id: "w1", name: "write_file", args: { path: "notes.txt", content: "TOOL-TURN-OK\n" } }],
    },
    { assistant_message: "notes.txt created with TOOL-TURN-OK.", tool_calls: [] },
  ]);
  const engine1 = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request1,
    modelGateway: gateway1,
    namedSession: sessionName,
  });
  await engine1.run();

  // The journal must hold the POST-TRANSFORM multi-turn conversation:
  // user intent, assistant w/ tool_calls, tool result, final assistant.
  const journaled = buildActiveBranchMessages(workspaceRoot, sessionName);
  const roles = journaled.map((m) => m.role);
  assert.deepEqual(
    roles,
    ["user", "assistant", "tool", "assistant"],
    `expected full turn sequence, got ${JSON.stringify(roles)}`,
  );
  assert.match(journaled[0]!.content, /Create notes\.txt/);
  assert.equal(journaled[1]!.tool_calls?.[0]?.name, "write_file");
  assert.equal(journaled[2]!.tool_call_id, "w1");
  assert.match(journaled[3]!.content, /TOOL-TURN-OK/);

  // ── Run 2: the tool history reaches the next run's model call ────────
  const request2 = createValidRequestEnvelope();
  request2.payload = { prompt: "What file did you create and what does it contain?" };
  const gateway2 = new CapturingJsonGateway([
    { assistant_message: "notes.txt containing TOOL-TURN-OK.", tool_calls: [] },
  ]);
  const engine2 = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request2,
    modelGateway: gateway2,
    namedSession: sessionName,
  });
  await engine2.run();

  const firstCall = gateway2.capturedMessages[0]!;
  const rehydratedToolMsg = firstCall.find((m) => m.role === "tool" && m.tool_call_id === "w1");
  assert.ok(rehydratedToolMsg, "run 2 must rehydrate the tool result turn");
  const rehydratedAssistant = firstCall.find(
    (m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function.name === "write_file"),
  );
  assert.ok(rehydratedAssistant, "run 2 must rehydrate the assistant tool_calls turn");
});
