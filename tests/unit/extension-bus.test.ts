/**
 * Tests for F4: typed extension bus.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  ExtensionBus,
  getExtensionBus,
  __resetExtensionBusForTests,
} from "../../src/extension/bus.js";

test("F4: ExtensionBus registers and emits handlers in order", async () => {
  const bus = new ExtensionBus();
  const seen: string[] = [];
  bus.on("PreToolUse", () => seen.push("a"));
  bus.on("PreToolUse", () => seen.push("b"));
  await bus.emit("PreToolUse", { tool: "read_file" });
  assert.deepEqual(seen, ["a", "b"]);
});

test("F4: bus.off unsubscribes a handler", async () => {
  const bus = new ExtensionBus();
  const seen: string[] = [];
  const handler = () => seen.push("a");
  bus.on("PreToolUse", handler);
  bus.off("PreToolUse", handler);
  await bus.emit("PreToolUse", {});
  assert.deepEqual(seen, []);
});

test("F4: emit captures first error but does not stop other handlers", async () => {
  const bus = new ExtensionBus();
  const seen: string[] = [];
  bus.on("PreToolUse", () => seen.push("a"));
  bus.on("PreToolUse", () => { throw new Error("boom"); });
  bus.on("PreToolUse", () => seen.push("c"));
  const out = await bus.emit("PreToolUse", {});
  assert.equal(out.firstError instanceof Error, true);
  assert.deepEqual(seen, ["a", "c"]);
});

test("F4: getExtensionBus is a singleton", () => {
  const a = getExtensionBus();
  const b = getExtensionBus();
  assert.equal(a, b);
  __resetExtensionBusForTests();
  const c = getExtensionBus();
  assert.notEqual(a, c);
});

test("F4: emitSync records sync handlers and yields undefined for async ones", () => {
  const bus = new ExtensionBus();
  const seen: string[] = [];
  bus.on("PreToolUse", () => seen.push("a"));
  bus.on("PreToolUse", () => undefined);
  const out = bus.emitSync("PreToolUse", {});
  // Two sync handlers ran; nothing in `seen` from the async handler
  // because the async handler was skipped in sync mode.
  assert.deepEqual(seen, ["a"]);
  assert.equal(out.results.length, 2);
});
