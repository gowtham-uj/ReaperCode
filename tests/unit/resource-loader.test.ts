import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createEmptyResourceAccumulator,
  resolveResources,
  resourcePrecedenceRank,
  type PackageResourceInput,
} from "../../src/resources/resource-loader.js";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

test("resourcePrecedenceRank matches Pi order", () => {
  assert.equal(resourcePrecedenceRank({ scope: "project", source: "local", origin: "top-level" }), 0);
  assert.equal(resourcePrecedenceRank({ scope: "project", source: "auto", origin: "top-level" }), 1);
  assert.equal(resourcePrecedenceRank({ scope: "user", source: "local", origin: "top-level" }), 2);
  assert.equal(resourcePrecedenceRank({ scope: "user", source: "auto", origin: "top-level" }), 3);
  assert.equal(resourcePrecedenceRank({ scope: "user", source: "npm:@acme/reaper-pack", origin: "package" }), 4);
});

test("resolveResources gives project-local resources precedence over user and package resources", async () => {
  const workspace = await tempDir("reaper-resource-workspace-");
  const home = await tempDir("reaper-resource-home-");
  const packageRoot = await tempDir("reaper-resource-package-");

  await writeJson(path.join(workspace, ".reaper", "extensions", "same", "extension.json"), {
    id: "same",
    main: "index.js",
    description: "project extension",
  });
  await writeFile(path.join(workspace, ".reaper", "extensions", "same", "index.js"), "export default {};", "utf8");

  await writeJson(path.join(home, ".reaper", "extensions", "same", "extension.json"), {
    id: "same",
    main: "index.js",
    description: "user extension",
  });
  await writeFile(path.join(home, ".reaper", "extensions", "same", "index.js"), "export default {};", "utf8");

  await writeJson(path.join(packageRoot, "package.json"), {
    name: "@acme/reaper-pack",
    reaper: { extensions: ["extensions/same/index.js"], skills: ["skills/same/SKILL.md"], prompts: ["prompts/same.md"] },
  });
  await mkdir(path.join(packageRoot, "extensions", "same"), { recursive: true });
  await writeFile(path.join(packageRoot, "extensions", "same", "index.js"), "export default {};", "utf8");
  await mkdir(path.join(packageRoot, "skills", "same"), { recursive: true });
  await writeFile(path.join(packageRoot, "skills", "same", "SKILL.md"), "---\nname: same\n---\n# same", "utf8");
  await mkdir(path.join(packageRoot, "prompts"), { recursive: true });
  await writeFile(path.join(packageRoot, "prompts", "same.md"), "package prompt", "utf8");

  const packages: PackageResourceInput[] = [{ root: packageRoot, source: "npm:@acme/reaper-pack", scope: "user" }];
  const resolved = await resolveResources({ workspaceRoot: workspace, userHome: home, packages });

  const extensionMatches = resolved.extensions.filter((resource) => resource.id === "same");
  assert.equal(extensionMatches.length, 3);
  assert.equal(extensionMatches[0]?.enabled, true);
  assert.equal(extensionMatches[0]?.metadata.scope, "project");
  assert.equal(extensionMatches[1]?.enabled, false);
  assert.equal(extensionMatches[1]?.disabledReason, "shadowed-by-higher-precedence-resource");
  assert.equal(extensionMatches[2]?.enabled, false);

  assert.equal(resolved.skills.find((resource) => resource.id === "same")?.metadata.origin, "package");
  assert.equal(resolved.prompts.find((resource) => resource.id === "same")?.metadata.origin, "package");
});

test("resolveResources auto-discovers user/project skills, prompts, and extension entrypoints", async () => {
  const workspace = await tempDir("reaper-resource-auto-workspace-");
  const home = await tempDir("reaper-resource-auto-home-");

  await mkdir(path.join(workspace, ".reaper", "skills", "ship"), { recursive: true });
  await writeFile(path.join(workspace, ".reaper", "skills", "ship", "SKILL.md"), "---\nname: ship\n---\n# ship", "utf8");
  await mkdir(path.join(home, ".reaper", "prompts"), { recursive: true });
  await writeFile(path.join(home, ".reaper", "prompts", "review.md"), "review prompt", "utf8");
  await mkdir(path.join(workspace, ".reaper", "extensions", "lint"), { recursive: true });
  await writeFile(path.join(workspace, ".reaper", "extensions", "lint", "index.js"), "export default {};", "utf8");

  const resolved = await resolveResources({ workspaceRoot: workspace, userHome: home });

  assert.equal(resolved.skills.find((resource) => resource.id === "ship")?.metadata.scope, "project");
  assert.equal(resolved.prompts.find((resource) => resource.id === "review")?.metadata.scope, "user");
  assert.equal(resolved.extensions.find((resource) => resource.id === "lint")?.path.endsWith("index.js"), true);
});

test("resolveResources respects .gitignore/.ignore/.fdignore during auto discovery", async () => {
  const workspace = await tempDir("reaper-resource-ignore-workspace-");
  const home = await tempDir("reaper-resource-ignore-home-");
  const skillsDir = path.join(workspace, ".reaper", "skills");

  await mkdir(path.join(skillsDir, "keep"), { recursive: true });
  await mkdir(path.join(skillsDir, "skip"), { recursive: true });
  await writeFile(path.join(skillsDir, ".gitignore"), "skip/\n", "utf8");
  await writeFile(path.join(skillsDir, "keep", "SKILL.md"), "---\nname: keep\n---\n# keep", "utf8");
  await writeFile(path.join(skillsDir, "skip", "SKILL.md"), "---\nname: skip\n---\n# skip", "utf8");

  const resolved = await resolveResources({ workspaceRoot: workspace, userHome: home });
  assert.equal(resolved.skills.some((resource) => resource.id === "keep"), true);
  assert.equal(resolved.skills.some((resource) => resource.id === "skip"), false);
});

test("createEmptyResourceAccumulator returns independent maps", () => {
  const a = createEmptyResourceAccumulator();
  const b = createEmptyResourceAccumulator();
  a.extensions.set("x", []);
  assert.equal(b.extensions.has("x"), false);
});
