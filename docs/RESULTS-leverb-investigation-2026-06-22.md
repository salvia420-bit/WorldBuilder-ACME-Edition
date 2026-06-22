# RESULTS — Lever B (CPU draw-distance) investigated; framed fixes don't measurably help (2026-06-22)

Lever B from `docs/HANDOFF-perf-followups-3-levers-2026-06-22.md` — "the next draw-distance
bottleneck is CPU, not shaders" — investigated end-to-end with multi-agent orchestration (ultracode):
r10 CPU profile → parallel subsystem-mapping workflow → implemented the two JS fixes → adversarial
review workflow → 1070 A/B. **Outcome: the doc's framed fixes produce no measurable improvement on
the current build. Code was implemented, measured, and REVERTED. The real remaining cold-fill cost is
the synchronous shader-program LINK — goal1's lever, already largely addressed by the light-pool trim
(`59544b35`) — not the atlas/wasm-decode/bake costs Lever B targets.**

This is a negative result that saves future effort: **do not build the atlas-worker or the bake/copy
fixes.** It also corrects the doc's older percentages with measured ones.

## What the doc claimed vs what the profile measured

The doc (from older notes) said the r10 fill is CPU-bound ~4.6 fps split across: (1) wasm decode
33–58%, (2) a 33 MiB synchronous atlas build, (3) un-budgeted bake bursts.

Measured on the real GTX 1070 (headless ANGLE/D3D11, `quality=high&pvsRingRadius=10`, 140 s CPU profile
of the post-in-world fill — harness `r10-cpuprofile-1070.mjs`):

| bucket | self-time |
|---|---|
| shader/material pipeline (`getProgramParameter` 13.7% + `getProgramCacheKey`/`getProgram`/`setProgram`/`getParameters`) | **~40%** |
| `(program)` native / GL driver | 17.4% |
| idle | 28% |
| **wasm decode** | **6.5%** (not 33–58%) |
| **atlas build** | **0%** (one-time boot cost, done before the window) |
| **bake() fn** | 0.1% |

Plus: fps 19.8, **worst frame 12.3 s** (the cold stall), 169 LBs baked in 140 s. The fill is *mostly*
~55 fps (p50 18 ms) punctuated by a few multi-second freezes — those freezes are the target.

## The A/B (the verdict)

Implemented behind flags (default-off): **Fix #1 `?terrainNoDoubleCopy`** (drop the redundant second
copy of subdivided-mesh attributes per LB — `adapter.js`) and **Fix #2 `?pvsStreamStartsPerTick`**
(cap bake STARTS per tick in the PVS stream drain — `cells.js`). 1070 A/B, cold r10 fill, 95 s/arm,
fresh browser each (harness `leverb-ab-1070.mjs`):

| arm | fps | p50 ms | worst ms | >1s | >250ms | LB/s |
|---|---|---|---|---|---|---|
| baseline | 20.6 | 18.0 | 12367 | 5 | 15 | 1.78 |
| fix1 (no-double-copy) | 21.0 | 17.9 | 12403 | 4 | 19 | 1.78 |
| fix2 (frame-budget) | 21.6 | 18.1 | 11810 | 4 | 19 | 1.78 |
| both | 21.6 | 18.4 | 11492 | 5 | 15 | 1.78 |

**All four arms are within run-to-run noise.** Worst-frame stays ~12 s, >1 s stalls 4–5, LB/s
identical at 1.78 (exactly 169 LBs every arm). No fix moves any metric.

## Why each fix is a no-op here (mechanism, not guesswork)

- **Fix #1 (no-double-copy):** the redundant copy is ~100 KB/LB; over 169 LBs in 95 s that's below the
  noise floor. Throughput is gated by bake concurrency + fetch + wasm decode, **not** JS copying — so
  LB/s is identical. The adversarial review confirmed it's *safe* (the wasm-bindgen getters return
  `.slice()` copies, not views — `pkg/holtburger_web.js:12272-12313`), but safe ≠ beneficial. The
  defensive `.from()` copies are also more robust to a future wasm-getter change, so they were kept.
- **Fix #2 (frame-budget):** the natural fill rate is **1.78 LB/s ≈ 0.18 starts/tick** (10 Hz tick),
  far below the cap of 2 starts/tick — **so the cap never binds.** And the 12.3 s worst-frame is the
  one-time synchronous shader-compile burst, not a bake burst, so capping bake starts can't touch it.
  (Caveat: the stationary 95 s window is dominated by the radius-6 boot ring — already time-sliced via
  `?terrainRingTimeSlice` — so the PVS-expansion path Fix #2 targets was under-exercised; but the
  worst-frame conclusion holds across all arms regardless.)
- **Atlas off-thread (doc cost #2):** 0% during the fill — it's a one-time ~840 ms *boot* cost
  (`terrain.js:76-77` names it). MEDIUM risk (async RPC + double-build latch). Not worth it; deferred.
  Fully specced (reuse the existing `bake_worker`) if ever revisited — see the understand-workflow plan.
- **wasm decode (doc cost #1):** 6.5%, and any real reduction needs an OOM-risky Rust/wasm rebuild on
  the 8 GB laptop. Deferred.

## The real lever (redirect)

The dominant cold-fill cost is the **synchronous D3D11 shader-program LINK** (≈40% pipeline + the
12 s worst-frame): ~72 programs, ~49 radius-independent, `KHR_parallel_shader_compile` a no-op on the
1070 (links synchronously). That is **goal1's domain**, already largely addressed by the shipped
light-pool trim (`lighting.js`, `59544b35`) and `bake_prewarm.js`'s `compileAsync` warmup. Further
cold-load wins come from **more shader-program trimming / compile warmup**, NOT from Lever B's
atlas/wasm/bake framing. Lever B is effectively **OBE** — the light-pool fix already took the cost it
was chasing.

## Recommendation

- **Don't** implement the atlas-worker, the no-double-copy, or the bake frame-budget — measured no win.
- If outdoor/draw-distance FPS is later raised so the frame becomes **GPU-bound** (not CPU/shader-bound),
  re-measure — the bake/decode tails could then matter. Until then, Lever B is closed.
- Remaining cold-load headroom is a **shader-compile** problem (goal1), not Lever B.

## Artifacts

`leverb-investigation-2026-06-22/`: `r10-cpuprofile-1070.mjs` + `r10-cpuprofile-buckets.json` (the cost
split), `leverb-ab-1070.mjs` + `leverb-ab-report.json` (the 4-arm A/B). The implemented-then-reverted
fixes + the full subsystem map + ranked plan live in the session's workflow transcripts.
