#!/bin/bash
# Laptop-side "is a person on the 1070?" watcher. Polls hbwho.ps1 every 15 s; prints ONE line per state
# change (AWAY / PRESENT / GPU-BUSY / WATCHER-STALE / UNREACHABLE). PRESENT = any keyboard/mouse input
# since the last poll or < 180 s ago (idlewatch heartbeat in their session), or a desktop browser window
# of theirs on two consecutive polls (they use Chrome). On PRESENT it kills ONLY our D:\Temp\hbbench test Chrome (box rule).
# Hysteresis: after PRESENT, AWAY needs 15 min without input and no browser of theirs.
# State persists in $ST so a re-armed monitor stays quiet until something changes.
# Every poll also rewrites $POLL ("<epoch> <state> <hbwho line>") — gate1070.sh reads it, and every
# driver that starts Chrome on the box must pass that gate first.
# 2026-10-12: while PRESENT/GPU-BUSY, test Chrome that (re)appears is killed on EVERY poll, not only at
# the state change; a stale heartbeat (idlewatch's 16 h cap) re-runs the hbidle task, unless
# D:\Temp\hbbench\idlewatch.stop says the heartbeat was stopped on purpose.
# Run it detached so a tool timeout can't end the protection mid-test, and tail the events:
#   setsid nohup env WATCH1070_MAX_S=43200 ./watch1070.sh >> $DIR/watch1070.events 2>&1 < /dev/null &
#   (Claude Code Monitor:  tail -n0 -F $DIR/watch1070.events)
# One watcher at a time (flock on $DIR/watch1070.lock — a second copy exits at once);
# WATCH1070_MAX_S bounds its lifetime (default: no limit, the Monitor-tool foreground use).
BOX=young@100.127.215.75
DIR=${WATCH1070_DIR:-/mnt/wbterminal1/tmp/claude-scratch/perf}
ST=$DIR/watch1070.state
LOG=$DIR/watch1070.log
POLL=$DIR/watch1070.poll
exec 9>"$DIR/watch1070.lock"
if ! flock -n 9; then echo "$(date +%H:%M:%S) watch1070 already running — this copy exits"; exit 0; fi
END=0; [ -n "$WATCH1070_MAX_S" ] && END=$(( $(date +%s) + WATCH1070_MAX_S ))
echo "$(date +%H:%M:%S) watch1070 started (pid $$${WATCH1070_MAX_S:+, max ${WATCH1070_MAX_S}s})"
last=$(cat "$ST" 2>/dev/null); fails=0; gpuhits=0; previdle=-1; brhits=0; rearmed=0
killchrome() {
  timeout 30 ssh -o ConnectTimeout=10 -o BatchMode=yes $BOX 'powershell -NoProfile -ExecutionPolicy Bypass -File D:\Temp\hbbench\hbbench-kill.ps1' >/dev/null 2>&1
}
while true; do
  if [ "$END" -gt 0 ] && [ "$(date +%s)" -ge "$END" ]; then
    echo "$(date +%H:%M:%S) watch1070 lifetime reached — exiting (gate1070.sh now refuses until a watcher runs again)"
    exit 0
  fi
  line=$(timeout 25 ssh -o ConnectTimeout=10 -o BatchMode=yes $BOX 'powershell -NoProfile -ExecutionPolicy Bypass -File D:\Temp\hbbench\hbwho.ps1' 2>/dev/null | tr -d '\r' | grep '^idle=' | tail -1)
  if [ -z "$line" ]; then
    fails=$((fails+1)); [ $fails -ge 3 ] && state=UNREACHABLE || { sleep 15; continue; }
  else
    fails=0
    eval "$(echo "$line" | tr ' ' '\n' | sed -n 's/^\([a-z0-9_]*\)=\(-\{0,1\}[0-9.]*\)$/\1=\2/p')"
    other=${gpu3d_other%.*}
    awaymin=180; [ "$last" = PRESENT ] && awaymin=900
    input=0; [ "$previdle" -ge 0 ] && [ "$idle" -ge 0 ] && [ "$idle" -lt "$previdle" ] && input=1
    # A browser-only signal must hold for two polls: while our test Chrome starts or exits, its
    # processes briefly report no command line and read as "theirs" (false PRESENT 2026-10-09
    # 07:53:19, idle 18.7 h). Real use also moves the mouse, which is caught at once.
    if [ "$browsers" -gt 0 ]; then brhits=$((brhits+1)); else brhits=0; fi
    if [ "$hbage" -lt 0 ] || [ "$hbage" -gt 40 ]; then state=WATCHER-STALE
    elif [ $input -eq 1 ] || [ "$idle" -lt "$awaymin" ] || [ $brhits -ge 2 ] || { [ "$last" = PRESENT ] && [ "$browsers" -gt 0 ]; }; then state=PRESENT
    else
      if [ "${other:-0}" -ge 35 ]; then gpuhits=$((gpuhits+1)); else gpuhits=0; fi
      [ $gpuhits -ge 2 ] && state=GPU-BUSY || state=AWAY
    fi
    previdle=$idle
  fi
  echo "$(date '+%F %T') $state $line" >> "$LOG"
  echo "$(date +%s) $state $line" > "$POLL.tmp" && mv -f "$POLL.tmp" "$POLL"
  if [ "$state" = WATCHER-STALE ] && [ $(( $(date +%s) - rearmed )) -ge 300 ]; then
    rearmed=$(date +%s)
    timeout 30 ssh -o ConnectTimeout=10 -o BatchMode=yes $BOX 'if not exist D:\Temp\hbbench\idlewatch.stop schtasks /run /tn hbidle' >/dev/null 2>&1 \
      && echo "$(date +%H:%M:%S) 1070 heartbeat stale — re-ran hbidle" || echo "$(date +%H:%M:%S) 1070 heartbeat stale — hbidle re-run FAILED"
  fi
  if [ "$state" != "$last" ]; then
    msg="$(date +%H:%M:%S) 1070 $state | $line"
    if [ "$state" = PRESENT ] || [ "$state" = GPU-BUSY ]; then
      killchrome && msg="$msg | killed our hbbench Chrome" || msg="$msg | KILL OF OUR CHROME FAILED"
    fi
    echo "$msg"
    last=$state; echo "$state" > "$ST"
  elif { [ "$state" = PRESENT ] || [ "$state" = GPU-BUSY ]; } && [ "${ourchrome:-0}" -gt 0 ]; then
    killchrome && echo "$(date +%H:%M:%S) 1070 still $state — our test Chrome reappeared, killed it again" \
      || echo "$(date +%H:%M:%S) 1070 still $state — our test Chrome reappeared, KILL FAILED"
  fi
  sleep 15
done
