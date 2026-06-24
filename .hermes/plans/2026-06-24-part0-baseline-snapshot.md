# Part 0 Baseline Snapshot and Safety Harness

> Branch: `chore/part0-baseline-snapshot`
>
> Base commit: `e2c461e` (`Initial sanitized Reaper source snapshot`)
>
> Purpose: record current baseline before starting the Reaper v2 main-agent architecture refactor.

## Selected track

The highest-impact architecture capability is **Part 2 — Repository Intelligence Layer**, because it gives the future main agent compact repo understanding before it edits. However, the dependency gates require:

```text
Part 0 baseline -> Part 1 observability -> Part 2 repo intelligence
```

So this branch implements Part 0 only: no behavior changes, just a baseline note from real command output.

## Working tree baseline

Command:

```bash
git status --short
git rev-parse --short HEAD
git branch --show-current
```

Observed before writing this note:

```text
HEAD: e2c461e
branch: chore/part0-baseline-snapshot
status: clean before baseline doc creation
```

## Typecheck baseline

Command:

```bash
npm run typecheck
```

Result: **failed** with 7 TypeScript errors.

Observed output:

```text
src/tui/engine-driver.ts(282,7): error TS2353: Object literal may only specify known properties, and 'hooks' does not exist in type 'RuntimeEngineInput'.
tests/perf/enter-to-first-delta.test.ts(162,5): error TS2353: Object literal may only specify known properties, and 'hooks' does not exist in type 'RuntimeEngineInput'.
tests/unit/engine-implicit-completion.test.ts(23,10): error TS2305: Module '"../../src/runtime/engine.js"' has no exported member 'detectImplicitCompletion'.
tests/unit/engine-implicit-completion.test.ts(294,7): error TS2353: Object literal may only specify known properties, and 'hooks' does not exist in type 'RuntimeEngineInput'.
tests/unit/engine-implicit-completion.test.ts(335,7): error TS2353: Object literal may only specify known properties, and 'hooks' does not exist in type 'RuntimeEngineInput'.
tests/unit/engine-implicit-completion.test.ts(367,7): error TS2353: Object literal may only specify known properties, and 'hooks' does not exist in type 'RuntimeEngineInput'.
tests/unit/engine-implicit-completion.test.ts(447,7): error TS2353: Object literal may only specify known properties, and 'hooks' does not exist in type 'RuntimeEngineInput'.
```

Baseline classification:

- Pre-existing at sanitized snapshot `e2c461e`.
- Blocks the formal Part 0 “typecheck passes” gate if interpreted strictly.
- Does not block focused runtime tests below.
- Recommended next PR before Part 1: fix stale `RuntimeEngineInput.hooks` callsites and stale `detectImplicitCompletion` test/export expectations, or explicitly accept this as known baseline debt.

## Focused integration/runtime baseline

Command:

```bash
node scripts/run-node-tests.mjs tests/integration/runtime-engine.test.ts tests/integration/execution-phase5.test.ts tests/integration/recovery-phase3.test.ts
```

Result: **passed**.

Observed summary:

```text
1..42
# tests 42
# suites 0
# pass 41
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 76320.907148
```

## Focused unit baseline

Command:

```bash
node scripts/run-node-tests.mjs tests/unit/model-observability.test.ts tests/unit/parameter-mapper.test.ts tests/unit/runtime-state.test.ts
```

Result: **passed**.

Observed summary:

```text
1..9
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1555.839397
```

## Part 0 gate status

```json
{
  "part": "Part 0 - Baseline Snapshot and Safety Harness",
  "baseCommit": "e2c461e",
  "typecheck": "failed_preexisting",
  "focusedIntegration": "passed",
  "focusedUnit": "passed",
  "behaviorChanged": false,
  "gateStatus": "partial",
  "recommendedNext": "Fix baseline TypeScript errors before Part 1, or explicitly approve carrying them as known baseline debt."
}
```

## Highest-impact next path

After this baseline is accepted, the recommended sequence is:

1. **Baseline TypeScript cleanup** if required by gate discipline.
2. **Part 1 — Source-first observability + model profile naming.**
3. **Part 2 — Repository Intelligence Layer** as the first major product-impact capability.

Part 2 remains the highest-impact target because it directly improves the future main agent’s first-turn repo understanding and reduces wasted discovery turns.
