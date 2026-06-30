import test from "node:test";
import assert from "node:assert/strict";

import { classifyShellCommandSemantics, isWeakVerificationCommand } from "../../src/tools/command-semantics.js";

test("classifies strict verifier commands separately from weak checks", () => {
  assert.equal(classifyShellCommandSemantics("pytest tests/test_app.py").kind, "strict_verifier");
  assert.equal(classifyShellCommandSemantics("python3 -c \"import pathlib; assert pathlib.Path('out.txt').read_text() == 'ok\\n'\"").kind, "strict_verifier");
  assert.equal(classifyShellCommandSemantics("test \"$(cat out.txt)\" = ok").kind, "strict_verifier");

  assert.equal(classifyShellCommandSemantics("python3 -c \"print('passed')\"").kind, "weak_check");
  assert.equal(classifyShellCommandSemantics("node --version").kind, "weak_check");
  assert.equal(classifyShellCommandSemantics("cat output.txt").kind, "inspect");
  assert.equal(classifyShellCommandSemantics("python3 generate_report.py").kind, "producer");
});

test("weak verification helper rejects producer and inspection commands", () => {
  assert.equal(isWeakVerificationCommand("python3 generate.py"), true);
  assert.equal(isWeakVerificationCommand("ls -la output"), true);
  assert.equal(isWeakVerificationCommand("echo verified"), true);
  assert.equal(isWeakVerificationCommand("diff expected.txt actual.txt"), false);
});
