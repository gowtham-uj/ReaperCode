import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LaborMarket,
  ForegroundSubagentRunner,
  SubagentStore,
  SubagentOutputWriter,
  AgentTool,
  parseAgentTypeYaml,
  buildSystemPrompt,
  resolveTools,
  prepareSoul,
  type SubagentModelFn,
  type WireEventLike,
} from "../../../src/adaptive/swarm/index.js";
import type { AgentTypeDefinition } from "../../../src/adaptive/swarm/index.js";

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

const EXPLORE_TYPE_YAML = `
name: explore
description: Read-only explorer.
when_to_use: Use for searching the codebase.
default_model: coder
allowed_tools: [read_file]
supports_background: true
system_prompt_addition: "you are a read-only explorer"
`.trim();

function makeMarket(): LaborMarket {
  const m = new LaborMarket();
  m.addBuiltinType(parseAgentTypeYaml(CODER_TYPE_YAML, "/tmp/coder.yaml"));
  m.addBuiltinType(parseAgentTypeYaml(EXPLORE_TYPE_YAML, "/tmp/explore.yaml"));
  return m;
}

function makeStore(ws: string): SubagentStore {
  return new SubagentStore({ workspaceRoot: ws });
}

/* -------------------------------------------------------------------------- */

test("LaborMarket registers and lists built-in types", () => {
  const m = makeMarket();
  const types = m.listBuiltinTypes();
  assert.equal(types.length, 2);
  const coder = m.requireBuiltinType("coder");
  assert.equal(coder.name, "coder");
  assert.equal(coder.supportsBackground, true);
  assert.equal(coder.toolPolicy.mode, "inherit");
  assert.deepEqual(coder.toolPolicy.excludeTools, ["Agent", "AskUserQuestion"]);
  const explore = m.requireBuiltinType("explore");
  assert.equal(explore.toolPolicy.mode, "allowlist");
  assert.deepEqual(explore.toolPolicy.tools, ["read_file"]);
});

test("parseAgentTypeYaml reads frontmatter style", () => {
  const td = parseAgentTypeYaml(
    [
      "---",
      "name: test",
      "description: a test type",
      "when_to_use: testing",
      "default_model: m1",
      "supports_background: false",
      "allowed_tools: [a, b]",
      "exclude_tools: [c]",
      "---",
    ].join("\n"),
    "/tmp/test.yaml",
  );
  assert.equal(td.name, "test");
  assert.equal(td.defaultModel, "m1");
  assert.equal(td.supportsBackground, false);
  assert.deepEqual(td.toolPolicy.tools, ["a", "b"]);
  assert.deepEqual(td.toolPolicy.excludeTools, ["c"]);
});

