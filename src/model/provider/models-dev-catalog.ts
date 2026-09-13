import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bundledModelsDevCatalog } from "../../util/bundled-assets.js";
import {
  ModelsDevCatalogSchema,
  type ModelsDevCatalog,
  type ModelsDevModel,
  type ModelsDevProvider,
} from "./models-dev-types.js";
export { MODELS_DEV_SNAPSHOT_METADATA } from "./models-dev-snapshot.js";

export const MODELS_DEV_SOURCE = "https://models.opencode.ai";

const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const FRESH_MS = 5 * 60 * 1_000;
const REFRESH_MS = 60 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_ATTEMPTS = 3;

export interface ModelsDevCatalogStatus {
  source: "snapshot" | "cache" | "network";
  sourceUrl: string;
  providerCount: number;
  modelCount: number;
  loadedAt: string;
  lastRefreshAt?: string;
  refreshError?: string;
}

export interface ModelsDevModelQuery {
  providerId: string;
  query?: string;
  cursor?: string;
  limit?: number;
  status?: "active" | "alpha" | "beta" | "deprecated";
  reasoning?: boolean;
  attachments?: boolean;
  toolCalls?: boolean;
}

export interface ModelsDevModelPage {
  data: ModelsDevModel[];
  nextCursor: string | null;
  total: number;
}

export interface ModelsDevCatalogOptions {
  home?: string;
  sourceUrl?: string;
  snapshotPath?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class ModelsDevCatalogService {
  private readonly cachePath: string;
  private readonly sourceUrl: string;
  private readonly snapshotPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private data: ModelsDevCatalog;
  private state: ModelsDevCatalogStatus;
  private refreshPromise: Promise<ModelsDevCatalogStatus> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ModelsDevCatalogOptions = {}) {
    const home = options.home ?? homedir();
    this.cachePath = path.join(home, ".cache", "reaper", "models.json");
    this.sourceUrl = (options.sourceUrl ?? MODELS_DEV_SOURCE).replace(/\/+$/, "");
    this.snapshotPath = options.snapshotPath
      ?? fileURLToPath(new URL("./models-dev.json", import.meta.url));
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;

    const snapshot = this.loadSnapshot();
    this.data = snapshot;
    this.state = this.makeStatus("snapshot");
    this.loadCache();
  }

  catalog(): ModelsDevCatalog {
    return this.data;
  }

  providers(): ModelsDevProvider[] {
    return Object.values(this.data).sort((a, b) => a.name.localeCompare(b.name));
  }

  provider(providerId: string): ModelsDevProvider | undefined {
    return this.data[providerId];
  }

  model(providerId: string, modelId: string): ModelsDevModel | undefined {
    return this.provider(providerId)?.models[modelId];
  }

  status(): ModelsDevCatalogStatus {
    return { ...this.state };
  }

  listModels(query: ModelsDevModelQuery): ModelsDevModelPage {
    const provider = this.provider(query.providerId);
    if (!provider) throw new Error(`Unsupported provider "${query.providerId}"`);
    const needle = query.query?.trim().toLocaleLowerCase();
    const models = Object.values(provider.models)
      .filter((model) => {
        const status = model.status ?? "active";
        if (query.status && status !== query.status) return false;
        if (query.reasoning !== undefined && model.reasoning !== query.reasoning) return false;
        if (query.attachments !== undefined && model.attachment !== query.attachments) return false;
        if (query.toolCalls !== undefined && model.tool_call !== query.toolCalls) return false;
        if (!needle) return true;
        return `${model.name} ${model.id} ${model.family ?? ""} ${model.description ?? ""}`
          .toLocaleLowerCase()
          .includes(needle);
      })
      .sort(compareModels);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = parseCursor(query.cursor);
    const data = models.slice(offset, offset + limit);
    const next = offset + data.length;
    return {
      data,
      nextCursor: next < models.length ? String(next) : null,
      total: models.length,
    };
  }

  defaultModel(providerId: string): ModelsDevModel | undefined {
    const provider = this.provider(providerId);
    return provider ? Object.values(provider.models).sort(compareModels)[0] : undefined;
  }

  async refresh(force = false): Promise<ModelsDevCatalogStatus> {
    if (this.refreshPromise) return await this.refreshPromise;
    this.refreshPromise = this.refreshInner(force).finally(() => {
      this.refreshPromise = undefined;
    });
    return await this.refreshPromise;
  }

