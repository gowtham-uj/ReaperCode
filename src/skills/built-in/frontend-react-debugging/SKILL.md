# frontend-react-debugging

Diagnose React component, hook, and state bugs.

## Steps

1. Capture the rendered UI (screenshot if you have a browser).
2. Identify the component tree at the failure point.
3. Trace state ownership: which hook / prop / context owns the wrong value?
4. Look for: stale closures, missing deps, wrong key, double-fire effect.
5. Apply a minimal fix; do not rewrite the component.
6. Re-render and confirm.

## When NOT to use

- The bug is a server / network error — use api-backend-debugging.
- The change is purely a styling tweak.

## Validation

The UI must render correctly after the fix; no console errors; existing
component tests must pass.
