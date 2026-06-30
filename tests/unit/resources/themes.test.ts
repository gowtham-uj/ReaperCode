import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isThemeFileName, listThemeFiles, resolveTheme } from "../../../src/resources/themes.js";
import { resolveResources } from "../../../src/resources/resource-loader.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test("isThemeFileName recognizes JSON and CSS themes", () => {
  assert.equal(isThemeFileName("dark.json"), true);
  assert.equal(isThemeFileName("dark.css"), true);
  assert.equal(isThemeFileName("DARK.JSON"), true);
  assert.equal(isThemeFileName("dark.txt"), false);
  assert.equal(isThemeFileName("README"), false);
});

test("listThemeFiles returns only theme files sorted by name", async () => {
  const dir = await tempDir("reaper-themes-list-");
  await writeFile(path.join(dir, "alpha.json"), "{}", "utf8");
  await writeFile(path.join(dir, "beta.css"), "/* css */", "utf8");
  await writeFile(path.join(dir, "notes.txt"), "not a theme", "utf8");

  const files = await listThemeFiles(dir);
  assert.deepEqual(files.map((p) => path.basename(p)), ["alpha.json", "beta.css"]);
});

test("resolveTheme parses JSON theme name and detects CSS format", async () => {
  const dir = await tempDir("reaper-themes-parse-");
  const jsonPath = path.join(dir, "named.json");
  const cssPath = path.join(dir, "plain.css");
  await writeFile(jsonPath, JSON.stringify({ name: "neon", colors: {} }), "utf8");
  await writeFile(cssPath, "/* theme */", "utf8");

  const json = await resolveTheme(jsonPath);
  assert.equal(json.id, "neon");
  assert.equal(json.format, "json");
  assert.equal(json.parsed, true);

  const css = await resolveTheme(cssPath);
  assert.equal(css.id, "plain");
  assert.equal(css.format, "css");
  assert.equal(css.parsed, true);
});

test("resolveResources includes project, user, and package themes with highest precedence winning", async () => {
  const workspace = await tempDir("reaper-themes-workspace-");
  const home = await tempDir("reaper-themes-home-");
  const packageRoot = await tempDir("reaper-themes-package-");

  await mkdir(path.join(workspace, ".reaper", "themes"), { recursive: true });
  await writeFile(path.join(workspace, ".reaper", "themes", "dark.json"), JSON.stringify({ name: "dark" }), "utf8");
  await mkdir(path.join(home, ".reaper", "themes"), { recursive: true });
  await writeFile(path.join(home, ".reaper", "themes", "light.css"), "/* light */", "utf8");
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@acme/reaper-themes",
    reaper: { themes: ["themes/extra.json"] },
  }), "utf8");
  await mkdir(path.join(packageRoot, "themes"), { recursive: true });
  await writeFile(path.join(packageRoot, "themes", "extra.json"), JSON.stringify({ name: "extra" }), "utf8");

  const resolved = await resolveResources({
    workspaceRoot: workspace,
    userHome: home,
    packages: [{ root: packageRoot, source: "npm:@acme/reaper-themes", scope: "user" }],
  });

  const ids = resolved.themes.map((theme) => theme.id).sort();
  assert.deepEqual(ids, ["dark", "extra", "light"]);
  // Project theme wins for "dark" (only one match), user "light" wins, package "extra" wins for its id.
  const dark = resolved.themes.find((theme) => theme.id === "dark")!;
  assert.equal(dark.format, "json");
  assert.match(dark.path, /workspace.*dark\.json$/);
});