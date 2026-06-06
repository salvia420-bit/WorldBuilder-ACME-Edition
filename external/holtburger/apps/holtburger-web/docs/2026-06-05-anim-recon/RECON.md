# RECON.md — Animation / Motion Subsystem (anim-deep)

**Target:** `/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web`
**Date:** 2026-06-05 · **Sources fused:** holtburger-web (Rust+JS), acclient decomp, ACE server, chorizite, melt (12 recon reports)
**Synthesis verification:** I read the authoritative melt reference (`MotionTable.cs:225-231`), the holtburger accumulator (`lib.rs:4990-5110`), the protocol queue (`movement/types.rs`), the `graphics.rs` Frame struct, and the JS `_fireHook` executor (`entities.js:7465-8200`) to resolve two cross-report conflicts. Findings below override report claims where they conflicted.

---

## 1. Executive summary

The subsystem is ~70% complete and **structurally sound**. Cycle resolution (stance+command → MotionData), root-motion **translation** accumulation, the 27-type hook decoder, hook direction-gating (incl. reverse-segment negation), velScale/cycleBaseSpeed (3-tier fallback), and the JS hook executor are all shipped and largely retail-correct.

**The one confirmed, high-leverage, code-only GO is DIM5-2 (root-motion ORIENTATION).** Authoritative proof: melt `MotionTable.cs:225-231` rotates each `posFrame.Origin` by the **accumulated** orientation (`origin += Vector3.Transform(posFrame.Origin, orientation)`) AND accumulates orientation (`orientation *= posFrame.Orientation; Normalize()`). Holtburger's accumulator (`lib.rs:5057-5067`) does a raw `accum += o.x/y/z` with **no rotation-by-accumulated-orientation and no quaternion accumulator**. Two chorizite reports (`chor:worldobjects`) claimed "rotation is per-frame, ready to ship" — **those are WRONG**, contradicted by the melt source I read. Verdict: **GO**, gated on a one-MotionTable DAT sweep to confirm a reachable cycle carries non-identity `pos_frame.orientation`.

**Attack order for the aggressive session:**
1. **DIM5-2** quaternion accumulator in `build_concatenated_motion_frames` (clear retail reference exists; ~15-line change; gate on DAT sweep).
2. **W5.1 per-part LOD** guard removal (`lib.rs:5606` `parts.len() != 1` is the explicit defect; small, isolated).
3. **H-3 queue drain** — protocol PARSES the full `Vec<MotionItem>` but **NO consumer reads index >0** (verified: grep for command-iteration in world/core/web crates returned nothing). Wire it as a client-side queue.
4. **DIM3-4** — close as NO-GO/documentation (the `-2`/`UNKNOWN_ANIMHOOK` is a constructor sentinel, never wire-serialized).
5. **W5.2 MoveTo distance branch** — NEEDS-EVIDENCE (server-authoritative; `curr_distance` not on wire).

---

## 2. Per-item cross-reference

Legend for verdicts: **GO** (clear fix + reference), **NEEDS-EVIDENCE** (blocked on a probe/data), **NO-GO** (not a real gap / out of scope / server-authoritative).

### DIM5-2 — Root-motion ORIENTATION channel — **GO** (gate on DAT sweep)

