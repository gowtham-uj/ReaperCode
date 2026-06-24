import { createLiveReaperGateway } from "../tests/fixtures/live-gateway.js";
import { loadWorkspaceEnv } from "../reaper_eval/runtime/load-env.js";

loadWorkspaceEnv("/workspace");
process.env.REAPER_LIVE_FALLBACK_PROVIDERS = "";
process.env.REAPER_LIVE_MODEL_TIMEOUT_MS = "15000";
process.env.REAPER_MODEL_CALL_TIMEOUT_MS = "15000";

const provider = process.argv[2];
if (!provider) throw new Error("usage: check-one-provider.ts <provider>");

function summarizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/g, "Bearer <redacted>").slice(0, 900);
}

const startedAt = Date.now();
try {
  const { gateway, config } = createLiveReaperGateway(`provider-smoke:${provider}`, provider);
  const profile = config.models.main_reasoner ?? config.models.default_model;
  console.error(`[provider-smoke] ${provider}: profile provider=${profile.provider} model=${profile.model} timeout=${profile.timeoutMs ?? "none"}`);
  const result = await gateway.generate({
    role: "main_reasoner",
    messages: [{ role: "user", content: "Return exactly this JSON object and nothing else: {\"ok\":true}" }],
    maxTokens: 64,
    responseFormat: "json",
  });
  console.log(JSON.stringify({
    provider,
    ok: true,
    elapsedMs: Date.now() - startedAt,
    resolvedProvider: result.provider,
    model: result.model,
    finishReason: result.finishReason,
    contentPreview: result.content.slice(0, 160),
    profileProvider: profile.provider,
    profileModel: profile.model,
  }));
} catch (err) {
  console.log(JSON.stringify({
    provider,
    ok: false,
    elapsedMs: Date.now() - startedAt,
    error: summarizeError(err),
  }));
  process.exitCode = 1;
}
