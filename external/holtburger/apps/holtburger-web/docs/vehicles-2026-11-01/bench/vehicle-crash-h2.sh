#!/bin/bash
# H2 crash test driver: fly, get saved in the sky (save interval 10 s), SIGKILL ACE, restart, log in, check placement.
set -u
FIFO=/home/wbterminal/ace_stdin.fifo
ACERT=/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0
B=/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/vehicles-2026-11-01/bench
OUT=/mnt/wbterminal1/tmp/claude-scratch/vehicles
NODEPATH="/home/wbterminal/.local/bin:/usr/local/bin:/usr/bin:/bin"
ts() { date +%H:%M:%S; }
cd "$B" || exit 1
L0=$(wc -l < "$ACERT/ACE_Log.txt")
echo "$(ts) log start line $L0"
echo "modifylong player_save_interval 10" > "$FIFO"
sleep 2
env PATH="$NODEPATH" capped-build node vehicle-runner.mjs --plan plan-crashsave.json --out "$OUT/crash-a.json" > "$OUT/crash-a.log" 2>&1 &
RP=$!
for i in $(seq 1 300); do
  grep -q 'step keep flying' "$OUT/crash-a.log" && break
  kill -0 $RP 2>/dev/null || { echo "$(ts) runner exited early"; tail -5 "$OUT/crash-a.log"; break; }
  sleep 2
done
grep -a 'fly and get saved' "$OUT/crash-a.log" | tail -1 | cut -c1-300
sleep 15
PID=$(pgrep -f '^/home/wbterminal/.local/bin/dotnet ACE.Server.dll')
echo "$(ts) SIGKILL ACE pid $PID"
grep -a -n 'saved\|Save' "$ACERT/ACE_Log.txt" | tail -n +1 | awk -F: -v s=$L0 '$1>s' | tail -3 | cut -c1-200
kill -9 "$PID"
for i in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
echo "$(ts) ACE gone"
sleep 5
kill $RP 2>/dev/null; wait $RP 2>/dev/null
echo "$(ts) restarting ACE"
setsid /home/wbterminal/ace-server/run-ace-live.sh > /dev/null 2>&1 < /dev/null &
for i in $(seq 1 90); do ss -ulpn | grep -q ':9000 ' && break; sleep 2; done
for i in $(seq 1 60); do tail -n 50 "$ACERT/ACE_Log.txt" | grep -q 'World is now open' && break; sleep 2; done
echo "$(ts) ACE up: $(ss -ulpn | grep -c ':900[01] ')"
echo "modifylong player_save_interval 300" > "$FIFO"
sleep 3
env PATH="$NODEPATH" capped-build node vehicle-runner.mjs --plan plan-crashlogin.json --out "$OUT/crash-b.json" > "$OUT/crash-b.log" 2>&1
grep -a 'where did we enter' "$OUT/crash-b.log" | tail -1 | cut -c1-400
echo "--- ACE log since start:"
tail -n +"$L0" "$ACERT/ACE_Log.txt" | grep -a -E 'VEHICLE|player_save_interval|saved in the air' | cut -c1-260 | tail -20
echo "$(ts) done"
