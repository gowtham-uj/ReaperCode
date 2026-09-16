/**
 * What the model reads, and the one rule that must never break.
 *
 * `renderModelView` is the last step before a page reaches the model, so its
 * failure modes are the expensive ones. The rule the whole file is built on is
 * that relevance decides *detail* and never *existence*: a section nobody is
 * looking at becomes one line, and it never becomes nothing. A model cannot ask
 * about a region it does not know exists, so a view that silently omits part of
 * a page is a view that makes the model confidently wrong.
 *
 * The second rule is about which sections get opened. The first version opened
 * exactly one, chosen by relevance, falling back to the largest. On a form page
 * that opened the *navigation*, because twelve nav links outweigh six form
 * fields by element count, and the model then read a view whose only named
 * elements were menu items on a page whose entire purpose was a button labelled
 * Continue. The budget decides now: sections open in priority order while there
 * is room, and shape beats size.
 *
 * These run without a browser. The IR is a plain object, which is the point of
 * the three-layer split: the renderer takes compiled data and touches nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { renderModelView, MODEL_VIEW_MAX_CHARS, MAX_ROWS_SHOWN } from "../../../src/browser/model-view.js";
import type { BrowserIR, IrElement, IrSection } from "../../../src/browser/ir.js";

function element(id: string, section: string, role: string, name: string, extra: Partial<IrElement> = {}): IrElement {
  return { id, role, name, states: [], section, locators: [{ expression: `getByRole("${role}",{name:"${name}"})`, strategy: "role+name", by: { kind: "role", role, name }, score: 1, verified: false }], ...extra };
}

function section(id: string, kind: IrSection["kind"], label: string, elements: IrElement[], extra: Partial<IrSection> = {}): IrSection {
  return { id, kind, label, summary: "", elements: elements.map((e) => e.id), fingerprint: `${kind}:${label}`, ...extra };
}

function ir(sections: IrSection[], elements: IrElement[], coverage: Partial<BrowserIR["coverage"]> = {}): BrowserIR {
  return {
    url: "https://example.test/page",
    title: "A page",
    revision: 3,
    sections,
    elements: new Map(elements.map((e) => [e.id, e])),
    order: sections.map((s) => s.id),
    coverage: {
      counts: { rawNodes: 100, axNodes: 40, candidates: 20, visible: 20, listenerProbed: 0 },
      frames: { total: 1, read: 1 },
      complete: true,
      ...coverage,
    },
  };
}

test("a section nobody is looking at is one line, never nothing", () => {
  /*
   * The load-bearing rule. Three sections, one relevant to the step, and the
   * other two must still be present by name. This is the assertion that would
   * catch a future "compression" that drops low-relevance sections entirely,
   * which is the most natural-looking way to make the view smaller and the one
   * that makes the model wrong rather than merely terse.
   */
  const form = section("s1", "form", "Application", [element("e1", "s1", "textbox", "Email")]);
  const nav = section("s2", "navigation", "Main", [element("e2", "s2", "link", "Jobs"), element("e3", "s2", "link", "About")]);
  const footer = section("s3", "footer", "Footer", [element("e4", "s3", "link", "Privacy")]);

  const view = renderModelView(ir([form, nav, footer], [element("e1", "s1", "textbox", "Email"), element("e2", "s2", "link", "Jobs"), element("e3", "s2", "link", "About"), element("e4", "s3", "link", "Privacy")]), {
    context: { step: "fill the application" },
  });

  for (const label of ["Application", "Main", "Footer"]) {
    assert.match(view.text, new RegExp(label), `${label} must appear in the view`);
  }
});

