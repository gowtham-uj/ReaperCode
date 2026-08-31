import type { SessionMessage } from "../context/session-journal.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import type { ThreadEventRecord } from "./event-bus.js";
import type { ThreadMetadata } from "./thread-store.js";

export type AppTurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export type AppThreadItem =
  | { type: "userMessage"; id: string; content: Array<{ type: "text"; text: string }> }
  | { type: "agentMessage"; id: string; text: string; phase: "commentary" | "final_answer" }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | { type: "commandExecution"; id: string; command: string; cwd?: string; status: "inProgress" | "completed" | "failed"; aggregatedOutput?: string; exitCode?: number; durationMs?: number }
  | { type: "fileChange"; id: string; changes: Array<{ path: string; kind: string; diff?: string }>; status: "inProgress" | "completed" | "failed" }
  | { type: "dynamicToolCall"; id: string; tool: string; arguments: Record<string, unknown>; status: "inProgress" | "completed" | "failed"; result?: unknown; error?: string }
  | { type: "contextCompaction"; id: string };

export interface AppTurn {
  id: string;
  status: AppTurnStatus;
  items: AppThreadItem[];
  error?: { message: string; additionalDetails?: string };
}

export interface AppThread {
  id: string;
  sessionId: string;
  preview: string;
  ephemeral: false;
  cwd: string;
  modelProvider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  name?: string;
  status: "notLoaded" | "idle" | "systemError" | { type: "active"; activeFlags: string[] };
  turns?: AppTurn[];
}

export interface ProjectedNotification {
  method: string;
  params: Record<string, unknown>;
}

interface MutableTurn {
  turn: AppTurn;
  items: Map<string, AppThreadItem>;
}

export class SessionProjection {
  private readonly turns = new Map<string, MutableTurn>();

