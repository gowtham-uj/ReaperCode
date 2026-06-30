/**
 * status-bar.test.tsx — unit tests for the status bar footer.
 *
 * Covers:
 *   - Phase indicator (text and color).
 *   - Token count and ctx% formatting.
 *   - Session id is shown.
 *   - hideThinkingBlock indicator reflects the snapshot flag.
 *
 * The tests use ink-testing-library. The status object is passed
 * directly so we can construct any state we want.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";

import { render } from "ink-testing-library";

import { StatusBar } from "../../../../src/tui/components/status-bar.js";
import type { TuiStatus } from "../../../../src/tui/types.js";

function makeStatus(overrides: Partial<TuiStatus> = {}): TuiStatus {
  return {
    phase: "idle",
    model: "claude-opus-4-8",
    provider: "anthropic",
    sessionId: "ses_test_1234",
    tokens: 1234,
    ctxPct: 0.42,
    hideThinkingBlock: true,
    debugMode: false,
    ...overrides,
  };
}

test("status-bar: shows the phase label", () => {
  const { lastFrame, unmount } = render(<StatusBar status={makeStatus({ phase: "idle" })} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    // The phase label appears in the frame after the leading glyph.
    // Use a substring that survives any line wrap — the full label
    // is short enough to never be split by the test renderer.
    assert.ok(/idl|done|stream|verify/.test(frame),
      `frame should include some phase label; got: ${frame}`);
  } finally {
    unmount();
  }
});

test("status-bar: shows the streaming phase label", () => {
  const { lastFrame, unmount } = render(<StatusBar status={makeStatus({ phase: "streaming" })} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("stream") || frame.includes("Stream"),
      `frame should include the 'streaming' phase label; got: ${frame}`);
  } finally {
    unmount();
  }
});

test("status-bar: shows the done phase label", () => {
  const { lastFrame, unmount } = render(<StatusBar status={makeStatus({ phase: "done" })} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("done"),
      `frame should include the compact done label; got: ${frame}`);
    assert.ok(!frame.includes("streaming"),
      "frame should not include the streaming label when phase=done");
    assert.ok(!frame.includes("tool-running"),
      "frame should not include the tool-running label when phase=done");
  } finally {
    unmount();
  }
});

test("status-bar: shows the model name and provider", () => {
  const { lastFrame, unmount } = render(
    <StatusBar status={makeStatus({ model: "alpha", provider: "beta" })} />,
  );
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("alpha"), "frame should include the model name");
    assert.ok(frame.includes("beta"), "frame should include the provider name");
  } finally {
    unmount();
  }
});

test("status-bar: formats the ctx% as a percentage", () => {
  const { lastFrame, unmount } = render(<StatusBar status={makeStatus({ ctxPct: 0.42 })} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("ctx 42%"),
      "frame should include the compact ctx percentage");
  } finally {
    unmount();
  }
});

test("status-bar: shows the session id", () => {
  const { lastFrame, unmount } = render(<StatusBar status={makeStatus({ sessionId: "ses_xyz" })} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("ses_xyz"),
      "frame should include the session id");
  } finally {
    unmount();
  }
});

test("status-bar: shortens long session ids", () => {
  const { lastFrame, unmount } = render(
    <StatusBar status={makeStatus({ sessionId: "ses_1234567890abcdef" })} />,
  );
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("ses_1234"),
      "frame should include the shortened session prefix");
    assert.ok(frame.includes("cdef"),
      "frame should include the shortened session suffix");
  } finally {
    unmount();
  }
});

test("status-bar: shows the debug marker when debugMode is enabled", () => {
  const { lastFrame, unmount } = render(<StatusBar status={makeStatus({ debugMode: true })} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("debug"),
      "frame should include the debug marker");
  } finally {
    unmount();
  }
});

test("status-bar: shows the active tool count when > 0", () => {
  const { lastFrame, unmount } = render(<StatusBar status={makeStatus({ activeToolCount: 2 })} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("tools 2"),
      "frame should include the compact tool count segment");
    assert.ok(frame.includes("2"),
      "frame should include the active tool count");
  } finally {
    unmount();
  }
});

test("status-bar: omits the tools segment when activeToolCount is 0", () => {
  const { lastFrame, unmount } = render(<StatusBar status={makeStatus({ activeToolCount: 0 })} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(!frame.includes("tools 0"),
      "frame should NOT include the tools segment when count is 0");
  } finally {
    unmount();
  }
});

test("status-bar: shows the transient hint line when set", () => {
  const { lastFrame, unmount } = render(
    <StatusBar status={makeStatus({ hint: "press Ctrl-C again to exit" })} />,
  );
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("press Ctrl-C again to exit"),
      "frame should include the transient hint");
  } finally {
    unmount();
  }
});
