//! Auto-generated MotionCommand symbol table (test-only).
//!
//! Mirrors `Chorizite/Chorizite.Common/Enums/MotionCommand.cs` (409 entries
//! including `Invalid`). Used by motion-table inspection probes to print
//! human-readable command names alongside numeric IDs.
//!
//! Source: <https://github.com/Chorizite/Chorizite.Common/blob/main/Enums/MotionCommand.cs>
//!
//! Regeneration recipe (bash awk pipeline, see audit doc §9):
//!   gh api repos/Chorizite/Chorizite.Common/contents/Enums/MotionCommand.cs \
//!     --jq '.content' | base64 -d > MotionCommand.cs
//!   awk '/^[[:space:]]+\/\// {next}
//!        match($0, /^[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(0x[0-9a-fA-F]+)/, m) {
//!          printf "    (%s, \"%s\"),\n", m[2], m[1] }' MotionCommand.cs | \
//!     awk 'match($0, /^[[:space:]]+\((0x[0-9a-fA-F]+),[[:space:]]+"([^"]+)"/, m) {
//!          printf "%d\t    (%s, \"%s\"),\n", strtonum(m[1]), m[1], m[2] }' | \
//!     sort -n -k1 | cut -f2-
//!
//! All entries have distinct hex values (no collisions) — binary_search is unambiguous.

#![allow(dead_code)]

