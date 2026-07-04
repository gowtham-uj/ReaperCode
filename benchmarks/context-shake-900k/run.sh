#!/usr/bin/env bash
set -euo pipefail
ROOT="/workspace/reapercode-main"
WORKSPACE="${WORKSPACE:-/tmp/reaper-context-shake-900k}"
PROVIDER="${PROVIDER:-nuralwatt2}"
MODEL="${MODEL:-kimi-k2.6-fast}"
PROMPT="$ROOT/benchmarks/context-shake-900k/task_prompt.md"
rm -rf "$WORKSPACE"
mkdir -p "$WORKSPACE/benchmarks"
cp -R "$ROOT/benchmarks/context-shake-900k" "$WORKSPACE/benchmarks/context-shake-900k"
cd "$ROOT"
npx tsx scripts/run-reaper.ts exec run   --workspace "$WORKSPACE"   --provider "$PROVIDER"   --model "$MODEL"   --prompt-file "$PROMPT"   --json | tee "$WORKSPACE/reaper-result.json"
