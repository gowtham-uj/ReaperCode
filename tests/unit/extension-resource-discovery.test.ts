/**
 * Tests for F5 wiring: bus emit -> handler -> sink.
 *
 * Verifies the end-to-end path described in the F5 step of the
 * report: the engine emits a ResourcesDiscover event, the bus
 * handler resolves matching conditional skills, and the sink
 * receives their bodies.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getExtensionBus, __resetExtensionBusForTests } from "../../src/extension/bus.js";
import {
  registerResourceDiscoveryHandler,
  setConditionalSkillSink,
  resolveConditionalSkillsForRun,
  __resetResourceDiscoveryForTests,
} from "../../src/extension/resource-discovery.js";
import { SkillMemoryRegistry } from "../../src/adaptive/skill-memory-registry.js";
import type { ReaperSkill } from "../../src/adaptive/types.js";

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "reaper-f5-"));
}

function registerWithPattern(workspaceRoot: string, name: string, body: string, patterns: string[]): ReaperSkill {
  const reg = new SkillMemoryRegistry({ workspaceRoot });
  // Write the on-disk file because the handler reads the body from
  // the skill's sourcePath.
  const dir = path.join(workspaceRoot, ".reaper", "skills");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  writeFileSync(file, body, "utf8");
  reg.upsertSkill({
    name,
    description: "f5 test skill",
    type: "behavioral",
    scope: "project",
    whenToUse: "test",
    disableAutoInvocation: false,
    arguments: [],
    allowedTools: [],
    memoryPolicy: { type: "ephemeral" },
    body,
    references: [],
    sourcePath: file,
    version: 1,
    createdBy: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    skillDir: dir,
    pathPatterns: patterns,
  } as unknown as ReaperSkill);
  return reg.getSkill(name)!;
}

test("F5 wiring: resolveConditionalSkillsForRun matches a registered pattern", () => {
  const ws = makeWorkspace();
  try {
    registerWithPattern(ws, "ts-skill", "# TS skill body", ["src/**/*.ts"]);
    const out = resolveConditionalSkillsForRun({
      workspaceRoot: ws,
      paths: [path.join(ws, "src", "foo.ts")],
    });
    assert.equal(out.matches.length, 1);
    assert.equal(out.matches[0]?.name, "ts-skill");
    assert.match(out.matches[0]?.body ?? "", /TS skill body/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("F5 wiring: bus emit triggers the sink", async () => {
  __resetExtensionBusForTests();
  __resetResourceDiscoveryForTests();
  const ws = makeWorkspace();
  try {
    registerWithPattern(ws, "md-skill", "# MD skill body", ["**/*.md"]);
    registerResourceDiscoveryHandler();
    let received: Array<{ name: string; body: string }> = [];
    setConditionalSkillSink((matches) => {
      received = matches;
    });
    await getExtensionBus().emit("ResourcesDiscover", {
      workspaceRoot: ws,
      paths: [path.join(ws, "README.md")],
    });
    assert.equal(received.length, 1);
    assert.equal(received[0]?.name, "md-skill");
  } finally {
    rmSync(ws, { recursive: true, force: true });
    __resetExtensionBusForTests();
    __resetResourceDiscoveryForTests();
    setConditionalSkillSink(null);
  }
});

test("F5 wiring: a skill with no pathPatterns is not returned", () => {
  const ws = makeWorkspace();
  try {
    const reg = new SkillMemoryRegistry({ workspaceRoot: ws });
    reg.upsertSkill({
      name: "plain",
      description: "",
      type: "prompt",
      scope: "project",
      whenToUse: "",
      disableAutoInvocation: false,
      arguments: [],
      allowedTools: [],
      memoryPolicy: { mayReadProjectMemory: false, mayWriteProjectMemory: false, mayReadUserMemory: false, mayWriteUserMemory: false },
      body: "nope",
      references: [],
      sourcePath: "",
      version: 1,
      createdBy: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      skillDir: "",
    });
    const out = resolveConditionalSkillsForRun({
      workspaceRoot: ws,
      paths: [path.join(ws, "src", "foo.ts")],
    });
    assert.equal(out.matches.length, 0);
    assert.equal(out.attempted.length, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("F5 wiring: bus emit ignores malformed payloads without throwing", async () => {
  __resetExtensionBusForTests();
  __resetResourceDiscoveryForTests();
  registerResourceDiscoveryHandler();
  // No throw on bad payloads.
  await getExtensionBus().emit("ResourcesDiscover", null);
  await getExtensionBus().emit("ResourcesDiscover", { workspaceRoot: 42, paths: "nope" });
  await getExtensionBus().emit("ResourcesDiscover", {});
  __resetExtensionBusForTests();
  __resetResourceDiscoveryForTests();
});
