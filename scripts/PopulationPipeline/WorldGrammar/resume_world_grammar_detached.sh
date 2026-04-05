#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
RUNS_DIR="$ROOT/pipeline_data/population_output/detached_runs"
MODEL_DIR="$ROOT/pipeline_data/models"
REF_DIR="$ROOT/pipeline_data/reference"

WORLD_TENSOR="$REF_DIR/world_grammar_component_linked_abstract_ace_tensors.npz"
WORLD_VOCAB="$REF_DIR/world_grammar_component_linked_abstract_ace_vocab.json"
LEGACY_TENSOR="$REF_DIR/component_linked_abstract_ace_tensors.npz"
LEGACY_VOCAB="$REF_DIR/component_linked_abstract_ace_vocab.json"

DEFAULT_RESUME="$MODEL_DIR/scene_placer_component_linked_abstract_ace_20260403T2151Z_resume.pt"
DEFAULT_EPOCHS=250

RESUME_PATH="$DEFAULT_RESUME"
EPOCHS="$DEFAULT_EPOCHS"
RUN_NAME=""
RUN_SUFFIX=""
SESSION_NAME=""

usage() {
  cat <<EOF
Usage:
  $(basename "$0") [options]

Options:
  --resume PATH     Checkpoint to resume from.
  --epochs N        Total epoch target. Default: $DEFAULT_EPOCHS
  --run-name NAME   Explicit run name.
  --suffix TEXT     Optional suffix appended to generated names.
  --session NAME    Explicit tmux session name.
  -h, --help        Show help.

Example:
  $(basename "$0") --epochs 325 --suffix e325
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

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required but not installed." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required but not installed." >&2
  exit 1
fi

TENSOR_PATH="$WORLD_TENSOR"
VOCAB_PATH="$WORLD_VOCAB"
if [[ ! -f "$TENSOR_PATH" ]]; then
  TENSOR_PATH="$LEGACY_TENSOR"
fi
if [[ ! -f "$VOCAB_PATH" ]]; then
  VOCAB_PATH="$LEGACY_VOCAB"
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
TAG="resume"
if [[ -n "$RUN_SUFFIX" ]]; then
  TAG="${TAG}_${RUN_SUFFIX}"
fi
if [[ -z "$RUN_NAME" ]]; then
  RUN_NAME="world_grammar_component_linked_abstract_ace_${TS}_${TAG}"
fi
if [[ -z "$SESSION_NAME" ]]; then
  SESSION_NAME="world_grammar_${TAG}_${TS}"
fi

RUN_DIR="$RUNS_DIR/${TS}-train-world-grammar-${TAG}"
LOG_PATH="$RUN_DIR/stdout.log"
mkdir -p "$RUN_DIR"

printf '%s\n' \
  "python3 -u scripts/PopulationPipeline/WorldGrammar/train_world_grammar.py --resume $RESUME_PATH --tensor-path $TENSOR_PATH --vocab-path $VOCAB_PATH --run-name $RUN_NAME --epochs $EPOCHS --checkpoint-every 25 --resume-checkpoint-every 10" \
  > "$RUN_DIR/command.txt"
printf '%s\n' "$SESSION_NAME" > "$RUN_DIR/session.txt"
printf '%s\n' "$LOG_PATH" > "$RUN_DIR/log_path.txt"

TMUX_CMD="cd $(printf '%q' "$ROOT") && exec -a world-grammar-train python3 -u scripts/PopulationPipeline/WorldGrammar/train_world_grammar.py --resume $(printf '%q' "$RESUME_PATH") --tensor-path $(printf '%q' "$TENSOR_PATH") --vocab-path $(printf '%q' "$VOCAB_PATH") --run-name $(printf '%q' "$RUN_NAME") --epochs $(printf '%q' "$EPOCHS") --checkpoint-every 25 --resume-checkpoint-every 10 > $(printf '%q' "$LOG_PATH") 2>&1"

tmux new-session -d -s "$SESSION_NAME" "$TMUX_CMD"
sleep 1
tmux list-panes -t "$SESSION_NAME" -F '#{pane_pid}' > "$RUN_DIR/pid.txt"

echo "Launched detached world-grammar training run."
echo "  session: $SESSION_NAME"
echo "  run_name: $RUN_NAME"
echo "  log: $LOG_PATH"
echo "  metadata: $RUN_DIR"
