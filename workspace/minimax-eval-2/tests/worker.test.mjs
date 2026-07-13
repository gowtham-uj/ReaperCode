import test from "node:test";
import assert from "node:assert/strict";

import { PriorityQueue } from "../src/priority-queue.mjs";
import { drainQueue } from "../src/worker.mjs";

function job(name, behavior) {
  return { name, run: behavior };
}

test("drains jobs in priority order with FIFO ties", async () => {
  const q = new PriorityQueue();
  const order = [];
  q.enqueue(job("c", async () => order.push("c")), 2);
  q.enqueue(job("a", async () => order.push("a")), 1);
  q.enqueue(job("b", async () => order.push("b")), 1);

  const result = await drainQueue(q);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(result.failed.length, 0);
});

test("a job with maxRetries = 2 executes at most 3 times", async () => {
  const q = new PriorityQueue();
  let executions = 0;
  q.enqueue(
    job("flaky", async () => {
      executions += 1;
      if (executions < 3) throw new Error(`boom ${executions}`);
      return "recovered";
    }),
    1,
  );

  const result = await drainQueue(q, { maxRetries: 2 });
  assert.equal(executions, 3, "1 initial attempt + 2 retries");
  assert.equal(result.succeeded.length, 1);
  assert.equal(result.succeeded[0].value, "recovered");
  assert.equal(result.succeeded[0].attempts, 3);
});

test("a permanently failing job is reported with its final error", async () => {
  const q = new PriorityQueue();
  q.enqueue(
    job("doomed", async () => {
      throw new Error("always fails");
    }),
    1,
  );

  const result = await drainQueue(q, { maxRetries: 1 });
  assert.equal(result.succeeded.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, "doomed");
  assert.match(result.failed[0].error, /always fails/);
  assert.equal(result.failed[0].attempts, 2, "1 initial attempt + 1 retry");
});
