# Tier 1 — Type-safe Reaper (behavior-preserving)

Date: 2026-06-21
Author: Pi (Reaper dev cockpit)
Mode: IMPLEMENT (per AGENTS.md)

## Goal

Eliminate every type-safety escape hatch that the type checker is currently
flagging or that hides bugs at the runtime seam. Zero behavior change.
Unblocks `npm run typecheck` as a CI gate.

## Scope (5 items)

### T1.1 — Fix two real type errors (unblocks `npm run typecheck`)

**File 1:** `src/recovery/session.ts:58`

Current code:

```ts
kind: "recovery_summary",
...
outcome: "merge_conflict",
```

But `src/logging/schema.ts:60` declares:

```ts
outcome: z.enum(["success", "failure"])
```

So the recovery trajectory emits a value the schema rejects. Two-step fix:

1. Add `"merge_conflict"` to the `recovery_summary.outcome` enum in
   `src/logging/schema.ts`. Use `z.enum(["success", "failure", "merge_conflict"])`.
2. Verify `recovery/session.ts` now type-checks.

This is the same value the runtime was already producing; the type system
was lying. This is a bug fix, not a behavior change.

**File 2:** `src/tools/executor.ts:1133`

Current code constructs a `ManagedBackgroundProcess` missing the required
`startedAtMs: number` field (declared at line 171). Add `startedAtMs: Date.now()`
to the literal at line 1133. Mirror of line 1097 in the sibling code path.

### T1.2 — Replace 8 `as any` casts in background-process path

`src/tools/executor.ts` lines 1090, 1091, 1131, 1132, 1145 all cast the
shell-tool result to `any` to check for a `child` property. The shell tool
already returns a typed result; we just need to type the union.

**Step 1:** In `src/tools/global/run-shell-command.ts` (line ~149), replace
the implicit `as any` on the background-spawn return with an exported
`BackgroundShellResult` type:

```ts
export interface BackgroundShellResult {
  pid: number;
  status: "running";
  wouldBlock: boolean;
  logPath?: string;
  startupOutput: string[];
  child: import("node:child_process").ChildProcess;
}
```

**Step 2:** Make `runShellCommandTool`'s return type a discriminated union:
`ForegroundShellResult | BackgroundShellResult`. The existing `"child" in result`
check becomes a proper type guard.

**Step 3:** In `executor.ts` lines 1090–1106 and 1131–1146, drop the 5
`as any` casts and use the discriminated union. `ManagedBackgroundProcess`
construction gains its `startedAtMs` in both branches.

Net: 8 `as any` casts → 0, plus a real type guard instead of string-key
detection.

### T1.3 — Replace 3 `as any` casts on tool args

`src/tools/executor.ts` lines 336, 348, 384 cast `args` to `any` because
the `ToolResult.args` field is typed `z.unknown().optional()`.

The casts are unnecessary because zod has already validated the input
(or the call failed before reaching this branch). Replace `args: call.args as any`
with `args: normalizedCall.args ?? call.args` typed as `unknown` (matches
the schema). The runtime behavior is identical; the cast was defensive
overhead. Three casts → zero.

### T1.4 — Typed provider response layer

Today the five provider clients each parse JSON with `as any`:
- `src/model/providers/anthropic.ts:50-57` (5 casts in this block)
- `src/model/providers/openrouter.ts` (3 casts)
- `src/model/providers/cerebras.ts` (3 casts)
- `src/model/providers/deepseek.ts` (1 cast)
- `src/model/providers/litellm-gateway.ts` (count TBD)

**Step 1:** Add `src/model/providers/response.ts` with a discriminated union:

```ts
export interface AnthropicMessagesResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface OpenAIChatResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export type ProviderResponse =
  | { family: "anthropic-messages"; raw: AnthropicMessagesResponse }
  | { family: "openai-chat"; raw: OpenAIChatResponse };
```

**Step 2:** Each provider client imports the right raw type, validates
with a small zod schema, and parses once. The `as any` casts become
zod-validated `parsed.data` access.

Behavior identical. Compile-time safety net for new provider families.

### T1.5 — Scope `MINIMAL_PREP_CACHE`

`src/runtime/engine.ts:12051` declares a module-level `Map` keyed only by
`workspaceRoot`. In a long-lived process (TUI session, control-plane
server) the cache returns stale `ContentPrepResult` after the user
opens a different workspace.

**Fix:** Key by `${workspaceRoot}::${configFingerprint}`. Compute
`configFingerprint` from the parsed `ReaperConfig` (stable JSON hash,
or `JSON.stringify` if a hash util is overkill). Invalidate on config
change rather than never.

Add a small `fingerprintConfig(config: ReaperConfig): string` helper
alongside `getEnvironmentFingerprintSync` (same file: `fingerprint.ts`).

## Verification

After all five changes:

```
npm run typecheck   # must pass with zero errors
npm test            # 128 tests must still pass
```

If `npm test` is slow (>2 min) and pure type-safety changes can't have
broken behavior, scope tests to:
- `tests/integration/runtime-engine.test.ts`
- `tests/integration/recovery-phase3.test.ts`
- `tests/integration/tools-executor.test.ts`
- `tests/integration/logging-artifacts.test.ts`

These four cover the four files we're touching.

## Risks

- **T1.1** changes a zod enum that downstream consumers may parse. Mitigation: read
  the trajectory replay path first; ensure it doesn't reject unknown
  outcomes. (We are *adding* to the enum, not removing values — backward
  compatible.)
- **T1.2** widens the run-shell-command return type. Mitigation: verify
  both call sites (executor.ts:1081 and 1122) match; if `shellRunner`
  option is also used, ensure it accepts the same union.
- **T1.3** changes the `args` field type from `any` to `unknown`. Any
  consumer that read `args.cmd` or `args.path` directly off the result
  would need updating. Mitigation: search for `result.args` reads in
  tests.
- **T1.4** is the largest change surface. Mitigation: do one provider
  first (anthropic), run typecheck, then roll the rest.
- **T1.5** invalidates the cache across config changes. That is the fix;
  users who swap workspaces will now get a fresh content prep.

## Out of scope (Tier 2 / 3)

Everything in the 15-item plan above Tier 1. Each will get its own
plan file in `.hermes/plans/`.
