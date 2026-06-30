import test from "node:test";
import assert from "node:assert/strict";

import {
  createTodoState,
  addTodoItem,
  updateTodoItem,
  completeTodoItem,
  renderTodoForCockpit,
  statusForTodoItem,
} from "../../src/runtime/plan-state.js";

test("updateTodoItem promotes legacy done=true to status=completed", () => {
  const state = createTodoState([{ id: "t1", content: "wire up", done: true }]);
  assert.equal(statusForTodoItem(state.items[0]!), "completed");
  assert.equal(renderTodoForCockpit(state), "- [x] t1: wire up");
});

test("updateTodoItem can mark an item in_progress with evidence", () => {
  const state = createTodoState([{ id: "t1", content: "wire up" }]);
  const next = updateTodoItem(state, { id: "t1", status: "in_progress", evidence: "src/index.ts" });
  assert.equal(next.items[0]?.status, "in_progress");
  assert.equal(next.items[0]?.evidence, "src/index.ts");
  assert.equal(renderTodoForCockpit(next), "- [>] t1: wire up — src/index.ts");
});

test("completeTodoItem is a shortcut for status=completed", () => {
  const state = createTodoState([{ id: "t1", content: "wire up" }]);
  const next = completeTodoItem(state, "t1");
  assert.equal(next.items[0]?.status, "completed");
});

test("addTodoItem deduplicates by id", () => {
  const state = createTodoState([{ id: "t1", content: "v1" }]);
  const next = addTodoItem(state, { id: "t1", content: "v2" });
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0]?.content, "v2");
});

test("renderTodoForCockpit includes priority and blocked states", () => {
  let state = createTodoState();
  state = addTodoItem(state, { id: "t1", content: "first", priority: "high" });
  state = updateTodoItem(state, { id: "t1", status: "in_progress" });
  state = addTodoItem(state, { id: "t2", content: "blocked task" });
  state = updateTodoItem(state, { id: "t2", status: "blocked" });
  const rendered = renderTodoForCockpit(state);
  assert.match(rendered, /t1 \(high\): first/);
  assert.match(rendered, /\[>\] t1/);
  assert.match(rendered, /\[!\] t2/);
});
