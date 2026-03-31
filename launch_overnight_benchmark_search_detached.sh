#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/salvia420/WorldBuilder-ACME-Edition"
cd "$ROOT"

RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUTDIR="$ROOT/pipeline_data/search_runs/overnight_benchmark_search_${RUN_TS}"
mkdir -p "$OUTDIR"
chown -R salvia420:salvia420 "$OUTDIR"

PID_FILE="$OUTDIR/runner.pid"
LOG_FILE="$OUTDIR/runner.log"
CMD_FILE="$OUTDIR/launch_command.txt"

cat > "$CMD_FILE" <<EOF
sudo /bin/bash -lc '
set -euo pipefail
mkdir -p /dev
[ -e /dev/nvidiactl ] || mknod -m 666 /dev/nvidiactl c 195 255
[ -e /dev/nvidia0 ] || mknod -m 666 /dev/nvidia0 c 195 0
[ -e /dev/nvidia-modeset ] || mknod -m 666 /dev/nvidia-modeset c 195 254
[ -e /dev/nvidia-uvm ] || mknod -m 666 /dev/nvidia-uvm c 235 0
[ -e /dev/nvidia-uvm-tools ] || mknod -m 666 /dev/nvidia-uvm-tools c 235 1
chown -R salvia420:salvia420 $OUTDIR
sudo -u salvia420 /bin/bash -lc "
cd /home/salvia420/WorldBuilder-ACME-Edition
nohup /home/salvia420/WorldBuilder-ACME-Edition/.venv/bin/python \
  /home/salvia420/WorldBuilder-ACME-Edition/scripts/PopulationPipeline/FrequencyModel/run_overnight_benchmark_search.py \
  --hours 8 \
  --model /home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/models/scene_placer_final.pt \
  --outdir $OUTDIR \
  > $LOG_FILE 2>&1 < /dev/null &
echo \\\$! > $PID_FILE
sleep 3
kill -0 \\\$(cat $PID_FILE)
"
'
EOF

eval "$(cat "$CMD_FILE")"

echo "Detached overnight launch started."
echo "Output dir: $OUTDIR"
echo "PID file:   $PID_FILE"
echo "Log file:   $LOG_FILE"
echo "Command:    $CMD_FILE"