/// Full MotionCommand symbol table sourced from Chorizite.Common, sorted by
/// value for binary search. 409 entries.
pub static MOTION_COMMAND_NAMES: &[(u32, &str)] = &[
    (0x0, "Invalid"),
    (0x80000a2, "Cancel"),
    (0x80000a9, "CreateShortcutToSelected"),
    (0x80000b5, "EnterChat"),
    (0x80000b6, "ToggleChat"),
    (0x80000b7, "SavePosition"),
    (0x90000a3, "UseSelected"),
    (0x90000a4, "AutosortSelected"),
    (0x90000a5, "DropSelected"),
    (0x90000a6, "GiveSelected"),
    (0x90000a7, "SplitSelected"),
    (0x90000a8, "ExamineSelected"),
    (0x90000aa, "PreviousCompassItem"),
    (0x90000ab, "NextCompassItem"),
    (0x90000ac, "ClosestCompassItem"),
    (0x90000ad, "PreviousSelection"),
    (0x90000ae, "LastAttacker"),
    (0x90000af, "PreviousFellow"),
    (0x90000b0, "NextFellow"),
    (0x90000b1, "ToggleCombat"),
    (0x90000b8, "OptionsPanel"),
    (0x90000b9, "ResetView"),
    (0x90000c0, "FloorView"),
    (0x90000c2, "PreviousItem"),
    (0x90000c3, "NextItem"),
    (0x90000c4, "ClosestItem"),
    (0x90000c6, "MapView"),
    (0x90000c7, "AutoRun"),
    (0x90000c8, "DecreasePowerSetting"),
    (0x90000c9, "IncreasePowerSetting"),
    (0x90000d5, "FirstPersonView"),
    (0x90000d6, "AllegiancePanel"),
    (0x90000d7, "FellowshipPanel"),
    (0x90000d8, "SpellbookPanel"),
    (0x90000d9, "SpellComponentsPanel"),
    (0x90000da, "HousePanel"),
    (0x90000db, "AttributesPanel"),
    (0x90000dc, "SkillsPanel"),
    (0x90000dd, "MapPanel"),
    (0x90000de, "InventoryPanel"),
    (0x90000e7, "CaptureScreenshotToFile"),
    (0x90000fe, "AutoCreateShortcuts"),
    (0x90000ff, "AutoRepeatAttacks"),
    (0x9000100, "AutoTarget"),
    (0x9000101, "AdvancedCombatInterface"),
    (0x9000102, "IgnoreAllegianceRequests"),
    (0x9000103, "IgnoreFellowshipRequests"),
    (0x9000104, "InvertMouseLook"),
    (0x9000105, "LetPlayersGiveYouItems"),
    (0x9000106, "AutoTrackCombatTargets"),
    (0x9000107, "DisplayTooltips"),
    (0x9000108, "AttemptToDeceivePlayers"),
    (0x9000109, "RunAsDefaultMovement"),
    (0x900010a, "StayInChatModeAfterSend"),
    (0x900010b, "RightClickToMouseLook"),
    (0x900010c, "VividTargetIndicator"),
    (0x900010d, "SelectSelf"),
    (0x9000110, "PreviousMonster"),
    (0x9000111, "ClosestMonster"),
    (0x9000112, "NextPlayer"),
    (0x9000113, "PreviousPlayer"),
    (0x9000114, "ClosestPlayer"),
    (0x900011d, "TradePanel"),
    (0x9000154, "CharacterOptionsPanel"),
    (0x9000155, "SoundAndGraphicsPanel"),
    (0x9000156, "HelpfulSpellsPanel"),
    (0x9000157, "HarmfulSpellsPanel"),
    (0x9000158, "CharacterInformationPanel"),
    (0x9000159, "LinkStatusPanel"),
    (0x900015a, "VitaePanel"),
    (0x900015b, "ShareFellowshipXP"),
    (0x900015c, "ShareFellowshipLoot"),
    (0x900015d, "AcceptCorpseLooting"),
    (0x900015e, "IgnoreTradeRequests"),
    (0x900015f, "DisableWeather"),
    (0x9000160, "DisableHouseEffect"),
    (0x9000161, "SideBySideVitals"),
    (0x9000162, "ShowRadarCoordinates"),
    (0x9000163, "ShowSpellDurations"),
    (0x9000164, "MuteOnLosingFocus"),
    (0x9000168, "AllegianceChat"),
    (0x9000169, "AutomaticallyAcceptFellowshipRequests"),
    (0x900016a, "Reply"),
    (0x900016b, "MonarchReply"),
    (0x900016c, "PatronReply"),
    (0x900016d, "ToggleCraftingChanceOfSuccessDialog"),
    (0x900016e, "UseClosestUnopenedCorpse"),
    (0x900016f, "UseNextUnopenedCorpse"),
    (0x9000170, "IssueSlashCommand"),
    (0xc0000c1, "MouseLook"),
    (0xd0000b2, "HighAttack"),
    (0xd0000b3, "MediumAttack"),
    (0xd0000b4, "LowAttack"),
    (0xd0000ba, "CameraLeftRotate"),
    (0xd0000bb, "CameraRightRotate"),
    (0xd0000bc, "CameraRaise"),
    (0xd0000bd, "CameraLower"),
    (0xd0000be, "CameraCloser"),
    (0xd0000bf, "CameraFarther"),
    (0xd0000c5, "ShiftView"),
    (0x1000004a, "Hop"),
    (0x1000004b, "Jumpup"),
    (0x1000004d, "ChestBeat"),
    (0x1000004e, "TippedLeft"),
    (0x1000004f, "TippedRight"),
    (0x10000050, "FallDown"),
    (0x10000051, "Twitch1"),
    (0x10000052, "Twitch2"),
    (0x10000053, "Twitch3"),
    (0x10000054, "Twitch4"),
    (0x10000055, "StaggerBackward"),
    (0x10000056, "StaggerForward"),
    (0x10000057, "Sanctuary"),
    (0x10000058, "ThrustMed"),
    (0x10000059, "ThrustLow"),
    (0x1000005a, "ThrustHigh"),
    (0x1000005b, "SlashHigh"),
    (0x1000005c, "SlashMed"),
    (0x1000005d, "SlashLow"),
    (0x1000005e, "BackhandHigh"),
    (0x1000005f, "BackhandMed"),
    (0x10000060, "BackhandLow"),
    (0x10000061, "Shoot"),
    (0x10000062, "AttackHigh1"),
    (0x10000063, "AttackMed1"),
    (0x10000064, "AttackLow1"),
    (0x10000065, "AttackHigh2"),
    (0x10000066, "AttackMed2"),
    (0x10000067, "AttackLow2"),
    (0x10000068, "AttackHigh3"),
    (0x10000069, "AttackMed3"),
    (0x1000006a, "AttackLow3"),
    (0x1000006b, "HeadThrow"),
    (0x1000006c, "FistSlam"),
    (0x1000006d, "BreatheFlame"),
    (0x1000006e, "SpinAttack"),
    (0x1000006f, "MagicPowerUp01"),
    (0x10000070, "MagicPowerUp02"),
    (0x10000071, "MagicPowerUp03"),
    (0x10000072, "MagicPowerUp04"),
    (0x10000073, "MagicPowerUp05"),
    (0x10000074, "MagicPowerUp06"),
    (0x10000075, "MagicPowerUp07"),
    (0x10000076, "MagicPowerUp08"),
    (0x10000077, "MagicPowerUp09"),
    (0x10000078, "MagicPowerUp10"),
    (0x1000009c, "EnterGame"),
    (0x1000009d, "ExitGame"),
    (0x1000009e, "OnCreation"),
    (0x1000009f, "OnDestruction"),
    (0x100000a0, "EnterPortal"),
    (0x100000a1, "ExitPortal"),
    (0x100000cd, "SpecialAttack1"),
    (0x100000ce, "SpecialAttack2"),
    (0x100000cf, "SpecialAttack3"),
    (0x100000d0, "MissileAttack1"),
    (0x100000d1, "MissileAttack2"),
    (0x100000d2, "MissileAttack3"),
    (0x100000e2, "Blink"),
    (0x100000e3, "Bite"),
    (0x1000010e, "SkillHealSelf"),
    (0x1000010f, "SkillHealOther"),
    (0x1000011e, "LogOut"),
    (0x1000011f, "DoubleSlashLow"),
    (0x10000120, "DoubleSlashMed"),
    (0x10000121, "DoubleSlashHigh"),
    (0x10000122, "TripleSlashLow"),
    (0x10000123, "TripleSlashMed"),
    (0x10000124, "TripleSlashHigh"),
    (0x10000125, "DoubleThrustLow"),
    (0x10000126, "DoubleThrustMed"),
    (0x10000127, "DoubleThrustHigh"),
    (0x10000128, "TripleThrustLow"),
    (0x10000129, "TripleThrustMed"),
    (0x1000012a, "TripleThrustHigh"),
    (0x1000012b, "MagicPowerUp01Purple"),
    (0x1000012c, "MagicPowerUp02Purple"),
    (0x1000012d, "MagicPowerUp03Purple"),
    (0x1000012e, "MagicPowerUp04Purple"),
    (0x1000012f, "MagicPowerUp05Purple"),
    (0x10000130, "MagicPowerUp06Purple"),
    (0x10000131, "MagicPowerUp07Purple"),
    (0x10000132, "MagicPowerUp08Purple"),
    (0x10000133, "MagicPowerUp09Purple"),
    (0x10000134, "MagicPowerUp10Purple"),
    (0x1000013a, "HouseRecall"),
    (0x10000153, "LifestoneRecall"),
    (0x10000165, "Fishing"),
    (0x10000166, "MarketplaceRecall"),
    (0x10000167, "EnterPKLite"),
    (0x10000171, "AllegianceHometownRecall"),
    (0x10000172, "PKArenaRecall"),
    (0x10000173, "OffhandSlashHigh"),
    (0x10000174, "OffhandSlashMed"),
    (0x10000175, "OffhandSlashLow"),
    (0x10000176, "OffhandThrustHigh"),
    (0x10000177, "OffhandThrustMed"),
    (0x10000178, "OffhandThrustLow"),
    (0x10000179, "OffhandDoubleSlashLow"),
    (0x1000017a, "OffhandDoubleSlashMed"),
    (0x1000017b, "OffhandDoubleSlashHigh"),
    (0x1000017c, "OffhandTripleSlashLow"),
    (0x1000017d, "OffhandTripleSlashMed"),
    (0x1000017e, "OffhandTripleSlashHigh"),
    (0x1000017f, "OffhandDoubleThrustLow"),
    (0x10000180, "OffhandDoubleThrustMed"),
    (0x10000181, "OffhandDoubleThrustHigh"),
    (0x10000182, "OffhandTripleThrustLow"),
    (0x10000183, "OffhandTripleThrustMed"),
    (0x10000184, "OffhandTripleThrustHigh"),
    (0x10000185, "OffhandKick"),
    (0x10000186, "AttackHigh4"),
    (0x10000187, "AttackMed4"),
    (0x10000188, "AttackLow4"),
    (0x10000189, "AttackHigh5"),
    (0x1000018a, "AttackMed5"),
    (0x1000018b, "AttackLow5"),
    (0x1000018c, "AttackHigh6"),
    (0x1000018d, "AttackMed6"),
    (0x1000018e, "AttackLow6"),
    (0x1000018f, "PunchFastHigh"),
    (0x10000190, "PunchFastMed"),
    (0x10000191, "PunchFastLow"),
    (0x10000192, "PunchSlowHigh"),
    (0x10000193, "PunchSlowMed"),
    (0x10000194, "PunchSlowLow"),
    (0x10000195, "OffhandPunchFastHigh"),
    (0x10000196, "OffhandPunchFastMed"),
    (0x10000197, "OffhandPunchFastLow"),
    (0x10000198, "OffhandPunchSlowHigh"),
    (0x10000199, "OffhandPunchSlowMed"),
    (0x1000019a, "OffhandPunchSlowLow"),
    (0x1000019b, "WoahDuplicate2"),
    (0x1200009b, "YMCA"),
    (0x120000d4, "Flatulence"),
    (0x120000df, "Demonet"),
    (0x1300004c, "Cheer"),
    (0x13000079, "ShakeFist"),
    (0x1300007a, "Beckon"),
    (0x1300007b, "BeSeeingYou"),
    (0x1300007c, "BlowKiss"),
    (0x1300007d, "BowDeep"),
    (0x1300007e, "ClapHands"),
    (0x1300007f, "Cry"),
    (0x13000080, "Laugh"),
    (0x13000081, "MimeEat"),
    (0x13000082, "MimeDrink"),
    (0x13000083, "Nod"),
    (0x13000084, "Point"),
    (0x13000085, "ShakeHead"),
    (0x13000086, "Shrug"),
    (0x13000087, "Wave"),
    (0x13000088, "Akimbo"),
    (0x13000089, "HeartyLaugh"),
    (0x1300008a, "Salute"),
    (0x1300008b, "ScratchHead"),
    (0x1300008c, "SmackHead"),
    (0x1300008d, "TapFoot"),
    (0x1300008e, "WaveHigh"),
    (0x1300008f, "WaveLow"),
    (0x13000090, "YawnStretch"),
    (0x13000091, "Cringe"),
    (0x13000092, "Kneel"),
    (0x13000093, "Plead"),
    (0x13000094, "Shiver"),
    (0x13000095, "Shoo"),
    (0x13000096, "Slouch"),
    (0x13000097, "Spit"),
    (0x13000098, "Surrender"),
    (0x13000099, "Woah"),
    (0x1300009a, "Winded"),
    (0x130000ca, "Pray"),
    (0x130000cb, "Mock"),
    (0x130000cc, "Teapot"),
    (0x13000119, "WarmHands"),
    (0x13000135, "Helper"),
    (0x1300014a, "NudgeLeft"),
    (0x1300014b, "NudgeRight"),
    (0x1300014c, "PointLeft"),
    (0x1300014d, "PointRight"),
    (0x1300014e, "PointDown"),
    (0x1300014f, "Knock"),
    (0x13000150, "ScanHorizon"),
    (0x13000151, "DrudgeDance"),
    (0x13000152, "HaveASeat"),
    (0x2000003a, "StopTurning"),
    (0x2500003b, "Jump"),
    (0x40000004, "Stop"),
    (0x40000008, "Fallen"),
    (0x40000009, "Interpolating"),
    (0x4000000a, "Hover"),
    (0x4000000b, "On"),
    (0x4000000c, "Off"),
    (0x40000011, "Dead"),
    (0x40000015, "Falling"),
    (0x40000016, "Reload"),
    (0x40000017, "Unload"),
    (0x40000018, "Pickup"),
    (0x40000019, "StoreInBackpack"),
    (0x4000001a, "Eat"),
    (0x4000001b, "Drink"),
    (0x4000001c, "Reading"),
    (0x4000001d, "JumpCharging"),
    (0x4000001e, "AimLevel"),
    (0x4000001f, "AimHigh15"),
    (0x40000020, "AimHigh30"),
    (0x40000021, "AimHigh45"),
    (0x40000022, "AimHigh60"),
    (0x40000023, "AimHigh75"),
    (0x40000024, "AimHigh90"),
    (0x40000025, "AimLow15"),
    (0x40000026, "AimLow30"),
    (0x40000027, "AimLow45"),
    (0x40000028, "AimLow60"),
    (0x40000029, "AimLow75"),
    (0x4000002a, "AimLow90"),
    (0x4000002b, "MagicBlast"),
    (0x4000002c, "MagicSelfHead"),
    (0x4000002d, "MagicSelfHeart"),
    (0x4000002e, "MagicBonus"),
    (0x4000002f, "MagicClap"),
    (0x40000030, "MagicHarm"),
    (0x40000031, "MagicHeal"),
    (0x40000032, "MagicThrowMissile"),
    (0x40000033, "MagicRecoilMissile"),
    (0x40000034, "MagicPenalty"),
    (0x40000035, "MagicTransfer"),
    (0x40000036, "MagicVision"),
    (0x40000037, "MagicEnchantItem"),
    (0x40000038, "MagicPortal"),
    (0x40000039, "MagicPray"),
    (0x400000d3, "CastSpell"),
    (0x400000e0, "UseMagicStaff"),
    (0x400000e1, "UseMagicWand"),
    (0x400000e4, "TwitchSubstate1"),
    (0x400000e5, "TwitchSubstate2"),
    (0x400000e6, "TwitchSubstate3"),
    (0x40000136, "Pickup5"),
    (0x40000137, "Pickup10"),
    (0x40000138, "Pickup15"),
    (0x40000139, "Pickup20"),
    (0x41000003, "Ready"),
    (0x41000012, "Crouch"),
    (0x41000013, "Sitting"),
    (0x41000014, "Sleeping"),
    (0x420000f9, "ATOYOT"),
    (0x430000ea, "ShakeFistState"),
    (0x430000eb, "PrayState"),
    (0x430000ec, "BowDeepState"),
    (0x430000ed, "ClapHandsState"),
    (0x430000ee, "CrossArmsState"),
    (0x430000ef, "ShiverState"),
    (0x430000f0, "PointState"),
    (0x430000f1, "WaveState"),
    (0x430000f2, "AkimboState"),
    (0x430000f3, "SaluteState"),
    (0x430000f4, "ScratchHeadState"),
    (0x430000f5, "TapFootState"),
    (0x430000f6, "LeanState"),
    (0x430000f7, "KneelState"),
    (0x430000f8, "PleadState"),
    (0x430000fa, "SlouchState"),
    (0x430000fb, "SurrenderState"),
    (0x430000fc, "WoahState"),
    (0x430000fd, "WindedState"),
    (0x43000118, "SnowAngelState"),
    (0x4300011a, "CurtseyState"),
    (0x4300011b, "AFKState"),
    (0x4300011c, "MeditateState"),
    (0x4300013d, "SitState"),
    (0x4300013e, "SitCrossleggedState"),
    (0x4300013f, "SitBackState"),
    (0x43000140, "PointLeftState"),
    (0x43000141, "PointRightState"),
    (0x43000142, "TalktotheHandState"),
    (0x43000143, "PointDownState"),
    (0x43000144, "DrudgeDanceState"),
    (0x43000145, "PossumState"),
    (0x43000146, "ReadState"),
    (0x43000147, "ThinkerState"),
    (0x43000148, "HaveASeatState"),
    (0x43000149, "AtEaseState"),
    (0x44000007, "RunForward"),
    (0x45000005, "WalkForward"),
    (0x45000006, "WalkBackwards"),
    (0x6500000d, "TurnRight"),
    (0x6500000e, "TurnLeft"),
    (0x6500000f, "SideStepRight"),
    (0x65000010, "SideStepLeft"),
    (0x8000003c, "HandCombat"),
    (0x8000003d, "NonCombat"),
    (0x8000003e, "SwordCombat"),
    (0x8000003f, "BowCombat"),
    (0x80000040, "SwordShieldCombat"),
    (0x80000041, "CrossbowCombat"),
    (0x80000042, "UnusedCombat"),
    (0x80000043, "SlingCombat"),
    (0x80000044, "TwoHandedSwordCombat"),
    (0x80000045, "TwoHandedStaffCombat"),
    (0x80000046, "DualWieldCombat"),
    (0x80000047, "ThrownWeaponCombat"),
    (0x80000048, "Graze"),
    (0x80000049, "Magic"),
    (0x800000e8, "BowNoAmmo"),
    (0x800000e9, "CrossBowNoAmmo"),
    (0x8000013b, "AtlatlCombat"),
    (0x8000013c, "ThrownShieldCombat"),
    (0x85000001, "HoldRun"),
    (0x85000002, "HoldSidestep"),
];

