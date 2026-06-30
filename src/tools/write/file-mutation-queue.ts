import { realpathSync } from "node:fs";
import path from "node:path";

export class FileMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  get size(): number {
    return this.tails.size;
  }

  async run<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const key = mutationKey(filePath);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current, () => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      // Delete only if no later operation replaced this path's tail while we ran.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}

export const globalFileMutationQueue = new FileMutationQueue();

function mutationKey(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}
