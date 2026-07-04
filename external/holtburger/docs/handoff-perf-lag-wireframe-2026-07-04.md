# Handoff 2026-07-04 — perf (quality=low / wireframe) + network-timeout lag

Session goal: fix (1) a perf issue that "appears without textures" at `?quality=low&wireframe=1`,
and (2) a lag issue (suspected ACE server; user considered rebooting it).
All measurements below are live GTX-1070 (CDP :9333 tunnel), quality=low, spawn location
(camPos ≈ 32532, 96.8, −34561), 121-LB plateau, fresh `?nosw=1` boots.

## TL;DR

- **Normal mode is healthy**: 23 fps @ ~1,355 draws steady. No regression in the 44 commits since
  `ca8e5e03` — `terrainBatch` default-ON verified GOOD by A/B (off = 20.7 fps @ 1,577 draws).
- **Wireframe mode is the real defect**: 4.5 fps @ ~10,000 draws at the same spot — wireframe
  DE-batches statics (~4,100 plain meshes) and doubles buildings/cells/entities via fill
  companions. Root cause fully diagnosed (below); final one-gate fix is **NOT yet landed**.
- **Lag ≠ server**: ACE is healthy (fast saves/ticks, months-long identical timeout pattern across
  restarts). Cause is client-side keepalive starvation; two mitigations SHIPPED this session.
  **Do not bother restarting ACE.**

## Shipped this session (all in this commit)

1. **wasm keepalive** — `SessionCommand::ForceKeepalive` + `sendKeepalive()` export
   (`src/lib.rs` ~19992 / ~29913 / ~41340, gated `LoopState::InWorld`), driven by a 2.5 s
   `setInterval` in `index.html` (~5078, guard `window.__hbKeepaliveInterval`, dynamic handle
   lookup survives reconnect). ACE drops sessions after 60 s without ANY inbound packet
   (`NetworkManager.DefaultSessionTimeout`, Config.js `DefaultSessionTimeout: 60`); previously the
   only keepalive lived in the rAF-coupled main-thread task → occluded tab / saturated main thread
   → chronic "Network Timeout" drops (1,299 across both ACE log files, every day since 05-06,
   lifetimes = activity burst + exactly ~60 s silence). **wasm rebuilt `--release` (4,716,554 B);
   pkg/ is gitignored — rebuild after pulling.**
2. **net-drain watchdog** — `scene3d/index.js` ~2224: 500 ms interval, no-ops while
   `__lastPumpMs` is <1 s fresh; when the rAF pump stalls >1 s it calls `window.__netFramePump()`
   directly (net drain only, not the render tick). `?netWatchdog=off` escape. Complements #1:
   keepalive keeps the session, watchdog keeps messages draining.
3. **wireframe fill-companion fixes** (`materials.js` addFillCompanions):
   `BatchedMesh` sources skipped (was drawing the whole allocated batch buffer at the origin —
   wrong AND expensive); animated-scenery instanced buckets skipped (frozen-ghost fill);
   new `?wireFill=0` disables the whole companion pass (default ON preserves the occluded look).
   Reader `scene3d/index.js:580` → `MaterialCache.wireFill`.
4. **willReadFrequently** on the three terrain-atlas readback canvases
   (`scene3d/adapter.js` 357/478/555) — kills the Chrome getImageData warnings and the
   per-LB-bake GPU→CPU stall.
5. **statics.js `bakeStaticsRing` wireframe branch** (~2774) — correct in principle but
   **the ring path is RETIRED in the live client** (boot is spawn-driven per-LB; only
   capture_world_expand_e2e.cjs / smoke_test.cjs call it). Kept: harmless, helps captures.

## The remaining wireframe fix (next session — small, fully diagnosed)

Live census, same camera: normal = terrain 1 batched / statics 703 draws (535 batched);
wireframe = terrain 242 plain / statics 4,708 draws (4,211 plain) / buildings-cells-entities
exactly ×2 (fill companions, by design).

Mechanism, verified in code + live:
- The live statics path is `bakeStaticsForLandblock` → `consolidateStaticSingletonsCrossLb`
  (`statics.js` ~2077-2090 → `static_batch_x.js` ~163). It batches fine in wireframe (the 493).
- The leak is `static_batch_x.js` ~200: `if (group.length < 2) { out.push(...group); continue; }`.
  Materials appearing once per per-LB feed are punted to the downstream **statAtlas** seam.
  Normal mode: atlas absorbs them (needs `mat.map.image.data`, `static_atlas.js:389`).
  Wireframe: shared MeshBasicMaterial buckets have **no `.map`** → atlas passthrough → plain Mesh
  → + wireFill companion each → ~4,100 draws and tripled node count (2,287 → 6,222).
- **Fix**: in wireframe mode only, consume lone groups too (drop the `<2` gate; the cross-LB
  region buckets are persistent, so ~121 LBs of loners collapse into ~32-per-region buckets).
  Keep the gate untouched when wireframe is off. Batched statics automatically lose their fill
  companions (BatchedMesh skip). Expected result: wireframe ≈ or cheaper than normal mode.
  Terrain (242 plain in wireframe) deliberately left unbatched — `terrain_batch.js:502` gates on
  wireframe and the batch machinery is hard-coupled to the textured DataArrayTexture path;
  low value (242 draws) vs high risk.

## Measurement traps (cost real time today — add to runbooks)

- **Chrome clamps timers/rAF to 1 Hz for the off-screen test window** (−32000 position) even with
  `visibilityState === "visible"` → fake p50 = 1008.3 ms, 79% idle profile, streaming crawl,
  starved batching (census looks "broken" mid-stream), boot watchdog 'error'. Launcher with
  `--disable-background-timer-throttling --disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding` is on the box: **`C:\Temp\launch-wls-nothrottle.bat`**
  (profile `C:\Temp\cdpwb-nothrottle`).
- **Account-in-use gap is >60 s, not ~25 s**: the client never sends a clean logoff; navigating
  away only closes the WS, ACE holds the UDP session until the 60 s timeout. Re-login inside that
  window boots BOTH sessions ("Account In Use").
- `?profileStatics=1` (exactly `1`, not `on`) for `[profileStatics]` bake marks.
- probe: `PW_DIR=<npx playwright-core dir> node ~/from-vm/probe1070.cjs status|watch|attrib|eval`.

## A/B record (steady state, 121 LBs)

| arm | fps | p50 | draws |
|---|---|---|---|
| normal, defaults | 23.3 | 41.7 ms | 1,355 |
| normal, `terrainBatch=off` | 20.7 | 49.6 ms | 1,577 |
| `wireframe=1` (pre- and post-ring-fix — identical) | 4.5 | 225 ms | ~9,900 |

Streaming worst-frames 1.5–2.7 s in all arms (shader compiles + bakes; #4 shaves the readback
part). `singleDriver`/`syncPhysicsTick` defaults are NOT a regression (flipped 06-12/06-17, ran in
the good baseline; `syncPhysicsTick=off` A/B: no change). The `posePublishPostTick` warning is a
one-frame camera-lag note, unrelated to perf.
