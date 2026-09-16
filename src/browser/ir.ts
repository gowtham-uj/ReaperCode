/**
 * BrowserIR: the page, compiled.
 *
 * Not a snapshot. A deterministic reduction of the page into semantic sections
 * and addressable elements, built so the model reads a description of what it
 * can do rather than a tree of everything that exists.
 *
 * The thing this exists to avoid is the accessibility tree, and the reason is
 * measurable rather than philosophical. A real page's full tree is thousands of
 * nodes, most of them wrappers, with no signal about which parts matter. Probed
 * on a small page with a nav, a form, a list, a dialog and a footer, the AI
 * snapshot ran 1,837 characters and the great majority of the lines were
 * structure. On a job board it runs to tens of thousands. A Flash-class model
 * given that spends its context re-deriving the same layout every step, and the
 * evidence says it does worse with more of it: a full tree measurably hurts
 * small models, and a compiled view with a program per turn is worth far more
 * than a tree with a click per turn.
 *
 * The compiler takes the accessibility tree and the DOM and produces:
 *
 *   sections   semantic, stable, task-shaped: a form, a result list, a nav
 *   elements   stable ids, roles, names, live state, and scored locators
 *
 * Everything below is pure. The page is read by `collect.ts` and handed in as
 * plain data, which is what makes section detection, id assignment, fingerprint
 * matching and rendering testable without a browser.
 *
 * ## What the input already gives us, measured rather than assumed
 *
 * Playwright's `ariaSnapshot({ mode: "ai" })` was measured against a fixture
 * carrying every interesting state, and it turns out to carry more than the
 * docs suggest:
 *
 *   - **form values are inline**: `textbox "First name" [ref=e12]: Alice`
 *   - **state is inline**: `[checked]`, `[disabled]`, `[selected]`
 *   - **hidden elements are omitted entirely**
 *   - test ids are **not** there, which is why the DOM join exists
 *
 * So values, states and visibility cost nothing extra. The DOM join is only for
 * the attributes the tree omits, and it is cheap: `DOM.getDocument` (depth -1,
 * pierce) is 30ms and `Accessibility.getFullAXTree` is 38ms on that same page.
 *
 * ## What is deliberately not derived here
 *
 * Geometry. It is not free: `DOM.getBoxModel` is 4ms per node, but
 * `locator.boundingBox()` is about 30ms, so on a page with 37 elements the
 * Playwright route costs over a second. Since the compact view does not show
 * geometry and only `screenshot(element)` and the live pane's cursor need it,
 * bounding boxes are collected on demand rather than in the base compile.
 */

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/**
 * What a section is for, as far as the compile can tell.
 *
 * Deliberately a small closed set. A section whose kind is beyond these is
 * `unknown`, and an `unknown` section is still rendered with its label and its
 * elements rather than discarded, because the fallback running is the difference
 * between a site built from divs losing its structure and keeping it.
 */
export type SectionKind =
  | "navigation"
  | "search"
  | "results"
  | "product"
  | "form"
  | "dialog"
  | "pagination"
  | "header"
  | "main"
  | "footer"
  | "list"
  | "article"
  | "unknown";

/** An accessibility node, joined with what the DOM knows about it. */
export interface IrNode {
  /** The accessibility role, lowercased: "button", "textbox", "link". */
  role: string;
  /** The accessible name, which is usually the visible label. */
  name: string;
  /** The DOM `id`, when there is one. */
  id?: string | undefined;
  /** `data-testid` and its common spellings, when present. */
  testId?: string | undefined;
  /** The link target, for links. */
  href?: string | undefined;
  /** Live value for a form control, as the accessibility tree reports it. */
  value?: string | undefined;
  /** `checked`, `disabled`, `selected`, `required`, `expanded`, `invalid`. */
  states?: string[] | undefined;
  /** `input`, `password`, `email`, for form controls. */
  inputType?: string | undefined;
  /** The DOM tag, lowercased. Used for section shape and for CSS fallback. */
  tag?: string | undefined;
  /** Nesting depth, for the DOM-depth fallback and for rendering. */
  depth: number;
  /** Index into the flat node list, which is how the tree below refers to it. */
  index: number;
  /** Indices of child nodes. */
  children: number[];
  /** True when the accessibility tree says this node is not rendered. */
  hidden?: boolean | undefined;
  /** The accessible description, when it adds something the name does not. */
  description?: string | undefined;
  /**
   * A form control's placeholder.
   *
   * Carried because it is a second, independent handle on the same element:
   * search boxes routinely have an empty accessible name and a placeholder that
   * says exactly what they are, and the placeholder survives re-renders that
   * change nothing else.
   */
  placeholder?: string | undefined;
  /**
   * The words this node holds, when it is a leaf of prose.
   *
   * Set only for an element whose subtree contains text and nothing else, so a
   * container never carries the sum of its children. This is what lets a view
   * say that a form answered "submitted" rather than only describing its
   * controls, which is the difference between a model that can act and a model
   * that can tell whether acting worked.
   */
  textContent?: string | undefined;
}

/** A compiled section: a region of the page a person would name. */
export interface IrSection {
  /** Stable across revisions: "s3". */
  id: string;
  kind: SectionKind;
  /** The human label: "Application", "Results". */
  label: string;
  /** One line, cheap, always sent: "form, 6 fields, Apply, Cancel". */
  summary: string;
  /** The element ids in this section, in document order. */
  elements: string[];
  /** The heading text that identified this section, when there was one. */
  heading?: string | undefined;
  /**
   * The identity this section was matched on, carried so the next revision can
   * match it again.
   *
   * It is stored rather than recomputed because `label` is not stable: a
   * duplicate label gets rewritten for the model's benefit after ids are
   * assigned, and re-deriving the fingerprint from the rewritten label would
   * fail to match the next revision's cut and hand every section a new id on
   * every compile.
   */
  fingerprint: string;
  /** Set when this section is the same as one in the previous revision. */
  unchanged?: boolean | undefined;
  /** How many hidden fields this section carries, so the model knows they exist. */
  hiddenCount?: number | undefined;
  /**
   * The repeated rows inside this section, when it is a list of the same thing.
   *
   * Present only when grouping fired. A feed of thirty stories is one section
   * with thirty items, not thirty sections: the model needs to know the page has
   * a list and be able to address the fourth row, and it does not need the word
   * "List" printed thirty times.
   */
  items?: IrItem[] | undefined;
  /**
   * Text the section holds, in document order, deduplicated.
   *
   * What the page *says* rather than what it offers. A form of six fields and
   * the line "Invalid password" are the same section to the compiler and two
   * very different things to the model, and without this the second was
   * invisible: every control compiled, and the sentence explaining why the last
   * action did not work did not.
   *
   * Not elements, because prose is not a target. It has no locator worth
   * printing and nothing to click, and giving it an element id would put a
   * paragraph in the same list as the buttons and invite the model to pick it.
   */
  prose?: string[] | undefined;
}

/** One row of a repeated section. */
export interface IrItem {
  /** Addressable as "s1:r3". Stable within a revision, positional by nature. */
  id: string;
  /** What distinguishes this row: its heading, or its first named element. */
  label: string;
  /** The element ids in this row, in document order. */
  elements: string[];
}

/**
 * The structured form of a locator.
 *
 * Carried alongside the expression because the expression is *source code*, not
 * a selector: `getByRole("button",{name:"Apply"})` is what the model pastes into
 * a program, and it is not something `page.locator()` accepts. Reaper resolves
 * the element internally from this structured form instead of re-parsing the
 * string, which is how the expression and the thing Reaper actually clicks stay
 * the same element by construction rather than by agreement.
 */
export type LocatorBy =
  | { kind: "role"; role: string; name: string; exact?: boolean | undefined }
  | { kind: "testid"; value: string }
  | { kind: "label"; value: string }
  | { kind: "placeholder"; value: string }
  | { kind: "text"; value: string; exact?: boolean | undefined }
  | { kind: "css"; value: string };

/** A scored locator candidate. */
export interface IrLocator {
  /** Ready to paste into a Playwright program. This is code, not a selector. */
  expression: string;
  /** Higher is better. See `scoreLocators`. */
  score: number;
  /** Why this rank, for `inspect` and for debugging a stale match. */
  strategy: "role+name" | "testid" | "label" | "placeholder" | "text" | "css";
  /** The same locator in a form Reaper can resolve without evaluating source. */
  by: LocatorBy;
  /**
   * True only when this locator was checked against the live page and matched
   * exactly one element.
   *
   * Everything the compiler produces is unverified, and saying so is the point.
   * A locator derived from the accessibility tree is a true statement about what
   * the page contains ("there is a button named Apply") but not a promise that
   * it is unique, and on a real page it often is not: the same "Apply" appears
   * in every row of a table. Presenting an unverified locator as if it were
   * certain is how an agent clicks the wrong row and reports success, so the
   * flag is carried to the model rather than hidden.
   */
  verified: boolean;
}