  project(record: ThreadEventRecord, metadata?: ThreadMetadata): ProjectedNotification[] {
    const threadId = record.threadId;
    const turnId = record.turnId;
    const event = record.event;
    const base = {
      threadId,
      ...(turnId ? { turnId } : {}),
      sequence: record.sequence,
      timestamp: record.timestamp,
    };

    switch (event.type) {
      case "thread.started":
        return [{ method: "thread/started", params: { ...base, thread: metadata ? projectThread(metadata) : { id: threadId } } }];
      case "thread.status.changed":
        return [{ method: "thread/status/changed", params: { ...base, status: projectStatus(event.status) } }];
      case "thread.closed":
        return [{ method: "thread/closed", params: base }];
      case "turn.queued":
        return [{ method: "turn/queued", params: base }];
      case "turn.user.message": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        const item: AppThreadItem = {
          type: "userMessage",
          id: `${turnId}:user-message`,
          content: [{ type: "text", text: event.text }],
        };
        this.putItem(mutable, item);
        return [];
      }
      case "turn.interrupt.requested":
        return [{ method: "turn/interruptRequested", params: base }];
      case "turn.started": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        mutable.turn.status = "inProgress";
        const notifications: ProjectedNotification[] = [{
          method: "turn/started",
          params: { ...base, turn: { id: turnId, status: "inProgress", items: [] } },
        }];
        for (const item of mutable.items.values()) {
          notifications.push(this.itemStarted(base, item), this.itemCompleted(base, item));
        }
        return notifications;
      }
      case "assistant.message.delta": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        const itemId = `${turnId}:agent-message`;
        const existing = mutable.items.get(itemId);
        const item: Extract<AppThreadItem, { type: "agentMessage" }> = existing?.type === "agentMessage"
          ? existing
          : { type: "agentMessage", id: itemId, text: "", phase: "final_answer" };
        const started = existing ? [] : [this.itemStarted(base, item)];
        item.text += event.text;
        this.putItem(mutable, item);
        return [...started, { method: "item/agentMessage/delta", params: { ...base, itemId, delta: event.text } }];
      }
      case "assistant.message.completed": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        const itemId = `${turnId}:agent-message`;
        const existing = mutable.items.get(itemId);
        const item: Extract<AppThreadItem, { type: "agentMessage" }> = existing?.type === "agentMessage"
          ? existing
          : { type: "agentMessage", id: itemId, text: "", phase: "final_answer" };
        if (event.text) item.text = event.text;
        this.putItem(mutable, item);
        return [this.itemCompleted(base, item)];
      }
      case "assistant.reasoning.delta": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        const itemId = `${turnId}:reasoning`;
        const existing = mutable.items.get(itemId);
        const item: Extract<AppThreadItem, { type: "reasoning" }> = existing?.type === "reasoning"
          ? existing
          : { type: "reasoning", id: itemId, summary: [], content: [] };
        const started = existing ? [] : [this.itemStarted(base, item)];
        item.content.push(event.text);
        this.putItem(mutable, item);
        return [...started, { method: "item/reasoning/textDelta", params: { ...base, itemId, delta: event.text } }];
      }
      case "assistant.reasoning.completed": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        const itemId = `${turnId}:reasoning`;
        const existing = mutable.items.get(itemId);
        const item: Extract<AppThreadItem, { type: "reasoning" }> = existing?.type === "reasoning"
          ? existing
          : { type: "reasoning", id: itemId, summary: [], content: [] };
        if (event.text) item.content = [event.text];
        this.putItem(mutable, item);
        return [this.itemCompleted(base, item)];
      }
      case "tool.started": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        const item = toolItem(event.toolCall, "inProgress");
        this.putItem(mutable, item);
        return [this.itemStarted(base, item)];
      }
      case "command.output.delta": {
        if (!turnId) return [];
        const existing = this.ensureTurn(turnId).items.get(event.toolCallId);
        if (existing?.type === "commandExecution") {
          existing.aggregatedOutput = `${existing.aggregatedOutput ?? ""}${event.text}`;
        }
        return [{
          method: "item/commandExecution/outputDelta",
          params: { ...base, itemId: event.toolCallId, delta: event.text, stream: event.stream },
        }];
      }
      case "tool.completed": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        const item = completeToolItem(mutable.items.get(event.toolCall.id), event.toolCall, event.result);
        this.putItem(mutable, item);
        return [this.itemCompleted(base, item)];
      }
      case "tool.failed": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        const current = mutable.items.get(event.toolCall.id) ?? toolItem(event.toolCall, "failed");
        setItemFailed(current, event.error.message);
        this.putItem(mutable, current);
        return [this.itemCompleted(base, current)];
      }
      case "compaction.updated": {
        if (!turnId) {
          return [{ method: "item/compaction/updated", params: { ...base, compaction: event } }];
        }
        if (event.phase !== "completed") {
          return [{ method: "item/compaction/updated", params: { ...base, compaction: event } }];
        }
        const mutable = this.ensureTurn(turnId);
        const item: AppThreadItem = { type: "contextCompaction", id: `${turnId}:compaction` };
        this.putItem(mutable, item);
        return [
          { method: "item/compaction/updated", params: { ...base, compaction: event } },
          this.itemCompleted(base, item),
        ];
      }
      case "turn.completed":
        return turnId ? this.turnCompleted(base, turnId, "completed") : [];
      case "turn.aborted":
        return turnId ? this.turnCompleted(base, turnId, "interrupted") : [];
      case "turn.failed":
        return turnId ? this.turnCompleted(base, turnId, "failed", event.error.message) : [];
      case "token.usage":
        return [{
          method: "thread/tokenUsage/updated",
          params: {
            ...base,
            tokenUsage: {
              total: { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.inputTokens + event.outputTokens },
              last: { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.inputTokens + event.outputTokens },
              modelContextWindow: null,
            },
          },
        }];
      case "verification.started":
      case "verification.completed":
        return [{ method: "item/verification/updated", params: { ...base, verification: event } }];
      case "approval.requested":
        return [{ method: "item/approval/requested", params: { ...base, approval: event } }];
      case "approval.resolved":
        return [{ method: "item/approval/resolved", params: { ...base, approval: event } }];
      case "warning":
        return [{ method: "warning", params: { ...base, message: event.message, code: event.code } }];
      case "error":
        return [{ method: "error", params: { ...base, message: event.message, code: event.code } }];
    }
  }

  hydrate(turns: AppTurn[]): void {
    const existingIds = new Set(this.turns.keys());
    const existingFingerprints = new Set(
      [...this.turns.values()]
        .map((entry) => userFingerprint(entry.turn))
        .filter((value): value is string => Boolean(value)),
    );
    const prepend: AppTurn[] = [];
    for (const turn of turns) {
      if (existingIds.has(turn.id)) continue;
      const fingerprint = userFingerprint(turn);
      if (fingerprint && existingFingerprints.has(fingerprint)) continue;
      const cloned = cloneTurn(turn);
      prepend.push(cloned);
      existingIds.add(cloned.id);
      if (fingerprint) existingFingerprints.add(fingerprint);
    }
    if (prepend.length === 0) return;
    const liveEntries = [...this.turns.entries()];
    this.turns.clear();
    for (const turn of prepend) {
      this.turns.set(turn.id, {
        turn,
        items: new Map(turn.items.map((item) => [item.id, item])),
      });
    }
    for (const [id, entry] of liveEntries) this.turns.set(id, entry);
  }

  snapshotTurns(): AppTurn[] {
    return [...this.turns.values()].map((entry) => cloneTurn(entry.turn));
  }

  private ensureTurn(turnId: string): MutableTurn {
    let mutable = this.turns.get(turnId);
    if (!mutable) {
      mutable = { turn: { id: turnId, status: "inProgress", items: [] }, items: new Map() };
      this.turns.set(turnId, mutable);
    }
    return mutable;
  }

  private putItem(mutable: MutableTurn, item: AppThreadItem): void {
    mutable.items.set(item.id, item);
    mutable.turn.items = [...mutable.items.values()];
  }

  private itemStarted(base: Record<string, unknown>, item: AppThreadItem): ProjectedNotification {
    return { method: "item/started", params: { ...base, item: structuredClone(item) } };
  }

  private itemCompleted(base: Record<string, unknown>, item: AppThreadItem): ProjectedNotification {
    return { method: "item/completed", params: { ...base, item: structuredClone(item) } };
  }

  private turnCompleted(base: Record<string, unknown>, turnId: string, status: AppTurnStatus, error?: string): ProjectedNotification[] {
    const mutable = this.ensureTurn(turnId);
    if (mutable.turn.status === status && !error) return [];
    mutable.turn.status = status;
    if (error) mutable.turn.error = { message: error };
    return [{ method: "turn/completed", params: { ...base, turn: cloneTurn(mutable.turn) } }];
  }
}

