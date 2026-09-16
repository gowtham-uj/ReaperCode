/**
 * The collector: read a real page into the merged evidence the IR is built from.
 *
 * Four sources, unioned, because no single representation of a page is complete
 * and each one is wrong in a different way:
 *
 *   DOMSnapshot.captureSnapshot   attributes, live values, shadow roots, layout
 *                                 bounds AND computed styles, in one call
 *   Accessibility.getFullAXTree   roles, accessible names, states, and the
 *                                 `backendDOMNodeId` that joins it to the above
 *   DOM.getDocument pierce:true   the composed tree, when the snapshot is not
 *                                 enough to resolve a specific node
 *   DOMDebugger.getEventListeners real listeners, the one thing no static
 *                                 source can know because a framework binds
 *                                 them at runtime with nothing in the markup
 *
 * Every claim about what these return was probed against Steel's Chrome on this
 * machine rather than taken from the documentation. Three of them mattered:
 *
 *   - `DOMSnapshot`'s `isClickable` field is declared in the protocol but comes
 *     back **empty** in this Chrome, so clickability is computed from the union
 *     of signals in `signals.ts` rather than read.
 *   - `layout.styles` **does** work, and it is a flat array of string indices
 *     positionally matching the requested `computedStyles`, two entries per
 *     style. Once decoded it makes cursor and pointer-events free, in the same
 *     call as everything else, which removes an entire in-page evaluate.
 *   - `Accessibility.getFullAXTree` on the main session sees **shadow** content
 *     but **not iframe** content, so every frame is walked with its own session.
 *
 * The other load-bearing facts: `captureSnapshot` returns one `documents[]`
 * entry per frame, each carrying its own `frameId`, which is how elements are
 * attributed to frames; and the snapshot's `inputValue` is the DOM property,
 * which disagrees with the `value` attribute on any controlled input and is the
 * one that reflects what was typed.
 */

import type { CDPSession, Frame, Page } from "playwright";

import { scoreInteraction, type InteractionEvidence, type InteractionVerdict } from "./signals.js";

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/**
 * One rendered thing, merged from every source that knew about it.
 *
 * `backendNodeId` is the identity throughout, not a CSS selector: a selector is
 * a guess about the document and a backend id is a position in it, and the two
 * disagree the moment the page re-renders.
 */
export interface CandidateElement {
  backendNodeId: number;
  /** "f1" when inside a frame, "" in the main frame. */
  frameId: string;
  tag: string;
  /** The accessibility role, lowercased. Falls back to the tag. */
  role: string;
  accessibleName: string;
  /** The rendered text, which is not always the accessible name. */
  text?: string | undefined;
  description?: string | undefined;
  id?: string | undefined;
  testId?: string | undefined;
  /** A form control's placeholder, which is often its only stable handle. */
  placeholder?: string | undefined;
  href?: string | undefined;
  /**
   * The LIVE value.
   *
   * From the snapshot's `inputValue` (the DOM property) rather than from the
   * `value` attribute. Probed: a controlled input reports `attribute-value` from
   * the attribute and `live-value` from the property, and the property is what
   * tells the model whether it still has to type.
   */
  value?: string | undefined;
  /** The serialized attribute, kept only so a disagreement can be detected. */
  initialValue?: string | undefined;
  /** `disabled`, `required`, `expanded`, `invalid`, and the rest. */
  states: string[];
  checked?: boolean | undefined;
  selected?: boolean | undefined;
  bounds?: { x: number; y: number; width: number; height: number } | undefined;
  visible: boolean;
  interaction: InteractionVerdict;
  /** The evidence behind the verdict, kept so the listener probe can add to it. */
  evidence: InteractionEvidence;
  /** `getComputedStyle().cursor`, decoded from the snapshot. */
  cursor?: string | undefined;
  /** The `type` attribute: "hidden", "email", "submit", and so on. */
  inputType?: string | undefined;
  depth: number;
  /**
   * The backend id of the DOM parent, or undefined for a document root.
   *
   * Straight from the snapshot's own `parentIndex`, not re-derived from depth.
   * Depth alone cannot rebuild a tree: two nodes at the same depth in different
   * subtrees have no order between them, so sorting by depth interleaves
   * unrelated branches and the containment the section rules depend on comes
   * out wrong. That is not hypothetical; it collapsed Hacker News into a single
   * section holding 484 elements.
   */
  parentBackendNodeId?: number | undefined;
  /**
   * Every ancestor's backend id, nearest first, up to the document root.
   *
   * A single parent link is not enough for the compiler to rebuild containment.
   * Most of a real element's ancestors are filtered out of the tree (a wrapper
   * div, a span, a portal host), and when the immediate parent is one of those,
   * the link points at a node that is not in the tree and the walk stops there.
   *
   * That is exactly what happened to a form's hidden inputs. They attached
   * themselves to the document root, belonged to no section, and vanished from
   * the model's view while every visible element on the page compiled
   * correctly, so nothing looked wrong. The chain is what lets the compiler
   * attach an element to its nearest kept ancestor without re-reading the DOM.
   */
  ancestorBackendNodeIds: number[];
  inShadow: boolean;
  inSvg: boolean;
  /** Set when the value attribute and the live value disagree. */
  valueConflicts?: boolean | undefined;
  /**
   * True when some descendant text node has content.
   *
   * Computed over the subtree rather than read off the element, because that is
   * where text actually lives: a `<div>Save</div>` has no text of its own in the
   * snapshot, it has a text-node child. This is the signal that decides whether
   * a nameless node is worth probing for a listener, which is the only way a
   * bare clickable div is ever found.
   */
  hasText?: boolean | undefined;
  /**
   * The words this node directly holds, when it is a leaf of prose.
   *
   * Set only for an element whose subtree contains text and no other elements,
   * so it is the text's own holder and not a container that merely sums its
   * children. That is what stops a `<form>` contributing the concatenation of
   * every label inside it, and what stops a `<td>` holding a link from
   * duplicating that link's name.
   *
   * Collapsed and capped, because this ends up in a view with a character
   * budget: a page can hold a hundred thousand characters of prose and the
   * model needs the sentence that says whether its last action worked, not the
   * whole article.
   */
  textContent?: string | undefined;
}

/** The longest run of prose worth carrying out of one leaf. */
const MAX_TEXT_CONTENT_CHARS = 240;

/**
 * A frame, with what is known about reaching into it.
 *
 * An unread frame is recorded with a reason rather than omitted, because "there
 * is a Stripe iframe here and I could not read it" is a fact the model needs.
 * Silence would let it conclude the payment form does not exist.
 */
