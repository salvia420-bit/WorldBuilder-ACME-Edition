# Wave 9.5b — Missed-Motion Audit (2026-05-26)

User asked: **"how about the players crouch and laying down animation, are
there others we missed?"**

This wave audits gaps between what the player can *trigger* (via slash
command, key press, action) and what gets *animated* (via classifier +
recv path). Companion to Wave 8 (classifier inventory) and Wave 9 (chat
soul-emote wiring).

## Phase A — ChatPoseTable catalog audit

Dumped retail `ChatPoseTable (0x0E000007)` from
`/home/wbterminal/ac_base_dats/client_portal.dat` via the
`holtburger-dat::parse_dat_record` example (raw output:
`/mnt/wbterminal1/tmp/claude-scratch/movement-overhaul/chatposetable.json`,
13.5 KB JSON).

**Catalog stats:**
- 309 slash-command tokens (`chat_pose_hash` keys)
- 74 distinct pose names (`chat_emote_hash` keys)
- `SoulEmote.cs` allowlist also has 74 entries — 1:1 match by *count*.

**Cross-check vs `SoulEmote.cs`:**
- 68/74 of the SoulEmote.cs allowlist poses ARE in the catalog directly.
- 6 SoulEmote.cs poses (`ClapHandsState`, `ScratchHeadState`,
  `ShakeFistState`, `SnowAngelState`, `WarmHands`, `WaveState`) are
  spelled UPPERCASE in the catalog (`CLAPHANDSSTATE`, …).
- 0 tokens in the catalog map to a non-existent pose (no orphans).

**Phase A1 finding — retail catalog has 6 uppercased pose names.** This
is a real wiring gap on our side: `motion_command_for_soul_emote_pose`
in `crates/holtburger-core/src/soul_emote_motion.rs` was case-sensitive
PascalCase before this wave. The retail client uses `__strnicmp` in
`string2command` (`~/ac-headers/acclient.c:718585`) so its lookup is
case-insensitive and the live game's emote chain resolved both shapes.

**Affected tokens (21):**
- `CLAPHANDSSTATE` (via `ClapHandsState`): `clapping`, `clapping hands`
- `SCRATCHHEADSTATE` (via `ScratchHeadState`): `hmm`, `hmmm`, `hmmmm`,
  `itchy`, `scratching`, `scratching head`, `scratchinghead`
- `SHAKEFISTSTATE` (via `ShakeFistState`): `getting angry`,
  `shaking fist`, `shakingfist`
- `SNOWANGELSTATE` (via `SnowAngelState`): `snow angel`, `snowangel`
- `WARMHANDS` (via `WarmHands`): `blow hands`, `blow in hands`,
  `blow on hands`, `warm hands`, `warm up hands`
- `WAVESTATE` (via `WaveState`): `waving`, `waving hand`

Pre-fix: typing `/clapping` produced a chat broadcast ("Foo claps."), the
network round-trip went through, but the local-prediction motion was
`0x00000000` = Invalid → Ready, so no visible animation. Post-fix: the
sub catalog pose-name lookup adds 6 uppercase fallback arms to
`motion_command_for_soul_emote_pose` matching retail's `__strnicmp`
behaviour.

### Phase A — User-mentioned commands

| User typed | Token in catalog? | Pose | Routes to |
|---|---|---|---|
| `/crouch` | **NO** | — | not player-triggerable in retail |
| `/lay` | **NO** | — | not player-triggerable in retail |
| `/laydown` | **NO** | — | not player-triggerable in retail |
| `/lie` | **NO** | — | not player-triggerable in retail |
| `/sleep` | **NO** | — | not player-triggerable in retail |
| `/sit` | yes | `SitState` (`0x4300013d`) | wired |
| `/rest` | **NO** | — | (use `/meditate` for vitals regen pose) |
| `/kneel` | yes | `KneelState` (`0x430000f7`) | wired |
| `/prone` | **NO** | — | not player-triggerable in retail |

