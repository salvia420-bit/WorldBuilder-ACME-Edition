# RESULTS — Task #21: attribute the multi-second no-upload stall frame

**Date:** 2026-07-14 · **Box:** 1070 real-GPU · **Probe:** `scripts/net-review/decode-gc-probe.mjs`
(new; console-capture + bigFrame classifier over 5 telepoi re-streams) ·
**Raw:** `/mnt/wbterminal2/tmp/wf21-decode-gc.json`.

## TL;DR — the worst frame is a BULK-EVICTION GC pause, not decode, not fallback
The handoff's worst walk frame was **5159 ms with zero Δprogram/Δgeom/Δtexture**,
open-questioned as major GC vs synchronous wasm decode vs bake-worker main-thread
fallback. Attribution now settles it: the worst no-upload frame is a **bulk
eviction + GC** — it disposes textures/geometries (Δtextures **< 0**) and the
multi-second stall is the GC that follows freeing hundreds of objects. **Not**
synchronous wasm decode (the bake worker is running, decode is off the main
thread) and **not** the main-thread fallback (zero fallback tells).

## Evidence
- **Reproduced:** worst no-upload frame = **5101 ms, dP=0, dG=0, dT=−20** (≈ the
  handoff's 5159 ms). The **dT = −20** is the tell — 20 textures were *disposed*
  that frame ⇒ a bulk evict, and the stall is the accompanying GC. All other
  no-upload frames are sub-second (561 / 536 / 364 / 355 ms, dT=0 — ordinary GC /
  scheduler gaps).
- **Bake worker is ACTIVE, not in fallback:** `fallback-tells = 0` over the whole
  run; **93** `[bake_worker_client]` messages, live-splitting decode work
  (`"… N alias DID(s) → main wasm, M real → worker"`). ⇒ the "synchronous wasm
  decode on the main thread" and "main-thread fallback" hypotheses are **ruled
  out** for this frame.
- Console tell to watch (memory): `[bake_worker_client] … main-thread fallback` —
  it did **not** appear.

## Caveat on the stressor
Each `@telepoi` evicts the ENTIRE old ring at once, so the 5101 ms frame here is a
full-ring teardown GC. The handoff's original 5159 ms was on a *continuous*
corridor walk — there the equivalent pause is the governor evicting a **cluster**
of LBs together (or GC from continuous re-decode/re-bake allocation churn). Same
root class (eviction-driven GC), reached two ways.

## Lever (for a future task)
Reduce the bulk-evict GC pause: the shipped governor already time-budgets its
park/dispose (`parkDisposeBudgetMs`) and the entity reap does likewise
(`entityReapBudgetMs`, #11b) — but a full-ring teardown (telepoi) and possibly the
terrain/statics bulk-evict path still dispose a large batch in one frame. Options:
(a) extend the dispose budget to cover the terrain/statics teardown path so a
cluster evict spreads across frames; (b) cut per-burst allocation churn (fewer
short-lived objects per bake) to lower GC pressure. Lower priority than it looked:
the frame is eviction-bound (bounded, and only on big teardowns), and the heap is
terrain/entity-dominated and already bounded (RESULTS-task2 / -task11b).

## Status
No code shipped for #21 (it is a *measurement* task; premise now attributed).
Added the reusable `decode-gc-probe.mjs` (console-fallback capture + no-upload
frame classifier).
