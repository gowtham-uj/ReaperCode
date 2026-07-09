import test from "node:test";
import assert from "node:assert/strict";

import {
  isFinalAssistantSummary,
  recoverEmbeddedToolCallsFromText,
} from "../../../src/runtime/main-agent-node.js";

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

test("isFinalAssistantSummary rejects embedded tool_call markup", () => {
  assert.equal(
    isFinalAssistantSummary(
      `I'll execute steps 1-3 now.\n\n<tool_call>{"name":"scratchpad","parameters":{"action":"append","note":"STRESS-TOKEN-991"}}</tool_call>`,
    ),
    false,
  );
});

test("recoverEmbeddedToolCallsFromText parses MiniMax-style tool_call markup", () => {
  const recovered = recoverEmbeddedToolCallsFromText(
    `Starting.\n<tool_call>{"name":"scratchpad","parameters":{"action":"append","label":"user-note","note":"STRESS-TOKEN-991"}}\\n{"name":"bash","parameters":{"cmd":"cat big/logdump.txt","description":"Full cat","timeout":30}}</tool_call>`,
  );
  assert.ok(recovered.calls.length >= 2, `expected >=2 calls, got ${recovered.calls.length}: ${JSON.stringify(recovered)}`);
  assert.equal(recovered.calls[0]?.name, "scratchpad");
  assert.equal(recovered.calls[1]?.name, "bash");
});

test("recoverEmbeddedToolCallsFromText parses escaped-quote MiniMax dumps", () => {
  const recovered = recoverEmbeddedToolCallsFromText(
    `<tool_call>{\\"name\\": \\"scratchpad\\", \\"parameters\\": {\\"action\\": \\"append\\", \\"label\\": \\"user-note\\", \\"note\\": \\"STRESS-TOKEN-991\\"}}\\n{\\"name\\": \\"bash\\", \\"parameters\\": {\\"cmd\\": \\"cat big/logdump.txt\\", \\"timeout\\": 30}}\\n{\\"name\\": \\"file_view\\", \\"parameters\\": {\\"path\\": \\"docs/alpha.md\\"}}</tool_call>`,
  );
  assert.equal(recovered.calls.length, 3, JSON.stringify(recovered));
  assert.deepEqual(
    recovered.calls.map((c) => c.name),
    ["scratchpad", "bash", "file_view"],
  );
});
