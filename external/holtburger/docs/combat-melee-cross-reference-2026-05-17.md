# Combat: Melee Attack — three-source cross-reference

**Date:** 2026-05-17
**Status:** Phase A doc (no implementation yet). Phase B wires the primitive; Phase C makes it visible in-game.
**Methodology:** See `feedback_three_source_cross_reference.md` — every new game system gets cross-referenced against ACE (server) + RynthSuite/RynthCore (client API) + acclient.h (retail internals) before any implementation code.

## TL;DR

All three sources converge on a small, well-defined primitive. The client sends one `GameAction::TargetedMeleeAttack` packet with `{ targetGuid: u32, attackHeight: u32, powerLevel: f32 }` once per engagement. The server (ACE) owns auto-repeat — it re-fires the swing via an `ActionChain` while the target is alive, in range, and `CharacterOption.AutoRepeatAttacks` is set. The client receives `AttackerNotification` (0x01B1) on each hit, `AttackDone` (0x01A7) when the swing finishes and the power bar can refill, and `CombatCommenceAttack` (0x01B8) when the next swing kicks off. Power is a float clamped to [0.0, 1.0]; height is the retail enum value (HIGH=1, MEDIUM=2, LOW=3). A combat-mode change (separate GameAction) and a target select (separate GameAction) are pre-requisites.

This is a small enough primitive that Phase B (wire + wasm + JS facade) is genuinely scoped to one packet shape + three response handlers.

## Source 1 — ACE server (the server-side contract)

ACE is the source of truth for the wire format: this is the packet shape ACE deserializes off the network.

### GameAction opcode

```csharp
// ACE.Server/Network/GameAction/GameActionType.cs:6
public enum GameActionType
{
    // ...
    TargetedMeleeAttack                  = 0x0008,
    // ...
}
```

The `0x0008` is the sub-opcode inside the GameAction message envelope, not a top-level Turbine opcode. The outer message is `GameAction` and the first u32 of the payload is the sub-opcode.

### Wire-packet payload

```csharp
// ACE.Server/Network/GameAction/Actions/GameActionTargetedMeleeAttack.cs:8-10
public static void Handle(ClientMessage message, Session session)
{
    var targetGuid   = message.Payload.ReadUInt32();
    var attackHeight = message.Payload.ReadUInt32();
    var powerLevel   = message.Payload.ReadSingle();

    session.Player.HandleActionTargetedMeleeAttack(targetGuid, attackHeight, powerLevel);
}
```

Three fields total: `u32 + u32 + f32`. No alignment padding.

### Server-side handler entry

`Player.HandleActionTargetedMeleeAttack` at `ACE.Server/WorldObjects/Player_Melee.cs:51-164` validates combat mode, busy state, jump state, and PK cooldown, then:

1. Clamps `powerLevel` to `[0.0, 1.0]`.
2. Stores `AttackHeight` on the Player.
3. Queues `powerLevel` into `AttackQueue`.
4. Resolves the target via `CurrentLandblock.GetObject(targetGuid)`. If not a live Creature or `!CanDamage(target)`, calls `OnAttackDone()` and returns.
5. Sets `MeleeTarget`, `AttackTarget`, increments `AttackSequence`.
6. Schedules `HandleActionTargetedMeleeAttack_Inner(target, attackSequence)` via an `ActionChain`, possibly with a `NextRefillTime`-driven delay.

### Server-emitted messages (responses)

| Event | Opcode | File | Fields |
|---|---|---|---|
| `GameEventAttackerNotification` | 0x01B1 | `GameEvent/Events/GameEventAttackerNotification.cs` | defenderName (str16), damageType (u32), percent (f64), damage (u32), criticalHit (u32), attackConditions (u64) |
| `GameEventDefenderNotification` | 0x01B2 | `GameEvent/Events/GameEventDefenderNotification.cs` | attackerName, damageType, percent, damage, damageLocation (BodyPart), criticalHit, attackConditions (+align) |
| `GameEventAttackDone` | 0x01A7 | `GameEvent/Events/GameEventAttackDone.cs` | (header) — signals power-bar refill can start |
| `GameEventCombatCommenceAttack` | 0x01B8 | `GameEvent/Events/GameEventCombatCommenceAttack.cs` | (header) — sent before each repeating swing to show hourglass |
| `UpdateHealth` / vital deltas | — | standard channel | broadcasts target's health change |

