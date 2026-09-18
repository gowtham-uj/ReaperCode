import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueueModePicker } from "./QueueModePicker.js";

afterEach(cleanup);

/*
 * The bug this file exists for, stated as the behaviour a reader expects.
 *
 * The way to choose "after the agent finishes" used to be a radio group on the
 * queued card, and the card was only reachable after the message was already
 * queued. For the default `next-step` mode the message is steered at the
 * agent's next tool boundary within a round trip, so the card arrived in its
 * delivered state and the radios were disabled: the control existed and could
 * not be used. These assertions are what "the option works now" means.
 */

describe("QueueModePicker", () => {
  it("offers the choice before the message is sent, not after", async () => {
    const user = userEvent.setup();
    const onMode = vi.fn();
    render(<QueueModePicker mode="next-step" running onMode={onMode} />);

    // The trigger is present while the agent runs, which is the whole point:
    // the decision is available at the moment it is made.
    await user.click(screen.getByRole("button", { name: /Delivery:/i }));
    expect(screen.getByRole("menuitemradio", { name: /After the agent finishes/i })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /After the next tool call/i })).toBeTruthy();
  });

  it("reports the chosen mode and closes the menu", async () => {
    const user = userEvent.setup();
    const onMode = vi.fn();
    render(<QueueModePicker mode="next-step" running onMode={onMode} />);

    await user.click(screen.getByRole("button", { name: /Delivery:/i }));
    await user.click(screen.getByRole("menuitemradio", { name: /After the agent finishes/i }));

    expect(onMode).toHaveBeenCalledWith("after-turn");
    // Closed on pick, so the choice does not hover over the composer.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("marks the current mode as checked", async () => {
    const user = userEvent.setup();
    render(<QueueModePicker mode="after-turn" running onMode={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: /Delivery:/i });
    expect(trigger.getAttribute("aria-label")).toMatch(/After the agent finishes/i);
    await user.click(trigger);
    const chosen = screen.getByRole("menuitemradio", { name: /After the agent finishes/i });
    expect(chosen.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /After the next tool call/i }).getAttribute("aria-checked")).toBe("false");
  });

  it("is absent while the agent is idle", () => {
    /*
     * With no running turn a message is simply sent; a control offering to hold
     * it would describe a state that cannot occur. Unmounted, not disabled, so
     * it stays out of the tab order too.
     */
    render(<QueueModePicker mode="next-step" running={false} onMode={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Delivery:/i })).toBeNull();
  });
});
