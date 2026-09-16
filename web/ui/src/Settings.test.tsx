import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import type { JsonRpcClient } from "@reaper/web-shared";

import type { CatalogProvider, ModelCatalog, ModelPage } from "./models.js";
import {
  AppearanceSettings,
  ModelsSettings,
  PermissionsSettings,
  ProvidersSettings,
  SettingsLayout,
} from "./Settings.js";
import type { SettingsStore } from "./settings.js";

afterEach(cleanup);

const client = {} as JsonRpcClient;

function settingsStore(): SettingsStore {
  return {
    settings: {
      fileExists: true,
      permissionMode: "auto",
      modelRouting: { primary: "coding" },
      models: [{ role: "coding", provider: "deepseek", model: "deepseek-chat", thinking: "enabled" }],
      pinnedSkills: [],
      disabledSkills: [],
      disabledProviders: [],
      restartsRequired: false,
    },
    skills: [],
    skillErrors: [],
    extensions: [],
    extensionErrors: [],
    policyRules: [],
    policyFileExists: false,
    loading: false,
    error: undefined,
    refreshSettings: vi.fn(async () => undefined),
    saveSettings: vi.fn(async () => undefined),
    refreshSkills: vi.fn(async () => undefined),
    refreshExtensions: vi.fn(async () => undefined),
    refreshPolicy: vi.fn(async () => undefined),
    savePolicy: vi.fn(async () => undefined),
  };
}

function catalog(providers: CatalogProvider[] = [], modelPages: Record<string, ModelPage> = {}): ModelCatalog {
  return {
    providers,
    credentials: [],
    defaultSelection: null,
    loading: false,
    error: undefined,
    status: { source: "snapshot", providerCount: providers.length, modelCount: 1 },
    modelPage: (query) => modelPages[query.providerId] ?? { models: [], nextCursor: null, total: 0, loading: false },
    loadModels: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    connectApi: vi.fn(async () => undefined),
    checkHealth: vi.fn(async () => ({
      providerId: "fixture",
      status: "ok" as const,
      message: "Provider accepted the credential.",
      checkedAt: "2026-01-01T00:00:00.000Z",
      latencyMs: 42,
    })),
    startOAuth: vi.fn(async () => { throw new Error("not configured"); }),
    completeOAuth: vi.fn(async () => ({ status: "failed" as const, message: "not configured" })),
    oauthStatus: vi.fn(async () => ({ status: "failed" as const, message: "not configured" })),
    disconnect: vi.fn(async () => undefined),
    saveKey: vi.fn(async () => undefined),
    removeKey: vi.fn(async () => undefined),
  };
}

const fixtureProvider: CatalogProvider = {
  providerId: "fixture",
  label: "Fixture AI",
  configured: false,
  authStatus: "disconnected",
  envVar: "FIXTURE_API_KEY",
  envKeyPresent: false,
  defaultModel: "fixture-model",
  modelCount: 1,
  maxContextTokens: 16_000,
  supportsReasoning: false,
  authMethods: [{ id: "api-key", type: "api", label: "API key" }],
  runnable: true,
};

