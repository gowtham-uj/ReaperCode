import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { runMiddlewareChain } from "../../src/runtime/middleware.js";

test("middleware runs in priority order", async () => {
  const result = await runMiddlewareChain({
    workspaceRoot: "/tmp",
    hook: "onContentPrep",
    state: { value: 1 },
    validator: z.object({ value: z.number() }),
    middlewares: [
      { name: "b", hook: "onContentPrep", priority: 20, middlewareApiVersion: 1, run: (ctx) => ({ value: ctx.state.value * 10 }) },
      { name: "a", hook: "onContentPrep", priority: 10, middlewareApiVersion: 1, run: (ctx) => ({ value: ctx.state.value + 1 }) },
    ],
  });

  assert.equal(result.state.value, 20);
});

test("non-fatal middleware failure rolls back to snapshot and continues", async () => {
  const result = await runMiddlewareChain({
    workspaceRoot: "/tmp",
    hook: "onContentPrep",
    state: { value: 1 },
    validator: z.object({ value: z.number() }),
    middlewares: [
      { name: "bad", hook: "onContentPrep", priority: 10, middlewareApiVersion: 1, run: () => { throw new Error("boom"); } },
      { name: "good", hook: "onContentPrep", priority: 20, middlewareApiVersion: 1, run: (ctx) => ({ value: ctx.state.value + 1 }) },
    ],
  });

  assert.equal(result.state.value, 2);
  assert.match(result.warnings.join("\n"), /boom/);
});

test("fatal middleware failure aborts the chain", async () => {
  await assert.rejects(
    () =>
      runMiddlewareChain({
        workspaceRoot: "/tmp",
        hook: "onVerify",
        state: { ok: true },
        validator: z.object({ ok: z.boolean() }),
        middlewares: [
          { name: "fatal", hook: "onVerify", priority: 10, middlewareApiVersion: 1, fatal: true, run: () => { throw new Error("fatal"); } },
        ],
      }),
    /fatal/,
  );
});
