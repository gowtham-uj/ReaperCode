/**
 * The terminal renderer, and the bug it exists to fix.
 *
 * The old CLI wrote reasoning and answer through one stdout channel,
 * distinguished only by `dim()`. A non-TTY — a pipe, a log file, CI — made
 * `dim()` a no-op, so reasoning was emitted character-for-character identically
 * to the answer and read as part of it.
 *
 * These tests use a plain object as the output stream, which is exactly the
 * non-TTY case: no `isTTY`, so no colour. Every assertion below is about what a
 * user or a log would actually contain, never about ANSI codes.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { TerminalRenderer } from "../../src/cli-client/renderer.js";

/** A stream that records what was written, with no TTY. */
function capture(): { stream: NodeJS.WriteStream; text(): string } {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, text: () => chunks.join("") };
}

test("reasoning is labelled on a stream that cannot colour", () => {
  const { stream, text } = capture();
  const renderer = new TerminalRenderer({ out: stream });

  renderer.handle("item/reasoning/textDelta", { delta: "let me think" });
  renderer.handle("item/agentMessage/delta", { delta: "The answer." });
  renderer.finish();

  const output = text();
  /*
   * The load-bearing assertions. `thinking` must appear as literal text and the
   * reasoning must not be indistinguishable from the answer: strip the labels
   * and the two would concatenate into one run, which is the bug.
   */
  assert.match(output, /thinking/, "reasoning had no label on a non-colour stream");
  assert.match(output, /let me think/);
  assert.match(output, /The answer\./);
  assert.ok(
    output.indexOf("thinking") < output.indexOf("The answer."),
    "the reasoning label must come before the answer it precedes",
  );
  // No escapes on a stream that cannot render them.
  assert.doesNotMatch(output, /\x1b\[/, "ANSI codes were written to a non-TTY");
});

test("the answer is not labelled as reasoning", () => {
  const { stream, text } = capture();
  const renderer = new TerminalRenderer({ out: stream });
  renderer.handle("item/agentMessage/delta", { delta: "Just the answer." });
  renderer.finish();
  const output = text();
  assert.match(output, /Just the answer\./);
  assert.doesNotMatch(output, /thinking/, "the answer was labelled as thinking");
});

test("reasoning can be turned off entirely", () => {
  // A quiet run should not print thinking at all, rather than printing it
  // unlabelled, which is what made the old output unreadable.
  const { stream, text } = capture();
  const renderer = new TerminalRenderer({ out: stream, showReasoning: false });
  renderer.handle("item/reasoning/textDelta", { delta: "secret thoughts" });
  renderer.handle("item/agentMessage/delta", { delta: "Visible." });
  renderer.finish();
  const output = text();
  assert.doesNotMatch(output, /secret thoughts/);
  assert.match(output, /Visible\./);
});

test("a tool call gets one line with its label and detail", () => {
  const { stream, text } = capture();
  const renderer = new TerminalRenderer({ out: stream });
  renderer.handle("item/completed", {
    item: {
      type: "dynamicToolCall",
      id: "t1",
      tool: "grep_search",
      arguments: { pattern: "refreshToken", path: "src/" },
      status: "completed",
    },
  });
  const output = text();
  // The label comes from the shared vocabulary, so the terminal and the web
  // transcript call this call the same thing.
  assert.match(output, /Grep search|Search/, `unexpected label in: ${output}`);
  assert.equal(output.split("\n").filter((line) => line.trim()).length, 1, "a tool call should be one line");
});

test("a failed command is marked as failed, not as done", () => {
  const { stream, text } = capture();
  const renderer = new TerminalRenderer({ out: stream });
  renderer.handle("item/completed", {
    item: { type: "commandExecution", id: "c1", command: "npm test", status: "failed", exitCode: 1 },
  });
  assert.match(text(), /✕|failed/i, "a failing command must be distinguishable from a passing one");
});

test("command output is indented so it is not read as prose", () => {
  const { stream, text } = capture();
  const renderer = new TerminalRenderer({ out: stream });
  renderer.handle("item/commandExecution/outputDelta", { delta: "line one\nline two\n" });
  const output = text();
  assert.match(output, /^ {4}line one$/m, "command output was emitted flush with agent prose");
});

test("an error is reported and closes the open block", () => {
  const { stream, text } = capture();
  const renderer = new TerminalRenderer({ out: stream });
  renderer.handle("item/agentMessage/delta", { delta: "partial" });
  renderer.handle("error", { message: "the provider refused" });
  const output = text();
  assert.match(output, /the provider refused/);
  // The partial answer must be terminated, or the error reads as its next line.
  assert.match(output, /partial\n/);
});

test("unknown notifications are ignored rather than dumped", () => {
  // The server can add methods; a client that printed their raw params would
  // spray JSON into what the user is reading.
  const { stream, text } = capture();
  const renderer = new TerminalRenderer({ out: stream });
  renderer.handle("some/futureMethod", { strange: { nested: true } });
  assert.equal(text(), "");
});
