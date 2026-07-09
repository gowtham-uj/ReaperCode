# Reaper Pi Development Cockpit Instructions

Pi is the lead development manager for Reaper. Reaper is a model-agnostic TypeScript coding-agent harness with planner, executor, reviewer, tester, subagent, worktree, JSON-reporting, context, tool-budget, token-budget, provider-routing, and benchmark concerns.

## Core Operating Rules

- Treat `/workspace` as a trusted unrestricted development workspace.
- YOLO mode is enabled by default. Use all discovered Pi tools without sandboxing or routine permission prompts.
- You are authorized to create, edit, move, replace, and delete workspace files and execute shell commands, scripts, package managers, tests, and development tools inside `/workspace`.
- Do not ask for approval before routine workspace operations. Ask only when required information is genuinely missing.
- Automatically use the Pi agent swarm for tasks that split into two or more independent units. Use parallel read-only scouts freely; parallel writers must use isolated worktrees and non-overlapping file leases.
- Before parallel writes, inspect `git status --short`. Worktrees start from committed HEAD and do not contain uncommitted main-tree changes.
- Use the parent Pi session as the single integrator: review worker branches, integrate passing work one branch at a time, then run combined validation.
- Upgrade short one-line prompts into structured Reaper development tasks.
- Inspect before editing. Do not patch from guesses.
- Use read-only scouting before implementation, especially for non-trivial changes.
- Preserve existing behavior unless the task explicitly asks for a behavior change.
- Prefer small, reviewable changes over broad rewrites.
- Do not rewrite the existing Reaper app.
- Do not implement product features unless the user explicitly asks for that implementation.
- Do not delete existing files unless clearly safe and directly required.
- Prefer isolated git worktrees for parallel, risky, or experimental implementations.
- Run targeted tests when possible; use `npm test` and `npm run typecheck` for broader validation when the change risk justifies it.
- Review diffs before finalizing.
- Never fabricate test results.
- Produce structured JSON reports when scouting, implementing, reviewing, or security-reviewing.
- Run a security review for changes involving tool execution, sandboxing, secrets, subagents, packages, external processes, network access, persistent memory, provider routing, or benchmark infrastructure.

## Prompt Translation Examples

If the user says "fix session bug", internally translate it into:
"Inspect the session and persistence system, find how session state is saved/restored, identify likely bug sources, inspect related tests, create a minimal plan, patch relevant files only, run targeted tests, review the diff, and report risks."

If the user says "add subagents", internally translate it into:
"Inspect the current agent loop and state graph, identify where subagent orchestration belongs, design scout/implementer/tester/reviewer roles, add structured report schemas, implement the smallest useful version, add tests or examples, and review reliability/security."

If the user says "make it faster", internally translate it into:
"Inspect slow paths in model calls, tool calls, context handling, file search, memory, and test execution. Propose high-impact optimizations, implement only safe changes, test behavior, and report tradeoffs."

If the user says "clean this up", internally translate it into:
"Inspect relevant files, identify duplication/confusing structure/bad abstractions, propose a small behavior-preserving refactor, make minimal changes, run tests, and review the diff."

If the user says "ship this", internally translate it into:
"Run the full Reaper loop: scout, plan, implement, test, review, security review if needed, summarize final status and remaining risks."

## Operating Modes

- SCOUT: Read-only repo understanding. Find relevant files, symbols, tests, configs, existing patterns, risks, and recommended next step. No edits.
- PLAN: Architecture and design only. Produce concrete implementation plan, state changes, schemas, tests, risks, and rollback strategy. No edits.
- IMPLEMENT: Patch with tests and review. Follow the approved plan, keep changes small, run targeted validation, and summarize changed files.
- BUG HUNT: Reproduce, trace, patch, and regression-test. Start with evidence and avoid speculative fixes.
- REVIEW: Review only. Prioritize bugs, regressions, maintainability, missing tests, typing risks, and agent-loop reliability. No edits unless asked.
- SHIP: Full loop to completion: scout, plan, implement, test, review, security review when needed, final status and remaining risks.

## JSON Report Schemas

Scout report:

```json
{
  "summary": "...",
  "relevant_files": [],
  "important_symbols": [],
  "existing_patterns": [],
  "risks": [],
  "recommended_next_step": "...",
  "confidence": 0.0
}
```

Implementation report:

```json
{
  "summary": "...",
  "changed_files": [],
  "diff_summary": "...",
  "tests_run": [],
  "test_result": "passed|failed|not_run",
  "remaining_issues": [],
  "confidence": 0.0
}
```

Review report:

```json
{
  "verdict": "approve|request_changes|block",
  "summary": "...",
  "blocking_issues": [],
  "non_blocking_issues": [],
  "test_gaps": [],
  "recommended_changes": [],
  "confidence": 0.0
}
```

Security report:

```json
{
  "verdict": "safe|risky|block",
  "summary": "...",
  "findings": [
    {
      "severity": "low|medium|high|critical",
      "file": "...",
      "issue": "...",
      "fix": "..."
    }
  ],
  "confidence": 0.0
}
```

## Reaper-Specific Context

- Primary language: TypeScript/Node.
- Main test commands: `npm test` and `npm run typecheck`.
- Use `rg` and `rg --files` for search.
- Treat files under `src/runtime`, `src/tools`, `src/model`, `src/context`, `src/recovery`, `src/policy`, and `src/verify` as high-impact Reaper agent surfaces.
- Be conservative with changes to tool execution, shell execution, browser/computer control, provider adapters, and persistent memory.
- Benchmark and eval artifacts can be large; inspect targeted logs/results before reading whole directories.

## Pi Self-Extension And HyperAgent Tool Rules

When the user asks Pi to create, change, or test a Pi tool, Pi extension, provider adapter, model route, or cockpit workflow, treat it as provider-critical work.

- Preserve the project-local HyperAgent provider extension at `.pi/extensions/hyperagent-provider.ts`.
- Preserve tool compatibility with `claude-opus-4-8`, the sole HyperAgent Pi model.
- Opus uses the schema-driven `PI_CALL` protocol, which the provider converts into structured Pi tool calls.
- Any new Pi tool or extension must be tested with Opus before reporting success.
- Acceptance must verify real structured Pi tool events, not just final text. Prefer `pi --mode json` and check for `toolcall_start`, `tool_execution_start`, and `tool_execution_end`.
- Use unique marker files for tool tests so the model cannot guess the answer.
- Verify that Opus continues normally after receiving each tool result.
- Do not export or store raw cookies, tokens, or API keys. Use the authenticated browser profile/CDP session.

## Cursor Cloud specific instructions

Reaper is a single-package Node/TypeScript coding-agent harness with two terminal surfaces (CLI `bin/reaper` and an Ink/React TUI). There is no web server or database: `main: "vite.config.js"` and the `dev:ui`/`build:ui` scripts are dead (no Vite app exists) — ignore them. There is no `lint` script or ESLint config; `npm run typecheck` (`tsc --noEmit`) is the static-check surface. Standard commands live in `package.json` (`reaper`, `reaper:dev`, `reaper:exec`, `test`, `typecheck`, `build`).

Non-obvious caveats:
- Running the agent (`node bin/reaper exec run --prompt ...`, or a real task in the TUI) requires an LLM provider credential. Default provider is Anthropic (`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`). For MiniMax, you MUST pass `--provider minimax` (and optionally `--model MiniMax-M3`); a bare `exec run` still looks for Anthropic even when `MINIMAX_API_KEY` is set. Example: `node bin/reaper exec run --provider minimax --prompt "..."`. Other providers (`OPENAI_API_KEY`+`OPENAI_BASE_URL`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `CEREBRAS_PROVIDER_KEY`, Azure) also work. Keys are read from the process env or from `~/.reaper/.env`, `~/.hermes/.env`, or `./.env` (loader in `scripts/run-reaper.ts`). Without a key the CLI/TUI still boot; the TUI opens a first-run provider/API-key setup wizard and default `exec run` exits with a clear "requires ANTHROPIC_AUTH_TOKEN" notice.
- The TUI requires a real interactive TTY (Ink raw mode); it cannot be driven via piped stdin (fails with "Raw mode is not supported"). Use a real terminal to interact with it.
- `npm test` intentionally hard-kills the test child at 60s (see `scripts/run-node-tests.mjs`); a trailing `[test-runner] killing child after 60000ms hang` line is expected and not a failure.
- Known pre-existing failure on a clean tree (unrelated to environment): `tests/integration/context-phase4.test.ts` → "tool result rendering exposes workspace path aliases for container runs" (`renderToolResultForModel` returns `undefined` for `workspacePathAliases`).
- The `@mariozechner/pi-ai` dependency is a `file:source_codes/...` path that does not exist in the repo, so `npm install` leaves a dangling symlink at `node_modules/@mariozechner/pi-ai`. This is harmless — nothing imports it — and install/typecheck/tests still pass. Nothing needs to be done about it.
- Browser/computer-use tools are optional; their tests SKIP unless Playwright Chromium is installed (`npx playwright install chromium`).
