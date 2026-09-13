/**
 * The in-process browser hub: many tabs multiplexed over one virtual
 * app-server connection.
 *
 * This is a stateful multiplexer, never a second source of truth. It holds
 * routing state only — which tab watches which thread, and which tab owns an
 * in-flight approval. The transcript stays canonical in the app-server's
 * `SessionProjection` plus the session journal.
 *
 * It is the former BFF, moved into the app-server process. Instead of speaking
 * to the app-server over a WebSocket it presents one `VirtualAppServerConnection`
 * to the message processor: tab-initiated calls are dispatched *into* the
 * processor, and everything the processor sends "down" — results, notifications,
 * server-initiated approval requests — arrives at `handleInbound` and is fanned
 * out to the right tab. The processor genuinely cannot tell it is talking to a
 * multiplexer, which is the whole point.
 *
 * Two problems it exists to solve:
 *
 * 1. **Approval id spaces.** The processor sends server-initiated requests
 *    whose ids belong to its own space (`server-<uuid>`). Tabs have their own.
 *    Proxying raw ids would misattribute an approval after a reconnect
 *    renumbers one side, so each side keeps its own space, correlated by the
 *    stable `approvalId`.
 *
 * 2. **Disconnect-cancel.** `message-processor.ts` drops turn ownership when
 *    the owning connection closes, which is how a closed client stops blocking
 *    the agent. With all tabs sharing one virtual connection that never fires
 *    for an individual tab, a closed tab must not hang the agent's tool call
 *    for the full approval timeout — so a departing tab's approvals are answered
 *    `cancel` immediately.
 */

import { randomUUID } from "node:crypto";

import type { AppServerClientConnection } from "../connection.js";
import { JsonRpcError } from "../../../web/shared/src/jsonrpc-client.js";
import type { JsonRpcId, JsonRpcMessage } from "../../../web/shared/src/types.js";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestApproval",
  "item/tool/requestUserInput",
]);

/** Mirrors the decisions `ApprovalResponseResultSchema` accepts. */
const VALID_DECISIONS = new Set([
  "approved", "denied", "cancelled",
  "accept", "acceptForSession", "decline", "cancel",
]);

export interface TabSocket {
  send(payload: string): void;
  close(): void;
}

interface Tab {
  id: string;
  socket: TabSocket;
  /** Threads this tab is watching. Notifications are filtered by this set. */
  threads: Set<string>;
}

interface PendingApproval {
  appServerRequestId: JsonRpcId;
  approvalId: string;
  threadId: string;
  tabId: string;
}

