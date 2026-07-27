use crate::stats;
use holtburger_common::{CharacterOption, CharacterOptions1, CharacterOptions2, Guid, Vector3};
use holtburger_protocol::messages::EquipMask;
use holtburger_protocol::messages::magic::Enchantment;
use holtburger_protocol::messages::movement::{MotionStance, PositionType};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Wave 10 Phase 10.2 (2026-05-26) — full 32-bit
/// [`MotionCommand`](https://github.com/ACEmulator/ACE/blob/master/Source/ACE.Entity/Enum/MotionCommand.cs)
/// constants used by [`PlayerState::current_substate`] and
/// [`motion_allows_jump`].
///
/// Only the substates the jump gate cares about are listed here. The
/// full 409-entry table lives in
/// `crates/holtburger-dat/tests/common/motion_command_names.rs` (test
/// scaffolding) and `apps/holtburger-web/data/motion-command-names.json`
/// (runtime renderer).
#[allow(dead_code, non_snake_case)]
pub mod MotionCommandCode {
    /// `Ready` — at-rest pose, the universal "you can jump from here"
    /// substate. Default for [`PlayerState::current_substate`].
    pub const READY: u32 = 0x4100_0003;
    /// `Fallen` — post-fall stagger pose. Blocked by
    /// [`motion_allows_jump`] (PhatSDK `MovementManager.cpp:434`).
    /// **NOT** the same as `Falling`: Falling is the in-air looping
    /// cycle, gated by `PlayerState::is_airborne`.
    pub const FALLEN: u32 = 0x4000_0008;
    /// `Falling` — in-air looping cycle. NOT in the PhatSDK blocked
    /// set; double-jump prevention runs through `is_airborne`.
    pub const FALLING: u32 = 0x4000_0015;
    /// `Jump` — set on [`PlayerState::begin_jump`]. Not in PhatSDK's
    /// blocked set (`is_airborne` gates instead).
    pub const JUMP: u32 = 0x2500_003B;
}

/// Wave 10 Phase 10.2 (2026-05-26) — port of PhatSDK
/// `CMotionInterp::motion_allows_jump` at
/// `external/GDL/PhatSDK/MovementManager.cpp:427-438`. Returns `true`
/// when the substate is one the retail client would permit jumping
/// from, `false` when retail would emit "You can't jump from this
/// position." (`WeenieError::YouCantJumpFromThisPosition = 0x0048`).
///
/// The ranges mirror PhatSDK exactly:
///
/// - `0x40000016..=0x40000018` — `Reload`, `Unload`, `Pickup`
///   (interactions in progress)
/// - `0x1000012B..=0x10000134` — `MagicPowerUp01Purple..MagicPowerUp10Purple`
///   (colored magic power-up windups) — see the ERA NOTE below
/// - `0x1000006F..=0x10000078` — `MagicPowerUp01..MagicPowerUp10`
///   (war-magic cast windups)
/// - `0x41000012..=0x41000014` — `Crouch`, `Sitting`, `Sleeping`
///   (stationary held poses)
/// - `0x4000001E..=0x40000039` — `AimLevel..MagicPray`
///   (aim states + magic spell substates)
/// - `0x40000008` — `Fallen` (post-fall stagger)
/// - `0x10000057` — `Sanctuary` (lifestone bind) — 2015 addition
/// - `0x1000019B` — `AI_TelegraphCast` — 2015 addition
///
/// ERA NOTE (2015 build 11.6096 — TASK ERA-01/ERA-02 of
/// `docs/acclient-deep-dive-mining/wave3-F-architecture-2015diff.md`).
/// Three commands were inserted at ordinal `0x10F` between 11.4186
/// (2013, which is what PhatSDK encodes) and 11.6096, shifting every
/// higher ordinal by `+3`. Our DATs, ACE's enum and the wire data are
/// all 2015, so the purple power-up window is `0x12B..=0x134`, not
/// PhatSDK's `0x128..=0x131`. Read at 2015 ordinals the older window
/// blocks `TripleThrustLow/Med/High` (`0x128`-`0x12A`, which retail
/// never blocked in either build) and lets `MagicPowerUp08/09/10Purple`
/// (`0x132`-`0x134`) through. `0x6F..=0x78` is era-invariant — it sits
/// below the `0x10F` boundary. Authority:
/// `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:304-316`
/// (`TripleThrustLow = 0x10000128`, `MagicPowerUp01Purple = 0x1000012b`,
/// `MagicPowerUp10Purple = 0x10000134`).
///
/// 11.6096 additionally blocks `Sanctuary` (`0x10000057`) and
/// `AI_TelegraphCast` (`0x1000019B` — ACE names that ordinal
/// `WoahDuplicate2`, TASK ERA-03). Retail added `Sanctuary` to
/// `motion_allows_jump`, `jump_charge_is_allowed` and `charge_jump`,
/// but `AI_TelegraphCast` only to `motion_allows_jump`; holtburger
/// routes the charge gate through this same predicate
/// (`holtburger-core/src/client/movement/jump_charge.rs:142`), so
/// `AI_TelegraphCast` over-applies to charging — harmless, it is a
/// monster-only motion the local player never enters.
///
/// Note: `Falling (0x40000015)` is NOT in this set per retail — the
/// PhatSDK source does not block on it. Double-jump prevention runs
/// via the `is_airborne` flag (the recv-loop `Jump` arm at
/// `apps/holtburger-web/src/lib.rs` short-circuits when
/// `world.player.is_airborne`).
#[inline]
pub fn motion_allows_jump(substate: u32) -> bool {
    !(matches!(substate, 0x4000_0016..=0x4000_0018)
        || matches!(substate, 0x1000_012B..=0x1000_0134)
        || matches!(substate, 0x1000_006F..=0x1000_0078)
        || matches!(substate, 0x4100_0012..=0x4100_0014)
        || matches!(substate, 0x4000_001E..=0x4000_0039)
        || substate == 0x4000_0008
        || substate == 0x1000_0057
        || substate == 0x1000_019B)
}

/// Wave 10 Phase 10.2 (2026-05-26) — expand a low-16
/// `InterpretedMotionCommand` to its full 32-bit `MotionCommand`
/// value. ACE / the wire format only carries the low-16 substate
/// (see `external/holtburger/crates/holtburger-protocol/src/messages/
/// movement/types.rs:230` — `InterpretedMotionState::forward_command:
/// Option<InterpretedMotionCommand>` where `InterpretedMotionCommand`
/// is a `pub u16` newtype), but PhatSDK's
/// [`motion_allows_jump`] operates on the full 32-bit value.
///
/// This is a partial table. It originally covered only the substates
/// needed for jump-gating (the ranges enumerated in
/// [`motion_allows_jump`] plus a few well-known idle states). Wave 2
/// (2026-06-08) widened it to the full Action-class consumable/use range
/// (Eat / Drink / Reading / JumpCharging — needed so the renderer can
/// resolve the MotionTable link clip for B6's eat one-shot) and the
/// melee/attack swing range (needed for B10 creature attacks), so that
/// the single inbound `UpdateMotion` action command can be expanded ONCE
/// here in Rust and shipped to JS as a full 32-bit `MotionCommand` (the
/// MotionTable link inner key is the full value, never the masked
/// low-16 — a wrong class prefix misses the DAT link entry just as badly
/// as a missing one). Misses return `None`; the caller should preserve
/// the previous substate when this happens (a permissive default keeps
/// jump from breaking on unknown server motion commands).
///
/// Sourced from ACE `Source/ACE.Entity/Enum/MotionCommand.cs`
/// (cross-checked against chorizite `Chorizite.Common/Enums/
/// MotionCommand.cs`).
pub fn expand_motion_command_low16(low16: u16) -> Option<u32> {
    match low16 {
        // Idle / locomotion (not in blocked set, but tracked so the
        // substate field stays correctly populated when the player
        // walks/runs around).
        0x0003 => Some(0x4100_0003), // Ready
        0x0004 => Some(0x4000_0004), // Stop
        0x0005 => Some(0x4500_0005), // WalkForward
        0x0006 => Some(0x4500_0006), // WalkBackwards
        0x0007 => Some(0x4400_0007), // RunForward
        // Fallen — blocked (post-fall stagger).
        0x0008 => Some(0x4000_0008), // Fallen
        // Falling — NOT blocked here; is_airborne covers it.
        0x0015 => Some(0x4000_0015), // Falling
        // Crouch..Sleeping — blocked.
        0x0012 => Some(0x4100_0012), // Crouch
        0x0013 => Some(0x4100_0013), // Sitting
        0x0014 => Some(0x4100_0014), // Sleeping
        // Reload..JumpCharging — the Action-class consumable/use range. The
        // jump gate only blocks Reload..Pickup (`0x16..0x18`); the rest of
        // the range (StoreInBackpack 0x19, Eat 0x1A, Drink 0x1B, Reading
        // 0x1C, JumpCharging 0x1D) is NOT in the blocked set, but Wave 2
        // needs the full 32-bit value so the renderer can resolve the
        // MotionTable link clip for these one-shots (Eat / Drink especially
        // — B6). All carry the `0x40000000` Action class prefix.
        // ACE `MotionCommand.cs:29-37`: Reload=0x40000016 .. JumpCharging=
        // 0x4000001d (verified against chorizite `MotionCommand.cs:29-37`).
        0x0016..=0x001D => Some(0x4000_0000 | u32::from(low16)),
        // AimLevel..MagicPray — blocked. Magic gesture / aim substates,
        // Action class. ACE `MotionCommand.cs:37-64`.
        0x001E..=0x0039 => Some(0x4000_0000 | u32::from(low16)),
        // FallDown..SpinAttack — the melee/attack swing range, all class
        // 0x10000000 in ACE `MotionCommand.cs:87-117` (FallDown 0x10000050
        // .. SpinAttack 0x1000006e — includes ThrustMed/Low/High, Slash*,
        // Backhand*, Shoot, AttackHigh/Med/Low 1-3, etc., e.g. SlashHigh
        // 0x1000005b). Verified there is no non-0x10 prefix in this subrange
        // (Cheer 0x1300004c sits at 0x4c, just below the range start).
        0x0050..=0x006E => Some(0x1000_0000 | u32::from(low16)),
        // MagicPowerUp01..MagicPowerUp10 — blocked. War-magic cast windups,
        // class 0x10000000. ACE `MotionCommand.cs:118-127`.
        0x006F..=0x0078 => Some(0x1000_0000 | u32::from(low16)),
        // LogOut..MagicPowerUp10Purple — LogOut + multi-strike attack chains
        // + colored magic powerups, class 0x10000000. ACE
        // `MotionCommand.cs:294-316` (LogOut 0x1000011e, DoubleSlashLow
        // 0x1000011f .. MagicPowerUp10Purple 0x10000134 — incl.
        // MagicPowerUp08/09/10Purple 0x10000132/133/134, all verified class
        // 0x10). Helper 0x13000135 sits just past this range (class 0x13) and
        // stays EXCLUDED. The jump gate's narrower `0x0128..=0x0131` blocked
        // sub-range is a subset of this.
        //
        // Motion-dispatch audit A9 (2026-06-09): the range start was lowered
        // from 0x11F to 0x11E to surface LogOut (0x1000011e) — a lifecycle
        // one-shot that is genuinely class 0x10 (verified ACE
        // `MotionCommand.cs:294`). TradePanel (0x900011d, class 0x09) sits one
        // below at 0x11D so the lowered range start does not pick up a non-0x10
        // command; MeditateState (0x4300011c) and the panel/state commands
        // below it stay excluded.
        0x011E..=0x0134 => Some(0x1000_0000 | u32::from(low16)),
        // ---- Motion-dispatch audit A2 (2026-06-09): social /emote
        // one-shot gestures. These are the single highest-prominence
        // motion-dispatch gap — `/bow`, `/wave`, `/cheer`, `/salute`,
        // `/dance`, … previously expanded to `None` here and were dropped
        // before reaching JS, so NO emote ever animated. Expanding them to
        // their full 32-bit `MotionCommand` lets the inbound `UpdateMotion`
        // be surfaced ONCE in Rust and shipped to JS; the renderer's
        // KIND_MOTION_ACTION path plays the full-32-bit key via `_tryPlayLink`
        // as a LoopOnce overlay (no JS classify change needed) as long as
        // (a) the expander emits the correct full key — done here — and
        // (b) `is_action_motion_command` returns true for class 0x13/0x12
        // (done below).
        //
        // ChatEmote class `0x13000000` — social emotes. Every low-16 here is
        // a one-shot gesture, verified against ACE
        // `Source/ACE.Entity/Enum/MotionCommand.cs` and cross-checked vs
        // chorizite / melt / WeenieViewer / ace-server (all five agree).
        // The corresponding *held* states (ShakeFistState … DrudgeDanceState)
        // are class `0x43000000`, NOT `0x13` — so widening is_action for
        // class 0x13 never converts a looping held state into a one-shot.
        0x004C => Some(0x1300_004C), // Cheer
        // ShakeFist (0x79) … Winded (0x9A) — a single contiguous, exclusively
        // class-0x13 span (ACE `MotionCommand.cs:128-161`). YMCA (0x9B,
        // class 0x12) sits just ABOVE 0x9A, so this range is split correctly
        // and never blanket-covers a mixed class.
        0x0079..=0x009A => Some(0x1300_0000 | u32::from(low16)),
        // Pray / Mock / Teapot — contiguous class-0x13 trio. Bounded by
        // IncreasePowerSetting (0xC9, class 0x09) below and SpecialAttack1
        // (0xCD, class 0x10) above (ACE `MotionCommand.cs:208-212`).
        0x00CA..=0x00CC => Some(0x1300_0000 | u32::from(low16)),
        // WarmHands — isolated class-0x13 (ACE `MotionCommand.cs:289`).
        0x0119 => Some(0x1300_0119), // WarmHands
        // Helper — isolated class-0x13 (ACE `MotionCommand.cs:317`). Sits one
        // past the swing range above (which ends at MagicPowerUp10Purple
        // 0x134, class 0x10) — must be an explicit arm so its 0x13 class is
        // not fabricated as 0x10.
        0x0135 => Some(0x1300_0135), // Helper
        // NudgeLeft (0x14A) … DrudgeDance (0x151) — contiguous class-0x13
        // span (ACE `MotionCommand.cs:338-345`): NudgeLeft/NudgeRight,
        // PointLeft/PointRight/PointDown, Knock, ScanHorizon, DrudgeDance.
        // Bounded by AtEaseState (0x149, class 0x43) below and LifestoneRecall
        // (0x153, class 0x10) above; HaveASeat (0x152, also 0x13) is just past
        // the audit-A2 scope and intentionally not surfaced here.
        0x014A..=0x0151 => Some(0x1300_0000 | u32::from(low16)),
        // Flatulence-class `0x12000000` — one-shot gestures sharing the
        // ChatEmote-adjacent class. Audit A2 surfaces YMCA + Flatulence; both
        // are genuine one-shots (no 0x12-class held variant exists).
        0x009B => Some(0x1200_009B), // YMCA
        0x00D4 => Some(0x1200_00D4), // Flatulence
        // Jump — set explicitly by begin_jump; not normally
        // round-tripped via UpdateMotion.
        0x003B => Some(0x2500_003B), // Jump
        // ---- Motion-dispatch audit A9 (2026-06-09): remaining dropped
        // one-shots whose TRUE class is 0x10 (attack/lifecycle/recall/use),
        // plus the two batch-2 emote omissions (HaveASeat 0x13, Demonet 0x12).
        // Every low-16 + class below is verified against ACE
        // `Source/ACE.Entity/Enum/MotionCommand.cs`. These ride the JS
        // KIND_MOTION_ACTION path via `_tryPlayLink` once the expander emits
        // the full key (here) AND `is_action_motion_command` returns true —
        // which it already does for all of class 0x10 and (batch-2) all of
        // 0x13/0x12. Audit A7 (2026-06-09) additionally surfaces the class-0x40
        // USE one-shots CastSpell (0x400000d3) and UseMagicStaff/Wand
        // (0x400000e0/e1) via dedicated 0x40 arms below + a SURGICAL is_action
        // 0x40 extension. The TwitchSubstates (0x400000e4..e6) remain EXCLUDED:
        // they are HELD substates (see the Blink/Bite arm comment), not
        // one-shots. The match is first-match; each new arm sits in a genuine
        // gap between existing arms (no overlap / unreachable pattern).
        //
        // Lifecycle one-shots EnterGame..ExitPortal — contiguous class 0x10
        // (ACE `MotionCommand.cs:163-168`): EnterGame 0x1000009c, ExitGame,
        // OnCreation, OnDestruction, EnterPortal, ExitPortal 0x100000a1.
        // Bounded by Winded (0x9a, 0x13) / YMCA (0x9b, 0x12) below and Cancel
        // (0x800000a2, class 0x08) above.
        0x009C..=0x00A1 => Some(0x1000_0000 | u32::from(low16)),
        // Monster specials SpecialAttack1-3 + MissileAttack1-3 — contiguous
        // class 0x10 (ACE `MotionCommand.cs:212-217`): SpecialAttack1
        // 0x100000cd .. MissileAttack3 0x100000d2. Bounded by Teapot (0xcc,
        // 0x13) below and CastSpell (0x400000d3, class 0x40) above, so the
        // range stops AT 0xd2 and does NOT fabricate a 0x10 class for CastSpell
        // (CastSpell gets its own 0x40 arm below). Flatulence (0xd4, 0x12) is
        // handled by its own arm.
        0x00CD..=0x00D2 => Some(0x1000_0000 | u32::from(low16)),
        // ---- Motion-dispatch audit A7 (2026-06-09): class-0x40 USE one-shots.
        // CastSpell — the generic cast-END clip, class 0x40 (ACE
        // `MotionCommand.cs:218`, 0x400000d3). It is a genuine ONE-SHOT: ACE
        // plays it via `new Motion(this, MotionCommand.CastSpell, speed)` with a
        // finite `MotionTable.GetAnimationLength(...)` (Monster_Magic.cs:215,223)
        // — a clip, not a held substate. It rides the JS KIND_MOTION_ACTION
        // overlay once the expander emits the full key (here) AND
        // `is_action_motion_command` admits its low-16 (extended below). Sits in
        // the gap between MissileAttack3 (0xd2, handled above) and Flatulence
        // (0xd4, class 0x12, its own arm), so this explicit single arm has no
        // overlap.
        0x00D3 => Some(0x4000_00D3), // CastSpell (one-shot cast-end clip)
        // Demonet — isolated class 0x12 one-shot (ACE `MotionCommand.cs:230`,
        // 0x120000df). Batch-2 omission; surfaced here. Surrounded by panel
        // commands (class 0x09) and 0x40-class use/twitch commands, so it must
        // be its own explicit arm.
        0x00DF => Some(0x1200_00DF), // Demonet
        // UseMagicStaff / UseMagicWand — contiguous class-0x40 USE one-shots
        // (ACE `MotionCommand.cs:231-232`): UseMagicStaff 0x400000e0,
        // UseMagicWand 0x400000e1. These are item-use gesture clips of the same
        // family as the Reload..JumpCharging use range already surfaced at
        // 0x16..=0x1d — finite one-shots, NOT held substates. Bounded by Demonet
        // (0xdf, class 0x12, its own arm above) below and Blink (0x100000e2,
        // class 0x10) above, so this exact 2-wide 0x40 arm has no overlap. The
        // is_action 0x40 arm is extended below to admit 0xe0/0xe1.
        0x00E0..=0x00E1 => Some(0x4000_0000 | u32::from(low16)),
        // Blink / Bite — contiguous class 0x10 monster attacks (ACE
        // `MotionCommand.cs:233-234`): Blink 0x100000e2, Bite 0x100000e3.
        // Bounded by UseMagicWand (0x400000e1, class 0x40 — own arm above) below
        // and TwitchSubstate1 (0x400000e4, class 0x40 — HELD substate, EXCLUDED)
        // above, so this is a 2-wide island of genuine 0x10 attacks. The
        // TwitchSubstate1-3 (0xe4..e6) commands are NOT surfaced: their name
        // ("Sub-state") + class 0x40 mark them as the entity's persistent,
        // continuously-looping HELD `substate` field (acclient `MotionState`
        // `curr_state->substate`), NOT one-shot overlays. Surfacing a held
        // substate onto the KIND_MOTION_ACTION path is exactly the C1/B9 gait
        // regression the is_action guard prevents, so they stay None.
        0x00E2..=0x00E3 => Some(0x1000_0000 | u32::from(low16)),
        // SkillHealSelf / SkillHealOther — contiguous class 0x10 use one-shots
        // (ACE `MotionCommand.cs:277,279`): SkillHealSelf 0x1000010e,
        // SkillHealOther 0x1000010f. SelectSelf (0x900010d, class 0x09) sits
        // below and PreviousMonster (0x9000110, class 0x09) above, so the range
        // is exactly these two.
        0x010E..=0x010F => Some(0x1000_0000 | u32::from(low16)),
        // HouseRecall — isolated class 0x10 (ACE `MotionCommand.cs:322`,
        // 0x1000013a). Sits above the Pickup5..Pickup20 block (0x136..0x139,
        // class 0x40) and below AtlatlCombat (0x8000013b, class 0x80), so it
        // must be its own arm.
        0x013A => Some(0x1000_013A), // HouseRecall
        // HaveASeat — isolated class 0x13 one-shot (ACE `MotionCommand.cs:346`,
        // 0x13000152). Batch-2 omission (the 0x14A..=0x151 emote span stops one
        // below at DrudgeDance 0x151). LifestoneRecall (0x153, 0x10) sits just
        // above, so HaveASeat needs its own explicit 0x13 arm.
        0x0152 => Some(0x1300_0152), // HaveASeat
        // LifestoneRecall — isolated class 0x10 (ACE `MotionCommand.cs:347`,
        // 0x10000153). Bounded by HaveASeat (0x152, 0x13) below and the panel
        // commands (class 0x09) above.
        0x0153 => Some(0x1000_0153), // LifestoneRecall
        // Fishing / MarketplaceRecall / EnterPKLite — contiguous class 0x10
        // (ACE `MotionCommand.cs:365-367`): Fishing 0x10000165,
        // MarketplaceRecall 0x10000166, EnterPKLite 0x10000167. Bounded by
        // MuteOnLosingFocus (0x9000164, class 0x09) below and AllegianceChat
        // (0x9000168, class 0x09) above.
        0x0165..=0x0167 => Some(0x1000_0000 | u32::from(low16)),
        // AllegianceHometownRecall..PunchSlowLow — one contiguous class 0x10
        // span (ACE `MotionCommand.cs:377-412`): AllegianceHometownRecall
        // 0x10000171, PKArenaRecall 0x10000172, the offhand/extended melee
        // block OffhandSlashHigh 0x10000173 .. AttackLow6 0x1000018e, and the
        // monster Punch block PunchFastHigh 0x1000018f .. PunchSlowLow
        // 0x10000194 — every entry in 0x171..=0x194 is class 0x10 with no gap
        // or other class. Bounded by IssueSlashCommand (0x9000170, class 0x09)
        // below and OffhandPunchFastHigh (0x10000195, class 0x10 — out of this
        // batch's scope) above. The offhand attacks AND Attack4-6 are real
        // melee swings; Punch1-6 are monster unarmed attacks.
        0x0171..=0x0194 => Some(0x1000_0000 | u32::from(low16)),
        _ => None,
    }
}

