/**
 * AgentSwarmTool — the tool the main agent uses to fan out a task
 * to multiple subagents in parallel.
 *
 * The main agent calls this with:
 *   { description, subagent_type, prompt_template, items, model, timeout }
 *
 * `prompt_template` must contain the `{{item}}` placeholder. Each
 * element of `items` is substituted in, producing one subagent per
 * item. The whole set runs in parallel (bounded by maxConcurrency).
 *
 * The result is a single formatted text block with each subagent's
 * outcome wrapped in `<subagent ...>` tags inside an
 * `<agent_swarm_result>` envelope.
 *
 * Subagents cannot spawn further subagents (Agent/AgentSwarm are
 * excluded from their tool sets).
 */

import { ForegroundSubagentRunner, type SubagentHookEngine } from "./runner.js";
import { SubagentStore } from "./store.js";
import { LaborMarket } from "./labor-market.js";
import type { SubagentResult } from "./types.js";
import type { SubagentModelFn } from "./prepare.js";

/** Hard cap on items per AgentSwarm call. */
export const MAX_AGENT_SWARM_SUBAGENTS = 128;
/** Default bounded concurrency. */
export const DEFAULT_MAX_CONCURRENCY = 5;

export interface AgentSwarmToolParams {
  description: string;
  /** Subagent type for the whole swarm. Defaults to "coder". */
  subagent_type?: string | undefined;
  /** Template containing exactly one `{{item}}` placeholder. */
  prompt_template: string;
  /** Each element launches one subagent. 1..MAX_AGENT_SWARM_SUBAGENTS. */
  items: string[];
  /** Optional model override. */
  model?: string | null | undefined;
  /** Per-subagent wall timeout in seconds. null = no timeout. */
  timeout?: number | null | undefined;
  /** Optional override for the bounded concurrency. 1..32. */
  max_concurrency?: number | undefined;
}

export interface AgentSwarmToolOptions {
  store: SubagentStore;
  market: LaborMarket;
  parentBasePrompt: string;
  parentTools: string[];
  hookEngine?: SubagentHookEngine | undefined;
  modelCall: SubagentModelFn;
  /** Cap the parallelism of the swarm. */
  maxConcurrency?: number;
  /** Known model aliases. If `model` is set, it must be in this list. */
  knownModels: string[];
}

export interface AgentSwarmItemOutcome {
  item: string;
  agentId: string;
  outcome: "completed" | "failed" | "killed";
  summary: string;
  error?: string | undefined;
  durationMs: number;
  tokensUsed: number;
}

export interface AgentSwarmToolResult {
  output: string;
  status: "completed" | "partial" | "failed" | "rejected";
  completedCount: number;
  failedCount: number;
  total: number;
}

interface ResolvedItem {
  raw: string;
  rendered: string;
}

export class AgentSwarmTool {
  readonly name = "AgentSwarm";
  readonly description: string;

  private readonly store: SubagentStore;
  private readonly market: LaborMarket;
  private readonly parentBasePrompt: string;
  private readonly parentTools: string[];
  private readonly hookEngine: SubagentHookEngine | undefined;
  private readonly modelCall: SubagentModelFn;
  private readonly maxConcurrency: number;
  private readonly knownModels: string[];

