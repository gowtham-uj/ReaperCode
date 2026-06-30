const secretPatterns = [
  /([A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*)\s*[=:]\s*['"]?([A-Za-z0-9_\-]{12,})['"]?/gi,
  /(Bearer\s+)([A-Za-z0-9_\-]{12,})/gi,
];

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
  let redacted = value;
  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, (_match, prefix: string, secret: string) => `${prefix}${mask(secret)}`);
  }
  return redacted.replace(/[A-Za-z0-9_\-]{40,}/g, (token) => mask(token));
}

function mask(input: string): string {
  if (input.length <= 8) {
    return "[REDACTED]";
  }
  return `${input.slice(0, 4)}...[REDACTED]...${input.slice(-4)}`;
}
