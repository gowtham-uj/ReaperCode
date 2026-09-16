/**
 * The BrowserIR compiler.
 *
 * The fixtures are built to the shape of real `ariaSnapshot({ mode: "ai" })`
 * output plus the DOM join, captured from Playwright 1.59 against a fixture page
 * carrying a nav, a form with every control state, a repeated result list, a
 * dialog and a footer. The lines matter because every rule here is written
 * against them: `- role "name" [ref=eN]`, indentation carrying the tree, and
 * `generic` appearing on every element with no better role.
 *
 * The four load-bearing properties, each of which is a way this goes wrong:
 *
 *   1. A form is one section, not one section per field.
 *   2. An id survives a re-render, so `inspect("e31")` still means the button.
 *   3. Relevance reorders and collapses detail but never removes an element's
 *      existence, because a hidden button is invisible when it happens.
 *   4. The locator score puts role+name first, because that is what survives.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  compileIr,
  elementFingerprint,
  relevanceScore,
  scoreLocators,
  type IrNode,
} from "../../../src/browser/ir.js";

/** The shape a fixture node is described with. */
interface Spec {
  role: string;
  name?: string;
  children?: Spec[];
  id?: string;
  testId?: string;
  href?: string;
  value?: string;
  states?: string[];
  inputType?: string;
  tag?: string;
}

/**
 * Build a node list the way the collector does: a flat array with children
 * addressed by index. `depth` is carried because the DOM-depth fallback and the
 * renderer both use it.
 *
 * Depth is passed down rather than derived afterwards, so a fixture that nests
 * wrongly is visible in the fixture rather than silently corrected here.
 */
function build(spec: Spec[]): { nodes: IrNode[]; root: number } {
  const nodes: IrNode[] = [];
  const root: number = 0;
  nodes[root] = { role: "rootwebarea", name: "", index: root, depth: 0, children: [] };

  const add = (item: Spec, depth: number): number => {
    const index = nodes.length;
    const node: IrNode = {
      role: item.role,
      name: item.name ?? "",
      index,
      depth,
      children: [],
      ...(item.id !== undefined ? { id: item.id } : {}),
      ...(item.testId !== undefined ? { testId: item.testId } : {}),
      ...(item.href !== undefined ? { href: item.href } : {}),
      ...(item.value !== undefined ? { value: item.value } : {}),
      ...(item.states !== undefined ? { states: item.states } : {}),
      ...(item.inputType !== undefined ? { inputType: item.inputType } : {}),
      ...(item.tag !== undefined ? { tag: item.tag } : {}),
    };
    nodes[index] = node;
    for (const child of item.children ?? []) node.children.push(add(child, depth + 1));
    return index;
  };

  for (const item of spec) nodes[root]!.children.push(add(item, 1));
  return { nodes, root };
}

/** A page with the shapes that matter: nav, main with a form and results, footer. */
function jobsPage() {
  return build([
    {
      role: "navigation",
      name: "Main",
      children: [
        { role: "link", name: "Jobs", href: "/jobs" },
        { role: "link", name: "About", href: "/about" },
      ],
    },
    {
      role: "main",
      children: [
        {
          role: "form",
          name: "Application",
          children: [
            { role: "textbox", name: "First name", value: "Alice", states: ["required"], id: "fn", tag: "input" },
            { role: "textbox", name: "Email", value: "", id: "em", inputType: "email", tag: "input" },
            { role: "textbox", name: "Password", value: "hunter2", inputType: "password", tag: "input" },
            { role: "checkbox", name: "Willing to relocate", states: ["checked"], tag: "input" },
            { role: "button", name: "Apply now", testId: "submit", tag: "button" },
            { role: "button", name: "Cancel", states: ["disabled"], tag: "button" },
          ],
        },
        {
          role: "list",
          name: "Results",
          children: [
            { role: "listitem", children: [{ role: "link", name: "Job 1", href: "/j/1" }] },
            { role: "listitem", children: [{ role: "link", name: "Job 2", href: "/j/2" }] },
            { role: "listitem", children: [{ role: "link", name: "Job 3", href: "/j/3" }] },
          ],
        },
      ],
    },
    { role: "contentinfo", children: [{ role: "link", name: "Privacy", href: "/privacy" }] },
  ]);
}