/** A compiled element. */
export interface IrElement {
  /** Stable across revisions: "e31". */
  id: string;
  role: string;
  name: string;
  /** The live value, for a form control. */
  value?: string | undefined;
  states: string[];
  inputType?: string | undefined;
  href?: string | undefined;
  /** The section element id this belongs to. */
  section: string;
  /** Best first. `preferred` is `locators[0]`. */
  locators: IrLocator[];
  /** True when relevance ranking collapsed this element's detail. */
  stub?: boolean | undefined;
  /**
   * True when this exists in the DOM but is not rendered.
   *
   * Kept rather than dropped, because a hidden field is usually load-bearing: a
   * CSRF token, a cart id, the next step of a wizard that is already in the
   * markup but not yet shown. Dropping them is the silent-coverage failure the
   * whole design is against: the model would not know the form carries state,
   * and would not know a later step exists at all.
   *
   * A hidden element is never *actionable*, so it never counts toward a
   * section's action count and is never offered as a target. It is reported so
   * the model knows it is there.
   */
  hidden?: boolean | undefined;
  /** Why it is hidden, when the browser could say. */
  hiddenBecause?: string | undefined;
}

/**
 * What the compiler can and cannot vouch for.
 *
 * This exists because of the failure it was written in response to. A compile
 * that produced zero sections was indistinguishable from a page that genuinely
 * has nothing on it, and those two facts call for opposite actions: the first
 * means try again or escalate, the second means stop. A model handed "0
 * sections" reads it as the second and concludes the page is empty, which is
 * the exact thing the whole design is against: Reaper must never let the model
 * believe its view is complete or current when it cannot prove that it is.
 *
 * So an empty compile says which kind of empty it is.
 */
export interface IrCoverage {
  /** How much the browser reported, before any filtering. */
  counts: { rawNodes: number; axNodes: number; candidates: number; visible: number; listenerProbed: number };
  /** Frames seen and frames whose contents were read. */
  frames: { total: number; read: number; unread?: string[] | undefined };
  /** True when the page was read well enough to trust a negative. */
  complete: boolean;
  /**
   * Why coverage is not complete, in a sentence the model can act on. Absent
   * when `complete` is true.
   */
  incompleteBecause?: string | undefined;
}

export interface BrowserIR {
  url: string;
  title: string;
  /** Increments with each compile, so two views are distinguishable. */
  revision: number;
  sections: IrSection[];
  elements: Map<string, IrElement>;
  /** Section ids in document order. */
  order: string[];
  coverage: IrCoverage;
}

/**
 * Below this many accessibility nodes, a page that produced no sections is
 * treated as unread.
 *
 * A page with a handful of accessible nodes really does exist, so the threshold
 * is low. What it catches is the shape the sweep found on
 * stackoverflow.com/questions: 74 raw DOM nodes, two accessibility nodes, no
 * sections. Real markup, nothing readable.
 *
 * The count alone is not enough on a small page, which is why the ratio below
 * is checked too: 3 accessibility nodes out of 3 DOM nodes is a tiny page and
 * fine, while 3 out of 74 is a page that did not render.
 */
const MIN_TRUSTWORTHY_AX_NODES = 5;

/** Share of the DOM that must reach the accessibility tree to call a read real. */
const MIN_AX_COVERAGE_RATIO = 0.1;

/* ------------------------------------------------------------------ *
 * Section detection
 * ------------------------------------------------------------------ */

/**
 * Roles that are landmarks, in the order they should win.
 *
 * Landmarks first because they are the only structure the page actually
 * declares. Everything below this is inference, and inference should not
 * override a page that said what it meant.
 */
const LANDMARK_KINDS: Record<string, SectionKind> = {
  navigation: "navigation",
  search: "search",
  main: "main",
  banner: "header",
  contentinfo: "footer",
  form: "form",
  dialog: "dialog",
  alertdialog: "dialog",
  complementary: "unknown",
  region: "unknown",
  article: "article",
  list: "list",
  table: "results",
  tabpanel: "unknown",
};

/**
 * Roles that are content rather than structure.
 *
 * A section made only of these is not a section: a heading and a paragraph on
 * their own are the page's text, not a region of it. They join whatever
 * landmark encloses them, and a page with no landmarks at all falls back to the
 * DOM-depth rule instead of producing one section per paragraph.
 */
const CONTENT_ROLES = new Set([
  "heading",
  "paragraph",
  "statictext",
  "text",
  "inlinetextbox",
  "labeltext",
  "image",
  "strong",
  "emphasis",
  "code",
  "blockquote",
  "listitem",
  "term",
  "definition",
  "caption",
  "figure",
  "time",
  "separator",
  "note",
  "mark",
  "subscript",
  "superscript",
  "deletion",
  "insertion",
]);

/** Roles a person can act on, which is what an element in the IR is. */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "treeitem",
  "gridcell",
  "cell",
  "columnheader",
  "rowheader",
  "img",
  "figure",
  "video",
  "audio",
  "progressbar",
  "scrollbar",
  "textbox",
]);

/**
 * Whether this node starts a section.
 *
 * A landmark always does. A generic container does when it is shaped like one
 * of the things people look for and the page did not name: a container holding a
 * heading and repeated siblings is a list of results, a run of links with
 * numeric text is pagination. That inference is what stops a div-built site from
 * compiling to a single undifferentiated section.
 */
export function opensSection(node: IrNode, nodes: IrNode[]): SectionKind | undefined {
  const landmark = LANDMARK_KINDS[node.role];
  if (landmark !== undefined && node.role !== "region" && node.role !== "complementary") {
    /*
     * An unnamed list is not a results section; it is a list of items inside one.
     * Named, it is a landmark worth its own section, which is the `aria-label`
     * pattern every component library emits.
     */
    if (node.role === "list" && !node.name) return undefined;
    /*
     * A table is a section when it reads like a list, not when it has a name.
     *
     * The guard here was "unnamed and no heading, so it is a layout table",
     * written to stop a page-shell `<table>` becoming a section. Hacker News
     * then exposed it: its page shell is a three-cell layout table, and its
     * entire story list is *also* an unnamed table with no heading. The guard
     * rejected both, so ninety-two rows of one list were cut one at a time and
     * the page compiled to sixty-two sections.
     *
     * Name and heading are the wrong questions for a table. The right one is
     * whether its rows are the same kind of thing repeated, which is the same
     * test every other container gets. A layout table has three cells that look
     * nothing alike; a list table has thirty rows that do.
     */
    if (node.role === "table" && !node.name && !hasHeadingChild(node, nodes)) {
      const rows = node.children.map((index) => nodes[index]).filter((child): child is IrNode => child !== undefined);
      if (repeatedChildShape(rows, nodes) < 3) return undefined;
    }
    return landmark;
  }
  // A named region or complementary is a landmark the page declared; unnamed it
  // is a layout wrapper and gets judged by shape like any other container.
  if ((node.role === "region" || node.role === "complementary") && node.name) return "unknown";

  return inferredSectionKind(node, nodes);
}

function hasHeadingChild(node: IrNode, nodes: IrNode[]): boolean {
  return descendants(node, nodes).some((child) => child.role === "heading");
}

/** Every descendant, depth first. */
export function descendants(node: IrNode, nodes: IrNode[]): IrNode[] {
  const out: IrNode[] = [];
  const stack = [...node.children];
  while (stack.length > 0) {
    const index = stack.pop()!;
    const child = nodes[index];
    if (!child) continue;
    out.push(child);
    stack.push(...child.children);
  }
  return out;
}

/**
 * The shape rules, in priority order.
 *
 * Each is something a person would recognise from looking at the page, written
 * as the smallest test that catches it without catching ordinary layout.
 */
function inferredSectionKind(node: IrNode, nodes: IrNode[]): SectionKind | undefined {
  if (CONTENT_ROLES.has(node.role)) return undefined;
  const kids = node.children.map((index) => nodes[index]).filter((child): child is IrNode => child !== undefined);
  if (kids.length === 0) return undefined;

  const kidsDescendants = descendants(node, nodes);

  /*
   * Pagination: a container whose links are mostly numbers, or "next"/"previous".
   * Checked before results because a pagination strip often sits inside the
   * results container and the inner match is the more specific one.
   */
  const links = kidsDescendants.filter((child) => child.role === "link");
  if (links.length >= 3) {
    const paginationish = links.filter((link) => /^\d+$/.test(link.name.trim()) || /^(next|previous|prev|next page|older|newer)\b/i.test(link.name.trim()));
    if (paginationish.length >= Math.max(3, links.length * 0.6)) return "pagination";
  }

  /*
   * Search: a text input and a submit control in the same container, with no
   * form around them. A real `<form>` is caught by its landmark role first.
   */
  const inputs = kidsDescendants.filter((child) => child.role === "textbox" || child.role === "searchbox");
  const buttons = kidsDescendants.filter((child) => child.role === "button");
  if (inputs.length > 0 && (buttons.length > 0 || inputs.some((input) => input.role === "searchbox"))) {
    if (inputs.length <= 2 && kidsDescendants.length < 25) return "search";
  }

  /*
   * Results or list: repeated siblings of the same shape, each carrying
   * something actionable. This is the rule that catches a job board, a search
   * page and a feed, which share this shape and nothing else.
   */
  const repeated = repeatedChildShape(kids, nodes);
  if (repeated >= 3 && links.length >= 2) return "results";
  if (repeated >= 3) return "list";

  /*
   * A product or detail block: a heading plus a price-like or specification-like
   * run of text, or a heading plus one prominent action.
   */
  if (hasHeadingChild(node, nodes) && (buttons.length > 0 || links.length > 0)) {
    if (kidsDescendants.some((child) => child.role === "paragraph" && /\$|€|£|\d+[.,]\d{2}|\bper\b|\/mo\b/i.test(child.name + (child.value ?? "")))) {
      return "product";
    }
  }

  return undefined;
}

