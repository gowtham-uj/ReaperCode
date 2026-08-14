import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { redactSecrets } from "./redaction.js";
import {
  buildSessionHeader,
  createSessionClock,
  mapTrajectoryToMutations,
  parseSessionLine,
  type SessionClock,
  type SessionHeader,
  type SessionMutation,
} from "./session-format.js";
import type { TrajectoryEntry } from "./schema.js";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

export class SessionLogWriter {
  private readonly filePath: string;
  private readonly cwd: string;
  private clock: SessionClock;
  private headerWritten = false;
  private leafId: string | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private sessionId: string | undefined;
  private resumeChecked = false;

  constructor(workspaceRoot: string, options?: { runId?: string; filename?: string }) {
    const scratchpad = getReaperScratchpadPaths(workspaceRoot);
    const logsRoot = options?.runId ? path.join(scratchpad.runs, options.runId, "logs") : scratchpad.logs;
    this.filePath = path.join(logsRoot, options?.filename ?? "session.jsonl");
    this.cwd = workspaceRoot;
    this.clock = createSessionClock();
  }

  get path(): string {
    return this.filePath;
  }

  async writeTrajectory(entry: TrajectoryEntry): Promise<SessionMutation[]> {
    const next = this.writeChain.then(() => this.writeTrajectoryInternal(entry));
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async ensureResumeState(): Promise<void> {
    if (this.resumeChecked) return;
    this.resumeChecked = true;
    let raw = "";
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    if (!raw.trim()) return;

    let maxSeq = 0;
    let lastEntryId: string | null = null;
    let sawHeader = false;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { kind?: string; type?: string; seq?: number; id?: string };
        if (parsed.kind === "header") {
          sawHeader = true;
          continue;
        }
        if (typeof parsed.seq === "number" && Number.isFinite(parsed.seq)) {
          maxSeq = Math.max(maxSeq, parsed.seq);
        }
        if (parsed.kind === "entry" && typeof parsed.id === "string") {
          lastEntryId = parsed.id;
        }
      } catch {
        /* ignore corrupt prior lines */
      }
    }
    if (!sawHeader) return;
    this.headerWritten = true;
    this.leafId = lastEntryId;
    this.clock = createSessionClock({ seq: maxSeq, ids: maxSeq });
  }

  private async writeTrajectoryInternal(entry: TrajectoryEntry): Promise<SessionMutation[]> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.ensureResumeState();
    if (!this.headerWritten) {
      this.sessionId = entry.session_id;
      const header: SessionHeader = buildSessionHeader({
        id: entry.session_id,
        cwd: this.cwd,
        metadata: {
          runId: entry.run_id,
          sessionId: entry.session_id,
          traceId: entry.trace_id,
        },
      });
      parseSessionLine(header);
      await appendFile(this.filePath, `${JSON.stringify(redactSecrets(header))}\n`, "utf8");
      this.headerWritten = true;
    }

    const mutations = mapTrajectoryToMutations(entry, this.clock, {
      lane: "main",
      leafId: this.leafId,
      runId: entry.run_id,
    });
    for (const mutation of mutations) {
      parseSessionLine(mutation);
      await appendFile(this.filePath, `${JSON.stringify(redactSecrets(mutation))}\n`, "utf8");
      if (mutation.kind === "entry") {
        this.leafId = mutation.id;
      }
    }
    return mutations;
  }
}
