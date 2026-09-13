/**
 * `/skills pin`, `/skills unpin`, and the pin column in `/skills list`.
 *
 * The command writes the user's real global settings file. These tests inject a
 * temporary home for exactly that reason: without it, running the suite would
 * pin skills on the machine it runs on, which is a side effect a test has no
 * business having.
 *
 * The other thing worth asserting here is that the CLI and the browser agree.
 * Both go through `updateUserSettings` + `normalizePinnedNames`, and the last
 * test reads back what a browser-side write would have written, so a future
 * refactor that splits the two paths fails here rather than in the field.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSkillsCommands } from "../../src/commands/builtin-skills-commands.js";
import { readDisabledSkills, readPinnedSkills } from "../../src/context/pinned-skills.js";
import { updateUserSettings } from "../../src/config/settings-file.js";
import type { SkillRegistry } from "../../src/skills/registry.js";
import type { SkillLifecycle } from "../../src/skills/lifecycle.js";

interface Printed { out: string[]; errors: string[] }

/**
 * A registry stub with just enough surface for the command.
 *
 * Standing up the real `SkillRegistry` here would test discovery, which is a
 * different suite's job; what this file is about is what the command does with
 * a registry's answer.
 */
function stubRegistry(names: string[]): SkillRegistry {
  const entries = names.map((name) => ({
    manifest: { name, version: "1.0.0", description: `${name} description`, category: "prompt-enhancement", allowedTools: [] },
    trust: "builtin" as const,
  }));
  return {
    list: () => entries,
    get: (name: string) => entries.find((entry) => entry.manifest.name === name) ?? null,
    // Present so the command's in-process record update does not throw. What
    // these return is not asserted — the settings file is the state under test,
    // and the registry is only here so the command has something to talk to.
    disable: () => true,
    enable: () => true,
  } as unknown as SkillRegistry;
}

function stubLifecycle(): SkillLifecycle {
  return {} as unknown as SkillLifecycle;
}

async function run(
  home: string,
  names: string[],
  line: string[],
): Promise<{ printed: Printed; result: { ok: boolean; output: string; error?: string } }> {
  const [command] = buildSkillsCommands({ registry: stubRegistry(names), lifecycle: stubLifecycle(), home });
  const printed: Printed = { out: [], errors: [] };
  const result = await command!.run(line, {
    commandName: "skills",
    args: line,
    host: {
      print: (msg: string) => printed.out.push(msg),
      printError: (msg: string) => printed.errors.push(msg),
    },
  } as never);
  return { printed, result };
}

function home(): string {
  return mkdtempSync(path.join(tmpdir(), "reaper-pin-cmd-"));
}

function settingsBody(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, ".reaper", "settings.json"), "utf8")) as Record<string, unknown>;
}

