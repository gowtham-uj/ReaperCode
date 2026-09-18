/**
 * A failed turn has to look failed.
 *
 * The engine knows why a run stopped short, the app-server turns that into a
 * `turn.failed` notification, the store folds it onto the turn — and this is
 * where it becomes something a person can read. Every other link in that chain
 * is tested; this one had no test, which is how a turn that produced no reply
 * at all could render as nothing and stay that way.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AppTurn } from "@reaper/web-shared";

import { Transcript } from "./Transcript.js";

afterEach(cleanup);

function turn(overrides: Partial<AppTurn> = {}): AppTurn {
  return { id: "turn-1", status: "failed", items: [], ...overrides };
}

/**
 * Render a turn and expand any collapsed exploration group.
 *
 * A turn made only of read-only tool calls is summarised behind one disclosure
 * ("1 exploration action"), which is the transcript doing its job rather than a
 * rendering problem. The cards still have to be correct when a reader opens it,
 * so the tests open it.
 */
function expandAll(container: HTMLElement): void {
  for (const button of container.querySelectorAll(".exploration-step .disclosure")) {
    fireEvent.click(button);
  }
  /*
   * The step card first, because the tool cards do not exist in the DOM until
   * it is open. A step of nothing but reads is summarised behind its header,
   * which is the transcript doing its job rather than a rendering fault.
   */
  for (const button of container.querySelectorAll(".step-card-head")) {
    if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
  }
  /*
   * And the cards themselves. A successful call is one line until it is opened
   * — that is the reference's behaviour and the reason a fifteen-read turn is
   * fifteen lines rather than a wall — so a test asserting on a card's body has
   * to open it the way a reader would.
   */
  for (const button of container.querySelectorAll<HTMLButtonElement>(".tool-card-head")) {
    if (button.getAttribute("aria-expanded") === "false" && !button.disabled) fireEvent.click(button);
  }
}

function renderExpanded(turns: AppTurn[]): ReturnType<typeof render> {
  const view = render(<Transcript turns={turns} />);
  expandAll(view.container);
  return view;
}

function rerenderExpanded(view: ReturnType<typeof render>, turns: AppTurn[]): void {
  view.rerender(<Transcript turns={turns} />);
  expandAll(view.container);
}

