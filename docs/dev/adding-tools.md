# Adding a Tool to Reaper — Dev Guide

This guide is the canonical checklist for adding any new tool to Reaper's main-agent
tool surface. It exists because, as of v0.1.x, a tool name has to be threaded through
**~10 separate locations** before the model can actually call it through to execution.

If you only edit one location and forget the rest, the model will appear to emit the
tool call correctly, but the runtime will silently drop it (or accept it, but execute
nothing). Every failure mode listed in §6 was caused by exactly that pattern.

> **Audience:** Reaper contributors. Not for the model. Not user-facing.
>
> **Goal:** a tool added by following §1–§5 is correctly callable, executable, and
> discoverable end-to-end, with green tests.

---

## 1. The full list of places a tool name must touch

There is **no single registry**. Adding a tool requires edits to (or awareness of)
every file below. §2–§5 explain each one and what to put in it.

| # | File | Why it has to know your tool |
|---|---|---|
| 1 | `src/tools/registry.ts` | `toolRegistry[name]` is the canonical `description` + `argsSchema` + `kind` entry. |
| 2 | `src/tools/types.ts` | `ToolCallSchema` (the discriminated union of all model-emitted tool calls). |
| 3 | `src/tools/tool-allowlist.ts` | `TOOL_ALLOWED_ARGS[name]` is the source of truth for `KNOWN_TOOLS` and is what `tool-allowlist` validation checks against. |
| 4 | `src/tools/normalize.ts` | `normalizeToolCall(input)` must have a `case` for your tool, otherwise the streaming pipeline silently drops args. **This was the silent killer for `file_edit` until June 2026.** |
| 5 | `src/runtime/agent-tools.ts` | `buildGeneralAgentTools()` — the function that builds the model-facing `tools` payload (name, description, JSON-Schema). |
| 6 | `src/runtime/main-agent-prompt.ts` | TOOL USE HINTS section in the system prompt: prose guidance that names your tool, when to use it, and when not to. |
| 7 | `src/tools/executor.ts` | `executeTool(...)` switch — the actual code path that runs when the tool is called. Bypass patterns for special tools (viewer, MCP, etc.) live here too. |
| 8 | `src/tools/viewer/dispatch.ts` (only viewer-style tools) | The dispatch table for viewer/file-edit operations. |
| 9 | `src/runtime/runtime-state.ts` / `src/runtime/tool-taxonomy.ts` | If your tool is `control` (plans/todos), `executable`, or `unknown`. The default is `executable` if it is in `KNOWN_TOOLS`. |
| 10 | Tests | At minimum: `toolcall-schema-viewer.test.ts` (or equivalent), `tool-allowlist-viewer.test.ts`, `normalize-tool-call.test.ts` if the tool has unusual arg aliasing, plus an integration test that runs the tool end-to-end against a fixture. |

Plus, depending on intent:

- **Always-on vs. on-demand** — `CORE_TOOL_NAMES` in `registry.ts` (controls whether
  the model sees it in the static tool list or only via `search_tools`).
- **Phase rollout** — `docs/viewer_tool_plan.md` and `docs/skills-and-extensions/`.
- **Description wording** — important for the model’s choices; copy patterns from
  existing descriptions, do not over-invent.

---

## 2. The four runtime drift points you must update

These four are the ones that, if you forget any of them, the tool silently fails.

### 2.1 `src/tools/registry.ts`

Add a new entry to the `toolRegistry` object:

```ts
my_tool: {
  description: "What the model should know, when to use it, and when not to.",
  argsSchema: MyToolArgsSchema,
  kind: "executable", // or "control" for plan/todo
},
```

Also decide:

- Add to `CORE_TOOL_NAMES` if it should always be rendered with full schema.
- Add to `DEMOTED_LEGACY_TOOL_NAMES` if it replaces a legacy tool.

### 2.2 `src/tools/types.ts` (the discriminated union)

Append to `ToolCallSchema`:

```ts
z.object({
  id: z.string().min(1),
  name: z.literal("my_tool"),
  args: MyToolArgsSchema,
}).strict(),
```

Without this, **the streaming code at `src/runtime/main-agent-node.ts` line 168**
(`if (!validated.success) continue;`) silently drops the call.

### 2.3 `src/tools/tool-allowlist.ts`

Add an entry to `TOOL_ALLOWED_ARGS`:

```ts
my_tool: ["path", "foo", "bar"],
```

`KNOWN_TOOLS` is auto-derived from the keys of this object; if you skip this step,
`getToolKind("my_tool")` returns `"unknown"` and `validateToolCallBatch` rejects it.

