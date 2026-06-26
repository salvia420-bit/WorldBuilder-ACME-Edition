# Tree-wind changes — cap / nearest / cull / synth-fallback / +species (2026-06-26)

Per user: *"bump the cap significantly and make it animate nearest to player. extend the camera animation
distance cull because trees swaying in the distance looks cool. find out why those other species aren't
responding and include them and many more."*

**All JS-only** (no wasm/C# rebuild) → `serve.py` serves live; reload to pick up. node `--check` clean on all.

## The 5 changes

| # | What | File | Change |
|---|---|---|---|
| 1 | **Cap 512 → 4096** | `animated_scenery.js:56` | `DEFAULT_MAX_ANIMATED`. Tunable `?animSceneryMax`. |
| 2 | **Cull 140 → 800 m** | `animated_scenery.js:57` | `DEFAULT_TICK_RADIUS_M`. Distant trees now tick. Tunable `?animSceneryRadius`. |
| 3 | **Nearest-to-player build** | `animated_scenery.js` (attachWindTrees) | Sort placements by distance to the follow camera (AC Z-up world XY) before the build loop → a hit cap drops only the FARTHEST trees. |
| 4 | **Synth-fallback for un-baked DIDs** | `animated_scenery.js` (build loop) | Under `windBake=on`, a null/part-mismatched baked clip now SYNTHESIZES from the live rig instead of re-freezing. Synth ≈ bake (bake is bit-copied synth). Kills the one-load-frozen window; lets new species animate with no re-bake. |
| 5 | **+42 species (`windResponds`)** | `vfx_catalog.js` (new export) + `statics.js` (gate ×2) | The classifier's `trunk-canopy` (windBend) rule requires `IsFoliageLike && PartCount>=2 && MaxDimension>=4m` (`CommandEngine.Vfx.cs:307`); shorter multi-part foliage falls through to `foliage-pollen`. `windResponds()` = `hasWindBend` OR (`archetype==foliage-pollen` && partCount≥2) → adds the 42 multi-part bushes/shrubs (103 → ~145 windable species). Single-part pollen plants (no parts to bend) correctly excluded. |

## Why "those other species weren't responding" (the finding)
- The wind-riggable trees are the **103 "trunk-canopy"** classifier DIDs (have `deformation.windBend`).
- The 4 species visible near Holtburg (`0x2000bbf/494/493/5ac`) ARE in those 103; Holtburg just has a sparse
  subset, and the nearest was **773 m** away (now 141 m built — see below).
- `tip-flex` (404) = **weapons** (correctly excluded). `foliage-pollen` (269) = mostly **single-part** plants
  (227) that physically can't part-bend; the **42 multi-part** ones SHOULD sway and now do (change #5).
- The classifier's **4 m height gate** is the reason multi-part bushes/saplings were filed as pollen, not wind.
  (A cleaner fix is to lower that gate in `CommandEngine.Vfx.cs` + re-emit the catalog — a C# rebuild + a VFX
  tradeoff, deferred; the client-side `windResponds` gets the same 42 with no rebuild.)

## Verification state
**PROVEN (read live off the GTX-1070 runtime):**
- Cap: `windNodes` (animated tree count) **512 → 2084** around Holtburg — 0 dropped (was DROPPED 1572/2084).
- Nearest-first: nearest animated tree **773 m → 141 m** from the lifestone (closest trees now build first).
- Boot-safe: all runs reached in-world, 0 fatal/console errors with the new code.

**NOT demonstrated (headless tooling limit — honest):** the actual tree **sway motion** + a video. The headless
playwright/ANGLE session renders shader-time animation (rain, water, gemSparkle) but my probes never registered
the **rAF-driven part-rig** motion — *and this was true BEFORE these changes too*, so it's an environment
limitation, not a regression. Repeated attempts (part-transform sampling, forced-world-matrix sampling, screenshot
bursts) and camera-framing (the follow camera reasserts over a free-camera reposition) did not yield a clean
motion capture. **The wind animates strongly in a real foreground session (user-confirmed, 7° default amplitude).**
To capture the video: drive the **live foreground 1070 session** (where the rAF mixers run), or simply reload a
real session and watch — the changes are live-served.

## Follow-ups
- Capture the sway video from a live (non-headless) 1070 session.
- (Optional) lower the classifier `MaxDimension>=4f` gate + re-emit the catalog for a data-driven species
  expansion (vs the client-side `windResponds`); weigh the pollen→wind reclassification (VFX-fan call).
- The 42 newly-windable bushes are **un-baked** → they use the synth path (#4). If desired, add them to the
  windclip bake for the (negligible) bake-vs-synth purity.