/**
 * How many children share a shape.
 *
 * Shape is role sequence, which is coarse on purpose: three list items whose
 * inner text differs are still three of the same thing, and comparing text
 * would make every item unique and the rule never fire.
 */
function repeatedChildShape(children: IrNode[], nodes: IrNode[]): number {
  const shapes = new Map<string, number>();
  for (const child of children) {
    /*
     * Role, and whether the row holds anything to act on.
     *
     * The child *count* was part of this key and that is why Hacker News
     * compiled to thirty sections. Its table alternates between a title row
     * with three cells and a score row with two, so the rows grouped as
     * `row:3` and `row:2` and neither reached the count the rule needs. The
     * page is one list of thirty stories and the rule could not see it.
     *
     * Counting cells is the wrong question. A row of story titles and a row of
     * story scores are the same kind of thing: both are `row`s. What
     * distinguishes a list from a header is the role and whether the rows are
     * actionable, not how many cells each happens to have.
     */
    /*
     * Resolved against the page's node list, not against the sibling array.
     *
     * `descendants(child, children)` was the first version and it is a
     * type-shaped lie: `children` is a list of rows, and `descendants` indexes
     * into whatever it is handed, so it walked a different subtree for every row
     * and reported actionability that had nothing to do with the row it was
     * asked about. On the Hacker News shape that made the score row look
     * actionable, which is exactly the half the row-pairing rule reads.
     */
    const key = `${child.role}:${isInteractive(child) || descendants(child, nodes).some((n) => isInteractive(n)) ? "actionable" : "text"}`;
    shapes.set(key, (shapes.get(key) ?? 0) + 1);
  }
  let best = 0;
  for (const count of shapes.values()) best = Math.max(best, count);
  return best;
}

/* ------------------------------------------------------------------ *
 * Stable identity
 * ------------------------------------------------------------------ */

/**
 * How an element is recognised across a re-render.
 *
 * The id has to survive the page changing around it, because `inspect("e31")`
 * is only meaningful if `e31` is the same element two revisions later. A DOM
 * index does not survive, a `ref=e31` from the snapshot does not survive, and an
 * id attribute usually does but is frequently absent or generated per render.
 *
 * So the fingerprint is what a person would use to say "that button": its role
 * and its name, with the section it lives in to disambiguate two "Cancel"
 * buttons. Values are excluded because they change as the model types, and
 * including them would rename the element on every keystroke and break every
 * reference to it.
 */
export function elementFingerprint(element: { role: string; name: string; section: string; href?: string | undefined }): string {
  /*
   * An href is part of the identity for a link, because "View" appears ten times
   * on a results page and the destination is what distinguishes them. It is
   * normalised to the path so a session id in a query string does not rename the
   * element on every render.
   */
  const href = element.href ? normaliseHref(element.href) : "";
  return [element.role, normaliseName(element.name), element.section, href].join("|");
}

/** The section's own identity across revisions. */
export function sectionFingerprint(section: { kind: SectionKind; label: string; heading?: string | undefined }): string {
  return [section.kind, normaliseName(section.heading ?? section.label)].join("|");
}

/**
 * Names are compared without the parts that change.
 *
 * A count in a button ("Cart (3)") changes on every add and would rename the
 * element, so trailing counts come off. Whitespace is collapsed because the
 * accessibility tree sometimes carries the line breaks of the source.
 */
function normaliseName(name: string): string {
  return name.replace(/\s+/g, " ").replace(/\s*\(\d+\)\s*$/, "").trim().toLowerCase();
}

/**
 * The path of a URL, without the query or the fragment.
 *
 * A query string carries session ids, tracking parameters and pagination state,
 * all of which change while the destination does not. Two links to
 * `/jobs/1?s=abc` and `/jobs/1?s=def` are the same link.
 */
function normaliseHref(href: string): string {
  try {
    const url = new URL(href, "https://x.invalid");
    return url.pathname;
  } catch {
    return href.split("?")[0]!.split("#")[0]!;
  }
}

/**
 * Assign ids, reusing the previous revision's where the identity matches.
 *
 * This is the whole mechanism behind "a section keeps its id across a
 * re-render". The previous revision's fingerprints are indexed, and a new node
 * that fingerprints to one already in the index takes that id. Anything new
 * takes the next free number.
 *
 * Numbers are not reused within a revision run even after an element
 * disappears, which is deliberate: a model holding "e31" from before must not
 * find it pointing at a different button two revisions later. A stale id is
 * better than a wrong one.
 */
export function assignIds<T extends { fingerprint: string }>(
  items: T[],
  previous: Map<string, string>,
  prefix: string,
  nextNumber: { value: number },
): { ids: string[]; current: Map<string, string>; nextNumber: number } {
  const ids: string[] = [];
  const current = new Map<string, string>();
  let number = nextNumber.value;

  for (const item of items) {
    const existing = previous.get(item.fingerprint);
    if (existing !== undefined && !current.has(item.fingerprint)) {
      ids.push(existing);
      current.set(item.fingerprint, existing);
      continue;
    }
    /*
     * A duplicate fingerprint within one revision still needs a distinct id, so
     * the second one takes a fresh number. Two buttons with the same role, name
     * and section are genuinely ambiguous, and the locator scorer says so rather
     * than pretending one of them is the one.
     */
    const id = `${prefix}${++number}`;
    ids.push(id);
    if (!current.has(item.fingerprint)) current.set(item.fingerprint, id);
  }

  return { ids, current, nextNumber: number };
}

/* ------------------------------------------------------------------ *
 * Relevance
 * ------------------------------------------------------------------ */

/**
 * How much a section matters to the current step.
 *
 * Ranked, never used to remove something's existence. The rule the design
 * settled on: relevance reorders and collapses detail, but a low-relevance
 * element still appears, because a silently hidden button is invisible when it
 * happens and the model cannot even ask about what it does not know is there.
 *
 * The scoring is deliberately crude and deliberately explainable. It is not a
 * model call and it does not try to be clever: a section holding the form the
 * step names beats a navigation bar, and a section holding a blocker beats
 * everything.
 */
export function relevanceScore(section: IrSection, context: { step?: string | undefined; goal?: string | undefined; blockers?: string[] }): number {
  let score = 0;
  const text = `${section.label} ${section.heading ?? ""} ${section.summary}`.toLowerCase();
  const step = context.step?.toLowerCase() ?? "";
  const goal = context.goal?.toLowerCase() ?? "";

  /*
   * A blocker lives wherever the problem is, so its section is the one to look at.
   *
   * Matched on the blocker's distinctive words rather than on the whole phrase,
   * because a section's text is its label and its summary and will never contain
   * a sentence. "CAPTCHA on Results" has to find the section labelled "Results",
   * which means looking for "captcha" and "results" separately. Words of four
   * characters or fewer are dropped: they are prepositions and articles, and
   * "on" matches almost every section on the page.
   */
  for (const blocker of context.blockers ?? []) {
    const words = blocker.toLowerCase().split(/\W+/).filter((word) => word.length > 4);
    if (words.length > 0 && words.some((word) => text.includes(word))) score += 100;
  }

  /*
   * The step is the strongest signal available, because the model's own
   * statement of where it is beats any inference from the page.
   */
  if (step.length > 2) {
    const stepWords = step.split(/\W+/).filter((word) => word.length > 3);
    for (const word of stepWords) if (text.includes(word)) score += 12;
  }
  if (goal.length > 2) {
    const goalWords = goal.split(/\W+/).filter((word) => word.length > 4);
    for (const word of goalWords) if (text.includes(word)) score += 3;
  }

  // A kind that carries the work outranks one that frames it.
  if (section.kind === "form" || section.kind === "dialog") score += 20;
  if (section.kind === "search" || section.kind === "results") score += 10;
  if (section.kind === "product" || section.kind === "article") score += 8;
  // Navigation and footers are almost never the thing the current step touches.
  if (section.kind === "navigation" || section.kind === "header" || section.kind === "footer") score -= 15;
  if (section.kind === "pagination") score -= 5;

  // A section with nothing to act on is less likely to be the step.
  if (section.elements.length === 0) score -= 10;
  return score;
}

/* ------------------------------------------------------------------ *
 * The compile
 * ------------------------------------------------------------------ */

export interface CompileInput {
  url: string;
  title: string;
  /** The flat accessibility node list, joined with DOM attributes. */
  nodes: IrNode[];
  /** The root node's index. */
  root: number;
  /** What the browser reported, so an empty compile can explain itself. */
  coverage?: IrCoverage | undefined;
}

export interface CompileOptions {
  /** The previous compile, for id reuse. */
  previous?: BrowserIR | undefined;
  /** What the model is doing, for relevance ranking. */
  context?: { step?: string | undefined; goal?: string | undefined; blockers?: string[] } | undefined;
  /** Sections scoring at or above this keep full detail. */
  detailThreshold?: number;
}

/** Sections scoring below this render their elements as stubs. */
export const DETAIL_THRESHOLD = 0;

/**
 * How many prose leaves one section carries.
 *
 * Bounded because a page can hold a novel and the view has a character budget.
 * The first few in document order are where the page's answers are: a status
 * line, an error, a result count. A section that needs more than this is a
 * content page, and a content page the model should read with a scoped view or
 * a program rather than through the summary.
 */
export const MAX_PROSE_PER_SECTION = 8;

/**
 * Compile a page into the IR.
 *
 * Deterministic: the same input compiles to the same output, which is what makes
 * the diff between two revisions meaningful. Nothing here reads the clock, the
 * network or a random number.
 */
