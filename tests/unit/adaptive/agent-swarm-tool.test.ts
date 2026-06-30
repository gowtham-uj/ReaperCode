/**
 * Tests for the AgentSwarmTool — the parallel fan-out entry point
 * the main agent uses to delegate a templated task to many
 * subagents in one tool call.
 *
 * Coverage:
 *
 *   - rejects unknown model aliases (rejected status)
 *   - rejects empty items
 *   - rejects items > MAX_AGENT_SWARM_SUBAGENTS (128)
 *   - rejects prompt_template missing the {{item}} placeholder
 *   - rejects unknown subagent_type
 *   - succeeds with all completed outcomes (completed status)
 *   - partial: some completed, some failed (partial status)
 *   - all-failed (failed status)
 *   - render of <agent_swarm_result> envelope (description, subagent_type,
 *     count, <subagent> children, escape of unsafe characters in item)
 *   - resume hint appears when any item fails
 *   - resumes don't appear when all items complete
 *   - max_concurrency is clamped (1..32)
 *   - parallel scheduling: N items with concurrency K complete in
 *     roughly (N/K) batches, never all in one tick
 *   - the rendered prompt substitutes {{item}} for each item
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSwarmTool,
  MAX_AGENT_SWARM_SUBAGENTS,
  DEFAULT_MAX_CONCURRENCY,
} from "../../../src/adaptive/swarm/agent-swarm-tool.js";
import { LaborMarket, parseAgentTypeYaml } from "../../../src/adaptive/swarm/labor-market.js";
import { SubagentStore } from "../../../src/adaptive/swarm/store.js";
import type { SubagentModelFn } from "../../../src/adaptive/swarm/index.js";

/* -------------------------------------------------------------------------- */

const CODER_TYPE_YAML = `
name: coder
description: Good at general software engineering tasks.
when_to_use: Use for any non-trivial coding task.
default_model: null
supports_background: true
system_prompt_addition: "you are a subagent"
exclude_tools:
  - Agent
  - AskUserQuestion
`.trim();

function makeMarket(): LaborMarket {
  const m = new LaborMarket();
  m.addBuiltinType(parseAgentTypeYaml(CODER_TYPE_YAML, "/tmp/coder.yaml"));
  return m;
}

function makeStore(ws: string): SubagentStore {
  return new SubagentStore({ workspaceRoot: ws });
}

function withTmp<T>(prefix: string, body: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const result = body(dir);
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(cleanup);
    }
    cleanup();
    return Promise.resolve(result);
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** Build a long enough text for the runner to treat it as a final
 *  summary (skipping continuation). */
const longSummary = (lead: string) =>
  `${lead} ${"y".repeat(300)}`;

/* -------------------------------------------------------------------------- */

test("MAX_AGENT_SWARM_SUBAGENTS is 128", () => {
  assert.equal(MAX_AGENT_SWARM_SUBAGENTS, 128);
});

test("DEFAULT_MAX_CONCURRENCY is sane (>=1, <=32)", () => {
  assert.ok(DEFAULT_MAX_CONCURRENCY >= 1);
  assert.ok(DEFAULT_MAX_CONCURRENCY <= 32);
});

test("AgentSwarmTool description lists available built-in types", () => {
  const market = makeMarket();
  const store = makeStore("/tmp");
  const tool = new AgentSwarmTool({
    store,
    market,
    parentBasePrompt: "P",
    parentTools: [],
    modelCall: async () => ({ text: "x", turns: 1, toolCalls: 0, tokensUsed: 1 }),
    knownModels: ["coder"],
  });
  assert.match(tool.description, /coder/);
  assert.match(tool.description, /\{\{item\}\}/);
  assert.match(tool.description, /Available subagent types/);
});

test("AgentSwarmTool rejects unknown model alias", async () => {
  await withTmp("swarm-", async (dir) => {
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall: async () => ({ text: "x", turns: 1, toolCalls: 0, tokensUsed: 1 }),
      knownModels: ["coder"],
    });
    const r = await tool.__call__({
      description: "fan out",
      prompt_template: "Handle {{item}}",
      items: ["a"],
      model: "no-such-model",
    });
    assert.equal(r.status, "rejected");
    assert.equal(r.total, 0);
    assert.match(r.output, /Unknown model/);
  });
});

test("AgentSwarmTool rejects empty items", async () => {
  await withTmp("swarm-", async (dir) => {
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall: async () => ({ text: "x", turns: 1, toolCalls: 0, tokensUsed: 1 }),
      knownModels: [],
    });
    const r = await tool.__call__({
      description: "fan out",
      prompt_template: "Handle {{item}}",
      items: [],
    });
    assert.equal(r.status, "rejected");
    assert.match(r.output, /at least 1 item/);
  });
});

