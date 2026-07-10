# Full-telepoi battery — session 6 re-A/B (2026-07-10 evening)

Follow-on to `battery-findings-2026-07-10.md` (session 5). This session
landed the two reclaim fixes that finding 3 called for, then re-ran the
matrix with the SAME driver + environment across arms:

- **reclaim-center freshness gate** (`?reclaimGate`, default ON) — on a
  ≥2-LB center jump, at-cap victim selection holds until the new center
  LB's own bake is tracked (10 s hard cap). landblock_lru.js.
- **park hysteresis** (`?reclaimMinAgeMs`, default 2000) — entries touched
  <2 s ago are never victims (A11-F7).
- `?lbRingFloor=N|ringMax` — the floor is now a query arm, not a source
  edit.
- driver: same-destination duplicate POIs (verified identical rows in
  `ace_world.points_of_interest`) count as `noMove`, not failures; new
  per-stop `workDelta` (bake-worker requests, `window.__bakeWorkerSeq`)
  and `reclaimDelta` (evicted+parked) columns.

Run dir: `/mnt/wbterminal2/holtburger-scratch/battery-20260710T182346Z/`.
All arms: laptop SwiftShader `?nullRender=1`, tailnet1, serve.py live tree,
56/62 landed + 6 noMove duplicates per arm, ~3 SwiftShader renderer deaths
per arm absorbed by `--resume`.

## Round 1 (gate+hysteresis ON in all arms)

| arm | active | settleMed | satMed | capped | reclaim Σ / med / max | work med |
|---|---|---|---|---|---|---|
| gate-hyst (classic)        | 805.5 s | 14.5 s | 16.4 s | 18/56 | 17,803 / 121 / 3,786 | 100 |
| wp-gate-hyst               | **588.5 s** | **8.8 s** | 14.4 s | **10/56** | 11,751 / 40 / 7,135 | 87 |
| wp-rf-gate-hyst            | 657.0 s | 9.2 s | 15.8 s | 15/56 | **6,310 / 75 / 984** | 98 |
| rf-gate-hyst (classic+floor) | 799.2 s | 14.9 s | 15.2 s | 19/56 | 17,567 / 121 / 3,691 | 101 |

(Caveat: arms 1–2 overlapped ~3 min of cargo test CPU contention; arm 4 ran
clean and matches arm 1, so the classic numbers are not contention
artifacts.)

## Round 2 (controls)

| arm | active | settleMed | satMed | capped | reclaim Σ / med / max | work med |
|---|---|---|---|---|---|---|
| control-off (classic, fixes OFF)  | 688.1 s | **9.2 s** | 15.2 s | 17/56 | 10,104 / 46 / 3,656 | 96 |
| networker-gate-hyst (netWorker=1) | 691.8 s | 10.3 s | 19.6 s | 17/56 | 6,302 / 67 / 2,536 | 99 |
| wp-control-off (wp, fixes OFF)    | 682.2 s | 10.4 s | 15.9 s | 15/56 | 11,866 / 40 / 3,799 | 90 |

- **control-off contradicts the metric-artifact theory being the whole
  story: in CLASSIC mode the gate+hysteresis are a net REGRESSION** — 805 s
  vs 688 s active, 14.5 vs 9.2 s settle med, and Σreclaim 17.8k vs 10.1k
  (i.e. the fixes ADDED ~7.7k reclaim ops). Repeatable: the clean-env
  rf-gate-hyst arm matches gate-hyst (~800 s / ~14.8 s), so this is not
  the arm-1 CPU-contention confound. Reading: plain LRU recency ALREADY
  protects the arriving ring in classic mode (fresh bakes are touched →
  evicted last); the 2 s hysteresis instead promotes mid-ring LBs
  (outside the 3×3, older than 2 s, still being streamed) into an
  evict→re-bake→age-in→evict cycle through the dwell.
- **Under warmPark the picture inverts** — arm 7 (wp-control-off) closed
  the loop: wp+fixes-ON 588 s / 8.8 s / 10 capped vs wp+fixes-OFF 682 s /
  10.4 s / 15 capped at equal total churn — a ~14% same-day win. Parks
  are cheap re-attaches, so turnover costs little and the gate's arrival
  protection shows through.