export class BrowserHub {
  private readonly tabs = new Map<string, Tab>();
  /** Keyed by approvalId — the one identifier stable across both id spaces. */
  private readonly approvals = new Map<string, PendingApproval>();
  /** `"threadId turnId"` → tabId. Mirrors the processor's turnOwners one layer up. */
  private readonly turnOwners = new Map<string, string>();
  private readonly pending = new Map<JsonRpcId, { resolve: (message: JsonRpcMessage) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextRequestId = 1;

  /** The server's reported capabilities, captured at initialize. */
  capabilities: Record<string, unknown> = {};

  /**
   * @param dispatch Pushes an envelope *into* the message processor as this
   * hub's virtual connection. Closed over the processor and the virtual
   * connection by the caller — this avoids a constructor cycle.
   */
  constructor(private readonly dispatch: (value: unknown) => void) {}

  /* ---- tab lifecycle ---- */

  addTab(socket: TabSocket): string {
    const id = randomUUID();
    this.tabs.set(id, { id, socket, threads: new Set() });
    return id;
  }

  /**
   * Drop a tab and immediately release anything it was blocking. The agent is
   * sitting inside a tool call waiting on these; leaving them pending would
   * stall it until the server-side timeout with nobody left to answer.
   */
  removeTab(tabId: string): void {
    this.tabs.delete(tabId);
    for (const [approvalId, approval] of this.approvals) {
      if (approval.tabId !== tabId) continue;
      this.approvals.delete(approvalId);
      this.respondServerRequest(approval.appServerRequestId, { decision: "cancel" });
    }
    for (const [key, owner] of this.turnOwners) {
      if (owner === tabId) this.turnOwners.delete(key);
    }
  }

  watchThread(tabId: string, threadId: string): void {
    this.tabs.get(tabId)?.threads.add(threadId);
  }

  isWatching(tabId: string, threadId: string): boolean {
    return this.tabs.get(tabId)?.threads.has(threadId) ?? false;
  }

  /** Undo a speculative `watchThread` whose call turned out to fail. */
  unwatchThread(tabId: string, threadId: string): void {
    this.tabs.get(tabId)?.threads.delete(threadId);
  }

  claimTurn(tabId: string, threadId: string, turnId: string): void {
    this.turnOwners.set(`${threadId} ${turnId}`, tabId);
  }

  /* ---- tab → app-server ---- */

  /**
   * Run one tab-initiated RPC through the virtual connection and unwrap its
   * result, throwing `JsonRpcError` on a JSON-RPC error exactly as the old
   * BFF's upstream client did.
   */
  async call<T = Record<string, unknown>>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    const message = await this.request(method, params, timeoutMs);
    if (message.error) {
      throw new JsonRpcError(message.error.code, message.error.message, message.error.data);
    }
    return message.result as T;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcMessage> {
    const id = this.nextRequestId++;
    const promise = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, timer });
    });
    this.dispatch({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  /** Answer an approval on behalf of a tab, translating back to the server's id. */
  resolveApproval(tabId: string, approvalId: string, decision: string): { ok: boolean; error?: string } {
    const approval = this.approvals.get(approvalId);
    if (!approval) return { ok: false, error: "unknown_or_expired_approval" };
    if (approval.tabId !== tabId) return { ok: false, error: "approval_owned_by_another_tab" };
    if (!VALID_DECISIONS.has(decision)) return { ok: false, error: "invalid_decision" };
    this.approvals.delete(approvalId);
    this.respondServerRequest(approval.appServerRequestId, { decision });
    return { ok: true };
  }

  private respondServerRequest(id: JsonRpcId, result: unknown): void {
    this.dispatch({ jsonrpc: "2.0", id, result });
  }

  /** Tear down: reject every in-flight tab call and cancel every approval. */
  close(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ jsonrpc: "2.0", id: 0, error: { code: -32603, message: "Server shutting down" } });
    }
    this.pending.clear();
    for (const [approvalId, approval] of this.approvals) {
      this.approvals.delete(approvalId);
      this.respondServerRequest(approval.appServerRequestId, { decision: "cancel" });
    }
    this.tabs.clear();
    this.turnOwners.clear();
  }

  /* ---- app-server → tabs ---- */

  /** Entry point for everything the processor sends to the virtual connection. */
  handleInbound(message: JsonRpcMessage): void {
    // Response to a tab-initiated call.
    if (message.id !== undefined && message.method === undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }

    // Server-initiated request — an approval. Has both method and id.
    if (message.id !== undefined && message.method !== undefined) {
      this.routeServerRequest(message);
      return;
    }

    // Notification.
    if (message.method !== undefined) {
      this.routeNotification(message.method, message.params ?? {});
    }
  }

  private routeServerRequest(message: JsonRpcMessage): void {
    if (message.id === undefined || message.method === undefined) return;
    if (!APPROVAL_METHODS.has(message.method)) return;

    const params = message.params ?? {};
    const threadId = String(params.threadId ?? "");
    const turnId = String(params.turnId ?? "");
    const approvalId = String(params.approvalId ?? "");
    if (!approvalId || !threadId) {
      this.respondServerRequest(message.id, { decision: "cancel" });
      return;
    }

    const tab = this.pickReviewer(threadId, turnId);
    if (!tab) {
      // Nobody is watching. Cancel rather than let the agent block on a prompt
      // that will never be shown.
      this.respondServerRequest(message.id, { decision: "cancel" });
      return;
    }

    this.approvals.set(approvalId, {
      appServerRequestId: message.id,
      approvalId,
      threadId,
      tabId: tab.id,
    });
    this.sendToTab(tab, "approval/requested", { ...params, method: message.method });
  }

  /**
   * The tab that started the turn reviews its approvals. Falling back to any
   * tab watching the thread is the *degraded* path, used only when ownership
   * was lost — otherwise an observing tab could approve a destructive action
   * someone else initiated.
   */
  private pickReviewer(threadId: string, turnId: string): Tab | undefined {
    const owner = this.turnOwners.get(`${threadId} ${turnId}`);
    const owned = owner ? this.tabs.get(owner) : undefined;
    if (owned) return owned;
    for (const tab of this.tabs.values()) {
      if (tab.threads.has(threadId)) return tab;
    }
    return undefined;
  }

  private routeNotification(method: string, params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;

    // An approval settled server-side (timeout, or the turn aborted).
    //
    // The notification identifies it by `requestId` — the app-server's own id
    // space — and carries no approvalId. Translating that back is exactly this
    // hub's job: the browser only ever knows approvalIds. Matching on threadId
    // instead would take down every other pending approval on the same thread.
    if (method === "serverRequest/resolved") {
      const requestId = params.requestId as JsonRpcId | undefined;
      for (const [approvalId, approval] of this.approvals) {
        if (approval.appServerRequestId !== requestId) continue;
        this.approvals.delete(approvalId);
        const tab = this.tabs.get(approval.tabId);
        if (tab) this.sendToTab(tab, "approval/resolved", { ...params, approvalId });
        return;
      }
      return;
    }

    if (!threadId) {
      for (const tab of this.tabs.values()) this.sendToTab(tab, method, params);
      return;
    }
    for (const tab of this.tabs.values()) {
      if (tab.threads.has(threadId)) this.sendToTab(tab, method, params);
    }
  }

  private sendToTab(tab: Tab, method: string, params: unknown): void {
    try {
      tab.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    } catch {
      // A dead socket is the close handler's problem, not this send's.
    }
  }
}

/**
 * The virtual connection the processor and router hold on behalf of the hub.
 *
 * It implements `AppServerClientConnection`, so the processor stores its
 * per-thread subscriptions on it and the router sends envelopes "to" it — all
 * of which land in `hub.handleInbound`. It owns no socket and has no lifecycle
 * of its own beyond the hub.
 */
export class VirtualAppServerConnection implements AppServerClientConnection {
  readonly id = `browser-hub-${randomUUID()}`;
  readonly subscriptions = new Map<string, () => void>();

  constructor(private readonly hub: BrowserHub) {}

  sendJson(value: unknown): boolean {
    this.hub.handleInbound(value as JsonRpcMessage);
    return true;
  }

  close(): void {
    this.hub.close();
  }

  /** No socket to ping; the gateway's own WebSocketServer heartbeats its tabs. */
  heartbeat(): void {}
}
