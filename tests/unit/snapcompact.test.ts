/**
 * Tests for context/snapcompact.ts (T4 OMP port).
 *
 * Snapcompact collapses consecutive image blocks into a single
 * synthetic summary stub. Inert when there are no image blocks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { countImageBlocks, findConsecutiveImageRuns, maybeSnapcompact } from "../../src/context/snapcompact.js";

test("countImageBlocks: returns 0 for text-only messages", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "tool", content: '{"ok":true}' },
  ];
  assert.equal(countImageBlocks(messages), 0);
});

test("countImageBlocks: returns 1 per image-bearing message", () => {
  const messages = [
    { role: "user", content: "look at this:" },
    { role: "user", content: [{ type: "text", text: "image caption" }, { type: "image_url", image_url: { url: "https://..." } }] },
    { role: "assistant", content: "I see the image" },
    { role: "user", content: [{ type: "image", source: { type: "base64", data: "..." } }] },
  ];
  assert.equal(countImageBlocks(messages), 2);
});

test("findConsecutiveImageRuns: returns empty array when no images", () => {
  const messages = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ];
  assert.deepEqual(findConsecutiveImageRuns(messages), []);
});

test("findConsecutiveImageRuns: detects single-run of 4 consecutive images", () => {
  const imgMsg = (i: number) => ({
    role: "user",
    content: [{ type: "image_url", image_url: { url: `img-${i}` } }],
  });
  const messages = [
    { role: "user", content: "before" },
    imgMsg(0),
    imgMsg(1),
    imgMsg(2),
    imgMsg(3),
    { role: "assistant", content: "after" },
  ];
  const runs = findConsecutiveImageRuns(messages);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.startIdx, 1);
  assert.equal(runs[0]!.endIdx, 4);
});

test("findConsecutiveImageRuns: detects multiple separate runs", () => {
  const img = (i: number) => ({ role: "user", content: [{ type: "image_url", image_url: { url: `i${i}` } }] });
  const messages = [
    img(0), img(1),                 // run 1: idx 0-1
    { role: "user", content: "break" },
    img(2), img(3), img(4),         // run 2: idx 3-5
  ];
  const runs = findConsecutiveImageRuns(messages);
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.startIdx, 0);
  assert.equal(runs[0]!.endIdx, 1);
  assert.equal(runs[1]!.startIdx, 3);
  assert.equal(runs[1]!.endIdx, 5);
});

test("maybeSnapcompact: no-op for text-only conversation", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ];
  const result = maybeSnapcompact(messages);
  assert.equal(result.performed, false);
  assert.equal(result.collapsedImages, 0);
  assert.equal(result.savedChars, 0);
  assert.equal(messages.length, 2, "messages should be unchanged");
});

test("maybeSnapcompact: no-op when only 2 consecutive images (below default threshold of 3)", () => {
  const img = (i: number) => ({ role: "user", content: [{ type: "image_url", image_url: { url: `i${i}` } }] });
  const messages = [img(0), img(1)];
  const result = maybeSnapcompact(messages);
  assert.equal(result.performed, false);
  assert.equal(messages.length, 2);
});

test("maybeSnapcompact: collapses 3+ consecutive images into a stub", () => {
  // Note: each "image" stub is intentionally shorter than the
  // stub message — the goal is structural reduction (4 messages
  // → 1), not necessarily char reduction. For the simple image
  // messages below the stub is longer, so savedChars can be 0
  // for tiny originals. We assert `performed: true` and the
  // structural collapse as the canonical signal.
  const longCaption = "x".repeat(100);
  const img = (i: number) => ({
    role: "user",
    content: [{ type: "text", text: `caption-${i}` }, { type: "image_url", image_url: { url: `i${i}` } }],
  });
  const messages: Array<Record<string, unknown>> = [
    img(0), img(1), img(2), img(3),
  ];
  const result = maybeSnapcompact(messages);
  assert.equal(result.performed, true);
  assert.equal(result.collapsedImages, 3);
  assert.equal(messages.length, 1, "should be 1 stub message after collapse");
  assert.ok((messages[0] as any).__snapcompacted === true);
  assert.ok((messages[0] as any).content.includes("[snapcompact]"));
  assert.ok((messages[0] as any).content.includes("4 image blocks"));
});

test("maybeSnapcompact: saves chars when originals are large", () => {
  // Construct messages with substantial per-message content so
  // collapsing into a stub actually saves chars.
  const big = "x".repeat(500);
  const img = (i: number) => ({
    role: "user",
    content: [{ type: "image_url", image_url: { url: `i${i}` } }, { type: "text", text: big }],
  });
  const messages: Array<Record<string, unknown>> = [img(0), img(1), img(2), img(3)];
  const result = maybeSnapcompact(messages);
  assert.equal(result.performed, true);
  assert.ok(result.savedChars > 0, "savedChars should be > 0 for large originals");
});

test("maybeSnapcompact: respects custom minConsecutiveImages", () => {
  const img = (i: number) => ({ role: "user", content: [{ type: "image_url", image_url: { url: `i${i}` } }] });
  const messages = [img(0), img(1)];
  // Default min is 3 → no-op
  assert.equal(maybeSnapcompact(messages).performed, false);
  // Custom min is 2 → fires
  const result = maybeSnapcompact(messages, { minConsecutiveImages: 2 });
  assert.equal(result.performed, true);
  assert.equal(result.collapsedImages, 1);
});