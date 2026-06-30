import test from "node:test";
import assert from "node:assert/strict";

import { validateCandidateSource } from "../../src/tools/write/editor-guard.js";

test("editor guard accepts syntactically valid TypeScript", async () => {
  const result = await validateCandidateSource({
    path: "src/new.ts",
    content: "export const value = 42;\n",
  });

  assert.equal(result.ok, true);
  assert.equal(result.checker, "typescript-transpile");
});

test("editor guard rejects broken TypeScript syntax", async () => {
  const result = await validateCandidateSource({
    path: "src/new.ts",
    content: "export const value = ;\n",
  });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join("\n"), /Variable declaration expected|Expression expected/);
});

test("editor guard rejects broken JSON syntax", async () => {
  const result = await validateCandidateSource({
    path: "config.json",
    content: "{ bad json }\n",
  });

  assert.equal(result.ok, false);
  assert.equal(result.checker, "json-parse");
});
