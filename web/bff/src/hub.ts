/**
 * Fans one app-server connection out to many browser tabs.
 *
 * This is a stateful multiplexer, never a second source of truth. It holds
 * routing state only — which tab watches which thread, and which tab owns an
 * in-flight approval. The transcript stays canonical in the app-server's
 * `SessionProjection` plus the session journal.
 *
 * Two problems it exists to solve:
 *
 * 1. **Approval id spaces.** The app-server sends server-initiated requests
 *    whose ids belong to its own space. Tabs have their own. Proxying raw ids
 *    across the hop would misattribute an approval after a reconnect renumbers
 *    one side, so each hop keeps its own space and they are correlated by the
 *    stable `approvalId`.
 *
 * 2. **Disconnect-cancel.** `message-processor.ts:75-78` drops turn ownership
 *    when the owning *connection* closes, which is how a closed client stops
 *    blocking the agent. With the BFF multiplexing tabs over one connection
 *    that never fires — a closed tab would hang the agent's tool call for the
 *    full approval timeout. So the BFF answers `cancel` for every approval a
 *    departing tab owned.
 */

import { randomUUID } from "node:crypto";

import type { JsonRpcClient } from "../../shared/src/jsonrpc-client.js";
import type { JsonRpcId, JsonRpcMessage } from "../../shared/src/types.js";

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

export class Hub {
  private readonly tabs = new Map<string, Tab>();
  /** Keyed by approvalId — the one identifier stable across both id spaces. */
  private readonly approvals = new Map<string, PendingApproval>();
  /** `"threadId turnId"` → tabId. Mirrors the server's turnOwners one layer up. */
  private readonly turnOwners = new Map<string, string>();

  constructor(private readonly upstream: JsonRpcClient) {
    upstream.onNotification((method, params) => this.routeNotification(method, params));
    upstream.onServerRequest((message) => this.routeServerRequest(message));
  }

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
      this.upstream.respond(approval.appServerRequestId, { decision: "cancel" });
    }
    for (const [key, owner] of this.turnOwners) {
      if (owner === tabId) this.turnOwners.delete(key);
    }
  }

  watchThread(tabId: string, threadId: string): void {
    this.tabs.get(tabId)?.threads.add(threadId);
  }

  claimTurn(tabId: string, threadId: string, turnId: string): void {
    this.turnOwners.set(`${threadId} ${turnId}`, tabId);
  }

  /** Answer an approval on behalf of a tab, translating back to the server's id. */
  resolveApproval(tabId: string, approvalId: string, decision: string): { ok: boolean; error?: string } {
    const approval = this.approvals.get(approvalId);
    if (!approval) return { ok: false, error: "unknown_or_expired_approval" };
    if (approval.tabId !== tabId) return { ok: false, error: "approval_owned_by_another_tab" };
    if (!VALID_DECISIONS.has(decision)) return { ok: false, error: "invalid_decision" };
    this.approvals.delete(approvalId);
    this.upstream.respond(approval.appServerRequestId, { decision });
    return { ok: true };
  }

  private routeServerRequest(message: JsonRpcMessage): void {
    if (!message.method || message.id === undefined) return;
    if (!APPROVAL_METHODS.has(message.method)) return;

    const params = message.params ?? {};
    const threadId = String(params.threadId ?? "");
    const turnId = String(params.turnId ?? "");
    const approvalId = String(params.approvalId ?? "");
    if (!approvalId || !threadId) {
      this.upstream.respond(message.id, { decision: "cancel" });
      return;
    }

    const tab = this.pickReviewer(threadId, turnId);
    if (!tab) {
      // Nobody is watching. Cancel rather than let the agent block on a prompt
      // that will never be shown.
      this.upstream.respond(message.id, { decision: "cancel" });
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
    // space — and carries no approvalId. Translating that back is exactly the
    // BFF's job: the browser only ever knows approvalIds. Matching on threadId
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
