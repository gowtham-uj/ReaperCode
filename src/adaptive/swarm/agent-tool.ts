/**
 * AgentTool — the tool the main agent uses to spawn a subagent.
 *
 * The main agent calls this with `{ description, prompt, subagent_type,
 * model, resume, run_in_background, timeout }`. The result is a
 * formatted text block returned to the main context.
 *
 * The main agent never sees the subagent's full context — only the
 * formatted `SubagentResult` text. The subagent's own conversation
 * lives under `<workspace>/.reaper/swarm/<agentId>/`.
 *
 * Subagents cannot spawn other subagents by default. The Agent tool
 * itself is *not* in the parent's tool set when computing the
 * subagent's tool allowlist.
 */

import { ForegroundSubagentRunner, type SubagentHookEngine } from "./runner.js";
import { SubagentStore } from "./store.js";
import { LaborMarket } from "./labor-market.js";
import type { ForegroundRunRequest, SubagentResult } from "./types.js";

export interface AgentToolParams {
  description: string;
  prompt: string;
  subagent_type?: string | undefined;
  model?: string | null | undefined;
  resume?: string | null | undefined;
  run_in_background?: boolean | undefined;
  timeout?: number | null | undefined;
}

export interface AgentToolOptions {
  store: SubagentStore;
  market: LaborMarket;
  parentBasePrompt: string;
  parentTools: string[];
  hookEngine?: SubagentHookEngine | undefined;
  /** Returns the effective model call for foreground runs. */
  modelCall: import("./prepare.js").SubagentModelFn;
  /** Returns the effective model call for background runs. */
  backgroundModelCall?: import("./prepare.js").SubagentModelFn;
  /** Known model aliases. If a `model` param is set, it must be in
   *  this list, otherwise the tool rejects. */
  knownModels: string[];
}

export interface AgentToolResult {
  output: string;
  status: "completed" | "failed" | "killed" | "background_started" | "rejected";
  agentId: string | null;
}

const MAX_FOREGROUND_TIMEOUT = 60 * 60; // 1 hour
const MAX_BACKGROUND_TIMEOUT = 60 * 60;

export class AgentTool {
  readonly name = "Agent";
  readonly description: string;

  constructor(private readonly opts: AgentToolOptions) {
    this.description = renderToolDescription(opts.market);
  }

  /** Invoke the tool. Returns a formatted text block. The runtime
   *  layer is responsible for putting that text into the main agent's
   *  context as a tool result. */
  async __call__(params: AgentToolParams): Promise<AgentToolResult> {
    // Validate model override
    if (params.model && !this.opts.knownModels.includes(params.model)) {
      return {
        status: "rejected",
        agentId: null,
        output: `Unknown model alias: ${params.model}`,
      };
    }

    // Background mode is fire-and-forget. The main agent polls the
    // subagent store for completion.
    if (params.run_in_background) {
      return this.startBackground(params);
    }

    const req: ForegroundRunRequest = {
      description: params.description,
      prompt: params.prompt,
      requestedType: params.subagent_type ?? "coder",
      model: params.model ?? null,
      resume: params.resume ?? null,
      timeout: params.timeout ?? null,
    };

    const runner = new ForegroundSubagentRunner({
      store: this.opts.store,
      market: this.opts.market,
      modelCall: this.opts.modelCall,
      parentBasePrompt: this.opts.parentBasePrompt,
      parentTools: this.opts.parentTools,
      ...(this.opts.hookEngine !== undefined ? { hookEngine: this.opts.hookEngine } : {}),
    });

    const timeout = params.timeout ?? null;
    const timeoutMs = timeout !== null ? Math.min(timeout, MAX_FOREGROUND_TIMEOUT) * 1000 : null;
    const result: SubagentResult = timeoutMs
      ? await runWithTimeout(() => runner.run(req), timeoutMs)
      : await runner.run(req);

    return {
      status: result.status,
      agentId: result.agentId,
      output: formatResult(result),
    };
  }

