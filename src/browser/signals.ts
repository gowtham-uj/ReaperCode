/**
 * Whether a thing can be interacted with, and how sure we are.
 *
 * The narrow version of this check, `tag === "button" || tag === "input" ||
 * tag === "a"`, misses modern applications badly. React renders
 * `<div role="button" tabindex="0">Continue</div>`, component libraries render
 * into shadow roots, and plenty of sites attach the listener at runtime to a
 * plain `<div class="hash">` with no role at all. All of those are buttons in
 * every way that matters to a model trying to click one.
 *
 * So this is a union, not a check. Any single signal makes a thing a candidate;
 * the confidence is how many independent sources agreed, and the signal names
 * are kept because "why did you call this a button" is the question the
 * relevance layer and the coverage auditor both ask.
 *
 * False positives are cheap and false negatives are expensive, which is the
 * asymmetry that sets the weights. A div wrongly called interactive costs one
 * line in an observation. A button wrongly called a div costs the model the
 * ability to finish the task, and it cannot even tell that it is missing.
 */

/** One named reason to believe something is interactive. */
export interface InteractionSignal {
  name:
    | "native-control"
    | "ax-role"
    | "tabindex"
    | "role-attribute"
    | "contenteditable"
    | "handler-attribute"
    | "runtime-listener"
    | "cursor-pointer"
    | "svg-interactive"
    | "custom-element"
    | "draggable";
  /** What this contributes to confidence. */
  weight: number;
}

/**
 * AX roles that are interactive, and how strongly.
 *
 * `link` is slightly weaker than `button` because pages put `role="link"` on
 * decorative things more often than they put `role="button"` on them, but it is
 * still far above any heuristic.
 */
const AX_ROLE_WEIGHTS: Record<string, number> = {
  button: 0.4,
  link: 0.35,
  textbox: 0.4,
  searchbox: 0.4,
  combobox: 0.4,
  listbox: 0.35,
  checkbox: 0.4,
  radio: 0.4,
  switch: 0.4,
  slider: 0.4,
  spinbutton: 0.4,
  menuitem: 0.35,
  menuitemcheckbox: 0.35,
  menuitemradio: 0.35,
  option: 0.3,
  tab: 0.35,
  treeitem: 0.3,
  gridcell: 0.3,
  scrollbar: 0.3,
  // A `cell` or `columnheader` is a data position, not a control, unless the
  // grid is interactive. Kept low so it never outweighs a real signal.
  cell: 0.1,
  columnheader: 0.1,
  rowheader: 0.1,
  // `img` is only interactive with a listener or a cursor, so it carries no
  // weight on its own; the other signals have to say so.
  img: 0,
  figure: 0,
  video: 0.15,
  audio: 0.15,
};

/** Tags that are controls by virtue of what they are. */
const NATIVE_CONTROL_TAGS = new Set(["button", "input", "select", "textarea", "option", "summary"]);

/** Roles that count as interactive when written as an attribute. */
const INTERACTIVE_ROLE_ATTRIBUTES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "combobox",
  "listbox",
  "slider",
  "spinbutton",
  "textbox",
  "searchbox",
  "treeitem",
  "gridcell",
]);

/** Everything known about a node from every source, before scoring. */
export interface InteractionEvidence {
  tag?: string | undefined;
  /** The role from the accessibility tree, lowercased. */
  axRole?: string | undefined;
  /** The `role` *attribute* from the DOM, which is a different claim. */
  roleAttribute?: string | undefined;
  /** `tabindex`, parsed. Negative values mean focusable but not tab-reachable. */
  tabindex?: number | undefined;
  contenteditable?: boolean | undefined;
  draggable?: boolean | undefined;
  /** `onclick`, `onchange`, and the other `on*` attributes present. */
  handlerAttributes?: string[] | undefined;
  /** True when `DOMDebugger.getEventListeners` found a real listener. */
  hasListener?: boolean | undefined;
  /** `getComputedStyle().cursor`. */
  cursor?: string | undefined;
  pointerEvents?: string | undefined;
  /** True for an `svg` element or a descendant of one. */
  inSvg?: boolean | undefined;
  /** True for a custom element (a tag with a dash in it). */
  customElement?: boolean | undefined;
  /** True when a descendant is interactive, which makes a host a candidate. */
  hasInteractiveDescendant?: boolean | undefined;
  href?: string | undefined;
}

export interface InteractionVerdict {
  interactive: boolean;
  /** 0..1. Sum of the weights that applied, capped at 1. */
  confidence: number;
  signals: InteractionSignal[];
  /** True when the only evidence is weak, which is what the auditor wants. */
  ambiguous: boolean;
}

