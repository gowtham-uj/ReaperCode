/**
 * Switching a skill off, end to end.
 *
 * `skill disable` has never worked for a built-in skill, and the failure was
 * invisible from both ends. The CLI wrote a `disabled` marker file *beside the
 * skill's manifest* — which for a built-in is the shipped source tree in a
 * checkout and a temp directory regenerated from the bundle's inlined manifest
 * at runtime. So the marker either edited the installation or evaporated on the
 * next process start, while the command printed `disabled <name>` and exited 0
 * either way. Alongside that, the read path consulted `SkillMemoryRegistry`,
 * whose disabled flag lives in its own index and is set by a different call, so
 * `skill list` reported "active" immediately after the disable "succeeded".
 *
 * The state is a user-global list now (`runtimeTunables.disabledSkills`), and
 * what follows pins the two properties that were missing: a disable is durable
 * across processes, and every surface that can answer "is this skill on" gives
 * the same answer.
 *
 * These tests run against a scratch home rather than the real one. A test that
 * disabled a skill in `~/.reaper/settings.json` would leave the machine it ran
 * on changed, which is the same class of mistake the feature itself used to
 * make.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverSkills } from "../../../src/skills/discovery.js";
import { TrustResolver } from "../../../src/skills/trust.js";
import { builtinSkillsRoot } from "../../../src/skills/built-in/index.js";
import {
  MAX_DISABLED_SKILLS,
  readDisabledSkills,
} from "../../../src/context/pinned-skills.js";
import { readRawUserSettings, updateUserSettings } from "../../../src/config/settings-file.js";
import { listWorkspaceSkills } from "../../../src/app-server/workspace-inventory.js";
import { activateSkillTool } from "../../../src/tools/read/activate-skill.js";

/** A fresh home directory, removed when the test ends. */
function scratchHome(): { home: string; done: () => void } {
  const home = mkdtempSync(join(tmpdir(), "reaper-skill-switch-"));
  return { home, done: () => rmSync(home, { recursive: true, force: true }) };
}

/** Write the disabled list the way every surface does. */
function setDisabled(home: string, names: string[]): void {
  updateUserSettings(home, (before) => ({
    ...before,
    runtimeTunables: {
      ...((before.runtimeTunables as Record<string, unknown> | undefined) ?? {}),
      disabledSkills: names,
    },
  }));
}

function discoverWith(disabled: string[]) {
  const builtinRoot = builtinSkillsRoot();
  return discoverSkills({
    builtinRoot,
    userHomeSkillsDir: "",
    projectSkillsDir: "",
    workspaceRoot: "",
    resolver: new TrustResolver({ builtinRoot, userHomeSkillsDir: "", projectSkillsDir: "" }),
    disabledNames: new Set(disabled),
  }).records;
}

test("a switched-off built-in is discovered as disabled, without touching its folder", (t) => {
  const { home, done } = scratchHome();
  t.after(done);

  /*
   * The load-bearing assertion, and it is about a *directory*.
   *
   * The old implementation's whole job was writing a file next to `SKILL.md`.
   * If this test ever fails because a `disabled` marker appeared in
   * `src/skills/built-in/codemode/`, the mechanism has crept back to mutating
   * the installation — and in a source checkout that file would be committed
   * and ship the skill disabled to every user.
   */
  const skillDir = join(builtinSkillsRoot(), "codemode");
  assert.equal(existsSync(join(skillDir, "disabled")), false, "the shipped skill folder must be untouched");

  setDisabled(home, ["codemode"]);

  // The settings file is the only thing that changed.
  const raw = readRawUserSettings(home).raw as { runtimeTunables?: { disabledSkills?: string[] } };
  assert.deepEqual(raw.runtimeTunables?.disabledSkills, ["codemode"]);
  assert.deepEqual(readDisabledSkills(home), ["codemode"]);
  assert.equal(existsSync(join(skillDir, "disabled")), false, "writing the switch must not touch the skill");

  // And discovery agrees.
  const record = discoverWith(readDisabledSkills(home)).find((r) => r.manifest.name === "codemode");
  assert.ok(record, "codemode must still be discovered — disabled is not deleted");
  assert.equal(record.disabled, true);
  assert.equal(record.disabledReason, "disabled in settings");

  // Clearing the list puts it back, with no marker to clean up.
  setDisabled(home, []);
  const enabled = discoverWith(readDisabledSkills(home)).find((r) => r.manifest.name === "codemode");
  assert.ok(enabled);
  assert.equal(enabled.disabled, undefined);
});

