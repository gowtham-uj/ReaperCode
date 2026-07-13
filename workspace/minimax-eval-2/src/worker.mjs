import { PriorityQueue } from "./priority-queue.mjs";

/**
 * Drains a PriorityQueue of async jobs with bounded retries.
 * Contract:
 *  - Jobs run in priority order (FIFO within equal priority).
 *  - A failing job is retried up to `maxRetries` times (so a job with
 *    maxRetries = 2 executes at most 3 times) before being reported.
 *  - The result lists successes and failures in completion order.
 */
export async function drainQueue(queue, { maxRetries = 2 } = {}) {
  const succeeded = [];
  const failed = [];

  while (queue.size > 0) {
    const job = queue.dequeue();
    let attempts = 0;
    let lastError;

while (attempts <= maxRetries) {
      attempts += 1;
      try {
        const value = await job.run();
        succeeded.push({ name: job.name, value, attempts });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError !== undefined) {
      failed.push({ name: job.name, error: String(lastError?.message ?? lastError), attempts });
    }
  }

  return { succeeded, failed };
}
