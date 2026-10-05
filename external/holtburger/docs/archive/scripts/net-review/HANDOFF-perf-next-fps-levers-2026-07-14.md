# HANDOFF — holtburger-web: next FPS/perf levers (forward plan)

**Date:** 2026-07-14 · **Box:** wbterminal laptop → 1070 GPU box (tailscale)
**Purpose:** carry momentum toward *real* fps/heap wins now that the outdoor-run
plan's easy levers are exhausted. Reads on top of `HANDOFF-outdoor-run-perf-4.md`
(what closed) + the `RESULTS-task*.md` docs. Self-contained.
REPO = `/home/wbterminal/WorldBuilder-ACME-Edition`; HOLT = `$REPO/external/holtburger/apps/holtburger-web`.

---
## 0. Where we actually are (read this first — it reframes the search)
The engine is **already residency-bounded**. Prior sessions shipped the live-geometry
governor (`18644c6c`) + entity-reap smoothing (`0b8dc34d`); this session measured the
rest of the plan and **most of it was already handled or refuted**:
- **Refuted on the 1070 (paired A/B), do NOT rebuild:** #12 boot shader-prewarm,
  #20 compile/upload-throttle. Both were plausible; both showed zero signal against a
  noise floor where *identical* baselines swing ±49% (RESULTS-task12, -task20).
- **Bounded/tiny, dropped:** #3/#4/#4-lite static geometry dup (~21 geoms, negligible;
  RESULTS-task2). Statics/buildings already share via bakeCache + atlas.
- **Attributed:** the multi-second stall = **bulk-eviction GC** (dT<0 mass dispose),
  not decode/worker-fallback (RESULTS-task21).

**Implication:** the streaming *spikes* are largely wrung out. The remaining gains are
in the **dominant resident populations** and the **steady per-frame budget**, not in
shaving streaming bursts. Chase populations, not spikes.

## 1. The strategic target (the north star)
Retail residency = **refcounted geometry cache + fixed slot grid** (`LScape::update_block`,
`DBOCache`). Roadmap position (memory §perf):
`thread_local triangulation memo ✓ → instanced anim-scenery ✓ (2×fps forest) → [YOU ARE HERE] the geometry CACHE step → fixed slot grid/park`.
The next lever is the **geometry cache step**, and the data says its highest-value
target is **entity geometry** (below).

---
## 2. RANKED LEVERS (each: why · data · first step · measure · risk)

### L1 — Entity geometry dedup/sharing  ⭐ TOP LEVER (heap + draw-traversal)
- **Why.** Creatures/NPCs/players mint `new THREE.Mesh(g.geometry, mat)` **per
  entity** (`scene3d/entities.js:~3970`). Only the *Rust triangulation* is memoized
  (MODEL_TRI_CACHE) — the **GPU BufferGeometry duplicates per entity**. Anim-scenery
  and statics/buildings are already shared/instanced; entities are the last big
  un-deduped population.
