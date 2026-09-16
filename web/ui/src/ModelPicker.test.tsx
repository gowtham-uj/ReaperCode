import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcClient } from "@reaper/web-shared";

import { ModelPicker } from "./ModelPicker.js";
import type { CatalogModel, CatalogProvider, ModelCatalog, ModelPage } from "./models.js";

afterEach(cleanup);

const client = {
  call: vi.fn(async () => ({})),
} as unknown as JsonRpcClient;

function provider(overrides: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    providerId: "fixture",
    label: "Fixture AI",
    configured: true,
    authStatus: "connected",
    envVar: "FIXTURE_API_KEY",
    envKeyPresent: false,
    defaultModel: "fixture-model",
    modelCount: 1,
    supportsReasoning: false,
    authMethods: [{ id: "api-key", type: "api", label: "API key" }],
    runnable: true,
    ...overrides,
  };
}

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: "fixture-model",
    name: "Fixture Model",
    status: "active",
    supportsReasoning: false,
    supportsAttachments: false,
    supportsToolCalls: true,
    runnable: true,
    transportNpm: "@ai-sdk/openai-compatible",
    ...overrides,
  };
}

function catalog(
  providers: CatalogProvider[],
  models: CatalogModel[],
  defaultSelection: ModelCatalog["defaultSelection"] = null,
): ModelCatalog {
  const page: ModelPage = { models, nextCursor: null, total: models.length, loading: false };
  return {
    providers,
    credentials: [],
    defaultSelection,
    loading: false,
    error: undefined,
    status: undefined,
    modelPage: () => page,
    loadModels: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    connectApi: vi.fn(async () => undefined),
    checkHealth: vi.fn(async () => { throw new Error("not used"); }),
    startOAuth: vi.fn(async () => { throw new Error("not used"); }),
    completeOAuth: vi.fn(async () => ({ status: "failed" as const, message: "not used" })),
    oauthStatus: vi.fn(async () => ({ status: "failed" as const, message: "not used" })),
    disconnect: vi.fn(async () => undefined),
    saveKey: vi.fn(async () => undefined),
    removeKey: vi.fn(async () => undefined),
  };
}

function renderPicker(models: ModelCatalog, disabledProviders?: readonly string[]): void {
  render(
    <ModelPicker
      catalog={models}
      client={client}
      threadId="thread-1"
      provider={undefined}
      model={undefined}
      turnActive={false}
      disabledProviders={disabledProviders}
      onSetup={() => undefined}
      onError={() => undefined}
    />,
  );
}

describe("composer model picker and unavailable transports", () => {
  it("disables a model this build has no transport for, and says which", async () => {
    /*
     * Listing it but allowing the click produces a turn that starts and then
     * dies importing a missing module — a failure the user cannot connect to
     * anything they chose. A disabled row with the reason in `title` is the
     * honest version, and `title` is also what a screen reader announces for a
     * disabled control.
     */
    const user = userEvent.setup();
    const catalogWith = catalog(
      [provider()],
      [model({ id: "working" }), model({ id: "future-model", runnable: false, transportNpm: "@ai-sdk/not-installed" })],
    );
    renderPicker(catalogWith);

    await user.click(screen.getByRole("button", { name: /Choose model/ }));

    const working = await screen.findByRole("menuitemradio", { name: /working/ });
    const missing = screen.getByRole("menuitemradio", { name: /future-model/ });
    expect(working.hasAttribute("disabled")).toBe(false);
    expect(missing.hasAttribute("disabled")).toBe(true);
    expect(missing.getAttribute("title")).toBe("Not available in this build: no @ai-sdk/not-installed transport");
    expect(missing.getAttribute("data-runnable")).toBe("false");
  });

  it("does not offer a provider that cannot serve any model", async () => {
    // `configured` is not enough: the credential is fine, the transport is
    // not. Offering the provider would present an empty or disabled list with
    // no explanation of why nothing there works.
    const user = userEvent.setup();
    const catalogWith = catalog(
      [provider({ providerId: "working", label: "Working AI" }), provider({ providerId: "broken", label: "Broken AI", runnable: false })],
      [model()],
    );
    renderPicker(catalogWith);

    await user.click(screen.getByRole("button", { name: /Choose model/ }));

    expect(await screen.findByRole("group", { name: "Working AI" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Broken AI" })).toBeNull();
  });

  it("falls back to the setup action when no provider can serve a turn", async () => {
    // The trigger has to stay actionable. With only unrunnable providers the
    // old label would be "Choose model" over an empty menu.
    const user = userEvent.setup();
    const onSetup = vi.fn();
    const catalogWith = catalog([provider({ runnable: false })], [model()]);
    render(
      <ModelPicker
        catalog={catalogWith}
        client={client}
        threadId="thread-1"
        provider={undefined}
        model={undefined}
        turnActive={false}
        onSetup={onSetup}
        onError={() => undefined}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Add provider/ });
    await user.click(trigger);
    expect(onSetup).toHaveBeenCalled();
  });

  it("shows the model a turn will actually use when the thread names none", async () => {
    /*
     * The turn path falls back to the user's configured provider, so a thread
     * that was never pinned still runs on a real model. Showing "Choose model"
     * there tells the user nothing is selected while a turn quietly succeeds —
     * the UI describing a state the system is not in. The server computes the
     * same fallback it will use for the turn and sends it, so this is the real
     * model rather than a client-side guess.
     */
    const catalogWith = catalog(
      [provider()],
      [model({ id: "zai-org/GLM-5.3-Flash" })],
      { provider: "deepinfra", model: "zai-org/GLM-5.3-Flash" },
    );
    renderPicker(catalogWith);

    expect(screen.getByRole("button", { name: /zai-org\/GLM-5.3-Flash/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Choose model/ })).toBeNull();
  });

  it("prefers the thread's own model over the fallback", async () => {
    // The two must not be confused in either direction: a pinned thread keeps
    // its choice even while a different default is available.
    const catalogWith = catalog(
      [provider()],
      [model({ id: "pinned-model" }), model({ id: "zai-org/GLM-5.3-Flash" })],
      { provider: "deepinfra", model: "zai-org/GLM-5.3-Flash" },
    );
    render(
      <ModelPicker
        catalog={catalogWith}
        client={client}
        threadId="thread-1"
        provider="fixture"
        model="pinned-model"
        turnActive={false}
        onSetup={() => undefined}
        onError={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: /pinned-model/ })).toBeTruthy();
  });

  /*
   * A provider switched off in Settings must not be offered here.
   *
   * The whole point of Disable (as opposed to the Disconnect it replaced) is
   * that the provider keeps its credential but stops appearing as a choice. If
   * the picker still offered it, the switch would be invisible where it is
   * supposed to act, and the user would keep picking a provider they believed
   * they had turned off.
   */
  it("withholds a disabled provider from the picker", async () => {
    const user = userEvent.setup();
    const catalogWith = catalog(
      [provider({ providerId: "fixture" }), provider({ providerId: "other", label: "Other AI" })],
      [model({ id: "fixture-model" })],
    );
    renderPicker(catalogWith, ["fixture"]);

    await user.click(screen.getByRole("button", { name: /Choose model/ }));
    expect(screen.queryByRole("group", { name: "Fixture AI" })).toBeNull();
    expect(screen.getByRole("group", { name: "Other AI" })).toBeTruthy();
  });
});
