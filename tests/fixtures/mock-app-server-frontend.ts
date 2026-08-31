import WebSocket from "ws";

export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export type FrontendItem = Record<string, unknown> & {
  type: string;
  id: string;
};

export interface FrontendTurn {
  id: string;
  status: string;
  items: Map<string, FrontendItem>;
  error?: { message: string; additionalDetails?: string };
}

export interface FrontendThread {
  id: string;
  sessionId?: string;
  preview?: string;
  ephemeral?: boolean;
  cwd?: string;
  modelProvider?: string | null;
  model?: string | null;
  createdAt?: string;
  updatedAt?: string;
  name?: string;
  status?: unknown;
  approvalPolicy?: string;
  turns: Map<string, FrontendTurn>;
  latestSequence: number;
  tokenUsage?: unknown;
}

export interface MockFrontendOptions {
  headers?: Record<string, string>;
  autoApprove?: boolean;
  approvalDecision?: "accept" | "approved" | "decline" | "denied" | "cancel";
  name?: string;
}

interface PendingRequest {
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Waiter {
  predicate: (message: JsonRpcMessage) => boolean;
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Codex-style app-server consumer: one WebSocket, JSON-RPC 2.0, and a local
 * Thread/Turn/Item store updated from live notifications.
 */
export class MockAppServerFrontend {
  readonly threads = new Map<string, FrontendThread>();
  readonly notifications: JsonRpcMessage[] = [];
  readonly methods: string[] = [];
  readonly serverRequests: JsonRpcMessage[] = [];
  readonly warnings: JsonRpcMessage[] = [];
  readonly errors: JsonRpcMessage[] = [];
  protocolVersion?: number;
  capabilities?: Record<string, unknown>;
  serverInfo?: Record<string, unknown>;

  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly waiters: Waiter[] = [];
  private readonly pendingApprovals: JsonRpcMessage[] = [];
  private closeCode: number | undefined;
  private readonly closeWaiters: Array<(code: number) => void> = [];

  private constructor(
    private readonly socket: WebSocket,
    private readonly options: MockFrontendOptions,
  ) {
    socket.on("message", (raw) => this.onRaw(String(raw)));
    socket.on("close", (code) => {
      this.closeCode = code;
      for (const waiter of this.closeWaiters.splice(0)) waiter(code);
      const error = new Error(`WebSocket closed (${code})`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });
  }

  static async connect(url: string, options: MockFrontendOptions = {}): Promise<MockAppServerFrontend> {
    const socket = new WebSocket(url, options.headers ? { headers: options.headers } : {});
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        reject(new Error(`Unexpected server response: ${response.statusCode}`));
      });
    });
    return new MockAppServerFrontend(socket, options);
  }

  async initialize(clientInfo = { name: this.options.name ?? "mock-frontend", title: "Mock Reaper UI" }): Promise<JsonRpcMessage> {
    const response = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo,
    });
    const protocolVersion = numberOrUndefined(response.result?.protocolVersion);
    const capabilities = asRecord(response.result?.capabilities);
    const serverInfo = asRecord(response.result?.serverInfo);
    if (protocolVersion !== undefined) this.protocolVersion = protocolVersion;
    if (capabilities) this.capabilities = capabilities;
    if (serverInfo) this.serverInfo = serverInfo;
    return response;
  }

  async startThread(params: Record<string, unknown> = {}): Promise<JsonRpcMessage> {
    const response = await this.request("thread/start", params);
    const thread = asRecord(response.result?.thread);
    if (thread && typeof thread.id === "string") {
      this.seedThread(thread, asRecord(response.result));
    }
    return response;
  }

  async startTurn(params: Record<string, unknown>): Promise<JsonRpcMessage> {
    return await this.request("turn/start", params);
  }

  async resumeThread(params: Record<string, unknown>, timeoutMs = 5_000): Promise<JsonRpcMessage> {
    const response = await this.request("thread/resume", params, timeoutMs);
    const thread = asRecord(response.result?.thread);
    if (thread && typeof thread.id === "string") {
      this.seedThread(thread, asRecord(response.result));
      const turns = response.result?.initialTurnsPage;
      if (Array.isArray(turns)) this.replaceTurns(thread.id, turns as Array<Record<string, unknown>>);
    }
    return response;
  }

  async listThreads(): Promise<JsonRpcMessage> {
    return await this.request("thread/list", {});
  }

  async readThread(threadId: string, includeTurns = true): Promise<JsonRpcMessage> {
    return await this.request("thread/read", { threadId, includeTurns });
  }

  async listTurns(threadId: string, extra: Record<string, unknown> = {}): Promise<JsonRpcMessage> {
    return await this.request("thread/turns/list", { threadId, itemsView: "full", sortDirection: "asc", ...extra });
  }

  async listItems(threadId: string, extra: Record<string, unknown> = {}): Promise<JsonRpcMessage> {
    return await this.request("thread/items/list", { threadId, sortDirection: "asc", ...extra });
  }

  async setThreadName(threadId: string, name: string): Promise<JsonRpcMessage> {
    return await this.request("thread/name/set", { threadId, name });
  }

  async steer(params: Record<string, unknown>): Promise<JsonRpcMessage> {
    return await this.request("turn/steer", params);
  }

  async interrupt(params: Record<string, unknown>): Promise<JsonRpcMessage> {
    return await this.request("turn/interrupt", params);
  }

  async unsubscribe(threadId: string): Promise<JsonRpcMessage> {
    return await this.request("thread/unsubscribe", { threadId });
  }

  async closeThread(threadId: string): Promise<JsonRpcMessage> {
    return await this.request("thread/close", { threadId });
  }

  request(method: string, params: unknown, timeoutMs = 5_000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const promise = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} (${id})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  send(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }

  waitFor(predicate: (message: JsonRpcMessage) => boolean, timeoutMs = 5_000): Promise<JsonRpcMessage> {
    const seen = new Set([...this.notifications, ...this.serverRequests]);
    const existing = [...this.notifications, ...this.serverRequests].find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate: (message) => !seen.has(message) && predicate(message),
        resolve,
        reject,
        timer: (() => {
          const timer = setTimeout(() => {
            const index = this.waiters.indexOf(waiter);
            if (index >= 0) this.waiters.splice(index, 1);
            reject(new Error(`Timed out waiting for frontend notification; methods=${this.methods.join(" -> ")}`));
          }, timeoutMs);
          timer.unref();
          return timer;
        })(),
      };
      this.waiters.push(waiter);
    });
  }

  waitForMethod(method: string, timeoutMs = 5_000): Promise<JsonRpcMessage> {
    return this.waitFor((message) => message.method === method, timeoutMs);
  }

  waitForTurnCompleted(threadId: string, timeoutMs = 5_000): Promise<JsonRpcMessage> {
    return this.waitFor(
      (message) => message.method === "turn/completed" && message.params?.threadId === threadId,
      timeoutMs,
    );
  }

  waitForIdle(threadId: string, timeoutMs = 5_000): Promise<JsonRpcMessage> {
    return this.waitFor(
      (message) => message.method === "thread/status/changed"
        && message.params?.threadId === threadId
        && message.params.status === "idle",
      timeoutMs,
    );
  }

  waitForClose(timeoutMs = 5_000): Promise<number> {
    if (this.closeCode !== undefined) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket close")), timeoutMs);
      timer.unref();
      this.closeWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  approveNext(decision: MockFrontendOptions["approvalDecision"] = "accept"): void {
    const request = this.pendingApprovals.shift();
    if (!request || request.id === undefined) throw new Error("No pending approval request");
    this.respond(request.id, { decision });
  }

  snapshot(threadId: string): {
    thread: Omit<FrontendThread, "turns"> & { turns: Array<Omit<FrontendTurn, "items"> & { items: FrontendItem[] }> };
  } | undefined {
    const thread = this.threads.get(threadId);
    if (!thread) return undefined;
    return {
      thread: {
        ...thread,
        turns: [...thread.turns.values()].map((turn) => ({
          id: turn.id,
          status: turn.status,
          ...(turn.error ? { error: turn.error } : {}),
          items: [...turn.items.values()],
        })),
      },
    };
  }

  itemTypes(threadId: string, turnId?: string): string[] {
    const thread = this.threads.get(threadId);
    if (!thread) return [];
    const turns = turnId
      ? [thread.turns.get(turnId)].filter((turn): turn is FrontendTurn => Boolean(turn))
      : [...thread.turns.values()];
    return turns.flatMap((turn) => [...turn.items.values()].map((item) => item.type));
  }

  userTexts(threadId: string): string[] {
    const thread = this.threads.get(threadId);
    if (!thread) return [];
    return [...thread.turns.values()].flatMap((turn) =>
      [...turn.items.values()]
        .filter((item) => item.type === "userMessage")
        .flatMap((item) => {
          const content = item.content;
          if (!Array.isArray(content)) return [];
          return content.map((part) => String((part as { text?: string }).text ?? ""));
        }),
    );
  }

  agentText(threadId: string, turnId?: string): string {
    const thread = this.threads.get(threadId);
    if (!thread) return "";
    const turns = turnId
      ? [thread.turns.get(turnId)].filter((turn): turn is FrontendTurn => Boolean(turn))
      : [...thread.turns.values()];
    return turns
      .flatMap((turn) => [...turn.items.values()])
      .filter((item) => item.type === "agentMessage")
      .map((item) => String(item.text ?? ""))
      .join("");
  }

  renderTranscript(threadId: string): string {
    const snapshot = this.snapshot(threadId);
    if (!snapshot) return `(no thread ${threadId})`;
    const thread = snapshot.thread;
    const lines = [
      `thread ${thread.id} session=${thread.sessionId ?? "?"} status=${JSON.stringify(thread.status)} policy=${thread.approvalPolicy ?? "?"}`,
    ];
    for (const turn of thread.turns) {
      lines.push(`  turn ${turn.id} ${turn.status}`);
      for (const item of turn.items) {
        lines.push(`    ${summarizeItem(item)}`);
      }
    }
    return lines.join("\n");
  }

  close(): void {
    this.socket.close();
    const error = new Error("WebSocket client closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private onRaw(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    try {
      this.dispatchMessage(message);
    } catch (error) {
      const pending = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (pending) {
        this.pending.delete(message.id!);
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private dispatchMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }

    if (message.method && message.id !== undefined) {
      this.serverRequests.push(message);
      this.methods.push(message.method);
      this.handleServerRequest(message);
      this.dispatchWaiters(message);
      return;
    }

    if (message.method) {
      this.notifications.push(message);
      this.methods.push(message.method);
      try {
        this.applyNotification(message.method, message.params ?? {});
      } catch {
        // Keep the raw protocol stream even if local session apply fails.
      }
      if (message.method === "warning") this.warnings.push(message);
      if (message.method === "error") this.errors.push(message);
      this.dispatchWaiters(message);
    }
  }

  private dispatchWaiters(message: JsonRpcMessage): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]!;
      if (!waiter.predicate(message)) continue;
      this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    const method = message.method ?? "";
    const isApproval = method.includes("requestApproval") || method.endsWith("requestUserInput");
    if (!isApproval || message.id === undefined) return;
    if (this.options.autoApprove === false) {
      this.pendingApprovals.push(message);
      return;
    }
    this.respond(message.id, { decision: this.options.approvalDecision ?? "accept" });
  }

  private seedThread(thread: Record<string, unknown>, envelope?: Record<string, unknown>): FrontendThread {
    const current = this.ensureThread(String(thread.id));
    if (typeof thread.sessionId === "string") current.sessionId = thread.sessionId;
    if (typeof thread.preview === "string") current.preview = thread.preview;
    if (thread.ephemeral === false) current.ephemeral = false;
    const cwd = thread.cwd ?? envelope?.cwd;
    if (typeof cwd === "string") current.cwd = cwd;
    const modelProvider = thread.modelProvider ?? envelope?.modelProvider;
    if (typeof modelProvider === "string" || modelProvider === null) current.modelProvider = modelProvider;
    const model = thread.model ?? envelope?.model;
    if (typeof model === "string" || model === null) current.model = model;
    if (typeof thread.createdAt === "string") current.createdAt = thread.createdAt;
    if (typeof thread.updatedAt === "string") current.updatedAt = thread.updatedAt;
    if (typeof thread.name === "string") current.name = thread.name;
    if (thread.status !== undefined) current.status = thread.status;
    if (envelope?.approvalPolicy !== undefined) current.approvalPolicy = String(envelope.approvalPolicy);
    if (Array.isArray(thread.turns)) this.replaceTurns(current.id, thread.turns as Array<Record<string, unknown>>);
    return current;
  }

  private replaceTurns(threadId: string, turns: Array<Record<string, unknown>>): void {
    const thread = this.ensureThread(threadId);
    if (!(thread.turns instanceof Map)) thread.turns = new Map();
    thread.turns.clear();
    for (const turn of turns) this.putTurn(thread, turn);
  }

  private applyNotification(method: string, params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (typeof params.sequence === "number" && threadId) {
      const thread = this.ensureThread(threadId);
      thread.latestSequence = Math.max(thread.latestSequence, params.sequence);
    }

    switch (method) {
      case "initialized":
        return;
      case "thread/started": {
        const thread = asRecord(params.thread);
        if (thread && typeof thread.id === "string") this.seedThread(thread);
        return;
      }
      case "thread/status/changed":
        if (threadId) this.ensureThread(threadId).status = params.status;
        return;
      case "thread/name/updated":
        if (threadId) this.ensureThread(threadId).name = String(params.threadName ?? "");
        return;
      case "thread/closed":
        if (threadId) this.ensureThread(threadId).status = "notLoaded";
        return;
      case "thread/tokenUsage/updated":
        if (threadId) this.ensureThread(threadId).tokenUsage = params.tokenUsage;
        return;
      case "turn/queued":
      case "turn/interruptRequested":
        if (threadId && typeof params.turnId === "string") this.ensureTurn(this.ensureThread(threadId), params.turnId);
        return;
      case "turn/started": {
        if (!threadId) return;
        const thread = this.ensureThread(threadId);
        const turn = asRecord(params.turn) ?? { id: params.turnId, status: "inProgress", items: [] };
        this.putTurn(thread, turn);
        return;
      }
      case "turn/completed": {
        if (!threadId) return;
        const thread = this.ensureThread(threadId);
        const turn = asRecord(params.turn);
        if (turn) this.putTurn(thread, turn);
        return;
      }
      case "item/started":
      case "item/completed": {
        if (!threadId || typeof params.turnId !== "string") return;
        const item = asRecord(params.item);
        if (!item || typeof item.id !== "string" || typeof item.type !== "string") return;
        this.upsertItem(this.ensureThread(threadId), params.turnId, item as FrontendItem);
        return;
      }
      case "item/agentMessage/delta":
        this.appendItemText(threadId, params, "agentMessage", "text");
        return;
      case "item/reasoning/textDelta":
        this.appendReasoning(threadId, params);
        return;
      case "item/commandExecution/outputDelta":
        this.appendCommandOutput(threadId, params);
        return;
      default:
        return;
    }
  }

  private ensureThread(threadId: string): FrontendThread {
    let thread = this.threads.get(threadId);
    if (!thread) {
      thread = { id: threadId, turns: new Map(), latestSequence: 0 };
      this.threads.set(threadId, thread);
    }
    return thread;
  }

  private ensureTurn(thread: FrontendThread, turnId: string): FrontendTurn {
    let turn = thread.turns.get(turnId);
    if (!turn) {
      turn = { id: turnId, status: "inProgress", items: new Map() };
      thread.turns.set(turnId, turn);
    }
    return turn;
  }

  private putTurn(thread: FrontendThread, raw: Record<string, unknown>): FrontendTurn {
    const id = String(raw.id ?? "");
    const turn = this.ensureTurn(thread, id);
    turn.status = String(raw.status ?? turn.status);
    if (raw.error && typeof raw.error === "object") {
      const error = raw.error as { message?: unknown; additionalDetails?: unknown };
      turn.error = {
        message: String(error.message ?? ""),
        ...(typeof error.additionalDetails === "string" ? { additionalDetails: error.additionalDetails } : {}),
      };
    }
    if (Array.isArray(raw.items)) {
      turn.items.clear();
      for (const item of raw.items) {
        const record = asRecord(item);
        if (!record || typeof record.id !== "string" || typeof record.type !== "string") continue;
        turn.items.set(record.id, record as FrontendItem);
      }
    }
    return turn;
  }

  private upsertItem(thread: FrontendThread, turnId: string, item: FrontendItem): void {
    this.ensureTurn(thread, turnId).items.set(item.id, structuredClone(item));
  }

  private appendItemText(
    threadId: string | undefined,
    params: Record<string, unknown>,
    type: string,
    field: string,
  ): void {
    if (!threadId || typeof params.turnId !== "string") return;
    const itemId = String(params.itemId ?? "");
    const turn = this.ensureTurn(this.ensureThread(threadId), params.turnId);
    const existing = turn.items.get(itemId) ?? { type, id: itemId, [field]: "" };
    existing[field] = `${String(existing[field] ?? "")}${String(params.delta ?? "")}`;
    turn.items.set(itemId, existing);
  }

  private appendReasoning(threadId: string | undefined, params: Record<string, unknown>): void {
    if (!threadId || typeof params.turnId !== "string") return;
    const itemId = String(params.itemId ?? "");
    const turn = this.ensureTurn(this.ensureThread(threadId), params.turnId);
    const existing = turn.items.get(itemId) ?? { type: "reasoning", id: itemId, summary: [], content: [] };
    const content = Array.isArray(existing.content) ? existing.content : [];
    content.push(String(params.delta ?? ""));
    existing.content = content;
    turn.items.set(itemId, existing);
  }

  private appendCommandOutput(threadId: string | undefined, params: Record<string, unknown>): void {
    if (!threadId || typeof params.turnId !== "string") return;
    const itemId = String(params.itemId ?? "");
    const turn = this.ensureTurn(this.ensureThread(threadId), params.turnId);
    const existing = turn.items.get(itemId) ?? { type: "commandExecution", id: itemId, command: "", status: "inProgress" };
    existing.aggregatedOutput = `${String(existing.aggregatedOutput ?? "")}${String(params.delta ?? "")}`;
    turn.items.set(itemId, existing);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function summarizeItem(item: FrontendItem): string {
  if (item.type === "userMessage") {
    const content = Array.isArray(item.content)
      ? item.content.map((part) => String((part as { text?: string }).text ?? "")).join("")
      : "";
    return `userMessage ${JSON.stringify(content)}`;
  }
  if (item.type === "agentMessage") return `agentMessage ${JSON.stringify(String(item.text ?? ""))}`;
  if (item.type === "reasoning") return `reasoning ${JSON.stringify(Array.isArray(item.content) ? item.content.join("") : "")}`;
  if (item.type === "commandExecution") {
    return `commandExecution ${JSON.stringify(item.command ?? "")} status=${item.status} output=${JSON.stringify(String(item.aggregatedOutput ?? "").slice(0, 80))}`;
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes.map((change) => (change as { path?: string }).path).join(",") : "";
    return `fileChange ${changes} status=${item.status}`;
  }
  if (item.type === "dynamicToolCall") return `dynamicToolCall ${item.tool} status=${item.status}`;
  return item.type;
}
