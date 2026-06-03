# Animation Deep-Dive Context Map — holtburger-web 3D render (ACME edition)

**Date:** 2026-06-02
**Purpose:** Cross-source context gather ("animations for all things") in preparation for an animation deep dive on the holtburger-web 3D renderer. Five read-only Explore sweeps were run against the canonical references and the target.

**Sources swept (all under `WorldBuilder-ACME-Edition/external/` unless noted):**
| Source | Root | Role |
|---|---|---|
| ACE master | `external/ACE/Source` (also `~/ace-server/Source`) | Server-side motion/physics truth |
| Chorizite | `external/chorizite` (+ `~/.nuget/packages/chorizite.*`) | C# bindings/protocol; DAT + wire |
| Retail decomp | `~/ac-headers/` — acclient.c (31MB), .h (1.7MB), acclient.txt (82MB), acclient_2013.bndb_pseudo_c.txt (65MB) | **Behavioral ground truth** |
| melt | `external/melt` | ACE-derived DAT parser reference (bdekaru fork) |
| **Target:** holtburger-web | `external/holtburger/apps/holtburger-web` (+ `crates/holtburger-dat`) | Current implementation under deep dive |

---

## 1. Canonical animation data model (all 5 sources agree)

The chain, top to bottom:

```
SetupModel (0x02)            ── skeleton: Parts[]=GfxObj(0x01) ids, ParentIndex[] tree,
  │                             DefaultScale[], PlacementFrames{}, holding/attachment locations,
  │                             DefaultMotionTable(0x09), DefaultAnimation(0x03),
  │                             DefaultScript, DefaultSoundTable
  ▼
MotionTable (0x09)           ── (stance,command) → animation sequence
  ├ StyleDefaults{stance → default command}
  ├ Cycles{key → MotionData}              (looping/standalone motions)
  ├ Modifiers{key → MotionData}           (overlays: hold-run, casting pose…)
  └ Links{(style<<16)|currentMotion → {targetMotion → MotionData}}   (TRANSITIONS)
  ▼
MotionData                   ── num_anims, AnimData[], velocity(Vec3), omega(Vec3),
  │                             bitfield (bit0 = clears_modifiers on transition)
  ▼
AnimData                     ── anim_id(0x03), low_frame, high_frame(-1=all), framerate(<0 = reverse)
  ▼
Animation (0x03)             ── num_parts, num_frames, has_hooks,
  ├ pos_frames[]  (AFrame: root motion, optional via HasPosFrames flag)
  └ part_frames[frame] = AnimationFrame:
        ├ frames[part] = AFrame { Vector3 origin; Quaternion (W,X,Y,Z — W FIRST) }
        └ hooks[] = CAnimHook[]   (per-frame timed events; see §3)

ParticleEmitterInfo (0x32)   ← referenced by CreateParticle hook (emitter_info_id)
PhysicsScript (0x33)         ← referenced by CallPES/DefaultScript hook; list of
                                {start_time, CAnimHook} — same hook types, time-scheduled
```

**Lookup at runtime** (`CMotionTable::GetObjectSequence`, retail acclient.c:337641 / ACE `MotionTable.GetObjectSequence`):
key = `(motion & 0xFFFFFF) | (style << 16)`. Try Cycles, then Links (which may chain through `default_style`), then Modifiers. Result is a `CSequence` of `AnimSequenceNode`s. **Transitions are NOT instant** — Links carry transition clips that play *before* the target motion; modifiers are re-applied after (`re_modify`), and `bitfield & 1` clears modifiers on certain transitions.

---

## 2. The AnimationHook system — the heart of "animations for all things"

Every per-frame side effect (sound, particle, attack window, material change, visibility, light, UV scroll, scale, omega) is a `CAnimHook` subclass attached to an `AnimationFrame`. The same hook objects also populate `PhysicsScript` (0x33) entries, time-scheduled instead of frame-scheduled.

**`CSequence::execute_hooks(AnimFrame*, dir)`** runs hooks whose `direction_` matches playback direction:
`-2 Unknown · -1 Backward-only · 0 Both · +1 Forward-only`.

