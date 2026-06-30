# session-persistence

Diagnose and repair session restore, replay, and persistence issues.

## Steps

1. Capture the failure mode: blank restore, wrong replay, corrupt checkpoint.
2. Inspect the on-disk checkpoint format; compare to the live shape.
3. Identify the migration gap or the dropped field.
4. Patch the writer/reader pair; do not silently drop fields.
5. Add a round-trip test that writes → reads → matches.
6. Verify replay runs identically to the original trajectory.

## When NOT to use

- The session loss is intentional (e.g. user cleared the scratchpad).
- The checkpoint format is being redesigned elsewhere.

## Validation

A round-trip test must pass for every persisted shape.