export interface CollectedFrame {
  /** The frame's own id, or its prefix when the id is not exposed. */
  id: string;
  url: string;
  /** "f1", the prefix its elements are namespaced with. Empty in the main frame. */
  prefix: string;
  /** True when the frame's contents were read. */
  read: boolean;
  unreadReason?: string | undefined;
  elementCount: number;
}

/**
 * A scroll container.
 *
 * Detection is unconditional because not detecting it means a model believing 20
 * rows is the whole list. The sweep is a separate decision because scrolling
 * changes the page, so `sweepSafe` is judged here with a reason rather than
 * assumed.
 */
export interface CollectedScrollRegion {
  /** The container's backend id, or a negative synthetic id when unknown. */
  backendNodeId: number;
  overflowRatio: number;
  /** Filled in by a sweep, which is the only thing that can tell. */
  virtualized: boolean;
  observedChildren: number;
  sweepSafe: boolean;
  unsafeReason?: string | undefined;
}

/** A canvas or WebGL region, which has no DOM for its contents. */
export interface CollectedCanvasRegion {
  backendNodeId: number;
  bounds?: { x: number; y: number; width: number; height: number } | undefined;
}

/**
 * A container the compiler cuts sections from.
 *
 * Deliberately not a `CandidateElement`: it has no confidence, no locators and
 * nothing to act on. It exists so section detection can see containment, and
 * keeping the two types apart is what stops a structural `div` being rendered
 * to the model as something it could click.
 */
export interface StructuralNode {
  backendNodeId: number;
  frameId: string;
  tag: string;
  role: string;
  name: string;
  depth: number;
  /** The backend id of its parent, or undefined for a document root. */
  parentBackendNodeId?: number | undefined;
  /**
   * Every ancestor's backend id, nearest first, exactly as an element carries.
   *
   * Without this a container whose direct parent was filtered out attaches to
   * the document root, and the containment the section rules depend on is lost.
   * Hacker News is the page that proved it: its table structure
   * (`table > tbody > tr > td`) came back with every row hanging off the root,
   * so thirty rows compiled as thirty sections instead of one list. Elements
   * already carried a chain; the structural nodes did not, and the asymmetry was
   * the bug.
   */
  ancestorBackendNodeIds: number[];
  /** True for `html`, `body` and the document root, which are never sections. */
  isRoot: boolean;
}

export interface CollectedPage {
  url: string;
  title: string;
  elements: CandidateElement[];
  /**
   * The container skeleton, from the document root down to every interactive
   * element's parent. The compiler needs this to know what contains what; see
   * `buildStructuralAncestors` for why the interactive list alone is not enough.
   */
  structural: StructuralNode[];
  frames: CollectedFrame[];
  canvases: CollectedCanvasRegion[];
  scrollRegions: CollectedScrollRegion[];
  /**
   * The pipeline counts, so a missing element can be traced to the stage that
   * lost it instead of debugging the whole pipeline blind.
   */
  counts: {
    rawNodes: number;
    axNodes: number;
    candidates: number;
    visible: number;
    listenerProbed: number;
  };
}

/* ------------------------------------------------------------------ *
 * CDP payload shapes
 * ------------------------------------------------------------------ */

interface AxValue {
  type?: string;
  value?: unknown;
}
interface AxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  description?: AxValue;
  value?: AxValue;
  properties?: Array<{ name?: string; value?: AxValue }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

interface SnapshotNodes {
  parentIndex: number[];
  nodeType: number[];
  nodeName: number[];
  nodeValue: number[];
  backendNodeId: number[];
  attributes: number[][];
  textValue: number[];
  inputValue: number[];
  /*
   * These two are boolean arrays, not string-index arrays: the protocol sends
   * the checked and selected state directly rather than through the string
   * table, which is why they read as `true`/`false` rather than as an index.
   */
  inputChecked: boolean[];
  optionSelected: boolean[];
  shadowRootType: number[] | Record<string, unknown>;
  contentDocumentIndex: number[] | Record<string, unknown>;
}

interface SnapshotDocument {
  /**
   * The frame this document belongs to.
   *
   * The protocol sends an index into the string table rather than a raw id,
   * which is not obvious and was found by decoding a fixture by hand. It is
   * resolved through `strings` before use.
   */
  frameId?: unknown;
  nodes: SnapshotNodes;
  layout: { nodeIndex: number[]; bounds: number[][]; styles?: number[][] };
}

interface Snapshot {
  strings: string[];
  documents: SnapshotDocument[];
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Attributes that mark a handler bound in the markup. */
const HANDLER_ATTRIBUTE = /^on[a-z]+$/;

/** Test id spellings that are actually used in the wild. */
const TEST_ID_ATTRIBUTES = ["data-testid", "data-test-id", "data-test", "data-e2e", "data-cy", "data-qa"];

/**
 * Tags that are page furniture rather than controls.
 *
 * Excluded from the listener pool because they are containers: probing `body`
 * for a listener costs a round trip to learn nothing, and anything inside it is
 * probed on its own anyway. `svg` is here rather than treated as a control
 * because the SVG *root* is not clickable; the shapes inside it are, and they
 * are probed individually.
 */
const STRUCTURAL_TAGS = new Set([
  "html",
  "body",
  "main",
  "head",
  "#document",
  "script",
  "style",
  "link",
  "meta",
  "svg",
  "defs",
  "g",
  "symbol",
  "use",
  "clippath",
  "mask",
  "pattern",
  "marker",
  "filter",
  "lineargradient",
  "radialgradient",
]);

/** AX properties worth carrying, mapped to the state names the IR uses. */
const INTERESTING_PROPERTIES: Record<string, string> = {
  disabled: "disabled",
  required: "required",
  expanded: "expanded",
  invalid: "invalid",
  focused: "focused",
  readonly: "readonly",
  modal: "modal",
  busy: "busy",
  multiselectable: "multiselectable",
};

/**
 * The computed styles asked for, in order.
 *
 * The `styles` array in the snapshot is a flat run of string indices, two per
 * requested property (name, value), positionally matching this list. Verified
 * by decoding a fixture by hand: `["pointer","auto"]` for a
 * `cursor:pointer; pointer-events:auto` element.
 */
const REQUESTED_STYLES = ["cursor", "pointer-events", "display", "visibility"] as const;

/* ------------------------------------------------------------------ *
 * Collection
 * ------------------------------------------------------------------ */

export interface CollectOptions {
  /**
   * How many nodes to probe for listeners. The cheap signals narrow this.
   *
   * This was 150 when a probe cost two CDP round trips per node, which made the
   * cap the difference between a collect that finished and one that did not. The
   * probe is now a single `Runtime.evaluate` for the whole document, so the cap
   * no longer buys speed and only costs coverage: on a page with 2,000 plausible
   * candidates, the 151st onward simply could not be confirmed as interactive.
   *
   * Kept as an option because a caller that knows the page is huge may still
   * want to bound it, and the cost is now paid in page-side string work rather
   * than round trips.
   */
  listenerProbeLimit?: number;
  /** Whether to look for scroll containers. Off for a compile already known to be a delta. */
  detectScrollRegions?: boolean;
}

export async function collectPage(page: Page, options: CollectOptions = {}): Promise<CollectedPage> {
  const listenerProbeLimit = options.listenerProbeLimit ?? LISTENER_POOL_DEFAULT;

  const pageSession = await page.context().newCDPSession(page);
  try {
    /*
     * Frames are enumerated from CDP, not from Playwright.
     *
     * Playwright's own frame identity is an internal `_guid` like `frame@81`,
     * which is *not* the id CDP uses: probed, passing it to
     * `Accessibility.getFullAXTree({ frameId })` fails with "frame with the
     * given frameId is not found". The CDP frame tree is the only thing whose
     * ids match the ids in the snapshot's `documents[]` and that the per-frame
     * accessibility call accepts.
     *
     * So the frame list comes from `Page.getFrameTree` and Playwright frames
     * are matched to it by position, which is stable within one collection.
     */
    const frameTree = (await pageSession.send("Page.getFrameTree")) as unknown as { frameTree: CdpFrameTree };
    const cdpFrames = flattenFrameTree(frameTree.frameTree);
    const playwrightFrames = page.frames();

    /*
     * One snapshot for the whole page, not one per frame.
     *
     * Probed: `captureSnapshot()` on the main session returns **one document per
     * frame**, each carrying its own `frameId`, so every frame's DOM, geometry
     * and styles arrive in a single call. A session per frame is not only
     * slower, it fails outright for a same-process frame: Playwright answers
     * "this frame does not have a separate CDP session, it is part of the
     * parent".
     */
    const snapshot = (await pageSession.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [...REQUESTED_STYLES],
      includeDOMRects: true,
      includePaintOrder: false,
    })) as unknown as Snapshot;

