# Reaper v2 Main-Agent Architecture — Implementation Parts and Dependency Gates

> **Status:** Execution breakdown for review/approval. Do not implement until Gowtham approves the part structure.
>
> **Source design:** `.hermes/plans/2026-06-23_233845-reaper-codex-level-main-agent-architecture-v2.md`
>
> **Goal:** Divide the Reaper v2 refactor into dependency-ordered parts. Each part has a clear goal, implementation scope, success criteria, verification commands, and explicit downstream dependencies. A dependent part must not start until all required earlier parts pass their verification gate.

---

## 0. Dependency Graph Overview

```text
Part 0: Baseline + test harness snapshot
  -> Part 1: Source-first observability + model profile naming
  -> Part 2: Repo intelligence layer
  -> Part 3: Task contract extraction
  -> Part 4: VerificationState + BudgetState cockpit primitives
  -> Part 5: Tool taxonomy + validation layer
      -> Part 6: Checkpoint/diff mutation safety
      -> Part 7: Strict completion contract
  -> Part 8: Main-agent prompt/parser/node, behind isolated new graph path
      depends on Parts 1-7
  -> Part 9: Main-agent graph becomes only strategic path; old graph hard-disabled
      depends on Part 8
  -> Part 10: Advisory PLAN/TODO memory + candidate planner semantics
      depends on Part 9
  -> Part 11: Subagents-as-tools, blocking mode
      depends on Parts 5, 8, 9
  -> Part 12: Background subagents + result injection + staleness
      depends on Part 11
  -> Part 13: Reviewer/repair/tester policies and safe command allowlist
      depends on Parts 11-12
  -> Part 14: Remove old strategic nodes/dead paths
      depends on Parts 9-13 passing integration tests
  -> Part 15: End-to-end eval hardening and final acceptance
      depends on Parts 0-14
```

Hard rule:

> A part with dependencies must not start until every dependency has passed its verification gate. If a dependency fails, fix that dependency first; do not skip forward.

---

## 1. Part 0 — Baseline Snapshot and Safety Harness

### Goal

Create a reliable baseline before any architectural refactor. Capture current test behavior, graph shape, and live-eval scripts so regressions are obvious.

### Why this part comes first

Every later part changes runtime control flow or tool execution. We need a known-good baseline and a repeatable test list before touching behavior.

### Scope

No behavior changes.

Likely files:

```text
.h... optional docs only
scripts/live_stats.py        // read-only inspection only unless a baseline marker is helpful
```

### Tasks

1. Capture `git status --short`.
2. Run current focused runtime tests.
3. Run current typecheck.
4. Identify existing skipped tests and known pre-existing failures.
5. Save a short baseline note in `.hermes/plans/` or append to this plan if needed.

### Verification gate

Commands:

```bash
git status --short
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/unit/*.test.ts
node scripts/run-node-tests.mjs tests/integration/runtime-engine.test.ts tests/integration/execution-phase5.test.ts tests/integration/recovery-phase3.test.ts
```

Success criteria:

- Typecheck result known and recorded.
- Runtime/unit test result known and recorded.
- Any failures are identified as pre-existing or fixed before proceeding.
- No source behavior modified.

### Downstream dependencies

All parts depend on Part 0.

---

## 2. Part 1 — Source-First Observability and Model Profile Naming

### Goal

Make logs and live stats describe actual agent/source roles first, model profile second. Stop confusing `main_reasoner`/`fast_reasoner` with agents.

### Dependency

Requires Part 0 passed.

### Scope

Behavior-preserving observability changes only.

Likely files:

```text
src/model/observability.ts
src/model/json-response.ts
src/config/model-config.ts
src/runtime/engine.ts
scripts/live_stats.py
tests/unit/model-observability.test.ts
tests/unit/parameter-mapper.test.ts
```

### Required design

Model-call records should expose:

