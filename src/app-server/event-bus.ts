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
 * A bounded, process-local replay log for one managed thread.
 *
 * Publishing never waits for subscribers. A slow or failed transport is handled
 * by the connection writer queue rather than blocking the agent turn.
 */
export class ThreadEventBus {
  private readonly records: ThreadEventRecord[] = [];
  private readonly subscribers = new Map<string, ThreadEventSubscriber>();
  private nextSequence = 1;

  constructor(
    readonly threadId: string,
    private readonly maxReplayEvents = 2_000,
  ) {
    if (!Number.isSafeInteger(maxReplayEvents) || maxReplayEvents < 1) {
      throw new Error("maxReplayEvents must be a positive safe integer");
    }
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
    if (this.records.length > this.maxReplayEvents) {
      this.records.splice(0, this.records.length - this.maxReplayEvents);
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
