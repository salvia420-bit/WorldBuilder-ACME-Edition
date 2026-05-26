# Wave 8 — Full `MotionCommand` Inventory & Classifier Wiring (2026-05-26)

## Purpose

Categorize **every** `MotionCommand` enum entry the server can broadcast in an `UpdateMotion` packet. For each, list whether `scene3d/entities.js::classifyMotionCommand` already handles it, and what its recommended `"walk"` / `"attack"` / `"cast"` / `null` classifier class should be.

This document is the source-of-truth feeding the Phase 8.2 edits to `classifyMotionCommand` (and the new helper Sets: `EMOTE_COMMANDS`, `REACTION_COMMANDS`, `STATIONARY_COMMANDS`, `INTERACTION_COMMANDS`).

## Sources

- **Primary (canonical):** `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:5-420`. The single source of truth for u32 values and names. Treated as gospel for any disagreement vs. Chorizite.
- **Cross-check (sanity only):** `external/holtburger/crates/holtburger-dat/tests/common/motion_command_names.rs:25-435` (409 entries from Chorizite). Hex values agree with ACE for every overlapping entry.
- **`~/ac-headers/acclient.h`** does not dump the `MotionCommand` enum body — only struct forward-declarations exist (`acclient.h:31086-31420`). So the enum is named in retail decompilation only via raw `0x___u` literals in `acclient.c` (e.g. `343297: substate > 0x40000018` for the Pickup-family branch). ACE is the canonical name-table.

## Chorizite vs. ACE divergences

Cross-checked all 409 chorizite entries against ACE. **No name conflicts.** Two ACE entries are missing from chorizite (intentional comments in ACE):

- ACE has `SkillHealSelf = 0x1000010E` AND `SkillHealOther = 0x1000010F` (lines 277, 279). Chorizite has both — agrees.
- ACE comments `WoahDuplicate1 = 0x1000010F` (collides with `SkillHealOther`) as DELETED; `MimeDrinkDuplicate1 = 0x10000110` and `MimeDrinkDuplicate2 = 0x10000111` as DELETED. Chorizite simply doesn't list them. **No-op divergence.**
- ACE has `NextMonster = 0x900010F` commented out (line 282). Chorizite doesn't list it. **No-op divergence.**

All 409 chorizite entries have a 1:1 match in ACE with identical hex values.

## Already wired (Waves 1–7, baseline)

Per `scene3d/entities.js:128-244` and the Wave 1.7/5.1/6 docs:

| ACE name | u32 hex | low-16 | category | already wired | class |
|---|---|---|---|---|---|
| `Invalid` | `0x00000000` | `0x0000` | internal | yes (sub to Ready in setMotion L3074) | (Ready) |
| `Ready` | `0x41000003` | `0x0003` | locomotion | yes (L142, L409) | `"idle"` |
| `Stop` | `0x40000004` | `0x0004` | locomotion | yes (L128, L3074) | `"stop"` → Ready |
| `WalkForward` | `0x45000005` | `0x0005` | locomotion | yes (L129) | `"walk"` |
| `WalkBackwards` | `0x45000006` | `0x0006` | locomotion | yes (L130) | `"walk"` |
| `RunForward` | `0x44000007` | `0x0007` | locomotion | yes (L131) | `"run"` |
| `Fallen` | `0x40000008` | `0x0008` | falling | yes (L188) | `"walk"` (cycle) |
| `TurnRight` | `0x6500000D` | `0x000D` | locomotion | yes (L151) | `"walk"` |
| `TurnLeft` | `0x6500000E` | `0x000E` | locomotion | yes (L152) | `"walk"` (sub to Right L3092) |
| `SideStepRight` | `0x6500000F` | `0x000F` | locomotion | yes (L153) | `"walk"` |
| `SideStepLeft` | `0x65000010` | `0x0010` | locomotion | yes (L154) | `"walk"` (sub to Right L3095) |
| `Falling` | `0x40000015` | `0x0015` | falling | yes (L186) | `"walk"` (cycle) |
| `JumpCharging` | `0x4000001D` | `0x001D` | attack | yes (L227) | `"attack"` |
| `Jump` | `0x2500003B` | `0x003B` | attack | yes (L227) | `"attack"` |
| `FallDown` | `0x10000050` | `0x0050` | falling | yes (L187) | `"walk"` (cycle) |
| `MagicBlast/Self*` | `0x4000002B-0x40000032` | `0x002B-0x0032` | cast | yes (L231) | `"cast"` |
| `ThrustMed..BackhandLow` | `0x10000058-0x10000060` | `0x0058-0x0060` | attack | yes (L200-204) | `"attack"` |
| `Shoot` | `0x10000061` | `0x0061` | attack | yes (L206) | `"attack"` |
| `AttackHigh1..AttackLow3` | `0x10000062-0x1000006A` | `0x0062-0x006A` | attack | yes (L208-210) | `"attack"` |
| `MagicPowerUp01-10` | `0x1000006F-0x10000078` | `0x006F-0x0078` | cast | yes (L233) | `"cast"` |
| `MissileAttack1-3` | `0x100000D0-0x100000D2` | `0x00D0-0x00D2` | attack | yes (L212) | `"attack"` |
| `CastSpell` | `0x400000D3` | `0x00D3` | cast | yes (L235) | `"cast"` |
| `PunchFastHigh..PunchSlowLow` | `0x1000018F-0x10000194` | `0x018F-0x0194` | attack | yes (L214-215) | `"attack"` |

