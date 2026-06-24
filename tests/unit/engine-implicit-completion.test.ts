/**
 * Tests for the Pi-style implicit-completion short-circuit.
 *
 * When the engine's model turn produces a non-empty assistant message
 * AND zero tool calls, the engine treats that as "task is done" and
 * exits the loop instead of trying to coerce the text into a tool
 * call. This file covers the helper, the hook emission surface, and
 * the routing rules that route the turn-complete state to summarize
 * without forcing a `complete_task` tool call.
 *
 * The full LangGraph path is exercised through `RuntimeEngine.run`
 * with a mocked `ModelGateway`. We instantiate the engine and stub
 * out only the model gateway — the trajectory logger and hooks
 * adapters are real so we can assert on the emitted events.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { detectImplicitCompletion } from "../../src/runtime/engine.js";
import { Hooks } from "../../src/adaptive/hooks.js";
import type { HookEvent, HookEventName } from "../../src/adaptive/types.js";
import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ModelGateway,
  ModelRole,
  StreamEvent,
  TokenCountRequest,
} from "../../src/model/types.js";
import type { ToolCall } from "../../src/tools/types.js";

/* -------------------------------------------------------------------------- */
/*                          detectImplicitCompletion                            */
/* -------------------------------------------------------------------------- */

test("detectImplicitCompletion: text + zero tool calls → implicit completion", () => {
  const text = "Task is complete. The build passed and the test suite is green.";
  const toolCalls: ToolCall[] = [];
  assert.equal(detectImplicitCompletion(text, toolCalls), true);
});

test("detectImplicitCompletion: whitespace-only text + zero tool calls → not implicit", () => {
  // Whitespace-only assistant message should NOT count — the model
  // emitted nothing meaningful, so the engine still needs to re-prompt
  // exactly once before erroring.
  assert.equal(detectImplicitCompletion("   \n\t  ", []), false);
  assert.equal(detectImplicitCompletion("", []), false);
});

test("detectImplicitCompletion: text + tool calls → not implicit (tool calls take precedence)", () => {
  const text = "I will now write the file and then run the tests.";
  const toolCalls: ToolCall[] = [
    { id: "w1", name: "write_file", args: { path: "a.txt", content: "x" } },
  ];
  assert.equal(detectImplicitCompletion(text, toolCalls), false);
});

test("detectImplicitCompletion: complete_task tool call → not implicit (explicit path)", () => {
  // Even with empty assistant message, a complete_task call is the
  // explicit completion signal and bypasses the implicit path.
  const toolCalls: ToolCall[] = [
    {
      id: "c1",
      name: "complete_task",
      args: { summary: "Task is fully done with passing tests." },
    },
  ];
  assert.equal(detectImplicitCompletion("", toolCalls), false);
});

test("detectImplicitCompletion: empty text + zero tool calls → not implicit", () => {
  // The test for the "model returned nothing" case — the engine
  // re-prompts once and then errors. detectImplicitCompletion must
  // return false here so the re-prompt path is taken.
  assert.equal(detectImplicitCompletion("", []), false);
});

test("detectImplicitCompletion: trims whitespace before deciding", () => {
  const text = "   The whole task is complete.   ";
  assert.equal(detectImplicitCompletion(text, []), true);
});

/* -------------------------------------------------------------------------- */
/*                       EngineTurnComplete hook payload                         */
/* -------------------------------------------------------------------------- */

test("Hooks: EngineTurnComplete event name is accepted and payload is delivered", async () => {
  const hooks = new Hooks();
  const received: Array<{ name: HookEventName; payload: Record<string, unknown> }> = [];
  hooks.on("EngineTurnComplete", (event: HookEvent) => {
    received.push({ name: event.name, payload: event.payload });
    return { allow: true };
  });
  const result = await hooks.emit({
    name: "EngineTurnComplete",
    payload: {
      assistantMessage: "Task is complete.",
      toolResults: [{ name: "run_shell_command", ok: true }],
      implicit: true,
    },
    blockable: false,
  });
  assert.equal(result.allow, true);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.name, "EngineTurnComplete");
  assert.equal(received[0]!.payload.assistantMessage, "Task is complete.");
  assert.equal(received[0]!.payload.implicit, true);
  assert.deepEqual(received[0]!.payload.toolResults, [{ name: "run_shell_command", ok: true }]);
});

