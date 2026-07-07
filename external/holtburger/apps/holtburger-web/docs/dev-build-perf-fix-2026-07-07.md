# Dev-build stutter fix — optimize the compute crates in the dev profile

**Date:** 2026-07-07
**Symptom (reported):** the DEV wasm build had a regular ~half-second main-thread hitch (present regardless of activity — even stationary/rotating), eventually cascading into a freeze and an ACE "Network Timeout"/unresponsive connection. The RELEASE build was smooth. Goal: make the dev build *minimally functional* so it doesn't block agents that need it.

## Diagnosis (profiled, not guessed)

It is **NOT** the transport-in-worker port (`?netWorker`). Isolation on the dev build:

1. **`?netWorker=0` (direct path) hitches identically** — worse, in fact: a single **22.8-second** freeze during initial spawn. So the hitch is independent of the net_worker.
2. **`?nullRender=1` (skip `render()`) still hitches** → the stall is **CPU/wasm, not GPU/render**. (And the per-frame net-pump `__netFramePump` had 0 calls >20ms, ruling out the scene-event drain.)
3. **CPU profile (CDP `Profiler`, 200µs sampling)** named the hot path: the **terrain bake pipeline** —
   - `holtburger_dat::normal_gen::{sample_clamped, normal_from_luminance, height_from_luminance}` (per-pixel terrain normal-map generation) ≈ **9%** of dev self-time,
   - `holtburger_dat::file_type::texture::Texture::to_rgba8` (texture decode), `surface_classify::compute_stats`,
   - DAT deserialization (`std::io::Read::read_exact`, `binrw`), `sha2` content hashing,
   - plus ~2% in **debug-build-only** `core::slice::raw::from_raw_parts::precondition_check` bounds checks.

Root cause: this compute-heavy, tight-numeric-loop pipeline runs on the browser **main thread**, and the default dev profile compiles it at **`opt-level = 0` with debug-assertions + overflow-checks on** — several times slower than release. Release hides it; dev surfaces it as multi-hundred-ms (and, on the initial grid bake, multi-second) main-thread stalls, which also starve the keepalive → the eventual timeout.

## Fix

`external/holtburger/Cargo.toml` — optimize the stable, compute-heavy crates (and all dependencies) **in the dev profile only**, keeping the application crate at `opt-level = 0` so app/scene-code iteration keeps fast incremental rebuilds:

```toml
[profile.dev.package."*"]          # all dependencies (binrw, sha2, image, …)
opt-level = 3
[profile.dev.package.holtburger-dat]     # normal_gen, texture decode, DAT parse
opt-level = 3
debug-assertions = false
overflow-checks = false
[profile.dev.package.holtburger-world]   # collision / scene build
opt-level = 3
debug-assertions = false
overflow-checks = false
[profile.dev.package.holtburger-core]    # physics
opt-level = 3
debug-assertions = false
overflow-checks = false
```

Release is untouched (already `opt-level = 3`). The app crate (`holtburger-web`, incl. the 53k-line `lib.rs`) stays at `opt-level = 0`.

## Results (dev, `?netWorker=1&nullRender=1`, 30 s idle in-world)

| | Baseline (opt0) | dat/world/core opt3 | + deps opt3 + checks off |
|---|---|---|---|
| **Worst main-thread long task** | **1374 ms** | 525 ms | **488 ms** |
| Long tasks (>50 ms) in 30 s | 18 | 10 | 11 |
| Frames > 33 ms | 59 | 52 | **25** |
| Median long task | 186 ms | 153 ms | **112 ms** |
| Multi-second initial-bake freeze | 22.8 s | gone | gone |
| CPU: `normal_gen` self-time | 9.3 % | 1.2 % | ~1 % |
| CPU: wasm total / idle | 44 % / 45 % | 21 % / 67 % | mostly idle |

