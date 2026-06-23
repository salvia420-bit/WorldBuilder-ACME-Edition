I have all the real data I need. Writing the build spec now.

---

# Auto-Classifier Design — Build Spec (slice 03)

## Goal

Map every render-eligible AC DID → `{ archetype, components[], config, confidence, source, signals[] }` **deterministically and offline in C#** (`CommandEngine.Vfx.cs`), emitting `visual_descriptors.jsonl` + an auditable `visual_archetype_rules.jsonl`. The classifier must:

1. **Round-trip the shipped seed:** reproduce `TREE_WIND_DIDS` (`tree_wind.js:64`) exactly as `archetype=trunk-canopy` (Phase-0 exit bar).
2. Be **auditable as a git diff** (like the hand-seeded allowlist), so the locus is a priority cascade, not a black-box score.
3. Read **only static/derived** inputs (DAT geometry, weenie props, DAT self-labels, surface category) — it never touches runtime/replicated state, so it is trivially inside THE RULE (it's a pure offline function; the *components* it assigns are bound by THE RULE at runtime, the classifier itself only reads DAT/DB).

---

## Design

### 0. The DID-vs-weenie key problem (must solve first)

GROUND-3: **2,763 unique SetupDIDs across 19,686 weenies** — SetupDID present on 99.97%, ItemType on ~95%, MaterialType on ~0.5%. The descriptor is keyed by **SetupDID** (`tree_wind.js` keys the allowlist by SetupModel DID; the scenery-bake looks up by `model_id` — §6.3 of the design doc). But `WeaponType`/`MaterialType`/`AttackType`/`ValidLocations`/spell-DIDs live on the **weenie**, and *N weenies share one setup*.

**Resolution — reverse index + conflict detection:**
- Build `Map<uint setupDid, List<int wcid>>` by inverting `WeenieIndex.TryGetSetup` (`WeenieIndex.cs:103`) over all entries (`WeenieIndex.Entries`, `:112`).
- For a setup, **union** the weenie signals (if *any* contributing weenie is `WeaponType=Spear`, the setup is tip-flex-eligible).
- **Conflict flag:** if contributing weenies disagree on the *primary motion* tier (e.g. one setup used by both a `Sword` weenie and a non-weapon `Misc` prop), drop confidence by 0.3 and push to the audit list (`reason=multi-weenie-conflict:{wcids}`). This is a real case for shared generic setups.
- Setups with **zero** contributing weenies (pure scenery/structure setups — the 99.97%−95% gap) classify on **geometry + surface only** (Tier 5).

### 1. Feature-vector extraction (per source)

```
FeatureVector (per SetupDID)
─────────────────────────────────────────────────────────────────────────
  // ── Identity ──
  uint   setupDid
  int[]  contributingWcids            // from reverse index
  int    weenieType                   // union; WeenieIndexEntry.WeenieType (WeenieIndex.cs:36)

  // ── Weenie props (union over contributing weenies; AceWeenieSnapshot) ──
  ItemType?    itemType               // PropInt 1   (AceWeeniePropertyEnums.cs:6)   ~95% present
  WeaponType?  weaponType             // PropInt 353 (:358)
  MaterialType? materialType          // PropInt 131 (:136)  ~0.5% present → REFINER ONLY
  EquipMask?   validLocations         // PropInt 9   (:14)   bitfield
  AttackType?  attackType             // PropInt 47  (:52)   bitfield → mask, see §5
  bool         hasSpellDIDs           // AceWeenieSnapshot.SpellBookCount > 0  (AceWeenieSnapshot.cs:64)
  string?      inscription            // WeenieIndexEntry.Inscription (WeenieIndex.cs:73) → sign/plaque

  // ── Geometry (OntologyEntry, per SetupDID) ──
  float  maxDimension                 // OntologyEntry.cs:24
  float  aspectRatio                  // :31  (= Z / max(X,Y))
  int    partCount                    // :25
  int    polyCount                    // :29
  int    vertexCount                  // :61
  Vec3   boundsMin, boundsMax         // :17,:19
  // ── Derived geometry (computed by anchor-parts port of wind_rig) ──
  float  distalProtrusion             // see §1a — thin-tip ratio
  float  compactness                  // minDim / maxDim of bbox (1=cube, →0=needle/sheet)
  bool   hasHoldingLoc                // setup.holding_locations non-empty (setup_model.rs:334)
  bool   hasConnectionPts             // setup.connection_points non-empty (:335)
  int    flatSheetAxis                // -1 / 0/1/2 : an axis whose extent < 0.15·maxDim (cloth/sign)

  // ── DAT self-labels (HIGHEST confidence; from default_animation frames) ──
  bool   hookSetOmega                 // hook type 22 present (setup_model_hooks.rs:47)
  bool   hookTexVelocity              // hook type 23 or 24 (:48,:49)
  bool   hookCreateParticle           // hook type 13 (:38)
  bool   hookLuminous                 // hook type 8/9 (:33,:34)
  bool   hookScale                    // hook type 12 (:37)
  Vec3?  omegaAxis                    // SetOmegaHook payload (spin axis)

  // ── Surface category (per Surface DID, from SurfaceIds) ──
  SurfaceCategory[] surfaceCats       // surface_classify.rs:31 → {Stone,Wood,Metal,Lava,Water,Foliage,Cloth,...}
  SurfaceCategory   dominantSurface   // most-frequent across SurfaceIds (OntologyEntry.cs:64)
  bool   anyLuminousSurface           // surface flagged luminous (drives magic-glow)
```

**Extraction per source — concrete reads:**

| Field group | Source | Seam |
|---|---|---|
| Weenie props | `AceDbConnector.LoadWeenieSnapshotAsync(wcid)` → scan `snap.Ints` for type∈{1,9,47,131,353}, `snap.SpellBookCount` | `AceDbConnector.Weenie.cs:115`, `AceWeenieSnapshot.cs:51,64` |
| Geometry | `OntologyEntry` loaded alongside `ontology_cache.jsonl` | `OntologyEntry.cs:24-61` |
| Per-part / distal / holding | port of `wind_rig.js buildBboxRig` (shared with `vfx anchor-parts`) reading `setup.Parts` per-GfxObj bounds + `setup.holding_locations` | `wind_rig.js:113`, `setup_model.rs:334`; `OntologyService.ComputeSetupBounds` extended to retain per-part boxes (`OntologyService.cs:346`) |
| DAT self-labels | resolve `setup.default_animation` (`setup_model.rs:346`) → Animation DAT → iterate `AnimationFrame.hooks` (`setup_model.rs:295`), test `AnimationHookType` 22/23/24/13/8/9/12 | `setup_model_hooks.rs:26-51` |
| Surface | per Surface DID in `OntologyEntry.SurfaceIds` → `surface_classify::classify()` (already mirrored to `materials.js:138`) | `surface_classify.rs:230`, `OntologyEntry.cs:64` |

**§1a — distal-protrusion test (the "thin tip" / flex discriminator).** Reuse `wind_rig.js partBBox` (`:59`) per part. Sort parts by centroid distance from the `holding_locations` frame origin (or from bbox centroid if no grip). Let the farthest part = *distal*. 
```
distalProtrusion = distalPart.longestAxisExtent / distalPart.minorAxisExtent   // thin spike → high
                   × (distalCentroidDist / maxDimension)                       // far from grip → high
```
High `distalProtrusion` (>~3) + low `partCount` (1–2) ⇒ tip-flex; high `aspectRatio` (>3) across the whole model ⇒ whip; `flatSheetAxis≥0` ⇒ cloth/sign.

### 2. Decision-tree vs weighted-scoring — **recommendation: hybrid priority cascade**

**Recommend: a priority-ordered decision cascade for archetype SELECTION, with a small weighted-score sub-routine used only (a) inside the geometry-only tier and (b) to compute confidence.** Justification:

- The design doc already adjudicated *"deterministic rules over WeenieIndex + OntologyEntry; audit/override outliers; the classifier regenerates the auditable allowlist"* (§3.2, §Adjudicated-disagreements). A pure weighted-score model is **not auditable as a git diff** — the Phase-0 exit bar (round-trip `TREE_WIND_DIDS` exactly) demands a reproducible, inspectable rule, not a threshold sum.
- The in-tree precedent is **already a priority cascade with confidence bands** (`OntologyService.ClassifyCategoryByHeuristic`, `OntologyService.cs:577-637`): rules fire in priority order; boundary-straddling rules ramp confidence 0.5→1.0 inside a margin band and emit a human-readable `reason`. **Mirror it** — same vocabulary, same confidence shape — so consumers and trained agents stay valid.
- The dominant signals are **categorical hard facts** (DAT hook present, `WeaponType=Spear`), not continuous features that benefit from scoring. A cascade expresses these as 1.0-confidence early exits.
- **Where scoring earns its place:** the geometry-only tier (no weenie signal, the ~5% gap) and the *confidence number*. So scoring is a leaf, not the trunk.

**Two-stage output (critical):** the cascade picks **one primary archetype** (motion/shape bundle). Then an **independent additive pass** attaches **refiner components** (weathering/emissive/particle) via per-component predicates, because these *compose* (a sword = `rigid-glint` archetype **+** `weathering.tarnish` **+** `emissive.magicGlow` if enchanted). This matches the descriptor schema `{archetype, components[]}` and the component-interface slice (01) which composes them on one `_chainBeforeCompile` chain.

### 3. Classifier algorithm (pseudocode)

```csharp
VisualDescriptor Classify(FeatureVector f, RuleTable rules, OverrideMap overrides) {
  // ── stage -1: manual override wins outright ──
  if (overrides.TryGet(f.setupDid, out var ov))
      return ov with { source = "manual", confidence = 1.0 };

  // ── stage 0: DAT self-label (highest confidence, type 22/23/24) ──
  if (f.hookSetOmega)
      return Emit(f, "display-spin", ["procMotion.omegaSpin"], 1.0, "self-label:SetOmega", "A");
  if (f.hookTexVelocity)
      return Emit(f, "flow-scroll", ["texture.flowScroll"], 1.0, "self-label:TexVelocity", "frag");
  // hookCreateParticle / hookLuminous / hookScale → NOT a primary archetype, but a
  // COEXISTENCE flag (slice 14): suppress any suite component that would double-animate
  // the same channel. Recorded in signals[] + descriptor.datHooks[].

  string arch; string[] motion; double conf; string reason; string mech;

  // ── stage 1: WeaponType (exact, near-1.0; geometry may still refine tip-flex) ──
  switch (f.weaponType) {
    case Spear: case Staff:                          // tip-flex family
      (arch, motion, mech) = ("tip-flex", ["procMotion.tipFlex"], "B");
      conf = 0.95; reason = $"weaponType:{f.weaponType}";
      break;
    case Bow: case Crossbow:
      (arch, motion, mech) = ("bow-limb", ["procMotion.limbFlex","procMotion.stringHinge"], "B+A");
      conf = 0.95; reason = $"weaponType:{f.weaponType}"; break;
    case Sword: case Axe: case Mace: case Dagger: case TwoHanded:
      (arch, motion, mech) = ("rigid-glint", [], "frag");   // deformation = identity
      conf = 0.9;  reason = $"weaponType:{f.weaponType}"; break;
    case Magic:                                       // wand/orb caster
      (arch, motion, mech) = ("tip-flex", ["procMotion.tipFlex"], "B");
      conf = 0.7;  reason = "weaponType:Magic"; break;
    default:
      (arch, motion, conf, reason, mech) = (null, null, 0, null, null); break;
  }
  // AttackType REFINER (compound-safe, §5): if WeaponType said tip-flex but the weapon is
  // slash-only (no thrust bits) and shape is not thin-distal → demote to rigid-glint.
  if (arch == "tip-flex" && !ThrustCapable(f.attackType) && f.distalProtrusion < 2.5) {
    arch = "rigid-glint"; motion = []; mech = "frag"; conf = 0.7;
    reason += "+attackType:slash-only→rigid";
  }

  // ── stage 2: wind allowlist / foliage (reproduces TREE_WIND_DIDS) ──
  if (arch == null) {
    if (rules.WindAllowlist.Contains(f.setupDid)) {
      (arch, motion, conf, reason, mech) = ("trunk-canopy", ["procMotion.windBend"], 1.0,
                                            "allowlist:tree-wind", "A");
    } else if (f.dominantSurface == Foliage && f.partCount > 2) {
      // graceful: tall→trunk-canopy, short/whippy→plant-whip
      bool tall = f.aspectRatio >= 1.5 || f.maxDimension >= 4;
      arch  = tall ? "trunk-canopy" : "plant-whip";
      motion = tall ? ["procMotion.windBend"] : ["procMotion.organicWhip"];
      mech = "A"; reason = $"surface:Foliage+parts{f.partCount}";
      conf = Ramp(f.partCount, near:3, far:6);   // 0.5→1.0 band, like OntologyService
    }
  }

  // ── stage 3: ItemType + geometry (signs, hangers, levitators) ──
  if (arch == null) {
    if ((f.itemType & Misc) != 0 && f.inscription != null && f.flatSheetAxis >= 0)
      (arch,motion,conf,reason,mech) = ("sign-swing", ["procMotion.signSwing"], 0.8, "inscription+flat", "A");
    else if (f.flatSheetAxis >= 0 && f.dominantSurface == Cloth)
      (arch,motion,conf,reason,mech) = ("cloth-flutter", ["deformation.clothRipple"], 0.8, "flat+Cloth", "B");
    else if ((f.itemType & Creature) != 0)
      (arch,motion,conf,reason,mech) = ("idle-breath", ["procMotion.breathScale"], 0.6, "itemType:Creature", "B");
  }

  // ── stage 4: geometry-only fallback (the ~5% no-weenie gap) — SCORED ──
  if (arch == null)
    (arch, motion, conf, reason, mech) = ScoreGeometryArchetype(f);   // §3b

  // ── stage 5: default rigid (identity deformation) ──
  if (arch == null)
    (arch, motion, conf, reason, mech) = ("rigid", [], 0.6, "default:no-rule", "none");

  // ── ADDITIVE refiner components (compose; independent predicates) ──
  var comps = new List<string>(motion);
  comps.AddRange(RefinerComponents(f));     // §3c — weathering/emissive/particle

  // multi-weenie conflict penalty
  if (HasPrimaryTierConflict(f)) { conf -= 0.3; reason += $"|multi-weenie-conflict:{f.contributingWcids}"; }

  return Emit(f, arch, comps, clamp01(conf), reason, mech)
         with { source = (conf < rules.AuditThreshold ? "classifier-low" : "classifier") };
}
```

**§3b — `ScoreGeometryArchetype` (the only weighted-score leaf), mirrors `OntologyService.cs:577`:**
```
score(trunk-canopy) = w·[aspectRatio≥1.5] + w·[partCount>3] + w·[dominantSurface∈{Wood,Foliage}]
score(plant-whip)   = w·[aspectRatio≥3]   + w·[partCount≤4] + w·[dominantSurface=Foliage]
score(pendulum)     = w·[aspectRatio≥4]   + w·[partCount≥3 linear] (chains)
score(rigid)        = base 0.5
pick argmax; confidence = Ramp(margin between top-2 scores) → 0.5..0.9
reason = "geom-score:{arch}@{topScore:F2}"
```

**§3c — `RefinerComponents` (additive, each an independent predicate):**
```
if metalSurfaceOrMaterial(f)  && isWeapon(f.itemType)   → +weathering.tarnish      (cheap)
if f.dominantSurface == Metal && isWeapon(f.itemType)   → +emissive.glint          (cheap)
if isMetal(f.materialType==Iron)                        → +weathering.rust         (medium, REFINER, ~0.5% only)
if f.hasSpellDIDs                                        → +emissive.magicGlowAmbient + emissive.enchantShimmer
if f.itemType & (Jewelry|Gem) || isGemMaterial(f)       → +emissive.gemInnerFire   (medium)
if f.itemType & Creature                                → +emissive.eyeEmissive    (cheap)
if f.dominantSurface == Stone                           → +weathering.moss (audit-gated, region) 
// universal weatherables (wetness/frost) are GLOBAL-uniform, attached to ALL outdoor → not per-DID
```
Refiners NEVER override the primary archetype; they only append. Material-based refiners are tagged `confidence: lower` since MaterialType is present on only ~0.5% of weenies (GROUND-3) — **MaterialType is a refiner, never a gate** (adjudicated). When MaterialType is absent, fall back to `dominantSurface == Metal` from `surface_classify` (present for essentially all rendered objects).

### 4. Confidence model (mirror OntologyEntry/OntologyService exactly)

`OntologyEntry.Confidence` (`OntologyEntry.cs:48`) semantics, reused verbatim:

| Source | Confidence |
|---|---|
| DAT self-label hook (22/23/24) | **1.0** |
| Manual override | **1.0**, `source=manual` |
| Wind allowlist exact | **1.0** |
| WeaponType exact (Spear/Bow/Sword…) | **0.90–0.95** |
| Boundary/ramped (Foliage part-count band, geometry score margin) | **0.5→1.0** linear in band (`Ramp()`, identical to `OntologyService.cs:582-584`) |
| Categorical heuristic (sign/cloth/creature by ItemType) | **0.6–0.8** |
| Default rigid | **0.6** |
| Multi-weenie primary-tier conflict | **−0.3 penalty** |
| Degenerate (bounds failed / no geometry) | **0.0**, `source=BoundsFailed`-analogue |

Below `AuditThreshold` (default **0.6**) ⇒ `source=classifier-low`, routed to `vfx audit`. Each descriptor carries `signals[]` = the firing rule ids + the raw feature values (the auditable "feature vector dump" the `vfx classify` command returns, §6.2 of design doc).

### 5. Compound AttackType handling (166 / 160 / 486)

`AttackType` is a **`[Flags]` bitfield** (`ace-server/.../AttackType.cs:5`), so a single weapon carries multiple bits. **Never exact-match; always mask.** Decode of the examples:

| Value | Hex | Bits set | Meaning |
|---|---|---|---|
| 166 | 0xA6 | `Thrust(0x2)\|Slash(0x4)\|DoubleSlash(0x20)\|DoubleThrust(0x80)` | versatile slash+thrust, double multistrike → a sword |
| 160 | 0xA0 | `DoubleSlash(0x20)\|DoubleThrust(0x80)` | multistrike both modes, single bits absent → sword variant |
| 486 | 0x1E6 | `Thrust\|Slash\|DoubleSlash\|TripleSlash(0x40)\|DoubleThrust\|TripleThrust(0x100)` | versatile double+triple → two-handed/high-tier |

Classifier helpers (use ACE aggregate masks at `AttackType.cs:31-32`):
```
ThrustCapable(at) = (at & AttackType.Thrusts) != 0     // any thrust-family bit
SlashCapable(at)  = (at & AttackType.Slashes) != 0
Versatile(at)     = ThrustCapable(at) && SlashCapable(at)
```
**Role: refiner only, never selector.** WeaponType picks the family; AttackType disambiguates a *borderline* WeaponType:
- thrust-capable + thin-distal geometry → keep `tip-flex`;
- slash-only (`!ThrustCapable`) + compact geometry → demote to `rigid-glint` (most slashing swords don't visually flex);
- versatile (166/486) → **defer to WeaponType + geometry** (a versatile sword stays rigid-glint; a versatile spear stays tip-flex). This makes arbitrary compound values fall out of three mask tests — **no enum-per-value explosion**.

### Rule/score table — all ~28 archetypes

| # | Archetype | Selecting predicate (priority order) | Tier | Conf | Mech | Refiners often added |
|---|---|---|---|---|---|---|
| 9 | display-spin | `hookSetOmega` | 0 | 1.0 | A | — |
| 23 | flow-scroll | `hookTexVelocity (23/24)` | 0 | 1.0 | frag | — |
| 3 | tip-flex | `WeaponType∈{Spear,Staff}` OR `Magic`+thin; +thrust-capable | 1 | .95/.7 | B | glint, tarnish |
| 4 | bow-limb | `WeaponType∈{Bow,Crossbow}` | 1 | .95 | B+A | — |
| 13 | rigid-glint | `WeaponType∈{Sword,Axe,Mace,Dagger,TwoHanded}`; or tip-flex demote | 1 | .9 | frag | tarnish, magicGlow |
| 1 | trunk-canopy | `setupDid∈WindAllowlist`; or Foliage+parts+tall | 2 | 1.0/ramp | A | — |
| 2 | plant-whip | Foliage + short/whippy (`aspect<1.5`) | 2 | ramp | A/B | — |
| 8 | sign-swing | `Misc`+`inscription`+flatSheet | 3 | .8 | A | tarnish(metal) |
| 5 | cloth-flutter | flatSheet + `surface=Cloth` | 3 | .8 | B | clothFade |
| 6 | worn-garment | `ItemType&Clothing` + `surface=Cloth` + on body validLoc | 3 | .75 | B | clothFade |
| 7 | pendulum (chain/rope/lantern) | linear multi-part vertical, `aspect≥4`, hanging | 4(score) | .5-.9 | A/B | — |
| 10 | levitate-bob | `hasSpellDIDs` + small + `Jewelry/MagicWieldable` | 3 | .65 | tick | magicGlow, orbitMotes |
| 11 | idle-breath | `ItemType&Creature` (at-rest) | 3 | .6 | B | eyeEmissive, breathFog |
| 12 | soft-jiggle | `surface=Leather`/pouch geom, compact non-rigid | 4(score) | .55 | B | — |
| 14 | metal-tarnish/rust | refiner: metal surface/material + weapon/armor | refiner | — | frag | (rust if Iron) |
| 15 | magic-glow ambient | refiner: `anyLuminousSurface` OR `hasSpellDIDs` | refiner | — | frag | — |
| 16 | enchant-shimmer | refiner: `hasSpellDIDs` | refiner | — | frag | — |
| 17 | spell-school-aura | refiner: `hasSpellDIDs` + school resolvable | refiner(audit) | — | frag | — |
| 18 | glowing-runes | refiner: weapon/altar + rune surface (audit) | refiner(audit) | — | frag | — |
| 19 | gem-inner-fire | refiner: `ItemType&Gem` OR gem MaterialType | refiner | — | frag | — |
| 20 | value-tier-sheen | refiner: high `Value` PropInt | refiner | — | frag | — |
| 21 | glowing-eyes | refiner: `ItemType&Creature` | refiner | — | frag | — |
| 22 | holy/corrupt-tint | refiner: spell-school holy/corrupt (audit) | refiner(audit) | — | frag | — |
| 24 | flame-flicker | refiner: light-bearing static (brazier/torch surface=Lava/luminous) | refiner | — | light | embers |
| 25 | fire-particle | refiner: brazier/torch geom + flame-bowl part | refiner | — | particle | flame-flicker |
| 26 | foliage-ambient | refiner: `surface=Foliage` outdoor | refiner | — | particle | — |
| 27 | water-context | `surface=Water` (geometry-hard) | audit-only | manual | particle | — |
| 28 | dusty-indoor | refiner: indoor static (region gate) | refiner | — | particle+frag | — |
| — | rigid (default) | no rule matched | 5 | .6 | none | tarnish/glint if metal |

`water-context`, `glowing-runes`, `spell-school-aura`, `holy/corrupt`, overhang-drip are **audit-driven** (geometry-hard / state-dependent) — emitted with `source=classifier-low` so they land in `audit.csv`, never auto-applied day-zero (matches §3.2 "Outlier note").

### Audit / override file format

Two sidecars (independently versioned, mirror `.scenery.materials.json` precedent — §6.3):

**`visual_archetype_rules.jsonl`** — the regenerable rule seed (auditable git diff, the `TREE_WIND_DIDS` analogue):
```jsonc
{ "rule": "allowlist:tree-wind", "archetype": "trunk-canopy", "dids": ["0x02001063","0x02000258", ...] }
{ "rule": "weaponType:Spear",   "archetype": "tip-flex",    "selector": {"weaponType": 5} }
```

**`vfx_overrides.jsonl`** — hand authored, consumed at `stage -1` (wins outright):
```jsonc
{ "did": "0x02000724", "archetype": "tip-flex", "components": ["procMotion.tipFlex","emissive.glint"],
  "config": { "procMotion.tipFlex": { "ampDeg": 1.5, "gripAnchor": "holdingLoc" } },
  "reason": "atlan spear: geometry says rigid, curator overrides to tip-flex", "by": "salvia420" }
```

**`audit.csv`** — emitted by `vfx audit [<threshold>]`, one row per low-confidence/outlier DID:
```
did,archetype,confidence,reason,signals,contributingWcids,suggestedOverride
0x02000724,rigid,0.60,default:no-rule,"weaponType=null;distal=4.2;part=2",6253,tip-flex
```

---

## Integration seams (file:line)

- **New file:** `WorldBuilder.Terminal/CommandEngine.Vfx.cs` (sibling of `CommandEngine.SurfaceMaterials.cs`). Two-tier handler pattern per `CommandEngine.cs:26-28`; register in REPL dict `TerminalRepl.cs:83-215` and JSON dict `JsonCommandProcessor.cs:151-280` (slice 12 owns the verb surface; this slice supplies `_engine.VfxClassify(...)`).
- **Weenie props:** `AceDbConnector.LoadWeenieSnapshotAsync` `AceDbConnector.Weenie.cs:115`; scan `AceWeenieSnapshot.Ints` `AceWeenieSnapshot.cs:51`, `.SpellBookCount` `:64`, `.DataIds` `:56`.
- **Property keys:** `AceWeeniePropertyEnums.cs` ItemType=1, ValidLocations=9 (`:14`), AttackType=47 (`:52`), MaterialType=131 (`:136`), WeaponType=353 (`:358`).
- **Enums:** `WeaponType.cs:4-19`, `MaterialType.cs:3-83`, ACE `ItemType.cs` / `AttackType.cs` (`DatReaderWriter.Enums`).
- **Geometry:** `OntologyEntry.cs:24-61`; confidence/reason model `OntologyService.cs:577-637`; per-part bounds extend `OntologyService.ComputeSetupBounds` (`:346`).
- **DAT self-labels:** `setup_model.rs:334` holding_locations, `:346` default_animation; hook types `setup_model_hooks.rs:26-51`; frame hooks `setup_model.rs:295`.
- **Surface:** `surface_classify.rs:31` (categories), `:230` (`classify`); JS mirror `materials.js:138`.
- **Round-trip target:** `tree_wind.js:64` `TREE_WIND_DIDS`; rig math `wind_rig.js:59,98,113,149,199`.

---

## Edge cases & legacy-safety check (per THE RULE)

- **Classifier itself is offline & read-only** → trivially inside THE RULE: it reads DAT geometry/Surface, weenie DB props, DAT self-labels, surface category — all static/derived. It writes only JSON sidecars. It touches **no** wire value, physics/collision, or replicated state.
- **The components it assigns are bound by THE RULE at runtime** — the classifier must never emit a component that writes replicated state. Enforce by emitting only component ids present in the legacy-safe registry (slice 13 lint); reject unknown ids at export.
- **Shared-setup hazard:** one setup used by both weapon and prop weenies → conflict-flag + audit, never silently pick one.
- **MaterialType 0.5% sparsity:** never gate on it; fall back to `surface_classify` Metal/Stone/Wood. Verified: MaterialType absent on 99.5% of weenies (GROUND-3).
- **DAT-hook coexistence (slice 14):** `hookSetOmega/TexVelocity/Luminous/Scale/CreateParticle` recorded in `descriptor.datHooks[]`; the runtime must **defer** any suite component that animates the same channel (don't double-spin a windmill, don't double-scroll lava). Self-label archetypes (display-spin/flow-scroll) *are* the DAT animation surfaced, so no conflict there.
- **No light-count / cache-key impact:** the classifier emits per-component-SET keys (slice 01), never per-instance — it does not author `customProgramCacheKey`, so no shader-link explosion.
- **Classification runs on ORIGINAL DAT pixels** (not AI-upscaled) — upscaling changes `SurfaceStats` and would flip `surface_classify` (slice 16 constraint). The classifier reads the original Surface DIDs.

## GPU cost

Zero runtime GPU cost — the classifier is an **offline C# batch** emitting JSONL. Its only runtime footprint is the descriptor fetch the client already does for scenery (`{vfxBase}{did_hex}.vfx.jsonl`, mirrors `init_scenery_base_url`). The *components* it selects carry the GPU cost (owned by slices 04/05/07/09/11); the classifier's job is to **gate** them so `vfx gauge` (slice 11) stays <75% GPU at full Dereth — e.g. it must not assign `medium`/`expensive` components (POM, rust tex, heat-haze) by default, only behind audit/flags. Classifier batch runtime: O(2,763 setups) × (1 weenie-snapshot read + 1 ontology lookup + 1 default_animation hook scan) — seconds, offline.

## Build checklist

1. **Reverse index** — add `BuildSetupToWcidIndex()` inverting `WeenieIndex.Entries`/`TryGetSetup` (`WeenieIndex.cs:103,112`) → `Map<setupDid, List<wcid>>`; cache alongside `weenie_index.jsonl`.
2. **FeatureVector struct** + `ExtractFeatures(setupDid)` — union weenie props from `LoadWeenieSnapshotAsync` over contributing wcids; pull geometry from `OntologyEntry`; add conflict detection.
3. **Per-part / distal extraction** — port `wind_rig.js buildBboxRig` (`:113`) + `partBBox` (`:59`) to C# (shared with `vfx anchor-parts`); extend `ComputeSetupBounds` (`OntologyService.cs:346`) to retain per-part boxes; compute `distalProtrusion`, `compactness`, `flatSheetAxis`, `hasHoldingLoc`.
4. **DAT self-label scan** — resolve `setup.default_animation` (`setup_model.rs:346`) → Animation → scan `AnimationFrame.hooks` (`:295`) for types 22/23/24/13/8/9/12 (`setup_model_hooks.rs:26-51`); surface a C# accessor (WASM/DatReaderWriter parse) → set `hookSetOmega` etc.
5. **Surface category** — per `OntologyEntry.SurfaceIds` (`:64`) call `surface_classify::classify` (`:230`); compute `dominantSurface`, `anyLuminousSurface`.
6. **AttackType masks** — implement `ThrustCapable/SlashCapable/Versatile` using ACE aggregate masks (`AttackType.cs:31-32`); unit-test 166/160/486 decode.
7. **Confidence `Ramp()`** — copy the band formula from `OntologyService.cs:582-584`.
8. **Cascade `Classify()`** — implement stages −1…5 exactly as §3; `ScoreGeometryArchetype` (§3b); `RefinerComponents` (§3c).
9. **Rule table** — encode the ~28-row table (§rule/score table) as data (`visual_archetype_rules.jsonl`) so the cascade is regenerable, not hardcoded; seed `WindAllowlist` from `TREE_WIND_DIDS` (`tree_wind.js:64`).
10. **Override + audit I/O** — load `vfx_overrides.jsonl` at stage −1; emit `audit.csv` for confidence < `AuditThreshold` (0.6); emit `signals[]` feature dump per descriptor.
11. **Emit `visual_descriptors.jsonl`** — `{did, archetype, components[], config, confidence, source, signals[], datHooks[]}`, camelCase null-ignoring `JsonOpts` (mirror `WeenieIndex.cs:122-125`).
12. **Round-trip test (Phase-0 exit bar)** — assert the 3-archetype classifier (`trunk-canopy` + `rigid-glint` + `tip-flex`) regenerates `TREE_WIND_DIDS` byte-for-byte via `emit-allowlist trunk-canopy`; assert `vfx classify 0x02000258 → trunk-canopy@1.0` and `0x02000724 → tip-flex` (after override).
13. **Legacy-safety gate** — at export, reject any component id not in the slice-13 legacy-safe registry.
