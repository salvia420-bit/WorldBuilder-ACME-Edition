#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [ -f .venv/bin/activate ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for detached OutdoorML runs."
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$ROOT/pipeline_data/population_output/detached_runs/$STAMP"
mkdir -p "$RUN_DIR"
SESSION="outdoorml_${STAMP}"

BASE_RESUME="${1:-pipeline_data/models/resume_baseline_2026-03-26_epoch750.pt}"
TARGET_EPOCHS="${2:-775}"
PROBE_MODEL="${3:-scene_placer_final.pt}"

CMD=(
  "$ROOT/run_outdoorml_service_prior_cycle.sh"
  "$BASE_RESUME"
  "$TARGET_EPOCHS"
  "$PROBE_MODEL"
)

printf '%q ' "${CMD[@]}" > "$RUN_DIR/command.txt"
printf '\n' >> "$RUN_DIR/command.txt"

TMUX_CMD="/bin/bash -lc \"cd '$ROOT' && exec '${CMD[0]}' '${CMD[1]}' '${CMD[2]}' '${CMD[3]}' > '$RUN_DIR/stdout.log' 2>&1\""
printf '%s\n' "$TMUX_CMD" > "$RUN_DIR/tmux_command.txt"
printf '%s\n' "$SESSION" > "$RUN_DIR/session.txt"

tmux new-session -d -s "$SESSION" "$TMUX_CMD"
PANE_PID="$(tmux display-message -p -t "$SESSION" '#{pane_pid}')"
printf '%s\n' "$PANE_PID" > "$RUN_DIR/pid.txt"

tmux display-message -p -t "$SESSION" '#{session_name}:#{window_index}.#{pane_index}' > "$RUN_DIR/pane.txt"

echo "Detached OutdoorML run started."
echo "  Session: $SESSION"
echo "  PID:     $PANE_PID"
echo "  Run dir: $RUN_DIR"
echo "  Log:     $RUN_DIR/stdout.log"
