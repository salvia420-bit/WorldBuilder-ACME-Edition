# Visual Fidelity Push — Tiered Plan (Tiers 0–3)

**Date:** 2026-05-13
**Status:** Plan, not started
**Target:** `emit-dynamic-site` / `holtburger-web` 3D renderer (active when URL has `?renderer=3d`)
**Authors:** synthesized from a three-agent audit of the current renderer state (terrain, materials, surface data)
**Cross-cutting goal:** push visual quality from "2000-era game with modern shading" to "AAA-adjacent stylized realism" without changing what flows over the wire to ACE-compatible servers

---

## 1. Why this plan exists

Asheron's Call's wire protocol and physics are organized around 192m × 192m landblocks with a 9 × 9 vertex grid (24m spacing). That grid is **server protocol**: the heightfield broadcast, the cell graph, the collision math, the player position payload — all of it agrees on the 24m sampling. Keeping it lets us connect a player using our client to any ACE-compatible server (Coldeve at 1000 concurrent, future community shards, etc.) and benefit from the network effect of a shared ecosystem.

What's important to internalize: **the server protocol determines what the network sends. It does not determine what the GPU rasterizes.** The Three.js render mesh, the per-pixel shading, the texture sampling, the post-processing — all of that is local to the client and can be embellished arbitrarily as long as:

1. Network packets are unchanged.
2. Collision math still uses the 24m grid (the server is authoritative on position).
3. Visual deltas don't push players "into" geometry they shouldn't (e.g. procedural noise must be small enough to never affect navigation).

The 24m vertex grid is a year-2000 design constraint for memory and bandwidth budgets that no longer apply on the client. We can render at any density we want using the 24m heights as control points. This plan exploits that decoupling.

## 2. Baseline state (audited 2026-05-13)

Numbers and file paths gathered from three parallel audit agents.

### Terrain

| Aspect | State | Source |
|---|---|---|
| Vertices / LB | 81 (9 × 9 grid, no subdivision) | `apps/holtburger-web/scene3d/adapter.js:41-116` |
| Triangles / LB | 128 (64 quads × 2) | same |
| Material | Custom `THREE.ShaderMaterial`, GLSL3 | `apps/holtburger-web/scene3d/terrain.js:370-389` |
| Shading | Bilinear 4-corner texture blend, 6×6 atlas (1536² @ 256² tile) | `apps/holtburger-web/scene3d/terrain.js:48-127`, `adapter.js:36-39` |
| Normals / displacement / AO | None | — |
| Procedural detail | None (zero matches for `noise`, `simplex`, `perlin`, `subdivide`, `displacement`, `tessellate`) | — |
| Frustum culling | Enabled via `computeBoundingSphere()` | `adapter.js` |

### Buildings / statics

| Aspect | State | Source |
|---|---|---|
| Material class | `THREE.MeshStandardMaterial` (PBR-capable, but only diffuse wired) | `apps/holtburger-web/scene3d/materials.js:84` |
| Maps set | `map` only. No `normalMap`, `roughnessMap`, `metalnessMap`, `aoMap` | `materials.js:151-197` |
| Default constants | `roughness: 0.9`, `metalness: 0.0`, `side: THREE.DoubleSide` | same |
| Surface flag handling | Translucent, Base1ClipMap (alphaTest), Luminous (emissive), Additive | `materials.js:151-197` |
| `Detail (0x20000)` flag | Decoded but **unused** in material construction | `materials.js:62` |
| Batching | None for buildings (per-surface materials via `MaterialCache`) | `buildings.js:405-419` |

### Textures

| Aspect | State | Source |
|---|---|---|
| Decode pipeline | `Surface → SurfaceTexture → Texture → RGBA8` via `fetch_surface_pixels_impl` | `apps/holtburger-web/src/lib.rs:2520-2569` |
| Final format | RGBA8 straight (non-premultiplied) | same |
| Typical resolution | 64² to 256² | per AC retail convention |
| Wasm export | `fetch_surfaces_pixels(Uint32Array) → Promise<SurfacePixels[]>` carries `{ width, height, pixels, surfaceType }` | `lib.rs:2511`, `lib.rs:2520-2569` |
| JS-side wrap | `surfacePixelsToTexture` → `THREE.DataTexture` (SRGB, LinearMipmapLinear, Repeat) | `apps/holtburger-web/scene3d/adapter.js:519-546` |

### Lighting

| Aspect | State | Source |
|---|---|---|
| Sun | `DirectionalLight(0xfff2cc, 1.0)` at `(60, 80, 30)` | `apps/holtburger-web/scene3d/lighting.js:121-191` |
| Ambient | `AmbientLight(0xfff0e0, 0.5/0.7)` outdoor/indoor | same |
| Hemi tint | `HemisphereLight(0xb0c8ff, 0x504030, 0.15)` | same |
| Shadows | **Disabled by default.** 2048² map config present but `castShadow=false` everywhere | `lighting.js:161` |
| Per-SetupModel | Up to 32 active `PointLight` / `SpotLight`, distance-sorted | `lighting.js:14-55` |

### Surface metadata (in the DAT format itself)

| Field | Type | Notes |
|---|---|---|
| `surface_type` | `u32` bitfield | Rendering directives only — does **not** classify material category |
| Known bits | Base1Solid (0x1), Base1Image (0x2), Base1ClipMap (0x4), Translucent (0x10), Diffuse (0x20), Luminous (0x40), Alpha (0x100), InvAlpha (0x200), Additive (0x10000), **Detail (0x20000)**, Gouraud (0x10000000), Stippled (0x40000000), Perspective (0x80000000) | per `crates/holtburger-dat/src/file_type/surface.rs` |
| Texture refs | `orig_texture_id`, `orig_palette_id` | optional, present only when textured |
| Per-polygon surface | `Polygon.pos_surface: i16` indexes `GfxObj.surfaces[]` | `graphics.rs` |
| **Category metadata** | **None.** No "stone vs sand vs lava" tag in DAT | — |

### Visible-ring perf

| Metric | Holtburg 9-LB ring | Source |
|---|---|---|
| Draw calls | 153 | `docs/3d-port-state-2026-05-10.md` |
| Triangles | ~4,069 | same |
| Texture atlas memory | ~9 MB (terrain 1536² × RGBA8) | derived |
| Building texture memory | ~50 MB (rough estimate, 200 unique surfaces × 256² × RGBA8) | derived |

## 3. Performance budgets and headroom

Real-hardware budgets at 60 FPS, conservative:

| Class | Triangles | Draw calls | Texture mem | Fragment-shader complexity |
|---|---|---|---|---|
| Modern desktop | 1–3 M | 5,000 | 500 MB | ~unlimited (POM, SSAO, PBR fine) |
| Mid-range phone | 200–400 K | 1,000 | 150 MB | Watch fragment cost — POM risky, normal mapping fine |
| Low-end phone | 80–150 K | 500 | 80 MB | PBR + normal maps only; skip POM/SSAO |

Current usage (~5K tris, ~200 draw calls, ~60 MB texture mem) sits at <1% of the desktop budget and <5% of the phone budget. **The triangle / draw-call dimension has enormous headroom.** The fragment shader is the budget we need to watch on phones.

Headroom multipliers we have to spend, per dimension:

- Triangles: ~200× on desktop, ~40× on phone
- Draw calls: ~25× on desktop, ~5× on phone
- Texture mem: ~10× on desktop, ~3× on phone
- Fragment cost: Most surfaces currently sample one texture and do PBR math. POM adds 8–32 samples; SSAO adds a screen-space pass. Both viable on desktop, gated on phones.

## 4. Constraints and ground rules

Apply to every phase:

1. **Wire protocol is read-only.** Zero changes to packet structure, server expectations, or `holtburger-net`. ACE compat is non-negotiable.
2. **Collision math stays on the 24m grid.** Any subdivision/displacement is visual-only; physics keeps using `WorldState.terrain_heights` HashMap (9 × 9 per LB) for movement and snap.
3. **Visual deltas are bounded.** Procedural displacement amplitudes must be small enough (≤ ±0.3m on terrain) to never push the visible mesh away from the collision mesh in a way the player notices.
4. **Laptop OOM safety.** The local development laptop is **not** the perf test environment for heavy phases. The team agent for any tier-2 or tier-3 phase must:
   - Build and validate **correctness** (unit tests, shader compilation, small headless smoke) locally.
   - Defer **perf validation** (FPS measurement under load, mobile testing, full 9-LB ring with POM+SSAO+CSM enabled) to the live-ACE box at Tailscale `<server-ip>` or a hardware-test artifact.
   - Never launch a local capture script that loads the full Dereth bake while POM+SSAO+CSM are simultaneously active.
   - If unsure whether a local run will OOM: don't run it. Produce the capture script, ship it, and document the expected run conditions for PK or whoever's on hardware.
5. **Artifacts go on external drives.** Goldens, captures, profiler outputs, screenshot baselines under `/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/` or similar; system disk is ~96% full.
6. **All phases gate behind quality presets.** No phase ships a feature on by default at "low" or "mid" quality. The default for a new feature is **off**, then **`?quality=high`-only**, then graduated to mid/low only after live-ACE perf validation.
7. **Real game data, not synthetic.** Every visual validation uses real DAT data via WorldBuilder.Terminal, real wcid spawns, real Region 0x13 surfaces. No invented textures, no placeholder cubes.

## 5. Phase plan, in execution order

The plan is organized into five phase groups:

- **Phase 0** — free wins (already-coded toggles)
- **Phase 1** — cheap wins (procedural detail + classifier)
- **Phase 2** — moderate (mesh subdivision + animated displacement + authored hero assets)
- **Phase 3** — expensive (POM + SSAO + CSM)
- **Phase X** — cross-cutting (quality preset system + visual regression suite)