export function projectThread(metadata: ThreadMetadata, turns?: AppTurn[]): AppThread {
  const preview = metadata.lastTurn?.assistantMessage?.slice(0, 200) ?? metadata.title ?? "";
  return {
    id: metadata.threadId,
    sessionId: metadata.sessionName,
    preview,
    ephemeral: false,
    cwd: metadata.workspaceRoot,
    ...(metadata.provider ? { modelProvider: metadata.provider } : {}),
    ...(metadata.model ? { model: metadata.model } : {}),
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    ...(metadata.title ? { name: metadata.title } : {}),
    status: projectStatus(metadata.status),
    ...(turns ? { turns } : {}),
  };
}

export function projectHistory(messages: SessionMessage[]): AppTurn[] {
  const turns: AppTurn[] = [];
  let current: AppTurn | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "user") {
      current = {
        id: `history-turn-${turns.length + 1}`,
        status: "completed",
        items: [{
          type: "userMessage",
          id: `history-item-${index + 1}`,
          content: [{ type: "text", text: message.content ?? "" }],
        }],
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { id: `history-turn-${turns.length + 1}`, status: "completed", items: [] };
      turns.push(current);
    }
    if (message.role === "assistant") {
      current.items.push({
        type: "agentMessage",
        id: `history-item-${index + 1}`,
        text: message.content ?? "",
        phase: "final_answer",
      });
    } else if (message.role === "tool") {
      current.items.push({
        type: "dynamicToolCall",
        id: `history-item-${index + 1}`,
        tool: message.name ?? "tool",
        arguments: {},
        status: "completed",
        result: message.content,
      });
    }
  }
  return turns;
}

function projectStatus(status: string): AppThread["status"] {
  if (status === "running") return { type: "active", activeFlags: ["turn"] };
  if (status === "error") return "systemError";
  if (status === "closed") return "notLoaded";
  return "idle";
}

function toolItem(call: ToolCall, status: "inProgress" | "completed" | "failed"): AppThreadItem {
  if (call.name === "bash") {
    return {
      type: "commandExecution",
      id: call.id,
      command: "cmd" in (call.args as object) && typeof (call.args as { cmd?: unknown }).cmd === "string"
        ? (call.args as { cmd: string }).cmd
        : "",
      status,
    };
  }
  if (["write_file", "edit_file", "file_edit", "apply_patch", "delete_file"].includes(call.name)) {
    const args = asRecord(call.args) ?? {};
    const candidate = args.path ?? args.file_path;
    return {
      type: "fileChange",
      id: call.id,
      changes: typeof candidate === "string" ? [{ path: candidate, kind: call.name }] : [],
      status,
    };
  }
  return { type: "dynamicToolCall", id: call.id, tool: call.name, arguments: asRecord(call.args) ?? {}, status };
}

function completeToolItem(existing: AppThreadItem | undefined, call: ToolCall, result: ToolResult): AppThreadItem {
  const item = existing ?? toolItem(call, result.ok ? "completed" : "failed");
  if (item.type === "commandExecution") {
    item.status = result.ok ? "completed" : "failed";
    const record = asRecord(result.output);
    if (typeof record?.stdout === "string" || typeof record?.stderr === "string") {
      item.aggregatedOutput = `${typeof record.stdout === "string" ? record.stdout : ""}${typeof record.stderr === "string" ? record.stderr : ""}`;
    }
    if (typeof record?.exitCode === "number") item.exitCode = record.exitCode;
  } else if (item.type === "fileChange") {
    item.status = result.ok ? "completed" : "failed";
  } else if (item.type === "dynamicToolCall") {
    item.status = result.ok ? "completed" : "failed";
    item.result = result.output;
    if (result.error?.message) item.error = result.error.message;
  }
  return item;
}

function setItemFailed(item: AppThreadItem, message: string): void {
  if (item.type === "commandExecution" || item.type === "fileChange" || item.type === "dynamicToolCall") item.status = "failed";
  if (item.type === "dynamicToolCall") item.error = message;
}

function cloneTurn(turn: AppTurn): AppTurn {
  return structuredClone(turn);
}

function userFingerprint(turn: AppTurn): string | undefined {
  const item = turn.items.find((entry) => entry.type === "userMessage");
  if (item?.type !== "userMessage") return undefined;
  return item.content.map((part) => part.text).join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
