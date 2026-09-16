/**
 * The bridge between the collector and the compiler.
 *
 * The collector produces two flat lists, both keyed by `backendNodeId` with a
 * `parentBackendNodeId` link, because a flat list is what the browser gives. The
 * compiler walks a tree, because section detection is about containment: a
 * `form` is a section because the button is inside it.
 *
 * This is where the two meet, and the joining rule is what matters. It uses the
 * **DOM's own parent links**, never a re-derivation from depth.
 *
 * The depth approach was tried and it is wrong in a way that looks right: two
 * nodes at the same depth in different subtrees have no order between them, so
 * sorting the flat lists by depth interleaves unrelated branches. On Hacker News
 * that produced a tree in which one `<form>` appeared to contain the whole page,
 * and the compile came back as a single 484-element section. The numbers looked
 * plausible, which is exactly what made it worth not trusting.
 *
 * Ordering within one parent is by document position, which the collector
 * preserves because the snapshot emits nodes in document order.
 */

import type { BrowserIR, IrNode } from "./ir.js";
import { compileIr, type CompileOptions } from "./ir.js";
import type { CandidateElement, CollectedPage, StructuralNode } from "./collect.js";

/**
 * Assemble the tree the compiler walks.
 *
 * Skeleton nodes come first within each parent, because a landmark container
 * has to be reachable before the things inside it are; leaving that to sort
 * order by index alone would put a button above the form it lives in whenever
 * the button happened to be collected first.
 */
