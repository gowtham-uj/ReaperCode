import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ProjectTrustStore,
  hasTrustRequiringProjectResources,
  resolveProjectTrusted,
  type ProjectTrustDecision,
} from "../../src/resources/project-trust.js";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

test("hasTrustRequiringProjectResources is false when no executable project resources exist", async () => {
  const workspace = await tempDir("reaper-trust-empty-");
  assert.equal(await hasTrustRequiringProjectResources(workspace), false);
});

test("hasTrustRequiringProjectResources detects executable project-local resources", async () => {
  const workspace = await tempDir("reaper-trust-project-");
  await mkdir(path.join(workspace, ".reaper", "extensions", "demo"), { recursive: true });
  await mkdir(path.join(workspace, ".reaper", "hooks"), { recursive: true });

  assert.equal(await hasTrustRequiringProjectResources(workspace), true);
});

test("ProjectTrustStore persists remembered trust decisions by canonical workspace path", async () => {
  const home = await tempDir("reaper-trust-home-");
  const workspace = await tempDir("reaper-trust-workspace-");
  const store = ProjectTrustStore.create(home);

  assert.equal(await store.get(workspace), null);
  await store.set(workspace, true);
  assert.equal(await store.get(workspace), true);

  const reloaded = ProjectTrustStore.create(home);
  assert.equal(await reloaded.get(path.join(workspace, ".")), true);

  await reloaded.set(workspace, false);
  const raw = await readFile(path.join(home, ".reaper", "project-trust.json"), "utf8");
  assert.match(raw, /\"trusted\": false/);
});

test("resolveProjectTrusted trusts projects with no executable project resources", async () => {
  const workspace = await tempDir("reaper-trust-no-resource-");
  const store = ProjectTrustStore.create(await tempDir("reaper-trust-home-") );

  const decision = await resolveProjectTrusted({ workspaceRoot: workspace, store });
  assert.deepEqual(decision, {
    trusted: true,
    source: "no-project-resources",
    requiresTrust: false,
  });
});

test("resolveProjectTrusted blocks unremembered project resources when default is never", async () => {
  const workspace = await tempDir("reaper-trust-never-");
  await mkdir(path.join(workspace, ".reaper", "extensions", "demo"), { recursive: true });
  const store = ProjectTrustStore.create(await tempDir("reaper-trust-home-"));

  const decision = await resolveProjectTrusted({ workspaceRoot: workspace, store, defaultDecision: "never" });
  assert.deepEqual(decision, {
    trusted: false,
    source: "default-never",
    requiresTrust: true,
  });
});

test("resolveProjectTrusted can grant session-only trust without persisting", async () => {
  const workspace = await tempDir("reaper-trust-session-");
  await mkdir(path.join(workspace, ".reaper", "extensions", "demo"), { recursive: true });
  const home = await tempDir("reaper-trust-home-");
  const store = ProjectTrustStore.create(home);
  const ask = async (): Promise<ProjectTrustDecision> => "session";

  const decision = await resolveProjectTrusted({ workspaceRoot: workspace, store, defaultDecision: "ask", ask });
  assert.deepEqual(decision, {
    trusted: true,
    source: "ask-session",
    requiresTrust: true,
  });
  assert.equal(await ProjectTrustStore.create(home).get(workspace), null);
});

test("resolveProjectTrusted persists explicit trusted approval", async () => {
  const workspace = await tempDir("reaper-trust-approve-");
  await mkdir(path.join(workspace, ".reaper", "packages"), { recursive: true });
  const home = await tempDir("reaper-trust-home-");
  const store = ProjectTrustStore.create(home);
  const ask = async (): Promise<ProjectTrustDecision> => "trusted";

  const decision = await resolveProjectTrusted({ workspaceRoot: workspace, store, defaultDecision: "ask", ask });
  assert.equal(decision.trusted, true);
  assert.equal(decision.source, "ask-persisted");
  assert.equal(await ProjectTrustStore.create(home).get(workspace), true);
});
