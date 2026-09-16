/**
 * The perception engine: what the model reads, and what happens when it cannot.
 *
 * Two of these tests matter more than the rest, and they are the two that are
 * hardest to keep honest.
 *
 * The first is that the fallback announces itself. It only runs when the
 * compiler has failed, which makes it the path least likely to be exercised and
 * the one where a silent failure is most expensive: the compiled view hands out
 * `s1:r3` and locator expressions, the fallback hands out `aria-ref=e74`, and a
 * model that reads a fallback believing it is a compile writes locators that
 * resolve to nothing and concludes the page is wrong.
 *
 * The second is that the fallback is the *whole* page. Depth-limited snapshots
 * are tempting because they are three times smaller, and they are a trap: depth
 * folds controls into their ancestor's accessible name, so the navigation links
 * stop being individually addressable and a fallback that cannot press anything
 * is not a fallback. Measured on Hacker News, depth 6 keeps every story title
 * and drops 217 of the page's 225 addressable actions.
 *
 * These run without a browser. `perceive` takes its collector as an option, so a
 * test drives the failure paths directly rather than hoping to encounter them,
 * and the page is a stand-in with the one method the fallback needs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { perceive } from "../../../src/browser/engine.js";
import type { CandidateElement, CollectedPage, StructuralNode } from "../../../src/browser/collect.js";

/** Just enough of a Page for the fallback's `ariaSnapshot` call. */
function fakePage(snapshot: string): { ariaSnapshot: (options?: unknown) => Promise<string>; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    ariaSnapshot: async (options?: unknown) => {
      calls.push(options);
      return snapshot;
    },
  };
}

/**
 * A collected page with one form holding a button.
 *
 * Built from `elements` and `structural`, which is what `buildIrTree` actually
 * consumes. The first version of this handed the compile a `nodes`/`root` pair
 * instead, which the compiler ignores entirely, so every fixture compiled to
 * zero sections and the "successful read" test was really exercising the
 * fallback. Worth the note: a fixture that does not feed the real path fails in
 * the direction of the test passing for the wrong reason.
 */
function collected(forms: number = 1): CollectedPage {
  const elements: CandidateElement[] = [];
  const structural: StructuralNode[] = [];
  let backend = 100;

  for (let i = 0; i < forms; i++) {
    const formBackend = backend++;
    const buttonBackend = backend++;
    structural.push({
      backendNodeId: formBackend,
      frameId: "",
      tag: "form",
      role: "form",
      name: `Form ${i + 1}`,
      depth: 1,
      parentBackendNodeId: 1,
      ancestorBackendNodeIds: [1],
      isRoot: false,
    });
    elements.push({
      backendNodeId: buttonBackend,
      frameId: "",
      tag: "button",
      role: "button",
      accessibleName: "Continue",
      states: [],
      visible: true,
      interaction: { interactive: true, confidence: 1, signals: [{ name: "ax-role", weight: 1 }], ambiguous: false },
      evidence: {},
      depth: 2,
      parentBackendNodeId: formBackend,
      ancestorBackendNodeIds: [formBackend, 1],
      inShadow: false,
      inSvg: false,
    } as CandidateElement);
  }

  return {
    url: "https://example.test/page",
    title: "A page",
    elements,
    structural,
    frames: [],
    canvases: [],
    scrollRegions: [],
    counts: { rawNodes: 40, axNodes: 12, candidates: elements.length, visible: elements.length, listenerProbed: 0 },
  };
}

test("a collector that throws falls back, and says so in the view", async () => {
  const page = fakePage('- button "Continue" [ref=e1]');
  const result = await perceive(page as never, {
    collect: async () => {
      throw new Error("CDP session closed mid-collection");
    },
  });

  assert.equal(result.usedFallback, true);
  assert.equal(result.fallbackReason, "collect-failed");
  assert.match(result.text, /Continue/, "the model still gets the page");
  /*
   * The note is the load-bearing assertion. It has to name the reason, say that
   * this is a fallback, and state that elements are addressed by ref rather
   * than by locator, because that is the fact the model acts on.
   */
  assert.match(result.note ?? "", /FALLBACK/);
  assert.match(result.note ?? "", /collect-failed/);
  assert.match(result.note ?? "", /aria-ref/);
  assert.match(result.note ?? "", /CDP session closed mid-collection/, "the cause is named, not just the category");
});

test("a collector that returns nothing usable falls back rather than crashing", async () => {
  /*
   * The compiler is defensive: a collected page with no elements and a thin
   * accessibility tree compiles to an empty IR that reports itself as a page
   * that was not read, rather than throwing. So this does not exercise
   * "compile-failed" so much as the second guard behind it, which is the one
   * that actually fires in practice. `compile-failed` stays as a backstop for a
   * shape the compiler genuinely cannot walk, and is not reachable from a
   * well-formed empty collection.
   */
  const page = fakePage('- textbox "Email" [ref=e7]');
  const result = await perceive(page as never, {
    collect: async () => ({
      ...collected(0),
      counts: { rawNodes: 74, axNodes: 2, candidates: 0, visible: 0, listenerProbed: 0 },
    }),
  });

  assert.equal(result.usedFallback, true);
  assert.equal(result.fallbackReason, "no-sections");
  assert.match(result.text, /Email/, "the model still sees the field the snapshot found");
});

