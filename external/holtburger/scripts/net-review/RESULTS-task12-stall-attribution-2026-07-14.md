# RESULTS — Task #12: walk-stall attribution (shader prewarm premise DISPROVEN)

**Date:** 2026-07-14 · **Box:** 1070 real-GPU · **Probe:** `walk-entgrowth.mjs`
(per-frame observer: on any frame >250 ms, snapshot Δprograms/Δgeometries/Δtextures) ·
**Raw:** `/mnt/wbterminal2/tmp/walk-attrib.json`.

## TL;DR — don't build the boot shader-prewarm; it targets the smallest contributor
#12 assumed the multi-second walk stalls are cold shader compiles. **They're not.**
A frame-by-frame attribution over an 88-LB corridor walk shows the stalls are
**geometry/texture UPLOAD during streaming + decode/GC** — shaders are a tiny
trickle, and are already prewarmed per-bake by `bake_prewarm.js` (default-on).
**Not implementing the boot prewarm** — it would address the wrong cost.

## Attribution — 24 frames >250 ms (total ~24 s of stall)
| driver | frames | worst | total |
|---|---|---|---|
| **geometry upload** (ΔG>0, up to **+417 geoms/frame**) | 17 | — | 10.0 s |
| shader compile (ΔP>0, only **+1…+7 programs/frame**) | 20 | — | 11.7 s |
| texture upload (ΔT>0, up to +176) | 14 | — | 7.8 s |
| **decode / GC / streaming** (no Δp/g/t) | 3 | **5159 ms** | 6.1 s |

- The **single worst frame (5159 ms) had zero program/geom/texture change** — pure
  decode/GC/streaming, not a shader compile.
- Shader Δ is always small (1-7 programs). Where ΔP>0 it co-occurs with a big
  geometry upload (e.g. `1330 ms: SHADER+7 geomUpload+14 texUpload+22`, or
  `406 ms: SHADER+1 geomUpload+417`) — the **upload**, not the 1-7 program links,
  dominates the frame.
- `bake_prewarm.js` already `compileAsync`-prewarms terrain/statics/buildings/
  entities before attach. But `guardedCompileAsync` calls `renderer.compile()`
  (which uploads geometry+textures **synchronously**) and only async-polls the
  shader **link** — so the prewarm defers the *link* but the *upload* still lands
  on a frame, and hundreds of geoms can attach in one frame during a streaming burst.

## Why boot-prewarm of ~125 programs won't move the needle
Shaders are already prewarmed per-bake and cost 1-7 links per stall-frame; the
stall is the upload/decode riding alongside. Precompiling programs at boot removes
a cost that is (a) small and (b) already deferred. Net expected gain: negligible.

## The actual latency levers (for a future task)
1. **Per-frame streaming-attach throttle** — cap how many baked LB subtrees attach
   (and thus how many geoms/textures upload) per frame; spread bursts across frames.
   `bake_prewarm.js` cites a `PLAN-goal1-drawdistance-streaming-throttle` — extend
   that so the *upload* (not just the shader link) is rate-limited. This targets the
   17 geometry-upload frames (10 s) + 14 texture frames.
2. **The 5159 ms decode/GC frame** — attribute further (major GC vs a synchronous
   wasm decode vs bake-worker main-thread fallback — check the console for the
   `[bake_worker_client] … main-thread fallback` tell). If GC, reduce per-burst
   allocation churn; if decode, ensure the bake worker (not the main-thread
   fallback) is doing it.
3. Neither is #12. Recommend re-scoping #12 → "streaming-attach upload throttle."

## Status
No client code shipped for #12 (correctly — the premise didn't survive
measurement). Added frame-attribution instrumentation to `walk-entgrowth.mjs`
(reusable: `bigFrames[]` with Δp/g/t per >250 ms frame).
