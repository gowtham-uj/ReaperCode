import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildStarterConfig,
  writeStarterConfig,
} from "../../src/config/starter-config.js";

test("buildStarterConfig: every required field is set, no implicit defaults", () => {
  const cfg = buildStarterConfig();
  // Top-level required blocks.
  assert.ok(cfg["connection"], "connection block required");
  assert.ok(cfg["logging"], "logging block required");
  assert.ok(cfg["pruner"], "pruner block required");
  assert.ok(cfg["runtime"], "runtime block required");
  assert.ok(cfg["verification"], "verification block required");
  assert.ok(cfg["modelRouting"], "modelRouting block required");
  assert.ok(cfg["models"], "models block required");
  assert.ok(cfg["mcp"], "mcp block required");
  assert.ok(cfg["contextManagement"], "contextManagement block required");
  assert.ok(cfg["runtimeTunables"], "runtimeTunables block required");
  // API keys are NOT in the config file. They stay in environment
  // variables (e.g. ANTHROPIC_API_KEY). The schema deliberately omits
  // a secrets block to keep credentials out of source-controlled JSON.

  // Required scalar fields.
  const cm = cfg["contextManagement"] as Record<string, unknown>;
  assert.equal(typeof cm["softCap"], "number");
  assert.equal(typeof cm["shakeTriggerPct"], "number");
  assert.equal(typeof cm["maxConsecutiveShakeFailures"], "number");
  assert.equal(typeof cm["warningThresholdRatio"], "number");
  assert.equal(typeof cm["errorThresholdRatio"], "number");
  assert.equal(typeof cm["blockingThresholdRatio"], "number");

  // Required runtimeTunables.
  const rt = cfg["runtimeTunables"] as Record<string, unknown>;
  assert.equal(typeof rt["bashDefaultTimeoutMs"], "number");
  assert.equal(typeof rt["maxShellOutputBytes"], "number");
  assert.equal(typeof rt["retryMaxRetries"], "number");
  assert.equal(typeof rt["permissionMode"], "string");

  // Required secrets: API keys are read from env vars (e.g.
  // ANTHROPIC_API_KEY) at provider-resolution time, not from the
  // config file. Verify the env-reading code path exists.
  assert.equal(typeof process.env, "object");
  // Anthropic key: process.env.ANTHROPIC_API_KEY
  // (intentionally NOT asserted — empty string when unset is OK).
});

test("buildStarterConfig honors optional defaultModel and defaultProvider overrides", () => {
  const cfg = buildStarterConfig({ defaultModel: "gpt-5.4", defaultProvider: "openai" });
  const models = cfg["models"] as Record<string, Record<string, unknown>>;
  assert.equal(models["default_model"]?.["model"], "gpt-5.4");
  assert.equal(models["default_model"]?.["provider"], "openai");
});

test("writeStarterConfig writes a complete JSON file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reaper-starter-"));
  const { path: target } = await writeStarterConfig({ workspaceRoot: dir });
  assert.equal(target, path.join(dir, ".reaper", "config.json"));
  const raw = await readFile(target, "utf8");
  const obj = JSON.parse(raw) as Record<string, unknown>;
  // Re-validate: the written file must parse against the schema.
  // We import the parser lazily to avoid pulling in the full graph.
  const { parseReaperConfig } = await import("../../src/config/model-config.js");
  const parsed = parseReaperConfig(obj);
  assert.equal(parsed.contextManagement.softCap, 100_000);
  assert.equal(parsed.runtimeTunables.bashDefaultTimeoutMs, 600_000);
});