```ts
interface ModelCallTelemetry {
  source: string;          // main_agent, planner_subagent, etc.
  profile: string;         // strong_model, fast_model; alias-compatible
  legacyRole?: string;     // main_reasoner, fast_reasoner if still configured
  model: string;
  provider: string;
  promptChars: number;
  systemChars?: number;
  durationMs?: number;
  finishReason?: string;
  toolCallCount?: number;
}
```

Aliases:

```text
main_reasoner -> strong_model
fast_reasoner -> fast_model
```

Do not break existing config that still uses `main_reasoner` or `fast_reasoner`.

### Tasks

1. Add display/profile alias helpers.
2. Update model-call logging to include `source`, `profile`, `legacyRole`, `systemChars`.
3. Update `scripts/live_stats.py` to group by `source` first.
4. Keep secondary output grouped by profile/model.
5. Add/adjust tests for observability event shape.

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/unit/model-observability.test.ts tests/unit/parameter-mapper.test.ts
python3 scripts/live_stats.py || true
```

Success criteria:

- Tests pass.
- Live stats output primarily shows source labels such as `main_agent`, `planner_subagent`, etc. Existing runs may show old sources but not misleading role-only grouping.
- Backward-compatible model routing still works.
- No control-flow behavior changed.

### Downstream dependencies

Parts 8, 9, 11, 12, 15 depend on this for debuggability.

---

## 3. Part 2 — Repository Intelligence Layer

### Goal

Add `inspect_project` runtime capability and `RepoInspection` state so the main agent starts with compact repo understanding before editing.

### Dependency

Requires Part 1 passed.

### Scope

Add repo inspection primitives and cockpit rendering, but do not yet rewrite the graph.

Likely files:

```text
src/runtime/repo-inspection.ts                 // new
src/runtime/prompt-builders.ts                 // cockpit rendering hook
src/runtime/engine.ts                          // state integration only
tests/unit/repo-inspection.test.ts             // new
```

### Required schema

```ts
interface RepoInspection {
  packageManagers: string[];
  languages: string[];
  frameworks: string[];
  testCommands: string[];
  buildCommands: string[];
  lintCommands: string[];
  entrypoints: string[];
  configFiles: string[];
  importantDirectories: string[];
  gitStatus: string;
  risks: string[];
}
```

### Detection requirements

Detect at minimum:

- package managers: npm, pnpm, yarn, bun
- Node scripts: test, build, lint, typecheck, dev, start
- TypeScript/JavaScript markers
- common frameworks: React, Vite, Next, Express, Fastify, Vitest/Jest/Playwright
- config files: `package.json`, `tsconfig.json`, lockfiles, framework configs
- directories: `src`, `app`, `pages`, `server`, `client`, `tests`, `__tests__`
- git dirty status summary
- risk strings for no tests/no package manager/dirty workspace/large repo

### Tasks

1. Implement pure `inspectProject(root)` helper.
2. Add compact `renderRepoInspectionForCockpit()`.
3. Add unit fixtures or temp dirs for npm/pnpm/tsconfig/test scripts.
4. Wire optional state field into runtime without changing routing.

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/unit/repo-inspection.test.ts
```

Success criteria:

- Repo inspection detects package manager and scripts correctly in tests.
- Cockpit renderer produces concise, stable text.
- No graph behavior changes yet.

### Downstream dependencies

Parts 3, 4, 8, 9 depend on RepoInspection.

---

## 4. Part 3 — Task Contract Extraction

### Goal

Add a `TaskContract` representation extracted from the user request so completion can be verified against deliverables, constraints, acceptance criteria, forbidden actions, and likely validation.

### Dependency

Requires Part 2 passed.

### Scope

Add deterministic/lightweight extraction first. Later model-assisted refinement can be added if needed, but v1 should not add latency before main agent unless necessary.

Likely files:

```text
src/runtime/task-contract.ts                   // new
src/runtime/prompt-builders.ts                 // cockpit rendering hook
src/runtime/engine.ts                          // state integration only
tests/unit/task-contract.test.ts               // new
```

