// CMT Wave 11 / Phase 34 (2026-05-26) — PlayEffect placeholder VFX.
// CMT Wave 12 / Phase 37 (2026-05-26) — extended coverage for the
// highest-impact remaining PlayScript IDs (Splatter, Spark, Health*,
// Shield*, Death/Destroy, Fizzle).
// CMT Wave 15 / Phase 47 (2026-05-26) — another batch of family
// coverage: Attrib* up/down (12 IDs), Skill* up/down (14 IDs incl
// SkillDownBlack + SkillDownVoid), Enchant* up/down (16 IDs incl
// Grey/White variants), Hide/UnHide/Hidden (3 IDs), PortalEntry/Exit/
// Storm (3 IDs), Camping Mastery/Ineptitude (2 IDs), LayingofHands
// (1 ID). 51 additional IDs → 101/174 shipped, ~73 still TODO.
// CMT Wave 18 / Phase 54 (2026-05-26) — final batch covering the
// remaining gameplay-broadcast IDs: Breathe (4), SpecialState numeric
// (10) + colors (8), Regen up/down (7 incl RegenDownVoid),
// Vitae/Vision/Trans (6), SwapHealth (6), Dispel (3), Restriction (3),
// Augmentation (4), Aetheria (6), Wedding (2), DirtyFighting (4),
// plus 6 standalones (Create 0x58, ProjectileCollision 0x5A,
// LevelUp 0x8A, BunnySmite 0x95, BaelZharonSmite 0x96, BlackMadness
// 0xA0). 69 additional IDs → 170/174 shipped, 4 sentinels remain
// (Invalid + Test1-3, never broadcast in gameplay). Mandate priority-3
// IDs that DON'T exist in ACE's enum (HoldUpAttack/HoldDownAttack/
// AttackHook/HealthRing/HealthBlob/CleavePhys/CleaveSpark) are
// intentionally omitted — no wire event = no dispatch needed.
// CMT Wave 17 / Phase 51 (2026-05-26) — REAL retail VFX via the
// PhysicsScriptTable resolver chain. Wired BEFORE the placeholder
// fallthrough so any entity with a `physicsScriptTableDid` (0x34xxxx)
// + a matching PScriptType row in the table gets the real Sky-J-style
// particle emitter (`fetchPhysicsScript → CreateParticleHook →
// fetchParticleEmitter → ParticleManager.addEmitter`). Placeholders
// remain as the fallback path for entities without a table, scriptIds
// not in the table, or any resolver-chain failure. Phase 53 plumbs
// the `speed` field as the picker's mod-weight (was discarded prior).
//
// Self-registering Three.js module that subscribes to `playEffect`
// events on `window.__pluginClient.events` and spawns minimal
// geometry bursts at the target entity's position. Phase 34 covered:
//
//   - `PLAY_SCRIPT.Launch  (0x04)` — small additive-blend sphere,
//     blue-cyan, ~0.4m radius, fades over 500ms.
//   - `PLAY_SCRIPT.Explode (0x05)` — larger additive-blend sphere,
//     yellow-orange, ~1.2m radius, fades over 500ms.
//
// Phase 37 (Wave 12) extends with placeholder visuals for the
// combat-visible families (~48 additional IDs):
//
//   - Splatter family (0x5B-0x66, 12 IDs) — red sphere on hit.
//   - Spark family (0x67-0x72, 12 IDs) — tiny white sparkle.
//   - Health* family (0x1F-0x24 + 0xA7, 7 IDs) — green for *Up*
//     (heal), dim red for *Down*/*Void* (damage flash).
//   - Shield* family (0x2B-0x38, 14 IDs) — blue TorusGeometry ring
//     with rotation, for defensive-buff variety.
//   - Death (Destroy 0x59, DisappearDestroy 0x77) — large dark
//     purple expanding sphere.
//   - Fizzle (0x51) — brief gray puff for failed cast.
//
// All other (~122) PlayScript IDs continue to TODO-log via
// `console.debug` for future verticals. See `ui/ac_play_script.js`
// for the full 174-entry enum mirror, and the `VFX_COVERAGE` export
// below for the authoritative shipped-vs-TODO set.
//
// **Scope.** Real AC VFX uses `0x33 PhysicsScript` particle systems
// (see `scene3d/particles/particle.js` for the ACE-correct runtime
// already in the codebase). Phase 34 ships **placeholder visuals
// only** so the wire-to-render path is end-to-end verifiable. A
// future "PlayScript → PhysicsScript ID resolution + ParticleManager
// dispatch" vertical can swap the bursts here for the real
// retail-fidelity emitters.
//
// **Self-cleanup.** Each spawned burst tracks its own scale/opacity
// tween via `requestAnimationFrame`. On fade completion the mesh is
// removed from its parent group, the `THREE.SphereGeometry` and
// `THREE.MeshBasicMaterial` are `dispose()`-ed, and the active-bursts
// list entry is dropped. No memory leak even under sustained Launch/
// Explode storms.
//
// **Wire chain (proof of end-to-end connectivity):**
//
//   1. ACE broadcasts `GameMessageScript(target, script_id, speed)`
//      (opcode `0xF755 = PlayEffect`).
//   2. `crates/holtburger-protocol/src/messages/effects/types.rs`
//      decodes into `PlayEffectData`.
//   3. `crates/holtburger-world/src/handlers/system.rs:25` matches
//      on `GameMessage::PlayEffect(data)` and pushes
//      `WorldEvent::PlayEffect { target, script_id, speed }`.
//   4. `apps/holtburger-web/src/lib.rs` (WorldEvent dispatch arm —
//      paired with `EntityVisibilityChanged`) bridges to a
//      `ClientEvent { kind: 30 = CLIENT_EVENT_KIND_PLAY_EFFECT,
//      u32_payload: target, u32_payload_2: script_id, f32_payload:
//      speed }`.
//   5. `apps/holtburger-web/index.html`'s `drainEvents` loop dispatches
//      `evt.kind === 30` into `window.__pluginClient.events.emit(
//      "playEffect", { targetGuid, scriptId, speed })`.
//   6. This module's listener (registered on import below) resolves
//      the target entity's world position via
//      `liveScene3d.entityManager.entityMap.get(targetGuid)?.root?.position`
//      and spawns the burst mesh.

import * as THREE from "three";
import { PLAY_SCRIPT, playScriptName } from "../ui/ac_play_script.js";
import { fetchPhysicsScriptTable } from "../ui/ac_physics_script_table.js";

// Default tween duration in ms (Launch/Explode). ~500ms keeps the
// visual on-screen long enough to be perceptible but short enough
// that high-rate scripts (e.g. Splatter family during sustained
// combat) don't visually overlap. Phase 37 added per-burst duration
// overrides on `_spawnBurst`/`_spawnRingBurst` for visuals that need
// to be shorter (Spark/Splatter — fire frequently) or longer (Death
// — major one-shot event).
const TWEEN_DURATION_MS = 500;

// =====================================================================
// Phase 37 — family ID sets.
// =====================================================================
// ACE's PlayScript enum carries family clusters (Splatter has 12 IDs
// for 4 quadrants × 3 heights; Shield has 14 IDs for 7 colors × up/
// down; etc.). Rather than write a switch arm per ID, we collapse each
// family into a single arm + a Set membership test. This keeps the
// dispatch concise + matches the placeholder-scope mandate (we don't
// distinguish e.g. SplatterLowLeftBack vs SplatterUpRightFront — both
// read as "damage hit"; the directional variants are a PhysicsScript-
// port concern, out of scope).

// Splatter family — 12 IDs, 0x5B-0x66 contiguous.
// Visual: red sphere on the damaged entity (universal damage cue).
const _SPLATTER_IDS = new Set([
  PLAY_SCRIPT.SplatterLowLeftBack, PLAY_SCRIPT.SplatterLowLeftFront,
  PLAY_SCRIPT.SplatterLowRightBack, PLAY_SCRIPT.SplatterLowRightFront,
  PLAY_SCRIPT.SplatterMidLeftBack, PLAY_SCRIPT.SplatterMidLeftFront,
  PLAY_SCRIPT.SplatterMidRightBack, PLAY_SCRIPT.SplatterMidRightFront,
  PLAY_SCRIPT.SplatterUpLeftBack, PLAY_SCRIPT.SplatterUpLeftFront,
  PLAY_SCRIPT.SplatterUpRightBack, PLAY_SCRIPT.SplatterUpRightFront,
]);

// Spark family — 12 IDs, 0x67-0x72 contiguous. Same directional
// taxonomy as Splatter but represents minor/mana cues (small white).
const _SPARK_IDS = new Set([
  PLAY_SCRIPT.SparkLowLeftBack, PLAY_SCRIPT.SparkLowLeftFront,
  PLAY_SCRIPT.SparkLowRightBack, PLAY_SCRIPT.SparkLowRightFront,
  PLAY_SCRIPT.SparkMidLeftBack, PLAY_SCRIPT.SparkMidLeftFront,
  PLAY_SCRIPT.SparkMidRightBack, PLAY_SCRIPT.SparkMidRightFront,
  PLAY_SCRIPT.SparkUpLeftBack, PLAY_SCRIPT.SparkUpLeftFront,
  PLAY_SCRIPT.SparkUpRightBack, PLAY_SCRIPT.SparkUpRightFront,
]);

// Health* heal scripts ("Up" — gaining HP / healing applied). Cyan-
// green is the universal healing color (matches retail UI's HP-bar
// recovery flash + standard fantasy-RPG convention).
const _HEALTH_UP_IDS = new Set([
  PLAY_SCRIPT.HealthUpRed, PLAY_SCRIPT.HealthUpBlue, PLAY_SCRIPT.HealthUpYellow,
]);

// Health* damage scripts ("Down" — losing HP / damage tick). Dim red
// instead of bright red so it's distinct from Splatter (which is the
// per-hit splash) — Down* often fires for ongoing DoT effects.
// HealthDownVoid (0xA7) is in the late-additions cluster but has the
// same gameplay semantic, so it gets the same color.
const _HEALTH_DOWN_IDS = new Set([
  PLAY_SCRIPT.HealthDownRed, PLAY_SCRIPT.HealthDownBlue,
  PLAY_SCRIPT.HealthDownYellow, PLAY_SCRIPT.HealthDownVoid,
]);

// Shield family — 14 IDs, 0x2B-0x38 (Red/Orange/Yellow/Green/Blue/
// Purple/Grey × Up/Down). All collapsed to one blue ring; per-color
// fidelity is a PhysicsScript port concern.
const _SHIELD_IDS = new Set([
  PLAY_SCRIPT.ShieldUpRed, PLAY_SCRIPT.ShieldDownRed,
  PLAY_SCRIPT.ShieldUpOrange, PLAY_SCRIPT.ShieldDownOrange,
  PLAY_SCRIPT.ShieldUpYellow, PLAY_SCRIPT.ShieldDownYellow,
  PLAY_SCRIPT.ShieldUpGreen, PLAY_SCRIPT.ShieldDownGreen,
  PLAY_SCRIPT.ShieldUpBlue, PLAY_SCRIPT.ShieldDownBlue,
  PLAY_SCRIPT.ShieldUpPurple, PLAY_SCRIPT.ShieldDownPurple,
  PLAY_SCRIPT.ShieldUpGrey, PLAY_SCRIPT.ShieldDownGrey,
]);

// Death — the AC enum has no literal `Death` entry; the canonical
// "entity is dying/being destroyed" cue is `Destroy (0x59)`. The
// adjacent `DisappearDestroy (0x77)` is a related "vanish + destroy"
// flavor (often used for despawn after timeout). Both get the dark-
// purple expanding sphere so the player gets visual closure when a
// remote entity drops.
const _DEATH_IDS = new Set([
  PLAY_SCRIPT.Destroy, PLAY_SCRIPT.DisappearDestroy,
]);

// =====================================================================
// Phase 47 — additional family ID sets (Wave 15).
// =====================================================================
// Same Set-membership pattern as Phase 37. Each cluster maps a color/
// up-down semantic to a single visual treatment; per-color (Red/Orange/
// Yellow/...) directional fidelity is a PhysicsScript port concern and
// stays out of scope here.

// AttribUp family (0x06-0x10 every-other-even) — buff applied to a
// primary attribute (Strength/Endurance/Coordination/Quickness/Focus/
// Self). Six color variants in ACE but all read as "stat buff" — green-
// yellow `0xc8ff44` is the positive-change cue (matches HUD level-up
// flash convention; green = beneficial in nearly every RPG).
const _ATTRIB_UP_IDS = new Set([
  PLAY_SCRIPT.AttribUpRed, PLAY_SCRIPT.AttribUpOrange,
  PLAY_SCRIPT.AttribUpYellow, PLAY_SCRIPT.AttribUpGreen,
  PLAY_SCRIPT.AttribUpBlue, PLAY_SCRIPT.AttribUpPurple,
]);

// AttribDown family (0x07-0x11 every-other-odd) — debuff applied to a
// primary attribute. Six color variants collapse to red-orange
// `0xff6633` (negative-change cue; distinct from Splatter's brighter
// pure-red and HealthDown's dim red so the player can tell "your stat
// was reduced" from "you took a hit").
const _ATTRIB_DOWN_IDS = new Set([
  PLAY_SCRIPT.AttribDownRed, PLAY_SCRIPT.AttribDownOrange,
  PLAY_SCRIPT.AttribDownYellow, PLAY_SCRIPT.AttribDownGreen,
  PLAY_SCRIPT.AttribDownBlue, PLAY_SCRIPT.AttribDownPurple,
]);

// SkillUp family (0x12-0x1C every-other-even) — buff applied to a
// skill. Same green-yellow palette as Attrib so the player learns one
// "stat went up" color, but uses a small cube (via _spawnCubeBurst) so
// they get geometric distinction between attribute vs skill changes —
// attributes are "core" (sphere), skills are "trained" (cube).
const _SKILL_UP_IDS = new Set([
  PLAY_SCRIPT.SkillUpRed, PLAY_SCRIPT.SkillUpOrange,
  PLAY_SCRIPT.SkillUpYellow, PLAY_SCRIPT.SkillUpGreen,
  PLAY_SCRIPT.SkillUpBlue, PLAY_SCRIPT.SkillUpPurple,
]);

// SkillDown family — debuff applied to a skill. Includes the two extra
// late-additions in the enum: `SkillDownBlack (0x1E)` (the seventh
// "color" — only present in Down direction, no SkillUpBlack exists)
// and `SkillDownVoid (0xA9)` from the Void cluster (gameplay-equivalent
// to the regular skill debuff per ACE source). All collapse to the red-
// orange Attrib-down color.
const _SKILL_DOWN_IDS = new Set([
  PLAY_SCRIPT.SkillDownRed, PLAY_SCRIPT.SkillDownOrange,
  PLAY_SCRIPT.SkillDownYellow, PLAY_SCRIPT.SkillDownGreen,
  PLAY_SCRIPT.SkillDownBlue, PLAY_SCRIPT.SkillDownPurple,
  PLAY_SCRIPT.SkillDownBlack, PLAY_SCRIPT.SkillDownVoid,
]);

// EnchantUp family — enchantment applied (spell buff). 0x39-0x43
// covers the 6 color cycle; 0x8B (EnchantUpGrey) and 0x8E
// (EnchantUpWhite) are late-additions for two additional palette
// slots ACE added for late-Throne-of-Destiny enchantments. All collapse
// to a gold `0xffd966` brief flash (gold = magical-aura convention).
const _ENCHANT_UP_IDS = new Set([
  PLAY_SCRIPT.EnchantUpRed, PLAY_SCRIPT.EnchantUpOrange,
  PLAY_SCRIPT.EnchantUpYellow, PLAY_SCRIPT.EnchantUpGreen,
  PLAY_SCRIPT.EnchantUpBlue, PLAY_SCRIPT.EnchantUpPurple,
  PLAY_SCRIPT.EnchantUpGrey, PLAY_SCRIPT.EnchantUpWhite,
]);

// EnchantDown family — enchantment expired / dispelled. Same 8-color
// layout as EnchantUp. Muted purple `0x9966dd` (de-magic / fade-out
// convention; distinct from EnchantUp's gold so dispel reads
// differently from apply at a glance).
const _ENCHANT_DOWN_IDS = new Set([
  PLAY_SCRIPT.EnchantDownRed, PLAY_SCRIPT.EnchantDownOrange,
  PLAY_SCRIPT.EnchantDownYellow, PLAY_SCRIPT.EnchantDownGreen,
  PLAY_SCRIPT.EnchantDownBlue, PLAY_SCRIPT.EnchantDownPurple,
  PLAY_SCRIPT.EnchantDownGrey, PLAY_SCRIPT.EnchantDownWhite,
]);

