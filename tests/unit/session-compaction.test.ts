import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  compactSessionHistory,
  estimateSessionTokens,
  findCompactionCutIndex,
  type SessionCompactionInput,
} from "../../src/context/compaction/session-compaction.js";
import { createSessionEntry, ReaperSessionManager, type SessionEntry } from "../../src/session/session-manager.js";
import type { GenerateRequest, GenerateResult, ModelGateway, ModelRole, ResolvedModelProfile, StreamEvent } from "../../src/model/types.js";

function entry(input: Parameters<typeof createSessionEntry>[0]): SessionEntry {
  return createSessionEntry(input);
}

async function tempSessionFile(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return path.join(dir, "session.jsonl");
}

function fakeGateway(summary: string, calls: GenerateRequest[] = []): ModelGateway {
  const profile: ResolvedModelProfile = {
    profileName: "fast_reasoner",
    role: "fast_reasoner",
    provider: "test",
    model: "test-model",
    capabilities: { streaming: false, toolCalling: false, jsonMode: true, structuredOutput: false, embeddings: false },
  };
  return {
    async resolveRole(_role: ModelRole) { return profile; },
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      calls.push(request);
      return {
        role: request.role,
        profileName: request.role,
        provider: "test",
        model: "test-model",
        content: JSON.stringify({ summary }),
        raw: {},
      };
    },
    async *stream(): AsyncIterable<StreamEvent> {},
    async embed() { throw new Error("not implemented"); },
    async countTokens(request) { return Math.ceil(request.text.length / 4); },
  };
}

test("estimateSessionTokens uses gateway token counts when available and falls back to chars", async () => {
  const entries = [entry({ type: "session", version: 1, cwd: "/repo" }), entry({ type: "message", role: "user", content: "abcd" })];
  assert.equal(await estimateSessionTokens(entries, { modelGateway: fakeGateway("unused") }), Math.ceil(JSON.stringify(entries).length / 4));
  assert.equal(await estimateSessionTokens(entries), Math.ceil(JSON.stringify(entries).length / 4));
});

test("findCompactionCutIndex keeps root and recent entries", () => {
  const entries = [
    entry({ type: "session", version: 1, cwd: "/repo" }),
    entry({ type: "message", role: "user", content: "one" }),
    entry({ type: "message", role: "assistant", content: "two" }),
    entry({ type: "message", role: "tool", content: { name: "read_file", path: "src/a.ts" } }),
    entry({ type: "message", role: "assistant", content: "done" }),
  ];

  assert.equal(findCompactionCutIndex(entries, { keepRecentEntries: 2 }), 3);
});

test("compactSessionHistory uses model-generated summary and preserves file operation details", async () => {
  const calls: GenerateRequest[] = [];
  const entries = [
    entry({ type: "session", version: 1, cwd: "/repo" }),
    entry({ type: "message", role: "user", content: "Fix the parser" }),
    entry({ type: "message", role: "tool", content: { name: "read_file", args: { path: "src/parser.ts" } } }),
    entry({ type: "message", role: "tool", content: { name: "write_file", args: { path: "src/parser.ts" } } }),
    entry({ type: "message", role: "tool", content: { name: "bash", output: { cmd: "npm test", exitCode: 1 } } }),
    entry({ type: "message", role: "assistant", content: "Need another fix" }),
  ];

  const result = await compactSessionHistory({
    entries,
    maxContextTokens: 10,
    reserveTokens: 2,
    keepRecentEntries: 2,
    modelGateway: fakeGateway("Model summary: parser fix, npm test failed once", calls),
  });

  assert.equal(result.shouldCompact, true);
  assert.equal(result.compactionEntry?.type, "compaction");
  assert.match(result.compactionEntry?.summary ?? "", /Model summary/);
  assert.equal(result.retainedEntries.at(0)?.type, "session");
  assert.equal(result.details.readFiles.includes("src/parser.ts"), true);
  assert.equal(result.details.modifiedFiles.includes("src/parser.ts"), true);
  assert.equal(calls.length, 1);
});

test("compactSessionHistory re-chains retained entries so resumed context reaches the compaction summary", async () => {
  const root = entry({ type: "session", version: 1, cwd: "/repo", id: "root" });
  const user = entry({ type: "message", role: "user", content: "large task", id: "user", parentId: root.id });
  const oldTool = entry({ type: "message", role: "tool", content: { name: "read_file", args: { path: "src/old.ts" } }, id: "old-tool", parentId: user.id });
  const keptAssistant = entry({ type: "message", role: "assistant", content: "continuing after compaction", id: "kept-assistant", parentId: oldTool.id });
  const keptTool = entry({ type: "message", role: "tool", content: { name: "bash", output: { cmd: "npm test", exitCode: 0 } }, id: "kept-tool", parentId: keptAssistant.id });

  const result = await compactSessionHistory({
    entries: [root, user, oldTool, keptAssistant, keptTool],
    maxContextTokens: 5,
    reserveTokens: 1,
    keepRecentEntries: 2,
    modelGateway: fakeGateway("Summary of compacted large task"),
  });

  assert.equal(result.shouldCompact, true);
  assert.equal(result.compactionEntry?.firstKeptEntryId, keptAssistant.id);
  assert.equal(result.retainedEntries.find((item) => item.id === keptAssistant.id)?.parentId, result.compactionEntry?.id);

  const filePath = await tempSessionFile("reaper-session-compact-rechain-");
  await writeFile(filePath, result.retainedEntries.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  const manager = await ReaperSessionManager.open(filePath);
  const context = manager.buildSessionContext(keptTool.id);

  assert.deepEqual(context.map((item) => item.id), [root.id, result.compactionEntry?.id, keptAssistant.id, keptTool.id]);
  assert.equal(context.some((item) => item.type === "compaction" && /Summary of compacted/.test(item.summary)), true);
});

test("compactSessionHistory returns unchanged entries below threshold", async () => {
  const entries = [entry({ type: "session", version: 1, cwd: "/repo" }), entry({ type: "message", role: "user", content: "small" })];
  const result = await compactSessionHistory({ entries, maxContextTokens: 10000, reserveTokens: 100 });
  assert.equal(result.shouldCompact, false);
  assert.deepEqual(result.retainedEntries, entries);
});

test("compactSessionHistory falls back to heuristic summary when the model fails", async () => {
  const entries = [
    entry({ type: "session", version: 1, cwd: "/repo" }),
    entry({ type: "message", role: "user", content: "Fix bug" }),
    entry({ type: "message", role: "tool", content: { name: "write_file", args: { path: "src/bug.ts" } } }),
    entry({ type: "message", role: "assistant", content: "Done" }),
  ];
  const gateway = fakeGateway("unused");
  gateway.generate = async () => { throw new Error("model down"); };

  const result = await compactSessionHistory({ entries, maxContextTokens: 5, reserveTokens: 1, keepRecentEntries: 1, modelGateway: gateway });
  assert.equal(result.shouldCompact, true);
  assert.match(result.compactionEntry?.summary ?? "", /Heuristic session summary/);
  assert.equal(result.details.modifiedFiles.includes("src/bug.ts"), true);
});
