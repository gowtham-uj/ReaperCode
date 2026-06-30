import { createLiveReaperGateway } from "../tests/fixtures/live-gateway.js";

async function main() {
  const { gateway } = createLiveReaperGateway("smoke-test", "minimax");
  console.log("PROFILE_NAME:", gateway.constructor.name);
  const startedAt = Date.now();
  const r = await (gateway as { generate: (req: unknown) => Promise<unknown> }).generate({
    role: "main_reasoner",
    messages: [
      { role: "user", content: "Reply with the single word PONG and nothing else." },
    ],
  });
  const elapsedMs = Date.now() - startedAt;
  console.log("ELAPSED_MS:", elapsedMs);
  console.log("RESPONSE:", JSON.stringify(r).slice(0, 800));
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