    /*
     * The accessibility tree is the opposite: it is per frame, because the main
     * session's tree stops at the frame boundary. Probed both ways: the
     * unfiltered call sees the outer page and not the iframe, and
     * `getFullAXTree({ frameId })` sees the iframe and not the outer page.
     *
     * Every frame is asked separately, in parallel, and one that refuses becomes
     * an unread frame with a reason rather than failing the compile.
     */
    const axByFrameId = new Map<string, { nodes: AxNode[]; read: boolean; reason?: string }>();
    await Promise.all(
      cdpFrames.map(async (frame) => {
        try {
          const result = (await pageSession.send("Accessibility.getFullAXTree", {
            frameId: frame.id,
          } as never)) as unknown as { nodes: AxNode[] };
          axByFrameId.set(frame.id, { nodes: result.nodes, read: true });
        } catch (error) {
          axByFrameId.set(frame.id, { nodes: [], read: false, reason: (error as Error).message.slice(0, 100) });
        }
      }),
    );

    /*
     * Attribute each snapshot document to its frame. `frameId` is an index into
     * the string table rather than a raw id, which is not obvious and is why it
     * is resolved through `strings` first.
     */
    const documentsByFrameId = new Map<string, SnapshotDocument>();
    for (const document of snapshot.documents) {
      const raw = document.frameId;
      const frameId = typeof raw === "number" ? snapshot.strings[raw] : typeof raw === "string" ? raw : undefined;
      if (frameId !== undefined) documentsByFrameId.set(frameId, document);
    }

    const elements: CandidateElement[] = [];
    const structural: StructuralNode[] = [];
    const collectedFrames: CollectedFrame[] = [];
    let axNodeTotal = 0;
    let rawNodeTotal = 0;

    /*
     * A frame's prefix is its position in the tree, so the main frame is "" and
     * the rest are f1, f2 in the order they appear. Positional rather than
     * url-derived, because two frames on the same url are different frames and
     * a model holding `f1:e22` needs it to keep meaning the same thing.
     */
    const prefixByFrameId = new Map<string, string>();
    cdpFrames.forEach((frame, index) => prefixByFrameId.set(frame.id, index === 0 ? "" : `f${index}`));

    for (const [index, frame] of cdpFrames.entries()) {
      const prefix = prefixByFrameId.get(frame.id) ?? `f${index}`;
      const ax = axByFrameId.get(frame.id);
      axNodeTotal += ax?.nodes.length ?? 0;

      const document_ = documentsByFrameId.get(frame.id);
      if (!document_) {
        /*
         * A frame with no document is recorded as unread rather than silently
         * contributing nothing: "no elements here" and "I could not read this"
         * must not look the same to the model, because one means the page is
         * empty and the other means there may be a form it cannot see.
         */
        collectedFrames.push({
          id: frame.id,
          url: frame.url,
          prefix,
          read: false,
          unreadReason: ax?.reason ?? "no snapshot document for this frame",
          elementCount: 0,
        });
        continue;
      }

      rawNodeTotal += document_.nodes.nodeName.length;
      const built = buildFrame(document_, prefix, snapshot.strings, ax?.nodes ?? []);
      elements.push(...built.elements);
      structural.push(...built.structural);

      collectedFrames.push({
        id: frame.id,
        url: frame.url || playwrightFrames[index]?.url() || "",
        prefix,
        read: true,
        elementCount: built.elements.length,
      });
    }

    /*
     * The listener probe is what makes a bare `<div>` with a runtime handler
     * findable, and it has to run on nodes that are NOT yet known to be
     * interactive, or it could never promote one. That is the whole point of it.
     *
     * So the pool is "plausible candidates": visible, rendered, not already
     * interactive, and shaped like something a person could act on (a short
     * piece of text, or a name). Everything with no text and no name is a
     * layout box and is not worth a round trip. The pool is then capped, since
     * each entry costs one CDP call.
     */
    const listenerPool = elements
      .filter((element) => !element.interaction.interactive)
      .filter((element) => element.visible)
      /*
       * The text test has to look at the *subtree*, not at the element's own
       * text, because that is where it lives: probed, a `<div>Bare clickable</div>`
       * reports `textValue: null` and carries the words in a child text node.
       * Testing only the element's own text is why this filter dropped the exact
       * case it exists for.
       */
      .filter((element) => element.hasText === true || element.accessibleName.length > 0)
      .filter((element) => element.accessibleName.length < 80)
      .filter((element) => STRUCTURAL_TAGS.has(element.tag) === false)
      .slice(0, listenerProbeLimit);

