# Reaper Context A/B Test — Shake/Prune ~200K

This fixture is for comparing Reaper versions/providers on context engineering behavior at a practical ~200K estimated-token scale.

> Folder name remains `context-shake-900k` for continuity with earlier setup, but the payload has been resized to ~200K estimated tokens.

## What it tests

It forces the agent to read many large files one by one so tool-result context grows toward ~200K estimated tokens. This should trigger Reaper's shake/prune mechanism around the normal 50% threshold of a 200K soft cap.

## Contents

- `payload/` — 40 text files, each about 20,000 chars.
- `manifest.json` — expected facts/hashes.
- `task_prompt.md` — prompt to pass to Reaper.
- `run.sh` — convenience runner.
- `analyze_run.py` — extracts model-call context growth and `context_shake` events.

## Size

- Total payload chars: 805,376
- Estimated tokens chars/4: 201,360

## Run later

```bash
cd /workspace/reapercode-main
PROVIDER=nuralwatt2 MODEL=kimi-k2.6-fast bash benchmarks/context-shake-900k/run.sh
```

Or with another provider/model:

```bash
PROVIDER=<provider> MODEL=<model> bash benchmarks/context-shake-900k/run.sh
```

## Analyze

```bash
RUN_DIR=$(ls -td /tmp/reaper-context-shake-900k/.reaper/runs/* | head -1)
python3 benchmarks/context-shake-900k/analyze_run.py "$RUN_DIR"
```

Important metrics:

- `shake_events`
- `total_saved_chars`
- `total_saved_tokens_est`
- final `tool_chars`
- final placeholder count in model requests
- whether `benchmark-output/context-shake-summary.json` has 40 facts
