import test from "node:test";
import assert from "node:assert/strict";

import {
  assertRoleCapabilities,
  parseModelRole,
  parseReaperConfig,
  resolveModelRole,
} from "../../src/config/model-config.js";
import { createValidConfig } from "../fixtures/phase0.js";

test("parses a valid single-model config", () => {
  const config = parseReaperConfig(createValidConfig());

  assert.equal(config.models.default_model.model, "qwen-3-235b-a22b-instruct-2507");
  assert.equal(config.models.default_model.provider, "cerebras");
});

test("resolves all unspecified roles to default_model", () => {
  const config = parseReaperConfig(createValidConfig());

  assert.equal(resolveModelRole(config, "main_reasoner").profileName, "default_model");
  assert.equal(resolveModelRole(config, "judge").profileName, "default_model");
  assert.equal(resolveModelRole(config, "embedder").profileName, "default_model");
});

test("resolves explicit role overrides over the default model", () => {
  const config = createValidConfig();
  config.models.judge = {
    provider: "anthropic",
    model: "claude-sonnet-4",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    timeoutMs: 300000,
    maxRetries: 2,
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxContextTokens: 200000,
      maxOutputTokens: 32000,
    },
  };

  const parsed = parseReaperConfig(config);
  const judge = resolveModelRole(parsed, "judge");
  const main = resolveModelRole(parsed, "main_reasoner");

  assert.equal(judge.profileName, "judge");
  assert.equal(judge.provider, "anthropic");
  assert.equal(main.profileName, "default_model");
});

test("rejects missing default_model", () => {
  assert.throws(
    () =>
      parseReaperConfig({
        models: {},
      }),
    /default_model/,
  );
});

test("rejects unknown model roles to keep the contract frozen", () => {
  const config = createValidConfig() as { models: Record<string, unknown> };
  config.models.random_role = config.models.default_model;

  assert.throws(() => parseReaperConfig(config), /Unrecognized key/);
});

test("rejects invalid environment variable names", () => {
  const config = createValidConfig();
  config.models.default_model.apiKeyEnv = "bad-env-name";

  assert.throws(() => parseReaperConfig(config), /Invalid/);
});

test("allows timeoutMs zero to disable provider request deadline", () => {
  const config = createValidConfig();
  config.models.default_model.timeoutMs = 0;

  const parsed = parseReaperConfig(config);

  assert.equal(parsed.models.default_model.timeoutMs, 0);
});

test("defaults pruner to local-only mode", () => {
  const parsed = parseReaperConfig({
    models: createValidConfig().models,
  });

  assert.equal(parsed.pruner.localOnly, true);
});

test("enables session metrics by default", () => {
  const parsed = parseReaperConfig({
    models: createValidConfig().models,
  });

  assert.equal(parsed.logging.sessionMetrics, true);
});

test("defaults phase 1 control hardening flags", () => {
  const parsed = parseReaperConfig({
    models: createValidConfig().models,
  });

  assert.equal(parsed.runtime.progressGuard.enabled, true);
  assert.equal(parsed.runtime.progressGuard.actionRepeatLimit, 3);
  assert.equal(parsed.runtime.progressGuard.observationRepeatLimit, 3);
  assert.equal(parsed.runtime.progressGuard.sameFailedActionLimit, 3);
  assert.equal(parsed.runtime.progressGuard.stallSteps, 2);
  assert.equal(parsed.runtime.completionGateMax, 3);
  assert.equal(parsed.runtime.recedingHorizonPlanContext, true);
  assert.equal(parsed.runtime.voteAttempts, 1);
  assert.equal(parsed.runtime.artifactObligations.enabled, true);
  assert.equal(parsed.runtime.hypothesisRescue.enabled, true);
  assert.equal(parsed.runtime.expandedStuckDetection.enabled, true);
  assert.equal(parsed.runtime.expandedStuckDetection.alternatingPatternLength, 6);
  assert.equal(parsed.runtime.serviceSupervisor.enabled, true);
  assert.equal(parsed.runtime.serviceSupervisor.autoRecover, true);
  assert.equal(parsed.runtime.serviceSupervisor.maxAutoRecoveriesPerService, 1);
});

