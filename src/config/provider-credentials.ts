/**
 * User-global provider authentication store.
 *
 * API-key and OAuth records share one provider-keyed store, while callers
 * outside the server can only receive a redacted summary. Reaper keeps the store synchronous
 * because credentials are resolved while a turn's model profile is assembled.
 * Provider-specific OAuth refresh remains an integration hook, not generic file
 * storage behavior.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const ProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const TimestampSchema = z.string().min(1);
const MetadataSchema = z.record(z.string(), z.string());

const StoredApiCredentialSchema = z.object({
  type: z.literal("api"),
  providerId: ProviderIdSchema,
  key: z.string().min(1),
  metadata: MetadataSchema.optional(),
  baseUrl: z.string().url().optional(),
  addedAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const StoredOAuthCredentialSchema = z.object({
  type: z.literal("oauth"),
  providerId: ProviderIdSchema,
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number().int().nonnegative(),
  accountId: z.string().optional(),
  enterpriseUrl: z.string().url().optional(),
  addedAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const StoredCredentialSchema = z.discriminatedUnion("type", [
  StoredApiCredentialSchema,
  StoredOAuthCredentialSchema,
]);

const CredentialFileSchema = z.object({
  version: z.literal(2),
  providers: z.array(StoredCredentialSchema),
});

/** Version 1 stored only API keys. Parse it solely for an in-memory migration. */
const LegacyCredentialFileSchema = z.object({
  version: z.literal(1),
  providers: z.array(z.object({
    providerId: ProviderIdSchema,
    apiKey: z.string().min(1),
    baseUrl: z.string().url().optional(),
    addedAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })),
});

export type StoredCredential = z.infer<typeof StoredCredentialSchema>;
export type StoredApiCredential = z.infer<typeof StoredApiCredentialSchema>;
export type StoredOAuthCredential = z.infer<typeof StoredOAuthCredentialSchema>;

/** What a browser or other untrusted app-server client may know. */
export interface ProviderCredentialSummary {
  providerId: string;
  hasKey: boolean;
  authType: "api" | "oauth";
  status: "connected" | "expired";
  /** Masked key/token tail. Never usable as a credential. */
  keyHint: string;
  baseUrl?: string;
  accountId?: string;
  enterpriseUrl?: string;
  addedAt: string;
  updatedAt: string;
}

export interface ProviderCredentialStoreOptions {
  home?: string;
}

export class ProviderCredentialStore {
  private readonly filePath: string;
  private cache: StoredCredential[] | undefined;

  constructor(options: ProviderCredentialStoreOptions = {}) {
    const home = options.home ?? homedir();
    this.filePath = path.join(home, ".reaper", "providers.json");
  }

  list(): ProviderCredentialSummary[] {
    return this.load().map(toSummary);
  }

  /** Server-only raw auth. Never place this object in an RPC response. */
  authFor(providerId: string): StoredCredential | undefined {
    return this.load().find((entry) => entry.providerId === providerId);
  }

  /** API key or a non-expired OAuth access token for a provider request. */
  secretFor(providerId: string): string | undefined {
    const auth = this.authFor(providerId);
    if (auth?.type === "api") return auth.key;
    return auth && (auth.expires === 0 || auth.expires > Date.now()) ? auth.access : undefined;
  }

  baseUrlFor(providerId: string): string | undefined {
    const auth = this.authFor(providerId);
    return auth?.type === "api" ? auth.baseUrl : auth?.enterpriseUrl;
  }

