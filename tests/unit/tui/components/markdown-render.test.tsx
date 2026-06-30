import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";

import { render } from "ink-testing-library";

import { MarkdownRender } from "../../../../src/tui/markdown-render.js";

test("markdown-render: decodes HTML entities in inline text", () => {
  const { lastFrame, unmount } = render(<MarkdownRender source="I&#39;m ready" />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("I'm ready"), `frame should decode HTML entities; got: ${frame}`);
    assert.ok(!frame.includes("&#39;"), "frame should not expose the raw entity");
  } finally {
    unmount();
  }
});

test("markdown-render: suppresses empty list items", () => {
  const source = "- first\n-\n- third";
  const { lastFrame, unmount } = render(<MarkdownRender source={source} />);
  try {
    const frame = lastFrame();
    assert.ok(frame, "frame should be defined");
    assert.ok(frame.includes("first"), "frame should include the first list item");
    assert.ok(frame.includes("third"), "frame should include the third list item");
    assert.ok(!/^•\s*$/m.test(frame), `frame should not include an empty bullet; got: ${frame}`);
  } finally {
    unmount();
  }
});
