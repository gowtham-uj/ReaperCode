
import { LiteLLMProviderClient } from "../src/model/providers/litellm-gateway.js";
import type { GenerateRequest, ResolvedModelProfile } from "../src/model/types.js";

async function diagnoseMaxTokens() {
  const client = new LiteLLMProviderClient();
  const models = [
    "XiaomiMiMo/MiMo-V2.5",
    "NousResearch/Hermes-3-Llama-3.1-405B",
    "deepseek-ai/DeepSeek-V4-Flash"
  ];

  for (const model of models) {
    console.log(`\nTesting ${model} output capacity...`);
    const profile: ResolvedModelProfile = {
      provider: "deepinfra",
      model,
      profileName: "secondary_model",
      role: "secondary_model",
      apiKeyEnv: "DEEPINFRA_API_KEY",
      capabilities: { streaming: false, toolCalling: true, jsonMode: true, structuredOutput: true, embeddings: false },
    };

    const start = Date.now();
    try {
      const result = await client.generate({
        role: "secondary_model",
        messages: [{ role: "user", content: "Provide a JSON object with a 'story' key containing a very long story about a robot, at least 1000 words." }],
        maxTokens: 4096,
        responseFormat: "json"
      }, profile);
      console.log(`- Success! Content length: ${result.content.length} chars. FinishReason: ${result.finishReason}`);
    } catch (error: any) {
      console.log(`- Failed: ${error.message}`);
    }
  }
}

diagnoseMaxTokens().catch(console.error);
