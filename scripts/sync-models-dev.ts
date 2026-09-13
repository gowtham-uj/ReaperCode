import { chmod, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ModelsDevCatalogSchema } from "../src/model/provider/models-dev-types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = process.env.REAPER_MODELS_DEV_URL ?? "https://models.opencode.ai/api.json";
const OPENCODE_COMMIT = "82b665075b0c89e36938931087920e1b36b1c49e";
const MAX_BYTES = 16 * 1024 * 1024;

const response = await fetch(SOURCE, {
  headers: { "User-Agent": "reaper/models-dev-sync" },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Models.dev returned HTTP ${response.status}`);
const text = await response.text();
if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Models.dev catalog exceeds 16 MiB");
const catalog = ModelsDevCatalogSchema.parse(JSON.parse(text) as unknown);
const providerCount = Object.keys(catalog).length;
const modelCount = Object.values(catalog)
  .reduce((total, provider) => total + Object.keys(provider.models).length, 0);

const catalogPath = path.join(ROOT, "src", "model", "provider", "models-dev.json");
const metadataPath = path.join(ROOT, "src", "model", "provider", "models-dev-snapshot.ts");
const temporaryCatalog = `${catalogPath}.${process.pid}.tmp`;
const temporaryMetadata = `${metadataPath}.${process.pid}.tmp`;
const retrievedAt = new Date().toISOString().slice(0, 10);
const metadata = `export const MODELS_DEV_SNAPSHOT_METADATA = {\n`
  + `  source: ${JSON.stringify(SOURCE)},\n`
  + `  retrievedAt: ${JSON.stringify(retrievedAt)},\n`
  + `  opencodeCommit: ${JSON.stringify(OPENCODE_COMMIT)},\n`
  + `  providerCount: ${providerCount.toLocaleString("en-US").replace(/,/g, "_")},\n`
  + `  modelCount: ${modelCount.toLocaleString("en-US").replace(/,/g, "_")},\n`
  + `} as const;\n`;

await writeFile(temporaryCatalog, `${JSON.stringify(catalog)}\n`, { mode: 0o644 });
await writeFile(temporaryMetadata, metadata, { mode: 0o644 });
await chmod(temporaryCatalog, 0o644);
await chmod(temporaryMetadata, 0o644);
await rename(temporaryCatalog, catalogPath);
await rename(temporaryMetadata, metadataPath);
console.log(`Synced ${providerCount} providers and ${modelCount} models from ${SOURCE}`);
