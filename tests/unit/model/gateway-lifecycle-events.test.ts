import test from "node:test";
import assert from "node:assert/strict";

import { ConfiguredModelGateway, type ProviderModelClient } from "../../../src/model/gateway.js";
import {
  ExtensionLifecycleEventBus,
  getExtensionLifecycleEventBus,
  __resetExtensionLifecycleEventBusForTests,
  type ExtensionLifecycleEvent,
} from "../../../src/extensions/lifecycle-events.js";
import type { GenerateRequest, GenerateResult, ResolvedModelProfile, StreamEvent } from "../../../src/model/types.js";
import type { LoadedExtension } from "../../../src/extensions/types.js";

const baseCapabilities = {
  streaming: true,
  toolCalling: true,
  jsonMode: true,
  structuredOutput: true,
  embeddings: false,
};

const trustedExtension: LoadedExtension = {
  id: "test-extension",
  manifest: {
    id: "test-extension",
    version: "1.0.0",
    description: "test",
    main: "index.js",
    engines: { reaper: ">=0.0.0" },
    permissions: [],
  },
  trust: "user-trusted",
  status: "enabled",
  installPath: "/tmp/test-extension",
  loadedAt: Date.now(),
};

function buildConfig(): unknown {
  return {
    models: {
      default_model: {
        provider: "fake",
        model: "fake-model",
        apiBase: "https://fake.example/v1",
        apiKeyEnv: "FAKE_MODEL_KEY",
        capabilities: baseCapabilities,
      },
    },
  };
}

function makeClient(options: { failGenerate?: boolean } = {}): ProviderModelClient & { requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = [];
  return {
    requests,
    async generate(request, profile): Promise<GenerateResult> {
      requests.push(request);
      if (options.failGenerate) throw new Error("provider exploded");
      return {
        role: request.role,
        profileName: profile.profileName,
        provider: profile.provider,
        model: profile.model,
        content: JSON.stringify({ ok: true }),
        usage: { inputTokens: 3, outputTokens: 4 },
        raw: {},
      };
    },
    async *stream(request: GenerateRequest, _profile: ResolvedModelProfile): AsyncIterable<StreamEvent> {
      requests.push(request);
      yield { type: "message_start", data: {} };
      yield { type: "message_delta", content: "hello" };
      yield { type: "message_end", data: { usage: { inputTokens: 5, outputTokens: 6 } } };
    },
    async embed() {
      return { role: "default_model", profileName: "default_model", provider: "fake", model: "fake-model", vectors: [], raw: {} };
    },
  };
}

process.env.FAKE_MODEL_KEY = "configured";

test("ConfiguredModelGateway uses the global lifecycle bus by default", async () => {
  __resetExtensionLifecycleEventBusForTests();
  const events: ExtensionLifecycleEvent[] = [];
  getExtensionLifecycleEventBus().register(trustedExtension, (event) => {
    events.push(event);
  });

  const gateway = new ConfiguredModelGateway(buildConfig(), makeClient());
  await gateway.generate({ role: "default_model", source: "global-source", messages: [] });

  assert.deepEqual(events.map((event) => event.type), ["before_model_request", "after_model_response"]);
  assert.equal(events[0]?.type, "before_model_request");
  const before = events[0];
  if (before?.type !== "before_model_request") throw new Error("expected before_model_request");
  assert.equal(before.source, "global-source");
  __resetExtensionLifecycleEventBusForTests();
});

test("ConfiguredModelGateway directly emits mutable before/after lifecycle events for generate", async () => {
  const bus = new ExtensionLifecycleEventBus();
  const events: ExtensionLifecycleEvent[] = [];
  bus.register(trustedExtension, (event) => {
    events.push(event);
    if (event.type === "before_model_request") {
      event.request.source = "rewritten-source";
      event.request.messages.push({ role: "user", content: "added by lifecycle" });
    }
  });

  const client = makeClient();
  const gateway = new ConfiguredModelGateway(buildConfig(), client, { lifecycleBus: bus });
  const result = await gateway.generate({ role: "default_model", source: "original-source", messages: [] });

  assert.equal(result.content, JSON.stringify({ ok: true }));
  assert.equal(client.requests[0]?.source, "rewritten-source");
  assert.deepEqual(client.requests[0]?.messages, [{ role: "user", content: "added by lifecycle" }]);
  assert.deepEqual(events.map((event) => event.type), ["before_model_request", "after_model_response"]);
  const after = events[1];
  assert.equal(after?.type, "after_model_response");
  if (after?.type !== "after_model_response") throw new Error("expected after_model_response");
  assert.equal(after.source, "rewritten-source");
  assert.deepEqual(after.usage, { inputTokens: 3, outputTokens: 4 });
  assert.equal(after.response?.model, "fake-model");
});

test("ConfiguredModelGateway directly emits stream lifecycle events with stream usage", async () => {
  const bus = new ExtensionLifecycleEventBus();
  const events: ExtensionLifecycleEvent[] = [];
  bus.register(trustedExtension, (event) => {
    events.push(event);
    if (event.type === "before_model_request") {
      event.request.source = "stream-source";
    }
  });

  const client = makeClient();
  const gateway = new ConfiguredModelGateway(buildConfig(), client, { lifecycleBus: bus });
  const seen: StreamEvent[] = [];
  for await (const event of gateway.stream({ role: "default_model", source: "original-stream", messages: [] })) {
    seen.push(event);
  }

  assert.equal(seen.length, 3);
  assert.equal(client.requests[0]?.source, "stream-source");
  assert.deepEqual(events.map((event) => event.type), ["before_model_request", "after_model_response"]);
  const after = events[1];
  if (after?.type !== "after_model_response") throw new Error("expected after_model_response");
  assert.deepEqual(after.usage, { inputTokens: 5, outputTokens: 6 });
  assert.equal(after.response, undefined);
});

test("ConfiguredModelGateway directly emits after lifecycle event with provider errors", async () => {
  const bus = new ExtensionLifecycleEventBus();
  const events: ExtensionLifecycleEvent[] = [];
  bus.register(trustedExtension, (event) => {
    events.push(event);
  });

  const client = makeClient({ failGenerate: true });
  const gateway = new ConfiguredModelGateway(buildConfig(), client, { lifecycleBus: bus });
  await assert.rejects(
    () => gateway.generate({ role: "default_model", source: "failure-source", messages: [] }),
    /provider exploded/,
  );

  assert.deepEqual(events.map((event) => event.type), ["before_model_request", "after_model_response"]);
  const after = events[1];
  if (after?.type !== "after_model_response") throw new Error("expected after_model_response");
  assert.equal(after.source, "failure-source");
  assert.match(after.error ?? "", /provider exploded/);
});
