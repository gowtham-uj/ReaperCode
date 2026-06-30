/**
 * ForegroundSubagentRunner — runs a single subagent synchronously
 * and returns a compact `SubagentResult` (summary text) to the
 * main agent.
 *
 * Lifecycle:
 *  1. Resolve AgentTypeDefinition from LaborMarket
 *  2. Create or resume an AgentInstanceRecord
 *  3. Build a SubagentOutputWriter tee'd to the store's wire file
 *  4. prepareSoul() to compute system prompt + tool list + final prompt
 *  5. Fire SubagentStart hook
 *  6. Call the model gateway; append tool calls and results to writer
 *  7. If the final summary is too short, run a continuation prompt
 *  8. Fire SubagentStop hook
 *  9. Update the instance record and return SubagentResult
 *
 * Subagents cannot spawn other subagents by default. The Agent tool
 * is not in the parent's tool set as far as the subagent is concerned.
 */

import { SubagentStore, readContextMessages } from "./store.js";
import { SubagentOutputWriter } from "./output-writer.js";
import { LaborMarket } from "./labor-market.js";
import {
  prepareSoul,
  type SubagentModelFn,
  type WireEventLike,
} from "./prepare.js";
import type {
  AgentInstanceRecord,
  AgentLaunchSpec,
  AgentTypeDefinition,
  ForegroundRunRequest,
  SubagentResult,
  SubagentStatus,
  WireEvent,
} from "./types.js";

const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
const SUMMARY_CONTINUATION_PROMPT = `
Your previous response was too brief. Please provide a more comprehensive summary that includes:

1. Specific technical details and implementations
2. Detailed findings and analysis
3. All important information that the parent agent should know
`.trim();

export interface ForegroundRunnerOptions {
  store: SubagentStore;
  market: LaborMarket;
  modelCall: SubagentModelFn;
  parentBasePrompt: string;
  parentTools: string[];
  hookEngine?: SubagentHookEngine | undefined;
}

export interface SubagentHookEvent {
  name: "SubagentStart" | "SubagentStop";
  agentId: string;
  subagentType: string;
  prompt?: string;
  response?: string;
}

export type SubagentHookEngine = {
  trigger(event: SubagentHookEvent): Promise<void>;
  fireAndForgetTrigger(event: SubagentHookEvent): void;
};

export class ForegroundSubagentRunner {
  private readonly store: SubagentStore;
  private readonly market: LaborMarket;
  private readonly modelCall: SubagentModelFn;
  private readonly parentBasePrompt: string;
  private readonly parentTools: string[];
  private readonly hookEngine: SubagentHookEngine | undefined;

  constructor(opts: ForegroundRunnerOptions) {
    this.store = opts.store;
    this.market = opts.market;
    this.modelCall = opts.modelCall;
    this.parentBasePrompt = opts.parentBasePrompt;
    this.parentTools = opts.parentTools;
    this.hookEngine = opts.hookEngine;
  }

  /** Run a subagent. Always returns a SubagentResult; on failure, the
   *  result has `status: "failed"` and an `error` field. */
  async run(req: ForegroundRunRequest): Promise<SubagentResult> {
    const prepared = await this.prepareInstance(req);
    const typeDef = this.market.requireBuiltinType(prepared.actualType);
    const agentId = prepared.record.agentId;

    const writer = new SubagentOutputWriter(this.store.outputPath(agentId));
    writer.stage("runner_started");

    let launchSpec: AgentLaunchSpec = prepared.record.launchSpec;
    if (req.model !== null) {
      launchSpec = { ...launchSpec, modelOverride: req.model, effectiveModel: req.model };
    }

    const soul = prepareSoul({
      agentId,
      typeDef,
      parentBasePrompt: this.parentBasePrompt,
      parentTools: this.parentTools,
      prompt: req.prompt,
      resumed: prepared.resumed,
      store: this.store,
    });

    this.setStatus(agentId, "running_foreground", req.description);
    this.fireStart(agentId, typeDef.name, req.prompt);

    const startedAt = Date.now();
    const ac = new AbortController();

    let result: SubagentResult;
    try {
      writer.stage("run_soul_start");
      const r = await this.runWithSummaryContinuation(soul, typeDef, ac.signal, writer);
      if (r.failure) {
        this.setStatus(agentId, "failed");
        writer.stage(`failed: ${r.failure.brief}`);
        result = {
          agentId,
          actualSubagentType: typeDef.name,
          requestedSubagentType: prepared.record.subagentType,
          resumed: prepared.resumed,
          status: "failed",
          summary: "",
          ...(r.failure.message !== undefined ? { error: r.failure.message } : {}),
          durationMs: Date.now() - startedAt,
          turns: r.turns,
          toolCalls: r.toolCalls,
          tokensUsed: r.tokensUsed,
          outputPath: this.store.outputPath(agentId),
        };
      } else {
        this.setStatus(agentId, "idle");
        writer.stage("run_soul_finished");
        writer.summary(r.summary);
        result = {
          agentId,
          actualSubagentType: typeDef.name,
          requestedSubagentType: prepared.record.subagentType,
          resumed: prepared.resumed,
          status: "completed",
          summary: r.summary,
          durationMs: Date.now() - startedAt,
          turns: r.turns,
          toolCalls: r.toolCalls,
          tokensUsed: r.tokensUsed,
          outputPath: this.store.outputPath(agentId),
        };
      }
      this.fireStop(agentId, typeDef.name, r.summary);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus(agentId, "failed");
      writer.stage(`failed_exception: ${msg}`);
      result = {
        agentId,
        actualSubagentType: typeDef.name,
        requestedSubagentType: prepared.record.subagentType,
        resumed: prepared.resumed,
        status: "failed",
        summary: "",
        error: msg,
        durationMs: Date.now() - startedAt,
        turns: 0,
        toolCalls: 0,
        tokensUsed: 0,
        outputPath: this.store.outputPath(agentId),
      };
      this.fireStop(agentId, typeDef.name, "");
    }

    return result;
  }

