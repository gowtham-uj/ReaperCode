/**
 * Long-horizon LIVE MiniMax evaluation.
 *
 * Drives ReaperCode's RuntimeEngine against the real MiniMax-M3 model
 * (via createLiveReaperGateway) on a substantial multi-phase CLI-tool
 * build task, wrapping the live gateway in a TraceCapturingGateway that
 * snapshots every model request/response and tool call. The full trace
 * is written to /tmp/reaper-minimax-trace.json for downstream analysis.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import { COCKPIT_OPEN, COCKPIT_CLOSE } from "../../src/runtime/context-cockpit.js";
import { createValidRequestEnvelope } from "../fixtures/phase0.js";
import { createLiveReaperGateway } from "../fixtures/live-gateway.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

// `test(...)`'s `skip` option is evaluated synchronously at registration
// time, before createLiveReaperGateway() would otherwise load /work/.env.
// Load it eagerly here so process.env.MINIMAX_API_KEY is populated before
// the skip condition below is checked.
(function loadWorkspaceDotEnvEagerly(): void {
  for (const candidate of [path.resolve(process.cwd(), ".env"), "/workspace/.env"]) {
    if (!existsSync(candidate)) continue;
    const content = readFileSync(candidate, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) continue;
      const key = match[1]!;
      if (process.env[key]) continue;
      const raw = (match[2] ?? "").trim();
      process.env[key] =
        (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
          ? raw.slice(1, -1)
          : raw;
    }
  }
})();
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
import type { ToolResult } from "../../src/tools/types.js";

const TRACE_OUTPUT_PATH = "/tmp/reaper-minimax-trace.json";

interface CockpitTurnSnapshot {
  turn: number;
  content: string | null;
  bytes: number;
}

interface TracedToolResult {
  turn: number;
  name: string;
  ok: boolean;
  error?: string;
}

interface TraceData {
  model_turns: number;
  tool_calls_total: number;
  tool_calls_by_name: Record<string, number>;
  system_prompts: string[];
  cockpit_per_turn: CockpitTurnSnapshot[];
  tool_results: TracedToolResult[];
  verification_ok: boolean;
  summary_assistant_message: string;
  duration_ms: number;
  final_files: string[];
  // Extra bookkeeping (not required by the spec, but useful for turn
  // attribution of tool_results captured only from the engine result).
  tool_calls_per_turn: number[];
}

function extractCockpit(messages: GenerateRequest["messages"]): string | null {
  for (const message of messages) {
    if (
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith(COCKPIT_OPEN) &&
      message.content.endsWith(COCKPIT_CLOSE)
    ) {
      return message.content;
    }
  }
  return null;
}

class TraceCapturingGateway implements ModelGateway {
  constructor(
    private readonly inner: ModelGateway,
    private readonly trace: TraceData,
  ) {}

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return this.inner.resolveRole(role);
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    return this.inner.generate(request);
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.trace.model_turns += 1;
    const turnNumber = this.trace.model_turns;
    this.trace.system_prompts.push(request.system ?? "");
    const cockpit = extractCockpit(request.messages);
    this.trace.cockpit_per_turn.push({
      turn: turnNumber,
      content: cockpit,
      bytes: cockpit ? Buffer.byteLength(cockpit, "utf8") : 0,
    });

    let toolCallsThisTurn = 0;
    for await (const event of this.inner.stream(request)) {
      if (event.type === "tool_call") {
        this.trace.tool_calls_total += 1;
        toolCallsThisTurn += 1;
        const data = event.data as { name?: string } | undefined;
        const name = typeof data?.name === "string" ? data.name : "unknown";
        this.trace.tool_calls_by_name[name] = (this.trace.tool_calls_by_name[name] ?? 0) + 1;
      }
      yield event;
    }
    this.trace.tool_calls_per_turn.push(toolCallsThisTurn);
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return this.inner.embed(request);
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return this.inner.countTokens(request);
  }

  async dispose(): Promise<void> {
    return this.inner.dispose?.() ?? Promise.resolve();
  }
}

/** Attribute the engine's flat toolResults array to model turns using the
 *  per-turn tool_call counts captured while streaming. The engine appends
 *  tool results to a single ordered array in the exact order the model's
 *  tool_calls were emitted (per streamMainAgentResponseWithTransportRetry
 *  -> mainAgentNode's inner loop), so a running-count slice reconstructs
 *  turn attribution without touching engine internals. */
