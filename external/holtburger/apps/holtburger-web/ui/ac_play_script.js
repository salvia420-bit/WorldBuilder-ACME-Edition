// CMT Wave 11 / Phase 34 (2026-05-26) — PlayScript enum mirror.
//
// JS mirror of `ACE.Entity/Enum/PlayScript.cs` (canonical source at
// `~/ace-server/Source/ACE.Entity/Enum/PlayScript.cs`). Each value
// names a server-authored visual / particle script that ACE
// broadcasts via `GameMessage::PlayEffect` (opcode `0xF755 =
// GameMessageScript`). The wire decoder lives at
// `crates/holtburger-protocol/src/messages/effects/types.rs` and
// the `WorldEvent::PlayEffect { target, script_id, speed }` variant
// at `crates/holtburger-world/src/events.rs:215`.
//
// Wave 10 Phase 31 added wire-decode + WorldEvent emission. Wave 11
// Phase 34 ships the JS surface: `src/lib.rs`'s `kind = 30`
// ClientEvent bridge fires the `playEffect` event on
// `window.__pluginClient.events`, and `scene3d/play_effect_vfx.js`
// consumes the event to spawn placeholder particle bursts.
//
// **Coverage** — all 174 PlayScript values from ACE are mirrored
// below. The `PLAY_SCRIPT_NAMES` lookup table renders hex IDs as
// human-readable names for diag readers. Real AC VFX uses
// `0x33 PhysicsScript` particle systems (see
// `scene3d/particles/particle.js` for the ACE-correct runtime);
// Phase 34 only ships placeholder visuals for `Launch` (0x04) +
// `Explode` (0x05). All other IDs are TODO-logged by the VFX
// module so future agents can wire per-script visuals as needed.

