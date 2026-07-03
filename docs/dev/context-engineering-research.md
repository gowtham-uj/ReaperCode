# Context Engineering Research — AI Coding Agents

> Researched 2026-07-03 from local source code in `/workspace/focus_sources/`.
> 5 agents analyzed: Aider, Claude Code (cc-haha), pi-mono/oh-my-pi, OpenHands SDK.

---

## 1. Aider (Python)

**Source:** `/workspace/focus_sources/aider/aider/`

### System Prompt
- Static per-coder-type template (EditBlock SEARCH/REPLACE contract) with dynamic injections: platform info, dynamic fence selection (scans file contents to pick a backtick count that won't collide), token-gated reminder section (only appended if total tokens < max_input_tokens).
- Assembled into ordered `ChatChunks`: system → examples → readonly_files → repo_map → summarized_history → chat_files → current → reminder.
- Examples either flattened into system message (`examples_as_sys_msg`) or kept as separate turns with a "I switched code bases" reset pair.

### Context Window Management
- **Background thread summarization** using recursive split: summarizes the head via LLM, keeps the tail (up to max_tokens//2), recurses up to 3 depth levels. Minimum 4 messages to split.
- On context exhaustion: sets `exhausted=True`, shows per-quadrant diagnostics (input/output/total vs limits at 0.7 fudge factor), hints at `/drop`, `/clear`, smaller files.
- Assistant prefill support for Length-finish on capable models (appends partial content as prefixable assistant message to continue generation).
- **Proactive Anthropic cache warming** — spawns keepalive completions every ~5 min (`AIDER_CACHE_KEEPALIVE_DELAY`) to keep prefix hot. Reads `prompt_cache_hit_tokens`/`cache_read_input_tokens` for cost reporting.

### File Retrieval — Repo Map
- **Tree-sitter** parses all repo files extracting def/ref Tags (queries from `queries/<lang>-tags.scm`, Pygments fallback for unsupported langs).
- Builds a **networkx MultiDiGraph** with edges referencer→definer weighted by `√(num_refs) × multiplier`:
  - ×10 for user-mentioned identifiers
  - ×10 for long snake/kebab/camel-case names (≥8 chars) likely to be meaningful
  - ×50 when the referencer is a chat file (boosting context adjacent to active files)
  - ×0.1 for underscore-private or widely-defined (>5 definers) idents
- **PageRank** with personalization toward chat files and mentioned files/idents.
- **Binary search** over tag count to fit output to 15% of `max_map_tokens`. Rendered as `TreeContext` snippets (only def lines + minimal enclosing context, lines truncated to 100 chars).
- Cached in on-disk SQLite `diskcache` keyed by file mtime. `refresh` modes (`auto`/`files`/`manual`/`always`).

### Tool Result Handling
- Text-based reflection loop — edit blocks parsed from free text, failures fed back as new user turns (`reflected_message` loop, max_reflections iterations).
- Lint errors, test failures, and shell output fed back as user/assistant turns or reflections.
- `check_for_file_mentions` interactive-confirms adding new files to chat context.

### Unique Techniques
- **ContextCoder** — meta-coder that only proposes which files to edit (iterative retrieval front-end). Reflects until mentioned files == chat files.
- **File watcher** with `# ai!` / `# ai?` comment markers — turns source files into live instruction surface. Auto-adds those files to chat with `TreeContext`-rendered snippet marked `█` at comment lines.
- **Tiered ephemeral cache breakpoints** — `cacheable_messages`/`add_cache_control_headers` place `{"cache_control": {"type": "ephemeral"}}` on last message of system/examples, repo-or-readonly, and chat_files chunks.
- **Dynamic fence selection** — scans all file contents to pick a fence delimiter that doesn't collide, defaulting to quadruple backticks.
- `copy_context` auto-injects relevant snippets at input time. `cmd_web` scrapes URLs into context.

---

## 2. Claude Code / cc-haha (TypeScript)

**Source:** `/workspace/focus_sources/claude-repos/claude-extracted/cc-haha-main/`

### System Prompt
- Dynamically assembled at runtime: static base prompt + environment info (OS, shell, git status) + tool schemas + memory files (CLAUDE.md) + user preferences from `.claude/settings.json`.

### Context Window Management
- LLM-based compaction — when context approaches limit, an LLM summarizes old turns into a brief paragraph.
- Preserves the most recent messages and system prompt verbatim.

### File Retrieval
- No proactive retrieval — model uses `glob` and `grep` tools to find files on demand.
- No repo map or AST-based retrieval.

### Tool Result Handling
- Output persisted to temp files if >4KB.
- Model gets truncated preview + path to full output.
- `get_tool_output` tool to retrieve persisted output.

### Unique Techniques
- **Microagents** — model spawns sub-agents for isolated tasks with their own context window. Sub-agents return only a summary to the parent.
- **Plan mode** — model writes a structured plan before executing.
- Slash commands as user-configurable prompts.

---

## 3. pi-mono / oh-my-pi (TypeScript/Rust)

**Sources:**
- `/workspace/focus_sources/pi-mono-main/pi-mono-main/` (pi-mono)
- `/workspace/focus_sources/oh-my-pi/` (oh-my-pi)

### System Prompt
- Layered assembly: tool-aware base string listing "Available tools" → dynamically-selected guidelines gated on which tools exist (e.g. "Prefer grep/find/ls over bash" only when both are present) → `promptGuidelines` → project context files (AGENTS.md/CLAUDE.md) auto-discovered by walking cwd up to root with depth-based deduplication for monorepo hierarchies → skills formatted via `formatSkillsForPrompt()` (only if `read` tool is available) → date/cwd.
- `mom` component has its own large bespoke prompt embedding Slack formatting rules, channel/user ID tables, workspace layout, event/cron DSL, and memory from MEMORY.md files.

### Context Window Management — Multi-layered
1. **Pruning** (`pruning.ts`): Drops old tool results when token budget exceeded. Protects recent 16K tokens + skill-related tool results. Supersede-based pruning drops results overwritten by later calls. Prompt-cache guard prevents mutating results in warm cached prefix. Useless-flagged results bypass protect window.
2. **Shake** (`shake.ts`): Surgically replaces large tool-call results and fenced/XML code blocks with short placeholders. Protects live tail (16K tokens). Minimum savings threshold 4K tokens. Fence minimum 400 tokens. Pure layer — no I/O.
3. **LLM Compaction** (`compaction.ts`): Summarizes old turns using dedicated compaction prompts (`compaction-summary.md`, `compaction-update-summary.md`, `compaction-turn-prefix.md`). Turn-aware: when cutting mid-turn (on an assistant message), generates a `turn-prefix summary` so kept suffix stays coherent. Runs history summary and turn-prefix summary **in parallel**. Uses UPDATE prompt to merge rather than regenerate from scratch. Preserves "provenance data" for tool calls.
4. **Snapcompact** (`snapcompact.ts`): Renders discarded conversation history as **bitmap PNG images** that vision models read back directly. Provider-aware font/cell sizes: 11on16-bw for Anthropic (extra letter-spacing, black ink), 8on22-bw @2048 for Google (extra line spacing), 8on22-bw for OpenAI (patch billing aware). Frames hug text rows — partially filled frame never bills blank rows. **No LLM summarization needed, pure local rendering** in native code (`crates/pi-natives/src/snapcompact.rs`).
5. **OpenAI Remote Compaction** (`openai.ts`): Uses provider-side session compaction APIs when available. Builds OpenAI native history, preserves remote compaction data.
6. **Branch Summarization** (`branch-summarization.ts`): When user navigates session tree to a different leaf, walks old leaf back to common ancestor, packs messages newest-first into token budget (favoring compaction/branch_summary entries), generates structured Goal/Progress/Decisions summary prepended with "The user explored a different conversation branch before returning here".

### File Retrieval
- `pi-walker` crate (Rust) for filesystem traversal.
- `pi-ast` crate (Rust) for tree-sitter AST parsing.
- `pi-uu-grep` crate (Rust) for ripgrep-based search.
- No proactive repo map — model uses tools to find files.
- `read` tool truncates head-first to 2000 lines / 50KB with actionable `[Showing lines X-Y of N. Use offset=Z to continue.]` notice. Images auto-resized to 2000×2000, dropped with note for non-vision models.

### Tool Result Handling
- Two-tier truncation: `truncateHead` (keep beginning, for file reads) and `truncateTail` (keep end, where errors live, for bash). Both report `truncatedBy: "lines" | "bytes"`, total counts, never slice mid-line.
- Full bash output spilled to temp files with `fullOutputPath` pointer + human-readable `[Full output: /tmp/...]` notice.
- `onUpdate` partial results — bash uses rolling in-memory tail buffer, emits `truncateTail` previews as output arrives.
- `beforeToolCall` can `{ block: true }` (synthesized error result), `afterToolCall` can override `content`/`details`/`isError`/`terminate`.
- Steering messages inject mid-turn after tool calls. Follow-up messages revive agent after it would otherwise stop.

### Unique Techniques
- **Mnemopi** — persistent memory with embedding-based retrieval (fastembed local models + OpenRouter). **Polyphonic recall** across 4 voices: vector (semantic similarity), graph (episodic relationships — `EpisodicGraph`), fact (structured triples extracted via LLM), temporal (time-based). `VeracityConsolidator` detects contradictions. Working vs episodic memory tiers. `recall_count` and `last_recalled` tracking.
- **AppendOnlyContext** — `StablePrefix` snapshots system prompt + tool specs once and freezes them (fingerprint-based invalidation). `AppendOnlyLog` — messages only grow, prior turns never re-serialized. Combined: only the user's new message delta is a cache miss each turn. Maximum provider prefix cache hit rate.
- **Pods** (`pods/src/`) — thin CLI for routing prompts to remote model servers over SSH. Extracts host from `ssh` connection string, builds `--base-url`, selects `responses` vs `completions` API based on model name.
- **Mom** (`mom/src/`) — persistent Slack bot agent. `syncLogToSessionManager()` backfills messages from `log.jsonl` that arrived while offline (dedup by normalized content). `getMemory()` layers workspace-global `MEMORY.md` over per-channel `MEMORY.md`. Runners cached per channel.
- **AgentMessage extension model** — transcript is `Message | CustomAgentMessages[key]`. Apps extend via declaration merging to add typed custom message types. `convertToLlm` is the single conversion point called once per turn. `transformContext` runs before conversion for context-window pruning.
- **Turn-aware two-queue steering** — `steeringQueue` (drained after each turn's tool calls) and `followUpQueue` (drained when agent would stop). Precise control over mid-run injection vs post-run continuation.

---

## 4. OpenHands software-agent-sdk (Python)

**Source:** `/workspace/focus_sources/software-agent-sdk-extracted/software-agent-sdk-main/`

### System Prompt
- Jinja2 templates loaded from `context/prompts/` directory with `FlexibleFileSystemLoader` (supports relative + absolute paths).
- `refine` filter: `bash` → `powershell` on Windows.
- Bytecode cache stored at `~/.openhands/cache/jinja` to avoid reparsing templates across processes.
- `SystemPromptEvent` emitted when prompt is assembled.

### Context Window Management — Pluggable Condenser Pipeline
- **CondenserBase** (ABC): `condense(view, agent_llm) -> View | Condensation`. Discriminated union mixin. If returns `Condensation`, agent returns that event instead of its own action. Next step, condenser uses the condensation event to produce a new View.
- **NoOpCondenser**: Pass-through for testing.
- **LLMSummarizingCondenser**: LLM summarizes forgotten events. `max_size=240` events, `max_tokens` optional. `keep_first=2` events preserved at start. `minimum_progress=0.1` (10% of events must be condensed). Uses independent LLM for summaries (separate from agent LLM).
- **PipelineCondenser**: Chains condensers in sequence. Each condenser receives the previous one's output. Exits early if any returns `Condensation`.
- **RollingCondenser**: Base class implementing rolling window logic.
- Condensation is **event-sourced**: events are "forgotten" (removed from View) and optionally replaced with a summary at a specified `summary_offset`. `Condensation` event tracks `forgotten_event_ids`, `summary`, `summary_offset`, `llm_response_id`.
- **View** — linearly ordered view of events with `manipulation_indices` (where events can be removed without violating LLM API properties). `ALL_PROPERTIES` compute independent sets of safe manipulation indices.

### File Retrieval
- No proactive retrieval. Model uses `str_replace_editor` and `bash` tools.
- Event-sourced architecture means file reads are events that can be condensed.

### Tool Result Handling
- `maybe_truncate` utility.
- Each tool call+result is an `ActionEvent` + `ObservationEvent` pair — the unit of compaction.
- `ParallelToolExecutor` for concurrent tool execution.
- Security analyzer validates tool calls. `ConfirmationPolicyBase` / `NeverConfirm` for approval flows.

### Unique Techniques
- **Event-sourced architecture** — entire conversation is append-only event log. Views are computed projections over events. Condensers are composable pipeline operators on Views.
- **ContextWindowExceedError** handling — `LLMContextWindowExceedError` triggers condensation request.
- **Subagent** system with separate registry (`subagent/registry.py`, `subagent/schema.py`).
- **Stuck detector** (`conversation/stuck_detector.py`) — detects when agent is not making progress.
- **LLMSecurityAnalyzer** — security analysis of tool calls.
- **Thinking block condenser** — handles provider thinking/reasoning blocks during compaction.
- **Delayed condensation** — condensation can be requested but delayed until a natural break point.

---

## Comparative Summary

| Technique | Aider | Claude Code | pi-mono/oh-my-pi | OpenHands |
|-----------|-------|-------------|-------------------|-----------|
| System prompt | Static template + dynamic injections | Dynamic assembly | Layered capabilities | Jinja2 templates |
| Compaction | LLM summary (recursive, background thread) | LLM summary | Multi-layered (prune + shake + LLM + snapcompact + branch) | Condenser pipeline (pluggable, composable) |
| File retrieval | Repo map (tree-sitter + PageRank) | On-demand tools | On-demand tools (pi-walker, pi-ast, pi-uu-grep) | On-demand tools |
| Tool result handling | Text reflection loop | Temp file + preview | Two-tier truncation + spillover | Event pairs (ActionEvent + ObservationEvent) |
| Memory | None | CLAUDE.md files | Mnemopi (embeddings + polyphonic recall) | None (event log only) |
| Cache optimization | Ephemeral breakpoints + warming | None | Append-only context (stable prefix) | None |
| Unique | ContextCoder, file watcher, dynamic fence | Microagents, plan mode | Snapcompact, pods, mom, turn-aware queues | Event-sourced architecture |

---

## Key Takeaways for Reaper

1. **Aider's repo map** (tree-sitter + PageRank) is the most efficient file retrieval — gives the model file structure without needing to read files. Worth porting.
2. **oh-my-pi's multi-layer compaction** (prune → shake → LLM compact → snapcompact bitmap) is the most sophisticated context management. Snapcompact eliminates LLM summarization cost entirely.
3. **oh-my-pi's append-only context** is a clever prefix-cache optimization — stable prefix + append-only log = only new message is a cache miss.
4. **OpenHands's event-sourced condenser pipeline** is the cleanest architecture — composable condensers as pipeline stages. Worth porting as a framework.
5. **pi-mono's turn-aware compaction** (never cut mid-tool-call, generate turn-prefix summary) prevents corrupt conversation state.
6. **Aider's prompt cache warming** (keepalive completions every 5 min) is a simple, effective optimization for long sessions.
7. **pi-mono's two-tier truncation** (head for reads, tail for bash) is a better default than always-truncate-to-preview.
8. **oh-my-pi's mnemopi** (persistent memory with polyphonic recall across vector/graph/fact/temporal) is the most advanced memory system.
9. **OpenHands's stuck detector** is a simple safety net for loop detection.
10. **pi-mono's branch summarization** preserves context when exploring side branches — useful for multi-approach workflows.
