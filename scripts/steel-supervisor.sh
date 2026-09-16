#!/bin/bash
# Keep the vendored Steel API up, and say why whenever it goes down.
#
# Steel used to die silently: the CDP port closed, every browser test skipped,
# and the suite reported "no browser here" rather than "the browser died". One
# crash took the whole process with it, so a single stray rejection looked
# exactly like a machine that had never started Steel.
#
# This restarts it and timestamps every exit, so the log distinguishes a crash
# from a clean stop and a flapping process from a stable one.
set -u
CHROME="${CHROME_EXECUTABLE_PATH:-/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome}"
export CHROME_EXECUTABLE_PATH="$CHROME"
cd "$(dirname "$0")/../vendor/steel-browser" || exit 1

while true; do
  echo "[steel-supervisor] starting at $(date -Is) with CHROME_EXECUTABLE_PATH=$CHROME"
  npm run dev -w api
  code=$?
  echo "[steel-supervisor] exited code=$code at $(date -Is); restarting in 3s"
  sleep 3
done
