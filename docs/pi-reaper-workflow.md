# Pi Reaper Development Cockpit

This repository is configured so Pi Coding Agent can act as a development cockpit for Reaper. The setup turns short prompts into a professional loop: scout, plan, implement, test, review, and security review when needed.

## Repository Shape

- Primary language: TypeScript/Node.
- Package manager: npm with `package.json` and `package-lock.json`.
- Main checks:
  - `npm test`
  - `npm run typecheck`
- Pi project resources:
  - `AGENTS.md`
  - `.pi/agents/`
  - `.pi/skills/reaper-dev-loop/SKILL.md`
  - `.pi/extensions/hyperagent-provider.ts`

## Install Pi

Manual commands:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install npm:@tintinweb/pi-subagents
cd path/to/reaper
pi
```

This workspace currently also supports the Node 20 compatible Pi package line. If the latest package requires a newer Node, use the compatible package documented by npm for your environment.

## HyperAgent Provider

The repo has a project-local Pi extension at `.pi/extensions/hyperagent-provider.ts`. Pi discovers `.pi/extensions/` automatically.

It registers:

- provider: `hyperagent`
- model: `claude-opus-4-8`

Recommended start command:

```bash
cd path/to/reaper
pi
```

Plain `pi` is workspace-aware on this machine. From `/workspace` or any descendant directory it dispatches agent sessions to `scripts/pi-reaper-cockpit.sh`; outside `/workspace` it invokes the normal Pi binary unchanged. Pi administration commands such as `pi install`, `pi list`, and `pi update` pass directly to the real binary. The dispatcher is installed at `/root/.local/bin/pi`, which appears before `/usr/local/bin` on `PATH`.

Behavior:

- Opus is the sole HyperAgent model exposed to Pi.
- Authentication is kept in a persistent Chromium user-data-dir. Do not export raw cookies or tokens.
- If the browser profile is no longer authenticated, open HyperAgent in the supervised browser and log in again.

Tool-call behavior:

- Opus receives every active tool's real JSON schema and uses the `PI_CALL` protocol, which becomes a structured Pi tool call.
- When changing Pi tools, extensions, providers, or cockpit workflow, test Opus before reporting success.
- Verify real structured tool events with `pi --mode json`; final text alone is not enough.
- Use unique marker files so the model cannot guess the expected output.
- Verify Opus continues normally after receiving each tool result.

Useful environment variables:

```bash
export HYPERAGENT_CDP_URL=http://127.0.0.1:9222
export HYPERAGENT_BROWSER_PROFILE_DIR=/tmp/hyperagent-browser-profile
export HYPERAGENT_PI_AUTO_LAUNCH=1
```

## Use the Reaper Skill

Inside Pi:

```text
/skill:reaper-dev-loop Inspect the repo and create a development map. Do not edit files.
```

After that, one-line prompts are enough:

```text
fix session bug
add subagents
make it faster
build benchmark runner
clean this up
review the tool system
make memory reliable
ship this
```

## Reaper Cockpit Commands

This repo includes `.pi/extensions/reaper-cockpit/index.ts`, which starts Pi in unrestricted Reaper YOLO cockpit mode.

YOLO mode means every discovered Pi tool is active by default, including the built-in tools:

```text
read, bash, edit, write, grep, find, ls
```

There is no Pi execution sandbox and no cockpit-level guardrail or confirmation prompt for shell commands, file writes, installs, or deletes. The launcher enters this repository root before starting Pi, and Pi is authorized to operate freely inside that trusted workspace.

Available commands:

```text
/reaper
/reaper-scout <task>
/reaper-plan <task>
/reaper-ship <task>
/reaper-fix <bug-or-log>
/reaper-review <focus>
/reaper-test <scope>
/reaper-bench <scope>
/reaper-failures <scope>
/reaper-swarm <task>
/reaper-status
```

The commands expand short prompts into Reaper-specific workflows. Main-tree integration stays single-threaded, while safe independent work can run concurrently through shared-workspace agents and read-only scouts.

## Automatic Agent Swarm

The Reaper cockpit automatically evaluates each prompt for swarm execution. Explicit requests for a swarm, parallel agents, fan-out, multiple agents, or subagents force swarm evaluation. Larger multi-file/module/task requests and combined research-plus-implementation requests are routed as swarm candidates.

The parent Pi session acts as orchestrator:

1. Inspect the dirty working tree and launch bounded `swarm-scout` agents in the background.
2. Continue useful parent-side preflight while scouts run, then launch independent `swarm-worker` agents concurrently in the shared workspace with disjoint file leases.
3. Monitor using `get_subagent_result` and redirect using `steer_subagent`.
4. Gate completed branches with `swarm-reviewer`.
5. Integrate passing branches into the main tree one at a time and run combined validation.

Project swarm settings live in `.pi/subagents.json`. This setup permits up to six concurrent background agents, uses smart grouped completion notifications, disables unused scheduling, and scopes subagents to the configured Opus model.

The project agent definitions make `swarm-scout`, `swarm-worker`, and `swarm-reviewer` background agents by default. Workers run in the shared workspace by default; scouts and reviewers have bounded turn budgets to keep orchestration responsive.

When relevant uncommitted changes make shared-workspace workers unsafe, Pi falls back to parallel read-only scouting and serial parent-session implementation.

## Automatic Skill Use

Focused skills live under `.pi/skills/`:

- `reaper-scout`
- `reaper-plan`
- `reaper-bug-hunt`
- `reaper-ship`
- `reaper-bench`
- `reaper-provider-tools`
- `reaper-dev-loop`

Pi discovers these automatically. `.pi/APPEND_SYSTEM.md` tells the model to load the most specific matching skill based on prompt intent before acting. You can still force a skill explicitly:

```text
/skill:reaper-bug-hunt analyze these failed logs
```

## HyperAgent Max Reasoning

The HyperAgent Opus model always runs with provider-side `effort: "max"` and the maximum configured
thinking-token budget. Pi names its highest selectable reasoning level `xhigh`; the HyperAgent
provider maps that Pi label to HyperAgent's `max` value. Lower Pi reasoning levels are hidden.

## Subagents

These repo-local subagent definitions are stored in `.pi/agents/`:

- `reaper-scout.md`: read-only discovery, relevant files, symbols, tests, configs, patterns, risks.
- `reaper-architect.md`: concrete implementation plans, state shape, graph nodes, schemas, tests, rollback plan.
- `reaper-implementer.md`: minimal patches, targeted tests, diff summary, remaining issues.
- `reaper-tester.md`: reproduce bugs, run exact test commands, report pass/fail without fabrication.
- `reaper-reviewer.md`: review diffs for correctness, maintainability, minimality, tests, regressions, typing, reliability.
- `reaper-security.md`: review shell execution, sandboxing, secrets, packages, network, memory, provider routing, and subagent orchestration.

Install the subagents package if you want Pi commands that can dispatch these definitions:

```bash
pi install npm:@tintinweb/pi-subagents
```

## HyperAgent Tool Acceptance Tests

Run these after changing `.pi/extensions/hyperagent-provider.ts` or any Pi tool/provider behavior.

```bash
pi --approve --list-models hyperagent
npm run typecheck
```

Opus read-tool test:

```bash
MAGIC="PI_OPUS_READ_$(date +%s)_$RANDOM"
FILE="/tmp/pi-opus-read-tool-test.txt"
printf '%s\n' "$MAGIC" > "$FILE"
pi --approve --mode json --no-session --provider hyperagent --model claude-opus-4-8 --thinking xhigh --tools read \
  -p "Inspect $FILE using the read tool, then answer exactly the marker in that file."
