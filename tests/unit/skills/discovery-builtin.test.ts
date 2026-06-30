/**
 * AC1: Loads built-in skills.
 * Walks src/skills/built-in and confirms 17 records are produced
 * with `trust: "builtin"` for each.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { discoverSkills } from "../../../src/skills/discovery.js";
import { TrustResolver } from "../../../src/skills/trust.js";
import { builtinSkillsRoot } from "../../../src/skills/built-in/index.js";

const BUILTIN = builtinSkillsRoot();

test("AC1: loads every built-in skill", () => {
  const resolver = new TrustResolver({
    builtinRoot: BUILTIN,
    userHomeSkillsDir: "/tmp/nope-user",
    projectSkillsDir: "/tmp/nope-project",
  });
  const out = discoverSkills({
    builtinRoot: BUILTIN,
    userHomeSkillsDir: "/tmp/nope-user",
    projectSkillsDir: "/tmp/nope-project",
    workspaceRoot: "/tmp/nope-workspace",
    resolver,
  });
  const names = out.records.map((r) => r.manifest.name);
  for (const expected of [
    "repo-understanding",
    "bug-fixing",
    "test-failure-debugging",
    "typescript-refactor",
    "python-debugging",
    "frontend-react-debugging",
    "api-backend-debugging",
    "security-review",
    "performance-review",
    "documentation-writing",
    "terminal-bench-solving",
    "swe-bench-solving",
    "agent-runtime-debugging",
    "session-persistence",
    "completion-gate-debugging",
    "prompt-enhancement",
    "swarm-orchestration",
  ]) {
    assert.ok(names.includes(expected), `missing built-in skill "${expected}"`);
  }
  for (const r of out.records) {
    assert.equal(r.trust, "builtin", `skill ${r.manifest.name} should be builtin`);
  }
  assert.equal(out.records.length, 17, "exactly 17 built-in skills");
});
