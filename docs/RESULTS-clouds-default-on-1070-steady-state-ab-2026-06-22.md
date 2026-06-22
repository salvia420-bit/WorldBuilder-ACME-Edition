# RESULTS — Clouds default-on? Steady-state cost A/B on the real GTX 1070 (2026-06-22)

Follow-up to `docs/HANDOFF-perf-followups-3-levers-2026-06-22.md`. That handoff (Lever A) only
costed the **cold-load shader compile** of clouds (~38.9 s, of which ~33 s is the procedural noise
bake). It explicitly did **not** measure the **steady-state per-frame** cost — which is the real gate
for "can clouds ship default-on while maintaining current quality?" This is that measurement, on the
actual GTX 1070.

## TL;DR

**On the 1070, turning clouds on at current quality costs ~0 fps.** The outdoor world is already
**CPU-bound at ~20 fps** at the tier this card auto-selects (`mid`), with the **GPU 27–47 % idle**.
Clouds are a GPU-side raymarch that slots into that idle GPU time, so net frame-time barely moves:

| arm | cloud config (read back live) | **FPS** | p50 ms | p95 ms | worst ms | frames >33 ms | GPU util avg/max | watts avg | Δ vs off |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **off** | no overlay (true baseline) | **20.6** | 47.3 | 57.5 | 121.2 | all | 35 % / 37 % | 13.5 | — |
| **high** (current default) | resScale 1, 500 iter, 8 MS-oct, 3×512² shadow, shapeDetail+turbulence, lightShafts off | **21.4** | 44.9 | 57.6 | 123.7 | 659/659 | 33 % / 40 % | 22.1 | **+0.8 fps** |
| **medium** | resScale 1, 500 iter, 3×256² shadow, no turbulence | **19.9** | 48.2 | 61.8 | 170.2 | 613/613 | 45 % / 52 % | 14.4 | −0.7 fps |
| **low** | resScale 1, 200 iter, 2×256² shadow, no shapeDetail/turbulence | **21.0** | 46.0 | 60.8 | 157.4 | 646/646 | 27 % / 45 % | 26.1 | +0.4 fps |
| **half-res** | high @ resScale **0.5**, 3×512² shadow | **20.4** | 47.3 | 59.5 | 128.6 | 628/628 | 47 % / 51 % | 15.1 | −0.2 fps |

Every arm — including **off** — sits at **~20 fps**. The cloud delta (−0.7 … +0.8 fps) is **within
measurement noise**. Clouds do not regress framerate on the 1070.

> ⚠️ **Methodology gotcha that nearly produced the wrong answer.** The first run measured `off` at a
> bogus **60 fps** because that arm spawned at a distant cell and teleported to Holtburg *cold* — 32 s
> wasn't enough to bake terrain, so it rendered a near-empty **white world** (cheap → 60 fps, GPU ~0 %;
> see the original `cloud-ab-off.png` was 85 KB vs 2.4 MB for the baked re-run). Comparing the cloud
> arms against that white baseline produced a fake **"+31 ms/frame, 60→20 fps"** collapse. The clean
> re-run on a properly **baked** world (character parked at Holtburg, spawns there directly) shows the
> baked no-cloud world is *itself* ~20 fps. **Always verify the baseline screenshot is a real scene.**

## What this means for "default-on while maintaining quality"

- **Steady-state FPS: realistic on the 1070.** There is no framerate regression from clouds at current
  quality. A default-on player on this class of card gets the same ~20 fps they already get outdoors.
- **The ~20 fps itself is a pre-existing problem, and it is NOT clouds.** It is the outdoor world being
  CPU/main-thread-bound at `mid` — the same draw-distance / single-thread-wasm / sync-bake bottleneck
  documented in `project_goal1_drawdistance_compute_bound_2026-06-22` and
  `project_holtburger_stutter_diag_2026-06-01`. Clouds neither cause it nor worsen it.
