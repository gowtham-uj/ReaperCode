export interface RuntimeDeadlinePressure {
  active: boolean;
  critical: boolean;
  elapsedMs: number;
  deadlineMs?: number;
  remainingMs?: number;
  feedback?: string;
  negativeConstraint?: string;
}

export function getRuntimeDeadlinePressure(startedAt: number, now = Date.now()): RuntimeDeadlinePressure {
  const deadlineMs = getRuntimeDeadlineMs();
  const elapsedMs = now - startedAt;
  if (!deadlineMs) {
    return { active: false, critical: false, elapsedMs };
  }
  const remainingMs = Math.max(0, deadlineMs - elapsedMs);
  const ratio = elapsedMs / deadlineMs;
  const active = ratio >= 0.65;
  const critical = ratio >= 0.82 || remainingMs <= 180_000;
  if (!active) {
    return { active: false, critical: false, elapsedMs, deadlineMs, remainingMs };
  }
  const minutesLeft = Math.max(0, Math.round(remainingMs / 60_000));
  return {
    active,
    critical,
    elapsedMs,
    deadlineMs,
    remainingMs,
    feedback: [
      critical ? "Runtime deadline is critical." : "Runtime deadline pressure is active.",
      `Approximate time remaining: ${minutesLeft} minute(s).`,
      "Switch to acceptance-first execution: produce required artifacts/outputs, run the narrowest real validation, and emit complete_task only after evidence. Avoid broad rewrites, repeated inspection, or large generated source payloads.",
    ].join(" "),
    negativeConstraint:
      "Do not spend deadline-critical time on broad refactors, dependency upgrades, repeated reads, or deep internals unless they directly block the visible acceptance artifact/check.",
  };
}

export function getRuntimeDeadlineMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const candidates = [
    env.REAPER_RUN_DEADLINE_MS,
    env.REAPER_AGENT_TIMEOUT_MS,
    env.REAPER_TBENCH_TIMEOUT_SEC ? String(Number(env.REAPER_TBENCH_TIMEOUT_SEC) * 1000) : undefined,
    env.REAPER_TBENCH_AGENT_TIMEOUT_SEC ? String(Number(env.REAPER_TBENCH_AGENT_TIMEOUT_SEC) * 1000) : undefined,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}
