# Shield-Backhand runtime-gate investigation (Wave 6 / Phase 18 — 2026-05-26)

## TL;DR

**The acpedia Combat omnibus page is wrong.** Retail `client_portal.dat`
CMT `0x30000000` contains three `Backhand*` rows under
`SwordShieldCombat` (0x80000040) — one per `AttackHeight`
(Low/Medium/High), all `AttackType=Slash` (0x04) — and **no code path in
either retail acclient.c or ACE filters those rows out for
shield-equipped attackers**. When the picker's deterministic
power-bar / prev-motion lookup hits a Backhand row, retail plays it.

The wiki's per-stance table appears to have been hand-built from
gameplay observation and missed three rows. There is nothing to mirror
in our renderer.

## Context

Wave 5 Phase 10 set up a CMT data-shape regression test
(`external/holtburger/crates/holtburger-dat/tests/shield_stance_backhand_audit.rs`)
that asserts exactly **3** Backhand rows exist under SwordShieldCombat in
retail CMT 0x30000000. The acpedia Combat page implies that should be
**0** (it omits Backhand from the One-Handed-with-Shield column).

The test asserted retail-data shape correctly, but deferred the
wiki-vs-data resolution: maybe retail leaves the rows in the table but
gates them at runtime (acclient.c motion-selection, ACE
`Player_Melee.GetSwingAnimation`, etc). Phase 18 was scoped to find that
gate or prove it doesn't exist.

## Method

Read-only inspection across two source-of-truth trees:

- `~/ac-headers/acclient.c` — 1.4 GB / 938k-line Hex-Rays decompile of
  the retail Asheron's Call client.
- `~/ace-server/Source/` — the ACE.Server / ACE.DatLoader / ACE.Entity
  C# tree.

Searches:

1. `grep CombatManeuverTable::Get acclient.c` — finds the prototype, the
   single non-allocator call site, and the dtor/Pack/Unpack family.
2. `grep -i Backhand acclient.c` — 8 hits.
3. `grep -rn Backhand ace-server/Source/` — 5 hits, all
   non-load-bearing.
4. `grep -i shield ace-server/.../Creature_Combat.cs` — confirms shield
   logic lives upstream (stance picker) and downstream (damage
   mitigation), not in motion selection.
5. `grep CombatTable\. ace-server/Source/` — enumerates all
   server-side consumers (Player_Melee + Monster_Melee).
6. Whole-file reads of `Player_Melee.cs`, `CombatManeuverTable.cs`,
   plus the relevant 100-line windows in `WorldObject_Weapon.cs`,
   `Creature_Combat.cs`, `Monster_Melee.cs`, and acclient.c.

## Findings

### Retail acclient.c (the only `CombatManeuverTable::Get` call site)

`ClientCombatSystem::PlayerInReadyPosition` at
`~/ac-headers/acclient.c:408485–408594` is the **only** non-allocator
caller of `CombatManeuverTable::Get`. The pattern is:

```c
case 2:  // melee combat mode
  at = 0;
  /* ... read player's AttackType via PropertyInt 0x2F = 47 ... */
  CBaseQualities::InqDataID(v8, 4u, &cmt_id);   // grab CMT data ID
  if (cmt_id.id == stru_870678.id) goto LABEL_14;  // no CMT → not ready

  v9 = CombatManeuverTable::Get(cmt_id);          // line 408537
  if (v9) {
    /* ready */
    if (_considerAttackingReady) {
      LOBYTE(v5) = 1;
    } else {
      LOBYTE(v5) = (CPhysicsObj::motions_pending == 0);
    }
  } else {
    LOBYTE(v5) = 0;
  }
```

`v9` is the CMT object itself. The function uses it only as a boolean
"do we have a CMT to swing from?" The rows are never iterated, the
shield equip state is never inspected, and the `Backhand*` MotionCommand
IDs are never compared against anything. This is a readiness gate, not
a motion filter.

The other Backhand-adjacent hits in acclient.c are red herrings:

- Lines 254022–254030 build the **AttackHeight key-binding child
  widgets** in the combat UI tree — `GetChildRecursive(parent,
  0x1000005E)` etc are widget GUIDs that happen to share their integer
  values with the BackhandHigh/Med/Low MotionCommand IDs.
- Lines 407471 and 410027–410055 dispatch **input events**:
  `HandleMagicAction` reuses `0x10000060` as the "cast current spell"
  hotkey; `HandleCombatAction` uses `0x1000005D/5E/5F` (and aliases
  `0x100000F1/F2/F3`) as Low/Medium/High AttackHeight keystroke IDs.
  Pressing Numpad-8 to set High AttackHeight literally dispatches event
  `0x1000005F` which is *also* the integer value of `BackhandMed`. They
  are different namespaces; the integer collision is incidental.
- Lines 43549–43551 are entries in the global symbol-name table —
  `"BackhandHigh"`, `"BackhandMed"`, `"BackhandLow"` as strings.

Nowhere in acclient.c does any function read a MotionCommand return
from CombatManeuverTable, check `IsBackhand`, and gate on shield equip
state. The retail-client swing path mirrors ACE's: trust whatever the
table returns.

### ACE Player_Melee.GetSwingAnimation (the canonical port)

`~/ace-server/Source/ACE.Server/WorldObjects/Player_Melee.cs:440–475`:

