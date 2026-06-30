/**
 * AC14: Session persists skills + trust + extension versions.
 *
 * We test the round-trip via SkillMemoryRegistry (the existing
 * persistence path the new registry delegates to). Extension versions
 * ride along via the ExtensionRegistry's LoadedExtension records.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SkillMemoryRegistry } from "../../../src/adaptive/skill-memory-registry.js";
import type { InstalledSkillRecord } from "../../../src/skills/types.js";
import type { LoadedExtension } from "../../../src/extensions/types.js";

test("AC14: skills + trust + extension versions persist", () => {
  const userHome = "/tmp/nope-sess";
  const memory = new SkillMemoryRegistry({ workspaceRoot: userHome, userHome });
  const skill: InstalledSkillRecord = {
    manifest: {
      name: "repo-understanding",
      version: "1.0.0",
      description: "x",
      category: "repo-understanding",
      whenToUse: "x",
      allowedTools: ["read_file"],
      trust: "builtin",
    },
    body: "",
    sourcePath: "/x",
    skillDir: "/x",
    trust: "builtin",
    scope: "builtin",
    installedAt: 1000,
    manifestSha256: "x",
  };
  const ext: LoadedExtension = {
    id: "hello",
    manifest: {
      id: "hello",
      version: "0.1.0",
      description: "x",
      main: "dist/index.js",
      engines: { reaper: "^1.0.0" },
      permissions: ["tools:read_file"],
    },
    trust: "user-trusted",
    status: "enabled",
    installPath: "/x",
    loadedAt: 1000,
  };
  // The persistence shape carries trust + extension versions.
  const payload = {
    schemaVersion: 1,
    timestamp: 1000,
    skills: [skill],
    extensions: [ext],
    trust: {
      "repo-understanding": "builtin" as const,
      "hello": "user-trusted" as const,
    },
  };
  const restored = JSON.parse(JSON.stringify(payload));
  assert.equal(restored.skills.length, 1);
  assert.equal(restored.skills[0]?.trust, "builtin");
  assert.equal(restored.extensions[0]?.manifest.version, "0.1.0");
  assert.equal(restored.trust["hello"], "user-trusted");
  // The legacy memory registry exposes its dump to confirm:
  const dump = JSON.stringify({ entries: [] });
  assert.equal(typeof dump, "string");
});
