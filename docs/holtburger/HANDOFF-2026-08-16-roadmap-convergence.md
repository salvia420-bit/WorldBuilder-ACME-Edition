# HANDOFF — holtburger-web roadmap × dat-patch convergence (2026-08-16)

Written the night the r7 TRUE-4x rebake launched (docs/dat-patch/
R7-TRUE4X-PLAN.md). The two tracks — enhanced DATs for the retail client, and
the browser client's perf roadmap — have been parallel until now. This doc
records how they meet, what's landed, and the prerequisite ladder for serving
the enhanced world through a browser tab.

## Why converge
The dat-patch tiers (r1→r7: 4x textures, displaced relief, compression) only
reach people who install a patched retail client. holtburger-web renders the
same world from baked DAT layers with zero install. Once it can carry
r7-class content, the enhanced world becomes a link you click — the lowest-
friction showcase there is. The perf/residency roadmap is not a side quest;
it is the prerequisite for that.

## Where the perf roadmap stands (see memory/holtburger-perf.md for the full
analysis; distilled here so this doc stands alone)
- LANDED: thread-local triangulation memo (decode-once per wasm instance).
- NEXT (in order): **instanced anim-scenery** (2×fps, live-proven 2026-07-02);
  then the retail-shaped residency ladder — refcounted decode cache, fixed
  slot grid (retail's `LScape::update_block` shape), park/evict — in RUST, not
  JS (a JS shared-geometry cache was tried and rejected: unvalidatable
  dispose choreography; a Rust cache is byte-identical with no eye-test gate).
- Discipline that stays: ship-RELEASE wasm before measuring (~4.5 MB, not the
  ~18 MB dev build); bake-worker staleness rules; measurement traps are
  documented in the memory index (§staleness-rebuild).

## The convergence ladder (do these in order)

1. **Finish instanced anim-scenery + the residency ladder** (above). Every
   later step multiplies decode and memory load; this is the foundation.
   Gate: bare-default loads + spawns + 0 errors, fps A/B on real GPU.

2. **holtburger-dat: compressed-record support.** r7's portal stores texture
   records zlib-compressed (BTEntry flag bit 0). The Rust DAT reader has no
   inflate path today, so an r7-based bake would read garbage. Small, well-
   understood change — mirror of the DRW fix just posted upstream
   (Chorizite/DatReaderWriter#70): check the flag, inflate with a LOOPED read
   until the destination fills (the exact bug #70 fixes in C#). Add a
   round-trip test against a DatCompress'd fixture.

3. **An explicit "enhanced dist" bake lane.** The bake-base-dats-only policy
   (reject non-retail ids, emit bake-source.sha256) is a deliberate guard —
   do NOT quietly relax it. Instead: a second dist tree baked from the r7
   export with its own bake-source.sha256, served alongside the vanilla dist
   (the dist symlink/`HOLTBURGER_DIST` mechanism already supports pointing at
   either). Vanilla stays the default; enhanced is opt-in until gated.

4. **Size/bandwidth reality check before shipping shards.** TRUE-4x
   quadruples texture area; the lazy manifest pathway (first paint ~605 MB →
   ~5 MB) absorbs a lot, but per-landblock shard sizes will grow. Measure
   first; if shards bloat, the options are web-side texture transcode
   (KTX2/Basis-class) or serving the compressed records as-is and inflating
   in wasm (cheap; zlib is already small). Do not guess — the manifest makes
   this a one-afternoon measurement.

5. **Relief geometry (r8) last.** The area-based dungeon relief (~2.1 M tris
   across 3,924 variants, tools/dat-patch/env_geo.py area lane) lands on the
   retail side first. For the web it rides the same enhanced-dist bake, but
   only after the residency ladder proves it can hold the extra geometry.
   Note the dungeon-lighting caveat from the geometry audit: judge dungeon
   assets under a torch-model rig, not the daylight board.

## What already exists that this plan consumes
- r7 TRUE-4x portal (bake in flight tonight; compress-first, ~1.3 GB final,
  ~850 MB headroom for r8).
- The wrap-padded upscale corpus (92.8% tileability improvement) — also the
  right source if any web-side texture work needs the originals.
- The 1070/T4 real-GPU eyes + headless drive tooling for A/B gates; the
  browser side has its own zero-GPU bot modes (`?nullRender=1`, `__diag`)
  for protocol/perf regression without eyes.

## Non-goals (so nobody scope-creeps into them from here)
- No de-palettizing of recolor-live textures (breaks the clothing/skin
  system — the format is the constraint, on both renderers).
- No serving enhanced dats as the DEFAULT dist until the enhanced lane has
  its own gate parity with the vanilla one.
- No JS-side caching architecture — system work goes in Rust/wasm.
