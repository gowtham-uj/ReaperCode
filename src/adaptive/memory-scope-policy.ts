/**
 * MemoryScopePolicy — decide where a candidate memory should go and
 * whether it should be stored, skipped, or redacted first.
 *
 * Rules:
 *  - Secrets are never stored as raw values. They are redacted to
 *    "Project uses X in environment" or skipped.
 *  - User-explicit preferences may go to user scope, but only if the
 *    text starts with "always"/"never"/"I prefer"/etc. or comes from
 *    a tagged user-input source.
 *  - Repo-specific facts (mentions of files, commands, manifests)
 *    go to project scope.
 *  - Machine-specific facts (paths, OS, installed tools) go to
 *    machine scope.
 *  - Successful validations from the same repo go to project scope.
 *  - Speculative inferences below confidence 0.5 are skipped.
 *  - Contradictory memory candidates trigger an "ask" decision.
 */


import type { MemoryDecision,  MemoryKind,  MemoryRecord,  MemoryScope,  MemorySource} from "./types.js";
import { redactSecrets } from "./redact.js";

const USER_EXPLICIT_PREFIXES = /^(always|never|i prefer|i always|i never|please always|please never|remember that|note:)\b/i;

export interface MemoryScopePolicyInput {
  content: string;
  kind: MemoryKind;
  source: MemorySource;
  confidence: number;
  evidenceCount: number;
  /** Repo context: file paths, commands, package manager hints. */
  repoSignals: { files: string[]; commands: string[]; manifests: string[] };
  /** Existing memories that might contradict this one. */
  existing?: MemoryRecord[];
}

export class MemoryScopePolicy {
  decide(input: MemoryScopePolicyInput): MemoryDecision {
    // 1. Always redact secrets first.
    const { redacted, redactions } = redactSecrets(input.content);
    if (redactions.length > 0) {
      // If the redacted content is only metadata, allow with redaction.
      const isSafeMeta = /environment variable|env var|set (?:the )?(?:env|environment)/i.test(redacted);
      if (isSafeMeta) {
        return {
          action: "redact_then_store",
          scope: this.inferScope(input),
          reason: "redacted secret to environment-variable metadata",
          redactions,
        };
      }
      // If the candidate is just a secret value, skip entirely.
      if (redacted.replace(/\[REDACTED[^\]]*\]/g, "").trim().length < 4) {
        return { action: "skip", reason: "candidate is a secret value; storing as metadata is not appropriate here", redactions };
      }
    }

    // 2. Low confidence → skip.
    if (input.confidence < 0.5) {
      return { action: "skip", reason: `confidence ${input.confidence.toFixed(2)} < 0.5`, redactions };
    }

    // 3. Contradiction → ask.
    if (input.existing && input.existing.length > 0) {
      const contradiction = findContradiction(redacted, input.existing);
      if (contradiction) {
        return { action: "ask", reason: `contradicts existing memory "${contradiction.content.slice(0, 60)}…"`, redactions };
      }
    }

    // 4. Determine scope.
    const scope = this.inferScope(input);

    return { action: "store", scope, reason: this.explain(input, scope), redactions };
  }

  private inferScope(input: MemoryScopePolicyInput): MemoryScope {
    if (input.source === "user_explicit" && USER_EXPLICIT_PREFIXES.test(input.content)) {
      return "user";
    }
    if (input.source === "user_explicit") return "user";
    if (input.repoSignals.files.length > 0 || input.repoSignals.commands.length > 0 || input.repoSignals.manifests.length > 0) {
      return "project";
    }
    if (input.kind === "environment_fact" || /\b(linux|macos|darwin|windows|installed at|\/usr\/|\/opt\/|~|\.config)\b/i.test(input.content)) {
      return "machine";
    }
    if (input.source === "successful_validation") return "project";
    if (input.source === "screenshot_analysis") return "project";
    return "transient";
  }

  private explain(input: MemoryScopePolicyInput, scope: MemoryScope): string {
    if (scope === "user") return "user-explicit preference";
    if (scope === "project") {
      if (input.repoSignals.files.length > 0) return `references repo files: ${input.repoSignals.files.slice(0, 3).join(", ")}`;
      if (input.repoSignals.commands.length > 0) return `references repo commands: ${input.repoSignals.commands.slice(0, 3).join(", ")}`;
      return "repo-specific fact";
    }
    if (scope === "machine") return "machine-specific fact";
    return "transient observation";
  }
}

function findContradiction(content: string, existing: MemoryRecord[]): MemoryRecord | null {
  const lower = content.toLowerCase();
  for (const r of existing) {
    if (r.scope === "secret") continue;
    if (r.content.toLowerCase() === lower) continue;
    const rLower = r.content.toLowerCase();
    // Token-level contradiction. We check each pair of package managers
    // or alternatives. The check is "new mentions A, old mentions B" or
    // "new mentions B, old mentions A" — captures both directions.
    const options = ["npm", "pnpm", "yarn", "bun"];
    for (const a of options) {
      for (const b of options) {
        if (a === b) continue;
        if (lower.includes(a) && rLower.includes(b)) return r;
        if (lower.includes(b) && rLower.includes(a)) return r;
      }
    }
  }
  return null;
}