Dependency graph:

```
Phase X.2 (visual regression) ──────► should land EARLY, used to verify all subsequent phases

Phase 0.1 (shadows) ──┐
Phase 0.2 (Detail) ───┼──► Phase 1.* (cheap) ──► Phase 2.* (moderate) ──► Phase 3.* (expensive)
                      │                              │
                      │                              └──► requires Phase X.1 (quality presets)
                      │
                      └──► Phase 1.4 (heuristic) ──► Phase 1.5 (override) ──► Phase 2.3 (authored hero)
                                                                              └──► Phase 3.1 (POM, gated on stone)
```

Roughly: Phase X.1 (preset infrastructure) lands alongside Phase 0; Phase X.2 (regression) lands alongside Phase 1. Phase 1 must complete (classifier) before Phase 2.3 and Phase 3.1 are unblocked.

---

### Phase 0.1 — Enable shadow maps

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | Low |
| **Estimated effort** | 1–2 days |
| **Depends on** | nothing |
| **Blocks** | Phase 3.3 (CSM replaces this) |
| **Laptop-safe to validate?** | Yes (visual smoke, no perf test locally) |

**Context.** The single biggest perceived quality jump is shadows. The Three.js shadow infrastructure is already wired in `lighting.js:121-191` with a 2048² shadow map configured, but `castShadow=false` is hardcoded everywhere. Flipping it on requires four changes: enable on the directional light, set `castShadow=true` on building/NPC/static meshes, set `receiveShadow=true` on terrain + buildings, and configure the shadow camera frustum to cover the visible 3×3 LB ring.

**Intent.** Turn on dynamic shadows for the single directional sun light, gated behind a quality preset.

**Why this approach.** It's the lowest line-count, highest-impact change available. The renderer already loads a sun direction from the skybox chain (per `project_holtburger_skybox_done_2026-05-11.md`). Shadows complete the lighting model. We can defer cascaded-shadow polish to Phase 3.3 — a single shadow map is acceptable for tier 0.

**Objectives.**

1. Set `renderer.shadowMap.enabled = true` and `shadowMap.type = THREE.PCFSoftShadowMap`.
2. Enable `castShadow = true` on the sun `DirectionalLight`.
3. Configure shadow camera frustum: orthographic, sized to cover ~600m × 600m around the player (one full 3×3 LB ring plus margin).
4. Set `castShadow = true` on all building meshes, all entity (NPC/player) meshes, and all static-object meshes.
5. Set `receiveShadow = true` on terrain meshes and on building exterior walls/floors.
6. Add `?shadows=off|on` URL param (default off until Phase X.1 lands; once preset system exists, gate behind `quality≥mid`).

**Files to touch.**

- `apps/holtburger-web/scene3d/lighting.js:121-191` — main wiring.
- `apps/holtburger-web/scene3d/buildings.js` — add `castShadow`/`receiveShadow` on mesh construction.
- `apps/holtburger-web/scene3d/entities.js` — add `castShadow` on NPC/player rigs.
- `apps/holtburger-web/scene3d/statics.js` — add `castShadow` on static objects.
- `apps/holtburger-web/scene3d/adapter.js` (terrain construction) — add `receiveShadow=true`.
- `apps/holtburger-web/scene3d/index.js` or wherever renderer is created — `shadowMap.enabled = true`.

**Acceptance criteria.**

1. Screenshot in Holtburg at noon shows building shadows cast onto terrain.
2. Screenshot at sunset shows long shadows from buildings reaching across the plaza.
3. NPCs cast shadows visible on the ground beneath them.
4. URL with `?shadows=off` produces a screenshot indistinguishable from current baseline.
5. cargo workspace tests still 1293/0.

**Test approach.**

- Local: shader smoke test (load Holtburg, single screenshot at known sun time). Laptop-safe.
- Live-ACE: PK verifies FPS stays >40 on his phone with shadows enabled. **Do not run mobile perf testing on the laptop.**

**Hand-off notes.**

- The shadow camera frustum is the tricky bit. If too tight, shadows clip; too loose, resolution suffers. Tune for the player's current position + LB-ring extent. Update per-frame as the player moves.
- Don't enable on transparent / additive materials (waterfalls, particles) — they'll throw warnings and the result is wrong anyway. Branch in the material's `castShadow` setter on the `Translucent` and `Additive` flags.
- Don't enable on the sky dome geometry — it must remain `castShadow=false`.

---

### Phase 0.2 — Wire the `Detail (0x20000)` surface flag

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | Medium |
| **Estimated effort** | 3–5 days |
| **Depends on** | nothing |
| **Blocks** | Phase 1.2 informs design (terrain detail normal is conceptually similar) |
| **Laptop-safe to validate?** | Yes (visual smoke only) |

**Context.** AC's surface format defines bit `0x20000 = Detail`, which retail used to indicate "this surface wants a second tiled high-frequency layer composited over the diffuse." `materials.js:62` decodes the bit, but `materials.js:151-197` doesn't act on it. Honoring this is following the data's own intent.

**Intent.** Make the `Detail` flag actually do something: composite a tiled detail texture over the diffuse at higher UV frequency.

**Why this approach.** It's data-driven (we follow what retail tagged), it has direct precedent in PhatSDK/ACE rendering, and it sets up the infrastructure for Phase 1.2 (terrain detail normal). `MeshStandardMaterial` doesn't natively support a second tiled texture, so this introduces our first material variant — a useful pattern for later tiers.

**Objectives.**

1. Pre-bake or author a small set (3–5) of grayscale detail tiles (~512² each): generic-rough, stone-grain, wood-grain, fabric-weave, sand-grain. These ship as static assets.
2. Add a `DetailMaterial` variant in `materials.js` that wraps `MeshStandardMaterial` via `onBeforeCompile` shader injection (preferred over a full custom shader — preserves PBR pipeline).
3. The injected fragment shader samples the detail tile at `vUv * detailScale` and blends with diffuse via multiply or overlay mix (configurable per-flag).
4. Material picker (`_materialFromFlags`) branches: when `surface_type & 0x20000`, instantiate `DetailMaterial`, choose detail tile by surface category (post-classifier).
5. Pre-classifier: default to "generic-rough" tile. Wire the category-aware version once Phase 1.4 lands.

**Files to touch.**

- `apps/holtburger-web/scene3d/materials.js:151-197` — branch on Detail flag.
- `apps/holtburger-web/scene3d/materials.js` — add `DetailMaterial` variant (new section).
- `apps/holtburger-web/scene3d/assets/detail/` — new asset directory, ship 3–5 PNG tiles.
- `apps/holtburger-web/scene3d/adapter.js:519-546` — extend `surfacePixelsToTexture` to load detail asset.

**Acceptance criteria.**

1. Pick three retail surface IDs known to have `Detail` flag set (use WorldBuilder.Terminal to find them). Render them in 3D mode. Visually compare to retail screenshots: the surface should show high-freq texture detail at close range that fades to flat diffuse at distance.
2. Surfaces without the flag are visually unchanged.
3. FPS measured on live-ACE box stays within 5% of baseline.

**Test approach.**

