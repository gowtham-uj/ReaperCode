# python-debugging

Diagnose Python errors, tracebacks, and runtime issues.

## Steps

1. Capture the full traceback (no truncation).
2. Identify the deepest frame where the cause is.
3. Read the source at that frame and the caller(s).
4. Reproduce with the smallest script or pytest.
5. Fix; if the fix is a band-aid, log it as a follow-up.
6. Add a regression test if the bug is class-of-error.

## When NOT to use

- The error is a third-party environment issue (install / OS).
- The user wants performance tuning, not a bug fix.

## Validation

The repro must fail before and pass after the fix.