test("a section is never removed, even when the budget cuts the view", () => {
  /*
   * Truncation is where "never hide existence" is easiest to violate by
   * accident: trim the tail and the sections at the end are simply gone. The
   * budget is small enough here that the trim genuinely fires, and every section
   * still has to be accounted for by name somewhere in the output.
   *
   * The fixture is sized from a measurement rather than a guess: twelve sections
   * at 300 characters fit with room to spare, so the budget has to be under that
   * for the trim to happen at all. An earlier version of this used 320, did not
   * exceed the budget, and asserted `truncated` on a view that was not.
   */
  const sections: IrSection[] = [];
  const elements: IrElement[] = [];
  for (let i = 0; i < 12; i++) {
    const id = `s${i + 1}`;
    const el = element(`e${i + 1}`, id, "link", `Item ${i + 1}`);
    sections.push(section(id, "list", `Region ${i + 1}`, [el]));
    elements.push(el);
  }

  const view = renderModelView(ir(sections, elements), { maxChars: 240 });

  assert.equal(view.truncated, true, "the fixture must actually exceed the budget, or this proves nothing");
  for (const s of sections) {
    assert.match(view.text, new RegExp(s.label), `${s.label} must not vanish when the budget is cut`);
  }
});

test("sections print in document order, not id order", () => {
  /*
   * The tiebreak bug. With priority tied, an id comparison printed `s10` before
   * `s2`, so a twelve-region page read as s1, s10, s11, s12, s2, s3. That is an
   * order the page does not have, and one that disagrees with the document order
   * the compiler assigned ids from.
   */
  const sections: IrSection[] = [];
  const elements: IrElement[] = [];
  for (let i = 0; i < 12; i++) {
    const id = `s${i + 1}`;
    const el = element(`e${i + 1}`, id, "button", `Action ${i + 1}`);
    sections.push(section(id, "form", `Region ${i + 1}`, [el]));
    elements.push(el);
  }

  const view = renderModelView(ir(sections, elements), { maxChars: 240 });
  const positions = sections.map((s) => view.text.indexOf(s.label));

  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i]! > positions[i - 1]!, `Region ${i + 1} must print after Region ${i}`);
  }
});

test("the budget decides which sections open, not size alone", () => {
  /*
   * The form/nav inversion. The nav is bigger by element count, the form is what
   * the page is for, and the form is what must open. This is the bug the first
   * version had: it picked the largest section and opened the navigation.
   */
  const formElements = [element("e1", "s1", "textbox", "Email"), element("e2", "s1", "button", "Apply")];
  const navElements = Array.from({ length: 12 }, (_, i) => element(`n${i}`, "s2", "link", `Nav ${i}`));

  const view = renderModelView(ir([
    section("s1", "form", "Application", formElements),
    section("s2", "navigation", "Main", navElements),
  ], [...formElements, ...navElements]));

  // The form opens, so its named control appears; the nav stays collapsed.
  assert.match(view.text, /Email/, "the form's field must be visible in the default view");
  assert.ok(view.expanded.includes("s1"), `the form should be expanded, got ${view.expanded.join(",")}`);
});

test("a small page shows everything it has", () => {
  /*
   * The other half of the budget rule. Opening one section was not only wrong
   * for priority, it wasted the budget: a page with three small sections fits
   * well inside 3,000 characters and the model should see all of them rather
   * than one open section and two summary lines.
   */
  const sections: IrSection[] = [];
  const elements: IrElement[] = [];
  for (let i = 0; i < 3; i++) {
    const id = `s${i + 1}`;
    const el = element(`e${i + 1}`, id, "button", `Action ${i + 1}`);
    sections.push(section(id, "form", `Form ${i + 1}`, [el]));
    elements.push(el);
  }

  const view = renderModelView(ir(sections, elements));

  for (const s of sections) {
    assert.ok(view.expanded.includes(s.id), `${s.label} should be open on a page this small`);
  }
});

test("a list prints its rows, and says how many it did not print", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: `s1:r${i + 1}`,
    label: `Story ${i + 1}`,
    elements: [`e${i + 1}`],
  }));
  const elements = rows.map((row, i) => element(`e${i + 1}`, "s1", "link", `Story ${i + 1}`));
  const list = section("s1", "results", "Results (30)", elements, { items: rows });

  const view = renderModelView(ir([list], elements));

  assert.match(view.text, /30 rows/, "the section says how big it is");
  assert.match(view.text, /s1:r1/, "rows are addressable");
  assert.match(view.text, new RegExp(`s1:r${MAX_ROWS_SHOWN}\\b`), "the last shown row is addressable");
  /*
   * The cap has to be stated with the number left over. A silently truncated
   * list reads as a list that ends there, which is the coverage failure in
   * miniature.
   */
  assert.match(view.text, new RegExp(`${30 - MAX_ROWS_SHOWN} more`), "the remainder is counted, not hidden");
  assert.match(view.text, /s1:r/, "and it says how to reach a later row");
});