### Required schema

```ts
interface TaskContract {
  userGoal: string;
  deliverables: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  forbiddenActions: string[];
  likelyValidation: string[];
}
```

### Extraction requirements

For a request like “Build login and signup with tests,” extract:

```text
userGoal: Build login and signup with tests
Deliverables: signup, login, tests
Constraints: preserve existing behavior
Acceptance: endpoints/forms work as requested
Forbidden: remove unrelated behavior, fake verification
Likely validation: npm test / typecheck if available
```

Use RepoInspection to suggest likely validation commands.

### Tasks

1. Implement `extractTaskContract(request, repoInspection)`.
2. Add `renderTaskContractForCockpit()`.
3. Add tests for full-stack, bugfix, refactor, docs-only requests.
4. Ensure forbidden actions include generic safety constraints.

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/unit/task-contract.test.ts tests/unit/repo-inspection.test.ts
```

Success criteria:

- Contract extraction returns stable, non-empty deliverables for implementation tasks.
- Validation suggestions use repo scripts when available.
- Docs-only or read-only tasks do not force test commands unnecessarily.

### Downstream dependencies

Parts 4, 7, 8, 9, 13, 15 depend on TaskContract.

---

## 5. Part 4 — VerificationState and BudgetState Cockpit Primitives

### Goal

Add deterministic state for verification ladder and budget pressure, visible to the main agent before the graph rewrite.

### Dependency

Requires Parts 2 and 3 passed.

### Scope

State and renderer only. Completion gating is strengthened later in Part 7.

Likely files:

```text
src/runtime/verification-state.ts              // new
src/runtime/budget-state.ts                    // new
src/runtime/prompt-builders.ts
src/runtime/engine.ts
tests/unit/verification-state.test.ts          // new
tests/unit/budget-state.test.ts                // new
```

### VerificationState schema

```ts
interface VerificationState {
  artifactExistence: "unknown" | "passed" | "failed" | "not_applicable";
  syntaxTypecheck: "unknown" | "passed" | "failed" | "not_applicable";
  unitTests: "unknown" | "passed" | "failed" | "not_applicable";
  integrationTests: "unknown" | "passed" | "failed" | "not_applicable";
  taskSpecificManual: "unknown" | "passed" | "failed" | "not_applicable";
  reviewer: "unknown" | "approved" | "requested_changes" | "blocked" | "not_required";
  completionEligible: boolean;
  evidence: string[];
}
```

### BudgetState schema

```ts
interface BudgetState {
  maxIterations: number;
  maxToolCalls: number;
  maxRuntimeMs: number;
  maxModelCalls: number;
  remainingIterations: number;
  remainingToolCalls: number;
  remainingRuntimeMs: number;
  remainingModelCalls: number;
}
```

### Tasks

1. Implement verification state builder from tool results + repo inspection + task contract.
2. Implement budget state builder from config/runtime counters.
3. Render cockpit sections:
   - `# Verification State`
   - `# Budget`
