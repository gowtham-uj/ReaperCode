/**
 * session-graph.test.ts — smoke tests for the pi-style session
 * graph builder.
 *
 * We feed a synthetic trajectory JSONL through `buildSessionGraph`
 * and assert the resulting tree structure (turn count, tool counts,
 * outcome flags).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildSessionGraph, flattenGraph } from "../../../src/tui/session-graph.js";

function writeFixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tui-graph-"));
  const path = join(dir, "trajectory.jsonl");
  writeFileSync(path, content, "utf8");
  return path;
}

test("session-graph: parses a 2-turn trajectory with mixed outcomes", () => {
  const path = writeFixture([
    `{"event_id":"e1","kind":"user_prompt","timestamp":"2026-06-18T10:00:00.000Z","turn_id":"t1","payload":{"prompt":"build me a hello world script"}}`,
    `{"event_id":"e2","kind":"tool_call","timestamp":"2026-06-18T10:00:01.000Z","turn_id":"t1","tool_name":"write_file","status":"completed","args":{"path":"hello.js"},"duration_ms":12}`,
    `{"event_id":"e3","kind":"tool_call","timestamp":"2026-06-18T10:00:02.000Z","turn_id":"t1","tool_name":"run_shell_command","status":"completed","args":{"command":"node hello.js"},"duration_ms":350}`,
    `{"event_id":"e4","kind":"assistant_message","timestamp":"2026-06-18T10:00:03.000Z","turn_id":"t1","content":"Done."}`,
    `{"event_id":"e5","kind":"user_prompt","timestamp":"2026-06-18T10:01:00.000Z","turn_id":"t2","payload":{"prompt":"now add a goodbye world"}}`,
    `{"event_id":"e6","kind":"tool_call","timestamp":"2026-06-18T10:01:01.000Z","turn_id":"t2","tool_name":"edit_file","status":"failed","args":{"path":"hello.js"},"duration_ms":8}`,
    `{"event_id":"e7","kind":"assistant_message","timestamp":"2026-06-18T10:01:02.000Z","turn_id":"t2","content":"Sorry, that edit failed."}`,
  ].join("\n"));

  const graph = buildSessionGraph(path);
  assert.ok(graph, "graph should be built");
  assert.equal(graph.turnCount, 2);
  // 1 root + 2 turns + (2 tools + 1 assistant) + (1 tool + 1 assistant) = 8 nodes
  assert.equal(graph.totalNodes, 8);

  const flat = flattenGraph(graph);
  // First node is the root.
  assert.equal(flat[0]!.kind, "session");
  // First turn holds the first prompt and 3 children.
  const turn1 = flat[1]!;
  assert.equal(turn1.kind, "turn");
  assert.match(turn1.label, /hello world/);
  assert.equal(turn1.children.length, 3);

  // The failed tool lives under the second turn (turn 1's tools all
  // completed); locate it by scanning the second turn's children.
  const turn2 = flat.find((n) => n.kind === "turn" && n !== turn1)!;
  const errTool = turn2.children.find((c) => c.kind === "tool");
  assert.ok(errTool, "second turn should contain a tool node");
  assert.equal(errTool.outcome, "err");
});

test("session-graph: returns null for missing file", () => {
  const graph = buildSessionGraph("/nonexistent/trajectory.jsonl");
  assert.equal(graph, null);
});

test("session-graph: handles empty file", () => {
  const path = writeFixture("");
  const graph = buildSessionGraph(path);
  assert.equal(graph, null);
});

test("session-graph: tool outcome mapping", () => {
  const path = writeFixture([
    `{"event_id":"a","kind":"user_prompt","timestamp":"2026-06-18T10:00:00.000Z","turn_id":"t1","payload":{"prompt":"x"}}`,
    `{"event_id":"b","kind":"tool_call","timestamp":"2026-06-18T10:00:01.000Z","turn_id":"t1","tool_name":"a","status":"completed","args":{}}`,
    `{"event_id":"c","kind":"tool_call","timestamp":"2026-06-18T10:00:02.000Z","turn_id":"t1","tool_name":"b","status":"failed","args":{}}`,
    `{"event_id":"d","kind":"tool_call","timestamp":"2026-06-18T10:00:03.000Z","turn_id":"t1","tool_name":"c","status":"pending","args":{}}`,
  ].join("\n"));
  const graph = buildSessionGraph(path)!;
  const turn = graph.root.children[0]!;
  assert.equal(turn.children[0]!.outcome, "ok");
  assert.equal(turn.children[1]!.outcome, "err");
  assert.equal(turn.children[2]!.outcome, "pending");
});