/// Wave 2 (2026-06-08, review C1/B6) — is this *expanded* 32-bit
/// `MotionCommand` a GENUINE one-shot "action" (a swing / use / cast
/// gesture the renderer plays ONCE as an overlay), as opposed to a
/// locomotion / stance / lifecycle STATE command that drives a cycle?
///
/// This is the single shared notion of "is an action" reused by every
/// surfacing path so locomotion/stance/state are NEVER mis-routed onto
/// the one-shot overlay (which would drive the LOCAL player's predicted
/// gait — the C1/B9 regression). It is deliberately NARROW:
///
/// * Class `0x10000000` — attack swings, magic windups, and multi-strike
///   chains. Every member of this class in ACE `MotionCommand.cs` is a
///   genuine one-shot action, so the whole class qualifies (B10).
/// * Class `0x13000000` — social /emote ChatEmote one-shot gestures
///   (Cheer, ShakeFist..Winded, Pray/Mock/Teapot, WarmHands, Helper,
///   NudgeLeft..DrudgeDance, …). **Motion-dispatch audit A2 (2026-06-09):**
///   every member of this class is a one-shot gesture played ONCE as an
///   overlay, so the whole class qualifies. This is what routes /emote onto
///   the KIND_MOTION_ACTION overlay path instead of dropping it on the
///   locomotion path. The held/looping emote *states* are class
///   `0x43000000` (ShakeFistState … DrudgeDanceState), NOT `0x13`, so
///   widening here never makes a held STATE into a one-shot — the C1/B9
///   gait-regression guard holds.
/// * Class `0x12000000` — YMCA / Flatulence (and friends) one-shot
///   gestures (audit A2). Same reasoning as 0x13: genuine one-shots, no
///   0x12-class held state exists.
/// * Class `0x40000000` — accepted ONLY for the narrow Reload..JumpCharging
///   USE range (low-16 `0x16..=0x1D`, which includes Eat `0x4000001A` /
///   Drink `0x4000001B` — B6) plus the audit-A7 (2026-06-09) class-0x40 USE
///   one-shots CastSpell (`0x400000D3` — the cast-END clip, played by ACE as
///   a finite-length `Motion`) and UseMagicStaff/UseMagicWand
///   (`0x400000E0`/`0x400000E1` — item-use gesture clips). The `0x40` class
///   ALSO carries non-action STATE commands (Stop `0x40000004`, Fallen
///   `0x40000008`, Dead `0x40000011`, Falling `0x40000015`), the
///   aim/magic-gesture substates (`0x4000001E..=0x40000039`), and the HELD
///   `TwitchSubstate1..3` (`0x400000E4..=0x400000E6` — the entity's
///   continuously-looping persistent `substate`, named "Sub-state" for that
///   reason) — none of which are surfaced as one-shot actions here.
///
/// Everything else (locomotion `0x44/0x45`, stance `0x41` Ready/Crouch/
/// Sitting/Sleeping, held emote/lifecycle STATE `0x43`, Jump `0x25`, …) is
/// NOT an action.
///
/// Verified against ACE `Source/ACE.Entity/Enum/MotionCommand.cs` (Stop
/// 0x40000004, Fallen 0x40000008, Dead 0x40000011, Falling 0x40000015,
/// Eat 0x4000001a, Drink 0x4000001b, Ready 0x41000003, Cheer 0x1300004c,
/// YMCA 0x1200009b, ShakeFistState 0x430000ea).
#[inline]
pub fn is_action_motion_command(full: u32) -> bool {
    match full & 0xFF00_0000 {
        // Attack / magic windup / multi-strike — all genuine actions.
        0x1000_0000 => true,
        // Motion-dispatch audit A2 (2026-06-09): social /emote one-shot
        // gestures. The whole class is one-shots; the LOOPING held variants
        // are class 0x43, not 0x13/0x12, so nothing that should loop is
        // wrongly made a one-shot.
        0x1300_0000 => true, // ChatEmote (Cheer, Wave, Bow, Salute, Dance, …)
        0x1200_0000 => true, // YMCA / Flatulence one-shots
        // Use class: ONLY the narrow Reload..JumpCharging use range
        // (Eat / Drink live here) plus the audit-A7 class-0x40 USE one-shots
        // CastSpell (0xd3) and UseMagicStaff/Wand (0xe0/0xe1). Excludes
        // Stop/Fallen/Dead/Falling, the aim/magic-gesture substates
        // (0x1e..=0x39), and the HELD TwitchSubstate1-3 (0xe4..=0xe6) — making a
        // held substate a one-shot is the C1/B9 gait regression this guard
        // prevents, so they are deliberately NOT in this match.
        0x4000_0000 => matches!(full & 0x0000_FFFF, 0x0016..=0x001D | 0x00D3 | 0x00E0 | 0x00E1),
        _ => false,
    }
}

#[cfg(test)]
mod motion_allows_jump_tests {
    use super::*;

    /// PhatSDK `MovementManager.cpp:434` — Fallen is the lone single
    /// value in the blocked set.
    #[test]
    fn fallen_is_blocked() {
        assert!(!motion_allows_jump(0x4000_0008), "Fallen must block jump");
    }

    /// PhatSDK `MovementManager.cpp:429` — `0x40000016..0x40000018` =
    /// Reload, Unload, Pickup.
    #[test]
    fn reload_unload_pickup_blocked() {
        assert!(!motion_allows_jump(0x4000_0016), "Reload must block");
        assert!(!motion_allows_jump(0x4000_0017), "Unload must block");
        assert!(!motion_allows_jump(0x4000_0018), "Pickup must block");
    }

    /// PhatSDK `MovementManager.cpp:432` — `0x41000012..0x41000014` =
    /// Crouch, Sitting, Sleeping.
    #[test]
    fn crouch_sitting_sleeping_blocked() {
        assert!(!motion_allows_jump(0x4100_0012), "Crouch must block");
        assert!(!motion_allows_jump(0x4100_0013), "Sitting must block");
        assert!(!motion_allows_jump(0x4100_0014), "Sleeping must block");
    }

    /// PhatSDK `MovementManager.cpp:433` — `0x4000001E..0x40000039` =
    /// AimLevel through MagicPray (spell windups).
    #[test]
    fn aim_states_and_magic_substates_blocked() {
        assert!(!motion_allows_jump(0x4000_001E), "AimLevel must block");
        assert!(!motion_allows_jump(0x4000_002B), "MagicBlast must block");
        assert!(!motion_allows_jump(0x4000_0031), "MagicHeal must block");
        assert!(!motion_allows_jump(0x4000_0039), "MagicPray must block");
    }

    /// PhatSDK `MovementManager.cpp:431` — `0x1000006F..0x10000078` =
    /// MagicPowerUp01..MagicPowerUp10 (cast windups).
    #[test]
    fn magic_powerup_windups_blocked() {
        assert!(
            !motion_allows_jump(0x1000_006F),
            "MagicPowerUp01 must block"
        );
        assert!(
            !motion_allows_jump(0x1000_0074),
            "MagicPowerUp06 must block"
        );
        assert!(
            !motion_allows_jump(0x1000_0078),
            "MagicPowerUp10 must block"
        );
    }