// Camping family — `CampingMastery (0x90)` + `CampingIneptitude (0x91)`.
// "Camping" in AC = the temporary "resting" buff/debuff when standing
// still long enough (skill-grade affects which side fires). Gentle
// cyan slow pulse (`_CALM_COLOR` 0x88ddff) — peaceful / restful cue.
const _CAMPING_IDS = new Set([
  PLAY_SCRIPT.CampingMastery, PLAY_SCRIPT.CampingIneptitude,
]);

// Portal family — PortalEntry (0x52) / PortalExit (0x53) / PortalStorm
// (0x73). PortalStorm is the "you got recalled" atmospheric flash; the
// other two are per-traversal cues. All three get the bright purple
// expanding-sphere treatment, with per-script scale/duration tuning in
// the dispatch (Entry: expanding 0.3→2.0/600ms, Exit: contracting
// 2.0→0.3/600ms, Storm: bright white burst 0.5→1.5/500ms).
//
// Storm is grouped here because it's portal-related semantically, but
// we don't bundle it into a single arm — see the dispatch for per-ID
// branching.
const _PORTAL_FAMILY_IDS = new Set([
  PLAY_SCRIPT.PortalEntry, PLAY_SCRIPT.PortalExit, PLAY_SCRIPT.PortalStorm,
]);

// =====================================================================
// Phase 54 — additional family ID sets (Wave 18).
// =====================================================================
// Same Set-membership pattern as Phase 37/47. Each family collapses one
// gameplay-domain cluster to a single visual treatment. Hard constraint:
// only IDs that EXIST in `PLAY_SCRIPT` (verified against the 0x00–0xAD
// enum). Priority-3 candidates from the mandate that DON'T exist in ACE
// (HoldUpAttack, HoldDownAttack, AttackHook, HealthRing, HealthBlob,
// CleavePhys, CleaveSpark) are intentionally OMITTED — no enum entry =
// no wire event = no dispatch needed.

// Breathe family — 0x54-0x57 contiguous. Drudge/Tusker/dragon-class
// breath weapons. Four IDs, four colors per the mandate (orange flame,
// cyan frost, green acid, blue-white lightning). Each gets its own
// dispatch arm with a unique color (NOT collapsed to one Set arm) so
// the player can tell at a glance which element just hit them. Set is
// only used for the membership test; per-ID color selection happens
// in the dispatch.
const _BREATHE_IDS = new Set([
  PLAY_SCRIPT.BreatheFlame, PLAY_SCRIPT.BreatheFrost,
  PLAY_SCRIPT.BreatheAcid, PLAY_SCRIPT.BreatheLightning,
]);

// SpecialState1-9 + SpecialState0 — 0x78-0x81 (10 IDs). Generic game-
// mechanic state cues with no fixed semantic in ACE (used for varied
// "this entity is in special state N" broadcasts). 9-color palette
// cycle (pale red → orange → yellow → green → cyan → blue → indigo →
// violet → white; state0 = white shared with state9 as a tail). Brief
// 250ms quick flash matches the mandate's "state cue" duration call.
const _SPECIAL_STATE_NUMERIC_IDS = new Set([
  PLAY_SCRIPT.SpecialState1, PLAY_SCRIPT.SpecialState2, PLAY_SCRIPT.SpecialState3,
  PLAY_SCRIPT.SpecialState4, PLAY_SCRIPT.SpecialState5, PLAY_SCRIPT.SpecialState6,
  PLAY_SCRIPT.SpecialState7, PLAY_SCRIPT.SpecialState8, PLAY_SCRIPT.SpecialState9,
  PLAY_SCRIPT.SpecialState0,
]);

// SpecialState color variants — 0x82-0x89 (8 IDs). Named-color state
// cues that complement the numeric ones. Each gets a sphere matching
// its named color so the visual treatment is faithful to the name.
// Same 250ms duration as the numeric variants.
const _SPECIAL_STATE_COLOR_IDS = new Set([
  PLAY_SCRIPT.SpecialStateRed, PLAY_SCRIPT.SpecialStateOrange,
  PLAY_SCRIPT.SpecialStateYellow, PLAY_SCRIPT.SpecialStateGreen,
  PLAY_SCRIPT.SpecialStateBlue, PLAY_SCRIPT.SpecialStatePurple,
  PLAY_SCRIPT.SpecialStateWhite, PLAY_SCRIPT.SpecialStateBlack,
]);

// Regen family — 0x25-0x2A (6 IDs) + RegenDownVoid 0xA8. Periodic
// HP/Stam/Mana regen ticks. Up variants = positive green flash, Down
// variants = dim-red drain (matches Health up/down convention but
// with smaller scale + faster duration since regen fires per-tick on
// every regen-enchanted entity). RegenDownVoid (Void-cluster late-
// addition) is gameplay-equivalent to a normal regen debuff.
const _REGEN_UP_IDS = new Set([
  PLAY_SCRIPT.RegenUpRed, PLAY_SCRIPT.RegenUpBlue, PLAY_SCRIPT.RegenUpYellow,
]);
const _REGEN_DOWN_IDS = new Set([
  // Note: `RegenDownREd` (the 0x26 entry) preserves the ACE typo from
  // the C# source — kept exactly as in the enum so the lookup matches.
  PLAY_SCRIPT.RegenDownREd, PLAY_SCRIPT.RegenDownBlue,
  PLAY_SCRIPT.RegenDownYellow, PLAY_SCRIPT.RegenDownVoid,
]);

// Vitae/Vision/Trans Up/Down — 0x45-0x48 + 0x4F/0x50. White/Black
// cosmic-cluster cues (Vitae = death penalty, Vision = enchanted
// sight, Trans = transcendence/Asheron's-Gift-class buffs). Up =
// bright white (positive cosmic), Down = deep black (negative cosmic).
// Death-camp purple palette would conflict with Destroy, so we go
// pure white-vs-near-black to keep these visually distinct.
const _VITAE_VISION_TRANS_UP_IDS = new Set([
  PLAY_SCRIPT.VitaeUpWhite, PLAY_SCRIPT.VisionUpWhite, PLAY_SCRIPT.TransUpWhite,
]);
const _VITAE_VISION_TRANS_DOWN_IDS = new Set([
  PLAY_SCRIPT.VitaeDownBlack, PLAY_SCRIPT.VisionDownBlack, PLAY_SCRIPT.TransDownBlack,
]);

// SwapHealth family — 0x49-0x4E (6 IDs). The bizarre "swap one vital
// stat for another" cues (Red ↔ Yellow, Red ↔ Blue, Yellow ↔ Blue —
// HP/Stam/Mana). All collapse to a single magenta `0xff44dd` swirl
// since the visual semantic is just "vital pool transfer happened"
// — directional fidelity isn't useful at the placeholder layer.
const _SWAP_HEALTH_IDS = new Set([
  PLAY_SCRIPT.SwapHealth_Red_To_Yellow, PLAY_SCRIPT.SwapHealth_Red_To_Blue,
  PLAY_SCRIPT.SwapHealth_Yellow_To_Red, PLAY_SCRIPT.SwapHealth_Yellow_To_Blue,
  PLAY_SCRIPT.SwapHealth_Blue_To_Red, PLAY_SCRIPT.SwapHealth_Blue_To_Yellow,
]);

// Dispel family — 0x92-0x94 (3 IDs). DispelLife/Creature/All. All
// three collapse to a muted gray-violet `0xaa99cc` ring (TorusGeometry
// like Shield, since "ward removal" is conceptually a defensive cue
// running in reverse). Faster 350ms — dispels are common; long bursts
// would clutter the screen during high-magic combat.
const _DISPEL_IDS = new Set([
  PLAY_SCRIPT.DispelLife, PLAY_SCRIPT.DispelCreature, PLAY_SCRIPT.DispelAll,
]);

// Restriction family — 0x98-0x9A (3 IDs). RestrictionEffectBlue/Green/
// Gold. Per-color sphere matching the named color so the player can
// tell which restriction zone they're in (blue=PvP, green=Olthoi, gold
// = arena-style typical mappings). 500ms.
const _RESTRICTION_IDS = new Set([
  PLAY_SCRIPT.RestrictionEffectBlue, PLAY_SCRIPT.RestrictionEffectGreen,
  PLAY_SCRIPT.RestrictionEffectGold,
]);

// Augmentation family — 0x9C-0x9F (4 IDs). AugmentationUseAttribute/
// Skill/Resistances/Other — the throne-of-destiny "augmentation gem
// used" cues. All collapse to a brilliant gold `0xffcc33` celebratory
// burst — augmentations are major character-progression events;
// permanent stat boosts; gold = "you just got something significant".
// Long 800ms + large 0.4→1.5 scale, similar to Death's footprint but
// in gold instead of purple.
const _AUGMENTATION_IDS = new Set([
  PLAY_SCRIPT.AugmentationUseAttribute, PLAY_SCRIPT.AugmentationUseSkill,
  PLAY_SCRIPT.AugmentationUseResistances, PLAY_SCRIPT.AugmentationUseOther,
]);

// Aetheria family — 0xA1-0xA6 (6 IDs). AetheriaLevelUp + 5x Surge
// variants (Destruction/Protection/Regeneration/Affliction/Festering).
// Aetheria = the colored-gem socketable items added late in retail.
// Surges are random procs from socketed Aetheria. Each Surge gets a
// distinct color matching its gameplay role:
//   - SurgeDestruction = orange (damage)
//   - SurgeProtection  = blue (defense)
//   - SurgeRegeneration = green (heal)
//   - SurgeAffliction  = sickly green-yellow (DoT)
//   - SurgeFestering   = bruised purple (DoT decay)
// AetheriaLevelUp = pure white celebratory burst (rarer than Surges).
const _AETHERIA_IDS = new Set([
  PLAY_SCRIPT.AetheriaLevelUp,
  PLAY_SCRIPT.AetheriaSurgeDestruction, PLAY_SCRIPT.AetheriaSurgeProtection,
  PLAY_SCRIPT.AetheriaSurgeRegeneration, PLAY_SCRIPT.AetheriaSurgeAffliction,
  PLAY_SCRIPT.AetheriaSurgeFestering,
]);

// Wedding family — 0x8D WeddingBliss + 0x97 WeddingSteele. AC's
// player-marriage event cues (Bliss = the marriage spell;
// Steele = the wedding-band item). Pink heart palette `0xff66cc`.
// Long-ish 700ms — weddings are rare; players appreciate the visual.
const _WEDDING_IDS = new Set([
  PLAY_SCRIPT.WeddingBliss, PLAY_SCRIPT.WeddingSteele,
]);

// DirtyFighting family — 0xAA-0xAD (4 IDs). Late-additions cluster
// for the Dirty Fighting skill's debuff cues (Heal/Attack/Defense/
// DamageOverTime debuffs). All four are gameplay-debuffs; muted
// brown-red `0x884444` cube (cube to distinguish from generic Splatter
// red — Dirty Fighting hits are special-skill, not raw damage). 400ms.
const _DIRTY_FIGHTING_IDS = new Set([
  PLAY_SCRIPT.DirtyFightingHealDebuff, PLAY_SCRIPT.DirtyFightingAttackDebuff,
  PLAY_SCRIPT.DirtyFightingDefenseDebuff, PLAY_SCRIPT.DirtyFightingDamageOverTime,
]);

// Active burst registry — drives both per-frame tween updates and
// the cleanup on completion. Each entry holds the mesh + start time
// + scale-from/to + parent group reference so we can detach + dispose
// when the tween finishes.
//
// Keyed by an opaque numeric handle so cleanup can skip-iterate. We
// don't need ordered iteration; a Map keeps insert/delete O(1). A Map
// preserves insertion order, so the FIFO overflow drop (RP6 lever 2)
// can evict the OLDEST active burst via `_activeBursts.keys().next()`.
const _activeBursts = new Map();
let _nextHandle = 1;

// =====================================================================
// RP6 (2026-06-08) — placeholder-burst pooling + concurrent caps.
// =====================================================================
// The three placeholder burst helpers (_spawnBurst / _spawnRingBurst /
// _spawnCubeBurst) previously allocated a FRESH geometry + material +
// mesh per burst and disposed all three on tween-complete. Under a
// combat storm (Splatter/Spark fire per-hit) that is a churn of dozens
// of GPU buffer allocs+frees per second.
//
// RP6 pools by burst SHAPE. The geometry of each shape is identical
// across every burst (only `mesh.scale` / `material` vary), so we keep
// ONE shared, never-disposed geometry per shape and a free-list of
// reusable {mesh, material} pairs. On reuse the mesh + material are
// FULLY reset (position, scale, rotation, opacity, color, blending,
// side, renderOrder, parent, visible) so no stale state carries over.
//
// Pool size is bounded — if the free-list is full on release we let
// that pair fall through to real disposal (so a transient storm can't
// pin unbounded GPU memory in the pool either).
const _BURST_SHAPE = { SPHERE: 0, RING: 1, CUBE: 2 };
// Per-shape shared geometry, lazily built on first use (so importing
// the module in a non-WebGL / SSR test context doesn't allocate GPU
// buffers eagerly). Never disposed.
const _sharedGeometry = [null, null, null];
function _getSharedGeometry(shape) {
  let g = _sharedGeometry[shape];
  if (g) return g;
  if (shape === _BURST_SHAPE.SPHERE) {
    g = new THREE.SphereGeometry(1.0, 16, 12);
  } else if (shape === _BURST_SHAPE.RING) {
    // Same params as the pre-pool _spawnRingBurst torus.
    g = new THREE.TorusGeometry(0.5, 0.05, 12, 24);
  } else {
    g = new THREE.BoxGeometry(1, 1, 1);
  }
  _sharedGeometry[shape] = g;
  return g;
}
// Free-lists of reusable meshes per shape. Each holds detached meshes
// (removed from parent, invisible) whose material is reset on re-acquire.
const _burstPool = [[], [], []];
// Cap the pooled idle meshes per shape. Beyond this, released meshes
// are really disposed rather than retained.
const _BURST_POOL_MAX = 24;

/**
 * Acquire a burst mesh of `shape`, applying all per-burst properties.
 * Reuses a pooled mesh+material when available; otherwise allocates one
 * around the shared geometry. The returned mesh is fully reset — no
 * stale position/scale/rotation/opacity/parent from a prior burst.
 *
 * `side` differs per shape (sphere/cube = FrontSide, ring = DoubleSide),
 * so it's passed explicitly to keep the reset complete.
 */
function _acquireBurstMesh(shape, parent, position, scaleFrom, color, side) {
  const pool = _burstPool[shape];
  let mesh = pool.pop() || null;
  if (mesh) {
    // Reuse: reset material + transform fully.
    const mat = mesh.material;
    mat.color.set(color);
    mat.opacity = 1.0;
    mat.transparent = true;
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
    mat.side = side;
    // RP6 (2026-06-08): do NOT set `mat.needsUpdate = true` here. For a
    // MeshBasicMaterial, color/opacity are plain uniforms that update
    // without a recompile, and transparent/blending/depthWrite are
    // render-state (not program-cache keys). `side` is constant per shape
    // pool (sphere/cube=FrontSide, ring=DoubleSide) and each shape has its
    // OWN pool, so the program-cache key never changes across reuses.
    // Setting needsUpdate would bump material.version and force the
    // renderer to re-run getProgram()/uniform re-eval on the next render —
    // per-reuse churn the pre-pool (fresh-material) path never paid. If a
    // future change makes `side` vary within a pool, set needsUpdate only
    // on that specific transition.
    mesh.scale.setScalar(scaleFrom);
    mesh.position.copy(position);
    mesh.rotation.set(0, 0, 0);
    mesh.quaternion.set(0, 0, 0, 1);
    mesh.visible = true;
  } else {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side,
    });
    mesh = new THREE.Mesh(_getSharedGeometry(shape), material);
    mesh.position.copy(position);
    mesh.scale.setScalar(scaleFrom);
  }
  mesh.renderOrder = 950;
  // Tag the shape so _releaseBurstMesh can return it to the right pool
  // without re-deriving it from geometry identity.
  mesh.userData.__rp6Shape = shape;
  if (parent) parent.add(mesh);
  return mesh;
}