  /**
   * Non-secret provider settings a transport needs to build its endpoint —
   * region, project, resource name, account id. Deliberately excludes keys and
   * tokens so the result is safe to hand to loader code that shapes options.
   */
  metadataFor(providerId: string): Record<string, string> | undefined {
    const auth = this.authFor(providerId);
    if (!auth) return undefined;
    const metadata: Record<string, string> = auth.type === "api" ? { ...auth.metadata } : {};
    if (auth.type === "oauth" && auth.accountId) metadata.accountId = auth.accountId;
    if (auth.type === "oauth" && auth.enterpriseUrl) metadata.enterpriseUrl = auth.enterpriseUrl;
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  /** Backward-compatible API-key write used by CLI and legacy RPC callers. */
  set(input: {
    providerId: string;
    apiKey: string;
    baseUrl?: string;
    metadata?: Record<string, string>;
  }): ProviderCredentialSummary {
    return this.setApi({
      providerId: input.providerId,
      key: input.apiKey,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  }

  setApi(input: {
    providerId: string;
    key: string;
    baseUrl?: string;
    metadata?: Record<string, string>;
  }): ProviderCredentialSummary {
    const providerId = ProviderIdSchema.parse(input.providerId);
    const key = input.key.trim();
    if (!key) throw new Error("API key must not be empty");
    const baseUrl = input.baseUrl?.trim()
      ? z.string().url().parse(input.baseUrl.trim())
      : undefined;
    const metadata = input.metadata
      ? MetadataSchema.parse(input.metadata)
      : undefined;
    const now = new Date().toISOString();
    const existing = this.authFor(providerId);
    const next: StoredApiCredential = {
      type: "api",
      providerId,
      key,
      ...(metadata ? { metadata } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      addedAt: existing?.addedAt ?? now,
      updatedAt: now,
    };
    this.replace(next);
    return toSummary(next);
  }

  setOAuth(input: {
    providerId: string;
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
    enterpriseUrl?: string;
  }): ProviderCredentialSummary {
    const providerId = ProviderIdSchema.parse(input.providerId);
    const access = input.access.trim();
    const refresh = input.refresh.trim();
    if (!access || !refresh) throw new Error("OAuth access and refresh tokens are required");
    const expires = z.number().int().nonnegative().parse(input.expires);
    const enterpriseUrl = input.enterpriseUrl
      ? z.string().url().parse(input.enterpriseUrl)
      : undefined;
    const now = new Date().toISOString();
    const existing = this.authFor(providerId);
    const next: StoredOAuthCredential = {
      type: "oauth",
      providerId,
      access,
      refresh,
      expires,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(enterpriseUrl ? { enterpriseUrl } : {}),
      addedAt: existing?.addedAt ?? now,
      updatedAt: now,
    };
    this.replace(next);
    return toSummary(next);
  }

  remove(providerId: string): boolean {
    const normalized = ProviderIdSchema.parse(providerId);
    const entries = this.load();
    const remaining = entries.filter((entry) => entry.providerId !== normalized);
    if (remaining.length === entries.length) return false;
    this.save(remaining);
    return true;
  }

  private replace(next: StoredCredential): void {
    const others = this.load().filter((entry) => entry.providerId !== next.providerId);
    this.save([...others, next]);
  }

  private load(): StoredCredential[] {
    if (this.cache) return this.cache;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      const current = CredentialFileSchema.safeParse(raw);
      if (current.success) {
        this.cache = current.data.providers;
        return this.cache;
      }
      const legacy = LegacyCredentialFileSchema.parse(raw);
      this.cache = legacy.providers.map((entry) => ({
        type: "api" as const,
        providerId: entry.providerId,
        key: entry.apiKey,
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
        addedAt: entry.addedAt,
        updatedAt: entry.updatedAt,
      }));
      return this.cache;
    } catch {
      this.cache = [];
      return this.cache;
    }
  }

  private save(entries: StoredCredential[]): void {
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const payload = CredentialFileSchema.parse({ version: 2, providers: entries });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.filePath);
    this.cache = entries;
  }
}

function toSummary(entry: StoredCredential): ProviderCredentialSummary {
  if (entry.type === "api") {
    return {
      providerId: entry.providerId,
      hasKey: true,
      authType: "api",
      status: "connected",
      keyHint: maskSecret(entry.key),
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      addedAt: entry.addedAt,
      updatedAt: entry.updatedAt,
    };
  }
  return {
    providerId: entry.providerId,
    hasKey: true,
    authType: "oauth",
    status: entry.expires === 0 || entry.expires > Date.now() ? "connected" : "expired",
    keyHint: maskSecret(entry.access),
    ...(entry.accountId ? { accountId: entry.accountId } : {}),
    ...(entry.enterpriseUrl ? { enterpriseUrl: entry.enterpriseUrl } : {}),
    addedAt: entry.addedAt,
    updatedAt: entry.updatedAt,
  };
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return "••••";
  return `••••${secret.slice(-4)}`;
}
