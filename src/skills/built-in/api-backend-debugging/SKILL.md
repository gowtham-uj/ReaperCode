# api-backend-debugging

Trace API failures across server, DB, and network layers.

## Steps

1. Capture the request (method, path, headers, body) and the response.
2. Identify the server handler; read the route + middleware.
3. Trace DB / external calls — log the SQL / RPC + params.
4. Reproduce locally with the same input.
5. Patch the failure point; if the bug is in error mapping, surface a clear error.
6. Add a regression test that exercises the same request shape.

## When NOT to use

- The bug is in a third-party SaaS you don't control.
- The fix requires a deploy you cannot perform.

## Validation

The local repro must succeed; the regression test must pass.
