# Model API standardization

Reaper only supports two standard API shapes: **OpenAI Chat Completions** and **Anthropic Messages**. Every provider in the catalog must map to one of these families.

## Supported request/response families

| Family | SDK file | Wire path | Response schema |
|---|---|---|---|
| `openai-chat` | `src/model/provider/families/openai-chat.ts` | `POST /chat/completions` | `OpenAIChatResponseSchema` |
| `anthropic-messages` | `src/model/provider/families/anthropic-messages.ts` | `POST /v1/messages` | `AnthropicMessagesResponseSchema` |

## Why only two shapes

* The entire agent loop calls `ModelGateway.generate/stream` with a single vendor-agnostic request and receives a single vendor-agnostic `GenerateResult`/`StreamEvent`.
* Translation into vendor-specific JSON happens inside the family adapters, not in the engine.
* Providers that expose their own quirks (DeepSeek SSE `include_usage`, Cerebras retry/backoff) are still **responses in the OpenAI Chat Completions shape**, so they are handled by the `openai-chat` family post-processing, not by declaring a third family.

## Adding a new provider

1. Open `src/model/provider/catalog.ts`.
2. Add a `ProviderDescriptor` with `sdkFamily: "openai-chat"` or `sdkFamily: "anthropic-messages"`.
3. Set `envVar`, `baseUrl`, `defaultModel`, `models`, and `capabilities`.
4. Add a test in `tests/unit/model/provider-standardization.test.ts` asserting the provider is one of the two supported families.
5. No code changes in `src/runtime/`, `src/model/gateway.ts`, or `src/model/provider-registry.ts` are required.

## What is *not* supported

* Custom per-provider request/response bodies declared outside the two families.
* Ad-hoc clients that bypass `ProviderCallInput`/`ProviderCallResult`.
* Legacy `generate(request, profile)` callers are gradually migrated to the family adapters; new code should use `buildProvider` from `src/model/provider/registry.js`.
