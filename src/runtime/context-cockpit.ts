/**
 * Context Cockpit — single harness-authored user message rendered from
 * ContentPrepResult + bounded runtime facts. The exact current request is
 * sent as the following user message so it stays authoritative and unduplicated.
 *
 * Why a paired marker/version:
 *   The model must see this block once per live request, after any
 *   prior named-session history, with the current task at the recency
 *   edge. The engine inserts the cockpit on the first iteration of the
 *   autonomous loop; subsequent iterations do NOT rebuild or refresh
 *   the cockpit in place — the marker pair lets the engine find an
 *   existing cockpit so subsequent turns simply keep the one already
 *   in the conversation. Bumping COCKPIT_VERSION forces stale cockpits
 *   to be replaced on the next model call.
 */
import type { CodebaseIndex } from "../context/indexer.js";
import type { PreparedContext } from "../context/pruner.js";
import type { CompactedHistory } from "../context/history-compaction.js";
import type { Skill } from "../context/skills.js";
import type { EnvironmentFingerprint } from "./fingerprint.js";
import type { ContextFile } from "../resources/context-files.js";
import type { MentionResolution } from "../context/mentions.js";

/** Marker pair identifies the cockpit in the rendered conversation.
 *  Any single model turn may have at most ONE pair. */
export const COCKPIT_OPEN = "<<<REAPER_COCKPIT v1>>>";
export const COCKPIT_CLOSE = "<<<END_REAPER_COCKPIT>>>";
export const COCKPIT_VERSION = "1";
export const CURRENT_REQUEST_MESSAGE_NAME = "reaper_current_request";

/** Hard caps — the cockpit is bounded regardless of input size so
 *  large context files cannot starve the diagnostic / project /
 *  user / skills / runtime facts sections. */
export const COCKPIT_LIMITS = {
  maxEnvironmentBytes: 1_500,
  maxProjectContextBytes: 3_000,
  maxUserContextBytes: 3_000,
  maxSkillsBytes: 1_500,
  maxRuntimeFactsBytes: 1_000,
  hardCapBytes: 12_000,
} as const;

/** Render inputs. The cockpit is pure: identical inputs render to
 *  identical text bytes. Callers must hash or compare exact bytes
 *  to detect drift. */
export interface CockpitInput {
  preparedContext: PreparedContext;
  contextFiles: { files: ContextFile[]; diagnostics: string[] };
  skills: Skill[];
  /** All trusted skills known to the engine. Untrusted project skills
   *  are omitted before cockpit rendering. */
  resourceTrust: { trusted: boolean; requiresTrust?: boolean; diagnostics?: string[] };
  /** Skills loaded from the trusted project (filtered subset of
   *  `skills`). Omit when project is not trusted. */
  trustedSkills?: Skill[];
  environmentFingerprint: EnvironmentFingerprint;
  mentions: MentionResolution;
  /** Bounded runtime facts for this turn. */
  runtimeFacts: {
    activeWorkspaceRoot: string;
    latestVerificationFailure?: string;
  };
  /** Optional repo fingerprint used for diagnostics. */
  contentFingerprint?: string;
}

/** Renderer entry point. Always returns the cockpit text including
 *  the marker pair; never returns undefined so callers can rely on
 *  the bytes for byte-exact comparisons. */
export function renderContextCockpit(input: CockpitInput): string {
  const sections = [
    renderDiagnostics(input).join("\n\n"),
    truncateSection(renderEnvironment(input).join("\n\n"), COCKPIT_LIMITS.maxEnvironmentBytes),
    truncateSection(renderTrustedProjectContext(input).join("\n\n"), COCKPIT_LIMITS.maxProjectContextBytes),
    truncateSection(renderUserContext(input).join("\n\n"), COCKPIT_LIMITS.maxUserContextBytes),
    truncateSection(renderSkills(input).join("\n\n"), COCKPIT_LIMITS.maxSkillsBytes),
    truncateSection(renderRuntimeFacts(input).join("\n\n"), COCKPIT_LIMITS.maxRuntimeFactsBytes),
  ];
  const body = [COCKPIT_OPEN, ...sections, COCKPIT_CLOSE].join("\n\n");
  return truncateToHardCap(body);
}