export function compileIr(input: CompileInput, options: CompileOptions = {}): BrowserIR {
  const { nodes, root } = input;
  const rootNode = nodes[root];
  const coverage = input.coverage ?? { counts: { rawNodes: 0, axNodes: 0, candidates: 0, visible: 0, listenerProbed: 0 }, frames: { total: 0, read: 0 }, complete: true };
  if (!rootNode) {
    return {
      url: input.url,
      title: input.title,
      revision: (options.previous?.revision ?? 0) + 1,
      sections: [],
      elements: new Map(),
      order: [],
      coverage: { ...coverage, complete: false, incompleteBecause: "the page produced no node tree to read" },
    };
  }

  /*
   * Whether each node has a section shape, and how many actionable elements it
   * holds that no nested section already claims.
   *
   * Computed bottom-up before any section is cut, because the cutting rule needs
   * a fact that does not exist yet at the moment it is asked: whether the section
   * currently being descended into has anything of its own. Walking top-down and
   * asking "does this have elements" gets the wrong answer every time, because
   * the children have not been visited.
   *
   * A node that shapes like a section is subtracted from its parent entirely,
   * since its elements are going to become its own section's. That leaves
   * `ownElements` answering exactly the question the cut rule needs: does this
   * node hold anything except the sections nested inside it.
   */
  const shapeOf = new Map<number, SectionKind | undefined>();
  const ownElements = new Map<number, number>();
  const measure = (node: IrNode): number => {
    /*
     * A hidden subtree contributes nothing actionable and opens no section: an
     * invisible `div` is not a region the model can work in. It is still walked,
     * because a hidden field inside it is a fact the model needs, and the
     * element collection below keeps those separately.
     */
    if (node.hidden) {
      ownElements.set(node.index, 0);
      shapeOf.set(node.index, undefined);
      return 0;
    }
    const kind = opensSection(node, nodes);
    shapeOf.set(node.index, kind);

    let own = isInteractive(node) ? 1 : 0;
    for (const childIndex of node.children) {
      const child = nodes[childIndex];
      if (!child) continue;
      const childTotal = measure(child);
      // A child that shapes like a section is going to be its own; its elements
      // belong to it and not to this node.
      if (shapeOf.get(childIndex) === undefined) own += childTotal;
    }
    ownElements.set(node.index, own);
    return own;
  };
  measure(rootNode);

  /*
   * Sections are cut in a second, top-down pass. A node opens one when it has a
   * shape and either it is a landmark, nothing is open around it, or the section
   * it would join is an empty container.
   */
  const cuts: Array<{
    roots: IrNode[];
    kind: SectionKind;
    label: string;
    heading?: string | undefined;
    /**
     * When grouping merged a run of repeated siblings, the original roots, one
     * entry per row. Absent on an ordinary section.
     */
    itemRoots?: IrNode[][] | undefined;
  }> = [];
  const seen = new Set<number>();
  /** How many elements the section currently open has of its own, by cut index. */
  let enclosingCut: number | undefined;
  const walk = (node: IrNode, insideSection: boolean, isRoot: boolean): void => {
    if (seen.has(node.index)) return;
    seen.add(node.index);
    /*
     * A hidden node never opens a section, but its children are still walked so
     * a hidden form's fields are reached and attributed to whatever section
     * encloses them.
     */
    if (node.hidden) {
      for (const child of node.children) walk(nodes[child]!, insideSection, false);
      return;
    }

    /*
     * The root is never a section. It is the page, and making it one produces a
     * section containing every other section, which the shape rules happily do:
     * a page with three top-level divs reads as a list of three.
     */
    const found = isRoot ? undefined : opensSection(node, nodes);
    const isLandmark = found !== undefined && LANDMARK_KINDS[node.role] !== undefined;

    /*
     * When to open a new section, given one may already be open.
     *
     *   - Not inside a section yet: always.
     *   - This is a landmark: always. A `form` inside a `main` is its own thing.
     *   - This is an *inferred* shape and the enclosing section is empty: yes.
     *
     * That last rule is what stops a `main` wrapping a pagination strip or a
     * results list from swallowing it whole. The enclosing landmark holds no
     * elements of its own, so the inferred section inside it is the only thing
     * there is to see, and suppressing it would leave the model with a section
     * called "Main" containing everything and describing nothing.
     *
     * The reason inferred shapes are suppressed at all is the opposite case: a
     * results list whose rows each look like a results list. There the enclosing
     * section has elements, and cutting at every nested shape would produce a
     * section per row.
     */
    const enclosingIsEmpty =
      enclosingCut !== undefined && (ownElements.get(cuts[enclosingCut]!.roots[0]!.index) ?? 0) === 0;

    /*
     * An inferred shape does not cut inside an inferred shape.
     *
     * This is the rule Hacker News needed, and it cost thirty sections to find.
     * Its markup is one large table, so a `td` holding four links infers as
     * `results` on its own. The enclosing `tr` had inferred the same, and the
     * enclosing container held nothing of its own, so `enclosingIsEmpty` was
     * true all the way down and every cell cut. The page compiled to thirty
     * identically-shaped sections instead of one list of thirty rows.
     *
     * A *landmark* cutting inside another section is right: a `form` inside a
     * `main` is its own thing, because the page declared it. An inferred shape
     * doing so is not, because nothing was declared; two guesses about the same
     * region should not both become sections. The outer guess wins, and the
     * inner ones become the rows of its list.
     */
    const enclosingIsInferred = enclosingCut !== undefined && LANDMARK_KINDS[cuts[enclosingCut]!.roots[0]!.role] === undefined;
    const opensHere = found !== undefined && (!insideSection || isLandmark || (enclosingIsEmpty && !enclosingIsInferred));

    if (opensHere) {
      const previousCut = enclosingCut;
      cuts.push({ roots: [node], kind: found, label: labelFor(node, found), heading: headingOf(node, nodes) });
      enclosingCut = cuts.length - 1;
      for (const child of node.children) walk(nodes[child]!, true, false);
      enclosingCut = previousCut;
      return;
    }
    for (const child of node.children) walk(nodes[child]!, insideSection, false);
  };
  walk(rootNode, false, true);

  /*
   * The fallback: a page with no landmarks and no recognisable shape still has
   * structure, and the top-level blocks are the best available approximation.
   *
   * The first version of this made one section per top-level child, which on a
   * content page is wrong in a way that shows immediately: example.com's
   * heading, its paragraph and its link became three sections, two of them
   * labelled "Section" and holding nothing. A page with no structure should
   * compile to *one* section, not one per node.
   *
   * So the children are grouped. A child that is a substantial block of its own
   * (two or more things to act on, or enough children to be a block) starts a
   * section; everything else accumulates into the section around it. A page that
   * is all content therefore produces exactly one section, and a page built from
   * three cards produces three.
   */
  if (cuts.length === 0) {
    const substantial = (node: IrNode): boolean =>
      descendants(node, nodes).filter((child) => isInteractive(child)).length >= 2 || node.children.length >= 4;

    let group: IrNode[] = [];
    const flush = (): void => {
      if (group.length === 0) return;
      // The group's label comes from any heading in it, which is what a person
      // would name the region after.
      const heading = group.map((node) => headingOf(node, nodes)).find((value) => value !== undefined);
      cuts.push({
        roots: group,
        kind: "unknown",
        label: heading ?? group.map((node) => node.name).find((name) => name.length > 0) ?? "Page",
        heading,
      });
      group = [];
    };

    for (const childIndex of rootNode.children) {
      const child = nodes[childIndex];
      if (!child || child.hidden) continue;
      if (substantial(child)) {
        flush();
        cuts.push({ roots: [child], kind: "unknown", label: labelFor(child, "unknown"), heading: headingOf(child, nodes) });
        continue;
      }
      group.push(child);
    }
    flush();
  }

  groupRepeatedCuts(cuts, nodes);
  splitRepeatedRows(cuts, nodes);

  /* ---- sections get ids, reusing the previous revision's where they match ---- */
  const previousSections = new Map<string, string>();
  for (const section of options.previous?.sections ?? []) {
    previousSections.set(section.fingerprint, section.id);
  }
  const sectionNumbers = { value: maxNumbered(options.previous?.sections.map((section) => section.id) ?? [], "s") };
  /*
   * A fingerprint has to be unique within the revision, or two cuts claim the
   * same identity and neither keeps its id.
   *
   * That happened, and the symptom was subtle enough to be worth recording: a
   * page with a container whose rows all shaped as "Results" produced two cuts
   * fingerprinting to `results|results`. The first took the id and the second
   * was renumbered, so on the next compile the renumbered one matched the
   * fingerprint the *other* had just released, and every section changed id on
   * every observation. A model holding `s2` would find it pointing at a
   * different region one compile later.
   *
   * The discriminator is the occurrence number of that fingerprint within the
   * revision, which is stable as long as the page's shape is, and a page whose
   * shape changed has genuinely earned a reshuffle.
   */
  const seenFingerprints = new Map<string, number>();
  const cutFingerprints = cuts.map((cut) => {
    const base = sectionFingerprint({ kind: cut.kind, label: cut.label, heading: cut.heading });
    const occurrence = (seenFingerprints.get(base) ?? 0) + 1;
    seenFingerprints.set(base, occurrence);
    return occurrence === 1 ? base : `${base}#${occurrence}`;
  });
  const sectionAssigned = assignIds(
    cuts.map((cut, index) => ({ ...cut, fingerprint: cutFingerprints[index]! })),
    previousSections,
    "s",
    sectionNumbers,
  );

  /* ---- elements ---- */
  const elementNumbers = { value: maxNumbered([...(options.previous?.elements.keys() ?? [])], "e") };
  /*
   * Hidden fields get their own id sequence with an `h` prefix, so an
   * `e`-prefixed id in a model's notes can never accidentally resolve to
   * something it cannot click, and an `h` immediately reads as "reported, not
   * actionable".
   */
  const hiddenNumbers = { value: maxNumbered([...(options.previous?.elements.keys() ?? [])], "h") };
  /*
   * Deliberately NOT a list declared out here.
   *
   * It was, and the bug it caused was a section reporting hidden fields that
   * belonged to a different section: the array accumulated across the whole
   * compile, so `main`, which holds no hidden field at all, reported the form's
   * two. A count is per-section by definition, so each cut counts its own.
   */
  const previousElements = new Map<string, string>();
  for (const [id, element] of options.previous?.elements ?? []) {
    previousElements.set(elementFingerprint(element), id);
  }

  const sections: IrSection[] = [];
  const elements = new Map<string, IrElement>();

  cuts.forEach((cut, index) => {
    const id = sectionAssigned.ids[index]!;
    const fingerprint = cutFingerprints[index]!;
    const previousId = previousSections.get(fingerprint);

    /*
     * Every actionable node inside this cut, minus anything a nested landmark
     * section owns.
     *
     * The nested boundary is checked on the way in rather than on the way out,
     * so a `form` inside this cut is skipped along with everything under it and
     * its elements go to the form's own section instead of appearing twice.
     */
    const owned: IrNode[] = [];
    /** Hidden but real: collected and marked, never offered as a target. */
    const hiddenOwned: IrNode[] = [];
    /**
     * The prose this section holds, in document order.
     *
     * Text and not elements, because prose is not something to act on. It is
     * what the page says, which is a different fact from what the page offers,
     * and collapsing the two is how a model ends up with a list of buttons and
     * no idea whether the last one worked.
     */
    const prose: string[] = [];
    /*
     * Every node that became a section in its own right, which is where this
     * cut's claim to nested elements stops.
     *
     * Indexed up front rather than tested with `opensSection` inside the walk:
     * the shape rules are pure but not free, and the walk visits every node in
     * the subtree.
     */
    const cutRoots = new Set(cuts.flatMap((other) => other.roots.map((root) => root.index)));
    const collect = (node: IrNode, isRoot: boolean): void => {
      /*
       * Hidden nodes are collected, not skipped.
       *
       * A hidden field is usually load-bearing: a CSRF token, a cart id, the
       * next step of a wizard already in the markup. Dropping it is the silent
       * coverage failure this whole design is against, because the model cannot
       * miss what it was never told about. It is collected and marked, and the
       * `owned` list below separates the two kinds so a hidden field is never
       * offered as something to click.
       *
       * The walk continues into a hidden subtree for the same reason: a hidden
       * container usually holds the hidden fields, not nothing.
       */
      if (node.hidden) {
        if (isInteractive(node)) hiddenOwned.push(node);
        for (const child of node.children) {
          const childNode = nodes[child];
          if (childNode) collect(childNode, false);
        }
        return;
      }
      /*
       * A paragraph with no accessible name is a text node the AX tree reported
       * as a paragraph, and it is not something a person acts on. Skipping the
       * node is wrong though: a link nested in a paragraph is the most common
       * shape on the web ("Learn more" inside a `<p>`), and returning early
       * would drop it. So the node is passed over and its children are still
       * walked.
       */
      /*
       * A node that became its own section is a boundary, whatever kind it is.
       *
       * The first version of this checked only for a *landmark* shape, on the
       * reasoning that landmarks are the declared structure. That is wrong when
       * the nested shape is inferred, which is the common case on a
       * div-built site: the rows of Hacker News each infer as "results", so the
       * container above them collected all thirty rows' links as its own. It
       * then looked non-empty, which stopped the "a container holding nothing
       * but sections is not a section" rule from dropping it, and the page
       * compiled to two sections both called "Results".
       */
      if (!isRoot && cutRoots.has(node.index)) return;
      if (isInteractive(node)) {
        owned.push(node);
      } else if (node.textContent !== undefined && node.textContent !== node.name) {
        /*
         * A leaf of prose, kept as text rather than as an element.
         *
         * It is not a target: there is nothing to click and no locator worth
         * printing. But it is often the most important thing on the page after
         * an action, because it is where the page says what happened. "submitted",
         * "Invalid password", "3 results", "Your order could not be placed".
         *
         * The `!== node.name` guard is what stops a node repeating itself: an
         * element whose accessible name is its own text would otherwise appear
         * once as a named element and once as prose.
         */
        if (prose.length < MAX_PROSE_PER_SECTION) prose.push(node.textContent);
      }
      for (const child of node.children) {
        const childNode = nodes[child];
        if (childNode) collect(childNode, false);
      }
    };
    /*
     * Rows are collected before the section's own walk, so each element can be
     * attributed to the row it came from. `owned` is still the flat document
     * order list the rest of the compile expects; `rowOf` just records which row
     * each position belongs to, which is what turns a flat list back into
     * addressable items after ids are assigned.
     */
    const rowOf: Array<number | undefined> = [];
    const rowLabels: string[] = [];
    if (cut.itemRoots) {
      cut.itemRoots.forEach((rowRoots, rowIndex) => {
        const before = owned.length;
        for (const root of rowRoots) collect(root, true);
        while (rowOf.length < owned.length) rowOf.push(rowIndex);
        /*
         * A row's label is its heading when it has one, its first named element
         * otherwise. That is what distinguishes the fourth story from the fifth,
         * and it is the only part of a row the model can use to pick one.
         */
        const heading = rowRoots.map((root) => headingOf(root, nodes)).find((value) => value !== undefined);
        rowLabels.push(heading ?? distinguishingName(owned.slice(before)) ?? `Item ${rowIndex + 1}`);
      });
    } else {
      // `roots` holds nodes, not indices: a fallback group is several top-level
      // nodes that together make one section.
      for (const root of cut.roots) collect(root, true);
    }

    const assigned = assignIds(
      owned.map((node) => ({
        node,
        fingerprint: elementFingerprint({ role: node.role, name: node.name, section: id, href: node.href }),
      })),
      previousElements,
      "e",
      elementNumbers,
    );
    /*
     * The counter has to be carried forward between sections. `assignIds` is
     * pure and returns the new high-water mark rather than mutating, so without
     * this every section restarts at one and the whole page comes back as a
     * single `e1` repeated, which is worse than no id at all because it looks
     * like an answer.
     */
    elementNumbers.value = assigned.nextNumber;

    const elementIds: string[] = [];
    owned.forEach((node, position) => {
      const elementId = assigned.ids[position]!;
      elementIds.push(elementId);
      elements.set(elementId, {
        id: elementId,
        role: node.role,
        name: node.name,
        value: node.value,
        states: node.states ?? [],
        inputType: node.inputType,
        href: node.href,
        section: id,
        locators: scoreLocators(node),
      });
    });

    /*
     * Hidden fields, marked and kept.
     *
     * They get ids from the same sequence so `inspect` can reach them and a
     * reference stays stable across revisions, but they are deliberately NOT in
     * `section.elements`: that list is what the renderer offers as things to act
     * on, and a hidden input is not one. They are counted separately so the
     * section line can say they exist, and the count belongs to THIS section:
     * it is declared here rather than beside the id counter so a container that
     * holds no hidden field cannot inherit its child's count.
     */
    const thisSectionHiddenIds: string[] = [];
    for (const node of hiddenOwned) {
      const hiddenAssigned = assignIds(
        [{ fingerprint: elementFingerprint({ role: node.role, name: node.name, section: id, href: node.href }) }],
        previousElements,
        "h",
        hiddenNumbers,
      );
      hiddenNumbers.value = hiddenAssigned.nextNumber;
      const elementId = hiddenAssigned.ids[0]!;
      thisSectionHiddenIds.push(elementId);
      elements.set(elementId, {
        id: elementId,
        role: node.role,
        name: node.name,
        value: node.value,
        states: node.states ?? [],
        inputType: node.inputType,
        href: node.href,
        section: id,
        // Deliberately no locators: a hidden element is not a target, and
        // offering one would invite the model to write `getByLabel(...)` against
        // something Playwright will refuse to click.
        locators: [],
        hidden: true,
        ...(node.tag === "input" && node.inputType === "hidden" ? { hiddenBecause: "an input of type hidden" } : {}),
        ...(node.tag !== "input" || node.inputType !== "hidden" ? { hiddenBecause: "not rendered" } : {}),
      });
    }

    /*
     * Rows, built from the row attribution recorded during collection.
     *
     * A row id is positional ("s1:r3") and deliberately not fingerprinted the
     * way section and element ids are. A row's identity IS its position: "the
     * third story" is what the model means, and a feed that reorders has
     * genuinely made the third story a different story. The elements inside it
     * keep their stable ids, so a reference the model took to a specific link
     * still resolves.
     */
    /*
     * Prose that some element in this section already announces is dropped.
     *
     * The duplicate is real and it is not obvious from either side. A
     * `<label for="first">First name</label>` has an empty accessible name of
     * its own, because its text belongs to the input it labels, so the
     * node-level guard in the walk does not catch it. What the model then read
     * was a textbox called "First name" and, three lines down, a bare text line
     * saying "First name" again, which looks like a second field.
     *
     * Checking against the collected elements rather than against a list of tags
     * is deliberate: the same duplication arrives from a `<legend>`, an
     * `<option>`, or a `<div>` a component library put a label in. What matters
     * is whether the words are already spoken for, not what element produced
     * them.
     */
    const spokenFor = new Set(owned.map((node) => node.name).filter((name) => name.length > 0));
    const proseKept = [...new Set(prose)].filter((line) => !spokenFor.has(line));

    const items: IrItem[] = [];
    if (cut.itemRoots) {
      for (let rowIndex = 0; rowIndex < cut.itemRoots.length; rowIndex++) {
        const rowElements = elementIds.filter((_, position) => rowOf[position] === rowIndex);
        if (rowElements.length === 0) continue;
        items.push({ id: `${id}:r${items.length + 1}`, label: rowLabels[rowIndex] ?? `Item ${rowIndex + 1}`, elements: rowElements });
      }
    }

    // A section is unchanged when its id, its label and its element set all match.
    const previousSection = options.previous?.sections.find((section) => section.id === previousId);
    const unchanged = previousSection !== undefined && previousSection.elements.length === elementIds.length;

    const section: IrSection = {
      id,
      kind: cut.kind,
      label: cut.label,
      fingerprint,
      summary: summariseSection(cut.kind, cut.label, owned),
      elements: elementIds,
      heading: cut.heading,
      ...(items.length > 0 ? { items } : {}),
      ...(proseKept.length > 0 ? { prose: proseKept.slice(0, MAX_PROSE_PER_SECTION) } : {}),
      ...(thisSectionHiddenIds.length > 0 ? { hiddenCount: thisSectionHiddenIds.length } : {}),
      ...(unchanged ? { unchanged: true } : {}),
    };
    sections.push(section);
  });

  /*
   * A landmark holding nothing but other sections is a container, not a section.
   *
   * `main` wrapping a `form` and a `list` compiles to three sections, and the
   * empty `main` is noise: it costs a line on every observation and tells the
   * model nothing it cannot see from the two sections inside it. It is only
   * dropped when it has no elements of its own *and* something nested became a
   * section, so a genuinely empty `main` on a blank page is still reported
   * rather than vanishing and leaving the model with nothing.
   */
  const ancestorOf = (parent: IrNode, of: IrNode): boolean => descendants(parent, nodes).some((child) => child.index === of.index);
  const surviving = sections.filter((section, index) => {
    if (section.elements.length > 0) return true;
    /*
     * A container with prose of its own is not an empty container.
     *
     * This is the case that made a form's answer invisible. `<main>` wraps
     * `<form>` and `<p id="result">`, and on this page the submit handler writes
     * "submitted" into that paragraph. The form became a section, the `main` held
     * no elements of its own, and the rule below dropped it, taking the one
     * sentence that says whether the action worked with it. The model could see
     * the button and not the result of pressing it.
     *
     * Prose is content, and a container holding content is a section whatever
     * else is nested inside it.
     */
    if ((section.prose?.length ?? 0) > 0) return true;
    // Empty, and it wraps a section that is not empty: it is a container, not a
    // section, and it costs a line on every observation to say nothing.
    return !cuts.some(
      (other, otherIndex) =>
        otherIndex !== index && cuts[index]!.roots.every((root) => other.roots.some((otherRoot) => ancestorOf(root, otherRoot))),
    );
  });
  const dropped = new Set(sections.filter((section) => !surviving.includes(section)).map((section) => section.id));
  for (const sectionId of dropped) {
    for (const elementId of sections.find((section) => section.id === sectionId)?.elements ?? []) elements.delete(elementId);
  }
  sections.length = 0;
  sections.push(...surviving);

  disambiguateLabels(sections, elements);

  /* ---- relevance: rank, and collapse detail rather than hiding existence ---- */
  const threshold = options.detailThreshold ?? DETAIL_THRESHOLD;
  for (const section of sections) {
    const score = relevanceScore(section, options.context ?? {});
    if (score < threshold) {
      for (const elementId of section.elements) {
        const element = elements.get(elementId);
        if (element) element.stub = true;
      }
    }
  }

  /*
   * Sections are ordered by relevance, not by document position, because the
   * model reads top to bottom and the first section it sees is the one it acts
   * on. Document order is kept in `order` for anything that needs the page's own
   * sequence.
   */
  const order = sections.map((section) => section.id);
  const ranked = [...sections].sort((a, b) => {
    const delta = relevanceScore(b, options.context ?? {}) - relevanceScore(a, options.context ?? {});
    // Ties keep document order, so the ranking is stable and the diff is quiet.
    return delta !== 0 ? delta : order.indexOf(a.id) - order.indexOf(b.id);
  });

  /*
   * The verdict on this read, computed last because it is the one thing that
   * has to account for everything the compile did rather than one rule.
   *
   * An empty result from a page the browser reported almost nothing about is not
   * an empty page, it is a page that was not read. The distinction is the whole
   * point: a model told "0 sections" will conclude the page is blank and give
   * up, when the truth is that it should reload, wait, or escalate.
   */
  const { axNodes, rawNodes } = coverage.counts;
  const thinAxTree = axNodes < MIN_TRUSTWORTHY_AX_NODES || (rawNodes > 0 && axNodes / rawNodes < MIN_AX_COVERAGE_RATIO);
  const readNothing = ranked.length === 0 && thinAxTree;
  /* A frame nobody read is content nobody can see, and its absence is silent. */
  const unreadFrames = coverage.frames.total > coverage.frames.read;
  const incompleteBecause = readNothing
    ? `the browser reported ${coverage.counts.rawNodes} DOM nodes but only ${coverage.counts.axNodes} accessibility nodes, and none of them were actionable, so this is a page that was not read rather than a page with nothing on it`
    : unreadFrames
      ? `${coverage.frames.total - coverage.frames.read} of ${coverage.frames.total} frames could not be read, so content inside them is missing from this view: ${(coverage.frames.unread ?? []).join("; ")}`
      : undefined;

  return {
    url: input.url,
    title: input.title,
    revision: (options.previous?.revision ?? 0) + 1,
    sections: ranked,
    elements,
    order,
    coverage: {
      ...coverage,
      complete: incompleteBecause === undefined,
      ...(incompleteBecause !== undefined ? { incompleteBecause } : {}),
    },
  };
}