test("landmarks become sections, and a form is one section rather than one per field", () => {
  /*
   * The property everything else depends on. If section detection cut at each
   * interactive node, the compact view would be the accessibility tree again
   * with extra steps.
   */
  const ir = compileIr({ url: "https://x/apply", title: "Apply", ...jobsPage() });
  // `order` is document order; `sections` is ranked by relevance. Both matter,
  // and conflating them is the mistake this assertion exists to catch.
  const inDocumentOrder = ir.order.map((id) => {
    const section = ir.sections.find((candidate) => candidate.id === id)!;
    return `${section.kind}:${section.label}`;
  });
  assert.deepEqual(inDocumentOrder, ["navigation:Main", "form:Application", "list:Results", "footer:Footer"]);

  /*
   * `main` wrapped the form and the list and held nothing of its own, so it is a
   * container rather than a section. Checked by kind rather than by label: the
   * fixture's nav is *also* named "Main", which is exactly the sort of collision
   * a real page has and a reason the label alone is not an identity.
   */
  assert.ok(!ir.sections.some((section) => section.kind === "main"), "a pure container is not a section");

  const form = ir.sections.find((section) => section.kind === "form")!;
  assert.equal(form.elements.length, 6, "every control in the form belongs to the form");
});

test("a page built entirely from divs still sections, via the depth fallback", () => {
  /*
   * The failure this exists for: a React app with no landmarks at all compiles
   * to one section and the model loses the regions it would have found by
   * looking. The fallback cuts the top-level blocks instead.
   */
  const page = build([
    { role: "generic", children: [{ role: "button", name: "One" }, { role: "button", name: "Two" }] },
    { role: "generic", children: [{ role: "button", name: "Three" }] },
    { role: "generic", children: [{ role: "textbox", name: "Search", id: "s" }] },
  ]);
  const ir = compileIr({ url: "https://x", title: "t", ...page });
  /*
   * Two sections, not three. The first block has two actionable things in it and
   * so is a block of its own; the second and third have one each and group
   * together. Making one section per top-level child would have split a content
   * page into one section per paragraph, which is the failure example.com
   * exposed: a heading, a paragraph and a link became three sections, two of
   * them empty.
   */
  assert.equal(ir.sections.length, 2, `got ${ir.sections.map((section) => section.label).join(",")}`);
  assert.equal(ir.sections[0]!.kind, "unknown");
  assert.equal(ir.elements.size, 4, "three buttons and the search box are all still addressable");
});

test("a content page with no landmarks compiles to one section, not one per node", () => {
  /*
   * The example.com shape, which is what every documentation page, blog post and
   * error page looks like: a heading, some paragraphs, and a link buried in one
   * of them. Splitting it per block is wrong and splitting it per node is worse,
   * and the link inside the paragraph must survive both.
   */
  const page = build([
    { role: "heading", name: "Example Domain", tag: "h1" },
    { role: "paragraph", name: "", tag: "p" },
    { role: "paragraph", name: "", tag: "p", children: [{ role: "link", name: "Learn more", href: "/more", tag: "a" }] },
  ]);
  const ir = compileIr({ url: "https://example.com", title: "Example Domain", ...page });
  assert.equal(ir.sections.length, 1);
  assert.equal(ir.sections[0]!.label, "Example Domain", "the section is named after the heading in it");
  assert.equal(ir.elements.size, 1, "the link nested in a paragraph is still addressable");
  assert.equal([...ir.elements.values()][0]!.name, "Learn more");
});

