import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCandidatePlan,
  createPlanState,
  createTodoState,
  addTodoItem,
  completeTodoItem,
  renderPlanForCockpit,
  renderTodoForCockpit,
} from "../../src/runtime/plan-state.js";

test("candidate plan is visible but inactive until applied", () => {
  const state = createPlanState(["## Candidate\n- inspect first"]);

  const renderedCandidate = renderPlanForCockpit(state);
  assert.match(renderedCandidate, /Active Plan\nNone\./);
  assert.match(renderedCandidate, /Candidate 1:\n## Candidate/);

  const accepted = applyCandidatePlan(state, state.candidates[0]!);
  assert.equal(accepted.activeMarkdown, "## Candidate\n- inspect first");
  assert.match(renderPlanForCockpit(accepted), /Active Plan\n## Candidate/);
});

test("todo state appends, completes, and renders checklist items", () => {
  let state = createTodoState();
  state = addTodoItem(state, { id: "inspect", content: "Inspect runtime graph", done: false });
  state = addTodoItem(state, { id: "test", content: "Add coverage", done: false });
  state = completeTodoItem(state, "inspect");

  // Status is the canonical field; `done` is kept as a legacy alias for
  // backward compatibility. The updatedAt timestamp is set automatically
  // and excluded from the equality check because it varies per run.
  assert.deepEqual(
    state.items.map((item) => ({ id: item.id, content: item.content, status: item.status, done: item.done })),
    [
      { id: "inspect", content: "Inspect runtime graph", status: "completed", done: true },
      { id: "test", content: "Add coverage", status: "pending", done: false },
    ],
  );
  assert.equal(renderTodoForCockpit(state), "- [x] inspect: Inspect runtime graph\n- [ ] test: Add coverage");
});
