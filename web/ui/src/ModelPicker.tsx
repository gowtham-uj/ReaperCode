import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { JsonRpcClient } from "@reaper/web-shared";
import { CheckIcon, ChevronIcon } from "./icons.jsx";
import {
  isModelRunnable,
  sendableProviders,
  type CatalogModel,
  type CatalogProvider,
  type ModelCatalog,
} from "./models.js";

/* A NUL byte no model id or provider id can contain, so the joined key is
 * unambiguous. Written as an escape rather than a literal byte: a raw NUL
 * makes the file binary to grep, diff, and most editors. */
const SEPARATOR = "\u0000";

export function ModelPicker({ catalog, client, threadId, provider, model, turnActive, disabledProviders, selected, onSelect, onSetup, onError }: {
  catalog: ModelCatalog;
  client: JsonRpcClient | undefined;
  threadId: string | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  turnActive: boolean;
  /**
   * Providers the user switched off in Settings. Passed in rather than folded
   * into the catalog because it is user settings, not catalog data, and the
   * picker must not offer a provider the turn would refuse. `undefined` when
   * settings have not loaded yet, which reads as "nothing disabled".
   */
  disabledProviders?: readonly string[] | undefined;
  /**
   * The model a not-yet-created thread will start on.
   *
   * With no thread there is nothing to write to yet, so the choice is held by
   * the caller and applied when the thread is created. Without this the picker
   * was simply disabled before the first message, which read as "you cannot
   * choose the model" on the one screen where the thread's starting model is
   * most naturally decided.
   */
  selected?: { provider: string; model: string } | undefined;
  /** Called instead of the RPC when there is no thread to write the choice to. */
  onSelect?(choice: { provider: string; model: string }): void;
  onSetup(): void;
  onError(message: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [deferred, setDeferred] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const available = useMemo(
    () => sendableProviders(catalog.providers, disabledProviders ?? []),
    [catalog.providers, disabledProviders],
  );
  /*
   * What this picker is currently set to, from either source.
   *
   * A real thread reads its own provider and model. Before there is a thread the
   * caller's pending choice stands in for them, so a selection made on the empty
   * screen is shown back immediately rather than appearing to do nothing until
   * the first message is sent.
   */
  const effectiveProvider = threadId ? provider : selected?.provider ?? provider;
  const effectiveModel = threadId ? model : selected?.model ?? model;
  const current = effectiveProvider && effectiveModel ? `${effectiveProvider}${SEPARATOR}${effectiveModel}` : "";
  /*
   * A thread with no model is not a thread with no model.
   *
   * The turn path falls back to the user's configured provider, so a thread
   * that has never been pinned still runs on a real model — and the picker
   * saying "Choose model" while a turn quietly succeeds on DeepInfra tells the
   * user nothing is selected when something is. The server computes the same
   * fallback it will use for the turn and sends it along, so this shows the
   * model that will actually answer rather than a client-side guess.
   */
  const fallback = !current ? catalog.defaultSelection : null;
  const currentLabel = effectiveModel
    ?? fallback?.model
    ?? (available.length === 0 ? "Add provider" : "Choose model");

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const change = async (value: string): Promise<void> => {
    if (!value) return;
    const [nextProvider, nextModel] = value.split(SEPARATOR);
    if (!nextProvider || !nextModel) return;
    /*
     * Before the thread exists there is nothing to write the choice to, so the
     * caller keeps it and applies it at creation. Checked before the client so a
     * disconnected empty screen can still be configured, which is exactly when a
     * user is setting up a first conversation.
     */
    if (!threadId) {
      onSelect?.({ provider: nextProvider, model: nextModel });
      setOpen(false);
      return;
    }
    if (!client) return;
    setBusy(true);
    try {
      const result = await client.call<{ appliesTo?: string }>("thread/model/set", { threadId, provider: nextProvider, model: nextModel });
      setDeferred(result.appliesTo === "nextTurn" ? nextModel : undefined);
      setOpen(false);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not change the model");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        className="model-trigger"
        type="button"
        /*
         * Enabled with no thread when the caller can hold the choice. It used to
         * be disabled whenever `threadId` was absent, which is precisely the
         * empty new-thread screen, so the starting model could not be chosen at
         * all until after a message had already been sent on a default.
         */
        disabled={busy || (available.length > 0 && !threadId && onSelect === undefined)}
        aria-haspopup={available.length > 0 ? "menu" : undefined}
        aria-expanded={available.length > 0 ? open : undefined}
        aria-controls={open ? id : undefined}
        title={available.length === 0 ? "Set up a model provider" : `Model: ${currentLabel}`}
        onClick={() => {
          if (available.length === 0) onSetup();
          else setOpen((value) => !value);
        }}
      >
        <span className="model-trigger-label">{currentLabel}</span>
        <span className="model-trigger-chevron" data-open={open || undefined}><ChevronIcon /></span>
      </button>
      {open && (
        <div className="model-menu" id={id} role="menu" aria-label="Model for this thread">
          {catalog.error && <div className="menu-error">{catalog.error}</div>}
          <label className="model-search"><span className="sr-only">Search models</span><input type="search" value={query} placeholder="Search models" autoFocus onChange={(event) => setQuery(event.currentTarget.value)} /></label>
          {available.map((entry) => (
            <ProviderModelGroup
              provider={entry}
              catalog={catalog}
              client={client}
              query={query}
              current={current}
              busy={busy}
              onChoose={(value) => void change(value)}
              key={entry.providerId}
            />
          ))}
        </div>
      )}
      {deferred && turnActive && <span className="model-note" role="status">{deferred} applies next turn</span>}
    </div>
  );
}

function ProviderModelGroup({ provider, catalog, client, query, current, busy, onChoose }: {
  provider: CatalogProvider;
  catalog: ModelCatalog;
  client: JsonRpcClient | undefined;
  query: string;
  current: string;
  busy: boolean;
  onChoose(value: string): void;
}) {
  const modelQuery = useMemo(() => ({ providerId: provider.providerId, query }), [provider.providerId, query]);
  const page = catalog.modelPage(modelQuery);
  const { loadModels } = catalog;
  useEffect(() => {
    const timer = setTimeout(() => void loadModels(client, modelQuery), query ? 200 : 0);
    return () => clearTimeout(timer);
  }, [client, loadModels, modelQuery, query]);

  // The selected model may sit outside the current page. Keep it visible so
  // searching never makes the active choice look unset.
  const selectedId = current.startsWith(`${provider.providerId}${SEPARATOR}`)
    ? current.slice(provider.providerId.length + SEPARATOR.length)
    : undefined;
  /*
   * The synthesised row is runnable and claims no capabilities.
   *
   * It stands for whatever the user already has selected, and it is replaced
   * by the real entry as soon as the provider's page for that name loads.
   * Deriving "unrunnable" from a missing field would disable the user's own
   * current choice, which is the one row this exists to keep visible; the
   * capability flags are only read by the composer's effort control, which
   * gets them from the real metadata.
   */
  const rows: CatalogModel[] = selectedId && !page.models.some((model) => model.id === selectedId)
    ? [{
        id: selectedId,
        name: selectedId,
        status: "active",
        supportsReasoning: false,
        supportsAttachments: false,
        supportsToolCalls: false,
        runnable: true,
        transportNpm: "",
      }, ...page.models]
    : page.models;

  if (!page.loading && rows.length === 0) return null;
  return (
    <section className="model-group" role="group" aria-label={provider.label}>
      <div className="model-group-title">{provider.label}</div>
      {page.error && <div className="menu-error">{page.error}</div>}
      {page.loading && rows.length === 0 && <div className="menu-status">Loading models…</div>}
      {rows.map((model) => {
        const value = `${provider.providerId}${SEPARATOR}${model.id}`;
        const selected = value === current;
        const runnable = isModelRunnable(model);
        return (
          <button
            className="model-option"
            data-selected={selected || undefined}
            data-runnable={runnable ? undefined : "false"}
            role="menuitemradio"
            aria-checked={selected}
            disabled={busy || !runnable}
            key={model.id}
            /*
             * A disabled row with no explanation reads as a broken picker, so
             * the reason travels in `title` — which is also what a screen
             * reader announces for a disabled control.
             */
            title={runnable ? undefined : `Not available in this build: no ${model.transportNpm} transport`}
            onClick={() => onChoose(value)}
          >
            <span>{model.id}</span>
            <span className="model-check">
              {!runnable ? <span className="model-unavailable">unavailable</span> : selected && <CheckIcon />}
            </span>
          </button>
        );
      })}
      {page.nextCursor && (
        <button className="model-option" type="button" disabled={page.loading} onClick={() => void loadModels(client, modelQuery, true)}>
          <span>{page.loading ? "Loading…" : `Show more (${page.models.length} of ${page.total})`}</span>
        </button>
      )}
    </section>
  );
}
