#!/usr/bin/env bash
set -e
cd /workspace

source .env

RUN_ID="run-$(date +%s)-$(openssl rand -hex 4)"
WORKSPACE="/workspace/reaper_eval/workspaces/task2/$RUN_ID"
LOG_DIR="/workspace/reaper_eval/run_logs/task2/$RUN_ID"

echo "=== Task 2: Real-time Chat Application ==="
echo "Run ID: $RUN_ID"
echo ""

# Setup workspace
mkdir -p "$WORKSPACE/src" "$LOG_DIR"

# Create seed files
cat > "$WORKSPACE/package.json" 