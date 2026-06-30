export type ServiceLifecycleState = "absent" | "configured" | "starting" | "ready" | "unhealthy" | "crashed" | "stopped";

export function classifyServiceLifecycle(input: {
  status?: string;
  health?: string;
  probePassed?: boolean;
  exists?: boolean;
}): ServiceLifecycleState {
  if (input.exists === false) return "absent";
  const status = (input.status ?? "").toLowerCase();
  const health = (input.health ?? "").toLowerCase();
  if (/\b(?:exited|dead|removing)\b/.test(status)) return "crashed";
  if (/\b(?:created|configured)\b/.test(status)) return "configured";
  if (/\b(?:paused|stopped)\b/.test(status)) return "stopped";
  if (health === "unhealthy") return "unhealthy";
  if (input.probePassed === true || health === "healthy") return "ready";
  if (/\b(?:running|restarting|up)\b/.test(status)) return "starting";
  return "configured";
}