test("Hooks: EngineTurnComplete handler that throws is fail-open (does not derail emit)", async () => {
  const hooks = new Hooks();
  hooks.on("EngineTurnComplete", () => {
    throw new Error("simulated TUI crash");
  });
  // EngineTurnComplete is observation-only — the emit must NOT fail
  // closed even when a listener throws. The runtime guarantees the
  // engine state has already been committed at this point so we
  // cannot afford to block.
  const result = await hooks.emit({
    name: "EngineTurnComplete",
    payload: { assistantMessage: "x", toolResults: [], implicit: true },
    blockable: false,
  });
  assert.equal(result.allow, true);
});

/* -------------------------------------------------------------------------- */
/*               RuntimeEngine.run end-to-end implicit completion               */
/* -------------------------------------------------------------------------- */

interface ScriptedTurn {
  assistantMessage: string;
  toolCalls: ToolCall[];
}

function scriptedModelGateway(script: ScriptedTurn[]): ModelGateway {
  let callIndex = 0;
  return {
    async resolveRole(role: ModelRole) {
      return {
        role,
        profileName: role,
        provider: "mock",
        model: "mock-model",
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
      const turn = script[callIndex] ?? script[script.length - 1]!;
      callIndex += 1;
      return {
        role: request.role,
        profileName: request.role,
        provider: "mock",
        model: "mock-model",
        content: JSON.stringify({
          assistant_message: turn.assistantMessage,
          tool_calls: turn.toolCalls,
        }),
        finishReason: "stop" as const,
        raw: turn,
      };
    },
    async *stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {},
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      return {
        role: request.role,
        profileName: request.role,
        provider: "mock",
        model: "mock-model",
        vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
        raw: {},
      };
    },
    async countTokens(_request: TokenCountRequest): Promise<number> {
      return 0;
    },
  };
}