/**
 * Split one section's repeated children into rows.
 *
 * The sibling fix to `groupRepeatedCuts`, and the other half of the same
 * problem. Grouping merges *separate cuts* that are rows of one list; this
 * handles a single section that swallowed the whole list, which is what Hacker
 * News became once its table stopped being rejected: 62 sections collapsed to 4,
 * and one of them held 360 elements and described none of them.
 *
 * Both are needed because the section rule can fail in either direction. When it
 * cuts too eagerly, grouping repairs it; when it cuts too little, this does. The
 * shape it looks for is the same one `opensSection` uses to recognise a list in
 * the first place, so a container cannot be a list for one purpose and not the
 * other.
 *
 * Rows become addressable as `s1:r3`, which is what lets a model say "the fourth
 * story" and get one, rather than scrolling a section of three hundred elements
 * looking for it.
 */
function splitRepeatedRows(
  cuts: Array<{ roots: IrNode[]; kind: SectionKind; label: string; heading?: string | undefined; itemRoots?: IrNode[][] | undefined }>,
  nodes: IrNode[],
): void {
  for (const cut of cuts) {
    // A cut that already has rows was merged by grouping; leave it alone.
    if (cut.itemRoots !== undefined) continue;
    const root = cut.roots.length === 1 ? cut.roots[0] : undefined;
    if (!root) continue;

    const children = root.children.map((index) => nodes[index]).filter((child): child is IrNode => child !== undefined);
    /*
     * Three at least, which is the same floor the section rules use. Two
     * repeated children are two elements, not a list, and turning them into rows
     * costs the model a level of indirection to save one line.
     */
    if (children.length < GROUP_MIN_RUN) continue;
    if (repeatedChildShape(children, nodes) < GROUP_MIN_RUN) continue;

    /*
     * A form is never a list of rows.
     *
     * The first version of this split a form into one row per field, which is
     * the exact shape the section rules were written to prevent: "a form is one
     * section rather than one per field" is the oldest test in the file. A form's
     * children look repetitive because a form *is* repetitive; a label, a
     * control, a label, a control. Repetition is not the same as a list, and the
     * declared landmarks are where the difference shows: a page says "this is a
     * form" and it never says "this is a row".
     */
    if (cut.kind === "form" || cut.kind === "search" || cut.kind === "dialog") continue;

    /*
     * And the children have to be alike, which is a stronger test than the
     * shape count alone.
     *
     * A nav holding eight identical links passes the count and is not a list:
     * rows of a list are containers that each hold *several* things, where a
     * strip of links is a run of leaves. Requiring a majority of the children to
     * be containers is what separates "eight links" from "thirty stories".
     */
    const containers = children.filter((child) => child.children.length > 0).length;
    if (containers < children.length * 0.6) continue;

    /*
     * Every child becomes a row, including the ones that do not match the
     * majority shape. A list where the title row and the score row alternate is
     * one list; taking only the majority would drop half the content, and
     * dropping content is the failure this whole layer exists to avoid.
     */
    cut.itemRoots = pairContinuationRows(children, nodes);

    /*
     * The label says how many rows, for the same reason the merged one does.
     *
     * "Results" reads as though the page has a list; "Results (61)" tells the
     * model the list is long enough to need a row reference, which is the fact
     * it would otherwise have to infer by counting. The count is only added when
     * there is not one already, so a label that came from a merge is not counted
     * twice.
     */
    if (!/\(\d+\)$/.test(cut.label)) cut.label = `${cut.label} (${children.length})`;
  }
}

