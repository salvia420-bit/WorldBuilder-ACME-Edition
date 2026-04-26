#!/usr/bin/env bash
set -euo pipefail

cd ~/WorldBuilder-ACME-Edition
source .venv/bin/activate

RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
ROOT="$PWD"
OUTDIR="$ROOT/overnight_$RUN_TS"
mkdir -p "$OUTDIR"

TRAIN_LOG="$OUTDIR/training.log"
GEN_LOG="$OUTDIR/generate_small_region.log"
SUMMARY_LOG="$OUTDIR/summary.log"
TARBALL="$ROOT/artifacts_${RUN_TS}.tar.gz"

BEST_PT="$ROOT/pipeline_data/models/scene_placer_best.pt"
FINAL_PT="$ROOT/pipeline_data/models/scene_placer_final.pt"
RESUME_PT="$ROOT/pipeline_data/models/resume.pt"
HISTORY_JSON="$ROOT/pipeline_data/models/logs/training_history.json"

MAX_TRAIN_SECONDS=$((6*3600 + 30*60))
POLL_SECONDS=120

BEST_MTIME_BEFORE=0
if [ -f "$BEST_PT" ]; then
  BEST_MTIME_BEFORE=$(stat -c %Y "$BEST_PT")
fi

echo "[start] $(date -Is)" | tee -a "$SUMMARY_LOG"
git rev-parse HEAD > "$OUTDIR/git_head.txt" || true
git status --short > "$OUTDIR/git_status.txt" || true

shutdown_vm() {
  echo "[shutdown] $(date -Is)" | tee -a "$SUMMARY_LOG"
  sudo shutdown -h now || true
}

package_artifacts() {
  echo "[package] writing tarball $TARBALL" | tee -a "$SUMMARY_LOG"
  tar -czf "$TARBALL" \
    "$OUTDIR" \
    "$ROOT/docs/PopulationPipelineProgress.md" \
    "$ROOT/docs/PopulationPipelineStrategy.md" \
    "$ROOT/march25.md" \
    "$BEST_PT" \
    "$FINAL_PT" \
    "$RESUME_PT" \
    "$HISTORY_JSON" \
    "$ROOT/pipeline_data/population_output/vanquish_ml_populated.sql" \
    2>/dev/null || true
  ls -lh "$TARBALL" | tee -a "$SUMMARY_LOG" || true
}

finalize() {
  package_artifacts
  shutdown_vm
}
trap finalize EXIT

echo "[train] launching resume run" | tee -a "$SUMMARY_LOG"
python -u scripts/PopulationPipeline/OutdoorML/train_scene_placer.py \
  --resume pipeline_data/models/resume.pt > "$TRAIN_LOG" 2>&1 &
TRAIN_PID=$!

START_TS=$(date +%s)
BAD_COUNT=0

while kill -0 "$TRAIN_PID" 2>/dev/null; do
  sleep "$POLL_SECONDS"

  NOW_TS=$(date +%s)
  ELAPSED=$((NOW_TS - START_TS))

  if grep -qi "nan" "$TRAIN_LOG"; then
    echo "[train] NaN detected, stopping training" | tee -a "$SUMMARY_LOG"
    kill -INT "$TRAIN_PID" || true
    wait "$TRAIN_PID" || true
    break
  fi

  LAST_VAL_LINE="$(grep ' val=' "$TRAIN_LOG" | tail -n 1 || true)"
  if [ -n "$LAST_VAL_LINE" ]; then
    LAST_VAL="$(echo "$LAST_VAL_LINE" | sed -n 's/.* val=\([0-9.]*\) .*/\1/p')"
    LAST_ENT="$(echo "$LAST_VAL_LINE" | sed -n 's/.* ent=\([0-9.]*\) .*/\1/p')"
    echo "[monitor] elapsed=${ELAPSED}s val=${LAST_VAL:-na} ent=${LAST_ENT:-na}" | tee -a "$SUMMARY_LOG"

    python - "$LAST_VAL" "$LAST_ENT" <<'PY'
import sys
val = float(sys.argv[1]) if sys.argv[1] else 999.0
ent = float(sys.argv[2]) if sys.argv[2] else 0.0
# Catastrophic only: still awful after the fix
bad = (val > 8.0) or (ent < 1.8)
raise SystemExit(0 if bad else 1)
PY
    if [ $? -eq 0 ]; then
      BAD_COUNT=$((BAD_COUNT + 1))
    else
      BAD_COUNT=0
    fi

    if [ "$BAD_COUNT" -ge 3 ]; then
      echo "[train] catastrophic trend detected 3 polls in a row, stopping" | tee -a "$SUMMARY_LOG"
      kill -INT "$TRAIN_PID" || true
      wait "$TRAIN_PID" || true
      break
    fi
  fi

  if [ "$ELAPSED" -ge "$MAX_TRAIN_SECONDS" ]; then
    echo "[train] max runtime reached, stopping cleanly" | tee -a "$SUMMARY_LOG"
    kill -INT "$TRAIN_PID" || true
    wait "$TRAIN_PID" || true
    break
  fi
done

BEST_MTIME_AFTER=0
if [ -f "$BEST_PT" ]; then
  BEST_MTIME_AFTER=$(stat -c %Y "$BEST_PT")
fi

RUN_GEN=true
if grep -qi "nan" "$TRAIN_LOG"; then
  RUN_GEN=false
fi

LAST_VAL_LINE="$(grep ' val=' "$TRAIN_LOG" | tail -n 1 || true)"
if [ -n "$LAST_VAL_LINE" ]; then
  LAST_VAL="$(echo "$LAST_VAL_LINE" | sed -n 's/.* val=\([0-9.]*\) .*/\1/p')"
  LAST_ENT="$(echo "$LAST_VAL_LINE" | sed -n 's/.* ent=\([0-9.]*\) .*/\1/p')"
  python - "$LAST_VAL" "$LAST_ENT" <<'PY'
import sys
val = float(sys.argv[1]) if sys.argv[1] else 999.0
ent = float(sys.argv[2]) if sys.argv[2] else 0.0
usable = (val <= 4.5) and (ent >= 2.0)
raise SystemExit(0 if usable else 1)
PY
  if [ $? -ne 0 ]; then
    RUN_GEN=false
  fi
fi

if [ "$RUN_GEN" = true ]; then
  if [ "$BEST_MTIME_AFTER" -gt "$BEST_MTIME_BEFORE" ]; then
    echo "[gen] new best checkpoint detected" | tee -a "$SUMMARY_LOG"
  else
    echo "[gen] no new best checkpoint, but metrics were usable enough to probe generation" | tee -a "$SUMMARY_LOG"
  fi

  python -u scripts/PopulationPipeline/OutdoorML/generate_populated_world.py \
    --model scene_placer_best.pt \
    --lb-x-min 30 --lb-x-max 34 \
    --lb-y-min 120 --lb-y-max 124 \
    --progress-every 5 \
    > "$GEN_LOG" 2>&1 || true
else
  echo "[gen] skipped because training looked broken or non-usable" | tee -a "$SUMMARY_LOG"
fi

echo "[done] $(date -Is)" | tee -a "$SUMMARY_LOG"