**Crouch (`0x41000012`), Sitting (`0x41000013`), Sleeping (`0x41000014`)
are server-only MotionCommands.** ACE references them in
`Creature_Vitals.cs:130-235` (stamina/mana regen multipliers when
ForwardCommand is in that range) and `Player_Combat.cs:275-286` (player
defense multiplier — sleeping player is `0.2x` damage avoidance). The
client CANNOT enter those states via any retail slash command or key
binding. They are set:

- Server-side by NPC `EmoteManager` scripts (`EmoteManager.cs:1758-1761`
  — `MotionQueue` contains exactly `MotionCommand.Sleeping` for the
  monster-going-to-sleep case).
- Via paralysis/sleep spells (no, ACE doesn't actually broadcast a
  motion for these — `Asleep` is a debuff state, not a MotionCommand).
- Admin override (no admin command exists in ACE either).

**Closest retail player-triggerable equivalents:**
- "Lay down" → `*play dead*`/`*play possum*` → `PossumState`
  (`0x43000145`). Tokens: `opossum`, `play dead`, `play possum`,
  `playdead`, `playpossum`, `possum`.
- "Sleep" → `*meditate*`/`*pray kneel*` → `MeditateState`
  (`0x4300011c`). Tokens: `meditate`, `pray kneel`, `praykneel`.
- "Crouch" → none. The closest analogue (slouch low to ground) is
  `SlouchState` via `slouch`, `slouches`.

These three are already wired into `STATIONARY_COMMANDS` in
`scene3d/entities.js:322-338` (PossumState=`0x0145`,
MeditateState=`0x011c`, SlouchState=`0x00fa`).

### Phase A — Catalog poses NOT in SoulEmote.cs

After case-insensitive resolution none. Pre-fix, the 6 uppercased pose
names rejected by ACE's `SoulEmote.SoulEmotes` HashSet would still
flow through chat (just no motion broadcast); the rejection point is
`RawMotionState.cs:84-94` which guards `Commands[0].MotionCommand`
against the SoulEmotes set. Since the local client now sends the
correct `MotionCommand.ClapHandsState (0x430000ED)`, ACE accepts the
broadcast and the visual round-trips.

## Phase B — Missed motion categories

Searched `ace-server/Source/` and `~/ac-headers/acclient.c` for
motion-related identifiers that aren't in `MotionCommand.cs`.

### Swimming / underwater / liquid

**Not present.** AC retail had:
- No `Swim` / `Submerge` / `Liquid` MotionCommand entries.
- No `Motion_Swim*` globals in retail's `acclient.c` (grep returned 0).
- No swim animation clips in MT `0x09000001` (player MT, audited 366
  cycles + 318 link outers in Wave 8.4).
- Server-side: ACE has no `Liquid` collision response that broadcasts
  a motion. The retail engine had a `Liquid` PhysicsObj state flag
  (visible in `acclient.c` MovementParameters) but it never triggered
  an animation — players just sank slowly in water.

**No gap.** Not a player-visible feature in retail.

### Paralysis / Sleep spells

**Server-side state, no motion.** ACE represents debuffs as enchantment
properties (`ProperyInt::PlayerKillerStatus`, `ProperyInt::AsleepBitmask`,
etc.) with vitals/movement penalties applied during action chain
execution. No broadcast motion. The acclient.c grep for
`Motion_Sleeping` outside the catalog returned 0 hits — the existing
`Sleeping` cycle (`0x41000014`) is reserved for `EmoteManager` NPC
scripts.

**No gap.**

### Block / Parry / Dodge

**No discrete MotionCommands.** Combat resolution is pure server math
(`Player_Combat.cs::OnEvade`). On a successful evade the server may
broadcast a stagger or twitch reaction (already wired in
REACTION_COMMANDS), but no dedicated block/parry/dodge animation
exists.

**No gap.**

### Multi-stage death chain

**Single-stage.** ACE broadcasts `MotionCommand.Dead` once and waits
for the clip's `GetAnimationLength()` to elapse before spawning the
corpse (`Player_Death.cs:226-227`). Pre-death falling sequence:
- `Falling = 0x40000015` (cycle) — airborne loop
- `FallDown = 0x10000050` (cycle, per ACE class 0x10) — terminal fall
- `Fallen = 0x40000008` (cycle) — landed prone
- `Dead = 0x40000011` (held cycle) — death pose

