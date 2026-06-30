import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { createLiveCrazyRouterGateway } from "../fixtures/live-gateway.js";

loadWorkspaceDotEnv();

const routerKeyPresent = Boolean(
  process.env.RUN_LIVE_LLM_TESTS === "1" &&
    (process.env.CRAZY_ROUTER_API_KEY ||
    process.env.CRAZYROUTER_API_KEY ||
    process.env.CRAZY_ROUTER_PROVIDER),
);

test(
  "live crazy router generate call works with claude-sonnet-4-6",
  { skip: !routerKeyPresent, timeout: 120_000 },
  async () => {
    const { gateway } = createLiveCrazyRouterGateway(
      "live crazy router generate call works with claude-sonnet-4-6",
      "claude-sonnet-4-6",
    );
    const result = await gateway.generate({
      role: "main_reasoner",
      messages: [{ role: "user", content: "Reply with exactly the word: ok" }],
      maxTokens: 128,
    });

    assert.match(result.content.toLowerCase(), /ok/);
    assert.equal(result.provider, "crazyrouter");
    assert.equal(result.model, "claude-sonnet-4-6");
  },
);

function loadWorkspaceDotEnv(): void {
  for (const candidate of [path.resolve(process.cwd(), ".env"), "/workspace/.env"]) {
    if (!existsSync(candidate)) continue;
    const content = readFileSync(candidate, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) continue;
      process.env[match[1]!] ??= unquoteEnvValue(match[2] ?? "");
    }
  }
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