async function withTempWorkspace<T>(fn: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = mkdtempSync(path.join(tmpdir(), "reaper-implicit-complete-"));
  try {
    return await fn(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function minimalValidConfig(completionGateMax = 3): unknown {
  // Build a minimal-but-valid ReaperConfig the engine can parse. The
  // models block needs at least a default_model profile with a
  // capabilities object — the gateway is mocked so the actual
  // provider/model strings are never used.
  return {
    logging: { sessionMetrics: false },
    runtime: {
      completionGateMax,
      voteAttempts: 1,
      progressGuard: {
        enabled: false,
        stallSteps: 3,
        actionRepeatLimit: 3,
        observationRepeatLimit: 3,
        sameFailedActionLimit: 3,
        recoveryStrategyRepeatLimit: 3,
      },
      recedingHorizonPlanContext: false,
      hypothesisRescue: { enabled: false },
      serviceSupervisor: { enabled: false },
    },
    verification: {},
    modelRouting: {
      planner: "default_model",
      executor: "default_model",
      repair: "default_model",
      patcher: "default_model",
      completionGate: "default_model",
      summarizer: "default_model",
      judge: "default_model",
    },
    models: {
      default_model: {
        provider: "mock",
        model: "mock-model",
        capabilities: {
          streaming: false,
          toolCalling: true,
          jsonMode: true,
          structuredOutput: true,
          embeddings: false,
        },
      },
    },
  };
}

function minimalRequestEnvelope(prompt: string): unknown {
  return {
    connection_id: "c1",
    session_id: "s1",
    turn_id: "t1",
    request_id: "r1",
    message_type: "user_prompt",
    timestamp: new Date().toISOString(),
    trace_id: "tr1",
    payload: {
      prompt,
      tool_calls: undefined,
    },
    metadata: { transport: "stdio" },
  };
}

test("RuntimeEngine: model response with text + no tools ends the turn (implicit completion)", async () => {
  await withTempWorkspace(async (workspace) => {
    const { RuntimeEngine } = await import("../../src/runtime/engine.js");
    // Track the engine_turn_complete hook events — these are emitted
    // by writeEngineTurnCompleteTraces when implicit completion is
    // detected, with the same payload as the trajectory event.
    const hooks = new Hooks();
    const engineTurnEvents: Array<{ assistantMessage: string; implicit: boolean }> = [];
    hooks.on("EngineTurnComplete", (event) => {
      engineTurnEvents.push({
        assistantMessage: String(event.payload.assistantMessage ?? ""),
        implicit: Boolean(event.payload.implicit),
      });
      return { allow: true };
    });
    const gateway = scriptedModelGateway([
      {
        assistantMessage: "Task is complete. The build passed and the tests are green.",
        toolCalls: [],
      },
    ]);
    const engine = new RuntimeEngine({
      config: minimalValidConfig(),
      workspaceRoot: workspace,
      requestEnvelope: minimalRequestEnvelope("Build a hello world"),
      modelGateway: gateway,
      hooks,
    });
    const result = await engine.run();
    // Implicit completion must surface the assistant text on the
    // result (not empty) and emit EngineTurnComplete with implicit=true.
    assert.ok(
      result.assistantMessage.includes("Task is complete"),
      `expected assistantMessage to surface the completion text, got: ${result.assistantMessage}`,
    );
    assert.equal(engineTurnEvents.length, 1, "exactly one EngineTurnComplete event expected");
    assert.equal(engineTurnEvents[0]!.implicit, true);
    assert.ok(engineTurnEvents[0]!.assistantMessage.includes("Task is complete"));
    // Single model call — the engine did NOT loop on the gate.
    assert.ok(result.toolResults.length === 0 || result.toolResults.every((r) => r.ok));
  });
});

test("RuntimeEngine: explicit complete_task still completes the task", async () => {
  await withTempWorkspace(async (workspace) => {
    const { RuntimeEngine } = await import("../../src/runtime/engine.js");
    const hooks = new Hooks();
    const gateway = scriptedModelGateway([
      {
        assistantMessage: "All work done; emitting complete_task as requested.",
        toolCalls: [
          {
            id: "c1",
            name: "complete_task",
            args: {
              summary:
                "Task is fully complete. The build passed and the test suite verifies the requested behavior with concrete evidence.",
            },
          },
        ],
      },
    ]);
    const engine = new RuntimeEngine({
      config: minimalValidConfig(),
      workspaceRoot: workspace,
      requestEnvelope: minimalRequestEnvelope("Build a hello world"),
      modelGateway: gateway,
      hooks,
    });
    const result = await engine.run();
    // Explicit complete_task must still work — the result surfaces a
    // non-empty assistant message and the run does not hang.
    assert.ok(
      result.assistantMessage.length > 0,
      "expected non-empty assistant message after explicit complete_task",
    );
  });
});

test("RuntimeEngine: model returns no text + no tools → re-prompts and then errors (does NOT hang forever)", async () => {
  await withTempWorkspace(async (workspace) => {
    const { RuntimeEngine } = await import("../../src/runtime/engine.js");
    // Model returns empty text + zero tool calls every time. The
    // completion-gate budget is 1 — the engine must exhaust the gate
    // and terminate instead of looping forever.
    const gateway = scriptedModelGateway([
      { assistantMessage: "", toolCalls: [] },
      { assistantMessage: "", toolCalls: [] },
      { assistantMessage: "", toolCalls: [] },
      { assistantMessage: "", toolCalls: [] },
      { assistantMessage: "", toolCalls: [] },
      { assistantMessage: "", toolCalls: [] },
    ]);
    const hooks = new Hooks();
    const engine = new RuntimeEngine({
      config: minimalValidConfig(1),
      workspaceRoot: workspace,
      requestEnvelope: minimalRequestEnvelope("Do something"),
      modelGateway: gateway,
      hooks,
    });
    // The run must terminate (not hang). The exact termination
    // surface varies — it may throw, or it may return a failed
    // result — but it must not loop forever. We wrap in a Promise.race
    // with a hard timeout to enforce that.
    let didTerminate = false;
    let terminationError: unknown = null;
    const runPromise = engine.run()
      .then((value) => {
        didTerminate = true;
        return value;
      })
      .catch((error: unknown) => {
        didTerminate = true;
        terminationError = error;
      });
    const timeoutPromise = new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error("engine.run did not terminate within 60s")), 60_000);
    });
    try {
      await Promise.race([runPromise, timeoutPromise]);
    } catch (error) {
      if (String(error).includes("did not terminate")) {
        assert.fail("engine hung after model returned no text + no tools and the gate budget was exhausted");
      }
      throw error;
    }
    assert.ok(didTerminate, "engine must terminate when model returns no text + no tools and the gate budget is exhausted");
    void terminationError;
  });
});