- **Data.** RESULTS-task2: **928 distinct entity geometries at Cragstone**, the
  *largest single population*, **grows with traversal** (entities aren't
  modelId-tracked, so the census can't attribute them today), ~**40×** the entire
  static-dedup universe. Heap grew 1220→1539 MB / riGeoms 394→3458 over one 120 s walk
  — entity + terrain dominated.
- **First step (do this before building — census said so).** Instrument entity mesh
  identity: stamp each entity part mesh with `(setupId/gfxObjId, partIndex,
  surfaceDid)` in `userData`, then run a *tracked* census (extend `geom-census.mjs`)
  to size (a) how many distinct entity geoms collapse under that key, and (b) how far
  the count grows across a continuous 1070 traversal. This quantifies the prize.
- **Build.** Share one `BufferGeometry` per `(setupId, part, surface)` across all
  entities of that setup — each entity keeps its own Mesh node + per-part transform
  (animation is transform-only; the vertex geometry is identical across instances).
  N wasps → 1 geometry/part instead of N. **Prefer a RUST-side refcounted cache**
  (keyed off the decode/pack path — `fetch_model_meshes`/`pack_model_mesh`) so it's
  byte-identical and needs no eye-test (memory: system-work-in-Rust; a JS shared-geom
  cache is an "unvalidatable dispose dance"). If done in JS, reuse the existing entity
  `__cacheOwned`/`__disposable` B3 machinery (entities.js:562-2305) + refcount.
- **Measure.** `poi-burst-ab.mjs` distinctEntityGeoms + heap, paired off/on; expect a
  large drop in distinct geoms and heap-growth slope. This is the retail DBOCache step.
- **Risk.** Dispose discipline (refcount; don't free a geometry another entity holds).
  Real but bounded — the machinery exists, and Rust-side sidesteps the JS dance.

### L2 — Steady per-frame budget breakdown  (find the sustained-fps lever)
- **Why.** We've only measured streaming *spikes*. Median `maxFrameMs` was **74-183 ms
  DURING streaming** — but nobody has profiled a **steady in-town frame** (no
  streaming). If the steady frame is already over ~16.7 ms, there's sustained CPU cost
  (per-frame full-scene walks, ticks) that caps fps independent of streaming.
- **First step.** On the 1070, telepoi into a dense town, let it settle (streaming
  quiescent), then profile ONE frame's phases: `renderer.render` vs the per-frame
  walks (`cullStaticsGroup`/FCULL, shadow-receive gate, `tickStaticsBillboards`,
  `tickStaticParticles`, entity tick, particle sim, the DOM nameplate projection —
  loop.js flags each as a deferrable). Use `?vfxGauge=on` (T_cpu/T_gpu) + `?renderDiag=on`
  + a per-phase `performance.now()` bracket. `renderer.info.autoReset=false` then diff
  (measurement trap, memory §staleness).
- **Measure/decide.** Rank phases by ms; the fattest steady-frame phase is the lever.
  Likely suspects: full-scene traversals that scale with resident node count, or the
  nameplate DOM projection (loop.js calls it "the single biggest deferrable, 5-50 ms").
- **Risk.** Pure measurement first; low.

### L3 — Bulk-evict GC smoothing  (#21 follow-on)
- **Why/Data.** Worst frames (2.6-5.1 s) are eviction GC (dT<0 mass dispose;
  RESULTS-task21). The governor already time-budgets its park/dispose
  (`parkDisposeBudgetMs`) and entity reap (`entityReapBudgetMs`), but a full-ring
  teardown (telepoi) and possibly the terrain/statics bulk-evict path still dispose a
  big batch in one frame.
- **Build.** Extend the dispose budget to the terrain/statics teardown so a cluster
  evict spreads across frames; and/or cut per-burst allocation churn to lower GC
  pressure. **Measure** with `decode-gc-probe.mjs` (evictGc worst-frame ms).
- **Risk.** Touches eviction path — validate no orphaned/leaked LBs on a walk.

### L4 — `static_atlas.js:~334` BatchedMesh grow-never-shrink  (untracked heap)
- Low-effort heap reclaim: the cross-LB static atlas BatchedMesh grows but never
  shrinks. Add a compaction/shrink on sustained slack. Small, clean, JS-local.

### L5 — Fixed slot-grid residency  (endgame, big)
- The structural fix that removes per-LB re-decode + bulk evict entirely: a fixed
  slot grid around the player (retail `LScape::update_block`) that reuses slots as the
  player moves instead of bake/evict churn. Large; it's the real destination once
  L1/L3 land. Ties the whole retail-residency roadmap together.

---
## 3. Harness (use these — hard-won this session)
All in `scripts/net-review/`:
- **`poi-burst-ab.mjs`** — deterministic telepoi-jump PAIRED A/B (each jump = a
  worst-case re-stream). `env WALK_QUERY="flag=on"` for the B arm. Writes `bigFrames[]`
  (Δp/g/t per >250 ms frame) + `throttleStats`. **Use this, not held-W** — the corridor
  walk gets stuck headless (`lbsVisited 4` vs ~57). Add an `entGeom` sampler for L1.
- **`walk-entgrowth.mjs`** — held-W corridor walk (flaky; use for long-run growth only).
- **`decode-gc-probe.mjs`** — console-fallback capture + no-upload-frame classifier.
- **`geom-census.mjs`** — per-`(model,part,surface)` geometry census; **extend for L1**
  (entity identity keys).
- **`geom-census`/analysis:** `/tmp/.../scratchpad/ab-analyze.mjs` pattern (per-arm
  metrics + deltas).

### 1070 setup (MODE2i real GPU — the only authoritative fps path)
1. On box: off-screen CDP Chrome via `schtasks` + `launch-wls.bat`
   (`--use-angle=d3d11 --user-data-dir=C:\Temp\cdpwb-wls --window-position=-32000,-32000`).
   ⚠ This session left NO chrome running — you must relaunch it.
2. Tunnels (laptop): `ssh -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 young@100.127.215.75`
   **and** a separate `-R 8080`. Assert `UNMASKED_RENDERER` contains `GTX 1070 … Direct3D11`
   + `KHR_parallel_shader_compile` present.
3. serve.py `:8765` live JS (no build for JS; `capped-build wasm-pack --release` for any
   Rust change — L1 in Rust needs this). `?nosw=1` mandatory.
4. **Cleanup:** kill ONLY test chrome by `--user-data-dir=*cdpwb-wls*` match (PowerShell
   `Get-CimInstance Win32_Process | ? {$_.CommandLine -like '*cdpwb-wls*'} | % {Stop-Process $_.ProcessId -Force}`).
   NEVER `taskkill /IM chrome.exe` (the person's session).

## 4. Pitfalls (paid for in hours this session)
- **Noise floor is HUGE.** Identical baselines swung maxΔG 790↔1177 (±49%). **Never
  trust one run — pair arms (same telepoi sequence) and expect to need 2 pairs.** A
  single-run "win" is almost certainly noise.
- **Measure before you build; verify your own measurement.** #12 and #20 were both
  plausible levers killed by a paired 1070 A/B. Ship nothing default-on without it.
- **Account `tailnet1` single-login:** ≥**60 s grace** between arms or "Account In Use"
  aborts the run (hit twice this session at ~40 s).
- **Headless held-W walk is unreliable** (<1 fps, gets stuck) → telepoi jumps.
- **SwiftShader (laptop) can't measure fps or upload timing** (synchronous upload, OOMs
  ~6k nodes) — geometry *counts* only. All fps/frame-timing on the 1070.
- **JS shared-geom caches = dispose dance** (memory) → prefer Rust for L1.