4. Add tests for passed/failed/unknown/not-applicable states.

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/unit/verification-state.test.ts tests/unit/budget-state.test.ts tests/unit/task-contract.test.ts
```

Success criteria:

- Verification ladder accurately recognizes typecheck/test command outcomes from tool results.
- Completion eligibility false when required evidence missing.
- Budget warning renders near limits.

### Downstream dependencies

Parts 7, 8, 9, 13, 15 depend on this.

---

## 6. Part 5 — Tool Taxonomy and Validation Layer

### Goal

Classify tools as control/executable/mutating/subagent/completion and centralize batch validation rules before changing the main graph.

### Dependency

Requires Part 4 passed.

### Scope

Add taxonomy and validation helpers. Wire into existing path in non-breaking/blocking mode only if safe; full enforcement happens in Parts 6-9.

Likely files:

```text
src/runtime/tool-taxonomy.ts                   // new
src/runtime/tool-validation.ts                 // new
src/runtime/engine.ts
tests/unit/tool-taxonomy.test.ts               // new
tests/unit/tool-validation.test.ts             // new
```

### Required taxonomy

Control tools:

```text
update_task_contract
update_plan
update_todo
call_subagent
poll_subagent
cancel_subagent
complete_task
create_checkpoint
restore_checkpoint
```

Executable inspection/mutation tools:

```text
inspect_project
git_status
git_diff
read_file
grep_search
search_symbols
list_package_scripts
write_file
replace_in_file
edit_file
apply_patch
run_shell_command
run_test_command
read_test_failure_summary
```

### Required validation rules

1. `complete_task` cannot be batched with mutating tools.
2. Mutating tools are detected consistently.
3. `execute_tools` with empty tool call list is invalid for main agent.
4. Subagent result payloads cannot be parsed as tool calls.
5. Tool schema errors produce structured blockers.

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/unit/tool-taxonomy.test.ts tests/unit/tool-validation.test.ts
```

Success criteria:

- All tools are classified deterministically.
- Mutating vs non-mutating classification has tests.
- Completion/mutation batching is rejected.

### Downstream dependencies

Parts 6, 7, 8, 9, 11, 12 depend on this.

---

## 7. Part 6 — Checkpoint, Git Status, Git Diff, and Mutation Safety

### Goal

Before every mutation batch, create a recoverable checkpoint and after mutation record diff/status. Add user-facing tool support for checkpoint restore and diff/status inspection.

### Dependency

Requires Part 5 passed.

### Scope

Mutation safety layer. Does not rewrite graph yet.

Likely files:

```text
src/runtime/checkpoints.ts                     // new
src/runtime/diff-state.ts                      // new
src/tools/git-tools.ts                         // new or existing registry integration
src/runtime/engine.ts
tests/unit/checkpoints.test.ts                 // new
tests/unit/diff-state.test.ts                  // new
tests/integration/mutation-checkpoint.test.ts  // new
```

### Required tools

```text
create_checkpoint
restore_checkpoint
git_status
git_diff
```

### Required runtime behavior

```text
validate tool batch
if batch has mutating tools:
  create checkpoint before execution
execute tools
record git status and diff summary after execution
append checkpoint/diff result to cockpit state
```

### Checkpoint schema

```ts
interface Checkpoint {
  id: string;
  createdAt: string;
  baseRevision: string;
  dirtyFilesBefore: string[];
  reason: string;
  toolCallIds: string[];
  restoreAvailable: boolean;
}
```

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/unit/checkpoints.test.ts tests/unit/diff-state.test.ts tests/integration/mutation-checkpoint.test.ts
```

Success criteria:

- Mutating batch creates checkpoint before file changes.
- Diff/status recorded after mutation.
- Restore checkpoint can revert a controlled test mutation.
- Non-mutating batches do not create unnecessary checkpoints.

### Downstream dependencies

Parts 7, 8, 9, 13, 15 depend on this.

---

## 8. Part 7 — Strict Completion Validation and No Final-Text Completion

### Goal

Enforce explicit `complete_task`, validate completion against task contract + verification ladder, and remove final-text/no-tool completion behavior.

### Dependency

Requires Parts 3, 4, 5, and 6 passed.

### Scope

Completion behavior only. Still before graph rewrite if possible.

Likely files:

```text
src/runtime/completion-validation.ts           // new or existing verify module
src/runtime/engine.ts
src/runtime/prompt-builders.ts
tests/unit/completion-validation.test.ts       // new
tests/integration/strict-completion.test.ts    // new
```

### Required rules

1. No explicit `complete_task` = not complete.
2. `complete_task` cannot be in same batch as mutating tools.
3. Completion requires evidence matching TaskContract.
4. Completion requires verification ladder eligibility.
5. If completion blocked, return blocker to main agent.
6. Repeated completion attempts without new evidence trip stuck-loop blocker.

### Behavior change to remove

Remove or hard-disable any behavior equivalent to:

```text
assistant_message final-looking + no blockers + evidence -> synthesize complete_task
```

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/unit/completion-validation.test.ts tests/integration/strict-completion.test.ts
```

