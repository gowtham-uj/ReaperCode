# Extension Authoring

An extension is a TypeScript/JS package. The runtime loads
`extension.json` and the `main` entry, then calls
`default.activate(ctx)`. The author registers contributions through
the `ctx` object.

## Folder layout

```
my-extension/
  extension.json        # required — manifest
  package.json          # required — npm metadata
  src/
    activate.ts         # required — exports default { activate(ctx), deactivate? }
    tools/
      echo.ts           # tool implementation
      echo.metadata.ts  # ToolMetadata — REQUIRED for every tool
    commands/
      hello.ts          # slash command handler
```

## `extension.json` schema

```json
{
  "id": "hello",
  "version": "1.0.0",
  "description": "Example extension with one tool and one slash command.",
  "main": "dist/index.js",
  "engines": { "reaper": "^1.0.0" },
  "permissions": ["tools:read_file"],
  "contributes": {
    "tools": [
      { "name": "hello.echo", "description": "Echo a string back to the model" }
    ],
    "slashCommands": [
      { "name": "hello", "description": "Say hello" }
    ],
    "hooks": [
      { "event": "PreToolUse", "timeoutMs": 2000 }
    ]
  }
}
```

### Required fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | `^[a-z][a-z0-9-]{0,63}$` |
| `version` | string | semver |
| `description` | string | one-line summary |
| `main` | string | path relative to the extension root |
| `engines.reaper` | string | semver range |
| `permissions` | string[] | extension permission tokens (see Security doc) |

## `package.json` requirements

```json
{
  "name": "hello",
  "version": "1.0.0",
  "main": "dist/index.js",
  "engines": { "reaper": "^1.0.0" }
}
```

`engines.reaper` is checked at install. A peer-dep conflict on the
`reaper` major is a hard install failure.

## `activate(ctx)` lifecycle

```ts
import type { ReaperExtensionContext } from "reaper";

export default {
  activate(ctx: ReaperExtensionContext): void {
    // 1. Register a tool. metadata is REQUIRED.
    ctx.registerTool({
      name: "hello.echo",
      description: "Echo a string",
      schema: { type: "object", properties: { msg: { type: "string" } } },
      metadata: {
        name: "hello.echo",
        category: "read",
        risk_level: "low",
        is_read_only: true,
        can_modify_files: false,
        can_execute_code: false,
        can_control_ui: false,
        can_affect_host: false,
        requires_approval: false,
        preferred_before: [],
        preferred_after: [],
        forbidden_in_roles: [],
        allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
      },
      handler: async ({ msg }) => ({ ok: true, output: msg }),
    });

    // 2. Register a slash command.
    ctx.registerSlashCommand({
      name: "hello",
      description: "Say hello",
      handler: () => ({ ok: true, output: "Hello!" }),
    });

    // 3. Register a hook.
    ctx.registerHook({
      event: "PreToolUse",
      handler: (env) => {
        ctx.log.info(`pre-tool-use: ${env.event}`);
        return { allow: true };
      },
      timeoutMs: 2000,
    });

    // 4. Ask for a permission at runtime (CLI: no-op; TUI: prompt).
    void ctx.permissions.request("tools:read_file");
  },
  deactivate(): void {
    // optional; called on disable / shutdown
  },
};
```

## Contribution kinds

The full list, all registered via the same `ctx`:

| Method | Purpose |
|---|---|
| `ctx.registerTool(reg)` | register a callable tool (metadata required) |
| `ctx.registerSkill(reg)` | contribute a `SkillManifest` to the runtime |
| `ctx.registerSlashCommand(reg)` | add a `/command` |
| `ctx.registerHook(reg)` | add a hook handler with a per-event timeout |
| `ctx.registerPanel(reg)` | add a TUI panel (CLI ignores this) |
| `ctx.registerContextProvider(p)` | contribute a context source |
| `ctx.registerModelProvider(p)` | contribute a model adapter |
| `ctx.registerRepoAnalyzer(a)` | contribute a repo analyzer |
| `ctx.registerTestRunner(tr)` | contribute a test runner |
| `ctx.registerDiffRenderer(d)` | contribute a diff renderer |

## Tool metadata — why it is required

The policy gate at `src/governance/policy-engine.ts` denies any tool
call whose name has no `ToolMetadata` entry. The two-line guarantee
this gives you:

1. **Every extension tool is classified** — risk level, category,
   role allowlist.
2. **Every extension tool is policy-checked** — the role profile and
   preferred-ordering rules apply.

If you forget the metadata, the install pipeline rejects your
extension. If you try to register at runtime without metadata,
`ExtensionToolRegistry.register` returns `{ok:false, error: "..."}`.

## Hook timeouts

`HookRunner` enforces a per-handler timeout (default 5000ms;
configurable per registration). A timeout on a security event
(`PreToolUse`, `Stop`, `UserPromptSubmit`, `PreSkillInvoke`) collapses
to `allow: false` when `securityFailClosed` is on. The default is
`securityFailClosed: true`. Use a small `timeoutMs` for time-critical
gates; a longer one for analytics.

## Fault isolation

A thrown error in `activate(ctx)` becomes
`{status: "failed", error}` on the `LoadedExtension` and the host
keeps running. The hook bridge schedules a microtask so your handler
never blocks the engine. Use try/catch inside long-running handlers
to keep partial state out of the engine's critical path.
