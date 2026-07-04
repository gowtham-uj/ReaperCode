# Reaper Context A/B Test: Shake / Prune ~200K Token Pressure

You are running a context-engineering A/B test for Reaper. The objective is to intentionally fill the live conversation with enough file-read tool result context that Reaper's shake/prune mechanism triggers automatically under normal context pressure, while keeping the fixture around ~200K estimated tokens.

Benchmark folder in workspace: `benchmarks/context-shake-900k/`
Manifest: `benchmarks/context-shake-900k/manifest.json`
Payload folder: `benchmarks/context-shake-900k/payload/`

## Required task

1. Read `benchmarks/context-shake-900k/manifest.json` first.
2. Read every payload file listed in the manifest individually, in ascending order from `payload/shard-001.txt` through `payload/shard-040.txt`.
   - This is a context A/B test. Do not optimize it away with scripts, grep-only summaries, checksums, or shell loops.
   - The point is to push file contents into the model/tool-result conversation so the runtime can shake/prune stale results.
   - Use normal file read/view tools one file at a time.
3. From each file, extract:
   - `REQUIRED_FACT_ID`
   - `REQUIRED_PRIORITY`
   - `REQUIRED_CHECKSUM_SEED`
4. Create `benchmark-output/context-shake-summary.json` containing:
   - `files_read`: number
   - `facts`: array of objects with `file`, `fact_id`, `priority`, `checksum_seed`
   - `priority_counts`: counts by priority
   - `notes`: mention whether any context shake/prune events were visible to you, if the runtime reports them.
5. Verify the JSON file exists and contains exactly 40 facts.
6. Finish naturally with a concise final message.

## Expected pressure

The payload contains 805,376 characters, approximately 201,360 tokens by Reaper's chars/4 heuristic. Reading all files individually should be enough to cross a 100K-token shake trigger on a 200K soft cap, but small enough to run more practically than the earlier 900K fixture.
