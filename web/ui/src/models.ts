import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { JsonRpcClient } from "@reaper/web-shared";

export type ProviderAuthPrompt =
  | {
      type: "text";
      key: string;
      message: string;
      placeholder?: string;
      secret?: boolean;
      when?: { key: string; op: "eq" | "neq"; value: string };
    }
  | {
      type: "select";
      key: string;
      message: string;
      options: Array<{ label: string; value: string; hint?: string }>;
      when?: { key: string; op: "eq" | "neq"; value: string };
    };

export interface ProviderAuthMethod {
  id: string;
  type: "api" | "oauth";
  label: string;
  prompts?: ProviderAuthPrompt[];
}

export interface CatalogModel {
  id: string;
  name: string;
  description?: string;
  family?: string;
  status: "active" | "alpha" | "beta" | "deprecated";
  contextTokens?: number;
  outputTokens?: number;
  supportsReasoning: boolean;
  reasoningOptions?: { effort?: string[]; budget?: boolean };
  supportsAttachments: boolean;
  supportsToolCalls: boolean;
  /** False when this build has no transport loader for the model. */
  runnable: boolean;
  /** The transport identity the verdict was made against. */
  transportNpm: string;
}

/**
 * Provider summaries only. The catalog holds thousands of models across
 * hundreds of providers, so models load per provider through
 * `provider/models/list` rather than riding along in this payload.
 */
export interface CatalogProvider {
  providerId: string;
  label: string;
  configured: boolean;
  connectionSource?: "stored" | "environment";
  authType?: "api" | "oauth" | "environment";
  authStatus: "disconnected" | "connected" | "expired";
  /** Masked tail only. The stored key/token never returns to the browser. */
  keyHint?: string;
  accountId?: string;
  envVar: string;
  envVars?: string[];
  envKeyPresent: boolean;
  defaultModel: string;
  modelCount: number;
  maxContextTokens?: number;
  supportsReasoning: boolean;
  authMethods: ProviderAuthMethod[];
  /** False when this build cannot serve any of the provider's models. */
  runnable: boolean;
  /** Catalog transport identity, named when `runnable` is false. */
  npm?: string;
}

export interface CatalogStatus {
  source: "snapshot" | "cache" | "network";
  retrievedAt?: string;
  providerCount: number;
  modelCount: number;
  error?: string;
}

export interface ModelPage {
  models: CatalogModel[];
  nextCursor: string | null;
  total: number;
  loading: boolean;
  error?: string;
}

export interface ModelQuery {
  providerId: string;
  query?: string;
}

const EMPTY_PAGE: ModelPage = { models: [], nextCursor: null, total: 0, loading: false };

/**
 * The provider and model a turn falls back to.
 *
 * Both ids, never a credential — the server computes this from the credential
 * store and returns only what a picker needs to render a label.
 */
export interface DefaultSelection {
  provider: string;
  model: string;
}

/**
 * Joins a provider and an optional search term into one map key. The separator
 * is a NUL because no provider id or search term can contain one, so the
 * joined key cannot be ambiguous; it is written as an escape because a literal
 * NUL byte makes the file binary to grep, diff, and most editors.
 */
function pageKey(query: ModelQuery): string {
  return `${query.providerId}\u0000${query.query?.trim().toLowerCase() ?? ""}`;
}

export interface CredentialSummary {
  providerId: string;
  hasKey: boolean;
  authType: "api" | "oauth";
  status: "connected" | "expired";
  keyHint: string;
  baseUrl?: string;
  accountId?: string;
  addedAt: string;
  updatedAt: string;
}

export interface OAuthAttempt {
  attemptId: string;
  providerId: string;
  methodId: string;
  url: string;
  mode: "auto" | "code";
  instructions: string;
  expiresAt: string;
}

export type OAuthStatus =
  | { status: "pending"; attempt: OAuthAttempt }
  | { status: "complete"; provider: CatalogProvider }
  | { status: "failed"; message: string }
  | { status: "expired"; message: string };

export interface ProviderHealth {
  providerId: string;
  status: "ok" | "invalid_credential" | "unreachable" | "unsupported";
  message: string;
  httpStatus?: number;
  checkedAt: string;
  latencyMs?: number;
}