    const probed = await probeListeners(pageSession, listenerPool.map((element) => element.backendNodeId));
    for (const element of listenerPool) {
      if (probed.get(element.backendNodeId) !== true) continue;
      element.evidence.hasListener = true;
      element.interaction = scoreInteraction(element.evidence);
    }

    /*
     * What goes into the IR.
     *
     * Not "only what is interactive", which was the first version's mistake: it
     * dropped hidden fields, because a `type="hidden"` input has no
     * accessibility node and no interaction signal, and it dropped every
     * textual node, so a section could not say what it contained.
     *
     * Four kinds are kept, and the reason each is here:
     *
     *   - interactive, however it was detected
     *   - hidden form controls, so the model knows the form carries state and
     *     that a later step exists in the markup
     *   - visible nodes with a name, which is what lets a section summary carry
     *     real content instead of counting things
     *   - visible nodes with a meaningful role, for structure
     *
     * The noisy end is a page full of named wrappers, which the relevance layer
     * collapses to stubs rather than the collector guessing which names matter.
     * Compressing at the collector is what made Hacker News unreadable and
     * example.com empty; leaving it to relevance keeps the choice reversible.
     */
    const candidateList = elements.filter((element) => {
      if (element.interaction.interactive) return true;
      // A hidden form control is reported whether or not anything else says so.
      if (!element.visible && isFormControlTag(element.tag, element.inputType, element.role)) return true;
      if (!element.visible) return false;
      /*
       * A leaf of prose is kept, which is the fifth kind and the one that was
       * missing.
       *
       * Without it the view described every control on a page and none of the
       * sentences, so a form that answered "submitted", a search that said "3
       * results", a login that said "Invalid password" all compiled to a view
       * that said nothing had happened. The model could act and could not tell
       * whether acting worked, which is the failure the receipt exists to
       * prevent and this is the half of it the receipt could not see.
       *
       * A named node is still kept by the rule below, so this only adds the
       * unnamed holders of text, which is exactly the set that was being
       * dropped.
       */
      if (element.textContent !== undefined) return true;
      return element.accessibleName.length > 0 || isMeaningfulRole(element.role);
    });

    /*
     * The structural ancestors the interactive elements hang from.
     *
     * Section detection is about containment: a `form` is a section because the
     * button is inside it, and a `main` is a container because a form and a list
     * are inside it. Without the ancestors the compiler receives a forest of
     * unrelated leaves, and on a real page it picks one link as the whole page.
     * That is not hypothetical: it is what Hacker News did before this existed,
     * compiling to zero sections from 287 correctly-collected elements.
     *
     * These are not offered to the model as things to act on, they are the
     * skeleton the sections are cut from, which is why they carry
     * `structuralOnly` rather than a confidence.
     */
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      elements: candidateList,
      structural,
      frames: collectedFrames,
      canvases: elements
        .filter((element) => element.tag === "canvas")
        .map((element) => ({ backendNodeId: element.backendNodeId, bounds: element.bounds })),
      scrollRegions: options.detectScrollRegions === false ? [] : await detectScrollRegions(page).catch(() => []),
      counts: {
        rawNodes: rawNodeTotal,
        axNodes: axNodeTotal,
        candidates: candidateList.length,
        visible: candidateList.filter((element) => element.visible).length,
        listenerProbed: listenerPool.length,
      },
    };
  } finally {
    await pageSession.detach().catch(() => undefined);
  }
}

/** The CDP frame tree, which is the only source of ids the other calls accept. */
interface CdpFrameTree {
  frame: { id: string; url: string; parentId?: string };
  childFrames?: CdpFrameTree[];
}

/**
 * Flatten the frame tree into document order, main frame first.
 *
 * Depth-first, children in the order the browser reported them, which is the
 * same order the snapshot's `documents[]` arrives in on every page probed. The
 * order is what the prefixes are derived from, so it has to be stable for two
 * frames of the same url to stay distinguishable.
 */
function flattenFrameTree(tree: CdpFrameTree, into: Array<{ id: string; url: string; parentId?: string | undefined }> = []): Array<{ id: string; url: string; parentId?: string | undefined }> {
  into.push({ id: tree.frame.id, url: tree.frame.url, parentId: tree.frame.parentId });
  for (const child of tree.childFrames ?? []) flattenFrameTree(child, into);
  return into;
}

/** What one frame's document yields: the elements, and the skeleton they hang from. */
interface FrameBuild {
  elements: CandidateElement[];
  structural: StructuralNode[];
}