  /* ------------------------------------------------------------------ */

  private async prepareInstance(req: ForegroundRunRequest): Promise<{ record: AgentInstanceRecord; actualType: string; resumed: boolean }> {
    if (req.resume) {
      const record = this.store.requireInstance(req.resume);
      if (record.status === "running_foreground" || record.status === "running_background") {
        throw new Error(`agent instance ${record.agentId} is still ${record.status} and cannot be resumed concurrently`);
      }
      return { record, actualType: record.subagentType, resumed: true };
    }
    const actualType = req.requestedType || "coder";
    this.market.requireBuiltinType(actualType);
    const agentId = SubagentStore.newAgentId();
    const launchSpec: AgentLaunchSpec = {
      agentId,
      subagentType: actualType,
      modelOverride: req.model,
      effectiveModel: req.model || null,
      createdAt: new Date().toISOString(),
    };
    const record = this.store.createInstance({
      agentId,
      description: req.description,
      launchSpec,
    });
    return { record, actualType, resumed: false };
  }

  private setStatus(agentId: string, status: SubagentStatus, description?: string): void {
    const patch: Partial<AgentInstanceRecord> = { status };
    if (description !== undefined) patch.description = description;
    this.store.updateInstance(agentId, patch);
  }

  private fireStart(agentId: string, subagentType: string, prompt: string): void {
    if (!this.hookEngine) return;
    void this.hookEngine.trigger({
      name: "SubagentStart",
      agentId,
      subagentType,
      prompt: prompt.slice(0, 500),
    });
  }

  private fireStop(agentId: string, subagentType: string, response: string): void {
    if (!this.hookEngine) return;
    this.hookEngine.fireAndForgetTrigger({
      name: "SubagentStop",
      agentId,
      subagentType,
      response: response.slice(0, 500),
    });
  }

  /** Run the model and re-prompt if the summary is too short. */
  private async runWithSummaryContinuation(
    soul: ReturnType<typeof prepareSoul>,
    _typeDef: AgentTypeDefinition,
    signal: AbortSignal,
    writer: SubagentOutputWriter,
  ): Promise<{ summary: string; failure: { message: string; brief: string } | null; turns: number; toolCalls: number; tokensUsed: number }> {
    const onEvent = (ev: WireEventLike): void => {
      const at = new Date().toISOString();
      let wire: WireEvent;
      if (ev.kind === "stage") wire = { kind: "stage", name: ev.name, at };
      else if (ev.kind === "tool_call") wire = { kind: "tool_call", name: ev.name, at };
      else if (ev.kind === "tool_result") wire = { kind: "tool_result", status: ev.status, brief: ev.brief, at };
      else wire = { kind: "text", text: ev.text, at };
      writer.writeWireEvent(wire);
    };

    let totalTurns = 0;
    let totalToolCalls = 0;
    let totalTokens = 0;
    let summary = "";
    let failure: { message: string; brief: string } | null = null;

    try {
      const r1 = await this.modelCall({
        agentId: soul.systemPrompt.length === 0 ? "" : "",
        systemPrompt: soul.systemPrompt,
        tools: soul.tools,
        prompt: soul.finalPrompt,
        signal,
        onEvent,
      });
      totalTurns += r1.turns;
      totalToolCalls += r1.toolCalls;
      totalTokens += r1.tokensUsed;
      summary = r1.text;
    } catch (e) {
      failure = { message: e instanceof Error ? e.message : String(e), brief: "agent run error" };
      return { summary, failure, turns: totalTurns, toolCalls: totalToolCalls, tokensUsed: totalTokens };
    }

    let remaining = SUMMARY_CONTINUATION_ATTEMPTS;
    while (remaining > 0 && summary.length < SUMMARY_MIN_LENGTH) {
      remaining -= 1;
      try {
        const r2 = await this.modelCall({
          agentId: "",
          systemPrompt: soul.systemPrompt,
          tools: soul.tools,
          prompt: SUMMARY_CONTINUATION_PROMPT,
          signal,
          onEvent,
        });
        totalTurns += r2.turns;
        totalToolCalls += r2.toolCalls;
        totalTokens += r2.tokensUsed;
        summary = (summary + "\n" + r2.text).trim();
      } catch (e) {
        // Continuation failure is not fatal; keep what we have.
        break;
      }
    }

    if (summary.length === 0) {
      failure = { message: "agent completed but produced no output", brief: "empty output" };
    }
    return { summary, failure, turns: totalTurns, toolCalls: totalToolCalls, tokensUsed: totalTokens };
  }
}

/** Re-export for convenience. */
export { readContextMessages };
