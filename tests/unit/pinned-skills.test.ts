/**
 * Always-on skills.
 *
 * The feature is small and the security story is one sentence — a pin is a
 * *name*, resolved against the skills the turn was already going to offer — but
 * that sentence is only true if the resolution genuinely never consults a list
 * the trust gate has not filtered. Most of what follows exists to pin that
 * down, including the case that would otherwise be easy to miss: a pinned name
 * matching a project skill in an untrusted workspace.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readPinnedSkills, resolvePinnedSkills } from "../../src/context/pinned-skills.js";
import type { Skill } from "../../src/context/skills.js";

function home(): string {
  return mkdtempSync(path.join(tmpdir(), "reaper-pins-home-"));
}

function skillDir(): string {
  return mkdtempSync(path.join(tmpdir(), "reaper-pins-skill-"));
}

function writeSettings(root: string, body: unknown): void {
  mkdirSync(path.join(root, ".reaper"), { recursive: true });
  writeFileSync(path.join(root, ".reaper", "settings.json"), JSON.stringify(body));
}

function writeBody(dir: string, name: string, text: string): Skill {
  const file = path.join(dir, `${name}.md`);
  writeFileSync(file, text);
  return { name, description: `${name} skill`, filePath: file, disableModelInvocation: false };
}

test("reads the pinned list from the user's global settings", () => {
  const root = home();
  try {
    writeSettings(root, { runtimeTunables: { pinnedSkills: ["codemode", "release-checklist"] } });
    assert.deepEqual(readPinnedSkills(root), ["codemode", "release-checklist"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a settings file that is absent, malformed, or the wrong shape pins nothing", () => {
  /*
   * The turn path runs on the CLI, in the app-server, and in tests, and none of
   * them should fail because settings.json is missing or was hand-edited into
   * nonsense. Reading config must never be the reason a turn cannot run.
   */
  const root = home();
  try {
    assert.deepEqual(readPinnedSkills(root), [], "absent file");

    mkdirSync(path.join(root, ".reaper"), { recursive: true });
    writeFileSync(path.join(root, ".reaper", "settings.json"), "{ not json");
    assert.deepEqual(readPinnedSkills(root), [], "malformed file");

    writeSettings(root, { runtimeTunables: { pinnedSkills: "codemode" } });
    assert.deepEqual(readPinnedSkills(root), [], "wrong type");

    writeSettings(root, ["codemode"]);
    assert.deepEqual(readPinnedSkills(root), [], "wrong document type");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hand-written whitespace and duplicates are normalised on read", () => {
  const root = home();
  try {
    writeSettings(root, { runtimeTunables: { pinnedSkills: [" codemode ", "codemode", "", 7, "docs"] } });
    assert.deepEqual(readPinnedSkills(root), ["codemode", "docs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pin resolves to the skill's body, with frontmatter stripped", () => {
  const dir = skillDir();
  try {
    const skill = writeBody(dir, "codemode", "---\nname: codemode\n---\n\n# Code Mode\n\nUse eval.\n");
    const resolved = resolvePinnedSkills(["codemode"], [skill]);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.name, "codemode");
    assert.equal(resolved[0]?.body, "# Code Mode\n\nUse eval.");
    // Frontmatter is a wrapper, not content: if it leaked through the model
    // would read `name: codemode` as an instruction.
    assert.doesNotMatch(resolved[0]!.body, /^---/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pinned name that matches nothing is dropped, not fatal", () => {
  /*
   * Pins are references and references go stale: skills get deleted, renamed,
   * or live in a project you have moved away from. Refusing the turn would turn
   * a harmless drifted reference into a broken workspace.
   */
  const dir = skillDir();
  try {
    const skill = writeBody(dir, "codemode", "# Code Mode");
    const resolved = resolvePinnedSkills(["gone", "codemode", "also-gone"], [skill]);
    assert.deepEqual(resolved.map((entry) => entry.name), ["codemode"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pin cannot reach a skill the turn was not offered", () => {
  /*
   * The security-relevant case, and the reason `resolvePinnedSkills` takes a
   * `Skill[]` instead of doing its own discovery.
   *
   * `available` is what the turn built: packaged skills plus, only in a trusted
   * workspace, the project's. A pinned name that is not in that list resolves to
   * nothing — so pinning `deploy` cannot pull a project skill's instructions
   * into an untrusted repo, because the untrusted repo's skills were never in
   * the list to begin with.
   */
  const resolved = resolvePinnedSkills(["deploy"], []);
  assert.deepEqual(resolved, [], "a pin must select from the offered list, never add to it");
});

test("a skill silenced for model invocation stays silenced even when pinned", () => {
  const dir = skillDir();
  try {
    const skill = { ...writeBody(dir, "quiet", "# Quiet"), disableModelInvocation: true };
    assert.deepEqual(resolvePinnedSkills(["quiet"], [skill]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pins keep their configured order, so the prompt is stable across turns", () => {
  /*
   * Order is not cosmetic. A prompt that reorders itself between requests
   * invalidates the provider's prompt cache on every turn, for no benefit to
   * anyone — the pinned set is the same set.
   */
  const dir = skillDir();
  try {
    const skills = [
      writeBody(dir, "alpha", "# Alpha"),
      writeBody(dir, "beta", "# Beta"),
      writeBody(dir, "gamma", "# Gamma"),
    ];
    const first = resolvePinnedSkills(["gamma", "alpha", "beta"], skills).map((entry) => entry.name);
    const second = resolvePinnedSkills(["gamma", "alpha", "beta"], skills).map((entry) => entry.name);
    assert.deepEqual(first, ["gamma", "alpha", "beta"]);
    assert.deepEqual(second, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty body file is dropped rather than injected as nothing", () => {
  const dir = skillDir();
  try {
    const skill = writeBody(dir, "empty", "   \n\n");
    assert.deepEqual(resolvePinnedSkills(["empty"], [skill]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pin whose file vanished is dropped", () => {
  const dir = skillDir();
  try {
    const skill = writeBody(dir, "ghost", "# Ghost");
    rmSync(skill.filePath, { force: true });
    assert.deepEqual(resolvePinnedSkills(["ghost"], [skill]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
