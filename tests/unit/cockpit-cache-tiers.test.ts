import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMainAgentCockpitLayout,
  cockpitSectionKind,
} from "../../src/runtime/main-agent-prompt.js";

test("cockpitSectionKind returns the right tier for every section", () => {
  assert.equal(cockpitSectionKind("Task Contract"), "stable");
  assert.equal(cockpitSectionKind("Repo Snapshot"), "stable");
  assert.equal(cockpitSectionKind("Recent Tool Results"), "volatile");
  assert.equal(cockpitSectionKind("Runtime Blockers"), "volatile");
  assert.equal(cockpitSectionKind("Available Tools"), undefined);
  assert.equal(cockpitSectionKind("Verification State"), undefined);
  assert.equal(cockpitSectionKind("NonExistent"), undefined);
});

test("buildMainAgentCockpitLayout splits sections by cache tier", () => {
  const layout = buildMainAgentCockpitLayout(
    {
      contentPrep: {
        preparedContext: { fingerprint: "fp-1", fileTree: ["src/index.ts"] },
        toolShortlist: [{ name: "read_file" }],
        skillsPrompt: "skill text",
      },
      planState: { candidates: [] },
      todoState: { items: [] },
    },
    { payload: { prompt: "wire content prep" } },
    { objective: "wire content prep" },
    undefined,
    undefined,
    { iteration: 1 },
    { availableTools: [{ name: "read_file", description: "Read file" }] },
  );

  assert.ok(layout.stable.includes("Task Contract"), "stable tier should include task contract");
  assert.ok(layout.volatile.includes("Recent Tool Results"), "volatile tier should include tool results");
  assert.ok(!layout.combined.includes("Available Tools"), "tool inventory lives in system prompt");
  assert.ok(!layout.combined.includes("Verification State"), "verification is not a cockpit stop gate");
  // Combined should concatenate tiers deterministically.
  const stableStart = layout.combined.indexOf(layout.stable);
  const volatileStart = layout.combined.indexOf(layout.volatile);
  assert.ok(stableStart >= 0 && volatileStart > stableStart, "volatile must come after stable");
});