test("defaults phase 2 verification gate flags", () => {
  const parsed = parseReaperConfig({
    models: createValidConfig().models,
  });

  assert.equal(parsed.verification.requireGroundedCompletion, true);
  assert.equal(parsed.verification.enforceFailBeforeFixForGeneratedChecks, true);
  assert.equal(parsed.verification.selfDebugExplanation.enabled, true);
  assert.equal(parsed.verification.contractCoverage.enabled, true);
  assert.equal(parsed.verification.executionConsensusRanking, true);
});

test("defaults phase 6 model routing roles", () => {
  const parsed = parseReaperConfig({
    models: createValidConfig().models,
  });

  assert.equal(parsed.modelRouting.mainAgent, "main_reasoner");
  assert.equal(parsed.modelRouting.planner, "main_reasoner");
  assert.equal(parsed.modelRouting.executor, "fast_reasoner");
  assert.equal(parsed.modelRouting.repair, "main_reasoner");
  assert.equal(parsed.modelRouting.patcher, "fast_reasoner");
  assert.equal(parsed.modelRouting.completionGate, "fast_reasoner");
  assert.equal(parsed.modelRouting.summarizer, "fast_reasoner");
  assert.equal(parsed.modelRouting.judge, "judge");
});

test("accepts main-agent model routing aliases", () => {
  const parsed = parseReaperConfig({
    models: createValidConfig().models,
    modelRouting: {
      mainAgent: "main_agent",
    },
  });

  assert.equal(parsed.modelRouting.mainAgent, "main_reasoner");
  assert.equal(parseModelRole("main_agent"), "main_reasoner");
});

test("rejects unknown phase 6 model routing roles", () => {
  assert.throws(
    () =>
      parseReaperConfig({
        models: createValidConfig().models,
        modelRouting: {
          planner: "unknown_role",
        },
      }),
    /Invalid enum value|Invalid option|Expected/,
  );
});

test("rejects fallback profiles that do not exist", () => {
  const config = createValidConfig();
  config.models.default_model.fallbackProfile = "judge";

  assert.throws(() => parseReaperConfig(config), /Fallback profile 'judge' is not configured/);
});

test("enforces embedder capability when role override is present", () => {
  const config = createValidConfig();
  config.models.embedder = {
    provider: "openai",
    model: "gpt-4.1-mini",
    apiKeyEnv: "OPENAI_API_KEY",
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
    },
  };

  const parsed = parseReaperConfig(config);

  assert.throws(() => assertRoleCapabilities(parsed, "embedder"), /embeddings=true/);
});

test("enforces tool-calling capability for judge overrides", () => {
  const config = createValidConfig();
  config.models.judge = {
    provider: "anthropic",
    model: "claude-mini",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    capabilities: {
      streaming: true,
      toolCalling: false,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
    },
  };

  const parsed = parseReaperConfig(config);

  assert.doesNotThrow(() => assertRoleCapabilities(parsed, "judge"));
});

test("defaultParams accepts reasoningEffort (string enum)", () => {
  const config = createValidConfig();
  config.models.default_model.defaultParams = { reasoningEffort: "high" };
  const parsed = parseReaperConfig(config);
  assert.equal(parsed.models.default_model.defaultParams?.reasoningEffort, "high");
});

test("defaultParams accepts reasoningEffort (legacy numeric)", () => {
  const config = createValidConfig();
  config.models.default_model.defaultParams = { reasoningEffort: 75 };
  const parsed = parseReaperConfig(config);
  assert.equal(parsed.models.default_model.defaultParams?.reasoningEffort, 75);
});

test("defaultParams still rejects truly unknown keys (.strict)", () => {
  const config = createValidConfig();
  // Force-typed because TS won't allow this; Zod is what should reject it.
  (config.models.default_model as Record<string, unknown>).defaultParams = {
    notARealField: true,
  };
  assert.throws(() => parseReaperConfig(config), /Unrecognized key/);
});
