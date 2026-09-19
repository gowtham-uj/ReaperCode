/**
 * Skills reach the model, both the menu and the always-on bodies.
 *
 * Two bugs, same shape, found by a subagent auditing a reported symptom: the
 * model "discovered the browser skill on its own" even though it was pinned
 * always-on.
 *
 *   1. The catalogue. `formatSkillsForPrompt` builds the name-and-description
 *      list a model needs to know which skills exist, and its only consumer was
 *      `renderContextCockpit`, reachable from `insertCockpitIntoConversation`,
 *      which has no callers and returns early unless an environment flag is set.
 *      So the model was never told any skill existed, and reached the browser
 *      skill by finding `src/skills/built-in/browser/SKILL.md` while exploring.
 *
 *   2. The pinned bodies. `resolvePinnedSkills` read each body off disk every run
 *      and handed it to the same dead renderer. `pinnedSkills` was a real,
 *      correctly-stored user setting with no effect: the machine pins `browser`
 *      and `codemode`, and neither reached a request.
 *
 * Both now go into the system prompt, which is the one document every turn
 * carries. These tests assert the delivery rather than the computation, because
 * the computation was already correct and already tested — that is exactly how
 * this shipped broken.
 */
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

import { packagedSkills } from "../../../src/context/packaged-skills.js";
import { discoverSkills, formatSkillsForPrompt } from "../../../src/context/skills.js";
import { readPinnedSkills, resolvePinnedSkills } from "../../../src/context/pinned-skills.js";

test("the catalogue names every packaged skill with its description", () => {
  /*
   * The menu. A skill absent from here is a skill the model cannot know to load,
   * however well it is written.
   */
  const available = [...packagedSkills(), ...discoverSkills(process.cwd())];
  const catalogue = formatSkillsForPrompt(available, "", available.length);

  for (const skill of available) {
    assert.match(catalogue, new RegExp(`<name>${skill.name}</name>`), `${skill.name} must be listed`);
  }
  assert.match(catalogue, /<description>/, "and each entry must carry its description, which is what routes a task to it");
  assert.match(catalogue, /activate_skill/, "and say how to load one");
});

test("the catalogue names the built-in skills, so the browser one is discoverable", () => {
  /*
   * The specific failure. `browser` and `codemode` ship with the product and are
   * the two every run is most likely to need; a model that has to find them on
   * disk is a model that has already wasted the turn they were meant to save.
   */
  const catalogue = formatSkillsForPrompt(packagedSkills(), "", 100);
  for (const name of ["browser", "codemode"]) {
    assert.match(catalogue, new RegExp(`<name>${name}</name>`), `${name} must be named in the prompt`);
  }
});

test("a pinned skill resolves to its body, not just its name", () => {
  /*
   * The always-on half. The pin resolves to text that is supposed to be in the
   * prompt, and an empty body would deliver a heading with nothing under it,
   * which reads to a model as a skill that exists and has no content.
   */
  const available = [...packagedSkills(), ...discoverSkills(process.cwd())];
  const pinned = resolvePinnedSkills(readPinnedSkills(process.env["HOME"] ?? ""), available);
  for (const skill of pinned) {
    assert.ok(skill.body.length > 100, `${skill.name} must resolve to a real body, got ${skill.body.length} chars`);
  }
});

test("a skill marked model-invocation-disabled is never delivered automatically", () => {
  /*
   * The one thing pinning must not override. A skill that says it should not be
   * loaded by a model is authoritative about that, and a pin is a user preference
   * rather than a licence to contradict it.
   */
  const disabled = { name: "secret", description: "x", filePath: "/dev/null", disableModelInvocation: true };
  const resolved = resolvePinnedSkills(["secret"], [disabled as never]);
  assert.deepEqual(resolved, [], "a pin must not override disableModelInvocation");
});

test("the contract: metadata for every skill, bodies only for pinned ones", async () => {
  /*
   * The delivery rule, stated as one assertion so a future change cannot quietly
   * invert it.
   *
   *   - The system prompt carries the NAME AND DESCRIPTION of every skill this
   *     run may load. That is what tells a model the skill exists, and without it
   *     the only route is guessing a name for `activate_skill` or finding the file
   *     on disk, which is what a live mission did.
   *   - A PINNED skill also carries its BODY, because pinning means "always
   *     loaded". This is why the model could quote the browser skill's own
   *     wording without ever calling `activate_skill`.
   *   - An unpinned skill carries only its metadata; its body arrives through
   *     `activate_skill` when the task matches.
   *
   * The test is written against the two blocks the engine composes, so it fails
   * if the catalogue loses a skill or a body leaks into it.
   */
  const engine = await readFile(new URL("../../../src/runtime/engine.ts", import.meta.url), "utf8");

  // The catalogue is built from every available skill, with an empty query so it
  // is stable rather than turn-dependent.
  assert.match(engine, /formatSkillsForPrompt\(available, "", available\.length\)/,
    "the catalogue must list every skill, not a ranked subset that changes each turn");

  // The bodies come only from the pins.
  assert.match(engine, /resolvePinnedSkills\(readPinnedSkills/, "bodies come from the user's pins");
  assert.match(engine, /# Always-on skills/, "and are labelled as always-on");
  assert.match(engine, /# Available skills/, "while the metadata list is labelled as available, not loaded");

  /*
   * And the split is real: the catalogue call does not read bodies, and the pin
   * resolver is the only thing that does. If a body were included in the
   * catalogue, every skill's full text would ship on every request.
   */
  const catalogueCall = engine.slice(engine.indexOf("private skillCatalogue"), engine.indexOf("private pinnedSkillBlocks"));
  assert.doesNotMatch(catalogueCall, /readSkillBody|\.body/, "the catalogue must not carry skill bodies");
});
