const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

function validateEvent(event) {
  if (event === null || typeof event !== "object") {
    throw new TypeError("event must be an object");
  }
  const { eventId, occurredAt } = event;
  if (typeof eventId !== "string" || eventId.length === 0) {
    throw new Error("eventId must be a non-empty string");
  }
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    throw new Error("occurredAt must be a valid ISO 8601 date string");
  }
}

function cloneEvent(event) {
  return {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    payload: structuredClone(event.payload ?? {}),
  };
}

function coerceLimit(limit) {
  if (!Number.isFinite(limit) || Math.floor(limit) !== limit) {
    throw new TypeError("limit must be an integer");
  }
  if (limit <= 0) {
    throw new RangeError("limit must be a positive integer");
  }
  if (limit > MAX_LIMIT) return MAX_LIMIT;
  return limit;
}

export class EventStore {
  #events = [];
  #seenIds = new Set();

  append(event) {
    validateEvent(event);
    const { eventId, occurredAt } = event;
    if (this.#seenIds.has(eventId)) {
      return { inserted: false };
    }
    const stored = {
      eventId,
      occurredAt,
      payload: structuredClone(event.payload ?? {}),
};
    this.#events.push(stored);
    this.#seenIds.add(eventId);
    return { inserted: true, event: cloneEvent(stored) };
  }

  listAfter(cursor, limit = DEFAULT_LIMIT) {
    const boundedLimit = coerceLimit(limit);
    const sorted = [...this.#events].sort((a, b) => {
      if (a.occurredAt < b.occurredAt) return -1;
      if (a.occurredAt > b.occurredAt) return 1;
      return 0;
    });
    let start = 0;
    if (cursor != null) {
      const idx = sorted.findIndex((entry) => entry.eventId === cursor);
      if (idx === -1) {
        throw new Error("cursor must reference an existing eventId");
      }
      start = idx + 1;
    }
    return sorted.slice(start, start + boundedLimit).map(cloneEvent);
  }

  snapshot() {
    return {
      eventCount: this.#events.length,
      events: this.#events.map(cloneEvent),
    };
}
}