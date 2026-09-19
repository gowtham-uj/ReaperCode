import { test } from "node:test";
import assert from "node:assert/strict";

import { PageRegistry } from "../../../../src/browser/runtime/page-registry.js";

/** A page stand-in: the registry only ever asks whether it is closed. */
const fakePage = (closed = false) => ({ isClosed: () => closed, url: () => "https://example.com/" }) as never;

test("a page opened while an action runs is a popup attributed to that action", () => {
  /*
   * The provenance a benchmark checks. A task that asks for a popup is asking
   * whether a click caused one, and that cannot be recovered after the fact:
   * either it was recorded while the action was current or the answer is a guess.
   */
  const registry = new PageRegistry();
  const parent = fakePage();
  registry.register("main", parent, { creationType: "newPage" });

  registry.setCurrentAction("a152");
  const popup = registry.register("popup-1", fakePage(), { parent });
  assert.equal(popup.creationType, "popup");
  assert.equal(popup.openedBy, "a152");
  assert.equal(popup.parentId, "p1");
});

test("a page opened between actions is a newPage, not a popup", () => {
  const registry = new PageRegistry();
  const page = registry.register("tab", fakePage());
  assert.equal(page.creationType, "newPage");
  assert.equal(page.openedBy, undefined);
});

test("an explicit creation type wins over the inference", () => {
  /*
   * `browser.newPage()` during a step must not be recorded as a popup simply
   * because an action is running. The caller that knows is the caller that says.
   */
  const registry = new PageRegistry();
  registry.setCurrentAction("a1");
  const page = registry.register("tab", fakePage(), { creationType: "newPage" });
  assert.equal(page.creationType, "newPage");
});

test("ids are stable across a rename, and the name is rebound", () => {
  /*
   * A program that held `p3` must keep working after the model names the tab,
   * because the id is the handle and the name is the human label.
   */
  const registry = new PageRegistry();
  const page = fakePage();
  const first = registry.register("page-abc-1", page);
  const second = registry.register("parabank", page);
  assert.equal(first.id, "p1");
  assert.equal(second.id, "p1");
  assert.equal(registry.find("p1")?.name, "parabank");
  assert.equal(registry.find("parabank")?.id, "p1");
  assert.equal(registry.find("page-abc-1"), undefined);
});

test("registering the same page twice does not mint a second id", () => {
  const registry = new PageRegistry();
  const page = fakePage();
  registry.register("a", page);
  registry.register("a", page);
  assert.equal(registry.entries().length, 1);
});

test("a name and an id both resolve to the same page", () => {
  const registry = new PageRegistry();
  const page = fakePage();
  const entry = registry.register("parabank", page);
  assert.equal(registry.find("parabank")?.page, page);
  assert.equal(registry.find(entry.id)?.page, page);
  // And by object identity, which is how a program holding a page switches to it.
  assert.equal(registry.find(page)?.id, entry.id);
});

test("a closed page is forgotten so a name does not point at a corpse", () => {
  const registry = new PageRegistry();
  const page = fakePage();
  registry.register("gone", page);
  registry.forget(page);
  assert.equal(registry.find("gone"), undefined);
  assert.equal(registry.live().length, 0);
});

test("the rendered list names both handles, so the model stops re-deriving them", async () => {
  const registry = new PageRegistry();
  const page = fakePage();
  const entry = registry.register("parabank", page);
  const text = await registry.render(page);
  assert.match(text, new RegExp(entry.id));
  assert.match(text, /parabank/);
  // The starred entry is the active page, which is what a bare `page` means.
  assert.match(text, /^\* p1/m);
});
