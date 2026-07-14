import { redactSecrets as redactSecretText } from "../adaptive/redact.js";

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
      if (/(key|token|secret)$/i.test(key) && typeof entry === "string") {
        result[key] = mask(entry);
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