/// Lookup the symbolic name for a MotionCommand value via binary search.
/// Returns `None` for unknown values.
pub fn motion_command_name(value: u32) -> Option<&'static str> {
    MOTION_COMMAND_NAMES
        .binary_search_by_key(&value, |&(v, _)| v)
        .ok()
        .map(|i| MOTION_COMMAND_NAMES[i].1)
}

/// Coarse semantic class of a MotionCommand, derived from the upper bits and
/// the symbol-name table. Drives the swing-pose classifier.
///
/// Encoding observations (verified against MotionCommand.cs):
/// - `0x40000000` prefix: locomotion / action / aim / magic gesture
/// - `0x41000000` prefix: posture (Ready, Crouch, Sitting, Sleeping)
/// - `0x42000000` prefix: ATOYOT
/// - `0x43000000` prefix: state emote (BowDeepState, MeditateState)
/// - `0x44000000` prefix: run (RunForward)
/// - `0x45000000` prefix: walk (WalkForward, WalkBackwards)
/// - `0x65000000` prefix: turn / sidestep (TurnLeft, TurnRight, SideStep*)
/// - `0x80000000` prefix: STANCE (HandCombat..ThrownShieldCombat, Magic)
/// - `0x85000000` prefix: hold-key (HoldRun, HoldSidestep)
/// - `0x90000000` prefix: UI panel / option toggle (no animation)
/// - `0x10000000` prefix: ACTION (attack swings, magic powerups, scripted slash)
/// - `0x13000000` prefix: quick emote (NudgeLeft, WarmHands, ScanHorizon)
/// - `0x12000000` prefix: misc (Demonet)
/// - `0x25000000` prefix: jump (Jump @ 0x2500003B)
/// - `0x20000000` prefix: stop (StopTurning)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum MotionCommandClass {
    Invalid,
    Stance,
    Locomotion,
    Turn,
    Jump,
    Stop,
    HoldKey,
    Aim,
    MagicGesture,    // 0x40000xxx that's a magic anim (MagicBlast..MagicPray)
    Posture,         // Ready, Crouch, Sitting, Sleeping
    StateEmote,      // 0x43000xxx (BowDeepState, MeditateState)
    QuickEmote,      // 0x13000xxx (NudgeLeft, WarmHands)
    UiPanel,         // 0x90000xxx (no animation)
    Action,          // 0x10000xxx but not classified as Attack
    AttackHigh,
    AttackMedium,
    AttackLow,
    Misc,
}

