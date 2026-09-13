/**
 * A failed turn has to look failed.
 *
 * The engine knows why a run stopped short, the app-server turns that into a
 * `turn.failed` notification, the store folds it onto the turn — and this is
 * where it becomes something a person can read. Every other link in that chain
 * is tested; this one had no test, which is how a turn that produced no reply
 * at all could render as nothing and stay that way.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AppTurn } from "@reaper/web-shared";

import { Transcript } from "./Transcript.js";

afterEach(cleanup);

function turn(overrides: Partial<AppTurn> = {}): AppTurn {
  return { id: "turn-1", status: "failed", items: [], ...overrides };
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
    expect(message?.querySelector(".md-heading")?.textContent).toBe("Summary");
    expect(message?.querySelectorAll(".md-list li")).toHaveLength(2);
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
    const label = document.querySelector(".tool-label");
    expect(label?.textContent).toBe("Write file");
    expect(label?.textContent).not.toContain("_");
    expect(document.querySelector(".tool-detail")?.textContent).toBe("src/app.ts");
  });

  it("renders an unknown tool as words too", () => {
    // A tool this build has never heard of — a new one, or an extension's —
    // must still read as a phrase rather than as `some_new_tool`.
    render(<Transcript turns={[turn({
      status: "completed",
      items: [{ type: "dynamicToolCall", id: "t-2", tool: "some_new_tool", arguments: {}, status: "completed" }],
    })]} />);
    expect(document.querySelector(".tool-label")?.textContent).toBe("Some new tool");
  });
});
