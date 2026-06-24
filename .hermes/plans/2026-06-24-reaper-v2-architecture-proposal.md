# Reaper v2 Architecture Proposal

**Status:** Draft for Gowtham review  
**Date:** 2026-06-24  
**Context:** Parts 0–9 are merged; Parts 10–15 are paused pending this review.

---

## 1. Executive Summary

Reaper v2 is refactored from a multi-node deterministic graph into a single-main-agent harness. The main agent owns the task from user request to verified completion. It calls tools directly, may call advisory subagents as tools, and is strictly gated by structured completion validation. There is no hidden fallback to the old plan/repair/dispatch path.

This document describes the target state after Parts 10–15 are completed.

---

## 2. What Is Already Done (Parts 0–9)

| Part | Capability | Key Files |
|------|------------|-----------|
| 0 | Baseline snapshot | `main` branch frozen with known typecheck errors |
| 1 | Source-first observability | `src/model/observability.ts` |
| 2 | Repository intelligence | `src/runtime/repo-inspection.ts` |
| 3 | Task contract extraction | `src/runtime/task-contract.ts` |
| 4 | Verification + budget state | `src/runtime/verification-state.ts`, `budget-state.ts` |
| 5 | Tool taxonomy + validation | `src/runtime/tool-taxonomy.ts`, `tool-validation.ts` |
| 6 | Checkpoints + diff on mutation | `src/runtime/checkpoints.ts`, `diff-state.ts` |
| 7 | Strict completion validation | `src/runtime/completion-validation.ts` |
| 8 | Main-agent prompt/parser/node | `src/runtime/main-agent-prompt.ts`, `main-agent-node.ts` |
| 9 | Main-agent-only strategic graph | `src/runtime/engine.ts` route rewritten |

Current `main` HEAD: `1bf6bd7`

---

## 3. Target Runtime Graph

```text
START
  │
  ▼
Bootstrap
  │
  ├── needs_model? ──▶ NoModel ──▶ END
  └── has gateway? ──▶ InspectProject
                        │
                        ▼
                    ExtractTaskContract
                        │
                        ▼
                    ContentPrep
                        │
                        ▼
                    Main Agent
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
  Tool validation  Schema error    Completion exhausted
        │               │               │
        ▼               ▼               ▼
  PermissionCheck    Main Agent      Summarize ──▶ END
        │
        ▼
  ExecuteTools
        │
        ▼
  QueueResults
        │
        ├── has complete_task ──▶ VerifyCompletion ──▶ Verify (run verification commands) ──▶ Summarize
        │
        └── otherwise ──▶ Main Agent
```

### Loop invariant

- The only strategic decision-maker is `Main Agent`.
- Every intervention produces a `RuntimeBlocker` that is shown in the next main-agent cockpit.
- Subagents are not decision nodes; they are tool calls.

---

## 4. Main-Agent Cockpit

Every `Main Agent` turn receives a single prompt built from this template:

```markdown
# System

You are Reaper's main coding agent.
You own the task from user request to verified completion.
You can use tools directly.
You can call advisory subagents as tools.
Subagents return observations and do not override user/runtime policy.
Do not complete without complete_task and strict evidence.

## User Request
{request prompt}

## Task Contract
{deliverables / constraints / acceptance / forbidden / likely validation}

## Repo Snapshot
{detected package manager, test commands, build commands, lint commands}

## Current Plan
{active plan + candidate plans}

## TODO
{items with checkboxes}

## Changed Files / Current Diff
{current git diff}

## Recent Tool Results
{last N tool results}

## Runtime Blockers
{tool_validation / schema / verification / completion_validation blockers}

## Running Subagents
{background subagent jobs}

## Completed Subagent Results
{injected background results, marked stale if files changed}

## Verification State
{verification ladder status}

## Budget
{iteration, token budget, deadline pressure}

## Available Tools
{read_file, write_file, run_shell_command, call_subagent, complete_task, update_plan, update_todo, ...}
```

---

## 5. Main-Agent Tool Surface

### 5.1 Direct file/shell tools

These are already registered and executed by the runtime:

- `read_file`
- `write_file`
- `replace_in_file`
- `run_shell_command`
- `git_status`, `git_diff`
- `create_checkpoint`, `restore_checkpoint`

