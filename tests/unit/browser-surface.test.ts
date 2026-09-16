import test from "node:test";
import assert from "node:assert/strict";

import { applyNotification, emptyThreads } from "../../web/shared/src/index.js";

/**
 * The client reducer lifts a completed `browser_use` tool call into
 * `thread.browser`, so the Browser panel renders a screenshot + overlay without
 * knowing which tool produced the data. This pins that fold.
 */

function completed(params: {
  threadId: string;
  turnId: string;
  sequence: number;
  item: Record<string, unknown>;
}): [string, Record<string, unknown>] {
  return ["item/completed", params];
}

test("a completed browser_use call surfaces the page it left the model on", () => {
  /*
   * The tool returns a `surface` beside the prose the model reads, so the pane
   * shows the same step the model was looking at rather than a second reading
   * taken later.
   *
   * The old shape also carried an `interactive` list of `ref`/`x`/`y` overlay
   * entries, which went with the tool that produced it: a ref was a position in
   * a snapshot rather than an identity, so an overlay could point at a different
   * element after a re-render without anything saying so.
   */
  const [method, params] = completed({
    threadId: "t",
    turnId: "u",
    sequence: 3,
    item: {
      type: "dynamicToolCall",
      id: "browser-1",
      tool: "browser_use",
      arguments: { code: "page.url()" },
      status: "completed",
      result: {
        output: "OUTCOME: SUCCESS",
        outcome: "SUCCESS",
        rev: 3,
        surface: { url: "https://example.com/app", title: "Example App", viewport: { width: 1280, height: 800 } },
      },
    },
  });

  const state = applyNotification(emptyThreads(), method, params);
  const browser = state["t"]?.browser;
  assert.ok(browser, "thread.browser should be set");
  assert.equal(browser.url, "https://example.com/app");
  assert.equal(browser.title, "Example App");
  assert.deepEqual(browser.viewport, { width: 1280, height: 800 });
  assert.deepEqual(browser.interactive, [], "there are no ref overlays any more, and an empty list says so");
});

test("a later browser_use completion replaces the earlier surface", () => {
  let state = emptyThreads();
  const [m1, p1] = completed({
    threadId: "t",
    turnId: "u",
    sequence: 2,
    item: {
      type: "dynamicToolCall",
      id: "b1",
      tool: "browser_use",
      arguments: {},
      status: "completed",
      result: { output: "OUTCOME: SUCCESS", surface: { url: "https://a", title: "A" } },
    },
  });
  state = applyNotification(state, m1, p1);
  assert.equal(state["t"]?.browser?.url, "https://a");

  const [m2, p2] = completed({
    threadId: "t",
    turnId: "u",
    sequence: 4,
    item: {
      type: "dynamicToolCall",
      id: "b2",
      tool: "browser_use",
      arguments: {},
      status: "completed",
      result: { output: "OUTCOME: SUCCESS", surface: { url: "https://b", title: "B" } },
    },
  });
  state = applyNotification(state, m2, p2);
  assert.equal(state["t"]?.browser?.url, "https://b");
});

test("non-browser tool completions leave thread.browser untouched", () => {
  const [method, params] = completed({
    threadId: "t",
    turnId: "u",
    sequence: 3,
    item: {
      type: "dynamicToolCall",
      id: "grep-1",
      tool: "grep_search",
      arguments: {},
      status: "completed",
      result: { matches: [] },
    },
  });
  const state = applyNotification(emptyThreads(), method, params);
  assert.equal(state["t"]?.browser, undefined);
});

test("a failed browser_use call does not surface", () => {
  const [method, params] = completed({
    threadId: "t",
    turnId: "u",
    sequence: 3,
    item: {
      type: "dynamicToolCall",
      id: "browser-1",
      tool: "browser_use",
      arguments: {},
      status: "failed",
      error: "page crashed",
      result: { url: "https://example.com", title: "x", interactive: [] },
    },
  });
  const state = applyNotification(emptyThreads(), method, params);
  assert.equal(state["t"]?.browser, undefined);
});

test("a browser result without a url does not surface", () => {
  const [method, params] = completed({
    threadId: "t",
    turnId: "u",
    sequence: 3,
    item: {
      type: "dynamicToolCall",
      id: "browser-1",
      tool: "browser_use",
      arguments: { action: "close" },
      status: "completed",
      result: { action: "close", status: "closed" },
    },
  });
  const state = applyNotification(emptyThreads(), method, params);
  assert.equal(state["t"]?.browser, undefined);
});
