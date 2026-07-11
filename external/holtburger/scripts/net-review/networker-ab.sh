#!/usr/bin/env bash
# networker-ab.sh — laptop zero-GPU A/B: N boots × {netWorker=0, netWorker=1}.
# Prereq: scripts/serve.py running on :8765; local ACE at 127.0.0.1:9000.
# Usage: ./networker-ab.sh [N] [OUT_DIR]
set -uo pipefail
N="${1:-3}"
OUT_DIR="${2:-/tmp/networker-ab-$(date -u +%Y%m%dT%H%M%SZ)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MJS="${HERE}/networker-ab.mjs"
mkdir -p "$OUT_DIR"
echo "[ab] N=$N per arm  out=$OUT_DIR"

for i in $(seq 1 "$N"); do
  for ARM in 0 1; do            # alternate arms so drift affects both equally
    RID="n${i}a${ARM}"
    echo "[ab] run $RID (netWorker=$ARM) ..."
    node "$MJS" --net-worker "$ARM" --run-id "$RID" \
      --out "$OUT_DIR/$RID.json" > "$OUT_DIR/$RID.log" 2>&1
    echo "[ab]   $(grep 'NETWORKER-AB SUMMARY' "$OUT_DIR/$RID.log" || echo 'NO SUMMARY (crashed?)')"
    sleep 65                     # wait out ACE's 60s network-timeout session reap (abrupt close never tells ACE goodbye; live-measured s13)
  done
done

node -e '
const fs = require("fs"), dir = process.argv[1];
const runs = fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => {
  try { return JSON.parse(fs.readFileSync(dir + "/" + f, "utf8")); } catch { return null; }
}).filter(Boolean);
const agg = (arm) => {
  const rs = runs.filter(r => r.netWorker === !!arm && r.ok);
  const med = (xs) => { const s = xs.filter(x => x != null).sort((a,b)=>a-b); return s.length ? s[(s.length/2)|0] : null; };
  return {
    arm, runs: rs.length,
    armedOk: rs.filter(r => !arm || r.workerArmed).length,
    medSpeedMps: med(rs.map(r => r.movement.medianSpeedMps)),
    totalSnaps: rs.reduce((a,r) => a + r.movement.snapCount, 0),
    survivedFreeze: rs.filter(r => r.freeze.survived).length,
    medPoseResumeMs: med(rs.map(r => r.freeze.poseResumedMs)),
    medPostFreezeBurst: med(rs.map(r => r.wire.postFreezeBurst)),
    timeoutErrs: rs.reduce((a,r) => a + r.freeze.timeoutErrorCount, 0),
  };
};
const a0 = agg(0), a1 = agg(1);
console.log("\n===== NETWORKER A/B AGGREGATE ====="); 
console.log(JSON.stringify({ off: a0, on: a1 }, null, 2));
console.log(`AB VERDICT: speed off=${a0.medSpeedMps} on=${a1.medSpeedMps} | ` +
  `snaps off=${a0.totalSnaps} on=${a1.totalSnaps} | ` +
  `freeze-survival off=${a0.survivedFreeze}/${a0.runs} on=${a1.survivedFreeze}/${a1.runs}`);
' "$OUT_DIR"
