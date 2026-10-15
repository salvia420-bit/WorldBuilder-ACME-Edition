#!/usr/bin/env bash
# Dereth town tour — resumable per-site shoot driver (run detached: setsid nohup ./shoot-driver.sh >> driver.log 2>&1 &).
# One `film shoot --site=<id>` per schedule entry, in schedule order; a site whose shots all have reports is skipped.
# Stops (exit 3) when the 1070 test Chrome stops answering CDP, and (exit 4) when logged JEV spend exceeds the budget.
set -uo pipefail
P=/mnt/wbterminal2/film-projects/dereth-town-tour
RUN="$P/film-run.sh"
BUDGET_USD=${BUDGET_USD:-1.60}
STOP_AFTER_SITES=${STOP_AFTER_SITES:-0}   # >0: stop after this many sites were actually shot (review pause)
shotSites=0
cd "$P"
mapfile -t SITES < <(python3 -c "import json;[print(e['siteId']) for e in json.load(open('timeline.json'))['schedule']]")
echo "$(date -Is) driver start: ${#SITES[@]} sites, JEV budget \$${BUDGET_USD}"
for site in "${SITES[@]}"; do
  shots=$(python3 -c "import json,sys;t=json.load(open('timeline.json'));print(' '.join(next(e['shots'] for e in t['schedule'] if e['siteId']==sys.argv[1])))" "$site")
  missing=0; for s in $shots; do [ -f "reports/$s.json" ] || missing=1; done
  if [ $missing -eq 0 ]; then echo "$(date -Is) skip $site (all shots have reports)"; continue; fi
  if ! curl -s -m 8 http://127.0.0.1:9333/json/version >/dev/null; then echo "$(date -Is) STOP: CDP :9333 not answering (test Chrome or tunnel down) before $site"; exit 3; fi
  spent=$(python3 - <<'PY'
import json,glob
t=0
for f in glob.glob('reports/**/jev-client.jsonl',recursive=True)+glob.glob('reports/jev-client.jsonl'):
    for l in open(f):
        try: c=json.loads(l).get('costUsd')
        except Exception: continue
        if isinstance(c,(int,float)): t+=c
print(f'{t:.4f}')
PY
)
  if python3 -c "import sys;sys.exit(0 if float('$spent')>float('$BUDGET_USD') else 1)"; then echo "$(date -Is) STOP: JEV spend \$$spent > \$$BUDGET_USD"; exit 4; fi
  echo "$(date -Is) site $site [$shots] (JEV so far \$$spent)"
  "$RUN" shoot "$P/timeline.json" --project="$P" --site="$site" --retakes=0 --bitrate=12000000 --jev-max-usd-per-hour=0.35 > "reports/shoot-$site.log" 2>&1
  rc=$?
  echo "$(date -Is) site $site exit $rc: $(grep -E '^  [a-z0-9.-]+: ' "reports/shoot-$site.log" | tr '\n' ' ' | cut -c1-400)"
  shotSites=$((shotSites+1))
  if [ "$STOP_AFTER_SITES" -gt 0 ] && [ "$shotSites" -ge "$STOP_AFTER_SITES" ]; then echo "$(date -Is) PAUSE: STOP_AFTER_SITES=$STOP_AFTER_SITES reached (review, then restart the driver)"; exit 0; fi
done
echo "$(date -Is) driver done"