/**
 * Release a burst mesh back to its shape pool (or really dispose its
 * material if the pool is full). The shared geometry is NEVER disposed.
 * Always detaches from the parent + hides first so a pooled mesh can't
 * keep rendering.
 */
function _releaseBurstMesh(mesh) {
  if (!mesh) return;
  if (mesh.parent) mesh.parent.remove(mesh);
  mesh.visible = false;
  const shape = mesh.userData?.__rp6Shape;
  const pool = (shape === 0 || shape === 1 || shape === 2)
    ? _burstPool[shape]
    : null;
  if (pool && pool.length < _BURST_POOL_MAX) {
    pool.push(mesh);
    return;
  }
  // Pool full (or untagged) — really free this material. The shared
  // geometry stays alive for the pooled siblings.
  try {
    if (mesh.material && typeof mesh.material.dispose === "function") {
      mesh.material.dispose();
    }
  } catch (_) {}
}

// RP6 lever 2 — concurrent PLACEHOLDER-burst cap. Independent of the
// real-VFX emitter cap below. When the active-burst count exceeds this,
// the OLDEST non-critical burst is force-completed (FIFO) to make room
// — keeps a sustained Spark/Splatter storm from unbounded growth. The
// per-burst `critical` flag exempts gameplay-important cues (death,
// cast/fizzle/explode, heal/damage) from eviction.
const _MAX_ACTIVE_BURSTS = 64;

// Module flag set by _runPlaceholderDispatch for the duration of one
// (synchronous) dispatch so the spawn helpers can tag the burst they
// create as critical-or-not without threading a parameter through the
// dozens of _spawnBurst/_spawnRingBurst/_spawnCubeBurst call sites.
// Reset to false at the top of every dispatch; the spawn happens
// synchronously inside the same switch, so there's no interleaving.
let _currentBurstCritical = false;

// Gameplay-critical PlayScript IDs whose placeholder burst must NEVER
// be FIFO-evicted under the concurrent cap (RP6 guardrail): death/
// destroy, cast-result (fizzle/explode), heal/damage. These are the
// cues a player must always see. Frequent cosmetic cues (Spark,
// Splatter, Enchant, Regen, SpecialState…) are evictable. NOTE: this
// is purely the EVICTION-exemption set for the soft cap; the cues are
// still rendered normally — criticality only protects them from being
// dropped early when the screen is saturated.
const _CRITICAL_PLAY_SCRIPT_IDS = new Set([
  PLAY_SCRIPT.Explode,
  PLAY_SCRIPT.Fizzle,
  PLAY_SCRIPT.Destroy,
  PLAY_SCRIPT.DisappearDestroy,
  PLAY_SCRIPT.HealthUpRed, PLAY_SCRIPT.HealthUpBlue, PLAY_SCRIPT.HealthUpYellow,
  PLAY_SCRIPT.HealthDownRed, PLAY_SCRIPT.HealthDownBlue,
  PLAY_SCRIPT.HealthDownYellow, PLAY_SCRIPT.HealthDownVoid,
]);
function _isCriticalPlayScript(scriptId) {
  return _CRITICAL_PLAY_SCRIPT_IDS.has(scriptId);
}

function _enforceBurstCap() {
  if (_activeBursts.size <= _MAX_ACTIVE_BURSTS) return;
  // Map preserves insertion order → iterate oldest-first, evicting the
  // first non-critical burst(s) until under the cap. Never drop a
  // critical burst (let those exceed the soft cap rather than skip a
  // death/cast cue).
  for (const [handle, burst] of _activeBursts) {
    if (_activeBursts.size <= _MAX_ACTIVE_BURSTS) break;
    if (burst.critical) continue;
    _disposeBurst(handle, burst);
  }
}

// Single shared rAF loop for ALL active bursts. Idle when the map is
// empty; resumes on next spawn. Avoids one rAF callback per burst.
let _rafId = 0;
function _tickAllBursts() {
  _rafId = 0;
  if (_activeBursts.size === 0) return;
  const now = performance.now();
  // Iterate snapshot — _disposeBurst() mutates the map. `Array.from`
  // is cheap at the size we expect (<50 bursts in any realistic
  // combat scenario).
  for (const [handle, burst] of Array.from(_activeBursts.entries())) {
    // Per-burst durationMs override (Phase 37). Defaults to the
    // module-wide TWEEN_DURATION_MS for legacy Launch/Explode arms.
    const duration = burst.durationMs || TWEEN_DURATION_MS;
    const t = (now - burst.startMs) / duration;
    if (t >= 1.0) {
      _disposeBurst(handle, burst);
      continue;
    }
    // Ease-out — fast initial expansion, slow tail. `1 - (1-t)^3` is
    // the classic cubic ease-out and reads as "pop and settle".
    const inv = 1 - t;
    const ease = 1 - inv * inv * inv;
    const scale = burst.scaleFrom + (burst.scaleTo - burst.scaleFrom) * ease;
    burst.mesh.scale.setScalar(scale);
    // Opacity fades linearly from full-on to zero so the tail is
    // smooth even after the scale ease saturates.
    burst.material.opacity = (1 - t) * burst.opacityFrom;
    // Phase 37 — Shield rings spin a full 360° over the burst lifetime
    // for visual interest beyond pulse+fade. `rotateRadians` is set at
    // spawn (Math.PI * 2 for one rotation, 0 for static bursts). Axis
    // is Z (the torus's normal axis post-construction) so the ring
    // remains face-on to the camera if it was oriented that way.
    if (burst.rotateRadians) {
      burst.mesh.rotation.z = burst.rotateRadians * t;
    }
  }
  if (_activeBursts.size > 0 && typeof requestAnimationFrame === "function") {
    _rafId = requestAnimationFrame(_tickAllBursts);
  }
}

function _ensureRafRunning() {
  if (_rafId !== 0) return;
  if (typeof requestAnimationFrame !== "function") return;
  _rafId = requestAnimationFrame(_tickAllBursts);
}

function _disposeBurst(handle, burst) {
  try {
    // RP6 (2026-06-08): return the mesh + its material to the shape
    // pool instead of disposing them. The shared per-shape geometry is
    // never disposed; the material is reset on re-acquire. Detaches +
    // hides inside _releaseBurstMesh so a pooled mesh can't keep
    // rendering. Pre-pool bursts (if any ever set burst.geometry) fall
    // back to the old dispose path for belt-and-braces.
    if (burst.mesh && burst.mesh.userData && burst.mesh.userData.__rp6Shape !== undefined) {
      _releaseBurstMesh(burst.mesh);
    } else {
      if (burst.parent && burst.mesh && burst.mesh.parent === burst.parent) {
        burst.parent.remove(burst.mesh);
      }
      if (burst.geometry && typeof burst.geometry.dispose === "function") {
        burst.geometry.dispose();
      }
      if (burst.material && typeof burst.material.dispose === "function") {
        burst.material.dispose();
      }
    }
  } catch (e) {
    // Never let a disposal error kill the rAF loop or leak the
    // registry entry. The map.delete below still fires.
    // eslint-disable-next-line no-console
    console.warn("[play-effect-vfx] burst cleanup threw:", e);
  }
  _activeBursts.delete(handle);
}

/**
 * Resolve a target entity's three.js world position by GUID. Returns
 * `null` when the entity isn't currently in the entity map (race with
 * ObjectCreate, post-despawn PlayEffect, etc.) — the caller logs +
 * skips the burst.
 *
 * Reads through `window.liveScene3d.entityManager.entityMap` — the
 * canonical entity registry populated by `scene3d/entities.js`. Pose
 * is `inst.root.position` (a `THREE.Vector3`); see entities.js:455
 * for the assignment.
 *
 * @param {number} targetGuid
 * @returns {{ position: import("three").Vector3, parent: import("three").Object3D } | null}
 */
function _resolveTargetPlacement(targetGuid) {
  try {
    if (typeof window === "undefined") return null;
    const ls = window.liveScene3d;
    if (!ls) return null;
    const em = ls.entityManager;
    if (!em || !em.entityMap || typeof em.entityMap.get !== "function") {
      return null;
    }
    const inst = em.entityMap.get(targetGuid >>> 0);
    if (!inst || !inst.root) return null;
    return {
      position: inst.root.position,
      // Add bursts to entitiesGroup so they inherit worldRoot's AC→three
      // rotation. entitiesGroup is the parent of all entity rigs; see
      // scene3d/entities.js:1299 and scene3d/index.js:551.
      parent: ls.entitiesGroup ?? inst.root.parent ?? null,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Spawn a placeholder additive-blend sphere burst at `position`,
 * parented to `parent`. The burst tweens scale from `scaleFrom` to
 * `scaleTo` and opacity from 1.0 to 0.0 over `durationMs` (default
 * `TWEEN_DURATION_MS`), then auto-disposes.
 *
 * @param {import("three").Object3D} parent
 * @param {import("three").Vector3} position
 * @param {number} scaleFrom - starting radius scalar (THREE.Mesh.scale)
 * @param {number} scaleTo - ending radius scalar
 * @param {number} color - 0xRRGGBB
 * @param {number} [durationMs] - per-burst duration override (Phase 37);
 *   omit to inherit the module default of 500ms.
 */
function _spawnBurst(parent, position, scaleFrom, scaleTo, color, durationMs) {
  if (!parent) return;
  // RP6 (2026-06-08): pooled sphere. The unit-sphere geometry is shared
  // across all sphere bursts (sizing is driven by mesh.scale); the mesh
  // + material come from / return to the shape pool. depthWrite:false
  // (set in _acquireBurstMesh) means we don't occlude later geometry.
  const mesh = _acquireBurstMesh(
    _BURST_SHAPE.SPHERE, parent, position, scaleFrom, color, THREE.FrontSide,
  );
  mesh.name = "playEffectBurst";

  const handle = _nextHandle++;
  _activeBursts.set(handle, {
    mesh,
    // RP6: `material` is referenced (pool-owned) so the rAF tween can
    // lerp opacity without re-deriving it; it is NOT disposed here —
    // the __rp6Shape tag routes cleanup back to the pool.
    material: mesh.material,
    parent,
    startMs: performance.now(),
    scaleFrom,
    scaleTo,
    opacityFrom: 1.0,
    durationMs: durationMs || 0, // 0 = inherit TWEEN_DURATION_MS in the tick loop
    critical: _currentBurstCritical,
  });
  _enforceBurstCap();
  _ensureRafRunning();
}

/**
 * Spawn a placeholder additive-blend torus (ring) burst at `position`,
 * parented to `parent`. Tweens scale + opacity like `_spawnBurst` but
 * uses a `THREE.TorusGeometry` for distinct silhouette (Phase 37 —
 * Shield family). Optionally rotates a full `rotateRadians` over the
 * burst lifetime; pass `Math.PI * 2` for one rotation.
 *
 * Shield family is rotated face-on (XY plane) so the ring reads as a
 * "ward" around the target rather than a sphere — visual contrast vs
 * the sphere bursts used by the other families.
 *
 * @param {import("three").Object3D} parent
 * @param {import("three").Vector3} position
 * @param {number} scaleFrom
 * @param {number} scaleTo
 * @param {number} color - 0xRRGGBB
 * @param {number} durationMs
 * @param {number} [rotateRadians=0] - total rotation about Z over the
 *   burst lifetime; 0 = static. Default 0 keeps the helper general.
 */
function _spawnRingBurst(
  parent,
  position,
  scaleFrom,
  scaleTo,
  color,
  durationMs,
  rotateRadians = 0,
) {
  if (!parent) return;
  // RP6 (2026-06-08): pooled torus ring (outer radius 0.5, tube 0.05,
  // 12×24 segments — same silhouette as pre-pool). Rings are thin so
  // the shared material uses DoubleSide for visibility at any camera
  // angle to the torus's XY plane.
  const mesh = _acquireBurstMesh(
    _BURST_SHAPE.RING, parent, position, scaleFrom, color, THREE.DoubleSide,
  );
  mesh.name = "playEffectRing";

  const handle = _nextHandle++;
  _activeBursts.set(handle, {
    mesh,
    material: mesh.material,
    parent,
    startMs: performance.now(),
    scaleFrom,
    scaleTo,
    opacityFrom: 1.0,
    durationMs: durationMs || 0,
    rotateRadians,
    critical: _currentBurstCritical,
  });
  _enforceBurstCap();
  _ensureRafRunning();
}

/**
 * Spawn a placeholder additive-blend cube burst at `position` (Phase
 * 47). Geometric distinction from `_spawnBurst` (sphere) so the player
 * can differentiate attribute changes (sphere = core stat) vs skill
 * changes (cube = trained ability) at a glance even with identical
 * color palettes.
 *
 * Cube is `BoxGeometry(1,1,1)` driven by `mesh.scale`. Rotates 90°
 * over the burst lifetime for visual life — feels like a "trained
 * skill ticked up" vs a static pulse.
 *
 * @param {import("three").Object3D} parent
 * @param {import("three").Vector3} position
 * @param {number} scaleFrom
 * @param {number} scaleTo
 * @param {number} color
 * @param {number} durationMs
 */
function _spawnCubeBurst(
  parent,
  position,
  scaleFrom,
  scaleTo,
  color,
  durationMs,
) {
  if (!parent) return;
  // RP6 (2026-06-08): pooled box (1×1×1, 12 tris). Scale-driven sizing
  // matches the other burst helpers' invariants.
  const mesh = _acquireBurstMesh(
    _BURST_SHAPE.CUBE, parent, position, scaleFrom, color, THREE.FrontSide,
  );
  mesh.name = "playEffectCube";

  const handle = _nextHandle++;
  _activeBursts.set(handle, {
    mesh,
    material: mesh.material,
    parent,
    startMs: performance.now(),
    scaleFrom,
    scaleTo,
    opacityFrom: 1.0,
    durationMs: durationMs || 0,
    // Quarter-turn over the burst lifetime — drives the same Z-rotation
    // path the ring uses (rAF tick reads `rotateRadians` if present).
    rotateRadians: Math.PI * 0.5,
    critical: _currentBurstCritical,
  });
  _enforceBurstCap();
  _ensureRafRunning();
}

// =====================================================================
// Wave 17 / Phase 51 — REAL retail VFX resolver chain.
// =====================================================================
//
// Per `external/holtburger/docs/physicsscript-bridge-research-2026-05-26.md`,
// retail's `CPhysicsObj::play_script(scriptId, speed)`
// (acclient.c:320335) walks:
//
//   entity.physics_script_table → script_table[scriptId] (array of
//     {mod, scriptDid}) → first entry where speed <= entry.mod
//     → PhysicsScript (0x33) → for each CreateParticleHook
//       (hook_type 13 or 26) → ParticleEmitter (0x32) → addEmitter.
//
// `pickScriptEntry` ports the weighted-pick semantic; the resolver
// below stitches together the existing wasm fetches + the world-side
// `ParticleManager` that `entities.js::_attachParticleChainForEntity`
// already maintains on every entityManager.

/**
 * Weighted-mod pick: from a list of `{mod, scriptDid}` entries in
 * ascending `mod` order, return the FIRST entry where
 * `speed <= entry.mod`. If no entry satisfies that condition (the
 * incoming `speed` exceeds every mod threshold), clamp to the LAST
 * entry (greatest mod) — this matches retail's overflow behavior at
 * `acclient.c:336552 PhysicsScriptTableData::GetScript`, which returns
 * the final entry when the linear walk runs off the end.
 *
 * @param {Array<{mod: number, scriptDid: number}>} entries — ascending
 *   by `mod`; caller is responsible for sort invariant (the Rust-side
 *   DAT parse preserves DAT byte order which IS ascending).
 * @param {number} speed — the incoming mod weight from the PlayEffect
 *   wire event (typically 0.0..=1.0 but uncapped on the wire side).
 * @returns {{mod: number, scriptDid: number} | null}
 */
export function pickScriptEntry(entries, speed) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  // Top-down walk per acclient.c:336552. The first row whose `mod`
  // threshold is >= `speed` wins; this gives the "speed picks the
  // smallest band that contains it" semantic.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e.mod !== "number") continue;
    if (speed <= e.mod) return e;
  }
  // Overflow clamp — return the last (greatest-mod) entry. Mirrors the
  // retail walk falling off the end and returning the saved tail.
  return entries[entries.length - 1] ?? null;
}

/**
 * Inline self-tests for `pickScriptEntry`. Run via:
 *   node --input-type=module --eval "await import('./scene3d/play_effect_vfx.js').then(m => m.__test.runPickerSelfTests())"
 *
 * Cases mirror the retail walk shape: single-entry, two-entry below/
 * above-threshold, three-entry clamp.
 *
 * @returns {{passed: number, failed: number, total: number}}
 */
function _runPickerSelfTests() {
  const cases = [
    [
      "single-entry: speed 0.0 picks the only entry",
      () => {
        const r = pickScriptEntry([{ mod: 1.0, scriptDid: 0x33000100 }], 0.0);
        if (r?.scriptDid !== 0x33000100) throw new Error(`got ${r?.scriptDid}`);
      },
    ],
    [
      "two-entry: speed below first mod picks first",
      () => {
        const r = pickScriptEntry(
          [
            { mod: 0.5, scriptDid: 0x33000001 },
            { mod: 1.0, scriptDid: 0x33000002 },
          ],
          0.25,
        );
        if (r?.scriptDid !== 0x33000001) throw new Error(`got ${r?.scriptDid}`);
      },
    ],
    [
      "two-entry: speed exactly at first mod still picks first (<=)",
      () => {
        const r = pickScriptEntry(
          [
            { mod: 0.5, scriptDid: 0x33000001 },
            { mod: 1.0, scriptDid: 0x33000002 },
          ],
          0.5,
        );
        if (r?.scriptDid !== 0x33000001) throw new Error(`got ${r?.scriptDid}`);
      },
    ],
    [
      "two-entry: speed above first mod picks second",
      () => {
        const r = pickScriptEntry(
          [
            { mod: 0.5, scriptDid: 0x33000001 },
            { mod: 1.0, scriptDid: 0x33000002 },
          ],
          0.75,
        );
        if (r?.scriptDid !== 0x33000002) throw new Error(`got ${r?.scriptDid}`);
      },
    ],
    [
      "overflow: speed above ALL mods clamps to last (greatest-mod)",
      () => {
        const r = pickScriptEntry(
          [
            { mod: 0.5, scriptDid: 0x33000001 },
            { mod: 1.0, scriptDid: 0x33000002 },
          ],
          5.0,
        );
        if (r?.scriptDid !== 0x33000002) throw new Error(`got ${r?.scriptDid}`);
      },
    ],
    [
      "empty entries returns null",
      () => {
        const r = pickScriptEntry([], 1.0);
        if (r !== null) throw new Error(`expected null, got ${r}`);
      },
    ],
    [
      "null entries returns null",
      () => {
        const r = pickScriptEntry(null, 1.0);
        if (r !== null) throw new Error(`expected null, got ${r}`);
      },
    ],
    [
      "three-entry: middle pick",
      () => {
        const r = pickScriptEntry(
          [
            { mod: 0.25, scriptDid: 0x33000A01 },
            { mod: 0.75, scriptDid: 0x33000A02 },
            { mod: 1.0, scriptDid: 0x33000A03 },
          ],
          0.5,
        );
        if (r?.scriptDid !== 0x33000A02) throw new Error(`got 0x${r?.scriptDid?.toString(16)}`);
      },
    ],
  ];
  let passed = 0;
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      passed += 1;
      // eslint-disable-next-line no-console
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`  FAIL  ${name}: ${err?.message ?? err}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[play-effect-vfx picker self-tests] ${passed}/${cases.length} pass, ${failed} fail`);
  return { passed, failed, total: cases.length };
}