test("a disable survives a fresh read, which is what the marker file could not do", (t) => {
  const { home, done } = scratchHome();
  t.after(done);

  setDisabled(home, ["codemode"]);
  /*
   * Deliberately a new read of the file rather than a call through the object
   * that wrote it. The old bug was invisible to any test that kept the registry
   * in memory: the flag was set on the object, the process exited, and the
   * state was gone. Reading from disk is the whole point.
   */
  assert.deepEqual(readDisabledSkills(home), ["codemode"]);
  assert.deepEqual(readDisabledSkills(home), ["codemode"], "and it is stable across reads");
});

test("the web surface and the tool guard agree with the settings file", async (t) => {
  const { home, done } = scratchHome();
  t.after(done);

  /*
   * `listWorkspaceSkills` resolves the user's home from `os.homedir()`, so this
   * test drives the real path by pointing HOME at the scratch directory. That
   * is the honest way to check it: the property under test is "the browser and
   * the CLI read the same file", and stubbing the home out of one of them
   * would remove the thing being checked.
   */
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const before = listWorkspaceSkills("/tmp/reaper-no-such-workspace").data.find((s) => s.name === "codemode");
    assert.ok(before, "codemode must be listed");
    assert.equal(before.disabled, false);

    setDisabled(home, ["codemode"]);

    const after = listWorkspaceSkills("/tmp/reaper-no-such-workspace").data.find((s) => s.name === "codemode");
    assert.ok(after);
    assert.equal(after.disabled, true, "the browser must see the switch without a restart");

    /*
     * And the model cannot route around it. This is the assertion that matters
     * most: the list controls what is *offered*, and `activate_skill` is how a
     * model gets a body by name. A disabled skill whose body is still servable
     * is a disabled skill that isn't.
     */
    await assert.rejects(
      () => activateSkillTool("/tmp/reaper-no-such-workspace", { name: "codemode" }),
      /switched off/,
      "a switched-off skill must not be activatable",
    );

    setDisabled(home, []);
    const reenabled = await activateSkillTool("/tmp/reaper-no-such-workspace", { name: "codemode" });
    assert.match(String(reenabled), /# Code Mode/, "and re-enabling must restore it");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("the disabled list is cleaned and bounded like the pin list", (t) => {
  const { home, done } = scratchHome();
  t.after(done);

  /*
   * A hand-edited file is the normal case for a settings file, so the reader
   * has to survive one: duplicates collapse, non-strings drop, whitespace-only
   * names drop, and an entry of the wrong type does not throw. The same
   * normaliser as pinning, asserted here so the two lists cannot drift into
   * different ideas of what a name is.
   *
   * Written to disk directly rather than through `updateUserSettings`, because
   * the writer is *supposed* to reject this — it validates before and after
   * every mutation, which is what stops Reaper committing a config it cannot
   * load. The reader is the half that has to be tolerant, and hand-editing is
   * how a file like this comes to exist.
   */
  mkdirSync(join(home, ".reaper"), { recursive: true });
  writeFileSync(
    join(home, ".reaper", "settings.json"),
    JSON.stringify({ runtimeTunables: { disabledSkills: ["codemode", "codemode", "  ", 42, null, "other"] } }),
    "utf8",
  );
  assert.deepEqual(readDisabledSkills(home), ["codemode", "other"]);
  assert.ok(MAX_DISABLED_SKILLS >= 500, "the cap must be large enough to be useful");

  // A malformed file is a settings problem, not a discovery problem.
  const broken = scratchHome();
  t.after(broken.done);
  assert.deepEqual(readDisabledSkills(broken.home), [], "an absent file means nothing is switched off");
});

test("a skill the user wrote can still ship switched off by its own marker", (t) => {
  const { home, done } = scratchHome();
  t.after(done);

  /*
   * The marker file is not gone — it is the right mechanism for the one case
   * it fits, a skill author who wants their skill to arrive disabled. What
   * changed is that Reaper no longer *writes* one into a directory it does not
   * own. Both sources OR together, and the reason names which one applied so
   * `skill list --verbose` can tell a person where to undo it.
   */
  const builtinRoot = builtinSkillsRoot();
  const records = discoverSkills({
    builtinRoot,
    userHomeSkillsDir: "",
    projectSkillsDir: "",
    workspaceRoot: "",
    resolver: new TrustResolver({ builtinRoot, userHomeSkillsDir: "", projectSkillsDir: "" }),
    disabledNames: new Set(["codemode"]),
  }).records;
  const record = records.find((r) => r.manifest.name === "codemode");
  assert.equal(record?.disabled, true);

  // With neither source, the same discovery reports it enabled — proving the
  // flag above came from the set and not from something already on disk.
  const clean = discoverWith([]).find((r) => r.manifest.name === "codemode");
  assert.equal(clean?.disabled, undefined);
});

test("the settings document round-trips without dropping other keys", (t) => {
  const { home, done } = scratchHome();
  t.after(done);

  /*
   * The disabled list shares one document with every other setting, written
   * through the one atomic writer. A mutator that reconstructed `runtimeTunables`
   * from its own fields would silently delete a user's pins — the two lists are
   * edited from different screens and would otherwise clobber each other.
   */
  updateUserSettings(home, (before) => ({
    ...before,
    runtimeTunables: { ...((before.runtimeTunables as Record<string, unknown> | undefined) ?? {}), pinnedSkills: ["codemode"] },
  }));
  setDisabled(home, ["something-else"]);

  const raw = readRawUserSettings(home).raw as {
    runtimeTunables?: { pinnedSkills?: string[]; disabledSkills?: string[] };
  };
  assert.deepEqual(raw.runtimeTunables?.pinnedSkills, ["codemode"], "pins must survive a disable write");
  assert.deepEqual(raw.runtimeTunables?.disabledSkills, ["something-else"]);

  // And the file is valid JSON on disk, not merely valid in memory.
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(home, ".reaper", "settings.json"), "utf8")));
});

