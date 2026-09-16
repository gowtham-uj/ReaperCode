/**
 * Interaction detection as a union.
 *
 * Every fixture here is a real shape from a real site, because the failure this
 * replaces is narrow: the previous detector matched native tags and AX roles and
 * missed everything else. The cases below are the ones it missed.
 *
 * The asymmetry to keep in mind while reading: a false positive costs one line
 * in an observation, and a false negative costs the model the ability to finish
 * the task, with no way for it to tell that anything is missing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CERTAIN_THRESHOLD, scoreInteraction, signalNames } from "../../../src/browser/signals.js";

test("a native button is certain", () => {
  const verdict = scoreInteraction({ tag: "button", axRole: "button", tabindex: 0 });
  assert.equal(verdict.interactive, true);
  assert.ok(verdict.confidence >= CERTAIN_THRESHOLD, `a real button must be certain, got ${verdict.confidence}`);
  assert.equal(verdict.ambiguous, false);
});

test("a React div-button is found, which is the case the narrow detector misses", () => {
  /*
   * `<div role="button" tabindex="0">Continue</div>` is what every React
   * component library renders. It has no `button` tag, so a tag check misses it
   * entirely, and it is a button in every way that matters.
   */
  const verdict = scoreInteraction({ tag: "div", axRole: "button", roleAttribute: "button", tabindex: 0, cursor: "pointer" });
  assert.equal(verdict.interactive, true);
  assert.ok(verdict.confidence >= CERTAIN_THRESHOLD, `got ${verdict.confidence}`);
  assert.deepEqual(signalNames(verdict).sort(), ["ax-role", "cursor-pointer", "role-attribute", "tabindex"]);
});

test("a bare div with a runtime listener is found, which no attribute check can see", () => {
  /*
   * The hardest real case: no role, no tabindex, no handler in the markup. The
   * listener is attached at runtime, so only `DOMDebugger.getEventListeners`
   * knows, and the cursor style is the only other clue.
   */
  const verdict = scoreInteraction({ tag: "div", hasListener: true, cursor: "pointer" });
  assert.equal(verdict.interactive, true);
  assert.ok(verdict.confidence >= 0.5, `got ${verdict.confidence}`);
  assert.ok(signalNames(verdict).includes("runtime-listener"));
});

test("a pointer cursor alone is a candidate, and is marked ambiguous", () => {
  /*
   * Kept rather than dropped. This is precisely what the coverage auditor needs
   * to see, and dropping it would mean the auditor had nothing to report and a
   * genuinely clickable div vanished without trace.
   */
  const verdict = scoreInteraction({ tag: "div", cursor: "pointer" });
  assert.equal(verdict.interactive, true, "a lone pointer cursor is a candidate");
  assert.ok(verdict.confidence < CERTAIN_THRESHOLD, "but not a certain one");
  assert.equal(verdict.ambiguous, true, "and it is marked as the auditor's business");
});

test("a plain text div is not a candidate", () => {
  // The other side of the line. Calling every div interactive would make the IR
  // the DOM again, which is the thing it exists to avoid.
  const verdict = scoreInteraction({ tag: "div" });
  assert.equal(verdict.interactive, false);
  assert.equal(verdict.confidence, 0);
});

test("pointer-events none vetoes everything", () => {
  /*
   * The one signal that can veto, because it is physically definitive: an
   * element with `pointer-events: none` cannot receive a click. A button hidden
   * behind an overlay this way is genuinely unreachable, and reporting it as
   * actionable would send the model at something that cannot work.
   */
  const verdict = scoreInteraction({ tag: "button", axRole: "button", tabindex: 0, pointerEvents: "none" });
  assert.equal(verdict.interactive, false);
  assert.equal(verdict.confidence, 0);
});

