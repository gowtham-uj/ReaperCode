/**
 * The docs and the surface agree.
 *
 * A fix a model does not know about is a fix it does not use, and the failure
 * mode here is silent: the control works, the model never calls it, and the
 * expensive behaviour it was meant to prevent comes back. Three separate
 * behaviours landed in one batch (a program that answers itself gets no page,
 * `recover()` for a page that stopped taking input, downloads through the vault)
 * and each of them is only useful if it is named where the model looks.
 *
 * So this pins the names in both places the model reads: the tool description,
 * which is sent every turn, and the browser skill, which is loaded when the
 * model is actually browsing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { BROWSER_USE_DESCRIPTION } from "../../../src/tools/browser/browser-use.js";

const SKILL_PATH = new URL("../../../src/skills/built-in/browser/SKILL.md", import.meta.url);

test("the tool description names the recovery control and the download calls", () => {
  assert.match(BROWSER_USE_DESCRIPTION, /recover\(target\?\)/, "recover() must be named, or a stuck model will not know it exists");
  assert.match(BROWSER_USE_DESCRIPTION, /downloadAfter/, "the one-call download must be named");
  assert.match(BROWSER_USE_DESCRIPTION, /setInputFiles\(file\.path\)/, "and how to upload what the vault holds");
  assert.match(BROWSER_USE_DESCRIPTION, /capabilities\(\)/, "and the capability query");
  assert.match(BROWSER_USE_DESCRIPTION, /probeInput\(/, "and the input probe, so a dead page is one call to diagnose");
});

test("the tool description names the transactional surface", () => {
  /*
   * The same rule as the test above, applied to the calls added later.
   *
   * A model does not reach for a call it has not heard of, and every one of
   * these replaces work the measured mission did by hand and badly: deciding
   * whether an element could be clicked, reading a form's constraints, waiting a
   * fixed number of seconds, catching a download, opening a popup. The cost of
   * not naming them is not that the tool is broken; it is that the expensive
   * behaviour they were written to prevent comes straight back.
   */
  assert.match(BROWSER_USE_DESCRIPTION, /tx\(\{name\}/, "tx() must be named, or the receipt shape is never used");
  assert.match(BROWSER_USE_DESCRIPTION, /inspect\(target\)/, "inspect() is the zero-area fix and must be named");
  assert.match(BROWSER_USE_DESCRIPTION, /inspectForm\(\)/, "and the form reader");
  assert.match(BROWSER_USE_DESCRIPTION, /waitForChange\(\{/, "and the replacement for a fixed sleep");
  assert.match(BROWSER_USE_DESCRIPTION, /download\(\{trigger\}\)/, "and the arm-before-trigger download");
  assert.match(BROWSER_USE_DESCRIPTION, /expectPopup\(page, trigger\)/, "and the popup with provenance");
  assert.match(BROWSER_USE_DESCRIPTION, /state\.fact\(/, "and the mission memory");
});

test("every control the description names is one the sandbox actually binds", async () => {
  /*
   * The check the surface-binding test does for `BROWSER_PROGRAM_PARAMS`, done
   * for the prose.
   *
   * The three lists that can drift are the tool description, the sandbox's
   * returned object, and the host's dispatch. `recover`, `probeInput` and
   * `capabilities` each drifted in all three at once and the model got
   * "recover is not defined" for a call the description told it to make. The
   * other test compares the list against the surface; this one compares the
   * *description* against the surface, which is the half a reader would assume
   * was covered and was not.
   */
  const sandbox = await readFile(new URL("../../../src/browser/remote-page-source.ts", import.meta.url), "utf8");
  const listed = new Set(
    [...sandbox.slice(sandbox.indexOf("BROWSER_PROGRAM_PARAMS")).matchAll(/"(\w+)"/g)].map((match) => match[1]!),
  );
  /*
   * The helpers the description names by call form. Playwright's own methods
   * (`setInputFiles`, `getByRole`, `evaluate`) are deliberately not in the list:
   * they come from the page, not from this surface.
   */
  const named = [
    "tx", "inspect", "inspectForm", "waitForChange", "download", "downloadAfter",
    "expectPopup", "state", "metrics", "capabilities", "probeInput", "recover",
  ];
  for (const name of named) {
    assert.ok(
      listed.has(name),
      `the description names ${name}() but the sandbox does not bind it, so a model that follows the documentation gets "not defined"`,
    );
  }
});

test("the tool description says a returned value suppresses the page", () => {
  // The single biggest token cost was the page being appended after a program
  // that had already answered. A model that does not know this will ask for the
  // whole tree on every step to be safe.
  assert.match(BROWSER_USE_DESCRIPTION, /does not also get the page/, "the suppression rule must be stated");
  assert.match(BROWSER_USE_DESCRIPTION, /observe: "full"/, "and how to ask for it anyway");
});

test("the skill documents the same controls", async () => {
  const skill = await readFile(SKILL_PATH, "utf8");
  assert.match(skill, /`recover\(\)`/, "the skill must document recover()");
  assert.match(skill, /downloadAfter/, "and the download path");
  /*
   * The stop rule for a download, which is what a twenty-minute failure needed.
   *
   * The model's own workarounds were all reasonable in isolation and all futile,
   * because the failure was in the tool and not in the page. Naming them is what
   * turns "try harder" into "report it", and it has to be in the skill because
   * that is what the model reads while it is browsing.
   */
  assert.match(skill, /stop and report it/i, "the skill must say to stop rather than work around a download failure");
  assert.match(skill, /waitForEvent/, "and name the workarounds that do not help");
  assert.match(skill, /capabilities\(\)/, "and the capability query");
  assert.match(skill, /## Downloads and uploads/, "and have a section for the vault");
});

test("the skill says to stop rather than debug the browser", async () => {
  // The mission turned itself into a Playwright debugger for thirty traces. The
  // rule that prevents it has to be written down somewhere the model reads.
  const skill = await readFile(SKILL_PATH, "utf8");
  assert.match(skill, /Do not spend many steps proving a page is broken|Spending twenty steps proving a page is broken/, "the stop rule must be stated");
});
