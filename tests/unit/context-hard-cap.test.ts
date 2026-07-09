import test from "node:test";
import assert from "node:assert/strict";

import {
  clampSoftCapTokens,
  REAPER_CONTEXT_HARD_CAP_TOKENS,
  REAPER_DEFAULT_SOFT_CAP_TOKENS,
} from "../../src/config/context-hard-cap.js";
import { parseReaperConfig } from "../../src/config/model-config.js";

test("hard cap constant is 270k", () => {
  assert.equal(REAPER_CONTEXT_HARD_CAP_TOKENS, 270_000);
  assert.equal(REAPER_DEFAULT_SOFT_CAP_TOKENS, 270_000);
});

test("clampSoftCapTokens clamps above hard cap and defaults invalid values", () => {
  assert.equal(clampSoftCapTokens(1_000_000), 270_000);
  assert.equal(clampSoftCapTokens(270_000), 270_000);
  assert.equal(clampSoftCapTokens(32_000), 32_000);
  assert.equal(clampSoftCapTokens(0), 270_000);
  assert.equal(clampSoftCapTokens(-1), 270_000);
  assert.equal(clampSoftCapTokens(undefined), 270_000);
  assert.equal(clampSoftCapTokens(Number.NaN), 270_000);
});

test("parseReaperConfig defaults softCap to 270k and clamps 1M configs", () => {
  const base = {
    models: {
      default_model: {
        provider: "openai",
        model: "gpt-test",
        capabilities: {
          streaming: true,
          toolCalling: true,
          jsonMode: true,
          structuredOutput: true,
          embeddings: false,
        },
      },
    },
  };

  const defaults = parseReaperConfig(base);
  assert.equal(defaults.contextManagement.softCap, 270_000);

  const clamped = parseReaperConfig({
    ...base,
    contextManagement: { softCap: 1_000_000 },
  });
  assert.equal(clamped.contextManagement.softCap, 270_000);

  const lower = parseReaperConfig({
    ...base,
    contextManagement: { softCap: 32_000 },
  });
  assert.equal(lower.contextManagement.softCap, 32_000);
});
