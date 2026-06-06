# Movement + Animation Cross-Source Research Report (2026-06-06)

Cross-references **decomp** (`~/ac-headers/acclient.c`), **ACE** (`external/ACE/Source`),
**chorizite**, **melt**, and **our** code (`external/holtburger`, branch
`movement-anim-fixes-2026-06-05` @ `db2a1a2f`) for the 11 open movement/animation items
carried out of `from-vm/HANDOFF-movement-anim-2026-06-05.md` and the two `*-deep-2026-06-04`
OPEN-QUESTIONS sets.

Method: per item, one Explore agent read the assigned sources and produced a cited finding; a
second adversarial agent independently re-derived each load-bearing claim from ground truth; a
synthesis pass ranked them. 23 agents, ~1.0M tokens. Raw structured output: `raw-findings.json`.

**This report supersedes the agents' auto-ranking on the P0 item** — see the correction below,
which was found by the user (not the agents) and re-verified against the code.

---

## ⚠ CORRECTION TO THE P0 FINDING (read first)

The agents flagged the snapback root as a missing **augmentation carrying-capacity cap** in our
`player_capacity()` (we compute `(150·str)+(num_augs·30·str)` uncapped;
ACE `EncumbranceSystem.EncumbranceCapacity` caps the aug bonus at `150·str`,
`external/ACE/.../Physics/Common/EncumbranceSystem.cs:5-20`). That divergence is **real** and
present in the active tree (`crates/holtburger-world/src/context.rs:196`), but it is **NOT the
snapback cause**, because of the load modifier:

```rust
// crates/holtburger-world/src/context.rs:47
pub fn burden_load_modifier(burden: f32) -> f32 {
    if burden < 1.0 { 1.0 }          // clamped at 1.0 below capacity
    else if burden < 2.0 { 2.0 - burden }
    else { 0.0 }
}
```

`load_mod` maxes at **1.0** — burden is a *brake only*; lack of burden can never raise `run_rate`
above the skill baseline (ACE is identical: `EncumbranceSystem.GetBurdenMod`, and our test locks
the thresholds to it). The capacity (and therefore the augmentation cap) only moves `run_rate`
when `burden ≥ 1.0`, i.e. the char is **over-encumbered**. A `+Tester` running around town has
`burden ≈ 0`, so both sides land on `load_mod = 1.0` and the capacity difference is **inert**. The
agent never checked whether the snapback char was over capacity; its proposed mechanism silently
assumes the `load_mod < 1.0` regime.

**With `load_mod` pinned to 1.0, the only free variable is the run-skill we feed**
`(1.0·(s/(s+200)·11)+4)/4`. Both ACE and we source the **Current** Run skill into the *same*
formula:

- **ACE** `Creature.GetRunRate()` (`external/ACE/.../WorldObjects/Monster_Navigation.cs:346` — a
  `partial class Creature` file, *not* a separate Monster type; `Player : Creature` inherits it and
  calls it from `Player_Move.cs:159`; the player branch lives inside it behind `if (this is Player)`):
  `runSkill = GetCreatureSkill(Skill.Run).Current`.
- **Ours** `player_run_rate()` (`context.rs:210`): `get_player_skill_current(Run)` **with a fallback
  to Quickness** when the wire hasn't populated Run yet — ACE has no such fallback.

So the real P0 lever is the **run-skill INPUT** (prime suspect: the Quickness fallback, or a
buffed-vs-base / stale-skill mismatch), and the resolution is the live-input diff the handoff
already specified — **not** a capacity edit. The aug-cap is demoted to a low-priority correctness
cleanup (still worth fixing for over-encumbered chars, with a `num_augs ≥ 6` test).

---

## Ranked plan (corrected)

### TIER 1 — the live snapback root (do first)

**1. RUN-RATE live input probe** · *measurement, then likely a 1-line input fix*
The over-run is in the run-skill we feed, masked by the agents' burden detour. Instrument a
per-tick getter exposing the actual `run_skill`, `burden`, and resulting `run_rate` we compute, plus
whether the Quickness fallback fired. Capture on the 1070 for `+Tester`, diff against ACE's
`GetCreatureSkill(Skill.Run).Current` + burden for the same char. The integrator formula
(`4.0 × run_rate` = acclient `get_state_velocity:343539`) stays untouched — fix the input so our
`run_rate == ACE`'s.
- Files: `context.rs:210` (`player_run_rate`, the Quickness fallback at `:219-221`),
  `apps/holtburger-web/src/lib.rs:~26918` (`LATEST_RUN_RATE` cache + `playerRunRate` export).
- This is the handoff's original `#1 NEXT` / ACTION line, restored.

### TIER 2 — confirmed, high visible value