    /// PhatSDK `MovementManager.cpp:430` shifted into the 2015 command
    /// table (ERA-01): `0x1000012B..0x10000134` =
    /// MagicPowerUp01Purple..MagicPowerUp10Purple. PhatSDK's literal
    /// `0x128..0x131` is the 2013 window and is WRONG for our data.
    #[test]
    fn purple_powerups_blocked() {
        assert!(
            !motion_allows_jump(0x1000_012B),
            "MagicPowerUp01Purple must block"
        );
        assert!(
            !motion_allows_jump(0x1000_0131),
            "MagicPowerUp07Purple must block"
        );
        assert!(
            !motion_allows_jump(0x1000_0134),
            "MagicPowerUp10Purple must block"
        );
    }

    /// ERA-01 regression guard — TripleThrustLow/Med/High sit at
    /// `0x128`-`0x12A` in the 2015 table, just below the purple
    /// power-up window, and retail blocked jumping during them in
    /// NEITHER build.
    #[test]
    fn triple_thrust_allows_jump() {
        assert!(
            motion_allows_jump(0x1000_0128),
            "TripleThrustLow must allow jump"
        );
        assert!(
            motion_allows_jump(0x1000_0129),
            "TripleThrustMed must allow jump"
        );
        assert!(
            motion_allows_jump(0x1000_012A),
            "TripleThrustHigh must allow jump"
        );
    }

    /// ERA-02 — 11.6096 added two exact jump blocks.
    #[test]
    fn sanctuary_and_telegraph_cast_blocked() {
        assert!(
            !motion_allows_jump(0x1000_0057),
            "Sanctuary (lifestone bind) must block"
        );
        assert!(
            !motion_allows_jump(0x1000_019B),
            "AI_TelegraphCast must block"
        );
    }

    /// Allowed substates outside the PhatSDK ranges.
    #[test]
    fn ready_and_walk_allow_jump() {
        assert!(motion_allows_jump(0x4100_0003), "Ready must allow jump");
        assert!(
            motion_allows_jump(0x4500_0005),
            "WalkForward must allow jump"
        );
        assert!(
            motion_allows_jump(0x4400_0007),
            "RunForward must allow jump"
        );
    }

    /// Falling (0x40000015) is NOT in the PhatSDK blocked set — the
    /// `is_airborne` flag gates double-jumps separately.
    #[test]
    fn falling_substate_alone_does_not_block() {
        assert!(
            motion_allows_jump(0x4000_0015),
            "Falling itself is not blocked by motion_allows_jump"
        );
    }

    /// Boundary values around the blocked ranges — verify the ranges
    /// are inclusive on the low end, exclusive past the high end.
    #[test]
    fn range_boundaries_match_phatsdk() {
        // Just below Reload range
        assert!(
            motion_allows_jump(0x4000_0015),
            "Falling sits below the Reload range and is allowed"
        );
        // Just past Pickup
        assert!(
            motion_allows_jump(0x4000_0019),
            "0x40000019 = StoreInBackpack is allowed"
        );
        // Just below MagicPowerUp01
        assert!(motion_allows_jump(0x1000_006E), "SpinAttack is allowed");
        // Just past MagicPowerUp10
        assert!(motion_allows_jump(0x1300_0079), "ShakeFist is allowed");
        // Just past MagicPray
        assert!(motion_allows_jump(0x2000_003A), "StopTurning is allowed");
        // Just below the 2015 purple power-up window (ERA-01)
        assert!(
            motion_allows_jump(0x1000_012A),
            "TripleThrustHigh is allowed"
        );
        // Inside it — the 2013 window stopped at 0x131 and wrongly let
        // these three through (ERA-01)
        assert!(
            !motion_allows_jump(0x1000_0132),
            "MagicPowerUp08Purple must block"
        );
        // Just past the 2015 window
        assert!(
            motion_allows_jump(0x1000_0135),
            "0x10000135 sits past MagicPowerUp10Purple and is allowed"
        );
    }
}

#[cfg(test)]
mod expand_motion_command_low16_tests {
    use super::*;

    /// Wave 2 (2026-06-08) — Eat / Drink expand to their full 32-bit
    /// Action-class values so B6's local eat one-shot can resolve its
    /// MotionTable link. ACE `MotionCommand.cs:33-34`.
    #[test]
    fn eat_and_drink_expand_to_action_class() {
        assert_eq!(
            expand_motion_command_low16(0x1A),
            Some(0x4000_001A),
            "Eat low-16 0x1A must expand to 0x4000001A"
        );
        assert_eq!(
            expand_motion_command_low16(0x1B),
            Some(0x4000_001B),
            "Drink low-16 0x1B must expand to 0x4000001B"
        );
    }

    /// Wave 2 (2026-06-08) — a representative melee swing low-16
    /// (SlashHigh 0x5B) carries the 0x10000000 attack class bit so B10
    /// creature attacks resolve their swing link. ACE
    /// `MotionCommand.cs:98`.
    #[test]
    fn attack_swing_expands_with_attack_class_bit() {
        let slash_high = expand_motion_command_low16(0x5B)
            .expect("SlashHigh low-16 0x5B must expand");
        assert_eq!(
            slash_high & 0xF000_0000,
            0x1000_0000,
            "SlashHigh must carry the 0x10000000 attack class bit"
        );
        assert_eq!(
            slash_high, 0x1000_005B,
            "SlashHigh must expand to its full 0x1000005B value"
        );
    }

    /// The rest of the consumable/use range and the swing range keep the
    /// pre-Wave-2 jump-gate values intact (no class regression).
    #[test]
    fn ranges_carry_correct_class_prefixes() {
        // StoreInBackpack / Reading / JumpCharging — Action class.
        assert_eq!(expand_motion_command_low16(0x19), Some(0x4000_0019));
        assert_eq!(expand_motion_command_low16(0x1C), Some(0x4000_001C));
        assert_eq!(expand_motion_command_low16(0x1D), Some(0x4000_001D));
        // ThrustHigh / Shoot / AttackLow3 / SpinAttack — attack class.
        assert_eq!(expand_motion_command_low16(0x5A), Some(0x1000_005A));
        assert_eq!(expand_motion_command_low16(0x61), Some(0x1000_0061));
        assert_eq!(expand_motion_command_low16(0x6A), Some(0x1000_006A));
        assert_eq!(expand_motion_command_low16(0x6E), Some(0x1000_006E));
        // DoubleSlashHigh — multi-strike attack class.
        assert_eq!(expand_motion_command_low16(0x121), Some(0x1000_0121));
        // Reload / Pickup still resolve (jump-gate range unchanged).
        assert_eq!(expand_motion_command_low16(0x16), Some(0x4000_0016));
        assert_eq!(expand_motion_command_low16(0x18), Some(0x4000_0018));
    }

    /// Wave 2 (2026-06-08, review FIX 4a) — MagicPowerUp08/09/10Purple
    /// (0x132/133/134) expand to their class-0x10 attack values. The class-10
    /// swing range stops AT 0x134, so Helper (0x135) is never fabricated with
    /// the wrong 0x10 prefix.
    ///
    /// Motion-dispatch audit A2 (2026-06-09): Helper is now surfaced with its
    /// CORRECT class-0x13 key (0x13000135) by its own explicit arm — it is no
    /// longer a miss, but it is still NOT class 0x10. The original intent of
    /// this test (the swing-range arm must not bleed onto 0x135) is preserved.
    #[test]
    fn purple_powerups_08_to_10_attack_class_helper_is_0x13_not_0x10() {
        assert_eq!(expand_motion_command_low16(0x132), Some(0x1000_0132));
        assert_eq!(expand_motion_command_low16(0x133), Some(0x1000_0133));
        assert_eq!(expand_motion_command_low16(0x134), Some(0x1000_0134));
        assert_eq!(
            expand_motion_command_low16(0x135),
            Some(0x1300_0135),
            "Helper (0x13000135) is class 0x13 — surfaced by audit A2, must NOT \
             be the 0x10 swing class that ends one below it at 0x134"
        );
    }

    /// Wave 2 (2026-06-08, review C1/B6) — the shared action predicate is
    /// the single source of truth for "is this a one-shot action". Class
    /// 0x10 (all of it) and the narrow 0x40 use range (0x16..0x1D, incl.
    /// Eat/Drink) are actions; 0x40-class STATE (Stop/Fallen/Dead/Falling),
    /// 0x40-class aim/magic-gesture substates, 0x41 stance, and locomotion
    /// are NOT.
    #[test]
    fn is_action_motion_command_is_narrow() {
        // Genuine actions.
        assert!(is_action_motion_command(0x1000_005B), "SlashHigh swing");
        assert!(is_action_motion_command(0x1000_0078), "MagicPowerUp10");
        assert!(is_action_motion_command(0x1000_0134), "MagicPowerUp10Purple");
        assert!(is_action_motion_command(0x4000_001A), "Eat (use)");
        assert!(is_action_motion_command(0x4000_001B), "Drink (use)");
        assert!(is_action_motion_command(0x4000_0016), "Reload (use range)");
        assert!(is_action_motion_command(0x4000_001D), "JumpCharging (use range)");
        // 0x40-class STATE — NOT actions (the C1 hazard).
        assert!(!is_action_motion_command(0x4000_0004), "Stop");
        assert!(!is_action_motion_command(0x4000_0008), "Fallen");
        assert!(!is_action_motion_command(0x4000_0011), "Dead");
        assert!(!is_action_motion_command(0x4000_0015), "Falling");
        // 0x40-class aim/magic-gesture substates — NOT surfaced as actions
        // (deliberately narrow; do not broaden).
        assert!(!is_action_motion_command(0x4000_001E), "AimLevel");
        assert!(!is_action_motion_command(0x4000_0039), "MagicPray");
        // Stance (0x41), locomotion (0x44/0x45), Jump (0x25) — NOT actions.
        assert!(!is_action_motion_command(0x4100_0003), "Ready stance");
        assert!(!is_action_motion_command(0x4100_0013), "Sitting stance");
        assert!(!is_action_motion_command(0x4400_0007), "RunForward");
        assert!(!is_action_motion_command(0x4500_0005), "WalkForward");
        assert!(!is_action_motion_command(0x2500_003B), "Jump");
    }

    /// Motion-dispatch audit A2 (2026-06-09) — every social /emote low-16
    /// expands to its exact full 32-bit `MotionCommand` key, with the
    /// correct class prefix (0x13 for ChatEmote, 0x12 for YMCA/Flatulence).
    /// Values cross-checked against ACE / chorizite / melt / WeenieViewer /
    /// ace-server `MotionCommand.cs` (all five agree).
    #[test]
    fn emote_low16s_expand_to_exact_full_keys() {
        // Cheer (isolated, just below the swing range).
        assert_eq!(expand_motion_command_low16(0x4C), Some(0x1300_004C), "Cheer");
        // ShakeFist..Winded contiguous class-0x13 span (endpoints + interior).
        assert_eq!(
            expand_motion_command_low16(0x79),
            Some(0x1300_0079),
            "ShakeFist (range start)"
        );
        assert_eq!(expand_motion_command_low16(0x7D), Some(0x1300_007D), "BowDeep");
        assert_eq!(expand_motion_command_low16(0x87), Some(0x1300_0087), "Wave");
        assert_eq!(expand_motion_command_low16(0x8A), Some(0x1300_008A), "Salute");
        assert_eq!(
            expand_motion_command_low16(0x9A),
            Some(0x1300_009A),
            "Winded (range end)"
        );
        // YMCA (0x9B) is class 0x12 and sits just ABOVE the 0x13 range — the
        // range split is correct, NOT 0x1300009B.
        assert_eq!(
            expand_motion_command_low16(0x9B),
            Some(0x1200_009B),
            "YMCA must be class 0x12, not 0x13"
        );
        // Pray / Mock / Teapot trio.
        assert_eq!(expand_motion_command_low16(0xCA), Some(0x1300_00CA), "Pray");
        assert_eq!(expand_motion_command_low16(0xCB), Some(0x1300_00CB), "Mock");
        assert_eq!(expand_motion_command_low16(0xCC), Some(0x1300_00CC), "Teapot");
        // Flatulence — isolated class 0x12.
        assert_eq!(
            expand_motion_command_low16(0xD4),
            Some(0x1200_00D4),
            "Flatulence must be class 0x12"
        );
        // WarmHands / Helper — isolated class-0x13. Helper (0x135) sits one
        // past the class-0x10 swing range that ends at 0x134.
        assert_eq!(
            expand_motion_command_low16(0x119),
            Some(0x1300_0119),
            "WarmHands"
        );
        assert_eq!(
            expand_motion_command_low16(0x135),
            Some(0x1300_0135),
            "Helper must be class 0x13, not the 0x10 swing class below it"
        );
        // NudgeLeft..DrudgeDance contiguous class-0x13 span (endpoints +
        // interior).
        assert_eq!(
            expand_motion_command_low16(0x14A),
            Some(0x1300_014A),
            "NudgeLeft (range start)"
        );
        assert_eq!(
            expand_motion_command_low16(0x14C),
            Some(0x1300_014C),
            "PointLeft"
        );
        assert_eq!(expand_motion_command_low16(0x14F), Some(0x1300_014F), "Knock");
        assert_eq!(
            expand_motion_command_low16(0x150),
            Some(0x1300_0150),
            "ScanHorizon"
        );
        assert_eq!(
            expand_motion_command_low16(0x151),
            Some(0x1300_0151),
            "DrudgeDance (range end)"
        );
    }

    /// Motion-dispatch audit A2 (2026-06-09) — each newly-surfaced emote
    /// full key is an action, so the renderer routes it onto the
    /// KIND_MOTION_ACTION one-shot overlay path.
    #[test]
    fn emote_full_keys_are_actions() {
        for full in [
            0x1300_004C, // Cheer
            0x1300_0079, // ShakeFist
            0x1300_0087, // Wave
            0x1300_008A, // Salute
            0x1300_009A, // Winded
            0x1300_00CA, // Pray
            0x1300_00CC, // Teapot
            0x1300_0119, // WarmHands
            0x1300_0135, // Helper
            0x1300_014A, // NudgeLeft
            0x1300_0151, // DrudgeDance
            0x1200_009B, // YMCA
            0x1200_00D4, // Flatulence
        ] {
            assert!(
                is_action_motion_command(full),
                "{full:#010x} (emote) must be an action so it routes onto the one-shot overlay"
            );
        }
    }