```csharp
public MotionCommand GetSwingAnimation()
{
    if (IsDualWieldAttack) DualWieldAlternate = !DualWieldAlternate;
    var offhand = IsDualWieldAttack && !DualWieldAlternate;
    var weapon  = GetEquippedMeleeWeapon();

    var subdivision = 0.33f;
    if (weapon != null) {
        AttackType = weapon.GetAttackType(CurrentMotionState.Stance, PowerLevel, offhand);
        if (weapon.IsThrustSlash) subdivision = 0.66f;
    } else {
        AttackType = PowerLevel > KickThreshold && !IsDualWieldAttack
            ? AttackType.Kick : AttackType.Punch;
    }

    var motions = CombatTable.GetMotion(CurrentMotionState.Stance,
                                        AttackHeight.Value, AttackType,
                                        PrevMotionCommand);

    // higher-powered animation always in first slot ?
    var motion = motions.Count > 1 && PowerLevel < subdivision
                    ? motions[1] : motions[0];

    PrevMotionCommand = motion;
    return motion;
}
```

There is **no shield branch**. The stance is already
`SwordShieldCombat` by the time we get here (set upstream in
`Creature_Combat.GetCombatStance` at lines 274–356 when a shield is
equipped), and the picker takes whatever `CombatTable.GetMotion`
returns. For a single-bit-Slash sword in SwordShieldCombat stance with
the retail CMT, `GetMotion` returns the 2-entry list
`[SlashHigh/Med/Low, BackhandHigh/Med/Low]` (per the comment block in
`CombatManeuverTable.cs:85–88`) and the power-bar slot pick selects
which one plays. The user observes both swings.

### ACE Monster_Melee.GetCombatManeuver

`~/ace-server/Source/ACE.Server/WorldObjects/Monster_Melee.cs:164–230`
is the parallel monster path. Same shape: random AttackHeight + lookup
+ power-bar slot pick. No shield filter (monsters can wield shields
too).

### ACE Creature_Combat.cs (the upstream stance picker)

Lines 274–356: `GetCombatStance` checks `GetEquippedShield()` and
folds the stance to `SwordShieldCombat` / `ThrownShieldCombat` /
`DualWieldCombat` via `AddShieldStance`. That's the **only** place
shield equip influences the swing path — and it does so by *picking the
correct stance bucket*, not by filtering motions inside a bucket.

Lines 641–718 (`GetShieldMod`) compute damage absorption when a shield
is equipped; orthogonal to motion selection.

### ACE WorldObject_Weapon.GetAttackType

Lines 1050–1162: collapses a weapon's `W_AttackType` bitmask to a single
AttackType per stance. The SwordShieldCombat branch (1108–1130) forces
multi-strike weapons (TripleThrust, DoubleThrust) toward thrust attacks
when shielded — i.e. it changes which CMT *attack-type column* gets
looked up. But for the common single-bit-Slash sword, the lookup still
hits `attack_type=0x04`, which contains both the `Slash*` and
`Backhand*` rows. No motion filtering.

### ACE CombatManeuverTable.GetMotion (the lookup itself)

`~/ace-server/Source/ACE.DatLoader/FileTypes/CombatManeuverTable.cs:67–107`
is a pure 3-level dictionary lookup
`(stance → height → type → List<MotionCommand>)`. It returns the whole
list. The comment block at lines 85–88 even calls out the exact
duplicate-motion case we're investigating:

```text
// CombatManeuverTable(30000000).GetMotion(SwordCombat, Medium, Slash)
//   - found 2 maneuvers
// SlashMed
// BackhandMed
```

The function has no knowledge of shield, weapon, or attacker state.
It's a flat lookup.

## Implication for our renderer

**Nothing to mirror.** Our `getCombatManeuver` port in
`apps/holtburger-web/ui/ac_combat_maneuver.js` and the upstream
attack-type plumbing in `lib.rs` already match the ACE+retail
behavior: trust the table. When the ACE server resolves a Backhand
swing for a shielded attacker it broadcasts the resulting
`MotionCommand` via `UpdateMotion` (kind=5), and our pose pipeline
plays it as-is.

If anything, this resolves an open concern from Wave 5 — our renderer
doesn't need a shield-aware Backhand drop, and adding one would
diverge from server-authoritative behavior.

## Sources read

- `~/ac-headers/acclient.c`:
  - 407409–408594 (`ObjectIsAttackable`, `HandleMagicAction`,
    `RepeatAttackInProgress`, `SetPowerBarLevel`, `HidePowerBar`,
    `GetAttackTarget`, `PlayerInReadyPosition` — the
    `CombatManeuverTable::Get` call site at 408537).
  - 408597–408687 (`AttemptStartBuildingAttack`, `ExecuteAttack`).
  - 409950–410069 (`HandleCombatAction` — AttackHeight key-event
    dispatch; the `0x1000005E/5F/60` red herrings).
- `~/ace-server/Source/ACE.Server/WorldObjects/Player_Melee.cs`
  (full, 1–476).
- `~/ace-server/Source/ACE.Server/WorldObjects/Monster_Melee.cs:130–230`
  (`GetCombatManeuver`).
- `~/ace-server/Source/ACE.Server/WorldObjects/Creature_Combat.cs:131–356`
  (combat-stance picker) and 641–718 (`GetShieldMod`).
- `~/ace-server/Source/ACE.Server/WorldObjects/WorldObject_Weapon.cs:980–1245`
  (`IsThrustSlash`, `GetAttackType`, `GetOffhandAttackType`).
- `~/ace-server/Source/ACE.DatLoader/FileTypes/CombatManeuverTable.cs`
  (full, 1–130).
- Repo-wide greps documented in the Method section.

No production code was modified during this investigation.
