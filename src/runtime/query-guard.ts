/**
 * QueryGuard prevents re-entrant query execution in the LangGraph loop.
 * Pattern borrowed from cc-haha's QueryGuard.ts.
 *
 * Synchronous state machine:
 *   idle → dispatching → running → idle
 *
 * Generation counter ensures stale finally blocks from cancelled queries
 * know to skip cleanup.
 */

export type QueryGuardState = "idle" | "dispatching" | "running";

export class QueryGuard {
  private state: QueryGuardState = "idle";
  private generation = 0;

  /**
   * Attempt to start a new query.
   * Returns the current generation if successful, or throws if a query is already in progress.
   */
  start(): number {
    if (this.state !== "idle") {
      throw new ReentrantQueryError(`Query already in progress (state=${this.state})`);
    }
    this.state = "dispatching";
    this.generation += 1;
    return this.generation;
  }

  /** Transition from dispatching to running (model call started). */
  markRunning(gen: number): boolean {
    if (!this.isCurrent(gen)) return false;
    this.state = "running";
    return true;
  }

  /** Mark the query as complete. Only succeeds if gen matches the current generation. */
  finish(gen: number): boolean {
    if (!this.isCurrent(gen)) return false;
    this.state = "idle";
    return true;
  }

  /** Get the current generation. */
  currentGeneration(): number {
    return this.generation;
  }

  /** Check if a generation is still current. */
  isCurrent(gen: number): boolean {
    return gen === this.generation;
  }

  /** Force-reset the guard to idle (use with caution, e.g. crash recovery). */
  reset(): void {
    this.state = "idle";
    this.generation += 1;
  }

  getState(): QueryGuardState {
    return this.state;
  }
}

export class ReentrantQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReentrantQueryError";
  }
}
