import { parseAuditEntry, type AuditEntry } from "./schema.js";
import { JsonlStorage } from "./storage.js";
import { logLangfuseEvent } from "./langfuse.js";

export class AuditLogger {
  private readonly storage: JsonlStorage;
  private readonly legacyStorage: JsonlStorage | undefined;
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string, options?: { runId?: string }) {
    this.workspaceRoot = workspaceRoot;
    this.storage = new JsonlStorage({ workspaceRoot, filename: "reaper-audit.jsonl", ...(options?.runId ? { runId: options.runId } : {}) });
    this.legacyStorage = options?.runId ? new JsonlStorage({ workspaceRoot, filename: "reaper-audit.jsonl" }) : undefined;
  }

  async write(entry: AuditEntry): Promise<void> {
    const parsed = parseAuditEntry(entry);
    await this.storage.append(parsed);
    await this.legacyStorage?.append(parsed);
    await logLangfuseEvent({
      workspaceRoot: this.workspaceRoot,
      name: `reaper.audit.${parsed.kind}`,
      type: "event",
      output: parsed,
      level: parsed.severity === "error" ? "ERROR" : "WARNING",
      statusMessage: parsed.message,
      metadata: parsed as unknown as Record<string, unknown>,
      trace: { runId: parsed.run_id, sessionId: parsed.session_id, traceId: parsed.trace_id },
    });
  }

  get path() {
    return this.storage.path;
  }
}
