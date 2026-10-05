# HANDOFF — holtburger-web outdoor-run perf (continuation 3)

**Date:** 2026-07-14 · **Box:** wbterminal laptop (drives the 1070 GPU box over tailscale)
**Predecessor:** `HANDOFF-outdoor-run-perf-2.md` (the 19-task plan after the eviction-cluster
governor landed). This doc supersedes it: **this session MEASURED the remaining plan and most
of it did not survive contact with data.** Self-contained.

REPO = `/home/wbterminal/WorldBuilder-ACME-Edition` (single git repo; holtburger is a plain
subdir, NOT a submodule). HOLT = `$REPO/external/holtburger/apps/holtburger-web`.

---
## 0. TL;DR — the plan was mostly already done; measurement corrected it
The `-2` handoff called #4 (share geometry) the "TOP LEVER", promoted #11 (untracked entities),
and queued #12 (shader prewarm). **On the 1070, each turned out to be a non-lever** — the shipped
governor + `bake_prewarm.js` + `reapStaleEntities` already handle the big costs. What actually
shipped this session is small and honest; the value is the **measurements + corrected plan** and a
reusable **1070 walk/attribution harness**.

### What measurement found (4 RESULTS docs, all in `scripts/net-review/`)
- **`RESULTS-task2-geom-duplication`** — #4 is ~solved. Definitive `(modelId,partIndex,surfaceDid)`
  census: **buildings share perfectly** (bakeCache), **statics are mostly atlased**; true cross-LB
  reclaimable = **~21 geometries** at a 19-LB town. Not worth a Rust refcount. `cells.js` envcell
  target showed 0 dup. **→ #3 DROPPED, #4 downscoped to a tiny JS-only statics fix.**
- **`RESULTS-task11a-entity-geometry`** — entities are the largest geometry *count* (per-instance,
  not shared) but a small *heap* fraction. ⚠ contains a **CORRECTION**: the first "entities grow
  unbounded / never evicted" claim was a **stuck-character + spawn-backlog artifact** — WRONG.
- **`RESULTS-task11b-entity-reap`** — the reaper (`reapStaleEntities`) ALREADY bounds entities
  (1070 corridor walk: peak ~3875 geoms then reaps as you leave). Shipped a harmless continuous
  (budgeted) reap + an opt-in tighter radius; both marginal. Heap is **terrain-dominated**.
- **`RESULTS-task12-stall-attribution`** — #12's premise is **disproven**. Per-frame attribution:
  the multi-second walk stalls are **geometry/texture UPLOAD during streaming + decode/GC**, NOT
  shader compiles (shaders are 1-7 programs/frame and already prewarmed by `bake_prewarm.js`). The
  worst frame (5159 ms) had zero shader/geom/texture change. **No #12 code shipped (correctly).**

