import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";

import { render } from "ink-testing-library";

import { MessageList } from "../../../../src/tui/components/message-list.js";
import type { TuiMessage } from "../../../../src/tui/types.js";

const messages: TuiMessage[] = [
  { kind: "system", id: "s1", text: "internal note", ts: 0 },
  { kind: "user", id: "u1", text: "hello", ts: 0 },
  { kind: "assistant", id: "a1", text: "hi", ts: 0 },
];

test("message-list: hides system messages in compact mode", () => {
  const { lastFrame, unmount } = render(<MessageList messages={messages} maxLines={20} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("hello"), "frame should include the user message");
    assert.ok(frame.includes("hi"), "frame should include the assistant message");
    assert.ok(!frame.includes("internal note"), "frame should hide system messages by default");
    assert.ok(frame.includes("/logs"), "frame should point users to the log view");
  } finally {
    unmount();
  }
});

test("message-list: shows system messages in debug mode", () => {
  const { lastFrame, unmount } = render(
    <MessageList messages={messages} maxLines={20} debugMode />,
  );
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("internal note"), "frame should include system messages when debug is on");
  } finally {
    unmount();
  }
});