### Auto-repeat (server-driven)

ACE owns the repeat loop:

```csharp
// Player_Melee.cs:375-384
if (creature.IsAlive && GetCharacterOption(CharacterOption.AutoRepeatAttacks) &&
    (dist <= MeleeDistance || dist <= StickyDistance && IsMeleeVisible(target)) &&
    !IsBusy && !AttackCancelled)
{
    Session.Network.EnqueueSend(new GameEventAttackDone(Session));

    var nextAttack = new ActionChain();
    nextAttack.AddDelaySeconds(nextRefillTime);
    nextAttack.AddAction(this, () => Attack(target, attackSequence, true));
    nextAttack.EnqueueChain();
}
```

`nextRefillTime ∝ PowerLevel`. Client does NOT send a new `TargetedMeleeAttack` packet per swing — the server schedules its own `Attack` calls. The client only re-issues a packet to **change targets, change height, change power, or break and re-engage**.

### Stamina cost

`Player_Melee.cs:299-302`:
```csharp
var staminaCost = GetAttackStamina(GetPowerRange());
UpdateVitalDelta(Stamina, -staminaCost);
```
Cost is function of weapon burden + power level + Endurance, deducted at swing start. Misses still cost.

## Source 2 — RynthSuite + RynthCore (the working bot's client API)

RynthSuite is a NativeAOT C# plugin injected into retail `acclient.exe`. Its `CombatManager` is a model of how a real AC combat bot exercises the client's combat API — we're not porting the DLLs, we're mining the call shape so our JS facade can mirror it.

### Call chain summary

```
RynthAi (UI / decision)
  ↓
CombatManager.AttackTarget()                 // RynthSuite
  ↓
host.SelectItem(targetId)                    // RynthCoreHost.cs:361 — picks target
host.ChangeCombatMode(desiredMode)           // RynthCoreHost.cs:145 — Melee/Missile/Magic
host.MeleeAttack(targetId, height, power)    // RynthCoreHost.cs:186 — fires the GameAction
  ↓
delegate*<uint, int, float, int>(meleeFn)    // pattern-scanned function in acclient.exe
```

### CombatManager entry

`/mnt/wbterminal1/ac-refs/rynthsuite/Plugins/RynthCore.Plugin.RynthAi/Combat/CombatManager.cs:1259`:

```csharp
private void AttackTarget()
{
    // ...
    int uiHeight = isMissile ? _settings.MissileAttackHeight : _settings.MeleeAttackHeight;
    int acHeight = uiHeight switch { 0 => 3, 2 => 1, _ => 2 };  // Low=3, Med=2, High=1
    // ...
    if (_settings.UseNativeAttack && _host.HasNativeAttack)
    {
        _host.SelectItem(targetId);
        _host.NativeAttack(acHeight, power);
        return;
    }
    if (isMissile)
        _host.MissileAttack(targetId, acHeight, power);
    else
        _host.MeleeAttack(targetId, acHeight, power);
}
```

The "native" path is Chorizite-only (hardcoded retail VAs for the `ClientCombatSystem::StartAttackRequest` / `EndAttackRequest` functions). The non-native path sends a raw GameAction — that's the path that maps 1:1 to our wire packet and to ACE's handler.

### Pattern-scan confirmation of the opcode

`/mnt/wbterminal1/ac-refs/rynthcore/src/RynthCore.Engine/Compatibility/CombatActionHooks.cs:94-136`:

```csharp
byte[] meleeOpcode = [0xC7, 0x02, 0x08, 0x00, 0x00, 0x00];  // mov [edx], 0x08
int meleeOff = PatternScanner.FindPatternInRegion(text, meleeOpcode, ...);
```

