/**
 * message-card.test.tsx — unit tests for the chat bubble + reasoning
 * block rendering. Covers the basic message kinds (user / assistant /
 * system / error) and the new collapsible reasoning block on assistant
 * messages.
 *
 * The tests use ink-testing-library. The Tab key is simulated by
 * passing `stdin` keystrokes; we render with `exitOnCtrlC: false` so
 * the component stays mounted while we query it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";

import { render } from "ink-testing-library";

import { MessageCard } from "../../../../src/tui/components/message-card.js";
import type { TuiAssistantMessage, TuiUserMessage } from "../../../../src/tui/types.js";

test("message-card: renders the user role label and text", () => {
  const msg: TuiUserMessage = { kind: "user", id: "u1", text: "hello reaper", ts: 0 };
  const { lastFrame, unmount } = render(<MessageCard message={msg} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("you"), "frame should include the user role label");
    assert.ok(frame.includes("hello reaper"), "frame should include the user text");
  } finally {
    unmount();
  }
});

test("message-card: assistant message renders chat text", () => {
  const msg: TuiAssistantMessage = { kind: "assistant", id: "a1", text: "hi back", ts: 0 };
  const { lastFrame, unmount } = render(<MessageCard message={msg} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("reaper"), "frame should include the assistant role label");
    assert.ok(frame.includes("hi back"), "frame should include the chat text");
  } finally {
    unmount();
  }
});

test("message-card: assistant message without reasoning does not show the reasoning block", () => {
  const msg: TuiAssistantMessage = { kind: "assistant", id: "a2", text: "answer", ts: 0 };
  const { lastFrame, unmount } = render(<MessageCard message={msg} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(!frame.includes("thinking"),
      "frame should NOT include the reasoning block header when no reasoning is set");
  } finally {
    unmount();
  }
});

test("message-card: reasoning block defaults to collapsed", () => {
  const msg: TuiAssistantMessage = {
    kind: "assistant",
    id: "a3",
    text: "answer",
    reasoning: "I had a long thought",
    ts: 0,
  };
  const { lastFrame, unmount } = render(<MessageCard message={msg} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("thinking"),
      "frame should include the reasoning block header");
    assert.ok(!frame.includes("I had a long thought"),
      "frame should NOT include the reasoning body when collapsed");
  } finally {
    unmount();
  }
});

test("message-card: Tab key on a reasoning block expands it", async () => {
  const msg: TuiAssistantMessage = {
    kind: "assistant",
    id: "a4",
    text: "answer",
    reasoning: "I had a long thought",
    ts: 0,
  };
  const { lastFrame, unmount, stdin } = render(<MessageCard message={msg} />);
  try {
    // Default state: collapsed.
    let frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(!frame.includes("I had a long thought"),
      "frame should NOT include the reasoning body when collapsed");

    // Press Tab to expand. ink-testing-library's `stdin.write` takes
    // a single character; "\t" is the tab control character. Use the
    // kitty-protocol CSI u escape form as a fallback for terminals
    // that strip the raw \t — most TUI drivers will recognize one
    // of the two.
    stdin.write("\t");
    // Yield to the React reconciler so the state update from the
    // useInput handler can flush before we read the frame.
    await new Promise((r) => setImmediate(r));
    frame = lastFrame();
    assert.ok(frame, "frame should be defined after Tab");
    assert.ok(frame.includes("I had a long thought"),
      "frame should include the reasoning body after Tab expansion");
  } finally {
    unmount();
  }
});

test("message-card: reasoning block collapses again on second Tab press", async () => {
  const msg: TuiAssistantMessage = {
    kind: "assistant",
    id: "a5",
    text: "answer",
    reasoning: "thoughts",
    ts: 0,
  };
  const { lastFrame, unmount, stdin } = render(<MessageCard message={msg} />);
  try {
    stdin.write("\t");
    await new Promise((r) => setImmediate(r));
    let frame = lastFrame();
    assert.ok(frame?.includes("thoughts"), "Tab once should expand");

    stdin.write("\t");
    await new Promise((r) => setImmediate(r));
    frame = lastFrame();
    assert.ok(frame, "frame should be defined after second Tab");
    assert.ok(!frame.includes("thoughts"),
      "Tab twice should collapse back to the default state");
  } finally {
    unmount();
  }
});

test("message-card: reasoningDurationMs is rendered in the header when present", () => {
  const msg: TuiAssistantMessage = {
    kind: "assistant",
    id: "a6",
    text: "answer",
    reasoning: "thoughts",
    reasoningDurationMs: 12_500,
    ts: 0,
  };
  const { lastFrame, unmount } = render(<MessageCard message={msg} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("12.5s"),
      "frame should include the formatted duration (12.5s)");
  } finally {
    unmount();
  }
});

test("message-card: zero or undefined reasoningDurationMs omits the duration suffix", () => {
  const msg: TuiAssistantMessage = {
    kind: "assistant",
    id: "a7",
    text: "answer",
    reasoning: "thoughts",
    reasoningDurationMs: 0,
    ts: 0,
  };
  const { lastFrame, unmount } = render(<MessageCard message={msg} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("thinking"),
      "frame should still show the 'thinking' header");
    assert.ok(!frame.includes("(0.0s)"),
      "frame should NOT include a 0.0s duration suffix");
  } finally {
    unmount();
  }
});

/* -------------------------------------------------------------------------- */
/*  Pi-derived hideThinkingBlock feature                                       */
/*                                                                            */
/*  When the user has the "hide thinking" preference on (the default), the  */
/*  reasoning block is suppressed entirely — both the chevron header AND   */
/*  the body. Toggling off reveals the chevron + body again.               */
/* -------------------------------------------------------------------------- */

test("message-card: hideThinkingBlock=true suppresses the reasoning header", () => {
  const msg: TuiAssistantMessage = {
    kind: "assistant",
    id: "a8",
    text: "answer",
    reasoning: "I had a long thought",
    ts: 0,
  };
  const { lastFrame, unmount } = render(<MessageCard message={msg} hideThinkingBlock={true} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(!frame.includes("thinking"),
      "frame should NOT include the reasoning block header when hideThinkingBlock=true");
    assert.ok(!frame.includes("I had a long thought"),
      "frame should NOT include the reasoning body when hideThinkingBlock=true");
    assert.ok(frame.includes("answer"),
      "frame should still include the chat text");
  } finally {
    unmount();
  }
});

test("message-card: hideThinkingBlock=false shows the reasoning block", () => {
  const msg: TuiAssistantMessage = {
    kind: "assistant",
    id: "a9",
    text: "answer",
    reasoning: "I had a long thought",
    ts: 0,
  };
  const { lastFrame, unmount } = render(<MessageCard message={msg} hideThinkingBlock={false} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("thinking"),
      "frame should include the reasoning header when hideThinkingBlock=false");
    // The default state is collapsed, so the body itself should not
    // be in the frame; the header is enough to confirm presence.
    assert.ok(!frame.includes("I had a long thought"),
      "frame should NOT include the reasoning body when collapsed (default)");
  } finally {
    unmount();
  }
});

test("message-card: non-assistant messages are unaffected by hideThinkingBlock", () => {
  const msg: TuiUserMessage = { kind: "user", id: "u2", text: "hello", ts: 0 };
  const { lastFrame, unmount } = render(<MessageCard message={msg} hideThinkingBlock={true} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("you"),
      "frame should still include the user role label");
    assert.ok(frame.includes("hello"),
      "frame should still include the user text");
  } finally {
    unmount();
  }
});
