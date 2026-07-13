import test from "node:test";
import assert from "node:assert/strict";

import { PriorityQueue } from "../src/priority-queue.mjs";

test("dequeues by ascending priority", () => {
  const q = new PriorityQueue();
  q.enqueue("low", 10);
  q.enqueue("high", 1);
  q.enqueue("mid", 5);
  assert.deepEqual([q.dequeue(), q.dequeue(), q.dequeue()], ["high", "mid", "low"]);
});

test("equal priorities dequeue in FIFO insertion order", () => {
  const q = new PriorityQueue();
  q.enqueue("first", 1);
  q.enqueue("second", 1);
  q.enqueue("third", 1);
  assert.deepEqual([q.dequeue(), q.dequeue(), q.dequeue()], ["first", "second", "third"]);
});

test("peek does not remove and reflects the head", () => {
  const q = new PriorityQueue();
  q.enqueue("a", 2);
  q.enqueue("b", 1);
  assert.equal(q.peek(), "b");
  assert.equal(q.size, 2);
});

test("enqueue validates priority", () => {
  const q = new PriorityQueue();
  assert.throws(() => q.enqueue("x", Number.NaN), /priority/);
  assert.throws(() => q.enqueue("x", "1"), /priority/);
});
