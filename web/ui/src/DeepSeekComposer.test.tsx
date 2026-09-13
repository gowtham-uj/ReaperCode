import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcClient } from "@reaper/web-shared";

import { DeepSeekComposer } from "./DeepSeekComposer.js";
import { EffortPicker, effortOptions } from "./EffortPicker.js";
import type { CatalogModel } from "./models.js";

function model(overrides: Partial<CatalogModel>): CatalogModel {
  return {
    id: "m",
    name: "M",
    status: "active",
    supportsReasoning: false,
    supportsAttachments: false,
    supportsToolCalls: true,
    runnable: true,
    transportNpm: "@ai-sdk/openai-compatible",
    ...overrides,
  };
}

afterEach(cleanup);

describe("DeepSeek-derived composer behavior", () => {
  it("uses the primary action as Stop for an empty running turn", async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    const submit = vi.fn();
    render(<DeepSeekComposer value="" placeholder="Send a message" running disabled={false} onChange={() => undefined} onSubmit={submit} onStop={stop} />);

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("queues a non-empty draft during a running turn and exposes no fake controls", async () => {
    const user = userEvent.setup();
    const submit = vi.fn();
    render(<DeepSeekComposer value="continue with tests" placeholder="Add a message" running disabled={false} onChange={() => undefined} onSubmit={submit} onStop={() => undefined} modelControl={<button>Model</button>} />);

    await user.click(screen.getByRole("button", { name: "Queue message" }));
    expect(submit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /commands/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /permission/i })).toBeNull();
    expect(screen.queryByText("Preview")).toBeNull();
  });
});

describe("reasoning effort", () => {
  it("offers only the effort levels the model's catalog metadata advertises", () => {
    expect(effortOptions(model({ supportsReasoning: true, reasoningOptions: { effort: ["low", "medium", "high"] } })))
      .toEqual(["low", "medium", "high"]);
    // Reasoning without a selectable effort (a fixed-budget thinking model)
    // must not render a control that the wire request would reject.
    expect(effortOptions(model({ supportsReasoning: true, reasoningOptions: { budget: true } }))).toEqual([]);
    expect(effortOptions(model({ supportsReasoning: false }))).toEqual([]);
    expect(effortOptions(undefined)).toEqual([]);
  });

  it("does not render a cosmetic effort control for unsupported models", () => {
    render(<EffortPicker client={undefined} threadId="thread-1" metadata={model({ supportsReasoning: false })} effort="high" turnActive={false} onError={() => undefined} />);
    expect(screen.queryByRole("button", { name: /effort/i })).toBeNull();
  });

  it("persists supported effort and states when it applies to the next turn", async () => {
    const user = userEvent.setup();
    const call = vi.fn(async () => ({ appliesTo: "nextTurn" }));
    const client = { call } as unknown as JsonRpcClient;
    const metadata = model({ id: "gpt-5", supportsReasoning: true, reasoningOptions: { effort: ["low", "medium", "high"] } });
    render(<EffortPicker client={client} threadId="thread-1" metadata={metadata} effort="medium" turnActive onError={() => undefined} />);

    await user.click(screen.getByRole("button", { name: /Effort medium/i }));
    await user.click(screen.getByRole("menuitemradio", { name: /High/ }));

    expect(call).toHaveBeenCalledWith("thread/effort/set", {
      threadId: "thread-1",
      reasoningEffort: "high",
    });
    expect(await screen.findByText("Effort applies next turn")).toBeTruthy();
  });
});
