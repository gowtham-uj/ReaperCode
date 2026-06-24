import test from "node:test";
import assert from "node:assert/strict";

import { ToolCallSchema } from "../../src/tools/types.js";

test("accepts a valid read_file tool call", () => {
  const toolCall = ToolCallSchema.parse({
    id: "1",
    name: "read_file",
    args: { path: "README.md" },
  });

  assert.equal(toolCall.name, "read_file");
});

test("accepts a valid view_file tool call", () => {
  const toolCall = ToolCallSchema.parse({
    id: "view-1",
    name: "view_file",
    args: { path: "README.md", startLine: 2, endLine: 5 },
  });

  assert.equal(toolCall.name, "view_file");
});

test("rejects unknown tool names", () => {
  assert.throws(
    () =>
      ToolCallSchema.parse({
        id: "1",
        name: "unknown_tool",
        args: {},
      }),
    /Invalid discriminator value/,
  );
});

test("rejects malformed shell command args", () => {
  assert.throws(
    () =>
      ToolCallSchema.parse({
        id: "1",
        name: "run_shell_command",
        args: { timeoutMs: 10 },
      }),
    /cmd/,
  );
});

test("accepts web search with minimum ten-page scrape", () => {
  const toolCall = ToolCallSchema.parse({
    id: "research-1",
    name: "web_search",
    args: { query: "fix ts-jest beforeAll expect TypeScript", engine: "duckduckgo", maxResults: 10, scrapePages: 10 },
  });

  assert.equal(toolCall.name, "web_search");
});

test("accepts browser and computer control tool calls", () => {
  const browserCall = ToolCallSchema.parse({
    id: "browser-1",
    name: "browser_control",
    args: { action: "click", ref: "e0", screenshot: true, humanize: true, headless: true, maxInteractive: 20 },
  });
  const computerCall = ToolCallSchema.parse({
    id: "computer-1",
    name: "computer_control",
    args: { action: "click", x: 100, y: 200, humanize: true, headless: true },
  });

  assert.equal(browserCall.name, "browser_control");
  assert.equal(computerCall.name, "computer_control");
});

test("accepts native computer-use tool calls", () => {
  const mouseCall = ToolCallSchema.parse({
    id: "mouse-1",
    name: "mouse_click",
    args: { x: 500, y: 400, button: "left", clicks: 1 },
  });
  const keyboardCall = ToolCallSchema.parse({
    id: "keyboard-1",
    name: "keyboard_press",
    args: { keys: ["ctrl", "c"], duration: 0.1 },
  });
  const approvalCall = ToolCallSchema.parse({
    id: "approval-1",
    name: "request_human_approval",
    args: { reason: "Confirm destructive action", timeoutSeconds: 30 },
  });

  assert.equal(mouseCall.name, "mouse_click");
  assert.equal(keyboardCall.name, "keyboard_press");
  assert.equal(approvalCall.name, "request_human_approval");
});

test("accepts partial request_patch signals for model fallback repair", () => {
  const patchCall = ToolCallSchema.parse({
    id: "patch-1",
    name: "request_patch",
    args: { reasonPatchNeeded: "Latest verification still fails." },
  });

  assert.equal(patchCall.name, "request_patch");
  assert.equal(patchCall.args.reasonPatchNeeded, "Latest verification still fails.");
});
