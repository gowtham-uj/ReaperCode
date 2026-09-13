import { randomUUID } from "node:crypto";

import type {
  ProviderAuthMethod,
  ProviderAuthPrompt,
  ProviderAuthSuccess,
  ProviderIntegration,
  ProviderModelDescriptor,
  ProviderOAuthAuthorization,
} from "./types.js";
import {
  listProviderIntegrations,
  modelsDevCatalog,
  providerIntegrationFor,
} from "./catalog.js";
import type { ModelsDevCatalogService } from "./models-dev-catalog.js";
import { effectiveTransportNpm, isTransportInstalled } from "./transports.js";
import {
  ProviderCredentialStore,
  type StoredCredential,
} from "../../config/provider-credentials.js";
import { checkProviderCredential, type ProviderHealthResult } from "./health-check.js";

export interface PublicProviderAuthMethod {
  id: string;
  type: "api" | "oauth";
  label: string;
  prompts?: ProviderAuthPrompt[];
}

export interface PublicProviderModel {
  id: string;
  name: string;
  description?: string;
  family?: string;
  status: "active" | "alpha" | "beta" | "deprecated";
  releaseDate?: string;
  lastUpdated?: string;
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  supportsReasoning: boolean;
  reasoningOptions?: ProviderModelDescriptor["reasoningOptions"];
  supportsAttachments: boolean;
  supportsToolCalls: boolean;
  supportsTemperature: boolean;
  supportsStructuredOutput: boolean;
  modalities?: ProviderModelDescriptor["modalities"];
  cost?: ProviderModelDescriptor["cost"];
  transport?: { npm?: string; api?: string };
  /**
   * Whether this build has the AI SDK package this model needs.
   *
   * A refreshed catalog can name a transport Reaper has no loader for. Such a
   * model is still listed — hiding it would make the catalog disagree with
   * Models.dev for no stated reason — but the composer refuses to select it and
   * says why, instead of starting a turn that dies importing a missing module.
   */
  runnable: boolean;
  /** The transport identity the verdict above was made against. */
  transportNpm: string;
}

export interface PublicProvider {
  providerId: string;
  label: string;
  configured: boolean;
  connectionSource?: "stored" | "environment";
  authType?: "api" | "oauth" | "environment";
  authStatus: "disconnected" | "connected" | "expired";
  keyHint?: string;
  accountId?: string;
  envVar: string;
  envVars: string[];
  envKeyPresent: boolean;
  defaultModel: string;
  modelCount: number;
  maxContextTokens?: number;
  supportsReasoning: boolean;
  authMethods: PublicProviderAuthMethod[];
  npm?: string;
  api?: string;
  doc?: string;
  /** Whether this build has a transport loader for any of this provider's models. */
  runnable: boolean;
}

/**
 * Whether this build can run a catalog provider/model pair.
 *
 * Read by the preflight so a selection whose transport is missing is refused
 * before the call, with a message naming the package — rather than starting a
 * turn that dies importing a module.
 *
 * A provider the catalog does not contain is *not* refused here. Those are the
 * legacy wire families (direct Anthropic, an explicit OpenAI-compatible
 * endpoint, a local LiteLLM) plus whatever an embedding caller injects, and
 * their resolution belongs to the provider registry, which already rejects
 * anything it cannot route. Answering "unrunnable" for them would turn a
 * working legacy configuration into a hard failure.
 */