/** Strip any existing cockpit marker pair from a list of messages,
 *  returning a new list. Used when reinserting the cockpit to
 *  guarantee exactly one pair. */
export function stripCockpitFromMessages<T extends { role?: string; content?: string }>(messages: T[]): T[] {
  return messages.filter((message) => {
    if (message.role !== "user") return true;
    if (typeof message.content !== "string") return true;
    return !containsCockpitMarker(message.content);
  });
}

/** Test/diagnostic helper: is this text the harness-authored cockpit? */
export function containsCockpitMarker(text: string): boolean {
  return text.startsWith(COCKPIT_OPEN) && text.endsWith(COCKPIT_CLOSE);
}

/** Count cockpit marker pairs in a text. Used by tests to assert
 *  exactly one pair exists in a rendered request.
 *
 *  Counts only the FIRST occurrence of each marker: a literal user
 *  request that contains `COCKPIT_OPEN` / `COCKPIT_CLOSE` substrings
 *  (e.g. quoted inside a task description) must not double-count. The
 *  cockpit's own marker is always the FIRST occurrence (rendered at
 *  the start of the body), so this matches the "exactly one pair"
 *  invariant the tests assert. */
export function countCockpitMarkers(text: string): { opens: number; closes: number } {
  const openIdx = text.indexOf(COCKPIT_OPEN);
  const closeIdx = text.indexOf(COCKPIT_CLOSE);
  return {
    opens: openIdx === -1 ? 0 : 1,
    closes: closeIdx === -1 ? 0 : 1,
  };
}

function renderDiagnostics(input: CockpitInput): string[] {
  const lines: string[] = [];
  lines.push("# Snapshot & trust diagnostics");
  const parts: string[] = [];
  parts.push(`cockpit_version=${COCKPIT_VERSION}`);
  parts.push(`content_fingerprint=${input.contentFingerprint ?? input.preparedContext.fingerprint}`);
  if (input.mentions.fileMentions.length) {
    parts.push(`file_mentions=${input.mentions.fileMentions.join(",")}`);
  }
  if (input.mentions.symbolMentions.length) {
    parts.push(`symbol_mentions=${input.mentions.symbolMentions.join(",")}`);
  }
  if (input.contextFiles.diagnostics.length) {
    parts.push(`context_file_diagnostics=${input.contextFiles.diagnostics.join(" | ")}`);
  }
  if (input.resourceTrust.diagnostics?.length) {
    parts.push(`trust_diagnostics=${input.resourceTrust.diagnostics.join(" | ")}`);
  }
  if (input.preparedContext.droppedPaths.length) {
    parts.push(`dropped_paths=${input.preparedContext.droppedPaths.length}`);
  }
  lines.push(parts.join("\n"));
  return lines;
}

function renderEnvironment(input: CockpitInput): string[] {
  const fp = input.environmentFingerprint;
  const lines: string[] = [];
  lines.push("# Compact environment");
  lines.push(`OS=${fp.os}`);
  lines.push(`Arch=${fp.arch}`);
  lines.push(`Node=${fp.nodeVersion}`);
  lines.push(`cwd=${fp.cwd}`);
  lines.push(`source=fingerprint.runtime;authority=runtime_fact`);
  return lines;
}

function renderTrustedProjectContext(input: CockpitInput): string[] {
  const lines: string[] = [];
  lines.push("# Trusted project context");
  if (!input.resourceTrust.trusted) {
    lines.push("(project instructions omitted: workspace is not trusted)");
    return lines;
  }
  const projectFiles = input.contextFiles.files.filter((file) => file.kind === "project");
  if (projectFiles.length === 0) {
    lines.push("(no project context files found)");
    return lines;
  }
  lines[0] = "# Trusted project context (instructions authority)";
  for (const file of projectFiles) {
    lines.push(`<<<PROJECT_CONTEXT: ${file.source}>>> (authority=project_instruction;trust=trusted)`);
    lines.push(file.content);
    lines.push(`<<<END_PROJECT_CONTEXT>>>`);
  }
  return lines;
}

