#!/usr/bin/env bash
set -euo pipefail
cd ~/WorldBuilder-ACME-Edition

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTDIR="artifacts_$STAMP"
mkdir -p "$OUTDIR"

cp generate.log "$OUTDIR/" 2>/dev/null || true
cp training.log "$OUTDIR/" 2>/dev/null || true
cp pipeline_data/models/scene_placer_best.pt "$OUTDIR/" 2>/dev/null || true
cp pipeline_data/models/scene_placer_final.pt "$OUTDIR/" 2>/dev/null || true
cp pipeline_data/models/resume.pt "$OUTDIR/" 2>/dev/null || true
cp pipeline_data/models/logs/training_history.json "$OUTDIR/" 2>/dev/null || true
cp docs/PopulationPipelineProgress.md "$OUTDIR/" 2>/dev/null || true
cp docs/PopulationPipelineStrategy.md "$OUTDIR/" 2>/dev/null || true
cp pipeline_data/population_output/vanquish_ml_populated.sql "$OUTDIR/" 2>/dev/null || true

python - <<'PY' > "$OUTDIR/RUN_SUMMARY.txt"
import json, os
print("Run summary")
print("=" * 40)

p='pipeline_data/models/logs/training_history.json'
if os.path.exists(p):
    with open(p) as f:
        h=json.load(f)
    vals=[r for r in h if 'val_total' in r]
    print("history_rows:", len(h))
    if vals:
        last=vals[-1]
        print("last_val_epoch:", last.get('epoch'))
        print("last_val_total:", last.get('val_total'))
        print("last_entropy:", last.get('wcid_entropy'))
        print("last_gap:", last.get('overfit_gap'))

for path in [
    'pipeline_data/models/scene_placer_best.pt',
    'pipeline_data/models/scene_placer_final.pt',
    'pipeline_data/models/resume.pt',
    'pipeline_data/population_output/vanquish_ml_populated.sql',
    'generate.log',
    'training.log',
]:
    if os.path.exists(path):
        print(path, os.path.getsize(path))
PY

tar -czf "${OUTDIR}.tar.gz" "$OUTDIR"
echo "Created ${OUTDIR}.tar.gz"
sudo shutdown -h now