function SettingsRouter({ initial = "/settings" }: { initial?: string }) {
  const settings = settingsStore();
  const models = catalog();
  return (
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/" element={<div>Workspace</div>} />
        <Route path="/settings" element={<SettingsLayout settings={settings} client={client} />}>
          <Route index element={<Navigate to="providers" replace />} />
          <Route path="providers" element={<ProvidersSettings catalog={models} settings={settings} client={client} />} />
          <Route path="models" element={<ModelsSettings settings={settings} catalog={models} client={client} />} />
          <Route path="permissions" element={<PermissionsSettings settings={settings} client={client} />} />
          <Route path="policy" element={<div>Command policy</div>} />
          <Route path="capabilities" element={<div>Capabilities inventory</div>} />
          {/* Mirrors App.tsx; the route table is duplicated here, so a new
              settings page has to be added in both places. */}
          <Route path="appearance" element={<AppearanceSettings />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("routed Settings", () => {
  it("redirects /settings to Providers and offers every supported section", async () => {
    render(<SettingsRouter />);
    expect(await screen.findByRole("heading", { name: "Providers" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Providers" }).getAttribute("aria-current")).toBe("page");
    for (const label of ["Models", "Permissions", "Policy", "Capabilities", "Appearance"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
    expect(screen.queryByText("Memory")).toBeNull();
  });

  it("switches theme from Appearance and offers no light theme", async () => {
    const user = userEvent.setup();
    render(<SettingsRouter initial="/settings/appearance" />);

    // Only dark-family themes ship. A "Light" radio appearing here is the
    // regression this asserts against, so check the option set, not just that
    // the chosen one works.
    const options = (await screen.findAllByRole("radio")).map((el) => el.getAttribute("value"));
    expect(options.sort()).toEqual(["black", "dark", "reaper"]);

    // The stored-preference-free default is Reaper, not the vendored sheet's
    // blue `dark`. Asserted here as well as in theme.test.ts because this is
    // the screen where a wrong default is actually visible.
    expect(screen.getByRole("radio", { name: /^Reaper/ }).hasAttribute("checked")).toBe(true);
    await user.click(screen.getByRole("radio", { name: /^Black/ }));
    expect(document.body.hasAttribute("data-ds-black-theme")).toBe(true);
    // Black layers on the dark sheet; without this the alias tokens fall back
    // to their light values and the black surfaces get white text tokens.
    expect(document.body.hasAttribute("data-ds-dark-theme")).toBe(true);

    await user.click(screen.getByRole("radio", { name: /^Reaper/ }));
    expect(document.body.hasAttribute("data-ds-reaper-theme")).toBe(true);
    expect(document.body.hasAttribute("data-ds-dark-theme")).toBe(true);
    // Both accent ramps override the same neutral tokens, so picking one has to
    // clear the other or the winner is whatever the stylesheet order says.
    expect(document.body.hasAttribute("data-ds-black-theme")).toBe(false);
  });

  it("navigates between real pages without unmounting the Settings layout", async () => {
    const user = userEvent.setup();
    render(<SettingsRouter initial="/settings/providers" />);
    expect(await screen.findByText("No providers configured")).toBeTruthy();

    await user.click(screen.getByRole("link", { name: "Models" }));
    expect(await screen.findByRole("heading", { name: "Models" })).toBeTruthy();
    expect(screen.getByText("No models available")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();

    await user.click(screen.getByRole("link", { name: "Permissions" }));
    expect(await screen.findByRole("heading", { name: "Permissions" })).toBeTruthy();
  });

  it("searches supported providers and submits a write-only API key flow", async () => {
    const user = userEvent.setup();
    const models = catalog([fixtureProvider]);
    render(<ProvidersSettings catalog={models} settings={settingsStore()} client={client} />);

    await user.click(screen.getByRole("button", { name: "Add provider" }));
    const search = screen.getByRole("searchbox", { name: "Search providers" });
    await user.type(search, "fixture");
    await user.click(screen.getByRole("button", { name: /Fixture AI/ }));

    const key = await screen.findByLabelText("API key");
    await user.type(key, "secret-never-render-again");
    await user.click(screen.getByRole("button", { name: "Connect provider" }));

    expect(models.connectApi).toHaveBeenCalledWith(client, {
      providerId: "fixture",
      methodId: "api-key",
      apiKey: "secret-never-render-again",
    });
  });

  it("keeps the key form open and reports the verdict when the provider rejects the key", async () => {
    const user = userEvent.setup();
    const models = catalog([fixtureProvider]);
    models.connectApi = vi.fn(async () => ({
      providerId: "fixture",
      status: "invalid_credential" as const,
      message: "Fixture AI rejected the credential (HTTP 401).",
      httpStatus: 401,
      checkedAt: "2026-01-01T00:00:00.000Z",
    }));
    render(<ProvidersSettings catalog={models} settings={settingsStore()} client={client} />);

    await user.click(screen.getByRole("button", { name: "Add provider" }));
    await user.type(screen.getByRole("searchbox", { name: "Search providers" }), "fixture");
    await user.click(screen.getByRole("button", { name: /Fixture AI/ }));
    await user.type(await screen.findByLabelText("API key"), "wrong-key");
    await user.click(screen.getByRole("button", { name: "Connect provider" }));

    expect(await screen.findByText("Credential rejected")).toBeTruthy();
    expect(screen.getByText(/rejected the credential \(HTTP 401\)/)).toBeTruthy();
    // Still on the form, so the user can correct the key without re-navigating.
    expect(screen.getByLabelText("API key")).toBeTruthy();
  });

  it("re-checks a connected provider's stored credential on demand", async () => {
    const user = userEvent.setup();
    const models = catalog([{ ...fixtureProvider, configured: true, authStatus: "connected", authType: "api", connectionSource: "stored", keyHint: "…9f2c" }]);
    render(<ProvidersSettings catalog={models} settings={settingsStore()} client={client} />);

    await user.click(screen.getByRole("button", { name: "Test connection" }));

    expect(models.checkHealth).toHaveBeenCalledWith(client, "fixture");
    expect(await screen.findByText("Credential verified")).toBeTruthy();
  });

  it("says a connected provider has no transport instead of looking broken", async () => {
    /*
     * The credential is fine and the connection genuinely succeeded, so
     * reporting this as an auth problem would send the user back to re-enter a
     * working key. The message names the missing package and sits by the model
     * count, next to what it applies to.
     */
    const models = catalog([{
      ...fixtureProvider,
      configured: true,
      authStatus: "connected",
      authType: "api",
      connectionSource: "stored",
      keyHint: "…9f2c",
      runnable: false,
      npm: "@ai-sdk/invented-by-a-future-refresh",
    }]);
    render(<ProvidersSettings catalog={models} settings={settingsStore()} client={client} />);

    expect(await screen.findByText(/no transport for `@ai-sdk\/invented-by-a-future-refresh`/)).toBeTruthy();
    // Still manageable — unrunnable is not unmanaged.
    expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
  });

  /*
   * Disable replaces Disconnect.
   *
   * Disconnect called `provider/remove`, which deletes the stored credential:
   * the wrong verb for "hide this from the picker for now", and a one-click way
   * to lose a key the user would then have to re-enter. Disable keeps the key
   * and only withholds the provider from the model picker. These tests assert
   * the button is present on every configured provider (environment-configured
   * ones included, since disabling is Reaper's own preference, not a change to
   * a credential it does not own) and that clicking it writes the disabled
   * list rather than removing anything.
   */
  it("offers Disable on a configured provider and writes disabledProviders on click", async () => {
    const user = userEvent.setup();
    const store = settingsStore();
    const models = catalog([{
      ...fixtureProvider,
      configured: true,
      authStatus: "connected",
      authType: "api",
      connectionSource: "stored",
      keyHint: "…9f2c",
      envKeyPresent: false,
    }]);
    render(<ProvidersSettings catalog={models} settings={store} client={client} />);

    const disable = await screen.findByRole("button", { name: "Disable" });
    await user.click(disable);
    expect(store.saveSettings).toHaveBeenCalledWith(client, { disabledProviders: ["fixture"] });
    // Nothing removed the credential: disabling is not disconnecting.
    expect(models.disconnect).not.toHaveBeenCalled();
    expect(models.removeKey).not.toHaveBeenCalled();
  });

  it("shows Enable for a disabled provider and toggles it back off the disabled list", async () => {
    const user = userEvent.setup();
    const store = settingsStore();
    if (store.settings) store.settings.disabledProviders = ["fixture"];
    const models = catalog([{
      ...fixtureProvider,
      configured: true,
      authStatus: "connected",
      authType: "api",
      connectionSource: "stored",
      keyHint: "…9f2c",
      envKeyPresent: false,
    }]);
    render(<ProvidersSettings catalog={models} settings={store} client={client} />);

    expect(await screen.findByText(/hidden from the model picker/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Enable" }));
    expect(store.saveSettings).toHaveBeenCalledWith(client, { disabledProviders: [] });
  });

  it("explains an environment-configured provider instead of offering to remove it", async () => {
    /*
     * `provider/remove` deletes a *stored* credential, and a provider configured
     * by `DEEPSEEK_API_KEY` has none. A button wired to it would get
     * `{ removed: false }` and appear to work while changing nothing. Disabling
     * is different — it is Reaper's own preference about what to offer, not an
     * edit to a credential it does not own — so the row keeps the Disable
     * control and adds a note naming the variable, which is the thing the user
     * would actually change to disconnect for real.
     */
    const models = catalog([{
      ...fixtureProvider,
      configured: true,
      authStatus: "connected",
      authType: "environment",
      connectionSource: "environment",
      envKeyPresent: true,
    }]);
    render(<ProvidersSettings catalog={models} settings={settingsStore()} client={client} />);

    expect(await screen.findByText(/Configured by FIXTURE_API_KEY/)).toBeTruthy();
    expect(screen.getByText(/Unset it in the environment to/)).toBeTruthy();
    // The two controls that do work here are offered, and so is Disable.
    expect(screen.getByRole("button", { name: "Test connection" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace login" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
  });

  it("does not explain the environment when the credential is stored", async () => {
    const models = catalog([{
      ...fixtureProvider,
      configured: true,
      authStatus: "connected",
      authType: "api",
      connectionSource: "stored",
      keyHint: "…9f2c",
      envKeyPresent: false,
    }]);
    render(<ProvidersSettings catalog={models} settings={settingsStore()} client={client} />);

    expect(await screen.findByRole("button", { name: "Disable" })).toBeTruthy();
    expect(screen.queryByText(/Configured by/)).toBeNull();
  });
});
