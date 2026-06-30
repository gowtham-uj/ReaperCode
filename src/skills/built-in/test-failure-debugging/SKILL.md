# test-failure-debugging

Triage and repair failing tests.

## Steps

1. Capture the failing test names, the error lines, and the run command.
2. Group failures by shared root cause (imports, env, fixture, assertion shape).
3. Read the test file and the implementation under test; spot the divergence.
4. If flaky, isolate timing/global-state causes; do not paper over with `sleep`.
5. Apply minimal targeted fixes; do not rewrite tests to match buggy output.
6. Re-run the full test suite for the affected module.

## When NOT to use

- The test suite is green and you are proposing new tests.
- The failure is in a third-party library you don't control.

## Validation

`reaper skill test test-failure-debugging` — smoke exits 0; the actual fix
must make the original failing tests pass.
