/**
 * Provider capability routing for the Reaper runtime.
 *
 * Different models support different combinations of:
 *
 * - native tool calling (`tools: [...]` in the request body, returned
 *   as `tool_calls` in the response)
 * - JSON response mode (`response_format: { type: "json_object" }`)
 * - structured output (typed JSON-schema responses)
 * - streaming
 *
 * A Codex/Claude/OpenCode-style agent picks the right strategy per
 * model so the prompt format matches what the model can actually
 * parse. This module is the routing decision for that.
 *
 * Strategy matrix:
 *
 * - `native_tools`     — the model supports native tool calling;
 *                       `request.tools` is passed through, response
 *                       emits `tool_calls`. Preferred when available.
 * - `json_envelope`    — the model supports JSON mode but not tools;
 *                       `request.tools` is encoded as a "tool envelope"
 *                       in the system message and the model emits a
 *                       single JSON object that the runtime parses
 *                       into tool calls.
 * - `text_fallback`    — neither native tools nor JSON mode; the
 *                       model emits free-form text and the runtime
 *                       parses it via regex/heuristic. This is the
 *                       least reliable mode and we never reach it
 *                       for the main agent, but it covers legacy /
 *                       small models.
 */

import type { ModelCapabilities } from "./types.js";

export type CapabilityStrategy = "native_tools" | "json_envelope" | "text_fallback";

export interface RoutingDecision {
  strategy: CapabilityStrategy;
  /** Reason string suitable for telemetry. */
  reason: string;
  /**
   * When true, the request should pass `tools` through to the
   * provider. Otherwise tools are encoded in the prompt envelope.
   */
  passNativeTools: boolean;
  /**
   * When true, the request should set `response_format: json_object`
   * (or the equivalent provider option).
   */
  useJsonMode: boolean;
  /**
   * Optional recommended tool envelope prefix to inject into the
   * system message when strategy is `json_envelope`.
   */
  jsonEnvelopeTemplate?: string;
}

export interface RoutingInput {
  capabilities: ModelCapabilities | undefined;
  /** True if the caller wants to use native tool calling. */
  wantsToolCalling: boolean;
}

export function routeForCapabilities(input: RoutingInput): RoutingDecision {
  const caps = input.capabilities;
  if (!caps) {
    return {
      strategy: "json_envelope",
      reason: "no capabilities advertised; default to safe JSON envelope",
      passNativeTools: false,
      useJsonMode: true,
      jsonEnvelopeTemplate: DEFAULT_JSON_ENVELOPE,
    };
  }

  // 1. Native tools + caller wants them.
  if (input.wantsToolCalling && caps.toolCalling) {
    return {
      strategy: "native_tools",
      reason: "capabilities.toolCalling=true and caller requested tool calling",
      passNativeTools: true,
      // When the provider supports both tools and JSON mode, prefer
      // tools + native JSON rather than forcing response_format.
      useJsonMode: false,
    };
  }

  // 2. JSON mode is available (model supports response_format but
  // not native tool calling, or caller does not want tool calling).
  if (caps.jsonMode) {
    return {
      strategy: "json_envelope",
      reason: input.wantsToolCalling
        ? "caller wants tool calling but capabilities.toolCalling=false; falling back to JSON envelope"
        : "caller does not want tool calling; using JSON envelope",
      passNativeTools: false,
      useJsonMode: true,
      jsonEnvelopeTemplate: DEFAULT_JSON_ENVELOPE,
    };
  }

  // 3. No structured output: free-form text fallback.
  return {
    strategy: "text_fallback",
    reason: "no toolCalling or jsonMode; using text fallback (least reliable)",
    passNativeTools: false,
    useJsonMode: false,
  };
}

/**
 * Default JSON envelope for tools that do not support native tool
 * calling. The model is asked to emit one JSON object with a
 * `tool_calls` array of `{id, name, arguments}` entries — the same
 * shape native tool calls use, so downstream parsing is unchanged.
 */
export const DEFAULT_JSON_ENVELOPE = `Respond with a single JSON object matching this schema:
{
  "assistant_message": string,
  "tool_calls": [
    {
      "id": string,
      "name": string,
      "arguments": object
    }
  ]
}
Do not include prose outside the JSON. Use assistant_message only for
blockers or final user-visible status.`;

export function capabilityRoutingSummary(
  capabilities: ModelCapabilities | undefined,
): string {
  if (!capabilities) return "capabilities: <none>";
  const flags: string[] = [];
  if (capabilities.streaming) flags.push("stream");
  if (capabilities.toolCalling) flags.push("tools");
  if (capabilities.jsonMode) flags.push("json");
  if (capabilities.structuredOutput) flags.push("structured");
  if (capabilities.embeddings) flags.push("embeddings");
  const ctx = capabilities.maxContextTokens ? ` ctx=${capabilities.maxContextTokens}` : "";
  const out = capabilities.maxOutputTokens ? ` out=${capabilities.maxOutputTokens}` : "";
  return `capabilities: ${flags.join(",") || "<none>"}${ctx}${out}`;
}