    /// Motion-dispatch audit A2 (2026-06-09) — regression guard. The held
    /// emote STATE commands are class 0x43 (NOT 0x13/0x12), so widening
    /// is_action must NOT classify any of them as a one-shot — otherwise a
    /// looping held pose would be played once and snap back. Also confirm
    /// plain locomotion is untouched.
    #[test]
    fn emote_held_states_and_locomotion_are_not_actions() {
        // Held emote states (class 0x43) — must stay NON-actions so they loop.
        assert!(
            !is_action_motion_command(0x4300_00EA),
            "ShakeFistState (0x43 held) must NOT be a one-shot"
        );
        assert!(
            !is_action_motion_command(0x4300_00EB),
            "PrayState (0x43 held) must NOT be a one-shot"
        );
        assert!(
            !is_action_motion_command(0x4300_0144),
            "DrudgeDanceState (0x43 held) must NOT be a one-shot"
        );
        assert!(
            !is_action_motion_command(0x4300_00FD),
            "WindedState (0x43 held) must NOT be a one-shot"
        );
        // Locomotion negative — WalkForward still expands to its existing
        // value and is NOT an action (no regression to the gait path).
        assert_eq!(
            expand_motion_command_low16(0x05),
            Some(0x4500_0005),
            "WalkForward low-16 0x05 still expands to its existing value"
        );
        assert!(
            !is_action_motion_command(0x4500_0005),
            "WalkForward must NOT be an action (locomotion, not a one-shot)"
        );
        // RunForward negative (the other locomotion path).
        assert_eq!(expand_motion_command_low16(0x07), Some(0x4400_0007));
        assert!(!is_action_motion_command(0x4400_0007), "RunForward not an action");
    }

    /// Motion-dispatch audit A9 (2026-06-09) — every newly-surfaced class-0x10
    /// / 0x13 / 0x12 one-shot expands to its EXACT full 32-bit `MotionCommand`
    /// key, with the correct class byte. Values verified against ACE
    /// `Source/ACE.Entity/Enum/MotionCommand.cs`.
    #[test]
    fn audit_a9_low16s_expand_to_exact_full_keys() {
        // LogOut (0x1000011e) — the swing range was lowered from 0x11f to
        // 0x11e to surface this lifecycle one-shot; it is genuinely class 0x10.
        assert_eq!(
            expand_motion_command_low16(0x11E),
            Some(0x1000_011E),
            "LogOut must expand to 0x1000011e (class 0x10)"
        );
        // DoubleSlashLow (0x11f) — the next entry — still resolves to its
        // existing class-0x10 value (the lowered range start did not shift it).
        assert_eq!(
            expand_motion_command_low16(0x11F),
            Some(0x1000_011F),
            "DoubleSlashLow stays 0x1000011f"
        );
        // EnterGame..ExitPortal lifecycle one-shots — class 0x10.
        assert_eq!(
            expand_motion_command_low16(0x9C),
            Some(0x1000_009C),
            "EnterGame (range start)"
        );
        assert_eq!(expand_motion_command_low16(0x9D), Some(0x1000_009D), "ExitGame");
        assert_eq!(
            expand_motion_command_low16(0x9E),
            Some(0x1000_009E),
            "OnCreation"
        );
        assert_eq!(
            expand_motion_command_low16(0xA0),
            Some(0x1000_00A0),
            "EnterPortal"
        );
        assert_eq!(
            expand_motion_command_low16(0xA1),
            Some(0x1000_00A1),
            "ExitPortal (range end)"
        );
        // SpecialAttack1-3 / MissileAttack1-3 — class 0x10. The range stops at
        // 0xd2 (MissileAttack3) and EXCLUDES CastSpell 0xd3 (class 0x40).
        assert_eq!(
            expand_motion_command_low16(0xCD),
            Some(0x1000_00CD),
            "SpecialAttack1 (range start)"
        );
        assert_eq!(
            expand_motion_command_low16(0xCF),
            Some(0x1000_00CF),
            "SpecialAttack3"
        );
        assert_eq!(
            expand_motion_command_low16(0xD0),
            Some(0x1000_00D0),
            "MissileAttack1"
        );
        assert_eq!(
            expand_motion_command_low16(0xD2),
            Some(0x1000_00D2),
            "MissileAttack3 (range end)"
        );
        // Demonet (0x120000df) — isolated class 0x12 (batch-2 omission).
        assert_eq!(
            expand_motion_command_low16(0xDF),
            Some(0x1200_00DF),
            "Demonet must be class 0x12"
        );
        // Blink / Bite — class 0x10 island between 0x40-class neighbors.
        assert_eq!(expand_motion_command_low16(0xE2), Some(0x1000_00E2), "Blink");
        assert_eq!(expand_motion_command_low16(0xE3), Some(0x1000_00E3), "Bite");
        // SkillHealSelf / SkillHealOther — class 0x10 use one-shots.
        assert_eq!(
            expand_motion_command_low16(0x10E),
            Some(0x1000_010E),
            "SkillHealSelf"
        );
        assert_eq!(
            expand_motion_command_low16(0x10F),
            Some(0x1000_010F),
            "SkillHealOther"
        );
        // HouseRecall (0x1000013a) — isolated class 0x10 above the Pickup5..20
        // (0x136..0x139, class 0x40) block.
        assert_eq!(
            expand_motion_command_low16(0x13A),
            Some(0x1000_013A),
            "HouseRecall must be class 0x10"
        );
        // HaveASeat (0x13000152) — isolated class 0x13 (batch-2 omission),
        // one above DrudgeDance 0x151 (the prior emote range end).
        assert_eq!(
            expand_motion_command_low16(0x152),
            Some(0x1300_0152),
            "HaveASeat must be class 0x13"
        );
        // LifestoneRecall (0x10000153) — isolated class 0x10, one above
        // HaveASeat.
        assert_eq!(
            expand_motion_command_low16(0x153),
            Some(0x1000_0153),
            "LifestoneRecall must be class 0x10"
        );
        // Fishing / MarketplaceRecall / EnterPKLite — class 0x10.
        assert_eq!(
            expand_motion_command_low16(0x165),
            Some(0x1000_0165),
            "Fishing (range start)"
        );
        assert_eq!(
            expand_motion_command_low16(0x166),
            Some(0x1000_0166),
            "MarketplaceRecall"
        );
        assert_eq!(
            expand_motion_command_low16(0x167),
            Some(0x1000_0167),
            "EnterPKLite (range end)"
        );
        // AllegianceHometownRecall..PunchSlowLow — one contiguous class-0x10
        // span (recalls + offhand/extended melee + monster punches).
        assert_eq!(
            expand_motion_command_low16(0x171),
            Some(0x1000_0171),
            "AllegianceHometownRecall (range start)"
        );
        assert_eq!(
            expand_motion_command_low16(0x172),
            Some(0x1000_0172),
            "PKArenaRecall"
        );
        assert_eq!(
            expand_motion_command_low16(0x173),
            Some(0x1000_0173),
            "OffhandSlashHigh"
        );
        assert_eq!(
            expand_motion_command_low16(0x18E),
            Some(0x1000_018E),
            "AttackLow6"
        );
        assert_eq!(
            expand_motion_command_low16(0x18F),
            Some(0x1000_018F),
            "PunchFastHigh"
        );
        assert_eq!(
            expand_motion_command_low16(0x194),
            Some(0x1000_0194),
            "PunchSlowLow (range end)"
        );
    }

    /// Motion-dispatch audit A9 (2026-06-09) — every newly-surfaced full key is
    /// an action (class 0x10 / 0x13 / 0x12), so the renderer routes it onto the
    /// KIND_MOTION_ACTION one-shot overlay path. `is_action_motion_command`
    /// already returns true for all of these classes, so no is_action change
    /// was needed.
    #[test]
    fn audit_a9_full_keys_are_actions() {
        for full in [
            0x1000_011E, // LogOut
            0x1000_009C, // EnterGame
            0x1000_00A1, // ExitPortal
            0x1000_00CD, // SpecialAttack1
            0x1000_00D2, // MissileAttack3
            0x1200_00DF, // Demonet (class 0x12)
            0x1000_00E2, // Blink
            0x1000_00E3, // Bite
            0x1000_010E, // SkillHealSelf
            0x1000_010F, // SkillHealOther
            0x1000_013A, // HouseRecall
            0x1300_0152, // HaveASeat (class 0x13)
            0x1000_0153, // LifestoneRecall
            0x1000_0165, // Fishing
            0x1000_0166, // MarketplaceRecall
            0x1000_0167, // EnterPKLite
            0x1000_0171, // AllegianceHometownRecall
            0x1000_0172, // PKArenaRecall
            0x1000_0173, // OffhandSlashHigh
            0x1000_018E, // AttackLow6
            0x1000_018F, // PunchFastHigh
            0x1000_0194, // PunchSlowLow
            // Audit A7 (2026-06-09): class-0x40 USE one-shots now surfaced.
            0x4000_00D3, // CastSpell (cast-end clip)
            0x4000_00E0, // UseMagicStaff
            0x4000_00E1, // UseMagicWand
        ] {
            assert!(
                is_action_motion_command(full),
                "{full:#010x} (audit-A9 one-shot) must be an action so it routes onto the overlay"
            );
        }
    }

    /// Motion-dispatch audit A7 (2026-06-09) — the class-0x40 USE one-shots
    /// CastSpell / UseMagicStaff / UseMagicWand now expand to their exact full
    /// key AND are classified as actions, so they route onto the
    /// KIND_MOTION_ACTION overlay path.
    #[test]
    fn audit_a7_class0x40_use_oneshots_surfaced() {
        assert_eq!(
            expand_motion_command_low16(0xD3),
            Some(0x4000_00D3),
            "CastSpell 0xd3 expands to its class-0x40 key"
        );
        assert_eq!(
            expand_motion_command_low16(0xE0),
            Some(0x4000_00E0),
            "UseMagicStaff 0xe0 expands to its class-0x40 key"
        );
        assert_eq!(
            expand_motion_command_low16(0xE1),
            Some(0x4000_00E1),
            "UseMagicWand 0xe1 expands to its class-0x40 key"
        );
        assert!(
            is_action_motion_command(0x4000_00D3),
            "CastSpell is a one-shot action"
        );
        assert!(
            is_action_motion_command(0x4000_00E0),
            "UseMagicStaff is a one-shot action"
        );
        assert!(
            is_action_motion_command(0x4000_00E1),
            "UseMagicWand is a one-shot action"
        );
    }

    /// Motion-dispatch audit A7 (2026-06-09) — HELD-SUBSTATE exclusion guard.
    /// TwitchSubstate1-3 (0x400000e4..e6) are class 0x40 like the CastSpell /
    /// UseMagicStaff/Wand one-shots surfaced this batch, but their name
    /// ("Sub-state") + the acclient `MotionState.substate` semantics mark them
    /// as the entity's continuously-looping HELD substate, NOT one-shot
    /// overlays. They must stay `None` from the expander (no full key
    /// fabricated) and, even if hand-built, must NOT be classified as actions —
    /// surfacing a held substate onto the KIND_MOTION_ACTION path is the C1/B9
    /// gait regression the is_action guard exists to prevent.
    #[test]
    fn audit_a7_twitch_substates_excluded_as_held() {
        // The Blink/Bite arm stops at 0xe3, and there is no 0xe4..=0xe6 arm, so
        // these expand to None.
        assert_eq!(
            expand_motion_command_low16(0xE4),
            None,
            "TwitchSubstate1 0xe4 (HELD class-0x40 substate) must stay None"
        );
        assert_eq!(
            expand_motion_command_low16(0xE5),
            None,
            "TwitchSubstate2 0xe5 (HELD substate) must stay None"
        );
        assert_eq!(
            expand_motion_command_low16(0xE6),
            None,
            "TwitchSubstate3 0xe6 (HELD substate) must stay None"
        );
        // Even a hand-built full key must NOT be classified as an action: the
        // surgical is_action 0x40 extension admits exactly 0x16..=0x1d | 0xd3 |
        // 0xe0 | 0xe1 — and NOT 0xe4..=0xe6.
        assert!(
            !is_action_motion_command(0x4000_00E4),
            "TwitchSubstate1 0x400000e4 must NOT be an action (held substate)"
        );
        assert!(
            !is_action_motion_command(0x4000_00E5),
            "TwitchSubstate2 0x400000e5 must NOT be an action (held substate)"
        );
        assert!(
            !is_action_motion_command(0x4000_00E6),
            "TwitchSubstate3 0x400000e6 must NOT be an action (held substate)"
        );
    }