export function buildIrTree(collected: CollectedPage): { nodes: IrNode[]; root: number } {
  interface Entry {
    backendNodeId: number;
    parentBackendNodeId?: number | undefined;
    /** Every ancestor, nearest first, when the collector recorded one. */
    ancestors?: number[] | undefined;
    /** Document position as the browser reported it, for stable ordering. */
    order: number;
    node: IrNode;
    /** True for a container, false for something to act on. */
    structural: boolean;
  }

  const entries: Entry[] = [];
  const seen = new Set<number>();
  let order = 0;

  /*
   * Structural nodes first, then elements, with an element winning when the
   * same backend id is in both.
   *
   * The collector tries to keep the two lists disjoint, and this is the belt to
   * that pair of braces: an id in both lists would produce two sections with the
   * same label and two elements with the same name, which is what happened
   * before the collector's walk was fixed. An element is the richer record, so
   * it replaces the structural entry rather than coexisting with it.
   */
  for (const element of collected.elements) {
    const node = elementToNode(element, 0);
    entries.push({
      backendNodeId: element.backendNodeId,
      parentBackendNodeId: element.parentBackendNodeId,
      ancestors: element.ancestorBackendNodeIds,
      order: order++,
      structural: false,
      node,
    });
    seen.add(element.backendNodeId);
  }

  for (const node of collected.structural) {
    if (seen.has(node.backendNodeId)) continue;
    entries.push({
      backendNodeId: node.backendNodeId,
      parentBackendNodeId: node.parentBackendNodeId,
      /*
       * The chain, so a container whose direct parent was filtered attaches to
       * its nearest kept ancestor rather than to the document root. Without it
       * Hacker News's table hierarchy was lost and thirty rows compiled as
       * thirty sections instead of one list.
       */
      ancestors: node.ancestorBackendNodeIds,
      order: order++,
      structural: true,
      node: {
        role: node.role,
        name: node.name,
        index: 0,
        depth: node.depth,
        children: [],
        tag: node.tag,
      },
    });
    seen.add(node.backendNodeId);
  }

  /*
   * Index by backend id, then attach each entry to its parent. A node whose
   * parent is not in the set (a bare wrapper div that was filtered out) is
   * attached to the nearest ancestor that IS in the set, by walking up through
   * the collector's own links, or becomes a root when there is none.
   */
  const byBackend = new Map<number, Entry>();
  for (const entry of entries) byBackend.set(entry.backendNodeId, entry);

  /*
   * Every parent link the DOM gave us, for nodes that did not make it into the
   * tree, so an orphan can be walked up to the nearest ancestor that did.
   *
   * Without this the tree is flat and the compile silently loses elements. The
   * first version of this function had the walking loop but broke out of it on
   * the first iteration, so it never actually walked: any element whose direct
   * parent had been filtered out became a root. On a form page that meant the
   * hidden inputs, whose parent container was not kept, hung off the document
   * root, belonged to no section, and were dropped from the model's view
   * entirely. A fixture caught it; nothing else would have, because the visible
   * elements still compiled and the page still looked like it had worked.
   */
  /**
   * The ancestor chain for a node, nearest first.
   *
   * Taken from the collector when it recorded one, because only the collector
   * has the whole DOM: an element's immediate parent is usually a wrapper that
   * was filtered out, and a single parent link to a filtered node walks nowhere.
   * The structural nodes carry only a parent link, which is enough for them
   * because the collector keeps a container's ancestors by construction.
   */
  const chainFor = (entry: Entry): number[] => {
    const recorded = entry.ancestors ?? [];
    if (recorded.length > 0) return recorded;
    if (entry.parentBackendNodeId === undefined) return [];
    const parentEntry = byBackend.get(entry.parentBackendNodeId);
    return [...(parentEntry ? chainFor(parentEntry) : []), entry.parentBackendNodeId];
  };

  /**
   * The nearest ancestor that is in the tree, or undefined when there is none.
   *
   * Bounded because a malformed or cyclic chain must not hang a compile; the
   * bound is far above any real page's nesting depth.
   */
  const nearestKeptAncestor = (entry: Entry): Entry | undefined => {
    for (const candidate of chainFor(entry).slice(0, 200)) {
      const found = byBackend.get(candidate);
      if (found) return found;
    }
    return undefined;
  };

  const childrenOf = new Map<Entry, Entry[]>();
  const roots: Entry[] = [];

  for (const entry of entries) {
    /*
     * Walking up only happens when a wrapper was filtered, which is common: the
     * collector keeps landmarks and named containers, so a button inside
     * `<div class="wrap"><form>` has a parent the tree does not hold. Attaching
     * it to the form is the right answer, and it is what this does.
     */
    const parent = nearestKeptAncestor(entry);
    if (!parent) roots.push(entry);
    else (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push(entry);
  }

  /* Children in document order, containers before their contents at equal rank. */
  for (const children of childrenOf.values()) {
    children.sort((a, b) => Number(b.structural) - Number(a.structural) || a.order - b.order);
  }
  roots.sort((a, b) => Number(b.structural) - Number(a.structural) || a.order - b.order);

  /*
   * A synthetic document root, always. The compiler skips it as a section (a
   * root is never a section) but everything hangs from it, which is what gives
   * the walk a single trunk instead of a forest where picking a root by index
   * decides the whole compile.
   */
  const nodes: IrNode[] = [];
  const rootIndex = nodes.length;
  nodes.push({ role: "rootwebarea", name: "", index: rootIndex, depth: 0, children: [] });

  const emit = (entry: Entry, depth: number): number => {
    const index = nodes.length;
    const node = { ...entry.node, index, depth, children: [] as number[] };
    nodes.push(node);
    for (const child of childrenOf.get(entry) ?? []) node.children.push(emit(child, depth + 1));
    return index;
  };

  for (const entry of roots) nodes[rootIndex]!.children.push(emit(entry, 1));

  return { nodes, root: rootIndex };
}

/** A collected element as a compiler node. */
function elementToNode(element: CandidateElement, index: number): IrNode {
  return {
    role: element.role,
    name: element.accessibleName,
    index,
    depth: element.depth,
    children: [],
    ...(element.id !== undefined ? { id: element.id } : {}),
    ...(element.testId !== undefined ? { testId: element.testId } : {}),
    ...(element.placeholder !== undefined ? { placeholder: element.placeholder } : {}),
    ...(element.href !== undefined ? { href: element.href } : {}),
    ...(element.value !== undefined ? { value: element.value } : {}),
    ...(element.states.length > 0 ? { states: element.states } : {}),
    ...(element.tag !== undefined ? { tag: element.tag } : {}),
    ...(element.inputType !== undefined ? { inputType: element.inputType } : {}),
    ...(element.visible === false ? { hidden: true } : {}),
    ...(element.textContent !== undefined ? { textContent: element.textContent } : {}),
  };
}

/**
 * Compile a collected page, which is the whole pipeline in one call.
 *
 * The collector's own pipeline counts ride along into the compile, so the IR
 * can say whether an empty result means an empty page or an unread one. Without
 * this the counts are computed and thrown away, and the compile has no way to
 * tell the two apart even though the collector already knows.
 */
export function compileCollected(collected: CollectedPage, options: CompileOptions = {}): BrowserIR {
  const { nodes, root } = buildIrTree(collected);
  /*
   * Frames: the collector already records which ones it failed to read and why,
   * which is the fact that turns "some content is missing" into "this iframe is
   * cross-origin and blocked", and those are very different things to be told.
   */
  const unread = collected.frames.filter((frame) => !frame.read);
  const frames = {
    total: collected.frames.length,
    read: collected.frames.length - unread.length,
    ...(unread.length > 0
      ? { unread: unread.map((frame) => `${frame.prefix || "main"} ${frame.url}${frame.unreadReason ? ` (${frame.unreadReason})` : ""}`) }
      : {}),
  };
  return compileIr({ url: collected.url, title: collected.title, nodes, root, coverage: { counts: collected.counts, frames, complete: true } }, options);
}
