# HANDOFF — water fixed + terrain-VFX wave 0 foundation (2026-07-31)

Three Opus agents ran in parallel off the BC7/relief-v2 state: a water bugfix,
a full terrain-VFX design pass, and the wave-0 foundation the later effect
waves build on. Everything below is in this one commit. The program is PAUSED
by owner instruction after wave 0 — the next session resumes at Wave 1
(grass ‖ sand) per the plan doc.

## 1. Water — all three effects now actually run (they never did together)

`apps/holtburger-web/docs/2026-07-31-water-fix-report.md` has the full
root-cause write-up + measurement tables. Ten bugs; the headlines:

- **texMerge silently froze water scroll world-wide since 2026-07-02** — the
  merge composite sampled every slot at the unscrolled `cellUv` and then
  overwrote the blended result. The 07-08 "waterScroll fix" validated uniforms,
  never pixels.
- **The sheen never executed** — it lived inside `if (uPbrEnabled &&
  !acGouraud)` and retail Gouraud (default-ON) wins that test.
- **Player proximity tore the water open** — the subdiv LOD boundary moves
  with the player and a raw per-vertex sine is not linear along cell edges
  (up to ~0.23 m crack). Fix: the swell is **lattice-locked** — evaluated on
  the 24 m control grid and bilinearly interpolated, so every subdiv factor
  produces the identical surface.
- **POM fought the scroll** (off-registration): water now bypasses POM and the
  scroll UV derives after the march.
- **Two masks, not one**: `uWaterCodeMask` {16-20} (swell physics) vs
  `uWaterSurfaceCodeMask` {16-20,22} (the look) — FauxWaterRunning 22 flows
  like its retail-shared-surface twin 16 but does not displace. SeaSlime 23
  stays out of both (it is FAM_SWAMP; wave 3A owns it).
- `readStrictWaterCodesFlag` was the `!== "off"` footgun AND returned a
  different set under node than in browsers — fixed to one browser-true
  default. New orthogonal gates: `?waterWave` (geometry) vs `?waterScroll`
  (surface); `waterEnv` sheen now has a 30→160 m slope/mip/contribution fade.

Verified: `test_terrain_water.mjs` 73/73 (new), all terrain suites green, and
a **GPU harness** (`test_terrain_water_gpu.html` — renders the real shader
source, A/B by swapping terrain.js): shipped-default scroll 0.00% → 33.36%
pixels moving; `all_three` 15.94 (== swell_only, i.e. one effect ran) → 35.22;
LOD-boundary identity error 14.64% → 1.97% (rasterisation floor is 1.91%).

**OWED: one real-GPU look** on :8767 `?terrainBc7=on&texBc7=on` (or the 1070):
(a) does the sheen fade band read as a ring, (b) does code 22 now match its
WaterRunning neighbours. This box went memory-tight so the agent stopped
cleanly instead of OOMing; everything else is numeric + SwiftShader verified.

## 2. The design doc every later wave executes

`apps/holtburger-web/docs/2026-07-31-terrain-vfx-plan.md` (1,461 lines,
self-contained — implementation agents need no other research). Terrain codes
0..31 → families GRASS{1,3,9,21,28,29} SAND{10,11,12} ROCK{0,13,14,30}
SNOW/ICE{2,15,27} SWAMP{4(+23)} VOLCANO{6,25,26} DIRT{5,7,8,24,31}
WATER{16-20,22}. **Zero new npm packages** — every candidate failed r184
compat, doesn't exist, or would bypass the in-repo particle owner-registry /
quality / degrade systems. §2.6 has the four traps (park fires no evict
callback; subdiv path ignores the terrainCode attribute; log-depth composer;
dead uWindDir), §2.7 the BC7-arm/atlased-statics rules, §7 the wave plan,
§8 sixteen live risks.

## 3. Wave 0 foundation (landed, live-verified, everything ship-OFF except the inert spine)

