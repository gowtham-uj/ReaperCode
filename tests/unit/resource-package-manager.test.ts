import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DefaultResourcePackageManager,
  applyResourcePatterns,
  type PackageSettingsEntry,
  type ResourcePackageCommandRunner,
} from "../../src/resources/package-manager.js";
import { ProjectTrustStore } from "../../src/resources/project-trust.js";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

function fakeRunner(calls: Array<{ command: string; args: string[]; cwd: string }> = []): ResourcePackageCommandRunner {
  return async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

test("DefaultResourcePackageManager installs npm and git packages into safe managed roots", async () => {
  const workspace = await tempDir("reaper-pkg-workspace-");
  const home = await tempDir("reaper-pkg-home-");
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const manager = new DefaultResourcePackageManager({ workspaceRoot: workspace, userHome: home, runner: fakeRunner(calls) });

  await manager.install("npm:@acme/reaper-pack@1.0.0", { scope: "user" });
  await manager.install("git:github.com/acme/reaper-tools@main", { scope: "user" });

  assert.equal(manager.getInstalledPath("npm:@acme/reaper-pack", "user"), path.join(home, ".reaper", "packages", "npm", "node_modules", "@acme", "reaper-pack"));
  assert.equal(manager.getInstalledPath("git:github.com/acme/reaper-tools", "user"), path.join(home, ".reaper", "packages", "git", "github.com", "acme", "reaper-tools"));
  assert.deepEqual(calls.map((call) => call.command), ["npm", "git"]);
  assert.equal(await readFile(path.join(home, ".reaper", "packages", "npm", ".gitignore"), "utf8"), "*\n!.gitignore\n");
});

test("DefaultResourcePackageManager blocks project installs until the project is trusted", async () => {
  const workspace = await tempDir("reaper-pkg-untrusted-");
  const home = await tempDir("reaper-pkg-home-");
  const manager = new DefaultResourcePackageManager({ workspaceRoot: workspace, userHome: home, runner: fakeRunner() });

  await assert.rejects(
    () => manager.install("npm:@acme/reaper-pack", { scope: "project" }),
    /Project resources are not trusted/,
  );

  await ProjectTrustStore.create(home).set(workspace, true);
  await manager.install("npm:@acme/reaper-pack", { scope: "project" });
  assert.equal(manager.getInstalledPath("npm:@acme/reaper-pack", "project"), path.join(workspace, ".reaper", "packages", "npm", "node_modules", "@acme", "reaper-pack"));
});

test("DefaultResourcePackageManager persists package settings and dedupes by package identity", async () => {
  const workspace = await tempDir("reaper-pkg-settings-");
  const home = await tempDir("reaper-pkg-home-");
  const manager = new DefaultResourcePackageManager({ workspaceRoot: workspace, userHome: home, runner: fakeRunner() });

  await manager.addSourceToSettings("npm:@acme/reaper-pack@1.0.0", { scope: "user" });
  await manager.addSourceToSettings("npm:@acme/reaper-pack@^2.0.0", { scope: "user" });
  await manager.addSourceToSettings("git:github.com/acme/reaper-tools@main", { scope: "user" });
  await manager.addSourceToSettings("https://github.com/acme/reaper-tools@v1", { scope: "user" });

  assert.deepEqual(manager.listConfiguredPackages().map((entry) => entry.source), [
    "npm:@acme/reaper-pack@^2.0.0",
    "https://github.com/acme/reaper-tools@v1",
  ]);
});

test("DefaultResourcePackageManager resolves local package paths relative to scope settings", async () => {
  const workspace = await tempDir("reaper-pkg-local-");
  const home = await tempDir("reaper-pkg-home-");
  const projectPkg = path.join(workspace, ".reaper", "local-pack");
  await mkdir(projectPkg, { recursive: true });
  const manager = new DefaultResourcePackageManager({ workspaceRoot: workspace, userHome: home, runner: fakeRunner() });

  assert.equal(manager.getInstalledPath("./local-pack", "project"), projectPkg);
});

test("applyResourcePatterns implements include, exclude, force include, force exclude, and empty-disable semantics", () => {
  const all = [
    "/pkg/extensions/a.js",
    "/pkg/extensions/b.js",
    "/pkg/extensions/danger.js",
    "/pkg/extensions/sub/c.js",
  ];

  assert.deepEqual(applyResourcePatterns(all, [], "/pkg"), new Set<string>());
  assert.deepEqual(
    applyResourcePatterns(all, ["extensions/*.js", "!extensions/danger.js", "+extensions/sub/c.js", "-extensions/b.js"], "/pkg"),
    new Set(["/pkg/extensions/a.js", "/pkg/extensions/sub/c.js"]),
  );
});

test("DefaultResourcePackageManager materializes package resource inputs from configured installed paths", async () => {
  const workspace = await tempDir("reaper-pkg-inputs-");
  const home = await tempDir("reaper-pkg-home-");
  const manager = new DefaultResourcePackageManager({ workspaceRoot: workspace, userHome: home, runner: fakeRunner() });
  const installed = manager.getInstalledPath("npm:@acme/reaper-pack", "user");
  await mkdir(installed, { recursive: true });
  await manager.addSourceToSettings("npm:@acme/reaper-pack", { scope: "user" });

  assert.deepEqual(manager.resolvePackageResourceInputs(), [{ root: installed, source: "npm:@acme/reaper-pack", scope: "user" }]);
});
