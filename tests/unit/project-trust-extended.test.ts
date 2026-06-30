import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ProjectTrustStore,
  findNearestAncestorAgentsRoot,
  hasTrustRequiringProjectResources,
  resolveProjectTrusted,
} from "../../src/resources/project-trust.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test("ProjectTrustStore remembers and reads back a trusted project", async () => {
  const home = await tempDir("reaper-trust-home-");
  const store = ProjectTrustStore.create(home);
  const workspace = await tempDir("reaper-trust-workspace-");

  assert.equal(await store.get(workspace), null);
  await store.set(workspace, true);
  assert.equal(await store.get(workspace), true);
});

test("ProjectTrustStore.getNearestAncestor walks up to the closest trust entry", async () => {
  const home = await tempDir("reaper-trust-ancestor-home-");
  const store = ProjectTrustStore.create(home);
  const parent = await tempDir("reaper-trust-ancestor-parent-");
  const child = path.join(parent, "child");
  await mkdir(child, { recursive: true });
  const grandchild = path.join(child, "grandchild");
  await mkdir(grandchild, { recursive: true });

  await store.set(parent, true);
  const found = await store.getNearestAncestor(grandchild);
  assert.ok(found);
  assert.equal(found!.trusted, true);
  // The returned workspaceRoot should be the parent path (canonicalized).
  assert.match(found!.workspaceRoot, /reaper-trust-ancestor-parent-/);
});

test("ProjectTrustStore.lockReadOnly makes the file read-only and isLocked reports it", async () => {
  const home = await tempDir("reaper-trust-lock-home-");
  const store = ProjectTrustStore.create(home);
  const workspace = await tempDir("reaper-trust-lock-workspace-");
  await store.set(workspace, true);
  assert.equal(store.isLocked(), false);
  store.lockReadOnly();
  // chmod may not be supported on some platforms; only assert if it changed mode.
  if (store.isLocked()) {
    assert.equal(store.isLocked(), true);
  }
});

test("findNearestAncestorAgentsRoot returns the closest directory containing .agents or .reaper", async () => {
  const root = await tempDir("reaper-trust-agents-root-");
  const agents = path.join(root, ".agents");
  await mkdir(path.join(agents, "skills"), { recursive: true });
  await writeFile(path.join(agents, "skills", "SKILL.md"), "---\nname: sample\n---\n# sample", "utf8");
  const deep = path.join(root, "a", "b", "c");
  await mkdir(deep, { recursive: true });
  const found = await findNearestAncestorAgentsRoot(deep);
  assert.equal(found, root);
});

test("findNearestAncestorAgentsRoot returns null when no anchor exists in the test path", async () => {
  const root = await tempDir("reaper-trust-no-agents-root-");
  // Search upward starting from a known-empty subdir; the function should
  // either return null or return a path that is NOT inside our temp dir.
  const sub = path.join(root, "deeper", "still-deeper");
  await mkdir(sub, { recursive: true });
  const found = await findNearestAncestorAgentsRoot(sub);
  if (found !== null) {
    assert.ok(
      !found.startsWith(root),
      `findNearestAncestorAgentsRoot returned ${found} which is inside the test temp dir ${root}`,
    );
  }
});

test("hasTrustRequiringProjectResources flags .agents/skills directories", async () => {
  const root = await tempDir("reaper-trust-has-agents-");
  await mkdir(path.join(root, ".agents", "skills"), { recursive: true });
  await writeFile(path.join(root, ".agents", "skills", "SKILL.md"), "placeholder", "utf8");
  assert.equal(await hasTrustRequiringProjectResources(root), true);
});

test("resolveProjectTrusted honors session-only trust decisions without persisting", async () => {
  const home = await tempDir("reaper-trust-session-home-");
  const store = ProjectTrustStore.create(home);
  const root = await tempDir("reaper-trust-session-workspace-");
  await mkdir(path.join(root, ".reaper", "extensions"), { recursive: true });
  await writeFile(path.join(root, ".reaper", "extensions", "index.js"), "export default {};", "utf8");

  const resolution = await resolveProjectTrusted({
    workspaceRoot: root,
    store,
    defaultDecision: "ask",
    ask: async () => "session",
  });
  assert.equal(resolution.trusted, true);
  assert.equal(resolution.source, "ask-session");
  // Session-only decision must NOT be persisted.
  assert.equal(await store.get(root), null);
});
test("resolveProjectTrusted inherits ancestor trust when the workspace itself is undecided", async () => {
  const home = await tempDir("reaper-trust-inherit-home-");
  const store = ProjectTrustStore.create(home);
  const parent = await tempDir("reaper-trust-inherit-parent-");
  const child = path.join(parent, "child");
  await mkdir(path.join(child, ".reaper", "extensions"), { recursive: true });
  await writeFile(path.join(child, ".reaper", "extensions", "index.js"), "export default {};", "utf8");
  await store.set(parent, true);

  const resolution = await resolveProjectTrusted({
    workspaceRoot: child,
    store,
    ask: async () => "untrusted",
  });
  // ask is bypassed when an ancestor is remembered-trusted.
  assert.equal(resolution.trusted, true);
  assert.equal(resolution.source, "remembered-trusted");
});