describe("a turn that failed", () => {
  it("shows the reason, as an alert the user can act on", () => {
    render(
      <Transcript
        turns={[
          turn({
            error: {
              message:
                "The model returned 3 empty responses in a row — no text and no tool calls — and the run was stopped. "
                + "This is usually the provider rather than your prompt: send the message again, or switch models.",
            },
          }),
        ]}
      />,
    );

    const alert = screen.getByRole("alert");
    // The whole point of the message is that it explains and suggests. An
    // assertion on "an alert exists" would pass for a bare error code, and a
    // bare error code is the state this test exists to prevent.
    expect(alert.textContent).toContain("empty responses");
    expect(alert.textContent).toMatch(/again|switch models/);
  });

  it("renders nothing extra for a turn that succeeded", () => {
    render(<Transcript turns={[turn({ status: "completed", items: [] })]} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("thinking, while a turn is running", () => {
  /*
   * Reasoning used to render only inside a collapsed disclosure, so a turn that
   * spent a long time thinking showed "Reaper is working…" and nothing else. On
   * the provider this was measured against, the first token takes 45-60
   * seconds, so that static label sat there for a minute looking exactly like a
   * hang — while the thinking text was arriving the entire time.
   */
  function reasoningTurn(status: "inProgress" | "completed"): AppTurn {
    return turn({
      status,
      items: [{ type: "reasoning", id: "r-1", summary: [], content: ["Weighing the options."] }],
    });
  }

  it("shows the thinking while the turn is running", () => {
    const { container } = render(
      <Transcript turns={[reasoningTurn("inProgress")]} activeTurnId="turn-1" />,
    );
    const live = container.querySelector(".reasoning-live");
    expect(live).not.toBeNull();
    expect(live?.textContent).toContain("Weighing the options.");
    // Announced, so a screen reader gets progress rather than silence.
    expect(live?.getAttribute("aria-live")).toBe("polite");
  });

  it("collapses it once the turn is finished", () => {
    /*
     * A finished transcript where every answer is preceded by paragraphs of
     * thinking is harder to read than the answer was hard to wait for.
     *
     * No `activeTurnId`, because that is what "finished" means to this
     * component — App passes the id of the running turn and nothing else. My
     * first version of this test passed the id *and* a completed status, which
     * is a state the app never produces, and the component correctly rendered
     * it live.
     */
    const { container } = render(<Transcript turns={[reasoningTurn("completed")]} />);
    expect(container.querySelector(".reasoning-live")).toBeNull();
    expect(container.querySelector(".reasoning")).not.toBeNull();
  });
});

describe("an agent message is rendered as markdown", () => {
  it("does not show the markup characters", () => {
    render(<Transcript turns={[turn({
      status: "completed",
      items: [{ type: "agentMessage", id: "m-1", text: "## Summary\n\n- one\n- two", phase: "final_answer" }],
    })]} />);
    const message = document.querySelector(".agent-message");
    // The engine is Streamdown now, so the assertions are on the elements it
    // emits: a heading, and a real list with two items.
    expect(message?.querySelector("h2")?.textContent).toBe("Summary");
    expect(message?.querySelectorAll("li")).toHaveLength(2);
    // The literal markup must be gone from what a person reads.
    expect(message?.textContent).not.toContain("##");
    expect(message?.textContent).not.toContain("- one");
  });
});

describe("tool calls are named in words", () => {
  it("shows a human label rather than the registry key", () => {
    render(<Transcript turns={[turn({
      status: "completed",
      items: [{
        type: "dynamicToolCall", id: "t-1", tool: "write_file",
        arguments: { path: "src/app.ts" }, status: "completed",
      }],
    })]} />);
    /*
     * "Write file", not "Write".
     *
     * The label is the tool's own name beautified — `write_file` with the
     * underscore resolved — rather than a synonym. A synonym is prettier and
     * worse: it puts a word on screen that appears nowhere else, so a reader who
     * goes looking for the tool in a list, a config, or the model's transcript
     * finds `write_file` and has to translate.
     */
    const label = document.querySelector(".tool-card-title");
    expect(label?.textContent).toBe("Write file");
    expect(label?.textContent).not.toContain("_");
    // The path is now a sibling on the head row rather than a trailing detail.
    expect(document.querySelector(".tool-card-paths")?.textContent).toBe("src/app.ts");
  });

  it("renders an unknown tool as words too", () => {
    // A tool this build has never heard of — a new one, or an extension's —
    // must still read as a phrase rather than as `some_new_tool`.
    render(<Transcript turns={[turn({
      status: "completed",
      items: [{ type: "dynamicToolCall", id: "t-2", tool: "some_new_tool", arguments: {}, status: "completed" }],
    })]} />);
    expect(document.querySelector(".tool-card-title")?.textContent).toBe("Some new tool");
  });
});

/**
 * Tool cards.
 *
 * The card treatment exists because a flat row gave a reader nothing to scan
 * for. These pin the parts that carry the state: a labelled pill rather than a
 * bare glyph, the call's arguments shown rather than paraphrased, and a failure
 * whose output is already open.
 */
describe("tool cards", () => {
  it("labels the state in words, not only with a glyph", () => {
    /*
     * A row of twenty calls is scanned, not read, and the two things being
     * scanned for are "did anything fail" and "is anything still running". A
     * bare "✓" at the far right answers neither at a glance.
     */
    renderExpanded([turn({
      status: "completed",
      items: [{ type: "dynamicToolCall", id: "c-1", tool: "grep_search", arguments: { pattern: "TODO" }, status: "completed" }],
    })]);
    /*
     * The rail carries the state, and it carries it in words as well as in a
     * mark: `StatusGlyph` writes an `sr-only` sentence beside the glyph, so a
     * screen reader hears "succeeded" rather than a lone tick.
     *
     * A success says nothing further on the row itself. That is deliberate and
     * it is the change from the labelled pill this replaced: twenty rows each
     * ending in the word "Success" is the noise the rail exists to remove, and
     * the only states worth a word on the row are the two a reader scans for.
     */
    const rail = document.querySelector(".tool-rail");
    expect(rail?.getAttribute("data-status")).toBe("completed");
    expect(rail?.textContent).toContain("succeeded");
    expect(document.querySelector(".tool-card-note")).toBeNull();
  });

  it("marks a failure as failed and a running call as running", () => {
    const view = render(<Transcript turns={[turn({
      status: "inProgress",
      items: [{ type: "dynamicToolCall", id: "c-2", tool: "bash", arguments: {}, status: "inProgress" }],
    })]} />);
    expect(document.querySelector(".tool-rail")?.getAttribute("data-status")).toBe("inProgress");
    expect(document.querySelector(".tool-card-note")?.textContent).toBe("Running…");

    rerenderExpanded(view, [turn({
      status: "completed",
      items: [{ type: "dynamicToolCall", id: "c-2", tool: "bash", arguments: {}, status: "failed", error: "boom" }],
    })]);
    expect(document.querySelector(".tool-rail")?.getAttribute("data-status")).toBe("failed");
    expect(document.querySelector(".tool-card-note")?.textContent).toBe("Failed");
  });

  it("collapses a successful call to one line and opens a failed one", () => {
    /*
     * The reference's behaviour, and the reason a turn with fifteen reads in it
     * is fifteen lines rather than fifteen boxes. The asymmetry is the point:
     * a success is a line the reader skims past, and a failure is the thing
     * they opened the transcript for, so it opens itself.
     */
    render(<Transcript turns={[turn({
      status: "completed",
      items: [
        { type: "dynamicToolCall", id: "ok", tool: "file_view", arguments: { path: "a.ts" }, status: "completed", result: "contents" },
        { type: "dynamicToolCall", id: "bad", tool: "bash", arguments: { cmd: "false" }, status: "failed", error: "boom" },
      ],
    })]} />);
    const cards = [...document.querySelectorAll(".tool-card")];
    expect(cards.map((card) => card.getAttribute("data-open"))).toEqual([null, "true"]);
    expect(screen.getByText("boom")).toBeDefined();
  });

  it("shows the call's own arguments rather than a paraphrase", () => {
    /*
     * The argument is what explains a surprising output: a grep that returned
     * nothing is explained by its pattern. The previous card showed a
     * one-line summary, so the reader had to reconstruct the request from the
     * response.
     */
    renderExpanded([turn({
      status: "completed",
      items: [{
        type: "dynamicToolCall", id: "c-3", tool: "grep_search",
        arguments: { pattern: "registerTool", path: "src/extensions", include: "*.ts" },
        status: "completed",
      }],
    })]);
    const keys = [...document.querySelectorAll(".tool-arg-key")].map((node) => node.textContent);
    expect(keys).toEqual(["pattern", "path", "include"]);
    expect(document.querySelector(".tool-arg-scalar")?.textContent).toBe("registerTool");
  });

  it("opens a failure's output without the reader clicking", () => {
    /*
     * The bug this pins: the section mounted while the call was still running,
     * so `useState(defaultOpen)` captured `false` and the error stayed behind a
     * click when the call failed. A failure the reader has to expand is one
     * that gets missed.
     */
    renderExpanded([turn({
      status: "completed",
      items: [{
        type: "dynamicToolCall", id: "c-4", tool: "bash", arguments: { cmd: "cat /nope" },
        status: "failed", error: "No such file or directory",
      }],
    })]);
    // `textContent` is the title as written; the uppercase is CSS only, which
    // is why this compares against "Output" rather than "OUTPUT".
    const sections = [...document.querySelectorAll(".tool-section")];
    const output = sections.find((s) => s.querySelector(".tool-section-title")?.textContent === "Output");
    expect(output?.getAttribute("data-open")).toBe("true");
    expect(screen.getByText("No such file or directory")).toBeDefined();
  });

  it("renders structured output instead of [object Object]", () => {
    // `String(result)` on a record produced that, which made the card body
    // useless for every tool returning structured data.
    renderExpanded([turn({
      status: "completed",
      items: [{
        type: "dynamicToolCall", id: "c-5", tool: "list_directory", arguments: {},
        status: "completed", result: { entries: ["a.ts", "b.ts"], count: 2 },
      }],
    })]);
    const body = document.querySelector(".tool-output")?.textContent ?? "";
    expect(body).toContain("\"count\": 2");
    expect(body).not.toContain("[object Object]");
  });
});

/**
 * The transcript has to survive what a real agent run actually produces, and
 * what it produces is not the tidy fixture: it is a 1,482-line build log, a
 * 900-line diff from a rename, and fifty reads in a row. Each of those has a
 * way of making the page unusable, and each is pinned here.
 */
describe("output a real run actually produces", () => {
  it("holds back a huge log instead of putting every line in the DOM", () => {
    const log = Array.from({ length: 1482 }, (_, index) => `line ${index + 1}`).join("\n");
    renderExpanded([turn({
      status: "completed",
      items: [{
        type: "commandExecution", id: "cmd-1", command: "npm run build",
        status: "completed", exitCode: 0, aggregatedOutput: log,
      }],
    })]);
    const shown = document.querySelector(".tool-output")?.textContent ?? "";
    // The forty tail lines, the echoed prompt line the terminal opens with, and
    // the elision mark standing where the held-back lines were cut out.
    expect(shown.split("\n").length).toBe(42);
    expect(shown.startsWith("> npm run build\n⋯\n")).toBe(true);
    // The tail, not the head: the end of a log is where the failure is.
    expect(shown).toContain("line 1482");
    expect(shown).not.toContain("line 1\n");
    // And it says so, rather than truncating silently.
    expect(screen.getByText("Showing the last 40 of 1,482 lines")).toBeDefined();
  });

  it("gives the whole log when the reader asks for it", () => {
    const log = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");
    renderExpanded([turn({
      status: "completed",
      items: [{
        type: "commandExecution", id: "cmd-2", command: "npm run build",
        status: "completed", exitCode: 0, aggregatedOutput: log,
      }],
    })]);
    fireEvent.click(screen.getByText("Showing the last 40 of 200 lines"));
    expect(document.querySelector(".tool-output")?.textContent).toContain("line 1\n");
  });

  it("previews a large diff rather than rendering all of it", () => {
    const diff = Array.from({ length: 900 }, (_, index) => `+added line ${index + 1}`).join("\n");
    renderExpanded([turn({
      status: "completed",
      items: [{
        type: "fileChange", id: "fc-1", status: "completed",
        changes: [{ path: "src/big.ts", kind: "edit", diff }],
      }],
    })]);
    expect(document.querySelectorAll(".diff-line").length).toBe(14);
    /*
     * The label says "all ... here" rather than "the full diff" because the two
     * are not the same claim. When the server caps a very large change the
     * client holds a preview, and a button promising "the full diff" would
     * offer rows it does not have.
     */
    expect(screen.getByText("View all 900 lines here")).toBeDefined();
  });

  it("says a capped diff is a preview instead of offering what it lacks", () => {
    /*
     * A truncated change arrives with its true counts and a flag, so the card
     * must show the real size while being clear that the rows are a preview.
     * Without this the reader sees a small diff and a large number and has no
     * way to tell which is wrong.
     */
    const diff = "+kept line 1\n+kept line 2";
    renderExpanded([turn({
      status: "completed",
      items: [{
        type: "fileChange", id: "fc-2", status: "completed",
        durationMs: 2_400,
        changes: [{ path: "src/generated/schema.ts", kind: "write_file", diff, additions: 1_448, removals: 0, truncated: true }],
      }],
    })]);
    // The counts come from the server, not from counting the two visible `+`
    // lines, which would under-report the change by three orders of magnitude.
    expect(screen.getByText("+1448")).toBeDefined();
    expect(screen.getByText(/Preview only/)).toBeDefined();
    expect(screen.getByText(/1,448 lines changed in this file/)).toBeDefined();
    // The timing travels with the item too.
    expect(screen.getByText("2.4s")).toBeDefined();
  });

  it("keeps fifty reads to fifty rows", () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      type: "dynamicToolCall" as const, id: `r-${index}`, tool: "file_view",
      arguments: { path: `src/file-${index}.ts` }, status: "completed" as const,
      durationMs: 20, result: "contents",
    }));
    const view = render(<Transcript turns={[turn({ status: "completed", items })]} />);
    /*
     * Folded to its header: fifty rows is a screen and a half of near-identical
     * lines, and "50 actions" in the header is the same information in one.
     */
    expect(view.container.querySelectorAll(".tool-card").length).toBe(0);
    expect(screen.getByText(/50 actions/)).toBeDefined();
    for (const button of view.container.querySelectorAll(".step-card-head")) {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    }
    expect(view.container.querySelectorAll(".tool-card").length).toBe(50);
    // And still one line each once opened: no fifty expanded output blocks.
    expect(view.container.querySelectorAll(".tool-card-body").length).toBe(0);
  });

  it("keeps the live call visible when a long step folds", () => {
    /*
     * The fold must not cost "what is it doing right now". A badge saying "In
     * progress…" over a folded card answers the question with nothing.
     */
    const items = [
      ...Array.from({ length: 30 }, (_, index) => ({
        type: "dynamicToolCall" as const, id: `p-${index}`, tool: "file_view",
        arguments: { path: `src/f-${index}.ts` }, status: "completed" as const, result: "x",
      })),
      {
        type: "dynamicToolCall" as const, id: "p-live", tool: "grep_search",
        arguments: { pattern: "session-store" }, status: "inProgress" as const,
      },
    ];
    const view = render(<Transcript turns={[turn({ id: "t-live", status: "inProgress", items })]} activeTurnId="t-live" />);
    const cards = view.container.querySelectorAll(".tool-card");
    expect(cards.length).toBe(1);
    expect(cards[0]!.getAttribute("data-status")).toBe("inProgress");
    expect(view.container.querySelector(".step-card-body[data-peek]")).toBeTruthy();
  });

  it("names a failure that the tail of a long log scrolled past", () => {
    /*
     * A failing build prints its error and then keeps going, so the last forty
     * lines are the tidy end of a run that went wrong five screens earlier.
     * Showing only the tail reported "transforming (1462)" and said nothing
     * about the error at line 1301.
     */
    const log = Array.from({ length: 400 }, (_, index) =>
      index === 100 ? "ERROR  Cannot find module './session-store'" : `  transforming (${index})`).join("\n");
    renderExpanded([turn({
      status: "completed",
      items: [{
        type: "commandExecution", id: "cmd-3", command: "npm run build",
        status: "failed", exitCode: 1, aggregatedOutput: log,
      }],
    })]);
    expect(screen.getByText("Earlier, at line 101")).toBeDefined();
    expect(document.querySelector(".tool-buried code")?.textContent)
      .toBe("ERROR  Cannot find module './session-store'");
  });

  it("says nothing when the hidden part holds no failure", () => {
    const log = Array.from({ length: 400 }, (_, index) => `  transforming (${index})`).join("\n");
    renderExpanded([turn({
      status: "completed",
      items: [{
        type: "commandExecution", id: "cmd-4", command: "npm run build",
        status: "completed", exitCode: 0, aggregatedOutput: log,
      }],
    })]);
    expect(document.querySelector(".tool-buried")).toBeNull();
  });
});

describe("the raw call", () => {
  it("is present on every tool card but closed", () => {
    renderExpanded([turn({
      status: "completed",
      items: [{
        type: "dynamicToolCall", id: "call_abc", tool: "file_view",
        arguments: { path: "src/auth/session.ts", start: 84 },
        status: "completed", durationMs: 180, result: "contents",
      }],
    })]);
    const raw = document.querySelector<HTMLDetailsElement>(".tool-raw");
    expect(raw).toBeTruthy();
    expect(raw!.open).toBe(false);
    // The tool's real name and the call id, which is what makes a wrong label
    // diagnosable rather than a mystery.
    expect(raw!.textContent).toContain("file_view");
    expect(raw!.textContent).toContain("call_abc");
    expect(raw!.textContent).toContain("\"start\": 84");
  });
});

describe("the step's title", () => {
  it("uses the model's own words when it said what it was doing", () => {
    render(<Transcript turns={[turn({
      status: "completed",
      items: [
        { type: "agentMessage", id: "m-1", phase: "commentary", text: "I'm tracing where auth state gets lost, then I'll fix it." },
        { type: "dynamicToolCall", id: "t-1", tool: "grep_search", arguments: { pattern: "token" }, status: "completed", result: "a.ts:1" },
      ],
    })]} />);
    expect(screen.getByText("Tracing where auth state gets lost")).toBeDefined();
  });

  it("falls back to the tool mix when the model narrated nothing", () => {
    render(<Transcript turns={[turn({
      status: "completed",
      items: [{ type: "dynamicToolCall", id: "t-2", tool: "grep_search", arguments: { pattern: "token" }, status: "completed", result: "a.ts:1" }],
    })]} />);
    expect(screen.getByText("Searching")).toBeDefined();
  });

  it("rejects a paragraph rather than truncating it into the header", () => {
    render(<Transcript turns={[turn({
      status: "completed",
      items: [
        { type: "agentMessage", id: "m-2", phase: "commentary", text: "This codebase resolves authentication through a chain of middleware that begins in the request pipeline and ends somewhere in the session store." },
        { type: "dynamicToolCall", id: "t-3", tool: "grep_search", arguments: { pattern: "token" }, status: "completed", result: "a.ts:1" },
      ],
    })]} />);
    expect(screen.getByText("Searching")).toBeDefined();
  });

  it("names a step for its edit, not for the nine reads that led to it", () => {
    render(<Transcript turns={[turn({
      status: "completed",
      items: [
        { type: "dynamicToolCall", id: "t-4", tool: "file_view", arguments: { path: "a.ts" }, status: "completed", result: "x" },
        { type: "dynamicToolCall", id: "t-5", tool: "file_view", arguments: { path: "b.ts" }, status: "completed", result: "x" },
        { type: "fileChange", id: "t-6", status: "completed", changes: [{ path: "a.ts", kind: "edit" }] },
      ],
    })]} />);
    expect(screen.getByText("Editing files")).toBeDefined();
  });
});
