import { z } from "zod";

export const BudgetStateSchema = z
  .object({
    maxTurns: z.number().int().positive().optional(),
    turnsUsed: z.number().int().min(0),
    maxToolCalls: z.number().int().positive().optional(),
    toolCallsUsed: z.number().int().min(0),
    maxModelCalls: z.number().int().positive().optional(),
    modelCallsUsed: z.number().int().min(0),
    warnings: z.array(z.string()),
  })
  .strict();

export type BudgetState = z.infer<typeof BudgetStateSchema>;

export interface BudgetLimits {
  maxTurns?: number;
  maxToolCalls?: number;
  maxModelCalls?: number;
}

export interface BudgetUsage {
  turns?: number;
  toolCalls?: number;
  modelCalls?: number;
}

const WARNING_THRESHOLD = 0.8;

export function createBudgetState(limits: BudgetLimits = {}): BudgetState {
  const state = BudgetStateSchema.parse({
    ...limits,
    turnsUsed: 0,
    toolCallsUsed: 0,
    modelCallsUsed: 0,
    warnings: [],
  });

  return {
    ...state,
    warnings: deriveBudgetWarnings(state),
  };
}

export function recordBudgetUsage(state: BudgetState, usage: BudgetUsage): BudgetState {
  const nextState = BudgetStateSchema.parse({
    ...state,
    turnsUsed: state.turnsUsed + normalizeIncrement(usage.turns ?? 0, "turns"),
    toolCallsUsed: state.toolCallsUsed + normalizeIncrement(usage.toolCalls ?? 0, "toolCalls"),
    modelCallsUsed: state.modelCallsUsed + normalizeIncrement(usage.modelCalls ?? 0, "modelCalls"),
  });

  return {
    ...nextState,
    warnings: deriveBudgetWarnings(nextState),
  };
}

export function renderBudgetStateForCockpit(state: BudgetState): string {
  const warnings = state.warnings.length ? state.warnings : deriveBudgetWarnings(state);

  return [
    "# Budget State",
    `Turns: ${renderUsage(state.turnsUsed, state.maxTurns)}`,
    `Tool calls: ${renderUsage(state.toolCallsUsed, state.maxToolCalls)}`,
    `Model calls: ${renderUsage(state.modelCallsUsed, state.maxModelCalls)}`,
    `Warnings: ${warnings.length ? warnings.join("; ") : "none"}`,
  ].join("\n");
}

function deriveBudgetWarnings(state: BudgetState): string[] {
  return [
    renderBudgetWarning("Turns", state.turnsUsed, state.maxTurns),
    renderBudgetWarning("Tool calls", state.toolCallsUsed, state.maxToolCalls),
    renderBudgetWarning("Model calls", state.modelCallsUsed, state.maxModelCalls),
  ].filter((warning): warning is string => Boolean(warning));
}

function renderBudgetWarning(label: string, used: number, max: number | undefined): string | undefined {
  if (max === undefined) return undefined;
  if (used > max) return `${label} used ${used}/${max} exceeds the configured limit.`;
  if (used / max >= WARNING_THRESHOLD) return `${label} used ${used}/${max} is near the configured limit.`;
  return undefined;
}

function renderUsage(used: number, max: number | undefined): string {
  return max === undefined ? `${used} / unlimited` : `${used} / ${max}`;
}

function normalizeIncrement(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} usage increment must be a non-negative integer.`);
  }
  return value;
}
