/**
 * The collector against the fixture site, layer by layer.
 *
 * The point of this file is the shape of its failures. When something breaks,
 * it must say which layer lost the element, not just that an element is
 * missing. So every page is asserted three times, in order:
 *
 *   collector   did the browser read the element at all
 *   IR          did the compiler keep it
 *   addressable does an element with a usable locator exist for it
 *
 * A failure on the first line means the collector is wrong. A failure on the
 * second means the compiler dropped something the collector found, which is a
 * different bug in a different file. Without that split, every failure looks
 * like "the model cannot see the button" and the search starts from nothing.
 *
 * Skipped rather than failed when Steel is not up, because a machine without a
 * browser should still be able to run the suite. The skip says so out loud.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { chromium, type Browser } from "playwright";

import { startTortureSite, TORTURE_PAGES, type RunningTortureSite } from "../fixtures/torture-site.js";
import { probeBrowser, skipUnless } from "../fixtures/browser-availability.js";
import { collectPage, type CollectedPage } from "../../src/browser/collect.js";
import { compileCollected } from "../../src/browser/ir-tree.js";
import type { BrowserIR } from "../../src/browser/ir.js";

/** Where Steel's Chrome listens. Overridable so the suite is not machine-bound. */
const CDP_URL = process.env["REAPER_CDP_URL"] ?? "http://127.0.0.1:9222";

/** Whether a browser is reachable, checked once so every case can skip together. */
async function connect(): Promise<Browser | undefined> {
  try {
    return await chromium.connectOverCDP(CDP_URL, { timeout: 5_000 });
  } catch {
    return undefined;
  }
}

const availability = await probeBrowser(CDP_URL);
const skipReason = skipUnless(availability);
const browser = availability.available ? await connect() : undefined;
const site: RunningTortureSite | undefined = browser ? await startTortureSite() : undefined;

/**
 * One page, read once, so the three assertions share a single reading.
 *
 * Reading three times would let the collector be inconsistent between
 * assertions, and a page read twice is a different page.
 */
async function read(path: string): Promise<{ collected: CollectedPage; ir: BrowserIR } | undefined> {
  if (!browser || !site) return undefined;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${site.origin}${path}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    // The late-content fixture needs a moment; nothing else cares.
    await page.waitForTimeout(900);
    const collected = await collectPage(page);
    return { collected, ir: compileCollected(collected) };
  } finally {
    await context.close();
  }
}

/** The element ids the compiler produced for one collected element. */
function irHasElement(ir: BrowserIR, selectorId: string): boolean {
  for (const element of ir.elements.values()) {
    if (element.id === selectorId) return true;
  }
  return false;
}

test("the fixture site serves every page it declares", { skip: !site && "Steel is not running, so the fixture was not started" }, async () => {
  assert.ok(site);
  for (const fixture of TORTURE_PAGES) {
    const response: Response = await fetch(`${site.origin}${fixture.path}`);
    assert.equal(response.status, 200, `${fixture.path} should be served`);
    const body = await response.text();
    for (const selector of fixture.expectPresent) {
      /*
       * The selector's own id or name, checked in the raw HTML, so a fixture
       * that is malformed fails here rather than as a mysterious collector
       * problem three assertions later.
       */
      const token = /^#([\w-]+)$/.exec(selector)?.[1];
      if (token) assert.match(body, new RegExp(`id="${token}"`), `${fixture.path} should contain ${selector}`);
    }
  }
});

test("every fixture page compiles to something the model could act on", { skip: skipReason }, async () => {
  assert.ok(site, "the site is up whenever the browser is");
  for (const fixture of TORTURE_PAGES) {
    const reading = await read(fixture.path);
    assert.ok(reading, `${fixture.path} should be readable`);
    const { collected, ir } = reading;

    /*
     * The three-layer report. `counts.rawNodes` is the browser's own number, so
     * a page that produced no candidates with a non-trivial DOM is a read
     * failure and not an empty page, and saying which one it is here is the
     * whole reason this test exists in this shape.
     */
    const detail =
      `${fixture.path}: ${fixture.why}\n` +
      `  collector: raw=${collected.counts.rawNodes} ax=${collected.counts.axNodes} candidates=${collected.counts.candidates} visible=${collected.counts.visible}\n` +
      `  IR:        sections=${ir.sections.length} elements=${ir.elements.size} complete=${ir.coverage.complete}` +
      (ir.coverage.incompleteBecause ? ` (${ir.coverage.incompleteBecause})` : "");

    assert.ok(collected.counts.rawNodes > 0, `the browser should have seen markup\n${detail}`);
    assert.ok(
      collected.counts.candidates > 0,
      `the collector found no candidates on a page with content, so the DOM was not read\n${detail}`,
    );
    assert.ok(ir.coverage.complete, `the read should not report itself incomplete\n${detail}`);
  }
});