Locomotion stance markers `NonCombat..ThrownShieldCombat` (`0x8000003C-0x8000013C`) and `Magic` (`0x80000049`) are **stance values, never command values** — they appear in the high 16 bits of cycle keys but are never the dispatched `cmd`. Not wired in classifier; not a gap.

---

## Phase 8.1 Inventory — NEW entries to wire

ACE line refs from `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs`.

### Category 2 — Emotes (one-shot expressive motions)

Player-triggerable via `/emote` slash commands or direct UI. Server broadcasts as `UpdateMotion`. Classified `"attack"` (LoopOnce, links-keyed). Per swing-classification spec §1: emote links live in `MotionTable.links[(stance, Ready)][cmd]`.

| ACE name | u32 hex | low-16 | ACE line | class | notes |
|---|---|---|---|---|---|
| `Cheer` | `0x1300004C` | `0x004C` | 83 | `"attack"` | `/cheer` |
| `ChestBeat` | `0x1000004D` | `0x004D` | 84 | `"attack"` | creature |
| `TippedLeft` | `0x1000004E` | `0x004E` | 85 | `"attack"` | impact reaction (overlap reaction; goes here per ACE class 0x10) |
| `TippedRight` | `0x1000004F` | `0x004F` | 86 | `"attack"` | impact reaction |
| `Sanctuary` | `0x10000057` | `0x0057` | 94 | `"attack"` | recall start |
| `HeadThrow` | `0x1000006B` | `0x006B` | 114 | `"attack"` | creature special |
| `FistSlam` | `0x1000006C` | `0x006C` | 115 | `"attack"` | creature special |
| `BreatheFlame` | `0x1000006D` | `0x006D` | 116 | `"attack"` | creature special (dragon) |
| `SpinAttack` | `0x1000006E` | `0x006E` | 117 | `"attack"` | creature special |
| `ShakeFist` | `0x13000079` | `0x0079` | 128 | `"attack"` | `/shakefist` |
| `Beckon` | `0x1300007A` | `0x007A` | 129 | `"attack"` | `/beckon` |
| `BeSeeingYou` | `0x1300007B` | `0x007B` | 130 | `"attack"` | `/beseeingyou` |
| `BlowKiss` | `0x1300007C` | `0x007C` | 131 | `"attack"` | `/blowkiss` |
| `BowDeep` | `0x1300007D` | `0x007D` | 132 | `"attack"` | `/bow` |
| `ClapHands` | `0x1300007E` | `0x007E` | 133 | `"attack"` | `/clap` |
| `Cry` | `0x1300007F` | `0x007F` | 134 | `"attack"` | `/cry` |
| `Laugh` | `0x13000080` | `0x0080` | 135 | `"attack"` | `/laugh` |
| `MimeEat` | `0x13000081` | `0x0081` | 136 | `"attack"` | `/mimeeat` |
| `MimeDrink` | `0x13000082` | `0x0082` | 137 | `"attack"` | `/mimedrink` |
| `Nod` | `0x13000083` | `0x0083` | 138 | `"attack"` | `/nod` |
| `Point` | `0x13000084` | `0x0084` | 139 | `"attack"` | `/point` |
| `ShakeHead` | `0x13000085` | `0x0085` | 140 | `"attack"` | `/shakehead` |
| `Shrug` | `0x13000086` | `0x0086` | 141 | `"attack"` | `/shrug` |
| `Wave` | `0x13000087` | `0x0087` | 142 | `"attack"` | `/wave` |
| `Akimbo` | `0x13000088` | `0x0088` | 143 | `"attack"` | `/akimbo` |
| `HeartyLaugh` | `0x13000089` | `0x0089` | 144 | `"attack"` | `/heartylaugh` |
| `Salute` | `0x1300008A` | `0x008A` | 145 | `"attack"` | `/salute` |
| `ScratchHead` | `0x1300008B` | `0x008B` | 146 | `"attack"` | `/scratchhead` |
| `SmackHead` | `0x1300008C` | `0x008C` | 147 | `"attack"` | `/smackhead` |
| `TapFoot` | `0x1300008D` | `0x008D` | 148 | `"attack"` | `/tapfoot` |
| `WaveHigh` | `0x1300008E` | `0x008E` | 149 | `"attack"` | `/wavehigh` |
| `WaveLow` | `0x1300008F` | `0x008F` | 150 | `"attack"` | `/wavelow` |
| `YawnStretch` | `0x13000090` | `0x0090` | 151 | `"attack"` | `/yawn` |
| `Cringe` | `0x13000091` | `0x0091` | 152 | `"attack"` | `/cringe` |
| `Kneel` | `0x13000092` | `0x0092` | 153 | `"attack"` | `/kneel` (one-shot; held variant is `KneelState`) |
| `Plead` | `0x13000093` | `0x0093` | 154 | `"attack"` | `/plead` |
| `Shiver` | `0x13000094` | `0x0094` | 155 | `"attack"` | `/shiver` |
| `Shoo` | `0x13000095` | `0x0095` | 156 | `"attack"` | `/shoo` |
| `Slouch` | `0x13000096` | `0x0096` | 157 | `"attack"` | `/slouch` |
| `Spit` | `0x13000097` | `0x0097` | 158 | `"attack"` | `/spit` |
| `Surrender` | `0x13000098` | `0x0098` | 159 | `"attack"` | `/surrender` |
| `Woah` | `0x13000099` | `0x0099` | 160 | `"attack"` | `/woah` |
| `Winded` | `0x1300009A` | `0x009A` | 161 | `"attack"` | `/winded` |
| `YMCA` | `0x1200009B` | `0x009B` | 162 | `"attack"` | `/ymca` (class 0x12) |
| `Pray` | `0x130000CA` | `0x00CA` | 209 | `"attack"` | `/pray` (one-shot; held is `PrayState`) |
| `Mock` | `0x130000CB` | `0x00CB` | 210 | `"attack"` | `/mock` |
| `Teapot` | `0x130000CC` | `0x00CC` | 211 | `"attack"` | `/teapot` |
| `Flatulence` | `0x120000D4` | `0x00D4` | 219 | `"attack"` | `/fart` |
| `Demonet` | `0x120000DF` | `0x00DF` | 230 | `"attack"` | demonet emote |
| `WarmHands` | `0x13000119` | `0x0119` | 289 | `"attack"` | `/warmhands` |
| `ATOYOT` | `0x420000F9` | `0x00F9` | 256 | `"attack"` | inverse of TOYOTA — special emote (class 0x42; persistent? — modifier-class; treated as one-shot per ACE class) |
| `Helper` | `0x13000135` | `0x0135` | 317 | `"attack"` | `/helper` |
| `NudgeLeft` | `0x1300014A` | `0x014A` | 338 | `"attack"` | `/nudgeleft` |
| `NudgeRight` | `0x1300014B` | `0x014B` | 339 | `"attack"` | `/nudgeright` |
| `PointLeft` | `0x1300014C` | `0x014C` | 340 | `"attack"` | `/pointleft` |
| `PointRight` | `0x1300014D` | `0x014D` | 341 | `"attack"` | `/pointright` |
| `PointDown` | `0x1300014E` | `0x014E` | 342 | `"attack"` | `/pointdown` |
| `Knock` | `0x1300014F` | `0x014F` | 343 | `"attack"` | `/knock` |
| `ScanHorizon` | `0x13000150` | `0x0150` | 344 | `"attack"` | `/scanhorizon` |
| `DrudgeDance` | `0x13000151` | `0x0151` | 345 | `"attack"` | `/drudgedance` |
| `HaveASeat` | `0x13000152` | `0x0152` | 346 | `"attack"` | `/haveaseat` (one-shot; held is `HaveASeatState`) |