test("prose is printed, because a page's answer is often a sentence", () => {
  /*
   * The gap that made a form's result invisible. The compiled view described
   * every control and none of the text, so a page that answered "Invalid
   * password" compiled to a view that said nothing had happened.
   */
  const s = section("s1", "form", "Login", [element("e1", "s1", "textbox", "Password")], { prose: ["Invalid password", "Try again"] });
  const view = renderModelView(ir([s], [element("e1", "s1", "textbox", "Password")]));

  assert.match(view.text, /Invalid password/);
  assert.match(view.text, /Try again/);
});

test("a collapsed section still says it holds text", () => {
  // A section that only offers controls and one that also says something are
  // different propositions, and the model should be able to tell without opening
  // either.
  const withText = section("s1", "main", "Main", [], { prose: ["Something happened"] });
  const view = renderModelView(ir([withText], []));
  assert.match(view.text, /text/, "the collapsed line mentions its text");
});

test("coverage goes in the header, above the content, when it is incomplete", () => {
  /*
   * Position is the assertion. A model that reads only the top of a trimmed view
   * must still learn the view is not whole; a caveat at the bottom is a caveat
   * nobody reads.
   */
  const s = section("s1", "form", "Application", [element("e1", "s1", "textbox", "Email")]);
  const view = renderModelView(
    ir([s], [element("e1", "s1", "textbox", "Email")], { complete: false, incompleteBecause: "1 of 2 frames could not be read" }),
  );

  const coverageAt = view.text.indexOf("COVERAGE INCOMPLETE");
  const sectionAt = view.text.indexOf("s1 ");
  assert.ok(coverageAt >= 0, "the caveat must be present");
  assert.ok(coverageAt < sectionAt, "the caveat must come before the content it qualifies");
});

test("the view never emits its own revision or URL header", () => {
  /*
   * The observation header already carries those, and emitting them twice is not
   * a cosmetic defect: it doubles the cost of the one fact every look must
   * include, and a model reading two revisions has to work out which one the
   * diff is against.
   */
  const s = section("s1", "form", "Application", [element("e1", "s1", "textbox", "Email")]);
  const view = renderModelView(ir([s], [element("e1", "s1", "textbox", "Email")]));

  assert.doesNotMatch(view.text, /^REV \d+/m, "the renderer must not print a revision");
  assert.doesNotMatch(view.text, /^URL: /m, "the renderer must not print a URL header");
});

test("the budget is respected when a section is too big to open", () => {
  /*
   * A section that cannot fit does not get opened, and that is the mechanism
   * that keeps the budget: the view stays small because the detail was never
   * rendered, not because it was rendered and then cut. Worth asserting both
   * halves, because the cheap-looking alternative (open everything, then trim)
   * produces a view whose tail is missing rather than one whose detail is
   * correctly withheld.
   */
  const elements = Array.from({ length: 200 }, (_, i) => element(`e${i}`, "s1", "button", `Action number ${i}`));
  const view = renderModelView(ir([section("s1", "form", "Everything", elements)], elements), { maxChars: 500 });

  assert.ok(view.text.length <= 500, `view was ${view.text.length} chars`);
  assert.deepEqual(view.expanded, [], "a section that cannot fit stays closed");
  assert.match(view.text, /Everything/, "and is still named");
});

test("a view that is cut says so", () => {
  // A silently shortened view reads as a complete page that happens to be small,
  // and the model concludes the thing it needs is absent rather than unshown.
  const sections: IrSection[] = [];
  const elements: IrElement[] = [];
  for (let i = 0; i < 40; i++) {
    const id = `s${i + 1}`;
    const el = element(`e${i + 1}`, id, "link", `Item ${i + 1}`);
    sections.push(section(id, "list", `Region ${i + 1}`, [el]));
    elements.push(el);
  }

  const view = renderModelView(ir(sections, elements), { maxChars: 400 });

  assert.equal(view.truncated, true);
  assert.match(view.text, /trimmed|more line/i, "the cut is stated in the text");
});