// Wave 17 / Phase 51 diag counters. Read via `VFX_COVERAGE.realVfx*`
// at the bottom of this file. `attempts` is incremented for every
// PlayEffect that has a non-zero physicsScriptTableDid; `resolved`
// only when the chain produced at least one spawned emitter.
// =====================================================================
// RP6 (2026-06-08) — concurrent PlayEffect one-shot emitter cap.
// =====================================================================
// `_tryResolveRealVfx` spawns real ParticleManager emitters for a
// PlayEffect and schedules them for destruction after
// ONE_SHOT_LIFETIME_MS. Under a storm of overlapping spell PlayEffects
// the live emitter count (each with its own per-slot meshes, capped by
// E6 but still real GPU work) can pile up. RP6 caps the number of
// CONCURRENT PlayEffect-spawned emitter GROUPS and, on overflow,
// force-destroys the OLDEST non-critical group early (FIFO).
//
// SCOPE — this cap covers ONLY the PlayEffect one-shot path (this
// file). H2 entity-spawn emitters (entities.js
// _attachParticleChainForEntity) go straight to `wm.addEmitter` and are
// NEVER entered into this registry, so they are exempt by construction
// (RP6 guardrail). Critical cues (death/cast/heal/damage) are never
// evicted — they fall through and live their full ONE_SHOT_LIFETIME_MS.
//
// Each registry entry: { wm, ids:number[], critical:boolean }. `ids`
// is the SAME array reference the spawning call pushed into so the
// scheduled cleanup can splice without re-tracking.
const _playEffectEmitterGroups = [];
// Max concurrent PlayEffect emitter GROUPS held live at once. One
// PlayEffect typically resolves to 1-3 emitters; 24 groups is a
// generous headroom over realistic overlap while still bounding the
// worst case.
const _MAX_PLAYEFFECT_EMITTER_GROUPS = 24;

/** Force-destroy a PlayEffect emitter group's emitters now (FIFO evict). */
function _destroyEmitterGroup(group) {
  if (!group || !group.wm) return;
  for (const eid of group.ids) {
    try { group.wm.destroyParticleEmitter(eid); } catch (_) {}
  }
}

/** Register a freshly-spawned PlayEffect emitter group + evict overflow. */
function _registerEmitterGroup(group) {
  _playEffectEmitterGroups.push(group);
  if (_playEffectEmitterGroups.length <= _MAX_PLAYEFFECT_EMITTER_GROUPS) return;
  // Over cap — evict oldest NON-critical groups (FIFO) until back under.
  for (let i = 0; i < _playEffectEmitterGroups.length; i++) {
    if (_playEffectEmitterGroups.length <= _MAX_PLAYEFFECT_EMITTER_GROUPS) break;
    const g = _playEffectEmitterGroups[i];
    if (!g || g.critical) continue;
    _destroyEmitterGroup(g);
    g._evicted = true;
    _realVfxStats.rp6Evicted += 1;
    _playEffectEmitterGroups.splice(i, 1);
    i -= 1;
  }
}

/** Drop a group from the registry once its own one-shot timer fired. */
function _unregisterEmitterGroup(group) {
  const idx = _playEffectEmitterGroups.indexOf(group);
  if (idx !== -1) _playEffectEmitterGroups.splice(idx, 1);
}

const _realVfxStats = {
  attempts: 0,
  resolved: 0,
  // RP6 — count of PlayEffect emitter groups FIFO-evicted under the cap.
  rp6Evicted: 0,
  // Per-failure breakdown — helps the diag dashboard surface the most-
  // common miss mode. Bumped from `_tryResolveRealVfx`.
  missNoTable: 0,
  missNoScriptId: 0,
  missTableFetch: 0,
  missPhysicsScriptFetch: 0,
  missNoCreateParticleHook: 0,
  missEmitterFetch: 0,
  missAddEmitter: 0,
  missNoEntity: 0,
  missNoParticleManager: 0,
  // Track B7 — resolver exceeded the hard deadline; placeholder kept.
  timedOut: 0,
};

/**
 * Track B7 (2026-06-08): hard-deadline wrapper around `_tryResolveRealVfx`.
 *
 * The caller has ALREADY shown the synchronous placeholder burst before
 * invoking this, so the resolver's only job here is the upgrade to real
 * emitters. A cold chain (first-touch DAT fetches + lazy ParticleManager
 * build) can take multiple seconds; we cap the wait with a Promise.race
 * against a short deadline so the upgrade never blocks indefinitely. On
 * timeout we keep the placeholder already on screen and bump a diag
 * counter — the in-flight resolver promise is left to settle on its own
 * (it never throws, and its emitters/cleanup self-manage if it lands
 * after the deadline).
 *
 * @param {number} targetGuid
 * @param {number} scriptId
 * @param {number} speed
 */
function _tryResolveRealVfxBounded(targetGuid, scriptId, speed) {
  const DEADLINE_MS = 300;
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), DEADLINE_MS);
  });
  Promise.race([
    _tryResolveRealVfx(targetGuid, scriptId, speed),
    deadline,
  ]).then((outcome) => {
    if (outcome === "timeout") {
      _realVfxStats.timedOut += 1;
    }
  }).catch(() => {
    // Defensive: `_tryResolveRealVfx` contracts to never reject. The
    // placeholder is already shown, so any unforeseen throw is a no-op
    // for the user-visible cue.
  }).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * Phase 51 resolver: walk the
 * `entityPhysicsScriptTableDid → fetchPhysicsScriptTable → pickScriptEntry
 *  → fetchPhysicsScript → CreateParticleHook → fetchParticleEmitter →
 *  ParticleManager.addEmitter` chain for one PlayEffect event.
 *
 * Returns `true` if at least one real-VFX emitter was spawned (the
 * placeholder path should NOT fire); `false` for any miss in the
 * chain. Never throws — every internal failure resolves to `false`
 * + a `_realVfxStats.miss*` bump.
 *
 * Emitter lifecycle: spawned emitters are scheduled for
 * `ParticleManager.destroyParticleEmitter` after `ONE_SHOT_LIFETIME_MS`
 * (2500ms, see below). Long-lived PhysicsScripts that should keep
 * spawning particles (atmospheric scripts on entities) are out of
 * scope — they belong on the H2 chain (entity spawn), not the
 * PlayEffect one-shot chain.
 *
 * @param {number} targetGuid
 * @param {number} scriptId — PScriptType enum value (0x00..0xAD)
 * @param {number} speed — picker's mod-weight; per acclient.c:336552
 * @returns {Promise<boolean>}
 */
