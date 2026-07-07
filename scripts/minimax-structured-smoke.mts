import { createLiveReaperGateway } from "../tests/fixtures/live-gateway.js";
import { generateStructuredJson } from "../src/model/json-response.js";

function parseEnvelope(value: unknown): { assistant_message: string; tool_calls: unknown[] } {
  const obj = value as { assistant_message?: unknown; tool_calls?: unknown };
  if (typeof obj.assistant_message !== "string" || !Array.isArray(obj.tool_calls)) {
    throw new Error("expected envelope");
  }
  return { assistant_message: obj.assistant_message, tool_calls: obj.tool_calls };
}

async function main() {
  const { gateway } = createLiveReaperGateway("minimax-structured-smoke", "minimax", "MiniMax-M3");
  const startedAt = Date.now();
  const result = await generateStructuredJson({
    modelGateway: gateway,
    role: "secondary_model",
    messages: [{ role: "user", content: "Return a Reaper executor JSON envelope saying pong with no tool calls." }],
    parse: parseEnvelope,
    maxTokens: 768,
  });
  console.log("ELAPSED_MS:", Date.now() - startedAt);
  console.log("RESULT:", JSON.stringify(result));
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
