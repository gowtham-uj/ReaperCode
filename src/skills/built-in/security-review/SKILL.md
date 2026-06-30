# security-review

Audit code for common security regressions.

## Steps

1. Identify trust boundaries (user input → handler → DB / network).
2. Check input validation at each boundary (allow-list, type, length).
3. Check authn/authz on every privileged endpoint.
4. Check secret handling: no hardcoded keys, no raw secret logging.
5. Check outbound calls: SSRF, deserialization, command injection.
6. Check dependency surface: known CVEs in top-level deps.

## When NOT to use

- The diff is documentation-only.
- The user wants a perf review, not security.

## Validation

Findings must reference a specific file:line. Severity: blocker / major / minor.