async function _tryResolveRealVfx(targetGuid, scriptId, speed) {
  _realVfxStats.attempts += 1;
  // 1. Resolve the entity instance — we need the rig (.root) to anchor
  //    emitters to AND the EntityManager to access its
  //    `_worldParticleManager` + `wasmExports`.
  if (typeof window === "undefined" || !window.liveScene3d) {
    _realVfxStats.missNoEntity += 1;
    return false;
  }
  const ls = window.liveScene3d;
  const em = ls.entityManager;
  if (!em || typeof em.getPhysicsScriptTableDid !== "function") {
    _realVfxStats.missNoEntity += 1;
    return false;
  }
  const inst = em.entityMap?.get?.(targetGuid >>> 0);
  if (!inst || !inst.root) {
    _realVfxStats.missNoEntity += 1;
    return false;
  }

  // 2. Look up the entity's PhysicsScriptTable DID via the Wave 16
  //    JS facade. 0 = "no table" — entity has no PhysicsScript dispatch
  //    so the wire event was placeholder-only by definition.
  const tableDid = em.getPhysicsScriptTableDid(targetGuid >>> 0) >>> 0;
  if (tableDid === 0) {
    _realVfxStats.missNoTable += 1;
    return false;
  }

  // 3. Fetch + cache the PhysicsScriptTable (Phase 49 facade — module-
  //    scoped Promise cache; subsequent lookups on same DID hit the
  //    cache without re-paying the wasm round-trip).
  let table;
  try {
    table = await fetchPhysicsScriptTable(tableDid);
  } catch (_) {
    // Facade is "never throws" per Phase 49 contract; this catch is
    // defensive belt-and-braces.
    table = null;
  }
  if (!table || !table.scripts) {
    _realVfxStats.missTableFetch += 1;
    return false;
  }

  // 4. Index into scripts by stringified PScriptType (JSON object keys
  //    are strings). `scripts[scriptIdStr]` is the entry list for THIS
  //    PScript type, in ascending-mod order per the Phase 49 contract.
  const entries = table.scripts[String(scriptId >>> 0)];
  if (!Array.isArray(entries) || entries.length === 0) {
    _realVfxStats.missNoScriptId += 1;
    return false;
  }

  // 5. Weighted pick — acclient.c:336552. `speed` is the incoming
  //    wire mod-weight (Phase 53; was discarded prior to this phase).
  const picked = pickScriptEntry(entries, speed);
  if (!picked || (picked.scriptDid >>> 0) === 0) {
    _realVfxStats.missNoScriptId += 1;
    return false;
  }
  const pesId = picked.scriptDid >>> 0;

  // 6. Fetch the PhysicsScript (0x33) — Sky-J P3 infrastructure.
  const wasmExports = em.wasmExports;
  if (!wasmExports || typeof wasmExports.fetchPhysicsScript !== "function") {
    _realVfxStats.missPhysicsScriptFetch += 1;
    return false;
  }
  let ps;
  try {
    ps = await wasmExports.fetchPhysicsScript(pesId);
  } catch (err) {
    _realVfxStats.missPhysicsScriptFetch += 1;
    // eslint-disable-next-line no-console
    console.warn(
      `[play-effect-vfx/real] fetchPhysicsScript(0x${pesId.toString(16)}) failed:`,
      err,
    );
    return false;
  }

  // 7. Iterate hooks; only CreateParticle (hook_type 13) and
  //    CreateBlockingParticle (hook_type 26) spawn particles. The other
  //    hook types (Sound=1, SoundTweaked=21, etc.) are handled by the
  //    H2 entity chain walker, not the PlayEffect one-shot path.
  //
  //    `PhysicsScriptJs.takeEntries()` drains the entry list across
  //    the wasm boundary — call once and iterate the JS-side array.
  const entriesJs = ps.takeEntries();
  let particleHookCount = 0;
  for (const e of entriesJs) {
    if (e.hookType === 13 || e.hookType === 26) {
      particleHookCount += 1;
    }
  }
  if (particleHookCount === 0) {
    _realVfxStats.missNoCreateParticleHook += 1;
    return false;
  }

  // 8. We need access to the per-scene `ParticleManager`. The world-
  //    side instance lives on `entityManager._worldParticleManager`,
  //    lazily created on the first H2 chain walk
  //    (`entities.js::_attachParticleChainForEntity` line ~3446) or by
  //    the Track B7 spawn-time prewarm. If no entity has ever fired an
  //    H2 chain / been prewarmed yet (early in the session, or in a
  //    low-PhysicsScript region), the manager is still null and we fall
  //    back to the already-shown placeholder for this cue.
  //
  //    Reuse the existing manager when available. Track B7 (2026-06-08):
  //    we NO LONGER build the manager (dynamic import + geometry/material
  //    factory wiring) inline here. That lazy build runs on the PlayEffect
  //    critical path and is one of the slow steps that made the spell
  //    effect land seconds late on first touch. The placeholder burst is
  //    already on screen by the time this resolver runs, so when the
  //    manager doesn't exist yet we simply fall back to it (return false)
  //    and let the H2 entity-spawn chain — or the spawn-time prewarm —
  //    create `_worldParticleManager`. Subsequent PlayEffects on a warm
  //    manager then resolve to real emitters. (We DON'T touch
  //    `scene3d/particles/` directly here either — mandate § "don't
  //    refactor scene3d/particles/".)
  const wm = em._worldParticleManager;
  if (!wm) {
    _realVfxStats.missNoParticleManager += 1;
    return false;
  }

  // 9. For each CreateParticle / CreateBlockingParticle hook, fetch the
  //    ParticleEmitter (0x32) and add it to the ParticleManager parented
  //    to the entity rig. Each spawned emitter is scheduled for
  //    destruction after ONE_SHOT_LIFETIME_MS so PlayEffect bursts
  //    don't accumulate forever (the mandate calls out 2-3 seconds for
  //    Launch/Explode-class events).
  //
  //    Track B7 (2026-06-08): honor the per-hook StartTime. Retail
  //    `ScriptManager::AddScript` schedules each hook at
  //    `cur_time + data[0].start_time`; we previously spawned every
  //    emitter at `now`, collapsing scripted timing to t=0 and (with
  //    the old cold-chain) actually landing them seconds LATE. We now
  //    fetch the EmitterInfo synchronously (warming the DAT) then defer
  //    the `wm.addEmitter` visual via setTimeout at the hook's
  //    StartTime — mirroring the H2 chain-walker arms at
  //    entities.js:~6649 / ~6738. `spawnedEmitterIds` is shared with
  //    the RP6 group + per-guid map below; the deferred callbacks push
  //    the resolved emitter id into it as each lands (same fire-and-
  //    forget bookkeeping shape as entities.js:6994-6997).
  const spawnedEmitterIds = [];
  let pendingSpawnCount = 0;
  let maxStartTimeMs = 0;
  for (const e of entriesJs) {
    if (e.hookType !== 13 && e.hookType !== 26) continue;
    const emitterDid = (e.createParticleEmitterId >>> 0);
    if (emitterDid === 0) continue;
    let emitterInfo;
    try {
      emitterInfo = await wasmExports.fetchParticleEmitter(emitterDid);
    } catch (err) {
      _realVfxStats.missEmitterFetch += 1;
      // eslint-disable-next-line no-console
      console.warn(
        `[play-effect-vfx/real] fetchParticleEmitter(0x${emitterDid.toString(16)}) failed:`,
        err,
      );
      continue;
    }

    // CreateParticleHook offset frame — same shape the H2 chain walker
    // builds at entities.js:3611. Scratch Vec3/Quat is fine here because
    // PlayEffect events are rare enough that overlapping calls are
    // unlikely — we instantiate fresh THREE objects per call to dodge
    // the shared-scratch race the H2 path documents.
    const offset = {
      position: new THREE.Vector3(
        e.createParticleOffsetX,
        e.createParticleOffsetY,
        e.createParticleOffsetZ,
      ),
      quaternion: new THREE.Quaternion(
        e.createParticleOffsetQX,
        e.createParticleOffsetQY,
        e.createParticleOffsetQZ,
        e.createParticleOffsetQW,
      ),
    };
    const partIndex = (e.createParticlePartIndex === 0xffffffff)
      ? -1
      : (e.createParticlePartIndex | 0);

    // StartTime-driven schedule (entities.js:~6649/~6738 pattern).
    const startDelayMs = Math.max(0, (+e.startTime || 0) * 1000);
    if (startDelayMs > maxStartTimeMs) maxStartTimeMs = startDelayMs;
    pendingSpawnCount += 1;
    setTimeout(() => {
      // Wave-1 review (RP6 cap): if this group was FIFO-evicted under
      // concurrent-emitter cap pressure during the StartTime delay, do
      // NOT spawn the late emitter — the eviction's force-destroy already
      // ran and a late spawn would escape the cap. (`_rp6Group` is
      // declared below and is initialized by the time this async
      // callback fires.)
      if (_rp6Group._evicted) return;
      // The target may have despawned during the StartTime delay; if
      // so, skip the spawn (matches the H2 arms' entityMap guard).
      if (!em.entityMap?.has?.(targetGuid >>> 0)) return;
      wm.addEmitter({
        emitterInfo,
        parent: inst.root,
        partIndex,
        parentOffset: offset,
      })
        .then((emitterId) => {
          if (emitterId !== 0) {
            // Wave-1 review: a despawn that raced this addEmitter resolve
            // already tore down (and dropped) this guid's per-emitter
            // bucket; re-seeding it would strand a live emitter the
            // entity-remove path can no longer reap. Destroy it now.
            if (!em.entityMap?.has?.(targetGuid >>> 0)) {
              try { wm.destroyParticleEmitter(emitterId); } catch (_) {}
              return;
            }
            spawnedEmitterIds.push(emitterId);
            // Keep the per-guid tracking honest as late hooks land so
            // entity-remove can tear them down (the synchronous block
            // below created the array; push into the live one if it
            // still exists, otherwise re-seed it).
            let perGuidIds = em._particleEmittersForGuid.get(targetGuid);
            if (!perGuidIds) {
              perGuidIds = [];
              em._particleEmittersForGuid.set(targetGuid, perGuidIds);
            }
            perGuidIds.push(emitterId);
          } else {
            _realVfxStats.missAddEmitter += 1;
          }
        })
        .catch((err) => {
          _realVfxStats.missAddEmitter += 1;
          // eslint-disable-next-line no-console
          console.warn(
            `[play-effect-vfx/real] addEmitter(0x${emitterDid.toString(16)}) threw:`,
            err,
          );
        });
    }, startDelayMs);
  }

  if (pendingSpawnCount === 0) {
    return false;
  }

  // Wave 3 / A5 fix (2026-05-28) — register the PlayEffect emitters
  // with the entity manager's per-guid tracking so entity-remove
  // (entities.js:4259) destroys them early if the target despawns
  // inside the 2.5 s one-shot window. Without this, the emitter
  // outlives its parent rig: when the setTimeout below fires,
  // `destroyParticleEmitter`'s `if (m && m.parent) m.parent.remove(m)`
  // no-ops because the rig is already detached, and the per-slot
  // material disposal still runs but the JS-side ParticleEmitter
  // instance has held a now-stale `this.parent` reference for the
  // remainder of its lifetime. Mirrors the H2 spawn-time chain at
  // entities.js:4693-4694 which also writes into this map.
  //
  // Track B7 (2026-06-08): the StartTime-deferred spawn callbacks above
  // now push their resolved emitter ids into this per-guid array as they
  // land (the array may still be empty at THIS synchronous point). We
  // ensure the array exists up front so an entity-remove that races the
  // first deferred spawn finds a bucket to clear.
  {
    if (!em._particleEmittersForGuid.get(targetGuid)) {
      em._particleEmittersForGuid.set(targetGuid, []);
    }
  }

  // RP6 (2026-06-08): register this PlayEffect emitter group with the
  // concurrent-cap FIFO registry. If the live group count is over the
  // cap, the OLDEST non-critical group is force-destroyed here (its
  // emitters torn down early). H2 entity-spawn emitters never enter
  // this registry (they go straight through entities.js → wm.addEmitter)
  // so they are exempt from the cap by construction. Critical cues
  // (death/cast/heal/damage) are never evicted. Registering AFTER the
  // per-guid tracking above means an evicted group's emitter IDs are
  // still pruned correctly when the entity-remove or one-shot timer
  // fires (destroyParticleEmitter is idempotent).
  const _rp6Group = {
    wm,
    ids: spawnedEmitterIds,
    critical: _isCriticalPlayScript(scriptId),
    _evicted: false,
  };
  _registerEmitterGroup(_rp6Group);

  // 10. Schedule one-shot cleanup. PlayEffect events are by definition
  //     one-shot (the wire opcode broadcasts a single "play this script
  //     once" cue); long-lived per-entity scripts go through the H2
  //     spawn-time chain instead. 2500ms covers Launch (~500ms) +
  //     Explode (~1.2s) + the long tail of misc scripts; emitters
  //     whose own particles all expire earlier are no-op cleaned up
  //     by `ParticleManager.tick()`'s auto-remove path.
  //
  //     Track B7 (2026-06-08): extend the cleanup base by the largest
  //     hook StartTime so late-scheduled hooks aren't torn down before
  //     they even spawn (their setTimeout fires at +maxStartTimeMs).
  const ONE_SHOT_LIFETIME_MS = 2500 + maxStartTimeMs;
  setTimeout(() => {
    // RP6: drop from the cap registry first (idempotent if already
    // FIFO-evicted — indexOf returns -1 and the splice is a no-op).
    _unregisterEmitterGroup(_rp6Group);
    for (const eid of spawnedEmitterIds) {
      try { wm.destroyParticleEmitter(eid); } catch (_) {}
    }
    // Wave 3 / A5 fix — prune from per-guid tracking so a future
    // entity-remove doesn't double-destroy these already-destroyed
    // emitter IDs. (`destroyParticleEmitter` is safe to call twice —
    // returns false on the second — but pruning keeps the map honest
    // and prevents the map from accumulating stale IDs.)
    const perGuidIds = em._particleEmittersForGuid.get(targetGuid);
    if (perGuidIds && perGuidIds.length > 0) {
      const toRemove = new Set(spawnedEmitterIds);
      const remaining = perGuidIds.filter((id) => !toRemove.has(id));
      if (remaining.length === 0) {
        em._particleEmittersForGuid.delete(targetGuid);
      } else {
        em._particleEmittersForGuid.set(targetGuid, remaining);
      }
    }
  }, ONE_SHOT_LIFETIME_MS);

  _realVfxStats.resolved += 1;
  // eslint-disable-next-line no-console
  console.log(
    `[play-effect-vfx/real] resolved scriptId=0x${scriptId.toString(16)} ` +
      `target=0x${targetGuid.toString(16)} table=0x${tableDid.toString(16)} ` +
      `pes=0x${pesId.toString(16)} speed=${speed.toFixed(3)} ` +
      // Track B7: emitters spawn at their StartTime, so report the
      // SCHEDULED count here (the resolved count grows asynchronously).
      `emittersScheduled=${pendingSpawnCount}`,
  );
  return true;
}

// =====================================================================
// Track B2 / motion-backlog rank 7 (2026-06-09) — pending-effect queue.
// =====================================================================
// PROBLEM. A PlayEffect (0xF755) whose target guid is not yet in
// `entityMap` is silently dropped: every dispatch arm calls
// `_resolveTargetPlacement(guid) → null` (and the real-VFX resolver
// hits `missNoEntity`) → log + return, with no replay. So a cast/buff/
// spawn flash that arrives on the wire JUST BEFORE its target's
// ObjectCreate is lost forever — common for portal-in, projectile
// birth, and the first PlayEffect when entering a fresh PVS area where
// the effect packet beats the create packet.
//
// FIX. When the live dispatch finds NO instance for the target guid,
// enqueue the effect (scriptId, speed, enqueue-time) keyed by guid
// instead of dropping it. When `entities.js` later spawns that guid
// (right after `entityMap.set(guid, inst)`), it calls
// `drainPendingPlayEffects(this, guid)` which replays the queued
// effects through the SAME resolve/spawn path the live dispatch uses.
//
// BOUNDS (so the queue can NEVER grow unbounded for guids that never
// arrive — bad packets, despawn-before-create, etc.):
//   - At most `_PENDING_MAX_PER_GUID` effects per guid (drop OLDEST on
//     overflow; eviction is LOGGED, never silent).
//   - At most `_PENDING_MAX_GUIDS` distinct guids tracked at once (drop
//     the OLDEST-inserted guid bucket on overflow; LOGGED).
//   - Entries older than `_PENDING_TTL_MS` are evicted on the next
//     enqueue OR drain touch (lazy TTL — no timer/interval leak), with
//     the evicted count LOGGED. A guid bucket that goes empty after TTL
//     pruning is removed from the map.
//
// GATE. Default-OFF `?playEffectQueue=on` (same IIFE/URLSearchParams
// pattern as MT_CLASS_FALLBACK_ON / CYCLE_OMEGA_ON in entities.js).
// When OFF, behavior is byte-identical to pre-B2 (the missing-target
// effect is dropped + logged exactly as before) so this stays inert
// until the 1070 GPU eye-test flips the default. When ON, the effect is
// queued and replayed on spawn. `drainPendingPlayEffects` itself is a
// cheap no-op when the queue is empty regardless of the flag, so the
// entities.js wire-site call is always safe to add.
// INTEGRATED always-on — 1070 eye-test PASSED 2026-06-10 (fresh-spawn caster's
// cast/buff flash now plays instead of being dropped). JS, live on reload. Was
// the default-OFF `?playEffectQueue=on` gate.
const PLAY_EFFECT_QUEUE_ON = true;

// F9-3 (2026-06-09) — `?castVfxDedup=on` (default OFF). The local caster's
// CasterEffect plays TWICE: playCastSequence emits a synthetic `playEffect`
// at the chain's end AND ACE broadcasts the same effect over the wire
// (GameMessageScript → kind=30 → `playEffect`), so the glow flashes twice
// (compounded by F8-1's slow chain). When ON, a per-(guid, scriptId) dedup
// drops a second dispatch within `_CAST_VFX_DEDUP_MS` (first-wins, which
// usually means the wire copy plays and the synthetic is suppressed).
// Default OFF pending a 1070 eye-test (it must not swallow a legitimate
// rapid re-trigger of the same one-shot script on the same entity).
const CAST_VFX_DEDUP_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("castVfxDedup");
    return v === "on" || v === "1" || v === "true";
  } catch (_) {
    return false;
  }
})();
const _CAST_VFX_DEDUP_MS = 2000;
// Map<`${guid}:${scriptId}`, lastDispatchMs>. Pruned lazily in _onPlayEffect.
const _recentPlayEffects = new Map();

// Map<guid:number, Array<{scriptId:number, speed:number, enqueuedMs:number}>>.
// Insertion order is preserved by Map iteration, so the oldest-guid
// eviction below can pull `keys().next()`.
const _pendingPlayEffects = new Map();
const _PENDING_MAX_PER_GUID = 8;
const _PENDING_MAX_GUIDS = 256;
const _PENDING_TTL_MS = 3000;
// Diag counters — surfaced via __test.pendingStats() so an acceptance
// trace can assert "enqueued N, replayed N, evicted 0" without guessing.
const _pendingStats = {
  enqueued: 0,
  replayed: 0,
  evictedTtl: 0,
  evictedPerGuid: 0,
  evictedMaxGuids: 0,
  // cell==0 non-positional suppressions (not queued).
  suppressedCell0: 0,
};

/**
 * Resolve the live entity instance for a guid via the SAME entityMap
 * path the dispatch + resolver use (`_resolveTargetPlacement` line ~729
 * and `_tryResolveRealVfx` line ~1223). Returns the instance or null.
 * Used to decide enqueue-vs-dispatch: if this is null, the effect would
 * be dropped, so we queue it instead.
 *
 * @param {number} guid
 * @returns {object|null}
 */
