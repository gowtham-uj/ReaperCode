# typescript-refactor

Refactor TypeScript code while preserving types and behavior.

## Steps

1. Read the public API surface (exports, types, classes, Zod schemas).
2. Plan the refactor in small commits; preserve exports + signatures.
3. Move / extract / rename with `replace_symbol` or `edit_file` blocks.
4. Keep `tsc --noEmit` (or the project's typecheck) green at every step.
5. Run existing tests; do not delete tests to make the refactor pass.
6. Document breaking changes in CHANGELOG.

## When NOT to use

- The file is <100 lines and the change is purely cosmetic.
- The refactor requires behavior changes — split into two PRs.

## Validation

`tsc --noEmit` must pass; the existing test suite must pass without skips.
