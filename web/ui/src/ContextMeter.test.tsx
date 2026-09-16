import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ContextMeter } from "./ContextMeter.js";
import type { TokenUsage } from "@reaper/web-shared";

const BASE_PRESSURE: NonNullable<TokenUsage["contextUsage"]> = {
  promptTokens: 6_312,
  contextLimit: 238_000,
  reservedOutputTokens: 32_000,
  percent: 2.7,
  remaining: 231_688,
  estimated: false,
  limitSource: "config",
  model: "zai-org/GLM-5.3-Flash",
};

/**
 * A payload with the pressure reading overridden.
 *
 * `pressure` is taken as a partial and merged, rather than the caller spreading
 * the whole object: spreading built the object per test and made every failure
 * read as a missing property instead of a wrong value.
 */
function usage(options: { pressure?: Partial<NonNullable<TokenUsage["contextUsage"]>>; omitPressure?: boolean } = {}): TokenUsage {
  return {
    total: { inputTokens: 20_000, outputTokens: 1_000, totalTokens: 21_000 },
    last: { inputTokens: 6_300, outputTokens: 12, totalTokens: 6_312 },
    modelContextWindow: 1_048_576,
    contextSoftCap: 238_000,
    ...(options.omitPressure ? {} : { contextUsage: { ...BASE_PRESSURE, ...options.pressure } }),
  };
}

/*
 * Explicit, because `globals` is off in this config so Testing Library's
 * automatic cleanup never registers. Without it, a `rerender` leaves the
 * previous meter in the document and `getByRole("meter")` finds several.
 */
afterEach(cleanup);

describe("ContextMeter", () => {
  it("shows the percentage as the primary reading", () => {
    // The percentage is what a reader is asking for; the counts support it.
    // This ordering is copied from Goose, which leads with the number.
    render(<ContextMeter usage={usage()} />);
    expect(screen.getByText("2.7%")).toBeDefined();
    expect(screen.getByText("6.3K/238.0K")).toBeDefined();
  });

  it("keeps the decimal below ten percent so a slow change is visible", () => {
    /*
     * The report this fixes. Whole-percent rounding showed "2%" for a whole
     * turn while the real value moved 2.13% to 2.48%, and a user watching an
     * accurate meter reported it as not updating.
     */
    const { rerender } = render(<ContextMeter usage={usage({ pressure: { percent: 2.1 } })} />);
    expect(screen.getByText("2.1%")).toBeDefined();
    rerender(<ContextMeter usage={usage({ pressure: { percent: 2.5 } })} />);
    expect(screen.getByText("2.5%")).toBeDefined();
  });

  it("renders a whole number without a trailing decimal", () => {
    render(<ContextMeter usage={usage({ pressure: { percent: 42 } })} />);
    expect(screen.getByText("42%")).toBeDefined();
  });

  it("marks an estimated count with a tilde", () => {
    // A tokenizer estimate and a provider count are different kinds of number,
    // and the difference is visible without opening the tooltip.
    render(<ContextMeter usage={usage({ pressure: { percent: 7.4, estimated: true } })} />);
    expect(screen.getByText("~7.4%")).toBeDefined();
  });

  it("says unknown rather than inventing a percentage when the limit is not known", () => {
    /*
     * The failure mode from the other agent: a missing model limit made the
     * meter read 0%, and a wrong limit made it read far too high. Neither is
     * better than "unknown", which is true and tells the reader not to trust a
     * percentage at all.
     */
    render(<ContextMeter usage={usage({ pressure: { contextLimit: null, percent: null, remaining: null, reservedOutputTokens: 0, limitSource: "unknown" } })} />);
    expect(screen.getByText("6.3K")).toBeDefined();
    // Scoped to the visible label. The tooltip and the aria-label both quote
    // the same numbers, so a document-wide text query matches those instead
    // and would pass or fail for a reason unrelated to what is displayed.
    expect(document.querySelector(".context-meter-label")?.textContent).toBe("6.3K");
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("data-level")).toBe("unknown");
    expect(meter.getAttribute("aria-valuenow")).toBeNull();
  });

  it("escalates the colour with pressure", () => {
    // Goose's bands, which line up with Reaper's own compaction trigger.
    const { rerender } = render(<ContextMeter usage={usage({ pressure: { percent: 20 } })} />);
    expect(screen.getByRole("meter").getAttribute("data-level")).toBe("ok");
    rerender(<ContextMeter usage={usage({ pressure: { percent: 60 } })} />);
    expect(screen.getByRole("meter").getAttribute("data-level")).toBe("warning");
    rerender(<ContextMeter usage={usage({ pressure: { percent: 90 } })} />);
    expect(screen.getByRole("meter").getAttribute("data-level")).toBe("error");
  });

  it("names the reservation and the remaining budget on hover", () => {
    render(<ContextMeter usage={usage()} />);
    const title = screen.getByRole("meter").getAttribute("title") ?? "";
    expect(title).toContain("6,312 / 238,000 tokens");
    expect(title).toContain("32,000 reserved for output");
    expect(title).toContain("231,688 remaining");
    expect(title).toContain("zai-org/GLM-5.3-Flash");
  });

  it("renders nothing without usage", () => {
    const { container } = render(<ContextMeter usage={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("falls back to the raw count when the payload predates contextUsage", () => {
    // An older server payload must not produce a percentage against a guessed
    // denominator.
    render(<ContextMeter usage={usage({ omitPressure: true })} />);
    expect(screen.getByText("6.3K")).toBeDefined();
    expect(screen.getByRole("meter").getAttribute("data-level")).toBe("unknown");
  });
});