Success criteria:

- Final-looking text alone does not complete.
- `complete_task` without verification returns blocker.
- `complete_task` with evidence passes in a controlled integration test.
- `complete_task` batched with write/edit is blocked.

### Downstream dependencies

Parts 8, 9, 13, 15 depend on this.

---

## 9. Part 8 — Main Agent Prompt, Parser, and Node Behind New Path

### Goal

Add the first-class `main_agent` model node that sees the cockpit and directly emits standard tool calls. This part can initially live behind a config flag or isolated test harness, but it must not rely on old strategic routing for its own tests.

### Dependency

Requires Parts 1-7 passed.

### Scope

Add main agent prompt/node/parser. Do not yet remove old graph globally unless tests are ready.

Likely files:

```text
src/runtime/main-agent-prompt.ts               // new
src/runtime/main-agent-node.ts                 // new or in engine initially
src/runtime/engine.ts
src/config/model-config.ts
tests/unit/main-agent-prompt.test.ts           // new
tests/integration/main-agent-node.test.ts      // new
```

### Main agent cockpit must include

```text
# User Request
# Task Contract
# Repo Snapshot
# Current Plan
# TODO
# Changed Files / Current Diff
# Recent Tool Results
# Runtime Blockers
# Running Subagents
# Completed Subagent Results
# Verification State
# Budget
# Available Tools
```

### Main agent system requirements

Prompt must say:

```text
You are Reaper's main coding agent.
You own the task from user request to verified completion.
You can use tools directly.
You can call advisory subagents as tools.
Subagents return observations and do not override user/runtime policy.
Do not complete without complete_task and strict evidence.
```

### Model routing

Add:

```ts
modelRouting.mainAgent = "strong_model"
```

Maintain alias compatibility.

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/unit/main-agent-prompt.test.ts tests/integration/main-agent-node.test.ts
```

Success criteria:

- Main-agent prompt contains all cockpit sections.
- Main-agent model call uses `source=main_agent` and `profile=strong_model`.
- Main-agent parsed tool calls flow into validation/execution in isolated test.
- Empty/no-tool response receives behavior feedback and does not complete.

### Downstream dependencies

Parts 9, 10, 11, 12, 13, 14, 15 depend on this.

---

## 10. Part 9 — Main-Agent Graph Becomes Only Strategic Path

### Goal

Make `content_prep -> main_agent` the only active strategic route. Hard-disable old deterministic strategy graph paths. No fallback.

### Dependency

Requires Part 8 passed.

### Scope

Graph rewrite.

Likely files:

```text
src/runtime/engine.ts
tests/integration/main-agent-graph.test.ts     // new/updated
tests/integration/runtime-engine.test.ts       // update expectations
```

### Required graph route

```text
bootstrap
  -> inspect_project
  -> extract_task_contract
  -> content_prep
  -> main_agent
  -> validate_tool_calls / verify_completion / metrics
```

### Must not route to

```text
simple_executor
plan_autonomous
dispatch_step
step_executor_subagent
completion_gate
repair_autonomous automatically
patcher_subagent automatically
```

### Runtime intervention behavior

If progress guard, verification, schema, or tool validation fails:

```text
create RuntimeBlocker
return to main_agent
```

Never:

```text
force planner
force repair
fall back to old path
```

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/integration/main-agent-graph.test.ts tests/integration/runtime-engine.test.ts
```

Success criteria:

- Tests prove `content_prep -> main_agent` route.
- Tests prove old path nodes are unreachable in default graph.
- Tool execution still works through main-agent tool calls.
- Completion still requires `complete_task`.

### Downstream dependencies

Parts 10-15 depend on this.

