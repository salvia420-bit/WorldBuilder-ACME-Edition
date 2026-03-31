#!/usr/bin/env bash
set -euo pipefail

cd ~/WorldBuilder-ACME-Edition

RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUTDIR="$PWD/pipeline_data/search_runs/overnight_benchmark_search_${RUN_TS}"
LOG="$OUTDIR/runner.log"
mkdir -p "$OUTDIR"

exec "$PWD/.venv/bin/python" \
  "$PWD/scripts/PopulationPipeline/FrequencyModel/run_overnight_benchmark_search.py" \
  --hours 8 \
  --model "$PWD/pipeline_data/models/scene_placer_final.pt" \
  --outdir "$OUTDIR" \
  "$@" | tee "$LOG"