- **Why clouds are ~free here:** the frame's long pole is CPU. The GPU finishes the world in ~13 ms and
  idles the rest of the ~48 ms frame (util 27–47 %, power 13–26 W of a ~150 W card). The cloud raymarch
  consumes some of that idle GPU time without extending the CPU-bound frame. Confirmed by `off` itself
  showing GPU 35 % / 13.5 W — the card loafs with or without clouds.
- **Quality/resolution knobs are irrelevant to the cost** — high, medium, low, and half-res are all
  ~20 fps. You cannot buy back framerate by lowering cloud quality (there is nothing to buy back), and
  equally there is no penalty for keeping **current (high) quality**. So "maintain quality" is free.

## Important caveats (do not over-generalize)

1. **"Free" is contingent on the world staying CPU-bound.** If the draw-distance/CPU work is later
   fixed and outdoor FPS climbs toward the 60 vsync cap, the **GPU becomes the long pole** and the
   cloud raymarch cost (real GPU work — see the watts rising from 13.5 W → 22 W when high is on) will
   re-emerge as a visible frame-time hit. Re-measure clouds after any outdoor-FPS win.
2. **Cold load is still a real, separate cost.** Lever A stands: clouds add shader-compile time at boot
   (~5–6 s of render programs even after a noise prebake; ~33 s today without the prebake, which is
   *not yet implemented* — only a `proceduralTextures` gate + a JSDoc note exist, no `.bin` loader).
   Default-on worsens **cold load**, not steady-state. Prebake the noise before flipping default-on.
3. **Higher scene tiers are heavier, not lighter.** `mid` is what the 1070 auto-resolves to (it is not
   on the `GPU_HIGH` allowlist in `quality.js`). At `high`/`ultra` the world costs more CPU and the
   FPS floor is lower; clouds remain ~free for the same CPU-bound reason, but the baseline is worse.
4. **One location, stationary, vsync-capped.** Outdoor Holtburg `0xa9b40019`, frozen camera. rAF caps
   at 60, but everything is ~20 fps so the cap never bound the measurement. Rain weather was active in
   all arms (weather is clouds-independent — same streaks in `off`).

## Method (reproducible)

- Real **GTX 1070**, **headless** Chromium via ANGLE/D3D11 — renderer string confirmed
  `ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 (0x00001BE1) Direct3D11 …)`, i.e. real GPU, **not**
  SwiftShader. nvidia-smi util/watts (nonzero every arm) independently confirm hardware rendering.
- App served live from the laptop working tree (`serve.py:8765`, HEAD `59544b35`) over a reverse
  tunnel to the 1070's `127.0.0.1:18765`; wsbridge over tailscale.
- Scene `quality=mid` (the 1070's auto tier). Per arm, **fresh browser**: auto-login → `@telepoi
  Holtburg` (clouds are skipped indoors) → 32 s settle (terrain + one-time cloud noise bake) → freeze
  camera → 12 s warm (discarded) → **28 s steady-state window** (rAF frame-times) + nvidia-smi every
  3 s → screenshot. Cloud config (preset / resolutionScale / shadow / iterations) is **read back live**
  per arm and recorded, so the table reflects what actually ran.
- Session-release race between consecutive same-account logins handled with a 25 s pre-login gap +
  one reload-on-early-`boot=error` retry.

## Artifacts

- Screenshots (this dir): `cloud-ab-1070-2026-06-22/cloud-ab-{off,high,medium,low,halfres}.png`
  (all baked outdoor Holtburg, identical framing; `off` = lighter sky, cloud arms = dark overcast canopy).
- Harness: `cloud-ab-1070-2026-06-22/cloud-ab-1070.mjs` (runs on the 1070; `--arms=` filter).
- Raw report: `cloud-ab-1070-2026-06-22/cloud-ab-report.json`.

## Bottom line

The handoff framed default-on as gated by an unmeasured per-frame cost. Measured: on the 1070 that cost
is **~zero** because the card is CPU-bound outdoors. So **clouds can ship default-on at current quality
with no steady-state FPS regression on the 1070** — the only real work left is the **cold-load noise
prebake** (Lever A), and a note that the "free" verdict must be re-checked if/when the outdoor world
stops being CPU-bound.