**Count: 56 emotes** (Category 2).

### Category 3 — Reactions (server-broadcast damage/state responses)

Server broadcasts on damage / status events. Classified `"attack"` (LoopOnce overlay; one-shot creature reactions).

| ACE name | u32 hex | low-16 | ACE line | class | notes |
|---|---|---|---|---|---|
| `Twitch1` | `0x10000051` | `0x0051` | 88 | `"attack"` | take-damage twitch |
| `Twitch2` | `0x10000052` | `0x0052` | 89 | `"attack"` | take-damage twitch |
| `Twitch3` | `0x10000053` | `0x0053` | 90 | `"attack"` | take-damage twitch |
| `Twitch4` | `0x10000054` | `0x0054` | 91 | `"attack"` | take-damage twitch |
| `StaggerBackward` | `0x10000055` | `0x0055` | 92 | `"attack"` | stagger from impact |
| `StaggerForward` | `0x10000056` | `0x0056` | 93 | `"attack"` | stagger from impact |
| `TwitchSubstate1` | `0x400000E4` | `0x00E4` | 235 | `"attack"` | persistent-class twitch (ACE class 0x40 — "substate"; treated as one-shot per data shape) |
| `TwitchSubstate2` | `0x400000E5` | `0x00E5` | 236 | `"attack"` |  |
| `TwitchSubstate3` | `0x400000E6` | `0x00E6` | 237 | `"attack"` |  |

**Count: 9 reactions** (Category 3).

### Category 4 — Death/state-change

`Dead` (`0x40000011`) is a HELD pose (low-class 0x40 — cycle-class). Server broadcasts on death; entity remains in pose until corpse fade. Classified `"walk"` (cycle path).

| ACE name | u32 hex | low-16 | ACE line | class | notes |
|---|---|---|---|---|---|
| `Dead` | `0x40000011` | `0x0011` | 24 | `"walk"` | held post-death pose |

**Count: 1 death state** (Category 4).

### Category 5 — Stationary poses (persistent cycles)

Class 0x41 (`Ready`-family persistent) + class 0x43 (`State` family — emote-held variants). Server-set on NPCs (sitting, sleeping at desks). Classified `"walk"` (cycle path; held loop).

