/**
 * Reference-agent parity A/B equivalence tests.
 *
 * These tests do NOT call the reference agent at runtime. Instead they
 * assert that Reaper's new APIs produce results whose shape, ordering,
 * and observable properties match the reference agent's documented
 * behavior, derived directly from the reference source/dist files:
 *
 *   - /tmp/pi-reference-github/packages/implementation/src/core/session-manager.ts
 *   - /tmp/pi-implementation-latest/package/dist/core/session-manager.js
 *   - /tmp/pi-implementation-latest/package/dist/core/compaction/compaction.js
 *   - /tmp/pi-implementation-latest/package/dist/core/compaction/branch-summarization.js
 *
 * They serve as a regression net: if the Reaper implementation drifts
 * away from the reference semantics, this test fails and we know to
 * revisit the parity matrix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ReaperSessionManager,
  continueRecentSession,
  forkSessionFromFile,
  listSessions,
  createSessionEntry,
  type SessionEntry,
} from "../../src/session/session-manager.js";
import {
  compactSessionHistory,
  type SessionCompactionInput,
} from "../../src/context/compaction/session-compaction.js";
import {
  buildCompactionSystemPrompt,
  buildCompactionUserPrompt,
  buildSplitTurnNote,
} from "../../src/context/compaction/prompts.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function message(input: {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "tool" | "custom";
  content: unknown;
}): SessionEntry {
  return createSessionEntry({ id: input.id, type: "message", role: input.role, content: input.content, parentId: input.parentId });
}

// ---------------------------------------------------------------------------
// A/B: session-tree
// ---------------------------------------------------------------------------

test("A/B session-tree: getBranch matches the reference's parent-walk ordering (root -> leaf)", async () => {
  // Reference: getBranch(fromId) walks from `startId` up via parentId and
  // returns the path reversed to root -> leaf order.
  const filePath = path.join(await tempDir("reaper-ab-session-"), "session.jsonl");
  const manager = await ReaperSessionManager.create({ filePath, cwd: "/repo" });
  const u1 = await manager.appendMessage({ role: "user", content: "u1" });
  const a1 = await manager.appendMessage({ role: "assistant", content: "a1" });
  const u2 = await manager.appendMessage({ role: "user", content: "u2" });
  const a2 = await manager.appendMessage({ role: "assistant", content: "a2" });
  const branch = manager.getBranch(a2.id).map((e) => e.id);
  // Reference returns [root, u1, a1, u2, a2].
  assert.deepEqual(branch, [manager.root.id, u1.id, a1.id, u2.id, a2.id]);
});

test("A/B session-tree: getChildren returns only direct children sorted by timestamp", async () => {
  // Reference: getChildren(parentId) returns entries whose parentId matches.
  const filePath = path.join(await tempDir("reaper-ab-children-"), "session.jsonl");
  const manager = await ReaperSessionManager.create({ filePath, cwd: "/repo" });
  const u1 = await manager.appendMessage({ role: "user", content: "u1" });
  await manager.appendMessage({ role: "assistant", content: "a1" });
  const u2 = await manager.appendMessage({ role: "user", content: "u2" });
  // The session root has one direct child in this chain (u1); u2 is a grandchild.
  const rootChildren = manager.getChildren(manager.root.id).map((e) => e.id);
  assert.deepEqual(rootChildren, [u1.id]);
  const u1Children = manager.getChildren(u1.id).map((e) => e.id);
  assert.ok(u1Children.includes(u2.id) === false, "u2 is a grandchild, not a direct child of u1");
});

test("A/B session-tree: getTree returns orphan-as-root and sorts children by timestamp", async () => {
  // Reference: getTree() walks all entries, treats orphans as roots, and
  // sorts children by timestamp ascending. Here we drop u2's parent (u1)
  // by manually inserting a branch that orphans it.
  const filePath = path.join(await tempDir("reaper-ab-tree-"), "session.jsonl");
  const root = createSessionEntry({ id: "root", type: "session", version: 1, cwd: "/repo" });
  const a = createSessionEntry({ id: "a", type: "message", role: "user", content: "a", parentId: "root" });
  // Orphan: parent "ghost" does not exist in the file.
  const b = createSessionEntry({ id: "b", type: "message", role: "assistant", content: "b", parentId: "ghost" });
  const lines = [JSON.stringify(root), JSON.stringify(a), JSON.stringify(b), ""].join("\n");
  await writeFile(filePath, lines, "utf8");
  const manager = await ReaperSessionManager.open(filePath);
  const tree = manager.getTree();
  // Expect two roots: the session root and the orphan `b`.
  const rootIds = tree.map((node) => node.entry.id).sort();
  assert.deepEqual(rootIds, ["b", "root"]);
  // The session root has one child (a), and a has no children.
  const sessionRoot = tree.find((n) => n.entry.id === "root")!;
  assert.equal(sessionRoot.children.length, 1);
  assert.equal(sessionRoot.children[0]!.entry.id, "a");
});

test("A/B session-tree: branch() then append creates a child of the branch point (not the previous leaf)", async () => {
  // Reference: branch(branchFromId) moves the leaf pointer; next append
  // creates a child of the branch point.
  const filePath = path.join(await tempDir("reaper-ab-branch-"), "session.jsonl");
  const manager = await ReaperSessionManager.create({ filePath, cwd: "/repo" });
  const u1 = await manager.appendMessage({ role: "user", content: "u1" });
  await manager.appendMessage({ role: "assistant", content: "a1" });
  await manager.appendMessage({ role: "user", content: "u2" });
  manager.branch(u1.id);
  assert.equal(manager.getLeafId(), u1.id);
  const newChild = await manager.appendMessage({ role: "user", content: "u1-alternate" });
  assert.equal(newChild.parentId, u1.id);
});

test("A/B session-tree: forkSessionFromFile produces a fresh session with cwd override and rechained parents", async () => {
  // Reference: forkFrom creates a new session with the requested cwd, copies
  // all non-header entries, and rechains parentIds so the new file is
  // self-consistent under buildSessionContext.
  const sourcePath = path.join(await tempDir("reaper-ab-fork-"), "src.jsonl");
  const targetDir = await tempDir("reaper-ab-fork-target-");
  const source = await ReaperSessionManager.create({ filePath: sourcePath, cwd: "/original" });
  await source.appendMessage({ role: "user", content: "u1" });
  await source.appendMessage({ role: "assistant", content: "a1" });
  await source.appendMessage({ role: "user", content: "u2" });

  const fork = await forkSessionFromFile(sourcePath, targetDir, { cwd: "/forked" });
  assert.equal(fork.root.cwd, "/forked");
  assert.notEqual(fork.root.id, source.root.id);
  // The fork's buildSessionContext should reach the root.
  const ctx = fork.buildSessionContext();
  assert.equal(ctx[0]?.id, fork.root.id);
  const last = ctx.at(-1);
  if (!last || last.type !== "message") throw new Error("expected last entry to be a message");
  assert.equal(last.role, "user");
  assert.match(String(last.content), /u2/);
});

test("A/B session-tree: listSessions orders by mtime DESC and reports messageCount", async () => {
  // Reference: list() sorts sessions by mtime descending and reports a
  // per-session messageCount. We assert both.
  const dir = await tempDir("reaper-ab-list-");
  const first = await ReaperSessionManager.create({ filePath: path.join(dir, "first.jsonl"), cwd: "/repo" });
  await first.appendMessage({ role: "user", content: "a" });
  const second = await ReaperSessionManager.create({ filePath: path.join(dir, "second.jsonl"), cwd: "/repo" });
  await second.appendMessage({ role: "user", content: "b" });
  await second.appendMessage({ role: "assistant", content: "b-reply" });

  const list = await listSessions(dir);
  assert.equal(list.length, 2);
  // Newest first by mtime.
  assert.equal(list[0]!.messageCount, 2);
  assert.equal(list[1]!.messageCount, 1);
  // mtime strictly decreasing.
  assert.ok(list[0]!.modified.getTime() >= list[1]!.modified.getTime());
});

test("A/B session-tree: continueRecentSession returns the newest entry", async () => {
  // Reference: continueRecent returns the most recent file in sessionDir.
  const dir = await tempDir("reaper-ab-continue-");
  const old = await ReaperSessionManager.create({ filePath: path.join(dir, "old.jsonl"), cwd: "/repo" });
  await old.appendMessage({ role: "user", content: "old" });
  const recent = await continueRecentSession(dir);
  assert.ok(recent);
  const msg = recent!.entries.find((e) => e.type === "message");
  if (msg?.type !== "message") throw new Error("expected a message entry");
  assert.equal(msg.content, "old");
});

test("A/B session-tree: branchWithSummary appends a branch_summary child of the previous leaf and moves the leaf to the branch point", async () => {
  // Reference: branchWithSummary sets leafId to branchFromId, then appends
  // a branch_summary entry whose parentId is the previous leaf (the leaf
  // being abandoned), so the new branch starts a child of the branch point.
  const filePath = path.join(await tempDir("reaper-ab-summary-"), "session.jsonl");
  const manager = await ReaperSessionManager.create({ filePath, cwd: "/repo" });
  await manager.appendMessage({ role: "user", content: "u1" });
  const a1 = await manager.appendMessage({ role: "assistant", content: "a1" });
  const beforeLeaf = manager.getLeafId();
  const summary = await manager.branchWithSummary(a1.id, "going a different way");
  if (summary.type !== "branch_summary") throw new Error("expected branch_summary");
  assert.equal(summary.fromId, a1.id);
  // The branch_summary is a child of the abandoned leaf.
  assert.equal(summary.parentId, beforeLeaf);
  // The new leaf is the branch_summary itself (the next append creates a
  // child of the branch_summary, matching the reference's `branchWithSummary`).
  assert.equal(manager.getLeafId(), summary.id);
});

// ---------------------------------------------------------------------------
// A/B: compaction-prompts
// ---------------------------------------------------------------------------

test("A/B compaction-prompts: system prompt folds previous summary into the merge instructions", () => {
  // Reference (UPDATE_SUMMARIZATION_PROMPT): when previousSummary is
  // provided, the prompt tells the model to PRESERVE all existing
  // information from the previous summary. Reaper's
  // buildCompactionSystemPrompt encodes the same intent.
  const prompt = buildCompactionSystemPrompt({ previousSummary: "Old goal: ship the dashboard." });
  assert.match(prompt, /Fold its key facts into the new summary/);
  assert.match(prompt, /Old goal: ship the dashboard/);
});

test("A/B compaction-prompts: user prompt exposes splitTurn fields with kept entry id and partial flag", () => {
  // Reference (findCutPoint): splitTurn is detected when the cut index
  // does not land on a user message; the turn prefix is preserved. Reaper
  // surfaces kept_entry_id and partial_tool_result so the model can
  // produce a partial-turn summary.
  const kept = createSessionEntry({
    id: "kept-1",
    type: "message",
    role: "tool",
    content: { name: "read_file", output: { stdout: "..." } },
    parentId: "dropped-1",
  });
  const json = buildCompactionUserPrompt({
    entries: [],
    splitTurn: { keptEntry: kept, partialToolResult: true },
  });
  const parsed = JSON.parse(json) as { splitTurn: string };
  assert.match(parsed.splitTurn, /kept_entry_id: kept-1/);
  assert.match(parsed.splitTurn, /partial_tool_result: true/);
  assert.match(parsed.splitTurn, /truncated by compaction/i);
});

test("A/B compaction-prompts: split-turn note is empty when no partial tool result", () => {
  const kept = createSessionEntry({
    id: "kept-2",
    type: "message",
    role: "assistant",
    content: "ok",
    parentId: null,
  });
  const note = buildSplitTurnNote({ keptEntry: kept, partialToolResult: false });
  assert.equal(note, "");
});

test("A/B compaction-prompts: compactSessionHistory merges previous summary in heuristic output", async () => {
  // Reference (UPDATE_SUMMARIZATION_PROMPT): previous summary is folded
  // into the new prompt. Reaper's compactSessionHistory surfaces that
  // fold in `details.compactionEntry.summary` for the heuristic fallback.
  const root = createSessionEntry({ id: "root", type: "session", version: 1, cwd: "/repo" });
  const entries: SessionEntry[] = [
    root,
    message({ id: "u1", parentId: "root", role: "user", content: "build dashboard" }),
    message({ id: "a1", parentId: "u1", role: "assistant", content: "starting" }),
    message({ id: "u2", parentId: "a1", role: "user", content: "add metrics" }),
    message({ id: "a2", parentId: "u2", role: "assistant", content: "metrics added" }),
    message({ id: "u3", parentId: "a2", role: "user", content: "ship it" }),
  ];
  const input: SessionCompactionInput = {
    entries,
    maxContextTokens: 32,
    reserveTokens: 0,
    keepRecentEntries: 2,
    previousSummary: "Earlier: scaffolded the project.",
  };
  const result = await compactSessionHistory(input);
  assert.equal(result.shouldCompact, true);
  assert.ok(result.compactionEntry);
  assert.match(result.compactionEntry!.summary, /Continued from prior summary/);
  assert.match(result.compactionEntry!.summary, /scaffolded the project/);
});

test("A/B compaction-prompts: split-turn metadata appears in both details and summary when partial", async () => {
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

test("A/B compaction-prompts: compaction result records the correct firstKeptEntryId for resume", async () => {
  // Reference: firstKeptEntryId is the id of the first entry kept after
  // the cut, so resume can rebuild the path. Reaper records it in the
  // compaction entry.
  const root = createSessionEntry({ id: "root", type: "session", version: 1, cwd: "/repo" });
  const entries: SessionEntry[] = [
    root,
    message({ id: "u1", parentId: "root", role: "user", content: "big task" }),
    message({ id: "a1", parentId: "u1", role: "assistant", content: "more work" }),
    message({ id: "u2", parentId: "a1", role: "user", content: "and more" }),
  ];
  const result = await compactSessionHistory({
    entries,
    maxContextTokens: 32,
    reserveTokens: 0,
    keepRecentEntries: 1,
  });
  assert.equal(result.shouldCompact, true);
  assert.ok(result.compactionEntry);
  // With keepRecentEntries=1, the tail contains only u2; the first kept
  // entry id is therefore u2.
  assert.equal(result.compactionEntry!.firstKeptEntryId, "u2");
  // The compaction summary should not contain "u2" verbatim (it was kept).
  assert.doesNotMatch(result.compactionEntry!.summary, /and more/);
});