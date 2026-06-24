#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

export PI_CACHE_RETENTION="${PI_CACHE_RETENTION:-long}"
export PI_TELEMETRY="${PI_TELEMETRY:-0}"
export HYPERAGENT_PI_AUTO_LAUNCH="${HYPERAGENT_PI_AUTO_LAUNCH:-1}"
export HYPERAGENT_PI_FORWARD_TOOLS="${HYPERAGENT_PI_FORWARD_TOOLS:-1}"
export HYPERAGENT_PI_FORWARD_SYSTEM_PROMPT="${HYPERAGENT_PI_FORWARD_SYSTEM_PROMPT:-1}"
export REAPER_PI_WORKSPACE_ROOT="$repo_root"
export PI_REAL_BIN="${PI_REAL_BIN:-/usr/local/bin/pi}"

exec "$PI_REAL_BIN" --approve --reaper-yolo --provider hyperagent --model claude-opus-4-8 --thinking xhigh "$@"