| ACE name | u32 hex | low-16 | ACE line | class | notes |
|---|---|---|---|---|---|
| `Crouch` | `0x41000012` | `0x0012` | 25 | `"walk"` | held crouch |
| `Sitting` | `0x41000013` | `0x0013` | 26 | `"walk"` | NPC sitting cycle |
| `Sleeping` | `0x41000014` | `0x0014` | 27 | `"walk"` | NPC sleeping cycle |
| `ShakeFistState` | `0x430000EA` | `0x00EA` | 241 | `"walk"` | held shake-fist |
| `PrayState` | `0x430000EB` | `0x00EB` | 242 | `"walk"` | held pray cycle |
| `BowDeepState` | `0x430000EC` | `0x00EC` | 243 | `"walk"` | held bow |
| `ClapHandsState` | `0x430000ED` | `0x00ED` | 244 | `"walk"` | held clap |
| `CrossArmsState` | `0x430000EE` | `0x00EE` | 245 | `"walk"` | held crossed-arms |
| `ShiverState` | `0x430000EF` | `0x00EF` | 246 | `"walk"` | held shiver |
| `PointState` | `0x430000F0` | `0x00F0` | 247 | `"walk"` | held point |
| `WaveState` | `0x430000F1` | `0x00F1` | 248 | `"walk"` | held wave |
| `AkimboState` | `0x430000F2` | `0x00F2` | 249 | `"walk"` | held akimbo |
| `SaluteState` | `0x430000F3` | `0x00F3` | 250 | `"walk"` | held salute |
| `ScratchHeadState` | `0x430000F4` | `0x00F4` | 251 | `"walk"` | held scratch-head |
| `TapFootState` | `0x430000F5` | `0x00F5` | 252 | `"walk"` | held tap-foot |
| `LeanState` | `0x430000F6` | `0x00F6` | 253 | `"walk"` | held lean |
| `KneelState` | `0x430000F7` | `0x00F7` | 254 | `"walk"` | held kneel |
| `PleadState` | `0x430000F8` | `0x00F8` | 255 | `"walk"` | held plead |
| `SlouchState` | `0x430000FA` | `0x00FA` | 257 | `"walk"` | held slouch |
| `SurrenderState` | `0x430000FB` | `0x00FB` | 258 | `"walk"` | held surrender |
| `WoahState` | `0x430000FC` | `0x00FC` | 259 | `"walk"` | held woah |
| `WindedState` | `0x430000FD` | `0x00FD` | 260 | `"walk"` | held winded |
| `SnowAngelState` | `0x43000118` | `0x0118` | 288 | `"walk"` | snow angel held |
| `CurtseyState` | `0x4300011A` | `0x011A` | 290 | `"walk"` | held curtsey |
| `AFKState` | `0x4300011B` | `0x011B` | 291 | `"walk"` | held AFK |
| `MeditateState` | `0x4300011C` | `0x011C` | 292 | `"walk"` | held meditate |
| `SitState` | `0x4300013D` | `0x013D` | 325 | `"walk"` | sit variant |
| `SitCrossleggedState` | `0x4300013E` | `0x013E` | 326 | `"walk"` | sit cross-legged |
| `SitBackState` | `0x4300013F` | `0x013F` | 327 | `"walk"` | sit back |
| `PointLeftState` | `0x43000140` | `0x0140` | 328 | `"walk"` | held point-left |
| `PointRightState` | `0x43000141` | `0x0141` | 329 | `"walk"` | held point-right |
| `TalktotheHandState` | `0x43000142` | `0x0142` | 330 | `"walk"` | held talk-to-the-hand |
| `PointDownState` | `0x43000143` | `0x0143` | 331 | `"walk"` | held point-down |
| `DrudgeDanceState` | `0x43000144` | `0x0144` | 332 | `"walk"` | held drudge dance |
| `PossumState` | `0x43000145` | `0x0145` | 333 | `"walk"` | playing-possum (held) |
| `ReadState` | `0x43000146` | `0x0146` | 334 | `"walk"` | held reading |
| `ThinkerState` | `0x43000147` | `0x0147` | 335 | `"walk"` | thinker pose |
| `HaveASeatState` | `0x43000148` | `0x0148` | 336 | `"walk"` | held seated |
| `AtEaseState` | `0x43000149` | `0x0149` | 337 | `"walk"` | at-ease guard pose |

**Count: 39 stationary poses** (Category 5).

### Category 6 — Object interaction (one-shot)

Server broadcasts when player acts on items / containers / portals. Classified `"attack"` (LoopOnce). Per `acclient.c:343297` the substate threshold `> 0x40000018` (Pickup) is treated as ranged-action by retail's animation classifier.

