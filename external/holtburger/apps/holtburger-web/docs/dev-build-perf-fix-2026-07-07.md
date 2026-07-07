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

1. **Offload entity surface decode to the `bake_worker`** — ✅ **LANDED 2026-07-07.** Mirrored the statics offload: `bake_worker.js` gained `fetchEntitySurfacesPixels` + `fetchEntitySurfacesPixelsBatch` handlers (running `fetch_entity_surfaces_pixels[_batch]` in the worker's own wasm), `bake_transfer.js` gained `serializeEntitySurfacesBatch`/`reconstructEntitySurfacesBatch` (+ `hasPalette` now rides the shared `SurfacePixels` payload for the dyed ClipMap ref), and `bake_worker_client.js` gained `entitySurfacePixelsFetcher` / `entitySurfacesBatchFetcher` (transparent main-thread fallback). Wired: `spawns.js` F.41 pre-warm batch, and the `entities.js` spawn + hot-swap sites — both the dyed single-call path (`fetchEntitySurfacesPixels`) and the non-dyed sibling `materialCache.preload(…, fetch_surfaces_pixels)` (now `surfacePixelsFetcher`). Pure-JS change — the wasm already exported all three symbols. Rides the existing **default-on `?bakeWorker`** flag (opt out `?bakeWorker=0`); no wasm rebuild, no new flag.
   - **Verified (headless, release wasm, Holtburg, SwiftShader):** raw-vs-worker output **bit-equivalent** (single + batch, `hasPalette` carried, single-shot `payloadAt` MOVE preserved), **0 worker fallbacks / 0 page errors**, entities stream normally through the offloaded path (`entityMap`→18). **Worst main-thread block for a repeated 82-surface batch decode dropped 3506 ms → 54 ms (−98%)** — i.e. the "whole town's decode in one JS task" freeze is moved off the main thread. Worker wall-time is higher (postMessage/transfer through one worker) but the main thread stays responsive — the same trade the statics offload already ships. Harness: `scratchpad/entity_surface_perf_probe.mjs` (heartbeat max-gap = longest main-thread freeze).
   - **Still on the main thread (follow-up, same one-line `surfacePixelsFetcher` swap):** the peripheral entity `fetch_surfaces_pixels` sites in `entities.js` (prefetch ~4414, surface-refresh retry ~13334, and the `ents_wasm` sites ~9762/13606). Left out of this pass to keep the change cohesive; none fire in the F.41 town pre-warm burst.
2. **Time-slice the `ObjectCreate`/spawn dispatch** — ✅ **LANDED 2026-07-07.** Implemented at the single funnel `loop.js#_armSpawn` — **every** non-legacy spawn route (the live array hook + single hook, the pre-init3D backlog replay, the synthetic `spawns.js` injector, and the standalone drain) flows through it. Key correction to the original pointer: with a **live session** the synthetic `spawns.js pendingDispatches` path is **gated off** (`spawns=auto` → wire feeds spawns; it double-spawns otherwise), so the real teleport/login burst is the **wire dispatch**, not `spawns.js` — funneling at `_armSpawn` covers both. `_armSpawn` now snapshots `toMeta(upd)` (so the wasm handle's post-tick `.free()` is safe) and defers non-local spawns into a `Map`-backed per-tick pump (`_pumpDeferredSpawns`, `?spawnDispatchPerTick=N` default 6, `setTimeout(0)` yields like statics F3); the local player still dispatches immediately (camera latch), and `_armRemove` cancels a still-queued spawn (`_cancelDeferredSpawn`) so a spawn-then-despawn in the same burst can't orphan. Safe because `em.spawn` is **already** async fire-and-forget — nothing downstream assumes a synchronous spawn (`_armPosition` already stashes pose + no-ops `setPose` for a not-yet-spawned guid). Default ON; `?noSpawnTimeSlice=1` reverts to inline dispatch.
   - **Verified (headless, release wasm + worker offload, SwiftShader):** isolated 120-spawn burst fired through the real `__scene3dEntityHook` seam on a warm setup (no terrain/statics confound), time-slice ON vs OFF: **worst main-thread freeze 2020 ms → 561 ms (−72%)**, blocks >100 ms **7 → 1**, total long-task time 2609 → 842 ms; all 120 spawns materialise both arms, 0 errors. Live cross-check: a Holtburg→Arwic teleport (109–132 entities) fully populates with the local player present and 0 errors. Harness: `scratchpad/spawn_timeslice_isolated.mjs`.
   - **Residual / tuning:** the ON arm still shows one ~560 ms block (6 heavy-creature continuations per tick on SwiftShader); lower `?spawnDispatchPerTick` trades a smaller peak for more frames-to-populate. Finer still would need per-continuation yielding inside `_spawnImpl` — past the point of diminishing returns for this change. The `_prewarmFromBatch` streaming pre-warm is deliberately **not** sliced (handoff "off-target").