/**
 * Merge a row that continues the one above it.
 *
 * Hacker News again, and the last of its three shapes. A story there is *two*
 * adjacent table rows: the title, and the score line underneath. Both are
 * children of the same table, so the first version made them two items, and the
 * model read a list whose rows alternated between headlines and point counts.
 * Neither half is a story on its own.
 *
 * The rule that fixes it is general rather than site-specific. A row holding
 * nothing interactive, immediately after a row that does, is that row's
 * continuation: the metadata line under an item, the address under a name, the
 * tag list under an entry. That pattern is everywhere in tables and lists, and
 * it is the same shape in all of them.
 *
 * Guarded so it cannot chain: a continuation only merges upward into a row that
 * was not itself a continuation. Three text rows in a row are still three rows,
 * because there is nothing for the second and third to attach to.
 */
function pairContinuationRows(children: IrNode[], nodes: IrNode[]): IrNode[][] {
  const rows: IrNode[][] = [];
  for (const child of children) {
    const actionable = subtreeIsActionable(child, nodes);
    const previous = rows[rows.length - 1];
    if (!actionable && previous !== undefined && previous.length === 1) {
      const above = previous[0]!;
      if (subtreeIsActionable(above, nodes)) {
        previous.push(child);
        continue;
      }
    }
    rows.push([child]);
  }
  return rows;
}

