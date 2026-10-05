# HANDOFF — holtburger-web outdoor-run perf (continuation 4)

**Date:** 2026-07-14 · **Box:** wbterminal laptop (drives the 1070 GPU box over tailscale)
**Predecessor:** `HANDOFF-outdoor-run-perf-3.md`. This session EXECUTED the `-3` task list.
Self-contained. REPO = `/home/wbterminal/WorldBuilder-ACME-Edition`;
HOLT = `$REPO/external/holtburger/apps/holtburger-web`.

---
## 0. TL;DR — the `-3` list is CLOSED; one telemetry surface shipped, the "measured
##    lever" (#20) was REFUTED on the 1070, two tasks were dropped/deferred.
Same shape as the `-3` session: most of the plan didn't survive contact with data.

### What SHIPPED (client behaviour)
- **#14 — LOD band telemetry** (`?lodBandDiag=on`, default OFF). The explicit-band
  reader (`ui/ac_lod.js pickDegradeBand`) had **zero callers** — statics degrade via
  `THREE.LOD`, whose level pick happens internally at render — so the diag
  `bandHits/bandMisses` counters were structurally dead. New `tickLodBandDiag`
  (`scene3d/statics.js`, called per-frame from `scene3d/loop.js`) observes THREE.LOD
  active-level TRANSITIONS and drives the counters (level 0 = full detail = miss;
  level>0 = degrade band = hit). Armed behind a default-OFF flag because `__diag` is
  installed unconditionally (so its presence is NOT a gate); zero cost unarmed
  (returns on first line). Doc: `docs/url-flags.md`. **Caveat:** static LOD-wrapping
  is largely a no-op in current content (statics.js:1189 — "most Holtburg statics
  have no degrade chain"), so live LOD statics ≈ 0 at spawn/Cragstone; the counters
  correctly read ~0 there and light up only where a degrade chain resolves. Wiring
  validated on the 1070 (booted, ran every frame, 0 errors).

### What was INVESTIGATED and did NOT ship
- **#20 — streaming-upload throttle: REFUTED by a paired 1070 A/B.** Built a
  default-OFF `?uploadThrottle=on` (shared per-frame geometry budget; bakers await a
  slot before `prewarmSubtree`). Two paired telepoi-burst A/B runs → **no measurable
  effect**: maxΔG/frame swings 790↔1177 between the two BASELINES alone; the
  throttle-on runs (773, 1258) land inside that noise band. Mechanism: telepoi
  re-stream renders all new meshes in one frame (render-time upload clumps regardless
  of compile timing), and the throttle's batch-release re-clumps deferred compiles.
  **Code reverted** (module deleted, 4 baker wirings removed). Full write-up +
  numbers: `RESULTS-task20-upload-throttle-2026-07-14.md`.
- **#21 — the 5159 ms decode/GC frame: ATTRIBUTED** (measurement task, no code). It's
  a **bulk-eviction GC pause** (worst frame 5101 ms, dP=0 dG=0 **dT=−20** = mass
  texture disposal), **not** synchronous wasm decode and **not** bake-worker
  main-thread fallback (0 fallback tells; the worker is active, 93 split messages).
  Write-up: `RESULTS-task21-decode-gc-frame-2026-07-14.md`.

### What was DROPPED / deferred (with the user's agreement this session)
- **#4-lite — DEFERRED.** The ~20 non-atlased statics escape the atlas because they
  are `THREE.LOD`-wrapped (atlas skips isLOD); the only route is a cross-LB shared-geom
  map, but the statics evict path (`landblock_lru.js:1107`) disposes LOD-leaf geometry
  UNCONDITIONALLY, so sharing needs ALSO editing the eviction hot path + a ring dispose
  lifecycle — the "unvalidatable dispose dance" MEMORY warns against, for a ~21-geom
  win the census calls negligible vs the entity/terrain heap. (Also: live LOD statics
  ≈ 0, so there's almost nothing to share.) Do it in Rust if ever.
- **#3 — already DROPPED in `-3`** (MODEL_TRI_CACHE memo solves it). **#19 — moot:**
  nothing shipped to A/B (#20 reverted, #14 inert default-off, #21 measurement-only);
  its real sub-goal, a reliable corridor driver, was delivered as `poi-burst-ab.mjs`.

---
## 1. REUSABLE HARNESS delivered this session (all in `scripts/net-review/`)
- **`poi-burst-ab.mjs`** — deterministic telepoi-jump A/B. Each `@telepoi` evicts +
  re-streams a town = a worst-case upload burst; a fixed town sequence makes arms
  PAIRED. Far more reliable than the held-W corridor walk, which gets stuck headless
  (`lbsVisited 4` vs expected ~57). `env WALK_QUERY="flag=on"` for the B arm; writes
  `bigFrames[]` (Δp/g/t per >250 ms frame) + `throttleStats`.
- **`decode-gc-probe.mjs`** — console-fallback capture + no-upload-frame classifier
  (evict-GC `dT<0` vs pure-no-change `dT=0`). Answers "GC vs decode vs worker-fallback".
- **`walk-entgrowth.mjs`** — added a `throttleStats` capture (guarded; reads null when
  no throttle module present).
- Analysis: `/tmp/.../scratchpad/ab-analyze.mjs` (per-arm upload metrics + deltas).

## 2. 1070 harness state (as left)
Tunnels UP (`ssh … -L 9333 -R 8765 -R 8080`), off-screen CDP Chrome UP (real GPU:
`ANGLE NVIDIA GTX 1070 Direct3D11`, `KHR_parallel_shader_compile` present),
serve.py `:8765` reachable from the box. All probe pages closed; the person's chrome
untouched (dedicated `--user-data-dir=C:\Temp\cdpwb-wls`). Account `tailnet1`:
single-login, needs **≥45-60 s grace between arms** (hit "Account In Use" twice this
session at ~40 s).

## 3. What's actually left for outdoor-run perf (honest, small)
The `-3` and this session together closed the whole 19-task plan. The residual real
levers, all LOWER priority than they looked (heap is terrain/entity-dominated and
bounded per RESULTS-task2/-11b):
- **Bulk-evict GC pause (#21 follow-on)** — extend the governor dispose budget
  (`parkDisposeBudgetMs`) to the terrain/statics full-ring teardown path so a cluster
  evict spreads across frames; or cut per-burst allocation churn. Only bites on big
  teardowns.
- **A real upload-spreader (if #20 is ever revisited)** — throttle VISIBILITY /
  render-attach (stagger when subtrees become renderable), NOT compile; validate on a
  CONTINUOUS walk, not telepoi (which renders everything at once). Pop-in risk.
- **`static_atlas.js:334` BatchedMesh grow-never-shrink** (untracked heap, low pri).

## 4. Guiding principle earned again
Same as `-3` §4: **measure before you ship, and verify your own measurement.** #12
(shader prewarm) and now #20 (compile throttle) were both plausible levers that a
paired 1070 A/B overturned. Trust the RESULTS docs; re-verify any "lever" against a
paired 1070 run BEFORE shipping.
