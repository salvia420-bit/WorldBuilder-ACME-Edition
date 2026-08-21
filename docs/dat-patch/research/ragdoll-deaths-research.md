# Ragdoll deaths for the retail client — research (2026-08-21)

Question: can the ACME kit get holtburger-web-style ragdolls, driven by the
same rigid part skeleton? Answer: **yes, two routes**, both mapped below with
verified citations. The web client's ragdoll (scene3d/ragdoll.js, default-ON
since 2026-08-02) is the reference implementation — verlet particle per Setup
part, distance constraints along the DAT's `parent_index` joint graph, kill
impulse, energy governor, corpse pose transfer.

The skeleton data is identical on both sides: Setup (0x02) carries `Parts`,
`ParentIndex` (SetupFlags.HasParent), `PlacementFrames`, and per-part
`Spheres`/`CylSpheres` (ACE SetupModel.cs; CSetup in client memory).

## Route A — DAT-baked ragdoll death animations (fits the kit as-is)

**Mechanics (formats verified in dats.xml):**
- Animation (0x03) = Flags, NumParts, NumFrames, optional `PosFrames` (root
  motion), then AnimFrames = per-frame per-part `AFrame` (origin + quaternion)
  + hooks. Exactly what an offline ragdoll sim emits.
- MotionTable (0x09) `Links` = (style<<16|fromSubstate) → (toSubstate →
  MotionData); MotionData = list of AnimData {AnimId→0x03, LowFrame,
  HighFrame, Framerate}. The Ready→Dead transition is directly addressable
  and can be repointed at a new baked Animation record.

**The bake:** run the holtburger verlet sim offline per creature species
(deterministic seeded; consumes the same parentIndex + rest pose), sample
~30 fps part transforms, encode as new 0x03 records, repoint each species
MotionTable's death link. Lane shape mirrors 4.P4: enumerate species
MotionTables (Setup.DefaultMotionTable), bake, verify vs base (NumParts match,
retail anim untouched, link-only mtable delta), DatRecordInsert, walk_check,
1070 eye-test.

**Constraints:**
- ⚠ 0x03 and 0x09 are SERVER-READ types — NEVER `--compress` them
  (2026-08-21 ACE-crash rule; DatRecordInsert now refuses).