The `0x08` here is the retail client writing the sub-opcode into its GameAction packet buffer — independent confirmation that `0x08` is the `TargetedMeleeAttack` GameAction sub-opcode at the wire level. ACE and the retail client agree.

### Auto-repeat is NOT client-driven

```csharp
// CombatManager.cs:39-40
// StartAttackRequest auto-repeats — only call once per target.
private uint _nativeAttackTargetId;
```

RynthSuite fires `MeleeAttack` once per *new target*. The retail client's `ClientCombatSystem` (and the server) handle the repeat. We adopt the same contract.

### Combat-mode pre-flight

Before any attack, `CombatManager.EquipWeaponAndSetStance` (line ~960) calls `_host.ChangeCombatMode(desiredMode)` if the player isn't already in the right mode. Same primitive as the server's `Player.HandleActionChangeCombatMode` — separate GameAction.

## Source 3 — acclient.h (retail client internals)

acclient.h is the symbol-decompiled retail debug info. It gives us the *types* the retail client used internally — which is the source of truth for enum values + struct layouts that ACE and RynthCore both reference indirectly.

### Combat-mode enum

```c
// acclient.h:4966
enum eCombatMode {
  eCombatModeUndef    = 0x0,
  eCombatModeNonCombat = 0x1,
  eCombatModeMelee    = 0x2,
  eCombatModeMissile  = 0x4,
  eCombatModeMagic    = 0x8,
};
```

Note the bitfield-like spacing (1, 2, 4, 8) — same values ACE uses in `CombatMode` enum.

### Attack-height enum

```c
// acclient.h:4371
enum ATTACK_HEIGHT {
  UNDEF_ATTACK_HEIGHT   = 0x0,
  HIGH_ATTACK_HEIGHT    = 0x1,
  MEDIUM_ATTACK_HEIGHT  = 0x2,
  LOW_ATTACK_HEIGHT     = 0x3,
  NUM_ATTACK_HEIGHTS    = 0x4,
};
```

These are the values that go into the `u32 attackHeight` wire field. RynthSuite's UI-to-AC remap (`0→3, 2→1, _→2`) is just a UI ordering choice; the wire values are 1/2/3.

### ClientCombatSystem state — what the retail client tracked

```c
// acclient.h:40640 (excerpt)
struct ClientCombatSystem : ClientSystem, IInputActionCallback, QualityChangeHandler
{
  bool jump_pending;
  bool m_bTrackingTarget;
  COMBAT_MODE combatMode;
  COMBAT_MODE pendingCombatMode;
  ATTACK_HEIGHT requestedAttackHeight;
  long double buildStartTime;
  bool buildInProgress;
  PowerBarMode powerBarMode;
  float latestPowerBarLevel;
  bool attackInProgress;
  bool attackServerResponsePending;
  bool attackRequestInProgress;
  float requestedAttackPower;          // [0.0, 1.0]
  bool repeatAttacking;
  bool currentBuildIsAutomatic;
  bool targetWillinglyLost;
  bool attackWhenResponseReceived;
  float attackWhenResponseReceived_Power;
  float m_rUIRequestedPower;
  bool m_bAdvancedCombatMode;
  long double lastAttackedTime;
};
```

Key fields for our JS state model:
- `requestedAttackPower` (float) — confirms power is a normalized float, consistent with the f32 in the wire payload.
- `attackRequestInProgress` + `attackServerResponsePending` — two-stage "I asked, waiting" state to suppress duplicate sends.
- `attackWhenResponseReceived_Power` — queued next-power slot for player input mid-swing.
- `repeatAttacking` — local mirror of "we expect the server to fire another one".

The retail client did NOT own the repeat schedule — it owned the *state mirror* of "yes I'm in a repeat loop, render the power bar accordingly".

### AttackManager / AttackInfo — internal hit-collection (server-side-equivalent, included for completeness)