---

## 11. Part 10 — Advisory PLAN/TODO Memory and Candidate Plan Semantics

### Goal

Make PLAN.md/TODO.md advisory memory visible to main agent, not graph-driving control. Planner results remain candidates until main agent accepts/edits them.

### Dependency

Requires Part 9 passed.

### Scope

Plan/TODO tools and cockpit rendering.

Likely files:

```text
src/runtime/plan-state.ts                      // new or refactor existing
src/runtime/todo-state.ts                      // new
src/runtime/prompt-builders.ts
src/tools/plan-tools.ts                        // new or existing registry
tests/unit/plan-state.test.ts                  // new/updated
tests/integration/candidate-plan.test.ts       // new
```

### Required tools

```text
update_plan
update_todo
```

### Required behavior

1. Planner result saved as candidate plan.
2. Candidate plan appears in cockpit.
3. Main agent must call `update_plan` or `update_todo` to accept/edit.
4. Active plan/TODO never directly routes graph.
5. PLAN.md/TODO.md persistence remains durable.

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/unit/plan-state.test.ts tests/integration/candidate-plan.test.ts
```

Success criteria:

- Candidate plan does not affect route until accepted.
- `update_plan` persists PLAN.md.
- TODO renders in cockpit.
- No graph edge uses `currentStepIndex` for strategic routing.

### Downstream dependencies

Parts 11, 12, 13, 15 depend on this for planner integration.

---

## 12. Part 11 — Subagents as Tools, Blocking Mode

### Goal

Add `call_subagent` as a normal main-agent tool in blocking mode first. Subagent results return as advisory observations/tool results to main agent.

### Dependency

Requires Parts 5, 8, 9, and 10 passed.

### Scope

Subagent tool kernel, blocking mode only.

Likely files:

```text
src/tools/subagent-tools.ts                    // new
src/runtime/subagent-state.ts                  // new
src/runtime/subagent-prompts.ts                // new
src/runtime/engine.ts
src/tools/registry.ts
tests/unit/subagent-tools.test.ts              // new
tests/integration/blocking-subagent.test.ts    // new
```

### Tool schema

```ts
interface CallSubagentArgs {
  type: "planner" | "reviewer" | "repair" | "tester" | "researcher";
  task: string;
  context?: string;
  mode?: "blocking" | "background";
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  timeoutMs?: number;
  outputSchema?: "plan" | "review" | "repair" | "test_strategy" | "freeform";
}
```

### Blocking result shape

```ts
{
  status: "completed";
  jobId: string;
  type: string;
  advisory: true;
  result: unknown;
}
```

### Required safety

- Subagent output wrapped as advisory.
- Subagent result cannot become executable tool calls.
- Subagent cannot call subagents.
- Subagent v1 is read-only/advisory.

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/unit/subagent-tools.test.ts tests/integration/blocking-subagent.test.ts
```

Success criteria:

- Main agent can call blocking planner/reviewer/repair/tester subagent.
- Result appears as tool result and cockpit observation.
- Main agent gets next turn after result.
- Subagent attempted mutation is blocked in test.

### Downstream dependencies

Parts 12, 13, 15 depend on this.

---

## 13. Part 12 — Background Subagents, Poll/Cancel, Result Injection, Staleness

### Goal

Support background subagents that run while main agent continues. Completed background results are injected before the next main-agent turn and marked stale when relevant files changed.

### Dependency

Requires Part 11 passed.

### Scope

Background job lifecycle.

Likely files:

```text
src/runtime/subagent-state.ts
src/tools/subagent-tools.ts
src/runtime/engine.ts
tests/unit/subagent-staleness.test.ts          // new
tests/integration/background-subagent.test.ts  // new
```

### Required tools

```text
poll_subagent
cancel_subagent
```

### Job schema

