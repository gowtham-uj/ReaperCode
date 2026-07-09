# Reaper Implementation Research

Date: 2026-07-02

Related source:
- Reaper repo: `/workspace/reapercode-main`
- Oh My Pi source snapshot: `/workspace/focus_sources/oh-my-pi`
- Oh My Pi GitHub source: `https://github.com/can1357/oh-my-pi`

## Purpose

This report analyzes how Oh My Pi (OMP) designs its core agent tools and how those ideas can be used to improve Reaper's tool system.

The goal is not to replace Reaper's current tools wholesale. Reaper already has strong optimized ACI-style file read, file view, file edit, shell, background process, discovery, subagent, and context-management primitives. The highest-value path is selective porting: bring over OMP tool capabilities and architecture where they add speed, efficiency, reliability, or context control, while preserving Reaper's better existing pieces.

## Required Reaper Design Rule

Reaper must remain powerful scaffolding around the model.

Tool design must not introduce blocking, forcing, or guard behavior that blocks, guards, forces, or routes model tool calls against the model's choice.

Concretely:
- Do not add approval gates that force user/model routing.
- Do not add forced tool choice flows.
- Do not add hard resolve requirements.
- Do not add policy blockers that prevent a model-selected tool from running just because the host prefers another tool.
- Prefer advisory feedback, diagnostics, metadata, and tool results.
- Let the model choose the next tool call after seeing results.

Valid tool failures should still exist for real operational facts:
- Invalid schema or malformed arguments.
- Missing file.
- Invalid line range.
- Ambiguous exact edit.
- Process not found.
- Filesystem or OS errors.

Those are not policy guards; they are execution facts.

## Executive Summary

Yes, Reaper can benefit from porting OMP core tools where they add value.

The best OMP ideas to adopt are:
- A richer per-tool metadata contract.
- Shared/exclusive concurrency scheduling.
- A normalized result envelope with structured details and context hints.
- BM25-based tool discovery.
- Additional edit modes such as `apply_patch` and hashline.
- Unified async job management.
- Better post-write diagnostics.
- A small `glob` tool.
- Optional fast `eval` for low-overhead analysis.

The best OMP ideas to avoid or heavily adapt are:
- Approval blocking.
- Forced resolve flows.
- Forced tool-choice behavior.
- Any tool policy that prevents the model from executing a chosen tool path.

Reaper should port OMP capabilities, not OMP control policy.

## Current Reaper Strengths

### File Viewing

Reaper's `file_view`, `file_scroll`, `file_find`, and `file_edit` tools are already a strong context-management system.

Relevant files:
- `src/tools/registry.ts`
- `src/tools/viewer/dispatch.ts`
- `src/tools/viewer/viewer-registry.ts`

Strengths:
- Persistent per-file viewport state.
- Small line-window reads instead of full-file context dumping.
- Scroll and find operations that preserve context.
- SHA and mtime tracking.
- Numbered lines.
- Window clamping.

Recommendation: keep this design. Do not replace it with OMP's basic read model.

### Read File

Reaper's `read_file` remains useful as a legacy/full fallback.

Relevant file:
- `src/tools/read/read-file.ts`

Strengths:
- Bounded unbounded reads.
- Image detection and base64 attachment payloads.
- Unique basename fallback.
- Truncation notes that suggest targeted follow-up reads.

Recommendation: keep it as a compatibility and fallback tool. Prefer `file_view` for normal model-facing file inspection.

### Exact Edits And Mutation Queue

Reaper's `edit_file`, `replace_in_file`, `file_edit`, and mutation queue already provide important safety against overlapping writes and stale exact replacements.

Relevant files:
- `src/tools/write/edit-file.ts`
- `src/tools/write/replace-in-file.ts`
- `src/tools/write/file-mutation-queue.ts`
- `src/tools/viewer/dispatch.ts`

Strengths:
- Exact block edit support.
- Multi-edit support.
- Already-applied detection.
- Line-ending normalization.
- Quote normalization.
- Per-file mutation serialization.
- Checkpoint/snapshot integration.

Recommendation: preserve these. Add new OMP-style patch modes alongside them.

### Discovery

Reaper already has core and on-demand tools.

Relevant files:
- `src/tools/registry.ts`
- `src/tools/discovery.ts`
- `src/tools/write/search-tools.ts`
- `src/runtime/engine.ts`

Strengths:
- Core tool list.
- On-demand tool list.
- `search_tools` promotion.
- Per-run discovered tool state.

Recommendation: keep the mechanism, replace the ranking/indexing engine with a stronger OMP-style BM25 catalog.