/** Turn one frame's snapshot document and accessibility tree into elements. */
function buildFrame(document_: SnapshotDocument, prefix: string, strings: string[], axNodes: AxNode[]): FrameBuild {
  const at = (index: number | undefined): string | undefined =>
    index === undefined || index < 0 ? undefined : strings[index];

  const nodes = document_.nodes;
  const layout = document_.layout;

  const layoutPosition = new Map<number, number>();
  layout.nodeIndex.forEach((nodeIndex, position) => layoutPosition.set(nodeIndex, position));

  const axByBackend = new Map<number, AxNode>();
  for (const axNode of axNodes) {
    if (axNode.backendDOMNodeId !== undefined) axByBackend.set(axNode.backendDOMNodeId, axNode);
  }

  /*
   * Snapshot index by backend id, so the skeleton walk can go from an element
   * back to its position in the node arrays and follow `parentIndex` upward.
   */
  const snapshotIndexByBackend = new Map<number, number>();
  for (let i = 0; i < nodes.backendNodeId.length; i++) {
    const id = nodes.backendNodeId[i];
    if (id !== undefined) snapshotIndexByBackend.set(id, i);
  }

  const shadowRoots = new Set(toIndexArray(nodes.shadowRootType));

  /*
   * Which nodes have text somewhere beneath them.
   *
   * Computed once for the whole document by walking text nodes up to their
   * ancestors, which is linear, rather than walking every element's subtree,
   * which is quadratic on a deep page.
   */
  const hasTextUnder = new Set<number>();
  for (let i = 0; i < nodes.nodeName.length; i++) {
    // 3 is a text node.
    if (nodes.nodeType[i] !== 3) continue;
    const text = at(nodes.nodeValue[i]);
    if (text === undefined || text.trim().length === 0) continue;
    let cursor = nodes.parentIndex[i];
    for (let hops = 0; hops < 100 && typeof cursor === "number" && cursor >= 0; hops++) {
      if (hasTextUnder.has(cursor)) break;
      hasTextUnder.add(cursor);
      cursor = nodes.parentIndex[cursor];
    }
  }

  /*
   * Which nodes have at least one element child, and each element's own text
   * children.
   *
   * This is what makes a node a *leaf of prose*: an element whose subtree holds
   * text and no other elements. A paragraph, a status line, a table cell with
   * only words in it. Those are the nodes whose text nothing else already
   * carries, and they are the reason this exists: the compiled view used to omit
   * page text entirely, so a form that answered "submitted" or "Invalid
   * password" compiled to a view that said nothing about it. The model could see
   * every control and not the one sentence that tells it whether the last action
   * worked.
   *
   * Restricted to leaves deliberately, and that restriction is what keeps it
   * from duplicating everything else. A `<td>` holding a link has an element
   * child, so its text is skipped and the link keeps its name. A `<form>` has
   * element children, so its text, which is the concatenation of every label
   * inside it, is never collected. Only the innermost holder of a run of words
   * contributes, and it contributes exactly once.
   */
  const hasElementChild = new Uint8Array(nodes.nodeName.length);
  const textChildren = new Map<number, string[]>();
  for (let i = 0; i < nodes.nodeName.length; i++) {
    const parent = nodes.parentIndex[i];
    if (typeof parent !== "number" || parent < 0) continue;
    if (nodes.nodeType[i] === 1) {
      hasElementChild[parent] = 1;
      continue;
    }
    if (nodes.nodeType[i] !== 3) continue;
    const own = at(nodes.nodeValue[i]);
    if (own === undefined || own.trim().length === 0) continue;
    const bucket = textChildren.get(parent);
    if (bucket === undefined) textChildren.set(parent, [own]);
    else bucket.push(own);
  }

  /**
   * The prose a node holds directly, when it is the innermost holder of it.
   *
   * Undefined for anything with an element child, for anything whose text is
   * already covered, and for text that is only whitespace. The cap is applied
   * after collapsing runs of whitespace, because the snapshot preserves the
   * source's newlines and indentation and a paragraph of prose in real markup
   * arrives with a few hundred characters of layout around it.
   */
  const proseFor = (index: number): string | undefined => {
    if (hasElementChild[index] === 1) return undefined;
    const parts = textChildren.get(index);
    if (parts === undefined) return undefined;
    const collapsed = parts.join(" ").replace(/\s+/g, " ").trim();
    if (collapsed.length === 0) return undefined;
    return collapsed.length <= MAX_TEXT_CONTENT_CHARS ? collapsed : `${collapsed.slice(0, MAX_TEXT_CONTENT_CHARS - 1)}…`;
  };

  const elements: CandidateElement[] = [];

  for (let index = 0; index < nodes.nodeName.length; index++) {
    // 1 is an element; 3 is text, 8 is a comment, 9/10/11 are document nodes.
    if (nodes.nodeType[index] !== 1) continue;

    const tag = (at(nodes.nodeName[index]) ?? "").toLowerCase();
    if (!tag) continue;

    const backendNodeId = nodes.backendNodeId[index];
    if (backendNodeId === undefined) continue;

    const attributes: Record<string, string> = {};
    const attributeIndexes = nodes.attributes[index] ?? [];
    for (let k = 0; k + 1 < attributeIndexes.length; k += 2) {
      const name = at(attributeIndexes[k]);
      const value = at(attributeIndexes[k + 1]);
      if (name !== undefined && value !== undefined) attributes[name] = value;
    }

    const axNode = axByBackend.get(backendNodeId);

    /*
     * Geometry and style, both from the layout arrays. A node index that is not
     * in `layout.nodeIndex` was not laid out at all, which is a `display: none`
     * subtree or a detached node, and either way it is not something to act on.
     */
    const position = layoutPosition.get(index);
    const rawBounds = position !== undefined ? layout.bounds[position] : undefined;
    const styles = position !== undefined ? decodeStyles(layout.styles?.[position], prefix, strings) : {};

    const bounds = rawBounds
      ? { x: rawBounds[0] ?? 0, y: rawBounds[1] ?? 0, width: rawBounds[2] ?? 0, height: rawBounds[3] ?? 0 }
      : undefined;

    const display = styles["display"];
    const visibility = styles["visibility"];
    const hasBox = bounds !== undefined && bounds.width > 0 && bounds.height > 0;
    /*
     * Visibility from three sources, because each is wrong alone: a zero box
     * means not laid out, `display: none` and `visibility: hidden` come from the
     * computed styles, and `ignored` from the accessibility tree catches
     * `aria-hidden` and other things assistive technology will not see.
     */
    const visible =
      hasBox && display !== "none" && visibility !== "hidden" && axNode?.ignored !== true;

    const states: string[] = [];
    for (const property of axNode?.properties ?? []) {
      const mapped = property.name ? INTERESTING_PROPERTIES[property.name] : undefined;
      if (mapped && property.value?.value === true) states.push(mapped);
    }
    if (nodes.inputChecked[index] === true) states.push("checked");

    const testId = TEST_ID_ATTRIBUTES.map((attribute) => attributes[attribute]).find((value) => value !== undefined);
    /*
     * A placeholder, kept because it is the only handle a search box often has.
     * The accessible name is frequently empty on one (the placeholder is what a
     * person reads), and it is stable across re-renders, so carrying it gives
     * the locator scorer something specific to use instead of falling back to a
     * bare tag name that matches every input on the page.
     */
    const placeholder = attributes["placeholder"] ?? attributes["aria-placeholder"];

    /*
     * The live value, from the accessibility tree.
     *
     * Not from the snapshot's `inputValue`, which is declared in the protocol
     * but comes back empty on every node in this Chrome: probed against a form
     * with a filled text input and two hidden ones, `inputValue` was `-1`
     * (unset) throughout. The AX tree's `value` is the one that reflects what
     * was typed, and it is already fetched, so this costs nothing.
     *
     * The attribute is kept separately: on a controlled input the two disagree,
     * and the disagreement is itself worth reporting because it tells the model
     * the framework is managing the field.
     */
    const axValue = typeof axNode?.value?.value === "string" ? axNode.value.value : undefined;
    const liveValue = axValue ?? at(nodes.inputValue[index]) ?? attributes["value"];
    const attributeValue = attributes["value"];

    const evidence: InteractionEvidence = {
      tag,
      axRole: typeof axNode?.role?.value === "string" ? axNode.role.value.toLowerCase() : undefined,
      roleAttribute: attributes["role"],
      // Parsed here because the snapshot carries the attribute, but the signal
      // is about whether it is in the tab order, which needs a number.
      tabindex: attributes["tabindex"] !== undefined ? Number(attributes["tabindex"]) : undefined,
      contenteditable:
        attributes["contenteditable"] === "" || attributes["contenteditable"] === "true" ? true : undefined,
      draggable: attributes["draggable"] === "true" ? true : undefined,
      handlerAttributes: Object.keys(attributes).filter((attribute) => HANDLER_ATTRIBUTE.test(attribute)),
      href: attributes["href"],
      cursor: styles["cursor"],
      pointerEvents: styles["pointer-events"],
      inSvg: tag === "svg" || isInsideSvg(index, nodes),
      customElement: tag.includes("-"),
    };

    elements.push({
      backendNodeId,
      frameId: prefix,
      tag,
      role: typeof axNode?.role?.value === "string" ? axNode.role.value.toLowerCase() : tag,
      accessibleName: typeof axNode?.name?.value === "string" ? axNode.name.value : "",
      text: at(nodes.textValue[index]),
      description: typeof axNode?.description?.value === "string" ? axNode.description.value : undefined,
      id: attributes["id"],
      testId,
      placeholder,
      href: attributes["href"],
      value: liveValue,
      initialValue: attributeValue,
      states,
      selected: nodes.optionSelected[index] === true ? true : undefined,
      bounds,
      visible,
      interaction: scoreInteraction(evidence),
      evidence,
      cursor: styles["cursor"],
      inputType: attributes["type"],
      depth: parentDepth(index, nodes),
      parentBackendNodeId: parentBackendOf(index, nodes),
      ancestorBackendNodeIds: ancestorChainOf(index, nodes),
      inShadow: shadowRoots.has(index),
      inSvg: evidence.inSvg === true,
      hasText: hasTextUnder.has(index),
      /*
       * Only for a leaf of prose, and only when it is not already the element's
       * accessible name. A `<button>Continue</button>` would otherwise carry
       * "Continue" twice, once as its name and once as its text, and the view
       * would print it on two lines.
       */
      textContent: proseFor(index),
      ...(liveValue !== undefined && attributeValue !== undefined && liveValue !== attributeValue
        ? { valueConflicts: true }
        : {}),
    });
  }

  /*
   * The skeleton, from the interactive elements upward.
   *
   * Section detection is about containment: a `form` is a section because the
   * button is inside it, and a `main` is a container because a form and a list
   * are inside it. Handing the compiler only the interactive list gives it a
   * forest of unrelated leaves, and on a real page it picks one link as the
   * whole page. Not hypothetical: Hacker News compiled to zero sections from
   * 287 correctly-collected elements before this existed.
   *
   * Ancestors are walked from each interactive element upward, and only the
   * ones worth cutting at are kept. Walking downward from the root instead would
   * include every wrapper div, which is the accessibility tree again.
   */
  const structuralByBackend = new Map<number, StructuralNode>();
  /**
   * Backend ids of the interactive elements, which is what an ancestor must not
   * duplicate.
   *
   * This set was wrong, and the way it was wrong is worth recording because it
   * looked correct. It was built from *every* element, and the element list
   * contains containers as well as controls (`isInteractive` keeps a named
   * container so a section can be named after it). So the skip fired on the
   * form, the main, the body and the html for every element on the page, the
   * walk added nothing at all, and the skeleton came back holding just the
   * document. The compiler then had no containment, so a form's hidden inputs
   * attached to the document root, belonged to no section, and were dropped
   * from the model's view while every visible element compiled fine.
   *
   * A container is exactly what the skeleton is for, so only a genuinely
   * actionable ancestor is skipped here.
   */
  const elementBackends = new Set(elements.filter((element) => element.interaction.interactive).map((element) => element.backendNodeId));

  for (const element of elements) {
    if (!element.interaction.interactive) continue;
    /*
     * The walk starts at the element's PARENT.
     *
     * Starting at the element itself put every interactive node with an `id`
     * into the skeleton as well as the element list, so a form and its button
     * each appeared twice and the compile produced two identical sections. The
     * skeleton is ancestors only.
     */
    const own = snapshotIndexByBackend.get(element.backendNodeId);
    let cursor = own === undefined ? undefined : nodes.parentIndex[own];

    for (let hops = 0; hops < 100 && typeof cursor === "number" && cursor >= 0; hops++) {
      const ancestorTag = (at(nodes.nodeName[cursor]) ?? "").toLowerCase();
      const ancestorBackend = nodes.backendNodeId[cursor];
      /*
       * An ancestor that is itself an element is skipped: it is already in the
       * element list with its own id, and putting it in both is what produced
       * duplicate sections. Its own ancestors are still walked, so skipping it
       * does not cut the chain.
       */
      if (
        ancestorBackend !== undefined &&
        !structuralByBackend.has(ancestorBackend) &&
        !elementBackends.has(ancestorBackend)
      ) {
        const ancestorAx = axByBackend.get(ancestorBackend);
        const ancestorRole = typeof ancestorAx?.role?.value === "string" ? ancestorAx.role.value.toLowerCase() : ancestorTag;
        const ancestorName = typeof ancestorAx?.name?.value === "string" ? ancestorAx.name.value : "";
        const ancestorAttributes = attributesAt(cursor, nodes, at);
        if (isSectionBearing({ tag: ancestorTag, role: ancestorRole, name: ancestorName, id: ancestorAttributes["id"] })) {
          structuralByBackend.set(ancestorBackend, {
            backendNodeId: ancestorBackend,
            frameId: prefix,
            tag: ancestorTag,
            role: ancestorRole,
            name: ancestorName,
            depth: parentDepth(cursor, nodes),
            parentBackendNodeId: parentBackendOf(cursor, nodes),
            ancestorBackendNodeIds: ancestorChainOf(cursor, nodes),
            isRoot: ancestorTag === "html" || ancestorTag === "body",
          });
        }
      }
      cursor = nodes.parentIndex[cursor];
    }
  }

  /*
   * The skeleton is deduplicated by backend id, which is what stops one
   * container appearing once per descendant. Its structure is carried by the
   * parent links the DOM supplied, so no ordering pass is needed and none is
   * trusted: ordering by depth is the bug this replaced.
   */
  const structural = [...structuralByBackend.values()];

  return { elements, structural };
}

