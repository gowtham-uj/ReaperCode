import { createLiveReaperGateway } from "../tests/fixtures/live-gateway.js";
import { loadWorkspaceEnv } from "../reaper_eval/runtime/load-env.js";
import { generateStructuredJson } from "../src/model/json-response.js";

loadWorkspaceEnv("/workspace");
process.env.REAPER_LIVE_FALLBACK_PROVIDERS = "";
process.env.REAPER_LIVE_MODEL_TIMEOUT_MS = "45000";
process.env.REAPER_MODEL_CALL_TIMEOUT_MS = "45000";

const provider = process.argv[2] ?? "deepinfra";
const model = process.argv[3];
const { gateway, config } = createLiveReaperGateway(`structured-smoke:${provider}`, provider, model);
const profile = config.models.main_reasoner ?? config.models.default_model;
console.log(`[structured-smoke] provider=${provider} profile=${profile.provider}/${profile.model} timeout=${profile.timeoutMs ?? "none"}`);
const result = await generateStructuredJson({
  modelGateway: gateway,
  role: "main_reasoner",
  messages: [{ role: "user", content: "Return {\"ok\":true,\"message\":\"pong\"}." }],
  maxTokens: 512,
  parse(value) {
    const obj = value as { ok?: unknown; message?: unknown };
    if (obj.ok !== true || typeof obj.message !== "string") throw new Error("bad shape");
    return { ok: obj.ok, message: obj.message };
  },
});
console.log(JSON.stringify({ ok: true, provider, result }));