### Background Processes

Reaper already has background process tools.

Relevant files:
- `src/tools/background-process-manager.ts`
- `src/tools/registry.ts`
- `src/tools/executor.ts`

Strengths:
- Background command support.
- Output polling.
- Signaling.
- Stdin writes.

Recommendation: keep the manager and existing tools, but add a unified `job` facade similar to OMP.

## OMP Tool Architecture Lessons

### AgentTool Contract

OMP defines tools through a rich contract.

Relevant file:
- `packages/agent/src/types.ts`

Important fields:
- `label`
- `hidden`
- `deferrable`
- `loadMode`
- `summary`
- `concurrency`
- `lenientArgValidation`
- `interruptible`
- `approval`
- `execute`
- `renderResult`
- result `content`
- result `details`
- result `isError`
- result `useless`

Lesson for Reaper:
Reaper's registry is currently too flat. A new metadata layer should be added around existing tools, without rewriting all tool bodies first.

### Tool Creation And Discovery

OMP defines default essential tools and discoverable tools.

Relevant file:
- `packages/implementation/src/tools/index.ts`

OMP default essential tools:
- `read`
- `bash`
- `edit`
- `write`
- `glob`
- `eval`

OMP also includes discoverable or optional tools:
- `ast_grep`
- `ast_edit`
- `ask`
- `debug`
- `ssh`
- `github`
- `grep`
- `lsp`
- `inspect_image`
- `browser`
- `checkpoint`
- `rewind`
- `task`
- `job`
- `todo`
- `web_search`
- `search_tool_bm25`
- memory tools
- skill/autolearn tools

Lesson for Reaper:
Keep a small core set, but make discovery much smarter. The model should be able to find specialized tools without every full schema being in context.

### Execution Pipeline

OMP's agent loop validates tool calls, runs before/after hooks, coerces malformed results, streams partial updates, and schedules tools based on shared/exclusive concurrency.

Relevant file:
- `packages/agent/src/agent-loop.ts`

High-value ideas:
- Result coercion.
- Structured tool events.
- Partial update handling.
- Shared/exclusive scheduling.
- Interruptible wait/poll tools.

Adaptation for Reaper:
Adopt the scheduling and result normalization ideas. Do not adopt blocking hooks.

### BM25 Tool Discovery

OMP's `search_tool_bm25` searches discoverable tools and activates matches.

Relevant file:
- `packages/implementation/src/tools/search-tool-bm25.ts`

Lesson for Reaper:
Replace Reaper's simple keyword scoring with an indexed search over:
- Tool name.
- Normalized aliases.
- Summary.
- Description.
- Schema keys.
- Examples.
- Tool family.
- Capability tags.
- MCP/custom tool origin.

Discovery should remain advisory and model-driven.

### Edit Tool Modes

OMP's edit tool supports multiple modes, including patch-style and grammar-constrained forms.

Relevant file:
- `packages/implementation/src/edit/index.ts`

High-value ideas:
- `apply_patch` custom wire name.
- Lark grammar for patch syntax.
- Hashline mode.
- Patch mode.
- Matcher digest and matcher path projections.
- Per-file edit metadata.

Adaptation for Reaper:
Add these as extra edit paths. Keep Reaper's `file_edit` as the primary fast line-range edit tool.

### Bash Tool

OMP's bash tool has:
- Async support.
- Auto-background support.
- Shared/exclusive concurrency based on PTY.
- Structured result details.
- Output caps.
- Non-zero exit represented as a completed error result.

Relevant file:
- `packages/implementation/src/tools/bash.ts`

Adaptation for Reaper:
Reaper already has a good shell implementation. Port result-shaping, concurrency metadata, and job integration ideas, not blocking approval behavior.

### Job Tool

OMP's `job` tool gives a single interface for async job listing, polling, and cancellation.

Relevant file:
- `packages/implementation/src/tools/job.ts`

Adaptation for Reaper:
Add a `job` facade over:
- `read_background_output`
- `signal_process`
- `write_to_process`
- async bash jobs
- async subagent jobs

Keep existing process tools for backward compatibility and discoverability.


### Approval And Resolve

OMP has approval and resolve protocols.

Relevant files:
- `packages/implementation/src/tools/approval.ts`
- `packages/implementation/src/tools/resolve.ts`

These are useful to understand, but should not be copied directly into Reaper because they conflict with the required Reaper design rule.

Safe adaptation:
- Keep capability tier metadata for display, logging, and diagnostics.
- Do not use it to block, force, or redirect model tool calls.

## Reaper Hard Stops To Soften

