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
  { name: "openai-proj",    re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED:openai-proj-key]" },
  { name: "openai-key",     re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,     replacement: "[REDACTED:openai-key]" },
  { name: "openai-session", re: /\bsess-[A-Za-z0-9_-]{20,}\b/g,   replacement: "[REDACTED:openai-session-key]" },
  { name: "github-classic", re: /\bghp_[A-Za-z0-9]{30,}\b/g,      replacement: "[REDACTED:github-token]" },
  { name: "github-scoped",  re: /\bgh[os]_[A-Za-z0-9]{30,}\b/g,   replacement: "[REDACTED:github-token]" },
  { name: "github-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, replacement: "[REDACTED:github-token]" },
  { name: "anthropic-key",  re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,   replacement: "[REDACTED:anthropic-key]" },
  { name: "slack-token",    re: /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED:slack-token]" },
  { name: "stripe-key",     re: /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{16,}\b/g, replacement: "[REDACTED:stripe-key]" },
  { name: "google-api",     re: /\bAIza[0-9A-Za-z_-]{30,}\b/g,      replacement: "[REDACTED:google-api]" },
  { name: "sendgrid-key",   re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED:sendgrid-key]" },
  { name: "pem-private",    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, replacement: "[REDACTED:private-key]" },
  { name: "bearer",         re: /\bBearer\s+[A-Za-z0-9._-]{16,}/g, replacement: "Bearer [REDACTED:bearer]" },
  { name: "basic-auth",     re: /\bBasic\s+[A-Za-z0-9+/=]{8,}/g,    replacement: "Basic [REDACTED:basic-auth]" },
  { name: "conn-string",    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:([^@\s/]+)@[^\s/]+/g, replacement: (m: string) => m.replace(/:[^@\s/]+@/, ":[REDACTED:password]@") },
  /*
   * Environment assignments whose *name* says it holds a credential.
   *
   * The first version anchored the alternatives with `\b`, which is wrong for
   * the commonest form of all: `_` is a word character, so there is no boundary
   * between `ANTHROPIC_AUTH_` and `TOKEN`, and every prefixed name slipped
   * through. Measured on this box: `ANTHROPIC_AUTH_TOKEN=cpa_...`,
   * `DEEPSEEK_API_KEY=sk-...` and `NURALWATT_API_KEY=...` all survived
   * redaction verbatim and were written to the trajectory, while a bare
   * `TOKEN=...` was caught.
   *
   * The fix is to allow the name to be *anything* ending in one of these
   * suffixes, so the vendor prefix is irrelevant. `\w*` before the suffix
   * covers `ANTHROPIC_`, `MY_APP_CLIENT_` and everything else, and a leading
   * `(?:^|[^\w])` is what keeps the match from starting mid-word: without it,
   * `SOMETOKEN=` would match from `TOKEN=`. No `\b` at the end, because `=`
   * and `:` follow a name and neither is a word character.
   *
   * The suffix list has to include the `AUTH_TOKEN` and `ACCESS_TOKEN` shapes,
   * because a name ending in `_AUTH_TOKEN` is a credential whatever precedes
   * it. The value must still be at least six characters, so a sentence that
   * ends in a word like "secret" is not redacted.
   */
  { name: "env-secret",     re: /(?:^|[^\w])\w*(?:TOKEN|PASSWORD|PASSWD|SECRET|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTH_KEY|SESSION_KEY|CREDENTIAL)\w*(\s*[:=]\s*)["']?([^\s"',;]{6,})["']?/gi, replacement: (m: string, _sep: string, val: string) => m.replace(val, "[REDACTED]") },
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
  // Never reveal a usable fragment. Anything short enough that a
  // first2/last2 slice would expose most of the value is masked
  // wholesale; longer values keep only a 2-char prefix/suffix anchor.
  if (s.length <= 8) return "***";
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}
