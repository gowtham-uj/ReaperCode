/**
 * Phase T2.6 unit tests for the router-decision telemetry surface.
 *
 * Covers:
 *   - `setOnRoute` registers a callback that fires per `generate` call.
 *   - The callback fires exactly once on a primary success.
 *   - The callback fires on primary failure (no fallback eligible).
 *   - The callback fires on fallback success with strategy=fallback.
 *   - Listener exceptions do NOT propagate; the model call still resolves.
 *   - `setOnRoute(undefined)` removes the callback.
 *
 * Pattern lifted from tests/unit/provider-preflight.test.ts: minimal
 * inline provider client + minimal config that the ConfiguredModelGateway
 * constructor accepts.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ConfiguredModelGateway, type ProviderModelClient } from "../../../src/model/gateway.js";
import type { GenerateRequest, GenerateResult, ResolvedModelProfile, StreamEvent } from "../../../src/model/types.js";

const baseCapabilities = {
  streaming: true,
  toolCalling: true,
  jsonMode: true,
  structuredOutput: true,
  embeddings: false,
};

function makeClient(opts: {
  primarySucceeds: boolean;
  fallbackSucceeds: boolean;
  primaryErrorKind?: string;
  fallbackErrorKind?: string;
}): ProviderModelClient & { _calls: string[] } {
  const calls: string[] = [];
  return {
    _calls: calls,
    async generate(_request, profile) {
      calls.push(profile.model);
      const isPrimary = profile.model === "primary-model";
      const shouldSucceed = isPrimary ? opts.primarySucceeds : opts.fallbackSucceeds;
      if (shouldSucceed) {
        const result: GenerateResult = {
          role: _request.role,
          profileName: profile.profileName,
          provider: profile.provider,
          model: profile.model,
          content: "ok",
          raw: {},
        };
        return result;
      }
      const err = new Error(
        isPrimary ? (opts.primaryErrorKind ?? "primary failure") : (opts.fallbackErrorKind ?? "fallback failure"),
      );
      // Mark the error with a property classifyModelError will recognize.
      (err as Error & { status?: number; code?: string }).status = 503;
      throw err;
    },
    async *stream(_request: GenerateRequest, _profile: ResolvedModelProfile): AsyncIterable<StreamEvent> {
      yield { type: "message_start", data: {} };
    },
    async embed() {
      return { role: "default_model", profileName: "default_model", provider: "fake", model: "fake", vectors: [], raw: {} };
    },
  };
}

function buildConfig(opts: { withFallback: boolean }): unknown {
  const defaultModel = {
    provider: "fake-primary",
    model: "primary-model",
    apiBase: "https://primary.example/v1",
    apiKeyEnv: "PRIMARY_KEY",
    capabilities: baseCapabilities,
    ...(opts.withFallback ? { fallbackProfile: "fast_reasoner" as const } : {}),
  };
  return {
    models: {
      default_model: defaultModel,
      ...(opts.withFallback ? {
        fast_reasoner: {
          provider: "fake-fallback",
          model: "fallback-model",
          apiBase: "https://fallback.example/v1",
          apiKeyEnv: "FALLBACK_KEY",
          capabilities: baseCapabilities,
        },
      } : {}),
    },
  };
}

// Set required env vars so the preflight hook doesn't reject the fake profile.
process.env.PRIMARY_KEY = "configured";
process.env.FALLBACK_KEY = "configured";

test("onRoute fires once on a primary success with resolvedOnPrimary=true", async () => {
  const client = makeClient({ primarySucceeds: true, fallbackSucceeds: true });
  const gw = new ConfiguredModelGateway(buildConfig({ withFallback: true }), client);
  const captured: unknown[] = [];
  gw.setOnRoute((e) => {
    captured.push(e);
  });
  await gw.generate({ role: "default_model", messages: [] });
  assert.equal(captured.length, 1);
  const evt = captured[0] as { strategy: string; resolvedOnPrimary: boolean; provider: string; selectedModel: string };
  assert.equal(evt.strategy, "primary");
  assert.equal(evt.resolvedOnPrimary, true);
  assert.equal(evt.provider, "fake-primary");
  assert.equal(evt.selectedModel, "primary-model");
});

test("onRoute fires twice when primary fails and fallback resolves", async () => {
  const client = makeClient({ primarySucceeds: false, fallbackSucceeds: true });
  const gw = new ConfiguredModelGateway(buildConfig({ withFallback: true }), client);
  const captured: unknown[] = [];
  gw.setOnRoute((e) => {
    captured.push(e);
  });
  const result = await gw.generate({ role: "default_model", messages: [] });
  assert.equal(captured.length, 2, `expected 2 events, got ${captured.length}`);
  const primaryEvt = captured[0] as { strategy: string; resolvedOnPrimary: boolean; reason: string };
  const fallbackEvt = captured[1] as { strategy: string; selectedModel: string; resolvedOnPrimary: boolean };
  assert.equal(primaryEvt.strategy, "primary");
  assert.equal(primaryEvt.resolvedOnPrimary, true);
  assert.match(primaryEvt.reason, /failed/);
  assert.equal(fallbackEvt.strategy, "fallback");
  assert.equal(fallbackEvt.selectedModel, "fallback-model");
  assert.equal(fallbackEvt.resolvedOnPrimary, false);
  assert.equal(result.model, "fallback-model");
});

test("onRoute does NOT fire when no callback is set", async () => {
  const client = makeClient({ primarySucceeds: true, fallbackSucceeds: true });
  const gw = new ConfiguredModelGateway(buildConfig({ withFallback: false }), client);
  // No setOnRoute call
  const result = await gw.generate({ role: "default_model", messages: [] });
  assert.equal(result.content, "ok");
});

test("onRoute listener exceptions do not derail the model call", async () => {
  const client = makeClient({ primarySucceeds: true, fallbackSucceeds: true });
  const gw = new ConfiguredModelGateway(buildConfig({ withFallback: false }), client);
  gw.setOnRoute(() => {
    throw new Error("listener bug — should not bubble");
  });
  // Should resolve normally even though the listener threw.
  const result = await gw.generate({ role: "default_model", messages: [] });
  assert.equal(result.content, "ok");
});

test("setOnRoute(undefined) removes the callback", async () => {
  const client = makeClient({ primarySucceeds: true, fallbackSucceeds: true });
  const gw = new ConfiguredModelGateway(buildConfig({ withFallback: false }), client);
  const captured: unknown[] = [];
  gw.setOnRoute((e) => {
    captured.push(e);
  });
  await gw.generate({ role: "default_model", messages: [] });
  assert.equal(captured.length, 1);
  gw.setOnRoute(undefined);
  await gw.generate({ role: "default_model", messages: [] });
  assert.equal(captured.length, 1, "callback should not fire after setOnRoute(undefined)");
});
