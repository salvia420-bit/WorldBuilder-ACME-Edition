# Visual-Behavior Suite — Build Spec (holtburger)

**Status:** implementation-ready. Lead synthesis over 16 BUILD-SPEC slices + the design doc (`docs/visual-behavior-suite-design-2026-06-23.md`).
**Home:** `WorldBuilder.Terminal` C# REPL/JSON agent (no GUI). **Live client:** `external/holtburger/apps/holtburger-web/` (NOT `~/holtburger`).
**Shipped substrate (archetype #1):** `scene3d/tree_wind.js` + `scene3d/wind_rig.js` + `scene3d/animated_scenery.js`.

This document is the single source a laptop developer builds from. All file:line citations are against `external/holtburger/apps/holtburger-web/` unless prefixed `WorldBuilder.*` (C#) or `src/lib.rs` / `crates/` (Rust). Slice numbers (S01..S16) point back to `/home/wbterminal/visual-suite-out/parts/`.

---

## 1. Overview, the binding SAFETY RULE, and how this spec is organized

### 1.1 What the suite is

Every AC object (2,763 unique SetupDIDs across 19,686 weenies) carries an extensible **bag of visual-behavior components** (sway, glint, tarnish, glow, embers, texture-detail, proc-motion). An **auto-classifier** maps `DID → archetype` (a named bundle of components) from weenie props + DAT geometry shape, gauged against a **Holtburg GPU budget**. The shipped tree-wind is archetype #1; the suite generalizes its substrate. Cost scales with **unique drivers** (a handful), never placement count, because the world is **CPU-bound ~20 fps with the GPU 30–50% idle on the GTX 1070** — effects spend the idle GPU.

### 1.2 THE RULE (binding, verbatim from design §1.2)

> An effect may **READ only** (a) STATIC/DERIVED inputs — DAT geometry/Surface/SetupModel fields, weenie props, the object's server-authoritative position/heading, and a deterministic per-instance hash (`hash01(guid)`, `wind_rig.js:199`); plus (b) the shared CLIENT WALL-CLOCK (`scene3d.frameTime.tsSec` / `performance.now()`). An effect may **WRITE only** to RENDER-TIME transforms/materials that the server neither stores nor replicates: the THREE render-root or per-part Group local transform, and per-entity CLONED material uniforms (emissive/opacity/color/roughness, `map.offset`). It may **NEVER** write the value sent on the wire, the physics/collision state, or any server-replicated field.

**The five corollaries every component obeys (each enforced mechanically by §13):**
1. **No physics/collision/gravity.** The collision BSP is server-authoritative and untouched. Particle "gravity" (ParabolicLVGA) is a render trajectory, never rigid-body.
2. **Never change visible light COUNT.** A count change forces a MeshStandard shader RELINK + multi-second freeze (the `project_spell_freeze_light_pool` history). Modulate `.intensity`/`.color` ONLY; drive a light dark with `intensity=0`, never `.visible`. Never toggle `castShadow`.
3. **Never make `customProgramCacheKey` per-instance.** That explodes shader links — the project's #1 cold-load cost (`materials.js:262` `_patchSetCacheKey` keys on per-SET userData booleans, never per-instance values).
4. **Determinism.** Per-instance variation comes from `hash01` (`wind_rig.js:199`), never `Math.random()`/argless `Date.now()`.
5. **Proof it can't desync (in-tree):** `EntityInstance.setPose` does `this.root.quaternion.copy(...)` (`entities.js:2161`) every position update, STOMPING any render-time write; the shipped `SetOmega` spin survives only because it is re-derived client-side and re-applied AFTER the copy (`entities.js:2178` `premultiply(_omegaAccumQ)`). A render write is one-way (wire→`setPose`→`root`); nothing reads `root` back to the wire.

### 1.3 How this spec is organized

§2–§16 map 1:1 to the 16 slices (component interface → AI upscaling). §17 is the consolidated dependency-ordered build order. §18 is open risks. Where slices overlapped or disagreed, the adjudication is called out inline in a **▶ ADJUDICATION** block and rolled up in §17. Read §2 (the component contract) and §17 (build order) first — everything else hangs off those two.

---

## 2. Component interface (S01) — the `VisualComponent` contract

**New modules:** `scene3d/vfx/registry.js`, `scene3d/vfx/setkey.js`, `scene3d/vfx/attach.js`, `scene3d/vfx/tick.js`, `scene3d/vfx/components/*.js`.

### 2.1 The three-identity firewall (the spec hinges on this)

| Identity | Granularity | Controls | Mechanism |
|---|---|---|---|
| **Program key** (`customProgramCacheKey`) | per *component-SET* (+ link-variant bits) | how many shaders LINK (cold-load cost) | `_patchSetCacheKey` (`materials.js:262`) extended with `\|v + __vfxSetKey` |
| **Clone key** (JS Map) | per `(surfaceDid, setKey, configKey)` | how many material OBJECTS exist (heap) | `getCachedVariant` (new, mirrors `getCachedFloorBias` `materials.js:1794`) |
| **Per-instance channel** | per instance | per-object phase / weathering age | procedural in-shader hash (default) or `InstancedBufferAttribute aVfxHash` |

> **Invariant (the firewall):** config scalars and per-instance hashes flow ONLY through uniforms / attributes. They MUST NOT appear in `customProgramCacheKey`. Program count ≈ distinct component-SETs (~20–40 across the whole catalog), never 10k DIDs × instances.

### 2.2 The contract (plain JS objects; repo is `.js`)

```ts
interface VisualComponent {
  id: string;                 // "emissive.glint" — sorted into setKey
  family: "deformation"|"weathering"|"emissive"|"texture"|"particle";
  mech: "A"|"B"|"frag"|"light"|"particle";
  channel: string;            // §14 conflict unit: "transform"|"omega"|"uvScroll"|"emissive"|"particle"|...
  linkVariant(config): string;             // LINK-AFFECTING bits ONLY; derivable from config, no per-instance. "" = none.
  inject(shader, ctx): void;               // pure GLSL edit at canonical seams; never reads per-instance here
  declareUniforms(shader, config, globals): void;  // GLOBAL uniforms assigned BY REFERENCE (VFX_GLOBALS.uTime); config uniforms set once
  tick?(dt, t): void;                      // optional; updates SHARED uniforms only; O(1)
  buildClip?(parts, config): {frames, numParts, numFrames, fps};  // MECH-A only
  spawn?(node, anchorPartIdx, config, pm): EmitterHandle[];        // particle only
  // legacy-safety manifest (consumed by §13 lint):
  reads:  ReadCap[]; writes: WriteCap[];
  deterministic: true; lightCountDelta: 0; cacheKeyScope: "set"|"none";  // never "instance"
  defaults: Cfg;
}
```

### 2.3 Single-chain composition (canonical injection seams, all verified)

| Family | Seam (three.js chunk) | Edits | Evidence |
|---|---|---|---|
| varying decl | `#include <common>` (vtx+frag) | `varying float vVfxHash; varying vec3 vVfxWorld;` | `materials.js:319/331` |
| deformation (MECH-B) | after `<begin_vertex>` | `transformed += displace(...)` (SUM across deform comps) | `materials.js:325` |
| per-instance read | after `<begin_vertex>` | `vVfxHash = aVfxHash` (USE_INSTANCING) or procedural hash | three sets `USE_INSTANCING` for InstancedMesh |
| weathering | after `<map_fragment>` | modify `diffuseColor.rgb` (post-palette, §8) | `materials.js:427` (detail-patch precedent) |
| emissive | after `<emissivemap_fragment>` | `totalEmissiveRadiance += ...` | reuses `applyFloatLumDiffuse` path `materials.js:1238` |
| glint/spec | after `<roughnessmap_fragment>` | modulate `roughnessFactor`/spec | three std chunk |

Composition order is deterministic via `FAMILY_ORDER = {deformation:0, texture:1, weathering:2, emissive:3, particle:9}`, ties broken by `id`. Multiple deformations SUM into `transformed`; weatherings chain-modify `diffuseColor`; emissives accumulate into `totalEmissiveRadiance` — distinct seams, no conflict.

### 2.4 Cache-key strategy — the ONE unified `_patchSetCacheKey` extension

▶ **ADJUDICATION (S01/S05/S07/S08 all proposed separate `_patchSetCacheKey` bits — unify them).** The canonical extension is **one** `__vfxSetKey` field (S01) that encodes the full component-SET plus every component's `linkVariant()`. S05's normal-strategy (`skip/analytic/finitediff`), S07's oscillator-channel bitmask, and S08's `weatheringTextured` bit are **all `linkVariant()` outputs** of their components — they fold INTO `__vfxSetKey`, they do not add parallel `|n`/`|o`/`|wt` fields. The pre-existing standalone patches (detail/CSM/POM/floorBias) keep their existing boolean flags. Net change to `_patchSetCacheKey` (`materials.js:262`): append exactly one line:

```js
+ "|v" + (u.__vfxSetKey || "")   // the single firewall line; read lazily at setProgram (materials.js:259-261)
```

`componentSetKey(comps, config) = comps.map(c => c.id + (c.linkVariant(config[c.id])||"")).join("+")` — sorted by `FAMILY_ORDER` then `id`, so `{glint,tarnish}` and `{tarnish,glint}` collapse to one program. Two swords with `glint.strength` 0.4 vs 0.6 → identical setKey (strength is a uniform) → ONE program.

### 2.5 Shared globals + single tick

▶ **ADJUDICATION (S01 `VFX_GLOBALS.uTime` vs S07 `oscillators.channel('uTime')` — same object, one tick).** `VFX_GLOBALS` holds the shared `{value}` uniform objects assigned BY REFERENCE into every patched material; the **S07 `MaterialOscillatorRegistry` (§7) IS the implementation** that drives them once/frame. There is exactly ONE per-frame VFX tick, not two. See §7 for the registry; `VFX_GLOBALS.uTime` === `oscillators.channel('uTime').uniform`.

```js
const VFX_GLOBALS = { uTime:{value:0}, uWindDir:{value:new THREE.Vector2()}, uWetness:{value:0}, uFrost:{value:0}, uCamPos:{value:new THREE.Vector3()} };
```

### 2.6 `getCachedVariant` (mirrors `getCachedFloorBias` `materials.js:1794` exactly)

```js
getCachedVariant(surfaceDid, setKey, configKey, builder) {
  if (this.wireframeMode) return this._getCachedDouble(surfaceDid);
  const key = `${surfaceDid>>>0}|${setKey}|${configKey}`;
  let v = this.vfxVariants.get(key);                 // new Map in ctor
  if (!v) {
    const base = this._getCachedDouble(surfaceDid);
    v = base.clone();                                // CLONE shares textures (materials.js:1779/1800)
    v.userData = { ...(base.userData||{}), __cacheOwned:true, __vfxSetKey:setKey };  // set BEFORE _chainBeforeCompile
    builder(v);                                      // runs FAMILY_ORDER: declareUniforms + _chainBeforeCompile(comp.inject)
    v.needsUpdate = true; this.vfxVariants.set(key, v);   // reuse installPaletted LRU (materials.js:1873)
  }
  return v;
}
```

### 2.7 MECH-A/B coexistence proof (the bow)

MECH-A's `stringHinge` writes the **part Group local transform** via the shared-mixer template copy (`animated_scenery.js:607-609`). MECH-B's `limbFlex` writes `transformed` in the **vertex shader**. The vertex `modelViewMatrix` already includes the MECH-A part-Group transform, so B composes ON TOP of A automatically — disjoint layers, both read only `VFX_GLOBALS.uTime`, no ordering dependency.

### 2.8 Build checklist (S01)
1. `scene3d/vfx/registry.js` — `VFX_REGISTRY` Map + `registerComponent`/`getComponent`; export `VFX_GLOBALS`.
2. `scene3d/vfx/setkey.js` — `FAMILY_ORDER`, `orderedFragVertComps`, `componentSetKey`, `quantizeConfig` (config→stable string, NEVER into program key).
3. `materials.js:262` — append the single `|v + __vfxSetKey` line.
4. `materials.js` (ctor + near `:1794`) — `this.vfxVariants = new Map()` + `getCachedVariant(...)`.
5. `materials.js:3336` — add `this.vfxVariants` to `dispose()` `_disposeEach` walk.
6. `scene3d/vfx/attach.js` — `attachVfx(scene3d, node, surfaceDidByPart, descriptor, ctx)`: split by `mech`; MECH-A → `routeMechA` (→ `attachWindTrees` `animated_scenery.js:495`); frag/vertex → `getCachedVariant`; particle → `spawn`.
7. `scene3d/vfx/tick.js` — the single VFX tick (§7), wired in `loop.js` after `tickAnimatedSurfaces` (~`loop.js:1812`).
8. `statics.js` InstancedMesh build (~`:1223`) — attach `aVfxHash` `InstancedBufferAttribute` ONLY where placement-stable per-instance values are needed (default is procedural, §8); guard shader read with `USE_INSTANCING`.
9. `scene3d/vfx/components/windBend.js` — first component wrapping `buildBboxRig`+`buildTreeWindClip` (`wind_rig.js:113/149`); `mech:"A"`, `channel:"transform"`, reads `["dat.geometry","dat.setupModel","hash.instance","clock.frame"]`, writes `["render.partTransform"]`.
10. **Round-trip proof:** feed the 6 `TREE_WIND_DIDS` (`tree_wind.js:64`) as `trunk-canopy/[procMotion.windBend]`; confirm `attachVfx`→`routeMechA` reproduces `?treeWind=on` byte-identically.
11. One frag exemplar (`components/glint.js`); assert two glint configs → **1 program, 2 clones** (`renderer.info.memory.programs`).

---

## 3. Archetype taxonomy + schema (S02)

### 3.1 Representation decision

▶ **ADJUDICATION (S02, confirms design §Adjudicated):** archetype id is a **stable kebab-case STRING**; single source of truth is `visual_archetype_rules.jsonl`. C# references ids through a **generated const-string class** `VisualArchetypeIds` (codegen from the registry, NOT a hard `enum`). JS loads the same registry into a string-keyed Map. Rationale: archetypes are an *open evolving* set ("grow to ~20–40", Phase 5); a closed enum forces recompiles and fights the thesis "adding an effect = registering a component, nothing else breaks." SurfaceCategory stays a hard mirror only because it is a *closed physical* set of 13.

### 3.2 Canonical table (28 archetypes + `rigid` fallback + 2 universal modifiers = 31 registry lines)

`mech`: **A**=CPU per-part keyframe; **B**=GPU `begin_vertex`; **frag**; **light**; **particle**; **texture**; **defer**=DAT already animates (§14).

| # | id | components[] | mech | cost | classifier signal | key defaults |
|---|---|---|---|---|---|---|
| 1 | `trunk-canopy` (SHIPPED) | `procMotion.windBend` | A | cheap | wind allowlist `tree_wind.js:64` OR Foliage+multi-part+tall | windBend{ampDeg7, fps30, loopSeconds4, cycles1=3, cycles2=11, flutter0.3, dirDeg135, trunkSuppress0.3} = `wind_rig.js:151-159` |
| 2 | `plant-whip` | `procMotion.organicWhip` | A/B | cheap | Foliage + high single-axis aspect, short | organicWhip{ampDeg12, cycles1=2, cycles2=7, heightWeight"linear"} |
| 3 | `tip-flex` | `procMotion.tipFlex`,`emissive.glint` | B | cheap | WeaponType∈{Spear,Staff,Wand}+thin distal | tipFlex{ampDeg1.5, axis"shaftLong", weightCurve"smoothstep", gripAnchor"holdingLoc"}; glint{strength0.4} |
| 4 | `bow-limb` | `procMotion.limbFlex`,`procMotion.stringHinge` | B+A | medium | WeaponType∈{Bow,Crossbow} | limbFlex{ampDeg3 idle, drawSource"clientRangedSubstate"}; stringHinge{mech cpu} |
| 5 | `cloth-flutter` | `procMotion.clothRipple` | B | medium | banner/flag OR flat-thin-sheet+Cloth | clothRipple{ampDeg8, waveSpeed1.5, wavelength0.4, anchorEdge"topEdge", normalStrategy"analytic"} |
| 6 | `worn-garment` | `procMotion.garmentFlutter` | B | medium | ValidLocations cloak/chest+Cloth | garmentFlutter{ampDeg5, hemWeight"smoothstep", normalStrategy"finitediff"} |
| 7 | `hanging-sway` | `procMotion.pendulum` | A | cheap | thin vertical hanging multi-part | pendulum{ampDeg4, period3.5, axis"topPivot"} |
| 8 | `sign-swing` | `procMotion.signSwing` | A | cheap | ItemType=Sign+off-center top-pivot, no DAT hook | signSwing{ampDeg3.5, period4} |
| 9 | `display-spin` | `procMotion.omegaSpin` | **defer** | cheap | **DAT hook 22 SetOmega** self-label | reads DAT axis+omega; suite ADDS NOTHING (§14) |
| 10 | `levitate-bob` | `procMotion.bob` | tick | cheap | levitation/float property/spell | bob{ampMeters0.08, period3, axis"+Zrender"} render offset only |
| 11 | `idle-breath` | `procMotion.breathScale` | B | cheap | WeenieType=Creature, at-rest, no DAT idle | breathScale{ampScale0.02, period4, anchor"chest"} |
| 12 | `soft-jiggle` | `procMotion.decayWobble` | B | cheap | container/food + compact soft | decayWobble{ampDeg6, decayTau0.6, trigger"clientLocal"} |
| 13 | `rigid-glint` | `emissive.glint`,`weathering.tarnish` | frag | cheap | WeaponType∈{Sword,Axe,Mace,Dagger}+metal | glint{strength0.5, sweepSpeed0.7}; tarnish{amount"hash01", roughTarget1.0} |
| 14 | `metal-tarnish` | `weathering.tarnish`(+`.rust`) | frag | cheap/med | MaterialType metal **refiner** | tarnish{topWeight0.6}; rust{tile"rustBlotch"} |
| 15 | `magic-glow` | `emissive.magicGlowAmbient` | frag | cheap | spell DIDs OR Gem/magic | magicGlowAmbient{intensityFloor1.0, cap2.0, bloomTier"soft"} |
| 16 | `enchant-shimmer` | `emissive.enchantShimmer` | frag | cheap | enchanted/spell DIDs | enchantShimmer{amp0.25, period2, bloomTier"sub"} — `I·(1+a·sin)` |
| 17 | `spell-school-aura` | `emissive.schoolAura` | frag | cheap | spell DID with school | schoolAura{rimPower3, intensity0.6, bloomTier"soft"} |
| 18 | `glowing-runes` | `emissive.runeEmissive` | frag | medium | altar/lifestone OR high-value weapon | runeEmissive{runeTile, accum0.5, bloomTier"hard"} |
| 19 | `gem-inner-fire` | `emissive.gemInnerFire` | frag | medium | Gem+translucent | gemInnerFire{fresnelInv, coreGlow0.7, bloomTier"hard"} |
| 20 | `value-tier-sheen` | `emissive.sheen` | frag | cheap | high Value tier | sheen{roughBias−0.1, emissiveFloor0.05, bloomTier"sub"} |
| 21 | `glowing-eyes` | `emissive.eyeEmissive` | frag | cheap | Creature+head part | eyeEmissive{partAnchor"head", intensity1.5, bloomTier"soft"} |
| 22 | `holy-corrupt-tint` | `emissive.tint` | frag | cheap | alignment/faction | tint{diffuseMul, emissiveBias0.1, bloomTier"sub"} |
| 23 | `flow-scroll` | `texture.texVel` | **defer**/frag | cheap | **DAT hook 23/24** self-label OR Lava/Water | DEFER if hook; else texVel{uSpeed,vSpeed} |
| 24 | `flame-flicker` | `emissive.flameFlicker` | light | cheap | light-bearing torch/brazier | flameFlicker{amp0.18, floor0.55, ceil1.25, channel"flame", neverChangeCount} |
| 25 | `fire-particle` | `particle.embers`,`particle.smoke` | particle | medium | brazier/fire+bowl part | embers{rate0.06, max24, anchor"bowl"}; smoke{rate0.3, max10} |
| 26 | `foliage-ambient` | `particle.motes`(+`.leaves`) | particle | cheap/med | Foliage+canopy (firefly=dusk gate) | motes{rate0.4, spread"canopyBox"}; leaves{rate1.2, fadeBeforeGround} |
| 27 | `water-context` | `particle.splash`,`particle.mist` | particle | medium | **AUDIT-driven** anchor | splash{anchor"audit"} |
| 28 | `dusty-indoor` | `particle.dustMotes`,`weathering.dust` | particle+frag | cheap | Furniture/Prop indoor+aged | dustMotes{rate0.5, +Z}; dust{topWeight} |
| — | `rigid` (fallback) | `[]` | — | free | else (no signal) | byte-identical frozen path |
| U1 | `weatherable` (modifier) | `weathering.wetness`/`.frost` | frag | cheap | GLOBAL weather/season (NOT classifier) | wetness{uWetness global, upFacing}; frost{mutually-excl} |
| U2 | `textured` (modifier) | `texture.superRes`/`.normalGen`/`.detailGrain`/`.pom`/`.aniso` | texture | cheap–**exp** | SurfaceCategory+quality | POM + heat-haze **gated-expensive** (§11) |

**Modifiers ride in `descriptor.modifiers[]`** and compose on any base archetype (not exclusive). POM/heat-haze are the ONLY `expensive` entries and both hard-gated; no base archetype is expensive.

### 3.3 Descriptor + rule schema (the canonical merged form — see §3.4 adjudication)

```jsonc
// visual_descriptors.jsonl — one line per classified DID (DID serialized "0x%08X" for git-diff audit)
{
  "did": "0x02000724",
  "archetype": "tip-flex",                       // MUST ∈ registry ids
  "confidence": 0.62,
  "source": "classifier",                        // classifier | classifier-low | manual | dat-self-label | allowlist
  "mech": "B",
  "components": [                                 // resolved bundle; each carries channel + optional suppress
    { "name": "procMotion.tipFlex", "channel": "transform", "config": { "ampDeg": 1.5 } },
    { "name": "emissive.glint",     "channel": "emissive" }
  ],
  "modifiers": ["weatherable", "textured"],
  "datSelfAnim": { "animDid": 0, "hooks": [], "channels": [], "hasKeyframeMotion": false },  // §14
  "signals": [ {"name":"weaponType","value":"5","weight":0.7} ]   // audit; stripped from --slim client catalog
}
```

`visual_archetype_rules.jsonl` (registry, single source of truth): one line per archetype `{id,label,components,mech,cost,flag,defaults,select}`; the `rigid` fallback + `weatherable`/`textured` modifiers included.

### 3.4 Schema/representation adjudications

▶ **ADJUDICATION (S02 `config` as sparse map vs S12/S14 `components[]` as objects).** Merge: `components[]` is an **array of objects** `{name, channel, config?, suppressedBy?}` (S12/S14 shape) — this carries the per-component `channel` (needed by §14 coexistence) and `suppressedBy` flag. The registry's `defaults` supply per-component config; the descriptor's `config` is a sparse override merged at load via `resolveConfig`. C# `VisualDescriptor` keeps `Config` as a `JsonObject` so the config schema can evolve without a model bump.

▶ **ADJUDICATION (C# file name — S02 `VisualArchetype.cs` vs S12 `VisualDescriptor.cs`).** One file: `WorldBuilder.Shared/Lib/VisualDescriptor.cs`, holding `VisualDescriptor`, `VisualSignal`, `VisualArchetypeRule`, and the generated `VisualArchetypeIds` const-string class. `VisualDescriptorIndex` is a structural copy of `WeenieIndex` (`WeenieIndex.cs:84-165`) with `SaveJsonl`/`LoadJsonl`, serialized with `JsonOpts` (camelCase, null-ignoring, `WeenieIndex.cs:122`). Add a `"0x%08X"` `uint` `JsonConverter` (parse via the `ParseDid` convention, `CommandEngine.SurfaceMaterials.cs:263`).

### 3.5 Build checklist (S02)
1. `WorldBuilder.Shared/Lib/VisualDescriptor.cs` — records + `VisualArchetypeIds` + `VisualDescriptorIndex`.
2. Author `visual_archetype_rules.jsonl` — 31 lines transcribing §3.2.
3. `CommandEngine.Vfx.cs` `LoadArchetypeRules()` + validate every descriptor `archetype ∈ rules.Keys` on write (fail loud).
4. Codegen `VisualArchetypeIds` consts from rules ids (`vfx gen-ids` verb).
5. `scene3d/archetype_registry.js` (pure, no scene-graph imports) — `registerArchetype`/`archetypeFor`/`resolveConfig`.
6. Round-trip test: `archetypeFor(did)==="trunk-canopy"` for exactly the 6 `TREE_WIND_DIDS`, `"rigid"` otherwise.
7. `rigid` path emits zero components → statics/scenery bake skips attach → frozen path unchanged.
8. Per-archetype flag readers — generalize `tree_wind.js:33-56`'s memoized `_strFlag`/`_numFlag`; keep `?treeWind=on` as an alias for `trunk-canopy`.

---

## 4. Auto-classifier (S03)

Offline C# in `CommandEngine.Vfx.cs`, deterministic, auditable as a git diff. Reads ONLY static/derived inputs; emits `visual_descriptors.jsonl` + `visual_archetype_rules.jsonl`.

### 4.1 The DID↔weenie key problem (solve first)

Descriptor is keyed by **SetupDID** (99.97% present); weapon/material/attack/spell props live on the **weenie** and N weenies share one setup. **Resolution:** build `Map<setupDid, List<wcid>>` by inverting `WeenieIndex.TryGetSetup` (`WeenieIndex.cs:103`) over `WeenieIndex.Entries` (`:112`); **union** weenie signals per setup; if contributing weenies disagree on the primary motion tier, drop confidence 0.3 + push to audit (`reason=multi-weenie-conflict`). Zero-weenie setups (pure scenery) classify on geometry+surface only (Tier 5).

### 4.2 Feature vector (per SetupDID)

- **Identity:** setupDid, contributingWcids, weenieType (`WeenieIndex.cs:36`).
- **Weenie props (union, from `AceWeenieSnapshot.Ints`, keys via `AceWeeniePropertyEnums.cs`):** itemType(1), weaponType(353), materialType(131, ~0.5% → **refiner only**), validLocations(9), attackType(47, bitfield), hasSpellDIDs (`SpellBookCount>0`), inscription.
- **Geometry (`OntologyEntry.cs:24-61`):** maxDimension, aspectRatio, partCount, polyCount, vertexCount, bounds.
- **Derived geometry (port of `wind_rig.js buildBboxRig`/`partBBox`):** distalProtrusion, compactness, hasHoldingLoc (`setup_model.rs:334`), flatSheetAxis.
- **DAT self-labels (highest confidence, §14):** hookSetOmega(22), hookTexVelocity(23/24), hookCreateParticle(13/26), hookLuminous(8/9), hookScale(12), omegaAxis.
- **Surface (`surface_classify.rs:31`, JS mirror `materials.js:138`):** surfaceCats[], dominantSurface, anyLuminousSurface.

**§4.2a distal-protrusion test:** `distalProtrusion = (distalPart.longestAxis/minorAxis) × (distalCentroidDist/maxDimension)`. High (>3) + low partCount (1–2) ⇒ tip-flex; aspectRatio>3 ⇒ whip; flatSheetAxis≥0 ⇒ cloth/sign.

### 4.3 Algorithm — priority cascade + scored leaf

▶ **ADJUDICATION (decision-tree vs weighted-scoring):** **priority-ordered cascade** for SELECTION (auditable git diff, mirrors `OntologyService.ClassifyCategoryByHeuristic` `OntologyService.cs:577-637`), with a small **weighted score only** (a) inside the geometry-only tier and (b) for the confidence number. A pure score model is not git-diff-auditable and can't satisfy the Phase-0 exact round-trip.

**Two-stage output:** the cascade picks ONE primary archetype; an **independent additive pass** appends refiner components (weathering/emissive/particle) via per-component predicates (they compose).

Stages: `−1` manual override wins → `0` DAT self-label (conf 1.0, §14 runs FIRST) → `1` WeaponType exact (0.9–0.95) → `2` wind allowlist / Foliage (1.0 / ramped) → `3` ItemType+geometry (sign/cloth/creature, 0.6–0.8) → `4` `ScoreGeometryArchetype` (the ~5% no-weenie gap) → `5` default `rigid` (0.6). Then `RefinerComponents(f)` appends.

### 4.4 Rule/score table (selection predicates, priority order)

| Archetype | Predicate | Tier | Conf | Mech |
|---|---|---|---|---|
| display-spin | `hookSetOmega` | 0 | 1.0 | defer |
| flow-scroll | `hookTexVelocity(23/24)` | 0 | 1.0 | defer/frag |
| tip-flex | `WeaponType∈{Spear,Staff}` OR `Magic`+thin; +thrust-capable | 1 | .95/.7 | B |
| bow-limb | `WeaponType∈{Bow,Crossbow}` | 1 | .95 | B+A |
| rigid-glint | `WeaponType∈{Sword,Axe,Mace,Dagger,TwoHanded}`; or tip-flex demote | 1 | .9 | frag |
| trunk-canopy | `setupDid∈WindAllowlist`; or Foliage+parts+tall | 2 | 1.0/ramp | A |
| plant-whip | Foliage+short/whippy (`aspect<1.5`) | 2 | ramp | A/B |
| sign-swing | `Misc`+`inscription`+flatSheet | 3 | .8 | A |
| cloth-flutter | flatSheet+`surface=Cloth` | 3 | .8 | B |
| worn-garment | `Clothing`+`Cloth`+body validLoc | 3 | .75 | B |
| pendulum | linear multi-part vertical, `aspect≥4` | 4(score) | .5-.9 | A/B |
| levitate-bob | `hasSpellDIDs`+small+`Jewelry` | 3 | .65 | tick |
| idle-breath | `Creature` (at-rest) | 3 | .6 | B |
| soft-jiggle | pouch geom, compact non-rigid | 4(score) | .55 | B |
| rigid (default) | no rule matched | 5 | .6 | none |

**Refiners (additive, independent predicates):** metal+weapon→`+tarnish`; Metal surface+weapon→`+glint`; Iron→`+rust`(medium, ~0.5%); hasSpellDIDs→`+magicGlowAmbient +enchantShimmer`; Gem→`+gemInnerFire`; Creature→`+eyeEmissive`; Stone→`+moss`(audit). `water-context/glowing-runes/spell-school-aura/holy-corrupt/overhang-drip` are **audit-only** (`source=classifier-low` → `audit.csv`, never auto-applied day-zero).

### 4.5 Compound AttackType (166/160/486) — mask, never exact-match

`AttackType` is `[Flags]` (`AttackType.cs:5`). Helpers using ACE aggregate masks (`AttackType.cs:31-32`): `ThrustCapable = at & Thrusts`, `SlashCapable = at & Slashes`, `Versatile = both`. **Role: refiner, never selector.** WeaponType picks family; AttackType disambiguates borderline (slash-only+compact → demote tip-flex→rigid-glint; thrust-capable+thin → keep tip-flex). 166/160/486 fall out of three mask tests — no enum-per-value explosion.

### 4.6 Confidence model (mirror `OntologyEntry.Confidence` `OntologyEntry.cs:48`)

DAT self-label/manual/allowlist = **1.0**; WeaponType exact = 0.90–0.95; boundary ramp = 0.5→1.0 (`Ramp()`, `OntologyService.cs:582-584`); categorical = 0.6–0.8; default rigid = 0.6; multi-weenie conflict = −0.3; degenerate = 0.0. Below `AuditThreshold` (0.6) ⇒ `source=classifier-low`.

### 4.7 Audit/override format
- `vfx_overrides.jsonl` (stage −1, wins outright): `{did, archetype, components, config, reason, by}`.
- `visual_archetype_rules.jsonl` (regenerable rule seed): `{rule, archetype, dids[]|selector}`.
- `audit.csv` (`vfx audit [threshold]`): `did,archetype,confidence,reason,signals,contributingWcids,suggestedOverride`.

### 4.8 Build checklist (S03): reverse index → FeatureVector + conflict detection → per-part/distal extraction (port `buildBboxRig`, extend `OntologyService.ComputeSetupBounds` `:346`) → DAT self-label scan (§14) → surface category → AttackType masks (unit-test 166/160/486) → `Ramp()` → cascade → rule table as data → override+audit I/O → emit descriptors → **round-trip test** (`emit-allowlist trunk-canopy` reproduces `TREE_WIND_DIDS` byte-for-byte) → legacy-safety gate (reject component ids not in §13 registry).

---

## 5. Mechanism dispatch + normal recompute (S04, S05)

### 5.1 MECH-A vs MECH-B decision function (S04)

New pure module `scene3d/mech_dispatch.js`. The core test in one sentence: **Can the visually-correct motion be written as rigid rotation of whole parts about per-part pivots?** Yes + partCount≥2 → A; motion requires bending vertices within one rigid part → only B.

```
routeMechanism(component, geom):   // geom = {partCount, partBoxes[], hingeFrames[], placementCount}
  if component.mech in {'A','B'}: return component.mech                 // author override wins
  acrossParts = partCount>=2 && articulationIsPartStructure(partBoxes, hingeFrames)  // ≥2 separable parts
  withinPart  = component.locus == 'withinPart'
  if withinPart && !acrossParts: return 'B'                            // spear shaft, bow limb
  if acrossParts && !withinPart: mech='A'                              // trunk/canopy, chain links
  else: mech = component.preferMech ?? 'B'                             // ambiguous → cheaper GPU
  // instance-count override (the 512-cap escape):
  if mech=='A' && placementCount > INSTANCE_CAP_REACH(=512) && component.singleAxisApprox:
      return 'B'                                                        // animate ALL placements, preserve instancing
  return mech
```

**Substrate facts:** MECH-A = `animated_scenery.js` shared mixer (one driver per `(setupId, phaseBucket)`, `:389/495`; rAF advance `:580`; copy `:605-609`; cap 512 `:45`; 140 m cull `:46/:62-69`) — cost = CPU + draw calls (de-instanced), bounded by cap. MECH-B = `materials.js _chainBeforeCompile:292` `begin_vertex` displace on a per-DID clone (`getCachedFloorBias:1794` precedent) — cost = GPU vertex ALU, **per-instance ≈ 0**, instancing intact, no cap. Per-instance phase = **instanced attribute / procedural hash**, never a uniform-baked-into-GLSL-string (would fork the program).

**Worked cases:** trunk-canopy → A (articulation IS part structure); spear-tip → B (shaft is one rigid mesh, A can't bend it); bow → **B+A** (limb material patch + string CPU hinge — mechanism is a *component* property, not an *object* property); chain → A if ≥2 link parts, B if one tube mesh (`partCount` is the literal switch). **Fern `0x02001063`** (3-part, 317k placements, on wind allowlist) is the prime **A→B migration** candidate (Phase 2): single-axis height-weighted `begin_vertex` animates all 317k for ~free vs A's 512-nearest cap.

### 5.2 Normal-recompute strategy (S05) — pairs with MECH-B only

**Critical scoping fact:** MECH-A applies a rigid per-part quaternion; a rigid rotation rotates normals via the Group's `normalMatrix` automatically — **MECH-A never needs normal recompute.** Staleness is exclusively a MECH-B problem (three.js computes `vNormal` in `<normal_vertex>` BEFORE `<begin_vertex>`, from undisplaced `objectNormal`).

The only clean seam is to perturb `objectNormal` **after `<beginnormal_vertex>`** so the stock chunks propagate the corrected normal. One shared `hbDisplace(p)` declared once in vertex `<common>`, evaluated for BOTH position (`begin_vertex`) and normal.

| Effect | Strategy | Why |
|---|---|---|
| tip-flex, levitate/jiggle, breath-scale, chain | **SKIP** | <2° normal shift / translation / uniform scale — sub-perceptual; zero added cost |
| bow-limb | **ANALYTIC** | known rotation `θ(axialCoord)`; rotate rest normal by same θ (1 sin/cos pair, exact) |
| cloth/banner ripple | **ANALYTIC** | flat-sheet shading IS the wave slope; `dh/du = A·k·cos(...)` exact, ~3 ALU |
| cloak/cape/robe flutter | **FINITE-DIFFERENCE** | multi-octave noise whose analytic Jacobian is ugly; FD of the same `hbDisplace` at 2 tangent neighbours |

**Rejected as default:** screen-space `dFdx/dFdy` (per-fragment = wrong cost class for fill-bound budget; faceted; blind to displacement). Documented fallback only.

▶ **Strategy selection is a `linkVariant()` bit (folds into `__vfxSetKey`, §2.4)** — `#define HB_NORMAL_ANALYTIC|FINITEDIFF` per-strategy program, never per-instance. Per-instance `uDispPhase`/`uDispAmp` flow through uniforms. Shadow/depth: nothing to patch (depth pass uses stock `MeshDepthMaterial`, computes no lighting normals); if S04 adds a `customDepthMaterial` for position-displace shadow consistency, it carries the displace but NOT `HB_NORMAL_*`.

**A/B (1070-measurable):** `skip→analytic` and `skip→finitediff` frame-Δt delta <5% of idle slice (expect ~0.1 ms); `programs` count grows ≤1 per distinct strategy, **0 per instance**; ship analytic where a closed-form derivative exists.

### 5.3 Build checklist (S04+S05)
1. `scene3d/mech_dispatch.js` — `routeMechanism` + `articulationIsPartStructure` (reuse `wind_rig.partBBox` separability); unit-test 4 worked cases + fern override.
2. `materials.js` — `installVertexDisplacePatch(material,{patchKey,glsl,uniforms})` (generic MECH-B installer, idempotent, registers `linkVariant` bit) + `getCachedDisplaced(surfaceDid, patchKey)` (clone, mirror `getCachedFloorBias:1794`).
3. `materials.js` — `_installVertexNormalRecompute(material, strategy)`: set `userData.hbNormalStrategy` BEFORE `_chainBeforeCompile`; `.replace("#include <beginnormal_vertex>", ...)` per strategy; `skip` = no-op; `#ifndef USE_TANGENT` basis fallback (`materials.js:814` precedent).
4. Per-instance phase attribute/procedural hash in `statics.js`; assert one program across instances.
5. `statics.js:1584-1600` — generalize the two hardcoded peels into one router pass emitting disjoint `frozen`/`mechA`/`mechB` buckets (DAT-anim peel stays FIRST). A bow lands in BOTH mechA and mechB.
6. Cache-key test: `analytic` vs `finitediff` → distinct keys; two `uDispPhase` instances → SAME key.
7. Round-trip: only `trunk-canopy` registered reproduces `TREE_WIND_DIDS` MECH-A byte-identically; `?treeWind=off` untouched.

---

## 6. Read-only state plumbing (S06)

**Headline:** the client already knows draw/cast progress as render-side animation substate; deriving it is a pure read, zero wire traffic.

### 6.1 Where the data already lives
- **Draw/charge** = AC charge-attack hold-at-peak. Local input only: `picking.js:586-587` `setSwingMotion(localGuid, cmd, {holdAtPeak:true})` arms it; `picking.js:298-299` `releaseSwingHold` fires. The hold pauses the mixer at the peak frame (`peakMs = round(dur*500)` = dur×0.5, `entities.js:6312`; `action.paused=true` `:6319`) and records `inst._swingHold = {action, ...}` (`:6326-6332`). `releaseSwingHold` already reads `action.getClip().duration` + `action.time` (`:6007-6009`). So **draw progress = `clamp01(action.time / (clip.duration*0.5))`**, pinned at 1.0 while `action.paused`.
- **Cast** = `playCastSequence` (`entities.js:5751`); `inst._castBusyUntilMs` (`:5789/5795`), `inst._castSequenceToken` (`:5800`). Add ONE client-local start stamp `inst._castStartedMs = nowMs` at `:5795` (read-only thereafter); `castAmount = clamp01((now - start)/(end - start))`.
- **Bow is a child entity** — hop `bow.guid → bow._attachedParentGuid → wielder.inst` (`entities.js:2066-2067`); the accessor does this internally.

### 6.2 The deliverable accessor (`EntityManager`, next to `clearCastBusy` ~`entities.js:5943`)

`getDrawCastState(guid) → {mode:'draw'|'cast', amount, holding} | null` — pure reads, lazy (zero cost when no component attached), mirrors the `inst._motionSpeed` read-only-scalar precedent (`entities.js:6648`). `getDrawAmount(guid)` = scalar-only convenience.

### 6.3 Consumption (read → write own uniform only)
In the bow-limb component's per-frame uniform update (same cadence as `uTime` push, after `entityManager.tick(dt)` `loop.js:1818`): `const s = em.getDrawCastState(bowGuid); mat.uniforms.uDrawAmount.value += (target - cur) * 0.25` (relax-ease). `uDrawAmount` is read at `begin_vertex` (MECH-B); its *value* varies per-instance without changing the program → cache key stable.

### 6.4 Legacy-safety & build
Reads only `action.time`/`clip.duration`/`action.paused`/`_swingHold`/`_cast*`/`performance.now`/`_attachedParentGuid` — all static/derived or client clock; writes nothing (pure getter). Desync impossible — `setPose.copy()` stomp (`entities.js:2161`) sits upstream of any uniform. **Build:** add `_castStartedMs` stamp + teardown zeroing; add accessor; (P2) remote-archer fallback via `currentActionKey.startsWith("swing:")`; legacy-safety assertion test (`{reads:[...], writes:[]}`); diag hook for `vfx gauge`.

---

## 7. Material-oscillator layer (S07)

**New module:** `scene3d/material_oscillators.js`. The single, persistent, **once-per-frame** source of time-varying scalars (pulse/glint/shimmer/flicker/decay). It IS the implementation of §2.5's `VFX_GLOBALS`.

### 7.1 Two binding modes (both fed by one registry)
- **Mode 1 (JS-broadcast):** waveform evaluated in JS once/frame; all bound materials SHARE one `{value}` object (unison is the feature). 1 shared float per channel, written 1×/frame. Use: global wetness/frost ramp, world-breathe magic-glow.
- **Mode 2 (in-shader):** waveform in GLSL per-fragment; per-object variation from a **compile-time-static** `uOscPhase = hash01(guid)`. Consumes only the shared `uTime` channel + the static phase → **zero new ticked uniform**. Use: per-object glint sweep, enchant shimmer, gem flicker.

Both draw from the same waveform vocabulary (`type ∈ {sine,triangle,saw,pulse,noise,decay,time}`) — JS `evalWave` for Mode 1, exported `OSC_GLSL` strings for Mode 2, kept bit-consistent. `valueNoise1` is a hashed-lattice + smoothstep noise (NO `Math.random`).

### 7.2 Registry (`MaterialOscillatorRegistry`, module singleton `oscillators`)
`channel(name, cfg)` (idempotent, refcounted, returns the shared `{value}` uniform) · `release(name)` · `trigger(name, t)` (arm a `decay` channel) · `tick(tSec)` (O(channels), zero alloc, early-return on empty registry) · `reset()`. The canonical `'uTime'` channel is #0.

**Budget:** 1 broadcast `uTime` + ≤12 named Mode-1 channels (soft cap, gauged); 0 new ticked uniforms for Mode 2. `gl_MaxFragmentUniformVectors` (≥1024 on 1070) never a constraint. Tick cost ≤13 evals/frame, independent of material & instance count. Escape hatch if >16 channels: collapse into a shared `uniform vec4 uOscBank[N]` (documented, not day-one).

### 7.3 Integration & adjudication
▶ **One VFX tick (§2.5):** add `tickMaterialOscillators(scene3d)` reading `scene3d.frameTime.tsSec` (fallback per `loop.js:821-825`), wrapped try/catch + one-shot warn (shape of `loop.js:1604-1612`), called at **`loop.js:1812`** right after `tickAnimatedSurfaces`. This is THE VFX tick; S01's `tickVfxGlobals` folds into it (it also updates `VFX_GLOBALS.uWetness/uFrost` and runs `c.tick?.()` for any registered component oscillators). The terrain `uTime` per-material loop (`loop.js:826`) stays as-is (separate pre-existing registry, out of scope).

▶ **Cache-key:** the set of channels a material reads is one `linkVariant()` bit folded into `__vfxSetKey` (§2.4) — channel *values* never enter the key. **Build:** create the module; implement registry; wire the tick; teardown `oscillators.reset()` near `MaterialCache.dispose` (`materials.js:3331`); `bindOscillator(shader, glslName, channelName, cfg)` helper in `materials.js` (guards `OSC_GLSL` single-inject via `userData.__oscGlsl`); per-object `uOscPhase = hash01(guid)`; diag; tests (determinism, shared-object identity, empty-registry no-op, decay/trigger, release/reset, cache-key invariance).

---

## 8. Weathering compose-order + per-instance age (S08)

**Owns:** compose-order + correctness + per-instance-age + depth-exclusion for tarnish/fade/dust/rust/wetness/frost/moss/splatter.

### 8.1 Why "after `<map_fragment>`" is the ONLY correct seam
Palette/SubPalette shift is baked into RGBA8 at ingest (`lib.rs` `to_rgba8`, the `fetch_surface_pixels_impl` decode), so the dyed albedo only exists in `diffuseColor.rgb` **after `#include <map_fragment>`** (the same seam the shipped detail patch uses, `materials.js:427-436`). Weathering MUST: modify resolved `diffuseColor.rgb`; never read the `map` sampler or inject before `<map_fragment>`; **never add a flat-white emissive** (the original wash-to-white root, `materials.js:2293-2300`).

**The dyed-luminous trap, and immunity:** on a luminous surface `applyFloatLumDiffuse` (`materials.js:1238-1248`) attaches diffuse as `emissiveMap`. Weathering modifies *reflectance* (`diffuseColor`), not the shared sampler, and does NOT write `totalEmissiveRadiance` by default — so a tarnished lifestone dulls but keeps its coloured glow.

### 8.2 Chunk-by-chunk compose order (r184 MeshStandard frag)

| three.js chunk | Weathering action after it |
|---|---|
| `<map_fragment>` | albedo: tarnish tint·darken, fade desaturate, dust/moss/splatter on `diffuseColor.rgb` |
| `<roughnessmap_fragment>` | `roughnessFactor += tarnish/dust − wetness` |
| `<metalnessmap_fragment>` | `metalnessFactor −= rust` |
| `<emissivemap_fragment>` | **SKIP by default**; only `uFadeEmissive>0` dims `totalEmissiveRadiance` |

`opacity`/`diffuseColor.a` is **never written**. Install weathering **last** among after-map patches (sees the detail-composited albedo). Author tint uniforms in **linear** space (`<map_fragment>` outputs linear).

### 8.3 Per-instance AGE — procedural in-shader (the adjudicated default)

▶ **ADJUDICATION (S01 `aVfxHash` attribute vs S08 procedural).** **Default = procedural in-shader** `hash01(surfaceDid ^ instanceIndex)`: `uAgeSeedU = hash01u(surfaceDid)` uniform (set once at mint) XOR `gl_InstanceID` (InstancedMesh) / `getIndirectIndex(gl_DrawID)` (BatchedMesh) / `0` (singleton), mixed in GLSL. **Zero CPU, zero attribute, zero touch to the InstancedMesh build loop.** Only downside (slot reshuffle on LRU re-bake changes a barrel's tarnish *phase*) is visually invisible for weathering. Use the explicit `InstancedBufferAttribute aVfxHash` (S01) **only** when placement-stable per-instance values are required (a named landmark that must always read "heavily weathered"). Both walled out of the cache key.

### 8.4 Shadow/depth exclusion (hard rule)
The weathered clone leaves `customDepthMaterial` **unset** → fragment patch auto-excluded from the shadow pass (three renders casters with stock `MeshDepthMaterial`). Weathering never changes alpha/alphaTest, so clipmap-foliage shadow cutouts stay correct. `materialCanCastShadow` (`materials.js:123`) gates on `surfaceTypeFlags`, which weathering doesn't touch. **Contrast:** MECH-B vertex displacement (§5) *does* need depth patched — weathering is the opposite case.

### 8.5 Cache-key & build
≤2 set-level `linkVariant` bits (uniform-weathering present; textured-weathering present — adds `uBlotchMap` sampler), folded into `__vfxSetKey`. **Build:** `WEATHERING_UNIFORM_DEFAULTS` + `hash01u`; `_installWeatheringShaderPatch`; `getCachedWeathered(surfaceDid, effectSetKey, cfg)` (mirror `getCachedFloorBias:1794`, **never set `customDepthMaterial`**, skip blended/additive/fallback/animated/wireframe → base); swap at `statics.js:1223`/`:1467`; `?tarnish ?rust ?wetness ?frost ?dust ?clothFade ?moss` flags default-OFF; tests assert block-after-`<map_fragment>`, key bits, no emissive/opacity write, `customDepthMaterial` undefined, base byte-identical.

---

## 9. Particle / aura system (S09)

**Thesis:** the emitter runtime is already shipped (`ParticleManager`/`ParticleEmitter`/`Particle`). A synthesized emitter is just a POJO fed to `ParticleManager.addEmitter()` + a synthetic billboard gfxobj. Reuse RP6 cull, per-emitter cap, owner-registry teardown.

### 9.1 `SynthEmitterInfo` POJO schema
`ParticleEmitterInfo`'s constructor accepts a plain POJO (`particle_emitter_info.js:50-54`, confirmed: "tests use the POJO form"), reading every field with `?? default`. So **no wasm round-trip** — hand `addEmitter` an `emitterInfo` POJO; the manager does `new ParticleEmitterInfo(pojo)` (`particle_manager.js:529-531`). Field names mirror AC `0x32` ParticleEmitterInfo exactly (`crates/holtburger-dat/.../particle_emitter.rs`).

Key fields: `emitterType`(1=BirthratePerSec), `particleType`(1 Still/2 LocalVelocity/3 ParabolicLVGA/5 Swarm/12 GlobalVelocity), `hwGfxObjId`(MUST be non-zero — synthetic namespace §9.2), `birthrate`, `maxParticles`(clamped by quality preset), `totalParticles:0 + totalSeconds:0` ⇒ **persistent**, `lifespan(+Rand)`, offset disc, velocity basis A/B/C, scale/trans ramps (`trans` is translucency: opacity=1−trans), `isParentLocal:true` (re-anchor to part frame each tick). `sortingSphere.radius` is derived (`= max(maxOffset, maxA·lifespan)`); keep `maxA·lifespan` small for tight culling.

**Preset table** (`makeSynth(kind,cfg)`): embers(spark/additive, bowl), smoke(alpha, bowl+Z), dustMotes(soft-dot, centroid, indoor-only), pollen/fireflies(soft-dot/swarm, canopy, firefly=dusk), leaves(leaf/parabolic, canopy, season≠winter), splash/mist(droplet, audit-anchor), gemSparkle(spark, centroid), breathFog(smoke, head, cold-region), orbitMotes(soft-dot/swarm, centroid, has-spell), drip(droplet/parabolic, contact, wet/cave). `anchorKind`/`gate` carried as non-`0x32` sidecar fields the manager ignores.

### 9.2 Synthetic billboard gfxobjs (`scene3d/particles/synthetic_gfxobjs.js`)
Reserve id namespace **`0x7E000000–0x7E0000FF`** (never a real DAT key). `SYNTH_GFX = {SOFT_DOT, SPARK, SMOKE, DROPLET, LEAF}`. ONE shared `PlaneGeometry(1,1)` + 5 procedural canvas textures (generated once, `__cacheOwned`, survive teardown). Additive for SPARK/SOFT_DOT(firefly), alpha for SMOKE/DROPLET/LEAF; set `userData.surfaceTypeFlags = 0x10000` (Additive) for the manager's branch (`particle_manager.js:553-564`). **Factory patch** (the only wiring): prepend `isSyntheticGfxObj` branches to `geometryFactory`/`materialFactory` (`statics.js:3057-3073` + entity twin `entities.js:~5584`). The manager's per-slot clone + dispose path handles synthetic clones for free.

### 9.3 Auto part-anchor selector
Add `selectAnchorParts(partBoxes, hingeFrames)` to `wind_rig.js` reusing `_modelBox` (`:78`), `swayAmp`'s trunk test (`:98-105`), `partBBox` (`:59`). Returns `{canopy,head,bowl,contact,tip,centroid}` part indices into SetupModel order (`= partFrames`). `-1` = ROOT (always safe). **Two paths:** offline (C# port bakes `anchorPartIndex` into the descriptor — preferred) / runtime fallback (`selectAnchorParts` when per-part boxes are in hand). Anchor follows wind sway because `partFrames[partIndex]` reads the live mixer pose.

### 9.4 Visibility gates (`scene3d/particles/aura_gates.js`)
Pure read-only predicates over derived client state: weather wet/cold (`weather_state.js:225/229/247`, `daygroup_weather.js:179`), dusk/night (`ac_moons.js:361-372` sun altitude), indoor (`anchor.userData.isCellStaticScriptAnchor` `statics.js:3418`). `tickAuraGates()` ticked every ~30 frames; gate-close sets `emitter.stopped = true` (emission halts, live particles drain, emitter retained), reopen clears — fully reversible.

### 9.5 Lifecycle: caps + eviction
**Reused:** per-emitter `maxParticlesPerEmitter` (64/256/1024/2048 by quality, `particle_emitter.js:179-196`); RP6 frustum + 220 m cull (`particle_manager.js:117-131`). **New:** global resident-aura FIFO cap `{low:24,mid:64,high:160,ultra:320}` (pattern from `play_effect_vfx.js:593/624-635`), log drops (no silent truncation). **Per-landblock eviction:** owner key `vfxaura:lb:${lbKey}`; hook `LandblockLRU.onEvictLandblock` (`landblock_lru.js:67`) → `destroyAllForOwner`.

### 9.6 Legacy-safety & build
Reads DAT geometry + anchor pose (read-only) + derived weather/time + seeded clock (Math.random-free). Writes render-only meshes + cloned `MeshBasicMaterial` uniforms + `emitter.stopped`. Particles add **zero lights**, share one material per gfxobj-kind (no per-instance key). DAT-hook coexistence (§14): attach only when `defaultScriptId === 0`. Cost class cheap–medium (additive **overdraw/fill**, not draw calls; "measure fill, not particle count"). **Build:** synthetic gfxobjs → factory patch → `selectAnchorParts` → `aura_presets.js` → `aura_attach.js` (skip-if-DAT-scripted, FIFO cap, owner-registry) → `aura_gates.js` → wire `tickAuraGates` at `loop.js:1849-1878` → per-LB teardown → `?particleAuras`/`?particleBillboard`/per-effect flags → tests → `vfx gauge`.

---

## 10. Bloom + light budget (S10)

### 10.1 Bloom: keep GLOBAL threshold, reject selective
The shipped pipeline already has the right primitive: a full-screen pmndrs `BloomEffect` (`atmosphere_pipeline.js:292-300`, `luminanceThreshold:0.85`, `mipmapBlur`) in HDR before AGX tonemap, quality-gated (OFF low, ON medium+). **Decision: global, threshold-driven.** Selective bloom adds a second geometry pass scaling with bloomer count — the exact CPU/drawcall cost §1.3 says to avoid. With global bloom, **membership is decided in the fragment shader**: a surface blooms iff its HDR radiance exceeds 0.85 after the emissive add. Free, already wired, no pass code change.

### 10.2 The emissive-budget contract (the lever every emissive component pulls)
Reuse `applyFloatLumDiffuse` (`materials.js:1238-1247`), which clamps `emissiveIntensity = min(2.0, sfLuminosity)` (`:1246`) — the **2.0 ceiling is the bloom governor**. Three tiers (every emissive component declares `bloomTier`):

| Tier | target intensity | Blooms? | Use |
|---|---|---|---|
| **sub-bloom** | ≤0.6 | no | enchant-shimmer, value-sheen, holy/corrupt-tint, glint base |
| **soft-bloom** | ~0.85–1.3 | mild | magic-glow, school-aura, glowing-eyes |
| **hard-bloom** | ~1.5–2.0 | strong | glowing-runes, gem-inner-fire, lava, torch core |

Components animate intensity within their tier band (via §7 oscillator). **Bloom-pass cost is constant, object-count-independent** (~0.5 ms @1440p, already paid). What scales is additive-particle overdraw (governed by §9 caps) and *visual wash* — `vfx gauge` FAILs if hard-bloom emissive screen-coverage >~5% at the reference camera. The classifier must not assign hard-bloom to a high-placement DID.

### 10.3 Light-budget invariant (the four binding rules)
The freeze: three bakes the *count* of visible point/spot/dir lights into every lit material's program key; a count change relinks all lit materials. The fixed-count pool (`lighting.js:584-660`, N=8 point + M=2 spot, always visible, never `castShadow`; `MAX_ACTIVE_LIGHTS=32` `lighting.js:397`) is the shipped fix; real source lights stay `.visible=false` carriers (`lighting.js:1769`), nearest copied into pool slots each frame, unused driven to `intensity=0` (`feedSelectedIntoPool:699-739`). Rules: **(1)** never change visible light count — modulate `.intensity`/`.color` only, drive dark with `intensity=0` not `.visible`; **(2)** never toggle `castShadow`; **(3)** never per-instance `customProgramCacheKey`; **(4)** emissive spends the FRAGMENT budget — a glowing rune is `emissive`+bloom, NOT a new `PointLight` (never consume a pool slot to glow).

### 10.4 Flame-flicker (archetype #24) — intensity-only, zero relink
Net-new (retail had static lights). A dedicated flame channel jitters torch/brazier source **intensity**. It rides the existing pool feed (`feedSelectedIntoPool` already copies `src.intensity → dst.intensity` every frame, `:713`) so zero feed change, zero relink. Per source light at attach: `light.userData.__flame = {base: safeIntensity, phase: hash01(stableKey), amp:0.18, floor:0.55, ceil:1.25}`; registry `scene3d.flameLights`. **`flameFactor(tSec,f)`** = sum of 3 incommensurate sines (golden-ratio freqs → long beat), normalized, clamped to `[floor,ceil]`; `floor=0.55` guarantees the light never reaches 0 (never any temptation to toggle). `tickFlameFlicker(scene3d)` runs once/frame in `tickLightingForCellState` **immediately before** `capActiveLightsByDistance` (`lighting.js:984`), writing `L.intensity = f.base * flameFactor(...)` — INTENSITY ONLY. Detection: descriptor → `FLAME_FLICKER_DIDS` allowlist seed (`tree_wind.js:64` pattern) → `?flameFlickerAuto` warm-color heuristic (audit-only).

### 10.5 Gauge & build
`vfx gauge` (§11) PASS iff `renderer.info.programs.length` is **identical** across `?flameFlicker=off`/`on` over 600 frames (proves intensity-only → zero relink); bloom pass time invariant as emissive count grows; hard-bloom coverage ≤5%. **Build:** flag+allowlist seed → flame detection+flag at attach (`lighting.js:1770`) → eviction splice → `tickFlameFlicker` at `:984` → emissive `bloomTier` contract (schema only) → hand §13 the forbidden-write list → gauge no-relink assertion → exit bar `?flameFlicker=off` byte-identical.

---

## 11. GPU cost model + vfx gauge (S11)

### 11.1 What's measurable (the substrate)
Reused verbatim: `window.__diag.render` (`index.js:269-307`, `?renderDiag=on` → calls/triangles/programs/geometries/textures/nodes); `window.__diag.renderer` (`landblock_lru.js:460-490`, peakPrograms trend); `harness/perf-walk.mjs` (FPS, frame-ms p50/p95/p99, spikes, per-field min/max). **Two hard caveats:** no GPU timer in-tree (`renderer.render` is async-submit → frame-ms ≈ `max(T_cpu, T_gpu)`); this box renders **SwiftShader** (`perf-walk.mjs:13-16`) so absolute FPS/GPU are not representative of the 1070. ⟹ the gauge splits into a **Structural Meter** (hardware-independent, CI) and a **Timing Meter** (1070-only).

### 11.2 Cost axes & the scaling invariant
Five renderer-observable axes: draw-calls (`render.calls`), program links (`programs.length` — the #1 cold-load cost), ALU (est.), texFetch/VRAM (`memory.textures`), fill/overdraw (est. from particle counts). **THE SCALING INVARIANT (the gauge's rule):** cost scales with **unique drivers** `(model × surface × patch-set)` and `(setupId × phaseBucket)` — **NOT placement count**. Holtburg = 222 placements but **66 unique models** (`statics.js:37-44`) + 4 phase buckets. Any effect whose Δprograms or Δcalls grows with *placements* is a hard FAIL.

### 11.3 Per-archetype cost table (cost_model.jsonl — one source of truth)
The full table is the §3.2 archetypes scored on the five axes. Reading: **the entire cheap column is ~free at steady state** (ΔCalls=0, ΔPrograms bounded by ~66 unique models, ΔVRAM=0). Medium = +1 texture and/or +1 program *per material* (placement-independent). Only **particles** add draw-calls + fill; only **POM/heat-haze** add `+++` ALU (both hard-gated). `flame-flicker` = light intensity only, ΔPrograms=0. `magic-glow`/`flow-scroll` = 0 new programs (reuse `applyFloatLumDiffuse`/`map.offset`).

### 11.4 The ceiling formula
```
GPU_budget_per_frame = 0.75·T_frame − T_gpu_baseline      (25% margin for variance + next-gen headroom)
Σ ΔT_gpu(all enabled effects) ≤ GPU_budget_per_frame
PASS iff GPU_util_with_all_effects ≤ 0.75 at full-Dereth visible counts.
```
Worked 1070 target: `T_frame≈50 ms`, baseline `T_gpu≈25 ms` ⇒ ceiling 37.5 ms ⇒ **~12.5 ms/frame budget** for the entire suite at full Dereth (calibrate from real numbers in checklist step 11). Full-Dereth projection scales only per-visible-instance axes by the existing caps (animScenery≤512, particle 220 m cull + per-emitter cap); per-driver axes don't scale with Dereth.

### 11.5 Concurrency caps (reuse existing machinery)
cheap → cap on unique-driver count (`Δprograms ≤ K`); medium → cap concurrent visible instances (animScenery 512/140 m, particle 220 m + per-emitter cap); expensive → hard-gate behind `quality.preset∈{high,ultra}` + on-screen/distance. **Runtime governor `?visualBudget=80`:** rolling `GPU_util` estimate; shed effects expensive→medium→cheap (lower `animSceneryRadius`, drop emitter caps, disable POM).

### 11.6 The gauge protocol (two reconciled halves)
**Half A — C# static estimator (`CommandEngine.Vfx.cs`, offline, FAILs fast):** enumerate Holtburg DIDs (`dist/manifest.json` + statics/scenery jsonl + `0xA9B40000.json` oracle) → classify → sum cost-table rows weighted by Holtburg visible counts → emit `{drawcalls, programsDelta, vramMB, particleEmitters, vsCaps, headroomPct, verdict}` → **FAIL before any GPU work** (CI pre-flight).
**Half B — browser A/B (`harness/vfx-gauge.mjs`, fork of perf-walk):** fixed deterministic camera pose, `?atmosphere=off` (so `__diag.render.calls` counts the whole scene, not the post pass — caveat `index.js:266-267`), 60-frame settle + 300-frame record, baseline OFF vs treatment ON, delta per axis, project to full-Dereth.

**Gates** — **Structural (SwiftShader+CI):** G1 `Δprograms = O(unique drivers)` ≤ Kₚ [hard FAIL — link-explosion guard]; G2 ΔCalls=0 per non-particle effect; G3 ΔVRAM ≤ budget, no per-instance texture growth; G4 peakPrograms flat across a pan (no per-instance relink). **Timing (1070 only, N/A on SwiftShader):** G5 projected `GPU_util ≤ 0.75` [hard FAIL — ceiling]; G6 frame-ms p95 regression ≤10%; G7 spikes>100 ms delta = 0. SwiftShader verdict is `STRUCTURAL-PASS`, never `PASS`.

### 11.7 Gauge instrumentation (only new runtime code, behind `?vfxGauge=on`)
Wrap the render tick (`index.js:1779 tickPerFrame` → `:2012/2017 renderer.render` → `:2022 recordRenderDiag`) with a `T_cpu` `performance.now()` pair; `T_gpu` via **(1)** `EXT_disjoint_timer_query_webgl2` if present, **(2)** `gl.finish()` fence (perturbs, gauge-only), **(3)** else N/A. Zero cost when unarmed.

### 11.8 Build checklist (S11): arm `?vfxGauge` → instrument tick → GPU-time source → `harness/vfx-gauge.mjs` (fork perf-walk, fixed pose, A/B) → delta+gates → `cost_model.jsonl` → C# Half-A → `--measured` reconcile → register command → `?visualBudget` governor → **calibrate on a real 1070** (lock the 12.5 ms constant) → CI wire-up (SwiftShader structural gate on any branch registering a new effect).

---

## 12. WorldBuilder.Terminal surface + artifacts (S12)

### 12.1 Where it lives
New partial `WorldBuilder.Terminal/CommandEngine.Vfx.cs` (sibling of `CommandEngine.SurfaceMaterials.cs`) + `CommandResults.Vfx.cs`. Two-tier pattern (`CommandEngine.cs:26-28`): handler parses tokens → calls `_engine.Vfx*(...)` → returns a structured record serialized by the caller. Register in both dispatchers: REPL `["vfx"]=HandleVfx` (`TerminalRepl.cs:165`, switch like `HandleSurfaceMaterials:2909`); JSON `["vfx-classify"]...["vfx-export"]` (`JsonCommandProcessor.cs:305`, handlers like `CmdEmitRenderGallery:1047-1086`, `Serialize` `:4855`).

### 12.2 Command surface (9 verbs)

| Verb | Returns |
|---|---|
| `vfx classify <DID\|landblock>` | `{did, archetype, components, confidence, source, signals[]}` — dumps the feature vector |
| `vfx sample <n> --area holtburg --seed <s>` | jsonl of sampled DIDs + props + model-type (deterministic) |
| `vfx anchor-parts <SetupDID>` | candidate canopy/head/tip/bowl/contact/grip part indices (C# port of `buildBboxRig`) |
| `vfx preview <DID> [--archetype <a>]` | PNG path (reuse `RenderGalleryCurator.cs`) |
| `vfx gauge --ref holtburg [--quality high] [--measured]` | budget report; **`success=false`/`withinBudget=false` when over ceiling** (the gate) |
| `vfx assign <DID> <archetype>` | writes `source=manual, confidence=1.0` |
| `vfx audit [<archetype>\|<threshold>]` | `audit.csv` of low-confidence + overrides + DAT-self-animated outliers |
| `vfx emit-allowlist <archetype>` | regenerates the DID Set seed; returns `RoundTripMatchesSeed` |
| `vfx export [--slim]` | serializes `visual_descriptors.jsonl` + `visual_archetype_rules.jsonl` (`--slim` strips `signals`) |

### 12.3 Storage & auto-load
Sibling `visual_descriptors.jsonl` keyed by DID (NOT inline in `OntologyEntry`) — keeps the visual layer independently regenerable, mirrors the `.scenery.materials.json` sidecar. Auto-load on `Load` via `AutoRestoreVisualDescriptors`/`AutoRestoreVisualRules` (copy `AutoRestoreOntology` `CommandEngine.cs:144-160`); absent file → empty index, no error.

### 12.4 Baked-manifest fetch — ONE packed catalog (adjudication)
▶ **ADJUDICATION (design §6.3's per-DID `{vfxBase}{did_hex}.vfx.jsonl` vs one catalog).** **One packed `vfx_descriptors.jsonl` fetched once at scene-init, JS-side (no WASM rebuild).** Per-DID HTTP is wrong: the descriptor is looked up by `model_id` at *every* placement → thousands of round-trips; the catalog is ~2,763 DIDs × ~200 B ≈ 0.5 MB, one gzipped fetch. (Scenery is per-LB through WASM only because it's bulky SoA binary; the vfx catalog is small plain JSON JS consumes directly.) New `scene3d/vfx_catalog.js` (`initVfxCatalogUrl`/`loadVfxCatalog`/`vfxDescriptorFor`/`visualEnabled`, mirroring `tree_wind.js:15-56` memoization + `init_scenery_base_url` `lib.rs:2131`). **Consumption:** generalize the `statics.js:1594-1600` tree-wind divert into a descriptor-by-mech router (mech:"A" → shared-mixer player; mech:"B"/frag → `getCachedVariant`). `?treeWind=on` stays a catalog-less back-compat alias. Absent/corrupt catalog ⇒ byte-identical frozen path. `?visual` default-OFF.

### 12.5 Build checklist (S12): shared model → return records → engine partial (9 `Vfx*` methods) → state fields + auto-load → REPL wiring → JSON wiring → Phase-0 round-trip test → client loader (`vfx_catalog.js`, init next to `init_scenery_base_url` at `index.html:1145`/`bake_worker.js:38`) → client consumption (descriptor-by-mech router) → bake hook (drop catalog at `dist/vfx/vfx_descriptors.jsonl`) → verify bare-default byte-identical.

---

## 13. Legacy-safety lint (S13)

Turns THE RULE into a mechanical CI gate. Three layers, all run as Node `.test.cjs` children under `harness/run-js-headless.mjs:72-98` (already `process.exit(1)`s on child failure).

### 13.1 Formalization
A component `C` is legacy-safe iff `reads(C) ⊆ ALLOWED_READS ∧ reads ∩ FORBIDDEN_READS = ∅ ∧ writes(C) ⊆ ALLOWED_WRITES ∧ writes ∩ FORBIDDEN_WRITES = ∅ ∧ tick(C) pure(static, clock)`.

**`ALLOWED_READS`:** `dat.geometry`(`wind_rig.js:59`), `dat.setupModel`(`:113`), `dat.surface`(`materials.js:138`), `weenie.props`(offline classifier), `pose.authoritative`(read-only `inst.root.position/quaternion`), `hash.instance`(`wind_rig.js:199`), `clock.frame`(`scene3d.frameTime.tsSec`), `client.substate`(draw/cast, §6).
**`ALLOWED_WRITES`:** `render.partTransform`(`animated_scenery.js:607-609`), `render.rootTransform.stomped`(only via omega-accum re-apply `entities.js:2178`), `material.clonedUniform`(`loop.js:828`), `material.cacheKey.perSet`(`materials.js:262`), `light.intensity`.
**`FORBIDDEN_READS`:** any server-replicated/mutable field beyond the pose snapshot; `Math.random()`/argless `Date.now()` in tick; reading another entity's replicated state.
**`FORBIDDEN_WRITES`:** wire/C2S (`wasmExports.enqueue*/send*`), physics/collision (`wasmExports.*Collision*`, `setPosition/moveTo/teleport`), the replicated wire pose, **light COUNT** (`.visible` toggle / light-array mutation), **per-instance `customProgramCacheKey`**.

### 13.2 Manifest (every component exports a frozen `manifest`)
`{id, mech, channel, reads[], writes[], deterministic:true, lightCountDelta:0, cacheKeyScope:"set"|"none"}`. The shipped `procMotion.windBend` manifest is the round-trip seed (reads geometry/setupModel/hash/clock, writes partTransform, cacheKeyScope none). Echoed into `visual_archetype_rules.jsonl` by `vfx export` so C# and JS share one capability source.

### 13.3 Three layers
- **A — manifest conformance:** the seven set/scalar assertions; a token outside the closed vocabulary fails (catches smuggled capabilities).
- **B — static source lint:** denylist regex scan over each component source (`FORBIDDEN_SOURCE`: wasm enqueue/collision, `setPosition/moveTo/teleport`, `Math.random`, `Date.now`, `.visible=` on lights, light-array mutation, `customProgramCacheKey` interpolating `guid/instanceHash`), skipping `// vfx-lint-allow: <reason>` lines (logged, no silent suppression). Plus **write-declaration cross-check:** any assignment to `*.uniforms.*.value` / `*.parts[*].position` / `*.root.quaternion` must declare the matching write cap (prevents a lying manifest).
- **C — desync-proof regression:** re-implement the `setPose` contract (mirror `entities.js:2159-2180`) and assert the `copy()` stomp + omega re-apply, locking the architectural guarantee against future edits.
- **(Optional D)** dev-time `Proxy` runtime guard behind `?vfxLintRuntime=on`.

### 13.4 Build checklist (S13): `scene3d/vfx/lint_caps.js` (the 4 frozen Sets + `FORBIDDEN_SOURCE`) → require `export const manifest` per component (author windBend's) → Layer A/B/C in `tests/vfx_legacy_safety_lint.test.cjs` → register in `run-js-headless.mjs` TIER1 → verify windBend passes all three → **negative tests** (3 deliberately-violating fixtures: forbidden read, forbidden write, `cacheKeyScope:"instance"`) assert the gate fails → wire into `vfx export`.

---

## 14. DAT-hook coexistence (S14)

**One-line:** a SetupModel whose `default_animation` already keyframes parts or fires `SetOmega`(22)/`TextureVelocity`(23/24)/`CallPES`(19)/`CreateParticle`(13/26)/`Luminous`(8/9)/`Scale`(12) is **DAT-self-animated**; the suite must never add a component driving a channel the DAT already owns.

### 14.1 The channel model + the rule
A "channel" is a render output exactly one driver may own per object: `transform` (≥2 keyframe frames with non-identity per-part delta), `omega` (SetOmega), `uvScroll` (TextureVelocity), `particle` (CreateParticle/CallPES), `emissive` (Luminous), `diffuseRamp` (Diffuse/Transparent), `scale` (Scale). **THE RULE (binding):** for each candidate component `c` on DID `d`, let `owned = datSelfAnim(d).channels`; if `channel(c) ∈ owned` → **suppress** `c` (record `suppressedBy:"dat"`, defer ≠ delete — `vfx audit` surfaces it); else → **compose** normally. A windmill that DAT-spins gets no `display-spin` but CAN take `weathering.rust` + `emissive.glint` (different channels). `hash01`/clock-only material channels the DAT never touches (most tarnish/rust/wetness, view-sweep glint) are **always free**.

**The gap that makes this necessary:** `buildSceneryAnimationClip` (`animated_scenery.js:127-158`) builds only `part{p}.position/quaternion` tracks — **it never reads `hooks`**. So a scenery `default_animation` that is *purely* a `SetOmega`/`TextureVelocity` hook renders frozen today, and is exactly where the suite would be tempted to add a component. Recording owned channels now makes both safe (suite defers; a future scenery-omega player drives from the DAT's declared axis without the suite fighting it). Contrast the entity path which DOES consume hooks (`entities.js:_tickHookOmega:12374-12378` already SUMS hook-omega + cycle-omega — "one channel, one driver" precedent).

### 14.2 Detection (offline C#, `DatHookScan(setupDid)`)
Reuse `MotionParity.cs:566-577` (PartFrames→Hooks walk) + `ObjectSpriteGenerator.cs:943-944` (`Setup.DefaultAnimation.DataId`). Resolve `default_animation` (0x03…) → `Animation.PartFrames[].Hooks` → collect `AnimationHookType` ints (`dats.xml:253-258`) → `ChannelsFor(hooks, hasKeyframe)`. `HasNonIdentityPerPartMotion` = `PartFrames.Count≥2` AND some part origin/orientation delta > epsilon (single-frame hook-only "animations" report `hasKeyframeMotion=false` so they don't falsely claim `transform`). Returns `DatSelfAnim {animDid, hooks[], channels[], hasKeyframeMotion}`.

### 14.3 Classifier + runtime integration
`DatHookScan` runs **FIRST** in classify (stage 0, §4.3): non-empty channels → `source="dat-self-label"`, `confidence=1.0`, self-label archetype; in BOTH branches, suppress candidate components whose channel ∈ owned. Write `datSelfAnim` into the descriptor. **Runtime (belt-and-suspenders):** the suite attach hook runs on the frozen-and-not-DAT-animated residual (after both `statics.js:1584-1600` peels); skip components flagged `suppressedBy:"dat"`; hard assert (links to §13) throws if `component.channel ∈ descriptor.datSelfAnim.channels`.

### 14.4 Edge cases & build
`CallPES`(19) conservatively owns both `particle` and (if PES unscanned) `transform`+`omega`. `TextureVelocityPart`(24) Phase-0 treats as whole-object `uvScroll`-owned (Phase-5 part-scoped). A tree DID also carrying `defaultAnimationId!=0` is peeled by the anim peel first (`statics.js:1585`) — already correct. DAT read failure ⇒ empty channels ⇒ heuristic path (safe; worst case caught by the runtime whole-object guard). **Net GPU saving** (suppresses redundant drivers). **Build:** `DatSelfAnim` + `DatHookScan` → `ChannelsFor` → `HasNonIdentityPerPartMotion` → classifier wiring → descriptor schema → `vfx audit dat-self-animated` filter → JS attach guard → hard assert → C# unit tests (windmill→transform, pure-SetOmega→["omega"], lava→["uvScroll"], brazier→["particle"]) → JS tests (suppress spin, keep rust) → round-trip proof.

---

## 15. LOD/cull unification (S15)

### 15.1 The problem
Four independent spatial-gating systems re-resolve the camera, re-derive distance, make their own binary keep/drop: **FCULL** (`culling.js`, AC-space frustum, default ∞), **animScenery motion cull** (`animated_scenery.js:46/587-602`, 140 m, mixed AC/world frame bug at `:602`), **particle RP6** (`particle_manager.js:117-131`, 220 m world-space, every 6 ticks), **LandblockLRU** (LB-Chebyshev resident set). Three different camera reads, two redundant frustum builds/frame, three thresholds, all binary (no near/mid/far tier).

### 15.2 The fix — extend `FrustumCuller` (the single per-frame camera/frustum owner)
Add LOD bands to `culling.js`'s `FrustumCuller` (already one-per-scene `:217`, AC-correct, allocation-free, fail-open, `.update()`d once/frame `loop.js:1587`). New flags `?lodNear=120 ?lodMid=220 ?lodHyst=8 ?lodFrustumGate ?visualLod`; exports `LOD_NEAR/LOD_MID/LOD_FAR`. New methods `getDistanceSqWorld`, `lodForSphereAc(sphere, prevTier)`, `lodForSphereWorld(wx,wy,wz,r,prevTier)` (transforms world→AC once via `_invWorldRoot`, reusing the SAME AC frustum — kills RP6's separate world frustum), `_bandFromDistSq` (radius-padded bands + hysteresis to kill edge flicker). Fail-open: `!valid` ⇒ `LOD_NEAR`.

**Layering (orthogonal, do not conflate):** LOAD ring (~1764 m) → RESIDENT (LandblockLRU, evict) → **ACTIVE (the new authority, metre bands, freeze)** → RENDER cull (FCULL frustum). The authority is a *tick/uniform cost gate* — it **never** evicts, never `.visible`-hides (FAR objects stay DRAWN; a frozen tree at 220 m is pixel-identical → **zero pop**).

### 15.3 Per-archetype tiers
| Family | NEAR | MID | FAR (still drawn) |
|---|---|---|---|
| MECH-A (mixer copy) | copy every frame | copy every Kth frame (`lodMidStride=3`) | skip copy (freeze) |
| MECH-B (vertex) | full amplitude | depth-faded amplitude | amplitude→0 |
| particle | emit+update every tick | emit×0.5 / update every 2nd | freeze+hide (today's RP6 FAR) |
| weathering/emissive (frag) | full | full | FCULL render-cull only (`lodExempt:true`) |
| light flicker | full | full | clamp to static when LB out of PVS; **never down-tier a light node** |

The MECH-B fade is **two SHARED uniforms** `uLodNear/uLodFar` + in-shader depth fade — NOT a per-instance cache key.

### 15.4 Invariants & build
**Nesting (no-pop):** clamp `lodMid ≤ 0.5 × ring diagonal` so a FAR object is always loaded+drawn. **No ownership overlap:** the authority never touches `evict/track/.visible`. The 512 build cap stays (resident analog). Light exemption inherited (`statics.js:2766 _staticOwnsLight`). **Net-negative cost** (removes RP6's second frustum build + animScenery's separate camera read; MID tier saves ⅔ mixer copies + ½ particle overdraw in the 120–220 m band). **Build:** flags+clamp → API methods → unit test → animScenery consumer (delete `DEFAULT_TICK_RADIUS_M`/`tickRadiusSq`, query authority, fixes the AC/world bug) → particle consumer (delete private frustum, query authority, keep 6-tick cadence + drain contract) → MID emit-scale → MECH-B fade hook (forward-compat) → LRU-orthogonality assertion → light-exemption regression → diag tier histogram → eye-test + gauge.

---

## 16. AI texture upscaling — ISOLATED TRACK (S16)

> **Isolation contract:** touches the rest of the suite at EXACTLY two points — (1) the pixel-swap ingest seam, (2) the rule that the classifier reads ORIGINAL DAT pixels. Registers NO `VisualComponent`, adds NO `_chainBeforeCompile` patch, never participates in the descriptor/archetype schema. It is a *source-pixel substitution*, not a shader effect. Build it as a parallel track.

### 16.1 Model & bake decisions
**Real-ESRGAN (RRDBNet backbone) + game-texture finetune, offline via `realesrgan-ncnn-vulkan`** (degradation model matches AC's CustomRawJpeg + P8 banding; richest game-finetune ecosystem; fast on the 1070). Reject SwinIR (over-smooths stylized flat art, 5–10× slower). Bake decisions: **4× clamped** to `min(srcDim*4, 1024)`, skip >256 px / ≤4 px / solids; **alpha upscaled SEPARATELY** by edge-preserving bicubic (SR models soften the alphaTest 0.5 boundary); **3×3 wrap-pad → upscale → center-crop** (preserves tiling seams, gives the "seam-fix" effect free); **sRGB-space** upscale; **operate on POST-palette RGBA8** (the model never sees indices).

### 16.2 Sidecar key, catalog, format
**Key by the RenderSurface/Texture DID (`0x06`)** not Surface (`0x08`) — `0x06` is the unique pixel payload shared across Surfaces and icons (icons upgrade free, `fetch_icon_pixels_impl`). New Rust `upscale_fetch` module mirroring `scenery_fetch` (`lib.rs:2069-2188`): `init_upscale_base_url`/`ensure_catalog`/`ensure_upscaled`/`get`/`clear`. One-shot `upscale-catalog.json` index (avoids per-DID 404 probing). Sidecar `0xDID.tex.bin` = 16-byte header (magic/fmt/w/h/mipCount) + mip-major payload. **Format: BC7 (bptc) primary, BC3/BC1 fallback, raw RGBA8 debug** — raw 4× is ~16× original VRAM (budget risk); **BC7 keeps the 4×-res texture at ≈ original RGBA8 footprint** (the whole reason to compress). Tier picked from `quality.js` GPU-tier + `EXT_texture_compression_bptc`/`WEBGL_compressed_texture_s3tc`.

### 16.3 The swap seam — classify-then-swap (CRITICAL ordering)
```
to_rgba8(...)              // decode original
compute_stats(&pixels)     // ← SurfaceStats from ORIGINAL
classify_with_overrides()  // ← classify ORIGINAL   (fetch_surface_pixels_impl @ src/lib.rs:7270/7292)
──────── SWAP HERE, AFTER classify ────────         // replace pixels/w/h, regen normal/height from UPSCALED
SurfacePixels{...}         // ship upscaled
```
**Swap AFTER `classify_with_overrides`, not at the `to_rgba8` shorthand line** — Real-ESRGAN shifts mean luminance / gradient variance / edge density, which would flip `surface_classify` (smooth-metal → rough-dirt). `category`/`roughness_override`/`normal_scale_override` stay computed from original. **Phase 1** = raw RGBA8 swap in Rust (proves the pipeline). **Phase 2** = BCn `CompressedTexture` swap in JS at `materials.js` `_installFromPixels` (`:3197`, the `surfacePixelsToTexture` call — the `downscaleRgba` `adapter.js:902` hook is the precedent), copying `colorSpace=SRGB/flipY=false/wrap/anisotropy` identically from `adapter.js:911-918`; Rust stays unchanged (max isolation, WASM out of the BCn path).

### 16.4 VRAM budget + LRU + bake CLI
JS `UpscaleTextureLRU` (mirror `landblock_lru.js:66/178/197`): keyed by `0x06` DID, byte budget from catalog, `touch` on bind, evict→`dispose`→restore original `.map`; `?upscaleBudget=256` MB default (BC7 holds thousands), `?upscale=off`. Bounds **unique 0x06 DIDs** (tiny), not placements. Offline bake CLI `apps/holtburger-tools/src/bin/texture-upscale-bake.rs` (mirror `scenery-bake.rs` determinism + `bake-source.sha256` base-DAT-hash gate); bake Holtburg ring first (scope via `vfx sample --area holtburg`) → `dist/upscale/`.

### 16.5 Legacy-safety & build
The safest effect: reads only static DAT pixels + baked sidecar; writes only a client-owned texture bound to `material.map` (same UVs, same geometry); never touches wire/physics/light-count/`customProgramCacheKey` (a bigger/compressed texture binds to the byte-identical program → **zero shader-link cost**). Edge cases: classification-poisoning lint (assert swap-line > classify-line); ClipMap alpha-test (bicubic alpha); SubPalette dyed recolor (bypass swap — bake is default-palette); animated surfaces (per-frame `0x06` or skip); stale-pkg/missing-catalog ⇒ original pixels, byte-identical. **Build:** (A) offline bake CLI → decode/split/upscale/recombine/BCn → catalog; (B) Rust Phase-1 raw swap + lint; (C) JS Phase-2 BCn + `UpscaleTextureLRU`; (D) flags/gauge/Holtburg-first ramp.

---

## 17. CONSOLIDATED BUILD ORDER

The dependency graph, starting from the shipped tree-wind + design-doc Phase 0. **Legend:** `[JS]` no rebuild · `[C#]` WB.Terminal · `[WASM]` Rust rebuild · `[bake]` offline.

### 17.1 What blocks what
```
S01 component interface ──┬─> S02 taxonomy ──> S03 classifier ──> S12 WB.Terminal surface ──> client catalog fetch
   (substrate; wraps      │      (registry)      (offline C#)        (commands + artifacts)
    shipped windBend)     │
                          ├─> S07 oscillator (THE vfx tick) ─┬─> S08 weathering ─┐
                          │                                   ├─> S10 emissive/bloom/flame ─┤─> Phase-1 frag bundle
                          │                                   │                              │
                          ├─> S04 mech-dispatch ─> S05 normals ─> S06 draw/cast ──> Phase-2 MECH-B deform
                          ├─> S09 particle/aura ─────────────────────────────────> Phase-3
                          └─> S13 legacy-safety lint (gates ALL of the above at PR time)
S11 gauge (cost model) ── parallel; gates every default-on flip
S14 DAT-hook coexistence ── runs inside S03 classify (stage 0); blocks any motion/particle default-on
S15 LOD/cull unification ── refactor; sequence after Phase-2/3 land (consumes their tiers)
S16 AI upscaling ── ISOLATED parallel track; intersects only at the ingest seam + "classify on original pixels"
```

### 17.2 Phases (each ends with `vfx gauge` green + bare-default 0-error load)

**Phase 0 — minimal vertical slice [JS + C#, no WASM].** Generalize tree-wind into the S01 component schema (windBend wraps `buildTreeWindClip`, `?treeWind=on` byte-identical); 3-archetype classifier `trunk-canopy`/`rigid-glint`/`tip-flex` (S03); descriptor schema + JSON registry (S02); WB.Terminal `vfx classify/sample/emit-allowlist/gauge-HalfA` (S12, S11); client `vfx_catalog.js` + descriptor-by-mech router (S12); legacy-safety lint (S13). **Exit:** classifier round-trips `TREE_WIND_DIDS` exactly; `vfx gauge` green; lint green on windBend.

**Phase 1 — emissive/material bundle [JS-only].** Material oscillator (S07, the vfx tick); cheap frag family `magic-glow`/`enchant-shimmer`/`glint`/`tarnish`/`wetness`/`frost` (S08, S10); flame-flicker (S10); weathering compose-order + per-instance age (S08); bloom tiers (S10). DAT-hook coexistence detection (S14, C#) so no frag effect double-drives a Luminous/Diffuse channel. Default-OFF behind `?visual=` → batched 1070 eye-test → default-ON with `=off`.

**Phase 2 — MECH-B deformation [JS; may need WASM getters].** Mech-dispatch router (S04); normal-recompute (S05); draw/cast plumbing (S06, one `_castStartedMs` line + accessor); `tip-flex`/`bow-limb`/`cloth-flutter`/`worn-garment`. Normal strategy measured on the 1070.

**Phase 3 — particle/aura [JS].** Synthetic gfxobjs + presets + anchor selector + gates + per-LB teardown (S09). `fire-particle`/`foliage-ambient`/`gem-sparkle`/`breath-fog`.

**Phase 4 — LOD/cull unification [JS refactor].** Fold the four cull systems into `FrustumCuller` 3-tier authority (S15); wire animScenery + particle consumers; MECH-B amplitude fade.

**Phase 5 — texture/detail + classifier maturation [JS + C# + WASM].** Extend `normal_gen.rs` (roughness/AO), richer detail tiles, anisotropic metal, seam-fix; grow to ~20–40 archetypes; audit/override pass; per-archetype default-on flips gated by `vfx gauge`.

**Isolated track (any time) — AI super-res [bake + WASM + JS].** S16 offline bake → Rust Phase-1 swap → JS Phase-2 BCn + LRU. Only touchpoints: the ingest swap seam (after `classify_with_overrides`) and the classifier-reads-original rule.

### 17.3 The first 5 concrete commits a dev makes
1. **`feat(vfx): component-interface substrate + windBend`** — `scene3d/vfx/{registry,setkey,attach,tick}.js`; `VFX_GLOBALS`; extend `_patchSetCacheKey` (`materials.js:262`) with the single `|v + __vfxSetKey` line; `getCachedVariant` + `vfxVariants` Map + dispose walk; `components/windBend.js` wrapping `buildBboxRig`+`buildTreeWindClip`; round-trip the 6 `TREE_WIND_DIDS` byte-identically. (S01)
2. **`feat(vfx): C# classifier + descriptor schema`** — `WorldBuilder.Shared/Lib/VisualDescriptor.cs` (records + `VisualArchetypeIds` + `VisualDescriptorIndex`); `visual_archetype_rules.jsonl` (3 archetypes + `rigid`); `CommandEngine.Vfx.cs` reverse-index + cascade + `vfx classify`/`emit-allowlist`; assert `emit-allowlist trunk-canopy` reproduces `TREE_WIND_DIDS`. (S02, S03, S12)
3. **`feat(vfx): client catalog fetch + descriptor-by-mech router`** — `scene3d/vfx_catalog.js` (`initVfxCatalogUrl`/`loadVfxCatalog`/`vfxDescriptorFor`/`visualEnabled`); generalize the `statics.js:1594-1600` tree-wind divert; `?visual` default-OFF; absent-catalog byte-identical. (S12)
4. **`test(vfx): legacy-safety lint`** — `scene3d/vfx/lint_caps.js` (4 frozen Sets + `FORBIDDEN_SOURCE`); `export const manifest` on windBend; `tests/vfx_legacy_safety_lint.test.cjs` (Layers A/B/C); register in `harness/run-js-headless.mjs` TIER1; 3 negative fixtures. (S13)
5. **`feat(vfx): gauge Half-A + cost model`** — `cost_model.jsonl` (§11.3 table); `CommandEngine.Vfx.cs` `VfxGauge` (enumerate Holtburg DIDs, sum weighted rows, FAIL-fast over ceiling); `?vfxGauge=on` tick instrumentation in `index.js`; confirm the 3-archetype set green on the 222-placement ref. (S11)

---

## 18. Open questions / risks

1. **Weenie prop source gap (blocks S03 selectors, not the taxonomy).** WeaponType/MaterialType/ValidLocations/AttackType/spell-DIDs are **NOT** in the current `WeenieIndexEntry` (`WeenieIndex.cs:32-74` carries only WeenieType/CreatureType/Level/SetupDid/Icon/Palette/Inscription). S03's `select` predicates name props by ACE key, so the taxonomy is stable, but the classifier must extend `WeenieIndexEntry` or read `weenie_properties_*` via `AceDbConnector.LoadWeenieSnapshotAsync` (`AceDbConnector.Weenie.cs:115`). **Resolve before Phase 0 classifier coding.**
2. **MECH-B shadow consistency (S04/S05/S08 boundary).** A large MECH-B bend (cloth/limb) leaves the shadow silhouette undisplaced (shadow pass uses stock `MeshDepthMaterial`). S05 defers `customDepthMaterial` patching; for cloth at the Holtburg scale this is likely invisible, but the decision (patch depth vs accept) must be made on a 1070 eye-test in Phase 2. Weathering (S08) and normal-recompute (S05) must NOT touch the depth material.
3. **1070 calibration is a placeholder until measured.** The 12.5 ms/frame budget constant (§11.4) is a worked example. The whole ceiling depends on real `T_frame`/`T_gpu_baseline` from a physical GTX 1070 — this box is SwiftShader, so all timing gates (G5–G7) are `N/A` here. **No effect defaults-on until a 1070 timing run exists.**
4. **DAT-hook scan depth — `CallPES` recursion (S14).** A `default_animation` firing `CallPES`(19) may spawn SetOmega/CreateParticle from a 0x33 PhysicsScript not visible to the keyframe scan. Conservative default suppresses all motion+particle on `CallPES` present; full PES recursion is a Phase-5 refinement. Risk: over-suppression (a CallPES object that only plays a sound loses legitimate weathering) — acceptable vs double-drive.
5. **Per-instance age phase reshuffle (S08).** Procedural in-shader age reshuffles on LRU re-bake (a barrel's tarnish *phase* can change after you walk away and back). Invisible for weathering; if a named landmark ever needs placement-stable age, layer the explicit `aVfxHash` attribute (S01) as a per-DID override.
6. **Fern A→B migration (S04) is a 317k-placement bet.** `0x02001063` under MECH-A animates only the 512 nearest; the single-axis `begin_vertex` migration animates all 317k for ~free GPU but must prove the height-weighted approximation reads acceptably near-camera. Phase-2 migration, gauge-gated, not day-zero.
7. **Catalog freshness vs ontology re-scan.** `visual_descriptors.jsonl` is regenerated by the classifier; an ontology re-scan that changes geometry features could silently drift descriptors. Mitigation: `vfx export` validates `archetype ∈ rules.Keys` and the round-trip test pins `trunk-canopy`; add a Phase-5 staleness check (descriptor `bake-source.sha256` vs ontology hash).
8. **AI upscale classification-poisoning (S16).** The swap MUST land after `classify_with_overrides`; a lint asserts swap-line > classify-line, and `bake-source.sha256` enforces base-DAT-only. If a future refactor moves `compute_stats`, the lint must move with it — flagged for the §13 lint owner.
9. **SwiftShader false-green (S11).** A CI run that reported timing gates as PASS on software GL would be meaningless. The gauge hard-codes `STRUCTURAL-PASS` (never `PASS`) on SwiftShader; the risk is a dev reading STRUCTURAL-PASS as ship-ready. Document loudly in the gauge report header.
