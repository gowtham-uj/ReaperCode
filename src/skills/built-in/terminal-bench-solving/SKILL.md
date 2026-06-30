# terminal-bench-solving

Approach terminal-bench tasks systematically.

## Steps

1. Read the task statement fully; note the binary / scripted answer expected.
2. Inspect the environment: which binaries are available, which paths.
3. Reproduce the failure locally if one is described.
4. Apply the smallest fix or build the missing artifact.
5. Verify by re-running the official check; do not stop until it passes.
6. Do not introduce side effects outside the workspace.

## When NOT to use

- The task has no scripted / binary answer (open-ended writing).
- The environment is non-deterministic and outside your control.

## Validation

The official verification command must exit 0 with the expected output.
