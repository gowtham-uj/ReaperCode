import test from "node:test";
import assert from "node:assert/strict";

import { buildMainAgentCockpit } from "../../src/runtime/main-agent-prompt.js";
import { composeAbortSignals } from "../../src/util/abort-signal.js";

test("main-agent cockpit surfaces prepared context, tool shortlist, and skills sections", () => {
  const cockpit = buildMainAgentCockpit(
    {
      contentPrep: {
        preparedContext: {
          fingerprint: "fp-123",
          fileTree: ["src/index.ts", "src/runtime/engine.ts", "src/agent/types.ts"],
          chunks: [
            { path: "src/index.ts", score: 0.91, reason: "main entry", content: "export {}" },
            { path: "src/runtime/engine.ts", score: 0.74, reason: "orchestrator", content: "class RuntimeEngine {}" },
          ],
          summary: "small TS project with engine, agents, tools",
        },
        toolShortlist: [
          { name: "read_file", description: "Read a file", score: 0.88 },
          { name: "bash", description: "Run a shell command", score: 0.71 },
        ],
        skillsPrompt: "Use compact summary mode for large files. Prefer replace_in_file.",
        mentions: ["RuntimeEngine", "call_subagent"],
        environmentFingerprint: "node 20 / linux / x86_64",
      },
    },
    { payload: { prompt: "Wire up content prep" } },
    undefined,
    undefined,
    undefined,
    undefined,
    { availableTools: [{ name: "read_file", description: "Read a file" }] },
  );

  assert.match(cockpit, /## Prepared Context/);
  assert.match(cockpit, /## Tool Shortlist/);
  assert.match(cockpit, /## Skills \/ Mentions/);
  assert.match(cockpit, /fp-123/);
  assert.match(cockpit, /read_file/);
  assert.match(cockpit, /RuntimeEngine/);
  assert.match(cockpit, /Use compact summary mode/);
});

test("main-agent cockpit available-tools list matches the provider tool list", () => {
  const tools = [
    { name: "read_file", description: "Read a file" },
    { name: "replace_in_file", description: "Patch a file" },
  ];
  const cockpit = buildMainAgentCockpit(
    { recentToolResults: [] },
    { payload: { prompt: "use read_file" } },
    undefined,
    undefined,
    undefined,
    undefined,
    { availableTools: tools },
  );
  // Only the provided tools appear, not the entire registry.
  assert.match(cockpit, /read_file/);
  assert.match(cockpit, /replace_in_file/);
  // The default registry is large — verify one rare tool does not leak in.
  assert.doesNotMatch(cockpit, /browser_control/);
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
