# Visual-Behavior Suite — Design Doc (2026-06-23)

**Status:** design / pre-build. Lead synthesizer over GROUND (WB.Terminal REPL + renderer-injection + object-data + GPU-budget) and BRAINSTORM-A/C/F + weathering/texture/particle catalogs.
**Home:** `WorldBuilder.Terminal` C# REPL/JSON agent — **no GUI**, agentic CLI only.
**Live client:** `external/holtburger/apps/holtburger-web/` (NOT `~/holtburger`).

---

## 1. Vision + Constraints

### 1.1 Vision (one paragraph)
AC ships ~10k object models (2,763 unique SetupDIDs across 19,686 weenies — GROUND-3) that render frozen and lifeless. We want every object to carry an extensible **bag of visual-behavior components** (sway, glint, tarnish, glow, embers, texture-detail, proc-motion) selected by an **auto-classifier** that maps `DID → archetype` from weenie props + geometry shape, gauged against a **Holtburg GPU budget** so we spend the idle GPU without going greedy. The first shipped archetype — tree wind-sway (`scene3d/tree_wind.js` + `scene3d/wind_rig.js`) — is archetype #1; the suite generalizes its substrate.

### 1.2 The ONE safety RULE (verbatim from BRAINSTORM-F)
> An effect may **READ only** (a) STATIC/DERIVED inputs — DAT geometry/Surface/SetupModel fields, weenie props, the object's server-authoritative position/heading, and a deterministic per-instance hash (`hash01(guid)`, `wind_rig.js:199`); plus (b) the shared CLIENT WALL-CLOCK (`scene3d.frameTime.tsSec` / `performance.now()`). An effect may **WRITE only** to RENDER-TIME transforms/materials that the server neither stores nor replicates: the THREE render-root or per-part Group local transform, and per-entity CLONED material uniforms (emissive/opacity/color/roughness, `map.offset`). It may **NEVER** write the value sent on the wire, the physics/collision state, or any server-replicated field.

**Corollaries (binding):**
- [ ] Gravity / collision / rigid-body dynamics are **OUT** — they break legacy compat. The collision BSP is server-authoritative and untouched.
- [ ] Effects must not change **light count** (a count change forces a MeshStandard shader RELINK + frame freeze — the shipped spell-freeze light-pool history). Torch flicker modulates **intensity only**, never `.visible`/count.
- [ ] Effects must not change a material's `customProgramCacheKey` **per-instance** (would explode shader links — the project's #1 cold-load cost, RESULTS-shader-link-landscape-2026-06-23).
- [ ] **Why it can't desync (PROOF in-tree):** `SetOmega` spin writes `inst.root.quaternion`, and the server-orientation `setPose` `copy()` STOMPS it every position update (`entities.js ~4201`); the spin literally cannot leak to the wire. Tree-wind writes per-part Group transforms on a NON-rendered template copied onto instances; collision never sees it.

### 1.3 GPU-headroom rationale
The outdoor world is **CPU-bound ~20 fps on the GTX 1070 with the GPU ~30–50% idle** (memory: clouds-default-on + goal1 A/B). Vertex/fragment visual effects spend the *idle* resource, not the saturated CPU. The shipped instancing model keeps CPU cost flat: **one shared mixer/clip per `(model, phase-bucket)` advanced once/frame, COPIED onto N instances** (`animated_scenery.js`), with a 512 build cap (`animSceneryMax`) + distance tick-cull (`animSceneryRadius`). Cost scales with **unique drivers** (a handful), not placement count.

---

## 2. Visual-Behavior Component Schema

### 2.1 The descriptor (per-DID, extensible)
A descriptor is `{ did, archetype, components[], config{}, confidence, source }`. An **archetype = a named bundle of components**. Adding an effect = registering a component; archetypes select which components they carry. Nothing else breaks (the shipped tree-wind code is literally one component — CPU hinge — bound to one archetype — trunk-canopy).

```jsonc
// visual_descriptors.jsonl — one line per classified DID
{
  "did": 33558820,                       // 0x02000724
  "archetype": "tip-flex",
  "confidence": 0.62,
  "source": "classifier",                // classifier | manual | self-label
  "components": ["procMotion.tipFlex", "emissive.glint"],
  "config": {
    "procMotion.tipFlex": { "ampDeg": 1.5, "gripAnchor": "holdingLoc", "tipWeightCurve": "smoothstep", "mech": "gpu" },
    "emissive.glint":     { "strength": 0.4, "metalBias": 0.9 }
  }
}
```

