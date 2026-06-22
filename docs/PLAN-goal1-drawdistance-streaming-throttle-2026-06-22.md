# PLAN — Goal 1: draw-distance streaming throttle (2026-06-22)

> **⚠ EMPIRICAL UPDATE (1070 headless real-GPU probe, 2026-06-22) — read first.**
> The implemented Item 1 (`?pvsStreamQueue`, default-ON) + Item 2a (lbCap headroom) +
> raised `pvsRingRadius` clamp (≤12) were validated on the GTX 1070. **The result reframes
> the goal:** at `pvsRingRadius=10` the fill stall is **CPU-compute-bound (synchronous wasm
> decode/subdivide ~33–58 % + shader-program link ~20–32 %), not fetch-concurrency-bound**
> (fetch ≈ 3–5 % of CPU; CPU 96–98 % busy). The fetch flood (≈1.7–2.0 k shard req, peak
> concurrent **172**) is **unchanged** by the bake-start queue, exactly as the critique
> predicted. So **Item 1 does NOT make r10 interactive, and Item 2b (fetch semaphore) is NOT
> the next lever** — the effective lever is **Item 4 (frame-budget the synchronous per-bake
> instantiation) + async/pre-warmed shader compile**. Full numbers + caveats: see
> **"Empirical validation"** at the end. Item 1 stays (correct, harmless, improved the
> worst-case frame 60 s → 9.7 s, and safely unlocks larger draw distance), but it is a
> prerequisite, not the fix.

Implementation plan for **Goal 1** of `docs/HANDOFF-perf-drawdistance-and-textures-2026-06-22.md`:
increasing draw distance (`pvsRingRadius`) floods the per-landblock fetch+bake pipeline
and stalls the **main thread**; the GPU is never the limit. This plan was produced by a
multi-agent code-mapping + adversarial-critique pass over the actual code; every anchor
below was read, not assumed.

> Scope: **OUTDOOR** draw-distance streaming only (terrain + statics + buildings + spawns
> via the PVS ring). The EnvCell interior/dungeon load path (`cells.js:172`
> `buildEnvCellsForLandblock`) bypasses the stream guard entirely and is **out of scope**.

---

## Current architecture (path trace)

Draw distance = `scene3d.pvsRingRadius` (default **5** = 11×11; wired from `?pvsRingRadius=N`
at `index.js:2398` ← `PVS_RING_RADIUS` `index.js:203`). Every rAF frame, `loop.js` calls
`tickPvsLoadExpansion(scene3d, sessionHandle)` (`cells.js:1031`), which:

1. reads the wasm visibility set `getRenderSet(1)` (`cells.js:1057`) — **outdoors this
   collapses to the single player LB-key** (`cells.js:1066-1079`); the cell-portal graph is
   indoor-only, so `pvsRingRadius` *is* the outdoor streaming horizon, not a perf guard;
2. builds a fire signature and short-circuits if unchanged (`cells.js:1119`);
3. expands `seen` into the full `(2r+1)²` ring (`cells.js:1122-1135`) — **121 LBs @ r=5,
   ~441 @ r=10, 1,089 @ r=16**;
4. for each new ring LB (capped path `cells.js:1186-1245`), sorts by Chebyshev distance and
   calls `fireOne(lbKey)` (`cells.js:1140-1176`) for at most **K=4** *new* LBs/frame.

`fireOne` fire-and-forgets three hooks `loadTerrain/Statics/Buildings`
(`index.js:2585/2658/2690`), each wrapping a real baker in `_guardedStreamBake` →
`guardedStreamBake(state, …)` (`stream_bake_guard.js:52`). The bakers issue the actual HTTP
fetches on the **main-thread wasm instance**, decode/subdivide synchronously, build
`BufferGeometry` and `THREE.DataTexture(...).needsUpdate=true` (`adapter.js:904-1028`), then
the GL upload is deferred to first bind — **all main-thread** (`WebGLRenderer` on the page
canvas, no OffscreenCanvas, `index.js:568`).

**Two pacing layers exist, neither bounds total network fan-out:**
- `PVS_BAKE_CAP` K=4 (`cells.js:71`, `?pvsBakeCap`) — bounds *new bakes started per frame*.
- Stream guard global `STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT=6` (`stream_bake_guard.js:33,80`) —
  bounds *concurrently-running guarded bakes* across all keys. **This is the only true
  concurrency ceiling on the bake layer.** Per-`(kind:lbKey)` in-flight dedup + a 2.5 s
  failure cooldown sit above it (`stream_bake_guard.js:67-91`).