test("a compile with no sections falls back rather than reporting an empty page", async () => {
  const page = fakePage('- paragraph: There is nothing here [ref=e1]');
  const result = await perceive(page as never, {
    collect: async () => ({
      ...collected(0),
      counts: { rawNodes: 74, axNodes: 2, candidates: 0, visible: 0, listenerProbed: 0 },
    }),
  });

  assert.equal(result.usedFallback, true);
  assert.equal(result.fallbackReason, "no-sections");
  assert.match(result.note ?? "", /FALLBACK/);
  /*
   * Why this matters: an empty compile and an empty page are the same output and
   * call for opposite actions. The fallback is the second opinion that settles
   * it, and the note has to carry the compiler's own reason (74 DOM nodes, 2
   * accessibility nodes) rather than a generic "it failed".
   */
  assert.match(result.note ?? "", /74|accessibility nodes|not read/);
});

test("the fallback is the whole page, not a depth cut", async () => {
  /*
   * The single most tempting optimisation here, and the one that is wrong.
   * `depth: 6` on Hacker News is 8,729 characters against the full snapshot's
   * 47,683, and it keeps every story title, which makes it look free. It is not:
   * depth folds controls into their ancestor's accessible name, so the nav links
   * stop carrying their own refs and 225 addressable actions become 8. The
   * fallback exists so the model can still act, so it asks for no depth.
   */
  const page = fakePage("full snapshot");
  await perceive(page as never, { collect: async () => { throw new Error("boom"); } });

  assert.equal(page.calls.length, 1);
  const options = page.calls[0] as { mode?: string; depth?: unknown };
  assert.equal(options.mode, "ai");
  assert.equal(options.depth, undefined, "the fallback must not pass a depth, or the controls fold into their parents");
});

test("raw mode is a fallback the caller asked for, and is labelled differently", async () => {
  const page = fakePage('- link "Home" [ref=e1]');
  const result = await perceive(page as never, { raw: true });

  assert.equal(result.usedFallback, true);
  assert.equal(result.fallbackReason, "requested");
  assert.match(result.note ?? "", /RAW/);
  // Nothing was compiled, so there is no collector call and no IR.
  assert.equal(result.ir, undefined);
  assert.equal(result.sectionCount, 0);
});

test("a page the compiler reads well produces the compiled view, not a fallback", async () => {
  /*
   * The control. Without this, every test above would pass on an engine that
   * fell back unconditionally.
   */
  const compiled = collected(2);
  const page = fakePage("snapshot that must not be used");
  const result = await perceive(page as never, { collect: async () => compiled });

  assert.equal(result.usedFallback, false, result.note ?? "");
  assert.equal(result.note, undefined, "a successful read carries no caveat");
  assert.ok(result.sectionCount > 0, "a compiled read reports its sections");
  assert.ok(result.elementCount > 0, "and its addressable elements");
  assert.equal(page.calls.length, 0, "the snapshot is not taken at all when the compiler succeeds");
  assert.match(result.text, /Continue/, "the view carries the button the fixture collected");
});

test("a fallback reaches the model whole, with no budget applied", async () => {
  /*
   * The fallback is not a summary, so it is not trimmed.
   *
   * The budget exists because the compiled view is a reduction a model may need
   * to ask more of, and cutting it is safe: every section is still named and can
   * be opened by id. A fallback is Playwright's own accessibility tree, and
   * cutting it at 3,000 characters removes whole regions that have no id, no
   * count, and no way to reach them. A model reading that would be reading a
   * partial tree believing it was the page, which is the exact failure this
   * whole layer exists to prevent.
   *
   * The observer is where the trim happens, so this drives the observer directly
   * with the two captures the runtime makes.
   */
  const { PageObserver } = await import("../../../src/browser/page-view.js");
  const long = Array.from({ length: 4000 }, (_, i) => `- link "Item ${i}" [ref=e${i}]`).join("\n");
  assert.ok(long.length > 3000 * 10, "the fixture must be far past the budget, or this proves nothing");

  const observer = new PageObserver();
  observer.capture({ url: "https://example.test/", title: "t", snapshot: long, note: "FALLBACK", untrimmed: true });
  const view = observer.view();

  assert.equal(view.truncated, false, "a fallback is not a truncated view");
  assert.ok(view.text.length > long.length, `the whole snapshot must be present, got ${view.text.length} chars`);
  assert.match(view.text, /Item 3999/, "the tail of the page must survive, not just the head");

  // And the compiled view is still trimmed, which is the half that must not regress.
  const observer2 = new PageObserver();
  observer2.capture({ url: "https://example.test/", title: "t", snapshot: long });
  const trimmed = observer2.view();

  assert.equal(trimmed.truncated, true, "the compiled view still respects the budget");
  assert.ok(trimmed.text.length < long.length, "and is still shorter than the tree it summarises");
});