**2. PROJECTILE dead-reckon** · *real · headless · ACE-side* — CONFIRMED/GO/high
Spell/missile bolts get motion via `VectorUpdate` only (velocity-only, pure dead-reckon), never
per-tick position. ACE only sends `GameMessageVectorUpdate` **on impact** to zero velocity
(`SpellProjectile.cs:238`) and **never at spawn**, so our (correct) JS dead-reckon
(`entities.js:7071-7073`) is starved — `lastVel` is never set → bolt sits/teleports, no arc.
- Fix: ACE emits the spawn velocity — `EnqueueBroadcast(new GameMessageVectorUpdate(sp))` after
  `LandblockManager.AddObject` in `WorldObject_Magic.cs:~1828`. No HOLT change needed once it does.
- **Open sub-question that gates correctness:** does ACE gravity arc-spells server-side
  (`SpellProjectile.cs:1761 useGravity`)? If ACE holds velocity constant and integrates gravity
  itself, our **linear** dead-reckon will under-arc Arc shapes — resolve before shipping.

**3. MotionData.omega cycle apply** · *real · headless build + 1070 eye-test* — CONFIRMED/GO/high
`MotionData.omega` is parsed (`motion_table.rs:303-313`) but only consumed for turn-left/right
modifiers (`self_movement.rs:249-278`); general cycles drop it → static idle-spinners (signs/fans)
render frozen. ACE applies `SetOmega(omega · speed)` (`Physics/Animation/MotionTable.cs:363`);
`entities.js setMotion` applies the SetOmega *hook* (type 22) but never the *cycle* omega.
- Fix (3 parts, flag default-OFF): (a) wasm `getCycleOmega(mtable, stance, cmd) -> Option<Vec3>` in
  `lib.rs`; (b) `entities.js setMotion` (~`:4731`) applies it via the existing `_omega` path (mirror
  hook code ~`:7867`); (c) zero `inst._omega` when the cycle carries no omega.
- Eye-test on a known-omega spinner on the 1070; resolve which Holtburg entities carry cycle omega.

**4. ROOTMOTION orientation (DIM5-2)** · *shipped, gated · eye-test ONLY* — CONFIRMED/GO/high
Already implemented and gated (`DIM5_2_ROOT_ORIENT`, `lib.rs:5084-5136`), both host paths unit
-tested. No code work. Reachable only on creature tables (player tables are identity → no-op).
- Eye-test MT `0x090001D5` cmd `0x0011` (27.46° yaw) on the 1070 with the gate ON; keep ON if clean,
  revert to `false` if it regresses.
- (The sibling DIM5 *translation* accumulation — raw-per-frame vs ACE running-sum `Sequence.cs:383`/
  `AFrame.cs:46` — shares the same reachability gate; idle/walk/run carry zero pos_frames, so it only
  bites a translating one-shot. Bundle with the eye-test if such a clip is found in-scene.)

### TIER 3 — needs a gate cleared before code

**5. MULTI-ACTION queue collapse** · *confirmed-broken path · CAPTURE FIRST* — reachability UNKNOWN
We unpack `commands: Vec<MotionItem>` at the protocol layer (`types.rs:316-323`) but discard it at
the wasm `UPDATE_MOTION` emit (`lib.rs:30507-30511`), surfacing only the singular `motion_command`
to `loop.js:1245`. Retail loops all actions with stamp-dedup (`acclient.c:344398-344407`). **But it
is unknown whether current Holtburg content ever packs ≥2 actions** per `UpdateMotion`.
- Capture a live `UpdateMotion` with ≥2 actions (NPC emote chains / cast flourishes) to confirm
  reachability **before** building the FIFO drain. Do not build speculatively.

**6. CHARGE locomotion cadence** · *partial · CAPTURE FIRST · lowest confidence* — partial/med
Whether a distinct charge *animation cadence* exists in retail at all is unproven: ACE's own
`Creature.cs:318` has the `/4.0` charge modifier **commented out**, and ACE `get_command` ignores
`CanCharge`. We mirror ACE (charge == run). The retail `MovementParams.CanCharge | Speed = 1.5f`
exists (`Player_Move.cs`), but the visible-cadence claim needs a live charge trace (a `CanCharge`
mob charging the player, animation cadence vs server velocity). If no current Holtburg creature sets
`CanCharge`, demote to record-only. No speculative `CHARGE_ANIM_SPEED` constant.

### TIER 4 — record-only / decision

**7. AUGMENTATION-CAP cleanup** · *real latent bug · headless · NOT the snapback* (demoted from P0)
`context.rs:196` computes `(150·str)+(num_augs·30·str)` uncapped; cap the bonus to match ACE:
```rust
let bonus_burden = (num_augs * 30.0).min(150.0);
Some((150.0 * strength) + (bonus_burden * strength))
```
Only affects over-encumbered (`burden ≥ 1.0`) chars with `num_augs ≥ 6`. The existing test
(`num_augs = 1` → 18000) won't catch it — add a `num_augs ≥ 6` case. Land for correctness, not feel.