Below the bake layer, the **real network ceiling** is in Rust: each baker's wasm call does
one batched `prefetch(keys)` then fans uncached shard GETs via `try_join_all`, gated by a
per-source counting **`Semaphore` = `DEFAULT_FETCH_CONCURRENCY` 32**
(`concurrency.rs:37`), overridable at runtime via `globalThis.__hbFetchConcurrency`
(`manifest_source.rs:63-78`). `fetch_bytes` uses bare `window.fetch` with **no
AbortController — fetches are not cancellable** (`http.rs:44`).

## Root cause (precise)

At high `pvsRingRadius` the ring expansion (`cells.js:1122-1135`) yields `(2r+1)²` LBs ×
3 domains. The capped fire loop re-enters **every frame** (signature held `null`,
`cells.js:1244`) starting K=4 new LBs/frame nearest-first. Because fill rate is K-per-frame
and frames stay slow while bakes run, a large ring takes hundreds of frames to drain;
across those frames the cumulative bakes issue thousands of shard GETs. The existing
**bake-cap doesn't help** — it gates *starts/frame*, not *total outstanding work*, and
re-fires forever until drained. The **F3/ring time-slice doesn't help** — it only spreads
synchronous *instantiation* across frames (`terrain.js:3535-3571`), never bounding fetch
count or concurrency. The stress-arm-B symptom (1,465 fetches, 35 s main-thread Script time,
0.2 fps) is the cumulative flood of bakes whose fetches outlive each frame.

> **Critique correction — read this before sizing the fix.** A JS-side bake-start queue
> bounds **bake STARTS**, not **total FETCHES**. Once a baker's `run` thunk enters wasm it
> does one batched prefetch + `try_join_all` over all its uncached shards in a single await —
> **JS cannot meter, reorder, or cancel the shard fetches inside that await.** The only thing
> bounding concurrent *network* is the Rust 32-permit semaphore (shared across
> terrain/statics/buildings/scenery/spawns/surfaces on the one main-thread source). So the
> fix is **two complementary levers**:
> 1. **JS bake-start queue** (Item 1) — converts `pvsRingRadius` from an *instantaneous-
>    request multiplier* into an *eventual-coverage* parameter, and bounds how many bakes'
>    fan-outs are live at once.
> 2. **Rust semaphore tuning** (Item 2b) — the actual concurrent-network ceiling; lower it
>    and/or budget per-domain.
>
> Do **not** target "peak ≤18 fetches" — intra-bake shard fan-out makes that unreachable.

## Baseline caveat (re-probe before/after)

The 1,465-fetch / 35 s / 0.2 fps numbers are from stress arm B only; **arms A & C never
logged in** (tailnet1 "Account In Use" ghost) so there is no clean vanilla baseline, and the
"worker-message churn" phrasing in the handoff is spurious — the bake worker is **default-off**
(`bake_worker_client.js:45-55`, zero `configureBakeWorker` callers), so there is no worker
traffic in the baseline. Re-run the 3-arm probe (with the ghost-login guard) to anchor a
trustworthy before/after.

---

## Work items (ranked by impact-per-risk)

### Item 1 — Bound *bake starts* with a bounded distance-priority queue *(first PR)*

