import { chromium } from "playwright";
import { collectPage } from "../../src/browser/collect.js";
import { compileIr, type IrNode } from "../../src/browser/ir.js";

const url = process.argv[2]!;
const b = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 30000 });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(400);
const collected = await collectPage(page);
console.log(`collected ${collected.elements.length} elements from ${url}`);

/*
 * Rebuild the tree the IR walks.
 *
 * The collector returns a flat list because a flat list is what the browser
 * gives; the compiler walks a tree because section detection is about
 * containment. So the parent links are reconstructed from depth here, which is
 * the bridge between the two and belongs in the compiler rather than in a
 * verification script. Left visible here for now so the shape of that bridge is
 * clear before it moves.
 */
/*
 * Merge the skeleton and the elements into one tree the compiler walks.
 *
 * The skeleton supplies containment and landmarks; the elements supply the
 * things to act on. Merging them here, rather than in a caller, is the next
 * step: `compileIr` should take a `CollectedPage` directly and do this itself.
 */
const all = [
  ...collected.structural.map((n) => ({ kind: "structural" as const, node: n })),
  ...collected.elements.map((e) => ({
    kind: "element" as const,
    node: { backendNodeId: e.backendNodeId, depth: e.depth, role: e.role, name: e.accessibleName, tag: e.tag },
  })),
].sort((a, b) => a.node.depth - b.node.depth);

const nodes: IrNode[] = all.map((entry, i) => {
  if (entry.kind === "structural") {
    return { role: entry.node.role, name: entry.node.name, index: i, depth: entry.node.depth, children: [], tag: entry.node.tag };
  }
  const e = collected.elements.find((c) => c.backendNodeId === entry.node.backendNodeId)!;
  return {
    role: e.role, name: e.accessibleName, index: i, depth: e.depth, children: [],
    id: e.id, testId: e.testId, href: e.href, value: e.value, states: e.states, tag: e.tag,
    hidden: !e.visible,
  };
});
const stackIdx: number[] = [];
for (let i = 0; i < nodes.length; i++) {
  const node = nodes[i]!;
  while (stackIdx.length > 0 && nodes[stackIdx.at(-1)!]!.depth >= node.depth) stackIdx.pop();
  if (stackIdx.length > 0) nodes[stackIdx.at(-1)!]!.children.push(i);
  stackIdx.push(i);
}
const roots = nodes.map((_, i) => i).filter((i) => !nodes.some((n) => n.children.includes(i)));
console.log(`skeleton=${collected.structural.length} elements=${collected.elements.length} roots=${roots.length}`);
const ir = compileIr({ url, title: await page.title(), nodes, root: roots[0] ?? 0 }, { context: { goal: "understand this page" } });
console.log(`sections=${ir.sections.length} elements=${ir.elements.size}`);
for (const s of ir.sections.slice(0, 12)) {
  console.log(`  [${s.id}] ${s.kind.padEnd(10)} "${s.label.slice(0,30).padEnd(30)}" els=${s.elements.length} :: ${s.summary.slice(0,50)}`);
}
await ctx.close(); await b.close();
