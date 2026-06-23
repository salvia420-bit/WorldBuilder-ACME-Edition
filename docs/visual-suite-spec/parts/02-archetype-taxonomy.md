I have everything I need. Writing the buildable spec for my slice now.

---

# SLICE 02 — FULL ARCHETYPE TAXONOMY (Build Spec)

## Goal

Finalize the canonical visual-behavior archetype list (target 20–40; this spec ships **31 entries** = 28 selectable archetypes + a `rigid` fallback + 2 universal refiner bundles), and fix for each one: stable `id`, the exact **component bundle** it carries, per-component **default config / parameter curves**, the **classifier signal** that selects it, and the **mechanism** (MECH-A CPU keyframe / MECH-B GPU vertex / frag / light / particle / texture / defer). Decide and justify the **representation** (C# enum vs JSON string schema). The taxonomy is the contract every other slice keys off: slice 01 (component interface) registers the components named here, slice 03 (classifier) emits these ids, slice 12 (WB.Terminal) serializes the schema defined here.

Grounded against the shipped archetype #1 `trunk-canopy` (`tree_wind.js:64`, `wind_rig.js:149`) so the file round-trips today's `TREE_WIND_DIDS` exactly.

---

## Design

### D1. Representation decision — **JSON string-id registry, NOT a closed C# enum** (recommended)

**Decision: the archetype id is a stable kebab-case STRING. The single source of truth is a baked JSON registry `visual_archetype_rules.jsonl`. C# references ids through a *generated const-string* class (`VisualArchetypeIds`, codegenned from the registry), never a hard `enum`. JS loads the same registry into a string-keyed `Map`.**

Justification (cross-checked against the in-tree precedents):

| Consideration | Hard `enum VisualArchetype` (mirrored C#↔Rust/WASM) | **String id + JSON registry (chosen)** |
|---|---|---|
| Extensibility | Adding archetype #29 forces a recompile of WB.Terminal **and** any shared-with-WASM crate. Fights the doc's core thesis: *"adding an effect = registering a component… nothing else breaks."* | New archetype = one new JSONL line + register its components (slice 01). No recompile of the consumer; matches *"keeps the JS runtime dumb (just reads tags)"* (adjudicated classifier-locus). |
| Storage match | Descriptor already lives in `visual_descriptors.jsonl` keyed by DID with `archetype` as a **string** field (§6.3, adjudicated). An enum would be (de)serialized as that string anyway. | Native: the field IS the id. The client reads string tags exactly like `tree_wind.js` reads its allowlist. |
| Drift safety | Two hand-maintained mirrors (the SurfaceCategory pattern, `surface_classify.rs:31` ↔ `materials.js:138`) — acceptable for a **closed physical** set of 13, but archetypes are an **open evolving** set the doc plans to *"grow to ~20–40"* (Phase 5). | One file both sides validate against. C# gets compile-time-checked refs via generated `VisualArchetypeIds` consts; JS validates loaded descriptors' `archetype ∈ registry`. Codegen kills typos without a closed enum. |
| Why not free strings | — | A bare free-string invites C#-emitter ↔ JS-consumer drift. The registry + generated consts give the typo-safety of an enum **without** the closed-set / recompile cost. |

**Rule of thumb encoded:** *closed, intrinsic physical kind → hard enum mirror (SurfaceCategory); open, evolving bundle-of-components → string id + shared JSON registry.* Archetypes are the latter.

### D2. Schema definitions

**`visual_archetype_rules.jsonl`** — the REGISTRY (single source of truth; one line per archetype). C# `CommandEngine.Vfx.cs` writes it (`vfx export`), C# classifier + JS `archetype_registry.js` both read it:

```jsonc
{
  "id": "tip-flex",                       // stable kebab id (immutable once shipped)
  "label": "Tip-flex (spear/polearm/staff/wand)",
  "components": ["procMotion.tipFlex", "emissive.glint"],   // ordered bundle
  "mech": "B",                            // A | B | "B+A" | frag | light | particle | texture | defer
  "cost": "cheap",                        // cheap | medium | expensive  (gate class, slice 11)
  "flag": "tipFlex",                      // per-archetype gate: ?tipFlex=on/off  (tree_wind.js:33 pattern)
  "defaults": {                           // per-component default config (the parameter curves)
    "procMotion.tipFlex": { "ampDeg": 1.5, "axis": "shaftLong", "weightCurve": "smoothstep",
                            "gripAnchor": "holdingLoc", "mech": "gpu" },
    "emissive.glint":     { "strength": 0.4, "metalBias": 0.9 }
  },
  "select": { "rule": "weaponType in [5,7]", "thinDistal": true, "confidence": 0.85 }  // see slice 03
}
```

**`visual_descriptors.jsonl`** — the per-DID OUTPUT (one line per classified DID; consumed by the holtburger bake → `{vfxBase}{did_hex}.vfx.jsonl`, §6.3):

```jsonc
{
  "did": 33558820,                        // 0x02000724  (u32; hex-string also accepted on read)
  "archetype": "tip-flex",                // MUST ∈ registry ids
  "confidence": 0.62,
  "source": "classifier",                 // classifier | manual | self-label | allowlist
  "components": ["procMotion.tipFlex", "emissive.glint"],   // resolved (= archetype default unless overridden)
  "config": { "procMotion.tipFlex": { "ampDeg": 1.5 } },    // SPARSE per-component override; absent → registry default
  "modifiers": ["weatherable", "textured"],                 // universal refiners composed on top (NOT exclusive)
  "signals": ["weaponType=5", "aspect=6.2", "distalThin"]   // optional, audit only
}
```

**C# types** (`WorldBuilder.Shared/Lib/VisualArchetype.cs`, new — sibling of `OntologyEntry.cs`):

```csharp
namespace WorldBuilder.Shared.Lib;

// GENERATED from visual_archetype_rules.jsonl by `vfx export` — do not hand-edit ids.
public static class VisualArchetypeIds {
    public const string TrunkCanopy = "trunk-canopy";
    public const string PlantWhip   = "plant-whip";
    public const string TipFlex     = "tip-flex";
    public const string BowLimb     = "bow-limb";
    public const string RigidGlint  = "rigid-glint";
    // … one const per registry line …
    public const string Rigid       = "rigid";   // fallback
    public static readonly IReadOnlySet<string> All = /* populated from registry load */;
}

public sealed record VisualArchetypeRule(
    string Id, string Label, string[] Components, string Mech, string Cost, string? Flag,
    Dictionary<string, JsonNode> Defaults, JsonNode Select);

public sealed record VisualDescriptor(
    uint Did, string Archetype, float Confidence, string Source,
    string[] Components,
    Dictionary<string, JsonNode>? Config = null,
    string[]? Modifiers = null,
    string[]? Signals = null);
```

(Serialized with the existing `JsonOpts` — camelCase, null-ignoring — copied from `WeenieIndex.cs:122`.)

**JS consumer** (`scene3d/archetype_registry.js`, new — pure, import-cycle-safe like `wind_rig.js`):

```js
const ARCHETYPES = new Map();   // id -> {components, mech, cost, flag, defaults}
export function registerArchetype(rule) { ARCHETYPES.set(rule.id, rule); }
export function archetypeFor(id) { return ARCHETYPES.get(id) || ARCHETYPES.get("rigid"); }
export function resolveConfig(descriptor) {           // merge sparse override onto registry defaults
  const rule = archetypeFor(descriptor.archetype);
  const out = {};
  for (const c of descriptor.components ?? rule.components) {
    out[c] = { ...(rule.defaults[c] || {}), ...((descriptor.config || {})[c] || {}) };
  }
  return out;
}
```

### D3. The canonical archetype table

`mech` legend: **A**=MECH-A CPU per-part keyframe hinge (`animated_scenery.js` shared mixer); **B**=MECH-B GPU `begin_vertex` displacement (`materials.js:324`); **frag**=fragment patch after `<map_fragment>` (`materials.js:428`); **light**=light-intensity modulation; **particle**=synthesized emitter; **texture**=ingest swap / sampler patch; **defer**=DAT already animates, suite adds nothing (slice 14).

| # | id | components[] | mech | cost | classifier signal | key config defaults (curves) |
|---|---|---|---|---|---|---|
| 1 | `trunk-canopy` **(SHIPPED)** | `procMotion.windBend` | A | cheap | on wind allowlist `tree_wind.js:64` **OR** Foliage surface + multi-part + scenery cat | windBend{ampDeg 7, fps 30, loopSeconds 4, cycles1 3, cycles2 11, flutter 0.3, dirDeg 135(global), strength 1, pivot "partZmin", trunkSuppress 0.3} — exactly `wind_rig.js:151-159` |
| 2 | `plant-whip` | `procMotion.organicWhip` | A / B | cheap | Foliage surface + high single-axis aspect; small reed/kelp/vine | organicWhip{ampDeg 12, cycles1 2, cycles2 7, flutter 0.5, heightWeight "linear"} |
| 3 | `tip-flex` | `procMotion.tipFlex`, `emissive.glint` | B | cheap | WeaponType ∈ {Spear, Staff, Wand} + thin distal protrusion | tipFlex{ampDeg 1.5, axis "shaftLong", weightCurve "smoothstep", gripAnchor "holdingLoc"}; glint{strength 0.4, metalBias 0.9} |
| 4 | `bow-limb` | `procMotion.limbFlex`, `procMotion.stringHinge` | B+A | medium | WeaponType ∈ {Bow, Crossbow} | limbFlex{ampDeg 3 idle, drawSource "clientRangedSubstate", axis "riserPerp"}; stringHinge{parts "stringParts", mech cpu} |
| 5 | `cloth-flutter` | `procMotion.clothRipple` | B | medium | ItemType banner/flag/pennant **OR** flat-thin-sheet + Cloth surface | clothRipple{ampDeg 8, waveSpeed 1.5, wavelength 0.4, anchorEdge "topEdge"} |
| 6 | `worn-garment` | `procMotion.garmentFlutter` | B | medium | ValidLocations cloak/chest + Cloth surface | garmentFlutter{ampDeg 5, velocityHeading uniform, hemWeight "smoothstep"} |
| 7 | `hanging-sway` | `procMotion.pendulum` | A | cheap | thin vertical hanging multi-part (chain/rope/lantern) | pendulum{ampDeg 4, period 3.5, axis "topPivot"} |
| 8 | `sign-swing` | `procMotion.signSwing` | A | cheap | ItemType=Sign + off-center top-pivot part, **no** DAT hook | signSwing{ampDeg 3.5, period 4, pivot "topEdgeCenter"} |
| 9 | `display-spin` | `procMotion.omegaSpin` | **defer** | cheap | **DAT hook 22 SetOmega** (`setup_model_hooks.rs:286`) self-label | reads DAT `axis`+omega; suite ADDS NOTHING (slice 14 — DAT wins) |
| 10 | `levitate-bob` | `procMotion.bob` | tick | cheap | weenie levitation/float property or spell | bob{ampMeters 0.08, period 3, axis "+Zrender"} — render offset only |
| 11 | `idle-breath` | `procMotion.breathScale` | B | cheap | WeenieType=Creature(7) **and at-rest / no DAT idle anim** | breathScale{ampScale 0.02, period 4, anchor "chest"} |
| 12 | `soft-jiggle` | `procMotion.decayWobble` | B | cheap | ItemType container/food + compact soft geometry | decayWobble{ampDeg 6, decayTau 0.6, trigger "clientLocal"} |
| 13 | `rigid-glint` | `emissive.glint`, `weathering.tarnish` | frag | cheap | WeaponType ∈ {Sword,Axe,Mace,Dagger} + metal | glint{strength 0.5, sweepSpeed 0.7, metalBias 0.9}; tarnish{amount "hash01", roughTarget 1.0, creviceTint 0.3} |
| 14 | `metal-tarnish` | `weathering.tarnish` (+`weathering.rust`) | frag | cheap/med | MaterialType metal **refiner** on weapon/armor/fixture | tarnish{amount "hash01", topWeight 0.6}; rust{tile "rustBlotch", strength 0.4} |
| 15 | `magic-glow` | `emissive.magicGlowAmbient` | frag | cheap | has spell DIDs **OR** ItemType=Gem/magic | magicGlowAmbient{useDiffuseAsEmissive true, intensityFloor 1.0, cap 2.0} |
| 16 | `enchant-shimmer` | `emissive.enchantShimmer` | frag | cheap | enchanted state / spell DIDs | enchantShimmer{amp 0.25, period 2, base 1.0} — `I·(1+a·sin(uTime))` |
| 17 | `spell-school-aura` | `emissive.schoolAura` | frag | cheap | spell DIDs carrying a magic school | schoolAura{rimPower 3, color "schoolColor", intensity 0.6} |
| 18 | `glowing-runes` | `emissive.runeEmissive` | frag | medium | ItemType altar/lifestone **OR** high-value weapon | runeEmissive{runeTile, accum 0.5, pulse 0.2} |
| 19 | `gem-inner-fire` | `emissive.gemInnerFire` | frag | medium | ItemType=Gem + translucent surface | gemInnerFire{fresnelInv true, coreGlow 0.7, uvWarp 0.05} |
| 20 | `value-tier-sheen` | `emissive.sheen` | frag | cheap | high Value property tier | sheen{roughBias −0.1, specBias 0.1, emissiveFloor 0.05} |
| 21 | `glowing-eyes` | `emissive.eyeEmissive` | frag | cheap | WeenieType=Creature + head part | eyeEmissive{partAnchor "head", intensity 1.5} |
| 22 | `holy-corrupt-tint` | `emissive.tint` | frag | cheap | alignment/faction property | tint{rimColor, diffuseMul, emissiveBias 0.1} |
| 23 | `flow-scroll` | `texture.texVel` | **defer**/frag | cheap | **DAT hook 23/24 TexVel** (`setup_model_hooks.rs:288`) self-label **OR** Lava/Water surface | DEFER if hook present; else texVel{uSpeed, vSpeed} |
| 24 | `flame-flicker` | `emissive.flameFlicker` | light | cheap | light-bearing torch/brazier | flameFlicker{intensityJitter 0.15, rate 8, channel "flame", neverChangeCount true} |
| 25 | `fire-particle` | `particle.embers`, `particle.smoke` | particle | medium | ItemType brazier/fire + bowl part | embers{rate 20, additive, anchor "bowlPart"}; smoke{rate 8, alpha} |
| 26 | `foliage-ambient` | `particle.motes` (+`particle.leaves`) | particle | cheap/med | Foliage + canopy part (firefly=dusk gate) | motes{rate 5, spread "canopyBox"}; leaves{rate 2, flutter, fadeBeforeGround} |
| 27 | `water-context` | `particle.splash`, `particle.mist` | particle | medium | **AUDIT-driven** (geometry-hard anchor) | splash{rate, anchor "audit"}; mist{rate} |
| 28 | `dusty-indoor` | `particle.dustMotes`, `weathering.dust` | particle+frag | cheap | Furniture/Prop indoor + aged | dustMotes{rate 3, +Z}; dust{topWeight, amount 0.4} |
| — | `rigid` **(fallback)** | `[]` (deformation identity) | — | free | else-branch (no signal matched) | none — byte-identical frozen path |
| U1 | `weatherable` **(modifier)** | `weathering.wetness` / `weathering.frost` | frag | cheap | global weather/season manager (NOT classifier) | wetness{uWetness global, upFacing}; frost{uFrost global, mutually-excl with wet} |
| U2 | `textured` **(modifier)** | `texture.superRes` / `.normalGen` / `.detailGrain` / `.pom` / `.aniso` | texture | cheap–**exp** | SurfaceCategory + quality preset | pom + heat-haze are **gated-expensive** (high-only + on-screen + LOD) |

**Modifiers (`weatherable`, `textured`) are not exclusive archetypes** — they ride in the descriptor's `modifiers[]` and compose on top of any base archetype. This is the only place `expensive` cost enters the base taxonomy (POM raymarch / heat-haze), and both are hard-gated per slice 11.

### D4. Worked-example cross-check (the taxonomy must reproduce §2.3)

| Object | DID | → archetype | components emitted | mech | round-trip check |
|---|---|---|---|---|---|
| Atlan spear | `0x02000724` | `tip-flex` (#3) | `procMotion.tipFlex`(gpu) + `emissive.glint` | B | ✓ grip = `holding_locations` (`setup_model.rs:334`); ampDeg 1.5 |
| Bow | per-DID | `bow-limb` (#4) | `limbFlex`(gpu) + `stringHinge`(cpu) | B+A | ✓ drawAmount read-only (slice 06) |
| Tall tree | `0x02000258` | `trunk-canopy` (#1) | `procMotion.windBend`(cpu) | A | ✓ **0x02000258 ∈ `TREE_WIND_DIDS` `tree_wind.js:69`** → allowlist regen reproduces it |
| Sword | per-DID | `rigid-glint` (#13) | `glint` + `tarnish`, deform = identity | frag | ✓ rigid base, no MECH-A/B transform |

All four resolve to the doc's prescribed bundles → taxonomy is consistent. Round-trip of the 6-DID `TREE_WIND_DIDS` set through `trunk-canopy` is the Phase-0 exit bar (§8).

---

## Integration seams (file:line)

- **Allowlist this taxonomy replaces:** `scene3d/tree_wind.js:64` `TREE_WIND_DIDS` Set → regenerated as `trunk-canopy` descriptor lines. `isTreeDid()` (`tree_wind.js:74`) becomes `archetypeFor(did) === "trunk-canopy"`.
- **Per-archetype flag gate pattern:** `tree_wind.js:33-56` (`treeWindEnabled`/`treeWindStrength`/`treeWindDir`, memoized `_strFlag`/`_numFlag`) → each registry `flag` field drives a `?<flag>=on` reader; master `?visual=archetypes`.
- **MECH-A consumer (windBend, pendulum, signSwing, stringHinge):** `wind_rig.js:113` `buildBboxRig` (rig math), `:149` `buildTreeWindClip` (keyframe array), `:199` `hash01` (per-instance phase) → `animated_scenery.js` shared-mixer player.
- **MECH-B consumer (tipFlex, limbFlex, clothRipple, garmentFlutter, breathScale, decayWobble):** `materials.js:292` `_chainBeforeCompile` + `:324` `#include <begin_vertex>` injection.
- **frag consumer (all emissive/weathering):** `materials.js:428` `#include <map_fragment>` insertion + `:1238` `applyFloatLumDiffuse`.
- **Cache-key invariant (critical for taxonomy correctness):** `materials.js:262` `_patchSetCacheKey` keys on **boolean `userData` component-present flags** (`detailEnabled`, `csmEnabled`, …) — NOT config values. Every component this taxonomy adds must contribute **one boolean flag** to that key, so the key space = number of distinct component-SETs (a handful), never per-instance. This is the structural guard against the project's #1 cold-load cost (§1.2 corollary).
- **DAT self-label inputs (display-spin #9, flow-scroll #23):** `setup_model_hooks.rs:286-290` (`SetOmega`=22, `TextureVelocity`=23, `TextureVelocityPart`=24), reachable via `setup_model.rs:346` `default_animation`.
- **Anchor inputs (tip-flex grip, particle bowls/heads):** `setup_model.rs:334` `holding_locations`, `:335` `connection_points`.
- **SurfaceCategory signal:** `surface_classify.rs:31` (Rust) ↔ `materials.js:138` `SURFACE_CATEGORY` (JS mirror).
- **C# registry home:** new `CommandEngine.Vfx.cs` (sibling of `CommandEngine.SurfaceMaterials.cs`); types in new `WorldBuilder.Shared/Lib/VisualArchetype.cs` (sibling of `OntologyEntry.cs`). Descriptor serialization reuses `WeenieIndex.cs:122` `JsonOpts`.

---

## Edge cases & legacy-safety check (per THE RULE)

1. **Classifier-signal dependency gap (build prerequisite).** The `select` signals reference weenie props — WeaponType, MaterialType, ValidLocations, AttackType, spell DIDs — that are **NOT in the current `WeenieIndexEntry` record** (`WeenieIndex.cs:32-74` carries only `WeenieType, CreatureType, Level, SetupDid, IconDid, PaletteBaseDid, ClothingBaseDid, PaletteTemplate, Inscription`). The taxonomy is stable regardless of *where* those props are sourced, but slice 03 must either extend `WeenieIndexEntry` or read a fuller `weenie_properties_*` store. My `select` column names props by their ACE key, not by a current C# field, so the taxonomy doesn't bake in the gap. **Flagged as a checklist dependency.**
2. **THE RULE — taxonomy-wide audit:** every component named here READS only DAT geometry/Surface/weenie props, server pos/heading, `hash01(guid)` (`wind_rig.js:199`), and the wall-clock; WRITES only render transforms / cloned uniforms. Per-archetype risk points:
   - `levitate-bob` (#10): writes a **render-only +Z offset**, reading server pos as the base — never the physics/replicated Z. ✓
   - `bow-limb` (#4): `drawAmount` is the existing **read-only** client ranged substate (slice 06 proves zero wire impact). ✓
   - `flame-flicker` (#24): modulates light **intensity only**, `neverChangeCount:true` — never `.visible`/light count (§1.2 relink corollary; `MAX_ACTIVE_LIGHTS=32`). ✓
   - `display-spin` (#9) / `flow-scroll` (#23): **defer** when a DAT hook (22/23/24) is present — no double-animate, no second writer (slice 14). ✓
   - `idle-breath` (#11): only when the creature has no DAT idle animation; coexistence-gated. ✓
   - **No archetype sets `customProgramCacheKey` per-instance** — all per-instance variation (tarnish amount, sway phase) flows through **uniforms keyed off `hash01`**, while the cache key stays a boolean component-present flag (`materials.js:262`). ✓
   - **No archetype changes light count.** Only `flame-flicker` touches lights, intensity-only. ✓
3. **Single-part vs multi-part mech ambiguity** (e.g. `plant-whip` #2): resolved by slice 04's dispatcher (PartCount + intra-vs-across-part motion). The taxonomy lists both `A / B` and defers the pick; my `defaults` are mech-agnostic so either consumer can read them.
4. **Compound objects** (a sword that is also a gem-hilted magic weapon): the base archetype is exclusive (`rigid-glint`), but `modifiers[]` + extra emissive components compose additively — the descriptor `components[]` can exceed the base bundle. Resolution is slice 01's compose contract; the taxonomy just permits the superset.
5. **`rigid` fallback** must emit zero components → byte-identical frozen path, matching today's `?treeWind` off behavior (`tree_wind.js:5-6`).

---

## GPU cost

Cost rolls up by class (slice 11 owns the gauge; this is the taxonomy's contribution to the budget):

- **cheap (18 of 28 base + both modifiers' default tier):** ~free at steady state. Cap = **unique-driver count, not placement count** (MECH-A shares one mixer/clip per `(setupId, phaseBucket)`; frag/emissive share one patched program per component-SET; flame-flicker is one intensity write per light). Against the Holtburg ref (222 placements / 66 unique models, §5.1) the cheap tier is bounded by the ~66 unique models, not 222 instances.
- **medium (8 base + aniso modifier):** 1 extra tex fetch (rust/runes/gem) or 1 MECH-B vertex displace or 1 particle emitter. Cap = **visible instances** in the Holtburg ring; counted live by `vfx gauge`.
- **expensive (modifiers only):** POM raymarch + heat-haze EffectPass — **hard-gated** (high quality + on-screen + distance LOD). Zero base archetypes are expensive, so a default-on archetype set never trips the expensive class.
- **Taxonomy-level ceiling:** because every cheap archetype's cost scales with unique drivers and every component contributes exactly one boolean cache-key bit (`materials.js:262`), the *number of archetypes* does not multiply shader programs — the program count is bounded by distinct **component-SETs** actually present in a scene (a handful), preserving the **<75% GPU at full Dereth** target (§5.2).

---

## Build checklist (ordered, each step a concrete code change)

1. **`WorldBuilder.Shared/Lib/VisualArchetype.cs`** (new) — add records `VisualArchetypeRule`, `VisualDescriptor`, and the `VisualArchetypeIds` const-string class (per D2). Reuse `JsonOpts` from `WeenieIndex.cs:122`.
2. **Author `visual_archetype_rules.jsonl`** (project data dir) — 31 lines: the 28 archetypes + `rigid` + `weatherable` + `textured`, each with `id/label/components/mech/cost/flag/defaults/select`, transcribing the D3 table verbatim. This file is the single source of truth.
3. **`CommandEngine.Vfx.cs`** (new, sibling of `CommandEngine.SurfaceMaterials.cs`) — `LoadArchetypeRules()` reads rules.jsonl into `Dictionary<string, VisualArchetypeRule>`; `vfx export` writes both rules.jsonl and descriptors.jsonl. Validate every descriptor `archetype ∈ rules.Keys` on write (fail loud).
4. **Codegen `VisualArchetypeIds` consts** from rules.jsonl ids (a small T4/source-gen or a one-shot `vfx gen-ids` verb) so the C# classifier (slice 03) references `VisualArchetypeIds.TipFlex`, never a literal.
5. **`scene3d/archetype_registry.js`** (new, pure module like `wind_rig.js` — imports nothing from the scene graph) — `registerArchetype`, `archetypeFor`, `resolveConfig` (sparse-override merge, D2). Loaded from the baked `{vfxBase}…vfx.jsonl` (slice 12 fetch path).
6. **Round-trip test** — emit `trunk-canopy` descriptors for the 6 `TREE_WIND_DIDS` (`tree_wind.js:64`); assert `archetypeFor(did)==="trunk-canopy"` for exactly those 6 and `"rigid"` otherwise. This is the Phase-0 exit bar (§8) and proves the taxonomy supersets the shipped allowlist.
7. **Wire the `rigid` byte-identical path** — `archetypeFor` returns the `rigid` (empty-components) rule for any unmatched DID; the statics/scenery bake (`statics.js` placement loop, §6.3) skips component attach when `components.length===0`, leaving the frozen instanced path unchanged.
8. **Per-archetype flag readers** — generalize `tree_wind.js:33-56`'s memoized `_strFlag`/`_numFlag` into `archetype_flags.js`: `archetypeEnabled(flag)` reads `?<flag>=on` and the master `?visual=archetypes`. Keep `?treeWind=on` working as an alias for the `trunk-canopy` flag (back-compat).
9. **Hand off component contracts to slice 01** — the `components[]` ids named here (`procMotion.*`, `weathering.*`, `emissive.*`, `texture.*`, `particle.*`) are the registration keys slice 01's `VisualComponent` registry must implement; each must add exactly one boolean `userData` flag to `_patchSetCacheKey` (`materials.js:262`).
10. **Dependency ticket (blocks slice 03 selectors, not this taxonomy):** extend the weenie source with WeaponType / MaterialType / ValidLocations / AttackType / spell-DID props (absent from `WeenieIndexEntry`, `WeenieIndex.cs:32-74`), or point the classifier at `weenie_properties_*`. The taxonomy's `select` column is written against ACE property keys so it needs no change once the source lands.