function _liveInstanceForGuid(guid) {
  try {
    if (typeof window === "undefined") return null;
    const em = window.liveScene3d?.entityManager;
    if (!em || !em.entityMap || typeof em.entityMap.get !== "function") {
      return null;
    }
    return em.entityMap.get(guid >>> 0) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Prune TTL-expired entries from a single guid's bucket in place.
 * Returns the (possibly shortened) array, or null if it went empty.
 * Bumps `_pendingStats.evictedTtl` + logs when anything was dropped.
 */
function _pruneExpired(guid, bucket, now) {
  if (!bucket || bucket.length === 0) return null;
  let dropped = 0;
  let w = 0;
  for (let r = 0; r < bucket.length; r++) {
    if (now - bucket[r].enqueuedMs <= _PENDING_TTL_MS) {
      bucket[w++] = bucket[r];
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) {
    bucket.length = w;
    _pendingStats.evictedTtl += dropped;
    // eslint-disable-next-line no-console
    console.debug(
      `[play-effect-vfx/queue] TTL-evicted ${dropped} stale effect(s) for ` +
        `guid 0x${(guid >>> 0).toString(16)} (>${_PENDING_TTL_MS}ms old)`,
    );
  }
  return bucket.length > 0 ? bucket : null;
}

/**
 * Enqueue a PlayEffect for a target guid that isn't in `entityMap` yet,
 * to be replayed by `drainPendingPlayEffects` when the entity spawns.
 * Enforces the per-guid cap, the max-guids cap, and lazy TTL pruning —
 * all evictions are logged, never silent. No-op when the queue gate is
 * OFF (caller checks `PLAY_EFFECT_QUEUE_ON` before calling, but this is
 * also internally safe to call).
 *
 * @param {number} guid
 * @param {number} scriptId
 * @param {number} speed
 */
function _enqueuePlayEffect(guid, scriptId, speed) {
  const g = guid >>> 0;
  const now = (typeof performance !== "undefined" && performance.now)
    ? performance.now()
    : Date.now();
  let bucket = _pendingPlayEffects.get(g);
  if (bucket) {
    // Lazy TTL prune on touch so stale entries can't linger.
    bucket = _pruneExpired(g, bucket, now);
    if (!bucket) {
      // Re-create a fresh bucket; the old one fully expired. Delete +
      // re-set so this guid moves to the tail of the insertion order
      // (it's the freshest now).
      _pendingPlayEffects.delete(g);
      bucket = null;
    }
  }
  if (!bucket) {
    // New guid bucket — enforce the global guid cap FIRST so we never
    // exceed _PENDING_MAX_GUIDS even transiently. Evict the oldest-
    // inserted bucket (Map preserves insertion order).
    while (_pendingPlayEffects.size >= _PENDING_MAX_GUIDS) {
      const oldestGuid = _pendingPlayEffects.keys().next().value;
      if (oldestGuid === undefined) break;
      const evictedCount = _pendingPlayEffects.get(oldestGuid)?.length || 0;
      _pendingPlayEffects.delete(oldestGuid);
      _pendingStats.evictedMaxGuids += evictedCount;
      // eslint-disable-next-line no-console
      console.debug(
        `[play-effect-vfx/queue] max-guids cap (${_PENDING_MAX_GUIDS}) — evicted ` +
          `bucket for guid 0x${(oldestGuid >>> 0).toString(16)} ` +
          `(${evictedCount} effect(s))`,
      );
    }
    bucket = [];
    _pendingPlayEffects.set(g, bucket);
  }
  bucket.push({ scriptId: scriptId >>> 0, speed, enqueuedMs: now });
  _pendingStats.enqueued += 1;
  // Per-guid cap — drop OLDEST on overflow.
  if (bucket.length > _PENDING_MAX_PER_GUID) {
    const overflow = bucket.length - _PENDING_MAX_PER_GUID;
    bucket.splice(0, overflow);
    _pendingStats.evictedPerGuid += overflow;
    // eslint-disable-next-line no-console
    console.debug(
      `[play-effect-vfx/queue] per-guid cap (${_PENDING_MAX_PER_GUID}) — dropped ` +
        `${overflow} oldest effect(s) for guid 0x${g.toString(16)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.debug(
    `[play-effect-vfx/queue] enqueued scriptId=0x${(scriptId >>> 0).toString(16)} ` +
      `for not-yet-spawned guid 0x${g.toString(16)} (depth ${bucket.length})`,
  );
}

/**
 * Replay (and remove) any PlayEffects queued for `guid` through the
 * SAME dispatch path the live `playEffect` listener uses. Call this
 * right after an entity is inserted into the entity map — see the
 * entities.js wire-site (after `this.entityMap.set(guid, inst)`).
 *
 * Idempotent + cheap: a no-op (single Map.get) when nothing is queued
 * for `guid`. Safe to call unconditionally regardless of the
 * `?playEffectQueue=on` gate — if the gate is OFF nothing was ever
 * enqueued, so this just returns. TTL-expired entries are pruned (and
 * logged) before replay so a slow spawn doesn't replay stale flashes.
 *
 * `em` is the EntityManager (the spawn site passes `this`). It's
 * accepted for signature symmetry + future direct use, but the replay
 * path resolves the live scene through `window.liveScene3d` exactly as
 * the live dispatch does, so the same resolve/spawn code runs for a
 * replayed effect as for a live one.
 *
 * @param {object} em - the EntityManager (entities.js `this`)
 * @param {number} guid
 */
export function drainPendingPlayEffects(em, guid) {
  const g = guid >>> 0;
  const bucket = _pendingPlayEffects.get(g);
  if (!bucket || bucket.length === 0) {
    if (bucket) _pendingPlayEffects.delete(g);
    return; // common fast path — nothing queued.
  }
  // Remove the bucket up front so a re-entrant enqueue during replay
  // (shouldn't happen — the entity now exists — but be safe) starts a
  // fresh bucket instead of mutating the one we're iterating.
  _pendingPlayEffects.delete(g);
  const now = (typeof performance !== "undefined" && performance.now)
    ? performance.now()
    : Date.now();
  // Drop anything that aged out while the entity was still un-spawned.
  const live = _pruneExpired(g, bucket, now);
  if (!live || live.length === 0) return;
  for (const eff of live) {
    _pendingStats.replayed += 1;
    // Replay through the shared dispatch — identical to a live event.
    _dispatchResolvedPlayEffect(g, eff.scriptId, eff.speed);
  }
}

/**
 * Event handler for `playEffect` on the plugin event bus.
 *
 * @param {CustomEvent<{ targetGuid: number, scriptId: number, speed: number }>} evt
 */
function _onPlayEffect(evt) {
  const detail = evt?.detail ?? {};
  const targetGuid = (detail.targetGuid >>> 0) || 0;
  const scriptId = (detail.scriptId >>> 0) || 0;
  // Wave 17 / Phase 53: `speed` is now load-bearing — it drives
  // `pickScriptEntry`'s weighted mod selection per acclient.c:336552.
  // Default to 1.0 on the wire (the most common ACE broadcast).
  const speed = Number.isFinite(detail.speed) ? detail.speed : 1.0;

  if (targetGuid === 0) {
    // eslint-disable-next-line no-console
    console.debug("[play-effect-vfx] skipped: targetGuid=0");
    return;
  }

  // F9-3 — drop a duplicate (guid, scriptId) within the dedup window so the
  // synthetic CasterEffect emit doesn't double-play the wire copy. First-wins.
  if (CAST_VFX_DEDUP_ON) {
    const now = (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();
    const key = `${targetGuid}:${scriptId}`;
    const last = _recentPlayEffects.get(key);
    if (last !== undefined && (now - last) <= _CAST_VFX_DEDUP_MS) {
      // eslint-disable-next-line no-console
      console.debug(
        `[play-effect-vfx] F9-3 deduped scriptId=0x${scriptId.toString(16)} ` +
          `target=0x${targetGuid.toString(16)} (within ${_CAST_VFX_DEDUP_MS}ms)`,
      );
      return;
    }
    _recentPlayEffects.set(key, now);
    // Lazy prune so the map can't grow unbounded.
    if (_recentPlayEffects.size > 256) {
      for (const [k, t] of _recentPlayEffects) {
        if ((now - t) > _CAST_VFX_DEDUP_MS) _recentPlayEffects.delete(k);
      }
    }
  }

  // Track B2 (2026-06-09) — retail cell==0 / non-positional guard.
  // Retail's CPhysicsObj::play_script anchors the script to the object's
  // current cell; a PlayEffect broadcast with cell==0 (no spatial cell)
  // is a non-positional cue that has no world anchor to attach a burst
  // to. We must NOT queue such an effect (it would wait forever for a
  // spatial target that will never make it positional). The wire bridge
  // (index.html kind===30) does not currently forward a `cell` field, so
  // this guard only fires when an explicit `detail.cell === 0` is present
  // — forward-compatible + inert for today's 3-field payload. When it
  // does fire we suppress (drop, logged) rather than queue; if the entity
  // already exists the normal dispatch below would still place it, but a
  // cell==0 broadcast by definition has no placement, so suppression is
  // the correct retail-parity behavior.
  if (Object.prototype.hasOwnProperty.call(detail, "cell")
      && (detail.cell >>> 0) === 0) {
    _pendingStats.suppressedCell0 += 1;
    // eslint-disable-next-line no-console
    console.debug(
      `[play-effect-vfx] suppressed non-positional (cell==0) PlayEffect ` +
        `scriptId=0x${scriptId.toString(16)} target=0x${targetGuid.toString(16)}`,
    );
    return;
  }

  // Track B2 (2026-06-09) — queue-on-miss. If the target guid isn't in
  // the entity map yet (PlayEffect raced ahead of ObjectCreate — common
  // for portal-in, projectile birth, first-touch in a fresh PVS area),
  // the dispatch below would resolve no placement and the effect would
  // be silently dropped. Gated default-OFF behind `?playEffectQueue=on`
  // (inert until the 1070 GPU eye-test): when ON we enqueue the effect
  // keyed by guid so the entity's spawn site can replay it via
  // `drainPendingPlayEffects`; when OFF we fall through to the original
  // drop-on-miss behavior unchanged.
  if (PLAY_EFFECT_QUEUE_ON && _liveInstanceForGuid(targetGuid) === null) {
    _enqueuePlayEffect(targetGuid, scriptId, speed);
    return;
  }

  _dispatchResolvedPlayEffect(targetGuid, scriptId, speed);
}

/**
 * Shared dispatch body for a PlayEffect whose target is expected to be
 * resolvable NOW — used by both the live listener (`_onPlayEffect`) and
 * the queue replay (`drainPendingPlayEffects`). Extracted verbatim from
 * the pre-B2 `_onPlayEffect` tail so a replayed effect runs the exact
 * same resolve/spawn path (table check → placeholder → bounded real-VFX
 * resolver) as a live one.
 *
 * @param {number} targetGuid
 * @param {number} scriptId
 * @param {number} speed
 */
function _dispatchResolvedPlayEffect(targetGuid, scriptId, speed) {
  // Wave 17 / Phase 51: try the REAL retail VFX chain FIRST. If the
  // resolver completes (table → pick → physics-script → emitters),
  // skip the placeholder fallthrough for this event. On any miss the
  // promise resolves to `false` and the placeholder runs as before —
  // strict superset of behavior; no regression for Phase 34/37/47
  // cases when the entity has no table or the script isn't in it.
  //
  // The async work doesn't block the event listener; the placeholder
  // path either runs in the .then() miss branch OR runs synchronously
  // first if we know the entity has no table. We detect the "definitely
  // no table" case via a synchronous `getPhysicsScriptTableDid` check
  // so the common no-table case (most weenies) skips the async hop.
  const ls = (typeof window !== "undefined") ? window.liveScene3d : null;
  const tableDid = (() => {
    try {
      const em = ls?.entityManager;
      if (!em || typeof em.getPhysicsScriptTableDid !== "function") return 0;
      return (em.getPhysicsScriptTableDid(targetGuid >>> 0) >>> 0);
    } catch (_) { return 0; }
  })();

  if (tableDid !== 0) {
    // Track B7 (2026-06-08): show the synchronous placeholder burst
    // IMMEDIATELY for the table-bearing branch too. Previously this
    // branch returned with no synchronous visual and deferred the
    // placeholder to the resolver's miss branch — but the resolver is
    // a cold async chain (fetchPhysicsScriptTable → fetchPhysicsScript
    // → per-hook fetchParticleEmitter + lazy ParticleManager build)
    // that can take 5+s on first hit, so the spell effect appeared
    // seconds late at the visual level even on a clean resolve. Retail
    // ScriptManager::AddScript does a synchronous local DAT get; we
    // emulate the "instant cue" by always firing the placeholder now,
    // then letting the resolver upgrade/replace it with real emitters
    // when the chain lands (the real emitters are additive, and the
    // placeholder self-expires on its own short lifetime).
    _runPlaceholderDispatch(targetGuid, scriptId);
    // Then kick off the real-VFX resolver under a hard deadline so a
    // slow/cold chain can't hang the upgrade — on timeout we simply
    // keep the placeholder already shown above.
    _tryResolveRealVfxBounded(targetGuid, scriptId, speed);
    return;
  }
  // No table → synchronous placeholder path, identical to pre-Phase-51
  // behavior. Most weenies hit this branch.
  _realVfxStats.attempts += 1;
  _realVfxStats.missNoTable += 1;
  _runPlaceholderDispatch(targetGuid, scriptId);
}

/**
 * Placeholder VFX dispatch — extracted from the pre-Phase-51 body of
 * `_onPlayEffect` so the resolver can defer to it via .then().
 * Behavior is identical to Phase 34/37/47; no semantic changes here.
 *
 * @param {number} targetGuid
 * @param {number} scriptId
 */
function _runPlaceholderDispatch(targetGuid, scriptId) {
  const placement = _resolveTargetPlacement(targetGuid);

  // RP6 (2026-06-08): mark this dispatch's burst critical-or-not so the
  // concurrent-burst cap won't FIFO-evict gameplay-important cues. Set
  // for the whole synchronous dispatch below (the spawn helpers read
  // it); the spawn is synchronous so there's no interleaving risk.
  _currentBurstCritical = _isCriticalPlayScript(scriptId);

  switch (scriptId) {
    case PLAY_SCRIPT.Launch: {
      // Small blue-cyan additive burst at the projectile's spawn
      // position. Mirrors retail's "spell-projectile leaving caster"
      // visual cue.
      if (!placement) {
        // eslint-disable-next-line no-console
        console.debug(
          `[play-effect-vfx] Launch target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
        );
        return;
      }
      _spawnBurst(placement.parent, placement.position, 0.1, 0.45, 0x4abcff);
      return;
    }
    case PLAY_SCRIPT.Explode: {
      // Larger yellow-orange burst at the impact target. Mirrors
      // retail's projectile-collision splash.
      if (!placement) {
        // eslint-disable-next-line no-console
        console.debug(
          `[play-effect-vfx] Explode target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
        );
        return;
      }
      _spawnBurst(placement.parent, placement.position, 0.2, 1.2, 0xffa733);
      return;
    }
    default: {
      // ---------------------------------------------------------------
      // Phase 37 — extended family coverage. Each block below maps an
      // ACE PlayScript family (Set membership) to a placeholder visual.
      // We check Sets here (rather than adding 48 explicit switch arms)
      // to keep the dispatch compact + keep family semantics colocated.
      // ---------------------------------------------------------------

      // Splatter (0x5B-0x66) — generic damage hit. Red `0xff3030` is
      // the universal "damage taken" cue (matches HP-bar drops, retail
      // floating-damage numbers, and standard combat-feedback color
      // conventions across the genre). Short 300ms duration since
      // sustained combat fires Splatter on every hit.
      if (_SPLATTER_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Splatter target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.1, 0.4, 0xff3030, 300);
        return;
      }

      // Spark (0x67-0x72) — minor cast / mana fizz. White `0xffffff` is
      // the canonical "magical micro-effect" color (mana shimmer, cast
      // spark) — visually neutral, doesn't compete with combat reds/
      // greens. Tiny scale (0.05-0.15) + brief 200ms = "blink and
      // you'll miss it" appropriate for a minor cue.
      if (_SPARK_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Spark target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.05, 0.15, 0xffffff, 200);
        return;
      }

      // Health* (Up) — heal applied. Cyan-green `0x40ff80` is the
      // universal "healing / vitality restored" color (matches HP
      // recovery in nearly every RPG; biological-green associations).
      // 400ms is mid-duration — perceptible recovery but doesn't
      // linger on long-running heal effects.
      if (_HEALTH_UP_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] HealthUp target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.15, 0.5, 0x40ff80, 400);
        return;
      }

      // Health* (Down/Void) — damage indicator / DoT tick. Dim red
      // `0xa03030` (instead of Splatter's bright `0xff3030`) so the
      // player can distinguish a one-shot hit (Splatter — bright) from
      // ongoing health loss like a poison/bleed tick (Down — dim).
      if (_HEALTH_DOWN_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] HealthDown target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.15, 0.5, 0xa03030, 400);
        return;
      }

      // Shield family (0x2B-0x38) — defensive buff. Blue `0x4080ff` is
      // the universal "ward / protection / barrier" color (sky blue =
      // defensive in fantasy convention; matches Three.js demos of
      // shield bubble effects). Uses TorusGeometry instead of a sphere
      // for clear visual distinction from damage/heal bursts — this
      // pops as a ring around the defended entity. Rotates 360° over
      // 600ms for added visual interest.
      if (_SHIELD_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Shield target 0x${targetGuid.toString(16)} not in entityMap — skipping ring`,
          );
          return;
        }
        _spawnRingBurst(
          placement.parent, placement.position,
          1.0, 1.5, 0x4080ff, 600, Math.PI * 2,
        );
        return;
      }

      // Death (Destroy / DisappearDestroy) — entity is dying. Dark
      // purple `0x6b1a8a` carries the "death / void / final" semantic
      // (purple = death in many fantasy contexts; AC itself uses dark
      // purple for vitae/death portals). Long 800ms + large scale
      // (0.3→1.5) since death is a major, infrequent event — gets to
      // dominate visually.
      if (_DEATH_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Death target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.3, 1.5, 0x6b1a8a, 800);
        return;
      }

      // Fizzle (0x51) — spell cast failed. Gray `0x808080` reads as
      // "nothing happened / dud" — visually muted on purpose since a
      // failed cast deserves a small acknowledgment but shouldn't
      // compete with successful-cast visuals. 350ms brief puff.
      if (scriptId === PLAY_SCRIPT.Fizzle) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Fizzle target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.1, 0.3, 0x808080, 350);
        return;
      }

      // ---------------------------------------------------------------
      // Phase 47 (Wave 15) — extended family coverage continued.
      // ---------------------------------------------------------------

      // AttribUp (0x06,0x08,0x0A,0x0C,0x0E,0x10) — attribute buff. Green-
      // yellow `0xc8ff44` sphere; positive stat-change cue. 400ms reads
      // as "your stat went up" — long enough to register but doesn't
      // linger when multiple buffs land in rapid succession.
      if (_ATTRIB_UP_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] AttribUp target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.15, 0.5, 0xc8ff44, 400);
        return;
      }

      // AttribDown (0x07,0x09,0x0B,0x0D,0x0F,0x11) — attribute debuff.
      // Red-orange `0xff6633` sphere (distinct from Splatter/HealthDown
      // so the player learns three distinct red cues: bright = hit,
      // dim = HP loss, orange = stat debuff).
      if (_ATTRIB_DOWN_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] AttribDown target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.15, 0.5, 0xff6633, 400);
        return;
      }

      // SkillUp (0x12,0x14,0x16,0x18,0x1A,0x1C) — skill buff. Same
      // green-yellow palette as AttribUp but via the cube helper for
      // geometric distinction (attribute = sphere, skill = cube).
      if (_SKILL_UP_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] SkillUp target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnCubeBurst(placement.parent, placement.position, 0.1, 0.4, 0xc8ff44, 400);
        return;
      }

      // SkillDown (0x13,0x15,0x17,0x19,0x1B,0x1D,0x1E,0xA9) — skill
      // debuff. Red-orange cube. 0x1E = SkillDownBlack (the 7th color
      // unique to Down direction); 0xA9 = SkillDownVoid (Void-cluster
      // late-addition; gameplay-equivalent to a normal skill debuff).
      if (_SKILL_DOWN_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] SkillDown target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnCubeBurst(placement.parent, placement.position, 0.1, 0.4, 0xff6633, 400);
        return;
      }

      // EnchantUp (0x39-0x43 cycle + 0x8B Grey + 0x8E White) — enchant
      // applied. Gold `0xffd966` brief flash (300ms; magical-aura
      // convention — gold pulses around an entity gaining a spell
      // effect). Smaller scale than Attrib/Skill since enchants land
      // frequently in combat (every spell cast on you).
      if (_ENCHANT_UP_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] EnchantUp target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.1, 0.4, 0xffd966, 300);
        return;
      }

      // EnchantDown (0x3A-0x44 cycle + 0x8C Grey + 0x8F White) — enchant
      // expired/dispelled. Muted purple `0x9966dd` — visually contrasts
      // with EnchantUp's gold so the two read as opposite events at a
      // glance.
      if (_ENCHANT_DOWN_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] EnchantDown target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.1, 0.4, 0x9966dd, 300);
        return;
      }

      // Hide (0x74) — stealth engaged. Gray `0x666666` sphere fades-IN
      // (scaleFrom > scaleTo so the visual shrinks/dissolves as the
      // caster "vanishes"). Long-ish 500ms to telegraph the state
      // change.
      if (scriptId === PLAY_SCRIPT.Hide) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Hide target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        // scaleFrom=0.8 → scaleTo=0.2 (contracting) reads as "fading
        // into stealth". Opacity tween in the rAF loop also fades to
        // zero so the net effect is "shrinks and disappears".
        _spawnBurst(placement.parent, placement.position, 0.8, 0.2, 0x666666, 500);
        return;
      }

      // UnHide (0x75) — stealth dropped. Reverse: gray sphere expands
      // outward (scaleFrom < scaleTo) as the caster reappears.
      if (scriptId === PLAY_SCRIPT.UnHide) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] UnHide target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.2, 0.8, 0x666666, 500);
        return;
      }

      // Hidden (0x76) — passive "still in stealth" cue. Very brief
      // (150ms), tiny (0.05→0.1), barely visible — just enough to mark
      // the state without polluting the visual field. Used when ACE
      // broadcasts a periodic stealth confirmation.
      if (scriptId === PLAY_SCRIPT.Hidden) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Hidden target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.05, 0.1, 0x666666, 150);
        return;
      }

      // PortalEntry (0x52) — entering a portal. Bright purple
      // `0xcc44ff` expanding sphere 0.3→2.0 over 600ms — large
      // signature for an important traversal event.
      if (scriptId === PLAY_SCRIPT.PortalEntry) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] PortalEntry target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.3, 2.0, 0xcc44ff, 600);
        return;
      }

      // PortalExit (0x53) — exiting a portal at the destination.
      // Reverse-shape vs Entry: contracting sphere 2.0→0.3 — reads as
      // "materializing at destination". Same purple palette so the
      // entry/exit pair feel connected.
      if (scriptId === PLAY_SCRIPT.PortalExit) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] PortalExit target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 2.0, 0.3, 0xcc44ff, 600);
        return;
      }

      // PortalStorm (0x73) — atmospheric "you got recalled" or
      // "portal storm hit" flash. The closest semantic to a
      // "PortalSending" cue in the enum (no literal PortalSending
      // exists). White `0xffffff` burst 0.5→1.5/500ms — bright,
      // unambiguous "something portal-y just happened to you".
      if (scriptId === PLAY_SCRIPT.PortalStorm) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] PortalStorm target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.5, 1.5, 0xffffff, 500);
        return;
      }

      // Camping (0x90 Mastery / 0x91 Ineptitude) — resting buff/debuff
      // tick. Soft cyan `0x88ddff` slow pulse 0.4→0.9/800ms — gentle
      // peaceful vibe matches the "resting at a campsite" semantic.
      // No up/down color distinction here since both variants share
      // the same gameplay context (you're resting; mastery vs
      // ineptitude is about skill grade, not stat polarity).
      if (_CAMPING_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Camping target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.4, 0.9, 0x88ddff, 800);
        return;
      }

      // LayingofHands (0x9B) — Paladin self-heal-or-touch-heal special.
      // Same calm cyan palette as Camping (peaceful / restorative) but
      // a touch brighter & faster (0.3→1.0/700ms) since it's a
      // discrete event vs Camping's ambient tick.
      if (scriptId === PLAY_SCRIPT.LayingofHands) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] LayingofHands target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.3, 1.0, 0x88ddff, 700);
        return;
      }

      // ---------------------------------------------------------------
      // Phase 54 (Wave 18) — extended family coverage continued.
      // ---------------------------------------------------------------
      // Adds: Breathe (4), SpecialState numeric (10), SpecialState
      // colors (8), Regen up/down (7), Vitae/Vision/Trans (6),
      // SwapHealth (6), Dispel (3), Restriction (3), Augmentation (4),
      // Aetheria (6), Wedding (2), DirtyFighting (4) + 6 standalone
      // (Create, ProjectileCollision, LevelUp, BunnySmite,
      // BaelZharonSmite, BlackMadness). 69 new IDs → 170/174 shipped.
      // Remaining 4 = the enum sentinels (Invalid 0x00 + Test1-3
      // 0x01-0x03) which ACE never broadcasts in gameplay.

      // Breathe family — per-ID color dispatch so flame vs frost vs
      // acid vs lightning are visually distinct. Larger scale + slightly
      // longer duration than Splatter since breath weapons are major,
      // visually impressive AoE-class hits. 500ms.
      if (_BREATHE_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Breathe target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        // Per-ID color: flame=orange, frost=cyan, acid=green, lightning=
        // bright blue-white. Lightning gets a shorter duration (300ms)
        // for the crackle feel; flame/frost/acid get full 500ms.
        let color = 0xffffff;
        let durationMs = 500;
        if (scriptId === PLAY_SCRIPT.BreatheFlame) { color = 0xff7733; }
        else if (scriptId === PLAY_SCRIPT.BreatheFrost) { color = 0x66ddff; }
        else if (scriptId === PLAY_SCRIPT.BreatheAcid) { color = 0x77ff44; }
        else if (scriptId === PLAY_SCRIPT.BreatheLightning) { color = 0xddeeff; durationMs = 300; }
        _spawnBurst(placement.parent, placement.position, 0.25, 1.1, color, durationMs);
        return;
      }

      // SpecialState1-9 + SpecialState0 — generic numeric state cues.
      // Cycle through a 9-color palette indexed by (id - SpecialState1);
      // SpecialState0 (0x81) folds onto the SpecialState9 tail (white).
      // 250ms brief flash per the mandate.
      if (_SPECIAL_STATE_NUMERIC_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] SpecialStateN target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        // Pale red, orange, yellow, green, cyan, blue, indigo, violet, white.
        const palette = [
          0xff8888, 0xffaa44, 0xffee44, 0x88ee88,
          0x66dddd, 0x6688ff, 0xaa66ff, 0xdd66ff, 0xeeeeee,
        ];
        // SpecialState1 = 0x78 → index 0; SpecialState9 = 0x80 → 8.
        // SpecialState0 = 0x81 → wraps to index 8 (white) to match a
        // "zero state = neutral / fallback" gestalt.
        let idx;
        if (scriptId === PLAY_SCRIPT.SpecialState0) idx = 8;
        else idx = (scriptId - PLAY_SCRIPT.SpecialState1) & 0xff;
        if (idx < 0 || idx > 8) idx = 8;
        _spawnBurst(placement.parent, placement.position, 0.1, 0.4, palette[idx], 250);
        return;
      }

      // SpecialState color variants — 0x82-0x89. Per-ID color matching
      // the named color so the visual stays faithful to the enum name.
      // 250ms brief flash, same envelope as the numeric variants.
      if (_SPECIAL_STATE_COLOR_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] SpecialStateColor target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        let color = 0xffffff;
        if (scriptId === PLAY_SCRIPT.SpecialStateRed) color = 0xff4444;
        else if (scriptId === PLAY_SCRIPT.SpecialStateOrange) color = 0xff9933;
        else if (scriptId === PLAY_SCRIPT.SpecialStateYellow) color = 0xffee44;
        else if (scriptId === PLAY_SCRIPT.SpecialStateGreen) color = 0x66ee66;
        else if (scriptId === PLAY_SCRIPT.SpecialStateBlue) color = 0x6688ff;
        else if (scriptId === PLAY_SCRIPT.SpecialStatePurple) color = 0xbb66ff;
        else if (scriptId === PLAY_SCRIPT.SpecialStateWhite) color = 0xeeeeee;
        else if (scriptId === PLAY_SCRIPT.SpecialStateBlack) color = 0x222222;
        _spawnBurst(placement.parent, placement.position, 0.1, 0.4, color, 250);
        return;
      }

      // RegenUp family — periodic regen tick (positive). Green flash
      // smaller than HealthUp since regen fires every few seconds on
      // every regen-enchanted entity (don't dominate the visual field).
      // 0.08→0.25 / 250ms — barely-perceptible "+pip" pulse.
      if (_REGEN_UP_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] RegenUp target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.08, 0.25, 0x66ee99, 250);
        return;
      }

      // RegenDown family (incl. RegenDownVoid 0xA8) — periodic drain
      // tick (negative). Dim red, same envelope as RegenUp.
      if (_REGEN_DOWN_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] RegenDown target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.08, 0.25, 0x884444, 250);
        return;
      }

      // VitaeUp / VisionUp / TransUp — cosmic-cluster positive cue.
      // Pure white `0xffffff` celebratory burst, large + medium-duration
      // (0.25→1.0 / 600ms) so cosmic restoration reads as significant.
      if (_VITAE_VISION_TRANS_UP_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] CosmicUp target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.25, 1.0, 0xffffff, 600);
        return;
      }

      // VitaeDown / VisionDown / TransDown — cosmic-cluster negative
      // cue. Deep blue-black `0x111133` (near-black with a hint of
      // depth so it doesn't disappear against dark scenes), same
      // envelope as the Up variant.
      if (_VITAE_VISION_TRANS_DOWN_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] CosmicDown target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.25, 1.0, 0x111133, 600);
        return;
      }

      // SwapHealth family — vital-pool transfer cue. Magenta `0xff44dd`
      // ring (TorusGeometry) for distinct "swap happened" silhouette.
      // No rotation since the swap is instantaneous (just expand+fade).
      if (_SWAP_HEALTH_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] SwapHealth target 0x${targetGuid.toString(16)} not in entityMap — skipping ring`,
          );
          return;
        }
        _spawnRingBurst(
          placement.parent, placement.position,
          0.8, 1.3, 0xff44dd, 400, 0,
        );
        return;
      }

      // Create (0x58) — entity spawn-in flash. Bright white expanding
      // burst (0.1→1.2/400ms) — counterpart to Destroy's contracting
      // purple. Reads as "something just appeared".
      if (scriptId === PLAY_SCRIPT.Create) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Create target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.1, 1.2, 0xeeffff, 400);
        return;
      }

      // ProjectileCollision (0x5A) — projectile impact. Smaller cousin
      // to Explode (which is the "spell projectile hit a target" splash);
      // this one fires for non-explosion projectile impacts (arrows,
      // bolts). Yellow-orange smaller burst (0.1→0.6/300ms).
      if (scriptId === PLAY_SCRIPT.ProjectileCollision) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] ProjectileCollision target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.1, 0.6, 0xffbb44, 300);
        return;
      }

      // LevelUp (0x8A) — major character-progression event. Brilliant
      // gold expanding sphere, long-duration (0.4→2.0/1000ms) — gets
      // to dominate visually since level-ups are rare + celebratory.
      if (scriptId === PLAY_SCRIPT.LevelUp) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] LevelUp target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.4, 2.0, 0xffcc33, 1000);
        return;
      }

      // Dispel family — ward removal cue. Muted gray-violet ring
      // (`0xaa99cc`), fast 350ms since dispels can fire frequently.
      // No rotation — the dispel is a moment, not a sweep.
      if (_DISPEL_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Dispel target 0x${targetGuid.toString(16)} not in entityMap — skipping ring`,
          );
          return;
        }
        _spawnRingBurst(
          placement.parent, placement.position,
          1.2, 0.6, 0xaa99cc, 350, 0,
        );
        return;
      }

      // BunnySmite (0x95) — AC's iconic comedic event (bunny-killer
      // achievement / Wedding-Land event). Pink `0xff99cc` brief sphere
      // — playful color matches the absurdist semantic. 400ms.
      if (scriptId === PLAY_SCRIPT.BunnySmite) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] BunnySmite target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.2, 0.8, 0xff99cc, 400);
        return;
      }

      // BaelZharonSmite (0x96) — Bael'Zharon (the dark Avatar) signature
      // smite. Dark purple-red `0x661133` per the mandate's "dark Avatar's
      // signature color". Large + long-duration (0.4→1.8/900ms) — this
      // is a major boss-encounter cue.
      if (scriptId === PLAY_SCRIPT.BaelZharonSmite) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] BaelZharonSmite target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.4, 1.8, 0x661133, 900);
        return;
      }

      // Restriction family — per-ID color matching the enum name
      // (RestrictionEffectBlue/Green/Gold). Sphere + 500ms. These cues
      // signal entering a restricted-action zone (PvP/no-PK/etc).
      if (_RESTRICTION_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Restriction target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        let color = 0xffffff;
        if (scriptId === PLAY_SCRIPT.RestrictionEffectBlue) color = 0x4488ff;
        else if (scriptId === PLAY_SCRIPT.RestrictionEffectGreen) color = 0x66dd66;
        else if (scriptId === PLAY_SCRIPT.RestrictionEffectGold) color = 0xffcc44;
        _spawnBurst(placement.parent, placement.position, 0.2, 0.8, color, 500);
        return;
      }

      // Augmentation family — major character-progression cue. Brilliant
      // gold burst, similar footprint to LevelUp (large + long-duration)
      // since augmentations are permanent character upgrades. 0.3→1.4/800ms.
      if (_AUGMENTATION_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Augmentation target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.3, 1.4, 0xffcc33, 800);
        return;
      }

      // BlackMadness (0xA0) — special debuff cue. Deep purple-black
      // `0x331144` sphere — distinct from BaelZharonSmite's red-purple
      // by being more purple-saturated. 500ms.
      if (scriptId === PLAY_SCRIPT.BlackMadness) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] BlackMadness target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.2, 0.9, 0x331144, 500);
        return;
      }

      // Aetheria family — per-ID color matching gameplay role.
      // AetheriaLevelUp = celebratory white; Surge variants get distinct
      // colors. 500ms (procs fire often; longer would clutter combat).
      if (_AETHERIA_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Aetheria target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        let color = 0xffffff;
        if (scriptId === PLAY_SCRIPT.AetheriaLevelUp) color = 0xffffff;
        else if (scriptId === PLAY_SCRIPT.AetheriaSurgeDestruction) color = 0xff7733;
        else if (scriptId === PLAY_SCRIPT.AetheriaSurgeProtection) color = 0x4488ff;
        else if (scriptId === PLAY_SCRIPT.AetheriaSurgeRegeneration) color = 0x66ee99;
        else if (scriptId === PLAY_SCRIPT.AetheriaSurgeAffliction) color = 0xaadd44;
        else if (scriptId === PLAY_SCRIPT.AetheriaSurgeFestering) color = 0x884488;
        _spawnBurst(placement.parent, placement.position, 0.2, 0.9, color, 500);
        return;
      }

      // Wedding family — WeddingBliss + WeddingSteele. Pink heart cue.
      // 700ms long enough to register; players notice marriage events.
      if (_WEDDING_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Wedding target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.3, 1.2, 0xff66cc, 700);
        return;
      }

      // DirtyFighting family — debuff cube (matches Skill* shape so
      // skill-based debuffs read as a coherent visual category). Muted
      // brown-red `0x884444` per the mandate. 400ms.
      if (_DIRTY_FIGHTING_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] DirtyFighting target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnCubeBurst(placement.parent, placement.position, 0.1, 0.4, 0x884444, 400);
        return;
      }

      // ---------------------------------------------------------------
      // Remaining ~4 PlayScript values — sentinels (Invalid 0x00 +
      // Test1-3 0x01-0x03) which ACE never broadcasts in gameplay.
      // Real-world wire frequency of these is zero; TODO-log if they
      // appear so we can surface the anomaly. (Pre-Phase-54: ~73
      // entries remained TODO. Phase 54 ships 69 → 4 sentinel-only.)
      // ---------------------------------------------------------------
      // eslint-disable-next-line no-console
      console.debug(
        `[play-effect-vfx] TODO: scriptId=0x${scriptId.toString(16)} (${playScriptName(scriptId)}) target=0x${targetGuid.toString(16)}`,
      );
      return;
    }
  }
}

