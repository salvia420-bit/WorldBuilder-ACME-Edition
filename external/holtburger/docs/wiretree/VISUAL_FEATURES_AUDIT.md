# Visual-features audit — wire-mode coverage (2026-05-21)

What's active vs stripped in `?wireframe=1`, with notes on whether the
strip is intentional vs accidental. Surfaced by the lazy-terrain bug
that exposed liveScene3d-vs-scene3dForBuilders aliasing patterns —
similar accidental gaps may exist for other features.

## Quality-preset flags (defined in `scene3d/quality.js`)

These gate on `quality.flags.<name>`. Wire-agent runs default to
`quality=low` so most of these are OFF in wire by virtue of the preset.

| flag | low default | wire-specific override? | effect when active |
|---|:---:|:---:|---|
| `antialias` | OFF | — | MSAA, ~25 % frametime cost |
| `shadows` | OFF | **forced OFF in wire** (`!wireframeMode && shadowsParam === "on"`) | single shadow map (Phase 0.1) |
| `normalMaps` | ON | irrelevant (no fragment shader in wire) | normal-mapped lighting |
| `detailFlag` | OFF | — | Detail composite via `onBeforeCompile` (materials.js:190-236) |
| `terrainDetailNormal` | OFF | irrelevant in wire | terrain detail-normal array sample |
| `triplanar` | OFF | irrelevant in wire | terrain triplanar projection |
| `pom` | OFF | — | parallax occlusion mapping on stone surfaces |
| `csm` | OFF | **forced OFF in wire** (`!wireframeMode && quality.flags.csm`) | 3-cascade shadow maps |
| `bloom` | OFF | gated by composer skip in wire | EffectComposer BloomEffect |
| `vignette` | OFF | gated by composer skip in wire | VignetteEffect |
| `lensFlare` | OFF | gated by composer skip in wire | LensFlareEffect (also default-off since 2026-05-21 stutter fix) |
| `lightShafts` | OFF | gated by composer skip in wire | cloud-shadow crepuscular rays |
| `hero` | OFF | — | hero-asset substitutions |
| `subdivLevel` | 1 | passes through in wire | terrain Catmull-Rom subdivision |
| `maxParticlesPerEmitter` | 64 | NOT STRIPPED (small gap) | particle emitter cap |
| `pomStepsPrimary/SelfShadow` | 0 | irrelevant in wire | POM raymarch step count |
| `triplanarSlopeThresholdPct` | 100 | irrelevant in wire | triplanar slope gate |

## Custom terrain-shader features (terrain.js ShaderMaterial)

The whole terrain ShaderMaterial is replaced with
`MeshBasicMaterial({color:0x4a6a52, wireframe:true})` in wire mode —
all of these are GONE.

| feature | line | wire status |
|---|---|---|
| Atlas texture sampling (33 layers) | terrain.js:1085 | gone |
| Per-vertex types DataTexture (terrain/road codes) | terrain.js:1086 | gone |
| Road blend painting | terrain.js:1097 | gone |
| Detail-normal array sample | terrain.js:1104 | gone |
| **Water/lava vertex displacement** | terrain.js:789 | **gone** (was the "moving water" feature) |
| Wave/scroll uniforms (uTime, uWindDir) | terrain.js:1107 | gone (per-rAF tick that pushed uTime is gated by terrainMaterials.push, which wire skips) |
| CSM cascade matrices + samples | terrain.js:1191-1207 | gone (CSM also stripped) |

## Material-side shader patches (`materials.js` `onBeforeCompile` chains)

Apply to MeshStandardMaterial. In wire mode, MaterialCache returns
MeshBasicMaterial directly without onBeforeCompile chains. All gone:

- Detail composite (materials.js:190-236)
- CSM cascade sampler (materials.js:238+)
- POM parallax raymarch (materials.js:~1100)

## Atmosphere / post-process

| feature | site | wire status |
|---|---|---|
| Bruneton LUTs + atmosphere runtime | atmosphere_runtime.js | **stripped** — Promise.resolve(null) |
| AGX tone mapping | atmosphere_pipeline.js | stripped (no composer) |
| Dithering | atmosphere_pipeline.js | stripped |
| Aerial perspective | atmosphere_pipeline.js | stripped |
| Bloom / vignette / lensflare | atmosphere_pipeline.js | stripped |
| SkyDome (background, horizon, zenith) | sky_dome.js | **stripped** (skyDome=null at outer scope) |
| Stars | atmosphere_sky.js | stripped (no skyScene) |
| Aurora | aurora.js | stripped (gated by `?aurora=` AND skipped via skyDome=null) |
| AC Moons (Alb'arel + Rez'arel) | ac_moons.js | stripped (no skyScene) |
| Cloud overlay / volumetric clouds | cloud_overlay.js | **stripped** (`cloudsFlag === "on" && !wireframeMode`) |