| Layer | Locus | Fact |
|---|---|---|
| holtburger Rust | `apps/holtburger-web/src/lib.rs:5003` (`pos_accum=[0.0;3]`), `:5057-5067` (raw `accum += o.x/y/z`) | Only translation summed; orientation discarded. **No quat accumulator, no rotate-delta step.** |
| holtburger Frame | `crates/holtburger-dat/src/graphics.rs:11-14` | `Frame { origin: Vector3, orientation: Quaternion }` — orientation field EXISTS and is parsed, just unused in accumulation. |
| holtburger JS | `scene3d/animation.js:136-162` | Applies translation `pos` to every part; no rig-root rotation from pos_frames. |
| acclient (retail truth) | `acclient.c:340717-340724` (frame loop calls `Frame::combine` then `apply_physics`), `:319449-319487` (`Frame::combine` 3x3 matrix rotate + quat multiply) | Each pos_frame delta rotated by accumulated orientation BEFORE add; rotation accumulates. `acclient.h:31629-31636` AFrame = origin+quat. |
| ACE | `Source/ACE.Server/Physics/Animation/AFrame.cs:43-49` (`orientation = Quaternion.Multiply(a.Ori, b.Ori)`) | Quaternion accumulation confirmed server-side. |
| chorizite | `Frame.cs:105-129` (`Frame::combine` 3 variants), `CAnimation.cs:40-45` pos_frames parallel to part_frames | Compose = rotate f2.origin by f1 matrix, add, then quat-multiply. (Two chor reports MISread this as "per-frame independent" — incorrect.) |
| **melt (AUTHORITATIVE)** | **`Source/ACE.DatLoader/FileTypes/MotionTable.cs:225-231`** — `origin += Vector3.Transform(posFrame.Origin, orientation); orientation *= posFrame.Orientation; orientation = Quaternion.Normalize(orientation);` | **Bit-exact reference implementation.** This is the change to port. |

**Exact code change:** In `build_concatenated_motion_frames` (`lib.rs:4990-5110`), add `let mut quat_accum = Quaternion::identity();` alongside `pos_accum`. Per frame, when `has_pos`:
- forward: `let rotated = quat_accum * pos_frames[idx].origin; pos_accum += rotated; quat_accum = (quat_accum * pos_frames[idx].orientation).normalize();`
- reverse: apply the inverse (`quat_accum *= pos_frames[idx].orientation.conjugate()` and subtract the rotated delta) to mirror `Frame::Subtract` / negated-combine on backward playback.
Then export `quat_accum` per keyframe (parallel to `pos`) and apply to the rig root in `animation.js:136-172` (currently translation-only). **Identity-quaternion cycles (idle/walk/run) are a no-op** — change is safe.

**Blocker (the gate):** Confirm a *reachable* cycle has non-identity `pos_frame.orientation`. Probe via `crates/holtburger-dat/examples/probe_anim_dist.rs` or a new `motion_table_inspect.rs` dumping `pos_frame.orientation` for MT `0x09000202`/`0x09000001` and combat spin/turn-in-place cycles. If all-identity in reachable data, downgrade to NEEDS-EVIDENCE.

---

### H-3 — Multi-action wire queue collapse — **GO** (parsed-but-not-consumed; client-side drain)

| Layer | Locus | Fact |
|---|---|---|
| holtburger protocol | `crates/holtburger-protocol/src/messages/movement/types.rs:228` (`num_commands:u32`), `:236`/`:461` (`commands: Vec<MotionItem>`), `:316-322` & `:525-526` (unpack loops over ALL commands) | Wire layer **fully parses** the queue. `num_commands` packed in flag bits (>>7 &0x1F outer; <<11 inner). `MotionItem`=`{command u16, packed_sequence u16 (bit15=autonomous), speed f32}` = 8 bytes (`types.rs:387-445`). |
| holtburger consumer | (verified by grep across `holtburger-world`, `holtburger-core`, `apps/holtburger-web/src`) | **NO consumer iterates `.commands` beyond implicit [0].** No `.commands.iter()`, no `for _ in commands`, no `commands[0]`. The parsed queue is dropped after the first/snapshot motion. **This is the gap.** |
| holtburger JS | `scene3d/loop.js:1232-1243` | Wasm emits ONE motion command; JS fans out forward+sidestep locally. Not a server-queue drain. |
| acclient (retail truth) | `acclient.h:31081-31089` (`MotionState.action_head/action_tail`), `acclient.c:341408-341615` (drain loop), `:341392-341397` (`add_action_tail`), `:341420` (`remove_action_head`) | Singly-linked `MotionList` action queue; drained one-per-`MotionDone`. |
| ACE | `MotionTable.cs:189-233` (Actions = **6-action FIFO**, drained via MotionDone), `WorldObject_Networking.cs:1304-1343` (`EnqueueBroadcastMotion`) | Server packs the queue; `MotionState.Actions` max 6. |
| chorizite | `InterpertedMotionState.generated.cs:28,65` (CommandListLength 0-127 + `List<PackedMotionCommand>`), `PackedMotionCommand.generated.cs:19-64` | Wire supports up to 127 chained commands; `MotionState.cs` `remove_action_head` 0x00526D20 granular drain. |
| melt | `movement/types.rs:317-322` (cross-checked) | Confirms all queued items arrive in ONE `InterpretedMotionState` body — **NOT** collapsed on wire. |