test("a shadow-DOM button is found through the pierced tree", () => {
  // A custom element host is not itself actionable; the button inside it is,
  // and the host is a candidate because its descendants are.
  const host = scoreInteraction({ tag: "my-select", customElement: true, hasInteractiveDescendant: true });
  assert.equal(host.interactive, true);
  assert.ok(signalNames(host).includes("custom-element"));

  const inner = scoreInteraction({ tag: "button", axRole: "button" });
  assert.ok(inner.confidence >= CERTAIN_THRESHOLD, "the button inside the shadow root is certain");
});

test("an SVG node with a name or a listener is kept", () => {
  /*
   * Charts put real controls in SVG, and a tag check for HTML elements discards
   * them. A `<path>` with a cursor and a listener is a chart segment a person
   * clicks.
   */
  const path = scoreInteraction({ tag: "path", inSvg: true, cursor: "pointer", hasListener: true });
  assert.equal(path.interactive, true);
  assert.ok(signalNames(path).includes("svg-interactive"));

  // ...but a decorative path with nothing on it is not.
  const decorative = scoreInteraction({ tag: "path", inSvg: true });
  assert.equal(decorative.interactive, false, "a decorative SVG shape is not a control");
});

test("an SVG root is not a control just for having a role", () => {
  /*
   * The bug this test exists for: every SVG element has an accessibility role,
   * including the root, so a rule that accepted any role put a decorative chart
   * wrapper into the IR as a low-confidence control on every page that uses one.
   */
  const root = scoreInteraction({ tag: "svg", inSvg: true, axRole: "svgroot" });
  assert.equal(root.interactive, false, "an SVG root is a container, not a control");

  const graphics = scoreInteraction({ tag: "g", inSvg: true, axRole: "graphicsobject" });
  assert.equal(graphics.interactive, false, "nor is an SVG group");

  // The shape inside it with a cursor is the control, and still is.
  const segment = scoreInteraction({ tag: "path", inSvg: true, axRole: "graphicsymbol", cursor: "pointer" });
  assert.equal(segment.interactive, true, "a clickable chart segment is still found");
});

test("a negative tabindex still counts, because that is how menus work", () => {
  // `tabindex="-1"` is how every focus trap and custom listbox manages focus.
  // It weighs less than 0, since it is not in the tab order, but it is a real
  // signal rather than an accident.
  const verdict = scoreInteraction({ tag: "div", tabindex: -1, axRole: "menuitem" });
  assert.equal(verdict.interactive, true);
  assert.ok(signalNames(verdict).includes("tabindex"));
});

test("an anchor without an href is not a control on its own", () => {
  // `<a>` with no href is a placeholder, and treating it as a link would put
  // dead entries in the IR.
  const verdict = scoreInteraction({ tag: "a", axRole: "link" });
  assert.ok(verdict.confidence > 0, "the AX role still says something");
  assert.ok(verdict.confidence < 0.45, "but it is not as strong as a real link");
});

test("confidence is capped rather than summed past one", () => {
  // A native button with every signal agreeing must read as 1.0, not 2.1, or
  // every downstream comparison against a threshold becomes meaningless.
  const verdict = scoreInteraction({
    tag: "button",
    axRole: "button",
    roleAttribute: "button",
    tabindex: 0,
    cursor: "pointer",
    hasListener: true,
    handlerAttributes: ["onclick"],
  });
  assert.equal(verdict.confidence, 1);
});

test("the signals are named, so a wrong call can be explained", () => {
  /*
   * The reason this carries signal names rather than a number: when the
   * detector gets something wrong, the question is always "why did you think
   * that", and a number cannot answer it.
   */
  const verdict = scoreInteraction({ tag: "div", cursor: "pointer", tabindex: 0, axRole: "button" });
  const names = signalNames(verdict);
  assert.deepEqual(names.sort(), ["ax-role", "cursor-pointer", "tabindex"]);
});

test("no signal means no interactive call, however many empty fields there are", () => {
  const verdict = scoreInteraction({ tag: "div", handlerAttributes: [], cursor: "default", pointerEvents: "auto" });
  assert.equal(verdict.interactive, false);
  assert.deepEqual(verdict.signals, []);
});
