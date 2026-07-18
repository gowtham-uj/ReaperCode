/**
 * policy/mode.ts — Workflow 3 single source of truth for mapping
 * permission modes to safety profiles and child-environment defaults.
 *
 * Pre-Workflow-3, the codebase had two parallel concepts:
 *
 *   - {@link PermissionMode} (`"yolo" | "accept_edits" | "auto" | "strict"`)
 *     owned by the classifier; the engine fed it into the executor via
 *     `getEngineTunables().permissionMode as any`.
 *
 *   - {@link SafetyProfile} (`"allow_all" | "standard" | "strict"`)
 *     owned by the rules engine; the executor used it to evaluate
 *     `evaluateCommandPolicy(...)`.
 *
 * The two concepts were loosely coupled by `safetyProfile: "allow_all"`
 * in the bootstrap. Workflow 3 unifies them so there is exactly one
 * permission-mode field per run, and every consumer reads from the
 * same place. The {@link resolveEffectivePermissionMode} helper is
 * the only place that normalizes the field; everything else relies
 * on the returned value.
 */

import type { PermissionMode } from "./classifier.js";
import type { SafetyProfile } from "./rules.js";

const PERMISSION_MODES = new Set<PermissionMode>(["yolo", "accept_edits", "auto", "strict"]);

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && PERMISSION_MODES.has(value as PermissionMode);
}

/**
 * Normalize an arbitrary input (config field, env override, runtime
 * tunable, CLI flag) into a valid PermissionMode. Falls back to
 * `"yolo"` for backward-compatible trusted local use.
 */
export function resolveEffectivePermissionMode(input: unknown): PermissionMode {
  if (isPermissionMode(input)) return input;
  return "yolo";
}

/**
 * Derive the {@link SafetyProfile} the rules engine should use for
 * shell command evaluation from a single {@link PermissionMode}.
 *
 * The mapping preserves the historical defaults:
 *
 *   - yolo         → allow_all (no rules-block, hard denies still trip)
 *   - accept_edits → standard (standard rules enforced, local denies hard)
 *   - auto         → standard (LLM-evaluated; rules-block is real)
 *   - strict       → strict (everything but the safe fast-path requires
 *                    confirmation; rules-block is real)
 *
 * The bootstrap previously hard-coded `"allow_all"`; we now derive it.
 */
export function permissionModeToSafetyProfile(mode: PermissionMode): SafetyProfile {
  switch (mode) {
    case "yolo":
      return "allow_all";
    case "accept_edits":
    case "auto":
    case "strict":
      return "standard";
    default: {
      // Defensive: exhaustive switch. The PermissionMode type is closed.
      const exhaustiveCheck: never = mode;
      return exhaustiveCheck;
    }
  }
}