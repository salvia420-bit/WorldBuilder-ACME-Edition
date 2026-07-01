# Handoff — perf session 2026-07-01: root cause, landed fixes, pending non-1070 work

## TL;DR
Per-move jank root cause: **the port RE-DECODES geometry per landblock and BULK-EVICTS**, where retail kept decoded objects in a refcounted resident cache (`DBOCache`) behind a fixed player-centered slot grid (`LScape`). Statics have **no cross-LB geometry cache** (buildings do, via `buildingBakeCache`). This session **landed three wins** and scoped the fuller fix. All measured on the SwiftShader laptop — **the 1070 was offline the entire session** (last seen 9h+ ago), but none of the landed work needed it.

## Landed (this commit)
1. **`bakeWorker` default-ON** (`scene3d/bake_worker_client.js`; opt-out `?bakeWorker=0`) — offloads model-mesh + surface-pixel decode to the worker. A/B measured **−24% main-thread longtasks, −34..37% on the 100–500ms per-LB decode stalls**, 0 errors, fail-safe (transparent main-thread fallback). Decode is byte-identical (only *where* it runs changes) → no 1070 eye-test needed.
2. **Rust triangulation memo** (`apps/holtburger-web/src/lib.rs`, `triangulate_model_with_substitutions_and_mtable`) — a `thread_local MODEL_TRI_CACHE` keyed by `model_id` on the substitution-free path. Decode-once-per-wasm-instance (persists in the default-on bake worker's instance) instead of re-triangulating the same tree/rock/wall for every LB. Byte-identical (deterministic decode) → no eye-test gate. This is the correct-layer version of "give statics a cross-LB decode cache" (system state in Rust, not a JS cache).
3. **Built `pkg/` as `--release`** — the shipped wasm was an unoptimized **`--dev` build (18MB → 4.5MB release)**. That alone fixed the SwiftShader boot 'scene-ready' 90s timeout, raised fps ~5→8, and (combined with the memo) cut a 5-min wireframe walk from **1062 longtasks / 124.5s jank → 42 / 5.8s** — movement jank effectively eliminated (lt flat across the whole walk, 0 errors, `tp=0`).

## Perf harness (repeatable, no 1070 needed)
- **Build (ALWAYS release):** `env PATH="/home/wbterminal/.cargo/bin:/usr/local/bin:/usr/bin:/bin" capped-build wasm-pack build --target web --out-dir pkg --release` (dev pkg = ~4× tax; a separate `--out-dir pkg-X/` lets you A/B without clobbering `pkg/`).
- **Run:** `OUT=<dir> SETTLE_S=60 WALK_S=300 WIREFRAME=1 MOVE_MODE=walk PVS=3 QUALITY=low AGENTIC=low TELEPORT=1 node scripts/perf-worker/walk-west-driver.mjs` → `samples.jsonl`/`summary.json`/`longtasks.json`. `python3 scripts/perf-worker-analyze.py <dir> --table`.
- **Modes:** `MOVE_MODE=hop` (`@teleloc` landblock hops, robust) | `walk` (held-'w' + stuck→teleport; needs `WIREFRAME=1`'s ~5–8fps to not starve input). `BAKE_WORKER=1` forces the worker (now default-on).
- **Trust these metrics on the laptop (GPU-independent):** main-thread **longtasks** (the hangs), `cumDrawCalls` (via `renderer.info.autoReset=false` delta), `meshTotal`/`visChain` (culling), `terrainBakedLbs.size` (streaming — `pose.landblockId` freezes <1fps), heap. **Absolute FPS is NOT representative** (SwiftShader).

## Pending — non-1070 to-dos (do next; no real GPU required)
1. **Isolate the memo:** release-no-memo vs release-memo A/B (revert the `lib.rs` memo → `--release` into `pkg-nomemo/` → same walk → compare to 42) to split the memo's share from the dev→release win. Shipped-dev wasm backed up at `/tmp/pkg_prememo_backup.wasm`.
2. **Fuller Rust residency** (the real end-state — from the 3-investigator sweep, all grounded in `acclient.c`):
   - Cross-LB **static geometry cache in Rust** (not JS) — `statics.js` rebuilds `BufferGeometry` per LB; do the residency in the wasm layer (retail `DBOCache`).
   - **Memoize `resolve_did_degrade`** (`lib.rs` ~7376) — it re-parses the GfxObj a *second* time per call for LOD models (trees).
   - **Fixed slot-grid residency + warm-park eviction** — replace the timestamp-LRU bulk-dump (`landblock_lru.js` `tickEviction` ~186) with retail's `LScape::update_block` shift-and-reuse (edge-only churn, interior pointer-copied, no re-bake-on-return, no ~4000-mesh dispose spike).
3. **Prefetch race** (43 magenta-fallback textures/run): Index16 surface decode needs its palette (`0x0400xxxx`) prefetched, but the prefetch batch omits palette DIDs the surfaces reference. Fix in the surface-fetch path (`fetch_surfaces_pixels` / `crates/holtburger-resource-http` `ManifestResourceSource` prefetch) → prefetch referenced palettes before decode.
4. **Terrain atlas → Web Worker** (the 22.6s boot stall): the 33-layer `DataArrayTexture` build is still synchronous main-thread (`terrain.js`); `bake_worker` only offloads statics/surface decode. Off-thread build (OffscreenCanvas/ImageBitmap transfer) — perf-testable on the laptop (visual eye-test later).
5. **Offline pre-triangulated geometry bake** — ship packed mesh in `dist/` via the existing `holtburger-suite-bake` sidecar infra, eliminating runtime triangulation entirely. Structural, bigger.

## Areas of general exploration for future perf work
- **Rust decode/residency layer** — `apps/holtburger-web/src/lib.rs`: `fetch_model_meshes`(~10153) → `triangulate_model`(~7293) → `pack_model_mesh`(~7443). The crown-jewel perf surface; cross-reference retail `acclient.c` (`DBOCache` 83485 `GetIfUsing`; `LScape` 306399 / `update_block` 307786/307916). ⚠ Bash/grep redacts these identifiers to `ln` — use the Read tool.
- **JS bake/stream/evict** — `cells.js` (`tickPvsLoadExpansion`), `statics.js` (`bakeStaticsForLandblock`), `landblock_lru.js` (eviction), `static_atlas.js` (cross-LB batcher, already default-on = 21 multidraws + 232 instanced — the "5,400 draws" wall is SOLVED), `stream_bake_guard.js`.
- **The 1070-gated backlog** (deferred until the box is back): shader-program trim (72 programs), texture fidelity / surface parity, the visual-suite eye-tests (owed), foliage/atlas cross-LB merge. See `2026-06-27-perf-fps-foliage-and-atlas-handoff.md`, `docs/HANDOFF-perf-followups-3-levers-2026-06-22.md`, `docs/HANDOFF-shader-compile-trim-72programs-2026-06-22.md`.

## Gotchas (also in MEMORY.md `perf-maintainability`)
SHIP RELEASE wasm (dev `pkg/` = 4× tax) · `capped-build` needs `~/.cargo/bin` on PATH · wasm crate is `apps/holtburger-web` (NOT `crates/holtburger-web`) · Bash redacts wasm decode identifiers to `ln`, Read is clean · system caches belong in Rust not JS (a JS shared-geom cache = a 4-site `__cacheOwned` double-free dance, unvalidatable without the 1070) · verify agent file:line leads (they hallucinate + cite stale premises).