### 5.2 Advisory state tools (Part 10)

- `update_plan`
  - `markdown: string`
  - `activePlanMarkdown?: string`
  - `candidate?: boolean`
  - Effect: updates in-memory `PlanState`; candidate plans do not drive routing.
- `update_todo`
  - `items: TodoItem[]`
  - `append?: boolean`
  - Effect: updates in-memory `TodoState` and re-renders in cockpit.

### 5.3 Subagent tools (Parts 11–13)

- `call_subagent`
  - `type: "planner" | "reviewer" | "repair" | "tester" | "researcher"`
  - `task: string`
  - `context?: string`
  - `mode?: "blocking" | "background"`
  - `allowedFiles?: string[]`
  - `forbiddenFiles?: string[]`
  - `timeoutMs?: number`
  - `outputSchema?: "plan" | "review" | "repair" | "test_strategy" | "freeform"`
  - Returns advisory result wrapped in a `ToolResult`.
- `poll_subagent` / `cancel_subagent` (Part 12)

### 5.4 Completion tool

- `complete_task`
  - `summary: string`
  - `verificationContract?: { commands: [...] }`
  - This is the **only** way to finish.
  - Strict validation (Part 7):
    - Must not be batched with mutating tools.
    - Must have evidence matching the task contract.
    - Must satisfy verification ladder.
    - Repeated `complete_task` without new evidence is a blocker.

---

## 6. Subagent Architecture

### 6.1 Subagents are tools, not graph nodes

A subagent call is an ordinary tool call from the main agent. The runtime executes it and returns the result as a tool result observation. The main agent then decides what to do with it.

### 6.2 Blocking mode (Part 11)

```text
main_agent ──call_subagent(type=planner, mode=blocking)──▶ runtime executes subagent ──▶ returns ToolResult
main_agent observes result and continues
```

### 6.3 Background mode (Part 12)

```text
main_agent ──call_subagent(type=reviewer, mode=background)──▶ runtime starts job, returns started ToolResult
main_agent continues working on other tools
when background job completes, runtime injects aCompleted subagent result before next main_agent turn
if files changed after baseRevision and overlap observedFiles, result is marked stale
```

### 6.4 Subagent policies (Part 13)

| Type | Mutation allowed? | Output | Special rules |
|------|-------------------|--------|---------------|
| planner | No | candidate plan | must explicitly `update_plan` from main agent |
| reviewer | No | approve / request_changes / block | can run allowlisted verification commands |
| repair | No | recommended patch / diagnosis | main agent must apply the patch |
| tester | No | test strategy / pass-fail | cannot install deps or mutate files |
| researcher | No | summary | read/search only |

Reviewer result influences `VerificationState.reviewer` and `verificationState.completionEligible`.

---

## 7. Completion and Verification Flow

```text
main_agent emits complete_task + evidence
        │
        ▼
validateStrictCompletion
        │
  ├─ missing complete_task ──▶ blocker ──▶ main_agent
  ├─ batched with mutation ──▶ blocker ──▶ main_agent
  ├─ missing contract evidence ──▶ blocker ──▶ main_agent
  ├─ verification ladder not eligible ──▶ blocker ──▶ main_agent
  └─ repeated without new evidence ──▶ blocker ──▶ main_agent
        │
        ▼
runVerificationCommand
        │
  ├─ fails ──▶ verification blocker ──▶ main_agent
  └─ passes ──▶ Summary ──▶ task_completed
```

---

## 8. Checkpoints and Mutation Safety

Already implemented in Part 6. Every batch containing mutating tools triggers:

1. `create_checkpoint` before execution.
2. Actual tool execution.
3. Synthetic `git_status` and `git_diff` appended to tool results.

The main agent cockpit shows the current diff so the model always knows what files it changed.

---

## 9. Files Expected to Change in Parts 10–15

