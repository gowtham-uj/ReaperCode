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
    return { title: "Run this command?", detail: String(params.command ?? "") };
  }
  if (request.method === "item/fileChange/requestApproval") {
    return { title: "Apply these file changes?", detail: JSON.stringify(params.changes ?? {}, null, 2) };
  }
  if (request.method === "item/tool/requestUserInput") {
    return { title: "The agent is asking for input", detail: String(params.reason ?? "") };
  }
  return { title: `Run ${String(params.tool ?? "this tool")}?`, detail: JSON.stringify(params.arguments ?? {}, null, 2) };
}

export function ApprovalCard({ request, onDecide }: {
  request: ApprovalRequest;
  onDecide: (approvalId: string, decision: string) => void;
}) {
  const described = describe(request);
  return (
    <div className="approval-root" data-approval-key={request.approvalId}>
      <div className="approval-card" role="group" aria-label={described.title}>
        <div className="approval-strip"><span className="approval-dot" />Waiting for your approval</div>
        <div className="approval-body">
          <div className="approval-title">{described.title}</div>
          {request.params.reason ? <p className="approval-reason">{String(request.params.reason)}</p> : null}
          {described.detail ? <pre className="approval-command">{described.detail}</pre> : null}
        </div>
        <div className="approval-actions">
          {request.availableDecisions.map((decision, index) => (
            <button
              className="button"
              data-variant={index === 0 ? "primary" : DESTRUCTIVE.has(decision) ? "danger" : "outline"}
              key={decision}
              onClick={() => onDecide(request.approvalId, decision)}
            >
              {label(decision)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function StickyApprovalBar({ request, onDecide, onReveal }: {
  request: ApprovalRequest;
  onDecide: (approvalId: string, decision: string) => void;
  onReveal: () => void;
}) {
  const described = describe(request);
  return (
    <div className="sticky-approval" role="region" aria-label="Pending approval">
      <div className="sticky-approval-copy">
        <div className="approval-title">{described.title}</div>
        <div className="tool-detail">{described.detail}</div>
      </div>
      <button className="button" data-variant="outline" onClick={onReveal}>Show</button>
      {request.availableDecisions.map((decision, index) => (
        <button
          className="button"
          data-variant={index === 0 ? "primary" : DESTRUCTIVE.has(decision) ? "danger" : "outline"}
          key={decision}
          onClick={() => onDecide(request.approvalId, decision)}
        >
          {label(decision)}
        </button>
      ))}
    </div>
  );
}
