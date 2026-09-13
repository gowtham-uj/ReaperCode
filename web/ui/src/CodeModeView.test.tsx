import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { CodeModeView } from "./CodeModeView.js";
import type { AppThreadItem } from "@reaper/web-shared";

afterEach(cleanup);

/**
 * Code Mode in the transcript.
 *
 * Two of these tests are about *absence*, which is the harder half to get
 * right and the half a naive implementation gets wrong. The inner tool calls
 * must be listed without their outputs — the entire reason to reach for eval is
 * that a hundred file bodies stay inside the script, and rendering them here
 * would rebuild, on screen, exactly the cost the model avoided. And a running
 * script must never render the collapsed failure line: there is no failure yet.
 */

type CodeModeItem = Extract<AppThreadItem, { type: "dynamicToolCall" }>;

function item(overrides: Partial<CodeModeItem> = {}): CodeModeItem {
  return {
    type: "dynamicToolCall",
    id: "eval-1",
    tool: "eval",
    arguments: { code: "const a = 1;\nreturn a + 1;" },
    status: "completed",
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "completed", durationMs: 1200, toolCallCount: 0, toolCalls: [], ...overrides };
}

describe("Code Mode transcript view", () => {
  it("summarises the run without being opened", () => {
    render(<CodeModeView item={item({
      result: result({
        toolCalls: [
          { name: "grep_search", ok: true, durationMs: 12 },
          { name: "file_view", ok: true, durationMs: 4 },
        ],
        value: 41,
      }),
    })} />);

    /*
     * The disclosure button, matched by name rather than by `expanded: false`.
     * The block now opens by default, so selecting it by its collapsed state
     * stopped finding it — and the state was never what this test was about.
     */
    const row = screen.getByRole("button", { name: /Eval/ });
    expect(within(row).getByText("Eval")).toBeDefined();
    expect(within(row).getByText(/2 tool calls/)).toBeDefined();
    expect(within(row).getByText(/41/)).toBeDefined();
    expect(within(row).getByText("1.2s")).toBeDefined();
  });

  it("opens into the source, the calls it made, and the value it kept", async () => {
    const user = userEvent.setup();
    render(<CodeModeView item={item({
      result: result({
        toolCalls: [{ name: "grep_search", ok: true, durationMs: 12 }],
        value: { files: 12 },
      }),
    })} />);

    // Already open by default; this ensures it regardless, so the test asserts
    // the content rather than the initial state.
    const trigger0 = screen.getByRole("button", { name: /Eval/ });
    if (trigger0.getAttribute("aria-expanded") === "false") await user.click(trigger0);

    expect(screen.getByText("JavaScript")).toBeDefined();
    // The model's own script, line by line, with the line numbers it would see
    // in an error message.
    expect(screen.getByText("const a = 1;")).toBeDefined();
    expect(screen.getByText("return a + 1;")).toBeDefined();
    /*
     * "Grep search", the tool's own name beautified.
     *
     * The ledger used the raw key, so the inner list said `grep_search` while
     * the row above it said "Eval" — one screen, two naming conventions. Both
     * now run through `toolLabel`, which resolves the underscore and leaves the
     * name alone otherwise.
     */
    expect(screen.getByText("Grep search")).toBeDefined();
    expect(screen.getByText(/"files": 12/)).toBeDefined();
  });

  it("never renders an inner tool's output", async () => {
    const user = userEvent.setup();
    /*
     * The load-bearing assertion. The result payload deliberately carries no
     * per-call output, and the view must not find one anyway — the moment this
     * renders a file body, the reason to use Code Mode is gone.
     */
    render(<CodeModeView item={item({
      result: result({
        toolCalls: [{ name: "file_view", ok: true, durationMs: 3 }],
        value: "3 files",
      }),
    })} />);
    // Already open by default; this ensures it regardless, so the test asserts
    // the content rather than the initial state.
    const trigger1 = screen.getByRole("button", { name: /Eval/ });
    if (trigger1.getAttribute("aria-expanded") === "false") await user.click(trigger1);

    expect(screen.getByText("File view")).toBeDefined();
    expect(screen.queryByText(/export const SECRET/)).toBeNull();
  });

  it("shows a failure on the collapsed row, because a silent row reads as success", () => {
    render(<CodeModeView item={item({
      result: result({
        status: "error",
        error: { name: "TypeError", message: "x is not a function" },
      }),
    })} />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("TypeError: x is not a function");
  });

  it("names the tool when a rejected call escaped the script", () => {
    render(<CodeModeView item={item({
      result: result({
        status: "error",
        error: { name: "Error", message: "denied", tool: "bash", code: "PERMISSION_DENIED" },
        toolCalls: [{ name: "bash", ok: false, durationMs: 2, error: "PERMISSION_DENIED: denied" }],
      }),
    })} />);

    expect(screen.getByRole("alert").textContent).toContain("bash");
  });

  it("streams output while the script is still running", () => {
    /*
     * The live half. A script that reads forty files takes a while, and the
     * only thing separating "working" from "hung" is output arriving as it
     * happens — so the running row counts the crossings it has seen.
     */
    render(<CodeModeView item={item({
      status: "inProgress",
      result: undefined,
      liveOutput: [
        { kind: "log", text: "starting\n" },
        { kind: "tool", text: "grep_search ok (12ms)\n" },
        { kind: "tool", text: "file_view ok (4ms)\n" },
      ],
    })} />);

    expect(screen.getByText(/running · 2 tool calls so far/)).toBeDefined();
  });

  it("does not render a failure line for a script that is still running", () => {
    render(<CodeModeView item={item({
      status: "inProgress",
      result: undefined,
      error: "connection lost mid-turn",
      liveOutput: [{ kind: "log", text: "working\n" }],
    })} />);

    // An in-flight call has no verdict. Showing one would tell a person their
    // script failed while it is still writing files.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the console only when there is console output", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<CodeModeView item={item({ result: result({ value: 1 }) })} />);
    // Already open by default; this ensures it regardless, so the test asserts
    // the content rather than the initial state.
    const trigger2 = screen.getByRole("button", { name: /Eval/ });
    if (trigger2.getAttribute("aria-expanded") === "false") await user.click(trigger2);
    expect(screen.queryByText("Console")).toBeNull();
    unmount();

    render(<CodeModeView item={item({
      result: result({ value: 1, console: [{ level: "warn", text: "careful\n" }] }),
    })} />);
    // Already open by default; this ensures it regardless, so the test asserts
    // the content rather than the initial state.
    const trigger3 = screen.getByRole("button", { name: /Eval/ });
    if (trigger3.getAttribute("aria-expanded") === "false") await user.click(trigger3);
    expect(screen.getByText("Console")).toBeDefined();
    expect(screen.getByText("careful")).toBeDefined();
  });

  it("states when the result was cut rather than quietly showing less", async () => {
    const user = userEvent.setup();
    render(<CodeModeView item={item({
      result: result({ value: ["a", "b"], resultTruncated: true, resultBytes: 262144 }),
    })} />);
    // Already open by default; this ensures it regardless, so the test asserts
    // the content rather than the initial state.
    const trigger4 = screen.getByRole("button", { name: /Eval/ });
    if (trigger4.getAttribute("aria-expanded") === "false") await user.click(trigger4);

    expect(screen.getByText(/cut to 256\.0 KB/)).toBeDefined();
  });

  it("renders a call that never produced a report without inventing one", async () => {
    const user = userEvent.setup();
    render(<CodeModeView item={item({
      status: "failed",
      result: undefined,
      error: "The JavaScript runtime could not be started: no workspace",
    })} />);

    /*
     * `getAllByText` with a length check rather than `getByText`, because the
     * count is the assertion. The body used to render the same sentence again
     * as a raw `<pre>` for any call with no report, so an *open* failed block
     * showed the error twice — a reader who clicked to learn more got the same
     * paragraph in a second typeface. `getByText` caught it as an ambiguity;
     * saying the number out loud records why one is the right number.
     */
    expect(screen.getAllByText(/runtime could not be started/)).toHaveLength(1);
    // Already open by default; this ensures it regardless, so the test asserts
    // the content rather than the initial state.
    const trigger5 = screen.getByRole("button", { name: /Eval/ });
    if (trigger5.getAttribute("aria-expanded") === "false") await user.click(trigger5);
    expect(screen.getAllByText(/runtime could not be started/)).toHaveLength(1);
    // The script is still worth reading when the runtime never started. Scoped to
    // the code block because the collapsed row also falls back to the script's
    // first line when there is no run summary to show instead.
    const code = document.querySelector(".code-block") as HTMLElement;
    expect(within(code).getByText("const a = 1;")).toBeDefined();
    expect(within(code).getByText("return a + 1;")).toBeDefined();
  });

  it("marks a thrown script as failed even though the tool call itself succeeded", () => {
    /*
     * Caught in a live transcript: the row read "Code Mode failed … ✓" with a
     * screen-reader name of "succeeded". Both halves were accurate about
     * different subjects — the script threw, the *call* returned it cleanly —
     * and together they were nonsense. The glyph answers the question the
     * reader is asking, which is about the program.
     */
    render(<CodeModeView item={item({
      status: "completed",
      result: result({ status: "error", value: undefined, error: { name: "TypeError", message: "cannot read property 'c' of undefined (line 1)" } }),
    })} />);

    const glyph = document.querySelector(".tool-status") as HTMLElement;
    expect(glyph.dataset.status).toBe("failed");
    expect(glyph.textContent).toContain("✕");
    expect(within(glyph).getByText("failed")).toBeDefined();
  });

  it("shows the correction alongside the complaint, not just the complaint", () => {
    /*
     * From a drive screenshot: a block reading "ReferenceError: could not load
     * module 'node:fs'" and nothing else, while the runtime had already
     * attached the sentence naming `tools.read` and the CLI was printing it.
     * The web row was the one surface dropping the half of the error that says
     * what to do instead.
     */
    render(<CodeModeView item={item({
      status: "completed",
      result: result({
        status: "error",
        value: undefined,
        error: {
          name: "ReferenceError",
          message: "could not load module 'node:fs'",
          hint: "`files` is not defined in this script. Each eval runs in a fresh environment, so a variable from an earlier eval is not visible here.",
        },
      }),
    })} />);

    const row = document.querySelector(".code-mode-error") as HTMLElement;
    expect(row.textContent).toContain("could not load module 'node:fs'");
    /*
     * The hint is the second line of the alert, and the assertion is on the
     * *rendered* text rather than on the prop — an earlier version of this
     * test passed while the hint was being read and then dropped on the way to
     * the screen, which is the bug this row exists to prevent.
     */
    expect(within(row).getByText(/fresh environment/)).toBeDefined();
  });

  it("keeps the failure on screen when the block is expanded", async () => {
    /*
     * Expanding was deleting the explanation: the error row was gated on the
     * block being closed, and the expanded body renders console, value, and
     * note — none of which a thrown script has. So the one gesture a person
     * makes to learn more about a failure left them with less.
     */
    const user = userEvent.setup();
    render(<CodeModeView item={item({
      status: "completed",
      result: result({ status: "error", value: undefined, error: { name: "Error", message: "bad input (line 3)" } }),
    })} />);

    // Already open by default; this ensures it regardless, so the test asserts
    // the content rather than the initial state.
    const trigger6 = screen.getByRole("button", { name: /Eval/ });
    if (trigger6.getAttribute("aria-expanded") === "false") await user.click(trigger6);
    expect(screen.getByRole("button", { expanded: true })).toBeDefined();
    expect(screen.getByText(/bad input \(line 3\)/)).toBeDefined();
  });

  it("a running call is a spinner, not a static ellipsis", () => {
    /*
     * The report this addresses: a tool call that had been running for two
     * minutes looked exactly like one that had finished. The glyph was "⋯" —
     * a static character that is indistinguishable from a glyph that failed to
     * render, and that never changes while the work continues.
     *
     * The assertion is on the shape, not the colour, because the shape is what
     * has to survive a colourblind reader and a greyscale screenshot. A
     * reduced-motion reader gets a still arc, which is still not "✓".
     */
    render(<CodeModeView item={item({ status: "inProgress" })} />);
    const glyph = document.querySelector(".tool-status") as HTMLElement;
    expect(glyph.dataset.status).toBe("inProgress");
    expect(glyph.querySelector(".tool-spinner")).not.toBeNull();
    expect(glyph.textContent).not.toContain("⋯");
    expect(within(glyph).getByText("running")).toBeDefined();
  });

  it("keeps the success glyph when the script returned normally", () => {
    render(<CodeModeView item={item({ status: "completed", result: result({ value: 42 }) })} />);
    const glyph = document.querySelector(".tool-status") as HTMLElement;
    expect(glyph.dataset.status).toBe("completed");
    expect(within(glyph).getByText("succeeded")).toBeDefined();
  });

  it("marks the call that failed, and only that one", async () => {
    /*
     * The inverse-marker bug, pinned at the level a unit test can reach.
     *
     * The row carried `data-ok` on success while the stylesheet painted its
     * marker red for `[data-ok]`, so a ledger of successful calls came out
     * looking like a list of failures. jsdom cannot see `::before`, so the
     * glyph itself is untestable here — what *is* testable is the attribute the
     * glyph keys off, and getting that backwards is the whole bug. Anyone who
     * flips it back to `data-ok` fails this.
     *
     * Asserted in both directions, because "no attribute on the failing row" is
     * exactly as broken as "attribute on the passing one" and only checking one
     * side would pass for either.
     */
    const user = userEvent.setup();
    render(<CodeModeView item={item({
      result: result({
        toolCalls: [
          { name: "grep_search", ok: true, durationMs: 12 },
          { name: "file_view", ok: false, durationMs: 3, error: "not_found: no such file" },
        ],
      }),
    })} />);
    // Already open by default; this ensures it regardless, so the test asserts
    // the content rather than the initial state.
    const trigger7 = screen.getByRole("button", { name: /Eval/ });
    if (trigger7.getAttribute("aria-expanded") === "false") await user.click(trigger7);

    const rows = Array.from(document.querySelectorAll(".code-mode-call"));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.hasAttribute("data-failed")).toBe(false);
    expect(rows[1]?.hasAttribute("data-failed")).toBe(true);
  });

  it("says in words whether each call worked, for readers who get no glyph", async () => {
    /*
     * The error text names what went wrong but never says the row failed, and
     * the marker is a `::before` that assistive technology cannot reach. So the
     * verdict gets a real node.
     */
    const user = userEvent.setup();
    render(<CodeModeView item={item({
      result: result({
        toolCalls: [
          { name: "grep_search", ok: true, durationMs: 12 },
          { name: "file_view", ok: false, durationMs: 3, error: "not_found: no such file" },
        ],
      }),
    })} />);
    // Already open by default; this ensures it regardless, so the test asserts
    // the content rather than the initial state.
    const trigger8 = screen.getByRole("button", { name: /Eval/ });
    if (trigger8.getAttribute("aria-expanded") === "false") await user.click(trigger8);

    const rows = Array.from(document.querySelectorAll(".code-mode-call"));
    expect(rows[0]?.textContent).toContain("succeeded");
    expect(rows[1]?.textContent).toContain("failed");
  });

  it("collapses a long value behind a disclosure instead of pushing the turn off screen", async () => {
    const user = userEvent.setup();
    const big = { rows: Array.from({ length: 200 }, (_, index) => ({ id: index, name: `row-${index}` })) };
    render(<CodeModeView item={item({ result: result({ value: big }) })} />);
    // Already open by default; this ensures it regardless, so the test asserts
    // the content rather than the initial state.
    const trigger9 = screen.getByRole("button", { name: /Eval/ });
    if (trigger9.getAttribute("aria-expanded") === "false") await user.click(trigger9);

    const toggle = screen.getByText("Show full value");
    const shown = document.querySelector(".code-mode-result")?.textContent ?? "";
    expect(shown.length).toBeLessThan(400);
    expect(shown.endsWith("…")).toBe(true);

    await user.click(toggle);
    expect((document.querySelector(".code-mode-result")?.textContent ?? "").length).toBeGreaterThan(1000);
  });

  /*
   * The collapsed row must never be blank, and the case that broke it was not
   * exotic.
   *
   * Found in a drive screenshot: the whole line read `{ } Code Mode  207ms`.
   * The model had run its work through raw `node:fs` rather than `tools.*`, so
   * there were no inner calls to count, and its last statement was a
   * serialising call rather than a bare expression, so there was no value to
   * preview. `summarizeRun` looked at exactly those two things, both were
   * legitimately empty, and it joined an empty array.
   *
   * The runtime had already diagnosed it — `note` is set precisely when the
   * rewrite could not find a value to return, and it names the fix — and the
   * row was throwing that away.
   */
  it("says what happened when a script called nothing and returned nothing", () => {
    render(<CodeModeView item={item({
      arguments: { code: "const fs = require('fs');\nfs.readdirSync('.').filter((f) => f.endsWith('.ts'));" },
      result: result({
        toolCalls: [],
        value: undefined,
        note: "The script produced no value. The result is the last expression — end with the value you want back, not with a declaration or a loop.",
      }),
    })} />);

    const detail = document.querySelector(".tool-detail")?.textContent ?? "";
    expect(detail.length).toBeGreaterThan(0);
    expect(detail).toContain("no value");
  });

  it("falls back to the script's first line when there is no note either", () => {
    /*
     * The second resort. A note is not always present — a script that returns
     * `undefined` on purpose has none, because it did what it said — and an
     * empty summary is worse than a slightly vague one. The first line answers
     * "what was this?", which is the question a collapsed row is for.
     */
    render(<CodeModeView item={item({
      arguments: { code: "const fs = require('fs');\nfor (const f of fs.readdirSync('.')) {}" },
      result: result({ toolCalls: [], value: undefined }),
    })} />);

    const detail = document.querySelector(".tool-detail")?.textContent ?? "";
    expect(detail).toBe("const fs = require('fs');");
  });

  it("still prefers a real value over either fallback", () => {
    // The fix must not displace the normal case: a script that returned
    // something shows it, and the note is only for when there is nothing else.
    render(<CodeModeView item={item({
      result: result({ toolCalls: [], value: 41, note: "ignored when a value exists" }),
    })} />);

    /*
     * `→ 41`, where this used to assert `41`.
     *
     * The arrow is the fix: a returned value and a call count are both bare
     * numbers, so a script that called nothing and returned `2` rendered as a
     * row reading exactly `2` — next to a column that says "2 tool calls" two
     * pixels away. The CLI has always printed `→ value` for this; the browser
     * now uses the same mark for the same fact.
     */
    expect(document.querySelector(".tool-detail")?.textContent).toBe("→ 41");
  });

  /*
   * The block opens by itself, and that is the point of the feature.
   *
   * It started collapsed, so a finished eval rendered as one thin line. The
   * program the model wrote — the thing Code Mode exists to show — sat one
   * click away from a reader with no reason to suspect it was there. A tool row
   * collapses because its detail is incidental; this one expands because its
   * detail *is* the feature.
   */
  it("opens by default so the script and the value are visible", () => {
    const { container } = render(<CodeModeView item={item({
      arguments: { code: "const a = 1;\na + 1;" },
      result: result({ value: 2 }),
    })} />);

    expect(container.querySelector(".tool-disclosure")?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll(".code-line").length).toBeGreaterThan(0);
    expect(container.querySelector("[data-result]")).not.toBeNull();
  });

  it("opens itself when the result arrives, having mounted while running", () => {
    /*
     * The bug the live UI caught, and the reason a lazy `useState` initializer
     * was not enough.
     *
     * A Code Mode item mounts when its call *starts* — status `inProgress`, no
     * result. The initializer therefore chose collapsed, and it never ran again,
     * so the block stayed collapsed after the result arrived. That is the
     * original "the code is gone when it finishes" complaint, re-created by the
     * fix for it: the screenshot showed `→ 55` beside a chevron pointing right.
     *
     * So this mounts mid-run and then re-renders with the result, which is the
     * exact sequence a real turn produces and which a single-render test cannot
     * reproduce.
     */
    const running = {
      type: "dynamicToolCall" as const, id: "e-mid", tool: "eval", status: "inProgress" as const,
      arguments: { code: "const total = 55;\ntotal;" },
    };
    const { container, rerender } = render(<CodeModeView item={running as never} />);
    expect(container.querySelector(".tool-disclosure")?.getAttribute("aria-expanded")).toBe("false");

    rerender(
      <CodeModeView
        item={{
          ...running,
          status: "completed",
          result: { status: "completed", durationMs: 154, toolCallCount: 0, toolCalls: [], value: 55 },
        } as never}
      />,
    );
    expect(container.querySelector(".tool-disclosure")?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll(".code-line").length).toBeGreaterThan(0);
  });

  it("respects a reader who closes it", () => {
    /*
     * The other half of auto-opening: once someone has made the choice, the
     * block must stop deciding for them. Without this, a re-render after a
     * close would reopen the block under the reader's cursor.
     */
    const { container } = render(<CodeModeView item={item({
      arguments: { code: "const a = 1;" },
      result: result({ value: 1 }),
    })} />);
    const trigger = container.querySelector(".tool-disclosure") as HTMLElement;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    act(() => { trigger.click(); });
    expect(container.querySelector(".tool-disclosure")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("stays collapsed while a script is still running", () => {
    // The live output has its own region below the row; opening the block
    // mid-run would push the streaming view off screen.
    const { container } = render(<CodeModeView item={item({
      status: "inProgress",
      arguments: { code: "while (true) {}" },
      result: undefined,
    })} />);

    expect(container.querySelector(".tool-disclosure")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("stays collapsed when there is nothing to show", () => {
    // A no-op script with no arguments should not take over the transcript.
    const { container } = render(<CodeModeView item={item({
      arguments: {},
      result: undefined,
    })} />);

    expect(container.querySelector(".tool-disclosure")?.getAttribute("aria-expanded")).toBe("false");
  });
});
