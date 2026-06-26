import { createSessionEntry, type SessionEntry } from "../../session/session-manager.js";
import type { ModelGateway } from "../../model/types.js";

export interface SessionCompactionInput {
  entries: SessionEntry[];
  maxContextTokens: number;
  reserveTokens: number;
  keepRecentEntries?: number;
  modelGateway?: ModelGateway;
}

export interface SessionCompactionDetails {
  tokensBefore: number;
  cutIndex: number;
  readFiles: string[];
  modifiedFiles: string[];
  verificationCommands: string[];
}

export interface SessionCompactionResult {
  shouldCompact: boolean;
  retainedEntries: SessionEntry[];
  compactionEntry?: Extract<SessionEntry, { type: "compaction" }>;
  details: SessionCompactionDetails;
}

export async function estimateSessionTokens(
  entries: SessionEntry[],
  options: { modelGateway?: ModelGateway } = {},
): Promise<number> {
  const text = JSON.stringify(entries);
  if (options.modelGateway) {
    try {
      return await options.modelGateway.countTokens({ role: "fast_reasoner", text });
    } catch {
      // fall through to cheap estimate
    }
  }
  return Math.ceil(text.length / 4);
}

export function findCompactionCutIndex(
  entries: SessionEntry[],
  options: { keepRecentEntries?: number } = {},
): number {
  if (entries.length <= 2) return entries.length;
  const keepRecentEntries = Math.max(1, options.keepRecentEntries ?? 8);
  return Math.max(1, entries.length - keepRecentEntries);
}

export async function compactSessionHistory(input: SessionCompactionInput): Promise<SessionCompactionResult> {
  const tokensBefore = await estimateSessionTokens(
    input.entries,
    input.modelGateway ? { modelGateway: input.modelGateway } : {},
  );
  const budget = Math.max(0, input.maxContextTokens - input.reserveTokens);
  const cutIndex = findCompactionCutIndex(
    input.entries,
    input.keepRecentEntries !== undefined ? { keepRecentEntries: input.keepRecentEntries } : {},
  );
  const details: SessionCompactionDetails = {
    tokensBefore,
    cutIndex,
    ...collectFileOperationDetails(input.entries),
  };

  if (tokensBefore <= budget || cutIndex >= input.entries.length) {
    return { shouldCompact: false, retainedEntries: input.entries, details };
  }

  const root = input.entries.find((entry): entry is Extract<SessionEntry, { type: "session" }> => entry.type === "session");
  const rootId = root?.id ?? input.entries[0]?.id ?? "root";
  const firstKept = input.entries[cutIndex] ?? input.entries.at(-1);
  const summary = await summarizeEntries(input.entries.slice(0, cutIndex), details, input.modelGateway);
  const compactionEntry = createSessionEntry({
    type: "compaction",
    summary,
    firstKeptEntryId: firstKept?.id ?? rootId,
    tokensBefore,
    parentId: rootId,
  }) as Extract<SessionEntry, { type: "compaction" }>;

  const retainedTail = input.entries.slice(cutIndex);
  const retainedEntries = root ? [root, compactionEntry, ...retainedTail.filter((entry) => entry.id !== root.id)] : [compactionEntry, ...retainedTail];
  return { shouldCompact: true, retainedEntries, compactionEntry, details };
}

async function summarizeEntries(
  entries: SessionEntry[],
  details: SessionCompactionDetails,
  modelGateway?: ModelGateway,
): Promise<string> {
  if (modelGateway) {
    try {
      const result = await modelGateway.generate({
        role: "fast_reasoner",
        source: "session_compaction",
        responseFormat: "json",
        maxTokens: 1200,
        system: "Summarize the coding-agent session so a future turn can continue safely. Return JSON: {\"summary\": string}.",
        messages: [
          {
            role: "user",
            content: JSON.stringify({ entries, details }).slice(0, 80_000),
          },
        ],
      });
      const parsed = JSON.parse(result.content) as { summary?: unknown };
      if (typeof parsed.summary === "string" && parsed.summary.trim()) return parsed.summary.trim();
    } catch {
      // fall back below
    }
  }
  return buildHeuristicSummary(entries, details);
}

function buildHeuristicSummary(entries: SessionEntry[], details: SessionCompactionDetails): string {
  const firstUser = entries.find((entry) => entry.type === "message" && entry.role === "user") as Extract<SessionEntry, { type: "message" }> | undefined;
  const lastAssistant = [...entries].reverse().find((entry) => entry.type === "message" && entry.role === "assistant") as Extract<SessionEntry, { type: "message" }> | undefined;
  return [
    "Heuristic session summary:",
    firstUser ? `- User intent: ${renderContent(firstUser.content)}` : "- User intent: unknown",
    lastAssistant ? `- Last assistant state: ${renderContent(lastAssistant.content)}` : "- Last assistant state: unknown",
    details.readFiles.length ? `- Read files: ${details.readFiles.join(", ")}` : "- Read files: none recorded",
    details.modifiedFiles.length ? `- Modified files: ${details.modifiedFiles.join(", ")}` : "- Modified files: none recorded",
    details.verificationCommands.length ? `- Verification commands: ${details.verificationCommands.join("; ")}` : "- Verification commands: none recorded",
  ].join("\n");
}

function collectFileOperationDetails(entries: SessionEntry[]): Omit<SessionCompactionDetails, "tokensBefore" | "cutIndex"> {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  const verificationCommands = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const content = asRecord(entry.content);
    if (!content) continue;
    const name = typeof content.name === "string" ? content.name : undefined;
    const args = asRecord(content.args);
    const output = asRecord(content.output);
    const path = typeof args?.path === "string" ? args.path : typeof content.path === "string" ? content.path : undefined;
    if (path && ["read_file", "grep_search", "list_directory", "skim_file"].includes(name ?? "")) readFiles.add(path);
    if (path && ["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(name ?? "")) modifiedFiles.add(path);
    const cmd = typeof output?.cmd === "string" ? output.cmd : typeof args?.cmd === "string" ? args.cmd : undefined;
    if (cmd && /\b(test|pytest|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|go\s+test|tsc|lint)\b/i.test(cmd)) {
      verificationCommands.add(cmd);
    }
  }
  return {
    readFiles: [...readFiles].sort(),
    modifiedFiles: [...modifiedFiles].sort(),
    verificationCommands: [...verificationCommands].sort(),
  };
}

function renderContent(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 500);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