test("an element the collector found is still there in the IR", { skip: skipReason }, async () => {
  /*
   * The layer boundary that matters most, because the compiler is where a
   * correct collection most easily becomes a wrong view: a section rule that
   * swallows a region, or an interactivity rule that drops a control, loses the
   * element without the collector ever being at fault.
   */
  const reading = await read("/basic");
  assert.ok(reading);
  const { collected, ir } = reading;

  assert.ok(collected.elements.length > 0, "the basic form should produce candidates");
  /*
   * The collector's interactive set and the IR's element set must overlap. Not
   * equal: the IR keeps textual nodes the collector does not call candidates,
   * and drops nothing the collector flagged. Overlap non-empty is the property
   * that breaks when a section rule swallows a region.
   */
  const collectedNames = new Set(collected.elements.map((element) => element.accessibleName).filter((name) => name.length > 0));
  const irNames = new Set([...ir.elements.values()].filter((element) => element.hidden !== true).map((element) => element.name));
  const shared = [...irNames].filter((name) => collectedNames.has(name));
  assert.ok(
    shared.length > 0,
    `the IR must contain elements the collector found. collector=${[...collectedNames].slice(0, 8).join(", ")} ir=${[...irNames].slice(0, 8).join(", ")}`,
  );
  // Every section the IR produced must reference elements it actually holds.
  for (const section of ir.sections) {
    for (const elementId of section.elements) {
      assert.ok(ir.elements.has(elementId), `section ${section.id} references ${elementId}, which is not in the IR`);
    }
  }
  assert.ok(ir.sections.length > 0, "a form page should compile to at least one section");
});

test("buttons and inputs are addressable, not just present", { skip: skipReason }, async () => {
  /*
   * Present-but-unaddressable is its own failure and a nastier one: the model
   * can see the button, writes a locator for it, and the locator matches
   * nothing or everything. Asserting a non-empty locator list catches the
   * second half of the job, which presence checks never do.
   */
  const reading = await read("/basic");
  assert.ok(reading);
  const roleByName = new Map<string, { locators: number }>();
  for (const element of reading.ir.elements.values()) {
    if (element.hidden === true) continue;
    if (element.role !== "button" && element.role !== "textbox" && element.role !== "combobox" && element.role !== "checkbox") continue;
    roleByName.set(`${element.role}:${element.name}`, { locators: element.locators.length });
  }

  assert.ok(roleByName.size > 0, "the basic form must produce actionable controls");
  for (const [key, value] of roleByName) {
    assert.ok(value.locators > 0, `${key} has no locator, so the model could see it and not address it`);
  }
});

test("a hidden field is reported and is not offered as a target", { skip: skipReason }, async () => {
  /*
   * Both halves of the rule, and the second is the one that gets forgotten. The
   * model must know the field exists, because it is usually load-bearing state,
   * and must not be handed a locator for it, because clicking it is not a thing
   * that can happen.
   */
  const reading = await read("/hidden");
  assert.ok(reading);
  const hidden = [...reading.ir.elements.values()].filter((element) => element.hidden === true);
  assert.ok(hidden.length > 0, "the page has a hidden input and the IR must say so");
  for (const element of hidden) {
    assert.equal(element.locators.length, 0, `${element.id} is hidden and must not be given a locator`);
    assert.ok(element.hiddenBecause !== undefined, `${element.id} must say why it is hidden`);
  }
});

test("the late-content page is read after its content arrives", { skip: skipReason }, async () => {
  // The settle case, in its smallest form: the button does not exist at
  // domcontentloaded and does exist 700ms later.
  const reading = await read("/slow");
  assert.ok(reading);
  const arrived = [...reading.collected.elements].some((element) => element.accessibleName === "Arrived" || element.id === "late-btn");
  assert.ok(arrived, "a control that appeared after load must be in the read");
});

test.after(async () => {
  await site?.close();
  await browser?.close();
});