### 2.4 `src/tools/normalize.ts`

Add a `case` to the `switch (name)` block. This is where wire-format args become
canonical args. The default branch only preserves `path`/`cmd`/`cwd`, so any tool
with custom args needs an explicit case:

```ts
case "my_tool":
  args = {
    ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
    ...(typeof record.foo === "string" ? { foo: record.foo } : {}),
    ...(typeof record.bar === "number" ? { bar: record.bar } : {}),
  };
  break;
```

**This is the silent killer.** If you forget this, the streaming pipeline sends
your tool to `ToolCallSchema.safeParse` with only `path` filled in, and every call
fails validation.

---

## 3. The model-facing surface

### 3.1 `src/runtime/agent-tools.ts`

`buildGeneralAgentTools()` builds the JSON-Schema tool list sent to the provider.
Each tool entry has:

```ts
{
  name: "my_tool",
  description: "...", // match registry.ts
  inputSchema: { type: "object", properties: { ... }, required: [...] },
}
```

Make the description specific:

- **What** the tool does.
- **When to use** vs other tools (especially `bash`).
- **Side effects** — does it mutate? Does it need a checkpoint?
- **Argument shapes** — especially constraints like "must be 1-based" or "must be a workspace-relative path."

### 3.2 `src/runtime/main-agent-prompt.ts`

The TOOL USE HINTS block in the main-agent system prompt must:

- Name the tool.
- Show when to reach for it instead of `bash`.
- Show the preferred argument shape.
- For replaced legacy tools, call them out as “legacy / on-demand; prefer the new tool.”

---

## 4. Execution path

### 4.1 `src/tools/executor.ts`

The `executeTool` method has a switch on `call.name`. You need:

- Either an entry in the normal switch (uses `toolRegistry[call.name]`).
- Or, for special tools (viewer, MCP), an early bypass — see the `file_view`,
  `file_scroll`, `file_find`, `file_edit` block for the pattern.

If your tool needs pre-execution mutation checkpointing (see `src/runtime/checkpoints.ts`),
make sure `batchNeedsMutationCheckpoint` recognizes the name — it uses `isMutatingTool`.

### 4.2 Viewer-style tools (optional)

If your tool is a viewer-style op, also update:

- `src/tools/viewer/types.ts` — add the args Zod schema (`MyToolArgsSchema`).
- `src/tools/viewer/dispatch.ts` — add the dispatch case.
- `src/tools/viewer/viewer-registry.ts` — register any per-file state.

---

## 5. Tests you must add or update

The minimum viable test set is:

1. **Schema accepts the call** — add to `tests/unit/tools/toolcall-schema-*.test.ts`:
   ```ts
   { id: "x", name: "my_tool", args: { /* required fields */ } }
   ```
2. **Allowlist knows the tool** — add to `tests/unit/tools/tool-allowlist-*.test.ts`:
   ```ts
   assert.equal(isKnownToolName("my_tool"), true);
   assert.deepEqual(getAllowedArgs("my_tool"), ["path", "foo", "bar"]);
   ```
3. **Normalize preserves args** — add to `tests/unit/tools/normalize-*.test.ts` if
   the tool has alias or non-trivial arg shapes.
4. **End-to-end execution** — integration test that actually runs the tool against a
   temp workspace.

For viewer-style tools, there are additional tests:

- `viewer-types.test.ts` — schemas parse, strict-mode, refinement.
- `executor-viewer-cases.test.ts` — executor handles the call.
- `main-agent-prompt-viewer.test.ts` — prompt mentions the tool.
- `registry-viewer-phase2.test.ts` / `registry-viewer-phase4.test.ts` — registry
  wiring.
- `file-edit-rollback.test.ts` (integration) — for any mutating viewer op.

---

## 6. Failure modes we have already hit

These are the silent killers we found while porting the viewer tools. Every one of
them presented as “the model emits the tool call correctly but the runtime drops it”
or “the model never sees the tool at all.”

### 6.1 `ToolCallSchema` does not include the tool name

**Symptom:** model emits `my_tool` repeatedly with no execution trajectory.
**Root cause:** discriminated union in `src/tools/types.ts` does not have a
`z.object({ name: z.literal("my_tool"), ... })` variant.
**Why silent:** `src/runtime/main-agent-node.ts` line 168:
```ts
if (!validated.success) continue;
```
**Fix:** add the variant.

### 6.2 `tool-allowlist.ts` is missing the tool