### 2.2 Component families (the registry axes)
| Family | Writes | Mechanism | Cost class | Runtime host (file) |
|---|---|---|---|---|
| `procMotion.*` (sway/flex/spin/bob/swing) | render transform / per-part Group | MECH-A CPU per-part keyframes **or** MECH-B GPU `begin_vertex` displacement | cheap–medium | `animated_scenery.js` player; `entities.js` `_tickHookOmega` |
| `deformation.*` (cloth-ripple, limb-bend) | render transform | MECH-B GPU vertex displace | medium | `materials.js _chainBeforeCompile @ begin_vertex` |
| `weathering.*` (tarnish/rust/moss/dust/wetness/frost/fade/edge-wear/splatter) | cloned material uniforms | fragment patch after `<map_fragment>` | cheap (uniform) / medium (1 tex fetch) | `materials.js` patch + `weathering.js` table |
| `emissive.*` (glow/pulse/runes/aura/glint/gem-fire/eyes/tint/sheen) | cloned material emissive/uniform | reuse luminous emissiveMap path + `uTime` | cheap (bloom halos free) / medium (rune tex) | `materials.js applyFloatLumDiffuse` + patch |
| `texture.*` (super-res swap, generated normal/rough/AO, detail grain, POM, aniso, seam-fix) | decoded RGBA8 buffer / sampler | swap pixels at ingest seam OR `_chainBeforeCompile` patch | cheap (swap/uniform) / medium (tex) / **expensive (POM raymarch)** | `lib.rs:7381` ingest; `materials.js` detail/POM/CSM |
| `particle.*` (embers/dust/pollen/leaves/splash/sparkle/breath/orbit/drip) | synthesized emitter on anchor | `ParticleManager.addEmitter({emitterInfo POJO})` | cheap–medium (additive overdraw) | `particle_manager.js`; anchor via `partFrames` |

Two transform mechanisms (both in-tree):
- **MECH-A (CPU per-part hinge keyframes):** `wind_rig.js:149 buildTreeWindClip` → frame-major Float32Array (7 floats/part `[ox,oy,oz,qw,qx,qy,qz]`) → `buildSceneryAnimationClip` → ONE shared mixer per `(setupId, phaseBucket)`, advanced once/rAF, per-part transforms copied onto instances. **Use for jointed/multi-part** bend (trunk-canopy, sign-swing, chain links, pendulums).
- **MECH-B (GPU vertex displacement):** `_chainBeforeCompile` (`materials.js:292`) injects GLSL at `#include <begin_vertex>` to modify `transformed`; `customProgramCacheKey` (`materials.js:282`) disambiguates patch sets. **Use for intra-part** bend where a part is one rigid mesh (spear/staff tip-flex, bow-limb, banner ripple, breathing scale).

