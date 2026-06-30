import test from "node:test";
import assert from "node:assert/strict";

import { classifyVerificationOutput } from "../../src/verify/failure-classifier.js";

test("classifies clustered manifest and type verification failures", () => {
  const result = classifyVerificationOutput(`
    npm error Missing script: "test"
    Cannot find module 'socket.io'
    src/server/__tests__/api.test.ts(6,5): error TS2304: Cannot find name 'expect'.
  `);

  assert.ok(result.classes.includes("missing_script"));
  assert.ok(result.classes.includes("missing_dependency"));
  assert.ok(result.classes.includes("missing_type_dependency"));
  assert.ok(result.facts.some((fact) => fact.includes("Cannot find module")));
  assert.match(result.repairStrategy, /Batch related fixes/);
});

test("classifies behavioral assertion failures separately from setup failures", () => {
  const result = classifyVerificationOutput(`
    expect(received).toBe(expected)
    Expected: "Hello World!"
    Received: "Message 1"
  `);

  assert.ok(result.classes.includes("assertion_failure"));
  assert.ok(result.classes.includes("exact_output_mismatch"));
});

test("extracts generic failure classes for infrastructure and artifact issues", () => {
  const result = classifyVerificationOutput(`
    PermissionError: [Errno 13] Permission denied: './run_pipeline.sh'
    E   AssertionError: File /app/value.txt does not exist
    E   UnicodeDecodeError: 'utf-8' codec can't decode byte 0xb8 in position 43
    requests.exceptions.ConnectionError: HTTPConnectionPool(host='program', port=8008): Failed to establish a new connection: [Errno 111] Connection refused
  `);

  assert.ok(result.classes.includes("permission_or_executable"));
  assert.ok(result.classes.includes("missing_artifact"));
  assert.ok(result.classes.includes("text_encoding_or_binary_output"));
  assert.ok(result.classes.includes("external_service"));
});
