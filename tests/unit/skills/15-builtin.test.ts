import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { builtinSkillsRoot } from "../../../src/skills/built-in/index.js";
import { activationSkillDirs } from "../../../src/tools/read/activate-skill.js";

const BUILTIN = builtinSkillsRoot();

test("the packaged built-in skills are exactly the ones the product intends to ship", () => {
  const packaged = readdirSync(BUILTIN, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  /*
   * A written-down list rather than `[]`.
   *
   * The product shipped no built-in bodies for a while and this asserted the
   * empty directory, which meant any packaged skill failed a test rather than
   * being reviewed. What the test is actually for is noticing that the shipped
   * set *changed* — a skill added to the bundle is a change to what every user
   * carries — so it names the set and fails when it drifts in either direction.
   */
  assert.deepEqual(packaged, ["browser", "codemode", "extension-authoring", "skill-authoring"]);
});

test("activation searches project, user, then optional built-in roots", () => {
  const workspace = "/tmp/reaper-skill-workspace";
  const home = "/tmp/reaper-skill-home";
  assert.deepEqual(activationSkillDirs(workspace, home), [
    join(workspace, ".reaper", "skills"),
    join(home, ".reaper", "skills"),
    BUILTIN,
  ]);
});
