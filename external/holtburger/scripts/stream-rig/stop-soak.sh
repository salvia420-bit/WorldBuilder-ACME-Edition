#!/bin/bash
# Stop the whole soak cleanly: end the YouTube push, tear down the game + slate
# windows and the watchdog, and stop the comprehension monitor. Triggered
# automatically by the director-disable watcher when the AI auto-disables after
# 5 consecutive errors (operator: "just stop the soak if it fails 5 times" — do
# NOT switch to the expensive glm-5.2). Safe to run by hand too.
# All kills are exe-checked / name-exact so they never hit the caller's shell.
S=/mnt/wbterminal2/stream
REASON="${1:-manual}"
echo "$(date -Is) 🛑 STOP-SOAK ($REASON) — tearing down stream + bot + monitor" >> "$S/comprehension-monitor.log"

# 1) Stop the YouTube push loop + watchdog (both exit on the STOP file) and end
#    the in-flight ffmpeg now so the broadcast closes promptly.
touch "$S/STOP"
pkill -x ffmpeg 2>/dev/null

# 2) Tear down the game + slate chromium (exe-checked — only chrome procs).
for p in $(pgrep -f 'stream/profile-'); do
  ex=$(readlink /proc/$p/exe 2>/dev/null); case "$ex" in *chrom*) kill "$p" 2>/dev/null;; esac
done

# 3) Stop the CDP watchdog if still up.
for p in $(pgrep -x node); do
  grep -qa stream-rig-watchdog /proc/$p/cmdline 2>/dev/null && kill "$p" 2>/dev/null
done

# 4) Stop the comprehension monitor (its crash-restart launcher + the node).
#    Matches the v2 script path in both cmdlines; this script's own cmdline does
#    not contain it, so we never kill ourselves.
pkill -f 'comprehension-monitor-v2.cjs' 2>/dev/null

echo "$(date -Is) 🛑 STOP-SOAK done ($REASON)" >> "$S/comprehension-monitor.log"
