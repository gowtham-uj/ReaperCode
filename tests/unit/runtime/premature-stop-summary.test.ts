import test from "node:test";
import assert from "node:assert/strict";

import { isFinalAssistantSummary } from "../../../src/runtime/main-agent-node.js";

test("isFinalAssistantSummary rejects mid-batch action announcements", () => {
  assert.equal(
    isFinalAssistantSummary("Writing f10-f14 now."),
    false,
  );
  assert.equal(
    isFinalAssistantSummary("Continuing - writing f10-f14, then FINAL.md, then npm test."),
    false,
  );
  assert.equal(
    isFinalAssistantSummary("I'll create the remaining files next."),
    false,
  );
  assert.equal(
    isFinalAssistantSummary(
      "Scratchpad note written and f00-f04 created. Now appending progress and creating the next batch (f05-f09) in parallel:",
    ),
    false,
  );
});

test("isFinalAssistantSummary accepts verified completion summaries", () => {
  assert.equal(
    isFinalAssistantSummary("Done. Created 20 batch files and FINAL.md. npm test passed."),
    true,
  );
  assert.equal(
    isFinalAssistantSummary("All checks passed. Fixed clamp and verified with npm test."),
    true,
  );
  assert.equal(
    isFinalAssistantSummary("Status: success. All required deliverables are complete."),
    true,
  );
});

test("isFinalAssistantSummary rejects embedded tool_call markup (never treat as done)", () => {
  assert.equal(
    isFinalAssistantSummary(
      `I'll execute steps 1-3 now.\n\n<tool_call>{"name":"scratchpad","parameters":{"action":"append","note":"STRESS-TOKEN-991"}}</tool_call>`,
    ),
    false,
  );
});
