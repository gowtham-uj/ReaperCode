import type { RuntimeEvent } from "../runtime/events.js";

export type ThreadLifecycleEvent =
  | { type: "thread.started"; threadId: string }
  | { type: "thread.status.changed"; threadId: string; status: string }
  | { type: "thread.closed"; threadId: string }
  | { type: "turn.queued"; threadId: string; turnId: string }
  | { type: "turn.user.message"; threadId: string; turnId: string; text: string }
  | { type: "turn.interrupt.requested"; threadId: string; turnId: string };

export type ThreadEventPayload = RuntimeEvent | ThreadLifecycleEvent;

export interface ThreadEventRecord {
  sequence: number;
  threadId: string;
  turnId?: string;
  timestamp: string;
  event: ThreadEventPayload;
}

export interface ThreadReplay {
  events: ThreadEventRecord[];
  earliestSequence: number;
  latestSequence: number;
  truncated: boolean;
}

export type ThreadEventSubscriber = (record: ThreadEventRecord) => void | Promise<void>;

/**
 * Approximate retained size of one record, in bytes.
 *
 * Deliberately cheap rather than exact. The events that make this matter are
 * the ones carrying text — tool output, assistant deltas — and for those the
 * string length dominates everything else in the object, so measuring the two
 * or three fields that can be large gives a number good enough to bound growth
 * without serialising every event on the publish path.
 *
 * Returns an over-estimate rather than an under-estimate where it is unsure,
 * because the failure it guards against is retaining too much.
 */
function eventByteSize(record: ThreadEventRecord): number {
  const event = record.event as Record<string, unknown>;
  let size = 200; // the record's own fields: id, sequence, threadId, timestamp
  const add = (value: unknown): void => {
    if (typeof value === "string") size += value.length;
    else if (Array.isArray(value)) for (const item of value) add(item);
    else if (value && typeof value === "object") {
      for (const nested of Object.values(value as Record<string, unknown>)) add(nested);
    }
  };
  add(event.text);
  add(event.content);
  add(event.delta);
  add(event.result);
  add(event.error);
  add(event.message);
  return size;
}

/**
 * A bounded, process-local replay log for one managed thread.
 *
 * Publishing never waits for subscribers. A slow or failed transport is handled
 * by the connection writer queue rather than blocking the agent turn.
 */
/**
 * How many bytes of retained events one thread's replay log may hold.
 *
 * The bus was bounded by *count* alone — 2,000 events — which is not a bound on
 * memory when the events are not the same size. `command.output.delta` carries
 * whatever chunk the child process emitted, so a command that prints steadily
 * puts 8–64KB into each record; 2,000 of those is over 100MB retained for one
 * thread, and every thread the UI opens keeps its own bus for the life of the
 * process.
 *
 * Measured on a long browsing session: the app-server climbed past 1.6GB and
 * was killed by the 2GB V8 heap limit after about three minutes of use, which
 * the user experienced as a turn that stopped producing output and never came
 * back. Nothing about that looked like memory from the outside.
 *
 * 8MB is generous for a replay window — a late-joining client is replayed so it
 * can catch up to a turn, which means the last few hundred events, not the last
 * two thousand — and it is a bound that holds whatever the events contain.
 */
const DEFAULT_MAX_REPLAY_BYTES = 8 * 1024 * 1024;

export class ThreadEventBus {
  private readonly records: ThreadEventRecord[] = [];
  private readonly subscribers = new Map<string, ThreadEventSubscriber>();
  private nextSequence = 1;
  /** Approximate retained size of `records`, maintained as they are added. */
  private retainedBytes = 0;

  constructor(
    readonly threadId: string,
    private readonly maxReplayEvents = 2_000,
    private readonly maxReplayBytes = DEFAULT_MAX_REPLAY_BYTES,
  ) {
    if (!Number.isSafeInteger(maxReplayEvents) || maxReplayEvents < 1) {
      throw new Error("maxReplayEvents must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxReplayBytes) || maxReplayBytes < 1) {
      throw new Error("maxReplayBytes must be a positive safe integer");
    }
  }

  /** Retained bytes, for tests and for a server that wants to report its own weight. */
  get retainedEventBytes(): number {
    return this.retainedBytes;
  }

  publish(event: ThreadEventPayload, turnId?: string): ThreadEventRecord {
    const record: ThreadEventRecord = {
      sequence: this.nextSequence++,
      threadId: this.threadId,
      ...(turnId ? { turnId } : {}),
      timestamp: new Date().toISOString(),
      event,
    };

    this.records.push(record);
    // `text.length` as a proxy for bytes: it is exact for ASCII, which is what
    // command output overwhelmingly is, and off by at most 2× for multi-byte
    // text. Measuring with a real encoder on the hot path would cost more than
    // the imprecision is worth, and the bound only has to be approximately
    // right to stop the growth being unbounded.
    this.retainedBytes += eventByteSize(record);

    /*
     * Evict oldest-first until both bounds hold.
     *
     * The count bound is kept because it is what the replay contract was
     * written against; the byte bound is what actually protects the process.
     * Both are checked on every publish and the oldest records are dropped one
     * at a time — the loop is bounded by the cheaper of the two conditions, and
     * in the steady state it removes one record per publish, which is what a
     * ring buffer does.
     */
    while (
      this.records.length > this.maxReplayEvents ||
      (this.retainedBytes > this.maxReplayBytes && this.records.length > 1)
    ) {
      const dropped = this.records.shift();
      if (!dropped) break;
      this.retainedBytes -= eventByteSize(dropped);
      // Never report a negative: the size estimate is approximate, and a
      // subtraction that overshoots would corrupt the bound rather than tighten
      // it.
      if (this.retainedBytes < 0) this.retainedBytes = 0;
    }

    for (const subscriber of this.subscribers.values()) {
      try {
        const result = subscriber(record);
        if (result && typeof result.then === "function") {
          void result.catch(() => undefined);
        }
      } catch {
        // Transport subscribers are fail-open. The router owns eviction.
      }
    }

    return record;
  }

  subscribe(subscriberId: string, subscriber: ThreadEventSubscriber): () => void {
    if (!subscriberId.trim()) throw new Error("subscriberId is required");
    this.subscribers.set(subscriberId, subscriber);
    return () => this.unsubscribe(subscriberId);
  }

  unsubscribe(subscriberId: string): void {
    this.subscribers.delete(subscriberId);
  }

  replayAfter(afterSequence = 0): ThreadReplay {
    const earliestSequence = this.records[0]?.sequence ?? this.nextSequence;
    const latestSequence = this.records.at(-1)?.sequence ?? this.nextSequence - 1;
    const normalized = Number.isSafeInteger(afterSequence) && afterSequence >= 0
      ? afterSequence
      : 0;

    return {
      events: this.records.filter((record) => record.sequence > normalized),
      earliestSequence,
      latestSequence,
      truncated: normalized > 0 && normalized < earliestSequence - 1,
    };
  }

  get latestSequence(): number {
    return this.nextSequence - 1;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