  startBackgroundRefresh(): void {
    if (this.refreshTimer) return;
    void this.refresh(false).catch(() => undefined);
    this.refreshTimer = setInterval(() => {
      void this.refresh(false).catch(() => undefined);
    }, REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  stopBackgroundRefresh(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private loadSnapshot(): ModelsDevCatalog {
    const bundled = bundledModelsDevCatalog();
    const text = bundled ?? readFileSync(this.snapshotPath, "utf8");
    return parseCatalog(text);
  }

  private loadCache(): void {
    try {
      const text = readFileSync(this.cachePath, "utf8");
      const parsed = parseCatalog(text);
      this.data = parsed;
      const modifiedAt = statSync(this.cachePath).mtimeMs;
      this.state = this.makeStatus("cache", new Date(modifiedAt).toISOString());
    } catch {
      // Snapshot remains the last known-good source.
    }
  }

  private async refreshInner(force: boolean): Promise<ModelsDevCatalogStatus> {
    try {
      if (!force && this.cacheIsFresh()) return this.status();
      let lastError: unknown;
      for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
        try {
          const text = await this.fetchCatalog();
          const parsed = parseCatalog(text);
          this.writeCache(text);
          this.data = parsed;
          const refreshedAt = new Date(this.now()).toISOString();
          this.state = this.makeStatus("network", refreshedAt);
          return this.status();
        } catch (error) {
          lastError = error;
          if (attempt + 1 < FETCH_ATTEMPTS) {
            await delay(200 * (2 ** attempt));
          }
        }
      }
      throw lastError;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not refresh Models.dev";
      this.state = { ...this.state, refreshError: message };
      throw new Error(message, { cause: error });
    }
  }

  private cacheIsFresh(): boolean {
    try {
      return this.now() - statSync(this.cachePath).mtimeMs < FRESH_MS;
    } catch {
      return false;
    }
  }

  private async fetchCatalog(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.sourceUrl}/api.json`, {
        headers: { "User-Agent": "reaper/models-dev" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Models.dev returned HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
        throw new Error("Models.dev response exceeds the catalog size limit");
      }
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) {
        throw new Error("Models.dev response exceeds the catalog size limit");
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  private writeCache(text: string): void {
    const directory = path.dirname(this.cachePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.cachePath}.${process.pid}.tmp`;
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.cachePath);
  }

  private makeStatus(
    source: ModelsDevCatalogStatus["source"],
    lastRefreshAt?: string,
  ): ModelsDevCatalogStatus {
    const providerCount = Object.keys(this.data).length;
    const modelCount = Object.values(this.data)
      .reduce((total, provider) => total + Object.keys(provider.models).length, 0);
    return {
      source,
      sourceUrl: `${this.sourceUrl}/api.json`,
      providerCount,
      modelCount,
      loadedAt: new Date(this.now()).toISOString(),
      ...(lastRefreshAt ? { lastRefreshAt } : {}),
    };
  }
}

let globalCatalog: ModelsDevCatalogService | undefined;

export function getModelsDevCatalog(): ModelsDevCatalogService {
  globalCatalog ??= new ModelsDevCatalogService();
  return globalCatalog;
}

export function _resetModelsDevCatalogForTests(): void {
  globalCatalog?.stopBackgroundRefresh();
  globalCatalog = undefined;
}

export function compareModels(a: Pick<ModelsDevModel, "id">, b: Pick<ModelsDevModel, "id">): number {
  const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"];
  const aPriority = priority.findIndex((part) => a.id.includes(part));
  const bPriority = priority.findIndex((part) => b.id.includes(part));
  if (aPriority !== bPriority) return bPriority - aPriority;
  const aLatest = a.id.includes("latest") ? 0 : 1;
  const bLatest = b.id.includes("latest") ? 0 : 1;
  if (aLatest !== bLatest) return aLatest - bLatest;
  return b.id.localeCompare(a.id);
}

function parseCatalog(text: string): ModelsDevCatalog {
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) {
    throw new Error("Models.dev catalog exceeds the size limit");
  }
  const parsed: unknown = JSON.parse(text);
  return ModelsDevCatalogSchema.parse(parsed);
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Invalid pagination cursor");
  }
  return offset;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