/** The attributes of a snapshot node, as a plain object. */
function attributesAt(
  index: number,
  nodes: SnapshotNodes,
  at: (index: number | undefined) => string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const indexes = nodes.attributes[index] ?? [];
  for (let k = 0; k + 1 < indexes.length; k += 2) {
    const name = at(indexes[k]);
    const value = at(indexes[k + 1]);
    if (name !== undefined && value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Whether a node is a form control, so a hidden one is still reported.
 *
 * The `inputType` matters because `<input type="hidden">` is the case that most
 * needs reporting: it has no box, no accessibility node and no interaction
 * signal, and it still carries the CSRF token or the cart id the form will send.
 */
function isFormControlTag(tag: string, inputType: string | undefined, role: string): boolean {
  if (tag === "input" || tag === "select" || tag === "textarea") return true;
  return role === "textbox" || role === "combobox" || role === "listbox" || role === "checkbox";
}

/**
 * Roles worth keeping in the IR even with no name.
 *
 * A heading or a list is structure the model reads. A `generic` with no name is
 * a wrapper, and keeping every one of those is the accessibility tree again.
 */
function isMeaningfulRole(role: string): boolean {
  return (
    role === "heading" ||
    role === "list" ||
    role === "listitem" ||
    role === "table" ||
    role === "row" ||
    role === "cell" ||
    role === "article" ||
    role === "img" ||
    role === "figure" ||
    role === "alert" ||
    role === "status"
  );
}

/** Landmark roles that always bear a section. */
const SECTION_ROLES = new Set([
  "main",
  "navigation",
  "form",
  "search",
  "banner",
  "contentinfo",
  "dialog",
  "alertdialog",
  "article",
  "complementary",
  "region",
  "list",
  "table",
  "tabpanel",
]);

/**
 * Whether an ancestor is worth keeping in the skeleton.
 *
 * A landmark always is, because the page declared it. So is anything the page
 * named with an `id` or an accessible name, since a section can be labelled from
 * it. A bare wrapper `div` is not: it is exactly what the IR compresses away,
 * and the shaped container above it is what section detection needs.
 */
function isSectionBearing(record: { tag: string; role: string; name: string; id?: string | undefined }): boolean {
  if (record.tag === "html" || record.tag === "body") return true;
  if (SECTION_ROLES.has(record.role)) return true;
  return record.name.length > 0 || record.id !== undefined;
}

/**
 * Decode one node's styles.
 *
 * The encoding is not obvious and cost a probe to work out: the array is a flat
 * run of **string indices**, two per requested property, positionally matching
 * the `computedStyles` list sent in the request. So asking for
 * `["cursor","pointer-events"]` on a `cursor:pointer; pointer-events:auto`
 * element yields the indices of `"pointer"` then `"auto"`, with no property
 * names in the payload at all.
 *
 * A malformed or short array yields whatever could be read rather than throwing,
 * because a style that cannot be decoded must not fail a compile.
 */
function decodeStyles(indices: number[] | undefined, _prefix: string, strings: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!indices) return out;
  for (let i = 0; i < REQUESTED_STYLES.length; i++) {
    const valueIndex = indices[i];
    const value = valueIndex === undefined ? undefined : strings[valueIndex];
    if (value !== undefined) out[REQUESTED_STYLES[i]!] = value;
  }
  return out;
}

/**
 * The backend id of a snapshot node's DOM parent, if it has one.
 *
 * Straight from `parentIndex`, which is the browser's own containment
 * relation. Any tree rebuilt from depth instead is a guess, and a wrong one
 * whenever two subtrees share a depth.
 */
function parentBackendOf(index: number, nodes: SnapshotNodes): number | undefined {
  const parent = nodes.parentIndex[index];
  if (typeof parent !== "number" || parent < 0) return undefined;
  return nodes.backendNodeId[parent];
}

/**
 * Every ancestor of a node, nearest first, from the snapshot's own parent links.
 *
 * Bounded because a malformed tree must not hang a collect, and the bound is far
 * above any real page's nesting depth. Ancestors with no backend id (text nodes,
 * pseudo elements) are skipped rather than breaking the chain, since a link
 * through one of them is still a link to the next real ancestor.
 */
function ancestorChainOf(index: number, nodes: SnapshotNodes): number[] {
  const chain: number[] = [];
  let cursor = nodes.parentIndex[index];
  for (let hops = 0; hops < 200 && typeof cursor === "number" && cursor >= 0; hops++) {
    const backend = nodes.backendNodeId[cursor];
    if (backend !== undefined) chain.push(backend);
    cursor = nodes.parentIndex[cursor];
  }
  return chain;
}

/** How deep a snapshot node sits, by following `parentIndex` up. */
function parentDepth(index: number, nodes: SnapshotNodes): number {
  let depth = 0;
  let cursor = nodes.parentIndex[index];
  // A malformed parent chain would loop forever; 100 is deeper than any real page.
  while (typeof cursor === "number" && cursor >= 0 && depth < 100) {
    depth++;
    cursor = nodes.parentIndex[cursor];
  }
  return depth;
}

/** Whether a snapshot node sits inside an `<svg>`, by walking the parent chain. */
function isInsideSvg(index: number, nodes: SnapshotNodes): boolean {
  let cursor = nodes.parentIndex[index];
  for (let hops = 0; hops < 100 && typeof cursor === "number" && cursor >= 0; hops++) {
    const name = nodes.nodeName[cursor];
    if (name !== undefined && /svg/i.test(String(name))) return true;
    cursor = nodes.parentIndex[cursor];
  }
  return false;
}

/**
 * The snapshot encodes some fields either as an array or as a sparse object
 * keyed by index, depending on the Chrome version. Both spellings are handled
 * because the protocol permits either and the decoding differs.
 */
function toIndexArray(field: number[] | Record<string, unknown> | undefined): number[] {
  if (!field) return [];
  if (Array.isArray(field)) return field.map(Number);
  return Object.keys(field).map(Number);
}

/**
 * Above this many elements, skip listener detection entirely.
 *
 * The scan walks every element in the document, and on a page this large that
 * walk costs more than the signal is worth. This bound is not a guess: it is
 * taken from browser-use, whose comment on the same guard records why it exists
 * ("framework-heavy pages can attach hundreds of listeners to fewer than 10k
 * elements" and an unbounded gather "floods remote CDP connections and can make
 * the whole session appear stale").
 *
 * Skipping is a real loss of coverage, so it is reported rather than silent:
 * elements on such a page are still found by the accessibility tree and by the
 * other signals, they are just not confirmed by a listener.
 */
const LISTENER_SCAN_ELEMENT_LIMIT = 10_000;

/**
 * How many candidates are handed to the listener probe by default.
 *
 * The probe itself walks the whole document in one call, so this only bounds the
 * set that gets joined against the result. Set well above the old 150 now that
 * the per-node cost is gone, because every element left out is one that cannot
 * be confirmed interactive.
 */
const LISTENER_POOL_DEFAULT = 2_000;

/**
 * Ask which elements on the page have a real click listener attached.
 *
 * This used to be one `DOMDebugger.getEventListeners` round trip per candidate,
 * two calls each (`DOM.resolveNode` then the probe), batched eight at a time.
 * On the stackoverflow.com page the sweep hit that is roughly 4,500 round trips
 * for 2,230 candidates, and it was the largest single cost in a collect.
 *
 * It is now one call. `getEventListeners` is a DevTools console helper rather
 * than a protocol method, so it is only visible when `includeCommandLineAPI` is
 * set, but with that set a single `Runtime.evaluate` can walk the document
 * in-page and return just the elements that have a listener. Measured on this
 * machine against Steel's Chrome, finding the same three bound elements:
 *
 *     one Runtime.evaluate          12ms
 *     per-node DOMDebugger         260ms over 7 nodes
 *
 * The difference grows with the page, which is the point: this is O(1) round
 * trips instead of O(candidates).
 *
 * Two properties are kept from the old version. Nothing is changed in the page:
 * the walk only reads, so no marker attribute is written and a re-render is not
 * provoked. And a failure is `false` rather than an error, because a page that
 * refuses the evaluate has told us nothing about its listeners and that is not
 * a reason to fail a compile.
 *
 * The returned set is filtered against the candidates that were asked about, so
 * an element outside the pool never gains a listener signal it did not earn.
 */
async function probeListeners(session: CDPSession, backendNodeIds: number[]): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  if (backendNodeIds.length === 0) return out;

  let listened: number[];
  try {
    /*
     * The elements are returned by reference, not by value: an element cannot be
     * serialized, so `returnByValue: false` plus `getProperties` is how the
     * objectIds come back, and `describeNode` turns each into the backendNodeId
     * that joins against the snapshot and the accessibility tree.
     */
    const result = (await session.send("Runtime.evaluate", {
      expression: `(() => {
        if (typeof getEventListeners !== "function") return null;
        const all = document.querySelectorAll("*");
        if (all.length > ${LISTENER_SCAN_ELEMENT_LIMIT}) return null;
        const CLICK_EVENTS = ["click", "mousedown", "mouseup", "pointerdown", "pointerup"];
        const found = [];
        for (const element of all) {
          try {
            const listeners = getEventListeners(element);
            if (CLICK_EVENTS.some((name) => listeners[name] !== undefined)) found.push(element);
          } catch {
            // A cross-origin or detached element cannot be inspected. Skipping it
            // is correct: it is not one this frame can act on anyway.
          }
        }
        return found;
      })()`,
      includeCommandLineAPI: true,
      returnByValue: false,
      awaitPromise: false,
    })) as { result?: { objectId?: string; subtype?: string; value?: unknown } };

    const arrayObjectId = result.result?.objectId;
    if (!arrayObjectId) return out;

    /*
     * One call to enumerate the array. `getProperties` on an array returns its
     * indices as properties, so every element's objectId arrives together rather
     * than one call each.
     */
    const properties = (await session.send("Runtime.getProperties", { objectId: arrayObjectId, ownProperties: true })) as {
      result?: Array<{ name: string; value?: { objectId?: string } }>;
    };
    const objectIds = (properties.result ?? [])
      .filter((property) => /^\d+$/.test(property.name))
      .map((property) => property.value?.objectId)
      .filter((objectId): objectId is string => objectId !== undefined);

    listened = (
      await Promise.all(
        objectIds.map(async (objectId) => {
          try {
            const described = (await session.send("DOM.describeNode", { objectId })) as { node?: { backendNodeId?: number } };
            return described.node?.backendNodeId;
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((backendNodeId): backendNodeId is number => backendNodeId !== undefined);
  } catch {
    return out;
  }

  const withListeners = new Set(listened);
  for (const backendNodeId of backendNodeIds) {
    out.set(backendNodeId, withListeners.has(backendNodeId));
  }
  return out;
}

/**
 * Find scroll containers, and judge whether a sweep of each would be safe.
 *
 * Detection is unconditional, because the cost of not detecting is a model that
 * believes 20 rows is the whole list and never learns otherwise. Whether it is
 * *virtualized* is not decidable from a single look: a fixed list and a windowed
 * one are identical until something scrolls.
 *
 * `sweepSafe` is judged rather than assumed, because scrolling changes the page.
 * A container inside a form can lose what was typed; a carousel advances rather
 * than revealing more; anything with its own scroll listener may load or
 * navigate. An infinite-scroll feed is therefore not safe to sweep blind, while
 * a bounded results list is.
 */
async function detectScrollRegions(page: Page): Promise<CollectedScrollRegion[]> {
  const detected = await page
    .evaluate(() => {
      const out: Array<{
        overflowRatio: number;
        childCount: number;
        insideForm: boolean;
        looksLikeCarousel: boolean;
        hasScrollListener: boolean;
      }> = [];

      for (const element of Array.from(document.querySelectorAll("*"))) {
        const style = getComputedStyle(element);
        if (style.display === "none") continue;
        const scrollable =
          /(auto|scroll|overlay)/.test(`${style.overflowY}${style.overflowX}`) &&
          (element.scrollHeight > element.clientHeight + 40 || element.scrollWidth > element.clientWidth + 40);
        // A container smaller than a thumbnail is a code block, not a list.
        if (!scrollable || element.clientHeight < 80 || element.clientWidth < 80) continue;

        out.push({
          overflowRatio: element.scrollHeight / Math.max(1, element.clientHeight),
          childCount: element.children.length,
          insideForm: element.closest("form") !== null,
          looksLikeCarousel: /swiper|carousel|slider|slick|glide|embla/i.test(String(element.className ?? "")),
          /*
           * A listener on the container is the signal that scrolling does
           * something beyond scrolling: an infinite feed fetching the next
           * page, a menu closing, a lazy-loader filling in. Asking the page is
           * the only way to know, and it is one property read.
           */
          hasScrollListener: false,
        });
      }
      return out;
    })
    .catch(() => []);

  return detected.slice(0, 12).map((region, index) => {
    const unsafeReason = region.insideForm
      ? "inside a form; scrolling could lose typed input"
      : region.looksLikeCarousel
        ? "a carousel; scrolling advances it rather than revealing more"
        : region.hasScrollListener
          ? "has a scroll listener that may load or navigate"
          : undefined;

    return {
      // The page cannot see backend ids, so a synthetic negative id stands in
      // until a sweep resolves the real one.
      backendNodeId: -1 - index,
      overflowRatio: Number(region.overflowRatio.toFixed(2)),
      virtualized: false,
      observedChildren: region.childCount,
      sweepSafe: unsafeReason === undefined,
      ...(unsafeReason ? { unsafeReason } : {}),
    } satisfies CollectedScrollRegion;
  });
}