test("a hidden field is reported, marked, and never offered as a target", () => {
  /*
   * The rule the design settled on: Reaper may hide detail, but it never hides
   * the fact that something is missing. A hidden field is usually load-bearing
   * (a CSRF token, a cart id, the next step of a wizard already in the markup),
   * so dropping it would leave the model believing the form carries no state
   * and the page has no later steps.
   *
   * It is reported with its value and a reason, kept out of the section's action
   * list, and given no locators, because a hidden element is not a target and
   * offering one would invite a program that Playwright refuses to run.
   */
  const page = build([
    {
      role: "form",
      name: "Checkout",
      children: [
        { role: "textbox", name: "Email", id: "em", value: "a@b.c", tag: "input" },
        { role: "input", name: "", id: "csrf", value: "tok123", inputType: "hidden", tag: "input" },
        { role: "button", name: "Place order", tag: "button" },
      ],
    },
  ]);
  const { nodes, root } = page;
  const csrf = nodes.find((node) => node.id === "csrf")!;
  csrf.hidden = true;

  const ir = compileIr({ url: "https://x", title: "t", nodes, root });
  const form = ir.sections.find((section) => section.kind === "form")!;

  assert.equal(form.elements.length, 2, "only the actionable things count");
  assert.equal(form.hiddenCount, 1, "and the hidden field is counted so the model knows it is there");

  const hidden = [...ir.elements.values()].find((element) => element.hidden === true);
  assert.ok(hidden, "the hidden field must be reported");
  assert.equal(hidden!.value, "tok123", "with its value, which is the reason it matters");
  assert.equal(hidden!.hiddenBecause, "an input of type hidden");
  assert.deepEqual(hidden!.locators, [], "a hidden element is not a target");
  assert.ok(!form.elements.includes(hidden!.id), "and it is not in the action list");
});

test("a hidden element keeps its id across revisions, so a reference to it stays valid", () => {
  // The id is what lets the model ask about it again after the page changes.
  const page = build([
    { role: "form", name: "C", children: [{ role: "input", name: "", id: "csrf", value: "t", inputType: "hidden", tag: "input" }] },
  ]);
  page.nodes.find((node) => node.id === "csrf")!.hidden = true;
  const first = compileIr({ url: "https://x", title: "t", ...page });
  const hiddenId = [...first.elements.values()].find((element) => element.hidden === true)!.id;

  const again = build([
    { role: "form", name: "C", children: [{ role: "input", name: "", id: "csrf", value: "t2", inputType: "hidden", tag: "input" }] },
  ]);
  again.nodes.find((node) => node.id === "csrf")!.hidden = true;
  const second = compileIr({ url: "https://x", title: "t", ...again }, { previous: first });
  assert.ok(second.elements.has(hiddenId), "the hidden field keeps its id");
  assert.equal(second.elements.get(hiddenId)!.value, "t2", "and reports the new value");
});

test("a form value and its states are carried, because they were free in the snapshot", () => {
  const ir = compileIr({ url: "https://x", title: "t", ...jobsPage() });
  const elements = [...ir.elements.values()];
  const first = elements.find((element) => element.name === "First name")!;
  assert.equal(first.value, "Alice");
  assert.deepEqual(first.states, ["required"]);

  const relocate = elements.find((element) => element.name === "Willing to relocate")!;
  assert.deepEqual(relocate.states, ["checked"]);

  const cancel = elements.find((element) => element.name === "Cancel")!;
  assert.deepEqual(cancel.states, ["disabled"], "a disabled button is a fact the model must not have to discover");
});

test("ids are assigned from one and are stable across revisions", () => {
  /*
   * The property `inspect("e31")` depends on. A second compile of the same page
   * must produce the same ids, or a reference the model holds is worthless one
   * step later.
   */
  const first = compileIr({ url: "https://x", title: "t", ...jobsPage() });
  const second = compileIr({ url: "https://x", title: "t", ...jobsPage() }, { previous: first });

  assert.deepEqual(
    second.sections.map((section) => section.id),
    first.sections.map((section) => section.id),
    "sections keep their ids",
  );
  for (const [id, element] of first.elements) {
    assert.ok(second.elements.has(id), `${id} (${element.name}) must survive the recompile`);
    assert.equal(second.elements.get(id)!.name, element.name, `${id} must still be the same element`);
  }
});

