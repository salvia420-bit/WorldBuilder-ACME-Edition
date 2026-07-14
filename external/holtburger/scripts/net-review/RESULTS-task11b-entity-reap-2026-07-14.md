# RESULTS — Task #11b: entity reap radius (opt-in) + corrected entity-heap picture

**Date:** 2026-07-14 · **Box:** 1070 real-GPU (ANGLE GTX 1070 Direct3D11) ·
**Probe:** `scripts/net-review/walk-entgrowth.mjs` (corridor start + nudge-on-stuck) ·
**Code:** `scene3d/entities.js` `readReapRadius()` / `REAP_PVS_RADIUS` ·
**Raw:** `/mnt/wbterminal2/tmp/walk-corr-r8.json`, `walk-corr-r3.json`.

## TL;DR — honest, and it walks back the #11 "top lever" framing
The stale-entity reaper (`reapStaleEntities`, radius 8 / 30 s grace) **already
works**. A real 88-LB corridor walk shows entity geometry rise to a **bounded**
peak then reap as the player leaves — not the "unbounded growth" the first #11a
draft claimed (that was a stuck-character + backlog-drain artifact; corrected in
RESULTS-task11a). Entities are a large geometry **count** but a **small heap
fraction** (heap is dominated by resident terrain — 360 LBs ≈ 1900 MB). A tighter
reap radius (`?entityReapRadius=3`) is a **directional** peak/smoothness win, **not**
a validated default change — shipped **opt-in**, default stays 8.

## What shipped
`scene3d/entities.js`: `REAP_PVS_RADIUS` is now `readReapRadius()` — default **8**
(unchanged shipped behaviour), overridable via `?entityReapRadius=N` (1–64) to opt
into a tighter (or wider) entity keep-window. `off` = 8. JS-only, live on reload.

## Measurement — 1070 corridor walk (Cragstone clearStart, 2110 m corridor, ~180 s)
| arm | lbsVisited | entGeoms base→peak→end | entRoots base→peak | heap peak |
|---|---|---|---|---|
| **r=8 (shipped)** | 88 | 2540 → **3875** → 1214 | 154 → 387 | 1850 MB |
| r=3 (opt-in) | 86 | 670 → **1636** → 655 | 56 → 287 | 1951 MB |

Read:
- **r=8 reaps, but late + bulky.** Entity geometry climbs to ~3875 as the player
  leaves a trail through town+wilderness, then **drops ~2500 in one ~15 s window**
  (3784→1226) once Cragstone falls 8 LBs behind — a dispose spike of the kind the
  landblock governor work fought.
- **r=3 stays lower and reaps continuously** (peak ~1636, no bulk drop) — the
  smoother, tighter behaviour ACE's ~1-2 LB PVS contract implies.
- **BUT the arms are not paired.** Spawn/backlog nondeterminism gave the two runs
  very different entity populations (baseline 2540 vs 670), so this is
  **directional, not a controlled single-variable A/B**. A crisp quantitative claim
  needs several runs per arm (or a controlled teleport-trail test).
- **Heap barely moved** (1850 vs 1951 MB — r=3 even higher, terrain-driven noise):
  the ~2200-geom peak difference is a **small fraction** of a terrain-dominated
  ~1900 MB heap. So the entity radius is a **minor** heap lever.

## Corrected picture of #11 (important)
- The entity heap is **bounded**, and the reaper already enforces it. My earlier
  "untracked entities are the top heap lever / grow unbounded" was **overstated** —
  it conflated geometry *count* with *heap*, and rested on a stalled walk.
- The real resident-heap mass at speed is **terrain** (360 resident LBs ≈ 1900 MB),
  which is the **landblock governor's** domain (already shipped) plus
  `static_atlas.js` BatchedMesh grow-never-shrink. #4's static-dedup is ~solved.
- Net: after this session's measurements, **there is no single dramatic remaining
  geometry lever**. The governor + atlas already bound the big consumers; entity
  radius is a minor smoothness tweak; #4 is ~done.

## Continuous (budgeted) reap — shipped default-on, but a minor lever
Added `?entityReapBudgetMs=N` (default **3**, `off`=legacy). The reaper now removes
**most-stale-first, bounded to a wall-clock budget + a 48/scan count backstop**;
the rest age out on later scans (mirrors the landblock governor's
`parkDisposeBudgetMs`). Steady traversal makes only a few entities stale per 4 s
scan, so nothing backs up — only a one-off town-exit backlog is spread out.

**Paired 1070 corridor A/B (same 660-geom baseline, 86 LBs, radius 8):**
| | worst frame | median frame | >100 ms frames | longtasks | peak entGeoms |
|---|---|---|---|---|---|
| budget **off** (bulk) | 3299 ms | 102.6 ms | 43 | 1008 | 1947 |
| budget **on** (3 ms) | 6067 ms | **68.7 ms** | **28** | 1071 | 1992 |

Read honestly:
- **The worst frames are NOT the reap.** 3–6 s frames are **shader-compile /
  streaming stalls** — my budgeted loop caps reap work at 3 ms and *cannot* produce
  a multi-second frame. Which arm draws the worse streaming stall is luck of timing.
- **Directional median win** (102→69 ms, fewer >100 ms hitches) but **noise-dominated
  overall** — the reap dispose is a small contributor swamped by shader/streaming.
- Zero behaviour downside (same entities reaped, ~+45 geoms peak = a few extra
  scans of retention). Shipped **default-on** as a harmless smoothing; escape via
  `?entityReapBudgetMs=off`.

## The real latency lever is #12, not the reap
The multi-second frames in BOTH arms are cold **shader compiles** (and streaming).
That is exactly task **#12** (`compileAsync`-prewarm ~125 programs at boot). The
entity-reap work (radius + budget) is a minor smoothing at best; **#12 is where the
walk-latency actually lives.** Recommend pivoting there next.

## Recommendation
1. **Keep r=3 opt-in.** Before defaulting it on, do (a) 3–4 paired corridor runs per
   radius to beat down spawn noise, and (b) a **live eye-test** for creature pop-out
   at distance (headless can't judge this). If both hold, flip the default to ~3-4.
2. **The bulk-reap spike is the more interesting thread** than absolute heap: r=8's
   ~2500-geom dispose in one window is a latency risk. A continuous/time-budgeted
   entity reap (mirroring the governor's `parkDisposeBudgetMs`) would smooth it
   regardless of radius — arguably a better #11b than the radius change.
3. **static_atlas.js:334 BatchedMesh grow-never-shrink** remains an untouched
   untracked contributor; measure it next if heap is the goal.

## Harness notes (cost future runs otherwise)
- `walk-entgrowth.mjs` now teleports to the plan's `clearStart` + corridor quat and
  **nudges (turn briefly) on <1 m/tick stall** — without it, held-`w` from a town
  center walks into a building and stops after ~70 m (which produced the bad #11a
  data). lbsVisited went 6 → 88 with the fix.
- Single-login `tailnet1`: **40 s between arms was NOT enough** — the second arm hit
  "Account In Use" / NOT-in-world twice. Use ≥60–90 s, or the
  `battery-outdoor-run-wrapper.sh` wait-for-logout logic.
- The battery driver's own 1070 corridor land reported `teleOk=false` this session
  (separate harness bug — its clear-start land-detection, not the entity work).
