import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ContextView } from "./ContextView.js";
import type { AppThreadItem } from "@reaper/web-shared";

afterEach(cleanup);

/**
 * Context management in the transcript.
 *
 * These tests are about a row that must inform without intruding. Reaper
 * compacts on its own schedule, several times an hour in a long session, so the
 * row has to answer "what happened and how much did it cost me" at a glance and
 * stay collapsed otherwise. The failure mode being guarded against is the one
 * this replaced: a single unstyled "Compacted context" line that named no
 * technique and carried no numbers, so a session that rewrote its whole history
 * with a model call looked exactly like one that dropped a stale file read.
 */

type ContextItem = Extract<AppThreadItem, { type: "contextManagement" }>;

function item(overrides: Partial<ContextItem> = {}): ContextItem {
  return {
    type: "contextManagement",
    id: "ctx-1",
    technique: "tool_output_prune",
    status: "completed",
    savedChars: 1_038_794,
    ...overrides,
  };
}

describe("ContextView", () => {
  it("names the technique rather than saying 'compacted'", () => {
    render(<ContextView item={item({ technique: "shake" })} />);
    // The mechanism, in words a reader can act on. "Compacted context" was the
    // old label and told a user nothing about what had been dropped.
    expect(screen.getByText("Shook out stale results")).toBeTruthy();
  });

  it("shows the saving exactly once", () => {
    render(<ContextView item={item({ savedChars: 1_038_794, detail: "52 aged tool outputs truncated" })} />);
    // The badge carries the figure; the detail line describes what happened.
    // Both were printing it, in different units, which is the duplication this
    // pins against.
    expect(screen.getByText("−1.0MB")).toBeTruthy();
    expect(screen.queryByText(/saved 1\.0MB/)).toBeNull();
    expect(screen.getByText("52 aged tool outputs truncated")).toBeTruthy();
  });

  it("omits the saving entirely when nothing was reclaimed", () => {
    render(<ContextView item={item({ savedChars: 0 })} />);
    // A "−0" badge is worse than no badge: it implies work that did not happen.
    expect(screen.queryByText(/^−/)).toBeNull();
  });

  it("marks a running technique as live with an elapsed clock", () => {
    render(<ContextView item={item({ status: "inProgress", startedAt: Date.now() })} />);
    const row = screen.getByText("Trimmed stale output").closest(".context-row")!;
    expect(row.getAttribute("data-status")).toBe("inProgress");
    // Full summarization is a model call that takes seconds; a row that cannot
    // say "still running" is indistinguishable from one that hung.
    expect(within(row as HTMLElement).getByText(/s$|running/)).toBeTruthy();
  });

  it("marks a failed technique, and says why", () => {
    render(<ContextView item={item({ status: "failed", error: "summary was larger than the conversation it replaced" })} />);
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText("summary was larger than the conversation it replaced")).toBeTruthy();
  });

  it("stays collapsed until asked, so a compacting session is not a wall of text", () => {
    render(<ContextView item={item({ technique: "full_summary", messagesBefore: 40, messagesAfter: 6 })} />);
    expect(screen.queryByText("Messages")).toBeNull();
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
  });

  it("reveals the numbers behind a disclosure when opened", async () => {
    const user = userEvent.setup();
    render(
      <ContextView
        item={item({
          technique: "full_summary",
          messagesBefore: 40,
          messagesAfter: 6,
          savedTokens: 182_000,
          usedTokens: 254_000,
          softCap: 270_000,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("40 → 6")).toBeTruthy();
    expect(screen.getByText("182,000")).toBeTruthy();
    expect(screen.getByText("254,000")).toBeTruthy();
    expect(screen.getByText("270,000")).toBeTruthy();
  });

  it("offers no disclosure for the routine passes", () => {
    // Pruning aged output has nothing to inspect; a "Details" button that opens
    // an empty panel teaches a reader to stop clicking them.
    render(<ContextView item={item({ technique: "tool_output_prune" })} />);
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });

  it("renders an unknown technique as words rather than a raw key", () => {
    // A technique added to the runtime before the web app knows about it must
    // still read as English rather than `some_new_thing`.
    render(<ContextView item={item({ technique: "some_new_thing" as ContextItem["technique"] })} />);
    expect(screen.getByText("Some new thing")).toBeTruthy();
  });
});