### ⚠ CRITICAL: declaration order ≠ serialized type ID
The retail decomp lists hook structs in **C++ vtable/declaration order** (acclient.h ~57405–57596: NOOP, SoundTable, Sound, SoundTweaked, ReplaceObject, Attack…). **That is NOT the wire/serialized `AnimationHookType`.** The serialized id (what `GetType()` returns and what DAT bytes carry) is the **ACE `AnimationHookType` enum**, which holtburger already uses. Anyone reading acclient.h directly must map through ACE's enum — do **not** treat the .h ordering as the type id.

### Canonical hook table (ACE enum = wire id = holtburger dispatch id)

| ID | Name | Payload | holtburger status |
|----|------|---------|-------------------|
| 0 | NoOp | — | n/a |
| 1 | Sound | gid (wave DID) | ✓ |
| 2 | SoundTable | SoundType enum | ✓ |
| 3 | Attack | AttackCone {part, left/right vec2, radius, height} | ✓ (emits `combatStrikeFrame`) |
| 4 | AnimationDone | — | ✓ (emits `animationHookDone`) |
| 5 | ReplaceObject | AnimPartChange {part, partId} | ✓ Wave 7 (async per-part mesh swap) |
| 6 | Ethereal | int | ✓ |
| 7 | TransparentPart | part, start, end, time | ✓ Wave 6 |
| 8 | Luminous | start, end, time | ✓ Wave 6 |
| 9 | LuminousPart | part, start, end, time | ✓ Wave 6 |
| 10 | Diffuse | start, end, time | ✓ Wave 6 |
| 11 | DiffusePart | part, start, end, time | ✓ Wave 6 |
| 12 | Scale | end, time | ✓ Wave 3 (uniform only) |
| 13 | CreateParticle | emitter_info_id(0x32), part_index, offset(Frame), emitter_id | ✓ Wave 1 — **anchors to ROOT, not part** |
| 14 | DestroyParticle | emitter_id | ✓ Wave 1 |
| 15 | StopParticle | emitter_id | ✓ Wave 1 |
| 16 | NoDraw | uint | ✓ (whole-object only) |
| 17 | DefaultScript | — | ✓ |
| 18 | DefaultScriptPart | part_index | ✓ Wave 4 (part hint UNUSED) |
| 19 | CallPES | pes(0x33), pause(float) | ✓ Wave 1 |
| 20 | Transparent | start, end, time | ✓ Wave 6 |
| 21 | SoundTweaked | id, priority, probability, volume | ✓ Wave 2 |
| 22 | SetOmega | axis(Vec3) | ✓ Wave 3 (persistent) |
| 23 | TextureVelocity | uSpeed, vSpeed | ✓ Wave 6 (UV scroll, persistent) |
| 24 | TextureVelocityPart | part, uSpeed, vSpeed | ✓ Wave 6 |
| 25 | SetLight | int lightsOn | ✓ R2.A (gated `?entityLights=on`) |
| 26 | CreateBlockingParticle | (inherits CreateParticle) | — verify coverage |

Retail also defines `FPHook` / `VectorHook` (subclasses of `PhysicsObjHook`, used by physics scripts for float/vector interpolation) — not in the 0–26 animation-hook id space; relevant if PhysicsScript bytecode gets fully decoded.

**Holtburger material hooks use clone-on-write** (`_materialHookTweens[]`, `_getOrCloneEntityMaterial`): shared material cloned on first ramp per surface. Animation hooks are currently the *only* consumer of per-entity materials.

---

## 3. Motion command / stance encoding (consistent across sources)

`MotionCommand` is a 32-bit bitfield; high bits classify (`CommandMasks`):
`0x80000000 Style · 0x40000000 SubState · 0x20000000 Modifier · 0x10000000 Action · 0x08 UI · 0x04 Toggle · 0x02 ChatEmote · 0x01 Mappable`.

`MotionStance` is the subset in `0x8000003c–0x8000013c` (HandCombat 3c, NonCombat 3d, SwordCombat 3e, Bow 3f, SwordShield 40, Crossbow 41, Sling 43, 2HSword 44, 2HStaff 45, DualWield 46, ThrownWeapon 47, Magic 49, AtlatlCombat 13b, ThrownShieldCombat 13c…).

⚠ **Stance high-bit divergence (from memory + chorizite sweep):** retail/ACE keep the `0x80000000` high bit on stance values; **Chorizite sometimes strips it.** ACE-wins is the canonical resolution (Wave 2.D). Watch this when comparing wire bytes across the three stacks.

