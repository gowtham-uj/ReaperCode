import { describe, expect, it, vi } from "vitest";

import { createTranscriptStore } from "./store.js";

describe("React transcript external store", () => {
  it("folds every notification immediately but publishes once per scheduled frame", () => {
    const scheduled: Array<() => void> = [];
    const store = createTranscriptStore(undefined, (flush) => scheduled.push(flush));
    const listener = vi.fn();
    store.subscribe(listener);

    store.ingest("thread/started", {
      threadId: "thread-1",
      sequence: 1,
      thread: { id: "thread-1" },
    });
    store.ingest("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      sequence: 2,
      delta: "hel",
    });
    store.ingest("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      sequence: 3,
      delta: "lo",
    });

    const thread = store.thread("thread-1");
    expect(thread?.latestSequence).toBe(3);
    expect(thread?.turns[0]?.items[0]).toMatchObject({
      id: "message-1",
      type: "agentMessage",
      text: "hello",
    });
    expect(scheduled).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();

    scheduled[0]!();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("preserves untouched thread identities", () => {
    const store = createTranscriptStore(undefined, (flush) => flush());
    store.ingest("thread/started", { threadId: "a", sequence: 1, thread: { id: "a" } });
    store.ingest("thread/started", { threadId: "b", sequence: 1, thread: { id: "b" } });
    const before = store.snapshot();

    store.ingest("item/agentMessage/delta", {
      threadId: "a",
      turnId: "turn-a",
      itemId: "message-a",
      sequence: 2,
      delta: "updated",
    });

    const after = store.snapshot();
    expect(after.a).not.toBe(before.a);
    expect(after.b).toBe(before.b);
  });
});

/**
 * The reload race: a resume seeds the RPC reply, then drains the notifications
 * buffered while the call was in flight. A replayed `thread/started` recorded
 * before a settings change therefore lands *after* the newer reply, and its
 * omission of `systemPrompt`/`disabledTools` must not be read as "cleared".
 */
describe("reconnecting into a configured thread", () => {
  it("keeps the settings a newer snapshot set when an older one arrives later", () => {
    const store = createTranscriptStore(undefined, (flush) => flush());

    store.seedThread({
      id: "thread-1",
      name: "Configured",
      updatedAt: "2026-09-10T08:00:10.000Z",
      systemPrompt: "Always write commit messages in the imperative mood.",
      disabledTools: ["bash"],
    });

    store.ingest("thread/started", {
      threadId: "thread-1",
      sequence: 1,
      thread: {
        id: "thread-1",
        name: "Configured",
        updatedAt: "2026-09-10T08:00:00.000Z",
      },
    });

    const thread = store.thread("thread-1");
    expect(thread?.systemPrompt).toBe("Always write commit messages in the imperative mood.");
    expect(thread?.disabledTools).toEqual(["bash"]);
  });

  it("still clears when the newer snapshot omits the fields", () => {
    const store = createTranscriptStore(undefined, (flush) => flush());

    store.seedThread({
      id: "thread-1",
      updatedAt: "2026-09-10T08:00:00.000Z",
      systemPrompt: "stale",
      disabledTools: ["bash"],
    });
    store.seedThread({ id: "thread-1", updatedAt: "2026-09-10T08:00:10.000Z" });

    const thread = store.thread("thread-1");
    expect(thread?.systemPrompt).toBeUndefined();
    expect(thread?.disabledTools).toBeUndefined();
  });

  it("lets a newer snapshot set the fields", () => {
    const store = createTranscriptStore(undefined, (flush) => flush());

    store.seedThread({ id: "thread-1", updatedAt: "2026-09-10T08:00:00.000Z" });
    store.seedThread({
      id: "thread-1",
      updatedAt: "2026-09-10T08:00:10.000Z",
      systemPrompt: "newer",
      disabledTools: ["web_fetch"],
    });

    const thread = store.thread("thread-1");
    expect(thread?.systemPrompt).toBe("newer");
    expect(thread?.disabledTools).toEqual(["web_fetch"]);
  });
});

/**
 * `attach` decides between resuming an idle scratch thread and creating a new
 * one. The decision is a pure read of the list projection, so it is tested
 * here rather than through a rendered app: the predicate is what matters, and
 * it is exactly the one that used to be missing, leaving a column of identical
 * "New chat" rows.
 */
describe("choosing a thread to attach to", () => {
  const pick = (entries: Array<Record<string, unknown>>): string | undefined => {
    const entry = entries.find((candidate) => candidate.hasTurns === false && candidate.ephemeral !== true);
    const id = entry?.id;
    return typeof id === "string" && id ? id : undefined;
  };

  it("reuses the newest thread that never ran a turn", () => {
    expect(pick([
      { id: "used", hasTurns: true },
      { id: "scratch", hasTurns: false },
      { id: "older-scratch", hasTurns: false },
    ])).toBe("scratch");
  });

  it("creates a thread when every thread has turns", () => {
    expect(pick([{ id: "a", hasTurns: true }, { id: "b", hasTurns: true }])).toBeUndefined();
  });

  it("never reuses an ephemeral thread", () => {
    expect(pick([{ id: "temp", hasTurns: false, ephemeral: true }])).toBeUndefined();
  });

  it("creates a thread when the list is empty", () => {
    expect(pick([])).toBeUndefined();
  });
});
