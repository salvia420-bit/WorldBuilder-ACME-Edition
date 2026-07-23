#!/bin/bash
# Clean-recover the stream GAME window: SIGKILL any (possibly wedged) game
# chromium + stalled watchdog, then relaunch. Keeps ffmpeg/go_live pushing.
# Invoked by comprehension-monitor.cjs on a detected hard-freeze; exe-checked
# kills never touch the caller's shell.
S=/mnt/wbterminal2/stream
for p in $(pgrep -f 'profile-game'); do
  ex=$(readlink /proc/$p/exe 2>/dev/null); case "$ex" in *chrom*) kill -9 "$p" 2>/dev/null;; esac
done
for p in $(pgrep -x node); do
  grep -qa stream-rig-watchdog /proc/$p/cmdline 2>/dev/null && kill "$p" 2>/dev/null
done
sleep 2
# Clear the game profile HTTP cache (NOT Local Storage — keeps the OpenRouter
# key) so a relaunch always boots the freshest served JS/index.html rather than
# a stale cached copy (STREAM-RIG-OPS trap #4: nosw=1 bypasses the SW, not the
# HTTP cache). This is what lets source edits (e.g. the minimax maxTokens bump)
# take effect on the next auto-recovery.
rm -rf "$S/profile-game/Default/Cache" "$S/profile-game/Default/Code Cache" \
       "$S/profile-game/Default/GPUCache" 2>/dev/null
bash "$S/launch.sh"