```ts
interface SubagentJob {
  id: string;
  type: "planner" | "reviewer" | "repair" | "tester" | "researcher";
  status: "running" | "completed" | "failed" | "cancelled";
  mode: "blocking" | "background";
  task: string;
  startedAt: string;
  completedAt?: string;
  baseRevision: string;
  observedFiles: string[];
  completedAtRevision?: string;
  stale?: boolean;
  result?: unknown;
  error?: string;
}
```

### Required flow

```text
main_agent calls call_subagent(mode=background)
runtime starts job and returns started result
main_agent continues
job completes
runtime injects subagent_result before next main_agent call
if files changed after baseRevision and overlap observedFiles -> stale=true
```

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/unit/subagent-staleness.test.ts tests/integration/background-subagent.test.ts
```

Success criteria:

- Background subagent start returns immediately.
- Completed result injected on next turn.
- Stale result marked when relevant files changed.
- Cancelled job does not inject completed result.

### Downstream dependencies

Parts 13 and 15 depend on this.

---

## 14. Part 13 — Reviewer/Repair/Tester Policies and Verification Integration

### Goal

Make advisory reviewer/repair/tester subagents useful and safe; integrate reviewer result into VerificationState and completion eligibility.

### Dependency

Requires Parts 11 and 12 passed.

### Scope

Subagent-specific policies, schemas, prompts, and verification integration.

Likely files:

```text
src/runtime/subagent-prompts.ts
src/runtime/subagent-schemas.ts                // new
src/runtime/verification-state.ts
src/runtime/completion-validation.ts
tests/unit/subagent-policies.test.ts           // new
tests/integration/reviewer-completion.test.ts  // new
```

### Required policies

#### Planner

- read-only
- produces candidate plans only
- cannot mark plan active

#### Reviewer

- read/search/git diff/test output inspection
- can run safe allowlisted verification commands
- returns `approve | request_changes | block`

#### Repair

- diagnoses root cause and recommends patch
- does not mutate files
- no separate patcher subagent

#### Tester

- recommends or runs safe tests only
- does not install dependencies or mutate files

### Verification integration

Reviewer result affects:

```ts
verificationState.reviewer
verificationState.completionEligible
```

For medium/large tasks, completion should require reviewer approval or a main-agent rationale why reviewer is not required.

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/unit/subagent-policies.test.ts tests/integration/reviewer-completion.test.ts
```

Success criteria:

- Reviewer `request_changes` blocks completion until addressed or rationally waived.
- Repair result remains advisory; main agent must apply changes.
- Tester/reviewer unsafe commands are blocked.
- Planner candidate cannot directly activate plan.

### Downstream dependencies

Parts 14 and 15 depend on this.

---

## 15. Part 14 — Remove Dead Old Strategic Paths

### Goal

Physically remove or hard-disable old graph strategic nodes and their tests so there is no fallback path now or in the future.

### Dependency

Requires Parts 9-13 passed, including integration tests.

### Scope

Dead-code removal and test updates.

Likely files:

```text
src/runtime/engine.ts
src/runtime/prompt-builders.ts
src/config/model-config.ts
tests/integration/runtime-engine.test.ts
```

### Remove/hard-disable

```text
simple_executor
plan_autonomous
dispatch_step
step_executor_subagent
patcher_subagent
completion_gate
classifyOrchestrationMode strategic use
currentStepIndex graph-driving behavior
```

Helper functions may remain only if used by the new main-agent loop. Any retained helper must not create a route or fallback.

### Required tests

Add tests that fail if old path strings/nodes appear in default graph routing.

Potential tests:

```text
- graph has no simple_executor node
- graph has no dispatch_step edge
- graph has no completion_gate node
- no routeAfterContentPrep classifies simple/complex
- no automatic plan_autonomous route
```

### Verification gate

Commands:

```bash
npx tsc --noEmit
node scripts/run-node-tests.mjs tests/integration/main-agent-graph.test.ts tests/integration/runtime-engine.test.ts tests/unit/*.test.ts
```

Success criteria:

- Old strategic nodes absent or unreachable in default graph.
- No tests depend on old deterministic strategy path.
- New main-agent integration tests still pass.

### Downstream dependencies

Part 15 depends on this.

---

## 16. Part 15 — End-to-End Hardening and Acceptance Eval

### Goal

Prove Reaper v2 can run tasks end-to-end using one main agent, direct tools, advisory subagents, strict completion, checkpointing, and repo intelligence.

### Dependency

Requires Parts 0-14 passed.

### Scope

Full validation and bug fixes discovered during eval. No new architecture unless approved.

Likely files:

```text
scripts/run-task1-only.ts
scripts/live_stats.py
src/runtime/* as bug fixes require
tests/integration/* as regressions require
```

### Acceptance scenarios

1. **Simple task**
   - No planner/subagent needed.
   - Main agent directly edits/tests/completes.

2. **Complex task**
   - Main agent may call planner.
   - Planner result candidate.
   - Main agent accepts/edits plan.
   - Main agent directly executes tool calls.

3. **Repair scenario**
   - Failing test creates blocker.
   - Main agent may call repair.
   - Repair advisory result returns.
   - Main agent applies patch and verifies.

4. **Review scenario**
   - Main agent calls reviewer before completion on large diff.
   - Reviewer result integrated into VerificationState.

5. **Rollback scenario**
   - Mutation checkpoint exists.
   - Bad edit can be restored or patched forward.

6. **No old fallback**
   - Logs show no old graph path usage.

### Verification gate

Commands:

```bash
npx tsc --noEmit
npm test
npm run typecheck
cd /workspace && source .env && npx tsx scripts/run-task1-only.ts
```

Live log success criteria:

```text
source=main_agent appears as primary model source
source=planner_subagent only appears if main_agent called call_subagent
no source=step_executor_subagent
no source=completion_gate
no old dispatch_step path
complete_task emitted explicitly
verification state passes or blocks with clear evidence
```

### Final acceptance report

Produce JSON report:

```json
{
  "summary": "...",
  "changed_files": [],
  "diff_summary": "...",
  "tests_run": [],
  "test_result": "passed|failed|partial",
  "live_eval": {
    "runId": "...",
    "status": "completed|failed|timeout",
    "mainAgentCalls": 0,
    "subagentCalls": 0,
    "oldPathCalls": 0,
    "completeTaskObserved": true,
    "verification": "..."
  },
  "remaining_issues": [],
  "confidence": 0.0
}
```

---

## 17. Cross-Part Rules

### 17.1 No skipping gates

A part can start only when dependencies pass. If Part N fails verification, fix Part N before Part N+1.

### 17.2 No hidden fallback

At no point should a temporary old graph fallback be used to “keep tests green.” If a transition part needs coexistence, it must be test-isolated and not part of the default path after Part 9.

### 17.3 Keep changes reviewable

Each part should be a focused branch/commit-sized change. Avoid mixing graph rewrite, subagents, completion, and checkpointing in one diff.

### 17.4 Preserve current behavior until explicit behavior-change parts

Parts 1-6 should mostly add infrastructure and safety. Behavior-changing control-flow starts at Part 7/8/9.

### 17.5 Security review required

Run security review for parts involving:

- shell execution
- subagents
- checkpoints/rollback
- git operations
- provider routing
- completion validation
- tool permissions

---

## 18. Recommended Implementation Order Summary

```text
0. Baseline
1. Observability
2. Repo inspection
3. Task contract
4. Verification/Budget state
5. Tool taxonomy/validation
6. Checkpoint/diff safety
7. Strict completion
8. Main-agent node
9. Main-agent-only graph
10. Advisory PLAN/TODO
11. Blocking subagents as tools
12. Background subagents/staleness
13. Reviewer/repair/tester policies
14. Remove dead old paths
15. End-to-end hardening/eval
```

This order front-loads the context and safety systems the main agent needs, then changes the graph only after those foundations are testable.