**Exact code change:** Add a client-side FIFO action queue (mirror ACE's 6-deep `MotionState.Actions`). In the motion-apply path (where `InterpretedMotionState`/`RawMotionState` is consumed — currently effectively `[0]` only), iterate `commands` in sequence order (`packed_sequence` bits 0-14), enqueue each `MotionItem`, and advance on `AnimationDone` (hook type 4). Today chained actions (e.g., combo swings) silently drop all but the first.

**Note:** Reports split on whether AC packs multi-action per packet. Reality (verified): the *wire struct* supports it (chorizite 0-127, ACE 6-FIFO), and holtburger *parses* it — so even if servers usually send 1, the queue must be drained for correctness. The `melt:animhook` report's "single MovementEventData per packet" refers to `MovementType`, not the `commands[]` within `InterpretedMotionState`.

---

### DIM3-4 — The "-2" direction hook — **NO-GO** (documentation only)

| Layer | Locus | Fact |
|---|---|---|
| holtburger | `lib.rs:5077-5090` (direction i32, negate-on-reverse), `:13025-13030` | Only `{-1,0,1}` exist; `-2` never appears. |
| acclient | `acclient.h:7311-7318` `AnimHookDir { UNKNOWN=0xFFFFFFFE(-2), BACKWARD=-1, BOTH=0, FORWARD=1 }`; constructors set `-2` (`acclient.c:342006,342087,342105,342181`); `UnPackHook` immediately overwrites `direction_` from wire (`acclient_2013.bndb:304241-304285`); gate `acclient.c:339695` `!direction_ \|\| dir==direction_` | `-2` is a **constructor default sentinel**, overwritten by the unpacked wire value before any fire. Never wire-serialized. |
| ACE | `AnimationHookDir.cs` (enum) | `-2` defined, unused. |
| chorizite | `CAnimHook.cs:23-31` (`UNKNOWN_ANIMHOOK=0xFFFFFFFE`); `ReplaceObjectHook.cs:60-64` sets default `-2` | Confirms constructor default; one report flagged ReplaceObject's `-2` default but it too is overwritten on unpack. |
| melt | `Source/Ace.Entity/Enum/AnimationHookDir.cs:5` `Unknown=-2`; `animation_hook_parity.rs` survey of 927MB portal.dat | Defined; **no retail hook carries `-2`**. |

**Exact change:** None functional. Add a one-line defensive comment at `setup_model.rs:70` + `entities.js _fireHook` noting `-2`=constructor sentinel, treat as Both(0)/skip if ever seen (avoids the `-h.direction → +2` out-of-enum flip at `lib.rs:5088`). Optionally clamp `-2` before negation.

---

### W5.1 — Per-part LOD — **GO** (small, isolated defect)

| Layer | Locus | Fact |
|---|---|---|
| **holtburger (the defect)** | **`apps/holtburger-web/src/lib.rs:5606` (`if setup.parts.len() != 1 { … skip LOD }`)**, full fn `resolve_did_degrade` `:5572-5625`, doc `:5550-5571` | Multi-part rigs return 0 (no degrade) → collapse to base mesh at distance. Single-part only. `did_degrade` field at `:3745-3801`. |
| acclient | `acclient.h` CSetup `num_parts`/`parts[]`/`parent_index[]` | Retail degrades **per-part** (each part has own degraded variant). |
| ACE | `MotionTable.cs:542-553` (no per-part LOD branch — LOD is renderer-level, not motion) | NOT a motion-table concern; lives in GfxObj rendering. |
| chorizite/melt | (no DAT-layer LOD; CPartArray rendering) | Per-part LOD is client render-side. |

**Exact change:** Refactor `resolve_did_degrade` (`lib.rs:5572-5625`) to resolve per-part: drop the `parts.len() != 1` short-circuit at `:5606`, walk each `setup.parts[i]` GfxObj's `did_degrade` chain, feed per-part degraded DIDs into `EntityAnimationData`. Medium effort but isolated; the guard removal is the load-bearing edit.

---

### W5.2 — MoveTo distance branch (DoMotion / MoveToManager) — **NEEDS-EVIDENCE** (server-authoritative)

| Layer | Locus | Fact |
|---|---|---|
| holtburger | `lib.rs:4673-4701` (`moveto_locomotion_hint`: static `Run if can_run\|can_charge else Walk`) | Collapses retail's distance branch; `curr_distance` not on wire. |
| acclient | `acclient.c:346175` `MovementParameters::get_command` (the distance branch), `acclient.h:31473-31497` MoveToManager, `:7129-7161` (CMotionInterp vs MoveToManager split) | `can_charge \| (can_run & (!can_walk \| (curr_distance - distance_to_object > walk_run_threshold)))`. |
| ACE | `MoveToManager.cs:361-399` `get_command(dist,heading)`; `MovementParameters.cs` (WalkRunThreshold default 1.0f, DistanceToObject 0.6f); `Creature.cs:310-320` | Server-side; vendor DatLoader code. |
| chorizite | `MoveToMovementParameters.generated.cs:49-51` (WalkRunThreshold parsed, NOT evaluated); `MovementParameters.cs:25-77` (`towards_and_away` 0x0052B5B0, `get_command` 0x0052B610) | Threshold on wire; eval needs per-tick mover state. |
| melt | `movement/messages/motion.rs:197-230` MoveToObject/Position | Parsed; DoMotion-equivalent not ported. |

**Verdict:** Server is authoritative for monster MoveTo; client renders the cycle the server selects. The walk/run refinement requires per-tick `curr_distance` not present on the wire packet. **Defer** unless the session adds a client-side mover that tracks distance-to-target — then evaluate the branch at playback time, not packet-construction time. Low A/B risk.

---

### Frame-combine fidelity (translation) — **SHIPPED / NO-GO**

| Layer | Locus | Verdict |
|---|---|---|
| holtburger | `lib.rs:5057-5071` (forward `+=`, reverse `-=`), reverse-swap `:5073-5093` | Translation cumulative sum is correct per ACE `Sequence.cs:383`. AnimData negative-framerate reverse handled (`:5044`). |
| chorizite | `AnimSequenceNode.cs:56-61` `multiply_framerate` negative→swap low/high | Matches. |

Translation half is correct; only the **orientation** half is missing (→ DIM5-2). No additional work on translation.

---

### Omega persistence / SetOmega(22) — **MOSTLY SHIPPED** (verify decay semantics)

| Layer | Locus | Fact |
|---|---|---|
| holtburger JS | `entities.js:7857-7861` (hookType 22 arm), `_tickHookOmega` `:8386`, accumulator `_omegaAccumQ` premultiplied `:1170-1171` & `:2733-2734` (DIM1-2/W4.3 FIX, 2026-06-05) | SetOmega integrated per-frame; persists across frames; re-applied after server-orientation copy so spinning remote entities keep spinning. **DIM1-2 fixed.** |
| holtburger wasm | `lib.rs:13389-13414` omegaX/Y/Z getters | 12-byte Vector3 payload decoded. |
| acclient | `acclient.c:342548` SetOmegaHook→`set_omega(&axis,1)`; `acclient.h:30752` persistent CSequence.omega; `apply_physics` `:339882-339889` (`omega*quantum`, Frame::rotate) | Set wholesale, no decay; persists until next set. |
| ACE/chorizite/melt | `AnimationHookType.cs:22`; chorizite `SetOmegaHook.cs:25-54` (axis Vector3); melt `SetOmegaHook.cs` | Axis-angle (|axis|=rad/s); no damping. MotionData.omega (cycle-wide) is a SEPARATE source (`re_modify` acclient.c:337286). |

**Open sub-gap:** MotionData.omega (cycle-wide, `HAS_OMEGA` flag, `motion_table.rs:30`) is **parsed but not applied at animation time** — only server-authoritative AutonomousPosition omega is rendered. Idle creatures that should spin via MotionData.omega (e.g., wraith hover) render static unless server sends omega. Lower priority (server usually drives it). If integrating, layer atop server omega without double-applying.

---

### velScale / cycleBaseSpeed — **SHIPPED & CORRECT / NO-GO** (one deferred tail)

| Layer | Locus | Fact |
|---|---|---|
| holtburger | `lib.rs:4654-4671` (`motion_cycle_base_speed`=|velocity|), `:4727-4782` (async `cycle_base_speed`, prefetch MT+MOTK `:4747-4752`), `:4811-4886` (`stateGroundSpeed`: X=sidestep*1.25, Y=walk*3.12/run*4.0, clamp run_rate*4); JS `entities.js:318-338,4415-4433,4649,7129-7159` (VEL_SCALE_ON default ON 2026-06-05) | 3-tier fallback: (1) velocity, (2) MotionKinematics, (3) GetAnimDist [DEFERRED]. |
| holtburger DAT | `motion_table.rs:84-129` `cycle_velocity_base_speed`/`cycle_anim_dist_base_speed`; `:260-264` **vector-sum-then-magnitude** (NOT sum-of-magnitudes) | Step-3 GetAnimDist is the deferred tail (rare: velocity AND kinematics both empty). |
| acclient | `MotionData.velocity` `acclient.h:57162-57169`; `CMotionInterp::get_state_velocity` `acclient.c:343539-343594` | |velocity| magnitude. Gaits hard-coded walk=3.12/run=4.0/sidestep=1.25. |
| ACE | `MotionTable.cs:23-26` (WalkSpeed/RunSpeed/TurnSpeed caches), `:506-589` GetAnimDist | |
| melt | `MotionData.cs:9-32`; `MotionDataFlags` (HasVelocity 0x1, HasOmega 0x2) | |

**Verdict:** SHIPPED. Only follow-up: implement step-3 async GetAnimDist (`cycle_anim_dist_base_speed`) for the rare both-empty case. Note the DIM5-2 fix would also improve GetAnimDist accuracy for curved cycles (vector-sum of rotated deltas). Test T1 validates vector-sum vs sum-of-magnitudes.

---

## 3. NEW parity gaps surfaced by recon (not in the handoff deferred list)

1. **MotionData.omega cycle-wide application gap** — parsed (`motion_table.rs:30`, `HAS_OMEGA`) but never applied client-side; only server AutonomousPosition omega renders. Retail `re_modify` (acclient.c:337286) re-applies after each cycle transition. → static idle-spinners. (Distinct from SetOmega *hook* which IS applied.)

2. **MotionTable.Modifiers integration deferred (Path B)** — `motion_table.rs:24-50`: all 1222 retail modifier entries are anim-free velocity/omega overlays (300/436 tables, 68.8% carry them; W9.5b audit). Retail `combine_motion`(acclient.c:337477)+`re_modify` add Velocity*speed/Omega*speed persisting through walk→run. Holtburger ships only Path A (heading interpolation). Turn modifiers (0x0D/0E/0F/10) are pure omega. Full integration blocked by client lacking entity physics integration. NEEDS-EVIDENCE: find a creature with >1 modifier entry and check for visible glitch.

3. **GetAnimDist step-3 deferred** — see velScale tail above. Async pos_frames fetch + ACE dist formula; rare path.

4. **`-2` reverse-negation hazard** — `lib.rs:5088` `h.direction = -h.direction` would map a stray `-2` to `+2` (out of `{-1,0,1}` enum). Defensive clamp recommended (ties into DIM3-4 NO-GO doc).

5. **Hooks decoded-but-not-fired (minor):** Attack(3) handled separately as strike frames; AnimationDone(4) needed by H-3 queue drain (advance-on-done); DefaultScript(17)/DefaultScriptPart(18) and CallPES(19, partial) not fully executed. Not blocking, but AnimationDone(4) becomes load-bearing once H-3 ships.

---

## 4. Authoritative AnimationHook reference (27 types, 0-26)

Cross-checked across **acclient** (`acclient.h:57405-57586`, `UnPackHook` switch `acclient_2013.bndb:304241-304600` / `acclient.c:342785-343029`), **melt** (`AnimationHookType.cs:1-34` + `AnimationHook.cs:43-167`), **ACE** (`AnimationHookType.cs:1-35`), **chorizite** (per-class VTables), **holtburger DAT** (`setup_model.rs:64-108` decoder), and **holtburger JS executor** (`entities.js:7465-8200`). **All 5 sources agree on the enum.** "24 types" in the handoff = 27 enum slots minus a few NoOp/internal; the canonical count is 27 (0-26).

| # | Name | Payload (bytes) | Semantics | JS executor (`_fireHook`) |
|---|---|---|---|---|
| 0 | NoOp | 0 | no-op | n/a |
| 1 | Sound | 4 (gid) | PlaySoundA | FIRES (`:6183`, audioMgr) |
| 2 | SoundTable | 4 (sound enum) | table-indexed sound | FIRES (`:6278-6287`) |
| 3 | Attack | 28 (AttackCone) | marks damage/strike frame | Handled separately as strike frames (not in `_fireHook`) |
| 4 | AnimationDone | 0 | cycle-complete signal | **Needed by H-3 queue drain** (not currently consumed) |
| 5 | ReplaceObject | var (1B part + 2/4B packed GfxObjId + pad) | swap part mesh | FIRES (`:7996`) |
| 6 | Ethereal | 4 (int) | toggle collision/visibility | FIRES (`:7924`) |
| 7 | TransparentPart | 16 (part + ramp 3f) | per-part opacity ramp | FIRES (`:7917`, opacity) |
| 8 | Luminous | 12 (ramp 3f) | whole-obj emissive ramp | FIRES (`:7912`, emissive) |
| 9 | LuminousPart | 16 (part + 3f) | per-part emissive | FIRES (`:7917`/`:8189`) |
| 10 | Diffuse | 12 (3f) | whole-obj diffuse ramp | FIRES (`:7912`) |
| 11 | DiffusePart | 16 (part + 3f) | per-part diffuse | FIRES (`:7917`) |
| 12 | Scale | 8 (2f: end, time) | mesh scale ramp | FIRES (`:6292-6300`,`:7912` region) |
| 13 | CreateParticle | 40 (emitter_info_id + part + Frame 28 + emitter_id) | spawn emitter | FIRES (`:6371`, ParticleManager) |
| 14 | DestroyParticle | 4 (id) | destroy emitter | FIRES (`:6353-6360`) |
| 15 | StopParticle | 4 (id) | stop emission | FIRES (`:6353`) |
| 16 | NoDraw | 4 (int) | hide mesh | FIRES (`:7815`) |
| 17 | DefaultScript | 0 | run default PES | Not fired (gap, minor) |
| 18 | DefaultScriptPart | 4 (part) | per-part default PES | Not fired (gap, minor) |
| 19 | CallPES | 8 (id + pause) | run PhysicsScript | Partial (`:6267`) |
| 20 | Transparent | 12 (ramp 3f) | whole-obj opacity | FIRES (`:7912`, opacity) |
| 21 | SoundTweaked | 16 (gid@0, prob@4, prio@8, vol@12) | sound w/ params. **Byte order corrected 2026-06-04 to acclient.c:343129** (was DRW-swapped) | FIRES (`:6183`) |
| 22 | SetOmega | 12 (Vector3 axis, rad/s) | persistent angular velocity | FIRES via `_tickHookOmega` (`:7857`,`:8386`); `_omegaAccumQ` premult |
| 23 | TextureVelocity | 8 (u_speed, v_speed) | whole-obj UV scroll | FIRES (`:7933`) |
| 24 | TextureVelocityPart | 12 (part + u/v) | per-part UV scroll | FIRES (`:7939`) |
| 25 | SetLight | 4 (int) | toggle light (render-math R2.A) | FIRES (`:7957`) |
| 26 | CreateBlockingParticle | 40 (same as 13) | blocking emitter | FIRES (shared 13 path `:6371`) |

**Direction enum** (`acclient.h:7311-7318`, melt `AnimationHookDir.cs`): `UNKNOWN=-2` (constructor sentinel, never wire-fired), `BACKWARD=-1`, `BOTH=0`, `FORWARD=1`. Gate: fire iff `direction==0 \|\| direction==playback_dir`. Holtburger negates direction on reverse segments at bake (`lib.rs:5086-5089`) so the always-forward JS executor fires the retail-correct set.

**Correction to recon:** `holt:rust-anim`, `holt:js-fx`, and `chor:worldobjects` reports variously claimed only types 1/2 fire or "13 of 24 missing." This conflated the **wasm decoder coverage** with the **JS executor**. The JS `_fireHook` (entities.js:7465-8200) actually executes the large majority (types 1,2,5,6,7,8,9,10,11,12,13,14,15,16,20,21,22,23,24,25,26). Genuine non-firing: 3 (separate strike path), 4 (needed for H-3), 17/18 (DefaultScript), 19 (partial).

---

## 5. Cut list / NO-GO

| Item | Reason | Loci |
|---|---|---|
| **DIM3-4 "-2 direction"** | `-2`/UNKNOWN_ANIMHOOK is a constructor default, overwritten on `UnPackHook` before any fire; never wire-serialized; absent from 927MB portal.dat survey. Only doc/defensive-clamp work. | `acclient.h:7311-7318`; `acclient.c:339695,342006`; melt `AnimationHookDir.cs:5`; `animation_hook_parity.rs` |
| **Frame-combine translation** | Already correct (cumulative sum, reverse-subtract). Only orientation missing → folded into DIM5-2. | `lib.rs:5057-5093` |
| **velScale / cycleBaseSpeed core** | Shipped & validated (3-tier fallback, vector-sum GetAnimDist, prefetch fix). Only step-3 tail deferred. | `lib.rs:4727-4886`; `motion_table.rs:84-129` |
| **W5.2 MoveTo distance branch** | Server-authoritative; `curr_distance` not on wire; requires client mover. Low A/B risk. NEEDS-EVIDENCE not NO-GO, but **do not attack in a code-only session** without runtime mover. | `lib.rs:4673-4701`; `MoveToManager.cs:361-399`; `acclient.c:346175` |
| **MotionTable.Modifiers Path B** | Blocked by absence of client-side entity physics integration; Path A (heading interp) ships the visible behavior. Defer. | `motion_table.rs:24-50`; `acclient.c:337286,337477` |
| **Per-part LOD via DAT layer** | LOD is renderer-side, not MotionTable — don't look for it in `MotionTable.cs`. The real fix is `resolve_did_degrade` (W5.1, GO). | `MotionTable.cs:542-553` (no branch) vs `lib.rs:5572-5625` (real locus) |
| **SetOmega decay/DIM1-2** | Already fixed 2026-06-05 (`_omegaAccumQ`, `_tickHookOmega`). Retail has no decay; matches. | `entities.js:1170,2733,7857,8386` |
| **ObjectExtensions.Copy / deep-clone** | Per MEMORY: 0 callers, Rust uses derive(Clone). Out of scope. | — |