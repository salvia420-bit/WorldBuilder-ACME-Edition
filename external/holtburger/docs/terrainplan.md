# terrainplan.md — Terrain & Texture Modernization Plan

**Date:** 2026-07-28 · **Status:** DRAFT / discussion-stage plan (no code landed)
**Scope:** holtburger-web rendering only. Zero DAT changes, zero data-format changes, zero server changes.

Grounding: Holtburg building dissection via WB.Terminal + 2026-07-02 live-1070 perf data + code survey 2026-07-28 (anchors below verified against current tree). Companion docs: `~/from-vm/fps-synthesis-20260702.md`, `docs/PLAN-fixed-slot-grid-residency-2026-07-11.md`, `apps/holtburger-web/docs/quality-presets.md`.

---

## 0. Ground truth & invariants (measured, not assumed)

1. **Triangles are nearly free; draw calls are the wall.** Live 1070 bracket (2026-07-02): 1,620 calls = 8.5fps, 800 calls = 17fps, GPU ≤34% throughout (~50µs CPU per call). Whole-town geometry is tens of thousands of tris vs tens of millions of per-frame GPU headroom. Nothing in this plan may add per-frame draw calls in the default path. Terrain today is ~203 draws (one per baked LB; `?terrainBatch` BatchedMesh consolidation exists at `scene3d/terrain_batch.js:367`).
2. **Retail models are tiny.** Holtburg (0xA9B4): 12 buildings, each one GfxObj — 76–373 triangles, 48–250 verts, 6–18 surfaces (measured via `chorizite-parse-dat-record`). Terrain: 9×9 = 81 verts per LB, 8×8 cells × 2 tris, per-cell diagonal from the shared pseudo-random rule (`cell_swto_ne_cut`, magic `1813693831` — same in acclient.c, ACE, WorldBuilder, and `crates/holtburger-dat/src/terrain_subdiv.rs`).
3. **The walk surface is not ours to change.** ACE computes Z from the DAT heightmap; legacy clients do the same. Client physics lives in Rust (`crates/holtburger-core/src/client/movement/system.rs`, six `terrain_height_at` call sites) on the retail linear grid + retail diagonal (`src/lib.rs:34386 terrain_height_at`; the RC-1 comment there records the pain of a wrong diagonal on ~53% of cells). Render geometry may be embellished; **physics truth stays the retail 81-vert linear grid** or we desync/rubber-band. This same invariant is what preserves legacy-client compatibility.
4. **Retail's own format already separates collision from visuals.** GfxObj stores `PhysicsPolygons` + `PhysicsBSP` apart from render `Polygons` + `DrawingBSP`; the schema notes render polys "can be higher detail than physics polys" (dats.xml GfxObj). Amplifying only drawing geometry is the engine's native architecture, not a hack.
5. **Affordance threshold rule.** Render/physics divergence is invisible below step height: cap any displacement at ~≤10cm and noisy (pebbles, ruts, mortar). Never systematic large offsets (a 25cm ledge *reads standable* → fall-through breaks the illusion). Bicubic silhouette smoothing through the 81 points diverges tens of cm exactly where players stand (ridgelines) — **skip it**, or hard-clamp toward the linear surface near the walkable plane.
6. **Texture inventory is head-heavy.** portal.dat: 6,152 Surfaces / 7,221 SurfaceTextures / 20,684 RenderSurfaces — most are icons/UI/clothing. Terrain = **33 atlas layers** (32 types + road). A usage-frequency ranking (WB.Terminal `asset-used-by` graph) will show a few hundred surfaces covering the vast majority of rendered pixels.
7. **Licensing:** Quixel/Fab free tier is UE-only — unusable. **ambientCG + PolyHaven are CC0** (no restriction) and cover the full AC material vocabulary (stone, cobble, planks, thatch, plaster, dirt, grass, sand, snow, ice…).

## 0b. Current terrain pipeline (survey 2026-07-28 — the plan builds ON this, not from scratch)

