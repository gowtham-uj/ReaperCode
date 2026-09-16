import test from "node:test";
import assert from "node:assert/strict";

import { ToolCallSchema } from "../../src/tools/types.js";

test("accepts a valid file_view tool call", () => {
  const toolCall = ToolCallSchema.parse({
    id: "view-1",
    name: "file_view",
    args: { path: "README.md", start_line: 2, window: 4 },
  });

  assert.equal(toolCall.name, "file_view");
});

test("rejects unknown tool names", () => {
  /*
   * Asserted on the issue code, not the message text. This used to match the
   * zod v3 string "Invalid discriminator value", which stopped being emitted
   * when the dependency moved to v4 — so the assertion silently became a test
   * of the wrong thing and then started failing. The code is the stable part.
   */
  assert.throws(
    () =>
      ToolCallSchema.parse({
        id: "1",
        name: "unknown_tool",
        args: {},
      }),
    (error: unknown) =>
      typeof (error as { issues?: Array<{ code?: string }> }).issues?.[0]?.code === "string"
      && (error as { issues: Array<{ code: string }> }).issues[0]!.code === "invalid_union",
  );
});

test("rejects malformed shell command args", () => {
  assert.throws(
    () =>
      ToolCallSchema.parse({
        id: "1",
        name: "bash",
        args: { timeoutMs: 10 },
      }),
    /cmd/,
  );
});

test("bash exposes only the canonical OMP-style argument contract", () => {
  const parsed = ToolCallSchema.parse({
    id: "bash-1",
    name: "bash",
    args: {
      cmd: "npm test",
      description: "run focused tests",
      timeout: 300,
      run_in_background: false,
    },
  });
  assert.equal(parsed.name, "bash");
  assert.deepEqual(parsed.args, {
    cmd: "npm test",
    description: "run focused tests",
    timeout: 300,
    run_in_background: false,
  });

  for (const args of [
    { cmd: "npm test", timeoutMs: 300_000 },
    { cmd: "npm test", isBackground: true },
    { command: "npm test", timeout: 300 },
  ]) {
    assert.throws(() => ToolCallSchema.parse({ id: "legacy", name: "bash", args }));
  }
});

test("retired shell and sandbox tool names are rejected", () => {
  for (const name of ["run_command", "run_shell_command", "sandbox_service_control"]) {
    assert.throws(() => ToolCallSchema.parse({ id: name, name, args: { cmd: "true", timeout: 60 } }));
  }
});

test("accepts web search with minimum ten-page scrape", () => {
  const toolCall = ToolCallSchema.parse({
    id: "research-1",
    name: "web_search",
    args: { query: "fix ts-jest beforeAll expect TypeScript", engine: "duckduckgo", maxResults: 10, scrapePages: 10 },
  });

  assert.equal(toolCall.name, "web_search");
});

test("accepts browser use tool calls", () => {
  /*
   * The arguments are a program and a revision, not a verb and a ref.
   *
   * The old shape carried an `action`, a `ref` like `e0`, and per-action extras.
   * A ref was a position in a snapshot rather than an identity, so it could point
   * at a different element after a re-render, and the model had no way to know.
   */
  const browserCall = ToolCallSchema.parse({
    id: "browser-1",
    name: "browser_use",
    args: {
      code: `await page.getByRole("button", { name: "Continue" }).click();`,
      intent: "Submit the application form",
      expected_revision: 4,
    },
  });

  assert.equal(browserCall.name, "browser_use");
});

test("a browser_use call with no code is valid, because looking is a call", () => {
  // The model's first look at a page, and the one it makes whenever the receipt
  // reports something it does not understand. A tool that only acts forces it to
  // write Playwright against a page it has not seen.
  const look = ToolCallSchema.parse({ id: "browser-look", name: "browser_use", args: {} });
  assert.equal(look.name, "browser_use");
});

test("a browser_use call cannot carry the old verb and ref", () => {
  // Strict, so the removed shape fails loudly rather than being ignored and
  // leaving the model believing it asked for a click.
  assert.throws(() => ToolCallSchema.parse({ id: "b", name: "browser_use", args: { action: "click", ref: "e0" } }));
});

/*
 * Native-desktop control was removed as a product decision, and the schemas
 * went with it. Pinning the rejection here is the point: a model that has
 * learned these names from elsewhere will still try them, and it must get a
 * parse error rather than a silently-accepted call that reaches a controller
 * that no longer exists.
 */
test("rejects the removed native computer-control tools", () => {
  for (const call of [
    { id: "computer-1", name: "computer_control", args: { action: "click", x: 100, y: 200 } },
    { id: "mouse-1", name: "mouse_click", args: { x: 500, y: 400, button: "left" } },
    { id: "keyboard-1", name: "keyboard_press", args: { keys: ["ctrl", "c"] } },
    { id: "shot-1", name: "screenshot", args: {} },
    { id: "approval-1", name: "request_human_approval", args: { reason: "Confirm" } },
    { id: "live-1", name: "start_live_view", args: {} },
  ]) {
    assert.throws(() => ToolCallSchema.parse(call), `${call.name} must not parse`);
  }
});

test("rejects removed request_patch legacy signal", () => {
  assert.throws(() =>
    ToolCallSchema.parse({
      id: "patch-1",
      name: "request_patch",
      args: { reasonPatchNeeded: "Latest verification still fails." },
    }),
  );
});
