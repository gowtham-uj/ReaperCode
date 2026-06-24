import test from "node:test";
import assert from "node:assert/strict";

import { bootPhase0Runtime } from "../../src/runtime/bootstrap.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";

test("boots Phase 0 runtime with one default model", () => {
  const result = bootPhase0Runtime({
    config: createValidConfig(),
    transport: "stdio",
    requestEnvelope: createValidRequestEnvelope(),
    userIntentSummary: "Bootstrap test run",
  });

  assert.equal(result.transport, "stdio");
  // Phase 2.5: modelBindings was removed — role-to-profile routing now
  // lives on `config.models`. The fixture only ships a single
  // `default_model` profile; the rest of the routes fall through to
  // it at the resolver layer.
  assert.equal(result.config.models.default_model.provider, "cerebras");
  assert.equal(result.state.userIntentSummary, "Bootstrap test run");
});

test("boots Phase 0 runtime after swapping the default model via config only", () => {
  const config = createValidConfig();
  config.models.default_model.provider = "anthropic";
  config.models.default_model.model = "claude-sonnet-4";
  config.models.default_model.apiKeyEnv = "ANTHROPIC_API_KEY";

  const result = bootPhase0Runtime({
    config,
    transport: "http_json",
    requestEnvelope: createValidRequestEnvelope(),
  });

  assert.equal(result.config.models.default_model.provider, "anthropic");
  assert.equal(result.config.models.default_model.model, "claude-sonnet-4");
});

test("boots Phase 0 runtime with role overrides while keeping the default model for other roles", () => {
  const config = createValidConfig();
  config.models.judge = {
    provider: "anthropic",
    model: "claude-sonnet-4",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
    },
  };

  const result = bootPhase0Runtime({
    config,
    transport: "websocket",
    requestEnvelope: createValidRequestEnvelope(),
  });

  // Phase 2.5: judge role now resolves to a separate profile; default_model
  // remains the cerebras profile for the rest.
  assert.ok(result.config.models.judge);
  assert.equal(result.config.models.judge.model, "claude-sonnet-4");
  assert.equal(result.config.models.default_model.provider, "cerebras");
});

test("fails fast on invalid request envelopes during boot", () => {
  const request = createValidRequestEnvelope();
  request.timestamp = "bad";

  assert.throws(
    () =>
      bootPhase0Runtime({
        config: createValidConfig(),
        transport: "http_sse",
        requestEnvelope: request,
      }),
    /Invalid datetime/,
  );
});

test("fails fast on invalid model config during boot", () => {
  const config = createValidConfig();
  config.models.default_model.provider = "";

  assert.throws(
    () =>
      bootPhase0Runtime({
        config,
        transport: "stdio",
        requestEnvelope: createValidRequestEnvelope(),
      }),
    /String must contain at least 1 character/,
  );
});