### What SHIPPED (client behaviour)
- `scene3d/entities.js`: **`?entityReapBudgetMs=N` (default 3, DEFAULT-ON)** — continuous,
  most-stale-first, time-budgeted entity reap (mirrors the governor's `parkDisposeBudgetMs`);
  identical end-state, only smoother dispose. Escape `=off`. **`?entityReapRadius=N` (default 8,
  OPT-IN)** — tighter entity keep-window; NOT defaulted (needs eye-test; see residuals).
- `scripts/net-review/battery-outdoor-run.mjs`: added an `entGeom` field to the FULL sampler
  (entity roots / meshes / distinct geoms / unique wcids) — additive telemetry.
- New probes: `geom-census.mjs` (per-`(model,part,surface)` geometry duplication census + entity
  census), `walk-entgrowth.mjs` (1070 CDP corridor walk w/ nudge-on-stuck + per-frame **bigFrames**
  attribution of Δprograms/Δgeoms/Δtextures).

---
## 1. REMAINING TASK LIST — recreate in the task system (session-local; does NOT survive /clear)
Dependency-ordered. Most of the old 19 are now closed or void; these are what's left.

**Real latency lever (re-scoped from #12) — the measured win**
- **#20 [design+build] Per-frame streaming-attach / upload throttle.** The dominant walk stalls are
  geometry/texture UPLOADS (frames uploading +100…+417 geoms). `renderer.compile()` in
  `bake_prewarm.js` defers the shader *link* but uploads *synchronously*, and many bakes attach in
  one frame. Cap the number of baked LB subtrees (and their geom/texture upload) attached per frame;
  spread bursts. `bake_prewarm.js` cites a `PLAN-goal1-drawdistance-streaming-throttle` — extend it
  to rate-limit the *upload*, not just the link. *blockedBy: none.* (See RESULTS-task12 §"actual levers".)
- **#21 [measure] Attribute the 5159 ms decode/GC frame.** No p/g/t change → major GC vs synchronous
  wasm decode vs bake-worker main-thread fallback (console tell: `[bake_worker_client] … main-thread
  fallback`). If GC, cut per-burst allocation churn; if decode, ensure the worker (not fallback) runs.
  *blockedBy: none.*

**Small, safe, JS-only wins**
- **#14 Emit LOD `bandHits/bandMisses`.** `scene3d/diag/lod.js:73-94` — `onBandHit/onBandMiss` are
  defined + increment counters but are **never called**; three.js `LOD.update()` selects bands
  internally at render, so pick the observable call site (per-frame LOD band read) and emit them.
  Pure telemetry, unblocked. *blockedBy: none.*
- **#4-lite Route the ~20 non-atlased static identities through the static atlas** (or a shared
  per-`(modelId,surfaceDid)` geometry map). JS-only, ≤~30 geoms reclaimed at a bounded town — small
  but clean. *blockedBy: none.* (Downscoped from the old #4; the Rust #3 is DROPPED.)
- **#5 verify** the #4-lite change flattens the ~20 static identities to 1 geom each on a battery
  slice. No wasm rebuild needed. *blockedBy: #4-lite.*

**Validation / gated on the above**
- **#19 Full post-fix battery + A/B** vs the two governor baselines, quantifying #20/#21/#14.
  *blockedBy: #20, #21, #14.*

CLOSED this session (do NOT recreate): #2 (done), #3 (DROPPED — memo already solves decode),
#11a (done+corrected), #11b (done — reap flags shipped), #12 (investigated, premise disproven →
became #20/#21), #13 (moot). #6/#7/#8/#10 tooling were done in the `-2` session.

---
## 2. RESIDUALS — partial / un-validated / deferred (read before trusting anything)
- **`?entityReapRadius=3` is OPT-IN, NOT defaulted.** The r=8→r=3 A/B was **spawn-noise-confounded**
  (baselines 2540 vs 670) — directional only (peak 1636 vs 3875, continuous vs bulk reap). Before
  defaulting it: (a) 3-4 **paired** corridor runs per radius, and (b) a **live eye-test for creature
  pop-out at distance** (headless can't judge). Default stays 8 until both hold.
- **`?entityReapBudgetMs=3` IS default-on but only marginally validated.** Median frame 69 vs 103 ms;
  worst-frame + longtasks were noise-dominated (the real stalls are elsewhere). It's harmless
  (identical end-state, escape `=off`), but its *benefit* is small. If any regression, flip to `off`.
- **Single-run A/B noise.** Entity population is nondeterministic per boot (spawn/backlog timing);
  never trust one run — pair arms with the SAME baseline (walk-corr-r8/r3 were unpaired; the
  budget-off/on and attrib runs were paired at 660).
- **The `-2` handoff's #4/#11/#12 framing is now wrong.** Believe the RESULTS docs over it.
- **Battery driver 1070 corridor land is broken** (`teleOk=false` — its clear-start land-detection,
  NOT the perf work). `walk-entgrowth.mjs` sidesteps it (teleloc to `clearStart` + nudge). Fix the
  battery's land detection before relying on `battery-outdoor-run.mjs --mode cdp` for #19.
- **`static_atlas.js:334` BatchedMesh grow-never-shrink** remains untouched (an untracked heap
  contributor; lower priority than #20 since heap is terrain-dominated and bounded).
- **Lint:** 3 pre-existing unused-var warnings in `entities.js` (IDLE_FIDGET_CHECK_INTERVAL_MS,
  childGuid, pesId) — NOT introduced by this session's edits.

---
## 3. How to run the harness (hard-won; costs hours otherwise)
### 3a. Local stack (verify up): ACE `ss -ulpn | grep :900`; serve.py `:8765` (live JS tree, `?nosw=1`
enough for JS edits, no build); ws-bridge `:8080`. Account single-login `tailnet1`.
### 3b. 1070 real-GPU CDP (authoritative for fps/frames):
1. On 1070 (`young@100.127.215.75`): `ssh … 'schtasks /create /tn cdpwb /tr C:\Temp\launch-wls.bat
   /sc once /st 00:00 /it /f & schtasks /run /tn cdpwb'` (bat + off-screen GPU Chrome exist).
2. Tunnels (laptop): `ssh -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 young@…` **and**
   `ssh -fN -R 8080:127.0.0.1:8080 young@…`. ⚠ `-R 8080` REQUIRED. If a stale 9333 tunnel exists,
   the `-L 9333` bind fails and takes `-R 8765` with it — bring up `-R 8765` separately.
   Assert `UNMASKED_RENDERER` contains `GTX 1070 … Direct3D11`.
3. Walk + measure: `node scripts/net-review/walk-entgrowth.mjs <out.json> <runS>`; env
   `WALK_QUERY="entityReapBudgetMs=off"` (etc.) for A/B arms. **≥60-90 s grace between arms**
   (40 s → "Account In Use" / NOT-in-world; hit twice this session).
### 3c. Analysis: the probe writes `samples[]` (entGeoms/entRoots/terr/riGeoms/maxFrameMs/lt) +
`bigFrames[]` (Δp/g/t per >250 ms frame — the attribution). Cragstone `clearStart` corridor =
2110 m; nudge-on-stuck (turn on <1 m/tick) got lbsVisited 6 → 88.

## 4. Guiding principle earned this session
**Measure before you build, and verify your own measurement.** Three planned "levers" (#4/#11/#12)
were already handled by shipped systems; two of my own first-pass readings (entity "unbounded
growth", "shader-compile stalls") were artifacts that a proper corridor walk + frame attribution
overturned. Trust the RESULTS docs; re-verify agent/handoff premises against a paired 1070 run.