test("SubagentStore creates an instance with persistent files", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-store-"));
  try {
    const store = makeStore(dir);
    const agentId = "atest0001";
    const record = store.createInstance({
      agentId,
      description: "test run",
      launchSpec: { agentId, subagentType: "coder", modelOverride: null, effectiveModel: null, createdAt: new Date().toISOString() },
    });
    assert.equal(record.status, "idle");
    store.appendWire(agentId, { kind: "stage", name: "ready", at: new Date().toISOString() });
    store.writePrompt(agentId, "fix the bug");
    assert.ok(existsSync(store.contextPath(agentId)));
    assert.ok(existsSync(store.wirePath(agentId)));
    assert.ok(existsSync(store.promptPath(agentId)));
    assert.ok(existsSync(store.outputPath(agentId)));
    const reloaded = store.readInstance(agentId);
    assert.equal(reloaded?.agentId, agentId);
    store.setStatus(agentId, "running_foreground");
    assert.equal(store.readInstance(agentId)?.status, "running_foreground");
    store.setStatus(agentId, "idle");
    assert.equal(store.readInstance(agentId)?.status, "idle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SubagentOutputWriter appends stage and summary events", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-out-"));
  try {
    const out = join(dir, "transcript");
    const w = new SubagentOutputWriter(out);
    w.stage("started");
    w.toolCall("read_file");
    w.toolResult("ok", "read 4 lines");
    w.summary("done. changed 1 file.");
    const text = readFileSync(out, "utf8");
    assert.ok(text.includes("[stage] started"));
    assert.ok(text.includes("[tool] read_file"));
    assert.ok(text.includes("[tool_result] ok: read 4 lines"));
    assert.ok(text.includes("[summary]"));
    assert.ok(text.includes("changed 1 file"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildSystemPrompt composes parent base + addition", () => {
  const td: AgentTypeDefinition = {
    name: "x",
    description: "",
    whenToUse: "",
    defaultModel: null,
    toolPolicy: { mode: "inherit", tools: [], excludeTools: [] },
    supportsBackground: false,
    systemPromptAddition: "addition",
    sourcePath: "/tmp/x.yaml",
  };
  const out = buildSystemPrompt("base", td);
  assert.ok(out.startsWith("base"));
  assert.ok(out.includes("addition"));
});

test("resolveTools inherits minus excludes", () => {
  const policy = { mode: "inherit" as const, tools: [], excludeTools: ["Agent", "WriteFile"] };
  assert.deepEqual(resolveTools(policy, ["read_file", "WriteFile", "Agent"]), ["read_file"]);
});

test("resolveTools allowlist filters by parent tools", () => {
  const policy = { mode: "allowlist" as const, tools: ["read_file", "missing"], excludeTools: [] };
  assert.deepEqual(resolveTools(policy, ["read_file", "WriteFile"]), ["read_file"]);
});

test("ForegroundSubagentRunner runs and writes transcript + summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-run-"));
  try {
    const market = makeMarket();
    const store = makeStore(dir);
    const modelCall: SubagentModelFn = async ({ prompt, onEvent }) => {
      onEvent({ kind: "stage", name: "thinking" });
      onEvent({ kind: "tool_call", name: "read_file" });
      onEvent({ kind: "tool_result", status: "ok", brief: "ok" });
      onEvent({ kind: "text", text: "found it" });
      // Long enough summary to skip continuation
      return { text: "Summary: " + prompt.repeat(20), turns: 3, toolCalls: 2, tokensUsed: 100 };
    };
    const runner = new ForegroundSubagentRunner({
      store,
      market,
      modelCall,
      parentBasePrompt: "You are the parent.",
      parentTools: ["read_file", "edit_file", "Agent", "WriteFile"],
    });
    const result = await runner.run({
      description: "fix bug",
      prompt: "Fix the bug in module X. " + "y".repeat(300),
      requestedType: "coder",
      model: null,
      resume: null,
      timeout: null,
    });
    assert.equal(result.status, "completed");
    assert.ok(result.summary.length >= 200, "summary should be long enough to skip continuation");
    assert.equal(result.turns, 3);
    assert.equal(result.toolCalls, 2);
    // The subagent must NOT have the Agent tool (excluded by policy)
    // — we can't assert that directly, but the policy resolved it.
    const out = readFileSync(store.outputPath(result.agentId), "utf8");
    assert.ok(out.includes("[stage]"));
    assert.ok(out.includes("[summary]"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ForegroundSubagentRunner runs summary continuation when output is too short", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-cont-"));
  try {
    const market = makeMarket();
    const store = makeStore(dir);
    let calls = 0;
    const modelCall: SubagentModelFn = async ({ prompt, onEvent }) => {
      calls++;
      onEvent({ kind: "text", text: "ok" });
      if (calls === 1) return { text: "too short", turns: 1, toolCalls: 0, tokensUsed: 10 };
      return { text: "Here is a more detailed summary of what I found. ".repeat(5), turns: 1, toolCalls: 0, tokensUsed: 10 };
    };
    const runner = new ForegroundSubagentRunner({
      store,
      market,
      modelCall,
      parentBasePrompt: "P",
      parentTools: ["read_file"],
    });
    const result = await runner.run({
      description: "fix",
      prompt: "p",
      requestedType: "coder",
      model: null,
      resume: null,
      timeout: null,
    });
    assert.equal(result.status, "completed");
    assert.equal(calls, 2, "should have run continuation");
    assert.ok(result.summary.length >= 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ForegroundSubagentRunner returns failed when agent throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-fail-"));
  try {
    const market = makeMarket();
    const store = makeStore(dir);
    const modelCall: SubagentModelFn = async () => {
      throw new Error("model crashed");
    };
    const runner = new ForegroundSubagentRunner({
      store, market, modelCall, parentBasePrompt: "P", parentTools: [],
    });
    const result = await runner.run({
      description: "fix", prompt: "p", requestedType: "coder",
      model: null, resume: null, timeout: null,
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /model crashed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AgentTool rejects unknown model aliases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-tool-"));
  try {
    const market = makeMarket();
    const store = makeStore(dir);
    const tool = new AgentTool({
      store, market,
      parentBasePrompt: "P", parentTools: [],
      modelCall: async () => ({ text: "x", turns: 1, toolCalls: 0, tokensUsed: 1 }),
      knownModels: ["coder", "explore"],
    });
    const r = await tool.__call__({ description: "x", prompt: "p", model: "unknown-model" });
    assert.equal(r.status, "rejected");
    assert.match(r.output, /Unknown model/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AgentTool runs foreground and returns formatted result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-tool-"));
  try {
    const market = makeMarket();
    const store = makeStore(dir);
    const tool = new AgentTool({
      store, market,
      parentBasePrompt: "P", parentTools: ["read_file"],
      modelCall: async ({ prompt }) => ({ text: "answer: " + prompt.repeat(15), turns: 1, toolCalls: 0, tokensUsed: 1 }),
      knownModels: ["coder"],
    });
    const r = await tool.__call__({ description: "test", prompt: "go", subagent_type: "coder" });
    assert.equal(r.status, "completed");
    assert.ok(r.agentId);
    assert.match(r.output, /agent_id:/);
    assert.match(r.output, /status: completed/);
    assert.match(r.output, /\[summary\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AgentTool description is rendered from LaborMarket", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-tool-"));
  try {
    const market = makeMarket();
    const store = makeStore(dir);
    const tool = new AgentTool({
      store, market, parentBasePrompt: "P", parentTools: [],
      modelCall: async () => ({ text: "x", turns: 1, toolCalls: 0, tokensUsed: 0 }),
      knownModels: [],
    });
    assert.match(tool.description, /coder/);
    assert.match(tool.description, /explore/);
    assert.match(tool.description, /Available Built-in Agent Types/);
    assert.match(tool.description, /Usage:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareSoul writes the prompt snapshot and resolves tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-prep-"));
  try {
    const market = makeMarket();
    const store = makeStore(dir);
    const td = market.requireBuiltinType("coder");
    const soul = prepareSoul({
      agentId: "a1",
      typeDef: td,
      parentBasePrompt: "PARENT",
      parentTools: ["read_file", "edit_file", "Agent", "AskUserQuestion", "write_file"],
      prompt: "fix bug",
      resumed: false,
      store,
    });
    assert.ok(soul.systemPrompt.includes("PARENT"));
    assert.ok(soul.systemPrompt.includes("you are a subagent"));
    // Agent and AskUserQuestion are in exclude list for coder, write_file and
    // edit_file and read_file are allowed.
    assert.deepEqual(soul.tools.sort(), ["edit_file", "read_file", "write_file"].sort());
    // Prompt snapshot exists
    assert.ok(existsSync(store.promptPath("a1")));
    assert.equal(readFileSync(store.promptPath("a1"), "utf8"), "fix bug");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
