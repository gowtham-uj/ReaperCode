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