**What.** Replace the K-new-per-frame start cap with a single bounded priority work-queue in
`tickPvsLoadExpansion`: enumerate the ring (unchanged), compute Chebyshev distance per LB,
feed not-yet-baked LBs into `scene3d._pvsBakeQueue`, and each frame drain the nearest items
only while a slot is free. Distance-prioritization (handoff #2) is intrinsic to queue order,
so handoff #1 + #2 are one change.

**Why it helps the measured symptom.** Today K=4 starts/frame *compound* across hundreds of
frames because skipped starts silently retry and the ring is re-enumerated each frame. A
queue that holds the full pending set **once** and releases new bakes only as in-flight slots
free makes ring radius set *eventual* coverage with a *fixed bake-start ceiling* regardless
of radius — the handoff's stated lever. It does not by itself cap network (see Item 2b).

**Files + anchors.**
- `cells.js:1186-1245` — replace the K-new loop + `_pvsLastFireSig` hold with: build
  `ringArr` (reuse the distance sort `cells.js:1207-1222`), diff via `isNewBake`
  (`cells.js:1193-1203`), enqueue new LBs into `scene3d._pvsBakeQueue`. Keep enumeration
  `cells.js:1122-1135` and `fireOne` `cells.js:1140-1176` unchanged.
- New drain helper: each frame, **while `state.inFlight.size < targetInFlight` and queue
  non-empty**, pop nearest and `fireOne`. Read the guard's in-flight `Set` directly
  (`stream_bake_guard.js:38`).
- `stream_bake_guard.js:33` — leave `maxInFlight=6` as the hard backstop; the queue's
  `targetInFlight` is a **separate** knob so the queue paces issuance.

**Concrete mechanics & subtleties (from critique).**
- **Re-check `inFlight.size` after *each* `fireOne`, not per-LB-batch.** One `fireOne`
  enqueues up to 3 guarded bakes (terrain+statics+buildings = 3 distinct guardKeys added
  synchronously, `stream_bake_guard.js:82`), so a single dequeue can jump `inFlight.size` by
  3 — a per-LB loop condition overshoots `targetInFlight` by up to 2.
- **Cooldown skip + livelock guard.** Dequeue must skip LBs whose `(kind:lbKey)` is in
  `state.failUntil` cooldown and advance to next-nearest, so a single dead/cooling cell never
  blocks the ring (flaky-tunnel livelock).
- **All-remaining-cooling branch.** If every queued LB is cooling down (drain dequeues
  nothing) the queue is still non-empty → keep `_pvsLastFireSig = null` so the tick re-enters
  after the 2.5 s window. **skipped ≠ done.**
- **Unsigned keys.** Use the `>>> 0` unsigned `lbKey` from `lbKeyOf` for all distance math
  (the pvs-signed-key footgun; `(x>>>24)` extraction must be unsigned-safe).

**Risk / invariants it must NOT break** (all four failure modes confirmed in the map):
- **mark-baked-before-fetch poison (A1–A4):** queue/in-flight state must live in a
  **separate** structure (`_pvsBakeQueue` + the guard's `inFlight` Set), **never** the
  per-domain baked-Sets (`terrainBakedLbs` etc.). Those Sets are written only *after*
  fetch+drain succeed (preserved — we don't touch bakers: `statics.js:1503-1520`,
  `buildings.js:629-820`). A queued-then-evicted LB never touches its baked-Set → stays
  retryable.
- **skipped ≠ done:** mark `_pvsLastFireSig` complete only when the queue is empty AND
  `isNewBake` is false for every ring LB (`cells.js:1241-1245`).
- **LRU evict hook:** `landblock_lru.js:385-398` clears baked-Sets on evict — **add a hook to
  also remove the evicted lbKey from `_pvsBakeQueue`** (else a re-entered evicted LB sits
  stale-queued). The guard's `finally{}` already clears `inFlight`.
- **far-LB liveness:** rebuild the queue per LB-crossing and re-include any still-unbaked ring
  LB so a mid-distance LB the player passes is re-enqueued — never permanently dropped.

**Coexistence with the second fire path.** `index.html:3634-3656` is a *second*, independent
caller (position-update handler) firing a 3×3 terrain ring + 1-LB statics/buildings on every
position update — **confirmed non-scaling** with `pvsRingRadius` (O3). It shares
`_streamGuardState`, so its bakes count against `inFlight.size` that the queue reads. This is
correct: the immediate 3×3 neighborhood wins slots, and the PVS queue only drains *spare*
slots. The queue is therefore correctly PVS-tick-owned; no cap needs to move into the guard.

**Boot-ring blind spot (note, not blocker).** The radius-6 boot ring
(`bakeTerrainRing/StaticsRing/BuildingsRing`) calls bakers **directly**, bypassing the
guarded hooks, so the queue's `inFlight` reading does not see boot work and could briefly
over-issue during boot. Bounded (boot is Holtburg-only) — acceptable for the first PR; revisit
if boot regresses.

**Effort: M.**

### Item 2a — Couple `lbCap`/eviction to runtime `pvsRingRadius` *(ship with first PR)*

**What.** `lbCap` (LRU `maxResident`) is computed **once at init** from the max of the boot
radii (`index.js:3626`). At r=10 the working set is ~441 LBs but boot radii are 6, so without
`?lbCap=600` the LRU evicts visible ring LBs → evict↔re-bake thrash (the code warns at
`index.js:201-202`). Raise the floor: `lbCap = max((2*PVS_RING_RADIUS+1)² + headroom, 32)`
(headroom ≈ +24). Keep `?lbCap=N` override (`index.js:3631-3632`). No new flag — it only
*raises* the eviction floor.

**Risk.** Don't set so high eviction never fires under sustained roaming (memory growth). Keep
it `ring working set + small headroom`, not unbounded. **Effort: S.**

### Item 2b — Tune the Rust fetch semaphore (the real network ceiling) *(measure-first)*

**What.** The actual concurrent-network ceiling is the 32-permit semaphore
(`concurrency.rs:37`), shared across all domains on the one main-thread source. A terrain
ring burst competes for the same 32 permits as entity-surface fetches (the exact F1 stutter
the cap was tuned against). After Item 1, re-probe peak concurrent network; if still high,
**lower `globalThis.__hbFetchConcurrency`** (already a runtime hook, `manifest_source.rs:63-78`)
and/or introduce **per-domain budgeting** (terrain wider than statics). This is the lever that
actually bounds the 1,465-fetch flood that Item 1 alone cannot.

**Risk.** Too low starves entity-surface fetches → stutter. Tune on the 1070, not blind.
**Effort: S (knob) / M (per-domain budget).**

### Item 3 — Enable the bake worker (move decode off-main) *(deferred, gated on O1)*

The worker (`bake_worker.js:50-60`) is fully built but **default-disabled**
(`configureBakeWorker` has zero callers). It would move `surface_classify`/`normal_gen`/DXT
decode off-main — but the measured stall is fetch-flood at ~22 % CPU, **not** decode CPU, and
the worker does **not** remove the dominant main-thread cost (geometry build + `DataTexture`
creation + GL upload stay main-thread, single GL context). It also spins a **second wasm
instance + second manifest fetch** (memory cost on the 8 GB laptop) and MEMORY notes
"bakeWorker NULL/slower" (`project_holtburger_load_perf_2026-06-06`). **Terrain subdivision
does not route through the worker at all** — only model meshes + surface pixels do. Defer; if
pursued, default-on only behind a flag and validate on the 1070. **Effort: M (mostly
validation risk).**

### Item 4 — Frame-budget the GPU upload / scene-graph hand-off *(deferred)*

When a burst of queued bakes complete in one frame, their geometry builds + `DataTexture`
creations land together → one heavy upload frame that can re-trip the watchdog. Budget the
*post-fetch instantiation* (mirror the `setTimeout(0)` macrotask yield from
`terrain.js:3571` — **never** a microtask, rAF won't run between microtasks). **Open
architectural gap:** the hand-off points (`materials.js:2522-2556`, `adapter.js:904-1028`) are
called from inside each baker's async body, **not** a single rAF-driven drain, so a cross-bake
per-frame budget has no existing chokepoint — needs a small instantiation scheduler. Defer
until Items 1+2 land and a re-probe shows upload-frame spikes survive. **Effort: M.**

---

## Recommended first PR

**Item 1 + Item 2a**, flag-gated default-ON:
- New flag **`?pvsStreamQueue`** (default-ON; `=off` restores the legacy `PVS_BAKE_CAP`
  K-per-frame path; integer `?pvsStreamQueue=N` overrides `targetInFlight`, default
  N = `STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT` = 6).
- Item 2a's `lbCap` floor in the same PR (2-line change, required so r=10 doesn't thrash;
  no separate flag — only raises the floor, `?lbCap=N` still overrides).

This is the smallest change that converts radius from an instantaneous-request multiplier
into an eventual-coverage parameter while respecting all four failure-mode invariants
(verified: baked-Sets written only after fetch+drain; queue state kept separate; LRU evict
hook; skipped ≠ done). **Treat Item 2b (semaphore) as the immediate follow-up** — Item 1
alone bounds bake starts but not the raw fetch count.

## Validation plan (1070 real-GPU, off-screen/headless)

Re-run the probe (`/mnt/wbterminal1/tmp/claude-scratch/terrain-realism/hb-perf-probe.cjs`)
with the ghost-login + worker-aware fixes from the handoff's "Re-probe" section, `?nosw=1`,
off-screen per the never-on-screen rule. A/B `?pvsStreamQueue` default vs `=off` at
**arm B `?pvsRingRadius=10&lbCap=600`** (also re-capture a clean arm-A vanilla baseline).

Metrics (baseline arm B = 1,465 fetches, 35 s Script time, 0.2 fps):
- **Bake starts in flight** — bounded by `targetInFlight` (≈6 bakes) regardless of radius.
  *(Primary metric Item 1 controls directly.)*
- **Peak concurrent network** — bounded by the 32-permit semaphore (Item 2b lever), **not**
  ≤18; report the real number and decide whether to lower the semaphore.
- **Total fetches over the roam window** — should approach *eventual* coverage (~441 LBs ×
  domains spread over time), not 1,465 near-simultaneous.
- **Main-thread Script time** — well under 35 s (CPU was only ~22 % busy).
- **Frame time / fps** — interactive (≥30 fps steady) while the ring fills progressively;
  visible trickle-in over a few seconds is the intended trade.
- **Liveness** — roam far from Holtburg: no permanent barren patch behind the player, no
  evict↔re-bake thrash (`?lbLruDebug=1`, `index.js:3766`).
- **Watchdog** — `window.__lastPumpMs` stays fresh (pumpAge 1–8 ms), no >4 s stalls
  (`index.html:8517-8550`).

## Open questions to resolve before/while coding

- **O1 (blocks Item 3, not Item 1):** Is the bake worker a regression? Confirm on the 1070
  before defaulting it on; MEMORY says "bakeWorker NULL/slower".
- **O2 (shapes Item 1 `targetInFlight` + Item 2b):** The 32-permit semaphore is shared across
  all domains. `targetInFlight=6` × up to 3 domains × multiple shard GETs each could still
  approach 32. Decide `targetInFlight` value and whether to budget per-domain.
- **O3 (resolved):** Position-update fire path is 3×3/1-LB, non-scaling, shares
  `_streamGuardState` → coexists with the queue (immediate neighborhood wins slots). No action.
- **O4 (Item 1 eviction):** Eviction while queued must clear the `_pvsBakeQueue` entry —
  insertion point `landblock_lru.js:385-398` alongside the baked-Set clears +
  `_evictSpawnsInjectedLb`.

---

## Confirmed anchors (spot-checked against the tree)

`cells.js:71` `PVS_BAKE_DEFAULT_K=4`; `cells.js:1119` sig short-circuit; `cells.js:1178`
uncapped path; `cells.js:1186-1245` capped path / `isNewBake` / hold; `cells.js:1122-1135`
ring expansion; `cells.js:1140-1176` `fireOne`. `stream_bake_guard.js:33` `MAX_IN_FLIGHT=6`,
`:67` dedup, `:80` global cap, `:82/:105` add/clear. `index.js:2398` `pvsRingRadius` wire,
`:3626` `lbCap` derivation, `:2585/2658/2690` hooks. `manifest_source.rs:63-78`
`__hbFetchConcurrency`; `concurrency.rs:37` `DEFAULT_FETCH_CONCURRENCY=32`; `http.rs:44`
no-AbortController fetch. Failure-mode fixes: `terrain.js:3439-3452`/`:2809` (A1),
`statics.js:1503-1520` (A2), `buildings.js:629-820` (A3), `spawns.js:808-851` (A4),
`index.html:8517-8550` (watchdog hold), `landblock_lru.js:385-398` (evict clears).

---

## Empirical validation (1070 headless real-GPU, 2026-06-22)

Headless Chrome on the GTX 1070 (real GPU: `ANGLE NVIDIA GeForce GTX 1070 D3D11`,
off-screen per the never-on-screen rule), app served live from the laptop via the
`-R 18765` reverse tunnel (so the running edits were under test). Account `tailnet1`,
`quality=high`, all three arms spawned **outdoor** at cell `0xA9B40019` (so the
`pvsRingRadius=10` ring genuinely expands). All arms share `pvsRingRadius=10&lbCap=600`;
the **only** variable is `pvsStreamQueue`. Metrics sampled over a 35 s window starting at
in-world. Probe: `/mnt/wbterminal1/tmp/claude-scratch/terrain-realism/goal1-probe.cjs`.

| arm | `pvsStreamQueue` | avg fps | worst frame | shard req | peak concurrent | CPU busy | wasm % | shader `(program)` % |
|---|---|---|---|---|---|---|---|---|
| `B-r10-qOFF` | off (legacy K=4) | 1.8 | **60.4 s** | 1671 | 172 | 98 % | 58 % | 21 % |
| `B-r10-qON` | on, target 6 (default) | 4.9 | 9.7 s | 1863 | 172 | 98 % | 56 % | 23 % |
| `B-r10-q3` | on, target 3 | 4.8 | 9.7 s | 1957 | 172 | 96 % | 33 % | 32 % |

**Robust findings (clean across arms):**
1. **The fill is CPU-compute-bound, not fetch-bound.** CPU 96–98 % busy; cost = wasm
   decode/subdivide (33–58 %) + shader-program link (`(program)` 20–32 %); `fetch` is only
   ≈3–5 %. This **contradicts the handoff's "~22 % CPU / fetch-flood + microtask churn"
   premise** — on real hardware the main thread is saturated by *synchronous bake compute*.
2. **The bake-start queue does not reduce the fetch flood.** Shard req (1671/1863/1957) and
   peak concurrent (172 on all) are essentially unchanged by the queue / its target — the
   Rust 32-permit semaphore (not the JS queue) is the network ceiling, and 172 ≫ any
   `targetInFlight`. Confirms the critique: Item 1 paces *starts*, not *fetches*.
3. **r10 is not interactive with Item 1 alone** — all arms sub-5 fps with multi-second
   stalls during fill, because the binding constraint (per-bake synchronous compute) is
   untouched by start-pacing.

**Suggestive (confounded — treat with caution):** `qON`/`q3` improved the worst-case frame
(9.7 s vs `qOFF`'s **60.4 s** single synchronous frame) and avg fps (4.9/4.8 vs 1.8). But
`loadMs` varied 8.8 s (`qOFF`) → 42 s (`q3`), so the 35 s window samples different points in
each arm's bake lifecycle — the avg-fps delta is *not* a clean controlled comparison. The
one robust asymmetry is that the queue arms never produced a >10 s frame while `qOFF` hit a
60 s one (consistent with the queue preventing a mega-batch of starts in one frame).

**Measurement gaps to fix in the next probe:** (a) `guard.peakInFlight` read 0 on every arm —
`window.liveScene3d._streamGuardState` is likely not the same object the active bake hooks
populate (or the Set clears between samples), so the bake-start ceiling was **not** directly
verified; (b) the fill window must be anchored to a fixed wall-clock from `goto` (not from
in-world) so arms with different `loadMs` are comparable; (c) `Performance.ScriptDuration`
returned 0 for `qOFF` (CDP timing anomaly during its 60 s frame).

**Revised next lever (was Item 2b → now Item 4 + shader):** because fetch is only ~4 % of
CPU, lowering the fetch semaphore (Item 2b) will *not* recover frame time. The effective
work is **Item 4 — frame-budget the synchronous per-bake instantiation** (geometry build +
`DataTexture`/material creation + the shader-program link), spilling overflow across frames
with a `setTimeout(0)` macrotask budget so no single frame does a 9.7 s (or 60 s) block —
**plus** addressing the shader-compile cost (async compile / material pre-warm; the
`(program)` 20–32 % is `getProgramInfoLog`/link, the same class as the known light-pool
relink + two-pass-compile work). Item 1 + 2a + the clamp bump remain shipped as the
prerequisite (they unlock the larger radius safely and cut worst-case start bursts), but the
draw-distance goal is **not met** until the per-bake compute is frame-budgeted.

## Item 4 SHIPPED + validated (1070 headless A/B, 2026-06-22)

**Implemented** (working tree, JS-only): `scene3d/bake_prewarm.js` (`?bakePrewarm`,
default-ON) + `compileAsync` pre-warm before attach in `terrain.js` (per-LB mesh),
`buildings.js` (per-LB Groups batched), `statics.js` (post-batch nodes, with a residency
re-check after the await since statics time-slices). Mirrors the EnvCell prewarm. Safe: the
per-LB bakers aren't LRU-tracked until they resolve + the stream guard holds the in-flight
key, so terrain/buildings can't be evicted across the new await (no re-check); statics
re-checks + disposes on bail.

**A/B** (both r10 + queue-on; only var = `bakePrewarm`; loadMs 8.6 s vs 9.2 s, comparable):

| metric | `prewarmOFF` | `prewarmON` (Item 4) | effect |
|---|---|---|---|
| worst frame | **57.0 s** | 9.1 s | **−84 %** (no catastrophic freeze) |
| total stall-time (Σ frames >50 ms) | 83.7 s | 46.9 s | **−44 %** |
| avg fps (50 s window) | 1.8 | 4.6 | +2.5× |
| LBs baked in window (geometries) | 405 | **745** | +84 % throughput |
| CPU busy / wasm | 99.8 % / 95 % | 99.8 % / 95 % | unchanged |

**Verdict: Item 4 is a real, keep-worthy win** — it eliminates the catastrophic 57 s
synchronous mega-frame (the whole ring's compile+upload dumped into one task), cuts total
stall-time ~44 %, and *increases* fill throughput (the `compileAsync` await yields, so bakes
spread across frames and more LBs complete). But it does **not** make r10 interactive
(4.6 fps), because of a **newly-revealed dominant cost**:

> **The fill is dominated by `holtburger_manifest::catalog` ≈ 71 % of CPU** (early-fill
> profile; wasm 95 %). This is the per-shard catalog resolution + **sha256 verification** in
> the manifest source (v2 catalog mode), scaling with the ~1.4–2.2 k shard fetches at r10.
> Shader `(program)` link was only ~2 % in this (early-fill) phase — the 20–32 % seen in the
> prior run was a *later* phase. So neither shader prewarm (Item 4) nor fetch concurrency
> (Item 2b) is the binding constraint at the fetch-issue phase: **the manifest catalog/verify
> CPU is.**

**Revised next lever (was Item 4 → now manifest catalog + Item 3):**
1. **Cut the `holtburger_manifest::catalog` per-shard CPU** — the biggest single lever. Read
   `crates/holtburger-resource-http/src/manifest_source.rs` catalog mode: likely the
   **sha256 verification over every shard's bytes** (×~2 k). Options: skip/disable verify
   (trust transport), verify off-main, memoize, or **reduce shard count** (coarser packing /
   bigger shards for distant LODs so r10 issues far fewer fetches).
2. **Item 3 (worker decode off-main)** — moving the bakers' wasm fetch+decode (incl. the
   catalog work for model-mesh/surface paths) to the bake worker relocates this CPU off the
   render thread. Note terrain subdivision does *not* route through the worker today.

Item 4 ships default-ON as a genuine improvement; r10 interactivity now hinges on the
manifest-catalog cost, not on shader/fetch-concurrency.

## CORRECTION — `__hbVerifyShards` A/B + fresh wasm build (1070, 2026-06-22)

Implemented a `__hbVerifyShards` toggle (default-ON) gating the per-shard sha256 verify in
both v2 (`manifest_source.rs:590`) and v1 (`manifest_source_v1.rs:138`) — found at
`shard_verify_enabled()`. Rebuilt the wasm (`capped-build wasm-pack --release`, 4m32s, toggle
confirmed embedded) and ran the verify A/B (both r10 + queue + prewarm on; only var = verify):

| metric | verifyON (default) | verifyOFF | 
|---|---|---|
| worst frame | **75.2 s** | 7.3 s |
| LBs baked in window (geom) | 405 | **1066** (2.6×) |
| shard req in window | 1422 | 2486 |
| avg fps | 10.8 | 7.8 |
| CPU busy / idle | 51.6 % / **48 %** | 52.8 % / 47 % |
| top CPU | `(program)` 9 %, wasm[682] 9 %, fflate inflate 4 %, getImageData 3 % | `(program)` 18 %, fetch 7 %, wasm 4 % |

**Two findings, one of which corrects this doc:**
1. **verify-skip helps (real signal):** verifyOFF avoided verifyON's catastrophic **75 s**
   synchronous frame (max 7.3 s) and baked **2.6× more LBs** + processed 75 % more shards in
   the same window. The 75 s frame is consistent with Step-E's synchronous sha256 loop over a
   whole `try_join_all` batch resolving at once — verify-skip removes that burst component.
2. **⚠ The "71 % `holtburger_manifest::catalog`" was largely a PROFILER PHASE ARTIFACT.** On
   the fresh build the CPU is only **~52 % busy (≈48 % IDLE — half network-bound)** with cost
   **spread** across shader link (`(program)` 9–18 %), **inflate decompression** (fflate),
   **image decode** (`getImageData`), and wasm — **no single 71 % dominator**. The earlier 4 s
   profiler snapshot happened to land in a pure-compute catalog/verify burst. So there is **no
   single silver-bullet hotspot.**

**True shape of the r10 stall:** *bursty* — long network-wait phases (~half idle at peak
concurrency 172) punctuated by giant synchronous frames when a batch of shards resolves and is
post-processed (sha256 + inflate + decode + bake + shader link) all at once. verify-skip,
Item 1 (pacing), and Item 4 (compile smoothing) each shrink a component; none alone makes r10
interactive.

**Methodology lesson (for the next probe):** the 4 s phase-variable CPU profile + unequal
per-arm work (arms baked 405 vs 1066 LBs) make single-number attribution unreliable and
produced a contradictory profile run-to-run (98 %/71%-catalog vs 52 %/spread). A trustworthy
re-measure needs a **continuous CPU profile over the whole fill** + **equalized work**
(time-to-bake-N-LBs, not a fixed wall-clock window).

**Net for Goal 1:** Items 1 + 2a + clamp + Item 4 + the `__hbVerifyShards` toggle are all
implemented, shipped (working tree, JS + one wasm rebuild), default-ON, and each demonstrably
chips at the stall — but **r10 draw distance is gated by distributed, bursty per-shard/per-LB
costs and is ~half network-bound, not a single fixable hotspot.** Realistic paths: (a) a clean
continuous-profile re-measure to break down the burst; (b) settle on a more modest default
radius (≈6–8) where bursts are tolerable; (c) the deeper architectural fix — process shard
post-processing *incrementally as shards arrive* rather than sha256+decode+bake a whole
`try_join_all` batch in one synchronous frame.

## DEFINITIVE root cause — 3-arm cache-disambiguation (1070, 2026-06-22)

Clean experiment: **fresh Chrome profile per arm** (both cold) + run-to-full-ring-plateau
(equalized work) + continuous whole-fill CPU profile. This kills the cross-arm shader-cache
warming that confounded every prior A/B (arm 2 was always faster because it inherited arm 1's
warm on-disk GL program cache).

| arm (r10, ~1000 geom baked) | profile | fillMs | `getProgramInfoLog` | CPU busy | fps |
|---|---|---|---|---|---|
| `verifyON-cold` | fresh | **163 s** | **65 %** | 89 % | 8.1 |
| `verifyOFF-cold` | fresh | **174 s** | **62 %** | 90 % | 8.3 |
| `verifyON-warm` | reuse arm-1 | — | — | **3 % (97 % idle)** | 60 |

**Two definitive conclusions:**
1. **Per-shard sha256 verify is a NON-FACTOR.** verifyON vs verifyOFF, both cold, are
   identical (163 s vs 174 s — within noise; getProgramInfoLog 65 % vs 62 %). The earlier
   "verify-off 5.8× faster" was **100 % the cold-vs-warm shader-cache confound** (arm order).
   The `__hbVerifyShards` toggle is correct but **does not help draw-distance perf** — keep it
   only if a trusted-CDN deploy wants to skip boot-time hashing; it is not the lever.
2. **The real bottleneck is synchronous shader-program LINK: `getProgramInfoLog` ≈ 63 % of a
   ~165 s cold fill.** `renderer.debug.checkShaderErrors` is never set → defaults to `true` in
   three.js → it calls `getProgramInfoLog` (which FLUSHES + BLOCKS the main thread on the GPU
   link) after every program. The warm arm (programs cached on disk) ran at **97 % idle** —
   confirming this is a **first-load** cost that Chrome's on-disk program cache eliminates on
   reload. (Also why Item 4's `compileAsync` prewarm didn't help enough: with
   `checkShaderErrors=true`, three.js still issues the blocking `getProgramInfoLog`.)

**THE FIX (cheap, JS-only, no wasm rebuild): `renderer.debug.checkShaderErrors = false`**
(`index.js:575`). three.js then skips the synchronous `getProgramInfoLog`/`LINK_STATUS` check,
and (with KHR_parallel_shader_compile + Item 4's prewarm) programs link in the driver
background without blocking. Expected to remove the ~63 %. Flag-gate it (`?shaderErrorCheck=on`
restores three.js's checking for shader development — the only cost of default-off is a broken
shader logs a raw GL error instead of the GLSL info log). Validate on the 1070: re-run cold
with the flag on vs off; `fillMs` should drop sharply and `getProgramInfoLog` should leave the
profile's top.

**Net:** the r10 draw-distance stall is, definitively, **first-load synchronous shader-program
linking** — not fetch concurrency, not manifest/verify, not GPU/VRAM.

## FINAL — `checkShaderErrors` didn't fix it; root cause = slow ANGLE/D3D11 compile (1070, 2026-06-22)

Shipped `renderer.debug.checkShaderErrors = false` (index.js:575, default-off,
`?shaderErrorCheck=on` restores). Cold A/B: it **did not fix the stall** — the block just
**moved from `getProgramInfoLog` (61 %) to `getProgramParameter` (61 %)**, `fillMs` 181 s → 161 s
(marginal). The program **link blocks regardless of the error-check flag.** Kept it anyway
(standard production setting, ~10 %).

Shader-pipeline diagnostic (real renderer GL context, during the r10 fill):

| metric | value |
|---|---|
| distinct programs | **72** (49 early → 72 at full ring) |
| `KHR_parallel_shader_compile` | **present** |
| `MAX_SHADER_COMPILER_THREADS_KHR` | **null** |
| renderer | ANGLE NVIDIA GTX 1070 **D3D11** |

**Definitive root cause:** **slow synchronous shader compilation by ANGLE's D3D11 HLSL backend.**
It's **not** a program-count explosion (only 72), and KHR parallel-compile is exposed but
**`maxThreads=null` → ANGLE/D3D11 compiles synchronously anyway** (that's why `checkShaderErrors`
and `compileAsync` prewarm can't background it — the link blocks in the driver). ~72 complex
programs × ~1.4 s compile+link each ≈ ~98 s of main-thread block. **It's a FIRST-LOAD cost**
(warm arm = 97 % idle; Chrome's on-disk program cache erases it on reload) and **largely
radius-independent** (~49 of the 72 are the base set that compiles at *any* radius; r10 adds ~23).

**No cheap flag fixes it.** Practical options, in order:
1. **Accept the one-time first-load cost** (recommended) — it warms away via the disk program
   cache, so r10 is fast on every visit after the first. Keep the **default radius at 5** (fast);
   treat r10+ as opt-in that's slow once. The shipped Items 1/2a/4/clamp/checkShaderErrors make
   that first load as smooth as it can be.
2. **Trim shader compile cost** — fewer features per program; notably `logarithmicDepthBuffer:true`
   (index.js:578) injects log-z into **all 72** programs. Fidelity tradeoff; also helps the base
   boot cost. Real work.
3. **Pace program/material creation** — ensure ≤1–2 new programs compile per frame so the ~75 s
   mega-freeze becomes a series of ~1.5 s stalls (interactive-ish, no watchdog trip). Doesn't
   speed the total, just smooths it. Moderate work in materials.js / the bake instantiation.

**Bottom line for Goal 1:** the draw-distance ceiling is **ANGLE/D3D11 first-load shader-compile
throughput**, which is environmental (the GPU driver's HLSL compiler), not a code hotspot we can
flag away. Everything shipped (Items 1/2a/4 + clamp→12 + checkShaderErrors=false + `__hbVerifyShards`)
is correct, default-on, and improves the margins — but a *fast* cold r10 needs a shader-complexity
reduction (option 2) or is accepted as a one-time/opt-in cost (option 1).
