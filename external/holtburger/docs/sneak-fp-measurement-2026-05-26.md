# Sneak-Attack Predictor FP Measurement — Investigation Report

**Wave 12 / Phase 39 (Agent AL, 2026-05-26)**

**Verdict: Path A.** Sneak-attack predictor accuracy can be measured *without* any ACE-side modifications. ACE already broadcasts a `SneakAttack` bit on every damage event; the bit already round-trips through our protocol crate; and `src/lib.rs` already surfaces it to JS as `attackConditions` on `damageDealt` / `damageTaken` plugin-bus events. Phase 39's job was purely to consume what's already there.

## AttackConditions enum (4 bits today)

`~/ace-server/Source/ACE.Entity/Enum/AttackConditions.cs:5-14`:

```csharp
[Flags]
public enum AttackConditions
{
    None                           = 0x0,
    CriticalProtectionAugmentation = 0x1,
    Recklessness                   = 0x2,
    SneakAttack                    = 0x4,
    Overpower                      = 0x8
};
```

No `RearAttack` / positional / "dirty fighting" bit — `SneakAttack` is the only one relevant to our predictor. It covers both retail "behind the target" sneak (`Creature_Combat.cs:763` GetSneakAttackMod) and SpellProjectile sneak (`SpellProjectile.cs:733`); both paths feed the same DamageEvent.

## Where ACE sets the bit

`~/ace-server/Source/ACE.Server/Entity/DamageEvent.cs:683-697` exposes a computed `AttackConditions` getter:

```csharp
public AttackConditions AttackConditions {
    get {
        var attackConditions = new AttackConditions();
        ...
        if (SneakAttackMod > 1.0f)
            attackConditions |= AttackConditions.SneakAttack;
        ...
    }
}
```

`SneakAttackMod` is assigned at line 234 (`= attacker.GetSneakAttackMod(defender)`) which queries `Creature_Combat.cs:745` — the canonical retail "is attacker in defender's rear hemisphere AND has SneakAttack skill" check that our client predictor (`scene3d/picking.js`'s `isAttackerBehindDefender`) mirrors.

## Where ACE broadcasts it

`~/ace-server/Source/ACE.Server/Network/GameEvent/Events/GameEventAttackerNotification.cs:16` — `Writer.Write((ulong)attackConditions)` — last 8 bytes of the 0x01B1 (AttackerNotification) payload. Mirror in `GameEventDefenderNotification.cs:18`. Set on enqueue from `Player_Combat.cs:163` (`new GameEventAttackerNotification(..., damageEvent.AttackConditions)`).

## Where our client parses + surfaces it

- **Protocol crate**: `external/holtburger/crates/holtburger-protocol/src/messages/combat/types.rs:27-36` defines `AttackConditions: u64` bitflags with `SNEAK_ATTACK = 0x4`. Unpack at `events.rs:57` (Attacker) and `events.rs:108` (Defender).
- **wasm → JS bridge**: `apps/holtburger-web/src/lib.rs:23601` and `:23649` already write `attackConditions: data.attack_conditions.bits()` into the `damageDealt` / `damageTaken` event JSON. **Zero wire/parser changes needed.**

## Client-side wiring (Path A, shipped this phase)

`scene3d/diag/combat.js` extended:

1. New `pendingPredictions[]` ring populated on every `sneakAttackPredicted` emission (Phase 36's existing hook).
2. New `damageDealt` subscription (idempotent installer, same pattern as the Phase 36 sneak hook). On arrival: bit `0x4` test → resolve `defenderName` to GUID via `entityManager.findGuidByName` → match against pending predictions within a configurable window (default 2000 ms).
3. Three new counters in `combat.sneakConfirmations`: `matched` (TP), `unmatchedServerBit` (server-said-sneak but no matching prediction — FN or non-melee-trigger), `expiredPredictions` (FP — predictor said sneak, ACE disagreed).
4. `summary()` and `snapshot()` surface `sneakFalsePositiveRate = expiredPredictions / total predictions`.

`node --check` clean. No ACE mods. No protocol mods. No `lib.rs` mods. Validation deferred to live combat soak.
