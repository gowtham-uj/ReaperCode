# task-queue

Tiny priority-queue + worker library used for internal tooling.

- `src/priority-queue.mjs` — binary-heap priority queue (lower number first,
  FIFO within equal priority).
- `src/worker.mjs` — drains a queue of async jobs with bounded retries.

Run `npm test`.