Some current Reaper behavior conflicts with the desired no-blocking/no-forcing direction. These should be softened as part of the implementation plan.

### Unknown Tool Loop Escalation

Current behavior:
- Unknown tool calls trigger suggestions.
- Repeated unknown tool calls escalate to an `UNKNOWN_TOOL_LOOP` style hard message.

Recommendation:
- Keep suggestions.
- Keep discovery matches.
- Remove escalation language that forces registered tools.
- Return advisory discovery results and let the model decide.

### Permission Classification

Current behavior:
- Dangerous classification can throw permission denied.

Recommendation:
- Convert policy classification into result metadata and warnings where possible.
- Keep host-level capability boundaries only where necessary for runtime integrity.
- Do not let policy classification become a model-routing guard.

### PreToolUse Hooks

Current behavior:
- `PreToolUse` hooks can be blockable.

Recommendation:
- Make hooks advisory by default.
- Hook output can add warnings, hints, annotations, or telemetry.
- Avoid hook-driven blocking of model calls.

### Safe Edit Threshold

Current behavior:
- Large-file edits can be blocked unless the file or range has been read.

Recommendation:
- Convert this to an advisory warning.
- Return snapshot metadata and line-count warnings.
- Allow the model to choose whether to continue, read more, or use AST/patch tools.

### Bash Timeout Requirement

Current behavior:
- Bash requires an explicit timeout.

Recommendation:
- Prefer default timeout plus advisory note.
- Allow model-provided timeout to override.
- Clamp extremes.
- Do not fail only because timeout was omitted.

### Lint Rollback In `file_edit`

Current behavior:
- `file_edit` lints candidate content before writing.
- If lint fails, the tool returns success but rolls back/does not persist.

Recommendation:
- Default should be write-then-diagnose.
- Return diagnostics in the result.
- Let the model fix or revert.
- Optional preview/rollback mode can exist only when the model explicitly asks for it.

## OMP Port Candidates

| OMP Tool | Reaper Status | Recommendation |
|---|---|---|
| `read` | Reaper already has `file_view`, `file_scroll`, `file_find`, `read_file` | Do not replace. Port structured result metadata and maybe reusable rendering concepts. |
| `edit` | Reaper has strong line/window edits and exact edit tools | High-value port. Add `apply_patch` and hashline modes as extra edit paths. Keep `file_edit` primary. |
| `write` | Reaper has `write_file` | Port post-write diagnostics and structured result details. Do not add approval gates. |
| `bash` | Reaper has bash and background process support | Port concurrency metadata, async/job result shape, output capping, and auto-background ideas. |
| `glob` | Reaper has `list_directory` and `grep_search` | Add a dedicated fast `glob` tool to reduce shell usage and context overhead. |
| `eval` | Reaper mostly uses bash/tests for one-off probes | Add discoverable `eval` for fast JS/Python snippets, JSON transforms, AST probes, and low-overhead analysis. |
| `search_tool_bm25` | Reaper has simple `search_tools` | High-value port. Replace simple scoring with BM25-style indexed discovery. |
| `job` | Reaper has background process tools | Add a unified `job` facade while keeping old process tools. |
| `task` | Reaper has agents/subagents | Port async progress, result aggregation, and concurrency controls. Preserve Reaper's advisory-subagent policy. |
| `ast_grep` | Reaper has grep and tree-sitter-adjacent tooling | Add discoverable AST search if it is reliable and fast. |
| `ast_edit` | Reaper has `replace_symbol` | Add discoverable AST edit only after good diagnostics and dry-run output exist. |
| `lsp` | Reaper has linter/diagnostic pieces | Port post-write/deferred diagnostics model. Avoid default rollback. |
| `checkpoint` / `rewind` | Reaper already has checkpoints | Leave mostly alone. Improve result rendering if useful. |
| `browser` | Reaper has browser/computer controls | Compare later for feature gaps. Not first priority. |
| `web_search` | Reaper has web search | Leave alone unless OMP has better result shaping. |
| `github` | Reaper may have partial external integrations | Defer. Useful but not core file/tool efficiency. |
| memory tools | Reaper has skills/context systems | Defer. Lower priority than core tool execution. |
| `learn` / skill tools | Reaper has skill mechanisms | Defer or map into Reaper skills later. |
| approval/resolve | Reaper must avoid blockers/forcing | Do not port directly. Only use metadata/display ideas. |

## What Should Be Left Alone

### Keep `file_view`, `file_scroll`, `file_find`

These are efficient and context-aware. OMP's `read` does not replace their value.

