# Provider and model architecture

Reaper resolves providers and models from a pinned Models.dev catalog snapshot and runs turns through AI SDK transports. The agent loop never sees any of this: it calls `ModelGateway.generate/stream/embed` with a vendor-agnostic request and receives vendor-agnostic `GenerateResult`/`StreamEvent` values.

## Layers

| Layer | File | Responsibility |
|---|---|---|
| Catalog | `models-dev-catalog.ts`, `models-dev.json` | Provider/model metadata, snapshot + user cache + background refresh |
| Auth | `integration-registry.ts`, `auth-integrations.ts`, `../../config/provider-credentials.ts` | API-key, OAuth, and prompted auth; write-only secret storage |
| Loader table | `transports.ts` | npm identity → AI SDK provider factory (lazy dynamic import) |
| Provider quirks | `transport-options.ts` | Per-provider option shaping, endpoint construction, model selection |
| Client | `../providers/ai-sdk-client.ts` | Reaper ↔ AI SDK translation, streaming normalization |
| Dispatch | `../provider-registry.ts`, `../providers/provider-client.ts` | provider id → family → client |

## Dispatch order

`ProviderMultiplexerClient` binds families in this order, last write winning:

1. A broad `openai-chat` binding for the legacy hard-coded provider list.
2. Purpose-built overrides: `deepseek-direct`, `cerebras-direct`, `anthropic-messages`, `codex-responses`.
3. `ai-sdk` for every remaining catalog provider.

Legacy clients keep serving the providers they were tested against; everything else in the catalog routes through the AI SDK. An unknown provider with no API base URL is an error — it is never silently pointed at a local LiteLLM proxy.

## Legacy families

The two hand-written wire families remain for the legacy clients:

| Family | SDK file | Wire path |
|---|---|---|
| `openai-chat` | `families/openai-chat.ts` | `POST /chat/completions` |
| `anthropic-messages` | `families/anthropic-messages.ts` | `POST /v1/messages` |

## Credentials

Keys and OAuth tokens are stored write-only in `~/.reaper/providers.json` (`0600`) and never returned to the browser. They reach a transport per call on `ResolvedModelProfile.apiKey`; the process environment is never mutated, so concurrent threads on different providers cannot race. Non-secret endpoint settings (region, project, resource name, account id) travel separately through `ProviderCredentialStore.metadataFor`.

## Adding a provider or transport

Catalog providers need no code. To support a new npm transport identity:

1. Install the package and add a loader to `TRANSPORT_LOADERS` in `transports.ts`.
2. Add a case to `resolveTransport` in `transport-options.ts` if the provider needs option shaping.
3. Run `npm run sync:transports` to regenerate `TRANSPORTS.md`.

`TRANSPORTS.md` is the checked-in coverage table; `tests/unit/model/transport-coverage.test.ts` fails if any catalog identity lacks a loader or the table is stale.

## Refreshing the catalog

```
npm run sync:models      # refresh models-dev.json + snapshot metadata
npm run sync:transports  # regenerate TRANSPORTS.md, exits non-zero on a missing loader
```

A refresh may introduce an unknown transport identity. Those models stay listed but unavailable until a loader exists; they are never advertised as runnable.