/**
 * Below this and the node is not a candidate at all.
 *
 * A single weak signal (a pointer cursor, a `cell` role) is not enough to put
 * something in the IR as an action, but it *is* enough for the auditor to look
 * at it. 0.15 admits `cursor: pointer` alone and excludes nothing-signals.
 */
export const CANDIDATE_FLOOR = 0.15;

/**
 * At or above this, the node is treated as definitely interactive.
 *
 * A native button alone is 0.45 and an AX `button` role alone is 0.40, so
 * neither reaches it on its own; that is deliberate, because the flag is only
 * used for reporting certainty, and the ranking uses confidence directly.
 */
export const CERTAIN_THRESHOLD = 0.6;

/**
 * Score the evidence.
 *
 * `pointer-events: none` is a gate rather than a weight: it means the element
 * cannot receive a click at all, so a node with it is not interactive no matter
 * what else is true. This is the one place a signal can veto, and it is the
 * only one, because it is the only signal that is physically definitive.
 */
export function scoreInteraction(evidence: InteractionEvidence): InteractionVerdict {
  const signals: InteractionSignal[] = [];

  const vetoed = evidence.pointerEvents === "none";
  if (vetoed) {
    return { interactive: false, confidence: 0, signals: [{ name: "cursor-pointer", weight: 0 }], ambiguous: false };
  }

  const tag = evidence.tag?.toLowerCase();

  if (tag && NATIVE_CONTROL_TAGS.has(tag)) signals.push({ name: "native-control", weight: 0.45 });
  else if (tag === "a" && evidence.href) signals.push({ name: "native-control", weight: 0.45 });

  const axWeight = evidence.axRole ? AX_ROLE_WEIGHTS[evidence.axRole] : undefined;
  if (axWeight !== undefined && axWeight > 0) signals.push({ name: "ax-role", weight: axWeight });

  if (typeof evidence.tabindex === "number") {
    /*
     * A negative tabindex is still focusable programmatically, which is how
     * every focus trap and menu listbox works. It weighs less than a
     * zero-or-positive one, which is the deliberate "this is in the tab order"
     * signal, but it is not nothing.
     */
    signals.push({ name: "tabindex", weight: evidence.tabindex >= 0 ? 0.2 : 0.1 });
  }

  if (evidence.roleAttribute && INTERACTIVE_ROLE_ATTRIBUTES.has(evidence.roleAttribute.toLowerCase())) {
    signals.push({ name: "role-attribute", weight: 0.35 });
  }

  if (evidence.contenteditable) signals.push({ name: "contenteditable", weight: 0.25 });
  if (evidence.draggable) signals.push({ name: "draggable", weight: 0.15 });
  if (evidence.handlerAttributes && evidence.handlerAttributes.length > 0) {
    signals.push({ name: "handler-attribute", weight: 0.25 });
  }
  if (evidence.hasListener) signals.push({ name: "runtime-listener", weight: 0.35 });
  if (evidence.cursor === "pointer") signals.push({ name: "cursor-pointer", weight: 0.2 });
  /*
   * An SVG shape is a control only with evidence of its own.
   *
   * The rule this replaces fired on the SVG *root*, because every SVG element
   * has an accessibility role and the check accepted any role at all. That put
   * a decorative `<svg>` chart wrapper into the IR as a 0.20-confidence control
   * on every page that uses one. What actually distinguishes a clickable chart
   * segment is a pointer cursor, a listener, or text of its own, so those are
   * what is required, and a named or generated shape counts too.
   */
  if (evidence.inSvg) {
    const named = (evidence.axRole ?? "") !== "" && evidence.axRole !== "svgroot" && evidence.axRole !== "graphicsobject";
    if (evidence.cursor === "pointer" || evidence.hasListener || named) {
      signals.push({ name: "svg-interactive", weight: 0.2 });
    }
  }
  if (evidence.customElement && evidence.hasInteractiveDescendant) {
    signals.push({ name: "custom-element", weight: 0.3 });
  }

  /*
   * The sum is capped rather than averaged, because the signals are not
   * independent: a native button has an AX role and a tabindex and a handler,
   * and averaging would drag a certain button down toward a suspicious div.
   */
  const raw = signals.reduce((total, signal) => total + signal.weight, 0);
  const confidence = Math.min(1, Number(raw.toFixed(3)));

  return {
    interactive: confidence >= CANDIDATE_FLOOR,
    confidence,
    signals,
    // The band where a model could reasonably disagree, which is where the
    // auditor escalates rather than reporting.
    ambiguous: confidence >= CANDIDATE_FLOOR && confidence < CERTAIN_THRESHOLD,
  };
}

/** The names of the signals, for rendering and for the auditor's reason line. */
export function signalNames(verdict: InteractionVerdict): string[] {
  return verdict.signals.map((signal) => signal.name);
}
