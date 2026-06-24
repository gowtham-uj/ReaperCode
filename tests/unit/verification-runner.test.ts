import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyGroundedVerificationSignal,
  validateGeneratedVerificationInvariant,
} from "../../src/verify/runner.js";

test("classifyGroundedVerificationSignal recognizes grounded command families", () => {
  assert.equal(classifyGroundedVerificationSignal("npm test").kind, "test");
  assert.equal(classifyGroundedVerificationSignal("npm run build").kind, "build");
  assert.equal(classifyGroundedVerificationSignal("tsc --noEmit").kind, "typecheck");
  assert.equal(classifyGroundedVerificationSignal("eslint src").kind, "lint");
  assert.equal(classifyGroundedVerificationSignal("test \"$(cat answer.txt)\" = ok").kind, "artifact_check");
  assert.equal(classifyGroundedVerificationSignal("echo looks good").grounded, false);
});

test("generated verification invariant rejects a check that passed on the pre-change trace", () => {
  const command = "python3 -c \"assert open('answer.txt').read().strip() == 'ok'\"";

  const result = validateGeneratedVerificationInvariant({
    verification: { command, generated: true },
    priorResults: [
      {
        ok: true,
        name: "run_shell_command",
        args: { cmd: command },
      },
    ],
  });

  assert.equal(result.ok, false);
});

test("generated verification invariant allows pass-after evidence when the same check failed first", () => {
  const command = "python3 -c \"assert open('answer.txt').read().strip() == 'ok'\"";

  const result = validateGeneratedVerificationInvariant({
    verification: { command, generated: true },
    priorResults: [
      {
        ok: false,
        name: "run_shell_command",
        args: { cmd: command },
      },
      {
        ok: true,
        name: "run_shell_command",
        args: { cmd: command },
      },
    ],
  });

  assert.equal(result.ok, true);
});

test("generated verification invariant allows a check that first passes after a mutation", () => {
  const command = "test \"$(cat answer.txt)\" = ok";

  const result = validateGeneratedVerificationInvariant({
    verification: { command, generated: true },
    priorResults: [
      {
        ok: true,
        name: "write_file",
        args: { path: "answer.txt", content: "ok\n" },
      },
      {
        ok: true,
        name: "run_shell_command",
        args: { cmd: command },
      },
    ],
  });

  assert.equal(result.ok, true);
});