Three motion-state representations (same in ACE, Chorizite, retail):
- **RawMotionState** — raw client input (+ HoldKeys, flags bitfield for field presence).
- **InterpretedMotionState** — server-synced, holdkeys dropped, carries ActionNode list.
- **MotionState** — current resolved {style, substate, substate_mod, modifier list, action queue}.

`CMotionInterp` / ACE `MotionInterp` constants: WalkAnimSpeed 3.12, RunAnimSpeed 4.0, RunTurnFactor 1.5, SidestepFactor 0.5, Backwards ≈0.65. Jump/run-rate formulas live in ACE `MovementSystem.cs` (GetRunRate, GetJumpHeight) and retail `CMotionInterp`.

**Wire (Chorizite.ACProtocol `MovementData`):** ushort sequences + `Autonomous` flag + `MovementType` (0 Interpreted+sticky / 6-7 MoveTo / 8-9 TurnTo) + Stance. `MovementTypes` enum: Invalid 0, RawCommand 1, InterpretedCommand 2, StopRaw 3, StopInterpreted 4, StopCompletely 5, MoveToObject 6, MoveToPosition 7, TurnToObject 8, TurnToHeading 9.

---

## 4. holtburger-web — current state (the target)

**Architecture:** Three.js (JS) driven by Rust→wasm. JS does hook execution + mixer + material FX; wasm does DAT parse + cycle baking + hook extraction.

**JS files:** `scene3d/animation.js` (923 LOC — AnimationClip builder + LRU AnimationCache, 256 entries, substitution-aware key), `scene3d/entities.js` (8800+ LOC — `setMotion` dispatch ~L4358, `_fireHook` switch ~L7066, `_attachParticleChainForEntity` ~L5635). `scene3d/particles/*` (emitter runtime). `scene3d/diag/{motion,assets}.js` (coverage matrix, cache stats).

**Wasm/Rust:** `src/lib.rs` — `fetchEntityAnimationKeyframes(setupId, modelChanges, textureChanges, paletteId, paletteSubsFlat, mtableId, motionCommand, stance, [fromMotion])` → `EntityAnimationData` {partFrames(7 floats/part/frame), frameTimes[] (non-uniform, T4), posFrames[] (root motion), restOrigins/restOrientations (Cohere-B, W-first), takePartMeshes(), takeHooks()}. `fetchEntityAnimationKeyframesBatch()` prewarms 25 setups in one walk (F.40: 100–475s → <5s). `classifyMotionCommandTyped()` = C# parity classifier (Wave 3.E, ~96% match). DAT parsing in `crates/holtburger-dat/src/setup_model.rs` + `file_type/mod.rs` (confirmed: GfxObj 0x01, Setup 0x02, Animation 0x03, Palette 0x04, MotionTable 0x09, ParticleEmitterInfo 0x32, PhysicsScript 0x33).

**What's solid:** keyframe playback (discrete interpolation, retail-correct), rest pose, non-uniform multi-segment timing + reverse, root-motion translation, LRU cache + batch prewarm, walk/run/strafe/turn cycles, swing/cast LoopOnce overlays via `_tryPlayLink`, link-transition prefetch, cycle phase preservation (resume window), 150ms Ready/stance crossfade, all 25 hook types dispatched with direction gating, particle emitters, PhysicsScript chain walker, remote dead-reckoning (`?deadReckon=on`).

