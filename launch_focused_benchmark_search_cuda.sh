#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/salvia420/WorldBuilder-ACME-Edition"
OUTDIR="${1:?usage: launch_focused_benchmark_search_cuda.sh OUTDIR [HOURS]}"
HOURS="${2:-2}"

mkdir -p /dev
[ -e /dev/nvidiactl ] || mknod -m 666 /dev/nvidiactl c 195 255
[ -e /dev/nvidia0 ] || mknod -m 666 /dev/nvidia0 c 195 0
[ -e /dev/nvidia-modeset ] || mknod -m 666 /dev/nvidia-modeset c 195 254
[ -e /dev/nvidia-uvm ] || mknod -m 666 /dev/nvidia-uvm c 235 0
[ -e /dev/nvidia-uvm-tools ] || mknod -m 666 /dev/nvidia-uvm-tools c 235 1

mkdir -p "$OUTDIR"
chown -R salvia420:salvia420 "$OUTDIR"

sudo -u salvia420 /bin/bash -lc "
cd $ROOT
nohup $ROOT/.venv/bin/python \
  $ROOT/scripts/PopulationPipeline/FrequencyModel/run_overnight_benchmark_search.py \
  --hours $HOURS \
  --model $ROOT/pipeline_data/models/scene_placer_final.pt \
  --outdir $OUTDIR \
  > $OUTDIR/runner.log 2>&1 < /dev/null &
echo \$! > $OUTDIR/runner.pid
sleep 3
kill -0 \$(cat $OUTDIR/runner.pid)
"

echo "$OUTDIR"
