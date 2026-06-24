#!/usr/bin/env bash
set -euo pipefail

workspace_root="${REAPER_PI_WORKSPACE_ROOT:-/workspace}"
real_pi="${PI_REAL_BIN:-/usr/local/bin/pi}"

current_dir="$(pwd -P)"
workspace_dir="$(cd "$workspace_root" && pwd -P)"

case "$current_dir/" in
  "$workspace_dir/"*)
    case "${1:-}" in
      install|remove|uninstall|update|list|config)
        exec "$real_pi" "$@"
        ;;
    esac
    exec "$workspace_dir/scripts/pi-reaper-cockpit.sh" "$@"
    ;;
  *)
    exec "$real_pi" "$@"
    ;;
esac
