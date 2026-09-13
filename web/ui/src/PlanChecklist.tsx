import type { PlanStep, TodoItem } from "@reaper/web-shared";

function progressOf(steps: PlanStep[]): { completed: number; total: number; blocked: number } {
  let completed = 0;
  let blocked = 0;
  for (const step of steps) {
    if (step.status === "completed") completed += 1;
    else if (step.status === "blocked") blocked += 1;
  }
  return { completed, total: steps.length, blocked };
}

function statusGlyph(status: PlanStep["status"]): string {
  switch (status) {
    case "completed": return "✓";
    case "in_progress": return "›";
    case "blocked": return "!";
    default: return "○";
  }
}

export function PlanChecklist({ plan = [], todo = [] }: { plan: PlanStep[] | undefined; todo: TodoItem[] | undefined }) {
  if (plan.length === 0 && todo.length === 0) return null;
  const progress = progressOf(plan);
  return (
    <section className="checklist" aria-label="Agent plan and todos">
      {plan.length > 0 && (
        <>
          <div className="checklist-head">
            <h2 className="checklist-title">Plan</h2>
            <span className="checklist-progress">
              {progress.completed}/{progress.total}{progress.blocked > 0 ? ` · ${progress.blocked} blocked` : ""}
            </span>
          </div>
          <ol className="checklist-steps">
            {plan.map((step, index) => (
              <li className="checklist-step" data-status={step.status} key={`${step.title}-${index}`}>
                <span className="checklist-glyph" aria-hidden="true">{statusGlyph(step.status)}</span>
                <span className="checklist-body">
                  <span className="checklist-step-title">{step.title}</span>
                  {step.detail && <span className="checklist-detail">{step.detail}</span>}
                  {step.status === "completed" && step.evidence && <span className="checklist-evidence">✓ {step.evidence}</span>}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
      {todo.length > 0 && (
        <>
          <h2 className="checklist-title">Todos</h2>
          <ol className="checklist-steps">
            {todo.map((item, index) => (
              <li className="checklist-step" data-status={item.status} key={`${item.content}-${index}`}>
                <span className="checklist-glyph" aria-hidden="true">{statusGlyph(item.status)}</span>
                <span className="checklist-body">
                  <span className="checklist-step-title">
                    {item.content}{item.priority ? <span className="checklist-priority"> · {item.priority}</span> : null}
                  </span>
                  {item.evidence && <span className="checklist-evidence">{item.evidence}</span>}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
