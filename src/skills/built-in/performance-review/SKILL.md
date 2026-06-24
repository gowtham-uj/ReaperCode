# performance-review

Profile hot paths and propose optimizations backed by a benchmark.

## Steps

1. Identify the hot path with a profiler or sampling.
2. Write a benchmark that reproduces the workload.
3. Capture baseline numbers (p50 / p99 / memory).
4. Form a hypothesis; change one thing at a time.
5. Re-run the benchmark; record the delta.
6. Keep the change only if the delta is real and worth the complexity.

## When NOT to use

- There is no measurable slow path.
- The change would obscure the code without measurable gain.

## Validation

The benchmark numbers must move; the existing test suite must still pass.