/**
 * True when a row, or anything inside it, is something a person can act on.
 *
 * The first version of the check above was
 * `child.children.some((index) => isInteractive({ ...child, index }))`, which
 * looks like it tests the children and does not: it spread the *parent* and
 * replaced its `index`, so the object handed to `isInteractive` was the row
 * itself wearing a different number. Every row of a generic list therefore read
 * as non-actionable, every row merged into the one above it, and a thirty-row
 * list compiled to fifteen items holding two rows each. The test that caught it
 * is the one asserting every row is addressable, and the reason it is worth
 * stating here is that the bug was invisible in the output: the model would have
 * read a list of fifteen stories where the page had thirty.
 *
 * Children are indexes into the node list, so resolving them needs the list,
 * which is why this takes `nodes` rather than reaching through the row. The walk
 * is iterative because a page can nest arbitrarily deep and a recursive walk over
 * hostile markup is a stack overflow rather than a wrong answer.
 */
function subtreeIsActionable(row: IrNode, nodes: IrNode[]): boolean {
  const stack: IrNode[] = [row];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isInteractive(node)) return true;
    for (const index of node.children) {
      const child = nodes[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return false;
}

/** How many cuts of the same kind and label it takes before they are one list. */
export const GROUP_MIN_RUN = 3;

/**
 * Collapse a run of repeated cuts into one section with items.
 *
 * This fixes the failure the 100-site sweep found, which was the exact inverse
 * of the one before it. The first version produced one enormous section per
 * page; fixing that made every repeated row cut its own section, and Hacker News
 * came back as 30 sections, 29 of them labelled "List". Both are the same bug
 * wearing different clothes: the compiler had no way to say "a list of the same
 * thing", so it had to choose between one section and N.
 *
 * A model reading 29 identical "List" lines cannot tell them apart and cannot
 * address a row, which is worse than it sounds: it will pick s1 for everything
 * because s1 is the only one it has a reason to prefer.
 *
 * The rule: a run of consecutive sibling cuts that share a kind and a normalised
 * label becomes one section whose `items` are the rows. Consecutive and sibling
 * both matter. Two lists at opposite ends of a page that happen to share a label
 * are genuinely two lists, and merging them would put a footer row inside the
 * results.
 */
function groupRepeatedCuts(
  cuts: Array<{ roots: IrNode[]; kind: SectionKind; label: string; heading?: string | undefined; itemRoots?: IrNode[][] | undefined }>,
  nodes: IrNode[],
): void {
  const parentOf = new Map<number, number>();
  for (const node of nodes) {
    for (const child of node.children) parentOf.set(child, node.index);
  }

  const grouped: typeof cuts = [];
  let run: typeof cuts = [];

  /**
   * The key a run shares: the kind, and the *shape* of the rows.
   *
   * Not the label, and the first version keyed on the label, which is why
   * Hacker News compiled to thirty sections rather than one list. Every row
   * there is a `results` cut, but each one's label is its own content -- "921
   * points by albelfio" against "25 points by bananaboy" -- so no two rows
   * agreed and nothing ever grouped.
   *
   * The label is content and content differs between rows of the same list by
   * definition. The shape is what they share: the same roles, in the same
   * order, at the same depth. Two job rows and two story rows both look like
   * rows, and a heading followed by a paragraph looks like neither.
   */
  const shapeOf = (cut: (typeof cuts)[number]): string => {
    const root = cut.roots[0];
    if (!root) return "";
    /*
     * Depth-two roles, which is enough to tell a row from a header without
     * being so specific that a row with one extra tag stops matching.
     */
    const roles = [root.role, ...root.children.map((child) => nodes[child]?.role ?? "?")];
    return roles.join(",");
  };
  const keyOf = (cut: (typeof cuts)[number]): string => `${cut.kind}|${shapeOf(cut)}`;
  const siblingOf = (a: (typeof cuts)[number], b: (typeof cuts)[number]): boolean => {
    const first = a.roots[0];
    const second = b.roots[0];
    if (!first || !second) return false;
    return parentOf.get(first.index) === parentOf.get(second.index);
  };

  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length < GROUP_MIN_RUN) {
      grouped.push(...run);
      run = [];
      return;
    }
    const first = run[0]!;
    /*
     * The merged section's label says how many rows there are, because that is
     * the fact the model most needs from a list and the one it would otherwise
     * have to count. "Stories" alone reads as though the page has a list;
     * "Stories (30)" tells it the list is long enough to need a row reference.
     */
    grouped.push({
      roots: run.flatMap((cut) => cut.roots),
      kind: first.kind,
      label: `${first.label} (${run.length})`,
      heading: first.heading,
      itemRoots: run.map((cut) => cut.roots),
    });
    run = [];
  };

  for (const cut of cuts) {
    const last = run[run.length - 1];
    if (last && keyOf(last) === keyOf(cut) && siblingOf(last, cut)) {
      run.push(cut);
      continue;
    }
    flush();
    run = [cut];
  }
  flush();

  cuts.length = 0;
  cuts.push(...grouped);
}

/**
 * The name in a row that actually tells one row from another.
 *
 * The first named element is the obvious choice and it is wrong on real pages.
 * Hacker News numbers its rows, so the first name in every row is "1.", "2.",
 * "3." and a model reading them learns nothing except that there are thirty of
 * them. The same shape appears as a rank, a bullet, a checkbox with no label, an
 * avatar, or a "1 of 30" counter.
 *
 * So ordinals and near-empty names are passed over in favour of the first name
 * with actual words in it, and the ordinal is only used when there is nothing
 * else, since a bad label still beats no label.
 */
