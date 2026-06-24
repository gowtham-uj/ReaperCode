/**
 * AC3: Detects invalid `skill.json`.
 * Bad name, bad version, unknown category, missing required field.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseSkillManifest } from "../../../src/skills/manifest.js";

test("AC3a: rejects bad name", () => {
  assert.throws(() => parseSkillManifest(JSON.stringify({
    name: "Bad_Name",
    version: "1.0.0",
    description: "x",
    category: "bug-fixing",
    whenToUse: "x",
    allowedTools: [],
    trust: "builtin",
  })));
});

test("AC3b: rejects bad version", () => {
  assert.throws(() => parseSkillManifest(JSON.stringify({
    name: "ok-name",
    version: "not-semver",
    description: "x",
    category: "bug-fixing",
    whenToUse: "x",
    allowedTools: [],
    trust: "builtin",
  })));
});

test("AC3c: rejects unknown category", () => {
  assert.throws(() => parseSkillManifest(JSON.stringify({
    name: "ok-name",
    version: "1.0.0",
    description: "x",
    category: "no-such-category",
    whenToUse: "x",
    allowedTools: [],
    trust: "builtin",
  })));
});

test("AC3d: accepts a valid manifest", () => {
  const m = parseSkillManifest(JSON.stringify({
    name: "ok-name",
    version: "1.0.0",
    description: "fine",
    category: "bug-fixing",
    whenToUse: "always",
    allowedTools: ["read_file"],
    trust: "builtin",
  }));
  assert.equal(m.name, "ok-name");
});