- **netWorker=1 first valid read**: vs its like-for-like control
  (gate-hyst classic, 805 s / 14.5 s) it is FASTER (692 s / 10.3 s) with
  the day's second-lowest churn — no regression; promising. Worst
  saturated tail (satMed 19.6 s) needs a look before promoting it.

## DECISION (landed): gate + hysteresis defaults FOLLOW ?warmPark

`RECLAIM_GATE_ON` and `RECLAIM_MIN_AGE_MS` now default to on/2000 when
warm-park is enabled and off/0 in classic mode, each explicitly
overridable (`?reclaimGate=on|off`, `?reclaimMinAgeMs=N`). This encodes
the measured matrix exactly (win under warm-park, regression in classic)
and rides along automatically when warmPark flips default-ON at the 1070
eye-gate (W4 §3.1). Bare-URL behavior is byte-identical to pre-session-6.
`lbRingFloor` stays default 1: under warm-park the floor trades ~12%
active for halved Σchurn and 7× lower worst-stop churn — revisit when
churn (GC pressure) rather than settle is the complaint.

## Verdicts so far

1. **warmPark confirmed again, margin larger** (8.8 vs 14.5 s settle med,
   10 vs 18 capped). Still default-OFF pending the 1070 eye-gate.
2. **Finding-3 reversal confirmed: the gate de-toxified ringFloor.**
   Yesterday wp+ringFloor was the worst churner (8,515 parks, satMed 16.0);
   today wp-rf has the LOWEST total reclaim (6,310) and a 7× lower
   worst-stop churn (max 984 vs 7,135) at neutral settle. The stale-center
   hypothesis was right.
3. **~121 reclaims/stop at saturation is legitimate ring turnover, not
   ping-pong** — identical in every arm: cap 203 vs streaming ring ~169
   means each town hop must retire ~a ring. The "<10/stop" target chased
   turnover, not churn. The meaningful churn signals are Σ and worst-stop
   max, where floor+gate+park win big.
4. **The settle-stability metric spreads-vs-bursts critique stands, but
   round 2 showed it is NOT the whole story**: control-off beat the
   classic fixes-on arms on RAW CHURN too (Σ 10.1k vs 17.8k), so in
   classic mode gate+hysteresis are a genuine regression, not just a
   metric artifact (see Round 2 notes). Next driver iteration should
   still settle on WORK PLATEAU (workDelta flat) rather than scene-count
   stability — workMed ~100 everywhere says throughput was identical
   while settle readings differed by 60%.

## The empty-screenshot diagnosis (user report, 1070 shots-wp-off)

~10 screenshots show a void world — no terrain, no NPCs on radar, and (the
tell) NO LOCAL PLAYER RIG. They are the FIRST ~10 stops of the cycle
(Ahurenga → Cragstone; the POI list is alphabetical). Root cause is ONE
pipeline, not two:

- The ACE wire was healthy throughout: every void stop landed in ~300 ms
  (teleport S2C processed), boot chat lines rendered.
- Radar blips require a COMPLETED entity spawn: `entityMap.set` happens at
  spawn Step E, after model decode (entities.js:3969). Wire-delivered NPCs
  with starved geometry fetches are radar-invisible — an empty radar does
  NOT implicate the wire.
- Terrain, NPC rigs, and the local player rig all funnel through the shard
  fetch → wasm decode → bake queue. Ten rapid teleports (each starved stop
  fast-settles in ~600 ms, so the driver hops on) queue ~10 towns of
  speculative ring work; completions arrive minutes late, then land as one
  burst (lru 11→57 on the 1070, 9→98 laptop — same signature locally, so
  not the tunnel).
- Client fix candidate (real UX bug for fast portal-hoppers, next session):
  a teleport FLUSH for the speculative fetch/bake queue — the analogue of
  P4 `spawnTeleportFlush` for ring work; the streamFix urgent lane can't
  beat a 10-town FIFO decode backlog.
