/**
 * Probe MiniMax-M2.7 to capture the exact raw response shape so we can
 * design a parser fix.
 */
import { createLiveReaperGateway } from "../tests/fixtures/live-gateway.js";

async function main(): Promise<void> {
  const gateway = createLiveReaperGateway("probe-minimax", "minimax");
  const profile = await gateway.resolveRole("executor");
  const r = await gateway.generate({
    role: "executor",
    system: "You are a main agent. Return only JSON: {\"assistant_message\":\"...\",\"tool_calls\":[]}",
    messages: [
      {
        role: "user",
        content:
          "Create a file called hello.txt with content 'world' and confirm it exists. " +
          "CRITICAL: Return ONLY a valid JSON object starting with { and ending with }. No markdown fences. No explanation. No filler text. Pure JSON only.",
      },
    ],
    maxTokens: 4096,
  });
  process.stdout.write("=== finishReason ===\n");
  process.stdout.write(r.finishReason + "\n");
  process.stdout.write("=== content (full) ===\n");
  process.stdout.write(r.content);
  process.stdout.write("\n=== toolCalls ===\n");
  process.stdout.write(JSON.stringify(r.toolCalls ?? [], null, 2) + "\n");
  process.stdout.write("=== END ===\n");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(2);
});