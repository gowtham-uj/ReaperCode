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
  assert.match(skill, /capabilities\(\)/, "and the capability query");
  assert.match(skill, /## Downloads and uploads/, "and have a section for the vault");
});

test("the skill says to stop rather than debug the browser", async () => {
  // The mission turned itself into a Playwright debugger for thirty traces. The
  // rule that prevents it has to be written down somewhere the model reads.
  const skill = await readFile(SKILL_PATH, "utf8");
  assert.match(skill, /Do not spend many steps proving a page is broken|Spending twenty steps proving a page is broken/, "the stop rule must be stated");
});