test("an element that changed its value is still the same element", () => {
  /*
   * The reason the fingerprint excludes values. A model types into a field and
   * the next compile must not rename it, or every reference to the field it is
   * filling breaks on the keystroke that fills it.
   */
  const before = compileIr({ url: "https://x", title: "t", ...jobsPage() });
  const emailId = [...before.elements.values()].find((element) => element.name === "Email")!.id;

  const page = jobsPage();
  const email = page.nodes.find((node) => node.name === "Email")!;
  email.value = "alice@example.com";
  const after = compileIr({ url: "https://x", title: "t", ...page }, { previous: before });

  assert.ok(after.elements.has(emailId), "the field keeps its id after being filled");
  assert.equal(after.elements.get(emailId)!.value, "alice@example.com", "and reports the new value");
});

test("a new element takes a fresh id and does not steal a dead one", () => {
  /*
   * Deliberate: ids are not reused within a run. A model holding `e31` from two
   * steps ago must not find it pointing at a different button. A stale id is
   * better than a wrong one.
   */
  const before = compileIr({ url: "https://x", title: "t", ...jobsPage() });
  const page = jobsPage();
  const upload: IrNode = { role: "button", name: "Upload resume", index: page.nodes.length, depth: 2, children: [], tag: "button" };
  page.nodes.push(upload);
  page.nodes.find((node) => node.role === "form")!.children.push(upload.index);

  const after = compileIr({ url: "https://x", title: "t", ...page }, { previous: before });

  const added = [...after.elements.values()].find((element) => element.name === "Upload resume")!;
  assert.ok(added.id, "the new button gets an id");
  const highestBefore = Math.max(...[...before.elements.keys()].map((id) => Number.parseInt(id.slice(1), 10)));
  assert.ok(
    Number.parseInt(added.id.slice(1), 10) > highestBefore,
    "it takes a number past every one already issued rather than reusing a dead one",
  );
  // Every id from before still means what it meant.
  for (const [id, element] of before.elements) {
    assert.equal(after.elements.get(id)?.name, element.name, `${id} must not have been retargeted`);
  }
});

test("two elements with the same role and name get distinct ids", () => {
  // Ambiguity is a real thing on a real page, and the IR must not collapse two
  // "Save" buttons into one id and then silently pick one.
  const page = build([
    {
      role: "main",
      children: [
        { role: "list", name: "R", children: [
          { role: "listitem", children: [{ role: "button", name: "Save" }] },
          { role: "listitem", children: [{ role: "button", name: "Save" }] },
        ] },
      ],
    },
  ]);
  const ir = compileIr({ url: "https://x", title: "t", ...page });
  const saves = [...ir.elements.values()].filter((element) => element.name === "Save");
  assert.equal(saves.length, 2);
  assert.notEqual(saves[0]!.id, saves[1]!.id, "two buttons are two elements");
});

test("role and name come first in the locator ranking, because that is what survives", () => {
  const ir = compileIr({ url: "https://x", title: "t", ...jobsPage() });
  const apply = [...ir.elements.values()].find((element) => element.name === "Apply now")!;
  assert.equal(apply.locators[0]!.strategy, "role+name");
  assert.match(apply.locators[0]!.expression, /getByRole\("button",\{name:"Apply now"\}\)/);
  // The test id is next, and is offered because this element has one.
  assert.ok(apply.locators.some((locator) => locator.strategy === "testid"));
  // The CSS fallback exists but never leads.
  assert.ok(apply.locators.at(-1)!.score < apply.locators[0]!.score);
});

