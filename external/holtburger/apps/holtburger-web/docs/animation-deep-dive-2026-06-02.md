# AC Animation Deep Dive — holtburger-web 3D render (ACME edition)

**Date:** 2026-06-02  
**Method:** 13-subsystem multi-agent deep read across retail decomp (`acclient.c/.h/.txt`) / ACE / chorizite / melt + the holtburger-web target. Every load-bearing claim was adversarially re-verified against source. 32 agents · ~3.0M tokens · 1,170 tool calls · ~91 min.  
**Companion:** high-level context map in `animation-deep-dive-context-2026-06-02.md`.  
**Canonical pair:** retail `acclient.c` + ACE are bit-for-bit identical on constants/branches and are the behavioral truth; melt is a DAT parser only; chorizite is offset thunks; holtburger ships a faithful DAT parser + a deliberately-reduced runtime.

## Verification scorecard

| # | Subsystem | Verdict | Refuted/corrected |
|---|---|---|---|
| 1 | MotionTable lookup (stance+cmd→sequence) | mostly-solid | 0 |
| 2 | Motion state machine (stance/mod/action) | solid | 0 |
| 3 | CMotionInterp (cmd→anim, raw/interp state) | solid | 0 |
| 4 | Animation (0x03) format & keyframes | solid | 0 |
| 5 | SetupModel (0x02) skeleton & parts | mostly-solid | 0 |
| 6 | CSequence playback & interpolation | mostly-solid | 0 |
| 7 | Hooks — visual/material/transform | solid | 0 |
| 8 | Hooks — sound/particle/script/attack | solid | 0 |
| 9 | Particle system (ParticleEmitterInfo 0x32) | solid | 0 |
| 10 | PhysicsScript (0x33) & script hooks | solid | 0 |
| 11 | Velocity/omega & ice-skating | mostly-solid | 1 |
| 12 | Jump & fall mechanics | mostly-solid | 0 |
| 13 | Wire protocol (movement/motion msgs) | solid | 0 |

> All 13 subsystems landed `solid` or `mostly-solid`; one claim was refuted (velocity-iceskating) and is corrected inline below. The completeness critic additionally surfaced **three uncovered subsystems** (MotionKinematics, CombatManeuverTable, ChatPoseTable) — see the Critic appendix; they materially affect the velocity and combat work.

---

## Motion Resolution & State Machine

This section is the canonical reference for how Asheron's Call turns a stance + motion command into played animation, across retail (`acclient.c`), ACE (`MotionTable.cs` / `MotionInterp.cs`), MELT (DAT parser only), Chorizite (offset thunks only), and holtburger-web. **Retail + ACE are the canonical behavioral pair** — they are bit-for-bit identical on every constant and branch. holtburger ships a faithful DAT parser plus a deliberately-reduced runtime (single-cycle + one-shot-link), not the full state machine.

There are **three nested layers**:

1. **`CMotionInterp`** — turns raw player key intent into a resolved motion command + speed (`RawMotionState` → `InterpretedMotionState`).
2. **`MotionTableManager` / `MotionState`** — the per-object stance/cycle/modifier/action state.
3. **`CMotionTable::GetObjectSequence`** — the resolver that consumes a command + `MotionState` and rebuilds the played `CSequence`.

---

### Layer 1 — `CMotionInterp`: command + speed resolution

