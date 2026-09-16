/**
 * An extension's manifest is read from disk, not remembered.
 *
 * The counterpart to `tests/unit/skills/live-reads.test.ts`, and the same
 * problem in a second place: hand-editing `extension.json` used to be invisible
 * until something re-walked the install directories, and the model surface had a
 * `reload` action whose only purpose was to work around that.
 *
 * What must *not* be thrown away is runtime state. Whether an extension is
 * active or has failed is a fact about this process, not about the file, and a
 * refresh that reset it would turn a running extension into a dormant one every
 * time somebody read the list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExtensionRegistry } from "../../../src/extensions/registry.js";

function scaffold(): { root: string; install: string; registry: ExtensionRegistry; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "ext-live-"));
  const workspaceRoot = join(root, "ws");
  const userHome = join(root, "home");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  const registry = new ExtensionRegistry({ workspaceRoot, userHome, builtinRoot: join(root, "builtin") });
  const install = join(workspaceRoot, ".reaper", "extensions", "drifted");
  mkdirSync(install, { recursive: true });
  writeFileSync(
    join(install, "extension.json"),
    JSON.stringify({
      id: "drifted",
      version: "1.0.0",
      description: "ORIGINAL DESCRIPTION",
      main: "main.js",
      engines: { reaper: "^1.0.0" },
      permissions: [],
    }),
  );
  writeFileSync(join(install, "main.js"), "export default { activate() {} };");
  return { root, install, registry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("an edited extension.json is visible on the next read, with no reload step", () => {
  const { install, registry, cleanup } = scaffold();
  try {
    registry.discover();
    assert.equal(registry.get("drifted")?.manifest.description, "ORIGINAL DESCRIPTION");

    writeFileSync(
      join(install, "extension.json"),
      JSON.stringify({
        id: "drifted",
        version: "1.0.0",
        description: "EDITED DESCRIPTION",
        main: "main.js",
        engines: { reaper: "^1.0.0" },
        permissions: [],
      }),
    );

    assert.equal(registry.get("drifted")?.manifest.description, "EDITED DESCRIPTION", "get must re-read the file");
    assert.equal(registry.list()[0]?.manifest.description, "EDITED DESCRIPTION", "list must re-read the file too");
  } finally {
    cleanup();
  }
});

test("refreshing a manifest keeps the activation status the process holds", () => {
  /*
   * The line between content and runtime state. A refresh must not reset
   * `status`, or reading the list would silently deactivate everything.
   */
  const { install, registry, cleanup } = scaffold();
  try {
    registry.discover();
    const before = registry.get("drifted");
    assert.ok(before);
    before.status = "enabled";

    writeFileSync(
      join(install, "extension.json"),
      JSON.stringify({
        id: "drifted",
        version: "1.1.0",
        description: "BUMPED",
        main: "main.js",
        engines: { reaper: "^1.0.0" },
        permissions: [],
      }),
    );

    const after = registry.get("drifted");
    assert.equal(after?.manifest.version, "1.1.0", "the file wins for content");
    assert.equal(after?.status, "enabled", "the process wins for runtime state");
  } finally {
    cleanup();
  }
});

test("an invalid edit is reported rather than hidden behind the last good manifest", () => {
  /*
   * Serving the previous valid manifest would make a broken extension look
   * healthy, which is the failure mode "no cache" exists to remove. The record
   * is marked failed and carries the parse error.
   */
  const { install, registry, cleanup } = scaffold();
  try {
    registry.discover();
    writeFileSync(join(install, "extension.json"), "{ not json");
    const record = registry.get("drifted");
    assert.equal(record?.status, "failed");
    assert.match(record?.error ?? "", /JSON|json/);
  } finally {
    cleanup();
  }
});
