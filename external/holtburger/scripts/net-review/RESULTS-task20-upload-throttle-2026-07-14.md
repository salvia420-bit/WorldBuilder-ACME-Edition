# RESULTS — Task #20: per-frame streaming-upload throttle (REFUTED by A/B)

**Date:** 2026-07-14 · **Box:** 1070 real-GPU (ANGLE NVIDIA GTX 1070 Direct3D11,
`KHR_parallel_shader_compile` present) · **Probe:** `scripts/net-review/poi-burst-ab.mjs`
(new; deterministic telepoi-jump A/B) + `walk-entgrowth.mjs` (baseline) ·
**Raw:** `/mnt/wbterminal2/tmp/wf20-{baseline,poi-off,poi-on,poi-off2,poi-on2}.json`.

## TL;DR — the compile/upload throttle does NOT reduce streaming upload bursts
#20 (re-scoped from #12) proposed rate-limiting the per-LB bakers' synchronous
geometry/texture UPLOAD (the `renderer.compile()` inside `prewarmSubtree`) so a
streaming burst doesn't pile many LBs' uploads onto one frame. I built it behind a
default-OFF `?uploadThrottle=on` flag (shared per-frame geometry budget; bakers
`await` a slot before prewarm; a per-frame reset releases queued bakers up to the
budget). **Two paired 1070 A/B runs show NO measurable effect** — the throttle-on
upload metrics land squarely inside the run-to-run noise of the throttle-off
baselines. **Not shipping it.** Code reverted; the reusable harness kept.

## The A/B (deterministic paired telepoi bursts)
Each `@telepoi <town>` evicts the ring and re-streams a new town = a worst-case
upload burst. Same 8-jump sequence (Cragstone→Rithwic→Holtburg→Arwic→Eastham→
Cragstone→Rithwic→Holtburg, 5 distinct towns) every arm → **paired**. The
per-frame `bigFrames` observer (Δprograms/Δgeometries/Δtextures on every >250 ms
frame) is the attribution.

| arm | throttle | upload-frames | uploadStall ms | **maxΔG/frame** | maxΔT/frame | queued |
|---|---|---|---|---|---|---|
| off  | — | 21 | 14827 | **790**  | 282 | 0 |
| off2 | — | 18 | 14190 | **1177** | 487 | 0 |
| on   | ✓ | 23 | 19092 | 1258 | 580 | 21 |
| on2  | ✓ | 23 | 13798 | **773** | 299 | 23 |

- **The two BASELINES alone swing maxΔG 790 ↔ 1177 (+49 %)** — the metric is
  dominated by telepoi re-stream timing + nondeterministic entity spawn, not the
  throttle. The throttle-on runs (773, 1258) fall *inside* that baseline band.
- uploadStall: off {14827, 14190}, on {19092, **13798**} — the lower on-run beats
  both baselines; no consistent direction.
- The throttle **engaged correctly** every on-run (395/440 acquires, 21/23 queued,
  **0 timeouts** → the never-hang fallback never fired, budget reset ran 17/18×).
  It is doing exactly what it was built to do; that work simply doesn't move the
  upload-burst distribution.

## Why it can't help (mechanism)
1. **Telepoi (and any ring re-stream) renders all new meshes in the SAME frame.**
   `renderer.info.memory.geometries` climbs when a geometry is first uploaded —
   which happens at first *render* as much as at `compile()`. When a whole ring
   becomes visible at once, its geometries upload together on the first visible
   frame no matter when each subtree was compiled. Throttling *compile* can't
   unclump the *render-time* upload.
2. **Batch-release re-clumps.** `resetUploadBudget()` releases up-to-budget queued
   bakers on ONE rAF frame; their `.then` compile continuations then run
   synchronously together in that frame — re-batching the very uploads the
   throttle deferred.
3. **The natural async bake schedule already spreads compiles.** `fetch_model_meshes`
   promises resolve at their own pace across many event-loop turns; inserting a
   budget gate mostly re-orders that, it doesn't spread it further.

## What a real upload-spreader would need (for a future task, if pursued)
Throttle **visibility / render-attach**, not compile: stagger *when newly-baked
subtrees become renderable* (e.g. keep them `.visible=false` and flip ≤N per frame),
so their first-render uploads spread across frames. Trade-off: visible pop-in, and
it must be validated on a **continuous walk** (the task12 scenario), not a telepoi
re-stream (which renders everything at once by construction). Given the heap is
terrain/entity-dominated and bounded (RESULTS-task2/11b) and the bursts are
already prewarmed, this is low-priority.

## Status
- **No client code shipped for #20** (correctly — the lever didn't survive the
  A/B). The `attach_throttle.js` module + 4 baker wirings were reverted.
- **Kept:** `poi-burst-ab.mjs` (reusable deterministic telepoi A/B harness — far
  more reliable than the held-W corridor walk, which gets stuck headless:
  `lbsVisited 4` vs an expected ~57 on one attempt) and the `throttleStats`
  capture in `walk-entgrowth.mjs` (guarded; reads null when no throttle module).
- Guiding principle (handoff §4) held again: **measure before you ship.** #12's
  shader-prewarm and now #20's compile-throttle were both plausible levers that a
  paired 1070 A/B overturned.
