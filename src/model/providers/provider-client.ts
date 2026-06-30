import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ResolvedModelProfile,
  StreamEvent,
} from "../types.js";
import type { ProviderModelClient } from "../gateway.js";
import { AnthropicClient } from "./anthropic.js";
import { CerebrasClient } from "./cerebras.js";
import { DeepSeekClient } from "./deepseek.js";
import { LiteLLMProviderClient, type LiteLLMGatewayOptions } from "./litellm-gateway.js";
import {
  bindProvidersToFamily,
  registerFamily,
  resolveProviderClient,
} from "../provider-registry.js";

export interface ProviderClientOptions extends LiteLLMGatewayOptions {
  deepseek?: DeepSeekClient;
  cerebras?: CerebrasClient;
  anthropic?: AnthropicClient;
  openAiCompatible?: LiteLLMProviderClient;
}

/**
 * Dispatches requests by the resolved profile provider, enabling
 * mixed-provider model configs.
 *
 * Phase T3.15: now built on top of the unified `provider-registry`.
 * The hard-coded switch that previously lived in `clientFor` has
 * been replaced with a data-driven lookup; the multiplexer only
 * owns the lifecycle of the underlying HTTP clients and delegates
 * dispatch to `resolveProviderClient`.
 *
 * Backward-compatible: the `deepseek` / `cerebras` / `anthropic` /
 * `openAiCompatible` constructor options still inject custom client
 * instances. The default constructor wires the built-in HTTP
 * clients into the registry.
 */
export class ProviderMultiplexerClient implements ProviderModelClient {
  private readonly deepseek: DeepSeekClient;
  private readonly cerebras: CerebrasClient;
  private readonly anthropic: AnthropicClient;
  private readonly openAiCompatible: LiteLLMProviderClient;

  constructor(options: ProviderClientOptions = {}) {
    this.deepseek = options.deepseek ?? new DeepSeekClient();
    this.cerebras = options.cerebras ?? new CerebrasClient();
    this.anthropic = options.anthropic ?? new AnthropicClient();
    this.openAiCompatible = options.openAiCompatible ?? new LiteLLMProviderClient(options);

    // Phase T3.15: register built-in families and provider-name
    // bindings. Re-registration is safe (it replaces the prior
    // resolver) so multiple `ProviderMultiplexerClient` instances
    // can coexist — the last one to register wins, but since they
    // all bind the same set of names → families, the result is
    // identical.
    registerFamily("anthropic-messages", () => this.anthropic);
    registerFamily("openai-chat", () => this.openAiCompatible);
    bindProvidersToFamily(
      [
        "anthropic",
        "openai",
        "openrouter",
        "crazyrouter",
        "deepinfra",
        "mimo",
        "minimax",
        "nuralwatt",
        "zai",
        "azure",
        "litellm",
        "cerebras",
        "deepseek",
      ],
      "openai-chat",
    );
    // Phase T3.15: route cerebras and deepseek to their own
    // purpose-built clients (they have non-standard streaming
    // quirks — DeepSeek SSE-include_usage, Cerebras retry-backoff).
    // These bindings override the broad openai-chat binding above.
    bindProvidersToFamily(["deepseek"], "deepseek-direct");
    bindProvidersToFamily(["cerebras"], "cerebras-direct");
    registerFamily("deepseek-direct", () => this.deepseek);
    registerFamily("cerebras-direct", () => this.cerebras);
    // Anthropic speaks the native Anthropic Messages wire, not the
    // OpenAI-compatible one. It gets its own family binding after the
    // broad openai-chat binding so it overrides the default.
    bindProvidersToFamily(["anthropic"], "anthropic-messages");
    registerFamily("anthropic-messages", () => this.anthropic);
  }

  generate(request: GenerateRequest, profile: ResolvedModelProfile): Promise<GenerateResult> {
    return resolveProviderClient(profile).generate(request, profile);
  }

  stream(request: GenerateRequest, profile: ResolvedModelProfile): AsyncIterable<StreamEvent> {
    return resolveProviderClient(profile).stream(request, profile);
  }

  embed(request: EmbeddingRequest, profile: ResolvedModelProfile): Promise<EmbeddingResult> {
    return resolveProviderClient(profile).embed(request, profile);
  }

  async dispose(): Promise<void> {
    const clients: ProviderModelClient[] = [
      this.deepseek,
      this.cerebras,
      this.anthropic,
      this.openAiCompatible,
    ];
    await Promise.all([...new Set(clients)].map((client) => client.dispose?.()));
  }
}