**Known gaps / stubs:**
1. **Velocity-scaled locomotion (ice-skating)** — `cycleTimeScale()` exists (`animation.js:241`) but **never called**; needs `MotionData.velocity` surfaced from wasm + per-frame ground speed. Feet desync from travel under haste/encumbrance/backpedal. `?velScale=on` gate exists, unwired.
2. **Jump** — Jump (0x2500003B) is absent from all 436 retail motion tables; current fallback is a no-op + leftover arms-up tween (W1.7). Open question: is jump meant to be skeletal at all, or pure physics + PhysicsScript? Resolve in deep dive.
3. **Per-part particle anchoring** — CreateParticle always attaches to root; `part_index`/offset not applied (Wave 4 TODO). Hooks 7/9/11/18/24 carry `partIndex` but several ignore it.
4. **PhysicsScript bytecode** — only CreateParticle/Luminous/Sound/CallPES nodes interpreted JS-side; other node types logged no-op. No per-frame script scheduling.
5. **Material ramps** — linear lerp only (retail likely linear too — verify); clones not pooled (GC pressure on crowds).
6. **Root motion** — translation only, no rotation. No per-part scale keyframes (retail Animation assets don't carry them — likely fine).
7. **Motion-link transitions** — fetched async, **silent-fail** if a link clip is absent → visual clunk on swing→walk etc. No telemetry on link hit rate.

---

## 5. Cross-source discrepancies & gotchas (verified)

- **MotionTable file type = 0x09**, not 0x04. (0x04 is Palette.) Verified in `holtburger-dat/file_type/mod.rs`. melt sweep mislabeled it.
- **Hook declaration order in acclient.h ≠ serialized type id.** Use ACE `AnimationHookType` enum (= holtburger ids). See §2.
- **Stance high-bit:** retail/ACE keep `0x80000000`; Chorizite strips. ACE-canonical.
- **Quaternion order is W-first** (qw,qx,qy,qz) everywhere in AC frame data — holtburger honors this (restOrientations).
- **Frame interpolation is discrete** in retail (~30Hz authored, snap to nearest frame) — holtburger hard-codes `InterpolateDiscrete`, which is correct, not a bug.
- **Transitions go through Links** (not instant) and modifiers re-apply after — subtle; small deviations break chaining visually.

---

## 6. Prioritized entry points per source (for the deep dive)

**Retail (truth):** `CMotionTable::GetObjectSequence` (c:337641), `MotionTableManager::PerformMovement` (c:330206), `CSequence` (h:30747), `CAnimHook` + subclass block (h:30973, 57405-57596), `AnimFrame` (h:31072), `CMotionInterp` (h:31407), `ParticleEmitterInfo`/`ParticleEmitter` (h:52409/52469), `PhysicsScript` (h:31801). Grep terms in the sweep notes.

**ACE:** `Physics/Animation/{MotionTable,MotionInterp,Sequence,AnimSequenceNode,MovementParameters,InterpretedMotionState,RawMotionState}.cs`, `Physics/Managers/{MotionTableManager,MovementManager,InterpolationManager,MoveToManager}.cs`, `Physics/Hooks/{AnimHook,PhysicsHookType}.cs`, `Entity/Enum/{MotionCommand,MotionStance,CommandMasks}.cs`, `WorldObject.ExecuteMotion/SetStance`.

**Chorizite:** `Chorizite.ACProtocol/Types/{MovementData,RawMotionState,InterpertedMotionState,PackedMotionCommand}.generated.cs`; ACBindings DBObjs `{CMotionTable,CAnimation,CSetup,CGfxObj}.cs`; `Dats/Types/AnimHooks/*`; `Common/Enums/{MotionCommand,MotionStance}.cs`.

**melt:** `ACE.DatLoader/FileTypes/{Animation,MotionTable,SetupModel,ParticleEmitterInfo,PhysicsScript}.cs`, `Entity/{AnimationFrame,MotionData,AnimationHook}.cs`, `Entity/AnimationHooks/*`, `Ace.Entity/Enum/{AnimationHookType,MotionStance,MotionCommand}.cs`.

**holtburger (target):** `scene3d/animation.js`, `scene3d/entities.js` (`setMotion`, `_fireHook`, `_attachParticleChainForEntity`), `src/lib.rs` (`fetchEntityAnimationKeyframes*`, `EntityAnimationData`, `AnimationHookJs`), `crates/holtburger-dat/src/setup_model.rs`, `scene3d/diag/{motion,assets}.js`.

---

## 7. Suggested deep-dive targets (ranked)
1. **Velocity scaling / ice-skating** (Tier-1, medium effort) — wire `cycleTimeScale()`: surface `MotionData.velocity` from wasm, track entity ground speed, gate stays `?velScale`.
2. **Jump resolution** (needs research first) — determine retail mechanism; implement clip or physics-script path.
3. **Per-part particle anchoring** (low effort, visible win) — apply `part_index` + offset in `_fireCreateParticleHook`.
4. **Motion-link telemetry + retry** (low) — instrument link hit rate, surface silent-fails.
5. **PhysicsScript node coverage** (medium) — decode remaining script node types.