- **Geometry:** generated live in wasm, not offline-baked. `src/lib.rs:1508 build_mesh()` (81-vert grid); `src/lib.rs:1759 SubdividedLandblockMesh` + `crates/holtburger-dat/src/terrain_subdiv.rs` = **LOD subdivision already exists**, driven by Chebyshev-distance cascade (`scene3d/terrain.js:3021 pickSubdivLevelForLb`). JS conversion in `scene3d/adapter.js:284/:349`.
- **Texturing:** hand-written GLSL3 `THREE.ShaderMaterial` (`scene3d/terrain.js:3444`, shader ~lines 1000–1700) over a `sampler2DArray` atlas — 33 layers @ `ATLAS_TILE_PX = 512` (`adapter.js:239`), upscaled from 256px retail natives. **A real TexMerge port is default-ON** (`readTexMergeFlag` `terrain.js:2974`; Rust half in `crates/holtburger-dat/src/terrain_merge.rs`): per-cell 6 slots (base + 3 terrain overlays + 2 road slots) with retail A8 alpha masks. Fallback path: bilinear 4-corner blend (`terrain.js:1540`). Plus palette LUT tint (`terrain.js:433`), detail textures (~3 slices @256), per-code tiling from Region `tex_tiling`.
- **Lighting:** DirectionalLight sun + AmbientLight + optional Hemisphere (`scene3d/lighting.js:204/:246/:255`), hand-rolled CSM sampling in the terrain shader, cloud-shadow array. Bruneton atmosphere vendored (takram) with "pool mode" light driving. **No environment map / IBL anywhere** (zero hits for `scene.environment`/`PMREMGenerator`). Light-count is deliberately frozen (comments at `lighting.js:1059-1109`) — changing DirectionalLight count forces shader recompiles.
- **Consequence for this plan:** the texture array, per-cell slot data, alpha-mask machinery, LOD subdivision, and custom shader are all in place. The terrain track is an *evolution of one shader + one atlas builder*, not new architecture. The genuinely missing piece is IBL.

---

## 1. Terrain track (T-phases)

### T1 — Per-pixel splat evolution of the existing shader
Evolve the existing TexMerge/bilinear blend toward noise-broken per-pixel splat: keep the per-cell slot data and per-vertex terrain codes as blend inputs, add a tiling breakup-noise texture that modulates blend borders in the fragment shader so transitions finger organically instead of following the 24m cell grid / fixed retail alpha masks.
- Reads the SAME painted DAT data. WorldBuilder painting workflow unchanged; the legacy client keeps rendering its own texmerge from the same vertices. Two renderers, one truth.
- Bonus: noise-broken borders tolerate bold terrain-type transitions that retail texmerge renders ugly — this *loosens* the "paint bland so texmerge can cope" constraint.
- Ship as a blend-mode uniform alongside the existing two paths (`uTexMergeEnabled` precedent), URL-flagged; retail-texmerge stays the escape hatch.
- Draw-call delta: 0 (same meshes, same material).

### T2 — CC0 PBR material sets for the 33 terrain layers
Curate once, mechanically: each terrain type → an ambientCG/PolyHaven set (albedo + normal + roughness [+AO]).
- Atlas builder (`buildTerrainAtlasArrayBytes`, `adapter.js:425`) grows parallel arrays: `uAtlas` (albedo, existing), `uAtlasNormal`, `uAtlasRough` — same layer indexing, so the splat logic is written once. `ATLAS_TILE_PX` already rescales; real 512–1K sources drop straight in. KTX2/Basis for the shipped copies; measure VRAM (albedo today ≈ 33 MiB at 512; 3 channels @1K ≈ manageable on 8GB, needs a number before default-ON).
- Tiling scale per type stays anchored to Region `tex_tiling` semantics so world-scale matches retail.
- Highest-visible-impact swap in the whole plan: terrain dominates every outdoor frame, is tiling by construction, zero painted-detail risk. The palette-LUT tint likely retires (or reweights) for replaced layers.

### T3 — Lighting co-requisite: IBL (what makes PBR actually pay)
Roughness/normal maps read as flat mud without directional + environment light. Ship alongside T2, not after:
- PMREM environment map generated from the existing Bruneton atmosphere sky (takram pipeline already computes it), refreshed at low cadence as `timeOfDayNormalized` moves; `scene.environment` for standard materials + explicit env sampling in the custom terrain shader.
- Hard rule (existing invariant, `lighting.js:1059-1109`): never change scene light count at runtime — env intensity/rotation animates, the light list stays fixed.
- Quality-tiered: full IBL on high; current ambient/hemisphere path remains the low tier.

### T4 — Per-pixel depth, then (maybe) micro-displacement — LAST, optional
- **POM first** (terrain, later walls): fakes centimetres of relief per-pixel with zero geometry and zero physics divergence. Uses T2's height/normal data. Quality-gated; SwiftShader-hostile, 1070-fine.
- **Real micro-displacement** rides the *existing* subdiv LOD cascade (`SubdividedLandblockMesh`) — displace subdivided verts from material height, amplitude clamp ≤10cm (invariant 5), near-LB LODs only. Costs decode/residency pressure (known jank axis) for the smallest visual delta in the track → only after the residency roadmap lands, if at all.
- **Never** bicubic silhouette smoothing (invariant 5).

---

## 2. Non-terrain texture track (X-phases, future)

