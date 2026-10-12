#!/bin/bash
# gate1070.sh — may we start (or keep) test Chrome on the 1070 right now?
# Exit 0 only when watch1070.sh polled within the last 60 s AND its state is AWAY (no keyboard/mouse
# input for the hysteresis window, no browser of theirs, their GPU load low). Any other answer —
# PRESENT, GPU-BUSY, WATCHER-STALE, UNREACHABLE, or no recent poll (watcher not running) — exits 1
# with the reason on stderr. Run it before every launch and between long steps of a driver.
DIR=${WATCH1070_DIR:-/mnt/wbterminal1/tmp/claude-scratch/perf}
POLL=$DIR/watch1070.poll
read -r ts state rest < "$POLL" 2>/dev/null
if [ -z "$ts" ]; then echo "gate1070: no poll file ($POLL) — start watch1070.sh first" >&2; exit 1; fi
age=$(( $(date +%s) - ts ))
if [ "$age" -gt 60 ]; then echo "gate1070: last poll ${age}s old — watch1070.sh is not running" >&2; exit 1; fi
if [ "$state" != AWAY ]; then echo "gate1070: 1070 is $state ($rest) — leave the box alone" >&2; exit 1; fi
echo "gate1070: AWAY (poll ${age}s ago: $rest)"
