/**
 * The sandbox toggle, tested end to end from the wire.
 *
 * The setting has two claims and each has its own failure mode. The first is
 * that it reaches the runtime at all, which is where a per-thread setting
 * normally breaks: every layer compiles, the value is stored, and nothing
 * reads it. The second is that a change lands on a turn that is already
 * running, which is the claim that made it worth building — a thread doing
 * something you did not expect is exactly the thread you want to confine
 * without waiting for it to finish.
 *
 * The runner here is a stub, so what is being checked is the value the
 * app-server hands the runtime. That the runtime then enforces it is
 * `shell-sandbox.test.ts`, against real commands.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { startAppServer } from "../../src/app-server/server.js";
import type { ManagedTurnRunner } from "../../src/app-server/managed-turn-runner.js";
import type { RuntimeEngineResult } from "../../src/runtime/engine.js";
import { createTempWorkspace } from "../fixtures/workspace.js";
import WebSocket from "ws";

function engineResult(message: string): RuntimeEngineResult {
  return {
    assistantMessage: message,
    toolResults: [],
    events: [],
    trajectoryPath: "",
    state: {} as RuntimeEngineResult["state"],
  };
}

class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly waiters = new Set<{ method: string; resolve(): void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message: string };
      };
      if (typeof message.id !== "number") {
        // A notification. `turn/start` returns before the runner has been
        // called, so the only reliable "the turn is over" signal is this one.
        for (const waiter of [...this.waiters]) {
          if (waiter.method === message.method) {
            this.waiters.delete(waiter);
            waiter.resolve();
          }
        }
        return;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  /** Resolves on the next notification with this method. */
  once(method: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.add({ method, resolve });
    });
  }

  /** Start a turn and wait for the server to say it finished. */
  async runTurn(threadId: string, prompt: string): Promise<void> {
    const completed = this.once("turn/completed");
    await this.call("turn/start", { threadId, prompt });
    await completed;
  }

  static async connect(url: string): Promise<RpcClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new RpcClient(socket);
  }

  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

test("a thread is sandboxed by default and the setting reaches the runtime", async () => {
  const workspaceRoot = await createTempWorkspace();
  const seen: Array<boolean | undefined> = [];
  const runner: ManagedTurnRunner = async (input) => {
    seen.push(input.filesystemSandbox);
    return engineResult("ok");
  };
  const server = await startAppServer({ workspaceRoot, turnRunner: runner });
  const client = await RpcClient.connect(server.ready.url);
  try {
    await client.call("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "test", version: "1" },
      capabilities: { experimentalApi: false, optOutNotificationMethods: [] },
    });
    const started = await client.call<{ thread: { id: string; filesystemSandbox?: boolean } }>("thread/start", {
      workspaceRoot,
      permissionMode: "yolo",
      subscribe: true,
      ephemeral: false,
      newWorkspace: false,
    });
    const threadId = started.thread.id;
    // Stated on the projection rather than left absent, so the settings switch
    // has a value to render rather than inferring one from a missing key.
    assert.equal(started.thread.filesystemSandbox, true);

    await client.runTurn(threadId, "one");
    assert.equal(seen[0], true, "a thread nobody configured must still be confined");

    const off = await client.call<{ filesystemSandbox: boolean }>("thread/config/set", {
      threadId,
      filesystemSandbox: false,
    });
    assert.equal(off.filesystemSandbox, false);

    await client.runTurn(threadId, "two");
    assert.equal(seen[1], false, "turning it off must actually reach the runtime");

    await client.call("thread/config/set", { threadId, filesystemSandbox: true });
    await client.runTurn(threadId, "three");
    assert.equal(seen[2], true, "and turning it back on must too");
  } finally {
    client.close();
    await server.stop();
  }
});

test("the setting survives the thread being dropped and resumed", async () => {
  const workspaceRoot = await createTempWorkspace();
  const seen: Array<boolean | undefined> = [];
  const runner: ManagedTurnRunner = async (input) => {
    seen.push(input.filesystemSandbox);
    return engineResult("ok");
  };
  const server = await startAppServer({ workspaceRoot, turnRunner: runner });
  const client = await RpcClient.connect(server.ready.url);
  try {
    await client.call("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "test", version: "1" },
      capabilities: { experimentalApi: false, optOutNotificationMethods: [] },
    });
    const started = await client.call<{ thread: { id: string } }>("thread/start", {
      workspaceRoot,
      permissionMode: "yolo",
      subscribe: true,
      ephemeral: false,
      newWorkspace: false,
    });
    const threadId = started.thread.id;
    await client.call("thread/config/set", { threadId, filesystemSandbox: false });
    // Resume rereads the metadata file. A setting that lived only in memory
    // would silently snap back to the default here, which is the form of this
    // bug that is hardest to notice: the thread becomes *more* confined than
    // the user left it, so nothing fails, it just stops working.
    await client.call("thread/resume", { threadId, subscribe: true, afterSequence: 0 });
    await client.runTurn(threadId, "after resume");
    assert.equal(seen[0], false);
  } finally {
    client.close();
    await server.stop();
  }
});
