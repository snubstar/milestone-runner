#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

DRY_RUN_ARGS=()
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN_ARGS=(--dry-run)
fi

PROMPT=$(cat <<'PROMPT'
TODO: Replace this placeholder with the actual task prompt.

Objective:
- Describe the concrete outcome.

Scope:
- List boundaries and files/modules to focus on.

Verification:
- List expected checks or manual inspection notes.
PROMPT
)

if [[ "$PROMPT" == TODO:* ]]; then
  echo "Replace the placeholder prompt in this task launcher before running it." >&2
  exit 2
fi

npm run build

node dist/cli/main.js \
  "${DRY_RUN_ARGS[@]}" \
  --runner codex-exec \
  --milestone 1 \
  --milestone-plan-review-policy scrupulous \
  -- "$PROMPT"
