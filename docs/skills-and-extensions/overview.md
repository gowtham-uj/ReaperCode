# Skills and Extensions

Reaper ships with a **local plugin architecture** — no MCP, no remote
servers. Two complementary surfaces:

| Surface | What it is | Where it lives |
|---|---|---|
| **Skill** | A folder of `skill.json` + `SKILL.md` describing a focused capability. The router picks relevant skills for a prompt and surfaces only the manifest summary; the body is loaded into the model only on explicit `activate_skill` invocation. | `src/skills/built-in/`, `~/.reaper/skills/`, `<workspace>/.reaper/skills/`, extension-contributed |
| **Extension** | A TypeScript/JS package that registers tools, slash commands, hooks, panels, context providers, etc. via `activate(ctx)`. | `src/extensions/built-in/` (none today), `~/.reaper/extensions/`, `<workspace>/.reaper/extensions/` |

The two systems share three things:

1. **Trust** — every install path resolves to one of the trust tiers
   (`builtin`, `user-trusted`, `project-untrusted`, `extension-inherited`,
   `draft`). The trust decision controls whether the body/tool loads.
2. **Tool policy gate** — the `evaluateToolCall` policy gate at
   `src/governance/policy-engine.ts` requires every tool to have a
   `ToolMetadata` entry. Extension tools must register metadata or be
   denied with `code: "no_metadata"`.
3. **Hook system** — a single `HookRunner` sits on top of the existing
   `Hooks` (skill/memory/swarm) and `ExtensionBus` (typed event bus).
   Per-handler timeouts and per-extension fault isolation are
   non-negotiable defaults.

## Trust model

| Location | Default trust | Promoted by |
|---|---|---|
| `src/skills/built-in/...` | `builtin` | (always trusted) |
| `~/.reaper/skills/...` | `user-trusted` | `reaper skill add --trust` |
| `<workspace>/.reaper/skills/...` | `project-untrusted` | `reaper skill trust <name>` |
| `<extension>/skills/...` | inherits extension trust | (cascade) |
| `~/.reaper/skills/drafts/...` | `draft` | `reaper skill test && reaper skill trust` |
| `src/extensions/built-in/...` | `builtin` | (always trusted) |
| `~/.reaper/extensions/...` | `user-trusted` | `reaper extensions add` (after install) |
| `<workspace>/.reaper/extensions/...` | `project-untrusted` | `reaper extensions trust <id>` |

`user-trusted` is the only tier whose bodies and tools are loaded into
the model without a confirmation gate. `project-untrusted` skills
still get the body in the router summary view, but `activate_skill`
refuses to load the body without explicit user approval.

## CLI cheatsheet

### Skills
```
reaper skill list                       # enumerate installed skills
reaper skill add <path> --scope user --trust
reaper skill show <name>
reaper skill enable <name>              # clear runtime gate
reaper skill disable <name> [--reason]
reaper skill trust <name>               # promote to user-trusted
reaper skill untrust <name>
reaper skill test <name>                # run validation.commands
reaper skill doctor <name>              # manifest + trust + tool-allowlist check
reaper skill create <name>              # author a new skill (lands as draft)
reaper skill search <query>             # router top-N (no body)
```

### Extensions
```
reaper extensions list
reaper extensions add <path> --scope user
reaper extensions enable <id>
reaper extensions disable <id>
reaper extensions trust <id>
reaper extensions untrust <id>
reaper extensions doctor <id>           # manifest + toolsHaveMetadata + activation
reaper extensions remove <id>
```

### Slash commands
The slash command registry is host-agnostic. The CLI surfaces it via
`reaper /<group>`. A future TUI imports the same `SlashCommandRegistry`
and calls `registry.handle(line)`.

```
reaper /skills list
reaper /extensions list
```

## Architectural notes

- **Bodies are never injected.** The `SkillRouter` returns a
  `SkillSummary` (name, description, category, trust, score). The
  body lives in `InstalledSkillRecord` and is only read by the
  hardened `activate_skill` tool (`src/tools/read/activate-skill.ts`)
  after the trust and allowlist checks pass.
- **Tools must register metadata.** `ExtensionToolRegistry.register`
  returns `{ok:false}` if `metadata` is missing, and the executor's
  policy gate independently denies any tool without metadata at
  call-time. This is two layers of defense.
- **Hooks never block the engine.** `HookRunner` uses a microtask
  boundary. Security events (`PreToolUse`, `Stop`, `UserPromptSubmit`,
  `PreSkillInvoke`) collapse to deny on timeout/error when
  `securityFailClosed` is on.
- **Fault isolation.** Every `activate(ctx)` runs in a
  `runner.runWithExtension(...)` envelope with a 60s hard timeout. A
  thrown error becomes `{status: "failed", error}` on the
  `LoadedExtension` — the host never sees the exception.
