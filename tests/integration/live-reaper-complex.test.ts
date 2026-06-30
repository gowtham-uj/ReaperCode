import test from "node:test";
import assert from "node:assert/strict";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import { createValidRequestEnvelope } from "../fixtures/phase0.js";
import { createLiveDeepSeekGateway } from "../fixtures/live-gateway.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

test("live Reaper solves a complex coding task with LLM planning", { skip: !(process.env.RUN_LIVE_LLM_TESTS === "1" && process.env.DEEPSEEK_API_KEY), timeout: 10 * 60_000 }, async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: [
      "Create a dependency-free Node.js task scoring library and tests.",
      "Requirements:",
      "- Implement src/task-score.mjs exporting scoreTask(task) and rankTasks(tasks).",
      "- scoreTask should reward priority, penalize estimate, and heavily penalize blocked tasks.",
      "- rankTasks should sort by descending score and then by id ascending for ties.",
      "- Add node:test coverage in tests/task-score.test.mjs.",
      "- Update package.json so npm test runs the tests.",
      "- Use no external npm dependencies.",
      "- Complete only after npm test passes.",
    ].join("\n"),
  };

  const { config, gateway } = createLiveDeepSeekGateway("live reaper complex coding task");
  const engine = new RuntimeEngine({
    config,
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.equal(result.verification?.ok, true);
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);
});
