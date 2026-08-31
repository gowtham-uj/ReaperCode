import { redactSecrets as redactSecretText } from "../adaptive/redact.js";

/**
 * Structural redaction: mask any object field whose key names a
 * credential (token, key, secret, password, credential, authorization,
 * cookie, …) regardless of casing or separator style. The value is
 * masked wholesale so a field like `headers.authorization` or
 * `x-api-key` can never leak a raw credential even when the regex
 * scanner doesn't recognize the value's shape. String values still go
 * through the regex scanner as a second line of defense.
 */
const SENSITIVE_KEY = /(key|token|secret|password|passwd|credential|authorization|cookie)/i;
// Token COUNTS are observability metadata, not credentials. The bare
// `token` keyword above would otherwise mask `inputTokens`/`outputTokens`
// (LLM usage numbers) as if they were bearer tokens.
const TOKEN_COUNT_KEY = /tokens$|token_?count$|token_?usage$/i;

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const isCredentialKey = SENSITIVE_KEY.test(key) && !TOKEN_COUNT_KEY.test(key);
      if (isCredentialKey && (typeof entry === "string" || typeof entry === "number")) {
        result[key] = mask(String(entry));
      } else {
        result[key] = redactSecrets(entry);
      }
    }
    return result;
  }
  return value;
}

function redactString(value: string): string {
  return redactSecretText(value).redacted;
}

function mask(input: string): string {
  if (input.length <= 8) {
    return "[REDACTED]";
  }
  return `${input.slice(0, 4)}...[REDACTED]...${input.slice(-4)}`;
}
