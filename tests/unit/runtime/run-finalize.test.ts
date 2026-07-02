import test from "node:test";
import assert from "node:assert/strict";

import { classifyRunFinalStatus } from "../../../src/runtime/run-finalize.js";

const okResult = (name = "bash", args?: unknown): { ok: boolean; name: string; args?: unknown } => ({ ok: true, name, ...(args ? { args } : {}) });
const failResult = (name = "bash", args?: unknown): { ok: boolean; name: string; args?: unknown } => ({ ok: false, name, ...(args ? { args } : {}) });

test("classifyRunFinalStatus: empty results are failed", () => {
  const status = classifyRunFinalStatus({ toolResults: [], mode: "autonomous" });
  assert.equal(status, "failed");
});

test("classifyRunFinalStatus: only intermediate failures with a final success returns completed", () => {
  // Build / test cycle: test fails, model fixes code, re-run passes.
  // The model succeeded; intermediate !ok results are part of recovery.
  // Mirrors the autonomous natural-stop branch where the engine has not yet
  // produced an explicit verification verdict but the last tool result is
  // ok and toolResults is non-empty.
  const status = classifyRunFinalStatus({
    toolResults: [okResult(), failResult("bash"), failResult("bash"), okResult("bash")],
    explicitVerification: undefined,
    mode: "autonomous",
  });
  assert.equal(status, "completed");
});

test("classifyRunFinalStatus: last result failed returns failed", () => {
  const status = classifyRunFinalStatus({
    toolResults: [okResult("bash"), failResult("bash")],
    mode: "autonomous",
  });
  assert.equal(status, "failed");
});

test("classifyRunFinalStatus: unrecovered test failure is failed even if build later passes", () => {
  const status = classifyRunFinalStatus({
    toolResults: [
      failResult("bash", { cmd: "pnpm -r test" }),
      okResult("bash", { cmd: "pnpm -r build" }),
    ],
    mode: "autonomous",
  });
  assert.equal(status, "failed");
});

test("classifyRunFinalStatus: verifier failure recovered by same verifier can complete", () => {
  const status = classifyRunFinalStatus({
    toolResults: [
      failResult("bash", { cmd: "pnpm -r test" }),
      okResult("bash", { cmd: "pnpm -r test" }),
      okResult("bash", { cmd: "pnpm -r build" }),
    ],
    mode: "autonomous",
  });
  assert.equal(status, "completed");
});

test("classifyRunFinalStatus: explicit verification ok forces completed", () => {
  const status = classifyRunFinalStatus({
    toolResults: [okResult(), failResult(), okResult()],
    explicitVerification: { ok: true },
    mode: "autonomous",
  });
  assert.equal(status, "completed");
});

test("classifyRunFinalStatus: explicit verification failed forces failed", () => {
  const status = classifyRunFinalStatus({
    toolResults: [okResult(), failResult()],
    explicitVerification: { ok: false },
    mode: "autonomous",
  });
  assert.equal(status, "failed");
});

test("classifyRunFinalStatus: completionGateExhausted always returns failed", () => {
  const status = classifyRunFinalStatus({
    toolResults: [okResult()],
    completionGateExhausted: true,
    mode: "autonomous",
  });
  assert.equal(status, "failed");
});
