import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseFrontmatter,
  parseSimpleYaml,
  validateSkillFields,
  serializeSkill,
  createSkill,
  loadSkill,
  selectRelevantSkills,
  renderSkillForModel,
} from "../../../src/adaptive/skill-author.js";
import type { ReaperSkill } from "../../../src/adaptive/types.js";

test("parseFrontmatter splits frontmatter and body", () => {
  const raw = `---
name: foo
description: bar
---
# Body

some text`;
  const r = parseFrontmatter(raw);
  assert.ok(r);
  assert.deepEqual(r!.frontmatter, { name: "foo", description: "bar" });
  assert.equal(r!.body, "# Body\n\nsome text");
});

test("parseSimpleYaml handles scalar, list, and inline list", () => {
  const yaml = `name: x
type: prompt
arguments: [a, b, c]
`;
  const r = parseSimpleYaml(yaml);
  assert.equal(r["name"], "x");
  assert.equal(r["type"], "prompt");
  assert.deepEqual(r["arguments"], ["a", "b", "c"]);
});

test("parseSimpleYaml coerces booleans and numbers", () => {
  const r = parseSimpleYaml(`a: true\nb: 42\nc: 3.14\n`);
  assert.equal(r["a"], true);
  assert.equal(r["b"], 42);
  assert.equal(r["c"], 3.14);
});

test("validateSkillFields rejects missing name/description", () => {
  const v = validateSkillFields({ description: "x", type: "prompt", scope: "project" });
  assert.equal(v.ok, false);
  const v2 = validateSkillFields({ name: "x", type: "prompt", scope: "project" });
  assert.equal(v2.ok, false);
});

test("validateSkillFields accepts a complete spec", () => {
  const v = validateSkillFields({ name: "x", description: "y", type: "prompt", scope: "project" });
  assert.equal(v.ok, true);
});

test("validateSkillFields rejects invalid type", () => {
  const v = validateSkillFields({ name: "x", description: "y", type: "weird", scope: "project" });
  assert.equal(v.ok, false);
});

test("createSkill writes SKILL.md to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-"));
  try {
    const skill = createSkill({
      name: "demo",
      description: "demo skill",
      type: "prompt",
      scope: "project",
      body: "Hello $ARGUMENTS",
      allowedTools: ["view_file"],
      arguments: ["x"],
      workspaceRoot: dir,
    });
    assert.ok(existsSync(skill.sourcePath));
    const read = readFileSync(skill.sourcePath, "utf8");
    assert.match(read, /name: demo/);
    assert.match(read, /scope: project/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSkill parses a created skill", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-"));
  try {
    const created = createSkill({
      name: "demo",
      description: "demo",
      type: "prompt",
      scope: "project",
      body: "body",
      workspaceRoot: dir,
    });
    const loaded = loadSkill(created.sourcePath, "project");
    assert.ok(loaded);
    assert.equal(loaded!.name, "demo");
    assert.equal(loaded!.scope, "project");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectRelevantSkills ranks by query and keywords", () => {
  const candidates: ReaperSkill[] = [
    { name: "react-build", description: "build a react app", type: "prompt", scope: "project", whenToUse: "react ui", disableAutoInvocation: false, arguments: [], allowedTools: [], memoryPolicy: { mayReadProjectMemory: true, mayWriteProjectMemory: true, mayReadUserMemory: false, mayWriteUserMemory: false }, body: "", references: [], sourcePath: "", version: 1, createdBy: "x", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", skillDir: "" },
    { name: "db-migrate", description: "postgres migrations", type: "prompt", scope: "project", whenToUse: "sql changes", disableAutoInvocation: false, arguments: [], allowedTools: [], memoryPolicy: { mayReadProjectMemory: true, mayWriteProjectMemory: true, mayReadUserMemory: false, mayWriteUserMemory: false }, body: "", references: [], sourcePath: "", version: 1, createdBy: "x", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", skillDir: "" },
  ];
  const picks = selectRelevantSkills({ query: "react", context: { taskKeywords: ["ui"] }, candidates, maxResults: 3 });
  assert.equal(picks[0]!.name, "react-build");
});

test("renderSkillForModel substitutes $ARGUMENTS and named placeholders", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-"));
  try {
    const skill = createSkill({
      name: "demo",
      description: "demo",
      type: "prompt",
      scope: "project",
      body: "build $TARGET in $MODE",
      arguments: ["TARGET", "MODE"],
      workspaceRoot: dir,
    });
    const rendered = renderSkillForModel(skill, ["app", "debug"]);
    assert.equal(rendered, "build app in debug");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serializeSkill round-trips a complete spec", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-"));
  try {
    const skill = createSkill({
      name: "demo",
      description: "demo",
      type: "prompt",
      scope: "project",
      body: "body",
      allowedTools: ["view_file", "edit_file"],
      arguments: ["a", "b"],
      workspaceRoot: dir,
    });
    const text = serializeSkill(skill);
    assert.match(text, /name: demo/);
    assert.match(text, /scope: project/);
    assert.match(text, /allowedTools: \[view_file, edit_file\]/);
    assert.match(text, /arguments: \[a, b\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