### X1 — Census & ranking
WB.Terminal `asset-used-by` reverse graph → rank world-visible Surfaces by placement frequency; exclude icons/UI/clothing (those stay retail). Output: ranked worklist + contact sheets.

### X2 — Automatic classification: *tiling material* vs *unique painted*
Autocorrelation/FFT tiling-ness + feature detection per texture. Painted class = windows, doors, signs, banners, trim painted INTO wall textures — must NOT be replaced by tiling materials (the window would vanish off the building).

### X3 — Tiling class → CC0 PBR substitution (similarity-matched)
CLIP-style embedding match of AC diffuse vs CC0 library albedos; human review as bulk contact sheets (old-vs-new), not per-texture curation. Substitution preserves UVs exactly; per-material tiling-scale factor derived from retail UV density (retail UVs tile — e.g. u=6.75 observed on building roofs).

### X4 — Painted class + unmatched tail → AI upscale
ESRGAN-family ×4 of the original diffuse (the standard retro-HD-pack pipeline). Fully automatic, preserves painted content. **This is also the safe baseline for everything** — an upscale-only pass ships visible value before any PBR matching does. Optionally + DeepBump-style diffuse→normal inference (normal-only is shader-safe: artifacts read as odd lighting, not warped geometry).

### X5 — Material/atlas engineering
- Statics/buildings already use `MeshStandardMaterial` with onBeforeCompile CSM patches (`scene3d/materials.js:310/:386`) → PBR channels are a materials.js change, not a rewrite.
- The cross-LB static atlas (`scene3d/static_atlas.js`) is single-channel → needs parallel atlases (albedo/normal/roughness sharing ONE UV layout). Do it inside static_atlas, not ad hoc per channel.
- Dedup opportunity: many near-duplicate AC surfaces → fewer shared modern materials → **fewer** unique materials → better batching. Track unique-surface count before/after.
- Respect the standing VFX invariants: no per-instance `customProgramCacheKey`, no light-count changes.

### X6 — Render-only geometry amplification (walls) — LAST
Protruding bricks/timber: subdivide+displace **drawing geometry only** in the wasm decode path (`triangulate_model` → `pack_model_mesh`); physics polys/BSP untouched (invariant 4 — retail's own split). Amplitude ≤ ~5cm (invariant 5) so nothing reads standable. The thread_local decode memo makes cost once-per-model with zero bake/network growth. Evaluate POM (T4) results first — it likely delivers most of this for free.

---

## 3. Performance guardrails & sequencing

- **Vs the perf roadmap:** Build #0 (instanced anim scenery) and statics consolidation attack the actual bottleneck and come FIRST. These tracks are orthogonal (draw-call delta 0) but 1070 eye-test time is shared — batch sessions, don't interleave A/B campaigns.
- **Budgets:** draw calls +0 in default path (hard). VRAM: measure per phase (terrain arrays first; heap+VRAM before/after). Download: shards/assets grow — KTX2 everywhere, 1K cap, record dist/ delta per phase.
- **Flags:** every phase default-OFF behind a URL flag → batched 1070 eye-test → default-ON with `?flag=off` escape (standing gate rules). Use explicit `=== 'on'` opt-in readers until validated — the `!== "off"` default footgun is a known live trap.
- **Measurement rules:** release wasm only (~4.5MB, never ~18MB dev); `renderer.info.autoReset=false`, diff over frames; fresh `--user-data-dir` per A/B arm; SwiftShader laptop = wiring/logic only (`?wireframe=1`, `?nullRender=1`); visual/perf verdicts on the 1070, off-screen.

## 4. Water (side quest, shares T3's IBL)
- Default tier: scrolling normal-mapped water shader + T3's environment — no extra scene pass, ~free, close to retail's animated-texture water anyway.
- High tier (1070, flag-gated): planar Reflector at half-res, layer-masked to terrain+sky+buildings (never the thousands of trees), refresh every 2–4 frames. A naive Reflector re-renders the whole scene per frame = doubling draw calls = the proven bottleneck; the masking IS the feature.
- Water cells are identifiable from terrain type / Region data — no new data needed.
- Traps: `Pass.mainCamera` is a no-op setter (use `this.camera`); never change light count or per-instance `customProgramCacheKey`.

## 5. Compatibility invariants (restated, non-negotiable)
1. No writes to DATs; no data-format changes; WorldBuilder painting/tooling workflow unchanged.
2. Server Z authority: physics height = retail linear triangle grid + retail diagonal split, in Rust, untouched by every phase above.
3. Legacy client renders the same painted world its own way — nothing here touches shared data, so nothing here can break it.
4. GfxObj physics geometry (`PhysicsPolygons`/`PhysicsBSP`) is never amplified or altered.
