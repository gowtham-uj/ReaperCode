import { strict as assert } from "node:assert";
import { test } from "node:test";

import { AnthropicClient } from "../../src/model/providers/anthropic.js";
import { buildAgentToolDescriptor } from "../../src/runtime/agent-tools.js";

/**
 * Capture the request body the client actually puts on the wire. Asserting on
 * an exported `mapTools` would not have caught this: the bug was that the
 * descriptor shape the runtime produces (`inputSchema`) was not one of the keys
 * the mapper read, which is only visible end-to-end.
 */
async function capturePayload(tools: unknown[]): Promise<Record<string, unknown>> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  let captured: Record<string, unknown> | undefined;

  globalThis.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
    captured = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    return new Response(JSON.stringify({ content: [], usage: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  try {
    const client = new AnthropicClient();
    await client
      .generate(
        { messages: [{ role: "user", content: "hi" }], tools } as never,
        { profileName: "test", provider: "anthropic", model: "claude-test" } as never,
      )
      .catch(() => undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  }

  assert.ok(captured, "the client must have issued a request");
  return captured;
}

// The registry-derived descriptor uses `inputSchema`, but the Anthropic mapper
// only read `parameters` / `input_schema`. Every tool therefore reached the
// model advertising `{type: "object", properties: {}}` — no arguments at all.
// The model then emitted argument-less calls that failed `ToolCallSchema` with
// "args.path: Required", and, when told to repair them, correctly objected that
// its tools took no such argument.
test("registry tool schemas reach Anthropic instead of being flattened to an empty object", async () => {
  const descriptor = buildAgentToolDescriptor("file_view");
  assert.ok(descriptor, "file_view must exist in the registry");

  const payload = await capturePayload([descriptor]);
  const wireTools = payload.tools as Array<{ name: string; input_schema: Record<string, unknown> }>;
  const fileView = wireTools.find((tool) => tool.name === "file_view");
  assert.ok(fileView, "file_view must be present on the wire");

  const properties = fileView.input_schema.properties as Record<string, unknown> | undefined;
  assert.ok(
    properties && Object.keys(properties).length > 0,
    "the tool must not be advertised as taking no arguments",
  );
  assert.ok(properties.path, "path must be advertised");
  assert.deepEqual(
    fileView.input_schema.required,
    ["path"],
    "path must be advertised as required, matching FileViewArgsSchema",
  );
});

test("the explicit parameters and input_schema keys still take precedence", async () => {
  const explicit = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
  for (const key of ["parameters", "input_schema"]) {
    const payload = await capturePayload([{ name: "custom", description: "d", [key]: explicit }]);
    const wireTools = payload.tools as Array<{ name: string; input_schema: unknown }>;
    assert.deepEqual(wireTools[0]?.input_schema, explicit, `'${key}' must still be honored`);
  }
});