```

Passing output should include `toolcall_start`, `tool_execution_start`, `tool_execution_end`, and the marker string.

## Safe Workflow

The main Pi session is intentionally unrestricted inside the trusted workspace. SCOUT, PLAN, REVIEW, and security-review roles remain logically read-only because their job is diagnosis or review, not because the main Pi session is sandboxed.

1. Start in SCOUT mode for unfamiliar tasks.
2. Ask for PLAN mode before large changes.
3. Use IMPLEMENT mode only after the plan is clear.
4. Use BUG HUNT mode for failures with logs or reproduction steps.
5. Use REVIEW mode when you want findings only.
6. Use SHIP mode when you want the complete loop.

For security-sensitive changes, require security review:

- shell execution
- file permissions
- sandboxing
- tool permissions
- browser or computer-control tools
- API keys, credentials, cookies, and secrets
- external packages
- network access
- persistent memory
- provider/model routing
- subagent orchestration
- benchmark runner infrastructure

## Git Worktrees

Use worktrees only when you explicitly want a sandboxed experiment:

```bash
git worktree add ../reaper-worktrees/feature-name -b feature/name
cd ../reaper-worktrees/feature-name
pi --approve --provider hyperagent --model claude-opus-4-8 --thinking xhigh
```

Keep worktree branches focused. Merge only after tests and review.

## Files Created By This Setup

- `AGENTS.md`
- `.pi/agents/reaper-scout.md`
- `.pi/agents/reaper-architect.md`
- `.pi/agents/reaper-implementer.md`
- `.pi/agents/reaper-tester.md`
- `.pi/agents/reaper-reviewer.md`
- `.pi/agents/reaper-security.md`
- `.pi/subagents.json`
- `.pi/skills/reaper-dev-loop/SKILL.md`
- `docs/pi-reaper-workflow.md`
- `scripts/setup-pi-reaper.sh`

## Avoid Unsafe Behavior

- Do not ask Pi to export or store raw cookies, tokens, or API keys.
- Prefer persistent browser profiles for authenticated providers.
- Keep shell commands scoped to the repo unless a task explicitly requires otherwise.
- Run targeted tests before broader tests.
- Review diffs before shipping.
- Do not let agents make parallel writes to the same files.