All four are wired (Falling/Fallen/FallDown via hardcoded checks in
`classifyMotionCommand` lines 629-630; Dead via STATIONARY_COMMANDS).

**No gap.**

### Vitae respawn ghost

**Particle effect, not a motion.** Vitae is a multi-aspect penalty
applied via `EnchantmentManager` on death. The visible "ghosted" tint
on a freshly-respawned player is a render-state property set on the
client. No MotionCommand involvement.

**No gap.**

### Mounted / horse / pet-following

**Pets exist (drudge eggs, etc.) but no rider motion.** AC retail never
shipped mounts. ACE's `PetDevice.cs` references `MotionCommand.ClapHands`
once (line 555) for the activate-pet emote — that's the pet *summoner*,
not a player-mount motion.

**No gap.**

### Tinkering / crafting

**Routes through standard interaction motions.** Smithing / fletching
/ tailoring in retail used the `MimeEat` / `MimeDrink` / `ClapHands`
motions (e.g. `Tailoring.cs:93` uses `MotionCommand.ClapHands`). No
dedicated `Crafting` or `Hammer` motion. These are all wired in
EMOTE_COMMANDS.

**No gap.**

### Trade / give-item

**No motion broadcast on item transfer.** ACE's trade system
(`Container.GiveItem`, `Trade.cs`) doesn't broadcast a motion when the
trade resolves; the inventory rows just update.

**No gap.**

### Recall windups

**One-shot motions, already classified.** `LifestoneRecall`,
`HouseRecall`, `MarketplaceRecall`, `AllegianceHometownRecall`,
`PKArenaRecall`, `Sanctuary` are all in EXTENDED_ATTACK_COMMANDS or
EMOTE_COMMANDS (Sanctuary). ACE's recall handlers
(`Player_Location.cs:111+`) call `MotionTable.GetAnimationLength()` on
these and schedule the actual teleport for after the clip duration —
so the motion plays start-to-end as a one-shot LoopOnce, not a held
cycle. The classifier's `"attack"` routing is correct (LoopOnce overlay
via `_tryPlayLink`).

**No gap.** Treating recalls as one-shots matches retail.

### Damage-type-specific death animations

**Single death clip.** ACE pulls `MotionTable.GetAnimationLength(
MotionCommand.Dead)` unconditionally (`Player_Death.cs:226`); no
damage-type branch. Player's MT 0x09000001 has exactly one Dead
cycle entry per stance.

**No gap.**

## Phase B Summary

| Category | Searched | Result |
|---|---|---|
| Swimming/underwater | yes (grep ACE + acclient.c) | not present in retail |
| Paralysis/sleep spell visual | yes | not a motion (debuff state) |
| Block/parry/dodge | yes | not a motion (server combat math) |
| Multi-stage death | yes | single-stage `Dead`, already wired |
| Vitae respawn | yes | render-state property, not motion |
| Mounted/horse | yes | not in retail |
| Tinkering/crafting | yes | re-uses MimeEat/ClapHands/etc., wired |
| Trade/give-item | yes | no motion broadcast |
| Recall windups | yes | one-shot, correctly classified |
| Damage-typed deaths | yes | single Dead clip, no branching |

**Net: no missed categories.** Wave 8's 231-entry classifier sweep
covered the full MotionCommand.cs space; ACE doesn't broadcast anything
outside that space; the catalog is the ONLY content-driven gate for
player-triggerable motions, and we now respect its full token set.

### Cross-check — classifier coverage of every ACE-referenced MotionCommand

Ran a coverage audit
(`/mnt/wbterminal1/tmp/claude-scratch/movement-overhaul/classifier_audit.cjs`)
over all 141 `MotionCommand.*` names ACE.Server references. Result:

- 139 of 141 hit a classifier set (or one of the hardcoded
  Ready/Walk/Run/Stop/Falling/Fallen/FallDown/Jump/JumpCharging/Turn/
  SideStep checks at lines 609-630).
- 2 misses (`AutoRun = 0x090000c7`, `MouseLook = 0x0c0000c1`) are
  class 0x09 / 0x0C UI key-binding actions — NEVER broadcast via
  `UpdateMotion`. Skipped by design per Wave 8 §Category 9. **Not a
  classifier bug.**

