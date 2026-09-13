import test from "node:test";
import assert from "node:assert/strict";

import { applyNotification, emptyThreads } from "../../web/shared/src/index.js";

/**
 * The client reducer lifts a completed `browser_control` tool call into
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

test("a completed browser_control call surfaces url, title, viewport, screenshot and interactive", () => {
  const [method, params] = completed({
    threadId: "t",
    turnId: "u",
    sequence: 3,
    item: {
      type: "dynamicToolCall",
      id: "browser-1",
      tool: "browser_control",
      arguments: { action: "snapshot" },
      status: "completed",
      result: {
        url: "https://example.com/app",
        title: "Example App",
        viewport: { width: 1280, height: 800 },
        screenshotPath: "logs/run-1/artifacts/browser-1.png",
        interactive: [
          { ref: "a1", index: 1, tag: "button", text: "Submit", x: 10, y: 20, width: 80, height: 30 },
        ],
      },
    },
  });

  const state = applyNotification(emptyThreads(), method, params);
  const browser = state["t"]?.browser;
  assert.ok(browser, "thread.browser should be set");
  assert.equal(browser.url, "https://example.com/app");
  assert.equal(browser.title, "Example App");
  assert.deepEqual(browser.viewport, { width: 1280, height: 800 });
  assert.equal(browser.screenshotPath, "logs/run-1/artifacts/browser-1.png");
  assert.equal(browser.interactive.length, 1);
  assert.equal(browser.interactive[0]!.ref, "a1");
});

test("a later browser_control completion replaces the earlier surface", () => {
  let state = emptyThreads();
  const [m1, p1] = completed({
    threadId: "t",
    turnId: "u",
    sequence: 2,
    item: {
      type: "dynamicToolCall",
      id: "b1",
      tool: "browser_control",
      arguments: {},
      status: "completed",
      result: { url: "https://a", title: "A", interactive: [] },
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
      tool: "browser_control",
      arguments: {},
      status: "completed",
      result: { url: "https://b", title: "B", interactive: [] },
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

test("a failed browser_control call does not surface", () => {
  const [method, params] = completed({
    threadId: "t",
    turnId: "u",
    sequence: 3,
    item: {
      type: "dynamicToolCall",
      id: "browser-1",
      tool: "browser_control",
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
      tool: "browser_control",
      arguments: { action: "close" },
      status: "completed",
      result: { action: "close", status: "closed" },
    },
  });
  const state = applyNotification(emptyThreads(), method, params);
  assert.equal(state["t"]?.browser, undefined);
});
