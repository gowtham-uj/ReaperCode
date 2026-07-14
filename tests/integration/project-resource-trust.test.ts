import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectTrustStore } from "../../src/resources/project-trust.js";
import { prepareRuntimeContent } from "../../src/runtime/content-prep.js";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

async function writeProjectExtension(workspace: string, id: string): Promise<void> {
  const dir = path.join(workspace, ".reaper", "extensions", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "extension.json"), JSON.stringify({ id, main: "index.js" }), "utf8");
  await writeFile(path.join(dir, "index.js"), "export default {};", "utf8");
}

test("prepareRuntimeContent blocks untrusted project resources", async () => {
  const workspace = await tempDir("reaper-runtime-untrusted-");
  const userHome = await tempDir("reaper-runtime-home-");
  await writeProjectExtension(workspace, "demo");

  const contentPrep = await prepareRuntimeContent({
    workspaceRoot: workspace,
    userHome,
    prompt: "inspect resources",
    maxContextTokens: 4000,
  });

  assert.equal(contentPrep.resourceTrust.trusted, false);
  assert.equal(contentPrep.resourceTrust.requiresTrust, true);
  assert.match(contentPrep.resourceTrust.diagnostics.join("\n"), /not trusted/);
  assert.deepEqual(contentPrep.resources.extensions, []);

});

test("prepareRuntimeContent resolves project resources when the project is trusted", async () => {
  const workspace = await tempDir("reaper-runtime-trusted-");
  const userHome = await tempDir("reaper-runtime-home-");
  await writeProjectExtension(workspace, "demo");
  await ProjectTrustStore.create(userHome).set(workspace, true);

  const contentPrep = await prepareRuntimeContent({
    workspaceRoot: workspace,
    userHome,
    prompt: "inspect resources",
    maxContextTokens: 4000,
  });

  assert.equal(contentPrep.resourceTrust.trusted, true);
  assert.equal(contentPrep.resources.extensions.some((resource) => resource.id === "demo" && resource.enabled), true);
});
