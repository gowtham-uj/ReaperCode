import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import type { JsonRpcClient } from "@reaper/web-shared";
import type {
  CatalogProvider,
  ModelCatalog,
  OAuthAttempt,
  ProviderAuthMethod,
  ProviderAuthPrompt,
  ProviderHealth,
} from "./models.js";
import { usableProviders } from "./models.js";
import { PERMISSION_MODES, type PermissionMode, type SettingsStore } from "./settings.js";
import { THEME_DESCRIPTIONS, THEME_LABELS, THEMES } from "./theme.js";
import { useTheme } from "./useTheme.js";

/**
 * Display preferences. Deliberately not stored in `~/.reaper/settings.json`:
 * a stored server-side theme would follow the account onto a machine with a
 * different display, and the choice is about this screen.
 */
export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  return (
    <section className="settings-section" aria-labelledby="appearance-heading">
      <h2 id="appearance-heading">Appearance</h2>
      <p className="settings-note">Saved in this browser, so each device keeps its own choice.</p>
      <fieldset className="theme-options">
        <legend className="sr-only">Theme</legend>
        {THEMES.map((entry) => (
          <label className="theme-option" data-selected={theme === entry || undefined} key={entry}>
            <input
              type="radio"
              name="theme"
              value={entry}
              checked={theme === entry}
              onChange={() => setTheme(entry)}
            />
            <span className="theme-swatch" data-theme={entry} aria-hidden="true">
              <span className="theme-swatch-surface" />
              <span className="theme-swatch-raised" />
              <span className="theme-swatch-accent" />
            </span>
            <span className="theme-option-text">
              <strong>{THEME_LABELS[entry]}</strong>
              <small>{THEME_DESCRIPTIONS[entry]}</small>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

export function SettingsLayout({ settings, client }: { settings: SettingsStore; client: JsonRpcClient | undefined }) {
  useEffect(() => {
    if (!client) return;
    void settings.refreshSettings(client);
    void settings.refreshPolicy(client);
  }, [client, settings.refreshPolicy, settings.refreshSettings]);
  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <div><p className="eyebrow">Reaper</p><h1>Settings</h1><p>User-wide providers, models, permissions, and capabilities. Appearance is saved in this browser instead.</p></div>
        <NavLink className="button" data-variant="outline" to="/">Back to workspace</NavLink>
      </header>
      <div className="settings-page-grid">
        <nav className="settings-nav" aria-label="Settings sections">
          <NavLink to="/settings/providers">Providers</NavLink>
          <NavLink to="/settings/models">Models</NavLink>
          <NavLink to="/settings/permissions">Permissions</NavLink>
          <NavLink to="/settings/policy">Policy</NavLink>
          <NavLink to="/settings/capabilities">Capabilities</NavLink>
          <NavLink to="/settings/appearance">Appearance</NavLink>
        </nav>
        <main className="settings-content">
          {settings.settings?.restartsRequired && <div className="settings-caveat" role="note"><span aria-hidden="true">⟳</span><div><strong>Configuration applies next run.</strong><p>Changes are saved immediately, but restart the app-server before expecting the running agent to use them.</p></div></div>}
          {settings.error && <p className="field-error" role="alert">{settings.error}</p>}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * Provider search over 200+ catalog entries. Each whitespace-separated word
 * must appear somewhere in the label or id, with separators ignored, so
 * "deep infra" finds "Deep Infra" (id `deepinfra`) and "google vertex" finds
 * "Google Vertex AI" regardless of how the vendor spaces its name.
 */
function matchProviders(providers: CatalogProvider[], query: string): CatalogProvider[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return providers;
  return providers.filter((provider) => {
    const haystack = `${provider.label} ${provider.providerId}`.toLowerCase();
    const collapsed = haystack.replace(/[\s._-]/g, "");
    return words.every((word) => {
      const bare = word.replace(/[\s._-]/g, "");
      return haystack.includes(word) || (bare.length > 0 && collapsed.includes(bare));
    });
  });
}

export function ProvidersSettings({ catalog, client }: { catalog: ModelCatalog; client: JsonRpcClient | undefined }) {
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState("");
  const configured = usableProviders(catalog.providers);
  const available = catalog.providers.filter((provider) => !provider.configured);
  const filtered = useMemo(() => matchProviders(available, query), [available, query]);
  // A provider the user already connected is filtered out of this list, so a
  // search for it would otherwise read as "no such provider" rather than
  // "already added".
  const alreadyAdded = useMemo(
    () => (filtered.length === 0 ? matchProviders(configured, query) : []),
    [configured, filtered.length, query],
  );
  const selected = catalog.providers.find((provider) => provider.providerId === selectedId);
  const closeConnect = (): void => {
    setSelectedId(undefined);
    setAdding(false);
    setQuery("");
  };
  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <div><h2>Providers</h2><p>Providers are user-wide. Authentication stays on this machine; API keys and OAuth tokens are never returned to the browser.</p></div>
        <span className="section-count">{configured.length}</span>
      </div>
      {catalog.error && <p className="field-error" role="alert">{catalog.error}</p>}
      {catalog.loading && catalog.providers.length === 0 ? (
        <p className="empty">Loading providers…</p>
      ) : configured.length === 0 ? (
        <div className="settings-empty-state"><strong>No providers configured</strong><p>Add one provider to make its authenticated models available in Settings and the chat composer.</p></div>
      ) : (
        <ul className="provider-list">
          {configured.map((provider) => (
            <ProviderRow
              provider={provider}
              catalog={catalog}
              client={client}
              onReconnect={() => { setAdding(true); setSelectedId(provider.providerId); }}
              key={provider.providerId}
            />
          ))}
        </ul>
      )}
      <div className="settings-add-provider">
        {!adding && <button className="button" data-variant="primary" type="button" onClick={() => setAdding(true)}>Add provider</button>}
        {adding && selected ? (
          <ProviderConnectPanel provider={selected} catalog={catalog} client={client} onBack={() => setSelectedId(undefined)} onComplete={closeConnect} />
        ) : adding ? (
          <div className="provider-picker" aria-label="Add provider">
            <div className="provider-picker-heading"><div><h3>Add provider</h3><p>Choose a deliberately supported integration, then use one of its real authentication methods.</p></div><button className="button" data-variant="ghost" type="button" onClick={closeConnect}>Close</button></div>
            {available.length === 0 ? (
              <p className="settings-note">No providers are supported yet. Integrations will be added and tested one at a time.</p>
            ) : (
              <>
                <label className="provider-search"><span className="sr-only">Search providers</span><input type="search" value={query} placeholder="Search providers" autoFocus onChange={(event) => setQuery(event.currentTarget.value)} /></label>
                {filtered.length === 0 ? (
                  alreadyAdded.length > 0
                    ? <p className="settings-note">{alreadyAdded.map((provider) => provider.label).join(", ")} {alreadyAdded.length === 1 ? "is" : "are"} already connected. Use Replace login above to change {alreadyAdded.length === 1 ? "its" : "their"} credentials.</p>
                    : <p className="settings-note">No providers match “{query}”.</p>
                ) : (
                  <ul className="provider-picker-list">{filtered.map((provider) => <li key={provider.providerId}><button type="button" onClick={() => setSelectedId(provider.providerId)}><span className="provider-mark">{provider.label.slice(0, 1)}</span><span><strong>{provider.label}</strong><small>{provider.modelCount} model{provider.modelCount === 1 ? "" : "s"} · {provider.authMethods.map((method) => method.type === "api" ? "API key" : method.label).join(" or ")}</small></span><span aria-hidden="true">›</span></button></li>)}</ul>
                )}
              </>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Storing a credential only proves it was written, not that the provider
 * accepts it, so every health verdict is rendered next to the provider it
 * belongs to rather than collapsed into a generic success message.
 */
const HEALTH_TONE: Record<ProviderHealth["status"], "ready" | "missing" | "unknown"> = {
  ok: "ready",
  invalid_credential: "missing",
  unreachable: "unknown",
  unsupported: "unknown",
};

const HEALTH_LABEL: Record<ProviderHealth["status"], string> = {
  ok: "Credential verified",
  invalid_credential: "Credential rejected",
  unreachable: "Provider unreachable",
  unsupported: "Cannot be verified",
};

function ProviderHealthNote({ health }: { health: ProviderHealth }) {
  return (
    <p className="provider-health" data-tone={HEALTH_TONE[health.status]} role="status">
      <strong>{HEALTH_LABEL[health.status]}</strong> {health.message}
      {health.status === "ok" && health.latencyMs !== undefined ? ` (${health.latencyMs} ms)` : ""}
    </p>
  );
}

function ProviderRow({ provider, catalog, client, onReconnect }: { provider: CatalogProvider; catalog: ModelCatalog; client: JsonRpcClient | undefined; onReconnect(): void }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [health, setHealth] = useState<ProviderHealth>();
  const remove = async (): Promise<void> => {
    if (!client || provider.connectionSource === "environment") return;
    setBusy(true); setFailure(undefined);
    try { await catalog.disconnect(client, provider.providerId); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : "Could not disconnect the provider"); }
    finally { setBusy(false); }
  };
  const check = async (): Promise<void> => {
    if (!client) return;
    setBusy(true); setFailure(undefined); setHealth(undefined);
    try { setHealth(await catalog.checkHealth(client, provider.providerId)); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : "Could not check this credential"); }
    finally { setBusy(false); }
  };
  const source = provider.connectionSource === "environment"
    ? `Environment · ${provider.envVar}`
    : provider.authType === "oauth"
      ? `OAuth${provider.accountId ? ` · ${provider.accountId}` : ""}`
      : `API key${provider.keyHint ? ` · ${provider.keyHint}` : ""}`;
  return (
    <li className="provider-row">
      <div className="provider-head"><div className="provider-identity"><span className="provider-mark">{provider.label.slice(0, 1)}</span><div><span className="provider-name">{provider.label}</span><span className="provider-state" data-tone={provider.authStatus === "connected" ? "ready" : "missing"}>● {provider.authStatus === "expired" ? "Authentication expired" : source}</span></div></div><div className="provider-actions"><button className="button" data-variant="ghost" disabled={busy} onClick={() => void check()}>{busy ? "Testing…" : "Test connection"}</button><button className="button" data-variant="outline" disabled={busy} onClick={onReconnect}>{provider.authStatus === "expired" ? "Reconnect" : "Replace login"}</button>{provider.connectionSource !== "environment" && <button className="button" data-variant="ghost" disabled={busy} onClick={() => void remove()}>Disconnect</button>}</div></div>
      <p className="provider-models">{provider.modelCount} model{provider.modelCount === 1 ? "" : "s"}{provider.defaultModel ? ` · default ${provider.defaultModel}` : ""}</p>
      {/*
        * Connected but not servable. The credential is fine and the connection
        * genuinely succeeded, so the failure is reported next to the model
        * count rather than as an auth problem — otherwise the user re-enters a
        * working key trying to fix a missing package.
        */}
      {provider.configured && provider.runnable === false && (
        <p className="provider-models" data-tone="missing">
          Connected, but this build has no transport for {provider.npm ? `\`${provider.npm}\`` : "any of its models"}.
          Its models are listed but cannot be selected for a turn.
        </p>
      )}
      {health && <ProviderHealthNote health={health} />}
      {failure && <p className="field-error" role="alert">{failure}</p>}
    </li>
  );
}

function ProviderConnectPanel({ provider, catalog, client, onBack, onComplete }: { provider: CatalogProvider; catalog: ModelCatalog; client: JsonRpcClient | undefined; onBack(): void; onComplete(): void }) {
  const [methodId, setMethodId] = useState<string>();
  const method = provider.authMethods.find((candidate) => candidate.id === methodId);
  useEffect(() => {
    if (provider.authMethods.length === 1) setMethodId(provider.authMethods[0]?.id);
  }, [provider.authMethods]);
  return (
    <div className="provider-connect-panel">
      <div className="provider-picker-heading"><div className="provider-connect-title"><button className="button" data-variant="ghost" type="button" onClick={onBack} aria-label="Back to provider list">←</button><span className="provider-mark">{provider.label.slice(0, 1)}</span><div><h3>Connect {provider.label}</h3><p>Choose how Reaper should authenticate this provider.</p></div></div></div>
      {!method ? (
        <div className="provider-auth-methods">{provider.authMethods.map((candidate) => <button type="button" key={candidate.id} onClick={() => setMethodId(candidate.id)}><strong>{candidate.type === "api" ? "API key" : candidate.label}</strong><span>{candidate.type === "api" ? "Store a write-only key in ~/.reaper/providers.json" : "Authorize in the provider using OAuth or device login"}</span></button>)}</div>
      ) : (
        <ProviderAuthForm provider={provider} method={method} catalog={catalog} client={client} onBack={provider.authMethods.length > 1 ? () => setMethodId(undefined) : onBack} onComplete={onComplete} />
      )}
    </div>
  );
}

function ProviderAuthForm({ provider, method, catalog, client, onBack, onComplete }: { provider: CatalogProvider; method: ProviderAuthMethod; catalog: ModelCatalog; client: JsonRpcClient | undefined; onBack(): void; onComplete(): void }) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState<OAuthAttempt>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [health, setHealth] = useState<ProviderHealth>();
  useEffect(() => {
    if (!client || attempt?.mode !== "auto") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const status = await catalog.oauthStatus(client, attempt.attemptId);
        if (!active) return;
        if (status.status === "complete") { onComplete(); return; }
        if (status.status === "failed" || status.status === "expired") { setFailure(status.message); return; }
        timer = setTimeout(() => void poll(), 1_000);
      } catch (cause) {
        if (active) setFailure(cause instanceof Error ? cause.message : "Could not check authorization status");
      }
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [attempt, catalog, client, onComplete]);
  const setInput = (key: string, value: string): void => setInputs((current) => ({ ...current, [key]: value }));
  const submitApi = async (): Promise<void> => {
    if (!client || !apiKey.trim()) return;
    setBusy(true); setFailure(undefined); setHealth(undefined);
    try {
      const verdict = await catalog.connectApi(client, { providerId: provider.providerId, methodId: method.id, apiKey: apiKey.trim(), ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(Object.keys(inputs).length ? { inputs } : {}) });
      setApiKey("");
      // A rejected key is stored but useless, so keep the form open with the
      // verdict visible instead of reporting a success the provider denied.
      if (verdict && verdict.status === "invalid_credential") { setHealth(verdict); return; }
      onComplete();
    } catch (cause) { setFailure(cause instanceof Error ? cause.message : "Could not connect the provider"); }
    finally { setBusy(false); }
  };
  const startOAuth = async (): Promise<void> => {
    if (!client) return;
    setBusy(true); setFailure(undefined);
    try { setAttempt(await catalog.startOAuth(client, { providerId: provider.providerId, methodId: method.id, ...(Object.keys(inputs).length ? { inputs } : {}) })); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : "Could not start authorization"); }
    finally { setBusy(false); }
  };
  const completeCode = async (): Promise<void> => {
    if (!client || !attempt || !code.trim()) return;
    setBusy(true); setFailure(undefined);
    try {
      const status = await catalog.completeOAuth(client, { attemptId: attempt.attemptId, code: code.trim() });
      if (status.status === "complete") onComplete();
      else if (status.status === "failed" || status.status === "expired") setFailure(status.message);
    } catch (cause) { setFailure(cause instanceof Error ? cause.message : "Could not complete authorization"); }
    finally { setBusy(false); }
  };
  if (attempt) return (
    <div className="provider-auth-flow">
      <p>{attempt.instructions}</p>
      <a className="button" data-variant="primary" href={attempt.url} target="_blank" rel="noreferrer">Open {provider.label}</a>
      {attempt.mode === "code" ? <form onSubmit={(event) => { event.preventDefault(); void completeCode(); }}><label className="field"><span>Authorization code</span><input autoComplete="off" spellCheck={false} value={code} onChange={(event) => setCode(event.currentTarget.value)} /></label><button className="button" data-variant="primary" disabled={!code.trim() || busy}>{busy ? "Verifying…" : "Complete login"}</button></form> : <div className="provider-auth-wait" role="status"><span className="connection-dot" data-status="connecting" /> Waiting for authorization…</div>}
      {failure && <p className="field-error" role="alert">{failure}</p>}
    </div>
  );
  return (
    <form className="provider-form" onSubmit={(event) => { event.preventDefault(); void (method.type === "api" ? submitApi() : startOAuth()); }}>
      <button className="provider-auth-back" type="button" onClick={onBack}>← Change authentication method</button>
      <p className="settings-note">{method.type === "api" ? `Enter an API key for ${provider.label}. Reaper stores it write-only in your user profile.` : `Authorize ${provider.label} using ${method.label}.`}</p>
      <AuthPromptFields prompts={method.prompts} inputs={inputs} setInput={setInput} />
      {method.type === "api" && <><label className="field"><span>API key</span><input type="password" autoComplete="off" spellCheck={false} autoFocus value={apiKey} placeholder={`Key for ${provider.label}`} onChange={(event) => setApiKey(event.currentTarget.value)} /></label><details className="provider-advanced"><summary>Advanced endpoint</summary><label className="field"><span>Base URL <small>optional</small></span><input type="url" autoComplete="off" spellCheck={false} value={baseUrl} placeholder="Proxy or self-hosted endpoint" onChange={(event) => setBaseUrl(event.currentTarget.value)} /></label></details></>}
      <div className="form-actions"><button className="button" data-variant="primary" disabled={busy || (method.type === "api" && !apiKey.trim())}>{busy ? "Connecting…" : method.type === "api" ? "Connect provider" : "Start authorization"}</button><button className="button" data-variant="ghost" type="button" onClick={onBack}>Cancel</button></div>
      {health && <ProviderHealthNote health={health} />}
      {failure && <p className="field-error" role="alert">{failure}</p>}
    </form>
  );
}

function AuthPromptFields({ prompts, inputs, setInput }: { prompts: ProviderAuthPrompt[] | undefined; inputs: Record<string, string>; setInput(key: string, value: string): void }) {
  return <>{(prompts ?? []).filter((prompt) => promptApplies(prompt, inputs)).map((prompt) => prompt.type === "text" ? <label className="field" key={prompt.key}><span>{prompt.message}</span><input type={prompt.secret ? "password" : "text"} value={inputs[prompt.key] ?? ""} placeholder={prompt.placeholder} autoComplete="off" onChange={(event) => setInput(prompt.key, event.currentTarget.value)} /></label> : <label className="field" key={prompt.key}><span>{prompt.message}</span><select value={inputs[prompt.key] ?? ""} onChange={(event) => setInput(prompt.key, event.currentTarget.value)}><option value="" disabled>Choose an option</option>{prompt.options.map((option) => <option value={option.value} key={option.value}>{option.label}{option.hint ? ` — ${option.hint}` : ""}</option>)}</select></label>)}</>;
}

function promptApplies(prompt: ProviderAuthPrompt, inputs: Record<string, string>): boolean {
  if (!prompt.when) return true;
  return prompt.when.op === "eq" ? inputs[prompt.when.key] === prompt.when.value : inputs[prompt.when.key] !== prompt.when.value;
}

export function ModelsSettings({ catalog, client }: { settings: SettingsStore; catalog: ModelCatalog; client: JsonRpcClient | undefined }) {
  const providers = usableProviders(catalog.providers);
  const [query, setQuery] = useState("");
  const modelCount = providers.reduce((count, provider) => count + provider.modelCount, 0);
  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <div><h2>Models</h2><p>Models come directly from providers you have authenticated. They are available to every conversation.</p></div>
        <span className="section-count">{modelCount}</span>
      </div>
      {catalog.status && <p className="settings-note">Catalog: {catalog.status.providerCount} providers · {catalog.status.modelCount} models · {catalog.status.source}{catalog.status.retrievedAt ? ` · ${catalog.status.retrievedAt.slice(0, 10)}` : ""}</p>}
      {providers.length === 0 ? (
        <div className="settings-empty-state"><strong>No models available</strong><p>Add a provider first. Its authenticated models will appear here and in the composer model selector.</p></div>
      ) : (
        <>
          <label className="provider-search"><span className="sr-only">Search models</span><input type="search" value={query} placeholder="Search models" onChange={(event) => setQuery(event.currentTarget.value)} /></label>
          <div className="settings-model-provider-list">
            {providers.map((provider) => (
              <ProviderModelList provider={provider} catalog={catalog} client={client} query={query} key={provider.providerId} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ProviderModelList({ provider, catalog, client, query }: { provider: CatalogProvider; catalog: ModelCatalog; client: JsonRpcClient | undefined; query: string }) {
  const modelQuery = useMemo(() => ({ providerId: provider.providerId, query }), [provider.providerId, query]);
  const page = catalog.modelPage(modelQuery);
  const { loadModels } = catalog;
  useEffect(() => {
    // Debounced so typing a search does not fire one request per keystroke.
    const timer = setTimeout(() => void loadModels(client, modelQuery), query ? 200 : 0);
    return () => clearTimeout(timer);
  }, [client, loadModels, modelQuery, query]);
  return (
    <section className="settings-card">
      <div className="settings-card-heading"><div><h3>{provider.label}</h3><p>{query ? `${page.total} matching` : `${provider.modelCount} available`} model{(query ? page.total : provider.modelCount) === 1 ? "" : "s"}</p></div><span className="provider-state" data-tone="ready">● configured</span></div>
      {page.error && <p className="field-error" role="alert">{page.error}</p>}
      {page.loading && page.models.length === 0 ? <p className="empty">Loading models…</p>
        : page.models.length === 0 ? <p className="settings-note">{query ? `No models match “${query}”.` : "This provider advertises no models."}</p>
        : (
          <ul className="settings-models">
            {page.models.map((model) => (
              <li className="settings-model-row" key={model.id}>
                <div><strong>{model.name}</strong><span>{provider.providerId}/{model.id}</span></div>
                <div className="model-metadata">
                  {/*
                    * Listed here, not offered in the composer. Settings is
                    * where a user comes to find out why, so the row stays
                    * visible and names the missing package; hiding it would
                    * make the count disagree with the catalog for no stated
                    * reason.
                    */}
                  {model.runnable === false && (
                    <span
                      className="status-badge"
                      data-status="failed"
                      title={`This build has no ${model.transportNpm} transport for this model.`}
                    >
                      unavailable
                    </span>
                  )}
                  {model.id === provider.defaultModel && <span className="status-badge" data-status="enabled">provider default</span>}
                  {model.supportsReasoning && <span>reasoning</span>}
                  {model.contextTokens && <span>{Math.round(model.contextTokens / 1000)}k context</span>}
                  {model.supportsAttachments && <span>attachments</span>}
                  {model.status !== "active" && <span>{model.status}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      {page.nextCursor && <button className="button" data-variant="ghost" type="button" disabled={page.loading} onClick={() => void loadModels(client, modelQuery, true)}>{page.loading ? "Loading…" : `Show more (${page.models.length} of ${page.total})`}</button>}
    </section>
  );
}

export function PermissionsSettings({ settings, client }: { settings: SettingsStore; client: JsonRpcClient | undefined }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [applied, setApplied] = useState<string>();
  const saveDefault = async (mode: PermissionMode): Promise<void> => {
    if (!client) return;
    setBusy(true); setFailure(undefined); setApplied(undefined);
    try {
      await settings.saveSettings(client, { permissionMode: mode });
      setApplied(`${mode} now applies to all conversations.`);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Could not save the permission mode");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section">
      <div className="settings-section-heading"><div><h2>Permissions</h2><p>Choose one user-wide approval mode for every conversation. Explicit policy denies still override it.</p></div></div>
      <div className="permission-grid" role="group" aria-label="User permission mode">{PERMISSION_MODES.map((entry) => { const selected = settings.settings?.permissionMode === entry.mode; return <button className="permission-option" data-selected={selected || undefined} aria-pressed={selected} disabled={busy} key={entry.mode} onClick={() => void saveDefault(entry.mode)}><span className="permission-check">{selected ? "✓" : ""}</span><strong>{entry.label}</strong><span>{entry.description}</span></button>; })}</div>
      <p className="settings-note">Changing this updates existing threads and becomes the default for new threads.</p>
      {applied && <p className="settings-note" role="status">{applied}</p>}{failure && <p className="field-error" role="alert">{failure}</p>}
    </section>
  );
}