Enhancements only:
- Add snapshot IDs.
- Add result `details`.
- Add context-cost metadata.
- Improve result normalization.

### Keep `read_file`

Keep it as a fallback and image-capable reader.

Enhancements only:
- Add same snapshot metadata used by viewer tools.
- Add result envelope compatibility.

### Keep Existing Edit Tools

Keep:
- `file_edit`
- `edit_file`
- `replace_in_file`
- `replace_symbol`
- `write_file`
- mutation queue
- snapshots/checkpoints

Enhancements:
- Add `apply_patch`.
- Add hashline mode.
- Add post-write diagnostics.
- Add stale snapshot warnings.
- Convert safe-edit hard blocks into advisory result metadata.

### Keep Background Process Manager

Reaper already has the hard part. Add a `job` facade rather than replacing internals.

### Keep Checkpoints

Reaper's checkpoint system is already aligned with implementation safety and recovery. Do not redesign it in the first pass.

## What Needs Redesign From Scratch

### Tool Metadata Layer

Create a new descriptor type around all tools.

Suggested fields:
- `name`
- `label`
- `summary`
- `description`
- `argsSchema`
- `loadMode`: `core` or `discoverable`
- `family`: `file`, `search`, `edit`, `shell`, `job`, `agent`, `web`, `browser`, `diagnostic`, `memory`
- `capabilityTier`: `read`, `write`, `exec`
- `concurrency`: `shared`, `exclusive`, or function of args
- `interruptible`
- `contextCost`: `low`, `medium`, `high`
- `outputPolicy`: inline, spill, summarize, attach
- `aliases`
- `examples`
- `source`: builtin, MCP, extension

This gives Reaper the same design leverage OMP gets from `AgentTool`, while keeping Reaper's implementation.

### Execution Pipeline

Build a formal execution pipeline:
1. Normalize alias.
2. Lookup descriptor.
3. Parse args.
4. Attach advisory metadata.
5. Schedule according to concurrency.
6. Execute.
7. Normalize result.
8. Spill or summarize large output.
9. Attach diagnostics.
10. Emit telemetry.

No step should block a model-selected call for policy reasons unless the operation itself cannot execute.

### Result Envelope

Normalize all tool results into a richer envelope.

Suggested shape:
- `ok`
- `toolCallId`
- `name`
- `args`
- `durationMs`
- `content`
- `details`
- `meta`
- `diagnostics`
- `artifacts`
- `isError`
- `useless`
- `advisories`

Benefits:
- Smaller model-visible outputs.
- Better UI/logging.
- Easier context compaction.
- Better downstream reasoning.

### Tool Discovery Index

Replace simple keyword scoring with a real index.

Index fields:
- Tool name.
- Aliases.
- Summary.
- Description.
- Args schema keys.
- Args descriptions.
- Examples.
- Capability tier.
- Family.
- Source.

Search behavior:
- `select:name` still works.
- Keyword search ranks results.
- Results promote tools into full schema rendering.
- Discovery never forces the model to use the tool.

### Advisory Diagnostics

Diagnostics should help the model decide, not prevent the call.

Examples:
- "This edit touched a large file."
- "The file was not viewed recently."
- "The snapshot changed since last view."
- "Lint errors found after write."
- "Command looks long-running; consider background mode."

These should be returned as tool result metadata or visible notes, not blockers.


also remove the sub agent system, mcp system from reaper as of now and sub agents system will be added later in a much more designed and concret way

## Proposed Implementation Phases

### Phase 0: Licensing And Source Mapping

OMP is MIT licensed. Reaper package metadata says ISC.

Action:
- If copying substantial OMP code, preserve MIT notices.
- Prefer reimplementation of concepts where the Reaper architecture differs.
- Add attribution in copied/adapted files if direct code is used.

### Phase 1: Tool Descriptor Layer

Add a descriptor wrapper for existing Reaper tools.

Scope:
- No behavior changes.
- Add metadata only.
- Map current core/on-demand sets into `loadMode`.
- Add family/capability/concurrency metadata.

Expected value:
- Enables scheduling, discovery, and context policies without touching every tool body.

### Phase 2: Result Normalization

Create one normalized result envelope and adapter functions.

Scope:
- Wrap existing tool results.
- Preserve current output compatibility.
- Add `details`, `meta`, `diagnostics`, `useless`, and artifact references.

Expected value:
- Better context management.
- Cleaner UI/logging.
- Safer integration of MCP/custom tools.

### Phase 3: BM25 Tool Discovery

Replace simple `search_tools` scoring with an indexed search.