`CMotionInterp` (struct `acclient.h:31407-31420`, 0x88 bytes) holds `RawMotionState raw_state` (the player's key-derived intent) and `InterpretedMotionState interpreted_state` (the post-resolution state actually played), plus `current_speed_factor` (init 1.0), `my_run_rate` (init 1.0), `standing_longjump`, `jump_extent`, `server_action_stamp`, and a `pending_motions` queue.

The two state structs have **different field order** (a real gotcha):

| `RawMotionState` (`acclient.h:31372-31386`) | `InterpretedMotionState` (`acclient.h:31389-31399`) |
|---|---|
| `LList<ActionNode> actions` (**FIRST**) | `uint current_style` |
| `HoldKey current_holdkey` | `uint forward_command; float forward_speed` |
| `uint current_style` | `uint sidestep_command; float sidestep_speed` |
| 3 slots `{forward,sidestep,turn}` × `{command, holdkey, speed}` | `uint turn_command; float turn_speed` |
| | `LList<ActionNode> actions` (**LAST**) |

`InterpretedMotionState` has **no per-slot holdkeys** — the holdkey is consumed by `adjust_motion` before this state is written. ACE `RawMotionState.cs:9-20` matches the retail field order exactly.

#### `adjust_motion` — Raw→Interpreted command/speed rewrite

Called 3× per `apply_raw_movement` (one per slot). Per-slot rewrite (`acclient.c:343746-343803`, ACE `MotionInterp.cs:394-428`):

```
if (WeenieObj && !IsCreature) return;          // non-creatures keep raw cmd+speed
switch (motion):
  RunForward (0x44000007):  return early;       // already run, no scaling
  WalkBackwards (0x45000006): motion=WalkForward(0x45000005); speed *= -BackwardsFactor;
  TurnLeft (0x6500000E):     motion=TurnRight(0x6500000D);     speed *= -1;
  SideStepLeft (0x65000010): motion=SideStepRight(0x6500000F); speed *= -1;
if (motion == SideStepRight):
  speed *= SidestepFactor(0.5) * (WalkAnimSpeed(3.12) / SidestepAnimSpeed(1.25));  // ≈1.248
// holdKey: if Invalid use RawState.CurrentHoldKey; if ==Run → apply_run_to_command
```

Retail bakes the SideStepRight scale as the literal `3.1199999/1.25*0.5` at `acclient.c:343786`.

#### `apply_run_to_command` — Walk→Run promotion + run scaling

`acclient.c:343439-343483`, ACE `MotionInterp.cs:525-561`:

```
speedMod = WeenieObj.InqRunRate(out runFactor) ? runFactor : MyRunRate;  // 1.0 if no weenie
switch (motion):
  WalkForward (0x45000005): if (speed > 0) motion = RunForward(0x44000007);  speed *= speedMod;
  TurnRight   (0x6500000D): speed *= RunTurnFactor(1.5);
  SideStepRight(0x6500000F): speed *= speedMod; if (fabs(speed) > 3.0) clamp to ±3.0 (sign-preserving);
```

**Backstep stays `WalkForward`.** Because `adjust_motion` already negated its speed (`× -0.65`), the `if (speed > 0)` promotion gate is skipped — there is intentionally **no RunBackward**; run gait only scales the magnitude.

#### `get_state_velocity` — Interpreted state → world velocity / anim rate

`acclient.c:343539-343594`, ACE `MotionInterp.cs:678-700`. Builds the world velocity used both for jump leave-ground velocity and for anim playback rate (`Framerate = base × speed`):

```
X = SidestepAnimSpeed(1.25) * SideStepSpeed   if SideStepCommand == SideStepRight  else 0
Y = WalkAnimSpeed(3.12)     * ForwardSpeed     if ForwardCommand == WalkForward
  = RunAnimSpeed(4.0)       * ForwardSpeed     else if RunForward
  = 0                                          else
Z = 0
rate = InqRunRate ? runFactor : 1.0           // retail seeds 1.0; ACE seeds MyRunRate (see divergence)
maxSpeed = RunAnimSpeed(4.0) * rate
if |velocity| > maxSpeed: normalize, *= maxSpeed
```

The SideStepRight `1.25 ×` here is a **separate stage** from the `1.248 ×` in `adjust_motion` — they are not redundant.

#### Constant table (all retail, ACE names them)

| Constant | Value | ACE ref |
|---|---|---|
| `WalkAnimSpeed` | `3.1199999f` (NOT 3.12 exactly) | `MotionInterp.cs:28-32` |
| `RunAnimSpeed` | `4.0f` | |
| `SidestepAnimSpeed` | `1.25f` | |
| `BackwardsFactor` | `0.64999998f` (NOT 0.65) | `MotionInterp.cs:26` |
| `RunTurnFactor` | `1.5f` | `MotionInterp.cs:27` |
| `SidestepFactor` | `0.5f` | |
| `MaxSidestepAnimRate` | `3.0f` | `MotionInterp.cs:27` |

The float-literal precision (`0.64999998`, `3.1199999`) matters for bit-exact A/B.

#### `motion_allows_jump`

`acclient.c:343295-343315`, ACE `MotionInterp.cs:770-779`. Returns `YouCantJumpFromThisPosition (0x48/72)` when the current substate falls in any reload/throw/magic-powerup/crouch-sit-sleep/aim/pray range or `== Falling (0x40000015)`; else `None`. Stored as `jump_error_code` on each queued `MotionNode` (`acclient.c:344002-344004`).

#### Wire pack bitfields

`RawMotionState::PackBitfield` (`acclient.h:46474-46488`) = **11 presence bits + 5-bit `num_actions`**:
`current_holdkey, current_style, forward_command, forward_holdkey, forward_speed, sidestep_command, sidestep_holdkey, sidestep_speed, turn_command, turn_holdkey, turn_speed`, then `num_actions:5`. `InterpretedMotionState::PackBitfield` (`acclient.h:46491-46500`) drops the 3 holdkey bits (7 presence bits + `num_actions:5`).

> **Do not conflate two same-named bitfields:** `MovementParameters.bitfield` is 18 flags (`can_walk` … `disable_jump_during_link`, `acclient.h:31423-31443`); the wire packer above is `PackBitfield`. The Rust `RawMotionFlags` mirrors only the 11 presence bits.

---

### Layer 2 — `MotionState`: stance, modifier stack, action queue

`MotionState` (`acclient.h:31081`, struct tag `/* 3275 */`, **24 bytes**), ctor at `acclient.c:341303`:

| Offset | Field | Type | Ctor init |
|---|---|---|---|
| 0 | `style` | u32 | 0 |
| 4 | `substate` | u32 | 0 |
| 8 | `substate_mod` | f32 | `1.0` (`0x3F800000`) |
| 12 | `modifier_head` | `MotionList*` | NULL |
| 16 | `action_head` | `MotionList*` | NULL |
| 20 | `action_tail` | `MotionList*` | NULL |

`MotionList` node (`acclient.h:31664`, tag `/* 3274 */`, **12 bytes**, `operator new(0xCu)`): `{ u32 motion @0; f32 speed_mod @4; MotionList* next @8 }`. ACE mirrors with `LinkedList<Motion>` and `Motion { uint ID; float SpeedMod }` (`MotionState.cs`, `Motion.cs`).

#### Modifiers are LIFO, actions are FIFO (opposite ordering — easy to conflate)

- **`add_modifier(m, s)`** (`acclient.c:341619`): dedupe two ways — return 0 if `m` already in the list, **and** return 0 if `this->substate == m` (the active base cycle already covers it). Otherwise `add_modifier_no_check`, which **prepends** (`new->next = modifier_head; modifier_head = new`, `acclient.c:341333-341334`). Newest modifier is head → overlays last. ACE `Modifiers.AddFirst` (`MotionState.cs:57`).
- **`add_action(a, s)`** (`acclient.c:341371`): 12-byte node `{a, s, next=0}`; if `action_head==NULL` set head; if `action_tail!=NULL` set `tail.next=node`; always `action_tail=node`. **Appends** (`acclient.c:341394-341397`). ACE `Actions.AddLast` (`MotionState.cs:38`). **This low-level `add_action` has NO count limit** — the 6-action cap lives in Layer 1.
- `remove_action_head` (`341420`), `clear_actions` (`341401`), `clear_modifiers` (`341353`), `remove_modifier` (`341338`).

#### 6-action cap (`TooManyActions`) lives in `CMotionInterp::DoMotion`, NOT `MotionState`

`acclient.c:344650`:
```c
if ( v6 & 0x10000000 /*Action*/ && InterpretedMotionState::GetNumActions(...) >= 6 )
    result = 69;   // WeenieError::TooManyActions (0x45)
```
ACE `MotionInterp.cs:147-151`; `WeenieError.TooManyActions = 0x45 = 69`. Gates only on Action-class commands. In non-NonCombat style, `DoMotion` also rejects Crouch/Sit/Sleep (63/64/65) and ChatEmote `0x02000000` (66) **before** the cap check.

`ActionNode` (HIGH layer, **20 bytes**, `operator new(0x14u)`, `acclient.c:332582`): `{ LListData* next @0; u32 action @4; f32 speed @8; u32 stamp @12; int autonomous @16 }`. The `stamp` + `autonomous` flag drive client-vs-server action ordering/reconciliation. ACE `ActionNode.cs:3-19`.

---

### Layer 3 — `CMotionTable::GetObjectSequence`: the resolver

`acclient.c:337641-337908`, ACE `MotionTable.cs:60-257`. Consumes `(motion, MotionState, sequence, speedMod, &numAnims, stopModifiers)`, rebuilds the `CSequence`, and mutates the `MotionState`.

#### Command-class dispatch order

Branches are tested in this **exact runtime precedence** (NOT numeric bit order — `Modifier 0x20000000` is tested **last** even though its bit sits numerically between SubState and Action):

| Order | Branch | Mask | Retail | ACE |
|---|---|---|---|---|
| 1 | Style | `0x80000000` | `337699` | `MotionTable.cs:76` |
| 2 | SubState | `0x40000000` | `337763` | `MotionTable.cs:121` |
| 3 | Action | `0x10000000` | `337842` | `MotionTable.cs:189` |
| 4 | Modifier | `0x20000000` | `337870` (`LABEL_80`) | `MotionTable.cs:234` |

> The mask **constants** are defined (in numeric order) at ACE `CommandMasks.cs:8-16` — `Style=0x80000000, SubState=0x40000000, Modifier=0x20000000, Action=0x10000000, UI=0x08000000, Toggle=0x04000000, ChatEmote=0x02000000, Mappable=0x01000000`. The **dispatch order** is encoded in `MotionTable.cs:76/121/189/234`, not in `CommandMasks.cs`. The four `if` blocks are **not mutually exclusive in code** — each falls through to the next if its cycle/link lookup fails — but every real retail command carries exactly one class bit.

#### Top-level early returns

```
numAnims = 0
if (style == 0 || substate == 0) return false
substate_default = StyleDefaults[style]
if (motion == substate_default && !stopModifiers && (substate & 0x20000000)) return true  // no-op while modified
```

#### Style branch (`0x80000000`) — stance change

`acclient.c:337699-337761`. If `style == motion` → true. Build pre-link OUT of current substate toward default; look up `cycles[(motion<<16) | (substate_default & 0xFFFFFF)]`. If that cycle's `bitfield & 1` → `clear_modifiers`. Link via `get_link`, with a **default_style relay** fallback if no direct link exists. `clear_physics + remove_cyclic_anims`, `add_motion` the chain, set `Substate=default, Style=motion, SubstateMod=speed`, then `re_modify`.

#### SubState branch (`0x40000000`) — locomotion cycle swap

`acclient.c:337763-337841`. `motionData = cycles[(Style<<16)|(motion & 0xFFFFFF)]` (fallback `DefaultStyle`). Gate on `is_allowed`. **Same-cycle fast path:** if `motion == Substate && seq.HasAnims() && sign(speedMod)==sign(SubstateMod)` → `change_cycle_speed + subtract_motion + combine_motion`, update `SubstateMod`, return (in-place speed change, no clip swap). Otherwise: if `bitfield & 1` → `clear_modifiers`; build link(s) with relay-via-`StyleDefaults[Style]` fallback on null/sign-mismatch; **if the OUTGOING substate was itself Modifier-class** (`old Substate & 0x20000000 && old != motion && != style default`) → `add_modifier_no_check(old Substate, SubstateMod)` (`337814-337822`). This pushback preserves a held aim/cast pose across a base-cycle change. Then `SubstateMod=speed, Substate=motion, re_modify`.

#### Action branch (`0x10000000`) — one-shot over current cycle

`acclient.c:337842-337908`. `cycle = cycles[(Style<<16)|(Substate & 0xFFFFFF)]` (resumes after the action). If a link exists: `add_action(motion, speed)`, `clear_physics + remove_cyclic_anims`, `add_motion(link@speed) + add_motion(cycle@SubstateMod)`, `re_modify`. Otherwise relay through `StyleDefaults[Style]`.

#### Modifier branch (`0x20000000`) — persistent velocity/omega overlay (no anim)

`acclient.c:337870-337892`. **Gated off if the current cycle has `bitfield & 1` set** (`337876` / ACE `MotionTable.cs:238`) — a cycle that clears modifiers also refuses new ones. `motionData = modifiers[(Style<<16)|(motion & 0xFFFFFF)]` (fallback bare `modifiers[motion & 0xFFFFFF]`). `add_modifier` (with `StopSequenceMotion` retry on duplicate), then `combine_motion(motionData, speed)` — adds `Velocity*speed + Omega*speed`, **NO animation**.

#### `get_link` — the link-chain primitive (speed-sign-dependent key roles)

`acclient.c:337585-337638`, ACE `MotionTable.cs:395-426`. **Forward** (speed ≥ 0): `Links[(style<<16)|(substate & 0xFFFFFF)][motion]`, fallback `Links[style<<16][motion]`. **Reverse** (`speed < 0` or `substateSpeed < 0`): the substate↔motion roles **swap** — `Links[(style<<16)|(motion & 0xFFFFFF)][substate]`. A naive port that ignores the speed sign will mis-resolve reverse-playback transitions. The **inner key is the FULL 32-bit destination command**, never masked.

#### `is_allowed` — `bitfield & 2` gate

`acclient.c:337560-337582`, ACE `MotionTable.cs:428-438`. If `(bitfield & 2)==0 || motion == state.Substate` → allowed. Else allowed iff `StyleDefaults[state.Style] == state.Substate` (bit1 cycles are only enterable from the style default substate, or re-entering themselves).

#### `re_modify` — re-overlay surviving modifiers after every rebuild

`acclient.c:337286-337316`, ACE `MotionTable.cs:440-458`. Clones `MotionState` into a dummy; while dummy modifiers remain, pop the head from **both** the real state and the dummy and re-call `GetObjectSequence(motion, …, Modifier-route)` to re-`combine_motion` each overlay onto the freshly-rebuilt sequence. **This is why hold-run angular velocity and the casting/aim pose survive a walk→run swap.** Without it, held overlays vanish on the next cycle swap.

#### `SetDefaultState` / `StopSequenceMotion` / `StopObjectCompletely`

- `SetDefaultState` (`337970-338022`): `clear_modifiers + clear_actions`; resolve `cycles[(DefaultStyle<<16)|(StyleDefaults[DefaultStyle] & 0xFFFFFF)]`; set state to default, `SubstateMod=1.0`; `clear_physics + clear_animations` (**full wipe — NOT `remove_cyclic_anims`**), `add_motion(cycle)`. Different reset semantics from the `GetObjectSequence` branches.
- `StopSequenceMotion` (`337912-337967`): if SubState-class && `motion == Substate` → re-issue style-default cycle with `stopModifiers=true`; if Modifier-class → find the node, `subtract_motion` its data, `remove_modifier`.
- `StopObjectCompletely` (`339029`): `StopSequenceMotion` every modifier, then the substate.

---

### On-disk `CMotionTable` wire format

`CMotionTable` (`acclient.h:31654-31661`, tag `/* 3273 */`) has exactly **5 retail members** (ACE/holtburger add a non-retail `id`/`ID`):

| Member | Type | Key |
|---|---|---|
| `style_defaults` | `Dict<u32 style, u32 substate>` | style |
| `cycles` | `Dict<u32, MotionData>` | `(style<<16) \| (substate & 0xFFFFFF)` |
| `modifiers` | `Dict<u32, MotionData>` | `(style<<16) \| low` (fallback bare `low`) |
| `links` | `Dict<u32 outer, Dict<u32 inner, MotionData>>` | outer `(style<<16)\|from`; **inner = full 32-bit dest cmd** |
| `default_style` | u32 | — |

ACE `MotionTable.cs:16-21`, holtburger `motion_table.rs:11-46`. Chorizite `CMotionTable.cs:41-45` corroborates as a 4th source.

#### Parse order (`MotionData::UnPack`, `acclient.c:341814-341882`)

`id u32; default_style u32; numStyleDefaults u32` + that many `(u32 key, u32 val)` pairs; then `cycles` and `modifiers` each as `PackedHashTable<MotionData>` (`u16 totalObjects, u16 bucketSize`, then per-entry `key u32 + MotionData`); then `links` = `u32 count` + per outer `(key u32 + nested PackedHashTable<MotionData>)`.

> **Retail `MotionData::UnPack` reads a leading 4-byte `id` (the dictionary KEY) FIRST**, before `numAnims/bitfield/flags` (`acclient.c:341839`). ACE/MELT/holtburger read that key in the **container loop** instead, so the byte stream is equivalent — but the retail `UnPack` body does not start with `numAnims`. Also: the Hex-Rays struct offsets (`*(_BYTE*)(md+48)&1` for bitfield, `+16` for num_anims) are **in-memory C++ offsets, NOT wire offsets** — trust the `UnPack` body order, not the `GetObjectSequence` offset arithmetic.

#### `MotionData` wire layout (after the key)

| Field | Type | Notes |
|---|---|---|
| `numAnims` | u8 | |
| `bitfield` | u8 | **bit0 (`&1`) = clears_modifiers; bit1 (`&2`) = is_allowed gate** |
| `flags` | u8 | `0x01 HAS_VELOCITY`, `0x02 HAS_OMEGA` |
| align | pad to 4 | |
| `anims` | `AnimData[numAnims]` | 20 B each |
| `velocity` | `Vector3` (12 B) | if `HAS_VELOCITY` |
| `omega` | `Vector3` (12 B) | if `HAS_OMEGA` |

`AnimData` (**20 bytes**): `anim_id u32` (DAT DID `0x03xxxxxx`); `low_frame i32`; `high_frame i32` (**-1 = play to end of asset**); `framerate f32` (**negative = reverse playback**). ACE/MELT/holtburger `motion_table.rs:160-225` are bit-compatible; holtburger sweep-validated 1:1 vs C# `DatReaderWriter` on `0x09000202` and the full `0x0900xxxx` range.

`bitfield` is **two independent bits in one u8**: 50/436 real tables (11.5%) set bit0. The two bits gate distinct behaviors (clear-modifiers-on-entry vs is_allowed style-restriction).

---

### Cross-source divergences (canonical = retail/ACE)

| Divergence | Canonical | Detail |
|---|---|---|
| **Substate/cycle key mask width** | `0x00FFFFFF` (24-bit) | MELT (`MotionTable.cs:71,134`) and holtburger (`motion_table.rs:8,228` `MOTION_KEY_MASK=0x000F_FFFF`) use **20-bit**. **Latent/harmless** — max real low-24 command = `0x19b` (verified across all 409 entries of `data/motion-command-names.json`). Both MELT and holtburger are **internally inconsistent**: MELT uses `0xFFFFFF` at `MotionTable.cs:199`; holtburger's idle path `lib.rs:5225` correctly uses `0x00FF_FFFF`. |
| **ACE Action-branch `numAnims`** | retail `acclient.c:337906-337907` (sums `motionData_` count) | ACE `MotionTable.cs:227` references `motionData.Anims.Count` (wrong variable). **Confirmed minor ACE bug** — affects only the returned anim count / pending-anim truncation timing, not clip selection. |
| **`get_state_velocity` no-weenie rate** | retail seeds `1.0` (`acclient.c:343584`) | ACE seeds `MyRunRate` (`MotionInterp.cs:689`). Only matters for weenie-less physics objects; for players `InqRunRate` always wins → observationally equivalent. |
| **Chorizite** | N/A | Carries the `MotionState`/`CMotionTable` struct mirrors + **native function-pointer thunks** into retail addresses (`Movement.cs:839-858`, e.g. `0x00523400`; `enum_Call.cs` lists `DoObjectMotion 0x0051CC82`, `SetDefaultState 0x0051CB8D`, `StopSequenceMotion 0x00523B16`). **Not a reimplementation** — offset/in-process-hook reference only. |
| **MELT** | N/A | DAT parser + geometry helpers (`GetAnimationLength`, `GetAttackFrames`, `GetAnimationFinalPositionFromStart`) only. No `MotionState`/`add_modifier`/action-queue runtime. |

On-disk `MotionTable` + `MotionData` + `AnimData` wire format and the command-class constants are in full agreement across all four sources.

---

### holtburger current state — `partial` (parse-complete, lookup-divergent by design)

**What exists (DAT parse — full parity):**
- Rust parser `crates/holtburger-dat/src/file_type/motion_table.rs:11-229` — `id/default_style/style_defaults/cycles/modifiers/links` + per-`MotionData` raw `u8 bitfield`/`num_anims`. Sweep-validated against C# `DatReaderWriter` (`motion_table.rs:393-565`).
- `motion_data_for_cycle` — `cycle_key = (stance & 0xFFFF)<<16 | (cmd & 0x000F_FFFF)` (`motion_table.rs:227-229`).
- `motion_data_for_link` — outer `cycle_key`, **inner FULL 32-bit `to_cmd`** (`motion_table.rs:101-109`; the W2.E fix corrected an earlier inner-mask bug that silently failed every retail link).
- wasm swing/cast resolver `lookupMotionLinkForSwing` / `classify_motion_link_for_swing` (`apps/holtburger-web/src/lib.rs:5006-5049`) walks `links[(stance, Ready=0x41000003)][full-cmd]`; bypasses the helper with raw `.get(&command)` (`lib.rs:5018`). 52/52 JS-vs-C# swing parity (asserted in-code, not re-derived in review).
- idle resolver `try_resolve_idle_anim_frame` (`lib.rs:5212-5226`) builds `(default_style<<16)|(idle_substate & 0x00FF_FFFF)` — mirrors `SetDefaultState`'s cycle lookup, correctly using 24-bit.

**What exists (Rust local-prediction — faithful Layer-1 speed model):**
`crates/holtburger-core/src/client/movement/common.rs` reimplements Raw→Interpreted for the **outbound wire packet + local prediction** with correct constants: `BACKWARDS_FACTOR=0.649_999_98` (`common.rs:588`), `SIDESTEP_RUN_SPEED_CAP=3.0` (`common.rs:571`), `RUN_HELD_TURN_SPEED=1.5` (`common.rs:57`); Walk→Run promotion (`forward_command_for_state` `common.rs:175-185`), Left→Right collapse with negated speed (`common.rs:209-234`), diagonal velocity composition (`local_velocity_for_state` `common.rs:619-691`). The `holtburger-protocol` `RawMotionFlags` (`messages/movement/types.rs:47-60`) matches the retail 11 presence bits bit-for-bit (`num_actions` carried separately, not in the bitflags enum).

**What exists (JS renderer — coarse classifier):**
`apps/holtburger-web/scene3d/entities.js`:
- `classifyMotionCommand(cmd)` (`L854-912`) — flat low-16 → 6-way string bucket (`stop/walk/run/idle/attack/cast`), keyed on `cmd & 0xffff` + an explicit command set, **NOT** the top-4 class bits.
- `setMotion(guid, cmd, stance, speed)` (`L4358+`) — `Stop(0x0004)/Invalid(0x0000) → Ready(0x0003)` (keep combat pose on release, `L4379`); `TurnLeft → TurnRight`, `SideStepLeft → SideStepRight` **command-level mirror only, no speed negate** (`L4397-4403`); `stance=0 → keep lastStance`; walk/run → `AnimationCache.makeKey(setup, mtable, cmd, stance)` crossFade; attack/cast → `_tryPlayLink` LoopOnce overlay from Ready.
- `cycleTimeScale = |actualSpeed| / baseSpeed` (`animation.js:241`) is the `get_state_velocity` Framerate analog, **but gated behind `?velScale=on`, default OFF** (`VEL_SCALE_ON`, `entities.js:305-319`). Default path applies the bare server `forward_speed` scalar via `setEffectiveTimeScale(_motionSpeed)` (`entities.js:4672-4677`).

> Repo path note: in this checkout the above live under `external/holtburger/` (e.g. `external/holtburger/apps/holtburger-web/scene3d/entities.js`).

**Gaps (no Layer-2/Layer-3 state machine):**
- No `MotionState` (`Style/Substate/SubstateMod/Modifiers/Actions`), no `modifier_head` LIFO list, no `action_head/action_tail` FIFO queue, no `re_modify`, no `clear_modifiers/clear_actions`, no `add_modifier/add_action`, no `StopSequenceMotion`, no full `SetDefaultState`.
- No `is_allowed` (`bitfield & 2`) gate; no `bitfield & 1` clear-modifiers-on-entry. `bitfield` is parsed as raw `u8` and **read only in a sweep test** (`motion_table.rs:517`), never for behavior.
- No four-clip link-chain composition, no default_style relay, no `combine_motion/subtract_motion/change_cycle_speed`.
- No 6-action `TooManyActions` cap, no `motion_allows_jump`/`contact_allows_move`/`MyRunRate` cache/`pending_motions` queue (server-side / wasm).
- JS renderer has no `RawMotionState`/`InterpretedMotionState`, no `RunTurnFactor`/`SidestepFactor`/`run_factor` speed-magnitude pipeline — it relies entirely on the server/wasm having pre-resolved `RunForward` vs `WalkForward` + a `forward_speed` scalar. The substate-modifier pushback (`337814-337822`) is absent.
- Modifier velocity/omega ("Path B") deferred by design (`motion_table.rs:16-43`); the smooth-turn visual shipped instead as "Path A" bounded heading interpolation on remote entities in `entities.js`.

**Parity verdict:** PARSE = full parity (validated). LOOKUP/RUNTIME = partial, divergent **by design** — server is position-authoritative, so holtburger renders one best-effort cycle + optional one-shot link overlay rather than reconstructing the full retail `CSequence`. Adequate for a server-broadcast-driven browser client; will diverge under rapid action queueing, held-modifier-through-cycle-swap, or stance-change-clears-modifiers edge cases. The Three.js mixer's concurrent-weight overlay approximates cycle+overlay visually, but is not the `MotionState` contract.

---

### Gotchas

- **Magic-number decode** (retail uses raw decimals): `0x44000007` RunForward, `0x45000005` WalkForward, `0x45000006` WalkBackwards, `0x6500000D` TurnRight, `0x6500000E` TurnLeft, `0x6500000F` SideStepRight, `0x65000010` SideStepLeft, `0x40000015` Falling, `0x41000003` Ready. Misreading inverts the whole mapping.
- **Modifier branch tested LAST** (`0x20000000`), out of numeric bit order.
- **Modifiers LIFO / actions FIFO** — opposite ordering.
- **6-action cap is Layer-1 (`DoMotion`), not `MotionState`** — the low-level `add_action` is unbounded.
- **SideStepRight has two separate scale stages**: `1.248 ×` in `adjust_motion`, then `1.25 ×` on X in `get_state_velocity`.
- **`BackwardsFactor = 0.64999998`, `WalkAnimSpeed = 3.1199999`** — float precision is load-bearing for A/B.
- **No RunBackward**: backstep negates speed before the `speed>0` promotion gate, so it stays `WalkForward`.
- **`adjust_motion` early-returns for non-creatures** — items/projectiles keep raw cmd+speed.
- **`get_link` reverse vs forward swap the substate↔motion key roles** — must honor speed sign.
- **Modifier branch refuses to apply if the current cycle has `bitfield & 1`** — a clear-modifiers cycle also blocks new modifiers.
- **`SetDefaultState` calls `clear_animations` (full wipe)**, all `GetObjectSequence` branches call `remove_cyclic_anims` (keep one-shots).
- **holtburger's anti-ice-skate (`velScale`) is DEFAULT OFF** — anyone assessing "does holtburger anti-ice-skate?" must check `VEL_SCALE_ON` or they get the wrong answer; the default path plays cycles at the bare server `forward_speed` scalar (backpedal/encumbrance/run-skill foot-speed can desync).
- **holtburger `Stop(0x0004)/Invalid → Ready(0x0003)` is a renderer convenience** (`entities.js:4379`), not a retail mechanism — retail handles Stop at the `StopObjectMotion`/`StopObjectCompletely` level.
- **MELT/holtburger convenience accessors** (`GetAnimData`, `GetCycleLength`, `movement_profile_for_stance`) approximate a single cycle/link lookup; they are **not** `GetObjectSequence` and skip the `MotionState` chain, default-style relay, and `re_modify`.

### Recommended follow-ups (low-risk first)

1. **Fix the latent mask footgun:** change `MOTION_KEY_MASK` (`motion_table.rs:8`) from `0x000F_FFFF` → `0x00FF_FFFF` to match retail/ACE and holtburger's own idle path. Harmless today (max real low-24 = `0x19b`).
2. Add `MotionData::clears_modifiers() { bitfield & 1 != 0 }` and `is_allowed_gate() { bitfield & 2 != 0 }` accessors.
3. Trace wasm `TickMovement` to confirm whether `UpdateMotion.motionSpeed` is the raw `0..1` `ForwardSpeed` or the already-scaled `get_state_velocity` magnitude — decides whether `setEffectiveTimeScale(_motionSpeed)` default is dimensionally meaningful.
4. If full client fidelity is ever wanted: port `GetObjectSequence` + `MotionState` + `re_modify` + `get_link` + `is_allowed` + add/clear-modifier + `StopSequenceMotion` + `SetDefaultState` from ACE `MotionTable.cs` (cleanest canonical managed reference), keyed on a per-entity `MotionState`, reconciled against server position. Weigh against the already-shipped Path-A heading interpolation; the Modifiers deferral is documented as low-payoff/high-risk.

---

## Animation Data, Skeleton & Playback

This section specifies how Achaea-Content-Engine (AC) animation data is laid out on disk, how the multi-part rig is composed, and how a cycle is played back — with the holtburger-web implementation state and parity gaps called out at each layer. Three independent sources corroborate every load-bearing fact: **RETAIL** (`ac-headers/acclient.c` + `acclient.h` decomp), **ACE/MELT** (`external/melt` and `external/ACE` C# ports), and **holtburger** (`crates/holtburger-dat` + `apps/holtburger-web`). Where they diverge, the canonical source is marked.

### The three-layer data model

| Layer | DAT type | Role | Indexed by |
|---|---|---|---|
| SetupModel | `0x02` | Multi-part object descriptor: part DID array + physics/anim defaults + rest poses | part index `i` ↔ GfxObj `0x01` DID |
| Animation | `0x03` | Flat keyframe array: per-part absolute model-space `Frame`s + per-frame hooks | `floor(frame_number)` |
| MotionTable | `0x09` | `AnimData` segments (anim_id, low/high frame, framerate) that slice + sequence `0x03` files | — |

**The single most important behavioral fact:** AC part frames are **NOT a parent-relative bone tree at render time**. `AnimationFrame.frames[i]` stores the *absolute model-space* frame of part `i` — the animator already baked any hierarchy into each keyframe. Building a Three.js bone tree from `parent_index[]` would **double-apply** parent transforms and break every multi-part model. `parent_index[]` is attachment/ordering metadata only.

### SetupModel (0x02) — skeleton & part array

**Wire UnPack order (canonical: `RETAIL acclient.c:335521` `CSetup::UnPack`; byte-identical in `MELT SetupModel.cs:46-106` and `holtburger setup_model.rs:331-449`).** Read all little-endian, in exactly this sequence:

| # | Field | Gate | Notes |
|---|---|---|---|
| 1 | `u32 Id` | — | |
| 2 | `u32 Flags` | — | bitfield, see below |
| 3 | `u32 numParts` | — | |
| 4 | `numParts × u32 parts[]` | — | each is a `0x01`-prefixed GfxObj DID |
| 5 | `numParts × u32 parent_index[]` | `Flags & 0x1` | metadata only — never used for transform composition |
| 6 | `numParts × Vector3 default_scale[]` | `Flags & 0x2` | 12 B each |
| 7 | `HoldingLocations` | — | `u32 cnt`, then `cnt × {i32 key, LocationType}` |
| 8 | `ConnectionPoints` | — | same shape as 7 |
| 9 | `PlacementFrames` | — | **`i32 cnt`** (signed), then `cnt × {i32 key, PlacementType}` |
| 10 | `CylSpheres` | — | `u32 cnt`, then `cnt × CylSphere(28 B)` |
| 11 | `Spheres` | — | `u32 cnt`, then `cnt × Sphere(16 B)` |
| 12 | `f32 Height` | — | |
| 13 | `f32 Radius` | — | |
| 14 | `f32 StepUpHeight` | — | **before** StepDown on the wire |
| 15 | `f32 StepDownHeight` | — | |
| 16 | `Sphere SortingSphere(16 B)` | — | |
| 17 | `Sphere SelectionSphere(16 B)` | — | |
| 18 | `Lights` | — | `u32 cnt`, then `cnt × {i32 key, LightInfo}` |
| 19 | 5× `u32` default DIDs | — | DefaultAnimation, DefaultScript, DefaultMotionTable, DefaultSoundTable, DefaultScriptTable |

`SetupFlags` (`MELT SetupFlags.cs:8-11`, confirmed by retail bit-extracts at `acclient.c:335629-335684`):

| Bit | Name | Retail extract | Effect |
|---|---|---|---|
| `0x1` | HasParent | `flags & 1` (`335667`) | gates `parent_index[]` presence |
| `0x2` | HasDefaultScale | `flags & 2` (`335684`) | gates `default_scale[]` presence |
| `0x4` | AllowFreeHeading | `(flags>>2)&1` (`335629`) | object may rotate freely about Z |
| `0x8` | HasPhysicsBSP | `(flags>>3)&1` (`335630`) | object carries a physics BSP for collision |

**Gotcha — wire order ≠ in-memory struct order.** The in-memory `CSetup` (`acclient.h:31119`, field-for-field identical to `CHORIZITE CSetup.cs:40-67`) declares `num_cylsphere/cylsphere/num_sphere/sphere/has_physics_bsp/allow_free_heading/height/radius/step_down_height/step_up_height` *before* the spheres/lights/holding tables, and declares `step_down_height` **before** `step_up_height` (`acclient.h:31133-31134`). Trust the wire order in the parsers, not the struct declaration. Step heights are read up-then-down on the wire.

**Flat part composition (canonical: `RETAIL acclient.c:326601` `CPartArray::UpdateParts`).** The render-time composition loop is:

```
for i in 0..min(num_parts, animframe.num_parts):
    Frame::combine(parts[i].pos.frame, object_frame, animframe.frame[i], scale)
```

i.e. `part_world = object_frame ⊗ animframe.frame[i] ⊗ scale`, **per part, independently**. The verifier confirmed the function body (`326601-326632`) contains zero `parent_index` references and no parent accumulation. `Frame::combine` signature is `(out, object_frame, AFrame, scale)` (`acclient.c:6635`).

**LocationType / ParentLocation (holding & connection entries, 32 B):** `i32 part_id (4 B)` + `Frame frame (28 B)`. The `i32` key is a `ParentLocation` enum: `None=0, RightHand=1, LeftHand=2, Shield=3, Belt=4, Quiver=5, Hearldry=6, Mouth=7, LeftWeapon=8, LeftUnarmed=9`. Retail looks these up via `CSetup::GetHoldingLocation` (`acclient.c:336114`) when wielding.

**PlacementType / Placement:** each `PlacementType` is a full `AnimationFrame` (one `Frame` per setup part + a hook list). Keys are the `Placement` enum (`MELT Placement.cs:6-32`): `Default=0, RightHandCombat=1, RightHandNonCombat=2, LeftHand=3, Belt=4, Quiver=5, Shield=6, LeftWeapon=7, LeftUnarmed=8, SpecialCrossbowBolt=51, MissileFlight=52, Resting=101, Other=102, Hook=103, Random1..10=121..130`. ACE sets `HasMissileFlightPlacement` when key `== 52` (`SetupModel.cs:83-84`).

### Animation (0x03) — file format & keyframes

**On-disk header is exactly 16 bytes** — four LE `u32` in order (`MELT Animation.cs:24-27`, `holtburger animation.rs:27-30`):

```
[u32 Id][u32 Flags][u32 NumParts][u32 NumFrames]
```

Only `Flags & 0x1 = POS_FRAMES` is defined (`AnimationFlags.cs:8`). Body, in order:

1. **IF `Flags & 0x1`:** `NumFrames × Frame` → `PosFrames` (root / whole-object motion, one per keyframe). Read **before** PartFrames.
2. **Unconditionally:** `NumFrames × AnimationFrame` → `PartFrames`.

No trailing padding at the Animation level.

**Frame / AFrame is 28 bytes — 7 contiguous `f32`, quaternion W-FIRST:**

| Offset | Field |
|---|---|
| 0 | `f32 origin.x` |
| 4 | `f32 origin.y` |
| 8 | `f32 origin.z` |
| 12 | `f32 qw` |
| 16 | `f32 qx` |
| 20 | `f32 qy` |
| 24 | `f32 qz` |

`RETAIL AFrame::UnPack` (`acclient.c:467619-467650`) reads `m_fOrigin.{x,y,z}` then `qw,qx,qy,qz` (`acclient.h:31631-31635`). `MELT Frame.cs:41-45` reads `qw,qx,qy,qz` then constructs `Quaternion(qx,qy,qz,qw)`. `holtburger-common` declares `Quaternion {w,x,y,z}` with `binrw` (`math.rs:120-125`) so disk order == field order.

**AnimationFrame (variable length):** `NumParts × Frame (28 B each)` then `u32 numHooks` then `numHooks × AnimationHook`. `frames[i]` is indexed **positionally** by `SetupModel.parts[i]` — the animation file does not name parts. `Animation.NumParts` **must equal** `SetupModel.parts.len()`; a mismatch silently mis-rigs parts.

**AnimationHook (variable length):** `u32 hookType; i32 direction;` then a per-type payload, then **0–3 bytes of `ALIGN_PTR` padding to a 4-byte boundary**. Payload sizes (holtburger's 27-case switch, types `0..=26`, `setup_model.rs:58-130`):

| Type | Name | Payload | | Type | Name | Payload |
|---|---|---|---|---|---|---|
| 0 | NoOp | 0 | | 13 | CreateParticle | 40 |
| 1 | Sound | 4 | | 14 | DestroyParticle | 4 |
| 2 | SoundTable | 4 | | 15 | StopParticle | 4 |
| 3 | Attack | 28 | | 16 | NoDraw | 4 |
| 4 | AnimationDone | 0 | | 17 | DefaultScriptPart | 4 |
| 5 | ReplaceObject | variable | | 18 | CallPES | 8 |
| 6 | Ethereal | 4 | | 19 | Transparent | 12 |
| 7 | TransparentPart | 16 | | 20 | SoundTweaked | 16 |
| 8 | Luminous | 12 | | 21 | SetOmega | 12 |
| 9 | LuminousPart | 16 | | 22 | TextureVelocity | 8 |
| 10 | Diffuse | 12 | | 23 | TextureVelocityPart | 12 |
| 11 | DiffusePart | 16 | | 24 | SetLight | 4 |
| 12 | Scale | 8 | | 25 | CreateBlockingParticle | 40 |
| | DefaultScript / NoOp | 0 | | 26 | ReplaceObject(ext) | 1-byte part_index + packed DID |

Only `ReplaceObject` (3 or 5 payload bytes) actually triggers the align-pad in practice; **skipping the pad desyncs all following hooks in that frame**.

**`has_hooks` is NOT in the DAT.** The in-memory `CAnimation` (`acclient.h:31623`) carries an `int has_hooks`, but the file header only has the `POS_FRAMES` bit. ACE's runtime physics `Animation.cs:20` sets `HasHooks = false; // comes from bitfield?` (verbatim, verifier-confirmed). Hooks are discovered per-frame via each `AnimationFrame`'s `u32 numHooks`, not a global flag.

### MotionTable AnimData — frame windowing & sequencing

`AnimData` is 16 bytes (`acclient.h:52536-52542`, `motion_table.rs:201-216`), identical field order/types across all sources:

```
anim_id: u32 @0; low_frame: i32 @4; high_frame: i32 @8; framerate: f32 @12
```

Defaults: `low_frame=0, high_frame=-1` (play to end), `framerate=30.0f` (`0x41F00000`, `acclient.c:341040`).

Frame-window semantics (canonical: `RETAIL` `get_starting_frame`/`get_ending_frame` at `acclient.c:341016-341037`):

- `high_frame` is **INCLUSIVE**; `high_frame < 0` means "to the last frame."
- `framerate < 0` is **reverse playback** — there is no separate reverse flag. `get_starting_frame` returns `high_frame + 1 - 0.0002` (the top of the window) when `framerate < 0`, else `low_frame`; `get_ending_frame` is the inverse. The eps offset makes `floor()` land on `high_frame`, never `high_frame+1`. `multiply_framerate(<0)` (`acclient.c:340968`) swaps `low/high` **and** negates the rate.
- ~22% of retail `AnimData` segments are negative-framerate; ignoring the sign plays transitions/flourishes backward.
- Per-frame `dt = 1/|framerate|`.

holtburger's bake computes the inclusive slice as `low = low_frame.max(0)..min(total)`, `high = total if high_frame < 0 else (high_frame+1).min(total)` (`lib.rs:4822-4825`), and reverses with `(low..high).rev()` when `framerate < 0` (`lib.rs:4844, 4860-4866`) — exactly matching `get_ending_frame`'s `HighFrame+1` semantics. Multiple `AnimData` segments are concatenated end-to-end with cumulative absolute per-frame times.

### CSequence playback (retail/ACE runtime model)

holtburger does **not** simulate CSequence at runtime (it bakes — see below), but the runtime model defines correct behavior. Canonical: `RETAIL acclient.c`, faithfully ported in `ACE Sequence.cs / AnimSequenceNode.cs`.

**CSequence struct** (`acclient.h:30747-30759`, `ACE Sequence.cs:13-23`): doubly-linked `anim_list` of `AnimSequenceNode`, `AnimSequenceNode* first_cyclic`, `Vector3 velocity`, `Vector3 omega`, `CPhysicsObj* hook_obj`, `double frame_number`, `AnimSequenceNode* curr_anim`, `AnimFrame* placement_frame`, `uint placement_frame_id`, `int bIsTrivial`.

**`AnimSequenceNode`** (`acclient.h:31063-31069`, 0x1C/28 B incl. DLListData base): `{CAnimation* anim; float framerate; int low_frame; int high_frame}`.

> **Decompiler-mislabel trap:** `acclient.c` symbol names lie here. `MD_Data_Fade::GetDuration` actually returns `AnimSequenceNode.framerate`; `AnimSequenceNode::get_high_frame` casts to `ChatRoomTracker` and reads `mOlthoiChatRoomID` (same offset = the `high_frame` field). Trust offsets/struct layout, not symbol names.

**`update_internal(quantum)` frame advance** (`acclient.c:340659`, `ACE Sequence.cs:351-443`):

1. `framerate = curr_anim.framerate; frame_quantum = framerate * quantum; v6 = floor(frame_number); frame_number += frame_quantum`.
2. **Forward (`frame_quantum > 0`):** if `floor(frame_number) > high_frame`, compute leftover `time_left = (frame_number - high_frame - 1.0)/framerate` (clamped ≥0; 0 if `|framerate| ≤ 0.0002`), set `advance_anim=1`, clamp `frame_number = high_frame`. Then `for(; floor(frame_number) > v6; ++v6)`: if `pos_frames` present, `Frame::combine(retval, get_pos_frame(v6))`; if `|framerate| > 0.0002`, `apply_physics(retval, 1.0/framerate, quantum)`; `execute_hooks(get_part_frame(v6), dir=1)`.
3. **Reverse (`frame_quantum < 0`, `acclient.c:340730-340760`):** symmetric — `for(; floor(frame_number) < v6; --v6)`: `Frame::subtract1(retval, get_pos_frame(v6))`; `apply_physics(...)`; `execute_hooks(get_part_frame(v6), dir=-1)`.
4. On overflow: if a link node just finished (first list node `!= first_cyclic`) add `anim_done_hook`; `advance_to_next_animation(...)`; recurse with `quantum = time_left`.

**Frame extraction is strictly DISCRETE.** `get_curr_frame_number` = `(unsigned __int64)floor(frame_number)` (`acclient.c:339774`); `get_curr_animframe` (`acclient.c:339745`) returns `get_part_frame(floor(frame_number))` (bounds-checked, direct index, **no lerp**) or the static `placement_frame` when `curr_anim == null`. **Retail NEVER interpolates between authored keys.**

**`advance_to_next_animation` & multi-segment chaining** (`acclient.c:340473`, `ACE Sequence.cs:145-201`): on forward, `curr_anim = Next`, or if `Next == null` **wrap to `first_cyclic`** (the loop point); `frame_number = new node's get_starting_frame()`; entering pos_frames are combined. `first_cyclic` is set to the **last appended node** (`acclient.c:340624`, `ACE Sequence.cs:209` `FirstCyclic = AnimList.Last`) — it is the boundary between one-shot link/transition anims (`apricot()` removes them once passed, `acclient.c:339893`) and the repeating cycle.

**`apply_physics` — velocity/omega accumulation** (`acclient.c:339860`, `ACE Sequence.cs:221-230`): `q = ±fabs(quantum); frame.Origin += velocity*q; Frame::rotate(frame, omega*q)`. These accumulators come from `MotionData.velocity/omega` (`HAS_VELOCITY 0x1 / HAS_OMEGA 0x2` flags). **They translate/rotate the OBJECT frame** (world position) during physics — distinct from `pos_frames`, which is Animation root motion baked into local part positions. Called once per integer frame at `quantum = 1/framerate`, so total displacement over the window = `velocity * (window_frames/framerate)`.

**EPSILON:** retail uses literal `0.00019999999` in `|framerate|` divide guards (`acclient.c:340705/340722/340738`); ACE `PhysicsGlobals.EPSILON = 0.0002f` (`PhysicsGlobals.cs:9`) equals it. *(Verifier correction: the ACE field is named `EPSILON`, not `n`.)* `get_ending_frame`/`get_starting_frame` use `HighFrame + 1 - 0.0002` so `floor()` lands on `HighFrame`.

### holtburger pipeline: bake → flat buffer → THREE.AnimationClip

holtburger replaces runtime CSequence with a **Rust-side bake** consumed by a `THREE.AnimationClip`.

**Bake (`build_concatenated_motion_frames`, `src/lib.rs:4780`):** iterates `motion_data.anims`; per segment filters `anim_id >> 24 == 0x03`, loads the Animation, applies the inclusive slice + reverse logic above, appends `part_frames` (and `pos_frames` root motion if `POS_FRAMES len == total`, else zeros — guard via `has_pos = anim.pos_frames.len() == total`), and stamps cumulative absolute time per frame. Returns `(frames, frame_times, pos_frames, total_duration)`.

**Flatten (`build_entity_animation_data_inner_v2`, `src/lib.rs:13560-13737`):** emits a frame-major `numFrames * partCount * 7` f32 buffer, `[x, y, z, qw, qx, qy, qz]` per part (W-first, byte-faithful to the DAT), at index `(frame*part_count + pi)*7`. Missing parts pad with identity `[0,0,0,1,0,0,0]`. Side channels: `rest_origins (partCount*3)`, `rest_orientations (partCount*4, w-first)`, `frame_times`, `duration`, sorted hook timeline.

**wasm getters** (`EntityAnimationData`, `lib.rs:13261-13428`): `partCount, numFrames, framerate (= numFrames/duration, AVERAGED), frameTimes, duration, posFrames, restOrigins/restOrientations, hooks`.

**Clip build (`buildAnimationClip`, `scene3d/animation.js:63-214`):** validates `length == numFrames*partCount*7`; per part builds a `VectorKeyframeTrack` (`position = part origin + posFrames[f*3..]` root motion) and a `QuaternionKeyframeTrack` with the quaternion **reordered W-first → xyzw** (`quatValues = [qx,qy,qz,qw]`, reading `qw=base+3..qz=base+6`, `animation.js:164-171`). **Both tracks use `THREE.InterpolateDiscrete`** (`animation.js:189,197`) — this is the load-bearing parity choice reproducing retail's `floor(frame_number)` snap. The verifier confirmed `animation.js` contains *only* `InterpolateDiscrete` (no Linear/Smooth path exists); without it, three.js default SLERP would invent poses the animators never authored ("rig decoherence").

**Rest-pose apply (`scene3d/entities.js:1981-2038`):** builds one `THREE.Group` per part, applies `rest_poses` to `partGroup.position`/`partGroup.quaternion` (reordering wire `w,x,y,z` → three.js `x,y,z,w` at `:2001-2005`), and `root.add(partGroup)` for **every** part — flat, matching `CPartArray::UpdateParts`. The rig walker `walk_setup_parts` (`lib.rs:4276-4395`) resolves each part's rest frame by pose priority (`pose_override → idle anim → placement_frames[0]→[1]→first → identity`) and applies `DefaultScale` by pre-scaling GfxObj vertex origins in part-local space (`lib.rs:4371`), normals getting the inverse-transpose.

### holtburger state & gaps

| Concern | State | Detail |
|---|---|---|
| `0x03` parse (header/frame/quat/indexing) | **solid / full retail parity** | byte-exact, unit-tested; W-first quat, inclusive `high_frame`, reverse slice all correct |
| `0x02` parse (wire order, flags, placement, holding, defaults) | **solid** | round-trip tested; `0→None` for default DIDs via `decode_optional_resource_id` |
| Flat part composition | **solid / retail-correct** | every part `root.add`-ed; `parent_index` parsed but **correctly never used for hierarchy** (`walk_setup_parts` has zero `.parent_index` refs — *verifier correction: the "all empty Vec at lib.rs:8614,8720" proof in the source note is wrong; those 7 sites are synthetic constructors/test fixtures, and the real parser DOES populate `parent_index` at `setup_model.rs:345/429/461`*) |
| Discrete interpolation | **solid / retail-correct** | `InterpolateDiscrete` on both tracks |
| **Multi-segment per-segment timing** | **GAP (primary)** | The sole `buildAnimationClip` call site (`animation.js:572-575`) passes `{partCount,numFrames,framerate,partFrames,posFrames}` and **omits `frameTimes` and `duration`**. The correct per-segment path (`animation.js:115-134`) and the wasm `duration` getter are therefore **dead in production**; clips fall through to uniform `t = i/framerate` with the **AVERAGED** `framerate (= numFrames/duration)`. Single-segment cycles (idle/walk/run — the common case) are exact; **multi-segment cycles (~23% of retail: swing windup→strike→recover→settle, casts) play at the wrong relative per-segment speed** even though the data is baked correctly. Fix is ~2 lines: pass `frameTimes: animData.frameTimes, duration: animData.duration`. |
| AnimationHook execution | **partial** | parsed faithfully but stored as opaque `data: Vec<u8>`; only `Sound(1)/SoundTable(2)` executed by the entity-anim JS handler; `CreateParticle(13)/SoundTweaked(21)` are TODO (`lib.rs:12717-12725`). Hook `direction` is carried but the executor fires regardless of playback direction. |
| Sequence velocity/omega (`apply_physics`) | **not baked (parity-neutral)** | object-root translation left to the network/movement path; `cycleTimeScale` anti-ice-skating input exists but is **opt-in only** behind `?velScale=on` (`entities.js:6841-6843`), default `setEffectiveTimeScale(1.0)`. *(Verifier correction: the source note's "implemented but explicitly NOT WIRED" overstates — there is a wired opt-in path; `entities.js:1189` is a generic hard-cut helper, not the locomotion default.)* |
| `first_cyclic`/`apricot` link→loop chaining | **partial** | not modeled at runtime; links baked as a single concatenated clip played `LoopOnce` (overlay) vs `LoopRepeat` (cycle) at the JS layer. |
| `HasPhysicsBSP (0x8)` | **gap** | bit not extracted to a named bool in holtburger (only raw `flags` stored; `0x1/0x2` tested inline); physics BSP itself not parsed — sphere/cylinder primitives used for collision. |
| `AllowFreeHeading (0x4)` | **gap** | bit not extracted; no render-time heading-freedom gating. |
| `ConnectionPoints` | **gap** | parsed but never surfaced to JS or used (only `HoldingLocations` is, via `fetchSetupHoldingLocations`/`attachChildToParent`). |
| `MissileFlight (52)` placement | **gap** | parsed but in-flight projectile orientation does not consume it. |

### Gotchas (consolidated)

- **Quaternion is W-FIRST on disk** (`qw,qx,qy,qz`). three.js / `System.Numerics` want `xyzw`. Every consumer MUST reorder; the flat 7-float wasm buffer deliberately keeps W-first for byte fidelity, and JS reorders at clip-build (`animation.js:164-171`) and rest-pose apply (`entities.js:2001-2005`). A missed reorder rotates every part wrong.
- **PosFrames only when `Flags & 0x1`.** Most cycles (idle/walk/run) have **zero** pos_frames (verified human idle `0x03000001` has `pos_frames_len == 0`). Don't assume `pos_frames.len() == num_frames`; check the flag.
- **`high_frame` is INCLUSIVE; `< 0` = to end.** Off-by-one drops or duplicates the last keyframe. holtburger uses `high = high_frame<0 ? total : (high_frame+1).min(total)`.
- **Negative framerate = reverse**, no separate flag. `dt` from `|framerate|`.
- **Retail `AFrame::UnPack` gates the 12-byte origin on `size >= 0xC`** (`acclient.c:467627`), yielding a 16-byte quat-only AFrame in the *pack/memory stream*. This is NOT the DAT file form — `0x03` files always carry the full 28-byte Frame (`Pack` returns 28, `acclient.c:467615`; vector ctor stride 0x1C). Don't shrink the DAT Frame.
- **`PlacementFrames` count is signed `i32`** (holtburger even rejects a negative count as corruption, `setup_model.rs:374`); the other dict counts are `u32`.
- **A literal `0` default DID means "no default of this kind"**, not DID `0x00000000` — holtburger maps `0 → None`.
- **Each part DID is `0x01`-prefixed (GfxObj);** `walk_setup_parts` skips parts whose `(id>>24) != 0x01` after substitution. Raw `0x01` objects funnel through the same walk as a single identity-framed part.

### Open verification items

- DAT sweep to enumerate which `0x03` DIDs set `POS_FRAMES` and their magnitudes — validates the root-motion path on real lunge/door/emote animations (most cycles have none; path is unit-tested but unexercised on real root-motion data).
- A/B on the 1070 (wire-agent, `nullRender`) of an actual multi-segment swing/cast clip, `frameTimes` vs uniform, to confirm the latent timing bug and that `InterpolateDiscrete` snaps correctly with non-uniform `times` (that path is never exercised in production today).
- Byte-for-byte check of holtburger's hook variant sizes against retail `CAnimHook::UnPackHook` (`acclient.c:342737-343026`) for the rarer types (`Attack=28`, `SoundTweaked=16`, `CreateParticle=40`) using a real animation that carries them.
- *Caveat from verifier:* the source note's claim of a `direction`-ignoring executor comment at `animation.js:2754-2759` is **unlocatable** (`animation.js` is ~922 lines); the `direction` field is carried at `animation.js:604` (`direction: h.direction | 0`) but the "fires regardless of direction" comment could not be verified.

---

## Hook System, Particles & Scripts

This section documents AnimationHooks (per-frame animation side-effects), the ParticleEmitterInfo (0x32) descriptor + emitter runtime, and PhysicsScripts (0x33) + their table (0x34). Canonical source priority: **retail `acclient.c`/`acclient.h` is the behavioral oracle for hook *effects* and the runtime**; **ACE/MELT (`ACE.DatLoader`) is canonical for DAT wire layout and enum constants**. ACE.Server's `AnimHook.Execute` implements only `AnimationDone` (all visual hooks are client-side and commented out — `AnimHook.cs:18-21`), so it is **not** an effect oracle. In this checkout the `ACE.DatLoader` project is *only* present as the MELT vendored copy under `external/melt/Source/ACE.DatLoader/...`; the in-tree `external/ACE` has only `ACE.Entity` + `ACE.Server`. All holtburger JS paths below are under `apps/holtburger-web/`.

### AnimationHook Wire Format (the load-bearing layout)

Every AnimationHook serializes as:

```
[u32 hook_type][i32 direction][variant payload][0..3 align-pad to 4-byte boundary]
```

The align-pad mirrors retail `PackObj::ALIGN_PTR` (`acclient.c:343027`, after the `CAnimHook::UnPackHook` switch at `acclient.c:342737`). It is a **no-op for every variant except `ReplaceObject(5)`**, whose 3-or-5-byte payload is the only variable-length one. Do not assume hooks are fixed-stride.

**CRITICAL GOTCHA — wire id ≠ `acclient.h` declaration order.** The `u32 hook_type` is the value `GetType()` returns, *not* the struct order in `acclient.h:57405-57600`. E.g. `TransparentHook` is declared right after `NoDraw` but its wire id is 20; `LuminousPartHook` is declared before `LuminousHook` but ids are 9 and 8. Chorizite ACBindings confirms `TransparentHook::GetType()==20` (retail offset `0x00683760`, Execute `0x00527830`). Trust the ACE/MELT enum, byte-for-byte identical (`ACE.Entity/Enum/AnimationHookType.cs:6-32` == `melt/.../AnimationHookType.cs:6-32`). The enum also declares `Unknown=-1` (line 5) and `ForceAnimationHook32Bit=2147483647`; the contiguous switched range is 0..26.

**AnimationHookDir** (`i32`): `Unknown=-2` (0xFFFFFFFE), `Backward=-1` (0xFFFFFFFF), `Both=0`, `Forward=1`. Retail `CAnimHook::AnimHookDir` at `acclient.h:7311-7318`.

#### Per-type payload table (canonical)

| id | Name | Bytes | Payload (after i32 direction) |
|----|------|-------|-------------------------------|
| 0 | NoOp | 0 | — |
| 1 | Sound | 4 | `gid_` u32 (Wave DID) |
| 2 | SoundTable | 4 | `sound_type_` u32 (SoundType **enum**, not a DID) |
| 3 | Attack | 28 | `AttackCone` (see below) |
| 4 | AnimationDone | 0 | — |
| 5 | ReplaceObject | 3 or 5 +pad | `part_index` **u8**, then packed gfxobj DID |
| 6 | Ethereal | 4 | `ethereal` i32 |
| 7 | TransparentPart | 16 | `part` u32, `start`/`end`/`time` f32 |
| 8 | Luminous | 12 | `start`/`end`/`time` f32 |
| 9 | LuminousPart | 16 | `part` u32 + 3×f32 |
| 10 | Diffuse | 12 | `start`/`end`/`time` f32 |
| 11 | DiffusePart | 16 | `part` u32 + 3×f32 |
| 12 | Scale | 8 | `end`/`time` f32 (**NO start** — start = current `m_scale`) |
| 13 | CreateParticle | 40 | see below |
| 14 | DestroyParticle | 4 | `emitter_id` u32 |
| 15 | StopParticle | 4 | `emitter_id` u32 |
| 16 | NoDraw | 4 | `no_draw` i32 |
| 17 | DefaultScript | 0 | — |
| 18 | DefaultScriptPart | 4 | `part_index` u32 |
| 19 | CallPES | 8 | `pes` u32 + `pause` f32 |
| 20 | Transparent | 12 | `start`/`end`/`time` f32 |
| 21 | SoundTweaked | 16 | `gid_` u32 + 3×f32 (**retail wire order: prob, prio, vol**) |
| 22 | SetOmega | 12 | `Vector3` axis x/y/z |
| 23 | TextureVelocity | 8 | `u_speed`/`v_speed` f32 |
| 24 | TextureVelocityPart | 12 | `part_index` u32 + `u_speed`/`v_speed` f32 |
| 25 | SetLight | 4 | `lights_on` i32 |
| 26 | CreateBlockingParticle | 40 | same as CreateParticle |

**Part-variant trap:** for `7/9/11/24` the part index is the **first u32**, then the floats. The wasm getters offset-shift correctly (start at byte 4 for `*Part`, byte 0 for whole-object). A naive "all floats" read misparses the part index as a float.

**SoundTweaked float order (DRW mislabel + a holtburger latent bug):** retail `SoundTweakedHook::UnPack` (`acclient.c:343132-343138`) reads the three floats as **prob, prio, vol** in that wire order — DRW `dats.xml` mislabels them prio/prob/vol. holtburger-dat stores the 16 bytes opaque (correct), but the wasm convenience getters `soundPriority`/`soundProbability` in `src/lib.rs:34398-34431` follow MELT's *named* order (`SoundTweakedHook.cs` calls byte `[4..8]` "Priority"), reading `[4..8]`→priority, `[8..12]`→probability. Against retail wire order `[4..8]` is **probability** and `[8..12]` is **priority** — so the two named getters are **swapped relative to retail semantics**. Any consumer reading `soundPriority` expecting retail priority gets probability. Audit before trusting named priority vs probability.

#### AttackCone (28 B)

`part_index` i32 @0; `left` Vec2D{x,y} @4 (8B); `right` Vec2D{x,y} @12 (8B); `radius` f32 @20; `height` f32 @24. Retail `acclient.h:~52507`, MELT `AttackCone.cs`. holtburger-dat `setup_model.rs:68` reads 28 bytes.

#### CreateParticleHook / CreateBlockingParticle (40 B)

`emitter_info_id` u32 @0 (0x32 DID); `part_index` u32 @4 (`0xFFFFFFFF`=root); `offset` Frame @8 (28B = origin Vec3 @8 + **AC w-first** quaternion qw@20,qx@24,qy@28,qz@32); `emitter_id` u32 @36 (per-script handle). Retail struct `acclient.h:~57525`. The on-wire Frame layout (origin+quat) differs from the in-memory C++ `Frame` (qw,qx,qy,qz then a recomputed 3×3 matrix then origin) — the matrix is rebuilt from the quaternion. holtburger `cp_f32` getters hard-require `hook_data.len()==40` and `hook_type∈{13,26}` else return 0.

#### ReplaceObject (AnimPartChange) — the irregular one

`part_index` is a single **u8** (not u32), then the gfxobj id via `Unpack_AsDataIDOfKnownType(0x01000000)` (u16 hi; if `hi & 0x8000`, read u16 lo → 2 or 4 byte packed id), then 0..3 align-pad → total 3 or 5 bytes. Canonical: retail `AnimPartChange::UnPack` (`acclient.c:471699`) = u8; holtburger-dat agrees (`setup_model.rs:220-243`). **MELT diverges** — `ReplaceObjectHook.cs` reads a 2-byte u16 PartIndex ("structure is slightly different"). MELT is the outlier; trust retail/holtburger-dat (u8).

### Hook Runtime Model (retail)

Two-phase, deferred:

1. **Queue (during animation advance).** `CSequence::execute_hooks(animframe, dir)` (`acclient.c:339683`) walks the singly-linked `animframe->hooks` and, for each, fires iff `!direction_ || dir == direction_` — i.e. `Both(0)` always queues; `Forward(1)` only on forward playback; `Backward(-1)` only on backward; `Unknown(-2)` matches neither real dir. "Fire" means `CPhysicsObj::add_anim_hook` (`acclient.c:322063`), which **appends the pointer** to the `anim_hooks` SmartArray — it does **not** execute. After the final anim frame, `AnimDoneHook` is appended unconditionally. ACE mirrors: `if (hook.Direction == Both || hook.Direction == dir) HookObj.add_anim_hook(hook)` (`Sequence.cs:262-270`, AnimDone append `:435`).

2. **Execute (once per physics frame).** `CPhysicsObj::process_hooks` (`acclient.c:318641`): **Phase 1** walks the intrusive doubly-linked `this->hooks` list of `FPHook`/`VectorHook` timers, calling `Execute`; if it returns nonzero (timer done) it unlinks + `operator delete`. **Phase 2** loops `anim_hooks.m_data[i]->vfptr->Execute(obj)` for `i=0..m_num`, then `shrink()` and `m_num=0` — so queued anim hooks fire **once then the queue clears every frame**. ACE mirrors exactly (`PhysicsObj.cs:3159-3176`).

**Gotcha:** `execute_hooks` does not execute — it *queues*. Conflating the two yields wrong fire-timing assumptions.

#### FPHook interpolation engine

`PhysicsObjHook` base (`acclient.h:30961`): `vfptr; HookType hook_type; f64 time_created; f64 interpolation_time; PhysicsObjHook* prev; PhysicsObjHook* next; void* user_data`. `FPHook` (`acclient.h:57589`) adds `float start_value, end_value` (0x38=56 bytes total). `VectorHook` (`acclient.h:57596`) adds `Vector3 start_vector, end_vector`.

`FPHook::Execute` (`acclient.c:329695-329716`):

```
v = curr_time - time_created;
frac = v <= 0 ? 0 : (v < interpolation_time ? v / interpolation_time : 1.0);
curr_value = (end_value - start_value) * frac + start_value;
process_fp_hook(obj, hook_type, curr_value, user_data);
return frac == 1.0;   // true => process_hooks deletes the completed hook
```

`hook_type` here is **a bitfield** reusing `PhysicsDescInfo` flags `CSetup=1 / MTABLE=2 / VELOCITY=4` (`acclient.h:6212`) as opaque dispatch tags — they do **not** mean velocity/motiontable/setup semantically. `process_fp_hook` (`acclient.c:320572`) switches the integer 0-7:

| value | dispatch |
|-------|----------|
| 0 | SetScaleStatic |
| 1 | SetTranslucencyInternal |
| 2 | SetPartTranslucencyInternal(part) |
| 3 | SetLuminosityInternal |
| 4 | SetDiffusionInternal |
| 5 | SetPartLuminosityInternal(part) |
| 6 | SetPartDiffusionInternal(part) |
| 7 | CallPESInternal(pes) |

The property setters (`SetTranslucency2 acclient.c:316921`, `SetPartTranslucency/Luminosity/Diffusion 318759-318926`, `SetScale 320622`) each spawn an `FPHook` when `delta >= 0.00019999999`, **else apply the end value instantly** (no hook). So a zero/tiny-duration material hook *snaps to end*, never divides by zero. The flag combos per property: SetTranslucency2→`CSetup`(1); SetPartTranslucency→`MTABLE`(2); SetLuminosity→`MTABLE|CSetup`(3); SetDiffusion→`VELOCITY`(4); SetPartLuminosity→`VELOCITY|CSetup`(5); SetPartDiffusion→`VELOCITY|MTABLE`(6); CallPES→7; SetScale→0.

#### Final D3D material math (retail)

- `CMaterial::SetTranslucencySimple` (`acclient.c:360594-360603`): `alpha = 1.0 - trans` on Ambient/Diffuse/Specular/Emissive. **The Transparent hook value is TRANSLUCENCY: 0=opaque, 1=invisible.**
- `SetLuminositySimple`: `Emissive.rgb = lumi`.
- `SetDiffuseSimple`: `Diffuse.rgb = diffuse` (multiplier, default 1.0).
- Per-part vs whole-object: whole-object setters iterate all parts via `CPartArray::Set*Internal`; per-part index `parts[part_index]` (bounds-checked). Each `CPhysicsPart` caches `curTranslucency/curDiffuse/curLuminosity` (`acclient.h:31166-31168`). Setters early-out if unchanged; if `CurSettingsAreDefault` they **release the cloned material** (revert to shared gfxobj material); else `CopyMaterial()` clones then mutates (**clone-on-write**, `acclient.c:315420-315485`).
- `NoDraw(16)` → `set_nodraw` flips state bit `0x20`. `SetLight(25)` → `set_lights` flips state bit `0x800` + Init/DestroyLights. `SetOmega(22)` → stores `m_omegaVector` (physics integrates rotation). `Scale(12)` → FPHook type 0, `start = current m_scale`. `TextureVelocityPart(24)` → `CPhysics::AddGfxVelocity` — a **global per-gfxobj UV scroll keyed on gfxobj DID** (`acclient.c:311467`), affecting *all instances* of that gfxobj, not per-instance.
- **`Ethereal(6)` → `set_ethereal` (`acclient.c:319047-319071`) ONLY toggles collision state bit `0x4` (ETHEREAL_PS) + transient_state bit `0x100`. It does NOT touch opacity/translucency/material.** Any visual change for ethereal is a client invention. (The symbol `set_translucency_internal` does not exist in `acclient.c`.)

### Effect Hooks (sound / particle / script / attack)

- **Sound(1):** `PlaySoundA(gid_, physobj)`. **SoundTable(2):** payload is a SoundType **enum** resolved through the object's `CSoundTable` to a Wave + per-row volume — *not* a DID. **SoundTweaked(21):** `PlaySoundA(gid_, physobj, prio, prob, vol)`; `prob<1.0` is a per-fire coin-flip, `vol` linear gain, `prio` mixer priority. Default ctor: prio≈0.85, prob=1.0, vol=1.0, direction=-2.
- **Attack(3):** `CPhysicsObj::attack(&cone)` builds a CSphere at `z=height*scale`, radius `scale*cone.radius + attack_manager.attack_radius`, runs the **client-side** hit-cone test for local feedback. Server (ACE) is authoritative for damage.
- **CreateParticle(13) emitter-id handle model** (`ParticleManager::CreateParticleEmitter`, `acclient.c:329375`): `emitter_id!=0` → **destroy+delete any existing emitter with that id** (replace), then reuse it; `emitter_id==0` → assign `next_emitter_id++` and **return** it. `SetParenting(part_index, offset)` (`acclient.c:330252`) stores `part_index`+`parent_offset` — retail anchors **per-part**. **CreateBlockingParticle(26)** additionally returns 0 (refuses) if a live emitter already holds that nonzero id, and pauses the animation while the script runs.
- **StopParticle(15) ≠ DestroyParticle(14):** Stop sets the "stopped" flag (`*((DWORD*)data+35)=1`, `acclient.c:329442`) — existing particles live out their lifespan, emitter removed later by `UpdateParticles` when it returns false. Destroy frees immediately.
- **DefaultScript(17)/DefaultScriptPart(18):** `play_default_script()` / `play_default_script(part_index)` — looks up `physics_script_table` by `default_script` + intensity (the table-driven path, below).

#### CallPES — the recursion primitive (retail)

`CPhysicsObj::CallPES(pes, delta)` (`acclient.c:318973`): if `delta >= 0.00019999999`, roll a **uniform random** duration `randp = Random::RollDice(0.0, delta)` (`acclient.c:105532`), then create `FPHook(hook_type = VELOCITY|MTABLE|CSetup = 7, time_created=curr_time, interpolation_time=randp, start=0.0, end=1.0, user_data=pes.id)`. The FPHook ramps 0→1 over the random window; `CallPESInternal` (`acclient.c:318963`) fires `play_script_internal(pes)` only once `curr_value>=1.0` **and** the object has a cell. If `delta<0.0002`, fire immediately. So `pause` is a **max random window**, not a fixed wait. The called script may itself contain CallPES hooks → arbitrarily deep recursion bounded only by script acyclicity.

### ParticleEmitterInfo (0x32) — Descriptor

#### Wire UnPack (172 bytes; canonical = MELT/Rust)

Read order: `id` u32; `reserved` u32 (ignored); `emitter_type` i32; `particle_type` i32; `gfxobj_id` u32; `hw_gfxobj_id` u32; `birthrate` f64; `max_particles` i32; `initial_particles` i32; `total_particles` i32; `total_seconds` f64; **`lifespan` f64; `lifespan_rand` f64**; `offset_dir` Vec3; `min_offset`/`max_offset` f32; `a` Vec3, `min_a`/`max_a` f32; `b` Vec3, `min_b`/`max_b` f32; `c` Vec3, `min_c`/`max_c` f32; `start_scale`/`final_scale`/`scale_rand` f32; `start_trans`/`final_trans`/`trans_rand` f32; **`is_parent_local` u32 (tested `!=0`, LAST field)**.

**Gotchas:**
- **Wire order ≠ struct memory order.** `acclient.h:52409-52442` declares `is_parent_local` 3rd and `lifespan_rand` *before* `lifespan`; the in-memory struct also carries a `CSphere sorting_sphere` that is **not serialized** (recomputed in `InitEnd`). The wire (MELT `ParticleEmitterInfo.cs:67-68,94`, Rust `particle_emitter.rs:82-83,104`) reads `lifespan` first and `is_parent_local` last.
- **`gfxobj_id` and `hw_gfxobj_id` are SCALAR u32 each**, despite the ACE schema labeling them `<vector>` of GfxObjId/HwGfxObjId. Reading them as count-prefixed lists corrupts every subsequent field. Verified across 2051 retail emitters (same family trap as SoundTable).
- Ctor defaults: `min/max a/b/c = 1.0`, `start/final_scale = 1.0`, rest 0.

`InitEnd` sorting_sphere: `velocity_radius = max_a * lifespan`; `radius = max(max_offset, velocity_radius)`; `center = (0,0,0)`. Identical retail/ACE/holtburger; used only for whole-emitter frustum culling.

#### Jitter helpers (retail = ADDITIVE)

All five are `result = RollDice(-1,1)*rand + value` (RollDice(-1,1) ~ uniform[-1,1)):
- `GetRandomStartScale/FinalScale` → clamp `0.1..10`.
- `GetRandomStartTrans/FinalTrans` → clamp `0..1`.
- `GetRandomLifespan` → floor 0.

Retail at `acclient.c:324324-324404`. **ACE BUG:** `GetRandomFinalScale/StartTrans/FinalTrans` use *multiplicative* `r*rand*value` (`ParticleEmitterInfo.cs:109,117,125`); only StartScale+Lifespan match retail. **holtburger ports the retail additive form for all five** (`particle_emitter_info.js:135-171`) — do NOT "fix" it back toward ACE.

**`GetRandomOffset`** builds an rng unit-cube point, removes the `offset_dir` projection (perpendicular spawn point), zeroes if `length<0.0002`, then scales by magnitude. **Retail:** `RollDice(0,1)*(max_offset-min_offset)+min_offset`. **ACE BUG:** `((max-min)+min)*Next(0,1) == max*Next(0,1)` — drops the lerp and the `min_offset` floor. **holtburger inherits the ACE collapsed form** (`particle_emitter_info.js:185-211`) — a real divergence from retail.

`GetRandomA/B/C`: `magnitude = (max_X - min_X)*RollDice(0,1) + min_X; result = X_vec * magnitude`. Identical retail/ACE/holtburger.

`ShouldEmitParticle`: `(total_particles<=0 || total_emitted<total_particles) && num_particles<max_particles`, then `emitter_type & 1` (BirthratePerSec) emits when `cur_time - last_emit_time > birthrate`; `emitter_type & 2` (BirthratePerMeter) when `last_emit_time < |emitter_offset|²`. Retail uses bitwise `&1/&2`; ACE/holtburger use `==` enum — equivalent for the only two defined types.

### Particle Runtime (CParticle, 12-case integrator)

`Particle::Init` snapshots `StartFrame` from `parent.position.frame` (or `parent.part[partIdx].pos.frame`), computes `Offset = StartFrame.LocalToGlobalVec(parentOffset.origin + randomOffset)` (**pure rotation, no translation** → world-axis vector), conditionally rotates A/B/C into world space per `ParticleType`, sets start/final scale+trans, and calls `Update` once at t=0.

`Particle::Update` (`acclient.c:330313-330551`) — `persistent = (total_particles==0 && total_seconds==0)`; non-persistent `lifetime = cur_time - birthtime` (full age; `last_update_time` only advances on the persistent branch — looks like a delta-vs-total bug but is correct). Position by type:

| type | formula |
|------|---------|
| 1 Still | `origin + offset` |
| 2/12 Velocity | `lt*A + origin + offset` |
| 3/8/10 Parabolic | accumulates `lt²*B*0.5 + lt*A + offset` |
| 4/9/11 Parabolic+rot | as above, then `frame.Rotate(lt*C)` |
| 5 Swarm | `cos(b.x*lt)*c.x + lt*a.x + offset.x + origin.x` (cos/sin/cos per axis — **trig × C**) |
| 6 Explode | `(lt*B + C*A.x)*lt + offset + origin` |
| 7 Implode | `cos(A.x*lt)*C + lt²*B + origin + offset` |

Then `interval = min(lifetime/lifespan, 1)`; `currentScale = start + (final-start)*interval`; `currentTrans` likewise; `SetTranslucency(part, currentTrans)` where translucency 1.0 ⇒ NoDraw.

**Translucency is INVERTED vs three.js opacity: AC 0=opaque, 1=invisible.** holtburger maps `opacity = 1 - translucency`, `translucency>=1.0` ⇒ `mesh.visible=false`.

#### Emitter lifecycle

`SetInfo`: `hw_gfxobj_id==0` → fail/discard. `InitEnd` seeds the t=0 burst from **`initial_particles`** (retail `acclient.c:331278`) — **ACE BUG** loops `TotalParticles` (`ParticleEmitter.cs:261`); holtburger correctly uses `initialParticles` (with totalParticles fallback). `EmitParticle` RNG draw order: lifespan, finalTrans, startTrans, finalScale, startScale, C, B, A, offset. `UpdateParticles`: if `ShouldDrawParticles(degrade_distance)==false` → `SetNoDraw(true)` + degrade; else update each live particle (frame = `is_parent_local ? current parent frame : particle.start_frame`), `KillParticle` when `lifetime>=lifespan`; then `ShouldEmitParticle`→`EmitParticle`; `StopEmitter` when `total_seconds` elapsed or `total_emitted>=total_particles`. Returns false (dead) only when `stopped && num_particles==0`.

### PhysicsScript (0x33) + Table (0x34)

Body: `[u32 id][u32 count][PhysicsScriptData × count]`, `PhysicsScriptData = [f64 start_time][AnimationHook]`. ID range `0x33000000..0x3300FFFF`. The in-memory retail `PhysicsScript` also carries a trailing `long double length` (`acclient.h:31804`) used to space queued scripts.

**NAME COLLISION:** the DAT record `PhysicsScriptData` (`acclient.h:31992` = `{start_time, CAnimHook*}`) is distinct from the runtime scheduler node plain `ScriptData` (`acclient.h:31206` = `{start_time, PhysicsScript*, next_data}`) used by `ScriptManager`. Don't conflate.

**ScriptManager (retail, wall-clock time-ordered — NOT frame-indexed):** `play_script_internal` (`acclient.c:318035`) → `AddScript` (QualifiedDataID type `0x2B`) → `AddScriptInternal` (`acclient.c:329069`): node `start_time = last_data ? last_data.script.length + last_data.start_time : Timer::cur_time` (so queued scripts are length-spaced). `UpdateScripts` (`acclient.c:329189`) per frame: while `Timer::cur_time >= next_hook_time`, `NextHook` (`acclient.c:329142`) returns the current hook, advances `hook_index`, sets `next_hook_time = next_entry.start_time + node.start_time`; at end-of-node it uses a `+INF` sentinel (HIDWORD `-1074790400`) and chains `curr_data = next_data`. Hooks within a script fire in **stored array order** at their `start_time` offsets relative to attach.

**PhysicsScriptTable (0x34):** `Dictionary<PScriptType, PhysicsScriptTableData{ List<ScriptAndModData{ f32 mod; u32 script_id }> }>`, entries ascending by `mod`. `PhysicsScriptTableData::GetScript` (`acclient.c:336552`): advance while `incoming_mod > entry.mod`; return the first entry with `mod >= intensity`, else the fallback id (`stru_8444D0`). Object-level: `Setup.default_script_id` is played at construction (`acclient.c:320866`); `play_default_script()` (`acclient.c:320351`) runs the table picker with `default_script_intensity`.

### holtburger Current State

| Area | State | Files |
|------|-------|-------|
| DAT parsing (all 27 hooks, 0x32, 0x33, 0x34) | **Solid / bit-exact** | `crates/holtburger-dat/src/file_type/{setup_model.rs:38-265, particle_emitter.rs, physics_script.rs:36-99}` |
| wasm field getters | Solid | `src/lib.rs:12734,13037-13260` (hooks); `34325-34552` (particle/script) |
| Visual/material/transform hooks | Implemented | `scene3d/entities.js` `_fireHook:7143`, `_spawnMaterialRampTween:7689`, `_tickMaterialHooks:7896`, `_tickHookOmega:7940`, clone-on-write `_getOrCloneEntityMaterial:5868` |
| Effect hooks (sound/particle/attack/replace/CallPES) | Implemented (simplified) | `entities.js:7143-8160`, `_attachParticleChainForEntity:5924-6268` |
| Particle runtime | **Solid** (5 JS files) | `scene3d/particles/{particle_emitter_info,particle,particle_emitter,particle_manager,time_rng}.js` |
| PhysicsScript runtime | **Partial** (setTimeout walker, not ScriptManager) | `scene3d/entities.js:5924-6268` |

The per-frame ramp lerp is **byte-identical to retail**: `_tickMaterialHooks` (`entities.js:7907-7909`) computes `t = elapsed/durationMs; v = rampStart + (rampEnd-rampStart)*t` — algebraically `FPHook::Execute`. Clone-on-write mirrors `CopyMaterial` (mesh re-pointing by `surfaceDid`). The `Direction==Backward(-1)` gate is collapsed to `if ((hook.direction|0) === -1) return` (`entities.js:7166`) because reverse segments are re-baked forward. The emitter-id replace/auto-allocate model matches retail (`particle_manager.js` delete-on-collision `:131`, `nextEmitterId++` from 1 `:238`). Root sentinel `0xFFFFFFFF` correctly maps to -1 and works.

#### Confirmed gaps / bugs

1. **Transparent inversion bug (likely real).** Retail value is translucency, `alpha = 1 - trans`. holtburger's **static** surface path is correct (`opacity = 1 - sfTranslucency`, `materials.js:1836`), but the **dynamic hook** path `_applyRampValueToMaterial` (`entities.js:7793`) sets `material.opacity = value` with **no inversion** — a Transparent hook fading translucency 0→1 (fade to invisible in retail) renders as opacity 0→1 (fade *in*). Internal inconsistency. Fix: `opacity = 1 - value` for hookType 20/7. Needs a fade-out eye-test.
2. **Ethereal semantic mismatch.** Retail `set_ethereal` is collision-only (no opacity). holtburger applies `opacity=0.4` (`entities.js:7845`) with a comment (lines 7824-7826) citing a **non-existent** retail `set_translucency_internal(0.4f)`. Decide whether to keep the 0.4 hint as a documented client invention or drop it; fix/remove the bad citation.
3. **Per-part particle anchoring broken for entities.** `CreateParticle.part_index` is threaded through `addEmitter`→`setParenting`, but `particle_emitter.js:336` resolves `this.parent.partFrames[partIndex] || this.parent`, and the entity rig (`inst.root`, a bare `THREE.Group`) has **no `partFrames`** (zero `.partFrames =` assignments anywhere in `scene3d/`). Every non-root part_index silently root-falls-back with only the static `parentOffset`. Root-anchored (`-1`) emitters work. Fix: synthesize a `partIndex→inst.parts[partIndex]` world-matrix accessor.
4. **CallPES timing diverges.** holtburger uses a **fixed** `setTimeout((start_time+pause)*1000)` (`entities.js:6105`), depth-capped at `MAX_CALL_PES_DEPTH=3` (`entities.js:347`). Retail uses `Random::RollDice(0, pause)` uniform-random duration driving a 0→1 FPHook that fires only on completion (no randomization, no interp in holtburger; depth-cap is a pragmatic guard, not retail behavior).
5. **No ScriptManager / FPHook engine.** No per-frame time-ordered scheduler; no `next_data` chaining or `length`-spaced queuing. Types `DestroyParticle(14)/StopParticle(15)/Ethereal(6)/TextureVelocity(23,24)/SetLight(25)/ReplaceObject(5)/Attack(3)` are parsed but **not acted on in the PhysicsScript walker** (some are handled in the entity `_fireHook` path, not the script walker).
6. **CreateBlockingParticle treated identically to CreateParticle** — no frame-gate, no refuse-if-id-live check (`acclient.c:329528`).
7. **PhysicsScriptTable picker not wired into idle entity spawn.** Documented in `ui/ac_physics_script_table.js:29-35` (cites `acclient.c:336552`) but the idle path uses a single pre-resolved `physicsScriptDid` directly (`entities.js:2281`); `default_script_intensity` is bypassed. (It *is* wired for the spell/PlayEffect path via `play_effect_vfx.js`, `entities.js:3863-3878` — so "never wired" would be too strong.)
8. **Swarm (type 5) inherits ACE divergence.** holtburger (`particle.js:379-395`, copying ACE `Particle.cs:159-164`) folds C **additively** (`cos(lt*B.X)+swarm.X`) instead of retail `cos(b.x*lt)*c.x + lt*a.x + offset + origin` (**trig × C**). Swarm is the type retail uses for Dereth's sky/moon, so this is the most visible particle gap.
9. **`getRandomOffset`** inherits the ACE collapsed `(max-min)+min` form — loses the `min_offset` floor and per-spawn random magnitude.
10. **No degrade-distance branch** — `degradeDistance` hardcoded `Infinity` (`particle_emitter.js:102`), `ShouldDrawParticles/SetNoDraw/degradedOut` absent (`particle_emitter.js:325-359`); distant emitters never degrade out.
11. **Minor:** `normalizeCheckSmall` uses `lengthSq<1e-6` (length<0.001) vs retail/ACE `length<0.0002` — 5× looser. `SetLight` is gated by `?entityLights` (default-off no-op). RNG is `Math.random` (`time_rng.js:23`), not seeded `RollDice` — not byte-reproducible (acceptable for visuals).

The team already corrected two ACE bugs in holtburger (multiplicative scale/trans jitter → additive; `TotalParticles` burst → `initialParticles`), so the jitter helpers and InitEnd seeding are **more retail-accurate than ACE**. Note the in-repo code comment claiming "ACE actually uses initial_particles too" is itself wrong — ACE uses `TotalParticles`.

---

## Movement, Velocity, Jump & Wire Protocol

This section covers how AC drives entity locomotion (velocity/omega + the anti-ice-skating coupling), the pure-physics jump/fall model (and why no jump animation clip exists), and the two on-wire motion structures (RawMotionState C2S vs InterpretedMotionState S2C). All formulas, constants, and struct layouts below are cross-verified against retail `acclient.c`/`acclient.h`, ACE, chorizite, melt, and the holtburger-protocol/holtburger-world crates. Canonical source is marked per divergence.

### 1. Velocity, Omega & the Ice-Skating Problem

**Authored data lives in the MotionTable.** Each motion cycle/link entry carries an optional `MotionData.velocity` (Vector3, `|velocity|` = clip ground speed in m/s) and `MotionData.omega` (Vector3, rotational rad/s), plus per-anim `AnimData.Framerate`. holtburger-dat parses both bit-for-bit (flag-gated; see §4 layout).

**Retail does NOT scale playback by `|velocity|` at runtime.** The ground velocity comes from `CMotionInterp::get_state_velocity` using **hardcoded anim-speed constants** times the interpreted `forward_speed` scalar — not the parsed velocity field:

| Branch | Command code (hex / dec) | Multiplier | Constant name | Source |
|---|---|---|---|---|
| Walk forward | `0x45000005` / `1157627909` | `3.1199999` | WalkAnimSpeed | `acclient.c:343561` |
| Run forward | `0x44000007` / `1140850695` | `4.0` | RunAnimSpeed | `acclient.c:343565` |
| Sidestep right | `0x6500000F` / `1694498831` | `1.25` | SidestepAnimSpeed | `acclient.c:343553` |
| Turn (run-turn factor) | `0x6500000D` | `×1.5` | RunTurnFactor | `acclient.c:343469` |
| Sidestep clamp | — | `≤3.0` | MaxSidestepAnimRate | `acclient.c:343474-343480` |

`get_state_velocity` (`acclient.c:343539-343594`): `X = sidestep_command==SideStepRight ? 1.25*sidestep_speed : 0`; `Y = WalkForward ? 3.1199999*forward_speed : RunForward ? 4.0*forward_speed : 0`; `Z=0`. Then `max = (InqRunRate ? runFactor : my_run_rate) * 4.0`; if `|v|>max`, normalize and rescale to `max` (clamp also in `get_max_speed`, `acclient.c:343500-343506`). ACE mirrors exactly at `MotionInterp.cs:683-687`; constants at `MotionInterp.cs:28-32`.

> **GOTCHA (corrected from a defect in the source note's prose):** `0x45000005` (dec `1157627909`) is **WalkForward** (the `3.1199999` branch), NOT RunForward. **RunForward** is `0x44000007` (dec `1140850695`, the `4.0` branch). holtburger-dat has these right: `motion_table.rs:49` `WALK_FORWARD_COMMAND=0x4500_0005`, `:50` `RUN_FORWARD_COMMAND=0x4400_0007`. Using the wrong code silently no-ops the scaling.

**`apply_run_to_command` (walk→run promotion, `acclient.c:343439-343483` / ACE `MotionInterp.cs:525-562`):** `speedMod = InqRunRate ? runFactor : my_run_rate`. `WalkForward`: if `speed>0` → motion becomes `RunForward`, `speed *= speedMod`. `TurnRight`: `speed *= 1.5`. `SideStepRight`: `speed *= speedMod`, then clamp `|speed| ≤ 3.0` (sign-preserving). Called from `adjust_motion` only when `holdKey==Run`.

**`my_run_rate` provenance** (the multiplier that scales everything) — two unrelated set-paths:
- (a) server `MoveTo` packet trailing float: `acclient.c:339571` (MoveToObject case 6), `:339583` (MoveToPosition case 7).
- (b) local self-assign when `forward_command==RunForward`: `my_run_rate = forward_speed` (`acclient.c:344163`; ACE `MotionInterp.cs:452`).

A renderer reading only (a) misses self-driven run-rate; reading neither falls back to `1.0` (every entity at base run speed).

**`GetRunRate` (ACE `MovementSystem.cs:20-28`):** if `runSkill>=800` → `18.0/4.0 = 4.5`; else `((GetBurdenMod(burden)*(runSkill/(runSkill+200)*11)+4)/scaling)/4`. `×4.0` gives the m/s ceiling (4..18). `GetBurdenMod` (`EncumbranceSystem.cs:34-39`): `burden<1→1`, `<2→2-burden`, else `0`. holtburger ports faithfully at `crates/holtburger-world/src/context.rs:57-64` — **caveat:** the holtburger port omits the `/scaling` divisor (`context.rs:62`), i.e. faithful only for `scaling=1.0`.

#### The anti-ice-skating coupling (shared `speed` scalar)

The mechanism that keeps feet planted is a single `speed` scalar applied to BOTH translation and playback rate — NOT a runtime division by `|velocity|`:

```
ACE MotionTable.add_motion(sequence, motionData, speed):   // MotionTable.cs:358-369
  sequence.SetVelocity(motionData.Velocity * speed)        // :362  physics translation
  sequence.SetOmega(motionData.Omega * speed)              // :363
  for each anim: new AnimData(anim, speed)                 // :367
       → AnimData.Framerate = animData.Framerate * speed   // AnimData.cs:17  playback rate
```

Translation and framerate scale by the **identical factor**, so as ground speed scales the feet stay planted. Retail equivalent: `AnimSequenceNode` framerate-multiply at `acclient.c:340978` (`this->framerate = multiplier * this->framerate`). `combine_motion`/`subtract_motion` (`MotionTable.cs:381-392`) add/remove `velocity*speed + omega*speed` for overlay turn cycles. **Ice-skating = decoupling these** (scaling ground translation but holding framerate at a fixed `timeScale`).

#### ACE alternate speed measure: GetAnimDist (DIVERGES from |velocity|)

ACE caches per-MotionTable speeds via a **second, distinct measure** of authored speed:
- `GetRunSpeed(mtId)` → `GetAnimDist(GetMotionData(mtId, RunForward))` (`MotionTable.cs:506-518`).
- `GetAnimDist` (`MotionTable.cs:572-589`): accumulate `offset += frame.Origin` across all anims/PosFrames, `totalFrames++`, then `dist = offset.Length()` **after** the loop (i.e. magnitude-of-the-vector-sum, NOT sum-of-magnitudes — numerically different for curved paths), return `dist/totalFrames * Anims[0].Framerate`.
- `GetTurnSpeed(mtId)` = `Math.Abs(motionData.Omega.Z)` (`MotionTable.cs:534`).
- `WalkSpeed`/`RunSpeed`/`TurnSpeed` caches at `MotionTable.cs:23-25`; only `RunSpeed`/`TurnSpeed` have getters in this build.
- `GetMotionData` key = `(currentStyle<<16)|(motion & 0xFFFFFF)` (`MotionTable.cs:549`); holtburger masks command with `0x000F_FFFF` (`motion_table.rs:8/228`) — same result for standard locomotion, different mask width.

> **CANONICAL-SOURCE DIVERGENCE:** authored base speed is `|MotionData.velocity|` (physics overlay path, holtburger's choice) **vs** `GetAnimDist` (ACE's nav/RunSpeed cache). They can disagree for the same cycle. ACE's `MovementSystem` trusts `GetAnimDist` for monster nav; per-cycle physics uses `velocity`. Needs an empirical check on the actual player MotionTable (the prior T11 failure suggested the player's RunForward cycle may carry `|velocity|==0`, making any `|velocity|`-based getter inert).

#### Holtburger current state: PARTIAL (default-OFF)

- **wasm export `cycleBaseSpeed`** (`apps/holtburger-web/src/lib.rs:4680`, `js_name=cycleBaseSpeed`; inner `motion_cycle_base_speed` `:4654-4671`): returns `|MotionData.velocity| = sqrt(x²+y²+z²)`, `0.0` if no `HAS_VELOCITY`, `0` for non-`0x09` ids. `stance==0` → `default_style`. This is the **only** authored-speed getter; it uses velocity, **not** `GetAnimDist`.
- **JS anti-ice-skating path IS fully wired** (`animation.js`/`entities.js`): `cycleTimeScale(actual, base)` (`animation.js:241-251`) → `1.0` if `base≤1e-4` else `clamp(|actual|/base, 0.25, 4.0)`. `setMotion` resolves `_locoBaseSpeed` via `_resolveCycleBaseSpeed` (memoised `_cycleBaseSpeedCache`, `entities.js:4324-4338`). `tick()` (`entities.js:6820-6845`) derives EMA ground speed from rig XZ position delta (`hypot(dx,dz)/dt`, EMA `0.7/0.3`) → `setEffectiveTimeScale(cycleTimeScale(emaSpeed, base) * motionSpeed)`.
- **`run_rate_from_skill_and_burden`** ported faithfully (`context.rs:57-64`) but **not consumed** by the render velScale path.

**Gaps:**
1. **Entire velScale path is OFF by default** — `VEL_SCALE_ON` requires `?velScale=on` (`entities.js:310-318`, default `false`). Out-of-the-box gait still ice-skates; `cycleTimeScale`'s only call site (`entities.js:6841`) sits inside `if(VEL_SCALE_ON)`.
2. **"Actual" speed is client-derived** from rendered rig XZ deltas, NOT a wasm `get_state_velocity` mirroring retail's `forward_command/forward_speed × const × run_rate`. Reads garbage during server-pose snaps / teleports / rubber-banding (clamp mitigates, doesn't fix).
3. **`cycleBaseSpeed` uses `|velocity|`** directly; holtburger implements neither `get_state_velocity`, `GetAnimDist`, nor the `my_run_rate*4.0` max-speed clamp — base may diverge from retail for cycles whose baked velocity ≠ `4.0*authored`.
4. **No turn-in-place foot/ground** (`TurnSpeed=|Omega.Z|`); turn cycles classify "walk" with ~0 `|velocity|` so `cycleTimeScale` no-ops (`entities.js:4490`). Omega is parsed but unused on the render path.

**Parity verdict:** numeric constants match retail exactly; DAT parse is canonical. The render-side model is a plausible-but-default-disabled approximation (`|velocity|` base + client position-delta as "actual"), NOT retail's `get_state_velocity`. **Effective parity LOW** until `?velScale=on` is flipped AND the "actual" input comes from wasm motion state. (A stale worktree `entities.js` predates this entire path and simply lacks it — it does **not** contain a renamed `n`/`_nCache` export; ignore it.)

### 2. Jump Mechanics

**Jump is a pure-physics event, not an animation.** The Jump MotionCommand `0x2500003B` (dec `620757051`) **keys NO animation clip in ANY of the 436 motion tables** — empirically confirmed by running `crates/holtburger-dat/examples/jump_clip_data_check.rs` against `~/ac_base_dats/client_portal.dat`: `TABLES_SCANNED=436, TABLES_WITH_JUMP=0`. The visible "jump" is the ballistic arc of the body in its existing pose.

> **GOTCHA (correction):** `0x2500003B` is NOT "absent from acclient.c" — it appears as dec `620757051` in command-enum tables (`acclient.c:40464/40899/43925`) and in the jump dispatch `CommandInterpreter::MovePlayer_NonAutonomous` (`acclient.c:717673/717678`, special `vfptr[5]` handler), and it is a first-class named MotionCommand (ACE `MotionCommand.cs:66`). The accurate statement is: it is a recognized MotionCommand but **no motion table maps an animation clip to it** — still proving jump is velocity-driven, not animation-driven.

**Math chain** (bit-identical across retail/ACE/holtburger):

```
GetJumpHeight(load, jumpskill, power, scaling):              // acclient.c:713806 (formula :713823)
  power = clamp(power, 0, 1)
  h = LoadMod(load) * (jumpskill/(jumpskill+1300.0)*22.200001 + 0.050000001) * power / scaling
  if h < 0.34999999: h = 0.34999999                          // 0.35m floor
  LoadMod: load>=2→0; 1<=load<2→2-load; load<1→1             // EncumbranceSystem, acclient.c:296777

velocity_z = sqrt(h * 19.6)     // 19.6 = 2*g (g=9.8) → apex == requested h    acclient.c:443843
```
ACE: `WeenieObject.cs:95` `velocity_z = (float)Math.Sqrt(height*19.6)`. holtburger: `crates/holtburger-world/src/player/types.rs:814` `(height*19.6).sqrt()` (inlines `22.2/1300/0.05/0.35` at `:812`).

**`JumpStaminaCost` (`acclient.c:713830` / ACE `MovementSystem.cs:30` / holtburger `types.rs:780`):**
- non-PK: `ceil((load + 0.5) * power * 8.0 + 2.0)`
- PK (PKTimerActive — recent PK attack within 20s + PlayerKillerStatus 4 or 64): `(power + 1.0) * 100.0`

If `stamina==0`, `jumpskill` is **forced to 0** (`acclient.c:443839` / holtburger `lib.rs:~33492`), collapsing height to the `0.35m` floor (`vz≈2.62 m/s` tiny hop) rather than rejecting the jump. ACE's "scale power down when low stamina" branch is **commented out** (`Player.cs:883-894`).

**`GetJumpPower` (server-only, effectively dead):** ACE `MovementSystem.cs:38` (non-PK `(stamina-2.0)/(burden*8.0+4.0)`; PK `stamina/100.0-1.0`), but its **only caller** is inside the commented block (`Player.cs:886`). Absent from the retail client decomp (only `ClientCombatSystem::GetJumpPowerLevel`, a UI power-bar getter, `acclient.c:408081`). holtburger omits it.

#### LeaveGround / HitGround launch pipeline

```
CMotionInterp::jump(extent)                                          // acclient.c:344224
  → cancel_moveto; jump_is_allowed → codes 0=OK / 36=in-air / 71=fully-constrained
                                     / 72=cant-from-position / 73=cant(load/stamina)  // :343922
  → standing_longjump=0; this->jump_extent=extent; set_on_walkable(0)
set_on_walkable(0)                                                   // :318502
  → clears transient_state walkable bit → MovementManager::LeaveGround
CMotionInterp::LeaveGround                                           // acclient.c:344457
  → get_leave_ground_velocity(&v)   // planar (x,y) from get_state_velocity + get_jump_v_z on z  :343806
       get_jump_v_z: clamp jump_extent (<0.0002→0, >1→1) → WeenieObject vtbl[12] InqJumpVelocity → sqrt(h*19.6)  :343343
  → set_local_velocity(v, 1); standing_longjump=0; jump_extent=0
  → RemoveLinkAnimations()          // acclient.c:317145 → CPartArray::HandleEnterWorld → DEFAULT enter-world pose
  → apply_current_movement(0,0)
HitGround (on contact): RemoveLinkAnimations + apply_current_movement(0,0)  // resumes grounded locomotion
```

> **GOTCHA:** Launch velocity is **NOT purely vertical**. `get_leave_ground_velocity` combines the current planar state velocity (x,y) with `jump_v_z` on Z — a running jump carries forward momentum. ACE works around this with a `MovementType.Invalid` update before the jump (`Player.cs:947`).

`jump_is_allowed` error-code strings (`DoJump`): `73→cant_jump_load`, `72→cant_jump_position`, `36→cant_jump_in_air`.

#### Autonomous send path (no MotionCommand queued)

`ClientCombatSystem::DoJump(autonomous=true)` (`acclient.c:408146`): `extent = GetPowerBarLevel()` (or `MIN_JUMP_EXTENT=0.001`, `acclient.c:41626`), `FinishJump`, `CMotionInterp::jump(extent)` applies local velocity, `get_local_physics_velocity` reads it, build `JumpPack` and `CM_Movement::Event_Jump(jp)`. **No `UpdateMotion(Jump)` is ever sent** — ACE echoes only `MovementType.Invalid` (`Player.cs:947`) + `GameMessageVectorUpdate` (`Player.cs:954`).

#### Falling (the one in-air clip that DOES exist)

`Falling = 0x40000015` **is** present in motion tables (per dump, MT `0x09000001` for every player stance except Sling/TwoHandedStaff/Graze) — the looping in-air fall cycle. `motion_allows_jump` does NOT treat Falling as a jump-blocker (double-jump is prevented by airborne/contact transient_state). `Fallen = 0x40000008` is a distinct post-fall stagger pose and **IS** in the jump-blocked set. holtburger: walk-off-ledge (`begin_fall`, `is_jumping=false`) emits `Falling` (`lib.rs:34087`); deliberate jump (`begin_jump`, `is_jumping=true`) suppresses Falling; touchdown emits `Ready 0x41000003` (`lib.rs:34049`) + kind=18 `EntityAirborneChanged(0)`.

**`motion_allows_jump` blocked substates** (`acclient.c:343295`, returns `72`=blocked): `0x40000016-18, 0x4000001E-39, 0x41000012-14, 0x1000006F-78, 0x10000128-131, 0x40000008`. holtburger `types.rs:64-71` negates the identical set (returns `false`=blocked — **opposite polarity, equivalent gating**; the retail name is misleading: `72` truthy means BLOCKED, `0` means allowed).

#### Fall damage (server-side, ACE `Player_Move.cs`)

```
jumpVelocity = 11.25434                                       // :254 (≈ InqJumpVelocity(1.0))
overspeed    = 11.25434 + currVelocity.Z + 4.5               // :259 (4.5 = leeway)
ratio        = -overspeed / 11.25434                         // :261
if ratio > 0: damage = ratio * 87.293810 → TakeDamage_Falling // :271
```
Descending Z is negative, so fast enough downward Z → `overspeed<0` → `ratio>0` → damage. holtburger `compute_fall_damage` (`types.rs:753`) replicates all three constants; client-side it is **documentation-only** (ACE is authoritative, applies from server velocity via `WeenieObject.cs:236`).

#### Holtburger current state: SOLID (one intentional visual divergence)

Math/physics/wire = **full parity**: `compute_jump_velocity_z` (`types.rs:800`), `jump_stamina_cost` (`:780`), `compute_fall_damage` (`:753`), `motion_allows_jump` (`:64`). Airborne integrator (`crates/holtburger-core/src/client/movement/system.rs`): `az=-9.8` (`:1793`), 2nd-order step `pos += v_old*dt + 0.5*az*dt²` (`:1796`) then `v += az*dt` (`:1798`), `MAX_VELOCITY` terminal clamp (`:1813`); `GRAVITY=-9.8` at `collision.rs:57`. wasm `SessionCommand::Jump` (`lib.rs:33378`): computes vz, `begin_jump`, deducts stamina, builds `GameAction::Jump` (`0xF61B`), `is_airborne` double-jump gate (`:33408`), `canJumpNow` pre-gate (`lib.rs:22489`). JS spacebar handler (`index.html:8269-8394`): variable-power charge `power=clamp(holdMs/500,0,1)`.

**Gaps:**
1. **Local-player jump arms-up pose — CONFIRMED RETAIL-CORRECT (authoritative; NOT a gap).** holtburger overlays an **arms-up** quaternion tween for the local player (`entities.js setAirborne:3500 / _applyHumanJumpPose:3543`: parts `[10]/[13]` `±π/2` around local X, parts `[1]/[5]` `±π/12`, 200ms, mixer paused). The project owner + Joe Trevis account ("combined jumping/falling animation had arms raised, the X-Play gag") are authoritative — this is how retail actually behaved. It RECONCILES with the decomp: `RemoveLinkAnimations → CPartArray::HandleEnterWorld` (`acclient.c:344483 + 317145`) resets to the **default** jump/fall pose during the arc, and that default pose is itself arms-up. KEEP IT; do not revert (it has wrongly flip-flopped: Wave 1.2 deleted, Wave 1.7 restored — `entities.js:760`; the `lib.rs:33497` "deleted in Wave 1.2" comment refers to an OLD frozen-mixer handler, not this overlay).
2. **Hold-to-power curve `power=clamp(holdMs/500,0,1)` is a documented guess** (`index.html:8261`); retail's `GetPowerBarLevel`/`FinishJump` fill timing not reproduced.
3. **PK detection defaults non-PK** (`PKTimerActive` not tracked, `lib.rs:~33474`).
4. **Remote-player jumps fall back to the MotionTable Falling cycle** (kind=18), not the arms-up overlay (`entities.js:3496`).

### 3. Wire Protocol: RawMotionState (C2S) vs InterpretedMotionState (S2C)

AC movement is carried by **two distinct on-wire structures** that share a flags-word scheme but differ in field width, bit layout, and direction.

> **CRITICAL GOTCHA:** the SAME logical command fields are **4-byte DWORDs** in RawMotionState (full `0x8000003D`-style values) but **2-byte LOWORDs** in InterpretedMotionState (low-16 index). Mixing these silently desyncs the entire stream.

#### RawMotionState (C2S, inside GameAction MoveToState 0xF61C)

Layout (`acclient.h:46474-46488`, Pack `acclient.c:332970`, UnPack `:333117`; holtburger `types.rs:445-571`):

| Flag bit | Field | Wire width | Default (when absent) |
|---|---|---|---|
| 0 | current_holdkey | u32 | 1 |
| 1 | current_style | u32 | `0x8000003D` (NonCombat) |
| 2 | forward_command | u32 | `0x41000003` (Ready) |
| 3 | forward_holdkey | u32 | 0 |
| 4 | forward_speed | f32 | `1.0` |
| 5 | sidestep_command | u32 | 0 |
| 6 | sidestep_holdkey | u32 | 0 |
| 7 | sidestep_speed | f32 | `1.0` |
| 8 | turn_command | u32 | 0 |
| 9 | turn_holdkey | u32 | 0 |
| 10 | turn_speed | f32 | `1.0` |
| 11-15 | num_actions (5-bit) | — | `(flags>>11)&0x1F` |

Then `num_actions × PackedMotionCommand` (8 bytes each). **Every present field is a full 4-byte value** (`acclient.c:333047/333052/333067/333082` write `*(_DWORD*)`). **NOT self-aligned** (its enclosing MoveToState action aligns afterward).

#### InterpretedMotionState (S2C, inside MovementData/UpdateMotion 0xF74C)

Layout (`acclient.h:46491-46500`, Pack `acclient.c:333310`, UnPack `:333445`; holtburger `types.rs:226-381`):

| Flag bit | Field | Wire width |
|---|---|---|
| 0 | current_style | u16 LOWORD |
| 1 | forward_command | u16 LOWORD |
| 2 | forward_speed | f32 |
| 3 | sidestep_command | u16 LOWORD |
| 4 | sidestep_speed | f32 |
| 5 | turn_command | u16 LOWORD |
| 6 | turn_speed | f32 |
| 7-11 | num_actions (5-bit) | `(flags>>7)&0x1F` |

**Pack order:** the four 2-byte command LOWORDs FIRST (`acclient.c:333375-333392`), THEN the three speed floats (`:333393-333407`), then `num_actions × PackedMotionCommand`, then **zero-pad to 4-byte boundary** (`:333425`). UnPack reconstructs each 2-byte index to full 32-bit via `command_ids[]` (`:333479`). Defaults: `current_style=0x8000003D`, `forward_command=0x41000003`, speeds `1.0`.

#### PackedMotionCommand / MotionItem (fixed 8 bytes)

`u16 command` (LOWORD MotionCommand) + `u16 packed_sequence` (bits 0-14 = ServerActionSequence `&0x7FFF`, bit 15 = autonomous) + `f32 speed`. Pack `acclient.c:333099-333108` (`v19 = seq&0x7FFF; if autonomous v19 |= 0x8000`); UnPack `:333270-333271`. holtburger `MotionItem` (`types.rs:383-442`): `sequence()=packed_sequence&0x7FFF`, `is_autonomous=(packed_sequence>>15)==1`.

> **GOTCHA:** `packed_sequence` bit15 (per-command autonomous) is **distinct** from the MovementData-header `Autonomous` field (whole-message). Both exist, different meaning.

#### MovementData union header + type dispatch (S2C SetObjectMovement / UpdateMotion 0xF74C)

`MovementManager::unpack_movement` (`acclient.c:339491-339627`). Header: `ObjectMovementSequence u16`, `ObjectServerControlSequence u16`, `Autonomous`, then a **16-bit word = movement_type(low byte) | option_flags(high byte)**, then `stance u16` (decoded via `command_ids_0[]`). Type dispatch (low byte):

| Type | Name (retail/holtburger) | Body |
|---|---|---|
| 0 | Invalid | InterpretedMotionState `[+u32 stickyObject if option&1]`; `standing_longjump = typeword & 0x200` |
| 1-5 | (e.g. 2=InterpretedCommand) | InterpretedMotionState / none |
| 6 | MoveToObject | `u32 target + Position::UnPackOrigin + MoveToParams(28B) + f32 run_rate` |
| 7 | MoveToPosition | `Origin + MoveToParams(28B) + f32 run_rate` |
| 8 | TurnToObject | `u32 target + f32 desired_heading + TurnToParams(12B)` |
| 9 | TurnToHeading | `TurnToParams(12B)` |

Option flags: `0x01`=StickToObject, `0x02`=StandingLongJump. `standing_longjump` derived as `(typeword & 0x200)` = option-byte bit1 (`0x02`); reading the two bytes separately yields identical little-endian bytes (equivalent, conceptually different).

ACE/holtburger header variant (`GameMessageUpdateMotion` shape): autonomous as **1 byte + 4-byte align** before the type byte, with `guid + instance_seq` prefix (holtburger `messages/movement/messages/motion.rs:47-51`). This differs from chorizite's bare `MovementData::Read` (`autonomous` as u16). Both are observed (object-physics-desc embed vs standalone UpdateMotion).

#### MotionCommand high-bit encoding & the chorizite divergence

MotionCommand is 32-bit: top byte = category (`Style=0x80000000`, `SubState=0x40000000`, `Modifier=0x20000000`, `Action=0x10000000`), low bits = index (ACE `CommandMasks.cs:8-16`). Stances are Style commands: `NonCombat=0x8000003D`, etc. **Retail/ACE/holtburger keep the `0x80000000` prefix**; chorizite strips it (`StanceMode.HandCombat=0x3C`). holtburger `MotionStance` (`types.rs:71-105`) keeps `0x8000003C..0x8000013C` and provides `interpreted()=(val&0xFFFF)` + `from_interpreted(u16)=0x80000000|val`.

> **CANONICAL = retail/ACE.** chorizite is **doubly wrong on RawMotionState**: it strips the high bits AND reads command fields as `ReadUInt16` where retail writes 4 bytes.

#### Chorizite bugs (use holtburger/retail, not chorizite, for RawMotionState)

| Bug | chorizite | Correct (retail) |
|---|---|---|
| RawMotionState command width | `ReadUInt16` (`RawMotionState.generated.cs:96/99/108/117`) | 4-byte DWORD (`acclient.c:333152/333161`) |
| RawMotionState count mask | `(Flags>>11)&0xF8` | `(flags>>11)&0x1F` (5-bit, `acclient.c:333240`) |
| InterpMotionState count mask | `(Flags>>7)&0x7F` (`InterpertedMotionState.generated.cs:28`) | `&0x1F` (`acclient.c:333542`) |
| Stance high bit | stripped to `0x3C` | `0x8000003C` |
| Top-end stance values | AtlatlCombat=`0x138`, ThrownShieldCombat=`0x139` (`StanceMode.generated.cs:46-48`) — **off-by-3, NOT a clean low-16 strip** | canonical `0x8000013B/0x8000013C` (ACE `MotionStance.cs:26-27`); holtburger `types.rs:91-92` correct |
| MovementType 0x09 name | TurnToPosition | TurnToHeading (`acclient.h:2867`) |
| MovementType coverage | declares only `{0,6,7,8,9}` | full 0-9 (`acclient.h:2856`); melt+holtburger full |

#### Opcodes & JS rig dispatch (holtburger)

- S2C: `UpdateMotion = 0xF74C` (`opcodes.rs:73`).
- C2S GameAction inner: `MoveToState = 0xF61C` (`:494`), `Jump = 0xF61B` (`:496`), `AutonomousPosition = 0xF753`, `AutonomyLevel = 0xF752`.
- `MoveToStateActionData` (`actions.rs:9-70`): `RawMotionState + WorldPosition + 4×u16 sequences + contact_long_jump byte + align4`.
- `JumpActionData` (`actions.rs:72-139`): `f32 extent + Vector3 velocity(x,y=planar, z=jump vz) + 4×u16 sequences + u32 object_guid + u32 spell_id`.

> **NOTE — JumpActionData ≠ retail JumpPack.** The retail client's internal `JumpPack` (`acclient.h:54020`, Pack `acclient.c:324068`) carries `extent + velocity + full Position + 4 u16 timestamps`. The ACE/holtburger `GameAction::Jump` form carries `extent + velocity + 4 sequences + guid + spell_id`. **ACE is the server → the ACE/holtburger form is canonical for this stack.** (Byte order not yet packet-verified against a captured 0xF61B — flagged open.)

JS consumption: parsed `UpdateMotion` surfaces as kind=5 `setMotion(guid, motionCommand, motionStance, motionSpeed)` (`entities.js:4358-4441`) driving the rig. `stance=0` = "keep current stance" (preserved as `inst.lastStance`). Low-16 `CMD_LOW_*` constants (`Ready=0x3, WalkForward=0x5, RunForward=0x7, TurnRight=0xD`, `entities.js:357-383`) feed `classifyMotionCommand`. `?deadReckon=on` for remote smoothing.

#### Holtburger current state: SOLID (retail-faithful, strictly more correct than chorizite)

Full implementation in `crates/holtburger-protocol`: `MovementType` 0-9, `MotionStance` with full high-bit values + `interpreted()/from_interpreted()`, InterpretedMotionState (7 presence flags, u16 commands, f32 speeds, align-4), RawMotionState (**correctly 4-byte u32 commands** — fixes chorizite), `MotionItem` 8-byte, `MovementEventData` union + per-type bodies, `MoveToParameters` (28B) / `TurnToParameters` (12B), round-trip parity tests (`test_move_to_state_fixture`, `test_jump_data_fixture`, `actions.rs:237-295`).

**Gaps (none affect current movement-animation behavior):**
1. Count fields unmasked: `num_commands=(raw_flags>>7)` (`types.rs:248`) and `command_list_length=(packed_flags>>11)` (`:467`) do NOT apply retail's `&0x1F`. Benign (servers never set upper bits; flags masked `&0x7FF`) but looser than acclient.
2. No `command_ids[]` full-32-bit reconstruction on inbound InterpretedMotionState — holtburger keeps raw low-16. Fine for animation (JS keys on low-16); means high-fidelity round-trip of the full MotionCommand isn't preserved inbound.
3. Header framing: holtburger uses ACE `is_autonomous` byte+align4 (not chorizite u16). Matches ACE message framing, passes its own fixtures.
4. Outbound Jump animation broadcast not wired (`JUMP=0x003b`/`JUMP_UP=0x004b` constants exist; local jump uses only `0xF61B` + ballistic Z arc; `types.rs:131-156`). Whether `JumpUp` is held for the whole arc or only at peak is unknown pending retail capture.

**Parity verdict:** HIGH. The two structures, presence bitfields, the critical Raw=4-byte vs Interp=2-byte command width distinction, PackedMotionCommand 8-byte layout, sequence/autonomous bit packing, union type dispatch, option-flag stickyObject/standing-longjump, and stance high-bit retention all match retail. holtburger is **more correct than chorizite** on RawMotionState width, stance high-bit, AND the top-end stance values.

### 4. Data Layouts (DAT-side)

**MotionData** (MotionTable cycle/link entry; MELT `MotionData.cs:9-31`, holtburger `motion_table.rs:161-198`):
`numAnims:u8` (count, not stored) → `Bitfield:u8` → `Flags:u8` (MotionDataFlags; bit HAS_VELOCITY, HAS_OMEGA) → **align to 4-byte boundary** → `Anims: AnimData[numAnims]` → if HAS_VELOCITY: `Velocity:Vector3` (3×f32=12B) → if HAS_OMEGA: `Omega:Vector3` (12B). **Fixed order; velocity precedes omega; both flag-gated.** holtburger matches byte-for-byte incl. `align_boundary(reader,4)` (`:174`) and flag-gated reads (`:181/:185`).

**AnimData** (per-anim ref inside `MotionData.Anims`; holtburger `motion_table.rs:200-217`, ACE `AnimData.cs:3-18`):
`AnimId:u32` + `LowFrame:i32` + `HighFrame:i32` + `Framerate:f32` = **16 bytes LE, fixed order**. `Framerate` is the authored playback rate, scaled by `speed` at runtime (`AnimData.cs:17` `Framerate = base*speed`).

**InterpretedMotionState (runtime, retail/ACE — drives get_state_velocity):**
`current_style:uint`, `forward_command:uint` (RunForward=`1140850695`/`0x44000007`, WalkForward=`1157627909`/`0x45000005`), `forward_speed:float`, `sidestep_command:uint` (SideStepRight=`1694498831`/`0x6500000F`), `sidestep_speed:float`, `turn_command:uint`, `turn_speed:float`. `CMotionInterp` adds `my_run_rate:float` + `current_speed_factor:float` (default `1.0`). `CMotionInterp` is `0x88` bytes (`acclient.h:31407`, Create `:344526`); jump-relevant fields `standing_longjump:int` + `jump_extent:float`.

---

## Deep-Dive Plan & Ranked Targets

This plan synthesizes the verified animation deep-read into prioritized, buildable engineering targets for holtburger-web. The DAT/wire-format layer is at full retail parity across the board; **every remaining gap is in the JS render runtime or in plumbing data that already exists in wasm but is dropped before it reaches three.js**. Targets are ranked by value-per-effort, leading with two ~2-line fixes that resolve user-visible defects.

---

### T1 — Velocity-scaling / anti-ice-skating: flip the wired-but-disabled path on (HIGHEST VALUE)

**(a) What's broken/missing.** Locomotion clips play at a fixed framerate (`setEffectiveTimeScale(1.0)`) while the entity travels at a different ground speed, so feet slide ("ice-skating") for backpedal, encumbrance, run-skill, and run-vs-walk gait. The entire anti-ice-skating path is **already fully implemented and unit-tested** but gated OFF behind `?velScale=on` (`entities.js:310` `VEL_SCALE_ON`), so out-of-the-box gait still ice-skates.

**(b) Retail-correct behavior + refs.** Retail couples playback framerate to ground speed via the shared `speed` scalar: ACE `add_motion` does `SetVelocity(velocity*speed)` AND `AnimData.Framerate = base*speed` so feet stay planted (`MotionInterp.cs`; retail `get_state_velocity` / `Framerate=base*speed`). Ground speed itself is `forward_command/forward_speed × {RunAnimSpeed 4.0 | WalkAnimSpeed 3.1199999 | SidestepAnimSpeed 1.25} × run_rate`, clamped to `run_rate × 4.0` — hardcoded anim-speed constants, **not** a runtime division by `|MotionData.velocity|`. Constants verified bit-exact: `WalkAnimSpeed 3.1199999`, `RunAnimSpeed 4.0`, `Sidestep 1.25`, `RunTurn 1.5`, `MaxSidestep 3.0`.

**(c) Files/functions to change.**
- `apps/holtburger-web/scene3d/entities.js:310` — flip `VEL_SCALE_ON` default to true (gate behind a kill-switch `?velScale=off` instead).
- `apps/holtburger-web/scene3d/entities.js:4324` `_resolveCycleBaseSpeed` + `_cycleBaseSpeedCache`, and the `tick()` composition `cycleTimeScale(emaGroundSpeed, base) * inst._motionSpeed → setEffectiveTimeScale` (already wired).
- `apps/holtburger-web/scene3d/animation.js:241` `cycleTimeScale` (clamp `[0.25, 4.0]`).
- `apps/holtburger-web/src/lib.rs:4680` `cycleBaseSpeed` (returns `|MotionData.velocity|` — keep, but see (d)).

**(d) Dependencies.**
1. **New wasm getter mirroring `get_state_velocity`** so the "actual ground speed" fed to `cycleTimeScale` comes from the motion-state model, not rendered XZ position deltas (`entities.js:6825` `hypot(dx,dz)/dt` + EMA reads garbage during server-pose snaps / teleports / rubber-banding; the clamp mitigates but doesn't fix). New getter computes `forward_command/forward_speed × anim-constant × run_rate`, clamped to `run_rate × 4.0`.
2. **Run-rate plumbing**: wire `holtburger-world` `run_rate_from_skill_and_burden` (`context.rs:57-64`, already ports ACE `GetRunRate` incl. the `18/4` cap and burden modifier) into the render velScale path so encumbrance/run-skill modulate gait.
3. **Resolve the T11 blocker first**: confirm the live player MotionTable's `RunForward` cycle actually carries `HAS_VELOCITY` — the prior T11 audit found `cycleBaseSpeed(playerMT, stance, RunForward) == 0`, which makes `cycleTimeScale` a 1.0 no-op even with the flag on. If `|velocity|` is 0/unreliable for player cycles, implement ACE's `GetAnimDist` (`Σframe.Origin` then `.Length()` after the loop — magnitude-of-vector-sum, **not** sum-of-magnitudes; `÷ totalFrames × Anims[0].Framerate`) as the authored-speed source and cache per-MotionTable like ACE's `WalkSpeed/RunSpeed`.

**(e) Effort.** Medium. The flip + EMA-source swap is ~1 day; the new `get_state_velocity` wasm getter + run-rate wiring is ~2-3 days. The T11 data-confirmation (which authored-speed source) must precede the getter or the whole path stays inert.

**(f) Verification.** Dump the live Holtburg player MotionTable; compare `cycleBaseSpeed` (`|velocity|`) vs `GetAnimDist` for `RunForward`/`WalkForward` to settle whether `HAS_VELOCITY` is set and which source to trust. Then a 1070 eye-test (`?velScale=on`, wire-agent, `nullRender` for the headless numeric check) of backpedal / encumbered / run-skill gait: measure foot-contact-point world drift across a stride against ground travel; tune the `[0.25, 4.0]` clamp + EMA constants; flip the default and remove the gate. Add a parity test driving the Rust `common.rs` speed model against the ACE `MotionInterp` oracle across `{Walk,Run}×{Forward,Backstep,SideStepL/R,TurnL/R}` to lock the `3.12/4.0/1.5/0.5/0.65/±3.0` constants end-to-end.

---

### T2 — Transparent hook opacity-inversion bug (HIGH VALUE, ~2-LINE FIX)

**(a) What's broken.** A `Transparent`/`TransparentPart` hook fading translucency `0→1` (fade to **invisible** in retail) renders as `opacity 0→1` (fade **IN**) in holtburger — backwards. Confirmed: `entities.js:7793` sets `material.opacity = value` directly, with no `1 - value`.

**(b) Retail-correct behavior + refs.** Retail `Transparent` hook value is **translucency**, and final material alpha `= 1.0 - value` (retail `SetTranslucencySimple`, `acclient.c:360598`). Holtburger's own **static-surface path already does this correctly** (`materials.js:1836` `opacity = 1 - translucency`) — only the dynamic hook path is wrong, so this is an internal inconsistency, not an ambiguity.

**(c) Files/functions.** `apps/holtburger-web/scene3d/entities.js:7793` `_applyRampValueToMaterial` — for `hookType === 20 || hookType === 7`, set `material.opacity = 1 - value` and `material.transparent = value > 0`.

**(d) Dependencies.** None. Wire parsing, the lerp formula `v = start + (end-start)*t`, and clone-on-write (`_getOrCloneEntityMaterial`) are all already correct.

**(e) Effort.** Trivial (~2 lines).

**(f) Verification.** In-game eye-test of a fade-OUT animation (dissipating spell or creature-death dissolve): confirm the object becomes invisible, not opaque, as the ramp completes. Cross-check against the static-surface path on the same surface DID.

---

### T3 — Multi-segment cycle timing: pass `frameTimes`/`duration` through the clip loader (HIGH VALUE, ~2-LINE FIX)

**(a) What's broken.** The production loader at `animation.js:572` calls `buildAnimationClip({partCount, numFrames, framerate, partFrames, posFrames})` and **does not pass `frameTimes` or `duration`** (confirmed). The clip falls through to uniform `times[f] = f*(1/framerate)` using an **averaged** framerate (`num_frames/duration`, `lib.rs:13718`). Single-segment cycles (idle/walk/run/Ready — the common case) are exact, but multi-segment cycles (~23% of retail: swing windup→strike→recover→settle, casts) play every segment at the clip-average rate instead of its own per-segment rate. The correct per-segment path (`animation.js:115-134`) and the wasm `frameTimes`/`duration` getters already exist and are simply discarded.

**(b) Retail-correct behavior + refs.** Each `AnimData` segment has its own framerate; retail `CSequence::update_internal` advances `frame_number` per-segment at that segment's `framerate*quantum`. The Rust bake (`build_concatenated_motion_frames`, `lib.rs:4780`) already produces correct per-frame absolute `frame_times` + `total_duration`; only the JS loader drops them. Discrete snapping (`InterpolateDiscrete`, `animation.js:189,197`) is already retail-correct (`(long)floor(frame_number)`, never lerp).

**(c) Files/functions.** `apps/holtburger-web/scene3d/animation.js:572` — change the first arg to `{ partCount, numFrames, framerate, partFrames, posFrames, frameTimes: animData.frameTimes, duration: animData.duration }`.

**(d) Dependencies.** None — `animData.frameTimes` (`lib.rs:13372`) and `animData.duration` (`lib.rs:13388`) getters exist on the wasm object.

**(e) Effort.** Trivial (~2 lines), but requires the verification below because the `frameTimes` path is **never exercised in production today**.

**(f) Verification.** A/B on the 1070 with an actual multi-segment clip (melee swing windup→strike→recover→settle, or a magic cast) comparing uniform-vs-`frameTimes` timing. **Confirm three.js `InterpolateDiscrete` with non-uniform `times` still snaps to the last-passed key correctly** (it should, but this path is unverified). First audit which in-game motion commands are multi-segment vs single-segment to size impact — idle/walk/run/Ready are likely single-segment, so the bug is currently latent.

---

### T4 — Per-part particle anchoring for entity rigs (MEDIUM VALUE)

**(a) What's broken.** `CreateParticle.part_index` is parsed and threaded through `addEmitter → setParenting`, but `particle_emitter.js:336` anchors to `parent.partFrames[partIndex]`, which is `undefined` on the entity rig (`inst.root` is a `THREE.Group` with no `partFrames`; that name only exists as a `Float32Array` inside `animation.js` clip-baking). Every non-root `part_index` silently falls back to root-anchoring with only the static `parentOffset` — emitters meant for a limb/weapon-tip/forge attach to the model origin instead. (`0xFFFFFFFF` → root is handled correctly; the gap is any other index.)

**(b) Retail-correct behavior + refs.** Retail anchors the emitter to the named part's world frame via the child-part lookup (`acclient.c:320378`); `CPartArray::UpdateParts` gives each part an absolute model-space world frame.

**(c) Files/functions.** `apps/holtburger-web/scene3d/particles/particle_emitter.js:336` (the `partFrames` fallback) and `entities.js:8016` / `:6166` (`_fireCreateParticleHook`, part_index→-1 mapping). Give the entity parent a `partFrames`-like accessor mapping `partIndex → inst.parts[partIndex]` world position/quaternion so the resolve succeeds instead of falling back.

**(d) Dependencies.** Needs the per-part `THREE.Group` world matrices (`inst.parts[partIndex]`, already built at `entities.js:1981-2038`) exposed to the emitter parenting path.

**(e) Effort.** Medium (~0.5-1 day).

**(f) Verification.** GPU/headless eye-test on the 1070: spawn an entity whose `CreateParticle` hook carries a non-root, non-`0xFFFFFFFF` part_index (forge embers, weapon-tip trail) and confirm the emitter is on the limb, not the origin. Add a per-LB wire-agent diag counting emitters whose resolved anchor `!= root`.

---

### T5 — Ethereal hook: remove the false retail citation (LOW EFFORT, CORRECTNESS HYGIENE)

**(a) What's broken.** Holtburger applies `opacity = 0.4` for `Ethereal` (`entities.js:7825`) with a code comment citing a non-existent retail `set_translucency_internal(0.4f)`.

**(b) Retail-correct behavior + refs.** Retail `set_ethereal` (`acclient.c:319047`) only flips collision-state bit `0x4` and **never touches opacity**. Any visual is a client invention.

**(c) Files/functions.** `apps/holtburger-web/scene3d/entities.js:7825` `_applyEtherealToEntity` — correct or remove the comment; decide whether to keep the `0.4` hint at all. If kept, document it as a deliberate client invention.

**(d) Dependencies.** None.

**(e) Effort.** Trivial.

**(f) Verification.** Eye-test that ethereal objects still read as "ghosted" if the hint is kept; no behavioral test needed since retail shows no visual change.

---

### T6 — CallPES randomized delay (LOW VALUE, SMALL FIX)

**(a) What's broken.** `CallPES` uses a fixed `setTimeout((start_time+pause)*1000)` (`entities.js:7351`), not retail's randomized delay.

**(b) Retail-correct behavior + refs.** Retail rolls a **uniform random** duration `Random::RollDice(0, pause)` (`acclient.c:318987`) driving a `0→1` FPHook, firing the sub-script only on interp completion; `pause` is a **max window**, not a fixed wait. With `delta < 0.0002` it fires immediately.

**(c) Files/functions.** `entities.js:7351` (`_attachParticleChainForEntity` CallPES branch).

**(d) Dependencies.** None (reuse `time_rng.js`, accepting `Math.random` non-determinism).

**(e) Effort.** Small. Applies to ~354 CallPES-carrying scripts.

**(f) Verification.** Visual: confirm sub-script spawn jitter (e.g. staggered ambient effects) varies per-fire instead of firing in lockstep.

---

### T7 — Decode the two MotionData bitfield bits (LOW VALUE, FOOTGUN REMOVAL)

**(a) What's missing.** `MotionData.bitfield` is parsed as a raw `u8` but never read for behavior. Bit0 (`&1`) = `clears_modifiers`; bit1 (`&2`) = `is_allowed` gate. 50/436 tables (11.5%) set bit0.

**(b) Retail-correct behavior + refs.** Bit0 wipes held modifiers on cycle entry; bit1 gates whether a cycle is enterable from the current substate (`acclient.c:337724/337568`; ACE `MotionTable.cs`). `docs/motion-table-acclient-audit-2026-05-19.md:455` already recommends accessors.

**(c) Files/functions.** `crates/holtburger-dat/src/file_type/motion_table.rs` — add `clears_modifiers()` / `is_allowed_gate()` accessors.

**(d) Dependencies.** None to add the accessors; **consuming** them requires a MotionState mirror (see T9), so ship accessors now, wire later.

**(e) Effort.** Trivial for accessors.

**(f) Verification.** Unit test that the accessors agree with the sweep counts (50/436 set bit0). Behavioral consumption deferred to T9; needs an eye-test on a creature whose MT uses bit1.

---

### T8 — Fix the latent 20-bit motion-key mask (LOW VALUE, FOOTGUN REMOVAL)

**(a) What's broken.** `MOTION_KEY_MASK` in `motion_table.rs:8/228` is `0x000F_FFFF` (20-bit) vs the canonical retail/ACE `0x00FF_FFFF` (24-bit), and is inconsistent with holtburger's own idle path (`lib.rs:5225`, which correctly uses 24-bit). Harmless **today** (largest real low-24 command is `0x19b`) but a footgun for any new lookup or private-server data.

**(b) Retail-correct behavior + refs.** Canonical mask is `0x00FFFFFF` everywhere (Cycles key, `get_link`, `SetDefaultState`). MELT shares the same 20-bit quirk; do not propagate it. Note the separate, **already-correct** rule: the Links **inner** key is the full 32-bit `MotionCommand` (e.g. `SlashHigh=0x1000005B`) and must **not** be masked — `lookupMotionLinkForSwing` correctly bypasses the helper.

**(c) Files/functions.** `crates/holtburger-dat/src/file_type/motion_table.rs:8`.

**(d) Dependencies.** None.

**(e) Effort.** Trivial.

**(f) Verification.** Existing motion-table sweep still passes; add a regression asserting a synthetic `>0x0FFFFF` low-24 substate resolves correctly.

---

### T9 — Port the MotionState state machine (LARGE, DEFER — scope-gate first)

**(a) What's missing.** Holtburger ships **no** `GetObjectSequence` state machine: no `MotionState` (Style/Substate/SubstateMod/Modifiers/Actions), no `re_modify`, no `clear_modifiers`, no LIFO `modifier_head` / FIFO `action_head` queues, no 6-action `TooManyActions` cap, no `is_allowed` gate, no four-clip link-chain composition, no `SetDefaultState`/`StopSequenceMotion`. It renders one cycle clip + optional one-shot link overlay via the three.js mixer, which approximates the visual via concurrent-action weighting.

**(b) Retail-correct behavior + refs.** ACE `MotionTable.cs` `GetObjectSequence` is the cleanest canonical managed reference (1:1 with retail `acclient.c:337641`). Command-class dispatch order is **Style(0x80000000) → SubState(0x40000000) → Action(0x10000000) → Modifier(0x20000000)** — not numeric order. Modifiers are LIFO (prepended), actions FIFO (appended). `re_modify` re-overlays surviving modifiers after every rebuild (how hold-run / cast-pose persists across a walk→run swap). On a substate change where the outgoing substate was itself a Modifier-class command, it's pushed back onto the modifier list (`acclient.c:337814`).

**(c) Files/functions.** New per-entity `MotionState` mirror + a `MotionTable::get_object_sequence` method (Rust, reconciled against server position rather than predicting); consumed by `entities.js setMotion`/`_tryPlayLink`.

**(d) Dependencies.** T7 (bitfield accessors) and T8 (mask) should land first. Also requires `combine_motion`/`subtract_motion` for any kinematic-modifier ("Path B") integration — explicitly documented as low-payoff/high-risk (`motion_table.rs:16-43`).

**(e) Effort.** Large (multi-day to multi-week).

**(f) Verification.** **Scope-gate before building.** The server is position-authoritative and the single-cycle + one-shot-link approach is intentional; this only matters under rapid action-queueing, held-modifier-through-cycle-swap, or stance-change-clears-modifiers edge cases. A **minimal** subset — a per-entity `modifier_head` LIFO + bit0 clear-on-stance-change + `re_modify` — would close the highest-value edge case (held aim/cast pose surviving a cycle swap) for a fraction of the cost; prefer that over the full port. Validate any port against the ACE `MotionTable.cs` oracle across the full command matrix.

---

### Deliberate non-retail choices to leave alone (do NOT "fix")

- **Jump arms-up overlay** (`entities.js:3500/3543`): **CONFIRMED RETAIL-CORRECT and authoritative** (project owner + Joe Trevis account). It reconciles with the decomp — the **default** jump/fall pose that `RemoveLinkAnimations → HandleEnterWorld` restores during the ballistic arc is itself arms-up (`0x2500003B` is a recognized MotionCommand but no table keys a clip to it, so the body arcs in that default pose). KEEP IT; do not revert. It has wrongly flip-flopped (Wave 1.2 deleted, Wave 1.7 restored) — see MEMORY `feedback_jump_arms_up_deliberate`. The jump **math/physics/wire** (`compute_jump_velocity_z`, `g=9.8`, `v=sqrt(2gh)`, `0xF61B` packet, double-jump gate, substate jump-gate ranges) is also at full parity.
- **Sequence velocity/omega not baked into local poses**: parity-neutral; retail applies it to the object frame in physics, not local poses. Leave to the network/movement path.
- **TextureVelocity scoped per-entity** (vs retail's global per-gfxobj scroll): arguably better, not bit-identical — acceptable.
- **Wire-format / DAT parsing** (MotionTable, Animation 0x03, AnimationHook, RawMotionState/InterpretedMotionState, ParticleEmitterInfo 0x32, PhysicsScript 0x33, SetupModel 0x02): all at full validated retail parity; holtburger is **more correct than chorizite** on RawMotionState field width (4-byte DWORD, not u16) and stance high-bit retention. No work needed.
- **Flat root-parented part rig** (`entities.js:2037`): retail-correct — AnimFrames are absolute model-space; `parent_index` is attachment metadata, not transform composition. Building a bone tree from it would double-apply transforms. Do not "fix."

---

### Suggested execution order

1. **T2** (Transparent inversion) + **T3** (multi-segment timing) + **T5** (Ethereal comment) — three near-zero-cost fixes, ship together behind one eye-test pass.
2. **T1** (velocity-scaling) — the flagship; gate-resolve the T11 authored-speed question, add the `get_state_velocity` wasm getter, wire run-rate, flip the default.
3. **T4** (per-part particle anchoring) — once T1's per-part world matrices are confirmed available.
4. **T7** + **T8** (bitfield accessors + mask) — footgun removal, land before any T9 work.
5. **T6** (CallPES jitter) — opportunistic.
6. **T9** (MotionState machine) — **scope-gate first**; prefer the minimal modifier-LIFO + `re_modify` subset over the full port unless an edge-case defect is demonstrated.

---

## Appendix — Completeness Critic

### Coverage gaps (subsystems no topic covered)

- MotionKinematics (DAT, holtburger/core namespace, motion_kinematics.rs) is a SEPARATE per-(stance,command) velocity/omega source that is parsed and loaded into the asset catalog (lib.rs:25540) but NOT covered by any topic. It is directly relevant to the velocity-iceskating topic: it is an alternate authored-speed source to MotionData.velocity, and it carries the SAME 0x000F_FFFF 20-bit MOTION_KEY_MASK (motion_kinematics.rs:10) the lookup topics flag as a footgun. No topic resolves whether cycleBaseSpeed should read MotionData.velocity OR MotionKinematics.cycle_kinematics — a real fork the ice-skating fix depends on.
- CombatManeuverTable (DAT type 0x30, combat_maneuver_table.rs) maps (MotionStance, AttackHeight, AttackType) -> the MotionCommand the client animates on attack, and IS consumed live (picking.js:673/823 getCombatManeuver -> setMotion). This is the actual selection mechanism for WHICH swing/cast clip plays, yet no topic covers it — the hooks/csequence/motiontable topics all assume the command is already known. The aim-level bypass (Creature_Missile.cs::GetAimLevel, combat.js:294) for ranged stances is also uncovered.
- ChatPoseTable (0x0E000007, chat_pose_table.rs: chat_pose_hash + chat_emote_hash->ChatEmoteData) drives emote/pose animation selection (the soul-emote / /dance / chat-pose path). entities.js has EMOTE_COMMANDS/REACTION_COMMANDS buckets (motion.js:376) but no topic covers how a typed emote string resolves to a MotionCommand via ChatPoseTable.
- Animation crossfade/blend policy is a deliberate, load-bearing decision (CROSSFADE_S=0, entities.js:720; 'retail AC never crossfaded between motions', entities.js:709) that no topic states as a finding. The csequence-playback and stance-modifier topics discuss discrete frame interpolation but never the clip-to-clip transition (hard-cut vs blend) — a retail-parity claim that should be flagged and is unverified against retail.
- Remote-entity HEADING easing / dead-reckoning (Path-A bounded slerp, DEFAULT-ON, entities.js:161-176 HEADING_EASE_EPSILON; ?deadReckon=on) is the actual mechanism by which remote players' rendered rotation is smoothed. The motion-interp topic mentions 'Path-A heading interpolation' in passing but never analyzes it as its own system, its parity, or its interaction with turn-cycle foot-slide (which the velocity topic leaves unhandled).
- Dynamic entity LOD / GfxObjDegradeInfo for the rig (degrade_info.rs GfxObjDegradeInfo; ?dynLod=on, entities.js:321; spawn-time LOD frozen at entities.js:1595). The rig that animations play on can be a degraded LOD mesh — no topic covers whether part-count/part-index alignment survives LOD substitution, which directly threatens the animation-format/setup-skeleton positional-part-mapping invariant (AnimationFrame.frames[i] <-> SetupModel parts[i]).
- ObjectDesc / ClothingTable (object_desc.rs, clothing.rs DAT 0x10) part-and-texture substitution (AnimPartChange / TextureMapChange / subpalettes) — Creature.CalculateObjDesc (entities.js:3354) and applyAppearance (entities.js:4919). The setup-skeleton topic mentions 'AnimPartChange model substitutions' inside walk_setup_parts but no topic covers the full ObjDesc-driven part-swap path, whether a swapped part keeps its animation-frame index, or the despawn+respawn vs hot-swap (?clothingHotSwap=1) appearance-change path's animation continuity.
- PlayScript / EffectId broadcast effects (play_effect_vfx.js, 170/174 IDs shipped) — the GameMessage-driven one-shot visual effects (PortalStorm, LevelUp, spell-fizzle, etc.). These are animation-adjacent client visuals distinct from the per-AnimFrame AnimationHook and the 0x33 PhysicsScript paths; no topic covers their selection or playback model or how they compose with the entity rig.
- MovementParameters.bitfield (18 flags can_walk..disable_jump_during_link, acclient.h:31423) is named in the motion-interp gotchas as 'two bitfields named alike' but its 18 movement-capability flags (can_walk/can_run/can_fly/sticky/etc.) and their effect on which motions are even attemptable are never analyzed by any topic.
- Sound/audio animation coupling beyond the hook level: the hooks-effects topic covers Sound(1)/SoundTable(2)/SoundTweaked(21) firing, but the SoundTable (0x07) resolution model (SoundType enum -> Wave DID via the object's CSoundTable) — the indirection that makes a SoundTableHook work — is treated as a gotcha, not analyzed as its own animation-driven subsystem.

### Refuted / corrected claims to flag

- JUMP IS NOT 'NEVER SEEN' IN RETAIL: the claim that 0x2500003B never appears in acclient.c is wrong — it appears as decimal 620757051 in the MotionCommand enum and in the jump dispatch at MovePlayer_NonAutonomous (acclient.c:717673). The accurate, still-supporting statement is: it is a recognized MotionCommand but NO motion-table keys an animation CLIP to it (436/436 empty). Flag loudly so no one 'proves' jump-is-velocity-driven via a false grep-returns-zero premise.
- ANIMATION 0x03 WIRE LAYOUT OMITS THE LEADING ID DWORD: the motiontable-refuted note corrects that retail MotionData::UnPack reads the 4-byte dictionary key (id) BEFORE numAnims/bitfield/flags; ACE/MELT/holtburger read that key in the container loop instead. The streams are equivalent but the cited retail byte range begins with an id-DWORD the stated layout omits — important for anyone byte-diffing a fixture.
- '20-BIT MASK IS THE ONLY RETAIL/ACE/MELT DIVERGENCE' IS INCOMPLETE: ACE also has an independent Action-branch numAnims counting bug (MotionTable.cs:227 reads motionData.Anims.Count instead of motionData_.Anims.Count), and the 20-bit mask is not uniformly applied (both MELT and holtburger also use 24-bit in sibling paths). Two divergences, not one — and the same 20-bit mask recurs in the uncovered MotionKinematics parser.
- GetAnimDist IS VECTOR-SUM-THEN-MAGNITUDE, NOT SUM-OF-MAGNITUDES: ACE GetAnimDist accumulates offset += frame.Origin across frames THEN takes offset.Length() (MotionTable.cs:582/586). For curved root-motion paths this is numerically different from sum-of-per-frame-magnitudes. Anyone implementing GetAnimDist as a speed source (a candidate for the ice-skating fix) must use the vector-sum form or get the wrong speed on curved cycles.
- ETHEREAL HOOK CHANGES NO VISUALS IN RETAIL: retail set_ethereal (acclient.c:319047) only toggles collision state bit 0x4; holtburger's 0.4-opacity hint cites a non-existent retail set_translucency_internal(0.4f). The visual is a client invention, not a port — the false citation should be corrected so it isn't trusted as retail behavior.
- FPHook hook_type IS A BITFIELD (CSetup=1/MTABLE=2/VELOCITY=4), NOT an AnimationHookType wire id: process_fp_hook switches on the 0-7 combination (e.g. CallPES path = VELOCITY|MTABLE|CSetup=7). Easy to conflate with the 27-type wire enum; the names are repurposed dispatch tags, not semantic velocity/motiontable/setup meanings.

### Unresolved questions

- Which authored-speed source is canonical for the ice-skating fix: MotionData.velocity (current cycleBaseSpeed), ACE GetAnimDist (vector-sum-then-magnitude of PosFrame origins / totalFrames * Framerate), OR the separately-parsed-but-unwired MotionKinematics.cycle_kinematics? Three candidate sources, no topic reconciles them, and the earlier T11 failure (RunForward cycleBaseSpeed==0 for the player MT) suggests velocity may be empty exactly where it's needed.
- Does the player's actual Holtburg MotionTable RunForward/WalkForward cycle carry HAS_VELOCITY at all? If cycleBaseSpeed returns 0 for the player, the entire velScale anti-ice-skating path is inert even when ?velScale=on is flipped — this is asserted as an open question in two topics but never settled with a DAT dump.
- Why does the production animation.js loader (line 572) drop the wasm frameTimes/duration getters, making the correct per-segment-timing path dead for ~23% of multi-segment cycles? Oversight vs deliberate single-segment assumption is unresolved, and the ~2-line fix is unverified to actually work with THREE.InterpolateDiscrete on non-uniform times (a path never exercised in production).
- RESOLVED — the local-player jump 'arms-up' overlay (entities.js:3543) IS retail-correct (authoritative per project owner + Joe Trevis; the default jump/fall pose is arms-up, consistent with the decomp's `HandleEnterWorld` default-pose reset). Keep it; do not revert. See MEMORY `feedback_jump_arms_up_deliberate`.
- Is the Transparent-hook opacity inversion (entities.js:7793 missing 1-value) an unfixed bug? The static-surface path does opacity=1-translucency correctly (materials.js:1836) but the dynamic hook path does not — a fade-to-invisible animation would render as fade-IN. Needs an in-game eye-test of a dissipating/death animation.
- Does the live ACE server emit RawMotionState command fields as 4-byte DWORDs (as retail acclient.c and holtburger do) or did ACE 'normalize' them like chorizite (2-byte)? The ACE Network serializers are absent from the sparse checkout; only a captured 0xF61C MoveToState packet can confirm holtburger's width choice end-to-end.
- Do per-part particle anchors actually work for any in-game entity? CreateParticle.part_index threads through but particle_emitter.js:336 falls back to root-anchoring because the entity rig exposes no partFrames[] — every non-root emitter (weapon-tip trail, limb effect) silently mis-places to the model origin. Visual impact is unmeasured (needs a GPU eye-test).
- Should holtburger fire Direction==Backward(-1) hooks at all? It re-bakes reverse segments forward and hard-drops -1 hooks (entities.js:7166) — for ~22% of AnimData that are negative-framerate, any backward-gated sound/particle/material hook never fires. Whether retail content relies on backward-direction hooks is unknown.
- Does any holtburger runtime path consume PhysicsScriptTableData::GetScript's mod-threshold intensity picker, or is intensity-tiered script selection bypassed (single pre-resolved physicsScriptDid always used)? Determines if intensity-varying scripted effects render the correct tier.
- Does the MotionKinematics 20-bit mask (motion_kinematics.rs:10) and the MotionTable 20-bit mask (motion_table.rs:8) ever collide with a real >0x000FFFFF substate command? Verified false for retail (max 0x19b) but unverified for any private-server / custom MotionKinematics data that this newer format might carry.

### Critic's ranked targets

- **Wire frameTimes+duration through the production animation loader (animation.js:572) so multi-segment cycle timing (~23% of retail: every swing windup->strike->recover, every cast) plays at correct per-segment rates instead of the clip-average.** _(effort: low (2-line loader change + one 1070 A/B on a real swing/cast clip to confirm InterpolateDiscrete works with non-uniform times))_ — Highest value-to-effort: the correct per-segment path (animation.js:115-134) and the wasm getters ALREADY EXIST and are just not passed in. ~2-line change fixes a divergence affecting nearly a quarter of all cycles, and combat (swings/casts) is exactly the multi-segment case. Lowest-risk, highest-coverage win.
- **Resolve the canonical authored-speed source (MotionData.velocity vs GetAnimDist vs the unwired MotionKinematics.cycle_kinematics) by dumping the actual Holtburg player MotionTable + MotionKinematics for RunForward/WalkForward, then wire the chosen source + run_rate into the velScale path and flip ?velScale=on by default.** _(effort: medium (DAT dump + decide source + wire wasm get_state_velocity-equivalent + run_rate + 1070 eye-test of backpedal/encumbered gait))_ — Ice-skating is a default-visible locomotion defect (gait desync on every player). The fix is blocked on an unanswered data question that NO topic settles and that the newly-surfaced MotionKinematics asset (parsed, loaded, but unwired) bears directly on. Settling the source unblocks the whole anti-ice-skating system and the run-skill/encumbrance gait modulation already ported in context.rs.
- **Settle the local-player jump-pose policy permanently: either match retail (remove arms-up overlay, body arcs in default pose) or document it as a deliberate non-retail choice in MEMORY/CLAUDE so it stops flip-flopping (already deleted in Wave 1.2, restored in Wave 1.7).** _(effort: low if documented-as-deliberate; medium if a real retail capture / SetupModel default-pose dump is required to settle parity)_ — This is churn-generating: it has already been toggled twice by different agents because the evidence is contradictory (decomp says default pose; Trevis quote says arms-up). Every future animation pass risks re-litigating it. A documented decision (with a retail capture if parity is the goal) ends the loop.
- **Fix the Transparent/TransparentPart hook opacity inversion (entities.js:7793: set opacity = 1 - value for hookType 20/7) to match retail SetTranslucencySimple and holtburger's own static-surface path.** _(effort: low (one-line inversion + transparent flag + in-game fade-out eye-test))_ — A concrete, narrow, confirmed-direction bug (the dynamic path contradicts the static path in the SAME codebase). Any fade-to-invisible animation (spell dissipation, creature death) currently plays backwards. Clear fix, clear eye-test.
- **Cover the CombatManeuverTable (0x30) -> swing/cast MotionCommand selection path and the ranged aim-level bypass, since this is the live mechanism (picking.js:673/823) that determines WHICH clip the hooks/csequence/motiontable systems then play.** _(effort: medium (read combat_maneuver_table.rs + ui/ac_combat_maneuver.js + picking.js getCombatManeuver, cross-check vs ACE CombatManeuverTable.cs))_ — All 12 topics assume the MotionCommand is already known and analyze playback downstream of selection. The selection table itself (stance x height x type -> motion, with MinSkillLevel gating and the slider/power index) is uncovered, yet it is the entry point for all combat animation. A gap in the most-played animation category.
- **Audit the rig part-index invariant under dynamic LOD / GfxObjDegradeInfo and ObjDesc/ClothingTable part substitution: confirm AnimationFrame.frames[i] still maps 1:1 to SetupModel parts[i] after a LOD-N mesh swap or a clothing AnimPartChange.** _(effort: medium (trace walk_setup_parts under degrade + ObjDesc substitution; wireframe capture on a multi-part NPC at LOD distance + with a clothing swap))_ — The single most load-bearing animation invariant (positional part mapping, flagged in animation-format AND setup-skeleton) is threatened by two uncovered systems that swap the mesh the animation plays on. A mismatch silently mis-rigs every part — exactly the kind of latent break that eye-tests miss until a specific creature/LOD combination hits it.
- **Fix the latent 20-bit MOTION_KEY_MASK divergence in BOTH motion_table.rs:8 AND motion_kinematics.rs:10 (0x000F_FFFF -> 0x00FF_FFFF) to match canonical retail/ACE and holtburger's own idle path.** _(effort: low (two constant edits + re-run the existing motion-table parse sweep))_ — Cheap footgun removal flagged across multiple topics. Harmless on retail data today (max 0x19b) but inconsistent within the same codebase (the idle path at lib.rs:5225 already uses 24-bit), and the newer MotionKinematics format may carry custom data that trips it. Two-constant change.
- **Cover the emote/pose animation path (ChatPoseTable 0x0E000007 -> MotionCommand) and verify EMOTE_COMMANDS/REACTION_COMMANDS resolution, including the SoulEmote catalog build.** _(effort: medium (read chat_pose_table.rs + the SoulEmoteCatalog build at lib.rs:25492 + entities.js EMOTE/REACTION command sets))_ — Emotes are a whole class of player-visible animation (the soul-emote / chat-pose system) with a dedicated DAT table and JS buckets, entirely unanalyzed. Lower gameplay-criticality than combat/locomotion but a clear completeness gap with a concrete table to ground it.

### Risk notes

- Eye-test debt is systemic: nearly every 'partial' verdict (velScale gait, jump pose, Transparent inversion, per-part particle anchoring, multi-segment timing, Ethereal) bottlenecks on a 1070/GPU eye-test that has NOT been run. The deep dive can recommend fixes but cannot confirm visual parity for any of them without that capture loop — treat 'fix shipped' as distinct from 'fix verified'.
- Default-OFF feature flags hide the real state: ?velScale=on, ?entityLights, ?dynLod=on, ?clothingHotSwap=1, ?deadReckon=on. Anyone assessing 'does holtburger anti-ice-skate / light entities / LOD rigs' will get the WRONG answer from the default render. Critiques and tests must explicitly enable the flag or they measure the inert path.
- Server-authoritative position masks client-animation bugs: because ACE owns position and resolves RunForward-vs-WalkForward + run-promotion before broadcast, many holtburger gaps (no GetObjectSequence state machine, no action queue, no modifier re_modify, single-cycle approximation) are LATENT — they only surface under rapid action queueing, held-modifier-through-cycle-swap, or for REMOTE players (whose rigs are driven verbatim by the JS classifier, NOT the Rust local-prediction layer). Remote-rig parity is the consistently unverified blind spot.
- Stale worktree copies exist (.claude/worktrees/agent-.../scene3d/entities.js + animation.js) that diverge from the canonical apps/holtburger-web copies (different/missing velScale path). Repo-wide grep will surface non-canonical hits; always pin findings to external/holtburger/apps/holtburger-web, not the worktree.
- Newer DAT format MotionKinematics (holtburger/core namespace, version=1) is loaded into the catalog but NOT wired to any render/speed path — it is a parsed-but-dead asset that bears directly on the ice-skating fix and re-introduces the same 20-bit mask footgun. Risk: a future agent wires the wrong speed source, or 'fixes' the mask in motion_table.rs but misses the twin in motion_kinematics.rs.
- ACE is NOT a parity oracle for hook/effect VISUALS (its AnimHook.Execute only implements AnimationDone — hooks are client-visual). Several notes correctly use retail acclient.c for hook effects, but any future cross-check that reaches for ACE on Transparent/Luminous/Diffuse/CreateParticle SEMANTICS will get a near-empty stub and falsely conclude parity. ACE is canonical ONLY for DAT layout, enum constants, and the queue/direction structure.
- DRW dats.xml mislabels are a recurring trap across multiple topics (SoundTweaked float order, CreateParticle EmitterInfoId as <vector>, gfxobj IDs as <vector>, ReplaceObject PartIndex width). holtburger correctly trusts acclient.c over DRW, but this means DRW-derived 'documentation' is actively misleading and must never be used to second-guess a holtburger parser without an acclient.c byte-trace.
