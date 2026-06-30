import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_JSON_ENVELOPE,
  capabilityRoutingSummary,
  routeForCapabilities,
} from "../../src/model/capability-router.js";

test("routeForCapabilities picks native_tools when both tools and caller wants them", () => {
  const decision = routeForCapabilities({
    capabilities: { streaming: true, toolCalling: true, jsonMode: true, structuredOutput: false, embeddings: false },
    wantsToolCalling: true,
  });
  assert.equal(decision.strategy, "native_tools");
  assert.equal(decision.passNativeTools, true);
  assert.equal(decision.useJsonMode, false);
});

test("routeForCapabilities picks json_envelope when caller wants tools but capabilities.toolCalling=false", () => {
  const decision = routeForCapabilities({
    capabilities: { streaming: true, toolCalling: false, jsonMode: true, structuredOutput: false, embeddings: false },
    wantsToolCalling: true,
  });
  assert.equal(decision.strategy, "json_envelope");
  assert.equal(decision.passNativeTools, false);
  assert.equal(decision.useJsonMode, true);
  assert.equal(decision.jsonEnvelopeTemplate, DEFAULT_JSON_ENVELOPE);
});

test("routeForCapabilities picks json_envelope when caller does not want tools and JSON mode is available", () => {
  const decision = routeForCapabilities({
    capabilities: { streaming: true, toolCalling: true, jsonMode: true, structuredOutput: false, embeddings: false },
    wantsToolCalling: false,
  });
  assert.equal(decision.strategy, "json_envelope");
  assert.equal(decision.passNativeTools, false);
  assert.equal(decision.useJsonMode, true);
});

test("routeForCapabilities falls back to text_fallback when neither tools nor JSON mode are available", () => {
  const decision = routeForCapabilities({
    capabilities: { streaming: false, toolCalling: false, jsonMode: false, structuredOutput: false, embeddings: false },
    wantsToolCalling: true,
  });
  assert.equal(decision.strategy, "text_fallback");
  assert.equal(decision.passNativeTools, false);
  assert.equal(decision.useJsonMode, false);
});

test("routeForCapabilities returns a safe default when capabilities are missing", () => {
  const decision = routeForCapabilities({
    capabilities: undefined,
    wantsToolCalling: true,
  });
  assert.equal(decision.strategy, "json_envelope");
  assert.equal(decision.useJsonMode, true);
});

test("capabilityRoutingSummary formats the capability flags", () => {
  const summary = capabilityRoutingSummary({
    streaming: true,
    toolCalling: true,
    jsonMode: false,
    structuredOutput: false,
    embeddings: false,
    maxContextTokens: 200000,
    maxOutputTokens: 8000,
  });
  assert.match(summary, /stream/);
  assert.match(summary, /tools/);
  assert.match(summary, /ctx=200000/);
  assert.match(summary, /out=8000/);
});

test("capabilityRoutingSummary returns 'none' for undefined capabilities", () => {
  assert.equal(capabilityRoutingSummary(undefined), "capabilities: <none>");
});