- `scene3d/terrain_families.js` + `scene3d/terrain_oracle.js` — terrain code /
  family / height / face normal at any world (x,y); park-survival cache
  (never scans scene children); `cornerCodes` for boundary feathering;
  allocation-free `sample(x,y,out)`. Height parity vs wasm: max 8.9e-6 at
  f32-quantised coords; **subdiv meshes are bit-identical** to the oracle
  math (plan §8 risk 1 RESOLVED — no raycaster fallback needed for grass).
  ⚠ wasm `terrainHeightAt` binds coords as f32 (~4 mm ULP at Dereth coords):
  sample at `Math.fround` or use ≥3e-3 tolerance.
- `scene3d/terrain_vfx.js` — per-landblock spawn/despawn spine:
  `registerTerrainVfx(provider)` / tick / stats, landblock+camera scopes,
  family gating from the LB's 81 codes, provider error containment,
  `window.__terrainVfx` with `oracleSelfTest()` (**passes live**: 66
  compared, 0 failures, maxErr 4.4e-4). Lifecycle hooks **chain** with
  `terrain_batch`'s and re-assert at the attach seam (absorb re-installs the
  bare hook — live-caught). VFX group is a **sibling** of terrainGroup
  (lru park/evict/rebake scan terrainGroup.children). Oracle imported lazily
  on first provider registration. Wireframe guard + `?terrainVfx=off` master
  kill both verified as clean no-ops.
- `scene3d/trail_map.js` — shared R8 ping-pong stomp/footprint/mud render
  target: texel-snapped centre (proven live), reprojection on scroll,
  frame-rate-independent fade, teleport clear, no readback; THREE/renderer
  injected so it tests pure-node. 0.375 m/texel at defaults — snow (wave 2A)
  likely wants a second high-res map (plan §8 risk 7).
- Flags: `terrainVfx` (on, opt-out master), `terrainTrail` (strict `=== "on"`,
  OFF all tiers), `terrainTrailRes/Radius/Fade` numerics — all with Reader
  rows in url-flags.md; quality keys in all 4 tiers; DEFAULT-ON count still 14
  (`test_vfx_flags.mjs` split into DEFAULT_ON_IDS/SHIP_OFF_IDS).

## 4. Combined verification of the merged tree (this commit)

water 73 · families 49 · oracle 76 · vfx_lifecycle 88 · trail_map 61 ·
vfx_flags 34 · texmerge 33 · park_storm 36 — all 0 failed;
quality_preset 30/2 (the 2 are pre-existing on HEAD, verified by stash);
`lint-url-flags` exit 0. Bare-default live boot: 0 console errors, zero
behavior change. Pre-existing unrelated failures (also fail on HEAD):
`test_terrain_visual_z.mjs` (imports a removed export, needs THREE_PATH),
rust `terrain_subdiv::…corner_ring…`.

## 5. Resume here (Wave 1, two agents — plan §7)

- **1A GRASS**: factor `terrain_scatter.js` out first (own commit), then
  `terrain_grass.js` + stomp via trail_map. Does NOT touch the terrain
  fragment shader this wave.
- **1B SAND**: `terrain_sand.js` (streamers, dust devils, grain sparkle) —
  the only wave-1 agent in the terrain fragment shader; must register with
  the POM `cellUv` offset + the new `cellTouchesWater` bypass, and update the
  `terrain_batch.js` attribute whitelist if adding a geometry attribute.
- Wave-1 notes from 0B: `ctx.oracle`/`ctx.trail` are live getters (never
  stash); `registerTerrainVfx` replays the resident ring; unpark of a
  never-seen LB fires `onLandblockReady`; grounding must use the oracle's JS
  path (wasm terrain cache missed 434/500 resident LBs live).
- Tune every effect on :8767 with `texBc7=on&terrainBc7=on` (look target),
  never the :8765 CC0 arm. Batch 1070 eye-tests; add the owed water look.

## 6. Session housekeeping

serve.py :8765 and the :8767 BC7 serve both left running; ACE alive (restart:
`/mnt/wbterminal2/ace-logs/start-ace.sh`). The 1070's pre-existing CDP test
tab on :9333 was left on an error page by a stray goto (harmless; reload it).
Agents' ACE accounts: tailnet1 (water), smoketest1/2 (0A/0B).