    /// Motion-dispatch audit A7 (2026-06-09) — is_action 0x40-widening
    /// REGRESSION guard. Extending the class-0x40 is_action arm to admit
    /// 0xd3/0xe0/0xe1 must NOT make any of the other class-0x40 STATE commands
    /// an action. Re-assert the canonical held/state 0x40 values stay false.
    #[test]
    fn audit_a7_class0x40_states_still_non_action() {
        assert!(!is_action_motion_command(0x4000_0004), "Stop (state) not action");
        assert!(!is_action_motion_command(0x4000_0008), "Fallen (state) not action");
        assert!(!is_action_motion_command(0x4000_0011), "Dead (state) not action");
        assert!(!is_action_motion_command(0x4000_0015), "Falling (state) not action");
        // The aim/magic-gesture substate range (0x1e..=0x39) and the held
        // Twitch substates (0xe4..=0xe6) sit adjacent to the newly-admitted
        // low-16s but must remain non-actions — the match is exact, not a range
        // widening over all of 0x40.
        assert!(!is_action_motion_command(0x4000_001E), "AimLevel (substate) not action");
        assert!(!is_action_motion_command(0x4000_0039), "MagicPray (substate) not action");
        assert!(!is_action_motion_command(0x4000_00E4), "TwitchSubstate1 (held) not action");
        // And the values just outside the admitted use-range/CastSpell keys
        // stay false (boundary checks): 0x15 (Falling, below 0x16), 0x1e (above
        // 0x1d), 0xd2 (MissileAttack3 is class 0x10, but a hand-built 0x40 d2
        // must not be admitted), 0xe2 (Blink — class 0x10, not a 0x40 action).
        assert!(!is_action_motion_command(0x4000_00D2), "0x400000d2 not in use range");
        assert!(!is_action_motion_command(0x4000_00E2), "0x400000e2 not in use range");
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct SkillBase {
    pub ranks: u32,
    pub init: u32,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct VitalBase {
    pub ranks: u32,
    pub start: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct LastSentStats {
    pub attributes: Vec<stats::Attribute>,
    pub vitals: Vec<stats::Vital>,
    pub skills: Vec<stats::Skill>,
    pub resistances: stats::Resistances,
    pub armor: i32,
    pub vitae: f32,
}

pub enum CharacterOptionMask {
    Options1(CharacterOptions1),
    Options2(CharacterOptions2),
}

/// Map a `CharacterOption` enum index to the underlying
/// `CharacterOptions1` or `CharacterOptions2` bitflag value. Exposed so
/// downstream crates (the wasm SessionHandle's `isCharacterOptionEnabled`
/// JS getter) can resolve a per-option boolean from a snapshot of the
/// raw bits without going through `PlayerState`.
pub fn character_option_mask(option: CharacterOption) -> CharacterOptionMask {
    match option {
        CharacterOption::AutoRepeatAttacks => {
            CharacterOptionMask::Options1(CharacterOptions1::AUTO_REPEAT_ATTACK)
        }
        CharacterOption::IgnoreAllegianceRequests => {
            CharacterOptionMask::Options1(CharacterOptions1::IGNORE_ALLEGIANCE_REQUESTS)
        }
        CharacterOption::IgnoreFellowshipRequests => {
            CharacterOptionMask::Options1(CharacterOptions1::IGNORE_FELLOWSHIP_REQUESTS)
        }
        CharacterOption::IgnoreAllTradeRequests => {
            CharacterOptionMask::Options1(CharacterOptions1::IGNORE_TRADE_REQUESTS)
        }
        CharacterOption::DisableMostWeatherEffects => {
            CharacterOptionMask::Options1(CharacterOptions1::DISABLE_MOST_WEATHER_EFFECTS)
        }
        CharacterOption::AlwaysDaylightOutdoors => {
            CharacterOptionMask::Options2(CharacterOptions2::PERSISTENT_AT_DAY)
        }
        CharacterOption::LetOtherPlayersGiveYouItems => {
            CharacterOptionMask::Options1(CharacterOptions1::ALLOW_GIVE)
        }
        CharacterOption::KeepCombatTargetsInView => {
            CharacterOptionMask::Options1(CharacterOptions1::VIEW_COMBAT_TARGET)
        }
        CharacterOption::Display3dTooltips => {
            CharacterOptionMask::Options1(CharacterOptions1::SHOW_TOOLTIPS)
        }
        CharacterOption::AttemptToDeceiveOtherPlayers => {
            CharacterOptionMask::Options1(CharacterOptions1::USE_DECEPTION)
        }
        CharacterOption::RunAsDefaultMovement => {
            CharacterOptionMask::Options1(CharacterOptions1::TOGGLE_RUN)
        }
        CharacterOption::StayInChatModeAfterSendingMessage => {
            CharacterOptionMask::Options1(CharacterOptions1::STAY_IN_CHAT_MODE)
        }
        CharacterOption::AdvancedCombatInterface => {
            CharacterOptionMask::Options1(CharacterOptions1::ADVANCED_COMBAT_UI)
        }
        CharacterOption::AutoTarget => {
            CharacterOptionMask::Options1(CharacterOptions1::AUTO_TARGET)
        }
        CharacterOption::VividTargetingIndicator => {
            CharacterOptionMask::Options1(CharacterOptions1::VIVID_TARGETING_INDICATOR)
        }
        CharacterOption::ShareFellowshipExpAndLuminance => {
            CharacterOptionMask::Options1(CharacterOptions1::FELLOWSHIP_SHARE_XP)
        }
        CharacterOption::AcceptCorpseLootingPermissions => {
            CharacterOptionMask::Options1(CharacterOptions1::ACCEPT_LOOT_PERMITS)
        }
        CharacterOption::ShareFellowshipLoot => {
            CharacterOptionMask::Options1(CharacterOptions1::FELLOWSHIP_SHARE_LOOT)
        }
        CharacterOption::AutomaticallyAcceptFellowshipRequests => {
            CharacterOptionMask::Options1(CharacterOptions1::AUTO_ACCEPT_FELLOW_REQUEST)
        }
        CharacterOption::SideBySideVitals => {
            CharacterOptionMask::Options1(CharacterOptions1::SIDE_BY_SIDE_VITALS)
        }
        CharacterOption::ShowCoordinatesByTheRadar => {
            CharacterOptionMask::Options1(CharacterOptions1::COORDINATES_ON_RADAR)
        }
        CharacterOption::DisplaySpellDurations => {
            CharacterOptionMask::Options1(CharacterOptions1::SPELL_DURATION)
        }
        CharacterOption::DisableHouseRestrictionEffects => {
            CharacterOptionMask::Options1(CharacterOptions1::DISABLE_HOUSE_RESTRICTION_EFFECTS)
        }
        CharacterOption::DragItemToPlayerOpensTrade => {
            CharacterOptionMask::Options1(CharacterOptions1::DRAG_ITEM_ON_PLAYER_OPENS_SECURE_TRADE)
        }
        CharacterOption::ShowAllegianceLogons => {
            CharacterOptionMask::Options1(CharacterOptions1::DISPLAY_ALLEGIANCE_LOGON_NOTIFICATIONS)
        }
        CharacterOption::UseChargeAttack => {
            CharacterOptionMask::Options1(CharacterOptions1::USE_CHARGE_ATTACK)
        }
        CharacterOption::UseCraftingChanceOfSuccessDialog => {
            CharacterOptionMask::Options1(CharacterOptions1::USE_CRAFT_SUCCESS_DIALOG)
        }
        CharacterOption::ListenToAllegianceChat => {
            CharacterOptionMask::Options1(CharacterOptions1::HEAR_ALLEGIANCE_CHAT)
        }
        CharacterOption::AllowOthersToSeeYourDateOfBirth => {
            CharacterOptionMask::Options2(CharacterOptions2::DISPLAY_DATE_OF_BIRTH)
        }
        CharacterOption::AllowOthersToSeeYourAge => {
            CharacterOptionMask::Options2(CharacterOptions2::DISPLAY_AGE)
        }
        CharacterOption::AllowOthersToSeeYourChessRank => {
            CharacterOptionMask::Options2(CharacterOptions2::DISPLAY_CHESS_RANK)
        }
        CharacterOption::AllowOthersToSeeYourFishingSkill => {
            CharacterOptionMask::Options2(CharacterOptions2::DISPLAY_FISHING_SKILL)
        }
        CharacterOption::AllowOthersToSeeYourNumberOfDeaths => {
            CharacterOptionMask::Options2(CharacterOptions2::DISPLAY_NUMBER_DEATHS)
        }
        CharacterOption::DisplayTimestamps => {
            CharacterOptionMask::Options2(CharacterOptions2::TIME_STAMP)
        }
        CharacterOption::SalvageMultipleMaterialsAtOnce => {
            CharacterOptionMask::Options2(CharacterOptions2::SALVAGE_MULTIPLE)
        }
        CharacterOption::ListenToGeneralChat => {
            CharacterOptionMask::Options2(CharacterOptions2::HEAR_GENERAL_CHAT)
        }
        CharacterOption::ListenToTradeChat => {
            CharacterOptionMask::Options2(CharacterOptions2::HEAR_TRADE_CHAT)
        }
        CharacterOption::ListenToLFGChat => {
            CharacterOptionMask::Options2(CharacterOptions2::HEAR_LFG_CHAT)
        }
        CharacterOption::ListenToRoleplayChat => {
            CharacterOptionMask::Options2(CharacterOptions2::HEAR_ROLEPLAY_CHAT)
        }
        CharacterOption::AppearOffline => {
            CharacterOptionMask::Options2(CharacterOptions2::APPEAR_OFFLINE)
        }
        CharacterOption::AllowOthersToSeeYourNumberOfTitles => {
            CharacterOptionMask::Options2(CharacterOptions2::DISPLAY_NUMBER_CHARACTER_TITLES)
        }
        CharacterOption::UseMainPackAsDefaultForPickingUpItems => {
            CharacterOptionMask::Options2(CharacterOptions2::MAIN_PACK_PREFERRED)
        }
        CharacterOption::LeadMissileTargets => {
            CharacterOptionMask::Options2(CharacterOptions2::LEAD_MISSILE_TARGETS)
        }
        CharacterOption::UseFastMissiles => {
            CharacterOptionMask::Options2(CharacterOptions2::USE_FAST_MISSILES)
        }
        CharacterOption::FilterLanguage => {
            CharacterOptionMask::Options2(CharacterOptions2::FILTER_LANGUAGE)
        }
        CharacterOption::ConfirmUseOfRareGems => {
            CharacterOptionMask::Options2(CharacterOptions2::CONFIRM_VOLATILE_RARE_USE)
        }
        CharacterOption::ListenToSocietyChat => {
            CharacterOptionMask::Options2(CharacterOptions2::HEAR_SOCIETY_CHAT)
        }
        CharacterOption::ShowYourHelmOrHeadGear => {
            CharacterOptionMask::Options2(CharacterOptions2::SHOW_HELM)
        }
        CharacterOption::DisableDistanceFog => {
            CharacterOptionMask::Options2(CharacterOptions2::DISABLE_DISTANCE_FOG)
        }
        CharacterOption::UseMouseTurning => {
            CharacterOptionMask::Options2(CharacterOptions2::USE_MOUSE_TURNING)
        }
        CharacterOption::ShowYourCloak => {
            CharacterOptionMask::Options2(CharacterOptions2::SHOW_CLOAK)
        }
        CharacterOption::LockUI => CharacterOptionMask::Options2(CharacterOptions2::LOCK_UI),
        CharacterOption::ListenToPKDeathMessages => {
            CharacterOptionMask::Options2(CharacterOptions2::HEAR_PK_DEATH)
        }
        CharacterOption::CharacterOptions1Default => {
            CharacterOptionMask::Options1(CharacterOptions1::DEFAULT)
        }
        CharacterOption::CharacterOptions2Default => {
            CharacterOptionMask::Options2(CharacterOptions2::DEFAULT)
        }
    }
}

/// Session-local player model and derived player-facing state.
///
/// `PlayerState` owns player-specific data such as attributes, vitals, spells, inventory, and
/// protocol sequence tracking. It is intentionally **not** a second world object: authoritative
/// entity/object state lives on the player `Entity`, while `PlayerState` retains only local-player
/// overlays and session sequencing. Feature handlers under `crate::handlers` orchestrate message
/// flows and call into focused mutation methods on `PlayerState` and `WorldState`.
///
#[derive(Debug, Clone)]
pub struct PlayerState {
    /// Unique identifier for the player's character.
    pub guid: Guid,
    /// Computed attribute values (Strength, Endurance, etc.) including buffs.
    pub attributes: HashMap<stats::AttributeType, stats::Attribute>,
    /// Computed vital values (Health, Stamina, Mana) including current/max/buffed states.
    pub vitals: HashMap<stats::VitalType, stats::Vital>,
    /// Stores the raw ranks and start for vitals so they can be recalculated during stat updates.
    pub vital_bases: HashMap<stats::VitalType, VitalBase>,
    /// Computed skill values (Melee Defense, War Magic, etc.) including training level and buffs.
    pub skills: HashMap<stats::SkillType, stats::Skill>,
    /// Stores the raw ranks and init for skills so they can be recalculated during stat updates.
    pub skill_bases: HashMap<stats::SkillType, SkillBase>,
    /// Sequence for object instantiation/removal.
    pub instance_sequence: u16,
    /// Sequence for server-controlled movement/actions.
    pub server_control_sequence: u16,
    /// Last non-zero server-reported motion stance/style cached for outbound movement packets.
    pub last_server_motion_style: Option<MotionStance>,
    /// Continuous airborne time in seconds, accumulated by the local-pose
    /// integrator and reset by [`Self::land`]. Drives the fell-through-world
    /// failsafe (a legitimate retail fall lasts a few seconds at most; a
    /// multi-second freefall far below terrain means a transit bug ate the
    /// floor and the fall would otherwise never end).
    pub airborne_secs: f32,
    /// Sequence for teleportation events to ignore stale position updates.
    pub teleport_sequence: u16,
    /// Sequence for server-forced repositions (e.g. rubberbanding or physics corrections).
    pub force_position_sequence: u16,
    /// Sequence for client-initiated position updates.
    pub position_sequence: u16,
    /// Sequence for authoritative VectorUpdate (velocity/omega) frames.
    ///
    /// Retail's `SmartBox::DoVectorUpdate` gates velocity/omega
    /// application on `CPhysicsObj::update_times[3]` (the `ObjectVector`
    /// stamp, acclient.c:143459-143480) — distinct from
    /// `instance_sequence`. Previously the self VectorUpdate handler
    /// misfiled the VectorUpdate's `instance_sequence` onto
    /// `instance_sequence` and never stored `vector_sequence` at all;
    /// this field is the correctly-named home for the latter. Read by
    /// the `USE_VECTOR_SEQUENCE_GATE` (enabled 2026-06-04) newer-than gate
    /// in `state/mutations.rs::set_player_vector_gated`.
    pub vector_sequence: u16,
    /// Last grounded bit reported by authoritative self movement updates.
    pub last_server_grounded: Option<bool>,
    /// Monotonically increasing sequence for autonomous movement steps.
    pub movement_sequence: u16,
    /// Session-local private position overlays keyed by packet `PositionType`.
    pub local_position_overlays: HashMap<PositionType, holtburger_common::position::WorldPosition>,
    /// List of all active enchantments (buffs/debuffs) currently affecting the player.
    pub enchantments: Vec<Enchantment>,
    /// Master list of known spells (Knowledge). Maps SpellID -> Power/Modifier level.
    pub spells: BTreeMap<u32, f32>,
    /// Primary character option mask retained from PlayerDescription.
    pub options1: CharacterOptions1,
    /// Secondary character option mask retained from PlayerDescription.
    pub options2: CharacterOptions2,
    /// Content of the 8 spellbook hotbars (Organization). Each inner vec corresponds to a UI hotbar.
    pub hotbar_spells: Vec<Vec<u32>>,
    /// Quick-bar shortcut bindings (gmFloatyToolbarUI slots) hydrated
    /// from `PlayerDescription.shortcuts`. ACE persists these in the
    /// `CharacterPropertiesShortcutBar` table — server-authoritative on
    /// every login. The wasm `playerShortcuts()` getter publishes this
    /// vec so the JS hotbar can reconcile its localStorage cache.
    pub shortcuts: Vec<holtburger_protocol::messages::player::shortcuts::Shortcut>,
    /// Desired material component counts retained from PlayerDescription.
    pub desired_comps: Vec<(u32, u32)>,
    /// Spellbook filter bitfield retained from PlayerDescription.
    pub spellbook_filters: u32,
    /// Opaque gameplay options blob retained from PlayerDescription.
    pub gameplay_options: Vec<u8>,

    /// Flat set of all item GUIDs currently owned by the player (in pack or containers).
    pub inventory: HashSet<Guid>,
    /// Items currently equipped, mapped by their primary slot mask.
    pub equipment: HashMap<Guid, EquipMask>,

    /// Dirty tracking for emitted derived-stat snapshots.
    pub(crate) last_emitted_derived_stats: Option<LastSentStats>,

    /// `true` while the local-prediction integrator should integrate
    /// gravity on the player Z each tick instead of snapping to the
    /// terrain / cell floor. Set by the recv-loop `Jump` arm; cleared
    /// when the integrator detects landing (downward `vertical_velocity`
    /// + Z below floor). Mirrors ACE's airborne handling in
    /// `Player_Move.cs` (the integrator's gravity loop while no
    /// floor contact is reported).
    pub is_airborne: bool,
    /// Wave 5 Phase 5.1 (movement-animation overhaul, 2026-05-26):
    /// distinguishes a `begin_jump()`-initiated airborne phase from a
    /// "walked off a ledge" airborne phase. Set to `true` only by
    /// [`begin_jump`]; cleared by [`land`]. The recv-loop animation
    /// emission uses this flag to route the right `MotionCommand` to
    /// the renderer:
    /// - `is_airborne && is_jumping` → Jump clip (already broadcast
    ///   from JS keyup handler at `index.html:7755`)
    /// - `is_airborne && !is_jumping` → `Falling` cycle so the rig
    ///   doesn't T-pose during a ledge walk-off.
    pub is_jumping: bool,
    /// F1-6 (movement bughunt 2026-06-09): `true` while a jump charge is
    /// being held that began from a grounded STANDSTILL (no locomotion
    /// keys at charge start). Mirrors retail/ACE `charge_jump` setting
    /// `StandingLongJump = true` (`MotionInterp.cs:564-581`). While set:
    /// - the manual-drive integrator ROOTS the player (zero locomotion
    ///   target — `DoInterpretedMotion`'s StandingLongJump branch
    ///   suppresses Walk/Run/SideStep, `MotionInterp.cs:458-476`);
    ///   turning stays allowed;
    /// - the MoveToState `contact_long_jump` byte carries bit `0x2`
    ///   (`MoveToState.cs:43-48`) so ACE's broadcast converter excludes
    ///   Forward/Sidestep from the observer broadcast
    ///   (`MovementData.cs:104,123`);
    /// - at release the Jump arm computes the launch planar velocity
    ///   from the interpreted INTENT (`local_velocity_for_state`) rather
    ///   than the rooted integrator store, mirroring
    ///   `get_leave_ground_velocity = get_state_velocity()`
    ///   (`MotionInterp.cs:654-663`) — the classic standing long jump.
    ///
    /// Set by the wasm `jumpChargeBegin` export (JS space-keydown);
    /// cleared on jump dispatch ([`begin_jump`]), touchdown/teleport
    /// ([`land`]), and charge cancel.
    pub standing_long_jump_charge: bool,
    /// Player's local Z velocity in m/s while [`is_airborne`].
    /// Initialized to the result of [`compute_jump_velocity_z`]
    /// on `Jump` and decremented by `9.8 * dt` per tick (ACE
    /// `MovementSystem.GetJumpHeight` derives height from this same
    /// kinematic — `v = sqrt(h * 19.6)` → `g = 9.8 m/s²`). Reset to
    /// 0.0 on landing or teleport.
    pub vertical_velocity: f32,
    /// Physics deep-dive 2026-06-01 (gap 3 follow-up: edge_slide).
    /// The local player's `AllowEdgeSlide` physics flag — retail's
    /// `ObjectInfoState.EdgeSlide` (acclient `OBJECT_INFO_STATE`
    /// `EDGE_SLIDE 0x2`; ACE `PhysicsState.EdgeSlide 0x00400000`,
    /// hydrated into [`PropertyBool::AllowEdgeSlide`] at
    /// `hydration.rs:285-288`). When set, retail's
    /// `Transition.EdgeSlide` (`Physics/Transition.cs:268-320`) skids the
    /// blocked motion along the contact-plane tangent instead of stopping
    /// dead; when clear it just stops. The local-prediction edge_slide
    /// path in `crates/holtburger-core/.../movement/system.rs` consults
    /// this flag before sliding a refused step-up's residual along the
    /// wall tangent.
    ///
    /// Default: `true` — matches the retail player default (the human
    /// body Setup ships with `EdgeSlide` set), and is the safe value
    /// before any `ObjectCreate`/`SetState` for the local player has
    /// hydrated the real flag. Refreshed from the local player's physics
    /// state in the `ObjectCreate` + `SetState` handlers
    /// (`handlers/player.rs`, `state/mutations.rs`).
    pub allow_edge_slide: bool,
    /// Wave 10 Phase 10.2 (movement-animation overhaul, 2026-05-26):
    /// the player's last-known full 32-bit `MotionCommand` substate.
    /// Mirrors PhatSDK's `CMotionInterp::interpreted_state.forward_command`
    /// (`external/GDL/PhatSDK/MovementManager.cpp:724`), which is the
    /// argument to `motion_allows_jump()` for the jump-charge gate
    /// (`MovementManager.cpp:471, 589, 1019, 1041`).
    ///
    /// Updated from three sources:
    ///
    /// 1. Server `GameMessage::UpdateMotion` for the local guid —
    ///    `data.data.state.forward_command` arrives as a low-16
    ///    [`InterpretedMotionCommand`]; the wasm-side recv handler
    ///    expands it via [`expand_motion_command_low16`] to a full
    ///    32-bit `MotionCommand` and assigns here. This covers
    ///    `/sit` (Crouch/Sitting/Sleeping), pickup, reload, item
    ///    use, spell windups (AimLevel..MagicPray + MagicPowerUp*),
    ///    and other server-driven pose changes.
    ///
    /// 2. Local jump dispatch ([`begin_jump`]) — assigns
    ///    `Jump (0x2500003B)`. The Jump substate itself is NOT in
    ///    PhatSDK's blocked set, but [`is_airborne`] already gates
    ///    double-jumps separately.
    ///
    /// 3. Local touchdown (recv-loop diff `was_airborne && !is_airborne`)
    ///    — assigns `Ready (0x41000003)` via the post-tick
    ///    [`Self::land_to_ready`] helper. Mirrors PhatSDK
    ///    `apply_interpreted_movement` falling back to Ready on
    ///    no-movement (`MovementManager.cpp:776-779`).
    ///
    /// Default: `Ready (0x41000003)` — the at-rest substate after
    /// character spawn before any UpdateMotion arrives.
    pub current_substate: u32,
    /// Wave 10 Phase 10.3 (movement-animation overhaul, 2026-05-26):
    /// smoothed lateral (X/Y) velocity in world meters per second.
    /// Mirrors `CPhysicsObj::m_velocityVector` from PhatSDK
    /// (`external/GDL/PhatSDK/PhysicsObj.h:333` — `Vector m_velocityVector`)
    /// in the X/Y plane only (Z is tracked separately in
    /// [`vertical_velocity`] for jump/fall arcs).
    ///
    /// Each tick the local-prediction integrator at
    /// `crates/holtburger-core/src/client/movement/system.rs`
    /// `advance_local_pose_for_manual_drive`:
    ///
    /// 1. Computes a `target_velocity` from
    ///    [`local_velocity_for_state`] (the input-derived velocity
    ///    based on which WASD keys the player is holding + their
    ///    current heading).
    /// 2. Applies friction decay to this stored
    ///    `current_planar_velocity` via
    ///    `v *= (1 - PLAYER_GROUND_FRICTION_PER_SEC).powf(dt)`
    ///    — mirrors `CPhysicsObj::calc_friction` formula at
    ///    `external/GDL/PhatSDK/PhysicsObj.cpp:558-559`. Skipped when
    ///    [`is_airborne`] (matches `transient_state & ON_WALKABLE_TS`
    ///    gate at `PhysicsObj.cpp:523`).
    /// 3. Snaps to zero when `|v| < PLAYER_VELOCITY_SNAP_THRESHOLD`
    ///    — mirrors the `small_velocity` short-circuit at
    ///    `PhysicsObj.cpp:589-592`.
    /// 4. Moves toward `target_velocity` capped at
    ///    `PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ * dt` per
    ///    axis. PhatSDK has no explicit accel cap (retail uses
    ///    friction-only smoothing) — this is a wasm-side game-feel
    ///    addition to make direction changes ramp smoothly through
    ///    zero on the ground. The user explicitly called out
    ///    "jumping backwards and immediately holding W" as the
    ///    smell-test scenario.
    /// 5. The resulting `current_planar_velocity` is what drives
    ///    `pose.coords` deltas — NOT the raw input target. This is
    ///    the difference between Wave 10.3 and prior waves.
    ///
    /// Default: zero (player starts stationary).
    pub current_planar_velocity: Vector3,
    /// Physics deep-dive 2026-06-01 (gap 1): leftover frame time
    /// (seconds) below `MIN_QUANTUM` carried forward to the next
    /// integration frame. Mirrors ACE's `update_object` advancing
    /// `UpdateTime` only by the *consumed* time and leaving the
    /// sub-`MinQuantum` tail in the timer
    /// (`external/ACE/Source/ACE.Server/Physics/PhysicsObj.cs:4159-4188`):
    /// a stream of sub-`MinQuantum` rAF frames (e.g. 16 ms @ 60 Hz)
    /// accumulates here until it crosses `MIN_QUANTUM` and a slice is
    /// integrated, matching retail's 30 Hz physics gate. Without this
    /// accumulator, gating each frame on `MIN_QUANTUM` independently
    /// would drop every 60 Hz frame and freeze movement.
    ///
    /// Reset to 0.0 when a `HugeQuantum` hitch consumes the frame
    /// without integrating (mirrors ACE setting `UpdateTime =
    /// CurrentTime`). Bounded to `< MIN_QUANTUM` (≈33 ms) at all other
    /// times, so a position correction can at worst replay one
    /// sub-`MinQuantum` slice — self-correcting and negligible.
    ///
    /// Default: zero.
    pub physics_time_accumulator: f32,
    /// Physics deep-dive 2026-06-01 (cliff_slide Stage-2) — the XY wall
    /// normal of the most-recent wall the local-drive solver clamped
    /// against, carried ACROSS integration slices so the NEXT slice can
    /// treat it as `N_last` and cross it with the slice's own
    /// `N_new` (`Vector3::Cross(N_new, N_last)`, Z-zeroed) to skid the
    /// residual along the SEAM where two non-coplanar walls meet.
    ///
    /// This is the persistent carrier for retail's
    /// `CollisionInfo.LastKnownContactPlane` (ACE
    /// `Physics/Transition.cs` `CliffSlide` / `InitLastKnownContactPlane`,
    /// `acclient.c:312005`). Retail INVALIDATES that plane on a contact
    /// reset; we mirror that by setting this to `None` on touchdown
    /// ([`PlayerState::land`]) and on any server-driven reposition
    /// (teleport / force-position resync / autonomous sync, via
    /// `WorldState::update_player_position`) — after a discontinuous
    /// pose change the previously-tracked wall is meaningless and a
    /// stale cross-product would skid along a phantom seam.
    ///
    /// Consumed only when the [`crate::spatial::cliff_slide_residual_along_seam`]
    /// Stage-2 path is enabled behind the `USE_CLIFF_SLIDE` flag; when
    /// that flag is off this field is still maintained but never read,
    /// so the shipped solver behaviour is unchanged.
    ///
    /// Default: `None` (no wall tracked at spawn).
    pub last_known_wall_normal: Option<Vector3>,

    /// Physics deep-dive 2026-06-02 (precipice_slide re-entry) — backup
    /// pose captured BEFORE a step-down walkability check, mirroring
    /// ACE/retail `CTransition::save_check_pos` /
    /// `restore_check_pos` (`acclient.c:312499-312501`) and the
    /// `Transition.EdgeSlide → StepDown → precipice_slide` re-entry
    /// (`Transition.cs:282-319`). When the player walks off a ledge
    /// within `PLAYER_STEP_DOWN_HEIGHT`, the pre-descent pose is saved
    /// here so a step-down that lands on a non-walkable surface can be
    /// restored and re-attempted as a precipice slide.
    ///
    /// Maintained (saved-before-descend / cleared-on-resolution) ONLY
    /// when the `USE_PRECIPICE_SLIDE_REENTRY` flag in
    /// `holtburger-core`'s movement system is enabled; when that flag is
    /// off this field is never written or read, so the shipped solver
    /// behaviour is unchanged (same pattern as
    /// [`last_known_wall_normal`] under `USE_CLIFF_SLIDE`).
    ///
    /// Default: `None` (no backup pose at spawn).
    pub backup_pose_for_step_down: Option<holtburger_common::position::WorldPosition>,

    /// A7-R1 (2026-06-12, survey A7 §3 row 1): the local player's
    /// per-setup step heights — `Setup.step_up/step_down × Scale.Z`,
    /// fallback `DefaultStepHeight = 0.01`
    /// (`acclient.c:325400-325424`; ACE `PartArray.cs:236-248`). `None`
    /// until the wasm-side Setup hydration runs; the movement system
    /// consumes them via `set_setup_step_heights` ONLY under the
    /// default-off `USE_SETUP_STEP_HEIGHTS` flag — flag off, the
    /// hardcoded human-body 0.6/1.5 stay in effect (byte-identical: the
    /// player Setup `0x02000001` resolves to exactly those values).
    pub step_up_height: Option<f32>,
    pub step_down_height: Option<f32>,

    /// USE_RETAIL_GROUND (2026-07-02) — the mover's stored contact plane
    /// (+ its cell id), the retail `CPhysicsObj::contact_plane` /
    /// `contact_plane_cell_id` pair `SetPositionInternal` copies out of
    /// every transition (acclient.c:322538-322590) and
    /// `get_object_info` seeds back in at the next transition's entry
    /// (acclient.c:319085-319099, `init_contact_plane` /
    /// `init_last_known_contact_plane`). Written by
    /// `finish_manual_slice_via_transition` from
    /// `TransitionOutcome::contact_plane`; `None` until the first
    /// grounded transition (mirrors retail's invalid plane at spawn).
    pub last_contact_plane: Option<(holtburger_common::Plane, u32)>,

    /// Retail stationary-fall carry — the persistent
    /// `transient_state` 0x10/0x20 counter (`STATIONARY_FALL` bits) retail
    /// threads between physics frames: seeded into each transition
    /// (`CPhysicsObj::transition`, acclient.c:320104-320115), advanced by
    /// `validate_transition` on a falling frame that failed to move
    /// (acclient.c:312279-312312), and copied back post-transition
    /// (`CPhysicsObj::report_collision_end`, acclient.c:321862-321918 —
    /// which also zeroes the velocity at >1 and clears the bits at 0/3).
    /// At 2 the NEXT failed frame synthesizes a flat resting floor under the
    /// mover (acclient.c:312283-312311) — retail's guarantee that a fall
    /// wedged by geometry (every slice COLLIDED, contact cleared, pose
    /// restored) grounds in place after ~3 frames instead of hovering
    /// frozen forever. Values 0/1/2 (3 never persists).
    pub frames_stationary_fall: u8,

    /// Arrival-placement latch — set when an authoritative position lands on the
    /// local player via a hard positional discontinuity (teleport `Reset` /
    /// force-blip resync), consumed by the movement tick's arrival-placement
    /// pass. Retail runs a PLACEMENT transition on every `CPhysicsObj::SetPosition`
    /// (`find_placement_position`, acclient.c:313341) so an arrival that lands the
    /// capsule embedded in an env-cell wall is de-embedded before movement; our
    /// client applies server positions verbatim, so this latch schedules the same
    /// placement on the next tick. `false` once consumed (or when the cell BSP is
    /// not yet resident, it stays set for a later retry).
    pub pending_arrival_placement: bool,

    /// Teleport-arrival latch (soak-11 Layer-1, 2026-07-20). The
    /// `PlayerTeleport` (0xF748) handler pre-mirrors the destination's
    /// `teleport_sequence` onto [`Self::teleport_sequence`] (so outbound
    /// MoveToState / AutonomousPosition packets carry a current stamp). The
    /// follow-up self `UpdatePosition` for the destination therefore compares
    /// its `teleport_sequence` EQUAL to the mirrored value — `is_newer_u16`
    /// reads `false`, the B1/D3-SNAP discriminant never selects
    /// `AuthoritativeBodySync::Reset`, and the arrival hard-snap runs as an
    /// authoritative-only / `Snapshot` apply that NEVER latches
    /// [`Self::pending_arrival_placement`]. Result: retail's arrival PLACEMENT
    /// (`CPhysicsObj::SetPosition` → `find_placement_position`,
    /// acclient.c:313341) is skipped and a teleport that lands the capsule in
    /// an env-cell wall stays embedded (walk realizes 0m at the seam).
    ///
    /// The handler arms this flag ([`Self::arm_teleport_arrival`]); the next
    /// self `UpdatePosition` decision consumes it
    /// ([`Self::take_teleport_arrival`]) to force `Reset`, which latches the
    /// placement. Expiry is consume-once: the flag is cleared unconditionally
    /// by the very next self `UpdatePosition` decision, so the armed window is
    /// at most one `UpdatePosition`. ACE suspends position broadcasts across
    /// the teleport and F2-3 defers `LoginComplete` until the destination
    /// `UpdatePosition` has been applied, so that destination pose is reliably
    /// the next self `UpdatePosition` — the latch lands on the true arrival. A
    /// lost destination packet cannot strand a stale flag: the first
    /// subsequent self `UpdatePosition` still clears it.
    pub teleport_arrival_pending: bool,

    /// WP-2 (last-known-good cell, 2026-07-21). The most recent NON-NULL
    /// landblock the local player was authoritatively placed at — stamped on
    /// every non-null apply in [`WorldState::update_player_position_core`]
    /// (`state/mutations.rs`). Consumed as the FINAL heal fallback in
    /// `runtime_pose_for_guid` (after the working authoritative pose and the
    /// entity position) so a transient NULL-landblock pose — a null `posA`
    /// that arrives before the real arrival `posB` and is never reconciled —
    /// reports the source cell instead of collapsing
    /// `getLocalPlayerPose().objCellId` to 0.
    ///
    /// It also gates the retire-suppression in
    /// `reconcile_authoritative_body_with_remote`: while a last-known cell is
    /// held the local body is held Suspended at that cell rather than retired
    /// on a NULL pose. A genuine world-exit tears the player down (guid →
    /// NULL) rather than nulling a live position, so the retire stays valid
    /// for remote entities and for a local player that never established a
    /// cell.
    ///
    /// Default: `None` (no cell established before the first position apply).
    pub last_valid_landblock: Option<Guid>,

    /// C2 fix (rynth-review 07/17-SYNTHESIS streamline #5, 2026-07-23):
    /// the WHOLE last-known-good pose (cell + matching local coords +
    /// rotation), stamped atomically in the SAME write as
    /// [`Self::last_valid_landblock`]
    /// (`state/mutations.rs::update_player_position_core`). Before this
    /// fix, the FINAL heal fallback in `runtime_pose_for_guid` spliced
    /// `last_valid_landblock`'s cell onto the CURRENT working
    /// `body.pose.coords` — but those coords can already have advanced
    /// into a DIFFERENT cell's local frame while the landblock is
    /// momentarily NULL, yielding a self-consistent-looking but WRONG
    /// world position (mixed cell+coords pose; a bogus `worldXY` can
    /// spuriously trip the JS router's teleport-detection threshold).
    /// `runtime_pose_for_guid` now swaps in this whole snapshot instead
    /// of splicing, so the final fallback is atomic: cell and coords
    /// always come from the SAME authoritative apply.
    ///
    /// Default: `None` (mirrors `last_valid_landblock`).
    pub last_valid_pose: Option<holtburger_common::position::WorldPosition>,
}

impl Default for PlayerState {
    fn default() -> Self {
        Self::new()
    }
}

impl PlayerState {
    pub fn new() -> Self {
        Self {
            guid: Guid::NULL,
            attributes: HashMap::new(),
            vitals: HashMap::new(),
            vital_bases: HashMap::new(),
            skills: HashMap::new(),
            skill_bases: HashMap::new(),
            instance_sequence: 0,
            server_control_sequence: 0,
            last_server_motion_style: None,
            airborne_secs: 0.0,
            teleport_sequence: 0,
            force_position_sequence: 0,
            position_sequence: 0,
            vector_sequence: 0,
            last_server_grounded: None,
            movement_sequence: 0,
            local_position_overlays: HashMap::new(),
            enchantments: Vec::new(),
            spells: BTreeMap::new(),
            options1: CharacterOptions1::empty(),
            options2: CharacterOptions2::empty(),
            hotbar_spells: vec![Vec::new(); 8],
            shortcuts: Vec::new(),
            desired_comps: Vec::new(),
            spellbook_filters: 0,
            gameplay_options: Vec::new(),
            inventory: HashSet::new(),
            equipment: HashMap::new(),
            last_emitted_derived_stats: None,
            is_airborne: false,
            is_jumping: false,
            // F1-6 — no jump charge held at spawn.
            standing_long_jump_charge: false,
            vertical_velocity: 0.0,
            // Physics deep-dive 2026-06-01 (gap 3 follow-up) — default
            // to the retail player value (EdgeSlide set) until the local
            // player's physics state hydrates the real flag.
            allow_edge_slide: true,
            // Wave 10 Phase 10.2 (2026-05-26) — default to Ready
            // (the at-rest pose) so a fresh character can jump
            // before any UpdateMotion has arrived from the server.
            current_substate: MotionCommandCode::READY,
            // Wave 10 Phase 10.3 (2026-05-26) — player spawns
            // stationary; the integrator ramps from zero.
            current_planar_velocity: Vector3::zero(),
            // Physics deep-dive 2026-06-01 (gap 1) — no carried
            // frame time at spawn.
            physics_time_accumulator: 0.0,
            // Physics deep-dive 2026-06-01 (cliff_slide Stage-2) — no
            // wall tracked at spawn (mirrors retail's null
            // LastKnownContactPlane before the first contact).
            last_known_wall_normal: None,
            // Physics deep-dive 2026-06-02 (precipice_slide re-entry) —
            // no backup pose at spawn.
            backup_pose_for_step_down: None,
            // A7-R1: unhydrated until the wasm-side Setup read.
            step_up_height: None,
            step_down_height: None,
            // USE_RETAIL_GROUND: no contact plane tracked at spawn.
            last_contact_plane: None,
            // No stationary-fall history at spawn (retail transient_state
            // starts clear).
            frames_stationary_fall: 0,
            // No arrival pending at spawn (the initial login position runs the
            // normal enter-world path, not a discontinuity resync).
            pending_arrival_placement: false,
            // No teleport in flight at spawn.
            teleport_arrival_pending: false,
            // WP-2: no last-known-good cell before the first position apply.
            last_valid_landblock: None,
            // C2 fix: no last-known-good WHOLE pose before the first apply.
            last_valid_pose: None,
        }
    }

    /// Compute the bludgeon-type damage a player would take landing
    /// at vertical velocity `landing_vz` m/s (negative = downward).
    /// Mirrors ACE's `Player_Move.HandleFallingDamage`:
    ///
    /// ```text
    /// overspeed = 11.25434 + currVz + 4.5       // 11.25434 is the
    ///                                              hardcoded "jump
    ///                                              velocity" baseline
    ///                                              in ACE Player_Move
    /// ratio = -overspeed / 11.25434
    /// damage = if ratio > 0 { ratio * 87.293810 } else { 0 }
    /// ```
    ///
    /// Threshold: damage starts when `landing_vz < -15.75 m/s` (about
    /// the velocity from a 12.6m free-fall). Normal jumps in this
    /// client land at ~−4 to −10 m/s — well under the threshold, so
    /// damage is 0. Damage applies when the player falls off a
    /// cliff or from a high jump that descends past the launch level.
    ///
    /// **Client-side use is documentation only.** ACE applies fall
    /// damage server-side from `PhysicsObj.Velocity` (set by our
    /// `GameAction::Jump` packet's velocity field + server-side
    /// gravity integration) and broadcasts the resulting health
    /// update + chat message via the existing vital/chat channels —
    /// the client's normal recv loop picks them up without any
    /// jump-specific code. Predicting damage client-side risks
    /// HUD desync if the server's velocity calc diverges from ours.
    ///
    /// Source: `~/ace-server/Source/ACE.Server/WorldObjects/Player_Move.cs`
    /// (`HandleFallingDamage`).
    pub fn compute_fall_damage(landing_vz: f32) -> f32 {
        const JUMP_VELOCITY: f32 = 11.25434;
        const LEEWAY: f32 = 4.5;
        const DAMAGE_SCALE: f32 = 87.293810;
        let overspeed = JUMP_VELOCITY + landing_vz + LEEWAY;
        let ratio = -overspeed / JUMP_VELOCITY;
        if ratio > 0.0 {
            ratio * DAMAGE_SCALE
        } else {
            0.0
        }
    }

    /// Stamina cost for a jump. Mirrors ACE's
    /// `MovementSystem.JumpStaminaCost`:
    ///   - non-PK: `ceil((burden + 0.5) * power * 8 + 2)`
    ///   - PK: `(power + 1) * 100`
    ///
    /// Source: `~/ace-server/Source/ACE.Server/Physics/Animation/MovementSystem.cs`.
    ///
    /// ACE's `HandleActionJump` reads this and applies via
    /// `UpdateVitalDelta(Stamina, -staminaCost)`. We mirror the cost
    /// calc client-side so we can gate the jump on the player having
    /// enough stamina (ACE would reduce velocity if stamina were
    /// short, but the relevant branch is commented out — see
    /// `Player.cs:866`) and so the visible stamina bar tracks the
    /// expected deduction before the server confirms.
    pub fn jump_stamina_cost(power: f32, burden: f32, pk: bool) -> u32 {
        let power = power.clamp(0.0, 1.0);
        if pk {
            ((power + 1.0) * 100.0) as u32
        } else {
            ((burden + 0.5) * power * 8.0 + 2.0).ceil() as u32
        }
    }

    /// Retail `CACQualities::InqJumpVelocity` zero-stamina fold
    /// (acclient.c:443838-443839): after the enchant/aug skill
    /// composition, `if (!stamina) jumpskill = 0` — an exhausted
    /// player's jump collapses onto `GetJumpHeight`'s 0.34999999
    /// min-height clamp (vz = sqrt(0.35 × 19.6) ≈ 2.6192 at any
    /// power). Mirror of `exhausted_run_skill` (context.rs). Feed the
    /// result to [`Self::compute_jump_velocity_z`]; the wire Stamina
    /// `current` is the retail `InqAttribute2nd(4)`+enchant value.
    pub fn exhausted_jump_skill(jump_skill: u32, stamina_current: u32) -> u32 {
        if stamina_current == 0 { 0 } else { jump_skill }
    }

    /// Compute the upward Z velocity for a jump with the given
    /// power, burden, and Jump skill. Mirrors ACE's
    /// `WeenieObject.InqJumpVelocity` chain:
    ///   1. `MovementSystem.GetJumpHeight(burden, jumpSkill, power, 1.0)`
    ///   2. `velocity_z = sqrt(height * 19.6)` (kinematic with g=9.8)
    ///
    /// `power` is the jump-press extent in `[0.0, 1.0]`. Burden mod
    /// is 1.0 for burden < 1.0 (typical player), so a starter
    /// character (jumpSkill=50) at full power lifts ≈ 0.87m
    /// (≈4.13 m/s); jumpSkill=400 lifts ≈ 5.27m (≈10.16 m/s).
    /// Source: `~/ace-server/Source/ACE.Server/Physics/Animation/MovementSystem.cs`.
    pub fn compute_jump_velocity_z(power: f32, burden: f32, jump_skill: u32) -> f32 {
        let power = power.clamp(0.0, 1.0);
        let burden_mod = if burden < 1.0 {
            1.0
        } else if burden < 2.0 {
            2.0 - burden
        } else {
            // ACE's > 2.0 branch returns 0; matched but never hit
            // for normal play.
            0.0
        };
        let skill = jump_skill as f32;
        let height = burden_mod * (skill / (skill + 1300.0) * 22.2 + 0.05) * power;
        let height = height.max(0.35); // ACE min clamp
        (height * 19.6).sqrt()
    }

    /// Retail `CPhysicsObj::set_velocity` (acclient.c:318578-318615),
    /// adapted to the split player store (planar x/y +
    /// [`Self::vertical_velocity`] z): the `!=`-dedupe wraps the store
    /// and the terminal clamp, and the clamp is retail's two-step
    /// rounding — `normalize(v)` THEN per-component `*= 50`
    /// (:318586-318597), not a fused `* (50/|v|)`. Retail's other side
    /// effects — `jumped_this_frame = 1` and the activate
    /// (`transient_state |= 0x80` + `update_time` reset) — have no
    /// consumer in the externally-clocked slice loop; documented no-ops
    /// (dossier A F8).
    pub fn set_velocity(&mut self, velocity: Vector3) {
        const MAX_VELOCITY_M_PER_SEC: f32 = 50.0;
        let current = Vector3::new(
            self.current_planar_velocity.x,
            self.current_planar_velocity.y,
            self.vertical_velocity,
        );
        if velocity == current {
            return;
        }
        let mut v = velocity;
        let mag2 = v.x * v.x + v.y * v.y + v.z * v.z;
        if mag2 > MAX_VELOCITY_M_PER_SEC * MAX_VELOCITY_M_PER_SEC {
            let len = mag2.sqrt();
            v.x /= len;
            v.y /= len;
            v.z /= len;
            v.x *= MAX_VELOCITY_M_PER_SEC;
            v.y *= MAX_VELOCITY_M_PER_SEC;
            v.z *= MAX_VELOCITY_M_PER_SEC;
        }
        self.current_planar_velocity.x = v.x;
        self.current_planar_velocity.y = v.y;
        self.vertical_velocity = v.z;
    }

    /// Begin a jump locally. Sets [`is_airborne`] and stamps the
    /// initial vertical velocity. No-op when already airborne — ACE
    /// does not allow double-jumps; the recv-loop gate also enforces
    /// this so the wire packet is only sent for grounded jumps.
    pub fn begin_jump(&mut self, velocity_z: f32) {
        if self.is_airborne {
            return;
        }
        self.is_airborne = true;
        // F1-6 — the charge (if any) is consumed by this dispatch; the
        // caller decides the launch planar velocity (interpreted intent
        // for a standing long jump, integrator store otherwise) BEFORE
        // calling begin_jump.
        self.standing_long_jump_charge = false;
        // Trajectory lock (Track B3) — deliberately leave
        // `current_planar_velocity` untouched: the last grounded tick's
        // world-space planar velocity becomes the immutable airborne
        // launch velocity (mid-air WASD must not re-aim it), mirroring
        // retail `LeaveGround` / `get_leave_ground_velocity`
        // (`MotionInterp.cs:192`).
        // Wave 5 Phase 5.1 (2026-05-26) — flag this airborne phase as
        // jump-initiated so the recv-loop animation emission can choose
        // Jump clip vs Falling cycle. The Jump clip is broadcast from
        // the JS keyup handler at `index.html:7755`; this flag prevents
        // the parallel Falling emission from clobbering it.
        self.is_jumping = true;
        // Physics-parity 2026-07-03 (dossier A F8): the jump vz routes
        // through the retail set_velocity entry (dedupe + two-step
        // clamp); the planar components pass the trajectory-locked
        // launch velocity through unchanged.
        self.set_velocity(Vector3::new(
            self.current_planar_velocity.x,
            self.current_planar_velocity.y,
            velocity_z,
        ));
        // Wave 10 Phase 10.2 (2026-05-26) — stamp the substate so the
        // motion_allows_jump gate sees `Jump` after dispatch (Jump
        // itself is not in PhatSDK's blocked set; the is_airborne
        // flag is what stops the second-jump press).
        self.current_substate = MotionCommandCode::JUMP;
    }

    /// Begin an unjumped airborne fall — i.e., the player walked off a
    /// ledge or stepped off a cliff. Wave 5 Phase 5.1 (movement-
    /// animation overhaul, 2026-05-26). Sets [`is_airborne`] without
    /// the [`is_jumping`] marker so the recv-loop emission routes
    /// `Falling (0x40000015)` to the renderer instead of leaving the
    /// rig T-posed (the prior bug — the `setAirborne` overlay deleted
    /// in Wave 1 Phase 1.2 was the only visual cue for falling).
    /// `vertical_velocity` starts at 0 because the fall is acceleration-
    /// driven; the integrator decrements it by `9.8 * dt` per tick.
    /// No-op when already airborne.
    pub fn begin_fall(&mut self) {
        if self.is_airborne {
            return;
        }
        self.is_airborne = true;
        self.is_jumping = false;
        self.vertical_velocity = 0.0;
        // Wave 10 Phase 10.2 (2026-05-26) — stamp the in-air substate.
        // Falling itself isn't in PhatSDK's blocked set; is_airborne
        // is what gates a mid-air re-jump.
        self.current_substate = MotionCommandCode::FALLING;
    }

    /// Clear the airborne state on landing or teleport.
    pub fn land(&mut self) {
        self.is_airborne = false;
        self.is_jumping = false;
        self.vertical_velocity = 0.0;
        self.airborne_secs = 0.0;
        // F1-6 / G-7 — touchdown (or teleport, which routes through land)
        // drops any held standing-long-jump charge, per the field doc.
        self.standing_long_jump_charge = false;
        // Physics deep-dive 2026-06-01 (cliff_slide Stage-2) — touchdown
        // is a contact reset, so the wall tracked while airborne (if any)
        // is no longer the `LastKnownContactPlane` for the next grounded
        // slice. Mirrors retail invalidating
        // `CollisionInfo.LastKnownContactPlane` on a contact change.
        self.last_known_wall_normal = None;
        // Wave 10 Phase 10.2 (2026-05-26) — fall back to Ready on
        // touchdown. Mirrors PhatSDK `apply_interpreted_movement` →
        // `DoInterpretedMotion(0x41000003)` when no forward command
        // is queued (`MovementManager.cpp:776-779`). If the player
        // is holding W/A/S/D, the next manual-drive tick will
        // overwrite this with WalkForward/etc via the wire-side
        // UpdateMotion round-trip (`update_current_substate_from_low16`).
        self.current_substate = MotionCommandCode::READY;
    }

    /// Wave 10 Phase 10.2 (2026-05-26) — assign a new substate from a
    /// low-16 [`InterpretedMotionCommand`] value. Used by the recv-loop
    /// `UpdateMotion` handler when ACE broadcasts a self-motion edge
    /// (e.g. `/sit` → Sitting, `/use` → Reload, spell cast → AimLevel
    /// or MagicPowerUp*). When the low-16 doesn't map to a known
    /// 32-bit `MotionCommand`, the previous substate is preserved
    /// (permissive default — never silently block jumps on an unknown
    /// command).
    pub fn update_current_substate_from_low16(&mut self, low16: u16) {
        if let Some(full) = expand_motion_command_low16(low16) {
            self.current_substate = full;
        }
    }

    pub fn vitae(&self) -> f32 {
        crate::magic::get_total_vitae(&self.enchantments)
    }

    pub fn local_position_overlay(
        &self,
        position_type: PositionType,
    ) -> Option<holtburger_common::position::WorldPosition> {
        self.local_position_overlays.get(&position_type).copied()
    }

    pub fn set_local_position_overlay(
        &mut self,
        position_type: PositionType,
        position: holtburger_common::position::WorldPosition,
    ) {
        self.local_position_overlays.insert(position_type, position);
    }
}

impl PlayerState {
    /// Adds an item to the player's inventory tracking.
    pub fn add_to_inventory(&mut self, item: Guid) {
        self.inventory.insert(item);
    }

    /// Removes an item from the player's inventory tracking and equipment.
    pub fn remove_from_inventory(&mut self, item: Guid) {
        self.inventory.remove(&item);
        self.equipment.remove(&item);
    }

    /// Marks an item as equipped.
    pub fn wield_item(&mut self, item: Guid, slot: EquipMask) {
        self.inventory.insert(item);
        self.equipment.insert(item, slot);
    }

    /// Marks an item as unequipped.
    pub fn unwield_item(&mut self, item: Guid) {
        self.equipment.remove(&item);
    }

    pub fn attribute_snapshot(&self) -> Vec<stats::Attribute> {
        let mut attr_objs: Vec<_> = self.attributes.values().cloned().collect();
        attr_objs.sort_by_key(|a| a.attr_type as u32);
        attr_objs
    }

    pub fn vital_snapshot(&self) -> Vec<stats::Vital> {
        let mut vitals: Vec<_> = self.vitals.values().cloned().collect();
        vitals.sort_by_key(|v| v.vital_type as u32);
        vitals
    }

    pub fn skill_snapshot(&self) -> Vec<stats::Skill> {
        let mut skills: Vec<_> = self.skills.values().cloned().collect();
        skills.sort_by_key(|s| s.skill_type as u32);
        skills
    }

    pub fn character_option_enabled(&self, option: CharacterOption) -> bool {
        match character_option_mask(option) {
            CharacterOptionMask::Options1(flag) => self.options1.contains(flag),
            CharacterOptionMask::Options2(flag) => self.options2.contains(flag),
        }
    }

    pub fn set_character_option_enabled(&mut self, option: CharacterOption, enabled: bool) {
        match character_option_mask(option) {
            CharacterOptionMask::Options1(flag) => {
                self.options1.set(flag, enabled);
            }
            CharacterOptionMask::Options2(flag) => {
                self.options2.set(flag, enabled);
            }
        }
    }
}

#[cfg(test)]
mod jump_tests {
    use super::PlayerState;
    use holtburger_common::Vector3;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 0.05
    }

    #[test]
    fn starter_character_jump_velocity_matches_ace_formula() {
        // jumpSkill=50, burden=0.5 (mod 1.0), power=1.0:
        //   height = 1.0 * (50/1350 * 22.2 + 0.05) = 0.872m
        //   vz = sqrt(0.872 * 19.6) ≈ 4.13 m/s
        let vz = PlayerState::compute_jump_velocity_z(1.0, 0.5, 50);
        assert!(close(vz, 4.13), "expected ~4.13 m/s, got {vz}");
    }

    #[test]
    fn skilled_jumper_velocity_matches_ace_formula() {
        // jumpSkill=400, burden=0.5 (mod 1.0), power=1.0:
        //   height = 1.0 * (400/1700 * 22.2 + 0.05) = 5.27m
        //   vz = sqrt(5.27 * 19.6) ≈ 10.16 m/s
        let vz = PlayerState::compute_jump_velocity_z(1.0, 0.5, 400);
        assert!(close(vz, 10.16), "expected ~10.16 m/s, got {vz}");
    }

    #[test]
    fn min_jump_height_clamp_floors_at_35cm() {
        // power=0.0 + zero skill → ACE clamps to 0.35m floor
        //   vz = sqrt(0.35 * 19.6) ≈ 2.62 m/s
        let vz = PlayerState::compute_jump_velocity_z(0.0, 0.5, 0);
        assert!(close(vz, 2.62), "min-clamp vz: {vz}");
    }

    #[test]
    fn overburden_kills_jump_height() {
        // burden > 2.0 → BurdenMod = 0 → height clamps to 0.35m floor.
        let vz = PlayerState::compute_jump_velocity_z(1.0, 2.5, 100);
        assert!(close(vz, 2.62), "overburden vz: {vz}");
    }

    /// Retail zero-stamina fold (acclient.c:443838-443839): stamina 0
    /// collapses the composed jump skill to 0 → the exhausted jump
    /// rides the 0.35m min-height clamp (vz ≈ 2.62) at FULL power.
    /// Stamina > 0 passes the skill through untouched.
    #[test]
    fn exhausted_jump_skill_zero_stamina_folds_to_min_hop() {
        assert_eq!(PlayerState::exhausted_jump_skill(400, 0), 0);
        assert_eq!(PlayerState::exhausted_jump_skill(400, 1), 400);
        let vz = PlayerState::compute_jump_velocity_z(
            1.0,
            0.5,
            PlayerState::exhausted_jump_skill(400, 0),
        );
        assert!(close(vz, 2.62), "exhausted full-power jump vz: {vz}");
    }

    #[test]
    fn begin_jump_sets_airborne_and_velocity() {
        let mut p = PlayerState::new();
        assert!(!p.is_airborne);
        p.begin_jump(5.0);
        assert!(p.is_airborne);
        assert_eq!(p.vertical_velocity, 5.0);
    }

    /// Retail `set_velocity` (acclient.c:318578-318615): the store +
    /// clamp are wrapped in a `!=`-dedupe, and the terminal clamp is the
    /// two-step `normalize` THEN `*= 50` rounding — a 90 m/s +x input
    /// lands on exactly `(1.0f) * 50.0` per component, planar splits to
    /// x/y and z to `vertical_velocity`.
    #[test]
    fn set_velocity_dedupes_and_two_step_clamps() {
        let mut p = PlayerState::new();
        p.set_velocity(Vector3::new(3.0, 4.0, 5.0));
        assert_eq!(p.current_planar_velocity.x, 3.0);
        assert_eq!(p.current_planar_velocity.y, 4.0);
        assert_eq!(p.vertical_velocity, 5.0);
        // Dedupe: identical composite is a no-op (retail `!=` gate).
        p.set_velocity(Vector3::new(3.0, 4.0, 5.0));
        assert_eq!(p.current_planar_velocity.x, 3.0);
        // Over-terminal input clamps to 50 with two rounding steps.
        p.set_velocity(Vector3::new(90.0, 0.0, 0.0));
        let expected = (90.0_f32 / 90.0) * 50.0;
        assert_eq!(p.current_planar_velocity.x, expected);
        assert_eq!(p.current_planar_velocity.y, 0.0);
        assert_eq!(p.vertical_velocity, 0.0);
    }

    #[test]
    fn begin_jump_is_noop_when_already_airborne() {
        let mut p = PlayerState::new();
        p.begin_jump(5.0);
        p.begin_jump(99.0); // second press, mid-air
        assert_eq!(p.vertical_velocity, 5.0, "double-jump must not retrigger");
    }

    #[test]
    fn land_clears_airborne() {
        let mut p = PlayerState::new();
        p.begin_jump(5.0);
        p.land();
        assert!(!p.is_airborne);
        assert_eq!(p.vertical_velocity, 0.0);
    }

    /// Wave 5 Phase 5.1 (2026-05-26).
    #[test]
    fn begin_jump_marks_is_jumping() {
        let mut p = PlayerState::new();
        assert!(!p.is_jumping);
        p.begin_jump(5.0);
        assert!(p.is_airborne);
        assert!(p.is_jumping, "begin_jump must set is_jumping");
    }

    /// Wave 5 Phase 5.1 (2026-05-26).
    #[test]
    fn begin_fall_marks_airborne_without_jumping() {
        let mut p = PlayerState::new();
        p.begin_fall();
        assert!(p.is_airborne, "begin_fall must set is_airborne");
        assert!(!p.is_jumping, "begin_fall must NOT set is_jumping");
        assert_eq!(
            p.vertical_velocity, 0.0,
            "ledge walk-off starts with zero vz"
        );
    }

    /// Wave 5 Phase 5.1 (2026-05-26).
    #[test]
    fn begin_fall_is_noop_when_already_airborne() {
        let mut p = PlayerState::new();
        p.begin_jump(5.0);
        p.begin_fall();
        assert!(p.is_jumping, "begin_fall must not overwrite an active jump");
        assert_eq!(p.vertical_velocity, 5.0);
    }

    /// Wave 5 Phase 5.1 (2026-05-26).
    #[test]
    fn land_clears_is_jumping() {
        let mut p = PlayerState::new();
        p.begin_jump(5.0);
        assert!(p.is_jumping);
        p.land();
        assert!(!p.is_jumping, "land must clear is_jumping");
    }

    #[test]
    fn stamina_cost_non_pk_baseline() {
        // ACE: ceil((0.5 + 0.5) * 1.0 * 8 + 2) = ceil(10) = 10
        assert_eq!(PlayerState::jump_stamina_cost(1.0, 0.5, false), 10);
    }

    #[test]
    fn stamina_cost_non_pk_heavy_burden() {
        // burden=1.5: ceil((1.5+0.5)*1*8+2) = ceil(18) = 18
        assert_eq!(PlayerState::jump_stamina_cost(1.0, 1.5, false), 18);
    }

    #[test]
    fn stamina_cost_non_pk_low_power() {
        // power=0.25: ceil((0.5+0.5)*0.25*8+2) = ceil(4) = 4
        assert_eq!(PlayerState::jump_stamina_cost(0.25, 0.5, false), 4);
    }

    #[test]
    fn stamina_cost_pk_full_power() {
        // PK: (1.0 + 1.0) * 100 = 200
        assert_eq!(PlayerState::jump_stamina_cost(1.0, 0.5, true), 200);
    }

    #[test]
    fn stamina_cost_pk_zero_power() {
        // PK: (0 + 1) * 100 = 100 (PK pays even for nothing)
        assert_eq!(PlayerState::jump_stamina_cost(0.0, 0.5, true), 100);
    }

    #[test]
    fn stamina_cost_clamps_power_to_unit() {
        assert_eq!(
            PlayerState::jump_stamina_cost(1.5, 0.5, false),
            PlayerState::jump_stamina_cost(1.0, 0.5, false)
        );
    }

    #[test]
    fn fall_damage_below_threshold_is_zero() {
        // Normal jump landing velocities: ~-4 to -10 m/s. All below
        // ACE's threshold (-15.75 m/s, where overspeed crosses 0).
        assert_eq!(PlayerState::compute_fall_damage(0.0), 0.0);
        assert_eq!(PlayerState::compute_fall_damage(-5.0), 0.0);
        assert_eq!(PlayerState::compute_fall_damage(-10.0), 0.0);
        assert_eq!(PlayerState::compute_fall_damage(-15.7), 0.0);
    }

    #[test]
    fn fall_damage_at_threshold_starts_climbing() {
        // overspeed = 11.254 + (-20) + 4.5 = -4.246
        // ratio = 4.246 / 11.254 ≈ 0.377
        // damage = 0.377 * 87.29 ≈ 32.92
        let d = PlayerState::compute_fall_damage(-20.0);
        assert!((d - 32.92).abs() < 0.1, "got {d}");
    }

    #[test]
    fn fall_damage_high_velocity_lethal_range() {
        // Falling from a 50m+ cliff: vz ≈ -31 m/s
        // overspeed = 11.254 + (-31) + 4.5 = -15.246
        // ratio = 1.355
        // damage = 1.355 * 87.29 ≈ 118.3 (likely lethal for low HP)
        let d = PlayerState::compute_fall_damage(-31.0);
        assert!((d - 118.3).abs() < 0.5, "got {d}");
    }
}
