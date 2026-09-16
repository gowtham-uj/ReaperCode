#!/usr/bin/env bash
#
# Redeploy the live stack: the app-server gateway and the UI.
#
# Written because this went wrong twice in one session. A server started by hand
# keeps running with the code it loaded at boot, so every fix after that point
# looks unfixed to anyone using the UI, and there is no error to explain it: the
# process is healthy, the ports answer, and the behaviour is simply old. The
# second time, two Steel processes were running at once and competing for port
# 9222, which produces intermittent connect failures that look like a crash.
#
# So this script does the unglamorous part properly: stop what is holding the
# ports, confirm the ports are actually free, start both servers, and wait for
# each to answer. It is idempotent, and it is safe to run when nothing is up.
#
#   ./scripts/serve-live.sh          stop, rebuild the UI, start both, verify
#   ./scripts/serve-live.sh --no-build   skip the UI build (faster, uses dist as-is)
#   ./scripts/serve-live.sh --stop       stop only
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The two listeners this stack owns. The app-server also opens the raw protocol
# on a random port, which is not pinned here because nothing needs to know it.
GATEWAY_PORT="${REAPER_BFF_PORT:-4180}"
UI_PORT=5273

LOG_DIR="$ROOT/.reaper/logs"
mkdir -p "$LOG_DIR"
APP_LOG="$LOG_DIR/app-server.log"
UI_LOG="$LOG_DIR/ui.log"

BUILD=1
STOP_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --stop) STOP_ONLY=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[2m[serve-live]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[serve-live] %s\033[0m\n' "$*" >&2; }

##
# Stop whatever is holding a port, and wait until it lets go.
#
# `kill` returns before the process is gone, so a script that kills and
# immediately starts would race its own replacement for the port and fail to
# bind. The wait is the point, and SIGKILL is the fallback because a tsx watcher
# ignores the polite signal often enough to matter.
##
stop_port() {
  local port="$1" label="$2" pids
  pids="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)"
  if [ -z "$pids" ]; then
    say "$label: nothing on :$port"
    return 0
  fi
  say "$label: stopping $(echo "$pids" | tr '\n' ' ') on :$port"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
      say "$label: :$port released"
      return 0
    fi
    sleep 0.5
  done
  say "$label: still bound after 10s, forcing"
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
  sleep 1
  if ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
    fail "$label: could not free :$port"
    return 1
  fi
  return 0
}

##
# Wait for a URL to answer, up to a deadline.
#
# Both servers take a variable few seconds to boot (tsx compiles on the fly), and
# a fixed sleep is either too short under load or wasted when it is fast.
##
wait_for() {
  local url="$1" label="$2" tries="${3:-60}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -m 2 "$url" >/dev/null 2>&1; then
      say "$label: ready"
      return 0
    fi
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------- stop
stop_port "$GATEWAY_PORT" "app-server"
stop_port "$UI_PORT" "ui"
# The backend spawns a worker on shutdown; give it a moment before the ports are
# reported free so a restart does not race a dying process.
sleep 1

if [ "$STOP_ONLY" = "1" ]; then
  say "stopped"
  exit 0
fi

# ---------------------------------------------------------------- build
if [ "$BUILD" = "1" ]; then
  say "building the UI"
  if ! (cd web/ui && npx vite build >"$LOG_DIR/ui-build.log" 2>&1); then
    fail "the UI build failed; see $LOG_DIR/ui-build.log"
    tail -20 "$LOG_DIR/ui-build.log" >&2 || true
    exit 1
  fi
  say "UI built"
fi

# ---------------------------------------------------------------- start
say "starting the app-server (log: $APP_LOG)"
REAPER_SESSION_ID="${REAPER_SESSION_ID:-live}" \
  setsid nohup npx tsx scripts/run-web.ts >"$APP_LOG" 2>&1 </dev/null &
sleep 1

if ! wait_for "http://127.0.0.1:$GATEWAY_PORT/healthz" "app-server gateway" 90; then
  fail "the gateway never answered on :$GATEWAY_PORT; last lines of $APP_LOG:"
  tail -20 "$APP_LOG" >&2 || true
  exit 1
fi

say "starting the UI (log: $UI_LOG)"
setsid nohup npx vite --config web/ui/vite.config.ts >"$UI_LOG" 2>&1 </dev/null &
sleep 1

if ! wait_for "http://127.0.0.1:$UI_PORT/" "ui" 90; then
  fail "the UI never answered on :$UI_PORT; last lines of $UI_LOG:"
  tail -20 "$UI_LOG" >&2 || true
  exit 1
fi

# ---------------------------------------------------------------- report
echo
say "live:"
printf '  UI        http://127.0.0.1:%s/\n' "$UI_PORT"
printf '  gateway   http://127.0.0.1:%s/\n' "$GATEWAY_PORT"
printf '  logs      %s\n' "$LOG_DIR"
echo
say "the app-server serves the code on disk as of this run; if a fix still looks"
say "absent, check that the change is saved and re-run this script."
