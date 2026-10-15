#!/usr/bin/env bash
# Waits until the 1070 is idle (owner choice 2026-10-14: "wait until it's idle"), then relaunches the hidden test
# Chrome, boots the film page (fair weather, cloud coverage 0.3) and shoots ONE site for review (STOP_AFTER_SITES=1).
# Idle = screen locked, OR (their Chrome closed or nearly idle AND Roblox not active) for 3 consecutive 5-min checks.
set -uo pipefail
P=/mnt/wbterminal2/film-projects/dereth-town-tour
HB=/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web
BOX=young@100.127.215.75
SSH="ssh -o ConnectTimeout=10 -o BatchMode=yes"
need=3; ok=0; prevC=""; prevR=""
# decide QUIET from one check line; prints "dC dR quiet". Pure, testable (DRY_LINES mode below).
judge() {  # $1=line $2=prevC $3=prevR
  local line="$1" pc="$2" pr="$3" locked nch ccpu rcpu dC dR quiet=0
  locked=$(sed -n 's/.*locked=\([A-Za-z]*\).*/\1/p' <<<"$line"); nch=$(sed -n 's/.*chrome=\([0-9]*\).*/\1/p' <<<"$line")
  ccpu=$(sed -n 's/.*chromecpu=\([0-9]*\).*/\1/p' <<<"$line"); rcpu=$(sed -n 's/.*roblox=\([0-9]*\).*/\1/p' <<<"$line")
  if [ -z "$locked" ] || [ -z "$nch" ] || [ -z "$ccpu" ] || [ -z "$rcpu" ]; then echo "9999 9999 0 $ccpu $rcpu"; return; fi
  if [ -z "$pc" ]; then dC=9999; else dC=$(( ccpu - pc )); [ "$dC" -lt 0 ] && dC=9999; fi
  if [ -z "$pr" ]; then dR=9999; else dR=$(( rcpu - pr )); [ "$dR" -lt 0 ] && dR=0; fi
  if [ "$locked" = "True" ]; then quiet=1
  elif [ "$nch" -eq 0 ] && [ "$dR" -lt 40 ]; then quiet=1
  elif [ "$dC" -lt 30 ] && [ "$dR" -lt 40 ]; then quiet=1; fi
  echo "$dC $dR $quiet $ccpu $rcpu"
}
check() {
  if [ -n "${DRY_LINES:-}" ]; then sed -n "${DRY_I}p" "$DRY_LINES"; return; fi
  timeout 60 $SSH $BOX "powershell -NoProfile -Command \"\$l=[bool](Get-Process LogonUI -ErrorAction SilentlyContinue); \$c=Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -notlike '*cdpwb-wls*' }; \$cpu=0; foreach (\$x in \$c) { \$pr=Get-Process -Id \$x.ProcessId -ErrorAction SilentlyContinue; if (\$pr) { \$cpu += \$pr.CPU } }; \$r=(Get-Process RobloxPlayerBeta -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum; 'locked=' + \$l + ' chrome=' + \$c.Count + ' chromecpu=' + [int]\$cpu + ' roblox=' + [int]\$r\"" 2>/dev/null | tr -d '\r' | tail -1
}
echo "$(date -Is) WATCH start (need $need quiet checks, 5 min apart)"
DRY_I=0
while true; do
  DRY_I=$((DRY_I+1))
  line=$(check)
  if [ -z "$line" ]; then echo "$(date -Is) check failed (box unreachable?) — not idle"; ok=0; [ -n "${DRY_LINES:-}" ] && { echo "DRY: out of lines"; exit 0; }; sleep 300; continue; fi
  read -r dC dR quiet ccpu rcpu <<<"$(judge "$line" "$prevC" "$prevR")"
  if [ "$quiet" = "1" ]; then ok=$((ok+1)); else ok=0; fi
  echo "$(date -Is) $line dChromeCpu=${dC}s dRobloxCpu=${dR}s -> quiet=$quiet ($ok/$need)"
  prevC=$ccpu; prevR=$rcpu
  if [ "$ok" -ge "$need" ]; then break; fi
  if [ -n "${DRY_LINES:-}" ]; then continue; fi
  sleep 300
done
if [ -n "${DRY_LINES:-}" ]; then echo "DRY: would resume now"; exit 0; fi
echo "$(date -Is) IDLE: relaunching the hidden test Chrome"
timeout 40 $SSH $BOX "schtasks /run /tn FilmCdp" >/dev/null 2>&1
pgrep -a ssh | grep -q -- '-L 9333' || ssh -o ExitOnForwardFailure=yes -o ConnectTimeout=10 -o BatchMode=yes -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 $BOX
for i in $(seq 1 30); do curl -s -m 3 http://127.0.0.1:9333/json/version >/dev/null && break; sleep 2; done
sleep 60   # single-login account: let the old session's logout settle
"$P/film-run.sh" boot --assume-muted --quality=high --width=1920 --height=1080 --base="http://127.0.0.1:8765/apps/holtburger-web/index.html?cloudCoverage=0.3" 2>&1 | grep -E 'gate:|camera owned|In Use|rror' | sed 's/^/  boot: /'
cd "$HB" && timeout 60 node --no-warnings --input-type=module -e '
const { chromium } = await import("playwright-core");
const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
const p = b.contexts().flatMap(c => c.pages()).find(x => /filmMode=on/.test(x.url()));
const s = await p.context().newCDPSession(p);
const { windowId } = await s.send("Browser.getWindowForTarget");
await s.send("Browser.setWindowBounds", { windowId, bounds: { left: -32000, top: -32000, width: 1920, height: 1167, windowState: "normal" } });
const r = await p.evaluate(() => ({ coverage: window.__cloudOverlay?.volume?.effect?.coverage ?? null }));
console.log("  page: " + JSON.stringify(r)); process.exit(0);
'
cd "$P" && echo "$(date -Is) RESUMED: shooting one site for review" && STOP_AFTER_SITES=1 ./shoot-driver.sh >> "$P/driver.log" 2>&1
echo "$(date -Is) REVIEW: first site shot ($(tail -2 "$P/driver.log" | head -1 | cut -c1-200))"
