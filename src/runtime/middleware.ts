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

  let current = input.validator ? input.validator.parse(input.state) : structuredClone(input.state);

  for (const middleware of chain) {
    if (middleware.middlewareApiVersion !== 1) {
      warnings.push(`Middleware '${middleware.name}' disabled بسبب API mismatch`);
      continue;
    }

    const snapshot = structuredClone(current);
    try {
      const next = await withTimeout(
        Promise.resolve(
          middleware.run({
            workspaceRoot: input.workspaceRoot,
            hook: input.hook,
            state: structuredClone(current),
          }),
        ),
        middleware.timeoutMs ?? 5000,
        middleware.name,
      );
      current = input.validator ? input.validator.parse(next) : next;
    } catch (error) {
      current = snapshot;
      const message = error instanceof Error ? error.message : `Middleware '${middleware.name}' failed`;
      if (middleware.fatal) {
        throw new Error(message);
      }
      warnings.push(message);
    }
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