test("AgentSwarmTool rejects items above MAX_AGENT_SWARM_SUBAGENTS", async () => {
  await withTmp("swarm-", async (dir) => {
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall: async () => ({ text: "x", turns: 1, toolCalls: 0, tokensUsed: 1 }),
      knownModels: [],
    });
    const r = await tool.__call__({
      description: "fan out",
      prompt_template: "Handle {{item}}",
      items: Array.from({ length: MAX_AGENT_SWARM_SUBAGENTS + 1 }, (_, i) => `i${i}`),
    });
    assert.equal(r.status, "rejected");
    assert.match(r.output, /too many items/);
  });
});

test("AgentSwarmTool rejects prompt_template missing {{item}} placeholder", async () => {
  await withTmp("swarm-", async (dir) => {
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall: async () => ({ text: "x", turns: 1, toolCalls: 0, tokensUsed: 1 }),
      knownModels: [],
    });
    const r = await tool.__call__({
      description: "fan out",
      prompt_template: "Handle this without substitution",
      items: ["a", "b"],
    });
    assert.equal(r.status, "rejected");
    assert.match(r.output, /\{\{item\}\} placeholder/);
  });
});

test("AgentSwarmTool rejects unknown subagent_type", async () => {
  await withTmp("swarm-", async (dir) => {
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall: async () => ({ text: "x", turns: 1, toolCalls: 0, tokensUsed: 1 }),
      knownModels: [],
    });
    const r = await tool.__call__({
      description: "fan out",
      prompt_template: "Handle {{item}}",
      items: ["a"],
      subagent_type: "no-such-type",
    });
    assert.equal(r.status, "rejected");
    assert.match(r.output, /unknown subagent_type/);
  });
});

test("AgentSwarmTool returns 'completed' when every item succeeds", async () => {
  await withTmp("swarm-", async (dir) => {
    const modelCall: SubagentModelFn = async ({ prompt }) => ({
      text: longSummary(`done for ${prompt.slice(0, 30)}`),
      turns: 1,
      toolCalls: 0,
      tokensUsed: 5,
    });
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall,
      knownModels: ["coder"],
    });
    const r = await tool.__call__({
      description: "fan out",
      prompt_template: "Investigate {{item}}",
      items: ["alpha", "beta", "gamma"],
    });
    assert.equal(r.status, "completed");
    assert.equal(r.total, 3);
    assert.equal(r.completedCount, 3);
    assert.equal(r.failedCount, 0);
    assert.match(r.output, /<agent_swarm_result>/);
    assert.match(r.output, /<\/agent_swarm_result>/);
    assert.match(r.output, /<subagent item=alpha /);
    assert.match(r.output, /<subagent item=beta /);
    assert.match(r.output, /<subagent item=gamma /);
    // No resume hint when everything succeeded.
    assert.doesNotMatch(r.output, /resume a specific subagent/);
  });
});

test("AgentSwarmTool substitutes {{item}} into the rendered prompt", async () => {
  await withTmp("swarm-", async (dir) => {
    const seen: string[] = [];
    const modelCall: SubagentModelFn = async ({ prompt }) => {
      seen.push(prompt);
      return {
        text: longSummary(`done`),
        turns: 1,
        toolCalls: 0,
        tokensUsed: 5,
      };
    };
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall,
      knownModels: ["coder"],
    });
    await tool.__call__({
      description: "fan out",
      prompt_template: "Look at {{item}} and write a note.",
      items: ["alpha", "beta"],
    });
    assert.equal(seen.length, 2);
    assert.ok(seen[0]!.includes("Look at alpha"));
    assert.ok(seen[1]!.includes("Look at beta"));
    assert.ok(!seen[0]!.includes("{{item}}"));
    assert.ok(!seen[1]!.includes("{{item}}"));
  });
});

test("AgentSwarmTool returns 'partial' when some items fail", async () => {
  await withTmp("swarm-", async (dir) => {
    let calls = 0;
    const modelCall: SubagentModelFn = async () => {
      calls++;
      if (calls === 2) throw new Error("simulated subagent crash");
      return { text: longSummary("ok"), turns: 1, toolCalls: 0, tokensUsed: 1 };
    };
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall,
      knownModels: ["coder"],
    });
    const r = await tool.__call__({
      description: "fan out",
      prompt_template: "Do {{item}}",
      items: ["a", "b", "c"],
    });
    assert.equal(r.status, "partial");
    assert.equal(r.total, 3);
    assert.equal(r.completedCount, 2);
    assert.equal(r.failedCount, 1);
    // Resume hint is shown.
    assert.match(r.output, /Some subagents did not complete/);
    assert.match(r.output, /resume="<agent_id>"/);
    // The failing item has its error surfaced.
    assert.match(r.output, /simulated subagent crash/);
  });
});

test("AgentSwarmTool returns 'failed' when every item fails", async () => {
  await withTmp("swarm-", async (dir) => {
    const modelCall: SubagentModelFn = async () => {
      throw new Error("model down");
    };
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall,
      knownModels: ["coder"],
    });
    const r = await tool.__call__({
      description: "fan out",
      prompt_template: "Do {{item}}",
      items: ["a", "b"],
    });
    assert.equal(r.status, "failed");
    assert.equal(r.completedCount, 0);
    assert.equal(r.failedCount, 2);
  });
});

