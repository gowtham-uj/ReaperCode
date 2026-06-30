import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCompactionSystemPrompt,
  buildCompactionUserPrompt,
  buildSplitTurnNote,
} from "../../../../src/context/compaction/prompts.js";
import {
  compactSessionHistory,
} from "../../../../src/context/compaction/session-compaction.js";
import { createSessionEntry, type SessionEntry } from "../../../../src/session/session-manager.js";

function message(input: {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "tool" | "custom";
  content: unknown;
}): SessionEntry {
  return createSessionEntry({ id: input.id, type: "message", role: input.role, content: input.content, parentId: input.parentId });
}

test("buildCompactionSystemPrompt stays neutral when no previous summary exists", () => {
  const prompt = buildCompactionSystemPrompt({});
  assert.match(prompt, /summarizing a coding-agent session/i);
  assert.doesNotMatch(prompt, /Previous summary/);
});

test("buildCompactionSystemPrompt folds a previous summary into the system prompt when provided", () => {
  const prompt = buildCompactionSystemPrompt({ previousSummary: "User intent: ship the dashboard." });
  assert.match(prompt, /Previous summary:/);
  assert.match(prompt, /ship the dashboard/);
  assert.match(prompt, /Fold its key facts into the new summary/);
});

test("buildCompactionUserPrompt includes split-turn metadata when provided", () => {
  const kept = createSessionEntry({
    id: "kept-1",
    type: "message",
    role: "tool",
    content: { name: "read_file", output: { stdout: "truncated" } },
    parentId: "dropped-1",
  });
  const json = buildCompactionUserPrompt({
    entries: [],
    splitTurn: { keptEntry: kept, partialToolResult: true },
  });
  const parsed = JSON.parse(json) as { splitTurn: string };
  assert.match(parsed.splitTurn, /partial_tool_result: true/);
  assert.match(parsed.splitTurn, /kept-1/);
});

test("buildCompactionUserPrompt omits splitTurn when not provided", () => {
  const json = buildCompactionUserPrompt({ entries: [] });
  const parsed = JSON.parse(json) as { splitTurn?: string };
  assert.equal(parsed.splitTurn, undefined);
});

test("buildSplitTurnNote returns empty string when no partial tool result was truncated", () => {
  const kept = createSessionEntry({
    id: "kept-1",
    type: "message",
    role: "assistant",
    content: "ok",
    parentId: null,
  });
  const note = buildSplitTurnNote({ keptEntry: kept, partialToolResult: false });
  assert.equal(note, "");
});

test("buildSplitTurnNote annotates the next kept entry when a tool result was truncated", () => {
  const kept = createSessionEntry({
    id: "kept-1",
    type: "message",
    role: "tool",
    content: { name: "read_file", output: { stdout: "truncated" } },
    parentId: "dropped-1",
  });
  const note = buildSplitTurnNote({ keptEntry: kept, partialToolResult: true });
  assert.match(note, /\[Split-turn\]/);
  assert.match(note, /kept-1/);
  assert.match(note, /partial/);
});

test("compactSessionHistory folds a previous summary into the heuristic output", async () => {
  const root = createSessionEntry({ id: "root", type: "session", version: 1, cwd: "/repo" });
  const entries: SessionEntry[] = [
    root,
    message({ id: "u1", parentId: "root", role: "user", content: "build a dashboard" }),
    message({ id: "a1", parentId: "u1", role: "assistant", content: "creating it" }),
    message({ id: "u2", parentId: "a1", role: "user", content: "add metrics" }),
    message({ id: "a2", parentId: "u2", role: "assistant", content: "metrics added" }),
    message({ id: "u3", parentId: "a2", role: "user", content: "ship it" }),
  ];
  // Force a compaction by giving a tiny budget.
  const result = await compactSessionHistory({
    entries,
    maxContextTokens: 32,
    reserveTokens: 0,
    keepRecentEntries: 2,
    previousSummary: "Earlier work: scaffolded the project layout.",
  });
  assert.equal(result.shouldCompact, true);
  assert.ok(result.compactionEntry);
  assert.match(result.compactionEntry!.summary, /Continued from prior summary/);
  assert.match(result.compactionEntry!.summary, /scaffolded the project layout/);
});

test("compactSessionHistory records a splitTurnNote when a tool result was truncated", async () => {
  const root = createSessionEntry({ id: "root", type: "session", version: 1, cwd: "/repo" });
  const kept = message({
    id: "kept-tool",
    parentId: "u1",
    role: "tool",
    content: { name: "bash", output: { stdout: "truncated", exitCode: 0 } },
  });
  const entries: SessionEntry[] = [
    root,
    message({ id: "u1", parentId: "root", role: "user", content: "run tests" }),
    kept,
    message({ id: "u2", parentId: "kept-tool", role: "user", content: "continue" }),
  ];
  const result = await compactSessionHistory({
    entries,
    maxContextTokens: 32,
    reserveTokens: 0,
    keepRecentEntries: 1,
    splitTurn: { keptEntry: kept, partialToolResult: true },
  });
  assert.equal(result.shouldCompact, true);
  assert.match(result.details.splitTurnNote ?? "", /\[Split-turn\]/);
  assert.match(result.compactionEntry!.summary, /\[Split-turn\]/);
});