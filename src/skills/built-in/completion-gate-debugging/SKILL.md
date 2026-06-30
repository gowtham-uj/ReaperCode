# completion-gate-debugging

Diagnose completion-gate, verification, and finalization failures.

## Steps

1. Capture the failing completion call: which condition denied it.
2. Read the gate's contract: which conditions are required (verification, trust).
3. Inspect the trajectory for the missing precondition.
4. Decide: was the precondition missed (real bug) or wrongly required (over-strict)?
5. If missed, fix the run to satisfy it; if over-strict, soften the gate.
6. Re-run end-to-end and confirm the gate now allows completion.

## When NOT to use

- The user wants to bypass the gate manually — wrong tool.
- The verification evidence is intentionally absent.

## Validation

The completion call must succeed; the verification log must remain auditable.
