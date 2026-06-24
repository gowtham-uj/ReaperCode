#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/setup-pi-reaper.sh [--install] [--install-subagents]

Checks the Pi/Reaper cockpit setup for this repository.

Options:
  --install             Install Pi globally with npm if pi is not found.
  --install-subagents   Install the Pi subagents package after confirming pi is available.

This script is intentionally conservative:
  - it does not overwrite existing files
  - it creates required directories if missing
  - it prints manual commands when installation is not requested
EOF
}

install_pi=false
install_subagents=false

for arg in "$@"; do
  case "$arg" in
    --install)
      install_pi=true
      ;;
    --install-subagents)
      install_subagents=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "Repository: $repo_root"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required but was not found." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is required but was not found." >&2
  exit 1
fi

echo "node: $(node --version)"
echo "npm: $(npm --version)"

if command -v pi >/dev/null 2>&1; then
  echo "pi: $(pi --version 2>/dev/null || echo installed)"
else
  echo "pi is not installed."
  if [ "$install_pi" = true ]; then
    npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  else
    echo "Install manually with:"
    echo "  npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
  fi
fi

mkdir -p .pi/agents .pi/skills .pi/extensions docs scripts

required_files=(
  "AGENTS.md"
  ".pi/agents/reaper-scout.md"
  ".pi/agents/reaper-architect.md"
  ".pi/agents/reaper-implementer.md"
  ".pi/agents/reaper-tester.md"
  ".pi/agents/reaper-reviewer.md"
  ".pi/agents/reaper-security.md"
  ".pi/subagents.json"
  ".pi/skills/reaper-dev-loop/SKILL.md"
  "docs/pi-reaper-workflow.md"
  "scripts/pi-workspace-dispatch.sh"
)

missing=()
for file in "${required_files[@]}"; do
  if [ ! -f "$file" ]; then
    missing+=("$file")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing expected cockpit files:"
  printf '  %s\n' "${missing[@]}"
  echo "This script will not synthesize or overwrite them; restore them from the repository setup."
else
  echo "Cockpit files are present."
fi

if [ "$install_subagents" = true ]; then
  if ! command -v pi >/dev/null 2>&1; then
    echo "ERROR: pi is required before installing subagents." >&2
    exit 1
  fi
  pi install npm:@tintinweb/pi-subagents
else
  echo "Install subagents manually with:"
  echo "  pi install npm:@tintinweb/pi-subagents"
fi

cat <<'EOF'

Next steps:
  cd path/to/reaper
  pi

Inside Pi:
  /skill:reaper-dev-loop Inspect the repo and create a development map. Do not edit files.
EOF