/// Classify a MotionCommand value. Returns `Invalid` for `0x0`.
pub fn motion_command_class(value: u32) -> MotionCommandClass {
    if value == 0 {
        return MotionCommandClass::Invalid;
    }
    let name = motion_command_name(value);

    // Hard-coded overrides for unique values.
    if value == 0x2500003B {
        return MotionCommandClass::Jump;
    }
    if value == 0x2000003A || (value & 0xFF000000) == 0x20000000 {
        return MotionCommandClass::Stop;
    }
    if let Some(n) = name {
        if n.starts_with("Aim") {
            return MotionCommandClass::Aim;
        }
        if n.starts_with("Magic") && (value & 0xFF000000) == 0x40000000 {
            return MotionCommandClass::MagicGesture;
        }
    }

    match value & 0xFF000000 {
        0x80000000 => MotionCommandClass::Stance,
        0x85000000 => MotionCommandClass::HoldKey,
        0x90000000 => MotionCommandClass::UiPanel,
        0x43000000 => MotionCommandClass::StateEmote,
        0x13000000 => MotionCommandClass::QuickEmote,
        0x41000000 => MotionCommandClass::Posture,
        0x44000000 | 0x45000000 => MotionCommandClass::Locomotion,
        0x65000000 => MotionCommandClass::Turn,
        0x10000000 => {
            // Swing taxonomy by name suffix on the 0x10000xxx range.
            let Some(n) = name else { return MotionCommandClass::Action; };
            let is_swing_root = n.contains("Attack")
                || n.contains("Slash")
                || n.contains("Thrust")
                || n.contains("Punch")
                || n.contains("Kick");
            if !is_swing_root {
                return MotionCommandClass::Action;
            }
            if n.contains("High") {
                MotionCommandClass::AttackHigh
            } else if n.contains("Med") {
                MotionCommandClass::AttackMedium
            } else if n.contains("Low") {
                MotionCommandClass::AttackLow
            } else {
                MotionCommandClass::Action
            }
        }
        0x40000000 => MotionCommandClass::Locomotion,
        _ => MotionCommandClass::Misc,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Table is strictly sorted by value (no duplicates).
    #[test]
    fn table_is_strictly_sorted_for_binary_search() {
        for w in MOTION_COMMAND_NAMES.windows(2) {
            assert!(
                w[0].0 < w[1].0,
                "table not strictly sorted: 0x{:08X} ({}) >= 0x{:08X} ({})",
                w[0].0,
                w[0].1,
                w[1].0,
                w[1].1
            );
        }
    }

    #[test]
    fn lookup_known_commands() {
        assert_eq!(motion_command_name(0x8000003D), Some("NonCombat"));
        assert_eq!(motion_command_name(0x4000000C), Some("Off"));
        assert_eq!(motion_command_name(0x45000005), Some("WalkForward"));
        assert_eq!(motion_command_name(0x44000007), Some("RunForward"));
        assert_eq!(motion_command_name(0x6500000D), Some("TurnRight"));
        assert_eq!(motion_command_name(0x2500003B), Some("Jump"));
        assert_eq!(motion_command_name(0x10000186), Some("AttackHigh4"));
        assert_eq!(motion_command_name(0xDEADBEEF), None);
    }

    #[test]
    fn classify_known_commands() {
        assert_eq!(motion_command_class(0x8000003D), MotionCommandClass::Stance);
        assert_eq!(motion_command_class(0x45000005), MotionCommandClass::Locomotion);
        assert_eq!(motion_command_class(0x6500000D), MotionCommandClass::Turn);
        assert_eq!(motion_command_class(0x2500003B), MotionCommandClass::Jump);
        assert_eq!(motion_command_class(0x4000001E), MotionCommandClass::Aim);
        assert_eq!(motion_command_class(0x4000002B), MotionCommandClass::MagicGesture);
        assert_eq!(motion_command_class(0x10000186), MotionCommandClass::AttackHigh);   // AttackHigh4
        assert_eq!(motion_command_class(0x10000187), MotionCommandClass::AttackMedium); // AttackMed4
        assert_eq!(motion_command_class(0x10000188), MotionCommandClass::AttackLow);    // AttackLow4
        assert_eq!(motion_command_class(0x1000011F), MotionCommandClass::AttackLow);    // DoubleSlashLow
        assert_eq!(motion_command_class(0x10000121), MotionCommandClass::AttackHigh);   // DoubleSlashHigh
        assert_eq!(motion_command_class(0x10000185), MotionCommandClass::Action);       // OffhandKick (no Hi/Med/Lo)
    }
}