## Lighting

| feature | site | wire status |
|---|---|---|
| Sun DirectionalLight | lighting.js | **stripped** — lighting={null,null,null,null,null,dispose:()=>{}} |
| Ambient + Hemisphere lights | lighting.js | stripped (same) |
| Per-SetupModel light fixtures (`attachSetupModelLights`) | lighting.js:627 | stripped (`!wireframeMode &&` gate) |
| CSM cascade lights (3 DirectionalLights) | lighting.js:setupCsm | stripped (csmEnabled=false) |
| SkyLightingController (region-driven color/intensity) | sky_lighting.js | **NOT STRIPPED** — runs but writes to null sun/ambient → no-op. Small overhead per tick. |

## Audio

| feature | site | wire status |
|---|---|---|
| AudioManager (wave fetch + decode) | scene3d/audio | **stripped** (`!wireframeMode` gate) |
| SoundTableCache | audio | stripped |
| AmbientRuntime | audio | stripped (cascades off via audioManager check) |

## Background / fog

| feature | wire status |
|---|---|
| scene.background | **set** to `0x1a1f26` dark blue-grey |
| scene.fog | **set** to `FogExp2(0x1a1f26, density=0.004)` — distance depth cue, free with MeshBasicMaterial.fog=true (default) |

## Renderer / texture

| feature | wire status |
|---|---|
| Anisotropy (1-N) | irrelevant — no texture sampling in wire |
| `EXT_float_blend` enable | NOT STRIPPED — small init call, doesn't affect wire |

## Entity / scene-graph

| feature | wire status |
|---|---|
| Entity body meshes | **wire** (entities.js WIREFRAME_MODE branch L977) |
| Entity fallback material | wire (entities.js:1320) |
| Entity selection ring (TorusGeometry) | unchanged — already MeshBasicMaterial flat color (red) |
| Nameplate sprite (canvas-rendered texture → SpriteMaterial) | **NOT STRIPPED** — visible in screenshots as textured text labels above entities. Useful for human evaluators identifying NPCs. |
| Nameplate DOM overlay (`liveScene3d.nameplateLayer`) | unchanged — pure HTML overlay, no GPU |
| Particle manager + emitter ticks | **NOT STRIPPED** — runs even when no emitters fire. Small overhead. |
| Hello-cube (Phase 7.0 capture artifact) | **wire** (fixed today) — was MeshStandardMaterial orange, now MeshBasicMaterial wire |

## Cell visibility / bake

| feature | wire status |
|---|---|
| Cell visibility BFS (per-frame) | unchanged — still flips `.visible` |
| EnvCell bake (cottage interiors) | **enabled** — runs through wire MaterialCache; ~700ms hitch when first entering a cottage-town LB (mitigated by `compileAsync` pre-warm shipped earlier) |
| PVS streaming via `tickPvsLoadExpansion` | unchanged |

## ⚠️ Newly-fixed accidental gaps

- **Lazy-terrain wire bypass** (2026-05-21 commit ___ — fixed): `liveScene3d` didn't propagate `wireframeMode` to lazy-loaded outer-ring terrain LBs. They went through ShaderMaterial. Surfaced by the docs/wiretree tour — outer LBs showed textured water/hills while inner LBs were wire.

- **Hello-cube** (2026-05-21 same commit — fixed): MeshStandardMaterial orange cube at `(0,0,5)` was the lone non-wire mesh in wire mode. Now also wire.

## Likely-remaining gaps (not yet hunted)

- **Particle manager init + per-frame tick** — runs in wire even when no emitters present. Cold-start + per-frame overhead. ~50-100ms boot + ~0.1-0.5ms per frame.
- **SkyLightingController** — constructed in wire (after the SkyDome skip block), writes to null sun → no-op but consumes the per-tick callback overhead.
- **Nameplate canvas bakes** per entity spawn — each NPC builds a canvas texture for its name label. Could be replaced with the DOM overlay (which already exists) in wire mode.
- **Detail tile cache load** + **terrain detail normal array** — gated by `quality.flags.detailFlag` / `terrainDetailNormal` which are false at low preset, so already off in low+wire. But if user sets `?quality=high&wireframe=1` they'd load uselessly.

## Verification command

```bash
# Run the wire-mode material probe to enumerate every mesh's material
# type. Anything NOT MeshBasicMaterial(wire) is a gap.
cd /tmp/local-wire-validate && node probe-materials.mjs
```

Expected: ONLY `MeshBasicMaterial(wire)` entries + (acceptable) `SpriteMaterial`
for nameplates. Anything else is a lazy-load path that bypassed the wire
swap (same shape as the terrain bug).