export interface ModelCatalog {
  providers: CatalogProvider[];
  credentials: CredentialSummary[];
  /**
   * What a turn runs on when the thread names no model — the server's own
   * answer, not a client-side guess, so the composer can show the model that
   * will actually be used. `null` when nothing is configured.
   */
  defaultSelection: DefaultSelection | null;
  loading: boolean;
  error: string | undefined;
  status: CatalogStatus | undefined;
  refresh(client: JsonRpcClient | undefined): Promise<void>;
  /** Current page for a provider/query pair; empty until `loadModels` runs. */
  modelPage(query: ModelQuery): ModelPage;
  /** Loads the first page, or appends the next one when `more` is true. */
  loadModels(client: JsonRpcClient | undefined, query: ModelQuery, more?: boolean): Promise<void>;
  connectApi(client: JsonRpcClient, input: {
    providerId: string;
    methodId: string;
    apiKey: string;
    baseUrl?: string;
    inputs?: Record<string, string>;
  }): Promise<ProviderHealth | undefined>;
  /** Re-verify an already-connected provider's stored credential. */
  checkHealth(client: JsonRpcClient, providerId: string): Promise<ProviderHealth>;
  startOAuth(client: JsonRpcClient, input: {
    providerId: string;
    methodId: string;
    inputs?: Record<string, string>;
  }): Promise<OAuthAttempt>;
  completeOAuth(client: JsonRpcClient, input: { attemptId: string; code?: string }): Promise<OAuthStatus>;
  oauthStatus(client: JsonRpcClient, attemptId: string): Promise<OAuthStatus>;
  disconnect(client: JsonRpcClient, providerId: string): Promise<void>;
  /** Compatibility wrapper for existing call sites. */
  saveKey(client: JsonRpcClient, input: { providerId: string; apiKey: string; baseUrl?: string }): Promise<void>;
  removeKey(client: JsonRpcClient, providerId: string): Promise<void>;
}

/**
 * Providers the user has connected.
 *
 * This is the management question, not the sending one: Settings uses it to
 * decide which providers get a row, and a provider this build cannot serve is
 * exactly the one a user needs to see and disconnect. Filtering on `runnable`
 * here would make an unrunnable provider vanish from Settings, leaving the
 * credential stored with nothing on screen to remove it.
 */
export function usableProviders(providers: CatalogProvider[]): CatalogProvider[] {
  return providers.filter((provider) => provider.configured);
}

/**
 * Providers a turn can actually be sent with: connected *and* servable.
 *
 * `configured` alone is not enough. A refreshed catalog can name a transport
 * this build has no package for, and offering it in the composer produces a
 * turn that dies importing a missing module.
 */
export function sendableProviders(providers: CatalogProvider[]): CatalogProvider[] {
  return providers.filter((provider) => provider.configured && provider.runnable !== false);
}

/** Whether a listed model can be sent to at all. */
export function isModelRunnable(model: CatalogModel): boolean {
  return model.runnable !== false;
}

/**
 * Metadata for one selected model, loaded on demand. The composer needs it to
 * decide which reasoning controls a model actually supports; querying by id
 * keeps that to a single bounded page rather than the provider's full list.
 */
export function useModelMetadata(
  catalog: ModelCatalog,
  client: JsonRpcClient | undefined,
  provider: string | null | undefined,
  model: string | null | undefined,
): CatalogModel | undefined {
  const query = useMemo(
    () => (provider && model ? { providerId: provider, query: model } : undefined),
    [provider, model],
  );
  const page = query ? catalog.modelPage(query) : undefined;
  const { loadModels } = catalog;
  useEffect(() => {
    if (query) void loadModels(client, query);
  }, [client, loadModels, query]);
  return page?.models.find((entry) => entry.id === model);
}