function attributeToolResultsToTurns(toolResults: ToolResult[], toolCallsPerTurn: number[]): TracedToolResult[] {
  const attributed: TracedToolResult[] = [];
  let cursor = 0;
  for (let turnIndex = 0; turnIndex < toolCallsPerTurn.length; turnIndex += 1) {
    const count = toolCallsPerTurn[turnIndex] ?? 0;
    const turnNumber = turnIndex + 1;
    for (let i = 0; i < count && cursor < toolResults.length; i += 1, cursor += 1) {
      const result = toolResults[cursor]!;
      attributed.push({
        turn: turnNumber,
        name: result.name,
        ok: result.ok,
        ...(result.error?.message ? { error: result.error.message } : {}),
      });
    }
  }
  // Any leftover results (e.g. synthesized checkpoint/git results appended
  // outside the live streaming loop) get attributed to the final turn.
  const finalTurn = toolCallsPerTurn.length;
  while (cursor < toolResults.length) {
    const result = toolResults[cursor]!;
    attributed.push({
      turn: finalTurn,
      name: result.name,
      ok: result.ok,
      ...(result.error?.message ? { error: result.error.message } : {}),
    });
    cursor += 1;
  }
  return attributed;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".reaper" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(root, full));
      }
    }
  }
  await walk(root);
  return out.sort();
}

async function snapshotMtimes(root: string, files: string[]): Promise<Map<string, number>> {
  const snapshot = new Map<string, number>();
  for (const file of files) {
    try {
      const info = await stat(path.join(root, file));
      snapshot.set(file, info.mtimeMs);
    } catch {
      /* file may have raced a delete; skip */
    }
  }
  return snapshot;
}

test(
  "live Reaper (MiniMax-M3) solves a long-horizon multi-phase CLI-tool build task",
  { skip: !process.env.MINIMAX_API_KEY, timeout: 15 * 60_000 },
  async () => {
    const workspaceRoot = await createTempWorkspace();
    const filesBeforeList = await listFilesRecursive(workspaceRoot);
    const filesBefore = new Set(filesBeforeList);
    const mtimesBefore = await snapshotMtimes(workspaceRoot, filesBeforeList);

    const request = createValidRequestEnvelope();
    request.payload = {
      prompt: [
        "Build a CLI note-taking tool 'notes' in TypeScript with the following subcommands:",
        "  notes add <title> <body>     # add a note",
        "  notes list                  # list all notes (sorted by date desc)",
        "  notes show <id>             # show one note",
        "  notes delete <id>           # delete a note",
        "  notes search <query>        # search notes by substring",
        "  notes tag <id> <tag>        # add a tag to a note",
        "  notes export <file>         # export to JSON",
        "",
        "Requirements:",
        "- Single-file persistence (./notes.json in cwd), no external deps",
        "- TypeScript with strict types, no 'any'",
        "- Use Node's built-in crypto for IDs (uuid v4 shape)",
        "- Full test coverage with node:test",
        "- README.md with usage examples",
        "- Complete only after npm test passes",
      ].join("\n"),
    };

    const { config, gateway: liveGateway } = createLiveReaperGateway("longhorizon-minimax-eval", "minimax", "MiniMax-M3");

    const trace: TraceData = {
      model_turns: 0,
      tool_calls_total: 0,
      tool_calls_by_name: {},
      system_prompts: [],
      cockpit_per_turn: [],
      tool_results: [],
      verification_ok: false,
      summary_assistant_message: "",
      duration_ms: 0,
      final_files: [],
      tool_calls_per_turn: [],
    };

    const tracingGateway = new TraceCapturingGateway(liveGateway, trace);

    const engine = new RuntimeEngine({
      config,
      workspaceRoot,
      requestEnvelope: request,
      modelGateway: tracingGateway,
    });

    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof engine.run>> | undefined;
    let runError: unknown;
    try {
      result = await engine.run();
    } catch (error) {
      runError = error;
    }
    trace.duration_ms = Date.now() - startedAt;

    trace.tool_results = attributeToolResultsToTurns(result?.toolResults ?? [], trace.tool_calls_per_turn);
    trace.verification_ok = result?.verification?.ok === true;
    trace.summary_assistant_message = result?.assistantMessage ?? (runError ? `[error] ${String(runError)}` : "");

    const filesAfter = await listFilesRecursive(workspaceRoot);
    const mtimesAfter = await snapshotMtimes(workspaceRoot, filesAfter);
    trace.final_files = filesAfter.filter((f) => {
      if (!filesBefore.has(f)) return true; // newly created
      return mtimesAfter.get(f) !== mtimesBefore.get(f); // modified
    });

    await writeFile(TRACE_OUTPUT_PATH, JSON.stringify(trace, null, 2), "utf8");

    if (runError) throw runError;

    assert.ok(trace.model_turns > 0, "expected at least one model turn");
    assert.ok(result, "engine run should produce a result");
  },
);
