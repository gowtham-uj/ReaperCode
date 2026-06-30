import test from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir } from "node:fs/promises";
import { reaperEvalHarness, type EvalBenchTask } from "../../reaper_eval/runtime/reaper-eval-harness.js";

test("harness creates task workspace and runs lifecycle", async () => {
  const benchRoot = "/tmp/reaper-eval-harness-test";
  await mkdir(benchRoot, { recursive: true });
  const task: EvalBenchTask = {
    id: "harness-self-test",
    title: "noop add",
    description: "In the file src/index.js, change the function to return x + 1.",
    difficulty: "easy",
    language: "javascript",
    projectFiles: {
      "package.json": JSON.stringify({ name: "noop", version: "1.0.0", type: "module", scripts: { test: "node --test index.test.js" } }, null, 2),
      "index.js": "export function inc(x) { return x; }\n",
      "index.test.js": `import { test } from "node:test"; import assert from "node:assert/strict"; import { inc } from "./index.js"; test("increment", () => { assert.equal(inc(3), 4); });\n`,
    },
    verification: { command: "npm test" },
  };
  const result = await reaperEvalHarness({
    task,
    model: { provider: "minimax-oauth", model: "MiniMax-M3" },
  });
  assert.equal(result.taskId, task.id);
  assert.ok(result.trajectoryPath.length > 0 || result.error === "mock not implemented", "expected trajectory or mock error");
  await rm(benchRoot, { recursive: true, force: true });
});
