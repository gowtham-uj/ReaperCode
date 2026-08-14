import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";
import { redactSecrets } from "./redaction.js";
import type { TrajectoryEntry } from "./schema.js";

export class ConversationLog {
  private readonly filePath: string;
  private readonly manifestPath: string;
  private headerWritten = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string, runId?: string) {
    const scratchpad = getReaperScratchpadPaths(workspaceRoot);
    const logsRoot = runId ? path.join(scratchpad.runs, runId, "logs") : scratchpad.logs;
    this.filePath = path.join(logsRoot, "conversation.md");
    this.manifestPath = path.join(logsRoot, "evidence-manifest.json");
  }

  get path(): string {
    return this.filePath;
  }

  async append(entry: TrajectoryEntry): Promise<void> {
    const slice = renderConversationSlice(entry);
    if (!slice) return;
    const next = this.writeChain.then(() => this.appendInternal(entry, slice));
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async appendInternal(entry: TrajectoryEntry, slice: string): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    if (!this.headerWritten) {
      let existing = "";
      try {
        existing = await readFile(this.filePath, "utf8");
      } catch {
        existing = "";
      }
      if (existing.trim()) {
        this.headerWritten = true;
      } else {
        const header = `# Conversation\n\nrun=${entry.run_id}  session=${entry.session_id}\n\nSystem prompt is not repeated here. See the first model-call JSON if you need the raw system text.\n\n`;
        await appendFile(this.filePath, header, "utf8");
        await writeFile(
          this.manifestPath,
          `${JSON.stringify(
            {
              trace: { file: "session.jsonl", role: "trace" },
              transcript: { file: "conversation.md", role: "transcript" },
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        this.headerWritten = true;
      }
    }
    await appendFile(this.filePath, slice, "utf8");
  }
}

export function renderConversationSlice(entry: TrajectoryEntry): string | undefined {
  const turn = "turn_index" in entry && typeof entry.turn_index === "number" ? ` t${entry.turn_index}` : "";
  if (entry.kind === "thinking") {
    return String(redactSecrets(`## thinking${turn}\n\n${entry.content}\n\n`));
  }
  if (entry.kind === "assistant_message") {
    const tools = entry.tool_names?.length ? `\ntools: ${entry.tool_names.join(", ")}` : "";
    return String(redactSecrets(`## assistant${turn}${tools}\n\n${entry.content || "(no text)"}\n\n`));
  }
  if (entry.kind === "tool_call" && entry.status !== "started") {
    const err = entry.is_error || entry.status === "failed" ? " error" : "";
    const dur = typeof entry.duration_ms === "number" ? ` ${entry.duration_ms}ms` : "";
    return String(redactSecrets(`## tool ${entry.tool_name}${turn}${err}${dur}\n\n`));
  }
  return undefined;
}