export function isSelectionRunnable(
  providerId: string,
  modelId: string,
  source: ModelsDevCatalogService = modelsDevCatalog(),
): {
  runnable: boolean;
  transportNpm: string;
  catalogManaged: boolean;
  reason?: string;
} {
  const integration = providerIntegrationFor(providerId, source);
  if (!integration) {
    return { runnable: true, transportNpm: "", catalogManaged: false };
  }
  const { descriptor } = integration;
  const details = descriptor.modelDetails ?? {};
  const model = details[modelId];
  const transportNpm = effectiveTransportNpm({ providerNpm: descriptor.npm, modelNpm: model?.npm });
  if (isTransportInstalled({ providerNpm: descriptor.npm, modelNpm: model?.npm })) {
    return { runnable: true, transportNpm, catalogManaged: true };
  }
  return {
    runnable: false,
    transportNpm,
    catalogManaged: true,
    reason:
      `Provider '${providerId}' model '${modelId}' needs the '${transportNpm}' transport, `
      + "which is not installed in this build. Pick another model for this provider.",
  };
}

export interface PublicOAuthAttempt {
  attemptId: string;
  providerId: string;
  methodId: string;
  url: string;
  mode: "auto" | "code";
  instructions: string;
  expiresAt: string;
}

export type PublicOAuthStatus =
  | { status: "pending"; attempt: PublicOAuthAttempt }
  | { status: "complete"; provider: PublicProvider }
  | { status: "failed"; message: string }
  | { status: "expired"; message: string };

export interface PublicProviderModelPage {
  data: PublicProviderModel[];
  nextCursor: string | null;
  total: number;
}

interface PendingOAuthAttempt {
  public: PublicOAuthAttempt;
  authorization: ProviderOAuthAuthorization;
  expiresAtMs: number;
}

/**
 * Provider/auth orchestration, split so that provider hooks remain
 * server-only while JSON-RPC receives data-only method descriptors and opaque
 * attempt ids. The registry is injectable so provider
 * integrations can be tested independently while production starts empty.
 */
export class ProviderIntegrationRegistry {
  private readonly integrations: Map<string, ProviderIntegration>;
  private readonly usesCatalog: boolean;
  private readonly attempts = new Map<string, PendingOAuthAttempt>();
  private readonly discovered = new Map<string, ProviderModelDescriptor[]>();
  private readonly refreshes = new Map<string, Promise<ProviderAuthSuccess>>();

  constructor(
    integrations: ProviderIntegration[] | undefined = undefined,
    private readonly credentials = new ProviderCredentialStore(),
    private readonly catalog: ModelsDevCatalogService = modelsDevCatalog(),
  ) {
    this.usesCatalog = integrations === undefined;
    this.integrations = new Map(
      (integrations ?? []).map((integration) => [integration.descriptor.id, integration]),
    );
    if (this.usesCatalog) this.catalog.startBackgroundRefresh();
  }

  list(): PublicProvider[] {
    this.pruneAttempts();
    return this.currentIntegrations()
      .map((integration) => this.toPublicProvider(integration))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  provider(providerId: string): PublicProvider {
    return this.toPublicProvider(this.integration(providerId));
  }

  methods(providerId: string): PublicProviderAuthMethod[] {
    return this.integration(providerId).authMethods.map(toPublicMethod);
  }

  listModels(input: {
    providerId: string;
    query?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
    status?: "active" | "alpha" | "beta" | "deprecated" | undefined;
    reasoning?: boolean | undefined;
    attachments?: boolean | undefined;
    toolCalls?: boolean | undefined;
  }): PublicProviderModelPage {
    const integration = this.integration(input.providerId);
    const descriptor = integration.descriptor;
    const discovered = this.discovered.get(input.providerId);
    const details = discovered ?? Object.values(descriptor.modelDetails ?? {});
    const needle = input.query?.trim().toLocaleLowerCase();
    const models = details
      .filter((model) => {
        const status = model.status ?? "active";
        if (input.status && status !== input.status) return false;
        if (input.reasoning !== undefined && Boolean(model.supportsReasoning) !== input.reasoning) return false;
        if (input.attachments !== undefined && Boolean(model.supportsAttachments) !== input.attachments) return false;
        if (input.toolCalls !== undefined && Boolean(model.supportsToolCalls) !== input.toolCalls) return false;
        if (!needle) return true;
        return `${model.name ?? model.id} ${model.id} ${model.family ?? ""} ${model.description ?? ""}`
          .toLocaleLowerCase()
          .includes(needle);
      })
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
    const offset = paginationOffset(input.cursor);
    const limit = Math.min(200, Math.max(1, input.limit ?? 50));
    const page = models.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      data: page.map((model) => toPublicModel(model, descriptor)),
      nextCursor: next < models.length ? String(next) : null,
      total: models.length,
    };
  }