test("pin adds a skill to the always-on list", async () => {
  const root = home();
  try {
    const { printed, result } = await run(root, ["codemode", "docs"], ["pin", "codemode"]);
    assert.equal(result.ok, true);
    assert.deepEqual(readPinnedSkills(root), ["codemode"]);
    assert.match(printed.out.join("\n"), /pinned "codemode"/);
    // The message says what pinning *does*, not just that it happened — the
    // word "pinned" alone does not tell anyone the body now rides in every turn.
    assert.match(printed.out.join("\n"), /every turn/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unpin removes exactly one skill and leaves the rest alone", async () => {
  const root = home();
  try {
    await run(root, ["a", "b", "c"], ["pin", "a"]);
    await run(root, ["a", "b", "c"], ["pin", "b"]);
    await run(root, ["a", "b", "c"], ["pin", "c"]);
    assert.deepEqual(readPinnedSkills(root), ["a", "b", "c"]);

    await run(root, ["a", "b", "c"], ["unpin", "b"]);
    assert.deepEqual(readPinnedSkills(root), ["a", "c"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pinning a skill that does not exist is refused", async () => {
  /*
   * A blind write would be worse than useless: the pin would sit in the file
   * forever, never resolving, and the user would have no signal that the thing
   * they asked for never happened.
   */
  const root = home();
  try {
    const { result } = await run(root, ["codemode"], ["pin", "nonexistent"]);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not found/);
    assert.deepEqual(readPinnedSkills(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pin and unpin both require a name", async () => {
  const root = home();
  try {
    const pin = await run(root, ["codemode"], ["pin"]);
    assert.equal(pin.result.ok, false);
    assert.match(pin.result.error ?? "", /usage/);

    const unpin = await run(root, ["codemode"], ["unpin"]);
    assert.equal(unpin.result.ok, false);
    assert.match(unpin.result.error ?? "", /usage/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pinning twice is a no-op, not a duplicate", async () => {
  const root = home();
  try {
    await run(root, ["codemode"], ["pin", "codemode"]);
    const { result, printed } = await run(root, ["codemode"], ["pin", "codemode"]);
    assert.equal(result.ok, true);
    assert.deepEqual(readPinnedSkills(root), ["codemode"]);
    assert.match(printed.out.join("\n"), /already always on/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unpinning something that is not pinned says so without writing", async () => {
  const root = home();
  try {
    const { result, printed } = await run(root, ["codemode"], ["unpin", "codemode"]);
    assert.equal(result.ok, true);
    assert.match(printed.out.join("\n"), /not always on/);
    // Nothing was pinned, so no settings file should have been created at all.
    assert.throws(() => settingsBody(root), "a no-op unpin must not create a settings file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("list marks pinned skills and summarises them", async () => {
  const root = home();
  try {
    await run(root, ["codemode", "docs"], ["pin", "codemode"]);
    const { printed } = await run(root, ["codemode", "docs"], ["list"]);
    const text = printed.out.join("\n");
    assert.match(text, /codemode.*●/);
    assert.doesNotMatch(text, /docs.*●/);
    assert.match(text, /● always on \(1\): codemode/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("show reports whether a skill is always on", async () => {
  const root = home();
  try {
    await run(root, ["codemode"], ["pin", "codemode"]);
    const on = await run(root, ["codemode"], ["show", "codemode"]);
    assert.match(on.printed.out.join("\n"), /always on: yes/);

    await run(root, ["codemode"], ["unpin", "codemode"]);
    const off = await run(root, ["codemode"], ["show", "codemode"]);
    assert.match(off.printed.out.join("\n"), /always on: no/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pinning keeps the other settings the user has", async () => {
  /*
   * The settings file holds permission mode, model routing, model profiles and
   * more. A pin write that rebuilt the document instead of merging into it
   * would silently discard all of that, and the damage would not surface until
   * the next turn ran with the wrong permissions.
   */
  const root = home();
  try {
    mkdirSync(path.join(root, ".reaper"), { recursive: true });
    writeFileSync(
      path.join(root, ".reaper", "settings.json"),
      JSON.stringify({
        runtimeTunables: { permissionMode: "strict", pinnedSkills: [], printReasoning: true },
        modelRouting: { mainAgent: "default_model" },
      }),
    );

    const { result } = await run(root, ["codemode"], ["pin", "codemode"]);
    assert.equal(result.ok, true, result.output);

    const body = settingsBody(root);
    assert.equal((body.runtimeTunables as Record<string, unknown>).permissionMode, "strict");
    // A sibling tunable, not just the sibling section — the merge is per-field
    // inside `runtimeTunables` too, and that is where a careless spread of the
    // patch's own object rather than the file's would show up.
    assert.equal((body.runtimeTunables as Record<string, unknown>).printReasoning, true);
    assert.deepEqual(body.modelRouting, { mainAgent: "default_model" });
    assert.deepEqual((body.runtimeTunables as Record<string, unknown>).pinnedSkills, ["codemode"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a settings file this build does not understand is left untouched, loudly", async () => {
  /*
   * `ReaperConfigSchema` is `.strict()` everywhere, so a key from a newer
   * Reaper (or a typo) makes the merged document invalid. The write must then
   * refuse and report, not drop the key quietly — silently rewriting someone's
   * config to a shape they did not ask for is the one outcome that is worse
   * than failing.
   *
   * The pin write goes through the same validation as every other settings
   * write, which is the point: pinning cannot be the back door that degrades
   * the file.
   */
  const root = home();
  try {
    mkdirSync(path.join(root, ".reaper"), { recursive: true });
    const original = JSON.stringify({
      runtimeTunables: { pinnedSkills: [] },
      somethingThisBuildDoesNotKnow: { keep: "me" },
    });
    writeFileSync(path.join(root, ".reaper", "settings.json"), original);

    const { result } = await run(root, ["codemode"], ["pin", "codemode"]);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /write failed/);
    // The specific key is named, so the user can go and look at it. "Refusing
    // to write an invalid config" alone would be true and useless.
    assert.match(result.output, /nrecognized key/);
    assert.match(result.output, /somethingThisBuildDoesNotKnow/);
    assert.equal(readFileSync(path.join(root, ".reaper", "settings.json"), "utf8"), original,
      "a refused write must leave the file byte-for-byte as it was");
    assert.deepEqual(readPinnedSkills(root), [], "and must not have pinned anything");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pin list written by the CLI reads back through the browser's path unchanged", async () => {
  /*
   * The divergence guard. `readSettings` is what the Settings screen renders;
   * `readPinnedSkills` is what the turn actually injects. They must agree about
   * the same file, or the UI would show a pin that never loads.
   */
  const root = home();
  try {
    await run(root, ["alpha", "beta"], ["pin", "alpha"]);
    await run(root, ["alpha", "beta"], ["pin", "beta"]);

    const { readSettings } = await import("../../src/app-server/settings-surface.js");
    const viewed = readSettings(root, { home: root });
    assert.deepEqual(viewed.pinnedSkills, readPinnedSkills(root));
    assert.deepEqual(viewed.pinnedSkills, ["alpha", "beta"]);

    // And a browser-style write is what the CLI then sees.
    updateUserSettings(root, (before) => ({
      ...before,
      runtimeTunables: { ...(before.runtimeTunables as object), pinnedSkills: ["beta"] },
    }));
    assert.deepEqual(readPinnedSkills(root), ["beta"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/*
 * `/skills disable` and `/skills enable`.
 *
 * These live in the pin suite because they are the same command writing the
 * same file, and the failure they share is the reason this suite exists: two
 * entrypoints that both claim to manage skills, disagreeing about where the
 * state lives. `disable` used to write a marker file beside the skill's own
 * manifest — for a built-in, the shipped source tree or a regenerated temp
 * directory — while the CLI's `skill disable` wrote settings. The commands
 * below must leave the settings file as the only record.
 */
test("/skills disable writes the settings list and leaves the skill alone", async (t) => {
  const dir = home();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { printed, result } = await run(dir, ["codemode", "release"], ["disable", "codemode"]);

  assert.equal(result.ok, true);
  assert.deepEqual(readDisabledSkills(dir), ["codemode"]);
  assert.ok(printed.out.some((line) => line.includes('disabled "codemode"')));

  // The skill folder is not the command's to write, and nothing here touched
  // one — asserted by the fact that the only file created is the settings file.
  const written = readdirSync(path.join(dir, ".reaper"));
  assert.deepEqual(written, ["settings.json"]);
});

test("/skills disable refuses a name that is not installed", async (t) => {
  const dir = home();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { result } = await run(dir, ["codemode"], ["disable", "typo"]);

  /*
   * Validated before writing, unlike a stale *reference* on the read path. The
   * asymmetry is deliberate: `skill disable typo` must fail loudly, because the
   * user is asking for something that will never happen; a settings entry that
   * later goes stale must not break a turn, because by then nobody is watching.
   */
  assert.equal(result.ok, false);
  assert.deepEqual(readDisabledSkills(dir), []);
});

test("/skills enable clears the name and reports the count", async (t) => {
  const dir = home();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  updateUserSettings(dir, (before) => ({
    ...before,
    runtimeTunables: { ...((before.runtimeTunables as Record<string, unknown> | undefined) ?? {}), disabledSkills: ["codemode", "release"] },
  }));

  const { result } = await run(dir, ["codemode", "release"], ["enable", "codemode"]);

  assert.equal(result.ok, true);
  assert.deepEqual(readDisabledSkills(dir), ["release"], "only the named skill is cleared");
});

test("disabling a skill does not disturb the pins in the same file", async (t) => {
  const dir = home();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  /*
   * Both lists live in `runtimeTunables`. A mutator that rebuilt that object
   * from its own field would delete the other list, and the two are edited from
   * different screens — one in the terminal, one in the browser — so the loss
   * would show up long after the command that caused it.
   */
  await run(dir, ["codemode", "release"], ["pin", "release"]);
  assert.deepEqual(readPinnedSkills(dir), ["release"]);

  await run(dir, ["codemode", "release"], ["disable", "codemode"]);
  assert.deepEqual(readPinnedSkills(dir), ["release"], "the pin must survive a disable");
  assert.deepEqual(readDisabledSkills(dir), ["codemode"]);

  await run(dir, ["codemode", "release"], ["enable", "codemode"]);
  assert.deepEqual(readPinnedSkills(dir), ["release"]);
  assert.deepEqual(readDisabledSkills(dir), []);
});