test("no surface writes a marker into a built-in skill's own directory", async (t) => {
  const { home, done } = scratchHome();
  t.after(done);

  /*
   * The regression this whole file exists for, stated as a filesystem fact.
   *
   * `SkillRegistry.disable` maintained a `disabled` marker next to the
   * manifest, and `skillDir` for a built-in resolves to the shipped source
   * directory — or, in the bundle, a temp directory regenerated on every run.
   * So the command that switched a built-in off either edited Reaper's own
   * installation (in a checkout: a file that gets committed, shipping the skill
   * permanently off to everyone) or wrote somewhere that lasts until the next
   * process start. Both are wrong, and neither shows up in an assertion about
   * the returned boolean.
   *
   * A snapshot of the directory before and after is the only check that
   * actually catches it.
   */
  const { builtinSkillsRoot } = await import("../../../src/skills/built-in/index.js");
  const { SkillRegistry } = await import("../../../src/skills/registry.js");
  const { discoverSkills } = await import("../../../src/skills/discovery.js");
  const { TrustResolver } = await import("../../../src/skills/trust.js");

  const builtinRoot = builtinSkillsRoot();
  const before = readdirSync(join(builtinRoot, "codemode")).sort();

  const registry = new SkillRegistry({ builtinMetadata: {} });
  const { records } = discoverSkills({
    builtinRoot,
    userHomeSkillsDir: "",
    projectSkillsDir: "",
    workspaceRoot: "",
    resolver: new TrustResolver({ builtinRoot, userHomeSkillsDir: "", projectSkillsDir: "" }),
  });
  for (const record of records) registry.register(record);

  registry.disable("codemode", "test");
  assert.equal(registry.get("codemode")?.disabled, true, "the in-process record must flip");

  const after = readdirSync(join(builtinRoot, "codemode")).sort();
  assert.deepEqual(after, before, "disabling must not write into the shipped skill directory");

  registry.enable("codemode");
  assert.deepEqual(readdirSync(join(builtinRoot, "codemode")).sort(), before, "nor must enabling");
});
