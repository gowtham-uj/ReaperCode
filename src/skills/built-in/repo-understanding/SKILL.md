# repo-understanding

Map a repository's structure, conventions, build steps, and entry points before
making changes.

## Steps

1. Read the top-level layout (`list_directory` on the workspace root).
2. Identify package manifests (package.json, pyproject.toml, go.mod, Cargo.toml, etc.).
3. Identify the entry points (main files, CLI binaries, server boot).
4. Identify the test commands and any CI hints.
5. Identify the conventional directories (src/, lib/, tests/, examples/).
6. Summarize findings in a short report — file tree, entry points, build, tests.

## When NOT to use

- The repo is already familiar and the change is small and local.
- The task is purely a single-file edit with no new dependencies.

## Validation

Run `reaper skill test repo-understanding` — the smoke command should exit 0.
