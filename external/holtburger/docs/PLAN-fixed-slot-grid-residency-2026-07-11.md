# PLAN — fixed-slot grid residency + park time-retention (`?fixedGrid`) — 2026-07-11 (s13 design doc, build S15)

> **STATUS BANNER (ST7 landing, 2026-08-09 — pass-09 S7.3 register row, T20).**
> This plan is HISTORICAL. What it designed was built, validated, and then
> GENERALIZED: the S15b/S15c `?fixedGrid` terrain grid shipped default-ON at
> radius 1 (S16 flip 2026-07-11, user 1070 sign-off), and at ST7 its core
> (shift-in-place slots, integrity detectors, EdgeParkScheduler hysteresis)
> became the seed of the full residency authority —
> `scene3d/residency_grid.js` (`?slotGrid`, SPEC.md §1.4 / §3 T20, pass 6
> D-06.1..D-06.10): tile-granular W_T=6, 36 slots covering the 11×11-LB ring,
> PackStore pins, pressure ladder, grid→legacy-producer adapter, legacy LRU
> assert-only. Under the `?slotGrid` arm the radius-1 fixed grid keeps ONLY its
> terrain FETCH role (its EdgeParkScheduler is not constructed there); full
> subsumption/retirement stages at ST10. Any brief echoing this plan's
> "designed, never built" framing is stale — the grid has been live default-ON
> since 2026-07-11. Read SPEC.md §1.4 for the current normative design.

Deliverable of 1120-appendix **A15** (T13 primary). Design-doc NOW, build in
S15 — after the S14 wasm rebuild lands the B1 surface cache (parking
containers still cold-re-decodes source bytes until that resource cache
exists, so retention without B1 mostly re-shuffles the pain).

## 1. Why: the retail residency model vs ours

Retail never "streams" the way our port does — it *reuses* across an
adjacent walk via three layers (decomp anchors verified in prior sessions):

| Layer | Retail mechanism | Our current analogue |
|---|---|---|
| L1 slots | `LScape::update_block` (acclient.c:307916): a FIXED player-centered `land_blocks[mid_width²]` pointer grid. On LB crossing the grid **shifts in place** — interior pointers are copied, only the leading/trailing EDGE row is released/fetched. No dump, no re-bake-on-return. | Dynamic `Set<lbKey>`-keyed bakers + `landblockLru` + warm-park + sealedKeepRing. Reclaim is LRU-pressure-driven, not position-derived; a zig-zag walk can evict/re-bake the same row. |
| L2 geometry keep | LOD/seam-gated geometry retention — a block leaving the detail radius keeps its coarse mesh; seams re-stitch instead of re-decode. | Warm-park (meshes detached, kept) — closest analogue, s11's sealedKeepRing fixed its worst ping-pong. |
| L3 resource cache | Refcounted `DBOCache` (acclient.c:83485 `GetIfUsing`): decoded resources live behind refcounts with a ~30 s `UseTime` freelist floor — release ≠ free. | `MODEL_TRI_CACHE` only (models). Surfaces = **B1** (appendix A3, S14): the DBOCache-style refcounted, byte-budget LRU cache is exactly the L3-surface slice. |

The whole B3 class of bugs (9-solo N+1 rings, re-decode on re-entry) exists
because residency is *reactive* (LRU + per-baker Sets) instead of
*positional*. **A4's `loadTerrainRing` facade (landed this session) is the
cheap 80% on-ramp:** it already computes the ring as a unit and hands
per-LB work to the guarded bake path — the slot grid replaces "compute the
ring every entry" with "shift the standing grid by the delta".

## 2. Design: `?fixedGrid` (default-OFF until validated → then default-ON + `=off` escape, house rule)

- **Grid**: `slots[W²]`, W = 2·pvsRingRadius+1 (odd), player-centered;
  each slot owns the per-LB scene3d containers (terrain/buildings/statics/
  scenery groups) + the LB's residency record. The grid is the ONLY owner
  of "resident" state; `terrainBakedLbs` etc. become derived views during
  migration (kept in sync, asserted equal under `?diag=1`).
- **Shift, don't rebuild**: on player LB crossing compute `(dx,dy)`;
  pointer-shift the array; interior slots untouched (no detach/attach, no
  LRU churn); the vacated edge row(s) → release path; the incoming edge
  row(s) → fetch path via `loadTerrainRing`-style batched fetches (one
  wasm call per layer per shift, NOT per-LB).
- **Release ≠ free (L3 tie-in)**: the released edge goes to warm-park with
  a **30 s UseTime floor** (retail's DBOCache constant) before the LRU may
  reclaim it — generalizes sealedKeepRing from "the sealed ring" to "any
  recently-used slot". Re-entering within the floor = pointer re-adopt,
  zero decode, zero bake.
- **Teleports** (the battery's dominant move): delta > W ⇒ whole-grid
  invalidate = today's behavior exactly; the grid only changes walking/
  short-hop behavior. This bounds regression risk for the telepoi suite.
- **Interaction with the stream guard**: slots adopt the existing
  `_guardedStreamBake` in-flight/cooldown keys unchanged — the grid decides
  *what* should be resident; the guard still serializes *how* it bakes.

## 3. Explicitly NOT in scope

- No wasm ABI change (grid is a JS residency driver; wasm sees the same
  batched fetch calls A4 introduced).
- Not a replacement for `landblockLru` byte/mesh budgets — the LRU stays as
  the memory-pressure backstop *behind* the UseTime floor.
- 2D renderer untouched.

## 4. Gates (from appendix A15, refined)

1. Owed full 62-POI re-read **under B1** first (S14 exit): park/unpark
   stays 18/0 · 6/0 · 0/0, reclaimMed ≤ ~300 — that is the baseline the
   grid must not regress.
2. `?fixedGrid` A/B on the v2 driver (fixed-length `--maxStops` sessions):
   walk/short-hop settle drops; teleport settle unchanged (±noise);
   renderer deaths 0.
3. `surface_cache_hits/misses` (B1 counters) hit-rate >60% during the
   walk legs; grid re-entry within 30 s shows ~zero decode work.
4. Evict/warmpark/sealed unit suites green with the grid on AND off;
   `?diag=1` derived-view assertion clean for a full battery.
5. 1070 eye-test leg for seam/LOD artifacts on shift (SwiftShader cannot
   adjudicate seams).

## 5. Landing order

1. **S14**: B1 surface cache (+ counters) — prerequisite.
2. **S15a**: park→DBOCache 30 s UseTime floor (small, independently
   testable, generalizes sealedKeepRing).
3. **S15b**: `?fixedGrid` slot grid for TERRAIN only (the layer with the
   ring already batched), derived-view assertions on.
4. **S15c**: extend to buildings/statics/scenery once terrain soaks a full
   battery; then flip default-ON with `=off` escape per house rule.