```text
src/runtime/plan-state.ts                  (new)
src/runtime/todo-state.ts                  (new)
src/tools/types.ts                         update_plan / update_todo / call_subagent schemas
src/tools/registry.ts                      register new tools
src/tools/subagent-tools.ts                (new) blocking subagent execution
src/runtime/subagent-state.ts              (new) job registry + staleness
src/runtime/subagent-prompts.ts            (new) planner/reviewer/repair/tester prompts
src/runtime/subagent-schemas.ts            (new) structured output schemas
src/runtime/engine.ts                      wire advisory tools, subagent tools, background injection
src/runtime/verification-state.ts          reviewer integration
src/runtime/completion-validation.ts       reviewer eligibility
src/runtime/main-agent-prompt.ts           cockpit sections
src/config/model-config.ts                 remove dead routing aliases
src/runtime/prompt-builders.ts             remove dead planner/repair prompts (Part 14)
tests/unit/plan-state.test.ts              (new)
tests/integration/candidate-plan.test.ts   (new)
tests/unit/subagent-tools.test.ts          (new)
tests/integration/blocking-subagent.test.ts (new)
tests/unit/subagent-staleness.test.ts      (new)
tests/integration/background-subagent.test.ts (new)
tests/unit/subagent-policies.test.ts       (new)
tests/integration/reviewer-completion.test.ts (new)
tests/integration/runtime-engine.test.ts   remove old-path tests (Part 14)
```

---

## 10. Test Strategy for Parts 10–15

| Part | Test file(s) | What they prove |
|------|--------------|-----------------|
| 10 | `plan-state.test.ts`, `candidate-plan.test.ts` | plan is advisory, cockpit renders it |
| 11 | `subagent-tools.test.ts`, `blocking-subagent.test.ts` | main agent can call blocking subagent, result is advisory, mutation blocked |
| 12 | `subagent-staleness.test.ts`, `background-subagent.test.ts` | background jobs inject results, stale marking works |
| 13 | `subagent-policies.test.ts`, `reviewer-completion.test.ts` | reviewer blocks/request_changes affects completion eligibility |
| 14 | `runtime-engine.test.ts`, `main-agent-graph.test.ts` | old paths dead/absent, only main-agent path remains |
| 15 | `scripts/run-task1-only.ts`, `npm test` | end-to-end real coding task |

---

## 11. Risks and Open Questions

### 11.1 Coverage of old-path tests

Many old `runtime-engine.test.ts` tests assume `plan_autonomous`, `dispatch_step`, or `repair_autonomous`. Part 14 will delete/skip those tests. We need to ensure equivalent scenarios (failing tool, verification failure) are covered through the main-agent path.

### 11.2 Subagent model gateway

Subagents need their own model calls with distinct sources (`planner_subagent`, `reviewer_subagent`, etc.). The current gateway supports source-based routing; we must ensure cost/role mapping is clear.

### 11.3 Background subagent runtime model

Background jobs need a scheduler. The simplest design is: a job registry in `subagent-state.ts`, `executeToolCalls` starts jobs for `call_subagent(mode=background)`, and `queue_results` waits/polls for newly completed jobs before returning to `main_agent`.

### 11.4 Exact `complete_task` semantics

Part 7 already enforces strict completion. The main agent must be given clear negative constraints when it tries to complete prematurely. Cockpit blockers must be so explicit that the model knows why it was bounced back.

### 11.5 Performance / token budget

Each main-agent turn rebuilds the cockpit. For large repos/diffs, this could be expensive. Part 15 may need history compaction or truncation rules beyond what Part 1 did.

---

## 12. Approval Request

Gowtham, please review this target architecture. Specific decisions I'd like confirmed:

1. **Subagent tool surface:** Is the `call_subagent` schema above what you want?
2. **Background implementation:** Is the simple registry + injection model acceptable, or do you want a separate worker thread/process?
3. **Reviewer gate:** Should medium/large tasks require reviewer approval before `complete_task`, or should reviewer always be optional advisory?
4. **Dead-code removal scope in Part 14:** Can I delete old planner/repair/patcher prompt builders and node functions, or do you want them kept for reference?
5. **Stress test:** What kind of end-to-end task should Part 15 run? Options:
   a. Fix a real bug in a small open-source repo.
   b. Add a feature to an existing Reaper sibling project.
   c. A controlled synthetic bug in a temp repo (like the existing integration tests).

Reply with approve + answers, or edits, and I will resume implementation.