### 2.3 Worked examples
| Object | DID | Archetype | Components | Mechanism / config | Source signal |
|---|---|---|---|---|---|
| **Atlan spear** | `0x02000724` (weenie 6253) | `tip-flex` | `procMotion.tipFlex` (GPU) + `emissive.glint` | shaft is 1–2 rigid parts → MECH-B axial-weighted `begin_vertex`, grip = `holding_locations` frame (`setup_model.rs:334`); ampDeg≈1.5, tip-only weight. Glint on metal. | WeaponType=Spear(5), MaterialType metal, thin distal aspect |
| **Bow** | (per-DID) | `bow-limb` | `procMotion.limbFlex` (GPU) + `procMotion.stringHinge` (CPU) | bilateral limb bend about riser via `drawAmount` uniform read from **existing client ranged-action substate** (`entities.js ~1242/2060`, read-only); string is a CPU per-part hinge. | WeaponType=Bow(8)/Crossbow(9) |
| **Tree (tall)** | `0x02000258` | `trunk-canopy` (archetype #1, SHIPPED) | `procMotion.windBend` (CPU) | MECH-A; pivot = part vertex-Zmin; `swayAmp` (`wind_rig.js:98`) suppresses full-height trunk to 0.3×; seamless integer-cycle loop; per-instance phase via `hash01`. | on `TREE_WIND_DIDS` allowlist (`tree_wind.js:64`) |
| **Sword** | (per-DID) | `rigid-glint` | `emissive.glint` + `weathering.tarnish` | deformation = **identity** (rigid). Glint = view+`uTime` specular sweep (`materials.js` fragment patch). Tarnish = one-time per-instance roughness→1.0 + crevice tint from `hash01(setupDid^instanceHash)`; FREE at steady state. | WeaponType=Sword(2), MaterialType Steel(64)/Iron(61) |

---

## 3. Archetype Catalog + Auto-Classifier

### 3.1 Canonical archetype catalog (~28, the first-pass; ~20–40 target)
| # | Archetype | Primary component(s) | Mech | Cost |
|---|---|---|---|---|
| 1 | trunk-canopy (SHIPPED) | windBend | A | cheap |
| 2 | plant/reed/kelp whip | organicWhip | A/B | cheap |
| 3 | tip-flex (spear/polearm/staff/wand) | tipFlex | B | cheap |
| 4 | bow-limb | limbFlex + stringHinge | B+A | medium |
| 5 | cloth-flutter (banner/flag/pennant) | clothRipple | B | medium |
| 6 | worn-garment (cloak/cape/robe) | garmentFlutter | B | medium |
| 7 | chain/rope/hanging-link sway | pendulum | A/B | cheap |
| 8 | sign/shingle swing | signSwing | A | cheap |
| 9 | display-spin (windmill/sign/orrery) | omega spin | A | cheap |
| 10 | levitate-bob (magic/levitating items) | bob | tick | cheap |
| 11 | idle-breath (at-rest creatures) | breathScale | A/B | cheap |
| 12 | soft-jiggle (pouch/carcass/fruit/sack) | decayWobble | B | cheap |
| 13 | rigid-glint (sword/dagger/axe/mace) | glint | frag | cheap |
| 14 | metal-tarnish/rust | tarnish/rust | frag | cheap/medium |
| 15 | magic-glow (ambient) | magicGlowAmbient | frag | cheap |
| 16 | enchant-shimmer/pulse | enchantShimmer | frag | cheap |
| 17 | spell-school-aura | schoolAura rim | frag | cheap |
| 18 | glowing-runes (weapon/altar/lifestone) | runeEmissive | frag | medium |
| 19 | gem-inner-fire | gemInnerFire | frag | medium |
| 20 | value-tier-sheen | sheen | frag | cheap |
| 21 | glowing-eyes (creatures) | eyeEmissive | frag | cheap |
| 22 | holy/corrupt-tint | tint rim | frag | cheap |
| 23 | flow-scroll (lava/water/portal) | texVel | frag | cheap |
| 24 | flame-flicker (torch/brazier light) | lightIntensityJitter | light | cheap |
| 25 | fire-particle (brazier embers+smoke) | embers+smoke emitters | particle | medium |
| 26 | foliage-ambient (pollen/firefly/leaves) | motes/leaves emitters | particle | cheap/medium |
| 27 | water-context (fountain/well/dock) | splash+mist emitters | particle | medium |
| 28 | dusty-indoor (crate/ruin/furniture) | dust motes + dust film | particle+frag | cheap |
| — | weatherable (universal) | wetness / frost | frag | cheap (global uniform) |
| — | textured (universal) | super-res / normal / detail / POM / aniso | texture | cheap–expensive |

### 3.2 Auto-classifier design
Map `DID → archetype + confidence` deterministically, audit/override only outliers — the auditable git-diff seed pattern `TREE_WIND_DIDS` (`tree_wind.js:64`) the classifier regenerates.

**Inputs (all present in-tree, GROUND-3):**
1. **Weenie props** (`WeenieIndex.cs:32-74` identity; upstream ACE `weenie_properties_int/did`): `ItemType` (key 1), `WeaponType`, `MaterialType` (key 131), `ValidLocations` (key 9), `AttackType` (key 47), spell DIDs. SetupDID via `didStats[Setup=1]` present on **99.97%** of weenies; ItemType on ~95%; **MaterialType on only ~0.5%** — so MaterialType is a *secondary refiner*, never a required gate.
2. **Geometry shape features** (`OntologyEntry.cs`: `MaxDimension`, `AspectRatio`, `PartCount`, `PolyCount`, `BoundsMin/Max`, `VertexCount`; per-part AABB via `wind_rig.js:59 partBBox`): thin distal protrusion = flex; high single-axis aspect = whip/spear; flat thin sheet = cloth; compact = rigid; `holding_locations`/`connection_points` frame = the planted/anchored end.
3. **DAT self-labels** (`setup_model.rs:346-350`): objects whose `default_animation` fires AnimationHook 22/23/24 (SetOmega / TextureVelocity) **declare their own archetype** — highest-confidence signal.
4. **SurfaceCategory** (`surface_classify.rs`: Stone/Wood/Metal/Sand/Lava/Water/Foliage/Cloth/Dirt/Snow/Brick/Tile/Generic; JS mirror `materials.js:138`) drives weathering/glint membership.

**Decision rule (priority):**
- [ ] DAT hook present → self-label archetype (flow-scroll / display-spin), confidence 1.0.
- [ ] WeaponType match → flex archetype (Spear/Staff→tip-flex, Bow→bow-limb, Sword/Axe/Mace→rigid-glint).
- [ ] On wind allowlist / Foliage category + multi-part → trunk-canopy / plant-whip.
- [ ] ItemType=Sign / thin off-center part + no default_anim → display-spin / sign-swing.
- [ ] Has spell DIDs → magic-glow + enchant-shimmer (+ school aura).
- [ ] MaterialType metal + ItemType weapon/armor → +tarnish/rust/edge-wear refiners.
- [ ] else → `rigid` (deformation identity).
- [ ] **Audit/override** any DID below a confidence threshold or hand-flagged (e.g. atlan spear shape says "rigid" but should be "tip-flex") → `source=manual, confidence=1.0`.

**Outlier note:** water-context, overhang-drip, and enchant-state cases are geometry-hard or state-dependent → audit-driven (manual override JSON), not auto-applied at day-zero.

---

## 4. Effect Catalog (by category)

Legend: `legacySafe` is **true for all** (verified against §1.2). `isolated` = independently boxed task (AI upscaling).

### 4.1 Geometry-deformation (BRAINSTORM-A) — vertex/keyframe, no shader recompile except MECH-B
| Effect | gpuCost | mechanism | legacy | isolated |
|---|---|---|---|---|
| trunk-canopy wind bend (SHIPPED) | cheap | MECH-A per-part hinge keyframes | ✓ | – |
| spear/polearm tip-flex | cheap | MECH-B `begin_vertex` axial weight | ✓ | – |
| bow-limb flex (idle+DRAWN) | medium | MECH-B + `drawAmount` from client substate | ✓ | – |
| staff/wand whip | cheap | MECH-B 2-lobe axial | ✓ | – |
| banner/flag ripple | medium | MECH-B travelling wave | ✓ | – |
| cloak/cape/robe flutter | medium | MECH-B + velocityHeading uniform | ✓ | – |
| chain/rope/lantern sway | cheap | MECH-A pendulum / MECH-B catenary | ✓ | – |
| hanging-sign swing | cheap | MECH-A top-pivot hinge | ✓ | – |
| plant/seaweed/vine sway | cheap | MECH-A whip / MECH-B height-weight | ✓ | – |
| idle breathing/wobble | cheap | additive keyframe / `begin_vertex` scale | ✓ | – |
| soft-item jiggle | cheap | MECH-B decaying wobble, client-local trigger | ✓ | – |

### 4.2 Weathering / material-state
| Effect | gpuCost | mechanism | legacy | isolated |
|---|---|---|---|---|
| metal tarnish/patina | cheap | frag patch after `<map_fragment>`, crevice/top weight, `uTarnish` from `hash01` | ✓ | – |
| shine-restore (inverse) | cheap | lerp same `uTarnish`→0, client-only verb | ✓ | – |
| rust-pitting on iron | medium | +1 tiling rust blotch tex fetch | ✓ | – |
| rain-wetness sheen | cheap | global `uWetness` from weather manager, up-facing | ✓ | – |
| frost/ice winter-zone | cheap | global `uFrost` from season/temp, mutually-excl with wet | ✓ | – |
| dust/cobwebs aged statics | cheap | top-weighted `uDust` (+optional web tile) | ✓ | – |
| edge-wear/scratches | medium | convexity proxy + optional scratch tile | ✓ | – |
| cloth fading/bleaching | cheap | desaturate after dyed-diffuse decode | ✓ | – |
| moss/lichen on stone | medium | +1 moss blotch tex, up+low-height bias | ✓ | – |
| mud/blood/soot splatter | medium | +1 splat tex, height/zone bias | ✓ | – |

### 4.3 Light / emissive / magic (BRAINSTORM-C)
| Effect | gpuCost | mechanism | legacy | isolated |
|---|---|---|---|---|
| enchant-shimmer | cheap | emissiveIntensity·(1+a·sin(uTime)) | ✓ | – |
| view-glint sparkle | cheap | noise-modulated specular on half-vector | ✓ | – |
| glowing-runes | medium | 2nd rune detail tex → emissive accumulator | ✓ | – |
| gem inner-fire | medium | inverted-fresnel core glow + small UV warp | ✓ | – |
| heat-haze | **expensive** | screen-space distortion EffectPass (gate hot+on-screen); downgrade = refractive billboard | ✓ | – |
| cold-vapor | medium | fresnel rim + low-rate particle puff | ✓ | – |
| spell-school aura | cheap | fresnel rim emissive, school color | ✓ | – |
| torch flame flicker | cheap | jitter light **intensity only** (NEVER count) | ✓ | – |
| glowing eyes | cheap | per-part head emissive decal | ✓ | – |
| holy/corrupt tint | cheap | diffuse multiply + emissive bias | ✓ | – |
| value-tier sheen | cheap | `uSheen` biases roughness/spec/emissive floor | ✓ | – |
| magic-glow ambient | cheap | emissiveMap=diffuse, intensity floor ≤2.0 | ✓ | – |

### 4.4 Texture / detail enhancement
| Effect | gpuCost | mechanism | legacy | isolated |
|---|---|---|---|---|
| **AI super-resolution sidecar (ESRGAN/Real-ESRGAN)** | cheap (bandwidth/VRAM) | offline upscale → DID-keyed `.bin` sidecar; swap RGBA8 at `lib.rs:7381` ingest; **operate on post-palette RGBA8, not P8/Index16** | ✓ | **YES — isolated task** |
| generated normal+rough+AO (extend Sobel) | cheap | `normal_gen.rs` adds roughness/AO channels from upscaled diffuse | ✓ | – |
| detail micro-grain overlay | cheap | `_installDetailShaderPatch` (SHIPPED), richer tiles | ✓ | – |
| parallax-occlusion (POM) | **expensive** | per-fragment raymarch, Stone/Brick/Tile, high-only + dist LOD (SHIPPED) | ✓ | – |
| anisotropic highlight (metal/hair) | medium | MeshPhysical `anisotropy` or GGX patch in `<lights_fragment_begin>` | ✓ | – |
| cavity-dirt/AO darkening | cheap | AO channel × diffuse after `<map_fragment>` | ✓ | – |
| tiling-seam fix | cheap | offline tileable variant (in sidecar) or half-texel boundary blend | ✓ | – |

### 4.5 Object-attached particles / auras (synthesized emitters, no DAT 0x32)
| Effect | gpuCost | mechanism | legacy | isolated |
|---|---|---|---|---|
| brazier embers+smoke | medium | 2 synth emitters, additive + alpha, anchor flame-bowl part | ✓ | – |
| dust motes (indoor) | cheap | low-rate +Z motes POJO | ✓ | – |
| pollen/fireflies (foliage) | cheap | sphere-spread motes, firefly=additive+dusk gate | ✓ | – |
| falling leaves | medium | canopy-part emitter, flutter velocity, fade before ground | ✓ | – |
| water splash/spray | medium | splash+mist emitters (audit-driven anchor) | ✓ | – |
| magic gem sparkle | cheap | persistent standing emitter, 2–4 additive sprites | ✓ | – |
| creature breath-fog | cheap | head-part emitter via live rig `partFrames`, cold-region gate | ✓ | – |
| enchant orbiting motes | cheap | circular A/B velocity on item anchor | ✓ | – |
| ground/ceiling drips | cheap | 1–2 droplet, downward A, age out mid-air | ✓ | – |

**Isolated-task callout:** the **AI texture super-resolution** track (model selection, training, batch bake, palettized-P8 handling, DXT-vs-raw sidecar size, per-DID VRAM budget + LRU) is its OWN task — do NOT entangle it with the idle-motion / material archetype components. It is the ONLY isolated item; it intersects the suite only at the `lib.rs:7381` pixel-swap seam and at the classifier (run classification on ORIGINAL DAT pixels, not upscaled — upscaling changes `SurfaceStats`).

---

## 5. GPU-Budget-vs-Holtburg Framework (don't get greedy)

Reuse GROUND-4 probes: `renderer.info` (`memory.{geometries,textures,programs}`, `render.{calls,triangles}`), `diag.js` `window.__diag`, `perf-worker` A/B harness, `quality.js` GPU-tier probe.

### 5.1 Holtburg baseline (ground truth)
- radius-1 Holtburg ring (9 LBs): **222 placements / 66 unique modelIds** (avg 3.4 instances/model) — `statics.js:37-44`.
- radius-6 boot ring (169 LBs): ~16,700 trees/rocks/props + ~51 buildings.
- Baseline perf: outdoor **~20 fps CPU-bound, GPU 30–50% idle** on the 1070.

### 5.2 The gauge (4 steps)
1. **Enumerate** Holtburg-area object DIDs from `dist/manifest.json` + statics/scenery jsonl + the `0xA9B40000.json` oracle.
2. **Sample** — `vfx sample <n> --area holtburg --seed <det>` random weenie/static draw with props + geometry.
3. **Measure** per-archetype incremental cost: baseline `renderer.info` + frame time (rAF Δ) → +effect → **delta**. Two cost meters: MECH-A = CPU mixer-copy; MECH-B/fragment = GPU ALU + tex fetch + VRAM. Additive particles = overdraw (measure fill, not particle count).
4. **Ceiling** — per-frame budget `= target_fps_ms − CPU_time`; at 20 fps CPU-bound the GPU ceiling is the whole idle slice. Hard target: **stay < 75% GPU at full Dereth** so gameplay + next-gen-GPU headroom survive.

### 5.3 Per-effect cost classes (the table the gauge enforces)
| Class | Members | Per-instance budget rule |
|---|---|---|
| **cheap** | global-uniform weathering, all emissive/sheen, MECH-A keyframe, light-intensity flicker, super-res swap | ~free at steady state; cap = unique-driver count, NOT placements |
| **medium** | 1-extra-tex-fetch weathering, runes/gem, MECH-B vertex displace, particle emitters, aniso | count visible instances in Holtburg ref; cap concurrent |
| **expensive** | POM raymarch (high-only + LOD), heat-haze EffectPass | hard-gate behind quality flag + on-screen test |

Existing caps to reuse (don't reinvent): particle RP6 off-screen + 220m cull, `maxParticlesPerEmitter` per quality preset (64/256/1024/2048), PlayEffect 64-group FIFO, `animSceneryMax` 512 + `animSceneryRadius`.

---

## 6. WorldBuilder.Terminal CLI / REPL Surface (agentic, no UI)

### 6.1 Where it lives
New partial `CommandEngine.Vfx.cs` (sibling of `CommandEngine.SurfaceMaterials.cs`, `CommandEngine.Weenie.cs`, `CommandEngine.RenderGallery.cs`) + handler registration in both dispatchers: REPL `Dictionary<string, Action<string[]>>` (`TerminalRepl.cs:83-215`) and JSON `Dictionary<string, Func<JsonNode, string>>` (`JsonCommandProcessor.cs:151-280`). Two-tier pattern (`CommandEngine.cs:26-28`): handler parses tokens → calls `_engine.VfxMethod(...)` → returns a structured record serialized by the caller (camelCase, null-ignoring `JsonOpts`).

### 6.2 Command surface
| Command | Returns | Notes |
|---|---|---|
| `vfx classify <DID\|landblock>` | `{did, archetype, components, confidence, signals[]}` | runs the §3.2 classifier; dumps the feature vector (weenie + geometry + self-labels) |
| `vfx sample <n> --area holtburg --seed <s>` | jsonl of sampled DIDs + props + model-type | deterministic draw for gauging/audit |
| `vfx anchor-parts <SetupDID>` | candidate canopy/head/tip/bowl/contact part indices | runs `wind_rig.js buildBboxRig` logic in C# |
| `vfx preview <DID>` | PNG path (thumbnail w/ proposed effect) | reuse `RenderGalleryCurator.cs` |
| `vfx gauge --ref holtburg [--quality high]` | budget report (drawcalls, ALU est, particle/instance counts vs caps, % headroom) — **FAIL if over budget** | A/B effect-set on vs off, mirrors perf-worker harness |
| `vfx assign <DID> <archetype>` | writes `source=manual, confidence=1.0` | manual override |
| `vfx audit [<archetype>\|<threshold>]` | `audit.csv` of low-confidence + overrides + outliers | human review (WaterSplash/Drip/enchant-state cases) |
| `vfx emit-allowlist <archetype>` | regenerates the DID Set seed (`tree_wind.js:64` analogue) | auditable git-diff artifact |
| `vfx export` | serializes `visual_descriptors.jsonl` (+ `visual_archetype_rules.jsonl`) to project dir | ready for holtburger bake |

### 6.3 Descriptor storage + consumption
- **Adjudication (storage):** keep visual descriptors in a **sibling `visual_descriptors.jsonl` keyed by DID**, NOT inline in `OntologyEntry`. *Why:* `OntologyEntry` is the geometry/identity cache (`OntologyEntry.cs:9-130`) consumed by holtburger + scenery-bake for a different purpose; a sibling file (auto-loaded alongside `ontology_cache.jsonl` in `CommandEngine.Load`) keeps the visual layer independently versioned/regenerable, mirrors the existing `.scenery.materials.json` sidecar precedent, and survives an ontology re-scan without merge churn. The classifier still *reads* `OntologyEntry` geometry fields + `WeenieIndex` props as inputs.
- **Holtburg client consumption:** the web client fetches a baked manifest the same way it fetches scenery (`init_scenery_base_url` → `{base}{hex}.scenery.jsonl`): an analogous `{vfxBase}{did_hex}.vfx.jsonl` (or a packed catalog). Today's hardcoded `TREE_WIND_DIDS` Set becomes a generated allowlist the JS archetype modules load. New flags publish under the `?visual=` family (`?visual=archetypes`, `?visualBudget=80`, `?tarnish ?wetness ?frost ?moss ?dust ?glint ?clothFade ?magicGlow`, per-archetype `?<effect>=on`), parsed at scene init (`tree_wind.js:15-56` memoized pattern).
- **Scenery bake consumption:** at `statics.js bakeStaticsRing` / `placeSnapshot`, before `InstancedMesh.add`, look up the descriptor for the placement's `model_id` → attach the component (MECH-A clip via `attachWindTrees`-style hook, or MECH-B/fragment material variant via `getCachedVariant(did, effectName)`). No change to the placement loop itself.

---

## 7. How Tree-Wind Folds In as Archetype #1

| Suite concept | Tree-wind realization (SHIPPED) |
|---|---|
| Archetype | `trunk-canopy` |
| Component | `procMotion.windBend` (one CPU-hinge component) |
| Descriptor allowlist | `TREE_WIND_DIDS` Set (`tree_wind.js:64`) = the *manual seed* the classifier will regenerate as `visual_descriptors.jsonl` lines |
| Flag gate | `treeWindEnabled()` `?treeWind=on` (`tree_wind.js:33`) = the per-archetype flag pattern |
| Runtime host (the consumer) | `animated_scenery.js`: shared mixer/clip/non-rendered template per `(setupId, phaseBucket)`, advanced once/rAF, per-part transforms COPIED onto live instances; distance cull (`animSceneryRadius`), 512 cap (`animSceneryMax`), LRU/orphan reclaim — **all inherited free by every MECH-A archetype** |
| Rig math | `wind_rig.js`: `partBBox` (`:59`), `swayAmp` (`:98`), `buildTreeWindClip` (`:149`, seamless integer-cycle loop), `hash01` (`:199`, deterministic per-instance phase, Math.random-free) |
| Legacy-safety | per-part Group transforms on a non-rendered template; collision BSP untouched; byte-identical frozen path when off |

**The runtime that consumes descriptors is already built.** Generalizing = adding new rig/displacement generators + fragment patch installers that feed the SAME `buildSceneryAnimationClip` player and the SAME `_chainBeforeCompile` chain. The descriptor file replaces the hardcoded Set.

---

## 8. Phased Roadmap

### Phase 0 — FIRST buildable increment (the minimal vertical slice)
- [ ] **Generalize tree-wind into the component schema:** factor `procMotion.windBend` into a named component with a `config` block; keep `?treeWind=on` working byte-identical. (JS-only, no WASM rebuild.)
- [ ] **2–3 archetype classifier** in `CommandEngine.Vfx.cs`: `trunk-canopy` (reuse the allowlist), `rigid-glint` (WeaponType=Sword/Axe/Mace + metal), `tip-flex` (WeaponType=Spear/Staff + thin distal). Deterministic rules over `WeenieIndex` + `OntologyEntry` geometry.
- [ ] **Surface as WB.Terminal commands:** `vfx classify`, `vfx sample`, `vfx emit-allowlist`, `vfx gauge --ref holtburg`.
- [ ] **Gauge against Holtburg:** run `vfx gauge` to confirm the 3-archetype set stays within the GPU ceiling on the 222-placement ref; produce the budget report.
- [ ] **Output:** `visual_descriptors.jsonl` (3 archetypes) + a regenerated allowlist that reproduces today's `TREE_WIND_DIDS` exactly (proves the round-trip).
- Exit bar: classifier round-trips the tree allowlist; `vfx gauge` green; bare-default loads + spawns + 0 errors.

### Phase 1 — emissive/material bundle (JS-only, no rebuild)
- [ ] Ship the cheap fragment family: `magic-glow ambient`, `enchant-shimmer`, `glint`, `tarnish`, `wetness/frost` — all reuse the emissive/`uTime`/`_chainBeforeCompile` infra. Default-OFF behind `?visual=` flags → batched 1070 eye-test → default-ON with `=off` escape.

### Phase 2 — MECH-B deformation archetypes (may need WASM getters)
- [ ] `tip-flex`, `bow-limb`, `cloth-flutter`, `worn-garment` GPU vertex displacement; `drawAmount`/`velocityHeading` from existing client substate (read-only). Normal-recompute decision measured on 1070.

### Phase 3 — particle/aura bundle
- [ ] Synthesized emitters: `brazier embers+smoke`, `foliage pollen/fireflies/leaves`, `gem sparkle`, `breath-fog`. Define shared billboard gfxobjs + `vfx anchor-parts` selector.

### Phase 4 — bake-side migration + system simplification  ⟵ RE-PHASED 2026-06-25
- [ ] Move the suite's deterministic runtime work to the BUILD SIDE (Rust crates / WorldBuilder.Terminal) as **per-DID** baked artifacts the runtime just FETCHES; three.js/wasm renders. **Bucket A (descriptor-config enrichment, the bulk):** bake Phase-2 shaft geometry (shaftAxis/gripBase/shaftLen), Phase-3 resolved emitter POJOs + anchor part-index/bbox, and Phase-0 wind config into the existing per-DID `visual_descriptors.jsonl` via the C# classifier `BuildResult`. **Bucket B (one new binary artifact):** stand up a **per-DID binary-sidecar** bake+fetch path on Phase-0 wind clips (VAT / Animation-0x03) — the same path Phase 5 texture channels reuse. **Leave Phase 1 (emissive) alone** (already baked). Dual mandate: *analyze + simplify* the runtime now that derivation moves offline, guarded by `off=byte-identical` + the legacy/program-key firewall. Plan: `docs/PHASE4-BAKE-MIGRATION-WORKFLOW-2026-06-25.md` (16-agent buildbox sweep).

### Phase 5 — texture/detail (excluding isolated AI track)  ⟵ was Phase 4
- [ ] Extend `normal_gen.rs` (roughness/AO channels), richer detail tiles, seam-fix; anisotropy as ONE global filtering option (not per-material). Uniform per-surface treatment baked offline onto the Phase-4 per-DID binary-sidecar path; category tunes strength only, never *which* effects. AI super-res runs as the **isolated** parallel track and only swaps pixels at the ingest seam.

### Phase 6 — classifier maturation + full catalog  ⟵ was Phase 5
- [ ] Grow to ~20–40 archetypes; audit/override pass; per-archetype default-on flips gated by `vfx gauge` + batched 1070 eye-tests.

---

## 9. Agenda for the Future 16-Agent VM Brainstorm

Deep-dive angles to explore exhaustively (fan-out, one slice per agent cluster):

1. **Component interface spec** — the canonical `VisualComponent` contract so deformation + material + light + particle components compose on ONE `_chainBeforeCompile` chain, ONE `uTime`, ONE shared uniform block WITHOUT N² shader permutations / cache-key explosion.
2. **Full archetype taxonomy (~20–40)** — finalize names, component bundles, parameter curves; decide C# `VisualArchetype` enum (shared WB.Terminal↔WASM) vs JSON string schema.
3. **Classifier design** — feature-vector spec (weenie ItemType/WeaponType/MaterialType/ValidLocations/AttackType/spell-DIDs + geometry aspect/distal-test/part-count/compactness + DAT self-labels); decision-tree vs scoring; confidence model; audit/override format; compound AttackType (166/160/486) handling.
4. **MECH-A vs MECH-B decision rule** — when a setup has enough parts for CPU hinges vs needing GPU intra-part displacement; per-part vs intra-part discriminator.
5. **GPU normal-recompute strategy** for displaced verts (cloth/limb) vs cheap normal-skip — measure on 1070.
6. **Draw/cast state plumbing** — prove `drawAmount`/cast substate is the SAME read-only client value, zero wire impact.
7. **Material-oscillator layer** — persistent oscillator registry in `_tickMaterialHooks` (pulse/glint sweep) + onBeforeCompile shader budget.
8. **Weathering compose-order** — fade/tarnish AFTER paletted-diffuse decode (the wash-to-white dyed-luminous bug); BatchedMesh per-instance age (instance attribute vs hash texture); shadow-pass must NOT get weathering patch.
9. **Particle slice** — synthesized-emitterInfo POJO schema + shared billboard gfxobjs (soft-dot/spark/smoke/droplet/leaf); auto part-anchor selector on `buildBboxRig`; day/weather/region visibility gates; persistent-emitter cap + landblock-eviction teardown.
10. **Bloom + light budget** — selective vs global bloom; how many >threshold emissive objects before mipmap cost bites; flame flicker reconciled with `MAX_ACTIVE_LIGHTS=32` + no-count-change relink (dedicated flame channel).
11. **GPU-cost model + `vfx gauge`** — per-archetype cost table; per-frame ceiling formula; concurrency caps; 1070 A/B against Holtburg steady-state; CPU-vs-GPU bottleneck isolation under quality presets.
12. **WB.Terminal command surface** — finalize `CommandEngine.Vfx.cs` verbs; classifier→archetype-map artifact format + baked-manifest fetch (mirror scenery bake).
13. **Legacy-safety lint** — automated test that no component reads a non-static/non-clock input or writes a wire/physics/replicated field (codify THE RULE).
14. **DAT-hook coexistence** — don't double-animate objects whose SetupModel already fires hooks 22/23/24.
15. **LOD/cull unification** — one tick-cull radius authority across all archetypes.
16. **AI TEXTURE UPSCALING — ISOLATED TASK** *(its own agent track, do not entangle):* model selection (Real-ESRGAN vs SwinIR vs game-art-tuned); palettized P8/Index16 (upscale post-palette RGBA8, not indices); DXT re-encode vs raw RGBA8 sidecar size; DID-keyed sidecar catalog format (mirror `init_scenery_base_url`); per-DID VRAM budget + LRU eviction; **classification must run on ORIGINAL DAT pixels** (upscale changes `SurfaceStats`).

---

## Adjudicated disagreements
- **Descriptor home (OntologyEntry inline vs sibling jsonl):** GROUND-1 offered both. **Chose sibling `visual_descriptors.jsonl` keyed by DID** — keeps the visual layer independently regenerable, mirrors the `.scenery.materials.json` sidecar precedent, survives ontology re-scan without merge churn, and matches the baked-manifest fetch path the client already uses. The classifier still reads OntologyEntry geometry as input.
- **Classifier locus (WASM heuristic vs JSON config vs C#):** **Chose offline C# in `CommandEngine.Vfx.cs` emitting JSON** — easiest iteration, lower runtime latency, reuses the same DAT structs WB.Terminal already parses, and keeps the JS runtime dumb (just reads tags). WASM stays a pure consumer.
- **Allowlist-first vs auto-apply day-zero:** **Allowlist-first, graduate to classifier** — GROUND-2's grounded pattern (ship OFF/allowlist → smoke → curated enable → graduate). Avoids 10k day-zero auto-labels; the classifier *regenerates* the allowlist for audit.
- **MaterialType as a gate:** **Rejected as a required gate** (present on only ~0.5% of weenies, GROUND-3) — used only as a secondary refiner; primary signals are WeaponType + geometry + DAT self-labels.