test("AgentSwarmTool escapes XML-unsafe characters in item values", async () => {
  await withTmp("swarm-", async (dir) => {
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall: async () => ({
        text: longSummary("ok"),
        turns: 1,
        toolCalls: 0,
        tokensUsed: 1,
      }),
      knownModels: ["coder"],
    });
    const r = await tool.__call__({
      description: "fan out",
      prompt_template: "Inspect {{item}}",
      items: [`bad & "weird" <value>`],
    });
    assert.equal(r.status, "completed");
    // & and " and < must be escaped in attribute values
    assert.match(r.output, /&amp;/);
    assert.match(r.output, /&quot;/);
    assert.match(r.output, /&lt;/);
    // and must NOT appear unescaped inside the attribute value
    assert.doesNotMatch(r.output, /<subagent item=bad & /);
  });
});

test("AgentSwarmTool honors max_concurrency (1 = fully sequential)", async () => {
  await withTmp("swarm-", async (dir) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const modelCall: SubagentModelFn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { text: longSummary("ok"), turns: 1, toolCalls: 0, tokensUsed: 1 };
    };
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall,
      knownModels: ["coder"],
    });
    const r = await tool.__call__({
      description: "fan out",
      prompt_template: "Do {{item}}",
      items: ["a", "b", "c", "d"],
      max_concurrency: 1,
    });
    assert.equal(r.status, "completed");
    assert.equal(r.total, 4);
    assert.equal(maxInFlight, 1, "concurrency=1 must never overlap calls");
  });
});

test("AgentSwarmTool runs items in parallel up to max_concurrency", async () => {
  await withTmp("swarm-", async (dir) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const modelCall: SubagentModelFn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { text: longSummary("ok"), turns: 1, toolCalls: 0, tokensUsed: 1 };
    };
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall,
      knownModels: ["coder"],
    });
    const r = await tool.__call__({
      description: "fan out",
      prompt_template: "Do {{item}}",
      items: ["a", "b", "c", "d", "e", "f"],
      max_concurrency: 3,
    });
    assert.equal(r.status, "completed");
    assert.equal(maxInFlight, 3, "max concurrency 3 must be respected");
  });
});

test("AgentSwarmTool clamps max_concurrency outside [1,32]", async () => {
  await withTmp("swarm-", async (dir) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const modelCall: SubagentModelFn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { text: longSummary("ok"), turns: 1, toolCalls: 0, tokensUsed: 1 };
    };

    // High value should be clamped to 32 (but we only have 6 items).
    const tHi = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall,
      knownModels: ["coder"],
    });
    await tHi.__call__({
      description: "fan out",
      prompt_template: "Do {{item}}",
      items: ["a", "b", "c", "d", "e", "f"],
      max_concurrency: 999,
    });
    assert.ok(maxInFlight <= 6, "high concurrency must not exceed item count");

    // Low/zero value must clamp up to 1.
    inFlight = 0;
    maxInFlight = 0;
    const tLo = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall,
      knownModels: ["coder"],
    });
    await tLo.__call__({
      description: "fan out",
      prompt_template: "Do {{item}}",
      items: ["a", "b", "c"],
      max_concurrency: 0,
    });
    assert.equal(maxInFlight, 1, "concurrency=0 must clamp up to 1");
  });
});

test("AgentSwarmTool per-subagent timeout surfaces as a failed outcome", async () => {
  await withTmp("swarm-", async (dir) => {
    const modelCall: SubagentModelFn = async () => {
      // Simulate slow model — far longer than the 1-second timeout.
      await new Promise((r) => setTimeout(r, 5000));
      return { text: longSummary("ok"), turns: 1, toolCalls: 0, tokensUsed: 1 };
    };
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall,
      knownModels: ["coder"],
    });
    const r = await tool.__call__({
      description: "fan out",
      prompt_template: "Do {{item}}",
      items: ["a"],
      timeout: 1,
    });
    assert.equal(r.status, "failed");
    assert.equal(r.failedCount, 1);
    assert.match(r.output, /timed out/);
  });
});

test("AgentSwarmTool result envelope includes subagent_type and description", async () => {
  await withTmp("swarm-", async (dir) => {
    const tool = new AgentSwarmTool({
      store: makeStore(dir),
      market: makeMarket(),
      parentBasePrompt: "P",
      parentTools: [],
      modelCall: async () => ({
        text: longSummary("ok"),
        turns: 1,
        toolCalls: 0,
        tokensUsed: 1,
      }),
      knownModels: ["coder"],
    });
    const r = await tool.__call__({
      description: "audit files",
      prompt_template: "Audit {{item}}",
      items: ["x"],
      subagent_type: "coder",
    });
    assert.equal(r.status, "completed");
    assert.match(r.output, /description: audit files/);
    assert.match(r.output, /subagent_type: coder/);
    assert.match(r.output, /count: 1/);
  });
});