## Phase C — Recv path trace verification

Picked 5 Wave 8 entries + 5 newly-investigated entries and traced each
from wasm `UpdateMotion` → JS `KIND_MOTION` → `em.setMotion` →
`classifyMotionCommand` → AnimationCache path.

| Cmd | Hex | Class | setMotion routes to | Outcome |
|---|---|---|---|---|
| `SitState` | `0x4300013d` | walk | cycle path (LoopRepeat) | clip plays if MT carries it; else `fadeOutCurrent` no-op |
| `KneelState` | `0x430000f7` | walk | cycle path | same |
| `PossumState` | `0x43000145` | walk | cycle path | same |
| `MeditateState` | `0x4300011c` | walk | cycle path | same |
| `BowDeepState` | `0x430000ec` | walk | cycle path | same |
| `ClapHandsState` | `0x430000ed` | walk | cycle path | same |
| `Wave` | `0x13000087` | attack | `_tryPlayLink` (LoopOnce overlay) | clip plays if MT.links has it; else null-clip silent fallback |
| `Cheer` | `0x1300004c` | attack | `_tryPlayLink` | same |
| `BowDeep` | `0x1300007d` | attack | `_tryPlayLink` | same |
| `Sanctuary` | `0x10000057` | attack | `_tryPlayLink` | same |

**0 trace failures.** Every command flows through to either a real clip
or a documented silent fallback (no broken stack, no orphan log noise).

## Phase D — Code changes

### D.1 — Case-insensitive pose name resolution

**File:** `external/holtburger/crates/holtburger-core/src/soul_emote_motion.rs`

Added 6 uppercase fallback arms (`CLAPHANDSSTATE`, `SCRATCHHEADSTATE`,
`SHAKEFISTSTATE`, `SNOWANGELSTATE`, `WARMHANDS`, `WAVESTATE`) to the
exact-match table, mirroring retail's `__strnicmp` semantics in
`string2command`. Each entry maps to the same low-16 as its PascalCase
sibling. Added a `uppercased_catalog_pose_names_resolve` unit test that
verifies the 6 pairs return equal values.

**Validation:**
- `cargo test -p holtburger-core --lib soul_emote_motion`: 2 passed,
  0 failed (1 pre-existing + 1 new).
- `cargo check -p holtburger-web --target wasm32-unknown-unknown`:
  clean (18 pre-existing warnings; no new errors).

**File:line citations:**
- `external/holtburger/crates/holtburger-core/src/soul_emote_motion.rs:1-23`
  — docstring explaining the case-insensitivity gap and retail
  citation.
- `external/holtburger/crates/holtburger-core/src/soul_emote_motion.rs:84-96`
  — 6 new uppercase arms with inline rationale.
- `external/holtburger/crates/holtburger-core/src/soul_emote_motion.rs:108-138`
  — new `uppercased_catalog_pose_names_resolve` test.

### D.2 — Classifier additions

**None needed.** Phase B confirmed no missed categories; Phase C trace
showed 0 dispatch gaps; Wave 8's 231 classifier entries cover every
ACE-broadcast MotionCommand.

### D.3 — Flagged for future waves (no code changes)

