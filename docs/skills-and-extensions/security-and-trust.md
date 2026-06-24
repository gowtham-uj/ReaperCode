# Security and Trust

This document describes the trust model, the policy-gate flow, the
deny codes you can observe, and the secret-redaction and
fault-isolation defaults.

## Trust states

Skills and extensions share the same trust tiers (extensions use a
slightly compressed subset):

| Tier | Source | Implication |
|---|---|---|
| `builtin` | shipped under `src/skills/built-in/` or `src/extensions/built-in/` | always trusted; body + tools load on demand |
| `user-trusted` | `~/.reaper/...` after install/approval | body + tools load on demand |
| `project-untrusted` | `<workspace>/.reaper/...` | body and tools require explicit approval |
| `extension-inherited` | skills inside an extension directory | trust follows the extension's trust |
| `draft` | `~/.reaper/skills/drafts/...` | body is **not** loadable; only `reaper skill test` and `reaper skill trust` are allowed |

The trust decision is recorded in `<installDir>/trust.json` and is
resolved by `TrustResolver.resolve({skillPath})` /
`ExtensionTrustResolver.resolve({extensionId, installPath})`.

## The policy gate

Every tool call goes through `evaluateToolCall` at
`src/governance/policy-engine.ts`. The decision tree:

1. **Is the tool name known?** Unknown names return
   `code: "unknown_tool"`. The executor's `hasTool` predicate is the
   union of `TOOL_METADATA` and `ExtensionToolRegistry.hasTool`.
2. **Is the metadata present?** Missing metadata returns
   `code: "no_metadata"`. This is what stops "shadow" tools that
   bypass the governance layer.
3. **Is the role allowed?** `RoleProfile` for the active role is
   checked against `metadata.forbidden_in_roles` /
   `metadata.allowed_in_roles`. Returns `code: "role_forbidden"`.
4. **Is approval required?** Tools with `requires_approval: true`
   return `code: "needs_approval"` on first call.
5. **Is the call sequenced well?** `preferred_before` violations
   produce an advisory note (not a hard block).

The gate is **synchronous and fail-closed**. There is no
`PERMISSIVE_MODE` flag in production.

## `activate_skill` hardening

The `activate_skill` tool (at `src/tools/read/activate-skill.ts`) is
the **only** path that loads a skill body into the model. It checks:

1. The skill name is in the allowlist (no path traversal).
2. The skill is not in a `draft` state.
3. The skill's trust is `builtin`, `user-trusted`, or
   `extension-inherited` (with the extension trusted).
4. The `disableModelInvocation` flag is `false` (set by
   `SkillRegistry.register` for untrusted skills; cleared by
   `reaper skill enable`).
5. The path resolves to a real file and is not a symlink pointing
   outside the skill root.

Any failure returns `code: "skill_blocked"` and the model never sees
the body.

## `HookRunner` security defaults

```ts
new HookRunner({ defaultTimeoutMs: 5000, securityFailClosed: true });
```

- `defaultTimeoutMs` — per-handler timeout. Override per registration
  with `{timeoutMs}`.
- `securityFailClosed` — when `true`, a timeout/error on a security
  event (`PreToolUse`, `Stop`, `UserPromptSubmit`, `PreSkillInvoke`)
  collapses to `allow: false` with the first deny reason. Set
  `false` only for tools in development.

The `RunWithExtension` envelope for `activate(ctx)` adds a 60s
hard-kill timeout on top of the per-handler one.

## Secret redaction

`ExtensionLoggerSink` (and the existing `Hooks.emit`) redacts known
secret patterns before emission. Use `ctx.log.info` / `warn` / `error`
freely — secrets are stripped automatically. The `Redaction` module
in `src/adaptive/redact.ts` is the source of truth for the patterns.

## Permission grants

Extensions ask for permissions in `extension.json` (the contract).
The runtime grants are tracked separately by
`ExtensionPermissionManager` and are what `executeTool` checks at
call time. `reaper extensions trust <id>` promotes the grant set to
match the manifest.

The `registerTool` sink grants the tool's required permission
*during* activation (derived from `metadata`), so the install
pipeline can refuse tools that ask for permissions the manifest
does not list.

## Slash-command trust

A slash command registered by an untrusted extension still works
when the extension is enabled. The trust gate fires on the
contributions (tools, hooks) the command may indirectly trigger,
not on the command itself. The `ConsoleHost` (CLI) and a future
`TUIHost` enforce that destructive operations still require
`confirm` — never an auto-yes.

## No raw secrets in `log`

`log.info(msg, ...)` runs the message and any structured args
through `redactSecrets` before writing to the sink. The CLI sink
goes to `stderr` for warnings/errors and `stdout` for info. The
TUI sink formats with the conversation pane renderer.

## Tool metadata is the contract

`metadata` is the **only** way to introduce a tool that the policy
gate accepts. `ExtensionToolRegistry.register` enforces the
constraint at registration time; `evaluateToolCall` enforces it at
call time. Two layers of defense — if a future bug lets one slip,
the other still catches it.
