import { chromium } from "playwright";
import { collectPage } from "../../src/browser/collect.js";
import { compileCollected } from "../../src/browser/ir-tree.js";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 30000 });
const ctx = await b.newContext(); const page = await ctx.newPage();
await page.setContent(`<!doctype html><body><main>
<form aria-label="Checkout">
  <input type="text" name="email" id="vis" value="a@b.c">
  <input type="hidden" name="csrf" id="csrf" value="tok123">
  <input type="hidden" name="cart_id" id="cart" value="99">
  <div style="display:none"><input type="text" name="promo" id="promo" value="PRM10"><button id="apply">Apply promo</button></div>
  <button type="submit" id="go">Place order</button>
</form></main></body>`);
await page.waitForTimeout(300);
const collected = await collectPage(page);
const ir = compileCollected(collected, { context: { goal: "complete checkout" } });
console.log(`collected ${collected.elements.length} elements, ir ${ir.elements.size}`);
console.log("\nsections:");
for (const s of ir.sections) console.log(`  [${s.id}] ${s.kind} "${s.label}" actions=${s.elements.length} hidden=${s.hiddenCount ?? 0}`);
console.log("\nall elements in the IR (e=actionable, h=hidden):");
for (const [id, e] of ir.elements) {
  console.log(`  ${id.padEnd(4)} ${e.hidden ? "HIDDEN" : "action"} ${e.role.padEnd(9)} "${e.name}" val=${JSON.stringify(e.value ?? "")} ${e.hiddenBecause ? `(${e.hiddenBecause})` : ""}`);
}
await ctx.close(); await b.close();
