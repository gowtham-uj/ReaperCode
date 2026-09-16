/**
 * The result walker, tested without a browser.
 *
 * Two things are worth knowing about the cases here. The Playwright detection
 * is structural — `_channel` plus `_connection` — so the fixtures build that
 * shape by hand rather than importing Playwright, which keeps this a unit test
 * and, more importantly, tests the *detection rule* rather than whether a
 * particular Playwright version happens to be installed.
 *
 * And every cap is asserted to *report itself*. A truncation nobody mentions is
 * indistinguishable from a small result, which is the failure that makes a
 * model trust a partial answer.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { playwrightName, serializeBrowserResult } from "../../../src/browser/serialize.js";

/** The shape every Playwright client object shares. */
function fakePlaywrightObject(protocolType: string): unknown {
  return {
    _channel: { _objectId: "x" },
    _connection: { _objects: new Map() },
    _initializer: { type: protocolType },
    // The plumbing that must never reach the model.
    _events: { on: () => {} },
    _guide: "internal",
  };
}

test("a returned Page is named, not walked", () => {
  const page = fakePlaywrightObject("page");
  const result = serializeBrowserResult({ page });
  const value = result.value as { page: string };
  assert.match(value.page, /Playwright Page/);
  assert.doesNotMatch(JSON.stringify(result.value), /_connection|_channel|_guide/, "internal fields must not leak");
});

test("a returned Locator is named too", () => {
  const result = serializeBrowserResult({ el: fakePlaywrightObject("locator") });
  assert.match((result.value as { el: string }).el, /Playwright Locator/);
});

test("the Page hint points at what to do instead", () => {
  const page = { ...(fakePlaywrightObject("page") as object), url: () => "https://x" };
  const result = serializeBrowserResult(page);
  assert.match(String(result.value), /await page\.title\(\)/, "a returned Page should suggest the fix");
});

test("an object that merely resembles one is not mistaken for it", () => {
  /*
   * The reason the check is strict about both fields. A script's own object
   * called `page`, or a plain data object that happens to have a `_channel`,
   * must serialize normally — otherwise a legitimate result is replaced by
   * "[Playwright Page]" and the model loses real data.
   */
  const lookalike = { name: "my page object", _channel: "not a channel" };
  const result = serializeBrowserResult(lookalike);
  assert.deepEqual(result.value, { name: "my page object", _channel: "not a channel" });
});

test("plain data survives unchanged", () => {
  const input = { titles: ["a", "b"], count: 2, ok: true, nested: { deep: [1, 2, 3] } };
  const result = serializeBrowserResult(input);
  assert.deepEqual(result.value, input);
  assert.equal(result.truncated, false);
});

test("NaN and Infinity become strings rather than null", () => {
  /*
   * `JSON.stringify` turns both into `null`, which reads as "no value" rather
   * than "not a number" — a different fact about the page.
   */
  const result = serializeBrowserResult({ a: NaN, b: Infinity, c: -Infinity });
  assert.deepEqual(result.value, { a: "NaN", b: "Infinity", c: "-Infinity" });
  assert.match(JSON.stringify(result.value), /"NaN"/);
});

test("a circular reference is marked rather than thrown on", () => {
  const node: Record<string, unknown> = { name: "root" };
  node.self = node;
  const result = serializeBrowserResult(node);
  assert.match(JSON.stringify(result.value), /\[Circular\]/);
});

test("a long string is cut and says how much was dropped", () => {
  const long = "x".repeat(100);
  const result = serializeBrowserResult({ text: long }, { maxString: 20 });
  const value = (result.value as { text: string }).text;
  assert.ok(value.startsWith("x".repeat(20)), "the head of the string is kept");
  assert.match(value, /80 more characters/, "the drop is stated, not silent");
});

test("a long array keeps a head and reports the tail", () => {
  const items = Array.from({ length: 250 }, (_, i) => i);
  const result = serializeBrowserResult(items, { maxEntries: 10 });
  const value = result.value as unknown[];
  assert.equal(value.length, 11, "10 entries plus the marker");
  assert.match(String(value[10]), /\+240 more items/);
});

test("deep nesting stops with an explanation", () => {
  let deep: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < 12; i += 1) deep = { next: deep };
  const result = serializeBrowserResult(deep, { maxDepth: 3 });
  assert.match(JSON.stringify(result.value), /nested too deeply/);
});

test("a getter that throws does not lose the rest of the object", () => {
  const hostile = {
    good: "kept",
    get bad(): string {
      throw new Error("boom");
    },
  };
  const result = serializeBrowserResult(hostile);
  const value = result.value as Record<string, string>;
  assert.equal(value.good, "kept", "the readable field survives");
  assert.match(value.bad ?? "", /threw on access: boom/);
});

test("the total size cap cuts on a line boundary and reports the remainder", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const result = serializeBrowserResult({ body: lines }, { maxTotalChars: 200 });
  assert.equal(result.truncated, true);
  assert.match(String(result.value), /result truncated: \d+ more characters not shown/);
});

test("functions and bigints are described, not dropped", () => {
  const result = serializeBrowserResult({
    fn: function namedThing() {},
    // An arrow assigned to a property takes that property's name, so this
    // arrives as `anon`, not as anonymous. Asserting `[Function]` here would be
    // asserting something JavaScript does not do.
    anon: () => {},
    big: 9007199254740993n,
  });
  const value = result.value as Record<string, string>;
  assert.equal(value.fn, "[Function: namedThing]");
  assert.equal(value.anon, "[Function: anon]");
  assert.equal(value.big, "9007199254740993n", "the n suffix keeps it distinguishable from a number");
});

test("a function with no name of its own is described by shape alone", () => {
  /*
   * Reaching the nameless branch is harder than it looks: an arrow assigned to
   * a property takes the property's name, and V8 names a `new Function(...)`
   * result "anonymous". So the name is deleted to get there, and the assertion
   * is that the label still says *something* — a dropped function would read as
   * a missing value rather than as a function.
   */
  const nameless = () => {};
  Object.defineProperty(nameless, "name", { value: "" });
  const result = serializeBrowserResult({ nameless });
  assert.equal((result.value as Record<string, string>).nameless, "[Function]");
});

test("binary data is summarized by size", () => {
  const result = serializeBrowserResult({ buf: new Uint8Array(64) });
  assert.equal((result.value as { buf: string }).buf, "[binary 64 bytes]");
});

test("playwrightName reports nothing for ordinary values", () => {
  assert.equal(playwrightName(null), undefined);
  assert.equal(playwrightName("page"), undefined);
  assert.equal(playwrightName({ _channel: 1 }), undefined, "one field is not enough");
  assert.equal(playwrightName({ _connection: 1 }), undefined, "one field is not enough");
});
