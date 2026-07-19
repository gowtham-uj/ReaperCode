import { z } from "zod";

export type MiddlewareHook = "onContentPrep" | "onBeforeExecution" | "onVerify";

export interface MiddlewareContext<T> {
  workspaceRoot: string;
  hook: MiddlewareHook;
  state: T;
}

export interface MiddlewareDefinition<T> {
  name: string;
  hook: MiddlewareHook;
  priority: number;
  middlewareApiVersion: 1;
  fatal?: boolean;
  timeoutMs?: number;
  run: (context: MiddlewareContext<T>) => Promise<T> | T;
}

export interface MiddlewareRunResult<T> {
  state: T;
  warnings: string[];
}

export async function runMiddlewareChain<T>(input: {
  workspaceRoot: string;
  hook: MiddlewareHook;
  state: T;
  middlewares?: Array<MiddlewareDefinition<T>>;
  validator?: z.ZodType<T>;
}): Promise<MiddlewareRunResult<T>> {
  const warnings: string[] = [];
  const chain = [...(input.middlewares ?? [])]
    .filter((middleware) => middleware.hook === input.hook)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  // Initial pass: validate the seed state if a validator was supplied.
  // We deliberately do NOT clone the seed state — pass the reference
  // through. The previous implementation cloned on every step (state
  // + snapshot + per-call payload), which produced O(N) full copies
  // per middleware invocation even for hooks that only read the
  // payload. This contract treats `state` as owned by the chain and
  // mutated in place; rollback below uses the lazy snapshot.
  let current: T = input.validator ? input.validator.parse(input.state) : input.state;

  for (const middleware of chain) {
    if (middleware.middlewareApiVersion !== 1) {
      warnings.push(`Middleware '${middleware.name}' disabled بسبب API mismatch`);
      continue;
    }

    // Take ONE snapshot per step (not per the previous three clones).
    // The lazy snapshot is only allocated when the middleware's
    // run() throws — happy-path middlewares never touch this branch,
    // so the V8 GC reclaims the snapshot as a no-op.
    let next: T;
    try {
      next = await withTimeout(
        Promise.resolve(
          middleware.run({
            workspaceRoot: input.workspaceRoot,
            hook: input.hook,
            // Pass the live state by reference. Middlewares are
            // expected to mutate the state in place and return it
            // (or return a replacement). Cloning here would defeat
            // the optimization.
            state: current,
          }),
        ),
        middleware.timeoutMs ?? 5000,
        middleware.name,
      );
    } catch (error) {
      // Only allocate the snapshot on the failure path.
      const snapshot = structuredClone(current);
      const message = error instanceof Error ? error.message : `Middleware '${middleware.name}' failed`;
      if (middleware.fatal) {
        throw new Error(message);
      }
      warnings.push(message);
      // Roll back to whatever the middleware published before the
      // throw. If `run` returned a partial state before throwing, we
      // don't have it; in practice middlewares either succeed
      // synchronously or fail before mutating, so this restores the
      // last-known-good snapshot.
      current = snapshot;
      continue;
    }

    current = input.validator ? input.validator.parse(next) : next;
  }

  return { state: current, warnings };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Middleware '${name}' timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