function distinguishingName(candidates: IrNode[]): string | undefined {
  const named = candidates.filter((node) => node.name.trim().length > 0);
  const substantive = named.find((node) => {
    const text = node.name.trim();
    // "1.", "12", "(3)", "#4", "-" and friends: position, not identity.
    if (/^[#(\[]?\d+[.)\]]?$/.test(text)) return false;
    if (text.length < 3) return false;
    return /[a-z]{3}/i.test(text);
  });
  return substantive?.name ?? named[0]?.name;
}

/**
 * Make every section label unique within the page.
 *
 * Grouping removes the common case of repeated labels, but not all of it: a page
 * can have two genuinely separate regions that both compile to "Section", and
 * they are not siblings so merging them would be wrong. DuckDuckGo does exactly
 * this.
 *
 * A duplicate label is a real failure and not a cosmetic one. The model picks a
 * section by reading its label, and two sections reading "Section" give it no
 * basis to choose, so it picks the first and acts in the wrong region. The
 * heading, the first element's name, or a position suffix all beat that.
 */
function disambiguateLabels(sections: IrSection[], elements: Map<string, IrElement>): void {
  const counts = new Map<string, number>();
  for (const section of sections) counts.set(section.label, (counts.get(section.label) ?? 0) + 1);

  const used = new Set<string>();
  for (const section of sections) {
    if ((counts.get(section.label) ?? 0) <= 1) {
      used.add(section.label);
      continue;
    }
    /*
     * Borrow identity from what the section holds, which is what a person would
     * do: the region with the search box is "the search one". Falling back to a
     * number is last, because "Section 2" is only marginally better than
     * "Section" and should not win over a real name.
     */
    /*
     * The borrowed name has to be a name.
     *
     * This reached for the first element's name without checking its length, so
     * on a table-based page it appended the row's entire concatenated text and
     * produced labels *longer* than the ones the length rule had just rejected.
     * A short name that distinguishes two sections is worth borrowing; a
     * paragraph of row text is not a label at all.
     */
    const first = section.elements
      .map((id) => elements.get(id))
      .find((element) => element?.name !== undefined && element.name.length > 0 && element.name.length <= MAX_LABEL_CHARS);
    const borrowed = section.heading ?? first?.name;
    let candidate = borrowed ? `${section.label}: ${borrowed}` : section.label;
    if (used.has(candidate)) {
      let suffix = 2;
      while (used.has(`${candidate} ${suffix}`)) suffix++;
      candidate = `${candidate} ${suffix}`;
    }
    section.label = candidate;
    used.add(candidate);
  }
}

/** The highest number already used with this prefix, so ids are not reused. */
function maxNumbered(ids: string[], prefix: string): number {
  let highest = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const value = Number.parseInt(id.slice(prefix.length), 10);
    if (Number.isFinite(value) && value > highest) highest = value;
  }
  return highest;
}

/** Whether a node is something a person can act on. */
export function isInteractive(node: IrNode): boolean {
  if (node.role === "link" && !node.href && !node.name) return false;
  /*
   * A form control is judged by its TAG as well as its role.
   *
   * The role falls back to the tag whenever the accessibility tree had no node
   * for the element, and a `type="hidden"` input is exactly that case: it has
   * no accessibility node at all, so its role arrives as `input` and a
   * role-only check misses it. That is how hidden fields disappeared before,
   * which is the specific failure this whole path exists to prevent.
   */
  if (node.tag === "input" || node.tag === "select" || node.tag === "textarea") return true;
  if (INTERACTIVE_ROLES.has(node.role)) return true;
  /*
   * A generic node with a test id or a name and a form control's attributes is
   * an element the page built from divs, which React and every component
   * library emit constantly. Missing these would mean a site whose buttons are
   * divs compiles to a page with no buttons.
   */
  if ((node.testId || node.id) && (node.role === "generic" || node.role === "group")) return true;
  return false;
}

/** What a person would call this section. */
/**
 * Longest a section label can be before it stops being a label.
 *
 * Hacker News is why this exists. Its markup is tables, and the accessible name
 * of a table cell is the concatenated text of everything inside it, so 31 of its
 * 32 sections were labelled:
 *
 *     "Hacker Newsnew | past | comments | ask | show | jobs | submit"
 *     "911 points by albelfio 8 hours ago | hide | 290 comments"
 *
 * That is the section's *content*, not its name, and it is worse than no label:
 * a model reading it cannot tell two sections apart, and it costs 60 characters
 * on every observation to say nothing. lobste.rs, which uses lists rather than
 * tables, had none of these.
 *
 * So a name is only used as a label when it reads like one. Past that, the
 * heading is the better answer, and past that the kind's default name.
 */
const MAX_LABEL_CHARS = 60;

function labelFor(node: IrNode, kind: SectionKind): string {
  if (node.name && node.name.length <= MAX_LABEL_CHARS) return node.name;
  const defaults: Record<SectionKind, string> = {
    navigation: "Navigation",
    search: "Search",
    results: "Results",
    product: "Product",
    form: "Form",
    dialog: "Dialog",
    pagination: "Pagination",
    header: "Header",
    main: "Main",
    footer: "Footer",
    list: "List",
    article: "Article",
    unknown: "Section",
  };
  return defaults[kind];
}

/** The section's own heading, which is what makes it recognisable later. */
function headingOf(node: IrNode, nodes: IrNode[]): string | undefined {
  if (node.role === "heading" && node.name) return node.name;
  const heading = descendants(node, nodes).find((child) => child.role === "heading" && child.name);
  if (heading) return heading.name;
  /*
   * A landmark's own name beats a heading inside it, because the name is what
   * the page declared. Falling back to the heading is what lets an unnamed
   * results list still be recognised by "Search results" two revisions later.
   */
  return undefined;
}

/** One line about a section, cheap enough to send every time. */
function summariseSection(kind: SectionKind, label: string, owned: IrNode[]): string {
  if (owned.length === 0) return `${kind}, no actions`;
  const byRole = new Map<string, number>();
  for (const node of owned) byRole.set(node.role, (byRole.get(node.role) ?? 0) + 1);
  const parts = [...byRole.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([role, count]) => (count === 1 ? role : `${count} ${role}s`));
  return parts.join(", ");
}

/* ------------------------------------------------------------------ *
 * Locators
 * ------------------------------------------------------------------ */

/**
 * Score the ways to address an element, best first.
 *
 * The model should never spend a reasoning turn deciding between CSS, XPath,
 * text and aria. Each candidate is ranked by how well it survives a re-render,
 * which is the only property that matters: a locator that breaks when the page
 * updates costs a failed step and a retry, and a locator that does not costs
 * nothing.
 *
 * | rank | strategy | why it survives |
 * |---|---|---|
 * | 1 | role + name | it is what the accessibility tree is for; a re-render that keeps the meaning keeps the match |
 * | 2 | test id | deliberately stable, put there by the site's authors |
 * | 3 | label | ties the control to its visible text |
 * | 4 | placeholder, exact text | survives unless the copy changes |
 * | 5 | css | position-dependent, breaks on any structural change |
 *
 * Only the top two are shown to the model; the rest stay here for `inspect` and
 * for re-resolution when the preferred one goes stale.
 */
export function scoreLocators(node: IrNode): IrLocator[] {
  const locators: IrLocator[] = [];
  const name = node.name.trim();
  /** Everything here is unverified until a page says otherwise. */
  const add = (expression: string, score: number, strategy: IrLocator["strategy"], by: LocatorBy): void => {
    locators.push({ expression, score, strategy, by, verified: false });
  };

  if (name.length > 0 && name.length <= 120 && isSemanticRole(node.role)) {
    add(`getByRole("${node.role}",{name:"${escapeForJs(name)}"})`, 100, "role+name", { kind: "role", role: node.role, name });
    /*
     * The same match, narrowed by exactness, as the second candidate. Playwright's
     * `name` is a substring match by default, so "Save" also matches "Save job 1",
     * and a page with both produces a strict-mode violation the model then has to
     * debug. Offering `exact: true` first-class is cheaper than explaining it.
     */
    add(`getByRole("${node.role}",{name:"${escapeForJs(name)}",exact:true})`, 95, "role+name", { kind: "role", role: node.role, name, exact: true });
  }

  if (node.testId) {
    add(`getByTestId("${escapeForJs(node.testId)}")`, 90, "testid", { kind: "testid", value: node.testId });
  }

  /*
   * A label locator needs a label, and the first version of this emitted one
   * whenever the control had an id. A control with an id and no accessible name
   * is common enough (a bare `<input id="q">`), and it produced
   * `getByLabel("")`, which matches nothing at all. A locator that cannot match
   * is worse than no locator, because it looks like an answer.
   */
  if (isFormControl(node.role) && hasLabelText(name)) {
    add(`getByLabel("${escapeForJs(name)}")`, 85, "label", { kind: "label", value: name });
  }

  /*
   * A placeholder is a real, stable handle on a search box and is what the model
   * reaches for when the accessible name is empty. It only applies to a control
   * that has one, so it is checked rather than assumed.
   */
  if (node.placeholder && node.placeholder.trim().length > 0) {
    add(`getByPlaceholder("${escapeForJs(node.placeholder.trim())}")`, 80, "placeholder", { kind: "placeholder", value: node.placeholder.trim() });
  }

  if (name.length > 0 && name.length <= 80 && !isFormControl(node.role)) {
    add(`getByText("${escapeForJs(name)}",{exact:true})`, 60, "text", { kind: "text", value: name, exact: true });
  }

  /*
   * The CSS candidates, and only the specific ones.
   *
   * There is deliberately no `locator("<tag>")` fallback. A bare tag name
   * matches every element of that kind on the page, so it is not a locator for
   * this element at all; it is a locator for "some input, somewhere". Emitting
   * it was the single most likely way for the model to act on the wrong element
   * while every number in the compile looked right, and it is exactly the
   * stale-and-incorrect failure this design is against. When nothing specific
   * exists, the honest answer is fewer locators, not a worse one.
   *
   * A test id or an id is specific, so those stay. An id is escaped for CSS
   * because ids with dots and colons in them are common in generated markup and
   * an unescaped one silently matches nothing.
   */
  if (node.testId) add(`locator('[data-testid="${escapeForJs(node.testId)}"]')`, 50, "css", { kind: "css", value: `[data-testid="${node.testId}"]` });
  else if (node.id) add(`locator('#${cssEscape(node.id)}')`, 45, "css", { kind: "css", value: `#${node.id}` });

  return locators.sort((a, b) => b.score - a.score);
}

/** Roles for which `getByRole` is the right door. */
function isSemanticRole(role: string): boolean {
  return INTERACTIVE_ROLES.has(role) || role === "heading" || role === "listitem" || role === "paragraph";
}

function isFormControl(role: string): boolean {
  return (
    role === "textbox" ||
    role === "searchbox" ||
    role === "combobox" ||
    role === "listbox" ||
    role === "checkbox" ||
    role === "radio" ||
    role === "switch" ||
    role === "slider" ||
    role === "spinbutton"
  );
}

/** Whether a name looks like a real label rather than a value that leaked in. */
function hasLabelText(name: string): boolean {
  return name.length > 0 && name.length < 60 && !/^\d+$/.test(name);
}

/** Quote for a JS string literal, so a name with a quote does not break it. */
function escapeForJs(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Quote for a CSS attribute selector. */
function cssEscape(text: string): string {
  return text.replace(/([^\w-])/g, "\\$1");
}