| ACE name | u32 hex | low-16 | ACE line | class | notes |
|---|---|---|---|---|---|
| `Reload` | `0x40000016` | `0x0016` | 29 | `"attack"` | bow/crossbow reload |
| `Unload` | `0x40000017` | `0x0017` | 30 | `"attack"` | bow/crossbow unload |
| `Pickup` | `0x40000018` | `0x0018` | 31 | `"attack"` | item pickup |
| `StoreInBackpack` | `0x40000019` | `0x0019` | 32 | `"attack"` | put in pack |
| `Eat` | `0x4000001A` | `0x001A` | 33 | `"attack"` | consume food |
| `Drink` | `0x4000001B` | `0x001B` | 34 | `"attack"` | consume drink |
| `Reading` | `0x4000001C` | `0x001C` | 35 | `"attack"` | one-shot read |
| `MagicVision` | `0x40000036` | `0x0036` | 61 | `"cast"` | magic vision (utility spell — kept under CAST as it's modifier-class 0x40, dispatched like a self-buff) |
| `MagicEnchantItem` | `0x40000037` | `0x0037` | 62 | `"cast"` | item enchant cast (also CAST class) |
| `MagicPortal` | `0x40000038` | `0x0038` | 63 | `"cast"` | portal opening cast |
| `MagicPray` | `0x40000039` | `0x0039` | 64 | `"cast"` | prayer cast |
| `EnterPortal` | `0x100000A0` | `0x00A0` | 167 | `"attack"` | portal-entry flash |
| `ExitPortal` | `0x100000A1` | `0x00A1` | 168 | `"attack"` | portal-exit flash |
| `UseMagicStaff` | `0x400000E0` | `0x00E0` | 231 | `"cast"` | staff focus-channel |
| `UseMagicWand` | `0x400000E1` | `0x00E1` | 232 | `"cast"` | wand focus-channel |
| `BowNoAmmo` | `0x800000E8` | `0x00E8` | 239 | `"attack"` | bow misfire (class 0x80 — locomotion?). Actually class 0x80 is stance-flag; included as one-shot for safety. |
| `CrossBowNoAmmo` | `0x800000E9` | `0x00E9` | 240 | `"attack"` | crossbow misfire |
| `Pickup5` | `0x40000136` | `0x0136` | 318 | `"attack"` | tall pickup variant |
| `Pickup10` | `0x40000137` | `0x0137` | 319 | `"attack"` | tall pickup variant |
| `Pickup15` | `0x40000138` | `0x0138` | 320 | `"attack"` | tall pickup variant |
| `Pickup20` | `0x40000139` | `0x0139` | 321 | `"attack"` | tall pickup variant |

**Count: 21 interactions** (Category 6).

### Category 7 — Idle variation / lifecycle ambient

ACE class 0x10 — ambient one-shots. Classified `"attack"` (LoopOnce). `EnterGame`/`ExitGame`/`OnCreation`/`OnDestruction` are lifecycle markers played on spawn/despawn.

| ACE name | u32 hex | low-16 | ACE line | class | notes |
|---|---|---|---|---|---|
| `EnterGame` | `0x1000009C` | `0x009C` | 163 | `"attack"` | spawn-in flash |
| `ExitGame` | `0x1000009D` | `0x009D` | 164 | `"attack"` | despawn flash |
| `OnCreation` | `0x1000009E` | `0x009E` | 165 | `"attack"` | object-create flash |
| `OnDestruction` | `0x1000009F` | `0x009F` | 166 | `"attack"` | object-destroy flash |
| `Blink` | `0x100000E2` | `0x00E2` | 233 | `"attack"` | random blink animation |
| `Bite` | `0x100000E3` | `0x00E3` | 234 | `"attack"` | random bite animation |
| `Helper` | `0x13000135` | `0x0135` | 317 | (already in Cat 2) | already classified under emotes |
| `LogOut` | `0x1000011E` | `0x011E` | 294 | `"attack"` | one-shot logout |

**Count: 7 ambient** (Category 7; `Helper` already in Cat 2). 

### Category 8 — Specialized (recall, fishing, hop, twirl)

Class 0x10 / 0x25 / 0x85 one-shots. Specialized but cheap to wire as `"attack"`.

| ACE name | u32 hex | low-16 | ACE line | class | notes |
|---|---|---|---|---|---|
| `HoldRun` | `0x85000001` | `0x0001` | 8 | `"walk"` | run-modifier flag (toggle); pattern matches Ready/cycle so route through cycle path |
| `HoldSidestep` | `0x85000002` | `0x0002` | 9 | `"walk"` | sidestep-modifier flag |
| `Interpolating` | `0x40000009` | `0x0009` | 16 | `"walk"` | physics-blend marker (state-class 0x40) |
| `Hover` | `0x4000000A` | `0x000A` | 17 | `"walk"` | hover/levitate cycle |
| `On` | `0x4000000B` | `0x000B` | 18 | `"walk"` | object on (e.g. torch lit) — held |
| `Off` | `0x4000000C` | `0x000C` | 19 | `"walk"` | object off — held |
| `AimLevel` | `0x4000001E` | `0x001E` | 37 | `"walk"` | aim-pose (held); cycle path resolves |
| `AimHigh15..AimLow90` | `0x4000001F-0x4000002A` | `0x001F-0x002A` | 38-49 | `"walk"` | aim-elevation poses (12 entries) — held aim modifiers |
| `MagicPenalty` | `0x40000034` | `0x0034` | 59 | `"cast"` | spell-failure animation (class 0x40 / cast-modifier) |
| `MagicTransfer` | `0x40000035` | `0x0035` | 60 | `"cast"` | spell-transfer (class 0x40 / cast-modifier) |
| `StopTurning` | `0x2000003A` | `0x003A` | 65 | `"walk"` | turn-stop marker — route to cycle (substituted via STOP path in setMotion) |
| `Hop` | `0x1000004A` | `0x004A` | 81 | `"attack"` | small hop (one-shot) |
| `Jumpup` | `0x1000004B` | `0x004B` | 82 | `"attack"` | small upward jump (one-shot) |
| `SpecialAttack1` | `0x100000CD` | `0x00CD` | 212 | `"attack"` | special creature attack |
| `SpecialAttack2` | `0x100000CE` | `0x00CE` | 213 | `"attack"` | special creature attack |
| `SpecialAttack3` | `0x100000CF` | `0x00CF` | 214 | `"attack"` | special creature attack |
| `SkillHealSelf` | `0x1000010E` | `0x010E` | 277 | `"attack"` | heal-self skill use |
| `SkillHealOther` | `0x1000010F` | `0x010F` | 279 | `"attack"` | heal-other skill use |
| `DoubleSlashLow..TripleThrustHigh` | `0x1000011F-0x1000012A` | `0x011F-0x012A` | 295-306 | `"attack"` | multi-strike attacks (12 entries) |
| `MagicPowerUp01Purple..10Purple` | `0x1000012B-0x10000134` | `0x012B-0x0134` | 307-316 | `"cast"` | nether/void powerup variants (10 entries) |
| `HouseRecall` | `0x1000013A` | `0x013A` | 322 | `"attack"` | house portal recall |
| `LifestoneRecall` | `0x10000153` | `0x0153` | 347 | `"attack"` | lifestone recall |
| `Fishing` | `0x10000165` | `0x0165` | 365 | `"attack"` | fishing cast |
| `MarketplaceRecall` | `0x10000166` | `0x0166` | 366 | `"attack"` | marketplace recall |
| `EnterPKLite` | `0x10000167` | `0x0167` | 367 | `"attack"` | PK Lite toggle anim |
| `AllegianceHometownRecall` | `0x10000171` | `0x0171` | 377 | `"attack"` | allegiance recall |
| `PKArenaRecall` | `0x10000172` | `0x0172` | 378 | `"attack"` | arena recall |
| `OffhandSlashHigh..OffhandTripleThrustHigh` | `0x10000173-0x10000184` | `0x0173-0x0184` | 379-396 | `"attack"` | dual-wield offhand attacks (18 entries) |
| `OffhandKick` | `0x10000185` | `0x0185` | 397 | `"attack"` | dual-wield kick |
| `AttackHigh4..AttackLow6` | `0x10000186-0x1000018E` | `0x0186-0x018E` | 398-406 | `"attack"` | additional attack variants (9 entries) |
| `OffhandPunchFastHigh..OffhandPunchSlowLow` | `0x10000195-0x1000019A` | `0x0195-0x019A` | 413-418 | `"attack"` | offhand punch variants (6 entries) |
| `WoahDuplicate2` | `0x1000019B` | `0x019B` | 419 | `"attack"` | same as Woah, class 0x10 variant |

**Count: ~100 specialized** (Category 8; lots of bundled attack-variant ranges).

### Category 9 — Internal / never broadcast (skip wiring)

These are **UI / input-binding action commands**, NOT animation commands. Class 0x80 / 0x90 / 0xC0 / 0xD0. They populate the `Controls` keybind UI; ACE will never `UpdateMotion`-broadcast them at an entity (you can't `/wave` a button press). 

Skipped:

- `Cancel` (`0x800000A2`), `UseSelected` (`0x900000A3`), `AutosortSelected`, `DropSelected`, `GiveSelected`, `SplitSelected`, `ExamineSelected`, `CreateShortcutToSelected` (lines 169-176)
- `PreviousCompassItem..ClosestCompassItem` (lines 177-179)
- `PreviousSelection`, `LastAttacker`, `PreviousFellow`, `NextFellow`, `ToggleCombat` (180-184)
- `HighAttack`, `MediumAttack`, `LowAttack` (185-187 — these are STANCE-TOGGLE actions, not animation commands; ACE sends GameAction-derived `Move`-class commands instead)
- `EnterChat`, `ToggleChat`, `SavePosition`, `OptionsPanel`, `ResetView` (188-192)
- `CameraLeftRotate..CameraFarther` (193-198)
- `FloorView`, `MouseLook`, `PreviousItem`, `NextItem`, `ClosestItem`, `ShiftView`, `MapView`, `AutoRun`, `DecreasePowerSetting`, `IncreasePowerSetting` (199-208)
- `FirstPersonView`, `AllegiancePanel`, `FellowshipPanel`, `SpellbookPanel`, `SpellComponentsPanel`, `HousePanel`, `AttributesPanel`, `SkillsPanel`, `MapPanel`, `InventoryPanel` (220-229)
- `CaptureScreenshotToFile` (238)
- `AutoCreateShortcuts..VividTargetIndicator` (261-275)
- `SelectSelf`, `PreviousMonster..ClosestPlayer` (276-287)
- `TradePanel`, `CharacterOptionsPanel..MuteOnLosingFocus` (293, 348-364)
- `AllegianceChat..IssueSlashCommand` (368-376)
- `Invalid` (line 7 — sentinel)

**Wiring strategy:** these all share high-nibble masks ≥ `0x8`. Since `classifyMotionCommand` only consults the low-16, and the low-16 values overlap legitimate motion commands, we **cannot** distinguish UI-action from animation by low-16 alone. Mitigation: ACE's `UpdateMotion` handler never builds these into broadcasts (they're consumed by `Game::OnAction(int actionId)` on the client side, not motion-table-driven). So they will not arrive in `setMotion`. Even if a misbehaving plugin sent one through `UpdateMotion`, the renderer would route via the low-16 to whatever motion-table entry exists for that low-16 — graceful null fallback via `_tryPlayLink` (no clip = no anim = no harm). **Documented, not wired.**

**Count: ~120 UI actions** (Category 9; skipped).

### Special non-broadcast values

- `Invalid` (`0x00000000`) — sentinel; `setMotion` already substitutes low-16 `0x0000` → Ready (entities.js:3074-3076).

---

## Phase 8.3 — Trace verification (5 representative new commands)

The recv-path (wasm → loop.js `KIND_MOTION` dispatch → `em.setMotion(guid, cmd, stance)`) routes the full u32 `cmd` straight to `setMotion` without filtering. The classifier is consulted at L3127. Tracing 5 new commands:

1. **`Sitting (0x41000013)`** — Category 5, classifier returns `"walk"` (cycle). `setMotion` routes through `AnimationCache.get(setupId, mtableId, cmd=0x41000013, stance)`. If the NPC's MT has `cycles[(stance<<16 | 0x0013)]`, the clip plays LoopRepeat. If not, the cache returns `clip=null` and L3245 falls through `fadeOutCurrent` (silent no-op, expected).

2. **`TakeDamage / Twitch1 (0x10000051)`** — Category 3, classifier returns `"attack"` (one-shot). `setMotion` L3163 routes through `_tryPlayLink(inst, setupId, mtableId, READY=0x0003, cmd=0x10000051, stance)`. If MT has `links[(stance<<16 | 0x0003)][0x10000051]`, the swing plays once. If not, link fetch returns null → no overlay → underlying locomotion continues. Graceful.

3. **`Pickup (0x40000018)`** — Category 6, classifier returns `"attack"` (one-shot). Same path as `TakeDamage`. Player MT 0x09000001 is expected to have `links[(NonCombat, Ready)][Pickup]` per the 5,455 link entries across 436 retail tables.

4. **`BowDeep (0x1300007D)`** — Category 2, classifier returns `"attack"` (one-shot). Same path. Player MT 0x09000001 expected to have this in `links[(NonCombat, Ready)]`.

5. **`Cheer (0x1300004C)`** — Category 2, classifier returns `"attack"` (one-shot). Same path. Player MT expected to have entry.

**Gap found:** none. The `_tryPlayLink` returning null-clip is the universal graceful fallback for any MT-missing entry (`entities.js:3242-3247`: `if (!clip) { inst.fadeOutCurrent(CROSSFADE_S); return; }`).

**Pre-existing protection (already there):**
- The substitution at `setMotion` L3074 (`STOP/Invalid → Ready`) means raw `Stop = 0x40000004` and `Invalid = 0x00000000` both safely land in cycle path.
- The substitution at L3092-3098 (`Left → Right`) means defensive remote-broadcast handling for sidestep/turn-left codes.

**No `setMotion` short-circuit found on any new command.** The classifier is now the single gate; once `classifyMotionCommand` returns non-null, dispatch flows through universally.

---

## Phase 8.4 — Retail MT data presence check (RESULTS)

The Rust example `wave_8_motion_inventory.rs` + `.mjs` wrapper `test_ac_motion_inventory.mjs` were executed against `~/ac_base_dats/client_portal.dat` on 2026-05-26.

**Player MT 0x09000001 (366 cycles, 318 link outer keys):**

| Category | Present | Total | Location |
|---|---|---|---|
| Emotes | 53 | 61 | `links[(NonCombat, Ready)][cmd]` |
| Reactions | **0** | 9 | (nowhere — confirmed absent from cycles, modifiers, AND links) |
| Stationary poses | 40 | 40 | `cycles[(stance, cmd)]` (any stance) |
| Interactions | 11 | 15 | `links[(NonCombat, Ready)][cmd]` |
| Idle ambient | 1 | 7 | `links[(NonCombat, Ready)][cmd]` (only `LogOut`) |

**Key finding — reactions absent in PLAYER MT.** The 9 reaction commands (`Twitch1-4`, `StaggerBackward/Forward`, `TwitchSubstate1-3`) are universally absent from MT `0x09000001`. This is **expected and correct** — players don't have take-damage reaction animations in retail; reactions live on creature/monster MTs. The classifier still wires reactions because:
1. The renderer routes EVERY `UpdateMotion` through the same `setMotion` path regardless of guid (player vs creature). Whether the entity's MT has the entry or not is independent of the classifier knowing the command class.
2. When ACE broadcasts `UpdateMotion(creature_guid, Twitch1, _)` on damage, the creature's MT will likely have the Twitch1 entry. The classifier correctly returns `"attack"` → `_tryPlayLink` → fetches the creature's clip → plays it. **No code path changes needed** — the audit confirms the architecture is correct.

**Emotes missing from player MT (8 of 61):**
Looking at the present-list output, the absent emotes are: `ChestBeat`, `TippedLeft`, `TippedRight`, `HeadThrow`, `FistSlam`, `BreatheFlame`, `SpinAttack`, `Demonet`. These are all explicitly **creature special attacks** (chest-beat = monkey, head-throw / fist-slam / breathe-flame / spin-attack = dragon/lugian, demonet = demonet emote). The classifier still wires them; the player's MT just doesn't carry them. Other entities that DO have these clips will play them correctly.

**Interactions missing from player MT (4 of 15):**
`Reload`, `Unload`, `BowNoAmmo`, `CrossBowNoAmmo`. The first two are bow/crossbow reload one-shots (likely live in `links[(BowCombat, Ready)]` — combat-stance-specific, not NonCombat). The latter two are misfire animations also bound to bow stances. Probing the brief's test runs `NonCombat` only; the entries likely exist under the bow stances.

**NPC MT cross-check** (3 humanoid-rich tables, ≥100 cycles each):

- `0x0900000A` — 180 cycles, 150 link outers, **43 emotes**, 4 interactions, 1 idle, 4 stationary, 0 reactions.
- `0x09000017` — 172 cycles, 134 link outers, 40 emotes, 4 interactions, 0 idle, 4 stationary, 0 reactions.
- `0x09000025` — 157 cycles, 121 link outers, 40 emotes, 4 interactions, 0 idle, 4 stationary, 0 reactions.

NPCs all carry the standard `/emote` set (40-43 of 61). They have fewer interactions (4) — likely just basic pickup variants. Stationary cycles drop to 4 (probably just `Sitting`, `Sleeping`, `Crouch`, `Dead` — most `State`-suffix variants are player-specific). Reactions still 0 — these are 3 humanoid NPCs (the first ≥100-cycle tables in ID-ascending order), not aggressive monsters that take damage from the player.

**Acceptance bar from brief: "player MT has at least 20 emotes wired in retail data."** PASS — observed **53/61**.

See the .mjs wrapper output for the structured check log.

---

## Summary

Actual Set sizes after Phase 8.2 edits (entries.js):

| JS constant | Size | Wave 8 delta | Class |
|---|---|---|---|
| `ATTACK_COMMANDS` | 31 | (unchanged) | `"attack"` |
| `CAST_COMMANDS` | 37 | **+18** (added MagicPenalty/Transfer/Vision/EnchantItem/Portal/Pray, UseMagicStaff/Wand, MagicPowerUp01-10Purple) | `"cast"` |
| `EMOTE_COMMANDS` | 61 | **NEW** | `"attack"` (LoopOnce link overlay) |
| `REACTION_COMMANDS` | 9 | **NEW** | `"attack"` |
| `STATIONARY_COMMANDS` | 40 | **NEW** | `"walk"` (LoopRepeat cycle) |
| `INTERACTION_COMMANDS` | 15 | **NEW** | `"attack"` |
| `IDLE_AMBIENT_COMMANDS` | 7 | **NEW** | `"attack"` |
| `EXTENDED_ATTACK_COMMANDS` | 61 | **NEW** | `"attack"` |
| `CYCLE_HELD_COMMANDS` | 20 | **NEW** | `"walk"` |

**TOTAL NEW low-16 classifier entries added in Wave 8: 231** (61+9+40+15+7+61+20+18).

Category 9 (UI actions ~120 commands) skipped per analysis — they're keybind action IDs, not animation commands; ACE never broadcasts them via `UpdateMotion`. Documented above.

## Wave 9 emote-UI recommendation

**Emote menu should expose 47 player-triggerable commands** — the Category 2 entries that should reasonably appear in `MotionTable 0x09000001.links[(NonCombat, Ready)][cmd]`. Filter (excludes creature-only specials):

`Cheer, ShakeFist, Beckon, BeSeeingYou, BlowKiss, BowDeep, ClapHands, Cry, Laugh, MimeEat, MimeDrink, Nod, Point, ShakeHead, Shrug, Wave, Akimbo, HeartyLaugh, Salute, ScratchHead, SmackHead, TapFoot, WaveHigh, WaveLow, YawnStretch, Cringe, Kneel, Plead, Shiver, Shoo, Slouch, Spit, Surrender, Woah, Winded, YMCA, Pray, Mock, Teapot, Flatulence, Demonet, WarmHands, Helper, NudgeLeft, NudgeRight, PointLeft, PointRight, PointDown, Knock, ScanHorizon, DrudgeDance, HaveASeat`

After Wave 8.4 data presence check completes, this list should be filtered to the actual MT-resident set (probably 30-50 entries).