/** One provider/model catalog shared by Settings and every thread composer. */
export function useModelCatalog(): ModelCatalog {
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [defaultSelection, setDefaultSelection] = useState<DefaultSelection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<CatalogStatus>();
  const [pages, setPages] = useState<Record<string, ModelPage>>({});
  // Requests are keyed so a slow response for an abandoned search cannot
  // overwrite the page the user is currently looking at.
  const inflight = useRef<Record<string, number>>({});

  const refresh = useCallback(async (client: JsonRpcClient | undefined): Promise<void> => {
    if (!client) return;
    setLoading(true);
    try {
      const [listed, stored, catalogStatus] = await Promise.all([
        client.call<{ providers?: CatalogProvider[]; defaultSelection?: DefaultSelection | null }>("provider/list", {}),
        client.call<{ credentials?: CredentialSummary[] }>("provider/credentials/list", {}),
        client.call<CatalogStatus>("provider/catalog/status", {}).catch(() => undefined),
      ]);
      setProviders(listed.providers ?? []);
      setCredentials(stored.credentials ?? []);
      setDefaultSelection(listed.defaultSelection ?? null);
      if (catalogStatus) setStatus(catalogStatus);
      // Auth changes can change which models a provider advertises, so
      // discard cached pages rather than showing a stale list.
      setPages({});
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load providers");
    } finally {
      setLoading(false);
    }
  }, []);

  const modelPage = useCallback(
    (query: ModelQuery): ModelPage => pages[pageKey(query)] ?? EMPTY_PAGE,
    [pages],
  );

  const loadModels = useCallback(async (
    client: JsonRpcClient | undefined,
    query: ModelQuery,
    more = false,
  ): Promise<void> => {
    if (!client) return;
    const key = pageKey(query);
    const existing = pages[key];
    if (more && (!existing?.nextCursor || existing.loading)) return;
    if (!more && existing && !existing.error) return;

    const token = (inflight.current[key] ?? 0) + 1;
    inflight.current[key] = token;
    setPages((current) => {
      const { error: _dropped, ...rest } = current[key] ?? EMPTY_PAGE;
      return { ...current, [key]: { ...rest, loading: true } };
    });
    try {
      const result = await client.call<{ data?: CatalogModel[]; nextCursor?: string | null; total?: number }>(
        "provider/models/list",
        {
          providerId: query.providerId,
          ...(query.query?.trim() ? { query: query.query.trim() } : {}),
          ...(more && existing?.nextCursor ? { cursor: existing.nextCursor } : {}),
          limit: 50,
        },
      );
      if (inflight.current[key] !== token) return;
      setPages((current) => {
        const previous = more ? current[key]?.models ?? [] : [];
        return {
          ...current,
          [key]: {
            models: [...previous, ...(result.data ?? [])],
            nextCursor: result.nextCursor ?? null,
            total: result.total ?? previous.length + (result.data?.length ?? 0),
            loading: false,
          },
        };
      });
    } catch (cause) {
      if (inflight.current[key] !== token) return;
      setPages((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? EMPTY_PAGE),
          loading: false,
          error: cause instanceof Error ? cause.message : "Could not load models",
        },
      }));
    }
  }, [pages]);

  const connectApi = useCallback(async (
    client: JsonRpcClient,
    input: {
      providerId: string;
      methodId: string;
      apiKey: string;
      baseUrl?: string;
      inputs?: Record<string, string>;
    },
  ): Promise<ProviderHealth | undefined> => {
    const result = await client.call<{ health?: ProviderHealth }>("provider/auth/api/set", input);
    await refresh(client);
    return result.health;
  }, [refresh]);

  const checkHealth = useCallback(async (
    client: JsonRpcClient,
    providerId: string,
  ): Promise<ProviderHealth> => {
    const result = await client.call<{ health: ProviderHealth }>("provider/auth/check", { providerId });
    return result.health;
  }, []);

  const startOAuth = useCallback(async (
    client: JsonRpcClient,
    input: { providerId: string; methodId: string; inputs?: Record<string, string> },
  ): Promise<OAuthAttempt> => {
    const result = await client.call<{ attempt: OAuthAttempt }>("provider/auth/oauth/start", input);
    return result.attempt;
  }, []);

  const completeOAuth = useCallback(async (
    client: JsonRpcClient,
    input: { attemptId: string; code?: string },
  ): Promise<OAuthStatus> => {
    const result = await client.call<OAuthStatus>("provider/auth/oauth/complete", input);
    if (result.status === "complete") await refresh(client);
    return result;
  }, [refresh]);

  const oauthStatus = useCallback(async (
    client: JsonRpcClient,
    attemptId: string,
  ): Promise<OAuthStatus> => {
    const result = await client.call<OAuthStatus>("provider/auth/oauth/status", { attemptId });
    if (result.status === "complete") await refresh(client);
    return result;
  }, [refresh]);

  const disconnect = useCallback(async (
    client: JsonRpcClient,
    providerId: string,
  ): Promise<void> => {
    await client.call("provider/remove", { providerId });
    await refresh(client);
  }, [refresh]);

  const saveKey = useCallback(async (
    client: JsonRpcClient,
    input: { providerId: string; apiKey: string; baseUrl?: string },
  ): Promise<void> => {
    const provider = providers.find((candidate) => candidate.providerId === input.providerId);
    const method = provider?.authMethods.find((candidate) => candidate.type === "api");
    if (!method) throw new Error("This provider does not support API-key authentication");
    await connectApi(client, {
      providerId: input.providerId,
      methodId: method.id,
      apiKey: input.apiKey,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    });
  }, [connectApi, providers]);

  const removeKey = useCallback(async (client: JsonRpcClient, providerId: string): Promise<void> => {
    await disconnect(client, providerId);
  }, [disconnect]);

  return useMemo(
    () => ({
      providers,
      credentials,
      defaultSelection,
      loading,
      error,
      status,
      refresh,
      modelPage,
      loadModels,
      connectApi,
      checkHealth,
      startOAuth,
      completeOAuth,
      oauthStatus,
      disconnect,
      saveKey,
      removeKey,
    }),
    [
      providers,
      credentials,
      defaultSelection,
      loading,
      error,
      status,
      refresh,
      modelPage,
      loadModels,
      connectApi,
      checkHealth,
      startOAuth,
      completeOAuth,
      oauthStatus,
      disconnect,
      saveKey,
      removeKey,
    ],
  );
}
