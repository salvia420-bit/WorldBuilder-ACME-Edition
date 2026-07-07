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

## Remaining (follow-up — would also help RELEASE)

The residual ~488 ms hitches are the **bake burst**: many landblocks baking in one synchronous chunk on the main thread. `opt-level` shrinks each unit of work but doesn't spread the burst. Two algorithmic fixes, both of which would smooth dev further AND raise release headroom (the reporter's intuition that "fixing dev could help release" is correct here — release just absorbs the burst better):

1. **Time-slice the landblock bake** — bake a bounded number of landblocks per frame with a yield, instead of draining the whole queue in one `TickMovement` arm pass. (There is already `?frameBudget` machinery for render-side deferrables and a terrain ring-bake; extend that discipline to the wasm-side terrain/AABB/BSP build.)
2. **Offload terrain normal-map + texture decode to the `bake_worker`** — the model-mesh/surface-pixel decoders already run there; the terrain-atlas/normal build does not. Moving `normal_gen` + `to_rgba8` off the main thread removes them from the frame budget entirely.
