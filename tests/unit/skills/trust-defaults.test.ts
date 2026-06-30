/**
 * AC6: Project-local skills untrusted by default.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TrustResolver } from "../../../src/skills/trust.js";

test("AC6: project-local skills default to project-untrusted", () => {
  const resolver = new TrustResolver({
    builtinRoot: "/workspace/src/skills/built-in",
    userHomeSkillsDir: "/home/u/.reaper/skills",
    projectSkillsDir: "/workspace/.reaper/skills",
  });
  const decision = resolver.resolve({ skillPath: "/workspace/.reaper/skills/some-skill" });
  assert.equal(decision.trust, "project-untrusted");
});

test("AC6b: user-home skills are trusted by default", () => {
  const resolver = new TrustResolver({
    builtinRoot: "/workspace/src/skills/built-in",
    userHomeSkillsDir: "/home/u/.reaper/skills",
    projectSkillsDir: "/workspace/.reaper/skills",
  });
  const decision = resolver.resolve({ skillPath: "/home/u/.reaper/skills/my-skill" });
  assert.equal(decision.trust, "user-trusted");
});

test("AC6c: built-in skills are always trusted", () => {
  const resolver = new TrustResolver({
    builtinRoot: "/workspace/src/skills/built-in",
    userHomeSkillsDir: "/home/u/.reaper/skills",
    projectSkillsDir: "/workspace/.reaper/skills",
  });
  const decision = resolver.resolve({ skillPath: "/workspace/src/skills/built-in/repo-understanding" });
  assert.equal(decision.trust, "builtin");
});
