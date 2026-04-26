#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
RUNS_DIR="$ROOT/pipeline_data/population_output/detached_runs"
MODEL_DIR="$ROOT/pipeline_data/models"
REF_DIR="$ROOT/pipeline_data/reference"

DEFAULT_RESUME="$MODEL_DIR/scene_placer_component_linked_abstract_ace_20260403T2151Z_resume.pt"
DEFAULT_TENSOR="$REF_DIR/component_linked_abstract_ace_tensors.npz"
DEFAULT_VOCAB="$REF_DIR/component_linked_abstract_ace_vocab.json"
DEFAULT_EPOCHS=250
DEFAULT_RUN_PREFIX="scene_placer_component_linked_abstract_ace"

RESUME_PATH="$DEFAULT_RESUME"
EPOCHS="$DEFAULT_EPOCHS"
RUN_SUFFIX=""
RUN_NAME=""
SESSION_NAME=""

usage() {
  cat <<EOF
Usage:
  $(basename "$0") [options]

Options:
  --resume PATH        Checkpoint to resume from.
  --epochs N           Total epoch target for the resumed run. Default: $DEFAULT_EPOCHS
  --run-name NAME      Explicit run name. Default: ${DEFAULT_RUN_PREFIX}_<timestamp>_resume
  --suffix TEXT        Optional suffix appended to the generated run name.
  --session NAME       Explicit tmux session name.
  -h, --help           Show this help.

Example:
  $(basename "$0") --epochs 300 --suffix resume300
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resume)
      RESUME_PATH="$2"
      shift 2
      ;;
    --epochs)
      EPOCHS="$2"
      shift 2
      ;;
    --run-name)
      RUN_NAME="$2"
      shift 2
      ;;
    --suffix)
      RUN_SUFFIX="$2"
      shift 2
      ;;
    --session)
      SESSION_NAME="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$RESUME_PATH" ]]; then
  echo "Resume checkpoint not found: $RESUME_PATH" >&2
  exit 1
fi

if [[ ! -f "$DEFAULT_TENSOR" ]]; then
  echo "Tensor file not found: $DEFAULT_TENSOR" >&2
  exit 1
fi

if [[ ! -f "$DEFAULT_VOCAB" ]]; then
  echo "Vocab file not found: $DEFAULT_VOCAB" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required but not installed." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required but not installed." >&2
  exit 1
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_TAG="resume"
if [[ -n "$RUN_SUFFIX" ]]; then
  RUN_TAG="${RUN_TAG}_${RUN_SUFFIX}"
fi
if [[ -z "$RUN_NAME" ]]; then
  RUN_NAME="${DEFAULT_RUN_PREFIX}_${TS}_${RUN_TAG}"
fi
if [[ -z "$SESSION_NAME" ]]; then
  SESSION_NAME="abstract_ace_${RUN_TAG}_${TS}"
fi

RUN_DIR="$RUNS_DIR/${TS}-train-abstract-ace-${RUN_TAG}"
LOG_PATH="$RUN_DIR/stdout.log"
COMMAND_PATH="$RUN_DIR/command.txt"
SESSION_PATH="$RUN_DIR/session.txt"
LOG_REF_PATH="$RUN_DIR/log_path.txt"
PID_PATH="$RUN_DIR/pid.txt"

mkdir -p "$RUN_DIR"

COMMAND=(
  python3 -u scripts/PopulationPipeline/OutdoorML/train_scene_placer.py
  --resume "$RESUME_PATH"
  --tensor-path "$DEFAULT_TENSOR"
  --vocab-path "$DEFAULT_VOCAB"
  --run-name "$RUN_NAME"
  --epochs "$EPOCHS"
  --checkpoint-every 25
  --resume-checkpoint-every 10
)

printf '%q ' "${COMMAND[@]}" | sed 's/ $/\n/' > "$COMMAND_PATH"
printf '%s\n' "$SESSION_NAME" > "$SESSION_PATH"
printf '%s\n' "$LOG_PATH" > "$LOG_REF_PATH"

TMUX_CMD="cd $(printf '%q' "$ROOT") && exec -a abstract-ace-resume python3 -u scripts/PopulationPipeline/OutdoorML/train_scene_placer.py --resume $(printf '%q' "$RESUME_PATH") --tensor-path $(printf '%q' "$DEFAULT_TENSOR") --vocab-path $(printf '%q' "$DEFAULT_VOCAB") --run-name $(printf '%q' "$RUN_NAME") --epochs $(printf '%q' "$EPOCHS") --checkpoint-every 25 --resume-checkpoint-every 10 > $(printf '%q' "$LOG_PATH") 2>&1"

tmux new-session -d -s "$SESSION_NAME" "$TMUX_CMD"
sleep 1
tmux list-panes -t "$SESSION_NAME" -F '#{pane_pid}' > "$PID_PATH"

echo "Launched detached abstract_ace resume run."
echo "  session: $SESSION_NAME"
echo "  run_name: $RUN_NAME"
echo "  log: $LOG_PATH"
echo "  metadata: $RUN_DIR"
echo "  monitor: tail -f $LOG_PATH"
echo "  attach: tmux attach -t $SESSION_NAME"