// =====================================================================
// Self-registration on import.
// =====================================================================
//
// The plugin event bus is built inside `plugins/api.js` and only
// becomes reachable once `createClient(sessionHandle)` runs (after
// successful login). Importing this module at page load doesn't
// guarantee `window.__pluginClient` exists yet — so we poll briefly
// for it, then bind. The same pattern is used by other one-shot
// listener modules that wire themselves via window.__pluginClient.
//
// Idempotency: a `__playEffectVfxBound` flag on `window` prevents
// double-binding if this module is re-evaluated (Firefox ES-module
// cache trap from a `?v=` rebust, dev hot-reload, etc.).

function _tryBind() {
  if (typeof window === "undefined") return true;
  if (window.__playEffectVfxBound === true) return true;
  const pc = window.__pluginClient;
  if (!pc || !pc.events || typeof pc.events.on !== "function") return false;
  pc.events.on("playEffect", _onPlayEffect);
  window.__playEffectVfxBound = true;
  // eslint-disable-next-line no-console
  console.log("[play-effect-vfx] bound to __pluginClient.events");
  return true;
}

(function _autoBind() {
  if (typeof window === "undefined") return;
  if (_tryBind()) return;
  // Plugin client not ready yet — poll every 200ms for up to 30s
  // (post-login bootstrap on weak hardware can take ~20s in cold
  // boot per the Wave 10/11 plan §"Wave 11 enablement"). 150 ticks
  // is a hard ceiling; we stop after that to avoid leaking a setInterval
  // on a session that never completes login.
  let ticks = 0;
  const MAX_TICKS = 150;
  const iv = setInterval(() => {
    ticks++;
    if (_tryBind() || ticks >= MAX_TICKS) {
      clearInterval(iv);
      if (ticks >= MAX_TICKS && (typeof window === "undefined" || !window.__playEffectVfxBound)) {
        // eslint-disable-next-line no-console
        console.warn("[play-effect-vfx] gave up waiting for __pluginClient after 30s");
      }
    }
  }, 200);
})();

