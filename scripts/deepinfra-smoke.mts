import { createLiveReaperGateway } from "../tests/fixtures/live-gateway.js";

async function main() {
  const { gateway } = createLiveReaperGateway("deepinfra-smoke", "deepinfra", process.env.DEEPINFRA_MODEL || "Qwen/Qwen2.5-7B-Instruct");
  const startedAt = Date.now();
  const r = await gateway.generate({
    role: "main_reasoner",
    messages: [{ role: "user", content: "Reply with the single word PONG and nothing else." }],
    maxTokens: 256,
  });
  console.log("ELAPSED_MS:", Date.now() - startedAt);
  console.log("PROVIDER:", r.provider);
  console.log("MODEL:", r.model);
  console.log("FINISH:", r.finishReason);
  console.log("CONTENT:", JSON.stringify(r.content).slice(0, 1000));
  console.log("USAGE:", JSON.stringify(r.usage ?? null));
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