**8. POSITION-SEQ gate symmetry** · *inert under TCP · optional cleanup* — NO-GO reachability
Correction to the agent's "missing" framing: the entity position-seq check **is** implemented
(`entity.rs:437-442`), just split across two methods while the player gate consolidates all three
(`player/mutations.rs:223-258`). Reachability is **NO-GO** — the WS transport is reliable-ordered
(TCP), so reordered position-only frames don't occur. Optional symmetry consolidation, default ON,
semantically correct but inert. **Also drop the unverified comment** at `entity.rs:435-436` claiming
`PositionPack.cs:47` bumps `ObjectPosition` per broadcast — ACE uses `GetCurrentSequence`, not
`GetNextSequence` (`WorldObject_Networking.cs:411`), so that claim is unsubstantiated.

**9. PER-PART LOD** · *real, reachable · GO/NO-GO · profile first* — partial/GO/high
`resolve_did_degrade` returns 0 for any `setup.parts.len() != 1` (`lib.rs:5564`) → every multi-part
rig (all humanoid NPCs/monsters/remote players) renders full detail at all distances. Real and
reachable, but the payoff is **perf, not feel**, and the fix is a 9-callsite signature ripple
(`u32 → Vec<u32>`, ripple at `lib.rs:7506/8239/8268/8274/8306`) + per-part JS mesh-swap honoring
`degrade_mode` + player exclusion. **Profile a Holtburg town/crowd to quantify the full-detail cost
before committing.** Not next-session headless work. (Verifier corrected a citation: `acclient.c:332356`
has no "modes 2-5" comment.)

### ALREADY CLOSED (record-only — no action)

- **VECTORUPDATE-SEQ** — fixed (`2aed8a41`) and enabled (`fef649de`, 2026-06-04);
  `USE_VECTOR_SEQUENCE_GATE = true` at HEAD; both self/remote paths gated via `is_newer_u16`.
- **SOUNDTWEAKED bytes** — corrected (`dcc277a1`, 2026-06-04); `sound_priority` reads `[8..12]`,
  `sound_probability` `[4..8]`, matching retail/melt wire order. (Optional: add an end-to-end payload
  test if revisiting audio.)
- **0xF619 PositionAndMovementEvent** — our codec+handler are implemented and round-trip tested;
  ACE only declares the opcode constant and **never emits it** (uses separate UpdatePosition +
  UpdateMotion). Forward-compat robustness, not a live break.

---

## Recommended sequence for the next code session

1. **RUN-RATE live input probe** (measure → fix the run-skill input; the real snapback root).
2. **PROJECTILE dead-reckon** (ACE-side spawn-velocity broadcast; resolve the Arc-gravity question first).
3. **MotionData.omega** cycle apply (headless build, flag-gated → 1070 eye-test).
4. **ROOTMOTION DIM5-2** eye-test (no code; flip the gate on the 1070 result).
5. **AUGMENTATION-CAP** cleanup (2-line + `num_augs ≥ 6` test; correctness only).
6. *(gate-cleared only)* **MULTI-ACTION** capture, then FIFO drain.
7. *(gate-cleared only)* **CHARGE** charge-trace, else record-only.
8. *(decision)* **PER-PART LOD** — profile first; separate task if material.

## Buckets

| Bucket | Items |
|--------|-------|
| Headless-fixable now | RUN-RATE probe, PROJECTILE (ACE-side), MotionData.omega build, AUG-CAP cleanup |
| Eye-test-gated (1070) | MotionData.omega flip, ROOTMOTION DIM5-2 |
| Needs wire capture first | MULTI-ACTION queue, CHARGE cadence |
| Decision / profile | PER-PART LOD |
| Record-only (closed) | VECTORUPDATE-SEQ, SOUNDTWEAKED, 0xF619, POSITION-SEQ (inert) |

## Sources

- decomp: `/home/wbterminal/ac-headers/` — `acclient.c` (retail behavioral truth), `acclient.h`.
- ACE: `external/ACE/Source/ACE.Server/{WorldObjects,Physics}` (server authority).
- our code: `external/holtburger` @ `db2a1a2f` — Rust wasm `apps/holtburger-web/src/lib.rs` +
  `crates/*`; JS scene `apps/holtburger-web/src/scene3d/*.js` + `index.html`.
- chorizite: `external/chorizite/Chorizite.ACProtocol` (generated protocol classes).
- melt: `external/melt` (research-only — `ACE.DatLoader`, AnimationHook subclasses, MotionData).

> Note: the run-rate finding's `ourBehavior` citations pointed at the **inactive** `~/holtburger`
> mirror; the divergence was re-verified in the active `external/holtburger` tree
> (`context.rs:196`, formula identical). Per-item raw output (including the original, now-demoted
> P0 framing) is preserved verbatim in `raw-findings.json`.