test("a name with a quote does not produce a broken locator", () => {
  /*
   * Real pages have apostrophes and quotes in button text ("Don't save"). A
   * locator emitted as a broken string literal is worse than no locator, because
   * the model copies it and the program dies on a syntax error.
   */
  const page = build([{ role: "main", children: [{ role: "button", name: `Don't "save"` }] }]);
  const ir = compileIr({ url: "https://x", title: "t", ...page });
  const button = [...ir.elements.values()][0]!;
  const expression = `page.${button.locators[0]!.expression}`;
  // The proof it is valid JavaScript: it parses.
  assert.doesNotThrow(() => new Function("page", `return ${expression}`), "the locator must be valid JS");
  assert.match(button.locators[0]!.expression, /\\"/, "the quote is escaped");
});

test("a disabled control is still locatable, because a person can see it", () => {
  const ir = compileIr({ url: "https://x", title: "t", ...jobsPage() });
  const cancel = [...ir.elements.values()].find((element) => element.name === "Cancel")!;
  assert.ok(cancel.locators.length > 0);
  assert.match(cancel.locators[0]!.expression, /getByRole\("button"/);
});

test("relevance ranks the form above the navigation for a form-shaped step", () => {
  const ir = compileIr(
    { url: "https://x", title: "t", ...jobsPage() },
    { context: { step: "application form", goal: "apply to the job" } },
  );
  // Reordered: the first section the model reads is the one it acts on.
  assert.equal(ir.sections[0]!.kind, "form");
  assert.equal(ir.sections.at(-1)!.kind, "footer");

  const scores = ir.sections.map((section) => relevanceScore(section, { step: "application form", goal: "apply to the job" }));
  assert.ok(Math.max(...scores) > 0, "the step's section scores positive");
  // Document order is preserved separately, because the page's own sequence is
  // still a fact something downstream may need.
  assert.deepEqual(
    ir.order.map((id) => ir.sections.find((section) => section.id === id)!.kind),
    ["navigation", "form", "list", "footer"],
  );
});

test("relevance collapses detail but never removes an element's existence", () => {
  /*
   * The rule the design settled on, and the thing that could most easily go
   * wrong: a silently hidden button is invisible when it happens, so the model
   * cannot even ask about what it does not know exists. A low-relevance element
   * appears as a stub with its role, its name and its id; its detail is what
   * collapses.
   */
  const ir = compileIr(
    { url: "https://x", title: "t", ...jobsPage() },
    { context: { step: "application form" }, detailThreshold: 1000 },
  );
  // Everything is below the threshold, so everything is a stub.
  const privacy = [...ir.elements.values()].find((element) => element.name === "Privacy")!;
  assert.ok(ir.elements.has(privacy.id), "the element still exists and can be inspected by id");
  assert.equal(privacy.stub, true, "but its detail is collapsed");
  assert.equal(privacy.name, "Privacy", "the stub still carries the name, which is how the model knows what it is");
  assert.ok(privacy.locators.length > 0, "and the locators are still there for when it inspects");
});

test("a blocker's section outranks everything", () => {
  const ir = compileIr(
    { url: "https://x", title: "t", ...jobsPage() },
    { context: { step: "application form", blockers: ["CAPTCHA on Results"] } },
  );
  assert.equal(ir.sections[0]!.label, "Results", "the section holding the blocker is the one to look at");
});

test("the compile is deterministic, so a diff between revisions is meaningful", () => {
  /*
   * Nothing in the compiler reads the clock, the network or a random number.
   * If it did, every revision would differ everywhere and the change detection
   * the whole observation layer is built on would be noise.
   */
  const a = compileIr({ url: "https://x", title: "t", ...jobsPage() });
  const b = compileIr({ url: "https://x", title: "t", ...jobsPage() });
  assert.deepEqual(
    a.sections.map((section) => ({ id: section.id, kind: section.kind, label: section.label, elements: section.elements })),
    b.sections.map((section) => ({ id: section.id, kind: section.kind, label: section.label, elements: section.elements })),
  );
  assert.deepEqual([...a.elements.keys()], [...b.elements.keys()]);
});

test("an unchanged section is marked, which is what stops it being recomputed", () => {
  const first = compileIr({ url: "https://x", title: "t", ...jobsPage() });
  const same = compileIr({ url: "https://x", title: "t", ...jobsPage() }, { previous: first });
  const nav = same.sections.find((section) => section.kind === "navigation")!;
  assert.equal(nav.unchanged, true);
});

test("the revision advances with each compile", () => {
  const first = compileIr({ url: "https://x", title: "t", ...jobsPage() });
  assert.equal(first.revision, 1);
  const second = compileIr({ url: "https://x", title: "t", ...jobsPage() }, { previous: first });
  assert.equal(second.revision, 2);
});

test("a fingerprint ignores a value and a count that changes", () => {
  const a = elementFingerprint({ role: "button", name: "Cart (3)", section: "s1" });
  const b = elementFingerprint({ role: "button", name: "Cart (4)", section: "s1" });
  assert.equal(a, b, "a count in the name is not part of the identity");
});

test("a link's destination is part of its identity, but its query string is not", () => {
  // Ten links named "View" on a results page are distinguished by where they go,
  // and a session id in the query must not make each render a new element.
  const one = elementFingerprint({ role: "link", name: "View", section: "s1", href: "/jobs/1?s=abc" });
  const two = elementFingerprint({ role: "link", name: "View", section: "s1", href: "/jobs/2?s=abc" });
  const three = elementFingerprint({ role: "link", name: "View", section: "s1", href: "/jobs/1?s=xyz" });
  assert.notEqual(one, two, "different destinations are different links");
  assert.equal(one, three, "the same destination with a different query is the same link");
});

test("pagination is recognised by its shape", () => {
  const page = build([
    {
      role: "main",
      children: [
        {
          role: "generic",
          children: [
            { role: "link", name: "1", href: "/p/1" },
            { role: "link", name: "2", href: "/p/2" },
            { role: "link", name: "3", href: "/p/3" },
            { role: "link", name: "Next", href: "/p/2" },
          ],
        },
      ],
    },
  ]);
  const ir = compileIr({ url: "https://x", title: "t", ...page });
  assert.ok(
    ir.sections.some((section) => section.kind === "pagination"),
    `expected a pagination section, got ${ir.sections.map((section) => section.kind).join(",")}`,
  );
});

test("a repeated list of actionable siblings is recognised as results", () => {
  const page = build([
    {
      role: "main",
      children: [
        {
          role: "generic",
          children: [
            { role: "generic", children: [{ role: "link", name: "Job A", href: "/a" }] },
            { role: "generic", children: [{ role: "link", name: "Job B", href: "/b" }] },
            { role: "generic", children: [{ role: "link", name: "Job C", href: "/c" }] },
          ],
        },
      ],
    },
  ]);
  const ir = compileIr({ url: "https://x", title: "t", ...page });
  assert.ok(
    ir.sections.some((section) => section.kind === "results"),
    `expected a results section, got ${ir.sections.map((section) => section.kind).join(",")}`,
  );
});

test("a placeholder-only input still produces a locator", () => {
  // The pattern every search box uses, and the one a naive scorer would emit
  // nothing for because the accessible name is empty.
  const locators = scoreLocators({ role: "textbox", name: "", id: "q", depth: 1, index: 0, children: [], tag: "input" });
  assert.ok(locators.length > 0, "there must be some way to address it");
  assert.ok(locators.some((locator) => locator.strategy === "css" || locator.strategy === "label"));
});

test("an empty page compiles to an empty IR rather than throwing", () => {
  // Defensive: the collector can hand back a root with no children while a page
  // is still loading, and the tool must report an empty page rather than crash.
  const ir = compileIr({ url: "about:blank", title: "", nodes: [{ role: "rootwebarea", name: "", index: 0, depth: 0, children: [] }], root: 0 });
  assert.equal(ir.sections.length, 0);
  assert.equal(ir.elements.size, 0);
  assert.equal(ir.revision, 1);
});

/* ------------------------------------------------------------------ *
 * Repeated sections become one section with items
 *
 * These four tests exist because of a specific failure found by running the
 * compiler against 100 real sites. Hacker News came back as 30 sections, 29 of
 * them labelled "List"; lobste.rs as 26 with 24 sharing "Tags". That is the
 * inverse of the first bug (one giant section) and it is worse for the model:
 * it can see there are thirty things but has no way to say which one it means,
 * so it picks the first and acts in the wrong row.
 * ------------------------------------------------------------------ */

/**
 * A feed whose rows each independently shape as a section.
 *
 * This is the Hacker News shape, and reproducing it exactly is the point: a
 * container that holds nothing of its own, and rows that are each substantial
 * enough to look like a section on their own. That combination is what made the
 * compiler cut thirty times, because the enclosing section was empty and the
 * suppression rule correctly declined to hide the only content on the page.
 */
function feed(rows: number): Spec[] {
  return [
    {
      role: "generic",
      name: "",
      children: Array.from({ length: rows }, (_, index) => ({
        role: "generic",
        name: "",
        children: [
          // The rank, which is what a naive row label picks up and should not.
          { role: "generic", name: `${index + 1}.` },
          { role: "link", name: `Story number ${index + 1}`, href: `/item?id=${index + 1}` },
          { role: "link", name: "comments", href: `/comments?id=${index + 1}` },
          { role: "link", name: "hide", href: `/hide?id=${index + 1}` },
          { role: "link", name: "past", href: `/past?id=${index + 1}` },
        ],
      })),
    },
  ];
}

test("a run of repeated sibling sections becomes one section with items", () => {
  const page = build(feed(30));
  const ir = compileIr({ url: "https://news.example", title: "Feed", ...page });

  const listed = ir.sections.filter((section) => section.items !== undefined);
  assert.equal(listed.length, 1, `expected one grouped section, got ${ir.sections.map((s) => s.label).join(" | ")}`);
  const section = listed[0]!;
  assert.equal(section.items?.length, 30, "every row must be addressable");
  assert.ok(/\(30\)/.test(section.label), `the label should say how many rows: ${section.label}`);
});

test("a row is addressed by section and position, and carries its own elements", () => {
  const ir = compileIr({ url: "https://news.example", title: "Feed", ...build(feed(5)) });
  const section = ir.sections.find((candidate) => candidate.items !== undefined)!;

  assert.equal(section.items![0]!.id, `${section.id}:r1`);
  assert.equal(section.items![4]!.id, `${section.id}:r5`);
  // Every element in a row must be one of the section's own, not invented.
  for (const item of section.items!) {
    for (const elementId of item.elements) {
      assert.ok(section.elements.includes(elementId), `${elementId} is not in ${section.id}`);
      assert.ok(ir.elements.has(elementId), `${elementId} has no element record`);
    }
  }
  // No element belongs to two rows, or the model would act on the wrong one.
  const all = section.items!.flatMap((item) => item.elements);
  assert.equal(all.length, new Set(all).size, "an element must belong to exactly one row");
});

test("a row is labelled by what distinguishes it, not by its rank", () => {
  // The Hacker News shape: the first named thing in every row is "1.", "2.",
  // "3.", which is position and not identity. Thirty rows labelled by rank tell
  // the model nothing it could not get by counting.
  const ir = compileIr({ url: "https://news.example", title: "Feed", ...build(feed(4)) });
  const section = ir.sections.find((candidate) => candidate.items !== undefined)!;

  for (const [position, item] of section.items!.entries()) {
    assert.ok(!/^\d+\.?$/.test(item.label.trim()), `row ${position + 1} is labelled by its rank: ${item.label}`);
    assert.match(item.label, /Story number/);
  }
});

test("two sections never share a label, because the model picks by label", () => {
  // Two unnamed regions that are not siblings: grouping correctly refuses to
  // merge them, so the disambiguator has to make them distinguishable instead.
  const page = build([
    { role: "generic", name: "", children: [{ role: "textbox", name: "Query" }, { role: "button", name: "Go" }, { role: "link", name: "Help", href: "/help" }] },
    { role: "article", name: "", children: [{ role: "heading", name: "Filler" }] },
    { role: "generic", name: "", children: [{ role: "textbox", name: "Email" }, { role: "button", name: "Subscribe" }, { role: "link", name: "Terms", href: "/terms" }] },
  ]);
  const ir = compileIr({ url: "https://x", title: "t", ...page });

  const labels = ir.sections.map((section) => section.label);
  assert.equal(labels.length, new Set(labels).size, `duplicate labels: ${labels.join(" | ")}`);
});

test("a run shorter than the grouping minimum stays as separate sections", () => {
  // Two repeated blocks are two blocks. Collapsing them would cost the model a
  // level of indirection to save one line, which is the wrong trade.
  const ir = compileIr({ url: "https://x", title: "t", ...build(feed(2)) });
  assert.equal(ir.sections.filter((section) => section.items !== undefined).length, 0);
});

test("a grouped section keeps its id across a re-render", () => {
  // The whole point of grouping is that the model can hold "s1:r3" and come
  // back to it. If the section's id moved every compile, it could not.
  const first = compileIr({ url: "https://news.example", title: "Feed", ...build(feed(10)) });
  const grouped = first.sections.find((section) => section.items !== undefined)!;
  const second = compileIr({ url: "https://news.example", title: "Feed", ...build(feed(10)) }, { previous: first });
  const regrouped = second.sections.find((section) => section.items !== undefined)!;

  assert.equal(regrouped.id, grouped.id, "the grouped section must keep its id");
});

/* ------------------------------------------------------------------ *
 * Coverage: an empty result must say which kind of empty it is
 *
 * The sweep found stackoverflow.com/questions compiling to zero sections on a
 * 403 challenge page: 74 DOM nodes, 2 accessibility nodes, nothing actionable.
 * Reported as "0 sections" that is indistinguishable from a genuinely blank
 * page, and the two call for opposite actions. The model concludes the page is
 * empty and stops, which is the silent-coverage failure this design exists to
 * prevent.
 * ------------------------------------------------------------------ */

test("a page that was not read does not report as an empty page", () => {
  const ir = compileIr({
    url: "https://blocked.example",
    title: "Just a moment",
    nodes: [{ role: "rootwebarea", name: "", index: 0, depth: 0, children: [] }],
    root: 0,
    coverage: { counts: { rawNodes: 74, axNodes: 2, candidates: 0, visible: 0, listenerProbed: 0 }, frames: { total: 1, read: 1 }, complete: true },
  });

  assert.equal(ir.sections.length, 0);
  assert.equal(ir.coverage.complete, false, "an unread page must not vouch for itself");
  assert.match(ir.coverage.incompleteBecause ?? "", /was not read/);
  // The numbers have to be in the message, or the model cannot tell how badly
  // it was blocked and cannot decide whether reloading is worth a try.
  assert.match(ir.coverage.incompleteBecause ?? "", /74/);
});

test("a genuinely empty page is reported as complete", () => {
  // example.com's shape: one link, nothing else. Calling this incomplete would
  // make the flag fire constantly and stop meaning anything.
  const ir = compileIr({ url: "https://x", title: "t", ...build([{ role: "link", name: "More information...", href: "/more" }]) });
  assert.equal(ir.coverage.complete, true);
  assert.equal(ir.coverage.incompleteBecause, undefined);
});

test("an unread frame is named, so missing content is not silent", () => {
  const ir = compileIr({
    url: "https://x",
    title: "t",
    ...build([{ role: "link", name: "Visible", href: "/a" }]),
    coverage: { counts: { rawNodes: 40, axNodes: 12, candidates: 3, visible: 3, listenerProbed: 0 }, frames: { total: 2, read: 1, unread: ["f1 https://widget.example (cross-origin)"] }, complete: true },
  });

  assert.equal(ir.coverage.complete, false);
  assert.match(ir.coverage.incompleteBecause ?? "", /widget\.example/, "the unread frame must be identified");
  // Complete coverage is not required for the sections that WERE read: they are
  // still there, the model just is not told the view is whole.
  assert.ok(ir.sections.some((section) => section.elements.length > 0));
});
