/**
 * A large pasted prompt must not enter the context window.
 *
 * The observed failure: an 842,845-character paste (~211K tokens) went straight
 * into the conversation, the first model call was 226K tokens (84% of the 270K
 * soft cap), and the next tool result pushed the following call to 432K — 160%
 * of the cap. Compaction fired afterwards, too late. These tests pin the fix:
 * a large prompt is written verbatim to the workspace and replaced by a small
 * reference the model reads with its own tools.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { spillLargePrompt } from "../../../src/context/prompt-spill.js";

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "reaper-prompt-spill-"));
}

test("a small prompt is returned unchanged", () => {
  const ws = workspace();
  try {
    const result = spillLargePrompt({ workspaceRoot: ws, prompt: "fix the failing test" });
    assert.equal(result.spilled, false);
    assert.equal(result.text, "fix the failing test");
    assert.equal(result.path, undefined);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a large prompt is spilled to the workspace and replaced by a reference", () => {
  const ws = workspace();
  try {
    const pasted = "line of pasted data\n".repeat(4_000); // ~80K chars, well over threshold
    const result = spillLargePrompt({ workspaceRoot: ws, prompt: pasted });

    assert.equal(result.spilled, true);
    assert.equal(result.originalChars, pasted.length);
    assert.ok(result.path, "a path must be returned when spilled");

    // The reference is a small fraction of the paste.
    assert.ok(
      result.text.length < pasted.length / 10,
      `the reference (${result.text.length}) must be far smaller than the paste (${pasted.length})`,
    );
    // It names the file and tells the model how to read it.
    assert.ok(result.text.includes(result.path!), "the reference must name the file");
    assert.match(result.text, /file_view|grep_search|eval/, "the reference must say how to read the paste");
    assert.match(result.text, /Do not ask the user to paste it again/, "the model must not re-request the paste");

    // The file holds the paste verbatim — nothing was lost.
    const onDisk = readFileSync(path.join(ws, result.path!), "utf8");
    assert.equal(onDisk, pasted, "the spilled file must contain the exact paste");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("the spilled file lives under .reaper so it is not the user's own file", () => {
  const ws = workspace();
  try {
    const result = spillLargePrompt({ workspaceRoot: ws, prompt: "y".repeat(30_000) });
    assert.ok(result.path, "expected a spill");
    assert.ok(result.path!.startsWith(".reaper/"), `expected a .reaper path, got ${result.path}`);
    assert.ok(existsSync(path.join(ws, result.path!)), "the file must exist");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a spilled prompt carries a preview so the model sees what it is dealing with", () => {
  const ws = workspace();
  try {
    const pasted = `START-MARKER${"z".repeat(30_000)}END-MARKER`;
    const result = spillLargePrompt({ workspaceRoot: ws, prompt: pasted });
    assert.ok(result.text.includes("START-MARKER"), "the preview must include the start of the paste");
    assert.ok(!result.text.includes("END-MARKER"), "the tail must not be inlined");
    assert.match(result.text, /characters are in/, "the reference must say where the rest is");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