function renderUserContext(input: CockpitInput): string[] {
  const lines: string[] = [];
  const userFiles = input.contextFiles.files.filter((file) => file.kind === "user");
  if (userFiles.length === 0) {
    lines.push("# User context (instructions authority)");
    lines.push("(no user context files)");
    return lines;
  }
  lines.push("# User context (instructions authority)");
  for (const file of userFiles) {
    lines.push(`<<<USER_CONTEXT: ${file.source}>>> (authority=user_instruction)`);
    lines.push(file.content);
    lines.push(`<<<END_USER_CONTEXT>>>`);
  }
  return lines;
}

function renderSkills(input: CockpitInput): string[] {
  const lines: string[] = [];
  const trustedSkills = input.trustedSkills ?? [];
  if (trustedSkills.length === 0) {
    lines.push("# Skill names");
    lines.push(input.resourceTrust.trusted
      ? "(no relevant trusted skills)"
      : "(project skills omitted: workspace is not trusted)");
    return lines;
  }
  lines.push("# Trusted skill names");
  lines.push(`source=skills;authority=project_instruction;trust=trusted;count=${trustedSkills.length}`);
  for (const skill of trustedSkills) {
    lines.push(`- ${skill.name}`);
  }
  return lines;
}

function renderRuntimeFacts(input: CockpitInput): string[] {
  const lines: string[] = [];
  lines.push("# Runtime facts");
  lines.push(`source=runtime;authority=runtime_fact`);
  lines.push(`active_workspace_root=${input.runtimeFacts.activeWorkspaceRoot}`);
  if (input.runtimeFacts.latestVerificationFailure) {
    lines.push(`latest_verification_failure=${input.runtimeFacts.latestVerificationFailure}`);
  }
  return lines;
}

function truncateSection(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buffer = Buffer.from(text, "utf8");
  let cut = Math.max(0, Math.min(maxBytes - 32, buffer.length));
  while (cut > 0 && cut < buffer.length && (buffer[cut]! & 0xC0) === 0x80) cut -= 1;
  return `${buffer.subarray(0, cut).toString("utf8")}\n...[section truncated]`;
}

function truncateToHardCap(body: string): string {
  if (Buffer.byteLength(body, "utf8") <= COCKPIT_LIMITS.hardCapBytes) {
    return body;
  }
  const head = body.slice(0, body.indexOf(COCKPIT_OPEN) + COCKPIT_OPEN.length + 1);
  const tail = body.slice(body.lastIndexOf(COCKPIT_CLOSE));
  const budget = COCKPIT_LIMITS.hardCapBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8") - 8;
  if (budget <= 0) {
    return `${head}\n${tail}`;
  }
  const middle = body.slice(head.length, body.length - tail.length);
  // Slice the middle in BYTES against the byte budget. The naive
  // `.toString("utf8")` on a byte subarray cut mid-codepoint emits
  // U+FFFD replacement characters; back the cut down to the nearest
  // full codepoint so the boundary is always valid UTF-8. A UTF-8
  // continuation byte has its top two bits set to `10` (mask 0xC0,
  // result 0x80); walking back past the leading byte (whose top bits
  // are NOT `10`) places the cut at a complete codepoint boundary.
  const middleBuf = Buffer.from(middle, "utf8");
  let cut = Math.max(0, Math.min(budget, middleBuf.length));
  while (cut > 0 && cut < middleBuf.length && (middleBuf[cut]! & 0xC0) === 0x80) {
    cut -= 1;
  }
  const truncatedMiddle = middleBuf.subarray(0, cut).toString("utf8");
  return `${head}${truncatedMiddle}\n${tail}`;
}

export const _internals = {
  renderDiagnostics,
  renderEnvironment,
  renderTrustedProjectContext,
  renderUserContext,
  renderSkills,
  renderRuntimeFacts,
  truncateSection,
};