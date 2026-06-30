/**
 * Regression for the RepoPilot A/B failure where the main agent's model
 * responses reached the hard-coded 8192-token cap. Truncated structured tool
 * batches produced empty/malformed write_file calls while the reference agent
 * could use a larger output budget.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { selectMainAgentMaxTokensForTurn } from "../../../src/runtime/engine.js";

const ENGINE_PATH = new URL("../../../src/runtime/engine.ts", import.meta.url);
const buildRequest = { payload: { prompt: "Build a full-stack app with apps/api and apps/web" } };

test("main-agent runtime uses adaptive high output budgets, not the old 8192 cap", async () => {
  const source = await readFile(ENGINE_PATH, "utf8");
  assert.match(source, /selectMainAgentMaxTokensForTurn\(/);
  assert.doesNotMatch(source, /callMainAgent\([\s\S]*?maxTokens:\s*8192/);
});

test("build tasks start at 16k then rise to 32k after artifact momentum", () => {
  assert.equal(selectMainAgentMaxTokensForTurn({ request: buildRequest as never, state: { toolResults: [] } as never }), 16_000);
  assert.equal(
    selectMainAgentMaxTokensForTurn({
      request: buildRequest as never,
      state: {
        toolResults: Array.from({ length: 20 }, (_, index) => ({ ok: true, name: "write_file", args: { path: `file-${index}.ts` } })),
      } as never,
    }),
    32_000,
  );
});

test("executor fallback structured planner still uses a 32k output budget", async () => {
  const source = await readFile(ENGINE_PATH, "utf8");
  assert.match(source, /source:\s*"executor_subagent"[\s\S]*?maxTokens:\s*32_000/);
  assert.doesNotMatch(source, /source:\s*"executor_subagent"[\s\S]*?maxTokens:\s*8192/);
});