  catalogStatus(): ReturnType<ModelsDevCatalogService["status"]> {
    return this.catalog.status();
  }

  async refreshCatalog(force = false): Promise<ReturnType<ModelsDevCatalogService["status"]>> {
    return await this.catalog.refresh(force);
  }

  async connectApi(input: {
    providerId: string;
    methodId: string;
    key: string;
    baseUrl?: string;
    inputs?: Record<string, string>;
  }): Promise<PublicProvider> {
    const integration = this.integration(input.providerId);
    const method = this.method(integration, input.methodId);
    if (method.type !== "api") {
      throw new ProviderIntegrationError("invalid_auth_method", "The selected method is not API-key authentication");
    }
    validatePromptInputs(method.prompts, input.inputs);
    const metadata = promptMetadata(method.prompts, input.inputs);
    this.credentials.setApi({
      providerId: input.providerId,
      key: input.key,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
    await this.discover(integration);
    return this.toPublicProvider(integration);
  }

  /**
   * Verify a stored (or environment) credential against the provider itself.
   * Used both right after `connectApi` and from the re-check action on an
   * already-connected provider. Returns only a verdict — never the credential.
   */
  async checkHealth(providerId: string, fetchImpl?: typeof fetch): Promise<ProviderHealthResult> {
    const integration = this.integration(providerId);
    const auth = await this.authForRequest(providerId);
    if (!auth) {
      return {
        providerId,
        status: "invalid_credential",
        message: "No credential is stored for this provider.",
        checkedAt: new Date().toISOString(),
      };
    }
    const baseUrl = this.credentials.baseUrlFor(providerId);
    return await checkProviderCredential({
      descriptor: integration.descriptor,
      auth,
      ...(baseUrl ? { baseUrl } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  async beginOAuth(input: {
    providerId: string;
    methodId: string;
    inputs?: Record<string, string>;
  }): Promise<PublicOAuthAttempt> {
    const integration = this.integration(input.providerId);
    const method = this.method(integration, input.methodId);
    if (method.type !== "oauth") {
      throw new ProviderIntegrationError("invalid_auth_method", "The selected method is not OAuth authentication");
    }
    validatePromptInputs(method.prompts, input.inputs);
    const authorization = await method.authorize(input.inputs);
    const attemptId = randomUUID();
    const expiresAtMs = Date.now() + 10 * 60 * 1_000;
    const record: PendingOAuthAttempt = {
      public: {
        attemptId,
        providerId: input.providerId,
        methodId: input.methodId,
        url: authorization.url,
        mode: authorization.mode,
        instructions: authorization.instructions,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
      authorization,
      expiresAtMs,
    };
    this.attempts.set(attemptId, record);
    return record.public;
  }

  async completeOAuth(input: { attemptId: string; code?: string }): Promise<PublicOAuthStatus> {
    const attempt = this.pending(input.attemptId);
    if (attempt.public.mode === "code" && !input.code?.trim()) {
      throw new ProviderIntegrationError("oauth_code_required", "An authorization code is required");
    }
    return await this.finishAttempt(attempt, input.code?.trim());
  }

  async oauthStatus(attemptId: string): Promise<PublicOAuthStatus> {
    const attempt = this.pending(attemptId, false);
    if (!attempt) return { status: "expired", message: "The authorization attempt expired" };
    if (attempt.public.mode === "code") return { status: "pending", attempt: attempt.public };
    return await this.finishAttempt(attempt);
  }

  remove(providerId: string): { removed: boolean; providers: PublicProvider[] } {
    this.integration(providerId);
    this.discovered.delete(providerId);
    const removed = this.credentials.remove(providerId);
    return { removed, providers: this.list() };
  }

  credentialStore(): ProviderCredentialStore {
    return this.credentials;
  }

  /** Resolve request credentials without exposing them through JSON-RPC. */
  async authForRequest(providerId: string, refreshSkewMs = 120_000): Promise<ProviderAuthSuccess | undefined> {
    const integration = this.integration(providerId);
    const stored = this.credentials.authFor(providerId);
    if (!stored) {
      for (const name of integration.descriptor.envVars ?? [integration.descriptor.envVar]) {
        const key = process.env[name]?.trim();
        if (key) return { type: "api", key };
      }
      return undefined;
    }
    if (stored.type === "api") return toAuthSuccess(stored);
    if (stored.expires === 0 || stored.expires - Date.now() > refreshSkewMs) {
      return toAuthSuccess(stored);
    }
    if (!integration.refreshOAuth) return undefined;
    const active = this.refreshes.get(providerId);
    if (active) return await active;
    const refresh = integration.refreshOAuth(toAuthSuccess(stored) as Extract<ProviderAuthSuccess, { type: "oauth" }>)
      .then((auth) => {
        this.credentials.setOAuth({ providerId, ...auth });
        return auth;
      })
      .finally(() => {
        this.refreshes.delete(providerId);
      });
    this.refreshes.set(providerId, refresh);
    return await refresh;
  }

  private async finishAttempt(
    attempt: PendingOAuthAttempt,
    code?: string,
  ): Promise<PublicOAuthStatus> {
    const result = await attempt.authorization.complete(code);
    if (result.type === "pending") return { status: "pending", attempt: attempt.public };
    if (result.type === "failed") {
      this.attempts.delete(attempt.public.attemptId);
      return { status: "failed", message: result.message };
    }
    const integration = this.integration(attempt.public.providerId);
    this.storeAuth(attempt.public.providerId, result.auth);
    this.attempts.delete(attempt.public.attemptId);
    await this.discover(integration);
    return { status: "complete", provider: this.toPublicProvider(integration) };
  }

  private storeAuth(providerId: string, auth: ProviderAuthSuccess): void {
    if (auth.type === "api") {
      this.credentials.setApi({
        providerId,
        key: auth.key,
        ...(auth.metadata ? { metadata: auth.metadata } : {}),
      });
      return;
    }
    this.credentials.setOAuth({ providerId, ...auth });
  }

  private async discover(integration: ProviderIntegration): Promise<void> {
    if (!integration.discoverModels) return;
    const stored = this.credentials.authFor(integration.descriptor.id);
    if (!stored) return;
    const models = await integration.discoverModels(toAuthSuccess(stored));
    this.discovered.set(integration.descriptor.id, models);
  }

  private currentIntegrations(): ProviderIntegration[] {
    return this.usesCatalog
      ? listProviderIntegrations(this.catalog, false)
      : [...this.integrations.values()];
  }

  private integration(providerId: string): ProviderIntegration {
    const integration = this.usesCatalog
      ? providerIntegrationFor(providerId, this.catalog)
      : this.integrations.get(providerId);
    if (!integration) {
      throw new ProviderIntegrationError("unsupported_provider", `Unsupported provider \"${providerId}\"`);
    }
    return integration;
  }

  private method(integration: ProviderIntegration, methodId: string): ProviderAuthMethod {
    const method = integration.authMethods.find((candidate) => candidate.id === methodId);
    if (!method) {
      throw new ProviderIntegrationError("invalid_auth_method", `Unknown authentication method \"${methodId}\"`);
    }
    return method;
  }

  private pending(attemptId: string, required?: true): PendingOAuthAttempt;
  private pending(attemptId: string, required: false): PendingOAuthAttempt | undefined;
  private pending(attemptId: string, required = true): PendingOAuthAttempt | undefined {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.expiresAtMs <= Date.now()) {
      if (attempt) this.attempts.delete(attemptId);
      if (!required) return undefined;
      throw new ProviderIntegrationError("oauth_attempt_missing", "The authorization attempt is missing or expired");
    }
    return attempt;
  }

  private pruneAttempts(): void {
    const now = Date.now();
    for (const [id, attempt] of this.attempts) {
      if (attempt.expiresAtMs <= now) this.attempts.delete(id);
    }
  }

  /**
   * Whether any of a provider's models can actually run in this build.
   *
   * Model details are optional (`listProviderIntegrations(source, false)` drops
   * them for the CLI startup snapshot), so when they are absent the only honest
   * answer is about the provider-level transport: a provider naming no package
   * still resolves through the OpenAI-compatible fallback.
   */
  private anyModelRunnable(
    integration: ProviderIntegration,
    discovered: ProviderModelDescriptor[] | undefined,
  ): boolean {
    const details = discovered ?? Object.values(integration.descriptor.modelDetails ?? {});
    if (details.length === 0) {
      return isTransportInstalled({ providerNpm: integration.descriptor.npm });
    }
    return details.some((model) =>
      isTransportInstalled({ providerNpm: integration.descriptor.npm, modelNpm: model.npm }));
  }

  private toPublicProvider(integration: ProviderIntegration): PublicProvider {
    const descriptor = integration.descriptor;
    const stored = this.credentials.list().find((item) => item.providerId === descriptor.id);
    const envVars = descriptor.envVars ?? (descriptor.envVar ? [descriptor.envVar] : []);
    const envKeyPresent = envVars.some((name) => Boolean(process.env[name]?.trim()));
    const discovered = this.discovered.get(descriptor.id);
    const modelCount = discovered?.length ?? descriptor.models.length;
    const configured = stored !== undefined || envKeyPresent;
    return {
      providerId: descriptor.id,
      label: descriptor.label,
      configured,
      ...(stored ? { connectionSource: "stored" as const } : envKeyPresent ? { connectionSource: "environment" as const } : {}),
      ...(stored
        ? { authType: stored.authType, keyHint: stored.keyHint }
        : envKeyPresent
          ? { authType: "environment" as const }
          : {}),
      authStatus: stored?.status ?? (envKeyPresent ? "connected" : "disconnected"),
      ...(stored?.accountId ? { accountId: stored.accountId } : {}),
      envVar: descriptor.envVar,
      envVars,
      envKeyPresent,
      defaultModel: descriptor.defaultModel,
      modelCount,
      ...(descriptor.capabilities.maxContextTokens !== undefined
        ? { maxContextTokens: descriptor.capabilities.maxContextTokens }
        : {}),
      supportsReasoning: descriptor.supportsReasoning ?? false,
      authMethods: integration.authMethods.map(toPublicMethod),
      // At least one model must be servable for the provider to be usable at
      // all. A provider whose every model needs an uninstalled transport is
      // connectable but not runnable, and the UI has to be able to tell the
      // difference before the user picks it.
      runnable: this.anyModelRunnable(integration, discovered),
      ...(descriptor.npm ? { npm: descriptor.npm } : {}),
      ...(descriptor.api ? { api: descriptor.api } : {}),
      ...(descriptor.doc ? { doc: descriptor.doc } : {}),
    };
  }
}

export class ProviderIntegrationError extends Error {
  constructor(
    readonly code:
      | "unsupported_provider"
      | "invalid_auth_method"
      | "invalid_auth_input"
      | "oauth_code_required"
      | "oauth_attempt_missing",
    message: string,
  ) {
    super(message);
    this.name = "ProviderIntegrationError";
  }
}

function toPublicMethod(method: ProviderAuthMethod): PublicProviderAuthMethod {
  return {
    id: method.id,
    type: method.type,
    label: method.label,
    ...(method.prompts ? { prompts: method.prompts } : {}),
  };
}

function toPublicModel(
  model: ProviderModelDescriptor,
  descriptor: ProviderIntegration["descriptor"],
): PublicProviderModel {
  const contextTokens = model.contextTokens ?? descriptor.capabilities.maxContextTokens;
  const outputTokens = model.outputTokens ?? descriptor.capabilities.maxOutputTokens;
  const transportNpm = effectiveTransportNpm({ providerNpm: descriptor.npm, modelNpm: model.npm });
  return {
    runnable: isTransportInstalled({ providerNpm: descriptor.npm, modelNpm: model.npm }),
    transportNpm,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description ? { description: model.description } : {}),
    ...(model.family ? { family: model.family } : {}),
    status: model.status ?? "active",
    ...(model.releaseDate ? { releaseDate: model.releaseDate } : {}),
    ...(model.lastUpdated ? { lastUpdated: model.lastUpdated } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(model.inputTokens !== undefined ? { inputTokens: model.inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    supportsReasoning: model.supportsReasoning ?? descriptor.supportsReasoning ?? false,
    ...(model.reasoningOptions ? { reasoningOptions: model.reasoningOptions } : {}),
    supportsAttachments: model.supportsAttachments ?? false,
    supportsToolCalls: model.supportsToolCalls ?? descriptor.capabilities.toolCalling,
    supportsTemperature: model.supportsTemperature ?? true,
    supportsStructuredOutput: model.supportsStructuredOutput ?? descriptor.capabilities.structuredOutput,
    ...(model.modalities ? { modalities: model.modalities } : {}),
    ...(model.cost ? { cost: model.cost } : {}),
    ...(model.npm || model.api
      ? { transport: { ...(model.npm ? { npm: model.npm } : {}), ...(model.api ? { api: model.api } : {}) } }
      : {}),
  };
}

function validatePromptInputs(
  prompts: ProviderAuthPrompt[] | undefined,
  inputs: Record<string, string> | undefined,
): void {
  for (const prompt of prompts ?? []) {
    if (!promptApplies(prompt, inputs ?? {})) continue;
    const value = inputs?.[prompt.key]?.trim();
    if (!value) {
      if (prompt.type === "text" && prompt.optional) continue;
      throw new ProviderIntegrationError("invalid_auth_input", `${prompt.message} is required`);
    }
    if (prompt.type === "select" && !prompt.options.some((option) => option.value === value)) {
      throw new ProviderIntegrationError("invalid_auth_input", `Invalid value for ${prompt.message}`);
    }
  }
}

function promptMetadata(
  prompts: ProviderAuthPrompt[] | undefined,
  inputs: Record<string, string> | undefined,
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const prompt of prompts ?? []) {
    if ((prompt.type === "text" && prompt.secret) || !promptApplies(prompt, inputs ?? {})) continue;
    const value = inputs?.[prompt.key]?.trim();
    if (value) metadata[prompt.key] = value;
  }
  return metadata;
}

function promptApplies(prompt: ProviderAuthPrompt, inputs: Record<string, string>): boolean {
  if (!prompt.when) return true;
  const current = inputs[prompt.when.key];
  return prompt.when.op === "eq" ? current === prompt.when.value : current !== prompt.when.value;
}

function paginationOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ProviderIntegrationError("invalid_auth_input", "Invalid pagination cursor");
  }
  return offset;
}

function toAuthSuccess(auth: StoredCredential): ProviderAuthSuccess {
  if (auth.type === "api") {
    return {
      type: "api",
      key: auth.key,
      ...(auth.metadata ? { metadata: auth.metadata } : {}),
    };
  }
  return {
    type: "oauth",
    access: auth.access,
    refresh: auth.refresh,
    expires: auth.expires,
    ...(auth.accountId ? { accountId: auth.accountId } : {}),
    ...(auth.enterpriseUrl ? { enterpriseUrl: auth.enterpriseUrl } : {}),
  };
}
