import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcClient } from "@reaper/web-shared";

import { ModelPicker } from "./ModelPicker.js";
import type { CatalogModel, CatalogProvider, ModelCatalog, ModelPage } from "./models.js";

afterEach(cleanup);

/*
 * The model a thread starts on, chosen before the thread exists.
 *
 * Measured on the empty new-thread screen: the picker was disabled whenever
 * `threadId` was absent, so the thread's starting model could not be chosen at
 * all. The first message went out on whatever the user's default was, and the
 * only way to change it was to start a conversation and then correct it. The
 * screen where the choice is most natural was the one screen that refused it.
 */

const client = { call: vi.fn(async () => ({})) } as unknown as JsonRpcClient;

function provider(overrides: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    providerId: "fixture",
    label: "Fixture AI",
    configured: true,
    authStatus: "connected",
    envVar: "FIXTURE_API_KEY",
    envKeyPresent: false,
    defaultModel: "fixture-model",
    modelCount: 2,
    supportsReasoning: false,
    authMethods: [{ id: "api-key", type: "api", label: "API key" }],
    runnable: true,
    ...overrides,
  };
}

function model(id: string): CatalogModel {
  return {
    id,
    name: id,
    status: "active",
    supportsReasoning: false,
    supportsAttachments: false,
    supportsToolCalls: true,
    runnable: true,
    transportNpm: "@ai-sdk/openai-compatible",
  };
}

function catalog(): ModelCatalog {
  const models = [model("fixture-one"), model("fixture-two")];
  const page: ModelPage = { models, nextCursor: null, total: models.length, loading: false };
  return {
    providers: [provider()],
    credentials: [],
    defaultSelection: null,
    loading: false,
    error: undefined,
    status: undefined,
    modelPage: () => page,
    loadModels: vi.fn(async () => undefined),
  } as unknown as ModelCatalog;
}

describe("ModelPicker before a thread exists", () => {
  it("is enabled, so the starting model can be chosen", async () => {
    const user = userEvent.setup();
    render(
      <ModelPicker
        catalog={catalog()}
        client={client}
        threadId={undefined}
        provider={undefined}
        model={undefined}
        turnActive={false}
        selected={undefined}
        onSelect={vi.fn()}
        onSetup={vi.fn()}
        onError={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Model:|Choose model/ });
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
    await user.click(trigger);
    expect(screen.getByRole("menu", { name: /Model for this thread/i })).toBeTruthy();
  });

  it("reports the choice to the caller instead of writing to a thread", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ModelPicker
        catalog={catalog()}
        client={client}
        threadId={undefined}
        provider={undefined}
        model={undefined}
        turnActive={false}
        selected={undefined}
        onSelect={onSelect}
        onSetup={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Model:|Choose model/ }));
    const option = screen.getAllByRole("menuitemradio")[0]!;
    await user.click(option);
    await waitFor(() => expect(onSelect).toHaveBeenCalled());
    const choice = onSelect.mock.calls[0]![0] as { provider: string; model: string };
    expect(choice.provider).toBe("fixture");
    expect(choice.model).toMatch(/^fixture-/);
    // And nothing was written to a thread that does not exist.
    expect(client.call).not.toHaveBeenCalled();
  });

  it("shows a pending choice back, so the selection is visible immediately", () => {
    render(
      <ModelPicker
        catalog={catalog()}
        client={client}
        threadId={undefined}
        provider={undefined}
        model={undefined}
        turnActive={false}
        selected={{ provider: "fixture", model: "fixture-two" }}
        onSelect={vi.fn()}
        onSetup={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(screen.getByText("fixture-two")).toBeTruthy();
  });

  it("stays disabled with no thread when the caller cannot hold a choice", async () => {
    /*
     * The old behaviour, kept for a caller that has nowhere to put the choice.
     * Without this the picker would offer a menu whose selection is silently
     * dropped.
     */
    render(
      <ModelPicker
        catalog={catalog()}
        client={client}
        threadId={undefined}
        provider={undefined}
        model={undefined}
        turnActive={false}
        onSetup={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect((screen.getByRole("button", { name: /Model:|Choose model/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