1. **Custom `/crouch`-style commands.** Adding new server-broadcast
   slash commands for `/crouch`, `/lay`, `/sleep`, `/prone` would
   require:
   - A custom `SoulEmote.SoulEmotes` allowlist extension on the ACE
     side (to permit `MotionCommand.Crouch`, `Sitting`, `Sleeping` in
     `RawMotionState`'s gate).
   - A custom `ChatPoseTable` entry — but the DAT is read-only at
     runtime, so the resolution would need to happen client-side via
     a `gameplay-side` slash router, not in `motion_command_for_soul_
     emote_pose`.
   - A new `SessionCommand::SendCustomMotion` wasm export.
   - JS shell wiring: add aliases to `index.html`'s
     `routeSlashCommand`.
   - Estimated ~80 LOC across wasm + JS + ACE.
   **Recommend:** stage as Wave 9.7 (player-pose extensions) if the
   user wants it; otherwise leave the retail catalog as canon.

2. **Emote popup menu.** Per Wave 9 §9.5, still outstanding. The
   case-insensitivity fix lands first because it affects 21 tokens
   the user can already type today.

3. **Remote-player motion broadcast for emotes.** Per Wave 9 §9.5 — the
   3rd-person observer gap. Requires `MotionStateBuilder` extension
   in `holtburger-core/src/client/movement_types.rs` to carry emote
   command in `Commands[]`. Estimated 50-80 LOC.

## Phase E — In-browser test plan

The user asked specifically about crouch and laying-down. After this
wave + a wasm rebuild + page reload, the user can test:

| Slash command | Expected outcome | Pose / Motion |
|---|---|---|
| `/sit` | character sits down on the ground | `SitState` (`0x4300013d`) |
| `/sit cross legged` | character sits cross-legged | `SitCrossleggedState` (`0x4300013e`) |
| `/sit back` | leaning-back sit | `SitBackState` (`0x4300013f`) |
| `/meditate` | kneeling meditate pose | `MeditateState` (`0x4300011c`) |
| `/kneel` | one-knee kneel | `KneelState` (`0x430000f7`) |
| `/pray` | hands-clasped pray pose | `PrayState` (`0x430000eb`) |
| `/play dead` | LAYS ON GROUND (closest "laying" in retail) | `PossumState` (`0x43000145`) |
| `/possum` | same as above | `PossumState` |
| `/play possum` | same | `PossumState` |
| `/snow angel` | snow-angel laying pose | `SnowAngelState` (`0x43000118`) |
| `/clapping` | held clapping pose (was BROKEN pre-fix) | `ClapHandsState` (`0x430000ed`) |
| `/hmm` | scratching head held pose (was BROKEN) | `ScratchHeadState` (`0x430000f4`) |
| `/waving` | held wave (was BROKEN) | `WaveState` (`0x430000f1`) |
| `/warm hands` | rubbing hands together (was BROKEN) | `WarmHands` (`0x13000119`) |

**Pre-existing limitations:**
- `/crouch`, `/sleep`, `/lay`, `/laydown`, `/lie`, `/prone` will route
  to ACE's "Unknown command" fall-through (per
  `index.html:7567-7677`'s `routeSlashCommand` default arm). This is
  RETAIL-CORRECT — these slash commands never existed in AC.
- The "Crouch", "Sitting", "Sleeping" cycles ARE renderable on the
  player rig if the server ever sets them (e.g. via `EmoteManager`
  on a tamed pet), since Wave 8 wired them into
  `STATIONARY_COMMANDS`. The user-side gap is purely on the
  *triggering* side.

## Summary report

| Phase | Finding |
|---|---|
| A — Catalog | 309 tokens / 74 poses; 6 retail uppercased pose names were case-sensitive in our resolver, causing 21 tokens to no-op locally |
| A — User Q | `/crouch`, `/sleep`, `/lay`, `/lie`, `/prone` have NO retail slash; only `/sit*`, `/kneel`, `/meditate`, `/play dead`, `/possum`, `/snow angel` are player-triggerable laying/seated poses |
| B — Categories | 0 missed (swim, parry, block, vitae, mounts, crafting, trade, etc. all non-features in retail) |
| B — Classifier coverage | 139/141 ACE-referenced motions classified; 2 (AutoRun, MouseLook) are UI keybinds excluded by design |
| C — Dispatch traces | 0 broken dispatch chains across 10 sample commands |
| D — Code changes | 1 wasm fix (6 uppercase arms + test); 0 classifier changes |
| E — Doc | this file |

## Scratch artefacts

- Catalog JSON dump: `/mnt/wbterminal1/tmp/claude-scratch/movement-overhaul/chatposetable.json`
- Inventory script + output: `/mnt/wbterminal1/tmp/claude-scratch/movement-overhaul/inventory.cjs` + `missed-motion-audit-2026-05-26.log`
- Classifier-coverage script: `/mnt/wbterminal1/tmp/claude-scratch/movement-overhaul/classifier_audit.cjs`
