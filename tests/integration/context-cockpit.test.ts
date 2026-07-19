/**
 * Smoke test for the cockpit renderer kept after the Pi-parity refactor.
 *
 * The runtime no longer inserts cockpit bundles into the conversation
 * (`renderContextCockpit` is unreferenced from engine.ts and only callable
 * from explicit external code). This test exists so:
 *   1) any external code that still imports the symbol compiles and runs,
 *   2) the renderer signature / marker pair remain stable so future
 *      tooling can rely on them.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  renderContextCockpit,
  COCKPIT_OPEN,
  COCKPIT_CLOSE,
  countCockpitMarkers,
  type CockpitInput,
} from "../../src/runtime/context-cockpit.js";

const EMPTY_INPUT: CockpitInput = {
  preparedContext: {
    fingerprint: "",
    fileTree: [],
    chunks: [],
    droppedPaths: [],
    usedTokens: 0,
  },
  contextFiles: { files: [], diagnostics: [] },
  skills: [],
  resourceTrust: { trusted: false },
  trustedSkills: [],
  environmentFingerprint: {
    os: "linux",
    arch: "x64",
    nodeVersion: process.versions.node,
    cwd: process.cwd(),
    npmVersion: "smoke",
    glibcVersion: "smoke",
    availableTools: [],
    dockerCliAvailable: false,
    dockerDaemonAvailable: false,
    dockerStatus: "daemon_unavailable",
  },
  mentions: { fileMentions: [], symbolMentions: [] },
  runtimeFacts: { activeWorkspaceRoot: "/tmp" },
};

test("renderContextCockpit returns marker pair on empty inputs (kept for backward compat)", () => {
  const text = renderContextCockpit(EMPTY_INPUT);
  assert.ok(text.startsWith(COCKPIT_OPEN), "expected the cockpit text to start with the open marker");
  assert.ok(text.endsWith(COCKPIT_CLOSE), "expected the cockpit text to end with the close marker");
  const markerCount = countCockpitMarkers(text);
  assert.deepEqual(markerCount, { opens: 1, closes: 1 }, "exactly one marker pair should be present");
});

test("COCKPIT_OPEN and COCKPIT_CLOSE are exported as stable strings", () => {
  assert.equal(typeof COCKPIT_OPEN, "string");
  assert.equal(typeof COCKPIT_CLOSE, "string");
  assert.notEqual(COCKPIT_OPEN, COCKPIT_CLOSE);
});