Net: worst-case hitch ~2.8× smaller, moderate hitches ~2.4× fewer, main thread mostly idle, and the catastrophic initial-bake freeze eliminated. Dev is now usable (login → spawn → in-world → move, no freeze; `?netWorker=1` also keeps the session alive through any residual stalls). Dev wasm shrank 19.7 MB → 16.8 MB.

**Build-time cost:** a one-time ~6.5 min cold rebuild (recompiling the dep tree + 3 crates at opt3). Deps + those crates are then cached, so incremental **app-code** rebuilds (the common iteration case) recompile only `holtburger-web` at opt0 — **measured ~17 s** (`touch src/lib.rs` → `wasm-pack build --dev`), i.e. iteration speed is preserved (faster, even, than the old ~1 min opt0 cold build).

## The "bake burst" — profiled 2026-07-07 (what it actually is)

A follow-up investigation drilled into the residual burst with CPU profiling (CDP `Profiler`, parent-chain attribution, `?nullRender` to isolate CPU from GPU) and an in-wasm timing probe. Findings **corrected two wrong hypotheses** (a multi-agent design pass first blamed the collision drain; the terrain bake was also a suspect):

- **NOT the collision drain.** An in-wasm timer around the whole `TickMovement` `drain_pending_*_into(&mut w.scene)` block (`lib.rs:~45445-45603`) never exceeded **8 ms/tick** even during bursts. Collision draining is not the hitch.
- **NOT terrain.** `terrain-mesh` was ~0 % of burst samples; the terrain atlas normal-gen is a one-time boot cost.
- **It is main-thread ASSET MATERIALISATION** — decode + integrity-check of world content as it streams/loads:
  - `holtburger_manifest::catalog::crc32_ieee` — per-record CRC32 — was **~19 %** of a town-load profile, running unoptimised (manifest was not in the opt3 list). **Fixed** by adding `holtburger-manifest` (+ `-content`, `-common`, `-resource-http`, `-scenery-bake`, `-suite-bake`) to the dev opt3 list above — CRC32 dropped off the profile.
  - The rest is inherent decode: surface `Texture::to_rgba8` + `normal_gen` (entity/statics surface pixels), `sha2` hashing, and heavy `Vec` alloc/free churn for the decoded pixel/normal buffers.
- **The worst case — teleporting into a dense town — is a single ~9 s synchronous freeze on dev** (a fraction of that on release). It is the whole town's `ObjectCreate` burst materialised in one JS task: many entities' surfaces decoded + geometry assembled synchronously. `opt-level` shrinks each unit but cannot spread one giant synchronous task. Notably, entity surface decode (`fetch_entity_surfaces_pixels`) runs on the **main thread** — unlike statics decode, which is already offloaded to the `bake_worker` (0 fallbacks observed).

## Remaining (the real residency work — would also help RELEASE)

The opt-level fixes cut per-unit cost (and made dev streaming much better), but the town-teleport freeze is a **synchronous-materialisation** problem — the residency item on the roadmap. Two changes, both of which raise release headroom too:

1. **Offload entity surface decode to the `bake_worker`** — mirror the existing statics offload (`bake_worker.js fetchSurfacesPixels` → `fetch_surfaces_pixels`). Add a `fetchEntitySurfacesPixels(Batch)` handler that runs `fetch_entity_surfaces_pixels[_batch]` in the worker's wasm and returns transferable pixel/normal/height buffers (carry the per-entity palette/`sub_palettes` dye params across the boundary). This moves `normal_gen` + `to_rgba8` for entities off the main thread entirely — the single biggest lever for the town freeze, and it helps release.
2. **Time-slice the `ObjectCreate`/spawn dispatch** — the per-landblock spawn pre-warm (`spawns.js` F.41 batch, `pendingDispatches` path) and the per-spawn `_spawnImpl` decode both materialise in one synchronous pass. Dispatch a bounded number of objects per frame with a yield so a town's burst spreads across frames (mirror the proven statics `F3` time-slice at `statics.js:~1986-2075`). This is what actually flattens the teleport freeze; it must target the `ObjectCreate` dispatch, not the collision drain or the streaming pre-warm (both verified off-target).
