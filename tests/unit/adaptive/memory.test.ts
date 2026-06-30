import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PersistentMemoryStore } from "../../../src/adaptive/persistent-memory-store.js";
import { MemoryScopePolicy } from "../../../src/adaptive/memory-scope-policy.js";

test("PersistentMemoryStore refuses secret scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-"));
  try {
    const store = new PersistentMemoryStore({ workspaceRoot: dir });
    const r = store.remember({ scope: "secret", kind: "project_fact", content: "x", source: "agent_inferred", confidence: 1 });
    assert.equal(r, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PersistentMemoryStore redacts sensitive content", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-"));
  try {
    const store = new PersistentMemoryStore({ workspaceRoot: dir });
    const r = store.remember({ scope: "project", kind: "project_fact", content: "token AKIAIOSFODNN7EXAMPLE is set", source: "agent_inferred", confidence: 0.7, sensitive: true });
    assert.ok(r);
    assert.match(r!.content, /\[REDACTED:aws-access-key\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PersistentMemoryStore persists project scope to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-"));
  try {
    const store = new PersistentMemoryStore({ workspaceRoot: dir });
    store.remember({ scope: "project", kind: "project_fact", content: "uses pnpm", source: "successful_validation", confidence: 0.9 });
    assert.ok(existsSync(join(dir, ".reaper", "memory", "project.jsonl")));
    const reloaded = new PersistentMemoryStore({ workspaceRoot: dir });
    assert.equal(reloaded.list("project").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PersistentMemoryStore search ranks by confidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-"));
  try {
    const store = new PersistentMemoryStore({ workspaceRoot: dir });
    store.remember({ scope: "project", kind: "project_fact", content: "low-confidence thing", source: "agent_inferred", confidence: 0.55 });
    store.remember({ scope: "project", kind: "project_fact", content: "high-confidence thing", source: "successful_validation", confidence: 0.95 });
    const r = store.search("thing");
    assert.equal(r.length, 2);
    assert.equal(r[0]!.content, "high-confidence thing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemoryScopePolicy skips low confidence", () => {
  const policy = new MemoryScopePolicy();
  const d = policy.decide({ content: "x", kind: "project_fact", source: "agent_inferred", confidence: 0.3, evidenceCount: 0, repoSignals: { files: [], commands: [], manifests: [] } });
  assert.equal(d.action, "skip");
});

test("MemoryScopePolicy routes repo facts to project scope", () => {
  const policy = new MemoryScopePolicy();
  const d = policy.decide({ content: "package.json uses pnpm", kind: "project_fact", source: "agent_inferred", confidence: 0.7, evidenceCount: 1, repoSignals: { files: ["package.json"], commands: [], manifests: ["package.json"] } });
  assert.equal(d.action, "store");
  assert.equal(d.scope, "project");
});

test("MemoryScopePolicy routes env facts to machine scope", () => {
  const policy = new MemoryScopePolicy();
  const d = policy.decide({ content: "node is at /usr/local/bin/node on linux", kind: "environment_fact", source: "agent_inferred", confidence: 0.7, evidenceCount: 0, repoSignals: { files: [], commands: [], manifests: [] } });
  assert.equal(d.action, "store");
  assert.equal(d.scope, "machine");
});

test("MemoryScopePolicy redacts secrets before storing", () => {
  const policy = new MemoryScopePolicy();
  const d = policy.decide({ content: "TOKEN=abcdef123456 set as environment variable", kind: "project_fact", source: "agent_inferred", confidence: 0.7, evidenceCount: 0, repoSignals: { files: [], commands: [], manifests: [] } });
  assert.equal(d.action, "redact_then_store");
  assert.ok((d.redactions ?? []).length > 0);
});

test("MemoryScopePolicy routes user-explicit preferences to user scope", () => {
  const policy = new MemoryScopePolicy();
  const d = policy.decide({ content: "always use pnpm", kind: "user_preference", source: "user_explicit", confidence: 0.9, evidenceCount: 0, repoSignals: { files: [], commands: [], manifests: [] } });
  assert.equal(d.action, "store");
  assert.equal(d.scope, "user");
});

test("MemoryScopePolicy asks on contradiction", () => {
  const policy = new MemoryScopePolicy();
  const existing = [{
    id: "x", scope: "project" as const, kind: "project_fact" as const, content: "uses npm",
    evidence: [], confidence: 0.9, source: "agent_inferred" as const,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", tags: ["pkg"], sensitive: false, editable: true,
  }];
  const d = policy.decide({ content: "use pnpm", kind: "project_fact", source: "agent_inferred", confidence: 0.7, evidenceCount: 1, repoSignals: { files: [], commands: [], manifests: [] }, existing });
  assert.equal(d.action, "ask");
});
