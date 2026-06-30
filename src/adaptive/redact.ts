/**
 * Secret redaction. Used by the memory scope policy and the visual
 * context bridge before any content is persisted.
 *
 * Detected patterns:
 *  - AWS access key (AKIA / ASIA)
 *  - OpenAI/Anthropic-style API keys (sk-..., sk_live_, ghp_, ...)
 *  - Generic bearer tokens (Bearer xxx)
 *  - PEM private keys
 *  - Connection strings with embedded passwords
 *  - Common env assignments: TOKEN=, PASSWORD=, SECRET=, KEY=
 *  - Cookie values: session=..., auth=...
 *
 * Each match is replaced with the corresponding redacted token. The
 * redaction never reveals the secret, even partially.
 */

import type { Redaction } from "./types.js";

const PATTERNS: { name: string; re: RegExp; replacement: string | ((...args: string[]) => string) }[] = [
  { name: "aws-access-key", re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement: "[REDACTED:aws-access-key]" },
  { name: "openai-key",     re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,     replacement: "[REDACTED:openai-key]" },
  { name: "openai-proj",    re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED:openai-proj-key]" },
  { name: "github-token",   re: /\bghp_[A-Za-z0-9]{30,}\b/g,        replacement: "[REDACTED:github-token]" },
  { name: "anthropic-key",  re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,   replacement: "[REDACTED:anthropic-key]" },
  { name: "slack-token",    re: /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED:slack-token]" },
  { name: "stripe-key",     re: /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{16,}\b/g, replacement: "[REDACTED:stripe-key]" },
  { name: "google-api",     re: /\bAIza[0-9A-Za-z_-]{30,}\b/g,      replacement: "[REDACTED:google-api]" },
  { name: "pem-private",    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, replacement: "[REDACTED:private-key]" },
  { name: "bearer",         re: /\bBearer\s+[A-Za-z0-9._-]{16,}/g, replacement: "Bearer [REDACTED:bearer]" },
  { name: "basic-auth",     re: /\bBasic\s+[A-Za-z0-9+/=]{8,}/g,    replacement: "Basic [REDACTED:basic-auth]" },
  { name: "conn-string",    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:([^@\s/]+)@[^\s/]+/g, replacement: (m: string) => m.replace(/:[^@\s/]+@/, ":[REDACTED:password]@") },
  { name: "env-secret",     re: /\b(?:TOKEN|PASSWORD|SECRET|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTH[_-]?KEY|SESSION[_-]?KEY)(\s*[:=]\s*)["']?([^\s"',;]{6,})["']?/gi, replacement: (m: string, _sep: string, val: string) => m.replace(val, "[REDACTED]") },
  { name: "cookie",         re: /\b(?:session|sid|auth|token|access_token|id_token)\s*=\s*([A-Za-z0-9._-]{16,})/g, replacement: (m: string) => m.replace(/([A-Za-z0-9._-]{16,})/, "[REDACTED]") },
];

export function redactSecrets(input: string): { redacted: string; redactions: Redaction[] } {
  let redacted = input;
  const redactions: Redaction[] = [];
  for (const p of PATTERNS) {
    if (typeof p.replacement === "function") {
      const fn = p.replacement;
      redacted = redacted.replace(p.re, (...args: unknown[]) => {
        const original = String(args[0] ?? "");
        const replacement = fn(...(args as string[]));
        redactions.push({ original: redactForLog(original), redacted: replacement, reason: p.name });
        return replacement;
      });
    } else {
      const replacement = p.replacement;
      redacted = redacted.replace(p.re, (m: string) => {
        redactions.push({ original: redactForLog(m), redacted: replacement, reason: p.name });
        return replacement;
      });
    }
  }
  return { redacted, redactions };
}

function redactForLog(s: string): string {
  if (s.length <= 4) return "***";
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}
