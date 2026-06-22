# RESULTS — Lever C (logarithmicDepthBuffer) measured; no-win, skip it (2026-06-22)

Lever C from `docs/HANDOFF-perf-followups-3-levers-2026-06-22.md` — global `logarithmicDepthBuffer`
exports `gl_FragDepth` on ~63/72 programs, which disables early-Z/Hi-Z (a per-pixel fill cost on every
lit pixel + the ortho shadow pass). The doc proposed a "cheap sub-win": scope log-depth OFF for the
passes where it's inert (ortho shadow/depth + fullscreen post). Measured on the real 1070 → **no win.
Skip it** (and the scoped slice isn't even cheap). This closes the three levers.

## TL;DR

The 1070 is **CPU-bound** in this scene with the **GPU deeply idle** — so restoring early-Z (the entire
point of Lever C) **cannot raise fps**. A/B of global logDepth on vs off (bracketed) shows flat ~22 fps.
Same conclusion as Lever B, same reason.

## Measurement (1070 headless, quality=high, warm steady-state outdoor Holtburg)

Bracketed A/B (on-1 / off / on-2 to expose GPU boost-state drift) — harness `leverc-ab-1070.mjs`,
temporary uncommitted `?logDepth=off` flag on the renderer capability (reverted after):

| arm | fps | p50 ms | GPU util avg | GPU power avg | SM clock avg |
|---|---|---|---|---|---|
| on-1 (logDepth on) | 21.7 | 44.9 | 29% | 18.4 W | 885 MHz |
| **off (logDepth off)** | 22.1 | 43.6 | 16% | 32.7 W | 1199 MHz |
| on-2 (logDepth on) | 22.7 | 42.9 | 21% | 34.5 W | 1205 MHz |

## Why it's a no-win (dispositive evidence)

- **fps is flat (~22) across all three arms** — off (22.1) sits *between* the two on runs (21.7, 22.7).
  No framerate difference from disabling log-depth.
- **The GPU is not fill-rate-bound.** Util 16–29%, power **18–34 W of a ~150 W card**, SM clock often
  pinned at the **885 MHz idle floor** (the 1070 boosts to ~1700 MHz under real load). A GPU with this
  much headroom cannot be sped up by an early-Z restoration — the bottleneck is the CPU/main thread
  (~22 fps, p50 ~44 ms). This is the **dispositive** result and it holds independent of the off-flag.
- **The power "delta" is boost-state jitter, not a fill saving.** off (32.7 W) is *higher* than on-1
  (18.4 W) and *lower* than on-2 (34.5 W); the bracket shows power drifts 18→34 W run-to-run regardless
  of log-depth. If early-Z were saving fill work, off would be below *both* on runs — it isn't.

Consistent with `[[project_leverb_cpu_drawdistance_obe_2026-06-22]]` and the clouds steady-state result:
the 1070 outdoor is CPU-bound; GPU-side optimizations (early-Z, fill-rate, cloud raymarch) don't move
fps because the GPU isn't the bottleneck.

**Honest caveat:** the off-arm flip couldn't be *independently* confirmed — the
`renderer.capabilities.logarithmicDepthBuffer` read was unreliable (it read false even on the default-on
arm, so it's the wrong field), and z-fighting didn't manifest in the off screenshot (expected: at the
default ~960 m draw distance 24-bit perspective depth is precise enough; log-depth only earns its keep
at r10+ km-scale draw distances). But the conclusion does **not** depend on the flip: the GPU-idle data
proves fill-rate isn't the bottleneck either way.

## And the scoped slice isn't cheap anyway

`logarithmicDepthBuffer` is a three.js **renderer-global capability** — it injects
`USE_LOGARITHMIC_DEPTH_BUFFER` into every material the renderer compiles; you can't pass it per-pass.
Scoping it off for just the ortho shadow pass / post passes requires hacky per-material
`onBeforeCompile` define-stripping (fragile across three versions). The fullscreen post passes are
mostly `RawShaderMaterial` (no auto-define) so there's little there to strip; the only genuinely-inert
site is the ortho `MeshDepthMaterial` shadow pass — and stripping it buys ~0 fps on an idle GPU.

It is also **load-bearing** where it's on: the terrain custom shader writes `gl_FragDepth` in log-depth
space (`terrain.js:792/1318`), and the indoor floor-coplanar bias (`materials.js:363/389`,
`applyFloorDepthBias`, `gl_FragDepth ∓ 2e-4`) is in log-depth space. Don't touch the global setting.

## Recommendation / three-levers wrap-up

- **Lever C: skip.** No fps win (GPU idle), and the scoped change is non-trivial + risk for ~0.
- **Three levers, resolved:** **A (clouds prebake) — shipped** (`e3a791b1`). **B (CPU draw-distance) —
  closed as OBE**, no measurable win (`6b1eb759`). **C (logDepth) — no-win, skip** (this doc).
- The common thread: the 1070 outdoor is **CPU/main-thread-bound**; the remaining cold-load headroom is
  the synchronous **shader-program LINK** (goal1's lever, already largely addressed by the light-pool
  trim `59544b35`). GPU-side levers (B's atlas/fill, C's early-Z) don't move fps until the frame becomes
  GPU-bound. If outdoor fps is ever raised toward the vsync cap, re-measure B and C.

## Artifacts

`leverc-investigation-2026-06-22/`: `leverc-ab-1070.mjs` (harness) + `leverc-ab-report.json` (the
bracketed A/B). Screenshots dropped — they showed no visible on/off difference (part of the finding).