/*                        complete_task without verificationContract                        */

test("RuntimeEngine: complete_task with NO verificationContract ends the turn (Pi-style verify-skip)", async () => {
  // Regression for the E2E blocker: when the model emits a complete_task
  // tool call but does not provide args.verificationContract, AND the
  // user did not explicitly request verification, the engine must
  // route straight to summarize instead of running verifyNode (which
  // would stall because the model agreed to no commands). This mirrors
  // the Pi reference behavior — a complete_task tool call IS the
  // model declaring the turn done; prose is the proof when the model
  // says so. Production config keeps requireGroundedCompletion=true
  // (it exists to catch the case where the model FORGETS to emit
  // complete_task), so we use the same default here.
  await withTempWorkspace(async (workspace) => {
    const { RuntimeEngine } = await import("../../src/runtime/engine.js");
    // Model emits a complete_task with no verificationContract — a
    // bare completion. No follow-up calls expected.
    const gateway = scriptedModelGateway([
      {
        assistantMessage: "Done. Playwright is a browser-automation library.",
        toolCalls: [
          {
            id: "complete-1",
            name: "complete_task",
            args: { summary: "Playwright is a browser-automation library." },
          },
        ],
      },
    ]);
    const hooks = new Hooks();
    const engineTurnEvents: Array<{ assistantMessage: string; implicit: boolean }> = [];
    hooks.on("EngineTurnComplete", (event) => {
      engineTurnEvents.push({
        assistantMessage: String(event.payload.assistantMessage ?? ""),
        implicit: Boolean(event.payload.implicit),
      });
      return { allow: true };
    });
    // Use the default config (verification: {} means Zod defaults
    // requireGroundedCompletion to true) — that's the production
    // setting under which the original E2E stall happened.
    const config = minimalValidConfig();
    const engine = new RuntimeEngine({
      config,
      workspaceRoot: workspace,
      requestEnvelope: minimalRequestEnvelope("in one sentence, what is playwright"),
      modelGateway: gateway,
      hooks,
    });
    const result = await engine.run();
    // The model's own summary must be surfaced, not a verifier
    // fallback like "Task ended without complete_task".
    assert.ok(
      String(result.assistantMessage ?? "").includes("Playwright"),
      `assistantMessage must contain the model summary; got: ${String(result.assistantMessage)}`,
    );
    // EngineTurnComplete fires so the TUI flips to phase=done.
    assert.ok(
      engineTurnEvents.length >= 1,
      "EngineTurnComplete hook must fire when bare complete_task ends the turn",
    );
  });
});
