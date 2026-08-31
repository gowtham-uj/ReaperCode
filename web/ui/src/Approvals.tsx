/**
 * Approval UI.
 *
 * The agent is blocked inside a tool call while this is on screen, so the
 * design goal is: answerable fast, never accidentally.
 *
 * Two surfaces for one approval:
 *  - **Inline**, at the point in the transcript where it happened, so the
 *    decision is made with the surrounding context visible.
 *  - **A sticky bar**, only when the inline card has scrolled out of view.
 *
 * No modal, and no focus stealing. A dialog that grabs focus mid-scroll gets
 * dismissed reflexively, which is the worst possible outcome for a prompt
 * gating a destructive action.
 *
 * Buttons render from `availableDecisions`, which the server picks per tool
 * type (`message-processor.ts:431-464`). The UI never maps tool → decisions
 * itself; doing so would silently drift from the server's policy.
 */

import { createMemo, For, Show, type JSX } from "solid-js";

import type { ApprovalRequest } from "@reaper/web-shared";

const DECISION_LABELS: Record<string, string> = {
  accept: "Approve",
  acceptForSession: "Approve for session",
  approved: "Approve",
  decline: "Deny",
  denied: "Deny",
  cancel: "Cancel",
  cancelled: "Cancel",
};

const DESTRUCTIVE = new Set(["decline", "denied", "cancel", "cancelled"]);

function label(decision: string): string {
  return DECISION_LABELS[decision] ?? decision;
}

function describe(request: ApprovalRequest): { title: string; detail: string } {
  const params = request.params;
  if (request.method === "item/commandExecution/requestApproval") {
    return { title: "Run a command?", detail: String(params.command ?? "") };
  }
  if (request.method === "item/fileChange/requestApproval") {
    return { title: "Apply file changes?", detail: JSON.stringify(params.changes ?? {}, null, 2) };
  }
  if (request.method === "item/tool/requestUserInput") {
    return { title: "The agent is asking for input", detail: String(params.reason ?? "") };
  }
  return {
    title: `Run ${String(params.tool ?? "a tool")}?`,
    detail: JSON.stringify(params.arguments ?? {}, null, 2),
  };
}

export function ApprovalCard(props: {
  request: ApprovalRequest;
  onDecide: (approvalId: string, decision: string) => void;
}): JSX.Element {
  const described = createMemo(() => describe(props.request));

  return (
    <div class="approval" role="group" aria-label={described().title}>
      <div class="approval-title">{described().title}</div>
      <Show when={props.request.params.reason}>
        <p class="status-label">{String(props.request.params.reason)}</p>
      </Show>
      <Show when={described().detail}>
        <pre class="output">{described().detail}</pre>
      </Show>
      <div class="approval-actions">
        <For each={props.request.availableDecisions}>
          {(decision, index) => (
            <button
              class="btn"
              data-variant={index() === 0 ? "primary" : DESTRUCTIVE.has(decision) ? "danger" : undefined}
              onClick={() => props.onDecide(props.request.approvalId, decision)}
            >
              {label(decision)}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

/**
 * Shown only when the inline card is off-screen. Carries the same decisions,
 * so the user never has to hunt for the card to answer it.
 */
export function StickyApprovalBar(props: {
  request: ApprovalRequest;
  onDecide: (approvalId: string, decision: string) => void;
  onReveal: () => void;
}): JSX.Element {
  const described = createMemo(() => describe(props.request));

  return (
    <div class="sticky-approval" role="region" aria-label="Pending approval">
      <div style={{ "min-width": 0, flex: 1 }}>
        <div style={{ "font-weight": 600 }}>{described().title}</div>
        <div class="tool-detail" style={{ color: "var(--text-muted)" }}>{described().detail}</div>
      </div>
      <button class="btn" onClick={props.onReveal}>Show in transcript</button>
      <For each={props.request.availableDecisions}>
        {(decision, index) => (
          <button
            class="btn"
            data-variant={index() === 0 ? "primary" : DESTRUCTIVE.has(decision) ? "danger" : undefined}
            onClick={() => props.onDecide(props.request.approvalId, decision)}
          >
            {label(decision)}
          </button>
        )}
      </For>
    </div>
  );
}