**Symptom:** `validateToolCallBatch` adds a blocker:
```text
Unknown tool 'my_tool' is not allowed in this batch.
```
**Root cause:** `KNOWN_TOOLS` is derived from `TOOL_ALLOWED_ARGS` keys, which is
derived from `src/tools/tool-allowlist.ts`.
**Fix:** add `my_tool: [...]` to that object.

### 6.3 `normalizeToolCall` has no `case` for the tool

**Symptom:** model emits `my_tool` correctly, but only `path` survives, so the
schema parse fails.
**Root cause:** `default` branch in `src/tools/normalize.ts` only preserves `path`,
`cmd`, `cwd`. Custom args are dropped.
**Fix:** add a `case "my_tool":` branch.

### 6.4 `buildGeneralAgentTools()` does not expose the tool

**Symptom:** model never sees the tool name in its tool list. A/B logs show the
tool missing from the request payload.
**Root cause:** the static tool surface in `src/runtime/agent-tools.ts` does not
include it.
**Fix:** add the entry in `buildGeneralAgentTools()` with description and JSON Schema.

### 6.5 `CORE_TOOL_NAMES` swap needed for A/B

**Symptom:** tool is in registry but not in the model’s first-request `tools` list
during a build-style A/B.
**Root cause:** the runtime narrows the tool list for build tasks before artifacts
exist (see `selectGeneralAgentToolsForTurn`).
**Fix:** verify the tool appears in the build-fast-start surface; update
`build-fast-start-tools.test.ts` if it should be always-on for builds.

### 6.6 `getToolKind` returns `unknown`

**Symptom:** even with a `case` everywhere, validation fails with
`unknown_tool` blocker.
**Root cause:** tool name is missing from `KNOWN_TOOLS` because it is missing
from `TOOL_ALLOWED_ARGS`.
**Fix:** see §2.3.

### 6.7 Strict schema rejects harmless model metadata

**Symptom:** model emits `my_tool({ ..., reason: "because ..." })` and the call is
rejected.
**Root cause:** strict Zod schemas reject extra keys.
**Fix:** if the model often adds harmless metadata (e.g. `reason`), declare it as
`z.string().optional()` in the args schema. Models like to explain themselves; the
runtime should ignore the explanation, not reject the call.

### 6.8 `file_edit` and similar: separate dispatcher required

**Symptom:** tool is registered, normalized, allowed, schema-accepted, but never
appears in the trajectory.
**Root cause:** the executor has an early bypass for viewer tools, and they must
also be in `dispatchViewerTool`.
**Fix:** add the dispatch case in `src/tools/viewer/dispatch.ts`.

---

## 7. Verification recipe (after every change)

Run, in order:

```bash
# 1. Type-check
npx -y -p typescript tsc --noEmit -p tsconfig.json

# 2. Targeted tests
PATH=/opt/node22/bin:$PATH \
  node scripts/run-node-tests.mjs \
    tests/unit/tools/toolcall-schema-*.test.ts \
    tests/unit/tools/tool-allowlist-*.test.ts \
    tests/unit/tools/normalize-*.test.ts \
    tests/unit/tools/executor-viewer-cases.test.ts

# 3. Integration test (only for mutating tools)
PATH=/opt/node22/bin:$PATH \
  node scripts/run-node-tests.mjs \
    tests/integration/file-edit-rollback.test.ts

# 4. Smoke A/B on a small task
/tmp/reaper-pi-ab-smoke.sh
```

Step 4 is the actual integration test that proves the model sees the tool, emits
it correctly, and the runtime executes it. Look in
`.reaper/runs/exec-*/logs/reaper-trajectory.jsonl` for your tool name in
`tool_call` events with `status: completed`.

If you only see `tool_call ... status: started` with no `completed`, the tool
emitted but did not execute. Go back to §6.

---

## 8. Anti-patterns

- **Don’t rely on `ToolCallSchema` alone.** It validates but does not execute.
- **Don’t rely on `toolRegistry` alone.** It documents but does not normalize.
- **Don’t add the tool name to one place and call it done.** §1 lists all ten.
- **Don’t use `bash` to write files** unless you have no other choice. The model
  uses it because it is always available; the viewer tools are cheaper and safer.
- **Don’t add a `case` in `executor.ts` without also updating `registry.ts`** —
  the executor looks up `toolRegistry[name]` for schema and metadata.
- **Don’t strip `reason` from args in `normalizeToolCall`** — models add it
  intentionally. Let it pass through; the schema marks it optional.
- **Don’t invent a new arg-aliasing scheme.** Match the existing snake_case /
  camelCase pair convention used elsewhere (e.g. `start_line`/`startLine`).