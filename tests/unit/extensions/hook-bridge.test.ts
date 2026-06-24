/**
 * HookRunner bridge between Hooks + ExtensionBus.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HookRunner } from "../../../src/extensions/hook-runner.js";
import { installHookBridge } from "../../../src/runtime/hook-bridge.js";
import { Hooks } from "../../../src/adaptive/hooks.js";
import { ExtensionBus } from "../../../src/extension/bus.js";

async function flush(): Promise<void> {
  // Microtask queue + setImmediate. Two passes is enough for the
  // bridge's `queueMicrotask(() => dispatch(...))` chain to land.
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => setImmediate(r));
  }
}

test("bridge: bus.PreToolUse event reaches HookRunner", async () => {
  const hooks = new Hooks();
  const bus = new ExtensionBus();
  const runner = new HookRunner({ defaultTimeoutMs: 1000 });
  const received: string[] = [];
  runner.register("ext", "PreToolUse", async (env) => {
    const p = env.payload as { toolName?: string };
    received.push(p?.toolName ?? "?");
    return { allow: true };
  });
  const cleanup = installHookBridge({ hooks, bus, runner });
  // Emit and wait for the async bridge chain to land.
  await bus.emit("PreToolUse", { payload: { toolName: "read_file" } });
  await flush();
  assert.ok(received.includes("read_file"), `expected read_file, got [${received.join(",")}]`);
  cleanup();
});

test("bridge: bus.PreToolUse event for write_file reaches HookRunner", async () => {
  const hooks = new Hooks();
  const bus = new ExtensionBus();
  const runner = new HookRunner({ defaultTimeoutMs: 1000 });
  const received: string[] = [];
  runner.register("ext", "PreToolUse", async (env) => {
    const p = env.payload as { toolName?: string };
    received.push(p?.toolName ?? "?");
    return { allow: true };
  });
  const cleanup = installHookBridge({ hooks, bus, runner });
  await bus.emit("PreToolUse", { payload: { toolName: "write_file" } });
  await flush();
  assert.ok(received.includes("write_file"), `expected write_file, got [${received.join(",")}]`);
  cleanup();
});
