import test from "node:test";
import assert from "node:assert/strict";

import { userPromptRequestsScratchpad } from "../../../src/runtime/agent-tools.js";

test("userPromptRequestsScratchpad detects explicit user requests", () => {
  assert.equal(
    userPromptRequestsScratchpad({ payload: { prompt: "Store STRESS-TOKEN in scratchpad first." } }),
    true,
  );
  assert.equal(
    userPromptRequestsScratchpad({ payload: { prompt: "Build the app and run npm test." } }),
    false,
  );
});