- Local: `worldbuilder-terminal` query lists all surfaces in Holtburg with `surface_type & 0x20000`. Pick three, screenshot each.
- Local: shader unit test for the injected GLSL (no full render — verify the fragment compiles and samples correctly via Three.js's `WebGLShader` introspection).
- Live-ACE: PK eye-checks during normal play.

**Hand-off notes.**

- `onBeforeCompile` is the right pattern here vs full custom shader — it keeps the PBR lighting model intact and only adds the detail composite. Reference: Three.js docs, `MeshStandardMaterial.onBeforeCompile`.
- Don't mix detail at the diffuse layer multiplicatively if you want it to also affect lighting — composite via `mix(diffuse, diffuse * detail, blendFactor)` after the existing texture sample, before PBR shading.
- Detail tile scale: a good default is `vUv * 8.0` (tiles 8× per surface UV unit). Make it a uniform so per-category tuning works.

---

### Phase 1.1 — Procedural normal maps from diffuse luminance

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | Medium |
| **Estimated effort** | 3–4 days |
| **Depends on** | nothing |
| **Blocks** | Phase 1.4 uses the same decode path; Phase 3.1 reuses the heightmap |
| **Laptop-safe to validate?** | Yes (correctness only, no perf test) |

**Context.** Every surface texture is decoded to RGBA8 in `fetch_surface_pixels_impl` (`lib.rs:2520-2569`). A Sobel filter on the luminance channel produces a plausible normal map for free — no authoring required. The result feeds into `MeshStandardMaterial.normalMap`, which is already PBR-ready (`materials.js:84`).

**Intent.** Add per-pixel bump shading to every surface in the game, derived from existing diffuse data, at zero authoring cost.

**Why this approach.** It's universal — works on every texture without exception. It's deterministic — the same diffuse always produces the same normal. And it's fast — Sobel is O(W×H) with a 3×3 kernel, runs in ~1ms for a 256² texture in Rust. The result is not as good as hand-authored normals (Phase 2.3 covers hero surfaces), but it's a massive uniform uplift across the long tail.

**Objectives.**

1. Add `normal_from_luminance(rgba: &[u8], w: u32, h: u32, strength: f32) -> Vec<u8>` in `crates/holtburger-dat` (or a new `crates/holtburger-normal-gen` if scope grows). Returns RGB8 normal map.
2. Strength parameter controls bump intensity (default 1.0, tunable per-category post-classifier).
3. Extend `SurfacePixels` wasm struct with `normal_pixels: Vec<u8>` field plus getter.
4. JS-side: in `surfacePixelsToTexture`, create a second `THREE.DataTexture` from `normal_pixels`, format `THREE.RGBFormat` or `THREE.RGBAFormat`, color space **linear** (not SRGB — normals are not color data).
5. Material picker assigns `material.normalMap = normalTexture`, `material.normalScale.setScalar(0.8)` (or category-tuned scale post-classifier).

**Files to touch.**

- `crates/holtburger-dat/src/normal_gen.rs` (new) — Sobel implementation.
- `apps/holtburger-web/src/lib.rs:2520-2569` — call `normal_from_luminance`, pack into `SurfacePixels`.
- `apps/holtburger-web/src/lib.rs:2511` — extend wasm struct + getter.
- `apps/holtburger-web/scene3d/adapter.js:519-546` — create normal `DataTexture`.
- `apps/holtburger-web/scene3d/materials.js:84` — assign `normalMap` + `normalScale`.

**Acceptance criteria.**

1. With sun in motion (use `?skytime=accel`), buildings show per-pixel shading variation that wasn't present before — bricks look like bricks, planks like planks.
2. Texture memory grows by ~10–15% (one byte-per-pixel per surface, packed as RGB).
3. cargo workspace tests pass with new normal_gen unit tests (golden RGB output for a known input).
4. FPS impact <5% on live-ACE box. **Defer measurement to PK.**

**Test approach.**

- Local: cargo unit test for `normal_from_luminance` with a checkerboard input → expect alternating normals in known directions.
- Local: shader smoke (single screenshot under three sun positions, normal-on vs normal-off side-by-side).
- Live-ACE: PK perf check.

**Hand-off notes.**

- Normal encoding convention: `(0.5, 0.5, 1.0)` is "flat up" in tangent space. Pack as `[r, g, b] = [(nx+1)/2 * 255, (ny+1)/2 * 255, nz * 255]` with z derived from `sqrt(1 - nx² - ny²)`.
- For low-res 64² textures, Sobel produces choppy normals. Optionally upscale 2× before Sobel (bilinear), then downscale the normal map back, or apply a small Gaussian blur before the Sobel. Make the upscale step opt-in.
- Don't apply normal generation to surfaces with `surface_type & 0x40 (Luminous)` — emissive doesn't need bump shading. Skip and assign flat normal.
- Save normal generation results to a cache keyed on surface DID + format hash, persisted to dist/ alongside diffuse pixels, so repeat decodes are free.

---

### Phase 1.2 — Terrain detail normal map

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | Medium |
| **Estimated effort** | 3–4 days |
| **Depends on** | Phase 0.2 (the asset-loading + onBeforeCompile pattern) |
| **Blocks** | none |
| **Laptop-safe to validate?** | Yes |

**Context.** Terrain currently does bilinear 4-corner blend (`terrain.js:48-127`) — at player-camera height, the ground looks flat and smooth despite the texture. Adding a high-resolution detail normal sampled at finer UV frequency adds grass-blade, dirt-grain, sand-drift detail without changing geometry.

**Intent.** Sample a tiled detail normal map per terrain-type in the fragment shader at high UV frequency, combine with surface normal via reoriented blending.

**Why this approach.** A single 1024² normal map serves the entire visible terrain at zero geometry cost. The detail normal pulls double duty: removes the "smooth carpet" feel at the player's feet, adds anisotropic patterns (wind on sand, fiber direction on grass) without per-LB authoring.

**Objectives.**

1. Author or generate 3–5 detail normal maps at 1024² each:
   - `terrain_grass_normal.png` — irregular blade pattern
   - `terrain_dirt_normal.png` — fine granular noise
   - `terrain_sand_normal.png` — anisotropic drift pattern, stretched along a per-uniform wind axis
   - `terrain_stone_normal.png` — crack/pebble pattern
   - `terrain_snow_normal.png` — drift + crystal pattern
2. Load all into a `THREE.DataTexture2DArray` (one slice per type), indexed by terrain code.
3. Modify `TERRAIN_FRAGMENT_GLSL` (`terrain.js:70-127`) to sample the detail normal at `vGridUv * 16.0` (high freq) using the vertex's terrain code to select the slice.
4. Combine detail normal with the base surface normal via reoriented normal mapping (RNM) — preserves direction-of-detail consistently.
5. Sun lighting in the fragment shader now uses combined normal for NdotL.

**Files to touch.**

- `apps/holtburger-web/scene3d/terrain.js:48-127` — fragment shader update.
- `apps/holtburger-web/scene3d/terrain.js:370-389` — uniform additions (`uDetailNormalArray`, `uDetailScale`).
- `apps/holtburger-web/scene3d/assets/terrain_detail/` (new) — five PNG normal maps.
- `apps/holtburger-web/scene3d/adapter.js` — load array texture at scene init.

**Acceptance criteria.**

1. First-person camera walking on grass shows visible blade detail at character height (within 2m of the camera).
2. Walking on sand shows directional drift pattern that rotates with a wind direction uniform.
3. Walking on stone paths shows fine crack/pebble bumps.
4. FPS impact <3% on live-ACE box.

**Test approach.**

- Local: single screenshot per terrain type at player-eye height. Five screenshots total. Laptop-safe.
- Live-ACE: PK FPS check.

**Hand-off notes.**

- Reoriented normal blending: see <https://blog.selfshadow.com/publications/blending-in-detail/> for the math. Don't use simple UDN (whiteout) — RNM is the standard for terrain.
- Sand wind direction is a `vec2 windDir` uniform driven by Region weather state (skybox chain already updates wind). Tile the sand normal with a rotation matrix in the fragment.
- For the grass normal, ensure tiling is non-obvious — author with non-repeating high-freq content or use two octaves with different scales summed.

---

### Phase 1.3 — Triplanar mapping on terrain slopes

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | Low–Medium |
| **Estimated effort** | 2–3 days |
| **Depends on** | Phase 1.2 (combined normal in fragment shader) |
| **Blocks** | Phase 2.1 (subdivision makes slopes more dramatic, so triplanar helps more) |
| **Laptop-safe to validate?** | Yes |

**Context.** Terrain UVs are grid-based (`vGridUv = position.xy / 24.0` per `terrain.js:48-62`). On steep slopes (cliffsides, hill faces near 60°+), this produces visible texture stretching — the diffuse appears smeared along the slope. Triplanar mapping samples the same texture in three orthogonal planes (XY, YZ, XZ) and blends by the world-space normal vector magnitudes.

**Intent.** Eliminate UV stretching on steep terrain by blending into triplanar sampling above a slope threshold.

**Why this approach.** It's a fragment-shader-only fix — zero mesh change, zero new assets. The cost is three texture samples instead of one (when active), gated to slopes that actually need it. Below the threshold (flat ground), the standard grid UV remains, paying no extra cost.

**Objectives.**

1. Compute slope angle in fragment shader from interpolated normal: `slope = 1.0 - normal.y` (assuming +Y up).
2. Compute three texture samples: XY-plane (current), YZ-plane, XZ-plane.
3. Blend weight: `vec3 weights = pow(abs(normal), vec3(triplanarSharpness)); weights /= weights.x + weights.y + weights.z;`
4. Final color: `mix(gridSample, triplanarSample, smoothstep(0.2, 0.5, slope))`.
5. Apply same logic to detail normal sampling (Phase 1.2) for consistency.

**Files to touch.**

- `apps/holtburger-web/scene3d/terrain.js:70-127` — fragment shader update.

**Acceptance criteria.**

1. Capture a screenshot facing the south wall of Holtburg or the academy slope. Visible texture stretching on the slope is gone.
2. Flat terrain looks unchanged (no shimmer or seam at the slope threshold).
3. FPS impact <2%.

**Test approach.**

- Local: target Holtburg cliffs or Asheron's Castle slope. Single screenshot.

**Hand-off notes.**

- `triplanarSharpness` of 4–8 gives good blend transitions. Lower values produce muddy blends; higher values produce hard seams at 45°.
- Triplanar requires using world-space position for sampling, not vGridUv. The vertex shader needs to pass `vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;` for the fragment to use.
- Don't triplanar the atlas — the atlas-UV mapping is already done in 2D. Apply triplanar to the detail normal layer only initially; consider extending to the base diffuse atlas sample in a follow-up if visual demand exists.

---

### Phase 1.4 — Surface classifier (heuristic layer)

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | Medium |
| **Estimated effort** | 1 week |
| **Depends on** | nothing |
| **Blocks** | Phase 1.5, Phase 2.3, Phase 3.1 |
| **Laptop-safe to validate?** | Yes (pure CPU classification, no GPU load) |

**Context.** AC's DAT format does **not** carry a material-category tag on surfaces (per the audit — `surface_type` is rendering directives only). For Phase 2.3 (authored hero surfaces) and Phase 3.1 (POM gated on stone), we need to bucket surfaces into categories: Stone, Wood, Metal, Sand, Lava, Water, Foliage, Cloth, Dirt, Snow, Generic. This phase builds the heuristic layer.

**Intent.** At decode time, compute per-surface statistics (mean RGB, std dev, dominant hue, luminance, variance) and apply a rule-based classifier that buckets each surface into one of ~12 categories with ~80% accuracy.

**Why this approach.** It runs at decode time on the existing RGBA8 pixel data — no extra fetches, no manual labeling. 80% is enough to drive material parameter selection for the long tail. Phase 1.5 (override layer) catches the 20% the heuristic misses, completing the hybrid (Option 3) approach.

**Objectives.**

1. Add `crates/holtburger-dat/src/surface_classify.rs` (new module) with:
   - `pub enum SurfaceCategory { Stone, Wood, Metal, Sand, Lava, Water, Foliage, Cloth, Dirt, Snow, Brick, Tile, Generic }`
   - `pub struct SurfaceStats { mean: [f32; 3], std_dev: [f32; 3], luminance: f32, variance: f32, dominant_hue: f32, saturation: f32 }`
   - `pub fn compute_stats(rgba: &[u8], w: u32, h: u32) -> SurfaceStats`
   - `pub fn classify(stats: &SurfaceStats, surface_type_flags: u32) -> SurfaceCategory`
2. Rule set (initial — tune empirically):
   - `Luminous` flag set + high red luminance + low variance → `Lava`
   - `Translucent` flag + blue dominant + low alpha → `Water`
   - `Base1ClipMap` + green dominant → `Foliage`
   - Green dominant (sat > 0.3) → `Foliage`
   - Red > 1.5×G and B, low sat → `Wood`/`Dirt` (split by luminance: dark=Wood, light=Dirt)
   - Gray + low variance + high luminance → `Metal`
   - Gray + low variance + mid luminance → `Stone`
   - Gray + high variance → `Brick` (regular pattern) or `Stone` (irregular) — distinguish via FFT or run-length on a luminance histogram (advanced; can fall back to Stone)
   - Tan/beige (sat 0.2–0.4, hue 30–60°) + low variance → `Sand`
   - Near-white + low variance → `Snow`
   - Default → `Generic`
3. Plumb `category: SurfaceCategory` through `SurfacePixels` (new field + wasm getter).
4. JS-side: `materials.js._materialFromFlags` consults category to set:
   - `material.roughness` per category (Stone 0.85, Metal 0.3, Sand 0.95, Lava 0.4, Wood 0.8, etc.)
   - `material.metalness` per category (Metal 0.9, others 0.0)
   - `material.normalScale` per category (Stone 1.2, Sand 0.8, Lava 1.5, Foliage 0.4, etc.)
5. Add a diagnostic page (`/diagnostics/classifier.html`) that renders a grid of surface tiles each labeled with the classifier's category — used for review/tuning.

**Files to touch.**

- `crates/holtburger-dat/src/surface_classify.rs` (new).
- `crates/holtburger-dat/src/lib.rs` — re-export.
- `apps/holtburger-web/src/lib.rs:2520-2569` — call classifier, pack into `SurfacePixels`.
- `apps/holtburger-web/src/lib.rs:2511` — extend wasm struct.
- `apps/holtburger-web/scene3d/materials.js:151-197` — consult category.
- `apps/holtburger-web/diagnostics/classifier.html` (new) — debug page.

**Acceptance criteria.**

1. Run classifier over all surface DIDs in Holtburg's LB (0xA9B4). For 50 randomly-sampled surfaces, manually inspect via WorldBuilder.Terminal and confirm at least 40 are classified correctly. (80% threshold.)
2. cargo unit tests for `compute_stats` (known input → known output) and `classify` (golden cases per category).
3. Diagnostic page shows recognizable groupings: all forge surfaces categorized as Metal, all cottage walls as Stone, all door surfaces as Wood, lifestone as Lava (close enough — emissive), etc.

**Test approach.**

- Local: cargo unit tests (no GPU).
- Local: render diagnostic page, visually review.
- Local: classify all surfaces in Holtburg + Academy, dump to JSON, audit by hand.
- No live-ACE perf test needed — pure CPU work.

**Hand-off notes.**

- Don't try to make the heuristic perfect. Aim for 80% — Phase 1.5 picks up the rest.
- The `Brick` vs `Stone` distinction is hard without pattern analysis. If FFT/run-length feels like too much, lump both as `Stone` initially and treat `Brick` as a Phase 1.5 override case.
- Saturation calculation: `S = (max(rgb) - min(rgb)) / max(rgb)` (HSV formulation).
- For palette-indexed textures (P8, Index16 — see `surface_classify.rs::texture.rs`), use the resolved RGBA8 from `tex.to_rgba8()` — palette resolution already happened upstream.

---

### Phase 1.5 — Surface classifier (manual override layer)

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | Low |
| **Estimated effort** | 2–3 days (plus ongoing override authoring) |
| **Depends on** | Phase 1.4 |
| **Blocks** | full hybrid completion (Option 3) — informs Phase 2.3, 3.1 |
| **Laptop-safe to validate?** | Yes |

**Context.** The heuristic in 1.4 is ~80% accurate. The remaining 20% needs explicit overrides — surfaces the heuristic miscategorizes (e.g., a stone wall that happens to have a red-tinted normal looks like Wood; a wooden door painted gray looks like Metal). This phase implements the override layer that completes the hybrid approach.

**Intent.** Load a JSON file at startup mapping surface DIDs to explicit categories, consulted before the heuristic. Provide tooling to populate it.

**Why this approach.** It's the lowest-friction way to inject hand-curated knowledge. JSON is human-editable, version-controllable, and trivially diffable. The override layer is consulted first; the heuristic is the fall-through. Together they form Option 3 from the analysis.

**Objectives.**

1. Define schema (`data/surface_overrides.json`):

   ```json
   {
     "version": 1,
     "overrides": {
       "0x06001234": { "category": "Stone", "notes": "Holtburg cottage wall, heuristic mistakenly tagged as Wood due to mossy tint" },
       "0x06001235": { "category": "Lava", "notes": "Asheron's Castle lava floor" },
       "0x06005678": { "category": "Wood", "normal_scale": 0.6, "roughness": 0.95 }
     }
   }
   ```

   Override entries can carry just `category` (lookup the rest from category defaults) OR override individual material parameters directly.

2. Load JSON into wasm at init, expose as `Option<HashMap<u32, OverrideEntry>>` consulted before `classify()`.
3. Add CLI subcommand to WorldBuilder.Terminal: `worldbuilder-terminal surface --did 0x06001234 --dump` prints:
   - Current category (from heuristic)
   - Surface stats
   - Texture preview (ANSI-art or saved PNG)
   - Sample uses (count of polygons in retail DAT that reference this surface)
   - Suggested override (if the surface is "in the gray zone")
4. Add CLI subcommand: `worldbuilder-terminal surface --hero-survey --landblock 0xA9B4` lists the top 50 most-used surfaces in a landblock, sorted by reference count — used to drive Phase 2.3 prioritization.
5. CI lint: warn if a "hero" surface (top 100 by usage in Dereth) lacks an override entry. Doesn't fail CI — just produces a diagnostic.

**Files to touch.**

- `data/surface_overrides.json` (new) — initial set of overrides authored by hand from diagnostic review.
- `apps/holtburger-web/src/lib.rs` — load + consult.
- `apps/holtburger-web/src/surface_overrides.rs` (new) — JSON parsing.
- `worldbuilder-terminal/src/cli/surface.rs` (or wherever its CLI lives) — two new subcommands.
- `.github/workflows/ci.yml` (or equivalent) — lint step.

**Acceptance criteria.**

1. Add 10 known-misclassified surfaces from Phase 1.4's diagnostic review to `surface_overrides.json`. Re-render the diagnostic page. All 10 now show the correct category.
2. CLI dump command works for arbitrary surface DID.
3. CLI hero-survey command produces a sane top-50 for Holtburg LB.
4. cargo workspace tests still pass.

**Test approach.**

- Local: end-to-end — pick 5 surface DIDs, override them, rebuild wasm, view diagnostic page, verify override applied.

**Hand-off notes.**

- Make the override loader resilient: missing JSON file → empty override map (just use heuristic), malformed JSON → log error and continue with empty map. Don't crash the renderer on a bad override file.
- Reserve `"category": null` for "force fall-through to heuristic" (useful for testing without removing the entry).
- The hero-survey CLI command needs to scan all GfxObj records and their polygon `pos_surface` references across a landblock's loaded objects. This is a read-only DAT walk — should be fast (<1 minute for Holtburg).

---

### Phase 2.1 — Terrain mesh subdivision with bicubic interpolation + clamped noise

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | High |
| **Estimated effort** | 1.5–2 weeks |
| **Depends on** | Phase X.1 (quality presets — to gate subdiv level) |
| **Blocks** | Phase 2.2 (animated displacement reuses the subdivided mesh) |
| **Laptop-safe to validate?** | Partial — subdiv=2 is laptop-safe; subdiv=4+ defer perf to live-ACE |

**Context.** The terrain mesh is currently 81 vertices per landblock (9×9 grid, 24m spacing). On hills, the polygonal silhouette is visible — the "blockiness" the user called out. Subdividing the mesh client-side is safe because:

- The 9 control heights are unchanged (server protocol intact).
- Bicubic interpolation between control points produces smooth curves (C2 continuous).
- Small procedural noise (±0.3m amplitude) adds crevice detail without changing collision (which still uses the 24m grid).

**Intent.** Render each LB at a higher effective vertex density (33×33, 65×65, or 129×129) using bicubic-interpolated heights plus seeded simplex noise, gated by a quality preset.

**Why this approach.** Bicubic interpolation is the standard technique for smooth terrain reconstruction. Adding small-amplitude noise on top gives the "more visual crevices" the user wants without introducing collision discrepancies. The vertex count grows quadratically but starts so low (81 → 1089 at 33×33, → 4225 at 65×65, → 16641 at 129×129) that even 129×129 per LB across 9 visible LBs is only ~150K triangles — well within the mobile budget.

**Objectives.**

1. Add subdivision factor as quality-preset knob (`subdivLevel`: 1 / 2 / 4 / 8). Maps to vertex grid 9×9 / 17×17 / 33×33 / 65×65 / 129×129 effective (factor n → (n×8+1)² verts).
2. Replace position generation in `adapter.js:41-116` with:
   - Bicubic patch evaluation using the 4×4 neighborhood of control heights (requires looking at adjacent LBs at LB edges — extend or repeat boundary conditions appropriately).
   - Simplex noise sampled in landblock-global coords (LB index × 192 + local pos × 24 / subdiv) with amplitude ramped per category (terrain code).
   - For water/lava terrain codes, noise amplitude → 0 (those are handled in Phase 2.2 with animation).
3. Compute proper face normals from the subdivided positions — or use a smooth-shaded approach with computed vertex normals.
4. Verify collision is unaffected: `WorldState.terrain_heights` still uses the 24m grid via `interp_height(...)`. Player movement bilinearly interpolates the 9×9 control points, not the subdivided mesh.
5. LOD: ramp subdivision down with distance — central 3×3 LBs get full subdivision, outer ring gets half subdivision. Quality preset sets the *max*.

**Files to touch.**

- `apps/holtburger-web/scene3d/adapter.js:41-116` — terrain mesh generation rewrite.
- `apps/holtburger-web/src/lib.rs` or new `terrain_subdiv.rs` — bicubic + noise on the wasm side (faster than JS).
- `apps/holtburger-web/scene3d/terrain.js:48-62` — vertex shader unchanged but verify `vGridUv` still works post-subdiv (the UV is still `position.xy / 24`, so it does).
- `apps/holtburger-web/scene3d/quality.js` (Phase X.1) — subdivLevel preset.

**Acceptance criteria.**

1. Side-by-side screenshot: subdiv=1 vs subdiv=4 of the same Holtburg hillside. Subdiv=4 shows smooth contour, no facets visible.
2. Player walks across a Holtburg hill. Movement still snaps to the 24m collision grid — no "stairs" in walking, no floating, no clipping into the visual mesh.
3. At subdiv=8 on the live-ACE box, FPS stays >30 on desktop. **Mobile perf testing deferred to PK on hardware.**
4. cargo workspace tests pass with new unit tests for bicubic patch evaluation and noise determinism.

**Test approach.**

- Local: cargo unit tests for bicubic patch + noise (no GPU).
- Local: subdiv=2 visual screenshot of a Holtburg hillside. Laptop should handle this.
- **Do NOT run subdiv=8 + full Dereth bake locally** — deferred to live-ACE box.
- Live-ACE: PK captures subdiv=4 and subdiv=8 screenshots + FPS on his phone.

**Hand-off notes.**

- Bicubic Catmull-Rom is a reasonable default (visually pleasing curves, C1 continuous). Pure bicubic interpolation (using the 4×4 corner Jacobi tangents) is C2 but more compute. Start with Catmull-Rom; upgrade if needed.
- LB-edge boundary condition: when evaluating the bicubic at an LB edge, the 4×4 neighborhood crosses into the adjacent LB. If the adjacent LB is loaded, use its heights. If not, mirror the current LB's heights (clamp boundary). This produces a visible seam at the edge of the loaded ring — accept it for now; LB streaming is already a known problem space.
- Simplex noise: use `noise-rs` crate on Rust side, port the same seed to JS via `simplex-noise.js` if any JS evaluation is needed. Same seed everywhere = same noise everywhere = no seam.
- Per-category noise amplitude scaling (post-Phase 1.4): water/lava = 0, sand = 0.5×, stone/dirt = 1.0×, grass = 0.8×, snow = 0.3× (smooth drift).
- The 24m collision grid is **not** affected by this phase. Verify by running movement smoke tests and checking that `getLocalPlayerPose()` Z still snaps to bicubic-on-control-grid (the existing `terrain_heights` bilinear-interp).

---

### Phase 2.2 — Animated vertex displacement for water/lava surfaces

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | Medium |
| **Estimated effort** | 3–5 days |
| **Depends on** | Phase 2.1 (subdivision provides the vertex density needed for visible animation) |
| **Blocks** | none |
| **Laptop-safe to validate?** | Yes (lightweight visual smoke) |

**Context.** Some terrain codes in retail map to water (rivers, lakes, ocean) or lava (Asheron's Castle, certain dungeons). With subdivision in place, we can animate vertex displacement in the vertex shader to give these surfaces motion — rolling waves on water, surging molten flows on lava.

**Intent.** Add per-vertex Y-axis displacement driven by a time-varying noise function for vertices tagged as water or lava terrain, in the existing terrain vertex shader.

**Why this approach.** Vertex displacement is cheap (a sin/noise eval per vertex), the visual impact is strong, and it requires no mesh re-upload per frame (only a time uniform). Tying it to terrain code means it activates automatically for the right surfaces without per-LB authoring.

**Objectives.**

1. Identify which terrain codes correspond to water and lava. Use Region 0x13's terrain texture list (per `project_holtburger_skybox_done_2026-05-11.md` — Region 0x13 has 32 terrain × 89 scene × 37 STBs). Cross-reference with Phase 1.4 classifier outputs.
2. Add per-vertex attribute `aTerrainCode` (uint, packed into existing vertex format).
3. In the vertex shader (`terrain.js:48-62`), branch on `aTerrainCode`:
   - Water: `position.y += sin(time * 0.5 + position.xy.x * 0.1) * 0.15 + sin(time * 0.7 + position.xy.y * 0.13) * 0.10`
   - Lava: `position.y += simplex(position.xy * 0.05, time * 0.2) * 0.4`
   - Others: no displacement.
4. Synced animation: single `uTime` uniform fed by `renderer.update()`; same time everywhere → matched motion across LB seams.
5. For water surfaces, also add UV scroll (offset the sample coords by `vec2(time * 0.05, time * 0.02)`) and tint shift over time.

**Files to touch.**

- `apps/holtburger-web/scene3d/terrain.js:48-62` — vertex shader.
- `apps/holtburger-web/scene3d/adapter.js:41-116` — terrain code per-vertex attribute.
- `apps/holtburger-web/scene3d/terrain.js:370-389` — `uTime` uniform + per-frame update hook.

**Acceptance criteria.**

1. Capture a screenshot in a region with water terrain (use WorldBuilder.Terminal to find one — Holtburg may not have water; try lakes near Yaraq or rivers in Direlands).
2. Capture a screenshot in a region with lava (Asheron's Castle floors).
3. Both show vertex motion in a video capture (or sequential screenshots a few seconds apart show different surface shapes).
4. FPS impact <3%.

**Test approach.**

- Local: cargo unit tests for terrain code → category mapping.
- Local: short video capture (5 seconds) of water and lava surfaces. Laptop-safe.
- Live-ACE: PK eyeballs in normal play.

**Hand-off notes.**

- Lava noise should be slow and chunky (large feature size, slow time scale) — molten rock moves slowly. Water should be small-amplitude high-frequency (wavelets).
- Vertex displacement breaks the assumption that collision matches visual. Be sure the displacement amplitude is small enough that players never feel they're walking through visible lava ridges. ≤0.4m total amplitude for both water and lava.
- Don't enable displacement when subdivLevel=1 — there aren't enough verts to make the wave visible (vertices are 24m apart, wavelength would be larger than the screen).

---

### Phase 2.3 — Authored normal/roughness/AO maps for hero surfaces

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | Medium–High |
| **Estimated effort** | 1–2 weeks (authoring time dominates) |
| **Depends on** | Phase 1.4 (classifier) + Phase 1.5 (override system to point at authored assets) |
| **Blocks** | none |
| **Laptop-safe to validate?** | Yes (asset loading, no perf risk) |

**Context.** Procedural normals (Phase 1.1) are good for the long tail but flat-looking on hero surfaces — the most-seen textures. The cottage wall stone in Holtburg, the plaza pavement, common door wood, etc. are visible across most of the early game. Hand-authoring proper PBR maps for these (~50 surfaces total) is a high-leverage investment.

**Intent.** Identify the top 50 most-referenced surface DIDs in Holtburg + Academy + the noob path. For each, author a proper normal map, roughness map, optional AO map. The override system (Phase 1.5) points the renderer at these authored assets.

**Why this approach.** Quality investment concentrates where it's seen. 50 surfaces is a tractable manual workload (~2-4 hours per surface for high-quality PBR maps). The procedural path remains as the long-tail fallback.

**Objectives.**

1. Run `worldbuilder-terminal surface --hero-survey --landblock 0xA9B4` (from Phase 1.5) for Holtburg LB. Repeat for Academy (LB 0x8602). Merge and dedupe to a top-50 list.
2. For each hero surface:
   - Export the diffuse to a PNG via the CLI.
   - Author (in Substance Painter, Blender, or hand-painted) a `_normal.png` (proper height-derived normal, not Sobel-only).
   - Author a `_roughness.png` (per-pixel roughness variation — e.g., mortar between bricks is high roughness, brick face is mid).
   - Optionally author an `_ao.png` (baked AO).
   - Save under `data/surface_authored/{did}/` as `diffuse.png`, `normal.png`, `roughness.png`, `ao.png`.
3. Extend override JSON schema:

   ```json
   "0x06001234": {
     "category": "Stone",
     "authored": {
       "normal": "data/surface_authored/0x06001234/normal.png",
       "roughness": "data/surface_authored/0x06001234/roughness.png",
       "ao": "data/surface_authored/0x06001234/ao.png"
     }
   }
   ```

4. `materials.js` checks for authored entries; if present, loads those textures and assigns to material maps; falls through to procedural if absent.
5. Manifest/bake updates: authored assets are shipped alongside DAT-derived assets. Adjust `bake-dist` (per `phase-5.2-manifest-fix.md`) to include `data/surface_authored/*`.

**Files to touch.**

- `data/surface_authored/{did}/` — new asset directories (50 of them).
- `data/surface_overrides.json` — extended entries.
- `apps/holtburger-web/scene3d/materials.js:151-197` — authored-asset loading.
- `apps/holtburger-web/scene3d/adapter.js` — manifest hook for authored assets.
- `bake-dist` script / config — include authored assets.

**Acceptance criteria.**

1. The top 50 hero surfaces, viewed in 3D mode, show hand-authored PBR detail. Diff vs procedural-only version is obvious in screenshots.
2. The remaining 90%+ of surfaces are unchanged (still use procedural).
3. Texture memory growth is bounded — authored assets at 512² each × 3 maps × 50 surfaces = ~150 MB total. Mobile budget concern — gate authored-asset loading behind quality preset (high only loads authored; mid uses procedural fall-through).
4. Manifest bake (`dist/manifest.json`) correctly references authored assets.

**Test approach.**

- Local: visual inspection of each hero surface as it's authored. Side-by-side comparison vs procedural.
- Live-ACE: PK confirms FPS on mobile with quality=mid (authored OFF) and quality=high (authored ON).

**Hand-off notes.**

- Authoring 50 surfaces is the bulk of the work. This phase can be parallelized — split the 50 across multiple authoring agents/sessions, each gets a batch of 10 surfaces.
- Consistency matters: use the same authoring conventions across all hero surfaces (same normal-map convention, same roughness scale, same AO darkness). Document conventions in `data/surface_authored/AUTHORING_GUIDE.md`.
- The diffuse should NOT be replaced — keep using the DAT-decoded diffuse. Authored maps supplement, never replace, the base texture. This preserves AC's color identity.
- For surfaces with `surface_type & 0x40 (Luminous)`, an authored emissive map is also useful — for the lifestones, lava floors, magic crystals, etc. Add an optional `emissive` slot in the override schema.

---

### Phase 3.1 — Parallax occlusion mapping for stone surfaces

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | High |
| **Estimated effort** | 1–2 weeks |
| **Depends on** | Phase 1.4 (category=Stone), Phase 1.1 (heightmap derivation), Phase X.1 (quality preset gate) |
| **Blocks** | none |
| **Laptop-safe to validate?** | No — defer perf to live-ACE box |

**Context.** Parallax occlusion mapping (POM) gives the illusion of 3D depth in a texture by ray-marching through a heightmap in the fragment shader. Bricks visibly recess; mortar lines have real shadow; rough stone has crevices. It's expensive (8–32 texture samples per pixel) but transformative.

**Intent.** Add POM as a fragment-shader option for surfaces classified as Stone, gated to `quality=high` and disabled on mobile.

**Why this approach.** POM is the technique that makes stone walls "appear more real" (user's words). For a fixed asset cost (one extra heightmap, already computable from Sobel diffuse luminance from Phase 1.1), POM produces output that looks like geometry without being geometry. The cost is fragment shader time — fine on desktop, too much for low-end mobile.

**Objectives.**

1. Add heightmap output to Phase 1.1's normal generation — Sobel-derived gradient → integrated height. Store as single-channel R8 texture, shipped alongside diffuse + normal.
2. Add POM material variant (extend `DetailMaterial` from Phase 0.2 or new `POMMaterial`):
   - Vertex shader: pass tangent-space view direction to fragment.
   - Fragment shader: ray-march along view direction through the heightmap (8–16 steps), find intersection with the height field, sample diffuse/normal/roughness at the intersection UV.
3. Gate POM to:
   - Surface category = Stone, Brick, or Tile.
   - Quality preset = high.
   - Camera-to-surface distance < 10m (LOD ramp via fragment-shader pixel-size check).
4. Add self-shadowing variant: secondary ray-march from intersection point toward light direction, darken if blocked.

**Files to touch.**

- `crates/holtburger-dat/src/normal_gen.rs` — extend to also produce heightmap.
- `apps/holtburger-web/scene3d/shaders/pom.glsl` (new) — POM shader code.
- `apps/holtburger-web/scene3d/materials.js` — POM material variant.
- `apps/holtburger-web/scene3d/quality.js` — POM gate.

**Acceptance criteria.**

1. Walk up to a Holtburg cottage wall. Bricks visibly recess; mortar lines show actual depth.
2. Walk away from the wall — POM fades smoothly to flat normal mapping (no popping).
3. With `?quality=mid`, walls fall back to normal-only — no POM.
4. **FPS on desktop with POM enabled: >55 in Holtburg (PK validation, live-ACE box). Do NOT run POM perf locally on the laptop with the full Dereth bake — that's where OOM risk is real.**

**Test approach.**

- Local: shader compilation, single-surface visual smoke (load one POM-enabled surface, screenshot). Laptop-safe.
- **Local perf test: explicitly skip.** Loading 9 LBs with POM-on stone is the kind of test that OOMs the laptop. Produce the capture script, run on live-ACE box only.
- Live-ACE: PK runs perf test, reports FPS at quality=high.

**Hand-off notes.**

- Standard POM technique: see <https://learnopengl.com/Advanced-Lighting/Parallax-Mapping>. The "Steep Parallax + Relief Mapping" variant is standard; "Parallax Occlusion Mapping with self-shadowing" is the high-quality variant.
- Step count: 8 is the floor (looks ok on flat surfaces), 16 is good, 32 is ideal but expensive. Make it a uniform tied to quality preset (high=16, ultra=32).
- POM is wrong at silhouette edges (the technique can't extend geometry beyond the mesh boundary). Either accept the artifact or use silhouette clipping (advanced, defer to ultra preset).
- Heightmap integration from gradient: a standard 2D Poisson solve, or simpler — assume gradient is height derivative and integrate by horizontal scan (loses some accuracy on perpendicular variation but is much faster and good enough for stone textures).

---

### Phase 3.2 — SSAO post-process pass

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | Low–Medium |
| **Estimated effort** | 3–5 days |
| **Depends on** | Phase X.1 (quality preset) |
| **Blocks** | none |
| **Laptop-safe to validate?** | Partial — single-frame screenshot is laptop-safe; perf test deferred |

**Context.** SSAO (Screen-Space Ambient Occlusion) adds subtle darkening where geometry meets geometry — building corners against ground, eaves against walls, deep crevices in subdivided terrain. Three.js provides `SSAOPass` out of the box via `EffectComposer`. The visual uplift is significant — it's how modern games suggest dense, "lived-in" worlds.

**Intent.** Drop in `THREE.SSAOPass` behind a quality-preset gate. Tune kernel size and radius for AC's scale (~24m grid, ~2m typical building extent).

**Why this approach.** SSAO is the cheapest way to add per-frame geometric "context" shading. Adding it via the existing `EffectComposer` integration (or introducing one if not present) is mostly plumbing — the algorithm is library-provided. The risk surface is the perf budget on mobile.

**Objectives.**

1. Audit current render setup: is `EffectComposer` already used (e.g., for bloom on emissive)? If not, introduce it.
2. Add `SSAOPass` with parameters tuned for AC scale:
   - `kernelRadius`: ~2.0–4.0 (in world units — 2-4m AC scale).
   - `kernelSize`: 16 samples (default; lower for mobile if enabled there).
   - `minDistance`/`maxDistance`: tuned to skip far-distance noise.
   - `output`: `SSAOPass.OUTPUT.Default` (composited with the main render).
3. Gate to `quality=high`. Disabled on mobile regardless.
4. Verify it interacts correctly with shadow maps from Phase 0.1 — SSAO shouldn't darken under-shadow areas redundantly. Tune `bias` and combine multiplicatively, not additively.

**Files to touch.**

- `apps/holtburger-web/scene3d/postprocess.js` (new) or wherever rendering is wired.
- `apps/holtburger-web/scene3d/index.js` — main render loop.
- `apps/holtburger-web/scene3d/quality.js` — SSAO gate.

**Acceptance criteria.**

1. Screenshot of Holtburg plaza shows subtle darkening at:
   - Where cottage walls meet ground.
   - Under eaves.
   - In corners between buildings.
   - In crevices of subdivided terrain.
2. SSAO off vs on: A/B screenshot diff is visible but subtle (not over-darkened).
3. FPS impact on desktop <8% with SSAO active. **Measured on live-ACE box.**

**Test approach.**

- Local: single screenshot in Holtburg with SSAO on. Laptop-safe (single frame).
- **Do not run a continuous capture session with SSAO + POM + subdivision=8 + CSM on the laptop.** Sum of those features risks OOM.
- Live-ACE: PK runs perf test, reports FPS budget impact.

**Hand-off notes.**

- Three.js SSAOPass requires a depth buffer. Verify the renderer outputs depth correctly (it does for `MeshStandardMaterial`; might not for fully-custom shaders like the terrain shader — check and add depth output if needed).
- Don't apply SSAO to the sky dome — gate by depth (sky is at far plane).
- Tune `bias` upward (~0.025–0.05) to avoid self-occlusion artifacts on flat surfaces.

---

### Phase 3.3 — Cascaded shadow maps

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | Medium–High |
| **Estimated effort** | 1–2 weeks |
| **Depends on** | Phase 0.1 (replaces the single shadow map) + Phase X.1 (quality gate) |
| **Blocks** | none |
| **Laptop-safe to validate?** | No — defer perf to live-ACE |

**Context.** Phase 0.1 enables a single 2048² shadow map. At distance, it shimmers and lacks resolution; close-up shadows are crisp but a single map can't satisfy both ranges simultaneously. Cascaded Shadow Maps (CSM) split the view frustum into 2–4 ranges, each rendered to its own shadow map at appropriate resolution.

**Intent.** Replace the single shadow map with a 3-cascade setup: near (30m, 2048²), mid (100m, 2048²), far (300m, 1024²). Per-frame, all three cascade matrices are updated based on camera position.

**Why this approach.** CSM is the standard for dynamic outdoor scenes with a single directional light. Three.js doesn't bundle CSM natively but `three-csm` is a maintained community package, or we can hand-roll (~200 LOC). The visual improvement at distance is substantial — Holtburg viewed from the academy hilltop would show crisp shadows on far buildings instead of shimmering blob.

**Objectives.**

1. Decide: integrate `three-csm` package vs hand-roll. Recommendation: hand-roll for simplicity (it's not that complex) and to avoid the dependency. Three directional lights, each with its own shadow map, each frustum-fitted to a cascade range.
2. Cascade split distances: 30m / 100m / 300m. Tune empirically — these should map to "Holtburg town center", "across the LB", "to the horizon".
3. Per-frame: compute the orthographic shadow camera frustum for each cascade to tightly fit the visible portion of that cascade range. Update per camera move.
4. Fragment shader (in `MeshStandardMaterial` extension): sample the appropriate cascade based on the fragment's view-space depth.
5. Smooth blending at cascade boundaries (avoid visible seam).
6. Mobile fallback: CSM disabled on `quality=low` and `quality=mid`; uses single shadow map.

**Files to touch.**

- `apps/holtburger-web/scene3d/lighting.js:121-191` — replace single shadow with 3-cascade setup.
- `apps/holtburger-web/scene3d/csm.js` (new) — cascade management.
- `apps/holtburger-web/scene3d/loop.js` — per-frame cascade update hook.
- `apps/holtburger-web/scene3d/quality.js` — CSM gate.

**Acceptance criteria.**

1. Screenshot from Academy hilltop looking south at Holtburg shows crisp shadows on close buildings AND on far buildings. No shimmer at moderate range.
2. Walking close to a building shows pixel-precise shadow edges (near cascade).
3. CSM off (mid quality) — single shadow, shimmer visible at distance. Expected baseline.
4. **FPS impact on desktop <15% — measured on live-ACE box.**

**Test approach.**

- Local: visual smoke (single screenshot). Laptop-safe.
- **Local perf: skip.** CSM + POM + SSAO on laptop = OOM risk.
- Live-ACE: PK runs perf test.

**Hand-off notes.**

- CSM frustum fitting: for each cascade range, project the camera's view frustum into the light's space; bound it with a tight orthographic frustum; use that for the shadow camera. Reference: <https://learnopengl.com/Guest-Articles/2021/CSM>.
- Cascade selection in fragment: use `view_space_z` (camera-relative depth) to pick which cascade to sample. Have a fixed selection threshold per cascade.
- Blending between cascades: at the boundary, sample both adjacent cascades and lerp by depth. Prevents a visible seam.
- Don't try to use Three.js's `THREE.DirectionalLight.shadow.cascades` if it exists — last I checked it's incomplete or unstable. Hand-roll.

---

### Phase X.1 — Quality preset system

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | Low |
| **Estimated effort** | 2–3 days |
| **Depends on** | nothing |
| **Blocks** | every other phase past Phase 0 wants to gate behind this |
| **Laptop-safe to validate?** | Yes (pure plumbing) |

**Context.** Multiple later phases (POM, SSAO, CSM, subdivision level, authored asset loading) each need their own toggle, but coordinating them via per-feature URL params is fragile. A unified preset system with `low|mid|high|ultra` is simpler for users and easier to test.

**Intent.** Introduce a single `?quality=` URL param controlling all visual-fidelity toggles via a preset table. Auto-detect mobile and downgrade.

**Why this approach.** Single user-facing knob. Internally each phase still has its individual toggle (for debugging and A/B), but the preset is what users actually flip.

**Objectives.**

1. Add `apps/holtburger-web/scene3d/quality.js` (new module) exporting a `QualityPreset` config object.
2. Preset table:

   ```js
   const PRESETS = {
     low:   { shadows: false, normalMaps: true,  detailFlag: false, terrainDetailNormal: false, triplanar: false, subdivLevel: 1, hero: false, pom: false, ssao: false, csm: false },
     mid:   { shadows: true,  normalMaps: true,  detailFlag: true,  terrainDetailNormal: true,  triplanar: true,  subdivLevel: 2, hero: false, pom: false, ssao: false, csm: false },
     high:  { shadows: true,  normalMaps: true,  detailFlag: true,  terrainDetailNormal: true,  triplanar: true,  subdivLevel: 4, hero: true,  pom: true,  ssao: true,  csm: true  },
     ultra: { shadows: true,  normalMaps: true,  detailFlag: true,  terrainDetailNormal: true,  triplanar: true,  subdivLevel: 8, hero: true,  pom: true,  ssao: true,  csm: true  },
   };
   ```

3. URL param `?quality=mid` (default) selects the preset.
4. Per-feature URL overrides: `?quality=mid&pom=on` flips POM on top of the mid preset (for A/B testing).
5. Mobile auto-detection: if user-agent suggests mobile, downgrade `mid` → `low` by default (user can still explicitly request `high`).
6. Expose `window.__quality` for inspection in dev tools.

**Files to touch.**

- `apps/holtburger-web/scene3d/quality.js` (new).
- `apps/holtburger-web/scene3d/index.js` — read URL at init.
- Every phase that gates on quality reads from `quality.js`.

**Acceptance criteria.**

1. `?quality=low` produces a render with all visual-fidelity features off.
2. `?quality=ultra` enables everything.
3. `?quality=mid&pom=on` enables POM on top of mid preset.
4. Mobile user agent gets `low` by default unless overridden.

**Test approach.**

- Local: cargo / unit tests + manual screenshot at each preset.

**Hand-off notes.**

- Document the preset table in `docs/quality-presets.md`. Keep it as the source of truth.
- Future-proof: add `?quality=auto` that tries to measure FPS at boot and picks dynamically. Defer to a follow-on.

---

### Phase X.2 — Visual regression capture suite

| | |
|---|---|
| **Status** | Not started |
| **Estimated complexity** | Medium |
| **Estimated effort** | 1 week |
| **Depends on** | nothing (lands early, used by every later phase) |
| **Blocks** | none directly, but enables confidence in all subsequent phases |
| **Laptop-safe to validate?** | Setup is laptop-safe; running the full suite is on live-ACE |

**Context.** Without baseline golden images, every subsequent phase risks shipping regressions. We need a curated set of canonical views (Holtburg town center at noon, Academy from hilltop, interior of a cottage with door open, etc.) captured at each quality preset, stored on external drive, with a CI step that diffs new captures vs goldens.

**Intent.** Build the capture infrastructure once, reuse it for every phase.

**Why this approach.** Visual regressions in shaders / mesh code don't fail tests — they just look wrong. Golden-image diffing is the standard catch. Storing on external drives respects the laptop disk constraint.

**Objectives.**

1. Define ~10 canonical capture views:
   - Holtburg plaza at noon (high sun)
   - Holtburg plaza at sunset (long shadows)
   - Academy from hilltop (distance test)
   - Inside a Holtburg cottage (interior lighting)
   - Forge close-up (metal classifier test)
   - Lifestone close-up (emissive test)
   - Holtburg cliff face south of town (triplanar test)
   - Subdivided hillside (subdiv visual test)
   - POM-enabled cottage wall close-up
   - SSAO-affected building corner
2. For each view: a capture script that loads the right LB, positions the camera, sets quality preset, captures PNG.
3. Goldens stored at `/mnt/wbterminal1/holtburger-goldens/{view}/{quality}/golden.png`. Versioned with date suffix.
4. CI step (or manual `npm run visual-regression`): generates new captures, diffs vs golden using pixelmatch or similar, fails if >5% pixel delta.
5. Tooling to update goldens deliberately when a phase intentionally changes output.

**Files to touch.**

- `scripts/visual-regression/capture-all.cjs` (new).
- `scripts/visual-regression/diff-vs-golden.cjs` (new).
- `scripts/visual-regression/views.json` (new) — view definitions.
- `.github/workflows/visual-regression.yml` (new) — CI step.

**Acceptance criteria.**

1. Run `npm run visual-regression` produces 10 × 4 = 40 captures (one per view × quality preset).
2. Captures stored on external drive.
3. CI diff step works: change a shader, watch a view fail diff.

**Test approach.**

- Setup is laptop-safe.
- **Running the full suite at quality=ultra on the laptop is NOT safe** — that's 10 captures each loading full Dereth at ultra. Run that suite on live-ACE box, archive results back.

**Hand-off notes.**

- Use pixelmatch for diffing. Set the threshold permissively (5% pixel delta) initially; tighten later.
- Store goldens as PNG (not JPG) — lossless avoids false diffs from compression artifacts.
- Version goldens by date in the path. Old goldens are kept for rollback comparison.

---

## 6. Surface classification — full hybrid (Option 3) detail

Restating the chosen approach (Option 3):

> Heuristic default, manual override JSON for problem cases. Best long-term.

### Layer 1: heuristic classifier (Phase 1.4)

At decode time, per-surface RGBA8 is fed to a rule-based classifier. Rules use:

- Mean color RGB (after gamma-decode)
- Saturation (HSV)
- Hue (HSV)
- Luminance (Rec. 601 weighting)
- Variance (texture roughness signal)
- `surface_type` bitfield (already available)

Output: `SurfaceCategory` enum (12 values).

Rules tuned empirically against the diagnostic page (Phase 1.4 acceptance criterion #1). Target: 80% accuracy on Holtburg surface set.

### Layer 2: manual override JSON (Phase 1.5)

`data/surface_overrides.json` consulted first:

```json
{
  "version": 1,
  "overrides": {
    "0x06001234": {
      "category": "Stone",
      "authored": {
        "normal": "data/surface_authored/0x06001234/normal.png"
      },
      "notes": "Holtburg cottage wall — heuristic miscategorized as Wood"
    }
  }
}
```

Authoring workflow:

1. View diagnostic page (Phase 1.4 output).
2. Spot a miscategorized surface.
3. Run `worldbuilder-terminal surface --did 0x06XXXXXX --dump` to inspect.
4. Add override entry to JSON.
5. Reload renderer → fix verified.

Hero surface authoring (Phase 2.3) adds `authored:` entries pointing at hand-made PBR maps.

### Maintenance

- The override JSON is version-controlled.
- CI lint warns on top-100 hero surfaces that lack overrides (just diagnostic, doesn't fail).
- New regions added in future expansion → run hero-survey, top-50 of those are candidates for next authoring batch.

This is sustainable: heuristic is cheap and universal, overrides are precise and accumulate slowly as we curate.

## 7. Testing strategy summary

### Laptop-safe (can run locally)

- Cargo unit tests (any phase)
- Single-frame screenshot smoke tests
- Diagnostic pages (classifier output review)
- Phase 0.1 (shadow toggle) full validation
- Phase 0.2 (Detail flag) full validation
- Phase 1.* (cheap wins) — visual smoke only
- Phase 1.4 / 1.5 — pure CPU work, fully laptop-safe
- Phase 2.1 at subdivLevel=2 — likely fine
- Phase X.1 (quality presets) — pure plumbing
- Phase X.2 setup (capture script authoring) — fine

### Defer to live-ACE box (Tailscale `<server-ip>`, PK on hardware)

- Phase 2.1 at subdivLevel=4+ — perf measurement only
- Phase 2.2 — full LB animation perf
- Phase 2.3 — mobile FPS with authored assets
- Phase 3.1 (POM) — perf measurement
- Phase 3.2 (SSAO) — perf measurement
- Phase 3.3 (CSM) — perf measurement
- Phase X.2 — full regression suite at quality=ultra

### Hard rule

**Never** run a combined-feature stress test (e.g., subdiv=8 + POM + SSAO + CSM + full Dereth bake) on the local laptop. That's the OOM scenario. Produce the capture script, ship it, run on hardware.

If a team agent is uncertain whether a local run is safe: don't run it. Document the test plan, ship the artifact, leave execution to the hardware test owner.

## 8. Dependency graph (canonical)

```
Phase X.1 (quality presets) ─────► gates Phase 2.1, 2.2, 2.3, 3.*
Phase X.2 (regression suite) ────► used by 1.*, 2.*, 3.*

Phase 0.1 (shadows) ────────────────────────┐
Phase 0.2 (Detail flag) ────────────────────┤
                                            ├──► Phase 1.1 (procedural normals) ──┐
                                            │                                     ├──► Phase 2.3 (authored hero)
                                            │    Phase 1.2 (terrain detail) ─────┤
                                            │    Phase 1.3 (triplanar) ──────────┤
                                            │                                     │
                                            └──► Phase 1.4 (heuristic) ──► 1.5 (overrides) ──► 2.3 + 3.1

Phase 2.1 (subdivision) ─────► Phase 2.2 (vertex displacement)
Phase 2.3 (authored hero) ──────────────────────────────────────► Phase 3.1 (POM, uses hero stone)

Phase 3.1 (POM) ──┐
Phase 3.2 (SSAO) ─┼──► all gate on Phase X.1
Phase 3.3 (CSM) ──┘
```

## 9. Effort estimates (rough)

| Phase | Complexity | Effort |
|---|---|---|
| 0.1 Shadows | Low | 1–2 days |
| 0.2 Detail flag | Medium | 3–5 days |
| 1.1 Procedural normals | Medium | 3–4 days |
| 1.2 Terrain detail normal | Medium | 3–4 days |
| 1.3 Triplanar | Low–Medium | 2–3 days |
| 1.4 Heuristic classifier | Medium | 1 week |
| 1.5 Override layer | Low | 2–3 days + ongoing curation |
| 2.1 Subdivision | High | 1.5–2 weeks |
| 2.2 Animated displacement | Medium | 3–5 days |
| 2.3 Authored hero PBR | Medium–High | 1–2 weeks (authoring time dominates) |
| 3.1 POM | High | 1–2 weeks |
| 3.2 SSAO | Low–Medium | 3–5 days |
| 3.3 CSM | Medium–High | 1–2 weeks |
| X.1 Quality presets | Low | 2–3 days |
| X.2 Regression suite | Medium | 1 week |

**Total serial effort:** ~14–22 weeks single-engineer.

**Parallelizable:** Phases 0.*, 1.1, 1.2, 1.3 can run in parallel after baseline. Phase 1.4/1.5 in parallel with 1.1–1.3. With 3–4 team agents, condense to **~6–10 weeks wall-clock**.

## 10. Glossary and file map

### Key files

| Path | Purpose |
|---|---|
| `apps/holtburger-web/scene3d/adapter.js:41-116` | Terrain mesh generation (target for Phase 2.1) |
| `apps/holtburger-web/scene3d/terrain.js:48-127` | Terrain shader (target for Phase 1.2, 1.3, 2.2) |
| `apps/holtburger-web/scene3d/terrain.js:370-389` | Terrain ShaderMaterial setup |
| `apps/holtburger-web/scene3d/materials.js:84` | Building MeshStandardMaterial (target for Phase 1.1) |
| `apps/holtburger-web/scene3d/materials.js:151-197` | Surface-flag material variant (target for Phase 0.2) |
| `apps/holtburger-web/scene3d/lighting.js:121-191` | Lighting + shadow setup (target for Phase 0.1, 3.3) |
| `apps/holtburger-web/src/lib.rs:2520-2569` | Surface pixel decode (target for Phase 1.1, 1.4) |
| `crates/holtburger-dat/src/file_type/surface.rs` | Surface DAT struct (source of truth) |
| `crates/holtburger-dat/src/file_type/texture.rs` | Texture format enum |

### Conventions

- Surface DIDs in hex with `0x06` prefix (file type byte) — e.g., `0x06001234`.
- Landblock IDs in hex (e.g., Holtburg = `0xA9B4`, Academy = `0x8602`).
- All new assets under `data/surface_authored/`, `data/surface_overrides.json`, `apps/holtburger-web/scene3d/assets/terrain_detail/`.
- All scratch artifacts under `/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/`.
- All goldens under `/mnt/wbterminal1/holtburger-goldens/`.

### Glossary

- **POM**: Parallax Occlusion Mapping — fragment-shader technique that simulates depth via ray-marching a heightmap.
- **CSM**: Cascaded Shadow Maps — multiple shadow maps at different distance ranges, blended.
- **SSAO**: Screen-Space Ambient Occlusion — post-pass that darkens areas near other geometry.
- **PBR**: Physically Based Rendering — uses roughness/metallic parameters to drive a Cook-Torrance-ish lighting model. `MeshStandardMaterial` is Three.js's PBR material.
- **Triplanar mapping**: Sampling a texture from three orthogonal planes blended by normal direction; eliminates UV stretching on steep slopes.
- **Sobel filter**: 3×3 convolution kernel that computes image gradients; used here to derive normal maps from diffuse luminance.
- **Reoriented Normal Mapping (RNM)**: Method of combining two normal maps that preserves directional consistency.
- **Detail flag**: Bit `0x20000` in the surface_type bitfield; AC's own signal that a surface wants a second tiled texture layer.

## 11. Open questions / explicit non-goals

### Open questions to resolve as work proceeds

1. **Should procedural normal generation happen at decode time or bake time?** Decode-time (current plan) re-runs every page load. Bake-time would store generated normals in dist/ shards, larger download but zero runtime cost. Lean toward decode-time initially; revisit if texture decode becomes a perf bottleneck.
2. **POM on terrain?** Phase 3.1 covers stone surfaces on buildings, but terrain surfaces (cobblestone paths, stone plazas) could also benefit. Decide once Phase 3.1 ships.
3. **Volumetric / atmospheric effects** (fog, god rays)? Not in this plan. Defer.

### Non-goals

- Real-time global illumination — too expensive for browser.
- Mesh shaders, geometry shaders, hardware tessellation — not in WebGL2, WebGPU support uneven.
- Lightmap baking — Dereth is too large; would need per-region baked solutions, out of scope.
- Replacing AC's art style with photo-real assets — we're going for "stylized realism" that respects the original look.

---

## 12. Notes for team agents picking up phases

- Each phase block above is self-contained enough to start cold. Read your assigned phase block, then the relevant audit data in §2, then jump in.
- File paths and line numbers are from the 2026-05-13 audit. Verify they're still current — the renderer is actively developed. If something moved, find it via grep and update the path notes in this doc.
- All work should be committed in small focused PRs. One phase = one PR (or a small set if naturally splittable).
- Add an entry to `MEMORY.md` (via `~/.claude/projects/-home-wbterminal/memory/`) when a phase completes, recording any non-obvious findings (e.g., "Sobel on 64² textures produces choppy normals — added Gaussian pre-blur step").
- **Laptop safety is real, not aspirational.** If you find yourself thinking "I'll just run the full ultra-quality capture suite locally to validate", stop, write the capture script, and hand off execution to the hardware test owner. Reference the rule in §7.
- Cross-compat is non-negotiable. If a phase appears to require a wire-protocol change or a collision-math change, stop and flag it — that's a planning error in this document, not a green-light to proceed.

---

End of plan.
