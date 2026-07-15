#!/bin/bash
# walkin-ab2 — the v1 script produced a PERFECT CONFOUND and I nearly read it as
# "the flag breaks the world":
#   off-1 SUCCESS -> +60s -> on-1  FAIL (pose:null, nothing streamed)
#   on-1  FAIL    -> +60s -> off-2 SUCCESS
#   off-2 SUCCESS -> +60s -> on-2  FAIL
# A SUCCESSFUL arm holds tailnet1 in-world ~90s, so 60s is not enough for the
# NEXT login; a FAILED arm never entered the world, so it never held the account
# and the arm after it always succeeds. With strict off/on alternation, every ON
# arm inherited the post-success slot => 2/2 ON failures that look exactly like a
# broken flag. (HANDOFF §6.8 says 45-60s; that is only true after a FAILED run.)
#
# Fixes: (1) 150s gap after every arm; (2) BALANCED ORDER — the arm that follows
# a success alternates per rep, so a residual gap effect cannot land on one arm;
# (3) one retry per arm, because a lost login should cost a retry, not the datum.
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/scripts/net-review
GAP=150
run_arm() {
  local arm=$1 rep=$2 q="" out log
  [ "$arm" = on ] && q="walkInInstance=on"
  out=/mnt/wbterminal2/tmp/w2-$arm-$rep.json
  log=/mnt/wbterminal2/tmp/w2-$arm-$rep.log
  for try in 1 2; do
    EXTRA_Q="$q" POI=Holtburg OUT=$out timeout 900 node multidraw-truth-probe.mjs > "$log" 2>&1
    local rc=$?
    if [ $rc -eq 0 ]; then
      echo "=== $arm rep$rep (try$try) OK ==="
      grep -E "info.render.calls|TRUE draw|renderCPU" "$log"
      sleep $GAP; return 0
    fi
    echo "=== $arm rep$rep (try$try) FAILED rc=$rc — retrying after ${GAP}s ==="
    sleep $GAP
  done
  echo "=== $arm rep$rep GAVE UP ==="
}
# rep1: on first (ON gets the fresh-idle slot); rep2: off first. Balanced.
run_arm on 1;  run_arm off 1
run_arm off 2; run_arm on 2
echo ALLDONE2