// Re-exports for diag/testing — call these directly to verify the
// burst pipeline works without needing a live server event. Useful
// for the Wave 11/12/15 acceptance traces. Wave 17 / Phase 51 adds
// the real-VFX resolver entrypoint + picker self-tests.
export const __test = Object.freeze({
  spawnBurst: _spawnBurst,
  spawnRingBurst: _spawnRingBurst,
  spawnCubeBurst: _spawnCubeBurst,
  resolveTargetPlacement: _resolveTargetPlacement,
  onPlayEffect: _onPlayEffect,
  activeBurstCount: () => _activeBursts.size,
  // Phase 51 — resolver entrypoint for end-to-end tests; bypasses the
  // event listener path so callers can directly assert the chain walks.
  tryResolveRealVfx: _tryResolveRealVfx,
  // Phase 51 — picker self-tests. Returns {passed, failed, total}.
  runPickerSelfTests: _runPickerSelfTests,
  // Phase 51 — diag counters snapshot. Read-only view; production code
  // should read via the `VFX_COVERAGE.realVfx*` getters.
  realVfxStats: () => Object.freeze({ ..._realVfxStats }),
  // RP6 (2026-06-08) — pool + cap introspection for acceptance tests.
  // `burstPoolSizes` returns the idle free-list length per shape;
  // `playEffectEmitterGroupCount` returns live PlayEffect emitter
  // groups under the concurrent cap; `isCriticalPlayScript` exposes the
  // FIFO-exemption classifier.
  burstPoolSizes: () => ({
    sphere: _burstPool[_BURST_SHAPE.SPHERE].length,
    ring: _burstPool[_BURST_SHAPE.RING].length,
    cube: _burstPool[_BURST_SHAPE.CUBE].length,
  }),
  playEffectEmitterGroupCount: () => _playEffectEmitterGroups.length,
  isCriticalPlayScript: _isCriticalPlayScript,
  maxActiveBursts: _MAX_ACTIVE_BURSTS,
  maxPlayEffectEmitterGroups: _MAX_PLAYEFFECT_EMITTER_GROUPS,
  // Track B2 (2026-06-09) — pending-effect queue introspection.
  // `pendingStats` snapshots the enqueue/replay/evict counters;
  // `pendingDepth(guid)` returns the queued count for one guid (or the
  // total tracked-guid count when called with no arg); `enqueuePlayEffect`
  // + `drainPendingPlayEffects` expose the two ends for a direct unit
  // trace (no live wire event needed). `queueGateOn` reflects the flag.
  pendingStats: () => Object.freeze({ ..._pendingStats }),
  pendingDepth: (guid) => (guid === undefined
    ? _pendingPlayEffects.size
    : (_pendingPlayEffects.get(guid >>> 0)?.length || 0)),
  enqueuePlayEffect: _enqueuePlayEffect,
  drainPendingPlayEffects,
  queueGateOn: PLAY_EFFECT_QUEUE_ON,
  pendingCaps: Object.freeze({
    maxPerGuid: _PENDING_MAX_PER_GUID,
    maxGuids: _PENDING_MAX_GUIDS,
    ttlMs: _PENDING_TTL_MS,
  }),
});

// =====================================================================
// VFX_COVERAGE — authoritative manifest of which PlayScript IDs ship
// placeholder visuals vs which still TODO-log. Useful for diag
// dashboards and future agents (Wave 13+) to know what's already
// painted vs what still needs a vertical.
// =====================================================================
//
// `shipped` is a frozen Set of every numeric PlayScript ID that has a
// real visual treatment (the dispatch arm returns a `_spawnBurst` /
// `_spawnRingBurst` and does NOT fall through to the TODO log).
//
// `families` maps the human-readable family label to the IDs in it.
// Iteration order matches the dispatch order in `_onPlayEffect`.
//
// Counts (as of Phase 54): shipped=170 (Launch + Explode + 48 from
// Phase 37 + 51 from Phase 47 + 69 from Phase 54). Total PLAY_SCRIPT
// enum size = 174 (0x00-0xAD). Remaining TODO = 4 (Invalid 0x00 +
// Test1/2/3 0x01-0x03 — sentinels never broadcast in gameplay).
// `shippedCount` and `todoCount` below are computed from the live
// `_COVERAGE_SHIPPED_SET.size` so any future additions flow through
// automatically.
const _COVERAGE_FAMILIES = Object.freeze({
  Launch: [PLAY_SCRIPT.Launch],
  Explode: [PLAY_SCRIPT.Explode],
  Splatter: Array.from(_SPLATTER_IDS),
  Spark: Array.from(_SPARK_IDS),
  HealthUp: Array.from(_HEALTH_UP_IDS),
  HealthDown: Array.from(_HEALTH_DOWN_IDS),
  Shield: Array.from(_SHIELD_IDS),
  Death: Array.from(_DEATH_IDS),
  Fizzle: [PLAY_SCRIPT.Fizzle],
  // Phase 47 additions (Wave 15).
  AttribUp: Array.from(_ATTRIB_UP_IDS),
  AttribDown: Array.from(_ATTRIB_DOWN_IDS),
  SkillUp: Array.from(_SKILL_UP_IDS),
  SkillDown: Array.from(_SKILL_DOWN_IDS),
  EnchantUp: Array.from(_ENCHANT_UP_IDS),
  EnchantDown: Array.from(_ENCHANT_DOWN_IDS),
  Hide: [PLAY_SCRIPT.Hide],
  UnHide: [PLAY_SCRIPT.UnHide],
  Hidden: [PLAY_SCRIPT.Hidden],
  Portal: Array.from(_PORTAL_FAMILY_IDS),
  Camping: Array.from(_CAMPING_IDS),
  LayingofHands: [PLAY_SCRIPT.LayingofHands],
  // Phase 54 additions (Wave 18).
  Breathe: Array.from(_BREATHE_IDS),
  SpecialStateNumeric: Array.from(_SPECIAL_STATE_NUMERIC_IDS),
  SpecialStateColor: Array.from(_SPECIAL_STATE_COLOR_IDS),
  RegenUp: Array.from(_REGEN_UP_IDS),
  RegenDown: Array.from(_REGEN_DOWN_IDS),
  VitaeVisionTransUp: Array.from(_VITAE_VISION_TRANS_UP_IDS),
  VitaeVisionTransDown: Array.from(_VITAE_VISION_TRANS_DOWN_IDS),
  SwapHealth: Array.from(_SWAP_HEALTH_IDS),
  Dispel: Array.from(_DISPEL_IDS),
  Restriction: Array.from(_RESTRICTION_IDS),
  Augmentation: Array.from(_AUGMENTATION_IDS),
  Aetheria: Array.from(_AETHERIA_IDS),
  Wedding: Array.from(_WEDDING_IDS),
  DirtyFighting: Array.from(_DIRTY_FIGHTING_IDS),
  Create: [PLAY_SCRIPT.Create],
  ProjectileCollision: [PLAY_SCRIPT.ProjectileCollision],
  LevelUp: [PLAY_SCRIPT.LevelUp],
  BunnySmite: [PLAY_SCRIPT.BunnySmite],
  BaelZharonSmite: [PLAY_SCRIPT.BaelZharonSmite],
  BlackMadness: [PLAY_SCRIPT.BlackMadness],
});

const _COVERAGE_SHIPPED_SET = new Set();
for (const ids of Object.values(_COVERAGE_FAMILIES)) {
  for (const id of ids) _COVERAGE_SHIPPED_SET.add(id);
}

// Wave 2.C / Phase 55 (2026-05-28) — verified-unshipped IDs. These four
// are the ACE enum sentinels (`Invalid` + `Test1-3`); they are NEVER
// broadcast in normal gameplay. The only ACE code path that references
// `PlayScript.Invalid` is `DeveloperCommands.cs:295` where it's used as
// an initialized default that's always overwritten before broadcast.
// Cross-checked: `~/ace-server/Source/ACE.Entity/Enum/PlayScript.cs:5-8`.
//
// Locked here so a regression in `_COVERAGE_FAMILIES` (e.g. accidentally
// removing a family) gets caught by `test_play_effect_resolver.mjs`'s
// Case O assertion.
const _COVERAGE_UNSHIPPED_SENTINELS = Object.freeze([
  PLAY_SCRIPT.Invalid, // 0x00
  PLAY_SCRIPT.Test1,   // 0x01
  PLAY_SCRIPT.Test2,   // 0x02
  PLAY_SCRIPT.Test3,   // 0x03
]);

// Wave 2.C / Phase 55 (2026-05-28) — IDs absent from EVERY retail
// PhysicsScriptTable (0x34 record in `client_portal.dat`). These IDs
// CAN'T resolve through the live `_tryResolveRealVfx` chain even when
// the entity has a `physicsScriptTableDid` — the table simply doesn't
// contain a script for them, so the placeholder path is the ONLY
// rendering layer. Source-of-truth:
// `apps/holtburger-web/data/playscript-canonical-physics-scripts.json`
// generated by `scripts/gen-playscript-canonical-physics-scripts.cjs`.
// Mirrored here as a const so a JS-side test can assert this set
// without an async fetch.
//
// 27 entries (4 sentinels + 23 ambient-state IDs).
const _COVERAGE_UNMAPPED_BY_RETAIL = Object.freeze([
  // Sentinels (also in `_COVERAGE_UNSHIPPED_SENTINELS`; deliberate
  // duplication so the two arrays read independently).
  PLAY_SCRIPT.Invalid, PLAY_SCRIPT.Test1, PLAY_SCRIPT.Test2, PLAY_SCRIPT.Test3,
  // Portal traversal cues (broadcast-only; client-side overlay):
  PLAY_SCRIPT.PortalEntry, PLAY_SCRIPT.PortalExit,
  // SpecialState numeric (0x78-0x81) + colors (0x82-0x89):
  PLAY_SCRIPT.SpecialState1, PLAY_SCRIPT.SpecialState2, PLAY_SCRIPT.SpecialState3,
  PLAY_SCRIPT.SpecialState4, PLAY_SCRIPT.SpecialState5, PLAY_SCRIPT.SpecialState6,
  PLAY_SCRIPT.SpecialState7, PLAY_SCRIPT.SpecialState8, PLAY_SCRIPT.SpecialState9,
  PLAY_SCRIPT.SpecialState0,
  PLAY_SCRIPT.SpecialStateRed, PLAY_SCRIPT.SpecialStateOrange,
  PLAY_SCRIPT.SpecialStateYellow, PLAY_SCRIPT.SpecialStateGreen,
  PLAY_SCRIPT.SpecialStateBlue, PLAY_SCRIPT.SpecialStatePurple,
  PLAY_SCRIPT.SpecialStateWhite, PLAY_SCRIPT.SpecialStateBlack,
  // Two enchant variants (late retail; no PhysicsScript in base portal):
  PLAY_SCRIPT.EnchantUpGrey, PLAY_SCRIPT.EnchantDownGrey,
  // WeddingSteele (player-marriage-band cue; no retail script):
  PLAY_SCRIPT.WeddingSteele,
]);

export const VFX_COVERAGE = Object.freeze({
  shipped: _COVERAGE_SHIPPED_SET,
  families: _COVERAGE_FAMILIES,
  // Wave 2.C addition — verified-unshipped sentinel IDs (Invalid + Test1-3).
  unshippedSentinels: _COVERAGE_UNSHIPPED_SENTINELS,
  // Wave 2.C addition — IDs that no retail PhysicsScriptTable maps to a
  // PhysicsScript. Even when the resolver chain has an entity-level
  // table, these PScript IDs hit `missNoScriptId` and fall through to
  // placeholders. Use this to identify the "placeholder is the only
  // visual" cases for next-agent template work.
  unmappedByRetail: _COVERAGE_UNMAPPED_BY_RETAIL,
  // Total enum size (PLAY_SCRIPT has 174 entries: 0x00-0xAD inclusive).
  // Kept as a hard-coded mirror so a diag consumer can compute the
  // TODO count without re-importing PLAY_SCRIPT.
  enumTotal: 174,
  shippedCount: _COVERAGE_SHIPPED_SET.size,
  todoCount: 174 - _COVERAGE_SHIPPED_SET.size,
  // Wave 17 / Phase 51 — resolver hit-rate counters. `realVfxAttempts`
  // is bumped once per `playEffect` event that we *consider* for the
  // real chain (regardless of whether the entity has a table); a
  // subset `realVfxResolved` is bumped only when the chain actually
  // produced at least one spawned emitter. The breakdown is on the
  // per-miss counters for diag dashboards. Exposed via getters so the
  // numbers reflect live state at read time (not a frozen snapshot).
  get realVfxAttempts() { return _realVfxStats.attempts; },
  get realVfxResolved() { return _realVfxStats.resolved; },
  get realVfxMissBreakdown() {
    return Object.freeze({
      noTable: _realVfxStats.missNoTable,
      noScriptId: _realVfxStats.missNoScriptId,
      tableFetch: _realVfxStats.missTableFetch,
      physicsScriptFetch: _realVfxStats.missPhysicsScriptFetch,
      noCreateParticleHook: _realVfxStats.missNoCreateParticleHook,
      emitterFetch: _realVfxStats.missEmitterFetch,
      addEmitter: _realVfxStats.missAddEmitter,
      noEntity: _realVfxStats.missNoEntity,
      noParticleManager: _realVfxStats.missNoParticleManager,
    });
  },
});
