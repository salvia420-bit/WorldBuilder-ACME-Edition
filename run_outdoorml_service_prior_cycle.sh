#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [ -f .venv/bin/activate ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MODELS_DIR="$ROOT/pipeline_data/models"
OUT_DIR="$ROOT/pipeline_data/population_output"
PROBE_DIR="$OUT_DIR/probes"
REGION_STEM="serviceprior_region_${STAMP}"
REGION_SQL="$OUT_DIR/${REGION_STEM}.sql"
REGION_SUMMARY="$OUT_DIR/${REGION_STEM}_summary.json"
REGION_SCORE="$OUT_DIR/${REGION_STEM}_score.txt"

BASE_RESUME="${1:-pipeline_data/models/resume_baseline_2026-03-26_epoch750.pt}"
TARGET_EPOCHS="${2:-775}"
PROBE_MODEL="${3:-scene_placer_final.pt}"
PLANNER_EPOCHS="${4:-40}"

echo "========================================================================"
echo "  OutdoorML Service-Prior Bounded Cycle"
echo "========================================================================"
echo "  Base resume:   $BASE_RESUME"
echo "  Target epochs: $TARGET_EPOCHS"
echo "  Probe model:   $PROBE_MODEL"
echo "  Planner epochs:$PLANNER_EPOCHS"
echo "  Region SQL:    $REGION_SQL"
echo "========================================================================"

echo
echo "[1/7] Rebuild placement tensors with service priors..."
python3 -u scripts/PopulationPipeline/OutdoorML/extract_placement_tensors.py

echo
echo "[2/7] Rebuild planner tensors..."
python3 -u scripts/PopulationPipeline/OutdoorML/extract_settlement_planner_tensors.py

echo
echo "[3/7] Retrain settlement planner..."
python3 -u scripts/PopulationPipeline/OutdoorML/train_settlement_planner.py \
  --epochs "$PLANNER_EPOCHS"

echo
echo "[4/7] Run bounded retrain..."
python3 -u scripts/PopulationPipeline/OutdoorML/train_scene_placer.py \
  --resume "$BASE_RESUME" \
  --epochs "$TARGET_EPOCHS"

echo
echo "[5/7] Run fixed 5x5 probe..."
python3 -u scripts/PopulationPipeline/OutdoorML/run_small_region_probe.py \
  --model "$PROBE_MODEL" \
  --temperature 1.0 \
  --top-k 0 \
  --nucleus-p 1.0 \
  --min-objects 5 \
  --adaptive-min-objects-bonus 2 \
  --pad-logit-bias 1.0 \
  --stop-logit-bias 0.5

echo
echo "[6/7] Run representative scored region..."
python3 -u scripts/PopulationPipeline/OutdoorML/generate_populated_world.py \
  --model "$PROBE_MODEL" \
  --lb-x-min 30 \
  --lb-x-max 49 \
  --lb-y-min 120 \
  --lb-y-max 139 \
  --progress-every 25 \
  --debug-landblocks 25 \
  --temperature 1.0 \
  --top-k 0 \
  --nucleus-p 1.0 \
  --min-objects 5 \
  --adaptive-min-objects-bonus 2 \
  --pad-logit-bias 1.0 \
  --stop-logit-bias 0.5 \
  --output-sql "$REGION_SQL" \
  --summary-json "$REGION_SUMMARY" \
  --require-cuda

echo
echo "[7/7] Score representative region..."
python3 -u scripts/PopulationPipeline/OutdoorML/score_placement_quality.py "$REGION_SQL" > "$REGION_SCORE"

echo
echo "Cycle complete."
echo "  Probe outputs:  $PROBE_DIR"
echo "  Region SQL:     $REGION_SQL"
echo "  Region summary: $REGION_SUMMARY"
echo "  Region score:   $REGION_SCORE"