```c
// acclient.h:31016
struct AttackManager {
  float attack_radius;
  unsigned int current_attack;
  LongNIHash<AttackInfo> pending_attacks;
};

// acclient.h:52525
struct AttackInfo {
  unsigned int attack_id;
  int part_index;
  float attack_radius;
  unsigned int waiting_for_cells;
  unsigned int num_objects;
  DArray<ObjectInfo> object_list;
};
```

These exist in retail for the client-side prediction of hits during the swing animation. ACE doesn't need them — ACE re-computes hits server-side. For our JS client, we likely don't need them in Phase B either: server-authoritative damage is the ACE model.

## Three-way convergence

| Concern | ACE | RynthSuite | acclient.h | Picked for holtburger-web |
|---|---|---|---|---|
| GameAction sub-opcode | 0x0008 (`TargetedMeleeAttack`) | pattern `[..0x08..]` | n/a | `0x0008` |
| Wire field 1 | `targetGuid: u32` | `targetId: uint` | `m_oidSelectedTarget` (game-obj) | `u32 target_guid` |
| Wire field 2 | `attackHeight: u32` cast to `AttackHeight` | `int height` (1/2/3) | `ATTACK_HEIGHT` u32 | `u32 attack_height` |
| Wire field 3 | `powerLevel: f32`, clamped [0,1] | `float power` | `requestedAttackPower: float` | `f32 power` |
| Combat-mode values | matches retail | matches retail | `eCombatMode`: 0/1/2/4/8 | `eCombatMode` verbatim |
| Auto-repeat owner | server (`ActionChain` re-fires) | "only call once per target" | client mirrors `repeatAttacking` | server-driven, JS sends once |
| Pre-reqs | mode==Melee, !busy, !IsJumping, !PKLogout | `ChangeCombatMode` + `SelectItem` | `combatMode == Melee` | mode change + target select are separate GameActions |

The three sources don't contradict each other on any load-bearing detail.

## Wire-packet spec for Phase B

For `holtburger-protocol/src/messages/` (Rust):

```rust
// GameAction sub-opcode for TargetedMeleeAttack
pub const GAME_ACTION_TARGETED_MELEE_ATTACK: u32 = 0x0008;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TargetedMeleeAttackActionData {
    pub target_guid:   u32,
    pub attack_height: AttackHeight,  // u32 on the wire
    pub power_level:   f32,           // [0.0, 1.0]; ACE clamps server-side
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum AttackHeight {
    Undef  = 0,
    High   = 1,
    Medium = 2,
    Low    = 3,
}
```

Wire encoding (little-endian per AC convention): `target_guid:u32 || attack_height:u32 || power_level:f32`. Total 12 bytes payload, embedded in a `GameAction` outer message with the sub-opcode as the first u32 of the GameAction payload.

For `apps/holtburger-web/src/lib.rs`:

```rust
pub enum SessionCommand {
    // ... existing variants ...
    Attack {
        target_guid: u32,
        attack_height: AttackHeight,
        power_level: f32,
    },
    // ... possibly ...
    ChangeCombatMode {
        mode: CombatMode,
    },
    SelectObject {
        guid: u32,  // covered by IdentifyObject already? double-check
    },
}

#[wasm_bindgen]
impl SessionHandle {
    pub fn attack(
        &self,
        target_guid: u32,
        attack_height: u32,
        power_level: f32,
    ) -> Result<(), JsValue> {
        // dispatch SessionCommand::Attack
    }
}
```

For `apps/holtburger-web/plugins/api.js`:

```js
client.player.attack(targetGuid, height, power)
  → sessionHandle.attack(targetGuid, height, power)

client.player.setCombatMode(mode)
  → sessionHandle.changeCombatMode(mode)  // rename existing toggleCombatMode? — see open Qs
```

For `client.events.emit`:

```js
client.events.emit("damageDealt", { defenderName, damageType, percent, damage, criticalHit, attackConditions });
client.events.emit("damageTaken", { attackerName, damageType, percent, damage, damageLocation, criticalHit, attackConditions });
client.events.emit("attackDone");
client.events.emit("combatCommenceAttack");
```

## Resolved questions (user-confirmed 2026-05-17)

1. **`toggleCombatMode` stays.** Keep the existing no-arg toggle for Phase B. The retail combat-bar button is a toggle that enters/leaves the most-recently-used (or auto-derived) combat sub-mode. We may need a parametric `change_combat_mode(mode)` later if a plugin wants to force a specific mode, but Phase B uses the toggle.

2. **Combat sub-mode is weapon-derived; `SelectObject` targets the entity to attack, not the weapon.** Entering combat mode picks the sub-mode from what's in hand:
   - **Magic** if wand/staff/orb. Cast-spell UI.
   - **Missile** if bow / crossbow / thrown. Requires ammo; drops out of combat if you run out. Slider chooses **speed ↔ accuracy**.
   - **Melee** otherwise. Works **with no weapon in hand** (unarmed). Slider chooses **speed ↔ power**.
   - This means melee is the safest first ship — it works without any inventory state.
   `SelectObject(guid)` (= RynthSuite's `SelectItem(targetId)`) selects the **attack target** entity, separate from `IdentifyObject` (which auto-fires on ObjectCreate to learn what an entity is). Phase B needs a real `SelectObject` GameAction; confirm in ACE source whether there's an existing `GameActionType` for it before adding a new one.

3. **`AttackDone` payload — verify in Phase B.** Re-read `GameEventAttackDone.cs` when wiring the recv arm. If it's header-only, treat as a tick. If it carries fields, deserialize accordingly.

4. **Auto-repeat toggle = combat-bar checkbox.** `CharacterOption.AutoRepeatAttacks` is a client-side option (tickbox in the combat bar) that syncs server-side via the character-options channel. Not part of Phase B; surfaces in Phase C UI when we add the combat bar.

5. **MotionTable for swing animation — pursue the real data.** Try to load the swing motion from `MotionTable.fetchPhysicsScript`-equivalent infra first. Fall back to vibe-coded pose (jump precedent) only if the data path is blocked. If the data path is unclear, ask user to search Discord.

## Source-citation footer

- **ACE**: `~/ace-server/Source/ACE.Server/Network/GameAction/GameActionType.cs:6`; `ACE.Server/Network/GameAction/Actions/GameActionTargetedMeleeAttack.cs:8`; `ACE.Server/WorldObjects/Player_Melee.cs:51,299,375`; `ACE.Server/Network/GameEvent/Events/GameEventAttackerNotification.cs:8`, `GameEventDefenderNotification.cs:9`, `GameEventAttackDone.cs:7`, `GameEventCombatCommenceAttack.cs:5`.
- **RynthSuite / RynthCore**: `/mnt/wbterminal1/ac-refs/rynthsuite/Plugins/RynthCore.Plugin.RynthAi/Combat/CombatManager.cs:39,734,960,1259`; `/mnt/wbterminal1/ac-refs/rynthcore/src/RynthCore.PluginSdk/RynthCoreHost.cs:145,186,361,1146`; `/mnt/wbterminal1/ac-refs/rynthcore/src/RynthCore.Engine/Compatibility/CombatActionHooks.cs:94,193`; `ClientCombatHooks.cs:15,130`.
- **acclient.h**: `~/ac-headers/acclient.h:3807,4371,4966,31016,40640,40655,52499,52509,52525,57437`.

Adjacent memory:
- `feedback_three_source_cross_reference.md` — the methodology this doc instantiates
- `project_holtburger_jump_done_2026-05-16.md` — same methodology applied to jump; the precedent for "wire + wasm + vibe pose" pattern
- `project_holtburger_ui_shell_bar_done_2026-05-17.md` — the plugin bar that will host the RynthSuite-port combat UI once Phase C lands
- `reference_ac_re_artifacts.md` — acclient.h provenance
