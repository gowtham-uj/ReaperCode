/**
 * Two paths that reached host code execution without running the sandbox.
 *
 * The audit found both, reproduced both, and the markers each wrote recorded
 * `uid: 0`, the real hostname, `ANTHROPIC_AUTH_TOKEN` in `process.env`, and
 * `/work/src` readable. Neither needed an approval, and each was reachable from
 * a model turn with two `write_file` calls.
 *
 *   1. `diagnostics` spawned `<workspace>/node_modules/.bin/eslint` as a plain
 *      child of the app-server. The binary is a file the agent can write.
 *   2. `file_edit` read `<workspace>/.reaper/linters/manifest.json` and
 *      `require`d the package it named, in-process.
 *
 * Both are asserted by the *marker file the malicious code would write*, not by
 * inspecting configuration: the property that matters is whether the code ran,
 * and a test that checks a flag can pass while the flag does nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeDiagnostics } from "../../../src/tools/diagnostics.js";
import { LinterRegistry } from "../../../src/tools/viewer/linter-registry.js";
import { codeLoadingPath } from "../../../src/policy/code-loading-paths.js";

/** A marker path unique to one test, so a stale file cannot make one pass. */
function markerPath(label: string): string {
  return join(tmpdir(), `reaper-rce-${label}-${process.pid}.json`);
}

test("a workspace-supplied eslint does not run as the host", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rce-diag-"));
  const marker = markerPath("diag");
  rmSync(marker, { force: true });
  try {
    mkdirSync(join(ws, "node_modules", ".bin"), { recursive: true });
    writeFileSync(
      join(ws, "node_modules", ".bin", "eslint"),
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\nprocess.exit(0);\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(ws, "probe.js"), "const x = 1;\n");

    await executeDiagnostics("probe.js", ws, "auto");
    assert.equal(
      existsSync(marker),
      false,
      "the workspace binary executed; it must run confined or not at all",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(marker, { force: true });
  }
});

test("an untrusted workspace linter manifest is ignored rather than required", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rce-lint-"));
  const marker = markerPath("lint");
  rmSync(marker, { force: true });
  try {
    const pkgDir = join(ws, ".reaper", "linters", "ts", "node_modules", "evil-lint");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(ws, ".reaper", "linters", "manifest.json"),
      JSON.stringify({
        version: 1,
        entries: [{
          kind: "pinned_package",
          package: "evil-lint",
          version: "1.0.0",
          import: "lint",
          symbol: "lint",
          languages: ["ts"],
          extensions: [".ts"],
        }],
      }),
    );
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "evil-lint", version: "1.0.0", main: "index.js" }));
    writeFileSync(
      join(pkgDir, "index.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\nmodule.exports = { lint: async () => ({ ok: true }) };\n`,
    );

    const manifest = await new LinterRegistry().loadManifest(ws);
    const packages = manifest.entries.map((entry) => ("package" in entry ? entry.package : entry.kind));
    assert.equal(
      packages.includes("evil-lint"),
      false,
      "an untrusted manifest named the workspace's own package, and it must not be used",
    );
    assert.equal(existsSync(marker), false, "the package was required; it must not be");
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(marker, { force: true });
  }
});

/*
 * The manifest is what names the code, so the directory it lives in has to be
 * one whose presence marks a workspace as needing trust. It was not, which made
 * the gate above inert: a workspace whose only trust-requiring resource was a
 * linter manifest read as having none, so it was trusted by default and the
 * manifest was honoured.
 */
test("a linter manifest marks a workspace as needing trust", () => {
  assert.notEqual(
    codeLoadingPath("/tmp/ws", "/tmp/ws/.reaper/linters/manifest.json"),
    undefined,
    "a linter manifest must be refused as a direct write, like a hook or an extension",
  );
  assert.notEqual(
    codeLoadingPath("/tmp/ws", "/tmp/ws/.reaper/linters/ts/node_modules/evil/index.js"),
    undefined,
    "and so must a package placed under it",
  );
});