- One deterministic fall per species (MotionData anim lists play
  sequentially, no random variant selection in retail). Can differ per
  species; no kill-direction or terrain conformance (same limitation as
  retail's authored death anims — model-space).
- ACE reads the same MotionTable (we serve the pair) → death durations shift
  corpse timing consistently; keep near retail duration.
- retail-clamps-never-empties: out-of-range frame refs clamp, some safety.

**Verdict: GREEN, pure dat-lane work, ships to every kit user, no client code.**

## Route B — Chorizite plugin runtime ragdoll (true physics, local-only)

Explore-agent map of the client pipeline, spot-verified in the decomp:

- Per-tick pipeline: `CPhysicsObj::UpdateObjectInternal` → `set_frame`
  (acclient.c:321328) → `CPartArray::SetFrame` (:326766) →
  **`CPartArray::UpdateParts` (:326601, VA 0x00519C20)** — the last writer:
  `Frame::combine(&parts[i]->pos.frame, objFrame, animframe->frame[i], &scale)`
  (verified). Draw consumes `CPhysicsPart.draw_pos` filled by
  `calc_draw_frame` (:315066).
- The client NEVER stops re-writing part poses: `CSequence::get_curr_animframe`
  (:339745, verified) falls back to `placement_frame` when the anim ends → a
  post-update per-frame overwrite is required and sufficient (same discipline
  as the web client's last-rig-writer slot).
- **Best hook: post-detour `CPartArray::UpdateParts`** via Reloaded.Hooks
  (already vendored in Chorizite; `HookBase.CreateHook`, sig-scan capable).
  `this` gives `owner` (CPhysicsObj) and `setup` (CSetup* → parent_index,
  placement_frames, cylspheres — all readable live, no DAT reads needed).
- Death detect: hook `CPhysicsObj::MotionDone` (:317097) filtering
  `motion == 0x40000011` (MotionCommand.Dead — already in Chorizite enums).
- Safe-ish: creature setups have no per-part physics BSPs → part frames are
  render-only for creatures (collision uses setup spheres). Residuals:
  bounding-box/LOD read `pos`; leave `pos.objcell_id` alone.
- ⚠ Traps: must recompute `Frame.m_fl2gv` (cached 3×3 — draw reads the
  matrix, not the quaternion; call `Frame::cache`); part-pointer lifetime
  (re-resolve via part_array each frame, null-check `parts[i]`); hot-path
  detour (arm/disarm dynamically); objects deactivate >96 m
  (transient_state &0x80) → sim freezes at range.
- ACBindings already binds CPhysicsPart/CPartArray/CSequence/AnimFrame/CSetup
  with thiscall thunks; AcmeRedline's D3D9 vtable-swap mechanism does NOT
  apply (CPartArray has no vtable) — Reloaded.Hooks detour instead.

**Verdict: feasible, real engineering; a separate distribution artifact
(plugin + Chorizite runtime), cosmetic-local (only plugin users see it).**

## Recommendation

Route A first as a kit lane ("ragdoll-deaths"): reuses the validated web-side
sim as the offline generator, ships inside the dats to everyone, and follows
the exact existing lane discipline. Route B later as an optional premium
plugin (AcmeRagdoll) for true per-death physics variety — the hook map above
is the design input. The two compose: A raises the floor for all users, B is
the ceiling for plugin users.

## RANDOMIZED variants — the Route A determinism is beatable (2026-08-21 brainstorm)

Opus deep-dive over decomp + vanilla ACE + the patcher; key claims re-verified
by hand (EmoteManager RNG, the "State" pose-reset exemption, Creature_Death
OnDeath ordering, command_ids[408], SoundManager::GetSound RollDice).

**#1 GREEN — "Emote-Dice deaths" (per-death randomization, ZERO ACE code
changes, ZERO exe changes).** Vanilla ACE already rolls weighted RNG on
`EmoteCategory.Death` emote sets (WorldObjects/Managers/EmoteManager.cs:1512
GetEmoteSet useRNG → ThreadSafeRandom + probability ladder), fired right
after the Dead motion (Creature_Death.cs:120-123 → EmoteManager.OnDeath), and
a Motion emote broadcasts an arbitrary MotionCommand. So: bake N death falls;
wire variants as MotionTable entries under existing client-known `*State`
commands (WindedState/SlouchState/KneelState/PossumState… — the client knows
36 of them, and EmoteManager.cs:938 exempts `*State` commands from the pose
reset); add N-1 `weenie_properties_emote` rows (Category=Death, laddered
Probability, Type=Motion). Server rolls per death; all viewers see the same
chosen fall. Pure dat-lane + world-DB-content work.
  - ⚠ HARD SAFETY RULE: the client's `InterpretedMotionState::UnPack` indexes
    `command_ids[408]` (acclient.c:40403) with NO bounds check — every
    variant command must be one of the 408 the client already knows.
  - Enabler "#2 phantom spacer": `AnimData{AnimId=0, LowFrame=-L,
    HighFrame=-1, Framerate=F}` — ACE reads it as L/F seconds of duration
    (corpse timing) while the client's append silently drops it (has_anim()
    false). A server-only duration knob, reusable beyond this lane.
  - Garnish (both GREEN, ride the same links): per-variant
    MotionData.Velocity/Omega (slide/spin differs per variant), and
    emote Extent ≥1.0 as a framerate multiplier (fall tempo).
**#6 GREEN — randomized death SOUNDS, DAT-only, every server:** the client
itself rolls RollDice inside SoundManager::GetSound (acclient.c:383432) when
a SoundType has N SoundData entries — a SoundTableHook on the death anim +
multi-entry SoundTable = free per-death audio variety for all kit users.
**#3 GREEN/YELLOW — code-cave randomizer (phase 2):** verified 800 zero
bytes of executable .text padding in our shipped exe (VA 0x792CE0); a 5-byte
detour in AnimSequenceNode's ctor (acclient.c:341289) remaps a reserved
death-anim DID family to family+RollDice(0,n-1) (client RollDice is plain
cdecl, acclient.c:105510). Gives per-death variety on ANY server, multiplies
with #1. First non-equal-length patch in the lane → needs its own PATCHES.md
entry + sig-scan re-location (decomp VAs ≠ shipped-exe offsets).
**Closed (verified dead ends):** stance/substate keying (ACE forces
NonCombat/Ready at death; client resets substate on style change), playhead
phase inheritance (death always starts at low_frame; RemoveLinkAnimations),
terrain/slope pose conformance (model-space, no ground conform), wire-level
variant field (InterpretedMotionState has none), anim hooks as branching VM
(all 30 hook types deterministic; only sound hooks carry probability).
**UNVERIFIED (test before relying):** whether server-side ACE physics
advances position by death PosFrames (if not, big root motion pops the corpse
back); exact shipped-exe patch offsets for #3.

**Composition:** ship #1(+spacer+omega/extent) and #6 together as the lane;
add #3 later for third-party-server reach.
