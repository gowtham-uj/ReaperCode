/**
 * Tests for F5: conditional skill activation by file path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { activateConditionalSkillsForPaths } from "../../src/adaptive/conditional-skills.js";
import type { ReaperSkill } from "../../src/adaptive/types.js";

function skill(name: string, patterns: string[]): ReaperSkill {
  return {
    name,
    description: "",
    type: "prompt",
    scope: "project",
    whenToUse: "",
    disableAutoInvocation: false,
    arguments: [],
    allowedTools: [],
    memoryPolicy: { mayReadProjectMemory: false, mayWriteProjectMemory: false, mayReadUserMemory: false, mayWriteUserMemory: false },
    body: "",
    references: [],
    sourcePath: "",
    version: 1,
    createdBy: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    skillDir: "",
    ...(patterns.length > 0 ? { pathPatterns: patterns } : {}),
  } as ReaperSkill & { pathPatterns?: string[] };
}

test("F5: returns skills whose patterns match", () => {
  const out = activateConditionalSkillsForPaths({
    workspaceRoot: "/workspace",
    paths: ["/workspace/src/foo.ts", "/workspace/README.md"],
    skills: [
      skill("ts-skill", ["src/**/*.ts"]),
      skill("md-skill", ["**/*.md"]),
    ],
  });
  assert.ok(out.includes("ts-skill"));
  assert.ok(out.includes("md-skill"));
});

test("F5: skills without pathPatterns are skipped", () => {
  const out = activateConditionalSkillsForPaths({
    workspaceRoot: "/workspace",
    paths: ["/workspace/src/foo.ts"],
    skills: [skill("plain", [])],
  });
  assert.deepEqual(out, []);
});

test("F5: non-matching patterns are skipped", () => {
  const out = activateConditionalSkillsForPaths({
    workspaceRoot: "/workspace",
    paths: ["/workspace/src/foo.py"],
    skills: [skill("ts-only", ["src/**/*.ts"])],
  });
  assert.deepEqual(out, []);
});
