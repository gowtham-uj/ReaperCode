# swe-bench-solving

Approach SWE-bench tasks systematically.

## Steps

1. Read the issue end-to-end; identify the failing test and the expected behavior.
2. Locate the relevant files; read both the implementation and its tests.
3. Form a minimal patch hypothesis; do not refactor unrelated code.
4. Apply the patch; preserve public APIs unless the issue requires otherwise.
5. Run the failing tests; iterate until they pass.
6. Run the broader suite to catch regressions.

## When NOT to use

- The issue has no reproducible test.
- The change requires behavior the issue does not request.

## Validation

The specific failing tests must pass; the broader suite must not regress.