Scope:
- Keep the existing `search_tools` tool name.
- Keep `select:tool_name`.
- Index builtins, MCP, and extension tools.
- Activate discovered tools by adding them to per-run discovered state.

Expected value:
- Less schema context.
- Better model access to specialized tools.
- Faster tool discovery with fewer failed calls.

### Phase 4: File/Edit Upgrade

Add OMP-inspired edit modes.

Scope:
- Keep `file_edit` primary.
- Add `apply_patch` mode.
- Add hashline mode if it proves reliable.
- Add snapshot metadata to reads/views/edits.
- Make lint diagnostics post-write by default.
- Convert safe-edit threshold into advisory metadata.

Expected value:
- Better edit success rate.
- Better large-file handling.
- Lower context cost.
- No forced edit path.

### Phase 5: Bash, Job, Glob, Eval

Add the highest-value OMP core capabilities.

Scope:
- Add `job` facade.
- Add dedicated `glob`.
- Add optional discoverable `eval`.
- Add shell concurrency metadata.
- Add auto-background advisory/result shaping.

Expected value:
- Less shell overuse for file discovery.
- Faster one-off analysis.
- Cleaner async command flow.
- Better long-running process management.

### Phase 6: AST And LSP Tools

Add specialized tools only after the core is stable.

Scope:
- Discoverable `ast_grep`.
- Discoverable `ast_edit`.
- LSP diagnostics facade.
- Post-write diagnostics batches.

Expected value:
- More precise code edits.
- Faster symbol-aware navigation.
- Better repair loops.

### Phase 7: MCP And Extension Normalization

Wrap MCP/custom tools in the same descriptor/result system.

Scope:
- Normalize schema.
- Normalize result.
- Add discovery metadata.
- Add source labels.
- Avoid default blocking of unknown custom tools.

Expected value:
- Consistent behavior for all tool sources.
- Better context rendering.
- Lower integration risk.

## Efficiency And Context Gains

Expected improvements:
- Fewer full tool schemas in every model turn.
- Better on-demand discovery.
- Less repeated file reading.
- Smaller file context windows.
- More successful edits with less context.
- Better stale-file awareness without blocking.
- Faster parallel read/search tool batches.
- Serialized writes without global tool slowdown.
- Cleaner long-running process handling.
- Less bash usage for simple glob/eval tasks.
- Better compaction through `useless` and structured details metadata.

## Risk Areas

### Over-Porting OMP

Risk:
Copying OMP tools directly could erase Reaper-specific optimizations.

Mitigation:
Port capabilities and metadata first. Keep Reaper tool bodies where they are already stronger.

### Reintroducing Blocking Policy

Risk:
OMP approval/resolve patterns could conflict with Reaper's model-first scaffolding rule.

Mitigation:
Use capability metadata for display and logs only. Do not use it to deny, force, or redirect calls.

### Too Many Tool Names

Risk:
Adding `apply_patch`, `hashline`, `glob`, `eval`, `job`, AST tools, and diagnostics can bloat context.

Mitigation:
Use discoverable load mode and BM25 activation. Keep the core set small.

### Edit Mode Confusion

Risk:
Too many edit paths can reduce model reliability.

Mitigation:
Make `file_edit` the default fast path. Expose other edit modes with clear descriptions and examples through discovery.

### Diagnostics Becoming Guards

Risk:
Lint/LSP integration can drift into blocking edits.

Mitigation:
Diagnostics must be post-write by default. Rollback/preview should require explicit model choice.

## Recommended First Port Set

The first implementation wave should include:

1. OMP-style tool descriptor metadata.
2. Normalized tool result envelope.
3. BM25 `search_tools`.
4. `apply_patch` edit mode.
5. Snapshot metadata for file tools.
6. Post-write diagnostics model.
7. `job` facade over background work.
8. Dedicated `glob`.
9. Optional discoverable `eval`.

This gives Reaper most of OMP's tool-system value while respecting Reaper's existing strengths and the no-blocking/no-forcing rule.

## Final Recommendation

Reaper should not become an OMP clone.

Reaper should absorb OMP's best tool architecture ideas:
- Rich tool descriptors.
- Better discovery.
- Better result metadata.
- Better concurrency.
- Better async jobs.
- Better patch edit modes.

Reaper should keep its own strongest tool implementations:
- File viewer.
- Scroll/find viewport.
- Bounded read fallback.
- Exact edit tools.
- Mutation queue.
- Checkpoints.
- Background process manager.
- Advisory subagent model.

The target design is a faster, more efficient, more context-aware Reaper where tools amplify the model's ability instead of controlling it.