  constructor(opts: AgentSwarmToolOptions) {
    this.store = opts.store;
    this.market = opts.market;
    this.parentBasePrompt = opts.parentBasePrompt;
    this.parentTools = opts.parentTools;
    this.hookEngine = opts.hookEngine;
    this.modelCall = opts.modelCall;
    this.maxConcurrency = clampConcurrency(opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.knownModels = opts.knownModels;
    this.description = renderToolDescription(this.market);
  }

  /** Invoke the tool. Returns a formatted `<agent_swarm_result>` text
   *  block. The runtime layer is responsible for surfacing that text
   *  to the main agent as the tool result. */
  async __call__(params: AgentSwarmToolParams): Promise<AgentSwarmToolResult> {
    if (params.model && !this.knownModels.includes(params.model)) {
      return {
        output: `Unknown model alias: ${params.model}`,
        status: "rejected",
        completedCount: 0,
        failedCount: 0,
        total: 0,
      };
    }

    if (params.items.length < 1) {
      return {
        output: "AgentSwarm: at least 1 item is required.",
        status: "rejected",
        completedCount: 0,
        failedCount: 0,
        total: 0,
      };
    }

    if (params.items.length > MAX_AGENT_SWARM_SUBAGENTS) {
      return {
        output: `AgentSwarm: too many items (${params.items.length} > ${MAX_AGENT_SWARM_SUBAGENTS}).`,
        status: "rejected",
        completedCount: 0,
        failedCount: 0,
        total: 0,
      };
    }

    if (!params.prompt_template.includes("{{item}}")) {
      return {
        output: "AgentSwarm: prompt_template must contain the {{item}} placeholder.",
        status: "rejected",
        completedCount: 0,
        failedCount: 0,
        total: 0,
      };
    }

    const subagentType = params.subagent_type ?? "coder";
    if (!this.market.getBuiltinType(subagentType)) {
      return {
        output: `AgentSwarm: unknown subagent_type "${subagentType}".`,
        status: "rejected",
        completedCount: 0,
        failedCount: 0,
        total: 0,
      };
    }

    const items: ResolvedItem[] = params.items.map((raw) => ({
      raw,
      rendered: params.prompt_template.replaceAll("{{item}}", raw),
    }));

    const concurrency = clampConcurrency(params.max_concurrency ?? this.maxConcurrency);
    const outcomes = await runWithConcurrency(
      items,
      concurrency,
      (item) => this.runOne(item, subagentType, params.model ?? null, params.timeout ?? null),
    );

    const completed = outcomes.filter((o) => o.outcome === "completed").length;
    const failed = outcomes.length - completed;
    const status: AgentSwarmToolResult["status"] =
      completed === outcomes.length
        ? "completed"
        : completed === 0
          ? "failed"
          : "partial";

    return {
      output: formatSwarmResult({
        description: params.description,
        subagentType,
        outcomes,
      }),
      status,
      completedCount: completed,
      failedCount: failed,
      total: outcomes.length,
    };
  }

  private async runOne(
    item: ResolvedItem,
    subagentType: string,
    model: string | null,
    timeout: number | null,
  ): Promise<AgentSwarmItemOutcome> {
    const runner = new ForegroundSubagentRunner({
      store: this.store,
      market: this.market,
      modelCall: this.modelCall,
      parentBasePrompt: this.parentBasePrompt,
      parentTools: this.parentTools,
      ...(this.hookEngine !== undefined ? { hookEngine: this.hookEngine } : {}),
    });

    try {
      const result: SubagentResult = timeout
        ? await runWithTimeout(
            () => runner.run({
              description: `swarm item: ${truncate(item.raw, 80)}`,
              prompt: item.rendered,
              requestedType: subagentType,
              model,
              resume: null,
              timeout,
            }),
            timeout * 1000,
          )
        : await runner.run({
            description: `swarm item: ${truncate(item.raw, 80)}`,
            prompt: item.rendered,
            requestedType: subagentType,
            model,
            resume: null,
            timeout: null,
          });

      return {
        item: item.raw,
        agentId: result.agentId,
        outcome: result.status,
        summary: result.summary ?? "",
        ...(result.error ? { error: result.error } : {}),
        durationMs: result.durationMs,
        tokensUsed: result.tokensUsed,
      };
    } catch (e) {
      return {
        item: item.raw,
        agentId: "(none)",
        outcome: "failed",
        summary: "",
        error: String((e as Error).message ?? e),
        durationMs: 0,
        tokensUsed: 0,
      };
    }
  }
}

/* -------------------------------------------------------------------------- */

function renderToolDescription(market: LaborMarket): string {
  const types = market.listBuiltinTypes();
  const lines: string[] = [
    "Run a subagent swarm — a set of independent subagent instances launched in parallel from a single tool call.",
    "",
    "The AgentSwarm tool takes a `prompt_template` containing the `{{item}}` placeholder and a list of `items`;",
    "each item is substituted into the template and a separate subagent is launched to handle the rendered prompt.",
    "All subagents in a single AgentSwarm call share the same `subagent_type` and (optionally) `model`.",
    "",
    "Decompose work as finely as possible while keeping subagent responsibilities non-conflicting.",
    "Subagents have your full capabilities (read/write, commands, search, etc., subject to their profile).",
    "Do not overload their prompts with excessive detail — they will follow up with focused tool calls.",
    "",
    "Each subagent's transcript is independent. The only thing you (the parent) see is the formatted",
    "<agent_swarm_result> block summarizing every subagent's outcome. You do not see their intermediate context.",
    "",
    `Constraints:`,
    `- Up to ${MAX_AGENT_SWARM_SUBAGENTS} items per call.`,
    `- At least 1 item is required.`,
    `- The template must include the literal placeholder {{item}} exactly once.`,
    `- Bounded concurrency (default 5) — items run in parallel up to the cap, queueing beyond it.`,
    "",
    "Available subagent types (same as the Agent tool):",
  ];
  for (const t of types) {
    const toolSummary = t.toolPolicy.mode === "allowlist"
      ? (t.toolPolicy.tools.length === 0 ? "(none)" : t.toolPolicy.tools.join(", "))
      : "*";
    const model = t.defaultModel ?? "inherit";
    const wtu = t.whenToUse ? ` When to use: ${t.whenToUse.replace(/\s+/g, " ").trim()}` : "";
    lines.push(`- \`${t.name}\`: ${t.description} (Tools: ${toolSummary}, Model: ${model}).${wtu}`);
  }
  lines.push(
    "",
    "Usage:",
    "- Always provide a short `description` (3-5 words).",
    "- `prompt_template` is required and must contain `{{item}}`.",
    "- Use `subagent_type` to pick a built-in type; default `coder`.",
    "- Use `model` to override the built-in type's default.",
    "- `timeout` is the per-subagent wall timeout in seconds (default: none).",
    "- `max_concurrency` defaults to 5; set lower for slow/heavy subagents, higher for fast ones.",
    "- The result is a single text block with one <subagent> per item; the parent agent decides what to do next.",
  );
  return lines.join("\n");
}

function formatSwarmResult(input: {
  description: string;
  subagentType: string;
  outcomes: AgentSwarmItemOutcome[];
}): string {
  const lines: string[] = ["<agent_swarm_result>"];
  lines.push(`description: ${input.description}`);
  lines.push(`subagent_type: ${input.subagentType}`);
  lines.push(`count: ${input.outcomes.length}`);
  for (const o of input.outcomes) {
    const attrs = [
      `item=${xmlAttr(o.item)}`,
      `agent_id=${o.agentId}`,
      `outcome=${o.outcome}`,
      `duration_ms=${o.durationMs}`,
      `tokens=${o.tokensUsed}`,
    ];
    lines.push(`<subagent ${attrs.join(" ")}>`);
    if (o.summary) lines.push(o.summary);
    if (o.error) lines.push(`error: ${o.error}`);
    lines.push("</subagent>");
  }
  // Resume hint if anything failed: the parent can re-launch via the Agent tool.
  const anyFailed = input.outcomes.some((o) => o.outcome !== "completed");
  if (anyFailed) {
    lines.push("");
    lines.push("Some subagents did not complete. To resume a specific subagent, use the Agent tool with `resume=\"<agent_id>\"` and a follow-up prompt.");
  }
  lines.push("</agent_swarm_result>");
  return lines.join("\n");
}

function xmlAttr(s: string): string {
  // Escape characters that would break the XML-ish attribute form.
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function clampConcurrency(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 32) return 32;
  return Math.floor(n);
}

async function runWithConcurrency<T, U>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`subagent timed out after ${ms}ms`)), ms);
    fn().then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
