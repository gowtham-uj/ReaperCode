/**
 * Mega dev task: a realistic multi-file feature addition exercised through
 * the mocked-provider integration pattern (see e2e-live-validation.test.ts).
 *
 * Seeded workspace:
 *   - src/math.ts        (add/sub/mul/div)
 *   - src/math.test.ts   (passing tests)
 *   - README.md
 *
 * Scripted model walks through:
 *   1. list_directory  — survey the workspace
 *   2. read_file       — inspect src/math.ts for style conventions
 *   3. write_file      — create src/stats.ts (mean/median/stdev)
 *   4. write_file      — create src/stats.test.ts (3+ tests)
 *   5. write_file      — update README.md to mention the new module
 *   6. bash            — run the full test suite
 *   7. (no tool_calls) — final summary message
 *
 * Every GenerateRequest sent to the mocked gateway is captured so the
 * behavioral review can inspect turn count, cockpit stability, system
 * prompt stability, and what the model saw on the first vs. last turn.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import {
  COCKPIT_OPEN,
  CURRENT_REQUEST_MESSAGE_NAME,
  countCockpitMarkers,
} from "../../src/runtime/context-cockpit.js";
import { MAIN_AGENT_SYSTEM_PROMPT_TEXT } from "../../src/runtime/system-prompt.js";
import { ProjectTrustStore } from "../../src/resources/project-trust.js";
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

class StepwiseGateway implements ModelGateway {
  readonly requests: GenerateRequest[] = [];
  private readonly responses: Array<{
    assistant_message?: string;
    tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  }>;
  private callIndex = 0;

  constructor(responses: Array<{
    assistant_message?: string;
    tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  }>) {
    this.responses = responses;
  }

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "stepwise",
      capabilities: {
        streaming: true,
        toolCalling: true,
        jsonMode: true,
        structuredOutput: true,
        embeddings: false,
      },
    };
  }

  async generate(_request: GenerateRequest): Promise<GenerateResult> {
    throw new Error("generate not used in mega dev task test");
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    // Deep-snapshot the request exactly as the engine sent it so later
    // assertions cannot be fooled by later in-place mutation of message
    // objects (the engine mutates/re-persists `liveConversation` in place).
    this.requests.push(JSON.parse(JSON.stringify(request)));
    const response = this.responses[Math.min(this.callIndex, this.responses.length - 1)] ?? { assistant_message: "Done." };
    this.callIndex += 1;
    yield { type: "message_start", data: { provider: "test", model: "stepwise" } };
    if (response.assistant_message) {
      yield { type: "message_delta", content: response.assistant_message };
    }
    for (const call of response.tool_calls ?? []) {
      yield { type: "tool_call", data: { id: call.id, name: call.name, arguments: JSON.stringify(call.args) } };
    }
    yield { type: "message_end", data: { finishReason: "stop" } };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return {
      role: "default_model",
      profileName: "default_model",
      provider: "test",
      model: "stepwise",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return Math.ceil(request.text.length / 4);
  }
}

const MATH_TS = `export function add(a: number, b: number): number {
  return a + b;
}

export function sub(a: number, b: number): number {
  return a - b;
}

export function mul(a: number, b: number): number {
  return a * b;
}

export function div(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero");
  return a / b;
}
`;

const MATH_TEST_TS = `import { add, sub, mul, div } from "./math.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("add", () => {
  assert.equal(add(2, 3), 5);
});

test("sub", () => {
  assert.equal(sub(5, 2), 3);
});

test("mul", () => {
  assert.equal(mul(4, 3), 12);
});

test("div", () => {
  assert.equal(div(10, 2), 5);
  assert.throws(() => div(1, 0));
});
`;

const README_SEED = `# Mini Project

A tiny arithmetic library.

## Modules

- \`src/math.ts\` — add, sub, mul, div
`;

const STATS_TS = `export function mean(values: number[]): number {
  if (values.length === 0) throw new Error("mean of empty array");
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of empty array");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function stdev(values: number[]): number {
  if (values.length === 0) throw new Error("stdev of empty array");
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
`;

const STATS_TEST_TS = `import { mean, median, stdev } from "./stats.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("mean", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
});

test("median odd length", () => {
  assert.equal(median([5, 1, 3]), 3);
});

test("median even length", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("stdev", () => {
  assert.equal(stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2);
});
`;

const README_UPDATED = `# Mini Project

A tiny arithmetic library.

## Modules

- \`src/math.ts\` — add, sub, mul, div
- \`src/stats.ts\` — mean, median, stdev
`;

test("mega dev task: add stats module with full test coverage", async () => {
  const workspaceRoot = await createTempWorkspace();
  const userHome = await mkdtemp(path.join(tmpdir(), "reaper-mega-home-"));
  await mkdir(path.join(userHome, ".config", "reaper"), { recursive: true });
  await ProjectTrustStore.create(userHome).set(workspaceRoot, true);

  // Seed the mini-project. createTempWorkspace() already git-inits and
  // commits src/app.ts + README.md + package.json; overwrite/extend with
  // the math module + task-specific README this test cares about.
  await writeFile(path.join(workspaceRoot, "src", "math.ts"), MATH_TS, "utf8");
  await writeFile(path.join(workspaceRoot, "src", "math.test.ts"), MATH_TEST_TS, "utf8");
  await writeFile(path.join(workspaceRoot, "README.md"), README_SEED, "utf8");

  const request = createValidRequestEnvelope();
  const userPrompt =
    "Add a new 'stats' module (mean, median, stdev) alongside the existing math module. " +
    "Write full test coverage for it, update the README to mention it, run all tests, and finish with a summary.";
  request.payload = { prompt: userPrompt };

  const gateway = new StepwiseGateway([
    // 1. Survey the workspace.
    { tool_calls: [{ id: "list-src", name: "list_directory", args: { path: "src" } }] },
    // 2. Inspect math.ts for style conventions before writing stats.ts.
    { tool_calls: [{ id: "read-math", name: "read_file", args: { path: "src/math.ts" } }] },
    // 3. Create the new stats module.
    {
      tool_calls: [
        { id: "write-stats", name: "write_file", args: { path: "src/stats.ts", content: STATS_TS } },
      ],
    },
    // 4. Create tests for it (3+ cases).
    {
      tool_calls: [
        { id: "write-stats-test", name: "write_file", args: { path: "src/stats.test.ts", content: STATS_TEST_TS } },
      ],
    },
    // 5. Update the README to mention the new module.
    {
      tool_calls: [
        { id: "write-readme", name: "write_file", args: { path: "README.md", content: README_UPDATED } },
      ],
    },
    // 6. Run the whole test suite.
    {
      tool_calls: [
        {
          id: "run-tests",
          name: "bash",
          args: {
            cmd: "node --test src/math.test.ts src/stats.test.ts",
            description: "run all tests",
            timeout: 60,
          },
        },
      ],
    },
    // 7. Natural stop with a final summary — no tool_calls.
    {
      assistant_message:
        "Added src/stats.ts (mean, median, stdev) with matching tests in src/stats.test.ts, " +
        "updated README.md to mention the new module, and confirmed all tests pass (math + stats).",
    },
  ]);

  const result = await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
    userHome,
  }).run();

  // ── Behavioral ground truth: files landed correctly on disk ──────────
  const statsSrc = await readFile(path.join(workspaceRoot, "src", "stats.ts"), "utf8");
  assert.match(statsSrc, /export function mean/);
  assert.match(statsSrc, /export function median/);
  assert.match(statsSrc, /export function stdev/);

  const statsTestSrc = await readFile(path.join(workspaceRoot, "src", "stats.test.ts"), "utf8");
  const testCaseCount = (statsTestSrc.match(/\btest\(/g) ?? []).length;
  assert.ok(testCaseCount >= 3, `expected >=3 test cases in stats.test.ts, got ${testCaseCount}`);

  const readmeSrc = await readFile(path.join(workspaceRoot, "README.md"), "utf8");
  assert.match(readmeSrc, /stats\.ts/);
  assert.match(readmeSrc, /mean, median, stdev/);

  const mathSrcUntouched = await readFile(path.join(workspaceRoot, "src", "math.ts"), "utf8");
  assert.equal(mathSrcUntouched, MATH_TS, "existing math.ts left untouched");

  // ── Tool selection: right tools, right order, nothing skipped ────────
  assert.ok(result.toolResults.length >= 6, `expected >=6 tool results, got ${result.toolResults.length}`);
  const toolNamesInOrder = result.toolResults.map((r) => r.name);
  assert.deepEqual(
    toolNamesInOrder,
    ["list_directory", "read_file", "write_file", "write_file", "write_file", "bash"],
    "tool call sequence matches the scripted dev-task walk",
  );
  assert.ok(result.toolResults.every((r) => r.ok), `all tool calls should succeed: ${JSON.stringify(result.toolResults.filter((r) => !r.ok))}`);

  const bashResult = result.toolResults.find((r) => r.name === "bash");
  assert.ok(bashResult, "bash tool ran");
  const bashOutput = typeof bashResult!.output === "string" ? bashResult!.output : JSON.stringify(bashResult!.output);
  assert.match(bashOutput, /pass 8/, "node --test reports 8 passing tests (4 math + 4 stats)");
  assert.doesNotMatch(bashOutput, /\bfail [1-9]/, "no failing tests in the run");

  // ── Workflow shape: turn count, cockpit, system prompt stability ─────
  const mainRequests = gateway.requests.filter((item) => item.source === "main_agent");
  assert.equal(mainRequests.length, 7, `expected exactly 7 main_agent turns, got ${mainRequests.length}`);

  const sys0 = mainRequests[0]!.system;
  assert.equal(sys0, MAIN_AGENT_SYSTEM_PROMPT_TEXT, "main agent receives canonical stable system prompt");
  for (const req of mainRequests) {
    assert.equal(req.system, sys0, "system bytes are byte-identical across all 7 turns");
  }

  for (const req of mainRequests) {
    const all = req.messages.map((m) => m.content).filter((c) => typeof c === "string").join("\n");
    const counts = countCockpitMarkers(all);
    assert.deepEqual(counts, { opens: 0, closes: 0 }, "no cockpit markers in any request under Pi-parity");
  }

  const first = mainRequests[0]!;
  const last = mainRequests[mainRequests.length - 1]!;

  // Pi-parity: NO cockpit bundle is injected on any turn. The model's
  // first user message is always the raw prompt; subsequent turns see
  // accumulated assistant + tool messages, nothing else.
  const cockpitFirst = first.messages.find(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(COCKPIT_OPEN),
  ) as { content: string } | undefined;
  assert.equal(cockpitFirst, undefined, "no cockpit on first request under Pi-parity");

  const cockpitLast = last.messages.find(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(COCKPIT_OPEN),
  ) as { content: string } | undefined;
  assert.equal(cockpitLast, undefined, "no cockpit on last request under Pi-parity");

  const firstUserMessage = first.messages.find(
    (m) => m.role === "user" && (m as { name?: string }).name === CURRENT_REQUEST_MESSAGE_NAME,
  );
  assert.ok(firstUserMessage, "raw prompt is the first user message under Pi-parity");
  assert.equal((firstUserMessage as { content: string }).content, userPrompt);

  // ── Context growth: message count grows turn over turn, tools land ───
  assert.ok(
    last.messages.length > first.messages.length,
    `conversation should grow as tool results accumulate: first=${first.messages.length}, last=${last.messages.length}`,
  );

  // Persist first/last full request payloads (system + messages) alongside
  // the review so a human/agent reviewer can diff exactly what the model
  // saw turn 1 vs turn 7 without re-running the suite.
  await mkdir("/tmp/reaper-mega-dev-task", { recursive: true });
  await writeFile(
    "/tmp/reaper-mega-dev-task/first-request.json",
    JSON.stringify(first, null, 2),
    "utf8",
  );
  await writeFile(
    "/tmp/reaper-mega-dev-task/last-request.json",
    JSON.stringify(last, null, 2),
    "utf8",
  );
  await writeFile(
    "/tmp/reaper-mega-dev-task/all-requests-summary.json",
    JSON.stringify(
      mainRequests.map((req, i) => ({
        turn: i + 1,
        messageCount: req.messages.length,
        toolCount: req.tools?.length ?? 0,
        systemBytes: (req.system ?? "").length,
        lastMessageRole: req.messages[req.messages.length - 1]?.role,
        lastMessagePreview:
          typeof req.messages[req.messages.length - 1]?.content === "string"
            ? (req.messages[req.messages.length - 1]!.content as string).slice(0, 200)
            : undefined,
      })),
      null,
      2,
    ),
    "utf8",
  );

  assert.equal(result.assistantMessage.length > 0, true, "final assistant message is non-empty");
  assert.match(result.assistantMessage, /stats/i);
});