/**
 * PlayScript enum — frozen mirror of `ACE.Entity.Enum.PlayScript`.
 *
 * Values are u32. Source-of-truth:
 * `~/ace-server/Source/ACE.Entity/Enum/PlayScript.cs` — 174 entries
 * covering Invalid + Test1-3 + Launch/Explode + Attrib/Skill/Health/
 * Regen/Shield/Enchant up-and-down colour families + Vitae/Vision/
 * SwapHealth/Trans + Fizzle + PortalEntry/Exit + Breathe (Flame/Frost/
 * Acid/Lightning) + Create/Destroy + ProjectileCollision + 12-way
 * Splatter + 12-way Spark + PortalStorm + Hide/UnHide/Hidden +
 * DisappearDestroy + SpecialState1-9/0/colour + LevelUp + Wedding +
 * Camping + Dispel/Bunny/BaelZharon + Restriction + LayingofHands +
 * Augmentation + BlackMadness + Aetheria + Void family +
 * DirtyFighting family.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const PLAY_SCRIPT = Object.freeze({
  Invalid:                     0x00,
  Test1:                       0x01,
  Test2:                       0x02,
  Test3:                       0x03,
  Launch:                      0x04,
  Explode:                     0x05,
  AttribUpRed:                 0x06,
  AttribDownRed:               0x07,
  AttribUpOrange:              0x08,
  AttribDownOrange:            0x09,
  AttribUpYellow:              0x0A,
  AttribDownYellow:            0x0B,
  AttribUpGreen:               0x0C,
  AttribDownGreen:             0x0D,
  AttribUpBlue:                0x0E,
  AttribDownBlue:              0x0F,
  AttribUpPurple:              0x10,
  AttribDownPurple:            0x11,
  SkillUpRed:                  0x12,
  SkillDownRed:                0x13,
  SkillUpOrange:               0x14,
  SkillDownOrange:             0x15,
  SkillUpYellow:               0x16,
  SkillDownYellow:             0x17,
  SkillUpGreen:                0x18,
  SkillDownGreen:              0x19,
  SkillUpBlue:                 0x1A,
  SkillDownBlue:               0x1B,
  SkillUpPurple:               0x1C,
  SkillDownPurple:             0x1D,
  SkillDownBlack:              0x1E,
  HealthUpRed:                 0x1F,
  HealthDownRed:               0x20,
  HealthUpBlue:                0x21,
  HealthDownBlue:              0x22,
  HealthUpYellow:              0x23,
  HealthDownYellow:            0x24,
  RegenUpRed:                  0x25,
  RegenDownREd:                0x26, // typo preserved from ACE source
  RegenUpBlue:                 0x27,
  RegenDownBlue:               0x28,
  RegenUpYellow:               0x29,
  RegenDownYellow:             0x2A,
  ShieldUpRed:                 0x2B,
  ShieldDownRed:               0x2C,
  ShieldUpOrange:              0x2D,
  ShieldDownOrange:            0x2E,
  ShieldUpYellow:              0x2F,
  ShieldDownYellow:            0x30,
  ShieldUpGreen:               0x31,
  ShieldDownGreen:             0x32,
  ShieldUpBlue:                0x33,
  ShieldDownBlue:              0x34,
  ShieldUpPurple:              0x35,
  ShieldDownPurple:            0x36,
  ShieldUpGrey:                0x37,
  ShieldDownGrey:              0x38,
  EnchantUpRed:                0x39,
  EnchantDownRed:              0x3A,
  EnchantUpOrange:             0x3B,
  EnchantDownOrange:           0x3C,
  EnchantUpYellow:             0x3D,
  EnchantDownYellow:           0x3E,
  EnchantUpGreen:              0x3F,
  EnchantDownGreen:            0x40,
  EnchantUpBlue:               0x41,
  EnchantDownBlue:             0x42,
  EnchantUpPurple:             0x43,
  EnchantDownPurple:           0x44,
  VitaeUpWhite:                0x45,
  VitaeDownBlack:              0x46,
  VisionUpWhite:               0x47,
  VisionDownBlack:             0x48,
  SwapHealth_Red_To_Yellow:    0x49,
  SwapHealth_Red_To_Blue:      0x4A,
  SwapHealth_Yellow_To_Red:    0x4B,
  SwapHealth_Yellow_To_Blue:   0x4C,
  SwapHealth_Blue_To_Red:      0x4D,
  SwapHealth_Blue_To_Yellow:   0x4E,
  TransUpWhite:                0x4F,
  TransDownBlack:              0x50,
  Fizzle:                      0x51,
  PortalEntry:                 0x52,
  PortalExit:                  0x53,
  BreatheFlame:                0x54,
  BreatheFrost:                0x55,
  BreatheAcid:                 0x56,
  BreatheLightning:            0x57,
  Create:                      0x58,
  Destroy:                     0x59,
  ProjectileCollision:         0x5A,
  SplatterLowLeftBack:         0x5B,
  SplatterLowLeftFront:        0x5C,
  SplatterLowRightBack:        0x5D,
  SplatterLowRightFront:       0x5E,
  SplatterMidLeftBack:         0x5F,
  SplatterMidLeftFront:        0x60,
  SplatterMidRightBack:        0x61,
  SplatterMidRightFront:       0x62,
  SplatterUpLeftBack:          0x63,
  SplatterUpLeftFront:         0x64,
  SplatterUpRightBack:         0x65,
  SplatterUpRightFront:        0x66,
  SparkLowLeftBack:            0x67,
  SparkLowLeftFront:           0x68,
  SparkLowRightBack:           0x69,
  SparkLowRightFront:          0x6A,
  SparkMidLeftBack:            0x6B,
  SparkMidLeftFront:           0x6C,
  SparkMidRightBack:           0x6D,
  SparkMidRightFront:          0x6E,
  SparkUpLeftBack:             0x6F,
  SparkUpLeftFront:            0x70,
  SparkUpRightBack:            0x71,
  SparkUpRightFront:           0x72,
  PortalStorm:                 0x73,
  Hide:                        0x74,
  UnHide:                      0x75,
  Hidden:                      0x76,
  DisappearDestroy:            0x77,
  SpecialState1:               0x78,
  SpecialState2:               0x79,
  SpecialState3:               0x7A,
  SpecialState4:               0x7B,
  SpecialState5:               0x7C,
  SpecialState6:               0x7D,
  SpecialState7:               0x7E,
  SpecialState8:               0x7F,
  SpecialState9:               0x80,
  SpecialState0:               0x81,
  SpecialStateRed:             0x82,
  SpecialStateOrange:          0x83,
  SpecialStateYellow:          0x84,
  SpecialStateGreen:           0x85,
  SpecialStateBlue:            0x86,
  SpecialStatePurple:          0x87,
  SpecialStateWhite:           0x88,
  SpecialStateBlack:           0x89,
  LevelUp:                     0x8A,
  EnchantUpGrey:               0x8B,
  EnchantDownGrey:             0x8C,
  WeddingBliss:                0x8D,
  EnchantUpWhite:              0x8E,
  EnchantDownWhite:            0x8F,
  CampingMastery:              0x90,
  CampingIneptitude:           0x91,
  DispelLife:                  0x92,
  DispelCreature:              0x93,
  DispelAll:                   0x94,
  BunnySmite:                  0x95,
  BaelZharonSmite:             0x96,
  WeddingSteele:               0x97,
  RestrictionEffectBlue:       0x98,
  RestrictionEffectGreen:      0x99,
  RestrictionEffectGold:       0x9A,
  LayingofHands:               0x9B,
  AugmentationUseAttribute:    0x9C,
  AugmentationUseSkill:        0x9D,
  AugmentationUseResistances:  0x9E,
  AugmentationUseOther:        0x9F,
  BlackMadness:                0xA0,
  AetheriaLevelUp:             0xA1,
  AetheriaSurgeDestruction:    0xA2,
  AetheriaSurgeProtection:     0xA3,
  AetheriaSurgeRegeneration:   0xA4,
  AetheriaSurgeAffliction:     0xA5,
  AetheriaSurgeFestering:      0xA6,
  HealthDownVoid:              0xA7,
  RegenDownVoid:               0xA8,
  SkillDownVoid:               0xA9,
  DirtyFightingHealDebuff:     0xAA,
  DirtyFightingAttackDebuff:   0xAB,
  DirtyFightingDefenseDebuff:  0xAC,
  DirtyFightingDamageOverTime: 0xAD,
});

/**
 * Reverse-lookup table: hex string (e.g. `"0x04"`) → PlayScript name
 * (e.g. `"Launch"`). Used by diag layers + the VFX module's TODO
 * console.debug lines to render "Launch" instead of raw `0x04` /
 * decimal `4`.
 *
 * Keys are lowercase hex with `0x` prefix and NO leading zero-padding
 * beyond the minimum (so `0x4`, not `0x04` — `Number(0x04).toString(16)`
 * produces `"4"`). Use {@link playScriptName} for safe key formatting.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const PLAY_SCRIPT_NAMES = Object.freeze(
  Object.fromEntries(
    Object.entries(PLAY_SCRIPT).map(([name, id]) => [
      `0x${id.toString(16)}`,
      name,
    ]),
  ),
);

/**
 * Look up the human-readable PlayScript name for a numeric ID. Falls
 * back to `Unknown(0x...)` for IDs outside the ACE enum (currently
 * none — ACE's enum is contiguous 0x00-0xAD).
 *
 * @param {number} scriptId - PlayScript ID (u32)
 * @returns {string}
 */
export function playScriptName(scriptId) {
  const id = (scriptId >>> 0);
  const key = `0x${id.toString(16)}`;
  return PLAY_SCRIPT_NAMES[key] ?? `Unknown(0x${id.toString(16)})`;
}
