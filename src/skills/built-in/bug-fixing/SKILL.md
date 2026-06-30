# bug-fixing

Diagnose, reproduce, and fix a reported bug.

## Steps

1. Restate the symptom in one sentence.
2. Locate the failing code path (`grep_search`, `skim_file`).
3. Reproduce with the smallest possible case (a unit test, a curl, a CLI invocation).
4. Form a hypothesis; instrument or `view_file` to confirm.
5. Apply the minimal fix.
6. Re-run the repro and any nearby tests.

## When NOT to use

- The bug is purely cosmetic or speculative with no repro.
- The user only wants a discussion, not a code change.

## Validation

Add or update a test that fails before the fix and passes after.