  private async startBackground(params: AgentToolParams): Promise<AgentToolResult> {
    if (!this.opts.backgroundModelCall) {
      return { status: "rejected", agentId: null, output: "background execution is not configured" };
    }
    const agentId = SubagentStore.newAgentId();
    const req: ForegroundRunRequest = {
      description: params.description,
      prompt: params.prompt,
      requestedType: params.subagent_type ?? "coder",
      model: params.model ?? null,
      resume: params.resume ?? null,
      timeout: null,
    };
    const launchSpec = {
      agentId,
      subagentType: req.requestedType,
      modelOverride: req.model,
      effectiveModel: req.model,
      createdAt: new Date().toISOString(),
    };
    this.opts.store.createInstance({ agentId, description: req.description, launchSpec });
    this.opts.store.setStatus(agentId, "running_background");
    const store = this.opts.store;
    const runner = new ForegroundSubagentRunner({
      store,
      market: this.opts.market,
      modelCall: this.opts.backgroundModelCall,
      parentBasePrompt: this.opts.parentBasePrompt,
      parentTools: this.opts.parentTools,
    });
    // Fire-and-forget. Update status when it finishes.
    void (async () => {
      try {
        const r = await runner.run({ ...req, resume: agentId });
        store.setStatus(agentId, r.status === "completed" ? "idle" : r.status === "killed" ? "killed" : "failed");
      } catch {
        store.setStatus(agentId, "failed");
      }
    })();
    return {
      status: "background_started",
      agentId,
      output: `Background subagent started: ${agentId}\nsubagent_type: ${req.requestedType}\nUse TaskOutput-style polling on this id to retrieve the summary when done.`,
    };
  }
}

/* -------------------------------------------------------------------------- */

function formatResult(r: SubagentResult): string {
  const lines: string[] = [
    `agent_id: ${r.agentId}`,
    `resumed: ${r.resumed}`,
    `actual_subagent_type: ${r.actualSubagentType}`,
    `status: ${r.status}`,
  ];
  if (r.error) lines.push(`error: ${r.error}`);
  lines.push(`duration_ms: ${r.durationMs}`);
  lines.push(`turns: ${r.turns}`, `tool_calls: ${r.toolCalls}`, `tokens_used: ${r.tokensUsed}`);
  if (r.status === "completed" && r.summary) {
    lines.push("", "[summary]", r.summary);
  }
  return lines.join("\n");
}

function renderToolDescription(market: LaborMarket): string {
  const types = market.listBuiltinTypes();
  const lines: string[] = [
    "Start a subagent instance to work on a focused task.",
    "",
    "The Agent tool can either create a new subagent instance or resume an existing one by `agent_id`.",
    "Each instance keeps its own context history under the workspace, so repeated use of the same",
    "instance can preserve previous findings and work.",
    "",
    "Available Built-in Agent Types:",
  ];
  for (const t of types) {
    const toolSummary = t.toolPolicy.mode === "allowlist"
      ? (t.toolPolicy.tools.length === 0 ? "(none)" : t.toolPolicy.tools.join(", "))
      : "*";
    const model = t.defaultModel ?? "inherit";
    const bg = t.supportsBackground ? "yes" : "no";
    const wtu = t.whenToUse ? ` When to use: ${t.whenToUse.replace(/\s+/g, " ").trim()}` : "";
    lines.push(`- \`${t.name}\`: ${t.description} (Tools: ${toolSummary}, Model: ${model}, Background: ${bg}).${wtu}`);
  }
  lines.push(
    "",
    "Usage:",
    "- Always provide a short `description` (3-5 words).",
    "- Use `subagent_type` to select a built-in agent type. If omitted, `coder` is used.",
    "- Use `model` when you need to override the built-in type's default model.",
    "- Use `resume` to continue an existing instance.",
    "- Default to foreground execution. Use `run_in_background=true` only when the task can continue independently.",
    "- The subagent's result is only visible to you as a text summary. The subagent's full context is not.",
  );
  return lines.join("\n");
}

async function runWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`agent timed out after ${ms}ms`)), ms);
    fn().then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export { MAX_FOREGROUND_TIMEOUT, MAX_BACKGROUND_TIMEOUT };
