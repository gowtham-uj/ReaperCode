/**
 * Sanity: every one of the 17 built-in skills loads, validates, and
 * registers cleanly. This is the "all 17" test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { discoverSkills } from "../../../src/skills/discovery.js";
import { TrustResolver } from "../../../src/skills/trust.js";
import { builtinSkillsRoot } from "../../../src/skills/built-in/index.js";
import { parseSkillManifest } from "../../../src/skills/manifest.js";

const BUILTIN = builtinSkillsRoot();
const NAMES = [
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
];

test("AC: every one of the 17 built-in skills validates", () => {
  const resolver = new TrustResolver({
    builtinRoot: BUILTIN,
    userHomeSkillsDir: "/tmp/nope",
    projectSkillsDir: "/tmp/nope",
  });
  const out = discoverSkills({
    builtinRoot: BUILTIN,
    userHomeSkillsDir: "/tmp/nope",
    projectSkillsDir: "/tmp/nope",
    workspaceRoot: "/tmp/nope",
    resolver,
  });
  assert.equal(out.records.length, 17);
  // Each must validate against the manifest parser too.
  for (const r of out.records) {
    const m = parseSkillManifest(JSON.stringify({
      name: r.manifest.name,
      version: r.manifest.version,
      description: r.manifest.description,
      category: r.manifest.category,
      whenToUse: r.manifest.whenToUse,
      allowedTools: r.manifest.allowedTools,
      trust: r.manifest.trust,
    }));
    assert.equal(m.name, r.manifest.name);
    assert.ok(NAMES.includes(m.name), `${m.name} is in the 17-name spec`);
  }
});
