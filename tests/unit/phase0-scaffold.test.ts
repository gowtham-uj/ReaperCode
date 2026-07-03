import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";

/**
 * Phase 0 smoke test: verify that the foundational tool surface
 * (write_file + file_view) works end-to-end with explicit tool calls.
 *
 * This is the simplest possible test that exercises the real executor
 * without any model gateway. It corresponds to the Phase 0 smoke test
 * in docs/dev/roadmap-v0.1.4-omp-tool-port.md:
 *   "Create a file named hello.txt with 'hello' in the workspace root,
 *    then read it back."
 */
test("Phase 0 smoke: write_file creates a file and file_view reads it back", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-phase0-smoke-"));
  try {
    const request = createValidRequestEnvelope();
    request.payload = {
      prompt: "Create hello.txt with 'hello', then read it back.",
      tool_calls: [
        {
          id: "write-hello",
          name: "write_file",
          args: { path: "hello.txt", content: "hello\n" },
        },
        {
          id: "read-hello",
          name: "file_view",
          args: { path: "hello.txt" },
        },
      ],
    };

    const engine = new RuntimeEngine({
      config: createValidConfig(),
      workspaceRoot,
      requestEnvelope: request,
    });
    const result = await engine.run();

    const writeResult = result.toolResults.find((r) => r.toolCallId === "write-hello");
    assert.equal(writeResult?.ok, true, "write_file should succeed");

    const readResult = result.toolResults.find((r) => r.toolCallId === "read-hello");
    assert.equal(readResult?.ok, true, "file_view should succeed");
    // file_view output may be a JSON string or a structured object
    const rawOutput = readResult?.output;
    let windowText = "";
    if (typeof rawOutput === "string") {
      try {
        const parsed = JSON.parse(rawOutput);
        windowText = (parsed?.window ?? []).join("\n");
      } catch {
        windowText = rawOutput;
      }
    } else if (rawOutput && typeof rawOutput === "object") {
      const obj = rawOutput as { window?: string[] };
      windowText = (obj.window ?? []).join("\n");
    }
    assert.match(windowText, /hello/, "file_view window should contain 'hello'");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * Phase 0: verify that the new descriptor and tool-result scaffold modules
 * export their types and functions correctly.
 */
test("Phase 0 scaffold: descriptor module exports are accessible", async () => {
  const { getToolDescriptor, getAllToolDescriptors, registerToolDescriptor } =
    await import("../../src/tools/descriptor.js");

  assert.equal(typeof getToolDescriptor, "function");
  assert.equal(typeof getAllToolDescriptors, "function");
  assert.equal(typeof registerToolDescriptor, "function");
  assert.equal(getAllToolDescriptors().length, 0, "descriptor map should start empty");
});

test("Phase 0 scaffold: tool-result module exports are accessible", async () => {
  const { normalizeToolResult } = await import("../../src/tools/tool-result.js");

  assert.equal(typeof normalizeToolResult, "function");

  const normalized = normalizeToolResult({
    ok: true,
    toolCallId: "tc-test",
    name: "write_file",
    output: "File written: hello.txt",
    durationMs: 5,
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.toolCallId, "tc-test");
  assert.equal(normalized.name, "write_file");
  assert.equal(normalized.isError, false);
  assert.equal(normalized.useless, false);
  assert.equal(normalized.durationMs, 5);
});
