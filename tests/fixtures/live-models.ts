export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";
export const DEFAULT_DEEPSEEK_FAST_MODEL = "deepseek-v4-flash";

export const DEFAULT_DEEPINFRA_MODEL = "Qwen/Qwen3.6-35B-A3B";
export const DEFAULT_DEEPINFRA_FAST_MODEL = "Qwen/Qwen3.6-35B-A3B";

export const DEFAULT_OPENROUTER_MODEL = "claude-sonnet-4-6";
export const DEFAULT_OPENROUTER_FAST_MODEL = "deepseek/deepseek-v4-flash";
export const DEFAULT_CRAZYROUTER_MODEL = "Qwen/Qwen3.6-35B-A3B";
export const DEFAULT_CRAZYROUTER_FAST_MODEL = "Qwen/Qwen3.6-35B-A3B";

export const DEFAULT_OPENAI_MODEL = "gpt-5.1";
export const DEFAULT_OPENAI_FAST_MODEL = "gpt-5.1-mini";
export const DEFAULT_NURALWATT_MODEL = "kimi-k2.7-code";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_ANTHROPIC_FAST_MODEL = "claude-haiku-4-5";
export const DEFAULT_CEREBRAS_MODEL = "qwen-3-235b-a22b-instruct-2507";
export const DEFAULT_CEREBRAS_FAST_MODEL = "llama3.1-8b";

export const DEFAULT_MIMO_MODEL = "mimo-v2.5";
export const DEFAULT_MIMO_FAST_MODEL = "mimo-v2.5";
export const DEFAULT_AZURE_OPENAI_MODEL = "gpt-4.1";

export function getDefaultDeepSeekModel(): string {
  return process.env.DEEPSEEK_MODEL ?? DEFAULT_DEEPSEEK_MODEL;
}

export function getDefaultDeepSeekLatencyFallbackModel(): string {
  return process.env.DEEPSEEK_LATENCY_FALLBACK_MODEL ?? DEFAULT_DEEPSEEK_FAST_MODEL;
}

export function getDefaultDeepSeekFlashFallbackModel(): string {
  return process.env.DEEPSEEK_FLASH_FALLBACK_MODEL ?? DEFAULT_DEEPSEEK_FAST_MODEL;
}

export function getDefaultDeepInfraModel(): string {
  return process.env.DEEPINFRA_MODEL ?? DEFAULT_DEEPINFRA_MODEL;
}

export function getDefaultDeepInfraLatencyFallbackModel(): string {
  return process.env.DEEPINFRA_LATENCY_FALLBACK_MODEL ?? DEFAULT_DEEPINFRA_FAST_MODEL;
}

export function getDefaultOpenRouterModel(): string {
  return process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
}

export function getDefaultOpenRouterLatencyFallbackModel(): string {
  return process.env.OPENROUTER_LATENCY_FALLBACK_MODEL ?? DEFAULT_OPENROUTER_FAST_MODEL;
}

export function getDefaultCrazyRouterModel(): string {
  return process.env.CRAZYROUTER_MODEL ?? process.env.CRAZY_ROUTER_MODEL ?? DEFAULT_CRAZYROUTER_MODEL;
}

export function getDefaultCrazyRouterLatencyFallbackModel(): string {
  return process.env.CRAZYROUTER_LATENCY_FALLBACK_MODEL ?? process.env.CRAZY_ROUTER_LATENCY_FALLBACK_MODEL ?? DEFAULT_CRAZYROUTER_FAST_MODEL;
}

export function getDefaultOpenAiModel(): string {
  return process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
}

export function getDefaultNuralWattModel(): string {
  return process.env.NURALWATT_MODEL ?? DEFAULT_NURALWATT_MODEL;
}

export function getDefaultOpenAiLatencyFallbackModel(): string {
  return process.env.OPENAI_LATENCY_FALLBACK_MODEL ?? DEFAULT_OPENAI_FAST_MODEL;
}

export function getDefaultAnthropicModel(): string {
  return process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
}

export function getDefaultAnthropicLatencyFallbackModel(): string {
  return process.env.ANTHROPIC_LATENCY_FALLBACK_MODEL ?? DEFAULT_ANTHROPIC_FAST_MODEL;
}

export function getDefaultCerebrasModel(): string {
  return process.env.CEREBRAS_MODEL ?? DEFAULT_CEREBRAS_MODEL;
}

export function getDefaultCerebrasLatencyFallbackModel(): string {
  return process.env.CEREBRAS_LATENCY_FALLBACK_MODEL ?? DEFAULT_CEREBRAS_FAST_MODEL;
}

export function getDefaultMimoModel(): string {
  return process.env.MIMO_MODEL ?? DEFAULT_MIMO_MODEL;
}

export function getDefaultMimoLatencyFallbackModel(): string {
  return process.env.MIMO_LATENCY_FALLBACK_MODEL ?? DEFAULT_MIMO_FAST_MODEL;
}

export function getDefaultAzureOpenAiModel(): string {
  return process.env.AZURE_OPENAI_MODEL ?? DEFAULT_AZURE_OPENAI_MODEL;
}
