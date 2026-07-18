import test from "node:test";
import assert from "node:assert/strict";

import { buildMainAgentSystemPrompt } from "../../src/runtime/system-prompt.js";
import { composeAbortSignals } from "../../src/util/abort-signal.js";


test("main-agent system prompt stays stable when the provider tool list changes", () => {
  const tools = [
    { name: "read_file", description: "Read a file" },
    { name: "replace_in_file", description: "Patch a file" },
  ];
  const system = buildMainAgentSystemPrompt({}, { availableTools: tools });
  assert.equal(system, buildMainAgentSystemPrompt({}));
  assert.doesNotMatch(system, /# Tool inventory|- read_file|- replace_in_file|browser_control/);
});

test("composeAbortSignals returns undefined when no signals are provided", () => {
  const composed = composeAbortSignals();
  assert.equal(composed, undefined);
});

test("composeAbortSignals returns the single signal when only one is provided", () => {
  const ctrl = new AbortController();
  const composed = composeAbortSignals(ctrl.signal);
  assert.equal(composed, ctrl.signal);
});

test("composeAbortSignals returns a signal that aborts when any input aborts", () => {
  const ctrl1 = new AbortController();
  const ctrl2 = new AbortController();
  const composed = composeAbortSignals(ctrl1.signal, ctrl2.signal);
  assert.ok(composed);
  assert.equal(composed!.aborted, false);
  ctrl2.abort(new Error("upstream cancel"));
  assert.equal(composed!.aborted, true);
});
