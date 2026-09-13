/**
 * Code Mode, as the terminal shows it.
 *
 * The CLI is a second surface for the same feature, and the failure mode it
 * has that the browser does not is unbounded output: a script is untrusted and
 * can print forever, and a terminal that scrolls ten thousand lines has buried
 * the turn it was narrating. So the assertions here are mostly about *bounds*
 * — that a long program, a long console, and a large value all come out
 * clipped, with the clipping stated rather than silent.
 *
 * The other half is the one thing the printer must never get wrong: a failed
 * script has to say why. A silent row for a `throw` is indistinguishable from a
 * script that deliberately returned nothing, which is exactly the confusion the
 * eval tool's result shape exists to prevent.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { dim, enableSessionPrinter, printToolCalls, printToolResult } from "../../src/runtime/session-printer.js";

/** Collect writes instead of touching stdout. */
function capture(): { out: NodeJS.WriteStream; text: () => string } {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
    isTTY: false,
  } as unknown as NodeJS.WriteStream;
  return { out: stream, text: () => chunks.join("") };
}

function withPrinter<T>(body: (out: NodeJS.WriteStream) => T): { result: T; text: string } {
  const { out, text } = capture();
  enableSessionPrinter(true, out);
  const result = body(out);
  return { result, text: text() };
}

test("a Code Mode call prints its summary and its source", () => {
  const { text } = withPrinter((out) => {
    printToolCalls([{ name: "eval", args: { code: "const files = await tools.glob({ pattern: '**/*.ts' });\nfiles.length" } }], { out });
  });
  // The tool's own name, beautified. `→ eval` was the raw registry key; the
  // terminal and the browser now say "Eval" for the same call.
  assert.match(text, /→ Eval — const files = await tools\.glob\(\{ pattern: '\*\*\/\*\.ts' \}\); \(\+1 lines\)/);
  // The program itself, on its own lines, because a one-line summary of a
  // program is not a summary of anything.
  assert.match(text, /const files = await tools\.glob/);
  assert.match(text, /files\.length/);
});

test("an ordinary tool does not grow a source block", () => {
  const { text } = withPrinter((out) => {
    printToolCalls([{ name: "file_view", args: { path: "/work/README.md" } }], { out });
  });
  assert.match(text, /→ File view — \/work\/README\.md/);
  assert.equal(text.split("\n").filter((line) => line.trim()).length, 1);
});

test("a long program is clipped, and says so", () => {
  const code = Array.from({ length: 60 }, (_, index) => `const line${index} = ${index};`).join("\n");
  const { text } = withPrinter((out) => {
    printToolCalls([{ name: "eval", args: { code } }], { out });
  });
  assert.match(text, /const line0 = 0;/);
  assert.doesNotMatch(text, /const line40 = 40;/, "only the head of the program is printed");
  assert.match(text, /… 36 more lines/);
});

test("a single very long line is clipped to the terminal width", () => {
  const code = `const blob = "${"x".repeat(400)}";`;
  const { text } = withPrinter((out) => {
    printToolCalls([{ name: "eval", args: { code } }], { out });
  });
  const body = text.split("\n").find((line) => line.includes("const blob")) ?? "";
  assert.ok(body.length < 200, `expected a clipped line, got ${body.length} characters`);
  assert.match(body, /…$/);
});

test("the result line carries status, tool-call count, value and duration", () => {
  const { text } = withPrinter((out) => {
    printToolResult({
      name: "eval",
      ok: true,
      output: {
        status: "completed",
        durationMs: 1234,
        toolCalls: [
          { name: "grep_search", ok: true, durationMs: 12 },
          { name: "file_view", ok: true, durationMs: 4 },
          { name: "file_view", ok: true, durationMs: 3 },
        ],
        value: 42,
      },
    }, { out });
  });
  // The inner tools, named, rather than only counted. "3 tool calls" told a
  // reader how busy the script was; "Grep search, File view ×2" tells them what
  // it did, which is the question the line exists to answer.
  assert.match(text, /Grep search, File view ×2 · → 42 · 1\.2s/);
});

test("a string value prints as the sentence it is, not as JSON", () => {
  const { text } = withPrinter((out) => {
    printToolResult({ name: "eval", ok: true, output: { status: "completed", durationMs: 5, value: "12 files changed" } }, { out });
  });
  assert.match(text, /→ 12 files changed/);
  assert.doesNotMatch(text, /"12 files changed"/);
});

test("a failed script explains itself without being asked", () => {
  const { text } = withPrinter((out) => {
    printToolResult({
      name: "eval",
      ok: true,
      output: {
        status: "error",
        durationMs: 9,
        toolCallCount: 0,
        error: { name: "TypeError", message: "cannot read properties of undefined (reading 'map')" },
      },
    }, { out });
  });
  assert.match(text, /error/);
  assert.match(text, /✕ TypeError: cannot read properties of undefined/);
});

test("the correction the model was given is printed under the error", () => {
  // The hint exists for the model, but a person watching a script fail wants
  // the same sentence: it is the difference between "that broke" and "that
  // broke, and here is what it should have done".
  const { text } = withPrinter((out) => {
    printToolResult({
      name: "eval",
      ok: true,
      output: {
        status: "error",
        durationMs: 4,
        error: {
          name: "ReferenceError",
          message: "could not load module 'node:fs'",
          hint: "Node modules are not available in this sandbox — use `await tools.read({ filePath })`.",
        },
      },
    }, { out });
  });
  assert.match(text, /✕ ReferenceError: could not load module/);
  assert.match(text, /↳ Node modules are not available/);
});

test("console output is shown as a tail, with the withheld count stated", () => {
  const console_ = Array.from({ length: 20 }, (_, index) => ({ level: "log", text: `step ${index}` }));
  const { text } = withPrinter((out) => {
    printToolResult({ name: "eval", ok: true, output: { status: "completed", durationMs: 5, console: console_ } }, { out });
  });
  assert.match(text, /… 12 earlier lines/);
  assert.match(text, /step 19/);
  assert.doesNotMatch(text, /│ step 11/, "the middle of the console is not reprinted");
});

test("the printer stays silent for tools that are not Code Mode", () => {
  const { text } = withPrinter((out) => {
    printToolResult({ name: "bash", ok: true, output: { stdout: "hello" } }, { out });
  });
  assert.equal(text, "");
});

test("a sandbox that never started reports through the tool-error channel", () => {
  const { text } = withPrinter((out) => {
    printToolResult({ name: "eval", ok: false, output: undefined, error: { code: "runtime_unavailable", message: "no workspace" } }, { out });
  });
  assert.match(text, /✕ no workspace/);
});

test("dim is a no-op on a stream that cannot render it", () => {
  const { out } = capture();
  assert.equal(dim("x", out), "x");
});
