// Phase 7.3+ — render-loop tick helpers.
//
// Phase 7.3 wired `tickCellVisibility3D` so the wasm-side cell BFS
// (`getCurrentCellId / getRenderSet / isCurrentCellIndoor`) drives
// `Object3D.visible` flips on the per-cell groups + the outdoor batch.
// Phase 7.4b adds:
//   - mixer.update(dt) per entity via `EntityManager.tick`.
//   - drainEntityEvents3D — pulls `pollEntityUpdates()` and
//     dispatches kind=1/2/4/5 into the EntityManager. The 2D path's
//     `drainEvents` (`index.html:5723`) also calls
//     `pollEntityUpdates` — both paths run today because the 2D
//     drainEvents drives chat/local-player/etc, but
//     `pollEntityUpdates()` is a one-shot drain. To avoid double-
//     consumption, the 3D path subscribes via a hook installed on the
//     SessionHandle (see `attachEntityHook` below) instead of
//     re-calling `pollEntityUpdates` directly.
//
// Phase 7.5 (this commit) drives `cameraSwitcher.tick(dt)` first so
// the per-frame camera position update + WASD → setMovementInput
// dispatch happens BEFORE the entity tick. Order matters: the camera
// queries `getPlayerWorldPos()` which reads
// `entityManager.entityMap[localPlayerGuid].root.position`; the
// entity mixer advance in step 2 then updates that position for the
// NEXT frame's camera. Camera-first means the camera always reflects
// last-frame entity poses, never a half-stepped state.
//
// Phase 7.6 (this commit) wires `tickLightingForCellState(scene3d,
// sessionHandle)` after `tickCellVisibility3D` so the sun-off /
// ambient-up toggle reads the freshly-flipped indoor flag on the
// same frame. Per-SetupModel point/spot lights are DEFERRED to a
// follow-on (see `lighting.js` header comment for the deferred-work
// pointer); the distance-cull pass referenced in earlier comments
// only needs to land then.
//
// `init3D`'s render loop calls this once per requestAnimationFrame
// frame, BEFORE `renderer.render(scene, camera)`.

import * as THREE from "three";
import { tickCellVisibility3D, tickPortalStencil, tickPortalPunch, tickPvsLoadExpansion } from "./cells.js";
// Far-terrain wave (2026-08-02). S1 (retail range fog) reads the flags + the
// effective-radius helper; S2/S3 (the Far Composite Ring) adds one budgeted
// tick. Both are hard no-ops behind `?farTerrain=off`.
import {
  terrainFogEnabled, farFogFrac, farFogNearPin, farFogFarPin,
  farFogFloorM, farFogFloorMinLb,
  farFogSkyProbeEnabled, farFogSkyElevDeg, farFogSkyHz, farFogTint,
} from "./far_terrain_flags.js";
import { tickFarTerrain, farTerrainEffectiveRadiusLb } from "./far_terrain.js";
// ?statAtlas (default-ON; ?statAtlas=off escapes) — lazy buffer-compaction for the cross-LB static
// texture-array buckets, driven off the ~10 Hz PVS path (NOT the per-frame
// eviction tick). Flag-off: statAtlasEnabled() is false → never runs.
import { statAtlasEnabled, tickStatAtlasOptimize } from "./static_atlas.js";
// ?statBatchChunk (default-OFF) — same lazy buffer-compaction story for the
// region-chunked per-material ?staticBatch buckets. Flag-off: never runs.
import { statBatchChunkEnabled, tickStatBatchXOptimize } from "./static_batch_x.js";
// ?terrainBatch (default-OFF) — lazy buffer compaction for the cross-LB
// terrain BatchedMesh; both imports are inert when the flag is off.
import { terrainBatchEnabled, tickTerrainBatchOptimize } from "./terrain_batch.js";
import { tickLightingForCellState } from "./lighting.js";
import { tickFlameFlicker } from "./vfx/components/flameFlicker.js";
import { cullTerrainGroup } from "./terrain.js?v=phase-d-batch";
import { SHADOW_RECEIVE_RANGE_SQ_M as BUILDINGS_SHADOW_RANGE_SQ_M } from "./buildings.js";
import {
  SHADOW_RECEIVE_RANGE_SQ_M as STATICS_SHADOW_RANGE_SQ_M,
  cullStaticsGroup,
  tickStaticParticles,
  tickLodBandDiag,
} from "./statics.js";
// A11-S3 (2026-06-12 unification survey) — `?particleClock=off|loop|sim`.
// "loop"/"sim" move the particle/script manager ticks into tickPerFrame's
// dedicated manager phase (below) at the retail point in frame; "sim"
// additionally drives the shared particle clock from the loop's clamped dt
// (install in scene3d/index.js). time_rng.js is dependency-free.
import { lbKeyOf, lbChebyshev } from "./landblock_lru.js"; // P4 teleport spawn-flush
import { particleClockMode } from "./particles/time_rng.js";
// FCULL (2026-06-08) — app-level frustum + distance render cull. loop.js
// owns the import graph: it wires the per-domain cull fns into culling.js
// (a three-only leaf module) via `setCullers`, then runs the coherent pass
// as ONE CRITICAL per-frame step (below). `tickEntityRenderVisibility`
// lives in entities.js so it can reach the EntityManager's private state.
import { tickFrustumCull, setCullers } from "./culling.js";
import { tickEntityRenderVisibility } from "./entities.js";
// Portal-space donut (0x02000306) travel visual. No-op unless a teleport has
// armed it via `startPortalSpace` (gated behind `?portalSpace=`).
import { tickPortalSpace } from "./portal_space.js";
// A15-Q2 (2026-06-11 unification survey) — single EntityUpdate clone/field
// schema shared with index.html's 2D path. Pure function, no DOM/wasm.
// Wired into `toMeta` behind `?unifiedClone=on` (default-off, see below).
import { cloneEntityUpdate } from "./entity_update_clone.js";
// A8-M3 (2026-06-11 unification survey) — scene3d-owned dispatcher for
// rig-affecting ClientEvents (kind=17 EntityVisibilityChanged). Pure
// module, no DOM/wasm. Installed unconditionally below in
// installSharedDrainHook; the flag (`?unifiedClientEvent=on`) is read at
// the call site in index.html so flag-off never invokes it.
import { createClientEventDispatcher } from "./client_event_dispatch.js";
// F17 (2026-07-03, physics-parity dossier A row 42) — pure helpers for the
// `?rustPose=on` render bypass (flag parse + lb-local → world pose
// conversion). Import-free module so tests/rust_pose.test.cjs runs the
// unit half under plain node. Consumed only inside
// `applyLocalPlayerPoseFromIntegrator` behind the default-off flag.
import { parseRustPoseFlag, rustPoseWorldFromPose } from "./rust_pose.js";
// FU-2 (2026-08-02, `?serverTurn=on`, DEFAULT OFF) — server turn authority +
// the retail control handoff. Leaf module (imports nothing) shared with
// picking.js; flag-off every export is inert.
import {
  SERVER_TURN_ON,
  headingFromTurnQuat,
  loseControlToServer,
  tickServerTurnControl,
  noteServerTurnApplied,
  noteServerTurnDropped,
} from "./server_turn.js";

// Wire the per-domain cullers once at module load. Each fn is `(scene3d,
// culler) => void` and is individually fail-soft (tickFrustumCull also
// wraps each in try/catch). Terrain is registered but only INVOKED when
// `?cullTerrain=on` (the gate lives inside tickFrustumCull).
setCullers({
  statics: cullStaticsGroup,
  entities: tickEntityRenderVisibility,
  terrain: cullTerrainGroup,
});
import { weatherForState } from "./daygroup_weather.js";
import { updateFromDayGroup as wxUpdateFromDayGroup } from "./weather_state.js";

// VFX material-oscillator registry (Visual-Behavior Suite, Phase 1 — spec §7).
// The SINGLE per-frame VFX tick: drives VFX_GLOBALS.uTime (the master clock) plus
// every shared VFX uniform once/frame, O(1). uTime is bound BY REFERENCE here so
// the leaf oscillators.js stays THREE-free (node-testable) — it's the same {value}
// object getCachedVariant binds into every VFX-patched material. Dormant until an
// effect registers a channel; the master clock advances every frame regardless.
import { VFX_GLOBALS } from "./materials.js";
import { tickOscillators, setMasterClock, getOscillator } from "./vfx/oscillators.js";
// Wave 2B (plan §3.6 item 3) — the identity of the crack-glow BREATHING
// oscillator, so `tickTerrainUTime` below can push its sampled value onto every
// terrain material's `uCrackGlowBreath`. terrain_volcano.js is THREE-free and
// registers the channel only under `?terrainVolcano=on&terrainCrackGlow=on`; an
// unregistered channel leaves the uniform at its shader default.
import { CRACK_GLOW_OSC_NAME } from "./terrain_volcano.js";
// Phase 1 (VFX slice 12) — derives VFX_GLOBALS.uWetness/uFrost/uWindDir from the
// client weather snapshot. Imports materials.js (VFX_GLOBALS) so it is NOT a
// leaf like oscillators.js — but loop.js already pulls in materials.js, so no
// new cycle. Ticked right after the oscillator so it shares the master clock.
import { tickWeatherInputs } from "./vfx/weather_inputs.js";
// Terrain-VFX spine (Wave 0B, docs/2026-07-31-terrain-vfx-plan.md §2.2). ONE
// call per frame, right after the VFX weather inputs so a provider reads the
// same clock and the same wind vector every other VFX component just got.
// Returns immediately with no providers registered, and is never even reached
// under `?terrainVfx=off` / `?wireframe=1`.
import { terrainVfxTick } from "./terrain_vfx.js";
setMasterClock(VFX_GLOBALS.uTime);

// A15-Q4 (2026-06-12 unification survey) — the renderer-neutral
// EntityUpdate kind table + per-host dispatcher factory. `KIND` is the
// single source for the kind constants (mirrors the wasm
// `ENTITY_UPDATE_KIND_*` from `crates/holtburger-session/src/lib.rs`);
// the local `KIND_*` aliases below keep the rest of this file
// diff-free. `createEntityDispatcher` builds the flag-on "3d" backend
// table inside installSharedDrainHook (`?unifiedDispatch=on`,
// default-off — read independently here and in index.html).
import { KIND, createEntityDispatcher } from "./entity_dispatch.js";
// NIGHT RAMP (2026-08-02, ?nightRamp — DEFAULT ON). See night_ramp.js.
import {
  nightRampEnabled,
  nightFactorFromAuthoredPitch,
  nightGroundScale,
} from "./night_ramp.js";

// Entity-update kind constants — aliases over the shared KIND table
// (A15-Q4; pre-Q4 these were file-local literals). Listed here
// for readability of `dispatchEntityUpdate`'s dispatch.
const KIND_POSITION = KIND.POSITION;
const KIND_SPAWN = KIND.SPAWN;
const KIND_REMOVE = KIND.REMOVE;
const KIND_META_REFRESH = KIND.META_REFRESH;
const KIND_VELOCITY = KIND.VELOCITY;
const KIND_MOTION = KIND.MOTION;
const KIND_APPEARANCE = KIND.APPEARANCE;
// Render-completeness audit (2026-05-29) — wielded-item attach/detach.
// Reuses EntityUpdate fields: model_id = parent (wielder) guid (0 = detach),
// motionCommand = ParentEvent.location, motionStance = ParentEvent.placement.
const KIND_ATTACH = KIND.ATTACH;
// Wave 2 (2026-06-08) — a one-shot Action-class motion command (creature
// attack swing B10, local eat/drink B6, emote/gesture) from the UpdateMotion
// action `commands` list. motionCommand is the FULL 32-bit MotionCommand
// (already expanded in Rust); motionStance is current_style; motionSpeed is
// the per-action playback speed. Played as a LoopOnce OVERLAY via
// em.setMotion → classifyMotionCommand → _tryPlayLink for EVERY guid
// INCLUDING the local player — it never carries a locomotion command, so the
// local-gait LOCOMOTION skip in the KIND_MOTION arms stays untouched (B9).
const KIND_MOTION_ACTION = KIND.MOTION_ACTION;
// F3-3 (bughunt 2026-06-09) — a server TurnToHeading/TurnToObject directive.
// qw/qx/qy/qz carry the absolute target heading as an AC z-up quaternion;
// omega_z is the turn-speed hint. Remote-only: em.applyTurnDirective sets the
// heading-ease target so the rig turns to face it (NPCs / idle turn-in-place).
const KIND_TURN = KIND.TURN;

// FORCE_MOTION_LOCAL (motion B5#2 / C3, backlog 19, 2026-06-09) —
// `?forceMotionLocal=on` (default OFF). The two KIND_MOTION arms below
// UNCONDITIONALLY skip the local player's `motion_command` and apply only
// the STANCE half (`setLocalStance`). That skip is the B9 fix: the local
// gait is client-predicted (W3.1 fires setMotion on keystate), and
// re-dispatching the server's locomotion echo to the local rig FIGHTS the
// predictor — the echoed Walk/Run can differ from the prediction, so the
// run clip keeps crossfading and never loops ("running animation
// interrupts" snap-back, DIM10/A-2). We must NOT reintroduce that.
//
// BUT the skip also swallows any server-FORCED NON-LOCOMOTION pose/action
// that ACE could broadcast onto the local player via the same UpdateMotion
// `forward_command` slot (a forced sit/sleep/paralysis hold, a forced quest
// emote, a knockdown). Those are NOT gait echoes and the predictor doesn't
// own them — skipping them means the forced pose never plays locally.
//
// When this flag is ON, the local-guid arm lets a kind=5 command THROUGH to
// `em.setMotion` IFF (a) the server marked it FORCED (`!upd.isAutonomous`)
// AND (b) the command is NOT one of the predictor-owned locomotion/stop/
// ready/fall signals (see `isLocalGaitLocomotionCmd`), while still skipping
// every routine gait echo so local prediction (B9) is preserved. When OFF,
// behaviour is byte-identical to today (skip → stance only). Default OFF
// pending a 1070 GPU eye-test.
//
// WIRE-SIGNAL (SG-B, 2026-06-09 — resolves the prior caveat): the wasm
// bridge NOW surfaces the UpdateMotion 0xF74C wire `is_autonomous` bit on
// the kind=5 EntityUpdate (`EntityUpdate.isAutonomous`,
// apps/holtburger-web/src/lib.rs — sourced from `MovementEventData
// .is_autonomous`, movement/messages/motion.rs:454). ACE semantics
// (`MovementData.cs:20`): true = client-initiated (the player's own
// predicted gait echo — Player.cs:948 sets it on every BroadcastMovement);
// false = server-initiated/forced (a `Motion(stance, command)` pushed via
// `EnqueueBroadcastMotion` — forced sit/sleep/paralysis-hold/quest-emote,
// Player.cs:1005). So `!isAutonomous` is now the PRIMARY, correct
// "is-this-server-forced" discriminator, and the command-class check is kept
// as defence-in-depth (B9). REMAINING gap: a forced pose that arrives ONLY
// as a `commands`-list MotionItem (not the `forward_command` slot) still
// flows through KIND_MOTION_ACTION (which already runs for the local guid),
// not here — that channel does not yet thread `is_autonomous` per item
// (movement/types.rs MotionItem.packed_sequence bit 15).
// INTEGRATED always-on — 1070 eye-test PASSED 2026-06-10 (`@animation Sitting`
// forced pose plays on the local avatar; B9 local-gait prediction preserved).
// Was the default-OFF `?forceMotionLocal=on` gate.
const FORCE_MOTION_LOCAL_ON = true;

// Predictor-owned LOCOMOTION command low-16 set — the kind=5 commands the
// B9 local-gait skip MUST keep swallowing so client prediction is never
// overridden by the server echo. Mirrors
// `InterpretedMotionCommand::is_locomotion()`
// (crates/.../movement/types.rs:170-178) PLUS the Stop/Ready/Falling/Fallen
// signals the wasm bridge also emits as kind=5 `motion_command` (lib.rs
// ~31848 STOP, ~37105 READY, ~37172 FALLING). Anything NOT in this set that
// arrives as a kind=5 command is, by construction, a forced non-locomotion
// pose/action (the predictor never issues those), so FORCE_MOTION_LOCAL lets
// it through. Low-16 values from ACE MotionCommand.cs (see the CMD_LOW_*
// constants in entities.js):
//   0x0003 Ready, 0x0004 Stop, 0x0005 WalkFwd, 0x0006 WalkBack,
//   0x0007 RunFwd, 0x0008 Fallen, 0x000D TurnRight, 0x000E TurnLeft,
//   0x000F SidestepRight, 0x0010 SidestepLeft, 0x0015 Falling.
const _LOCAL_GAIT_LOCOMOTION_LOWS = new Set([
  0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008,
  0x000d, 0x000e, 0x000f, 0x0010, 0x0015,
]);
function isLocalGaitLocomotionCmd(cmd) {
  // A zero command carries no forward locomotion (turn-only / unhandled
  // type per the wasm `motion_command` doc); treat it as locomotion-class
  // so it stays on the skip path (nothing to force, and it must not be
  // mistaken for a forced pose). Otherwise compare the low-16.
  const low = (cmd >>> 0) & 0xffff;
  if (low === 0) return true;
  return _LOCAL_GAIT_LOCOMOTION_LOWS.has(low);
}

// WS02 (2026-07-12) — `?castGestureParity` (default ON, `=off` = byte-identical).
// The FINAL cast GESTURE is a class-0x40 magic substate (MagicBlast..MagicPray,
// low16 0x2B..0x39; ACE puts it in the wire forward_command slot —
// Player_Magic.cs DoCastGesture EnqueueMotionMagic / WorldObject_Networking.cs
// new Motion(Magic,cmd,speed)). It is NOT action-class
// (is_action_motion_command=false for that band — crates/.../player/types.rs), so
// the lib.rs forward_command filter does NOT divert it to KIND_MOTION_ACTION — it
// rides KIND_MOTION as the locomotion motion_command with a RAW low16 and (being
// server-forced ⇒ !isAuto) reaches the local rig via forceLocal. But
// playCastSequence ALREADY predicts that gesture (setSwingMotion) and notes it
// (noteLocalSwingPrediction), so the echo is a redundant SECOND play with NO dedup
// (the swing-echo dedup only runs on the KIND_MOTION_ACTION path used by the
// windups). Consume the note here to swallow the local echo. Remote casters are
// untouched (they need the echo to animate). Empirically the band 0x2B..0x39
// covers EVERY cast gesture and NO windup across all 6,266 spells
// (tests/test_ws02_cast_echo_dedup.mjs T6).
const CAST_GESTURE_PARITY_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return (
      new URLSearchParams(window.location.search).get("castGestureParity")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return true; // non-browser (headless source-eval harness): default ON
  }
})();
// Magic cast-gesture substate low-16 band (MagicBlast 0x2B .. MagicPray 0x39).
function isLocalPredictedCastGestureLow(low) { return low >= 0x2b && low <= 0x39; }

// A2 (perf plan 2026-05-18) — module-scratch object passed to
// `em.setVelocity` so we don't allocate a fresh `{guid,vx,vy,vz,omegaZ}`
// on every KIND_VELOCITY event. `setVelocity` copies the fields into
// `inst.lastVel` synchronously and does not retain a reference, so a
// single shared scratch is safe across both drain paths.
const _velScratch = { guid: 0, vx: 0, vy: 0, vz: 0, omegaZ: 0 };

// Multi-action motion queue (2026-06-06, approach B) — `?multiAction`
// FIFO-plays the Action-class `commands` list (emotes / gestures) that the
// single motion_command path drops, drained from the wasm `pollMotionActions`
// side-channel. DEFAULT-ON (the reader below is `!== "off"`; listed in the
// default-ON block at the top of docs/url-flags.md — the old "default OFF, needs
// a 1070 eye-test" note here was stale, WS07 2026-07-12). `?multiAction=off` to
// disable. NOTE: cosmetic actions, NOT the strafe-cast / cast-break tech (those
// are SubState ForwardCommand + the sidestep axis — a separate gap).
const MULTI_ACTION_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("multiAction")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();

// A15-Q2 (2026-06-11 unification survey) — `?unifiedClone` (DEFAULT-ON —
// `!== "off"` reader; `=off` escapes):
// route `toMeta` (and, in index.html, the backlog/deferred-spawn clones)
// through the single shared `cloneEntityUpdate` schema instead of the
// hand-copied per-site field lists. Off = legacy per-site clone (the
// `toMeta` body below). See docs/url-flags.md.
const UNIFIED_CLONE_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("unifiedClone")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();

// FU-3 (2026-06-11) — `?serverSwing` (DEFAULT-ON — `!== "off"` reader;
// `=off` escapes): picking.js suppresses its
// optimistic click-time swing, so the server's KIND_MOTION_ACTION echo is
// the ONLY swing trigger. setMotion's MT-link overlay doesn't animate the
// LOCAL rig (the known local combat-anim gap), so for attack-class
// commands on the local guid we also fire the procedural shoulder pose
// (setSwingPose) — the visual that worked pre-FU-3 — now at the
// server-timed (post-MoveTo) moment instead of at click.
const SERVER_SWING_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("serverSwing")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();

// A15-Q3.2 (2026-06-12, SQ3 spec) — `?dispatchParity` (DEFAULT-ON —
// `!== "off"` reader; `=off` escapes):
// gates the F6-2 swing-echo dedup port into the unified dispatcher
// (`dispatchEntityUpdate` KIND_MOTION_ACTION arm). The dedup shipped in the
// dead direct-drain arm only, so it was INERT in every live 3D session —
// the server's swing echo double-plays / restarts the optimistic local
// swing (~RTT later) that picking.js `noteLocalSwingPrediction` already
// played. This is the only Q3 port that changes DEFAULT-mode live combat
// visuals, hence the gate. On 1070 eye-test PASS, integrate always-on and
// mark DONE in url-flags.md per the standing passed-flag workflow.
const DISPATCH_PARITY_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("dispatchParity")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();

// A15-Q4 (2026-06-12, S3 spec) — `?unifiedDispatch` (DEFAULT-ON —
// `!== "off"` reader; `=off` escapes):
// renderer-neutral core extraction. ON: the shared-drain `dispatchOne`
// delegates to a `createEntityDispatcher` "3d" backend table (built once
// per installSharedDrainHook call) whose per-kind handlers are the SAME
// `_arm*` functions the flag-off `dispatchEntityUpdate` if-chain calls —
// behavior identical by construction, no second copy. The 3d
// dispatcher's NEUTRAL table is EMPTY by invariant: neutral concerns
// (world streaming, worldObjectManager feed) run exactly once, at the
// index.html drain (the hook receives the same array the 2D for-loop
// iterates). OFF: byte-identical legacy routing.
const UNIFIED_DISPATCH_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("unifiedDispatch")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();

// A15-Q3.3 (2026-06-12, SQ3 spec) — `?legacyDirectDrain=on` (default-off =
// unified): rollback hatch for the direct-drain retirement. Default-off,
// `drainEntityEvents3D` is a thin poll → `dispatchEntityUpdate` → `.free()`
// wrapper over the unified core; on, the verbatim pre-Q3 legacy arm
// (`_legacyDirectDrainArm`) runs instead. LIVE 3D mode is unaffected in
// EITHER state — `installSharedDrainHook` is called unconditionally from
// init3D (scene3d/index.js:3876), so the `useSharedDrain` early-return
// fires first. Blast radius = the standalone capture path only.
const LEGACY_DIRECT_DRAIN_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("legacyDirectDrain")?.toLowerCase() === "on"
    );
  } catch (_) {
    return false;
  }
})();

// Per-entity last-applied action stamp (15-bit) for the multi-action FIFO's
// stamp-dedup. Mirrors retail's per-object `server_action_stamp`
// (acclient.c:344400-344414): an action plays only if its sequence is NEWER
// under the half-range wrap compare.
const _actionStamps = new Map();
function actionStampIsNewer(seq, stamp) {
  const a = seq & 0x7fff, b = stamp & 0x7fff;
  const diff = Math.abs(a - b);
  return diff <= 0x3fff ? b < a : a < b;
}

// DRAIN-WIRING FIX (2026-08-01) — `pollMotionActions` / `pollMotionAxes` are
// MODULE-LEVEL wasm exports (`#[wasm_bindgen(js_name = …)] pub fn …`,
// src/lib.rs:40490 / :40515 → `export function pollMotionActions()` at
// pkg/holtburger_web.d.ts:9290/:9297), NOT `SessionHandle` methods. Both drains
// below used to guard on `typeof sessionHandle.pollMotionX === "function"`, which
// is ALWAYS false, so they returned on line 1 every frame and the documented
// default-ON `?multiAction` / `?castAxes` flags had never executed.
//
// loop.js cannot statically `import … from "../pkg/…"` (the node suites
// source-transform this module with no pkg/ present, and the bake/net workers own
// their own wasm instances), so we resolve the free function off the
// `scene3d.wasmExports` bag that index.html already builds — the same
// typeof-guarded "additive namespace rider" convention every other module-level
// wasm export uses (index.html `dat_decode_diag`, `fetch_particle_degrade_distance`,
// `MotionSequence`, …). A stale pkg/ simply yields `undefined` → the drain
// no-ops exactly as it does today (F18-2 policy).
//
// A `SessionHandle` METHOD of the same name still wins if one ever exists, so a
// future Rust move onto the handle needs no JS change here.
//
// CAVEAT (documented, not fixed here): under `?netWorker=1` the Session state
// machine — and therefore the `MOTION_ACTIONS` / `MOTION_AXES` thread_locals —
// lives in the net worker's wasm instance, so the main-thread poll returns empty.
// That is unchanged from today (the drains were dead in both modes); routing the
// side-channels across the worker port is a Rust/worker-side follow-on.
function resolveMotionPollFn(scene3d, sessionHandle, name) {
  const method = sessionHandle && sessionHandle[name];
  if (typeof method === "function") return () => method.call(sessionHandle);
  const free = scene3d && scene3d.wasmExports && scene3d.wasmExports[name];
  if (typeof free === "function") return () => free();
  return null;
}

// Drain the wasm multi-action side-channel (`pollMotionActions`, flat 4-u32
// groups: [guid, command_low, packed_sequence, stance]) and FIFO-play each NEW
// action per entity. No-op only when `?multiAction=off` (default-ON). Plays via `em.setMotion`
// (same path the single motion_command uses) — Action-class commands resolve to
// their one-shot clip; unresolved ones no-op harmlessly. Local guid is skipped
// (the local caster predicts its own windups via playCastSequence).
//
// This is the channel that carries a PK/PKLite ("FastTick") caster's FULL windup
// gesture list: ACE packs every `spell.Formula.WindupGestures` entry into ONE
// UpdateMotion's `commands` vector (Player_Magic.cs:645 `EnqueueMotionAction`
// → WorldObject_Networking.cs:1231-1273), and the wasm main path emits only the
// FIRST of them as KIND_MOTION_ACTION — every LATER windup lands here. With the
// drain dead, a multi-scarab spell showed exactly one arm-raise on a remote
// caster instead of one per scarab.
//
// ORDER (HANDOFF-1070-vistest-2026-08-01 §A6): this drain runs AFTER
// drainEntityEvents3D (see the call sites below), so the observed sequence is
// [main-path action] then [these rows in array order]. The Rust side therefore
// puts the HEAD of the wire list on the main path and queues the tail in wire
// order — a scarab run plays first→last. Both halves of that contract are pinned
// natively (`cargo test -p holtburger-web tests_windup_action_order`). This loop
// must keep iterating FORWARD; reversing it re-breaks §A6 (and would make every
// row fail the ascending-sequence `actionStampIsNewer` dedup below).
function drainMotionActions(scene3d, sessionHandle) {
  if (!MULTI_ACTION_ON) return;
  const poll = resolveMotionPollFn(scene3d, sessionHandle, "pollMotionActions");
  if (!poll) return;
  let flat;
  try {
    flat = poll();
  } catch (_) {
    return;
  }
  if (!flat || flat.length < 4) return;
  const em = scene3d?.entityManager;
  if (!em) return;
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const guid = flat[i] >>> 0;
    if (isLocalPlayerGuid(guid)) continue;
    const cmdLow = flat[i + 1] >>> 0;
    const seq = flat[i + 2] & 0x7fff;
    const stance = flat[i + 3] >>> 0;
    const prev = _actionStamps.get(guid);
    if (prev !== undefined && !actionStampIsNewer(seq, prev)) continue;
    _actionStamps.set(guid, seq);
    em.setMotion(guid, cmdLow, stance, 1.0);
  }
}

// Casting-ingredient axes (2026-06-06) — `?castAxes` surfaces the remote
// sidestep + turn axes the single forward_command path drops, so a remote
// strafe-casting shows footwork and a remote turning in place shows the turn
// cycle. These are the retail casting *ingredients* (acclient
// get_state_velocity uses all three axes); built so a retail-faithful cast
// sequence renders fully, NOT forcing anything. DEFAULT-ON (the reader below is
// `!== "off"`; listed in the default-ON block at the top of docs/url-flags.md —
// the old "default OFF, needs a 1070 eye-test" note here was stale, WS06
// 2026-07-12). `?castAxes=off` to disable. Drains the wasm `pollMotionAxes`
// side-channel.
const CAST_AXES_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("castAxes")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();

function drainMotionAxes(scene3d, sessionHandle) {
  if (!CAST_AXES_ON) return;
  // Same module-export resolution as drainMotionActions — see resolveMotionPollFn.
  const poll = resolveMotionPollFn(scene3d, sessionHandle, "pollMotionAxes");
  if (!poll) return;
  let flat;
  try {
    flat = poll();
  } catch (_) {
    return;
  }
  if (!flat || flat.length < 5) return;
  const em = scene3d?.entityManager;
  if (!em) return;
  for (let i = 0; i + 4 < flat.length; i += 5) {
    const guid = flat[i] >>> 0;
    if (isLocalPlayerGuid(guid)) continue;
    const stance = flat[i + 1] >>> 0;
    const sideCmd = flat[i + 2] >>> 0;
    const turnCmd = flat[i + 3] >>> 0;
    const forwardIdle = flat[i + 4] >>> 0;
    // Sidestep → additive strafe overlay (strafe-cast footwork). Speed defaults
    // to 1.0 inside setSidestepLayer (OQ-3), matching today's local behaviour.
    if (sideCmd !== 0 && typeof em.setSidestepLayer === "function") {
      em.setSidestepLayer(guid, sideCmd, stance);
    }
    // Turn → a turn-in-place (no forward command) plays the turn cycle as the
    // base motion; heading-ease still drives the actual rotation, so the cycle is
    // just the legwork. When forward IS active (run / cast gesture), the turn is
    // ignored here — the forward cycle owns the legs, heading-ease the rotation.
    if (turnCmd !== 0 && forwardIdle && typeof em.setMotion === "function") {
      em.setMotion(guid, turnCmd, stance, 1.0);
    }
  }
}

// A2-P2 (2026-06-12, W3+ S8) — `?remoteInterp=on` (default OFF, composite:
// needs `?unifiedTick=on&wireStatePacks=stage1` or the wasm side degrades it
// and no rows ever arrive). Drains the wasm `pollRemotePoses` side-channel —
// the per-frame poses the Rust PositionManager (retail InterpolateTo /
// ConstrainTo remote driver) stepped this tick — and hands each row to
// `EntityManager.applyManagedPose`. Same flag-reader shape as CAST_AXES_ON.
const REMOTE_INTERP_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    // F-2026-06-27: DEFAULT-ON; only an explicit `=off` disables.
    return (
      new URLSearchParams(window.location.search).get("remoteInterp")?.toLowerCase() !==
      "off"
    );
  } catch (_) {
    return false;
  }
})();

function drainRemotePoses(scene3d, sessionHandle) {
  if (!REMOTE_INTERP_ON) return;
  // typeof-guard (F18-2 soft-degrade): a stale pkg without the export keeps
  // the legacy dead-reckon path — applyManagedPose is simply never armed.
  if (!sessionHandle || typeof sessionHandle.pollRemotePoses !== "function") return;
  let frame;
  try {
    frame = sessionHandle.pollRemotePoses();
  } catch (_) {
    return;
  }
  if (!frame) return;
  const em = scene3d?.entityManager;
  if (!em || typeof em.applyManagedPose !== "function") {
    if (frame.free) frame.free();
    return;
  }
  try {
    const guids = frame.guids;
    const landblocks = frame.landblocks;
    const poses = frame.poses;
    // A2-P3 R2 (`?stickyRetail=on`): per-row sticky-stepped flags.
    // `undefined` on a stale pkg without the getter (F18-2 soft-degrade:
    // every row is then non-sticky and the F3-4 glue keeps owning remote
    // sticky — the self-degrading compose rule).
    const stickyFlags = frame.stickyFlags;
    const n = Math.min(guids?.length ?? 0, landblocks?.length ?? 0);
    for (let i = 0; i < n; i++) {
      const g = guids[i] >>> 0;
      if (isLocalPlayerGuid(g)) continue;
      const lb = landblocks[i] >>> 0;
      const base = i * 7;
      // The exact KIND_POSITION drain math (landblock-local → world).
      const wx = ((lb >>> 24) & 0xff) * 192.0 + poses[base];
      const wy = ((lb >>> 16) & 0xff) * 192.0 + poses[base + 1];
      const wz = poses[base + 2];
      if (stickyFlags && stickyFlags[i]) {
        // A2-P3 R2: the wasm StickyManager stepped this row (retail
        // standoff/heading/1 s timeout, acclient.c:388519-388720). Hand
        // it ownership: clear the F3-4 glue for this entity (the glue
        // blocks applyManagedPose by design, S8 P2.d.2) and apply the
        // row WITH its heading. Rows are only ever flagged when the
        // wasm side is actually running remote sticky (?stickyRetail=on
        // × the remoteInterp composite × USE_STICKY_MANAGER × fresh
        // pkg), so the glue path self-restores in every degrade case.
        if (typeof em.setStickyTarget === "function") em.setStickyTarget(g, 0);
        em.applyManagedPose(
          g, wx, wy, wz,
          poses[base + 3], poses[base + 4], poses[base + 5], poses[base + 6]
        );
      } else {
        // Rotation rides the row (stride 7) but is deliberately unused on
        // non-sticky rows — heading stays on the JS K=14 ease (S8 OPEN Q4).
        em.applyManagedPose(g, wx, wy, wz);
      }
    }
  } finally {
    // wasm-bindgen struct — release the handle.
    if (frame.free) frame.free();
  }
}

// A2 (perf plan 2026-05-18) — get-or-allocate the per-guid slot in
// `window.__lastEntityWorldPos`. Mutates the slot in place on each
// KIND_POSITION instead of allocating a fresh `{x,y,z,ts}` literal.
// Consumers (camera.js#L806, entities.js#L1937) read fields
// synchronously and don't retain a reference, so reusing the slot
// is safe.
function _getOrCreatePosSlot(map, guid) {
  let slot = map.get(guid);
  if (!slot) {
    slot = { x: 0, y: 0, z: 0, ts: 0 };
    map.set(guid, slot);
  }
  return slot;
}

// A6 (perf plan 2026-05-18) — per-spawn scratch Uint32Arrays for
// `toMeta`'s three palette/model/texture vectors. The old code called
// `Uint32Array.from(upd.modelChanges)` × 3 per spawn; during a PVS
// burst (20+ simultaneous spawns from the academy ring or LB
// expansion) that's 60+ typed-array allocations cluster-bombing the GC.
//
// Strategy:
//   1. One shared `_emptyU32` sentinel returned for the (overwhelmingly
//      common) empty-payload case — zero allocation vs. the prior
//      `new Uint32Array(0)` literal per field.
//   2. For non-empty payloads, copy the wasm-bindgen view into a
//      generously-sized module scratch via `.set()` (a fast memcpy),
//      then `.slice(0, len)` to hand a stable, right-sized buffer to
//      the consumer. Slice is one allocation per field — same count as
//      `Uint32Array.from` — but the underlying primitive is tighter
//      (raw memcpy vs. iterator/length probe) and avoids a second
//      round-trip into the wasm-bindgen view if the JS engine doesn't
//      specialize.
//   3. Grow path: if a spawn's vector exceeds the current scratch
//      length, allocate a fresh scratch of size = nextPow2(needed).
//      Grow allocations are rare (initial 32 covers typical entity
//      payloads — palette substitutions in retail rarely exceed 8
//      triples / 24 u32s).
//
// SLICE IS MANDATORY HERE (not pass-by-reference): `EntityInstance`
// retains `meta` via `this.meta = meta;` (entities.js:205), and the
// async `_spawnImpl` awaits `animationCache.get()` which passes the
// typed arrays through to a wasm fetch. The next spawn would corrupt
// the prior entity's retained palette substitutions if we shared the
// scratch buffer directly.
let _modelChangesScratch = new Uint32Array(32);
let _textureChangesScratch = new Uint32Array(32);
let _subPalettesScratch = new Uint32Array(32);
const _emptyU32 = new Uint32Array(0);

function _nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Copies a wasm-bindgen `Uint32Array` view (or any array-like with a
// numeric `.length`) into the named scratch slot, growing the scratch
// if necessary, and returns a freshly-sliced right-sized copy.
// Returns the shared `_emptyU32` for null / zero-length sources.
//
// `slot` selects the module-level scratch: 0 = modelChanges,
// 1 = textureChanges, 2 = subPalettes. We dispatch through this
// integer + `let` rebinding rather than a holder object so the
// scratch references stay JIT-friendly module bindings.
function _sliceFromScratch(src, slot) {
  if (!src) return _emptyU32;
  const n = src.length | 0;
  if (n === 0) return _emptyU32;
  let scratch;
  if (slot === 0) scratch = _modelChangesScratch;
  else if (slot === 1) scratch = _textureChangesScratch;
  else scratch = _subPalettesScratch;
  if (n > scratch.length) {
    scratch = new Uint32Array(_nextPow2(n));
    if (slot === 0) _modelChangesScratch = scratch;
    else if (slot === 1) _textureChangesScratch = scratch;
    else _subPalettesScratch = scratch;
  }
  scratch.set(src);
  return scratch.slice(0, n);
}

function _nowMs() {
  return (typeof performance !== "undefined" && performance.now)
    ? performance.now()
    : Date.now();
}

// Cohere-B follow-on (2026-05-12): the 2D path's academy-rubberband
// fix (the `isLocal` branch in `index.html#handlePositionUpdate`'s
// sprite half — A15-Q4 comment-rot fix, was "index.html:4191-4214",
// which had drifted) explicitly skips syncing the local
// sprite to server `PublicUpdatePosition` / `PrivateUpdatePosition`
// broadcasts — the wasm integrator + JS prediction own the local
// sprite, and re-syncing on every UpdatePosition produces the visible
// "snaps back to starting spot when I move" the user reported (server
// pose lags client integration when, e.g., Run skill = 0). The 3D
// path was missing the equivalent guard at `em.setPose(localGuid,
// ...)` below. This helper centralises the local-player GUID lookup
// so both call sites (drainEntityEvents3D direct + dispatchOne shared
// hook) skip the snap consistently.
function isLocalPlayerGuid(g) {
  if (typeof window === "undefined") return false;
  try {
    const fn = window.getLocalPlayerGuid;
    if (typeof fn !== "function") return false;
    const lpg = fn();
    if (lpg === null || lpg === undefined) return false;
    return (g >>> 0) === (lpg >>> 0);
  } catch (_) {
    return false;
  }
}

// Cohere-B follow-on (2026-05-12): drive the local-player rig from the
// wasm integrator's `getLocalPlayerPose()` rather than from
// KIND_POSITION events. Mirrors the 2D path's per-rAF prediction tick
// (`index.html:6353-6420`) which writes `localEntry.sprite.x/.y`
// directly from keystate + dt; the 3D analogue reads the wasm
// integrator's authoritative pose (already integrator-smoothed; no
// server-pose blend that fights client prediction) and applies it to
// `inst.root.position/.quaternion`. Server-side reconciliation still
// happens INSIDE the wasm integrator silently — this layer just
// short-circuits the user-visible flash from late-arriving server
// poses landing as KIND_POSITION events on the local guid.
// Cohere-B follow-on v2 (2026-05-12): drive the local-player rig from
// Workstream B's `cameraSwitcher.predictedPlayerPos` instead of the
// wasm integrator's `getLocalPlayerPose()`. Mirrors the 2D path's
// architecture (`index.html:6353-6420` per-rAF prediction owns
// `sprite.x/.y`; the integrator pose is never read for the local
// sprite).
//
// Why the integrator-driven approach (v1) wasn't enough: ACE
// broadcasts `PublicUpdatePosition` at 5-10 Hz with the server's
// authoritative pose, which always lags client integration by a small
// amount (network latency + the server's slower physics tick + Run
// skill differences). The wasm integrator's internal reconcile pulls
// its pose backward on every broadcast and re-advances forward
// between broadcasts. `getLocalPlayerPose()` faithfully reports the
// oscillation; rendering it directly produces ~5-10 Hz visible jitter.
// A per-rAF rate limit (v1) can't smooth events arriving faster than
// the rate-limit horizon.
//
// `predictedPlayerPos` is exactly the smoothed alternative:
//   - Camera advances it by JS-side keystate × heading × dt (no
//     server-pose blend per frame).
//   - On fresh server pose arrival (via `__lastEntityWorldPos` ts
//     change), it starts a 150 ms lerp toward server pose. The lerp
//     completes well before the next broadcast lands, so the rendered
//     pose smoothly tracks server reality without visible per-
//     broadcast jitter.
//   - On large deltas (> 5 m), it snaps — preserves teleport feel.
//
// Heading is still sourced from the integrator's `getLocalPlayerPose`:
// turn rate is small (~1.5 rad/s × dt = 0.025 rad/frame) and doesn't
// oscillate visibly, so we don't need a prediction layer for it.
//
// Rig-Z smoothing (parkinsons-bob fix, 2026-06-02): X/Y use the smoothed
// `predicted` pose, but Z was sourced straight from the raw integrator
// (`getLocalPlayerPose().z`) to dodge the predicted.z hill-lag — and raw Z
// carries the SAME ~5-10 Hz server-reconcile oscillation the X/Y smoothing
// was added to remove, so the avatar visibly bobs vertically (worse on
// slopes, where Z actually moves). Exponential-ease the rendered rig Z
// toward the raw target: a short tau low-passes the bob with negligible
// altitude lag (still tracks the integrator's authoritative Z, no sinking
// below terrain), and deltas over the snap distance (teleport / landblock
// cross / fall landing) bypass the ease so big vertical moves stay crisp.
const RIG_Z_TAU_MS = 70.0;
const RIG_Z_SNAP_M = 1.0;
// F17 (2026-07-03, dossier A row 42) — `?rustPose=on` (default OFF): render
// the local player rig DIRECTLY from the wasm integrator pose
// (`getLocalPlayerPose()`), bypassing the JS smoothing stack — the
// cameraSwitcher `predictedPlayerPos` mirror for X/Y and the RIG_Z
// exponential ease above for Z. Retail renders m_position, period:
// `CPhysicsObj::set_frame` (acclient.c:321328) writes `m_position.frame`
// (:321344) and pushes it straight into the render parts
// (`CPartArray::SetFrame`, :321350) — interp/constraint mutate m_position
// INSIDE the sim, never as a render-side layer. The JS layers hid a
// reconcile oscillation whose Rust-side cause was fixed 2026-07-03
// (?retailLeash lattice + autonomy latch), so the bypass is viable pending
// a 1070 A/B (watching for the ~5-10 Hz jitter the banner above
// describes). The legacy layers are NOT deleted — flag-off is
// byte-identical; deletion happens after the A/B per the removal plan.
// camera.js reads the same flag for its `_safePlayerPos` framing read.
const RUST_POSE_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return parseRustPoseFlag(window.location.search);
  } catch (_) {
    return false;
  }
})();
function applyLocalPlayerPoseFromIntegrator(scene3d, sessionHandle) {
  if (!scene3d?.entityManager) return;
  if (!scene3d?.cameraSwitcher) return;
  if (typeof window === "undefined") return;
  const fn = window.getLocalPlayerGuid;
  if (typeof fn !== "function") return;
  let lpg;
  try { lpg = fn(); } catch (_) { return; }
  if (lpg === null || lpg === undefined) return;
  const guid = lpg >>> 0;
  const inst = scene3d.entityManager.entityMap.get(guid);
  if (!inst || !inst.root) return;

  // F17 (?rustPose=on) — direct-render the wasm integrator pose (see the
  // RUST_POSE_ON banner above). X/Y/Z/heading all come from ONE
  // `getLocalPlayerPose()` read this frame: no predictedPlayerPos mirror,
  // no RIG_Z ease/snap gate, no isOnGround branch. Pose unavailable
  // (pre-spawn / read failure / non-finite) → keep the last applied pose,
  // matching the legacy path's null-`predicted` early return. The
  // `_rigZSmooth` state is deliberately untouched — nothing reads it
  // flag-on, and flags are frozen at module load (a reload re-seeds it).
  if (RUST_POSE_ON) {
    let pose = null;
    if (sessionHandle && typeof sessionHandle.getLocalPlayerPose === "function") {
      try { pose = sessionHandle.getLocalPlayerPose(); } catch (_) { pose = null; }
    }
    const world = rustPoseWorldFromPose(pose);
    if (!world) return;
    scene3d.entityManager.setPose(
      guid,
      world.x, world.y, world.z,
      world.qw, 0.0, 0.0, world.qz
    );
    try { window.__diag?.physics?.onFrame?.(); } catch (_) {}
    return;
  }

  // Position source: X/Y from Workstream B predicted pose, Z from the
  // wasm integrator. Pre-spawn the predicted pose is null (no server-
  // pose anchor yet); the rig stays at its last applied position
  // until the first server pose lands — matches Workstream B's
  // camera behaviour, which falls through to a three-tier fallback
  // during the same window.
  //
  // Why split X/Y from Z: the reconcile flash that v1 was fighting is
  // a LATERAL phenomenon (server's slower run speed pulling the X/Y
  // pose backward along the heading axis). Z doesn't oscillate the
  // same way — terrain-following + gravity produces monotonic vertical
  // motion that the server-client integration agrees on. But
  // Workstream B's `_advancePrediction` only advances X and Y on WASD
  // (camera.js:953-954); predicted.z only updates via the 150 ms
  // reconcile lerp from each fresh server pose, so on hilly terrain
  // it LAGS the actual altitude. A lagging predicted.z would render
  // the rig (and its follow camera) below the terrain mesh on uphill
  // walks → terrain back-faced from below → INVISIBLE. Sourcing Z
  // straight from `getLocalPlayerPose().z` keeps the rig on the
  // ground at the integrator's authoritative altitude while X/Y still
  // benefit from the smoothed prediction.
  const predicted = scene3d.cameraSwitcher.predictedPlayerPos;
  if (!predicted) return;

  let posZ = predicted.z;
  let heading = 0;
  // Track B2: default grounded so the legacy terrain-clamp path is used
  // whenever the pose is unavailable (pre-spawn / read failure).
  let isOnGround = true;
  if (sessionHandle && typeof sessionHandle.getLocalPlayerPose === "function") {
    try {
      const pose = sessionHandle.getLocalPlayerPose();
      if (pose) {
        if (typeof pose.z === "number" && Number.isFinite(pose.z)) {
          posZ = pose.z;
        }
        if (typeof pose.heading === "number" && Number.isFinite(pose.heading)) {
          heading = pose.heading;
        }
        if (typeof pose.isOnGround === "boolean") {
          isOnGround = pose.isOnGround;
        }
      }
    } catch (_) {}
  }
  const qw = Math.cos(heading * 0.5);
  const qz = Math.sin(heading * 0.5);
  // The rendered terrain mesh now sits exactly on the faceted collision
  // surface the integrator's `posZ` is bound to (terrain_subdiv builds
  // vertex Z from `triangle_height_in_cell`: visual == collision), so
  // there is no visual-vs-collision gap to reconcile — render the rig
  // directly at the authoritative `posZ`. (Removed the per-frame
  // `getTerrainVisualZ` raycast + 0.3 m grounded lift, 2026-06-26.)
  // `let` (not `const`): the grounded low-pass below reassigns renderZ.
  let renderZ = posZ;

  // Low-pass the rig Z to kill the ~5-10 Hz vertical reconcile bob (see
  // the note atop this fn). Ease a persisted rig-Z toward `renderZ`; snap
  // through on big jumps. Framerate-independent (eases by wall-clock dt).
  //
  // Track B2: bypass the low-pass while airborne — the ballistic arc is
  // a fast, intentional vertical move (not reconcile noise), so the
  // 70 ms tau would lag/round it. Write `renderZ` straight through and
  // keep the smoother's state in sync so the first grounded frame after
  // touchdown eases from the correct altitude instead of snapping.
  {
    const now = (typeof performance !== "undefined" && performance.now)
      ? performance.now()
      : Date.now();
    if (!isOnGround) {
      scene3d._rigZSmooth = { z: renderZ, ts: now };
    } else {
      const st = scene3d._rigZSmooth;
      if (st && Number.isFinite(st.z) && Math.abs(renderZ - st.z) <= RIG_Z_SNAP_M) {
        const dtMs = Math.max(0, Math.min(now - st.ts, 100));
        st.z += (renderZ - st.z) * (1.0 - Math.exp(-dtMs / RIG_Z_TAU_MS));
        st.ts = now;
        renderZ = st.z;
      } else {
        scene3d._rigZSmooth = { z: renderZ, ts: now };
      }
    }
  }

  scene3d.entityManager.setPose(
    guid,
    predicted.x, predicted.y, renderZ,
    qw, 0.0, 0.0, qz
  );
  try { window.__diag?.physics?.onFrame?.(); } catch (_) {}
}

/**
 * Per-rAF tick. Called from `init3D`'s render loop with the live
 * `scene3d` shape, the wasm `SessionHandle` (may be null pre-spawn),
 * and the per-frame delta time in seconds.
 *
 * Order matters:
 *   1. Cell visibility (cheap; gates the rest of the scene).
 *   2. EntityManager.tick(dt) — advances mixers BEFORE we apply pose
 *      updates so the visual matches the new wire state on the same
 *      frame.
 *   3. drainEntityEvents3D — applies any queued events to the
 *      manager. Spawn is async; setMotion is async; setPose is sync.
 *      The async ones get scheduled on a microtask and apply on the
 *      next tick.
 */
/**
 * Phase 2.2 — push the shared wall-clock seconds onto every terrain
 * ShaderMaterial's `uTime` uniform. Single time source means matched
 * wave motion across LB seams (water animations stay phase-locked at
 * neighbouring landblock boundaries).
 *
 * Reads `scene3d.frameTime.tsSec`, the per-frame wall-clock snapshot
 * stamped by the rAF callback in scene3d/index.js. Same numeric value
 * as a fresh `performance.now() * 0.001` but sourced from the shared
 * snapshot so we don't grow a multi-clock zoo (cf. "three time sources"
 * in INTERACTING_LAYERS_ANALYSIS.md). Fallback to a fresh now() lets
 * capture scripts and tests that call this outside the rAF loop still
 * work.
 *
 * No-op when the registry is empty (pre-buildHoltburgTerrain) or when
 * subdivLevel < 2 (the material was built with uDisplacementEnabled=0
 * already, but pushing uTime is still safe — non-water cells gate on
 * the same uniform inside the shader).
 */
function tickTerrainUTime(scene3d) {
  if (!scene3d?.terrainMaterials || scene3d.terrainMaterials.length === 0) {
    return;
  }
  const tSec =
    scene3d.frameTime?.tsSec ??
    ((typeof performance !== "undefined" && performance.now)
      ? performance.now() * 0.001
      : Date.now() * 0.001);
  // Wave 2B (plan §3.6 item 3) — the VOLCANO crack glow's slow breath, sampled
  // from the shared oscillator registry and PUSHED here for the same reason
  // uTime is pushed: `terrain_batch.js::_buildBatchMaterial` CLONES each uniform
  // VALUE into a fresh `{value}` object, and `?terrainBatch` is DEFAULT-ON — a
  // by-reference binding would silently freeze the breath on the batched path.
  // `undefined` when the channel is unregistered (crack glow off), which leaves
  // every `uCrackGlowBreath` at its shader default; the block is gated off then
  // anyway. Reads LAST frame's sample (tickVfxOscillators runs after this one);
  // at 0.07 Hz that is ~4e-4 rad of phase, i.e. nothing.
  const breathOsc = getOscillator(CRACK_GLOW_OSC_NAME);
  const breath = breathOsc ? breathOsc.value : undefined;
  for (const mat of scene3d.terrainMaterials) {
    if (mat?.uniforms?.uTime) {
      mat.uniforms.uTime.value = tSec;
    }
    if (breath !== undefined && mat?.uniforms?.uCrackGlowBreath) {
      mat.uniforms.uCrackGlowBreath.value = breath;
    }
  }
}

/**
 * Phase 1 (Visual-Behavior Suite, spec §7) — drive the shared VFX uniforms.
 * The SINGLE per-frame VFX tick: writes VFX_GLOBALS.uTime (the master clock) plus
 * every registered oscillator channel ONCE per frame, O(1) (no per-instance
 * work). Sourced from the SAME `scene3d.frameTime.tsSec` snapshot tickTerrainUTime
 * reads, so the VFX clock and the terrain water clock never drift (single time
 * source — cf. the "three time sources" hazard in INTERACTING_LAYERS_ANALYSIS.md).
 *
 * Cheap + unconditional: with no effect active the oscillator registry is empty,
 * so this is one scalar write to the uTime uniform (which no material binds until
 * a frag/MECH-B variant is built) — byte-identical render when ?visual is off.
 * The fallback clock keeps capture scripts / tests that tick outside the rAF loop
 * working, exactly like tickTerrainUTime.
 */
function tickVfxOscillators(scene3d) {
  const tSec =
    scene3d?.frameTime?.tsSec ??
    ((typeof performance !== "undefined" && performance.now)
      ? performance.now() * 0.001
      : Date.now() * 0.001);
  const dt = scene3d?.frameTime?.dt ?? 0;
  tickOscillators(tSec, dt);
}

/**
 * Phase 1 (Visual-Behavior Suite, slice 12) — drive the three CLIENT-SIDE
 * weather/wind uniforms (VFX_GLOBALS.uWetness / uFrost / uWindDir) from the
 * already-client-derived weather_state snapshot. Ticked right AFTER
 * tickVfxOscillators so it reads the SAME `scene3d.frameTime.tsSec` the master
 * clock (uTime) was just driven from — wind/wetness stay phase-locked with
 * uTime, no second clock. O(1) + zero per-frame alloc.
 *
 * Unconditional + byte-identical when off: like the oscillator's uTime write,
 * uWetness/uFrost/uWindDir are dormant {value} objects no material binds until
 * a frag weathering variant is built (only when ?visual is on). Writing them
 * with ?visual off changes nothing on screen. Kept always-on (not flag-gated)
 * so the smoothing state stays warm if the user flips ?visual mid-session.
 */
function tickVfxWeatherInputs(scene3d) {
  const tSec =
    scene3d?.frameTime?.tsSec ??
    ((typeof performance !== "undefined" && performance.now)
      ? performance.now() * 0.001
      : Date.now() * 0.001);
  tickWeatherInputs(tSec);
}

/**
 * Push the live AC-z-up sun direction into all terrain ShaderMaterials.
 * Replaces the prior hardcoded literal in the terrain fragment shader so
 * cloud shadows + NdotL track the actual SkyState dirHeading/dirPitch
 * the rest of the atmosphere stack reads. Source of truth is
 * `skyLightingController._lastState`, the same snapshot
 * `atmosphereLights.tick` + `atmosphereSky.tick` already consume — no
 * second wasm getSkyState() call.
 *
 * No-op pre-populator (state null) or pre-buildHoltburgTerrain (empty
 * registry); the material uniform's default literal covers that frame.
 */
// === RND-20/21 — retail terrain light-tick state ===
// `LSCAPE_LIGHT_MINIMUM` (acclient.c:40344) floors the AMBIENT level only.
const AC_LSCAPE_LIGHT_MINIMUM = 0.2;

/**
 * Night multiplier for the retail-Gouraud terrain light, in (0, 1]. Recomputed
 * on the 15 s retail light tick with everything else, so the terrain steps into
 * night on the authored cadence rather than sliding per frame.
 */
function _nightGroundMul(state) {
  try {
    if (!nightRampEnabled()) return 1.0;
    const pitch = state && Number.isFinite(state.dirPitch) ? state.dirPitch : null;
    if (pitch == null) return 1.0;
    const n = nightFactorFromAuthoredPitch(pitch);
    return 1.0 + n * (nightGroundScale() - 1.0);
  } catch (_) {
    return 1.0;
  }
}
// Dereth's Region DAT (portal 0x13000000) carries skyInfo.lightTickSize = 15.0
// as an f64; acclient's no-region fallback is 3.0 (acclient.c:307294) and the
// SkyDesc ctor seeds 20.0 (acclient.c:301477). 15 is what the shipped client
// actually used in Dereth.
const AC_LIGHT_TICK_SECONDS = 15.0;
const _acTerrainGouraud = {
  nextLightTick: -Infinity,
  epoch: 0,
  sun: [0, 0, 0],
  sunColor: [1, 1, 1],
  ambColor: [1, 1, 1],
  ambLevel: AC_LSCAPE_LIGHT_MINIMUM,
};

// === visual-quality wave (2026-08-02) — TERRAIN world-light calibration ===
//
// WHY THIS EXISTS. `atmosphere_lights.js`'s 2026-06-27 calibration
// (`worldLightScale`, default 0.4) pulls the takram sun + sky probe back into
// AGX's colour-true range so lit SURFACES stop washing toward white at the
// composer's `toneMappingExposure = 5` (scene3d/index.js ~:4999). That scale
// reaches everything three.js lights — buildings, statics, entities — but the
// TERRAIN is not lit by those lights at all: `ACRender::landPolyDraw`
// (acclient.c:719994) calls `SetFFLighting(0)`, so our terrain shader
// reproduces retail's per-vertex Gouraud term instead
// (`terrain.js` ~:3207: `acC = min(1, uAcSunColor*L + uAcAmbColor*uAcAmbLevel)`
// then `modulated *= acC`). That term is DISPLAY-REFERRED (0..1), and it was
// the one surface class the world-light calibration never reached — so the
// terrain alone still eats the full 5x exposure.
//
// MEASURED ON THE 1070 (pinned Holtburg, `?renderScale=1&adaptiveRes=off`,
// `setSkyTimeOverride(19/24)`): at midday/afternoon `acC` CLAMPS to ~1.0 on
// flat ground, so the terrain renders at full albedo and AGX at exposure 5
// bleaches it — grass sampled #8A9864, a pale yellow-green with no shading
// gradient. Scaling the two colour uniforms restores both the gradient and
// the chroma: 0.6 -> #728050, 0.4 -> #5F6B3B (see vistest2 tls19b-grid.png).
//
// GRAMMAR: numeric opt-in, `?terrainLightScale=1` restores the pre-2026-08-02
// look exactly. Live setter `window.__setTerrainLightScale(v)`.
const AC_TERRAIN_LIGHT_SCALE_DEFAULT = 0.55;
// Saturation of the DayGroup ambient TINT, 1 = retail data verbatim.
// Dereth's DayGroups author `ambColor` = (200,100,255) for the whole
// 20:10h-03:50h block (portal 0x13000000 skyInfo.dayGroups[*].skyTime) — a
// literal magenta. The hue is retail's, but the terrain Gouraud term is the
// only place it lands undiluted, which is what reads as the "magenta/lavender
// terrain at dusk". `?ambTintSat` lerps it toward its own luminance.
//
// DEFAULT CHANGED 1.0 -> 0.6 (2026-08-02, visual pass 2). Pass 1 shipped 1.0
// on the "reproduce the authored bytes" principle, and that was right for a
// client whose night was a dimly-lit late afternoon: the tint was one term
// among many. `?nightRamp` landed in the SAME pass-2 session and made nights
// genuinely dark, and at a real 02:00 that same chroma is now the loudest
// colour in the frame -- 1070-measured on the Holtburg town vantage, the
// gravel roads render lavender and the grass reads muddy olive
// (GRID-AMB2.png, arms 1.00 / 0.75 / 0.60). At 0.6 the cold magenta-blue
// moonlight is still plainly on the gravel and grass reads as grass:
// measured hue 59 deg -> 78 deg, sat 0.367 -> 0.523.
// `?ambTintSat=1` restores the byte-faithful tint exactly.
const AC_AMB_TINT_SAT_DEFAULT = 0.6;
function _readNumFlag(name, dflt, lo, hi) {
  try {
    if (typeof window === "undefined" || !window.location) return dflt;
    const raw = new URLSearchParams(window.location.search || "").get(name);
    if (raw == null || raw === "") return dflt;
    const v = Number(raw);
    if (!Number.isFinite(v)) return dflt;
    return Math.min(hi, Math.max(lo, v));
  } catch (_) {
    return dflt;
  }
}
const _acTerrainLight = {
  scale: _readNumFlag("terrainLightScale", AC_TERRAIN_LIGHT_SCALE_DEFAULT, 0, 4),
  ambSat: _readNumFlag("ambTintSat", AC_AMB_TINT_SAT_DEFAULT, 0, 1),
};
if (typeof window !== "undefined") {
  // Live 1070 tuning handles (mirror `__setWorldLightScale`). Both take effect
  // on the NEXT retail light tick; bump the epoch so it is the next frame.
  window.__setTerrainLightScale = (v) => {
    _acTerrainLight.scale = Math.min(4, Math.max(0, +v));
    _acTerrainGouraud.nextLightTick = -Infinity;
    return _acTerrainLight.scale;
  };
  window.__setAmbTintSat = (v) => {
    _acTerrainLight.ambSat = Math.min(1, Math.max(0, +v));
    _acTerrainGouraud.nextLightTick = -Infinity;
    return _acTerrainLight.ambSat;
  };
  window.__terrainLightState = () => ({ ..._acTerrainLight });
}

function tickTerrainSunDir(scene3d) {
  if (!scene3d?.terrainMaterials || scene3d.terrainMaterials.length === 0) {
    return;
  }
  const state = scene3d.skyLightingController?._lastState ?? null;
  if (!state) return;
  const heading = state.dirHeading;
  const pitch = state.dirPitch;
  if (!Number.isFinite(heading) || !Number.isFinite(pitch)) return;
  const DEG = Math.PI / 180;
  const cp = Math.cos(pitch * DEG);
  const sx = cp * Math.sin(heading * DEG);
  const sy = cp * Math.cos(heading * DEG);
  const sz = Math.sin(pitch * DEG);

  // RND-20/21 — retail terrain Gouraud inputs. `LScape::UseTime`
  // (acclient.c:307257) only re-lights the landscape when the light tick
  // expires: Dereth's Region DAT carries skyInfo.lightTickSize = 15 s (the
  // acclient no-region fallback is 3 s, acclient.c:307294, and the SkyDesc
  // ctor default is 20 s, acclient.c:301477). Quantising to that cadence is
  // not an optimisation — the visible stepping of terrain brightness IS the
  // retail look, and a per-frame push would smooth it away.
  const g = _acTerrainGouraud;
  const nowSec = scene3d?.frameTime?.tsSec
    ?? ((typeof performance !== "undefined" && performance.now)
      ? performance.now() * 0.001
      : Date.now() * 0.001);
  const lightTickDue = !(nowSec < g.nextLightTick);
  if (lightTickDue) {
    g.nextLightTick = nowSec + AC_LIGHT_TICK_SECONDS;
    g.epoch += 1;
    // sunlight_vec carries dirBright as its MAGNITUDE
    // (SkyDesc::GetLighting, acclient.c:301548-301560).
    const db = Number.isFinite(+state.dirBright) ? Math.max(0, +state.dirBright) : 0;
    g.sun[0] = sx * db;
    g.sun[1] = sy * db;
    g.sun[2] = sz * db;
    // visual-quality wave (2026-08-02): both colour terms carry the terrain
    // world-light scale (see AC_TERRAIN_LIGHT_SCALE_DEFAULT). Scaling BOTH —
    // rather than only the ambient — is what un-clamps `acC` at midday and so
    // restores the shading gradient the pre-2026-08-02 look had lost.
    // NIGHT RAMP (2026-08-02, ?nightRamp / ?nightGround). Terrain is NOT lit by
    // three.js lights (retail SetFFLighting(0)) so the indirect night dim
    // applied in ibl_environment.js cannot reach it — this is its counterpart
    // on the retail-Gouraud term, and it rides the SAME night fraction so the
    // ground and the characters standing on it darken together. Multiplier is
    // exactly 1.0 by day and whenever the flag is off, so nothing about the
    // daytime calibration moves.
    const tls = _acTerrainLight.scale * _nightGroundMul(state);
    const dc = (state.dirColorArgb >>> 0);
    g.sunColor[0] = (((dc >>> 16) & 0xff) / 255) * tls;
    g.sunColor[1] = (((dc >>> 8) & 0xff) / 255) * tls;
    g.sunColor[2] = ((dc & 0xff) / 255) * tls;
    const ac = (state.ambColorArgb >>> 0);
    let ar = ((ac >>> 16) & 0xff) / 255;
    let ag = ((ac >>> 8) & 0xff) / 255;
    let ab2 = (ac & 0xff) / 255;
    // Optional chroma pull toward the tint's own Rec.709 luminance. sat=1
    // (default) leaves the retail bytes untouched.
    const sat = _acTerrainLight.ambSat;
    if (sat < 1) {
      const lum = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab2;
      ar = lum + (ar - lum) * sat;
      ag = lum + (ag - lum) * sat;
      ab2 = lum + (ab2 - lum) * sat;
    }
    g.ambColor[0] = ar * tls;
    g.ambColor[1] = ag * tls;
    g.ambColor[2] = ab2 * tls;
    // LSCAPE_LIGHT_MINIMUM floors AMBIENT ONLY (acclient.c:40344, 307261);
    // dirBright above is deliberately left free to reach 0 at night.
    const ab = +state.ambBright;
    g.ambLevel = Math.max(AC_LSCAPE_LIGHT_MINIMUM, Number.isFinite(ab) ? ab : 0);
  }

  for (const mat of scene3d.terrainMaterials) {
    const v = mat?.uniforms?.uSunDir?.value;
    if (v && typeof v.set === "function") {
      v.set(sx, sy, sz);
    }
    const u = mat?.uniforms;
    if (!u || !u.uAcSunVec) continue;
    // Epoch guard, not `lightTickDue`: a landblock baked between ticks would
    // otherwise render at the seed uniforms (black sun) for up to a full tick.
    if (mat.userData && mat.userData.__acLightEpoch === g.epoch) continue;
    if (mat.userData) mat.userData.__acLightEpoch = g.epoch;
    u.uAcSunVec.value.set(g.sun[0], g.sun[1], g.sun[2]);
    u.uAcSunColor.value.setRGB(g.sunColor[0], g.sunColor[1], g.sunColor[2]);
    u.uAcAmbColor.value.setRGB(g.ambColor[0], g.ambColor[1], g.ambColor[2]);
    u.uAcAmbLevel.value = g.ambLevel;
  }
}

// === W3 — clouds-independent weather tick (2026-05-29) ===
//
// Pre-W3 the ONLY caller of `weather_state.updateFromDayGroup` was
// `cloud_volume.js`'s tick (inside the cloud raymarch), so the weather
// profile + is_storm only refreshed when `?clouds=on`. The synthetic
// rain/lightning + the W1 SkyObject billboards therefore stayed inert on
// the default path. This hook moves the weather-state update onto the
// always-on per-frame path:
//
//   1. read the cached SkyState (`skyLightingController._lastState`) — the
//      same snapshot the rest of the sky stack consumes; no extra wasm call.
//   2. pull the active DayGroup's SkyObject snapshots
//      (`sessionHandle.getSkyObjectStates()`) so W4 can derive is_storm from
//      the REAL DAT weather-SkyObject presence (not the fabricated table).
//   3. push the derived profile into `weather_state` and the SkyObject scan
//      result (indoor flag + streak/droplet metadata) into the weather
//      effects manager (W2 precip selection + W5 indoor gate).
//   4. feed the same SkyObject snapshots to the W1 sky-dome billboard host.
//
// DOUBLE-DRIVE GUARD: `cloud_volume.js`'s `wxUpdateFromDayGroup` call was
// removed in this wave, so this is now the sole driver whether or not
// clouds are on. Fail-soft: any missing piece (no controller, null state,
// no session, empty snapshot array) silently no-ops to the prior behavior.
function tickWeatherState(scene3d, sessionHandle) {
  const state = scene3d?.skyLightingController?._lastState ?? null;
  if (!state) return;

  // SkyObject snapshots for the active DayGroup (W4 real-signal source).
  // Lazy-resolve the session handle the same way the sky controllers do.
  let skyObjects = null;
  const handle =
    sessionHandle ??
    (typeof window !== "undefined" ? window.__sessionHandle : null) ??
    scene3d?.sessionHandle ??
    null;
  if (handle && typeof handle.getSkyObjectStates === "function") {
    try {
      skyObjects = handle.getSkyObjectStates();
    } catch (_) {
      skyObjects = null;
    }
  }

  // W4 — profile (T/Td/P heuristic) + is_storm derived from real weather
  // SkyObjects when the snapshot array is available.
  try {
    const profile = weatherForState(state, state.dayGroupIndex, skyObjects);
    wxUpdateFromDayGroup(profile);

    // W5 indoor flag — reuse the skyDome's freshly-read indoor state when
    // present (it reads isCurrentCellIndoor() each tick); fall back to a
    // direct read so the billboard host still gates when the dome is absent.
    let indoor = scene3d?.skyDome?._lastIsIndoor;
    if (typeof indoor !== "boolean" && handle &&
        typeof handle.isCurrentCellIndoor === "function") {
      try { indoor = !!handle.isCurrentCellIndoor(); } catch (_) { indoor = false; }
    }
    if (typeof indoor !== "boolean") indoor = false;

    // W1 — drive the parametric sky-dome weather billboard host with the
    // same snapshot array (the host gates itself on its `?skyWeather`
    // flag + the props/window bits, and no-ops indoors).
    if (scene3d?.skyDome?.updateWeatherSkyObjects) {
      scene3d.skyDome.updateWeatherSkyObjects(skyObjects, indoor);
    }
    // Task #4 — realize SkyObject Swarm (bird/aurora) particle chains from the
    // same snapshot. Self-gated on `?skyBirds=on`; idempotent per pesObjectId.
    if (scene3d?.skyDome?.updateSkyParticleChains) {
      scene3d.skyDome.updateSkyParticleChains(skyObjects, scene3d.wasmExports);
    }
  } catch (_) {
    // Weather wiring must never kill the frame.
  }
}

// === Wave R1.C — fog color lerp (2026-05-28) ===
//
// Parse `?fogLerp` from the page URL.
//
// 2026-08-02 FAR-TERRAIN S1 — PROMOTED TO DEFAULT-ON (escape `?fogLerp=off`,
// or the wave master `?farTerrain=off` / `?terrainFog=off`). Rationale: retail
// closed its horizon with authored linear range fog out of the DAT
// (SkyDesc::GetWorldFog, acclient.c:301602), that data is already ported into
// wasm as SkyState.fogMin/fogMax/fogColorArgbLerp, and this reader is what
// decides whether the client actually uses it. It stayed opt-in only because
// the terrain shader had no fog code to receive it — which the shared fog tail
// (terrain_shared_glsl.js) now fixes. Keeping it opt-in would ship a horizon
// mechanism nobody turns on.
//
// The literal-"on" form still forces it on when the master escapes are set.
let _fogLerpFlagCache;
function readFogLerpFlag() {
  if (_fogLerpFlagCache !== undefined) return _fogLerpFlagCache;
  try {
    if (typeof window === "undefined" || !window.location) {
      _fogLerpFlagCache = false;
      return false;
    }
    const v = new URLSearchParams(window.location.search).get("fogLerp");
    const s = typeof v === "string" ? v.toLowerCase() : null;
    if (s === "on" || s === "1" || s === "true" || s === "yes") {
      _fogLerpFlagCache = true;
    } else if (s === "off" || s === "0" || s === "false" || s === "no") {
      _fogLerpFlagCache = false;
    } else {
      _fogLerpFlagCache = terrainFogEnabled();
    }
  } catch (_) {
    _fogLerpFlagCache = false;
  }
  return _fogLerpFlagCache;
}

// ===========================================================================
// HORIZON SKY RADIANCE PROBE (fix round 2026-08-03 — validator defects 1 + 3)
// ===========================================================================
//
// THE DEFECT. `scene.fog.color` is consumed as PRE-EXPOSURE SCENE RADIANCE:
// terrain and statics render into the composer's HalfFloat HDR buffer, the
// composer then applies `toneMappingExposure = 5` (index.js) and AGX
// (atmosphere_pipeline.js). Feeding it the AUTHORED sRGB hex — an 8-bit
// DISPLAY value — therefore over-drives it by roughly the exposure factor.
// Measured on the HD520: authored day 0xC6C8CC rendered (223,225,230);
// authored night 0x171725 rendered (64,68,97) against a night sky of (2,2,2).
// The visible result is a 60-level bright band where fogged terrain meets the
// sky at 19:00 and a grey wall glowing out of a black sky at 02:00.
//
// THE FIX. Sample the RENDERED SKY's radiance just above the horizon, in the
// camera's own azimuth, and feed THAT to the uniform. It is in scene-radiance
// space by construction — same buffer, same exposure, same tone curve — so a
// 100 %-fogged terrain pixel converges to the sky pixel directly above it at
// every hour, with no gamma/AGX inversion to derive and nothing to re-tune when
// the sky model changes. Retail's authored fog RANGES are untouched; the
// authored CHROMA is available at `?farFogTint=N` (default 0, see the flag).
//
// HOW. One tiny private render of the sky scene (the takram SkyMaterial quad
// only — stars/moons hidden for the probe) through a narrow-FOV camera aimed
// `farFogSkyElevDeg` above the horizon, into an 8x8 HalfFloat target, then a
// readback. The readback IS a GPU sync, so it is throttled to `farFogSkyHz`
// (default 4 Hz) and skipped entirely indoors, when `scene.fog` is absent, and
// after three consecutive failures (sticky fall-back to the authored hex).
//
// WHY NOT the composer's own sky pass: its buffer is overwritten by the world
// pass in the same frame, and the horizon row's screen position depends on the
// camera pitch — at the validator's `ov`/`hill` vantages the geometric horizon
// is not near the middle of the frame. A private camera asks the question
// directly and costs one 8x8 draw.
const _FOG_PROBE_PX = 8;
/** Probe cone, degrees. Centred on `farFogSkyElevDeg` → +/- 1.5 deg around it. */
const _FOG_PROBE_FOV_DEG = 3;
const _FOG_PROBE_MAX_FAILS = 3;
let _fogProbeRT = null;
let _fogProbeCam = null;
let _fogProbeBuf = null;
let _fogProbeNextMs = 0;
let _fogProbeFails = 0;
let _fogProbeDead = false;
let _fogProbeLast = null;
const _fogProbePos = new THREE.Vector3();
const _fogProbeFwd = new THREE.Vector3();
const _fogProbeDir = new THREE.Vector3();
const _fogTintColor = new THREE.Color();

/** IEEE-754 binary16 → Number. `readRenderTargetPixels` on a HalfFloatType
 *  target hands back raw 16-bit patterns in a Uint16Array. */
function _halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return s * f * 5.9604644775390625e-8;          // 2^-24
  if (e === 0x1f) return f ? NaN : s * Infinity;
  return s * (f + 1024) * Math.pow(2, e - 25);
}

/**
 * Render + read the sky radiance just above the horizon in the camera azimuth.
 * Returns `{ r, g, b }` in LINEAR working space (pre-exposure), or null when
 * the probe cannot run this frame (indoors, no sky yet, throttled, disabled).
 * The last good sample is reused between throttled ticks by the caller.
 */
function sampleHorizonSkyRadiance(scene3d) {
  if (_fogProbeDead) return null;
  const renderer = scene3d?.renderer;
  const skyScene = scene3d?.skyDome?.skyScene;
  const cam = scene3d?.camera;
  // `atmosphereSky` resolves ~seconds after boot; before that the sky scene has
  // no radiance quad and a probe would read the clear colour.
  const quad = scene3d?.atmosphereSky?.skyMesh ?? null;
  if (!renderer || !skyScene || !cam || !quad) return null;
  if (scene3d?.skyDome?._lastIsIndoor) return null;
  // 2026-08-03 LOAD FIX — two new early-outs, both boot-shaped:
  // (a) `?nullRender=1` bots: this probe calls renderer.render directly (not
  //     through the loop's render step), so it silently un-did nullRender's
  //     "no GPU work" contract.
  // (b) During the initial terrain fill the pipeline is upload-saturated and
  //     `readRenderTargetPixels` is a full GPU sync — the worst possible
  //     moment for 4 stalls/sec. The authored-hex fallback carries the fog
  //     colour until the first landblock is baked (seconds), after which the
  //     probe takes over exactly as before.
  if (scene3d?.nullRender) return null;
  if (!(scene3d?.terrainBakedLbs?.size > 0)) return null;

  const hz = farFogSkyHz();
  const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  if (now < _fogProbeNextMs) return null;
  _fogProbeNextMs = now + 1000 / Math.max(0.1, hz);

  const savedVisible = [];
  let prevTarget = null;
  let prevAutoClear = true;
  let restoreRenderer = false;
  try {
    if (!_fogProbeCam) {
      _fogProbeCam = new THREE.PerspectiveCamera(_FOG_PROBE_FOV_DEG, 1, 1, 1e7);
      _fogProbeCam.name = "far-fog-horizon-probe";
    }
    if (!_fogProbeRT) {
      _fogProbeRT = new THREE.WebGLRenderTarget(_FOG_PROBE_PX, _FOG_PROBE_PX, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      });
      _fogProbeBuf = new Uint16Array(_FOG_PROBE_PX * _FOG_PROBE_PX * 4);
    }

    // Aim: the camera's forward azimuth, flattened onto the horizontal plane
    // (three world space is Y-up; see sun_direction.js for the AC→three
    // transform), then lifted `farFogSkyElevDeg` above the horizon. A parked
    // straight-down camera degenerates → fall back to -Z.
    cam.getWorldPosition(_fogProbePos);
    cam.getWorldDirection(_fogProbeFwd);
    _fogProbeFwd.y = 0;
    if (_fogProbeFwd.lengthSq() < 1e-8) _fogProbeFwd.set(0, 0, -1);
    _fogProbeFwd.normalize();
    const elev = farFogSkyElevDeg() * Math.PI / 180;
    const ce = Math.cos(elev);
    _fogProbeDir.set(_fogProbeFwd.x * ce, Math.sin(elev), _fogProbeFwd.z * ce).normalize();
    _fogProbeCam.position.copy(_fogProbePos);
    _fogProbeCam.up.set(0, 1, 0);
    _fogProbeCam.lookAt(
      _fogProbePos.x + _fogProbeDir.x,
      _fogProbePos.y + _fogProbeDir.y,
      _fogProbePos.z + _fogProbeDir.z,
    );
    _fogProbeCam.updateMatrixWorld(true);
    _fogProbeCam.updateProjectionMatrix();

    // Stars, moon billboards and any cloud band in the sky scene are POINT
    // sources / overlays, not the horizon haze we are asking about — a single
    // star landing in an 8x8 probe would swing the fog colour. Radiance quad
    // only, restored in `finally`.
    const kids = skyScene.children;
    for (let i = 0; i < kids.length; i += 1) {
      savedVisible.push(kids[i].visible);
      kids[i].visible = (kids[i] === quad);
    }

    prevTarget = renderer.getRenderTarget();
    prevAutoClear = renderer.autoClear;
    restoreRenderer = true;
    renderer.setRenderTarget(_fogProbeRT);
    renderer.autoClear = true;
    renderer.render(skyScene, _fogProbeCam);
    // SENTINEL. `readRenderTargetPixels` reports an unreadable target by
    // console-erroring and RETURNING — it does not throw and it does not touch
    // the buffer. Pre-filling with 0xFFFF (a binary16 NaN) makes that silent
    // path indistinguishable from success impossible: every texel decodes
    // non-finite, `n` stays 0, and we take the sticky fallback below instead of
    // quietly driving the fog to black.
    _fogProbeBuf.fill(0xffff);
    renderer.readRenderTargetPixels(
      _fogProbeRT, 0, 0, _FOG_PROBE_PX, _FOG_PROBE_PX, _fogProbeBuf,
    );

    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let i = 0; i < _fogProbeBuf.length; i += 4) {
      const pr = _halfToFloat(_fogProbeBuf[i]);
      const pg = _halfToFloat(_fogProbeBuf[i + 1]);
      const pb = _halfToFloat(_fogProbeBuf[i + 2]);
      if (!Number.isFinite(pr) || !Number.isFinite(pg) || !Number.isFinite(pb)) continue;
      r += pr; g += pg; b += pb; n += 1;
    }
    if (n === 0) throw new Error("probe read no finite texels");
    const out = {
      r: Math.max(0, r / n),
      g: Math.max(0, g / n),
      b: Math.max(0, b / n),
      elevDeg: farFogSkyElevDeg(),
      at: now,
    };
    _fogProbeFails = 0;
    _fogProbeLast = out;
    if (typeof window !== "undefined") window.__farFogSkyProbe = out;
    return out;
  } catch (err) {
    _fogProbeFails += 1;
    if (_fogProbeFails >= _FOG_PROBE_MAX_FAILS) {
      _fogProbeDead = true;
      // eslint-disable-next-line no-console
      console.warn("[far-terrain S1] horizon sky probe disabled after "
        + `${_fogProbeFails} failures; falling back to the authored fog hex.`, err);
    }
    return null;
  } finally {
    if (savedVisible.length) {
      const kids = skyScene.children;
      for (let i = 0; i < kids.length && i < savedVisible.length; i += 1) {
        kids[i].visible = savedVisible[i];
      }
    }
    if (restoreRenderer) {
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
    }
  }
}

/**
 * Write a LINEAR working-space radiance triple straight into `fog.color`.
 *
 * Component assignment, NOT `setHex`/`setRGB`: three r0.184's
 * `refreshFogUniforms` does `fog.color.getRGB(uniform, getUnlitUniformColor
 * Space(renderer))`, and with a render target bound (always, for the world
 * pass) that resolves to `workingColorSpace` — i.e. the uniform receives these
 * components verbatim. Any colour-managed setter would insert a transfer
 * function we would then have to invert.
 *
 * `tint` (0..1) blends the AUTHORED DAT chroma over the sample while PRESERVING
 * the sample's luminance, so retail's tint identity is reachable without
 * re-introducing the brightness defect. 0 = pure sky radiance.
 */
function applyFogRadiance(fog, sky, authoredHex, tint) {
  let r = sky.r; let g = sky.g; let b = sky.b;
  if (tint > 0 && Number.isFinite(authoredHex)) {
    _fogTintColor.setHex(authoredHex);   // sRGB hex → linear working space
    const lumSky = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const lumTint = 0.2126 * _fogTintColor.r + 0.7152 * _fogTintColor.g
      + 0.0722 * _fogTintColor.b;
    if (lumTint > 1e-6) {
      const k = lumSky / lumTint;
      r += (_fogTintColor.r * k - r) * tint;
      g += (_fogTintColor.g * k - g) * tint;
      b += (_fogTintColor.b * k - b) * tint;
    }
  }
  fog.color.r = Math.max(0, r);
  fog.color.g = Math.max(0, g);
  fog.color.b = Math.max(0, b);
}

// Apply the live SkyState fog COLOR to the THREE distance fog
// (`scene.fog` — a FogExp2/Fog whose `.color` is a THREE.Color).
//
// Default OFF (`?fogLerp` absent) → uses `state.fogColorArgb`, exactly
// the value the rest of the stack reads (no behavior change). When
// `?fogLerp=on`, uses the acclient-faithful per-frame interpolated
// `state.fogColorArgb` lerp field instead, so the distance-fog tint
// glides dawn→day→dusk→night instead of stepping at DayGroup edges.
//
// ISOLATION: this is the ONLY consumer of `fogColorArgbLerp`. It writes
// `scene.fog.color` ONLY (never the clouds' `uHorizonColor`, never the
// weather `fogMax` thresholds). No-op when there is no `scene.fog`
// (the active 3D path leaves distance fog to the Bruneton aerial
// perspective; `scene.fog` is the wireframe-mode distance fog).
//
// ARGB (0xAARRGGBB) → RGB hex is `argb & 0xFFFFFF`. `scene.fog.color`
// is a THREE.Color; `.setHex(rgb)` re-tints it in place without
// importing THREE here. In THREE r0.184 `setHex` defaults to
// SRGBColorSpace input → converts to the linear working space, which is
// what the HalfFloat HDR pipeline wants (the world pass renders linear,
// the composer tone-maps with AGX). So we feed the raw sRGB hex.
//
// R1.C escalation (2026-05-28): when `?fogLerp=on` the 3D gate leaves
// `scene.fog` ALIVE as a linear THREE.Fog (index.js ~2674). On that path
// we ALSO push the AC-authored near/far band from the snapshot's
// `fogMin`/`fogMax` so the fog distance tracks weather + time-of-day,
// not just the seed values. Linear THREE.Fog carries `.near`/`.far`
// (plain numbers — no THREE import needed); FogExp2 (wireframe fallback)
// carries `.density` and no near/far, so we feature-detect.
function tickDistanceFogColor(scene3d) {
  const scene = scene3d?.scene;
  if (!scene) return;
  // AdminEnvirons (0xEA60) fog override — server-pushed RedFog/BlueFog/etc.
  // (acclient.c:396344-416). Set by index.html's kind-60 handler; takes
  // precedence over the region/sky fog until a Clear (0x00) nulls it. `rgb`
  // is sRGB hex (0xRRGGBB); `fogMax` is the AC far band (a dense near fog —
  // RedFog ~50 m). The world materials honour `scene.fog` (fog:true on terrain
  // + statics), but on the default atmosphere path `scene.fog` is null (only
  // wireframe creates the FogExp2; the ?fogLerp linear Fog is gated on one
  // already existing), so when an environ fog is active we CREATE a transient
  // linear THREE.Fog the materials then tint, and tear it down on Clear. This
  // sums with the atmosphere aerial-perspective haze; for these dramatic
  // overrides the dense colored fog dominates (an aerial-opacity knock, like
  // ?fogLerp's FOGLERP_AERIAL_OPACITY, is an optional tuning follow-up).
  const environOv = (typeof window !== "undefined") ? window.__environFogOverride : null;
  if (environOv && Number.isFinite(environOv.rgb)) {
    const far = (Number.isFinite(environOv.fogMax) && environOv.fogMax > 0) ? environOv.fogMax : 50;
    const near = far * 0.1;
    const rgb = environOv.rgb & 0xffffff;
    if (!scene.fog) {
      scene.fog = new THREE.Fog(rgb, near, far);
      scene.fog.__environCreated = true;
    } else if (typeof scene.fog.color?.setHex === "function") {
      scene.fog.color.setHex(rgb);
      if (typeof scene.fog.far === "number") {
        scene.fog.far = far;
        if (typeof scene.fog.near === "number") scene.fog.near = near;
      }
    }
    return;
  }
  // Override cleared (Clear / no environ) — tear down a fog WE created so the
  // default path returns to no-scene.fog. A fog we didn't create (wireframe
  // FogExp2 / ?fogLerp linear Fog) is left untouched.
  if (scene.fog && scene.fog.__environCreated) {
    scene.fog = null;
  }
  const fog = scene.fog;
  if (!fog || !fog.color || typeof fog.color.setHex !== "function") return;
  const state = scene3d.skyLightingController?._lastState ?? null;
  if (!state) return;
  const useLerp = readFogLerpFlag();
  const argb = useLerp
    ? (state.fogColorArgbLerp >>> 0)
    : (state.fogColorArgb >>> 0);
  if (!Number.isFinite(argb)) return;
  const rgb = argb & 0xffffff;
  // === FIX ROUND 2026-08-03 (validator defects 1 + 3) =====================
  // `fog.color` is scene RADIANCE, not a display colour. Prefer the rendered
  // sky's own horizon radiance (same buffer, same exposure, same tone curve →
  // fogged terrain converges to the sky it meets); fall back to the authored
  // sRGB hex when the probe is unavailable or `?farFogSky=off`. See
  // `sampleHorizonSkyRadiance` above for the full rationale + measurements.
  let skyRad = null;
  if (farFogSkyProbeEnabled()) {
    skyRad = sampleHorizonSkyRadiance(scene3d) ?? _fogProbeLast;
  }
  if (skyRad) applyFogRadiance(fog, skyRad, rgb, farFogTint());
  else fog.color.setHex(rgb);
  // Refresh the AC fog band only on the fogLerp path AND only for a
  // linear THREE.Fog (has finite `.near`/`.far`). Leaves the wireframe
  // FogExp2 density untouched (default-off path is unaffected — its fog
  // is the static FogExp2 from index.js L578, no near/far to write).
  // render-audit T1d (world_fog gate): a worldFog of 0 in the keyframe means
  // "fog OFF" for that segment, so the near/far lerp adoption must be skipped
  // (otherwise we'd fog out a frame the keyframe intends to be clear). AND-in
  // worldFog!=0 alongside the existing useLerp/finite/sane-value guards.
  // `state.worldFog` is the snapshot field copied in sky_lighting.js:62.
  const fogEnabled = (state.worldFog >>> 0) !== 0;
  if (fogEnabled && useLerp &&
      typeof fog.near === "number" && typeof fog.far === "number") {
    const fogMin = +state.fogMin;
    const fogMax = +state.fogMax;
    // Only adopt sane AC values; guard against 0/NaN pre-populator
    // snapshots and the degenerate near>=far case (which would make the
    // whole frame fog out). Keep prior values otherwise.
    if (Number.isFinite(fogMin) && Number.isFinite(fogMax) &&
        fogMax > fogMin && fogMax > 0) {
      // === FAR-TERRAIN S1 — the fog-before-edge invariant ==================
      // Retail's authored clear-day band is 150 -> 2400 m against a 1536 m
      // default grid, so its own ring edge sat at ~62 % fog and was never seen.
      // Our terrain edge is a STREAMING limit that moves (near ring radius 5,
      // far ring radius `farRadius`, and the geometry governor can collapse the
      // near ring to ~3), so the authored 2400 m would leave a hard, fully
      // unfogged cut. Clamp the far distance so fog reaches 100 % strictly
      // INSIDE the outermost DRAWN landblock. Then an absent / unbaked /
      // off-map tile is invisible, and the "void read as ocean" mis-tune that
      // contaminated pass 2 cannot recur. `?farFogFrac=0` disables the clamp;
      // `?farFogNear` / `?farFogFar` pin both ends outright for an A/B.
      //
      // FIX ROUND 2026-08-03 (validator defect 2) — the clamp was
      // `0.85 * R * 192`, which is ~0.77 of the real edge: `R` counts LB
      // CENTRES and each tile is 192 m wide, so the outermost drawn edge is at
      // `(R + 0.5) * 192`. At the measured R_near = 5 that put fogFar at 816 m,
      // i.e. the entire visible world inside the ramp, and mid-valley terrain
      // 400 m out measured 201/255 against 134/255 with the retail-authored
      // 2400 m band. Now `0.95 * (R + 0.5) * 192` — the invariant only needs
      // fog VISUALLY opaque before the edge, which smoothstep reaches well
      // before its `far` parameter, so 5 % of margin is enough and the rest of
      // the depth stays usable.
      //
      // Plus an absolute floor (`?farFogFloor`, 700 m) so a momentarily
      // under-reported radius cannot slam the world shut — gated on the
      // measured radius already being healthy (`?farFogFloorMinLb`, 3 LB) AND
      // capped at the TRUE drawn edge, so the floor can only ever give back the
      // `frac` margin, never claim terrain that is not there. During a boot
      // fill or a governor collapse the world really IS that small and the fog
      // still has to hide the true edge (defect 4, acceptance (c)).
      let near = fogMin;
      let far = fogMax;
      // 2026-08-03 residency task #10 — publish the AUTHORED band for the
      // PVS ring's fog cap (cells.js::tickPvsLoadExpansion). Deliberately the
      // authored fogMax, NOT the derived `far` below: the derived value is
      // clamped to the measured drawn edge, so capping the ring with it would
      // be a feedback loop (ring shrinks → edge shrinks → ring shrinks…).
      // The authored band is the binding visibility constraint at night
      // (0→400 m) and is what makes >400 m residency pointless there.
      scene3d._authoredFogMaxM = fogMax;
      const frac = farFogFrac();
      const rEff = farTerrainEffectiveRadiusLb(scene3d);
      if (frac > 0 && Number.isFinite(rEff) && rEff > 0) {
        const drawnEdge = (rEff + 0.5) * 192;
        let edge = frac * drawnEdge;
        const floorM = farFogFloorM();
        if (floorM > 0 && rEff >= farFogFloorMinLb()) {
          edge = Math.max(edge, Math.min(floorM, drawnEdge));
        }
        if (edge > 0 && edge < far) {
          far = edge;
          // DEGENERATE BAND. In the first seconds of a boot the drawn world is
          // smaller than the authored fog START (150 m), so the clamp produces
          // far < near, `far > near` below is false, and the fog silently keeps
          // whatever the THREE.Fog was CONSTRUCTED with (2500 m) — i.e. no fog
          // at all in exactly the phase where the drawn edge is nearest and
          // ugliest. Measured on the HD520: 30 s of fogFar 2500 against a
          // 136 m drawn edge. Scale the whole band down instead.
          if (near >= far) near = far * 0.1;
        }
      }
      const nearPin = farFogNearPin();
      const farPin = farFogFarPin();
      if (Number.isFinite(nearPin)) near = nearPin;
      if (Number.isFinite(farPin)) far = farPin;
      if (far > near) {
        fog.near = near;
        fog.far = far;
      }
      // Probe surface for the validator: what was ACTUALLY applied this frame,
      // alongside the authored values it came from.
      scene3d.__farFogApplied = {
        authoredMin: fogMin,
        authoredMax: fogMax,
        near: fog.near,
        far: fog.far,
        colorHex: rgb,
        // The value the shader actually receives (LINEAR working space). The
        // authored hex above is now only the FALLBACK / tint source.
        colorLinear: [fog.color.r, fog.color.g, fog.color.b],
        colorSource: skyRad ? "sky-horizon-radiance" : "authored-hex",
        skyRadiance: skyRad ? [skyRad.r, skyRad.g, skyRad.b] : null,
        tint: farFogTint(),
        frac,
        floorM: farFogFloorM(),
        // MEASURED (defect 4): near-ring measured radius, or the far ring's
        // SOLID radius when `?farRing=on` and patches are actually drawn.
        effectiveRadiusLb: rEff,
        drawnEdgeM: Number.isFinite(rEff) ? (rEff + 0.5) * 192 : null,
      };
    }
  }
}
// === end Wave R1.C ===

// Wave 1.E (2026-05-28) — player-tracked dynamic shadow-receive gate.
//
// Replaces FU2's spawn-anchored bake-time tag (`receiveShadow` set
// once per placement against the Holtburg LB centre) with a per-frame
// re-tag against the LIVE player position. Closes the
// `TODO(FU2-future)` flagged in `scene3d/buildings.js` +
// `scene3d/statics.js`: once the player walks beyond ~SHADOW_RECEIVE
// _RANGE_M from spawn, the static snapshot stops matching reality and
// shadows pop on/off at landblock boundaries as new LBs lazy-bake.
//
// Wiring contract:
//   - Reads `scene3d.entityManager.getLocalPlayerWorldPos()` (AC
//     coords). Pre-spawn the resolver returns null and we no-op.
//   - Walks `scene3d.buildingsGroup.children` (per-placement
//     `THREE.Group`s — see `buildOneBuilding` topology) and
//     `scene3d.staticsGroup.children` (plain `THREE.Mesh` singletons,
//     `THREE.LOD` LOD-wrapped singletons). Skips `THREE.InstancedMesh`
//     and LOD-wrapped InstancedMesh entirely — per the FU2 doc those
//     have uniform `.receiveShadow` across the batch (per-instance
//     receiveShadow isn't a thing in three.js), so the distance gate
//     can't discriminate without splitting the InstancedMesh.
//   - Skips when `shadowsEnabled || csmEnabled` is false (no shadow
//     map at all → tag is moot) and when `quality.preset === "low"`
//     (the C2/C3 gates already force receiveShadow=false bake-time).
//
// Cost model: throttled to ~5 Hz (every 200 ms) AND a 4 m player-move
// threshold. A static walking-speed pause skips entirely; a sustained
// run produces one walk every 200 ms or so. Per walk we touch at most
// ~46 building Groups + ~225 statics × 1-2 LOD levels at Holtburg
// 9-LB scope (orders of magnitude under the 460+ frustum-test cost
// the bake-time gate was avoiding). At 13×13 ring scope (16,700
// placements with most as InstancedMesh) the singleton count we walk
// is still 2-3× the ring LBs — well under 5 ms even worst-case.
//
// Mutation strategy: assign `mesh.receiveShadow = next` only if it
// changed. three.js doesn't dirty-check on assign but the GPU pass
// reads the property fresh each frame, so a no-op assign is free —
// the change-guard is for the diag counter, not the GPU.
//
// CSM cascade visibility verified (Wave 1.E): csm.js
// DEFAULT_CSM_SPLITS = [30, 100, 300] m; lighting.js single-shadow
// path uses sceneSize=600 m. 80 m gate sits well inside cascade 2
// (100 m far) AND the single-shadow frustum half-extent (600 m),
// so a placement flipped to `receiveShadow=true` ALWAYS has a shadow
// map covering it. Without this check the gate would be a no-op for
// the 80-100 m band in the single-shadow path AND a no-op past 300 m
// in the CSM path — log loudly if the cascade config ever drifts
// below the receive gate.
const SHADOW_GATE_TICK_INTERVAL_S = 0.2;
const SHADOW_GATE_PLAYER_DELTA_SQ_M = 16; // 4 m

function _isShadowReceiveCandidate(node) {
  // Skip InstancedMesh + LOD-wrapped InstancedMesh — uniform
  // receiveShadow across the batch (FU2 doc). Plain Mesh + plain LOD
  // (whose children are plain Mesh) are the only per-placement
  // singletons the gate can discriminate.
  if (!node) return false;
  if (node.isInstancedMesh) return false;
  if (node.isLOD) {
    // Could still be LOD-wrapping an InstancedMesh — peek at the
    // first level.
    const child = node.levels?.[0]?.object;
    if (child?.isInstancedMesh) return false;
  }
  return true;
}

function _setReceiveShadowForBuildings(group, withinRange, counters) {
  // Buildings: per-placement Group → per-part hingeWrapper Group →
  // per-surface Mesh (see `buildOneBuilding` topology in buildings.js).
  // The shadow-receive bool lives on each leaf surface Mesh; iterate
  // the part wrappers via `userData.partGroups` for stable ordering.
  const partGroups = group.userData?.partGroups;
  if (!Array.isArray(partGroups)) return;
  for (const hingeWrapper of partGroups) {
    if (!hingeWrapper?.children) continue;
    for (const mesh of hingeWrapper.children) {
      if (!mesh?.isMesh) continue;
      // Skip translucent / additive surfaces that already have
      // receiveShadow=false from the materials.js gate; the
      // material-level decision is authoritative regardless of range.
      if (mesh.material?.transparent === true) continue;
      const next = withinRange;
      if (mesh.receiveShadow !== next) {
        mesh.receiveShadow = next;
        counters.changed += 1;
      } else {
        counters.unchanged += 1;
      }
    }
  }
}

function _setReceiveShadowForStaticsNode(node, withinRange, counters) {
  // Statics: plain THREE.Mesh OR THREE.LOD wrapping two plain
  // Meshes (full + degraded). InstancedMesh path is filtered out by
  // _isShadowReceiveCandidate; here we only see per-placement nodes.
  if (node.isLOD) {
    const levels = node.levels;
    if (!Array.isArray(levels)) return;
    for (const lvl of levels) {
      const child = lvl?.object;
      if (!child?.isMesh) continue;
      const next = withinRange;
      if (child.receiveShadow !== next) {
        child.receiveShadow = next;
        counters.changed += 1;
      } else {
        counters.unchanged += 1;
      }
    }
    return;
  }
  if (node.isMesh) {
    const next = withinRange;
    if (node.receiveShadow !== next) {
      node.receiveShadow = next;
      counters.changed += 1;
    } else {
      counters.unchanged += 1;
    }
  }
}

function _staticsNodeWorldXY(node) {
  // Both plain Mesh + plain LOD carry the world XY in `.position`
  // (`buildSingletonNode` sets `mesh.position.set(worldX, worldY, z)`
  // before optionally wrapping in LOD whose `position.copy(mesh.position)`
  // also runs). InstancedMesh path is excluded upstream.
  return [node.position.x, node.position.y];
}

export function tickShadowReceiveGate(scene3d) {
  if (!scene3d) return;
  // Hard skip when no shadow path is active — the bake-time
  // receiveShadow tag is meaningless if the renderer never builds a
  // shadow map. Matches buildings.js `shadowsEnabled || csmEnabled`
  // bake-time gate.
  const shadowsLive = !!scene3d.shadowsEnabled || !!scene3d.csmEnabled;
  if (!shadowsLive) return;
  // Hard skip at low preset — the C2/C3 bake-time gates already
  // forced every receiveShadow to false; flipping any to true would
  // contradict the preset contract (CSM frustum-test cost the preset
  // is paying down).
  if (scene3d.quality?.preset === "low") return;

  // Throttle: time + player-move guard. Either gate alone is too
  // permissive — a stationary player would re-walk every 200 ms
  // (cheap but pointless); a fast player would skip walks for
  // arbitrarily long if only the move-guard ran.
  const tsSec = scene3d.frameTime?.tsSec
    ?? (typeof performance !== "undefined" && performance.now
        ? performance.now() * 0.001
        : Date.now() * 0.001);
  if (!scene3d._shadowGateState) {
    scene3d._shadowGateState = {
      lastTickSec: 0,
      lastPlayerX: NaN,
      lastPlayerY: NaN,
      lastChangedCount: 0,
      lastUnchangedCount: 0,
      lastWalkedCount: 0,
      cascadeMismatchWarned: false,
    };
  }
  const st = scene3d._shadowGateState;
  if (tsSec - st.lastTickSec < SHADOW_GATE_TICK_INTERVAL_S) return;

  const em = scene3d.entityManager;
  if (!em || typeof em.getLocalPlayerWorldPos !== "function") return;
  let pos;
  try { pos = em.getLocalPlayerWorldPos(); } catch (_) { pos = null; }
  if (!pos) return;
  const px = pos.x;
  const py = pos.y;
  if (!Number.isFinite(px) || !Number.isFinite(py)) return;

  // Player-move guard. First call has NaN cached → dx/dy NaN →
  // comparison false → falls through to walk (correct: bake-time
  // tag is stale by definition once the player spawns somewhere
  // other than the Holtburg LB centre).
  const dx = px - st.lastPlayerX;
  const dy = py - st.lastPlayerY;
  if (Number.isFinite(st.lastPlayerX) && (dx * dx + dy * dy) < SHADOW_GATE_PLAYER_DELTA_SQ_M) {
    // Mark the tick as "checked" so the throttle interval resets,
    // but skip the walk. Prevents a back-to-back tick re-doing the
    // distance compute the very next frame.
    st.lastTickSec = tsSec;
    return;
  }

  const counters = { changed: 0, unchanged: 0, walked: 0 };

  // Buildings — per-placement Groups under buildingsGroup. Each
  // Group's `.position` carries the world XY (set in
  // `buildOneBuilding`).
  const buildingsGroup = scene3d.buildingsGroup;
  if (buildingsGroup?.children?.length) {
    for (const child of buildingsGroup.children) {
      if (!child || !child.isGroup) continue;
      // Skip MaterialCache fill-companion meshes (wire-mode) that
      // also live under buildingsGroup. They carry `userData.lbX/lbY`
      // but no `partGroups` array — the building-receive helper
      // bails on missing partGroups, so the early continue here is
      // a perf nicety not a correctness fix.
      if (!Array.isArray(child.userData?.partGroups)) continue;
      const bx = child.position.x;
      const by = child.position.y;
      const ddx = bx - px;
      const ddy = by - py;
      const within = (ddx * ddx + ddy * ddy) < BUILDINGS_SHADOW_RANGE_SQ_M;
      _setReceiveShadowForBuildings(child, within, counters);
      counters.walked += 1;
    }
  }

  // Statics — per-placement Mesh / LOD under staticsGroup. The
  // InstancedMesh path (ring driver) is filtered by
  // _isShadowReceiveCandidate; the per-LB lazy baker emits plain
  // Mesh + LOD only (see statics.js `bakeStaticsForLandblock`
  // doc-comment), and the ring driver's singletons (modelIds with
  // only one instance) are also plain Mesh + LOD.
  const staticsGroup = scene3d.staticsGroup;
  if (staticsGroup?.children?.length) {
    for (const child of staticsGroup.children) {
      if (!_isShadowReceiveCandidate(child)) continue;
      const [sx, sy] = _staticsNodeWorldXY(child);
      const ddx = sx - px;
      const ddy = sy - py;
      const within = (ddx * ddx + ddy * ddy) < STATICS_SHADOW_RANGE_SQ_M;
      _setReceiveShadowForStaticsNode(child, within, counters);
      counters.walked += 1;
    }
  }

  st.lastTickSec = tsSec;
  st.lastPlayerX = px;
  st.lastPlayerY = py;
  st.lastChangedCount = counters.changed;
  st.lastUnchangedCount = counters.unchanged;
  st.lastWalkedCount = counters.walked;

  // Visibility cross-check: CSM cascade far-plane vs the gate radius.
  // If a future tuning bump pushes the gate beyond the largest
  // cascade's reach, the gate flips placements to receiveShadow=true
  // but no shadow map covers them → silent no-op. Warn once so the
  // mismatch surfaces in console + the diag snapshot.
  if (!st.cascadeMismatchWarned) {
    const csmState = scene3d.csmState ?? scene3d.lighting?.csmState ?? null;
    if (csmState && Array.isArray(csmState.splits)) {
      const farCascade = csmState.splits[csmState.splits.length - 1];
      // The larger of the two gate radii is the binding constraint
      // (whichever module's receivers we tag farther out).
      const maxRangeSq = Math.max(
        BUILDINGS_SHADOW_RANGE_SQ_M,
        STATICS_SHADOW_RANGE_SQ_M
      );
      const maxRange = Math.sqrt(maxRangeSq);
      if (Number.isFinite(farCascade) && maxRange > farCascade) {
        st.cascadeMismatchWarned = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[wave1e] shadow-receive gate radius ${maxRange.toFixed(0)}m > far CSM cascade ${farCascade}m; ` +
            `placements in the ${farCascade.toFixed(0)}-${maxRange.toFixed(0)}m band will have receiveShadow=true ` +
            `but no shadow map covering them. Bump csm.js DEFAULT_CSM_SPLITS or lower SHADOW_RECEIVE_RANGE_M.`
        );
      }
    }
  }
}

// === RP3 — render-loop frame budgeting (2026-06-08, client-only) ===
//
// A heavy DEFERRABLE phase (the nameplate DOM-projection in particular,
// 5-50 ms; the sky/atmosphere stack, ~5-10 ms) can blow a 16.6 ms frame
// and STALL INPUT — the camera switcher (#13) reads WASD and dispatches
// setMovementInput to wasm, and the entity drain (#16) applies server
// position snaps. If those run AFTER a phase that already ate the frame,
// the dispatch lands late and the player feels input lag.
//
// RP3 adds a per-frame budget guard around the DEFERRABLE phases ONLY.
// The contract (see GUARDRAIL in the track brief):
//   - CRITICAL phases (#1 cell-visibility, #5 lighting, #13 camera/input,
//     #15 mixer, #16 entity-drain, #19 local-player pose) ALWAYS run every
//     frame, unconditionally, in their existing order. They are NEVER gated
//     by the budget or a throttle.
//   - DEFERRABLE phases run only when (a) their throttle interval has
//     elapsed AND (b) the frame still has budget left — UNLESS they have
//     been skipped `MAX_DEFER_FRAMES` times in a row, in which case they
//     FORCE-RUN regardless of budget so they never freeze indefinitely
//     (bounded staleness). The existing 5 Hz shadow-receive gate keeps its
//     own throttle and is left exactly as-is.
//
// The deferrable groups (mapped to the brief's phase numbers):
//   PVS  — #2 PVS load expansion (renderSet scan + ring expand). Throttled
//          to ~10 Hz; the actual loads are idempotent, so a missed frame
//          just means the prefetch leads by a few ms less.
//   SKY  — #4 terrain sun-dir + #7-#12 sky-lighting / fog / atmosphere /
//          skydome / weather. ~5-10 ms. The downstream consumers (#8-#12)
//          read `skyLightingController._lastState`, a cached snapshot, so
//          throttling the whole block to ~10 Hz just holds the snapshot one
//          extra frame — the sky visibly glides at 10 Hz, imperceptible.
//   NAME — #20 nameplate DOM-projection. The single biggest deferrable
//          (5-50 ms). Budget-gated + force-run on staleness so labels track
//          but never block input on a heavy frame.
//
// Phases #3 (water/lava uTime clock) and #6 (shadow-receive gate) are NOT
// in any deferrable group: #3 is cheap and must run every frame to keep
// neighbouring-LB water phase-locked; #6 already self-throttles at 5 Hz.
//
// Config (URL flags, parsed once, mirrors the ?netDrainHz / ?fogLerp
// pattern used elsewhere in this stack):
//   ?frameBudget=<ms>   per-frame soft budget for deferrables. Default 9.
//                       `?frameBudget=off` disables the guard entirely
//                       (every phase runs every frame — pre-RP3 behaviour).
//   ?deferHz=<hz>       throttle rate for PVS + SKY groups. Default 10.
// All knobs fail-soft to the defaults in the Node harness (no `window`).
const RP3_DEFAULT_BUDGET_MS = 9;
const RP3_DEFAULT_DEFER_HZ = 10;
// Bounded-staleness ceiling: a deferrable that keeps losing the budget race
// is force-run after this many consecutive skips so it can never freeze.
// At 60 fps that is ~50 ms of worst-case staleness for a budget-starved
// phase; at 30 fps ~100 ms. Both are well under a human-noticeable freeze.
const RP3_MAX_DEFER_FRAMES = 3;

const _rp3Config = (() => {
  let budgetMs = RP3_DEFAULT_BUDGET_MS;
  let deferHz = RP3_DEFAULT_DEFER_HZ;
  let enabled = true;
  try {
    if (typeof window !== "undefined" && window.location) {
      const ps = new URLSearchParams(window.location.search);
      const rawBudget = ps.get("frameBudget");
      if (rawBudget !== null) {
        if (rawBudget.toLowerCase() === "off") {
          enabled = false;
        } else {
          const n = parseFloat(rawBudget);
          // Clamp to a sane band: below ~2 ms a single critical phase
          // could already exceed it (making the guard a no-op churner);
          // above one frame the guard never triggers. 2-33 ms.
          if (Number.isFinite(n) && n > 0) budgetMs = Math.max(2, Math.min(n, 33));
        }
      }
      const rawHz = ps.get("deferHz");
      if (rawHz !== null) {
        const h = parseFloat(rawHz);
        if (Number.isFinite(h) && h > 0) deferHz = Math.max(1, Math.min(h, 60));
      }
    }
  } catch (_) {
    /* fail-soft to defaults */
  }
  return {
    enabled,
    budgetMs,
    deferHz,
    // Per-group throttle interval in seconds (measured against the monotonic
    // frame-start clock), indexed by RP3_G_*. PVS + SKY throttle to `deferHz`;
    // NAME has NO
    // throttle (interval 0 = "due" every frame) — it wants the highest
    // refresh the budget allows so labels track moving entities crisply,
    // and is bounded only by the budget gate + the staleness ceiling.
    throttleSec: [1 / deferHz, 1 / deferHz, 0],
  };
})();

// Lazily attach (and return) the per-scene frame-budget bookkeeping. One
// object per scene3d, reused every frame — NO per-frame allocation in the
// hot path (the brief's "no new per-frame allocations" guardrail). Fields:
//   frameStartMs   — performance.now() at the top of this frame's tick.
//   lastRunSec[g]  — monotonic frame-start clock (sec) when group `g` last ran.
//   skips[g]       — consecutive frames group `g` has been deferred.
// Groups are indexed by the RP3_G_* constants below.
const RP3_G_PVS = 0;
const RP3_G_SKY = 1;
const RP3_G_NAME = 2;
function _rp3State(scene3d) {
  let st = scene3d._rp3FrameBudget;
  if (!st) {
    st = scene3d._rp3FrameBudget = {
      frameStartMs: 0,
      // -Infinity → every group is "due" on the first frame so nothing
      // waits a throttle interval before its first run.
      lastRunSec: [-Infinity, -Infinity, -Infinity],
      skips: [0, 0, 0],
    };
  }
  return st;
}

// Decide whether deferrable group `g` runs this frame.
//   1. Guard disabled (?frameBudget=off) → always run.
//   2. Throttle: skip if < throttleSec has elapsed since the group last ran
//      (returns false WITHOUT counting a skip — the group isn't "due" yet,
//      so staleness isn't accumulating).
//   3. Due, but over budget AND under the staleness ceiling → defer
//      (count a skip).
//   4. Due and (within budget OR at the staleness ceiling) → run, reset skip.
// `nowMs` is the intra-frame performance.now() budget clock; `tsSec` is the
// monotonic frame-start clock (seconds) used for the wall-clock throttle —
// it always advances (rAF AND net-drain callers), so a frozen frameTime can
// never defeat the throttle and starve a group.
function _rp3ShouldRun(st, g, tsSec, nowMs) {
  if (!_rp3Config.enabled) return true;
  if (tsSec - st.lastRunSec[g] < _rp3Config.throttleSec[g]) return false;
  const overBudget = nowMs - st.frameStartMs > _rp3Config.budgetMs;
  if (overBudget && st.skips[g] < RP3_MAX_DEFER_FRAMES) {
    st.skips[g] += 1;
    return false;
  }
  st.skips[g] = 0;
  st.lastRunSec[g] = tsSec;
  return true;
}

// Cheap monotonic intra-frame clock for the budget check. Distinct from the
// frameTime snapshot (which is stamped once at tick start) — we need the
// LIVE elapsed-this-frame, so a fresh now() is correct here and is not a new
// "time source" in the multi-clock sense (it measures one frame's duration,
// never world/sim time).
function _rp3NowMs() {
  return (typeof performance !== "undefined" && performance.now)
    ? performance.now()
    : Date.now();
}

export function tickPerFrame(scene3d, sessionHandle, dt) {
  // ── CRITICAL #0 (A1-O4) — single-driver net/input pump. Retail runs net
  // dispatch + input interp inside the one SmartBox::UseTime pass
  // (acclient.c:146316, :146324); under ?singleDriver=on the scene3d
  // driver owns that pass: `window.__netFramePump` is the 2D loop's whole
  // pumpNetFrame body (index.html — events drain, entity drain +
  // streaming, tickMovement enqueue, input side-effects), relocated here
  // wholesale while the 2D rAF driver parks. Placed ABOVE the RP3 stamp
  // and NEVER budget-gated (net + input are in the same never-gate class
  // as the camera/input phase #13) — pump cost is excluded from the
  // deferrable budget by design (A1-O4 spec §6 OQ3). Frame-top placement
  // (retail dispatches at frame-bottom) is equivalent modulo one frame
  // and means a server force-position lands before this frame's physics
  // enqueue — the spec's documented choice. Living INSIDE tickPerFrame
  // (not index.js tick) makes the ?netDrainHz interval and __renderOnce
  // inherit the full contract-minus-render for free. If the watchdog
  // un-claims while the 3D loop later revives, the brief double-pump is
  // benign (take-based drains, dt-measured tick, sig-deduped input —
  // today's steady-state concurrency).
  // GUARD (S16 reopen check, 2026-06-12 — DECISIONS-A1-O5-constants.md
  // (b)): this pump must stay dt-INDEPENDENT. It runs every frame,
  // including the dt=0 freeze-band frames of the JS dt-clamp; the wasm
  // tick inside it self-measures elapsed time (tick_spine.rs /
  // MovementSystemHandle::tick). Gating this call on `dt > 0` — or
  // passing the clamped JS `dt` into the wasm tick — would couple the
  // two clamp laws and starve Rust physics under ?singleDriver during
  // recovery: that is exactly the record's (b) reopen trigger. Revisit
  // the decision record FIRST.
  if (scene3d?.singleDriverOn && typeof window !== "undefined"
      && typeof window.__netFramePump === "function") {
    try {
      window.__netFramePump();
    } catch (e) {
      if (!scene3d._netPumpWarned) {
        scene3d._netPumpWarned = true;
        // eslint-disable-next-line no-console
        console.warn("[singleDriver] __netFramePump threw:", e);
      }
    }
  }
  // RP3 — stamp the frame-budget clock + resolve the wall-clock the throttles
  // read. Both the budget gate and the throttle now share ONE live monotonic
  // clock (_rp3NowMs), captured once per tick. This is deliberately NOT driven
  // off scene3d.frameTime.tsSec: see the throttle-clock note below.
  const _rp3 = scene3d ? _rp3State(scene3d) : null;
  const _rp3FrameStartMs = _rp3NowMs();
  if (_rp3) _rp3.frameStartMs = _rp3FrameStartMs;
  // RP3 throttle clock — derived from the LIVE monotonic frame-start clock,
  // NOT scene3d.frameTime.tsSec. frameTime is stamped ONLY by the rAF tick
  // (index.js); under ?renderOnDemand=1 the rAF loop fires once at boot then
  // idles, so frameTime.tsSec FREEZES. The ?netDrainHz=N setInterval then
  // calls tickPerFrame against that frozen snapshot — and because the throttle
  // early-return below never counts a skip, the force-run ceiling never fires
  // and PVS (#2) + the SKY group (#4,#7-#12) would be starved forever during
  // the idle window (the exact "permanently starved" guardrail violation).
  // _rp3NowMs() advances on every call regardless of which caller (rAF or
  // net-drain) drives the tick, so the throttle interval elapses normally in
  // both paths; the rAF path is unchanged (both clocks advance ~per frame).
  const _rp3TsSec = _rp3FrameStartMs * 0.001;
  // A11-S3 diag (flag-gated, zero cost when off): frame counter for the
  // "manager ticks == frames" headless parity check; managerTicks is
  // incremented in the manager phase below.
  if (scene3d && particleClockMode() !== "off") {
    const _d = scene3d._a11s3Diag ?? (scene3d._a11s3Diag = { managerTicks: 0, frames: 0 });
    _d.frames += 1;
  }

  // ── CRITICAL #1 — cell visibility (gates the whole scene). ───────────
  tickCellVisibility3D(scene3d, sessionHandle);
  // Portal-stencil feed (?portalStencil) — after the visibility tick so
  // container.visible reflects this frame's render set. No-ops when off.
  tickPortalStencil(scene3d, sessionHandle);
  // Portal-punch feed (?portalPunch) — same ordering; hands the punch pass this
  // frame's visible door/window apertures. No-ops when off.
  tickPortalPunch(scene3d, sessionHandle);
  // ── CRITICAL #1.5 — FCULL app-level frustum + distance render cull. ──
  // Runs AFTER cell-visibility (#1) so the world GROUPS already carry their
  // correct `.visible` state, and BEFORE lighting (#5). It only gates per-
  // OBJECT `.visible` INSIDE the already-visible statics/entities groups
  // (and, opt-in, terrain) — it NEVER flips a group `.visible` flag, so it
  // can't fight the wasm cell-visibility BFS. NEVER budget-deferred: the
  // cost is one AC-space frustum build + cheap sphere tests over the live
  // node/entity sets (no allocation in the hot path), and a deferred frame
  // would leave stale objects drawn/hidden. Builds its own AC-space frustum
  // from the active camera (mirrors cells.js's MVP order). Self-fail-soft
  // (no camera / no worldRoot → culls nothing). `?frustumCull=off` disables.
  tickFrustumCull(scene3d);
  // ── DEFERRABLE #2 (group PVS) — PVS-driven scenery + buildings ───────
  // expansion. (Stale-comment fix 2026-08-03, residency #12: this used to say
  // "paired with STATICS_RING_RADIUS=2 / BUILDINGS_RING_RADIUS=2 boot rings in
  // index.js" — those boot rings were retired 2026-06-30 and the constants are
  // now LRU-cap sizing inputs only, see scene3d/residency.js. This expansion IS
  // the statics/buildings streaming path now, with no boot ring behind it.)
  // Reads the wasm renderSet and triggers
  // `loadStaticsForLandblock` + `loadBuildingsForLandblock` for any LB the
  // player can see but hasn't entered yet. Both hooks are idempotent + cheap,
  // so RP3 throttles the per-frame renderSet scan + ring expand to ~10 Hz:
  // the loads themselves are still async, this just stops re-walking the
  // renderSet 60×/s when nothing has moved. Force-runs on staleness so a
  // budget-starved frame can never stall scenery prefetch indefinitely.
  if (!_rp3 || _rp3ShouldRun(_rp3, RP3_G_PVS, _rp3TsSec, _rp3NowMs())) {
    tickPvsLoadExpansion(scene3d, sessionHandle);
    // ?statAtlas (default-ON; ?statAtlas=off escapes) — compact fragmented cross-LB static buckets here
    // (low-frequency, off the per-frame hot path). No-op flag-off / no churn.
    if (statAtlasEnabled()) tickStatAtlasOptimize();
    // ?statBatchChunk (default-OFF) — same lazy compaction for the region-chunked
    // per-material ?staticBatch buckets. No-op flag-off.
    if (statBatchChunkEnabled()) tickStatBatchXOptimize();
    // ?terrainBatch (default-OFF) — same lazy compaction for the cross-LB
    // terrain BatchedMesh (dead space accrues on LB eviction / LOD re-bake).
    // No-op flag-off (module state never allocates) / no churn.
    if (terrainBatchEnabled()) tickTerrainBatchOptimize();
    // ── FAR COMPOSITE RING (2026-08-02, ?farRing) ─────────────────────
    // Deliberately parked on the SAME ~10 Hz deferrable as the PVS ring, and
    // deliberately AFTER it: the far path must never issue a fetch or a bake
    // while the near ring has work in flight (it re-checks that itself), and
    // there is nothing in it that needs 60 Hz — patches are world-anchored, so
    // player movement changes only which patches are in range. Hard no-op with
    // `?farTerrain=off` / `?farRing` unset (module state never allocates).
    try {
      tickFarTerrain(scene3d, sessionHandle, scene3d?.renderer);
    } catch (e) {
      if (!scene3d._farTerrainTickWarned) {
        scene3d._farTerrainTickWarned = true;
        // eslint-disable-next-line no-console
        console.warn("[far_terrain] tick threw (far ring idle this frame):", e);
      }
    }
  }
  // Phase 2.2 — water/lava vertex displacement clock. Runs FIRST so the
  // displacement is current before any code reads terrain positions
  // this frame (e.g. nameplate projection sampling terrain Y). Wrapped
  // in try/catch + one-shot warn so a thrown push never kills the tick.
  try {
    tickTerrainUTime(scene3d);
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._terrainUTimeTickWarned) {
      scene3d._terrainUTimeTickWarned = true;
      console.warn("[phase2.2] tickTerrainUTime threw:", e);
    }
  }
  // Phase 1 (Visual-Behavior Suite, §7) — the SINGLE per-frame VFX oscillator
  // tick. Placed right after the terrain uTime push so the VFX master clock
  // (VFX_GLOBALS.uTime) + every shared VFX uniform are current before any
  // VFX-patched material renders this frame. O(1); NEVER budget-gated (it IS the
  // clock — deferring it would freeze every emissive/weathering effect). Wrapped
  // like tickTerrainUTime so a thrown channel never kills the tick.
  try {
    tickVfxOscillators(scene3d);
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._vfxOscTickWarned) {
      scene3d._vfxOscTickWarned = true;
      console.warn("[vfx] tickVfxOscillators threw:", e);
    }
  }
  // Phase 1 (VFX slice 12) — weather/wind inputs. AFTER tickVfxOscillators so
  // uTime is current; shares the same frame clock. Same try/catch shape so a
  // thrown weather read never kills the tick. Byte-identical when ?visual off.
  try {
    tickVfxWeatherInputs(scene3d);
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._vfxWeatherTickWarned) {
      scene3d._vfxWeatherTickWarned = true;
      console.warn("[vfx] tickVfxWeatherInputs threw:", e);
    }
  }
  // Terrain-VFX spine (Wave 0B). AFTER the weather inputs so a provider's
  // update() reads this frame's uWindDir/uWetness, and sharing the SAME
  // `scene3d.frameTime` clock as the two ticks above (single time source).
  // Same try/catch shape: a thrown provider never kills the tick.
  try {
    terrainVfxTick(scene3d?.frameTime?.dt ?? 0, scene3d);
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._terrainVfxTickWarned) {
      scene3d._terrainVfxTickWarned = true;
      console.warn("[terrainVfx] terrainVfxTick threw:", e);
    }
  }
  // ── DEFERRABLE group SKY decision (#4 + #7-#12). ─────────────────────
  // Evaluated ONCE per frame here (it mutates the skip counter + throttle
  // stamp, so it must not be re-called for the same group). The SKY group
  // is the terrain sun-dir push (#4) plus the whole sky-lighting / fog /
  // atmosphere / skydome / weather stack (#7-#12). They run or skip as a
  // COHERENT UNIT: #8-#12 read `skyLightingController._lastState` — the
  // cached snapshot #7 (skyLightingController.tick) writes — so holding the
  // snapshot one extra frame keeps the whole stack self-consistent. Note
  // the CRITICAL lighting tick (#5) and the already-5Hz-throttled shadow
  // gate (#6) sit between #4 and #7 in source order and are NOT in this
  // group — they always run. `?frameBudget=off` → _rp3 is still allocated
  // but _rp3ShouldRun short-circuits to true, so SKY runs every frame.
  const _rp3RunSky = !_rp3 || _rp3ShouldRun(_rp3, RP3_G_SKY, _rp3TsSec, _rp3NowMs());
  // ── DEFERRABLE #4 (group SKY) — terrain sun-direction push. ──────────
  if (_rp3RunSky) {
    try {
      tickTerrainSunDir(scene3d);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._terrainSunDirTickWarned) {
        scene3d._terrainSunDirTickWarned = true;
        console.warn("[terrain-sun] tickTerrainSunDir threw:", e);
      }
    }
  }
  // ── CRITICAL #5 — Phase 7.6 lighting tick AFTER cell visibility so it ─
  // reads the freshly-flipped indoor/outdoor state on the same frame. This
  // is indoor/outdoor material state (not the deferrable SKY group) and is
  // NEVER budget-gated. Wraps in try/catch so a thrown isCurrentCellIndoor()
  // never kills the tick.
  try {
    tickLightingForCellState(scene3d, sessionHandle);
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._lightingTickWarned) {
      scene3d._lightingTickWarned = true;
      console.warn("[phase7.6] tickLightingForCellState threw:", e);
    }
  }
  // VFX Phase 1 (light.flameFlicker) — torch/brazier intensity jitter. Runs
  // AFTER the lighting tick so the pool slots are already re-fed from their
  // sources this frame; it multiplies the occupied point-slot intensities by a
  // deterministic flame waveform. Hard no-op (byte-identical) unless ?visual &&
  // ?flameFlicker AND ?lightPool=on. Intensity-only — never a light count /
  // visibility change (THE RULE / the no-relink discipline).
  try {
    tickFlameFlicker(scene3d);
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._flameFlickerTickWarned) {
      scene3d._flameFlickerTickWarned = true;
      console.warn("[vfx] tickFlameFlicker threw:", e);
    }
  }
  // Wave 1.E (2026-05-28) — player-tracked shadow-receive gate.
  // Re-tags `receiveShadow` on per-placement building Groups +
  // singleton statics so the FU2 distance gate tracks the LIVE
  // player position instead of staying frozen at the spawn-anchored
  // bake-time snapshot. Self-throttled to ~5 Hz with a 4 m player-
  // move guard; runs AFTER tickLightingForCellState so a thrown
  // walk never blocks lighting from settling. Hard no-op when
  // `shadowsEnabled || csmEnabled` is false OR `quality.preset ===
  // "low"`.
  try {
    tickShadowReceiveGate(scene3d);
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._shadowGateTickWarned) {
      scene3d._shadowGateTickWarned = true;
      console.warn("[wave1e] tickShadowReceiveGate threw:", e);
    }
  }
  // Workstream Sky-C — dynamic sky lighting (color + intensity +
  // position + fog) from wasm SkyState. Runs AFTER Phase 7.6's
  // tickLightingForCellState so the indoor/outdoor visible-flag is
  // already settled; Sky-C writes color/intensity/position WITHOUT
  // touching `.visible` so the two composers don't fight. No-op when
  // the controller hasn't been wired (e.g. setupSceneLighting was
  // skipped) or when `getSkyState()` returns null (pre-populator).
  //
  // RP3 — phases #7-#12 (this block through tickWeatherState) gate on the
  // single `_rp3RunSky` decision computed above so the whole sky stack
  // throttles to ~10 Hz as one unit (it shares `_lastState`).
  if (_rp3RunSky && scene3d?.skyLightingController) {
    try {
      scene3d.skyLightingController.tick(dt);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._skyLightingTickWarned) {
        scene3d._skyLightingTickWarned = true;
        console.warn("[sky-c] skyLightingController.tick threw:", e);
      }
    }
    // Wave R1.C (2026-05-28) — apply the freshly-snapshotted fog color
    // to the THREE distance fog. Runs immediately after the snapshot
    // tick so `_lastState` is current. Reads `?fogLerp` to pick the
    // interpolated vs the static-per-DayGroup field; no-op when there's
    // no `scene.fog`. Wrapped so a thrown setHex never kills the tick.
    try {
      tickDistanceFogColor(scene3d);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._fogLerpTickWarned) {
        scene3d._fogLerpTickWarned = true;
        console.warn("[wave-r1.c] tickDistanceFogColor threw:", e);
      }
    }
  }
  // Sky-K.3 — physical sun + sky probe. Reads heading/pitch from the
  // SAME SkyState that skyLightingController just snapshotted (its
  // _lastState), so the two stay in sync without a second wasm
  // getSkyState() call. The probe tracks the active camera so its
  // SH-irradiance computation reflects the camera's altitude in the
  // atmosphere.
  if (_rp3RunSky && scene3d?.atmosphereLights) {
    try {
      const state = scene3d.skyLightingController?._lastState ?? null;
      const cam = scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera;
      scene3d.atmosphereLights.tick(state, cam?.position);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._atmosphereLightsTickWarned) {
        scene3d._atmosphereLightsTickWarned = true;
        console.warn("[sky-k.3] atmosphereLights.tick threw:", e);
      }
    }
  }
  // T3 (?ibl=on) — sky IBL tick. Runs right after atmosphereLights.tick so
  // `lastProbeIntensity` (the retail diurnal ambient term) is fresh for the
  // environmentIntensity drive. Refreshes the PMREM + terrain env cube at
  // its own low cadence (default 15 s — the retail light tick); on other
  // frames it only writes environmentIntensity + terrain uniforms.
  if (_rp3RunSky && scene3d?.iblEnvironment) {
    try {
      const nowMs =
        (scene3d?.frameTime?.tsSec ?? null) !== null
          ? scene3d.frameTime.tsSec * 1000
          : performance.now();
      scene3d.iblEnvironment.tick(nowMs, scene3d.terrainMaterials);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._iblTickWarned) {
        scene3d._iblTickWarned = true;
        console.warn("[t3-ibl] tick threw:", e);
      }
    }
  }
  // Sky-K.4 — takram SkyMaterial + stars. Same SkyState source as the
  // physical lights so sun position in the sky matches the sunlight
  // direction. Stars are a fixed celestial backdrop (no per-frame
  // motion); only sun direction needs updating.
  if (_rp3RunSky && scene3d?.atmosphereSky) {
    try {
      const state = scene3d.skyLightingController?._lastState ?? null;
      scene3d.atmosphereSky.tick(state);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._atmosphereSkyTickWarned) {
        scene3d._atmosphereSkyTickWarned = true;
        console.warn("[sky-k.4] atmosphereSky.tick threw:", e);
      }
    }
  }
  // Workstream Sky-D — sky dome + celestial body renderer. Runs AFTER
  // Sky-C so the freshly-written `skyBackgroundColor` (Sky-C's horizon
  // color sink) + `skyLightingController._lastState.ambColorArgb`
  // (zenith color source) land on the dome's shader uniforms in the
  // same frame. Camera-parented; reads `cameraSwitcher.activeCamera`
  // (Phase 7.5) so the dome translates with whichever camera the
  // user has toggled to. No-op pre-construction or pre-populate.
  if (_rp3RunSky && scene3d?.skyDome) {
    try {
      const activeCam =
        scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera;
      scene3d.skyDome.tick(dt, activeCam);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._skyDomeTickWarned) {
        scene3d._skyDomeTickWarned = true;
        console.warn("[sky-d] skyDome.tick threw:", e);
      }
    }
  }
  // W3 (2026-05-29) — clouds-independent weather-state tick. Runs AFTER
  // skyDome.tick so `skyDome._lastIsIndoor` is the freshly-read value for
  // this frame, and after skyLightingController.tick so `_lastState` is
  // current. Derives the DayGroup weather profile + is_storm from the real
  // SkyObject snapshots (W4), drives weather_state, the precip manager
  // (W2/W5), and the W1 billboard host. Fully fail-soft.
  //
  // RP3 — #12, last of the SKY group; gated on the same `_rp3RunSky`
  // decision so weather throttles in lockstep with the snapshot it reads.
  if (_rp3RunSky) {
    try {
      tickWeatherState(scene3d, sessionHandle);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._weatherStateTickWarned) {
        scene3d._weatherStateTickWarned = true;
        console.warn("[w3] tickWeatherState threw:", e);
      }
    }
  }
  // ── CRITICAL #13 — Phase 7.5 camera tick BEFORE entity tick. ─────────
  // READS WASD INPUT + dispatches setMovementInput to wasm; stalling this
  // is visible input lag, so RP3 NEVER budget-gates it. The switcher reads
  // last-frame entity poses for follow framing AND dispatches
  // setMovementInput (which the wasm side consumes asynchronously, so
  // the dispatch order vs the entity tick has no race).
  if (scene3d?.cameraSwitcher && typeof scene3d.cameraSwitcher.tick === "function") {
    try {
      scene3d.cameraSwitcher.tick(dt);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._cameraTickWarned) {
        scene3d._cameraTickWarned = true;
        console.warn("[phase7.5] cameraSwitcher.tick threw:", e);
      }
    }
  }
  // Portal-space donut: stream the ring tunnel around the camera while a
  // teleport transition is active. AFTER cameraSwitcher.tick so the rig reads
  // the final camera pose this frame; no-op unless armed via startPortalSpace.
  try {
    tickPortalSpace(scene3d, dt);
  } catch (e) {
    if (!scene3d._portalSpaceTickWarned) {
      scene3d._portalSpaceTickWarned = true;
      // eslint-disable-next-line no-console
      console.warn("[portalSpace] tickPortalSpace threw:", e);
    }
  }
  // Render-completeness audit (2026-05-29) — advance animated SurfaceTextures
  // (water/lava/effect frame cycling). No-op until an animated surface loads.
  scene3d?.materialCache?.tickAnimatedSurfaces?.(dt);
  // ── CRITICAL #15 mixer + #16 entity-drain + #19 local pose. ──────────
  // All unconditional — RP3 NEVER budget-gates this block: #15 advances
  // animation, #16 applies server KIND_POSITION snaps, #19 drives the
  // camera-follow rig. Skipping any of these would desync the world.
  if (scene3d?.entityManager) {
    scene3d.entityManager.tick(dt);
    drainEntityEvents3D(scene3d, sessionHandle);
    // Multi-action queue (2026-06-06): FIFO-play queued Action-class motions
    // (emotes/gestures) drained from the wasm side-channel. No-op unless
    // ?multiAction=on. After drainEntityEvents3D so the entity exists.
    drainMotionActions(scene3d, sessionHandle);
    // Casting-ingredient axes: render remote strafe footwork + turn-in-place.
    // No-op unless ?castAxes=on. After drainMotionActions so the entity exists.
    drainMotionAxes(scene3d, sessionHandle);
    // A2-P2 (?remoteInterp=on): apply this tick's wasm-managed remote poses.
    // No-op unless the flag + export exist. AFTER drainEntityEvents3D so the
    // same-frame KIND_POSITION bookkeeping (sticky-clear, heading stash,
    // __lastEntityWorldPos) has landed and the managed write wins the frame.
    drainRemotePoses(scene3d, sessionHandle);
    // Cohere-B follow-on (2026-05-12): drive the local-player rig
    // from the wasm integrator's authoritative pose each rAF. Runs
    // AFTER drainEntityEvents3D so any KIND_SPAWN for the local guid
    // has had a chance to build the rig (which the helper guards on
    // via `entityMap.has`). The KIND_POSITION snap for the local guid
    // is disabled inside drainEntityEvents3D + the shared-hook
    // dispatchOne — this is the replacement source.
    try {
      applyLocalPlayerPoseFromIntegrator(scene3d, sessionHandle);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._localPlayerPoseTickWarned) {
        scene3d._localPlayerPoseTickWarned = true;
        console.warn("[cohere-b] applyLocalPlayerPoseFromIntegrator threw:", e);
      }
    }
    // FU-2 (2026-08-02, `?serverTurn=on`, DEFAULT OFF) — retail
    // `CommandInterpreter::UseTime`'s reclaim poll (acclient.c:717600-717612)
    // plus the `MovePlayer` press arm (:717938). Runs right after the local
    // pose is applied so the convergence probe reads THIS frame's heading.
    // Fully inert flag-off (the function early-returns on SERVER_TURN_ON).
    if (SERVER_TURN_ON) {
      try {
        const mi = scene3d?.cameraSwitcher?.lastMoveIntent;
        let heading = null;
        if (sessionHandle && typeof sessionHandle.getLocalPlayerPose === "function") {
          const p = sessionHandle.getLocalPlayerPose();
          if (p && typeof p.heading === "number" && Number.isFinite(p.heading)) {
            heading = p.heading;
          }
        }
        tickServerTurnControl({
          intentHeld: !!mi && ((mi.forward | 0) !== 0 || (mi.strafe | 0) !== 0 || (mi.turn | 0) !== 0),
          heading,
          applyCurrentMovement: () => {
            // Retail `ApplyCurrentMovement` (:717027) re-issues the held
            // movement after the reclaim. Ours: null the camera dispatcher's
            // dedupe signature so the very next `_dispatchMovement` re-sends
            // the held key state instead of early-returning on an unchanged
            // signature.
            const cs = scene3d?.cameraSwitcher;
            if (cs) cs.lastInputSig = null;
          },
        });
      } catch (e) {
        if (!scene3d._serverTurnTickWarned) {
          scene3d._serverTurnTickWarned = true;
          // eslint-disable-next-line no-console
          console.warn("[serverTurn] control tick threw:", e);
        }
      }
    }
  }
  // ── A11-S3 (CRITICAL — never RP3-gated): particle/script manager phase. ──
  // Retail point in frame: managers run after PositionManager finalizes the
  // frame, unconditionally (acclient.c:322883-322892), and statics update in
  // the SAME pass as dynamic objects (acclient.c:311381-311386). Order:
  // world (dynamic) managers first, then statics, mirroring CPhysics::UseTime
  // (acclient.c:311371-311386). Sits AFTER mixer advance + entity drains +
  // local-pose application and BEFORE any RP3-deferrable phase, so
  // part-anchored emitters read THIS frame's part world frames (lazy
  // getWorldPosition/getWorldQuaternion composition). Re-entry guard: under
  // multi-driver regimes (?netDrainHz + rAF) tickPerFrame can run twice per
  // display frame; managers are absolute-clock based so a second tick is
  // wasted work, not corruption — skip if this driver call carries the same
  // performance.now() timestamp (same-task double-call guard).
  const _pcMode = particleClockMode();
  if (scene3d && _pcMode !== "off") {
    const _pcNowMs = performance.now();
    if (scene3d._a11s3LastTickMs !== _pcNowMs) {
      scene3d._a11s3LastTickMs = _pcNowMs;
      if (_pcMode === "sim") {
        // S3d: advance the shared sim clock by the loop's CLAMPED dt (A1-O5
        // owns the clamp law — no clamp constants here); never ahead of wall
        // time (absorbs double-driver overcount).
        scene3d._particleSimNowS = Math.min(
          (scene3d._particleSimNowS ?? _pcNowMs / 1000) + dt,
          _pcNowMs / 1000
        );
      }
      if (scene3d._a11s3Diag) scene3d._a11s3Diag.managerTicks += 1;
      try { scene3d.entityManager?.tickParticlesAndScripts(); } catch (_) {}
      try { tickStaticParticles(scene3d); } catch (_) {}
    }
  }
  // #14 — LOD band hit/miss telemetry. Armed by `?lodBandDiag=on`
  // (default OFF): returns on its first line when unarmed, so the
  // production per-frame path is byte-identical. Under the flag it
  // observes THREE.LOD active-level transitions into the diag counters.
  try { tickLodBandDiag(scene3d); } catch (_) {}
  // Task #7 — animated-scenery mixers are driven by a self-managed rAF in
  // animated_scenery.js (mirrors the static-particle _spLoop), because this
  // function's `dt` arrives as 0 on the net-drain path. No tick here.
  // ── DEFERRABLE #20 (group NAME) — DOM-projected nameplate overlay. ───
  // The single biggest deferrable (5-50 ms): a full project-every-entity +
  // DOM-write pass. Runs LAST, after every CRITICAL phase has already had
  // its frame, so deferring it can only ever cost label freshness — never
  // input, entity drain, or camera follow. RP3 budget-gates it with NO
  // throttle (it's "due" every frame): when the frame is cheap it runs
  // every frame (crisp labels); when the frame is already over budget it
  // is deferred, but force-runs after RP3_MAX_DEFER_FRAMES consecutive
  // skips (~50 ms @60fps) so labels never freeze. This naturally lands at
  // "every 2nd/3rd frame" under sustained load. `?frameBudget=off` →
  // _rp3ShouldRun short-circuits to true → runs every frame (pre-RP3).
  //
  // It still runs AFTER entity tick so the per-rAF mixer.update has
  // advanced the rig poses for THIS frame — the projection sees
  // current-frame world positions — and AFTER cameraSwitcher.tick so the
  // camera matrices reflect the position we're about to render with.
  // Wrapped in try/catch so a thrown projection / DOM write never kills
  // the tick (one-time warn matches the cameraSwitcher.tick guard above).
  const _rp3RunName = !_rp3 || _rp3ShouldRun(_rp3, RP3_G_NAME, _rp3TsSec, _rp3NowMs());
  if (_rp3RunName && scene3d?.nameplateLayer) {
    try {
      const activeCam =
        scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera;
      if (activeCam) scene3d.nameplateLayer.tick(activeCam);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._nameplateTickWarned) {
        scene3d._nameplateTickWarned = true;
        console.warn("[follow-on#10] nameplateLayer.tick threw:", e);
      }
    }
  }
  // Retail target indicator (2026-08-02, `?selectionIndicator`) — the four
  // corner brackets re-project the selected object's selection sphere EVERY
  // frame, which is why they track the camera. Retail runs this at the very
  // end of `SmartBox::RenderNormalMode`, after the world and the alpha list
  // (acclient.c:144918-:144930), so it belongs here — after the entity tick
  // (rig poses current) and after cameraSwitcher.tick (camera matrices
  // current). Deliberately NOT gated by the RP3 frame-budget stride: it is
  // ONE projection per frame (the nameplate layer is one per entity), and a
  // strided target reticle visibly lags the camera. Same try/catch contract.
  if (scene3d?.selectionBracketLayer) {
    try {
      const activeCam =
        scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera;
      if (activeCam) scene3d.selectionBracketLayer.tick(activeCam);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._selBracketTickWarned) {
        scene3d._selBracketTickWarned = true;
        console.warn("[selection] selectionBracketLayer.tick threw:", e);
      }
    }
  }
}

/**
 * Snapshot the wasm-bindgen EntityUpdate into a plain JS object.
 *
 * EntityUpdate's getters are owned by the wasm-bindgen handle that
 * .free() is called on at the end of the drain (or by the parent
 * 2D drainEvents). For the async spawn path, the meta needs to
 * survive across `await`s — once free() is called, the getters
 * return garbage. This deep-copies every relevant field into a
 * plain object so the EntityManager can reference it later without
 * worrying about wasm lifetime.
 *
 * Mirrors `metaFromSpawn` (`index.html:3383`) for the spawn-only
 * fields, and adds the kind=0 / kind=1 wire-position fields the 3D
 * rig builder needs (the 2D path slots them in via
 * `landblockToWorldXY` outside metaFromSpawn).
 */
function toMeta(upd) {
  // A15-Q2: under `?unifiedClone=on`, defer to the single shared schema.
  // Pass the scratch-backed `_sliceFromScratch` so the Uint32Array copies
  // keep the same shared-empty-sentinel / right-sized allocation behaviour
  // the legacy body below has. The unified clone is a strict superset of
  // the legacy fields, so em.spawn (the sole consumer) is unaffected.
  if (UNIFIED_CLONE_ON) {
    return cloneEntityUpdate(upd, { sliceU32: _sliceFromScratch });
  }
  return {
    guid: (upd.guid >>> 0),
    modelId: (upd.modelId >>> 0),
    setupId: (upd.modelId >>> 0),
    landblockId: (upd.landblockId >>> 0),
    x: upd.x ?? 0,
    y: upd.y ?? 0,
    z: upd.z ?? 0,
    qw: upd.qw ?? 1,
    qx: upd.qx ?? 0,
    qy: upd.qy ?? 0,
    qz: upd.qz ?? 0,
    wcid: (upd.wcid >>> 0),
    itemType: (upd.itemType >>> 0),
    name: upd.name || "",
    iconId: (upd.iconId >>> 0),
    objScale: upd.objScale > 0 ? upd.objScale : 1.0,
    // Object-level physics Translucency (render-audit rank 6, 2026-06-09):
    // PhysicsDesc Translucency (0=opaque..1=transparent), sourced on the wasm
    // KIND_SPAWN arm. entities.js spawn() applies it as whole-object opacity.
    // Spawn-only for now (runtime fade needs the UpdateObject arm to source it).
    physicsTranslucency: +(upd.physicsTranslucency ?? 0),
    paletteId: (upd.paletteId >>> 0),
    mtableId: (upd.mtableId >>> 0),
    // A9-Stage1 (2026-06-12): wire placement id (PhysicsDesc
    // .animation_frame; Spawn only). entities.js threads it into the
    // rest-pose placement chain under ?placementId=on.
    placementId: (upd.placementId ?? 0) >>> 0,
    motionCommand: (upd.motionCommand ?? 0) >>> 0,
    motionStance: (upd.motionStance ?? 0) >>> 0,
    // F3-1 (bughunt 2026-06-09): projectile launch velocity (AC world frame,
    // m/s). Non-zero only on a PhysicsState::MISSILE spawn (the wasm KIND_SPAWN
    // arm forwards the ObjectCreate PhysicsDesc velocity for missiles, 0 for
    // everything else). entities.js _spawnImpl seeds it as `lastVel` + flags
    // `_ballistic` so tick() integrates the flight (ACE never streams in-flight
    // UpdatePosition for missiles, so this is the only motion datum they get).
    vx: +(upd.vx ?? 0),
    vy: +(upd.vy ?? 0),
    vz: +(upd.vz ?? 0),
    // A6 (2026-05-18): copy via shared module scratches, slice to a
    // right-sized retained buffer. The wasm-bindgen Uint32Array views
    // point at linear memory that grows on subsequent allocations, so
    // the copy is still mandatory — but `_sliceFromScratch` returns
    // the shared `_emptyU32` for the (common) empty case to avoid a
    // per-spawn `new Uint32Array(0)` literal, and uses a fast
    // memcpy + slice for the non-empty case.
    modelChanges: _sliceFromScratch(upd.modelChanges, 0),
    textureChanges: _sliceFromScratch(upd.textureChanges, 1),
    subPalettes: _sliceFromScratch(upd.subPalettes, 2),
    // H2 (2026-05-12): entity's PhysicsScript DID for in-world particle
    // effects. Used by entities.js::_spawnImpl to walk the Sky-J chain
    // and attach a per-entity ParticleManager emitter.
    physicsScriptDid: (upd.physicsScriptDid ?? 0) >>> 0,
    // Task E (2026-05-12): entity's SoundTable DID (0x20xxxxxx). Used
    // by entities.js::_spawnImpl to prewarm the SoundTableCache AND
    // by the per-frame hook executor to resolve SoundTable (hookType
    // 2) hooks via `soundTableCache.resolveSound(soundTableDid,
    // soundEnum)`. `0` for entities without a SoundTable property.
    soundTableDid: (upd.soundTableDid ?? 0) >>> 0,
    // HUD rec #52 (2026-06-16): ObjectDescription bitfield. Needed by
    // examine-target.js to dispatch player (bit 0x08) vs creature paths
    // and surface PlayerKiller (bit 0x20). Already present on the
    // unified-clone path (entity_update_clone.js:114) — adding here
    // keeps parity in the legacy default branch.
    objDescFlags: (upd.objDescFlags ?? 0) >>> 0,
  };
}

/**
 * A15-Q3 (2026-06-12, SQ3 spec) — THE unified per-update dispatcher.
 *
 * Hoisted from the `dispatchOne` closure inside `installSharedDrainHook`
 * (Q3.1, pure refactor) and parity-ported with the features that lived
 * ONLY in the dead direct-drain arm (Q3.2, D1-D5 per the spec's
 * divergence inventory). Both dispatch sites now route through here:
 * the live shared-drain hook (`window.__scene3dEntityHook`, fed by the
 * 2D drainEvents pre-`.free()`) and the standalone-capture direct drain
 * (`drainEntityEvents3D` thin wrapper below).
 *
 * Interface contract (load-bearing for S3/A15-Q4, which lifts THIS
 * symbol into `entity_dispatch.js` as the `dispatch3D` backend):
 *   - NEVER calls `upd.free()` — `.free()` stays with whoever polls
 *     (the 2D drainEvents loop for the hook path, the wrapper below
 *     for the direct path).
 *   - NEVER throws (internal try/catch retained).
 *   - Accepts BOTH wasm-bindgen handles and plain-JS clones (the
 *     backlog-replay invariant — both expose the same getters).
 *
 * A15-Q4 (2026-06-12, S3 spec) — DELIVERED: the kind table now lives in
 * `entity_dispatch.js` (`KIND`), the arm bodies in the module-scope
 * `_arm*` functions below, and under `?unifiedDispatch=on` the
 * shared-drain hook routes through a `createEntityDispatcher` "3d"
 * backend table over the SAME arms (see installSharedDrainHook). This
 * function remains the flag-off route AND the capture-path
 * (`drainEntityEvents3D`) route in both flag states; the contract above
 * is unchanged.
 */
// A15-Q4 (2026-06-12, S3 spec) — D1 __diag wire tap, extracted so both
// flag states of the 3D route tap identically (the flag-on dispatcher
// path in installSharedDrainHook and the flag-off if-chain in
// dispatchEntityUpdate below). Diag-only; also counts backlog replays
// and capture-path updates (the Q3.2 moved-semantics note).
function _wireDiagTap(upd) {
  try { window.__diag?.wire?.onEntityUpdate?.(upd); } catch (_) {}
}

// A15-Q4 (2026-06-12, S3 spec §3 Q4.2) — the per-kind 3D backend arms,
// split out of `dispatchEntityUpdate`'s if-chain (which itself was the
// A15-Q3 hoist of the `dispatchOne` closure). BOTH routes call these
// same functions — the flag-off if-chain below and the flag-on
// `createEntityDispatcher` "3d" backend table built in
// installSharedDrainHook — so behavior is identical by construction
// (no second copy). Every arm body is the verbatim pre-Q4 arm; each
// takes (scene3d, em, upd) because everything else it touches is
// module-scope. None of them ever calls `upd.free()` or throws past
// its caller's try/catch.

// ===========================================================================
// Item #2 (2026-07-07) — time-slice the ObjectCreate → spawn dispatch.
// ===========================================================================
// A town-load / teleport burst delivers dozens of ObjectCreate spawns that,
// dispatched in one pass, materialise their geometry in one giant synchronous
// task (the "~9 s dev / fraction on release" freeze; the ~90-spawn backlog
// replay is the login twin). Every non-legacy spawn route — the live array
// hook + single hook, the pre-init3D backlog replay, the synthetic
// spawns.js injector, and the standalone drain — funnels through `_armSpawn`,
// so deferring HERE spreads the burst across frames from one seam.
//
// `em.spawn` is ALREADY async fire-and-forget (nothing downstream may assume
// a synchronous spawn — `_armPosition` already stashes pose for a not-yet-
// spawned guid and `setPose` no-ops), so deferring the kick-off is a change
// of degree, not kind. The queued metas are plain `toMeta` snapshots — safe
// to hold across frames w.r.t. the wasm-handle `.free()` the drain owner does
// after the tick. Default ON; `?noSpawnTimeSlice=1` reverts to inline
// dispatch, `?spawnDispatchPerTick=N` tunes the per-tick kick-off count.
//
// The per-tick COUNT (not a time budget like statics F3) is the lever: each
// kicked-off `em.spawn` schedules its own heavy geometry-assembly continuation
// when its async fetches resolve, so bounding kick-offs/tick bounds how many
// continuations land per yield-interval. setTimeout(0) between ticks (NOT
// rIC — `_ric_shim` poisons it; NOT rAF — dies under renderOnDemand), same
// rationale as the statics F3 time-slice.
const _deferredSpawns = new Map(); // guid → {scene3d, em, meta}; FIFO + dedup + O(1) cancel
let _spawnPumpArmed = false;
function _readSpawnSliceFlag(name, dflt, max) {
  try {
    const v = new URLSearchParams(globalThis.location?.search || "").get(name);
    if (name === "noSpawnTimeSlice") return v !== "1";
    const n = v == null ? NaN : parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, max);
  } catch (_) { /* SSR / no location */ }
  return dflt;
}
const _SPAWN_TIMESLICE = _readSpawnSliceFlag("noSpawnTimeSlice", true);
const _SPAWN_PER_TICK = _readSpawnSliceFlag("spawnDispatchPerTick", 6, 64);

// FU-2 (2026-08-02): is this spawn something that can wield? Only these get a
// retry ladder in scene3d/index.js's flushWieldedDirty, so a lifestone / a
// pile of pyreals / a door never burns retry budget. Bits per
// target_cycle.js: ItemType::Creature (ACE ItemType.cs) = 0x10,
// ObjectDescriptionFlag::Player (ACE ObjectDescriptionFlag.cs) = 0x08.
function _isWielderCapable(meta) {
  const it = (meta?.itemType ?? 0) >>> 0;
  const odf = (meta?.objDescFlags ?? 0) >>> 0;
  return (it & 0x10) !== 0 || (odf & 0x08) !== 0;
}

// The actual spawn + FU-1 wield nudge, run at real dispatch time (inline or
// pumped) so the wield re-sync still fires per spawned guid.
function _doSpawn(em, meta) {
  em.spawn(meta);
  // D2 (Q3.2, rides existing ?wieldHandAttach, default-off ⇒ inert):
  // FU-1 (2026-06-11) — LOGIN-time wielded items never get a kind=49
  // Wielder-transition event (the wield predates the session), so no attach
  // is ever requested and the weapon renders "dropped" at the feet. Nudge the
  // wielder re-sync for every spawned guid: if it wields anything,
  // flushWieldedDirty enumerates entityWieldedItems() and requests the
  // attaches (child-not-yet-spawned ordering is handled by _pendingAttach).
  // Covers the local player on login AND NPCs spawning pre-armed. No-op for
  // non-wielders.
  if (em._wieldHandAttach) {
    try { em._markWielderDirty?.(meta.guid, { retry: _isWielderCapable(meta), spawn: true }); } catch (_) {}
  }
}

function _pumpDeferredSpawns() {
  _spawnPumpArmed = false;
  let n = 0;
  const done = [];
  for (const [guid, entry] of _deferredSpawns) {
    if (n >= _SPAWN_PER_TICK) break;
    // Drop silently if the scene was torn down / the EntityManager was swapped
    // (renderer hot-swap) between enqueue and pump — spawning into a detached
    // EM would orphan the rig.
    if (entry.scene3d.entityManager === entry.em) {
      try { _doSpawn(entry.em, entry.meta); }
      catch (e) { /* eslint-disable-next-line no-console */ console.warn("[loop] deferred spawn threw:", e); }
    }
    done.push(guid);
    n += 1;
  }
  for (const g of done) _deferredSpawns.delete(g);
  if (_deferredSpawns.size > 0) {
    _spawnPumpArmed = true;
    setTimeout(_pumpDeferredSpawns, 0);
  }
}

function _enqueueDeferredSpawn(scene3d, em, meta) {
  // Map.set on an existing key keeps its FIFO position but updates the value,
  // so a re-spawn of a still-queued guid supersedes with the latest meta.
  _deferredSpawns.set(meta.guid >>> 0, { scene3d, em, meta });
  if (!_spawnPumpArmed) {
    _spawnPumpArmed = true;
    setTimeout(_pumpDeferredSpawns, 0);
  }
}

// A KIND_REMOVE for a guid whose spawn is still queued must drop the queued
// spawn — else the pump would later create an entity that should have been
// removed (spawn-then-despawn in the same burst → orphan). No-op once the
// spawn has already kicked off (the in-flight case is the pre-existing async
// race, unchanged by this deferral).
function _cancelDeferredSpawn(guid) {
  _deferredSpawns.delete(guid >>> 0);
}

// P4/R-10 (A03-F3 ≡ A13-L2) — teleport spawn-flush. A portal hop leaves the
// departed area's queued spawns at the FRONT of the FIFO, so the pump spends
// its first ~N/6 ticks building rigs the player just left — at full Step A–E
// cost, exactly while the destination is loading. On a local-player landblock
// DISCONTINUITY (Chebyshev > _SPAWN_FLUSH_RADIUS in LB coords — walking moves
// one LB at a time; only a teleport jumps), drop queued spawns whose OWN
// landblock is outside that radius of the NEW position. Safe against ACE's
// visibility contract (A03-F3): anything dropped is far outside the ~1-LB
// outdoor vis range, so the server's ObjMaint sweep is already destroying
// those objects for us — their KIND_REMOVEs hit `_cancelDeferredSpawn`
// (no-op once flushed) — and a return trip re-sends ObjectCreate (fresh
// visibility). In-flight (already-kicked) spawns remain covered by the
// pre-existing generation token in `_spawnImpl` (A03 "verified-good" list).
// Default ON; `?spawnTeleportFlush=off` (also 0/false) reverts.
const _SPAWN_FLUSH_ON = (() => {
  try {
    const v = new URLSearchParams(globalThis.location?.search || "")
      .get("spawnTeleportFlush")?.toLowerCase();
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) {
    return true;
  }
})();
const _SPAWN_FLUSH_RADIUS = 2; // Chebyshev LBs; > this = teleport AND out-of-range
let _lastSpawnFlushLbKey = null;

/** Per-frame hook (index.js LRU tick): note the local player's current LB
 * and flush the departed area's queued spawns on a discontinuity. Returns
 * how many queued spawns were dropped (0 on the common no-jump path). */
export function noteLocalPlayerLandblockForSpawnFlush(lbIdOrKey) {
  if (!_SPAWN_FLUSH_ON || !lbIdOrKey) return 0;
  const key = lbKeyOf(lbIdOrKey >>> 0);
  const prev = _lastSpawnFlushLbKey;
  _lastSpawnFlushLbKey = key;
  if (prev == null || key === prev) return 0;
  if (lbChebyshev(prev, key) <= _SPAWN_FLUSH_RADIUS) return 0; // walking
  let flushed = 0;
  for (const [g, entry] of _deferredSpawns) {
    const mLb = entry?.meta?.landblockId;
    if (mLb == null) continue;
    if (lbChebyshev(lbKeyOf(mLb >>> 0), key) > _SPAWN_FLUSH_RADIUS) {
      _deferredSpawns.delete(g);
      flushed += 1;
    }
  }
  if (flushed > 0) {
    // eslint-disable-next-line no-console
    console.info(
      `[loop] teleport spawn-flush: dropped ${flushed} queued spawn(s) from the departed area`
    );
  }
  return flushed;
}

function _armSpawn(scene3d, em, upd) {
  // Snapshot before async — the wasm-bindgen handle may be `.free()`'d by the
  // owner right after dispatch, but the spawn is async + may await the
  // keyframe fetch. The plain meta is safe to hold across the deferral.
  const meta = toMeta(upd);
  // Dispatch the LOCAL PLAYER immediately so the camera latches onto its rig
  // without a few-frame delay (mirrors the backlog replay's local-first
  // priority). All other spawns time-slice across frames unless disabled.
  if (!_SPAWN_TIMESLICE || isLocalPlayerGuid(meta.guid >>> 0)) {
    _doSpawn(em, meta);
    return;
  }
  _enqueueDeferredSpawn(scene3d, em, meta);
}

// (2026-07-02) — death-hold grace: how long a freshly-Dead creature's rig
// survives its server delete so the collapse / frozen death pose is visible.
// ACE's `deathAnimLength` resolves through the MotionTable LINKS only
// (GetAnimData, DatLoader MotionTable.cs:130-148); creature Dead lives in
// the CYCLES, so the server deletes the creature ~immediately after the
// Dead motion — the corpse ObjectCreate lands in the same breath. 2 s
// covers the typical authored collapse (e.g. Broken Fragment Dead cycle at
// 30 fps) and gives the framerate-0 frozen poses (Blood Shreth, lowFrame 40
// hold) a visible beat before the corpse takes over.
const DEATH_HOLD_MS = 2000;

function _armRemove(scene3d, em, upd) {
  // A4 (2026-05-18): prune __lastEntityWorldPos on despawn to bound Map growth.
  const g = upd.guid >>> 0;
  // Item #2 — drop a still-queued (not-yet-dispatched) spawn for this guid so
  // a spawn-then-despawn in the same burst can't later materialise an orphan.
  _cancelDeferredSpawn(g);
  // (2026-07-02) — defer the visual disposal of a creature that JUST
  // received its Dead motion (entities.js stamps `_deathAt`), so the
  // collapse one-shot / frozen death pose renders instead of an instant
  // vanish. The deferred timer only removes the SAME instance it deferred
  // (`_removePending` marks it); a guid reused by a fresh spawn in the
  // window has a new inst without the mark, so it is never clobbered.
  try {
    const inst = em?.entityMap?.get?.(g);
    const deadAt = inst?._deathAt;
    if (inst && typeof deadAt === "number") {
      // (2026-07-06) If a corpse handoff has claimed this creature, the corpse's
      // own reveal timer removes it exactly when the collapse ends (and reveals
      // the corpse in the same beat) — don't also schedule our own disposal.
      if (inst._corpseHandoffGuid) {
        if (window.__lastEntityWorldPos) window.__lastEntityWorldPos.delete(g);
        _actionStamps.delete(g);
        return;
      }
      const nowMs = (typeof performance !== "undefined" && performance.now)
        ? performance.now() : Date.now();
      // (2026-07-06) Hold the rig for the REAL authored collapse length
      // (entities.js stamps `_deathDurationMs` from the Ready→Dead link bake —
      // it varies per creature), falling back to the flat DEATH_HOLD_MS when the
      // creature had no collapse link (bake gave the 1-frame cycle hold).
      const holdMs = (typeof inst._deathDurationMs === "number" && inst._deathDurationMs > 0)
        ? inst._deathDurationMs : DEATH_HOLD_MS;
      const remaining = deadAt + holdMs - nowMs;
      if (remaining > 0 && !inst._removePending) {
        inst._removePending = true;
        // Re-check the corpse-handoff claim AT FIRE TIME: the claim is made
        // by the corpse's async TIME-SLICED spawn, which lands after this
        // timer was armed (ACE sends CreateCorpse+Destroy in one action) —
        // the arm-time check alone destroyed the ragdolling creature before
        // finishReveal could copy its pose (2026-08-02 trace, bug #2). And
        // when the corpse spawn is SLOW (busy dungeon queue), DEFER while
        // the ragdoll sim is still live so the claim can still arrive — the
        // final removal is bounded (~8s) so nothing leaks. finishReveal owns
        // removal once the claim exists.
        let deferrals = 12;
        const fire = () => {
          try {
            const cur = em?.entityMap?.get?.(g);
            if (!cur || !cur._removePending) return;
            if (cur._corpseHandoffGuid) return; // finishReveal owns it now
            if (cur._ragdoll && !cur._ragdoll.sim?.done && deferrals-- > 0) {
              setTimeout(fire, 700);
              return;
            }
            em.remove(g);
          } catch (_) {}
        };
        setTimeout(fire, remaining);
        // Bookkeeping is pruned immediately — only the rig disposal waits.
        if (window.__lastEntityWorldPos) window.__lastEntityWorldPos.delete(g);
        _actionStamps.delete(g);
        return;
      }
    }
  } catch (_) {}
  em.remove(g);
  if (window.__lastEntityWorldPos) window.__lastEntityWorldPos.delete(g);
  // F18-4: prune the multiAction stamp-dedup so a reused guid (a
  // respawned creature) isn't silently refused its first action.
  _actionStamps.delete(g);
}

function _armPosition(scene3d, em, upd) {
  const lbId = upd.landblockId >>> 0;
  const lbX = (lbId >>> 24) & 0xff;
  const lbY = (lbId >>> 16) & 0xff;
  const wx = lbX * 192.0 + (upd.x ?? 0);
  const wy = lbY * 192.0 + (upd.y ?? 0);
  const wz = upd.z ?? 0;
  const g = upd.guid >>> 0;
  // Always stash the latest world-space position per guid, even
  // when the 3D EntityManager has no rig for this guid yet (the
  // wasm-side eager-WorldState path suppresses KIND_SPAWN for
  // the local player on SelectCharacter, so `em.setPose` below
  // is a no-op for that guid). `getLocalPlayerWorldPos` uses
  // this as its last-resort fallback so the camera tracks the
  // server pose regardless of whether a rig ever spawned.
  //
  // Workstream B (2026-05-11): `ts` is the rAF wall-clock when
  // this server-authoritative pose landed. The cameraSwitcher's
  // client-side prediction reads (x, y, z, ts) on each rAF: a
  // changed `ts` means a fresh KIND_POSITION arrived from ACE
  // since the last reconcile, so the prediction can snap-or-lerp
  // toward the new authoritative pose. Without the timestamp the
  // prediction would re-reconcile on every rAF and never let the
  // client-side integration breathe.
  if (!window.__lastEntityWorldPos) {
    window.__lastEntityWorldPos = new Map();
  }
  // A2: mutate the per-guid slot in place instead of allocating
  // a fresh `{x,y,z,ts}` literal per KIND_POSITION event.
  const _posSlot = _getOrCreatePosSlot(window.__lastEntityWorldPos, g);
  _posSlot.x = wx;
  _posSlot.y = wy;
  _posSlot.z = wz;
  _posSlot.ts = _nowMs();
  // Cohere-B follow-on (2026-05-12): skip the snap-to-server
  // for the local player here too — the per-rAF integrator
  // sync in `applyLocalPlayerPoseFromIntegrator` owns the
  // local rig's pose. KIND_POSITION still updates
  // `__lastEntityWorldPos` (above) so the camera's Workstream
  // B reconciliation gate sees the fresh `ts` and behaves
  // correctly.
  if (!isLocalPlayerGuid(g)) {
    // Terrain renders exactly on the collision surface the server Z is
    // bound to (visual == collision), so no visual reconcile is needed —
    // pose the remote rig directly at the server Z. (Removed the
    // outdoor-only getTerrainVisualZ raycast + 0.3 m lift, 2026-06-26.)
    em.setPose(
      g,
      wx, wy, wz,
      upd.qw ?? 1, upd.qx ?? 0, upd.qy ?? 0, upd.qz ?? 0
    );
  }
}

function _armVelocity(scene3d, em, upd) {
  // A2: mutate-in-place scratch (shared across both drain paths;
  // setVelocity copies synchronously and does not retain a ref).
  _velScratch.guid = upd.guid >>> 0;
  _velScratch.vx = upd.vx ?? 0;
  _velScratch.vy = upd.vy ?? 0;
  _velScratch.vz = upd.vz ?? 0;
  _velScratch.omegaZ = upd.omegaZ ?? 0;
  em.setVelocity(_velScratch);
}

function _armMotion(scene3d, em, upd) {
  const motionGuid = upd.guid >>> 0;
  // DIM10/A-2 (2026-06-05): skip the local player — its gait is
  // client-predicted (W3.1, index.html ~10207); re-dispatching the
  // server echo fights the predictor and breaks the run loop. See the
  // FORCE_MOTION_LOCAL block at the top of this module for the full
  // rationale.
  const st = (upd.motionStance ?? 0) >>> 0;
  const motionCmd = (upd.motionCommand ?? 0) >>> 0;
  // SG-B (2026-06-09): wire `is_autonomous` bit (UpdateMotion 0xF74C).
  // true = client-predicted gait echo (skip); false = server-forced
  // pose (apply under FORCE_MOTION_LOCAL). ACE semantics in the
  // FORCE_MOTION_LOCAL comment block above.
  const isAuto = !!upd.isAutonomous;
  // WS02 (`?castGestureParity`, default ON): swallow the LOCAL player's own
  // cast-gesture KIND_MOTION echo — the client already predicted it
  // (playCastSequence → setSwingMotion + noteLocalSwingPrediction). The 0x40
  // cast-gesture substate rides KIND_MOTION (is_action_motion_command=false),
  // NOT the deduped KIND_MOTION_ACTION path the windups use, so nothing else
  // swallows this echo → double-play/restart + over-held clamped frame. See the
  // CAST_GESTURE_PARITY_ON block above.
  if (CAST_GESTURE_PARITY_ON && isLocalPlayerGuid(motionGuid)) {
    const low = motionCmd & 0xffff;
    if (isLocalPredictedCastGestureLow(low)) {
      // KIND_MOTION delivers the raw low16; the chain noted the FULL 0x40-class
      // command — expand to match (crates/.../player/types.rs same mapping).
      const fullGesture = (0x40000000 | low) >>> 0;
      if (em.consumeLocalSwingEcho?.(motionGuid, fullGesture)) {
        // Predicted → drop the redundant echo (no double-play/restart/clamp).
        // Keep the server stance authoritative like the skip-branch below.
        em._castDiag?.("echoSwallowed");
        if (st !== 0) em.setLocalStance?.(motionGuid, st);
        return;
      }
      // No prediction (playCastSequence early-returned: table-not-loaded first
      // frame / F8-4 busy window / note expired at very high RTT) → fall
      // through so the echo is the single animation source. Fail-open.
    }
  }
  // FORCE_MOTION_LOCAL (B5#2 + SG-B): when ON, a server-FORCED
  // (`!isAuto`) NON-LOCOMOTION pose/action passes through to the
  // local rig; an autonomous echo OR a locomotion-class command is
  // still skipped to preserve the B9 client-gait predictor.
  const forceLocal =
    FORCE_MOTION_LOCAL_ON &&
    !isAuto &&
    !isLocalGaitLocomotionCmd(motionCmd);
  if (forceLocal || !isLocalPlayerGuid(motionGuid)) {
    // A1 (2026-05-29): forward UpdateMotion.forward_speed (default 1.0).
    em.setMotion(
      motionGuid,
      motionCmd,
      st,
      +(upd.motionSpeed ?? 1.0)
    );
  } else if (st !== 0) {
    // Track B9 (2026-06-08): skip the local LOCOMOTION command but
    // restore the server-authoritative STANCE half of UpdateMotion
    // 0xF74C. setLocalStance touches only the Ready/idle base pose
    // and never the predictor-owned walk/run clip.
    em.setLocalStance(motionGuid, st);
  }
  // F3-4 (bughunt 2026-06-09): sticky-attack target rides on model_id
  // of KIND_MOTION (0 = none/clear). Remote-only — the local player is
  // never sticky. While set, EntityManager.tick glues the mob to the
  // moving target so a kited melee monster tracks the player.
  // A2-P3 R2 (?stickyRetail=on): this arm STAYS the flag-OFF path —
  // when the wasm StickyManager owns a remote, its sticky-flagged
  // pollRemotePoses rows clear this glue per row (drainRemotePoses).
  if (!isLocalPlayerGuid(motionGuid) && typeof em.setStickyTarget === "function") {
    em.setStickyTarget(motionGuid, upd.modelId >>> 0);
  }
  // F3-5 (bughunt 2026-06-09): per-creature run rate on `vx`. Remote-only.
  if (!isLocalPlayerGuid(motionGuid) && typeof em.setEntityRunRate === "function") {
    em.setEntityRunRate(motionGuid, +(upd.vx ?? 0));
  }
  // Wave 10 Phase 10.1 (2026-05-26) — the Fallen→setAirborne(false)
  // coupling was removed; the local arms-up overlay now clears via
  // `kind=18` recv-side dispatch (lib.rs Wave 10.1 + index.html
  // kind=18 handler).
}

function _armMotionAction(scene3d, em, upd) {
  // Wave 2 (2026-06-08) — one-shot Action-class command (creature
  // attack swing B10, local eat/drink B6, emote/gesture). The wasm
  // side already EXPANDED it to the full 32-bit MotionCommand and
  // applied the 15-bit stamp-dedup, so we just route it through
  // setMotion → classifyMotionCommand → _tryPlayLink, which plays it
  // as a LoopOnce OVERLAY on top of the active locomotion cycle.
  //
  // Unlike KIND_MOTION, this fires for EVERY guid INCLUDING the local
  // player: the command is ONLY ever an Action-class one-shot (never
  // a locomotion command), so playing it does not touch the client-
  // predicted gait (B9 gait predictor unaffected; C1).
  const actionGuid = upd.guid >>> 0;
  const actionCmd = (upd.motionCommand ?? 0) >>> 0;
  const actionStance = (upd.motionStance ?? 0) >>> 0;
  // D3 (Q3.2, ?dispatchParity=on, default-off): F6-2 swing-echo
  // dedup, ported from the dead direct arm where it was inert in
  // live mode. The note side (picking.js noteLocalSwingPrediction)
  // fires on the DEFAULT live click path, so this port changes
  // default-mode combat visuals — hence the gate.
  if (DISPATCH_PARITY_ON && actionCmd !== 0 &&
      em.consumeLocalSwingEcho?.(actionGuid, actionCmd)) {
    // F6-2: optimistic local swing already played (picking.js
    // noteLocalSwingPrediction); swallow the server echo instead of
    // double-playing / restarting the same clip ~RTT later. Remote
    // guids and non-matching commands are unaffected.
    // WS01: count how often the echo is deduped (diag-only) — measures the
    // window where the local prediction is the SOLE animator (RC-1).
    em._castDiag?.("echoSwallowed");
    // WS16 diag: echo-vs-prediction dedup counter (the server echo was swallowed).
    try { window.__diag?.cast?.onEchoConsume?.({ cmd: actionCmd, hit: true }); } catch (_) {}
  } else if (actionCmd !== 0 && typeof em.setMotion === "function") {
    em.setMotion(actionGuid, actionCmd, actionStance, +(upd.motionSpeed ?? 1.0));
    // D4 (Q3.2, rides existing ?serverSwing, default-off ⇒ inert):
    // FU-3 (2026-06-11) — under ?serverSwing=on the local rig has no
    // click-time swing anymore, and setMotion's MT clip doesn't
    // animate the local rig. Fire the procedural shoulder pose at
    // this (server-timed, post-MoveTo) moment for attack-class
    // commands (0x51..0x6E per the swing-classification table;
    // 0x50 FallDown excluded).
    if (SERVER_SWING_ON && isLocalPlayerGuid(actionGuid)) {
      const low = actionCmd & 0xFFFF;
      if (low >= 0x51 && low <= 0x6E) {
        try { em.setSwingPose?.(actionGuid); } catch (_) {}
      }
    }
  }
}

function _armTurn(scene3d, em, upd) {
  // F3-3 (bughunt 2026-06-09): server TurnTo* directive — turn the
  // rig to face the absolute target heading (qw/qx/qy/qz).
  // Remote-only; the local player owns its own facing.
  const turnGuid = upd.guid >>> 0;
  // ROT-1 (2026-08-02) — count the LOCAL-guid turn directives we discard.
  // Retail does NOT discard them: `CPhysics::SetObjectMovement`
  // (acclient.c:311149) drops a movement blob addressed to the local player
  // only when its `autonomous` byte is set (the client's own echo). ACE's
  // `TurnToObject` broadcast is NON-autonomous and self-inclusive
  // (`Creature_Navigation.cs:127` → `EnqueueBroadcastMotion` →
  // `EnqueueBroadcast(sendSelf: true)`, `WorldObject_Networking.cs:1413`), so
  // retail UNPACKS it, turns the local player, and — because
  // `SetObjectMovement` returns 1 for a player — the dispatcher calls
  // `CommandInterpreter::LoseControlToServer()` (acclient.c:392828), handing
  // the drive to the server until `CommandInterpreter::UseTime` reclaims it
  // (acclient.c:717600-717612). Dropping it here is why the client needs a
  // LOCAL turn-to-face substitute at all (picking.js `turnToFaceThenAct`),
  // and why the two can fight. This counter is the evidence surface for that
  // arbitration; see `window.__diag.picking`.
  if (isLocalPlayerGuid(turnGuid)) {
    try { if (window.__diag?.picking) window.__diag.picking.localTurnDirectivesDropped++; } catch (_) {}
    // FU-2 (2026-08-02, `?serverTurn=on`, DEFAULT OFF) — STOP dropping it.
    // Retail applies the non-autonomous server turn to the local player and
    // then hands the drive over (`CPhysics::SetObjectMovement` :311149 →
    // `CommandInterpreter::LoseControlToServer` :716832; full chain in
    // scene3d/server_turn.js). We drive it through the wasm integrator's
    // `TurnToHeading` (retail :346141) rather than the rig quaternion,
    // because `applyLocalPlayerPoseFromIntegrator` re-renders the local rig
    // heading from `pose.heading` every frame and would overwrite a direct
    // quaternion write on the very next tick.
    if (SERVER_TURN_ON) {
      const heading = headingFromTurnQuat(upd.qw ?? 1, upd.qz ?? 0);
      const sh = (typeof window !== "undefined") ? window.__sessionHandle : null;
      let applied = false;
      if (heading !== null && sh && typeof sh.turnToHeading === "function") {
        try { sh.turnToHeading(heading); applied = true; } catch (_) { applied = false; }
      }
      if (applied) noteServerTurnApplied(); else noteServerTurnDropped();
      // Retail's LoseControlToServer fires off SetObjectMovement's return
      // value regardless of what the motion was, so latch even if the
      // TurnToHeading call itself was refused (pre-seed etc.).
      const cs = scene3d?.cameraSwitcher;
      const mi = cs?.lastMoveIntent;
      const intentHeld =
        !!mi && ((mi.forward | 0) !== 0 || (mi.strafe | 0) !== 0 || (mi.turn | 0) !== 0);
      loseControlToServer(heading, intentHeld, () => {
        // Retail: SetAutoRun(0, apply_movement=0) + ClearAllCommands()
        // (:716840-:716845). Our analogue — flush the wasm drive once and
        // force the camera dispatcher to re-fire on the next real key edge.
        try { sh?.setMovementInput?.(0, 0, 0, false); } catch (_) {}
        if (cs) { cs.lastInputSig = null; }
      });
    }
  }
  if (!isLocalPlayerGuid(turnGuid) && typeof em.applyTurnDirective === "function") {
    // G-5 (?turnOmega=on): forward the wire MoveToParameters.speed
    // (surfaced on omega_z) so the slerp can rate-limit to retail.
    em.applyTurnDirective(turnGuid, upd.qw ?? 1, upd.qx ?? 0, upd.qy ?? 0, upd.qz ?? 0, +(upd.omegaZ ?? 0));
  }
}

function _armAppearance(scene3d, em, upd) {
  // SG-D (2026-06-09): mid-game appearance change (equip / dye-commit /
  // death re-skin) from the wasm `UpdateObject` (0xF7DB) / `ObjDescEvent`
  // (0xF625) arms (lib.rs ~31978 / ~32058), which pack only the four
  // substitution-relevant fields and zero the rest. `_sliceFromScratch`
  // returns a fresh `.slice()` copy so the async `applyAppearance` is
  // alias-safe.
  //
  // Applies to the LOCAL player too (you should see your own gear/dye
  // change). `applyAppearance` despawn+respawns the rig (or hot-swaps
  // under `?clothingHotSwap=1`), preserving world pose; the camera +
  // integrator re-resolve the rig via `entityMap.get(guid)` every frame,
  // so the respawn doesn't orphan their binding. PENDING 1070 eye-test:
  // confirm no visible local-rig flicker on equip during normal play
  // (enable hot-swap if it does).
  em.applyAppearance?.(upd.guid >>> 0, {
    modelChanges: _sliceFromScratch(upd.modelChanges, 0),
    textureChanges: _sliceFromScratch(upd.textureChanges, 1),
    subPalettes: _sliceFromScratch(upd.subPalettes, 2),
    paletteId: (upd.paletteId ?? 0) >>> 0,
    // R7 (?runtimeObjScale=on): runtime scale/translucency (sentinels
    // 0 / -1 = no change; applyAppearance gates on the flag).
    objScale: +(upd.objScale ?? 0),
    physicsTranslucency: +(upd.physicsTranslucency ?? -1),
  });
}

function _armAttach(scene3d, em, upd) {
  // Render-completeness audit (2026-05-29) — wielded item equipped
  // or unequipped. model_id is the wielder guid (0 = detach back to
  // world / hide). motionCommand = holding-location key (RightHand=1,
  // …); motionStance = the child's grip placement key. EntityManager
  // parents the child rig under the wielder's part node at the
  // resolved holding-location frame.
  const childGuid = upd.guid >>> 0;
  const parentGuid = (upd.modelId ?? 0) >>> 0;
  em.attachChildToParent?.(
    childGuid,
    parentGuid,
    (upd.motionCommand ?? 0) >>> 0,
    (upd.motionStance ?? 0) >>> 0
  );
}

function _armMetaRefresh(scene3d, em, upd) {
  // D5 (Q3.2): explicit no-op arm. Not yet consumed — the consumer
  // stays unowned (portal-destination → nameplate/chip overlays);
  // see S3 (A15-Q4) OPEN QUESTIONS.
}

export function dispatchEntityUpdate(scene3d, em, upd) {
  if (!upd) return;
  // D1 (Q3.2, unconditional): __diag wire tap — moved from the legacy
  // direct arm (its sole prior call site, so it never fired in live 3D
  // sessions). Extracted to _wireDiagTap (A15-Q4) so the flag-on
  // dispatcher route taps identically.
  _wireDiagTap(upd);
  try {
    const kind = upd.kind | 0;
    if (kind === KIND_SPAWN) {
      _armSpawn(scene3d, em, upd);
    } else if (kind === KIND_REMOVE) {
      _armRemove(scene3d, em, upd);
    } else if (kind === KIND_POSITION) {
      _armPosition(scene3d, em, upd);
    } else if (kind === KIND_VELOCITY) {
      _armVelocity(scene3d, em, upd);
    } else if (kind === KIND_MOTION) {
      _armMotion(scene3d, em, upd);
    } else if (kind === KIND_MOTION_ACTION) {
      _armMotionAction(scene3d, em, upd);
    } else if (kind === KIND_TURN) {
      _armTurn(scene3d, em, upd);
    } else if (kind === KIND_APPEARANCE) {
      _armAppearance(scene3d, em, upd);
    } else if (kind === KIND_ATTACH) {
      _armAttach(scene3d, em, upd);
    } else if (kind === KIND_META_REFRESH) {
      _armMetaRefresh(scene3d, em, upd);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[a15-q3] dispatchEntityUpdate:", e);
  }
}

/**
 * Pull pollEntityUpdates() results from the SessionHandle and dispatch
 * into the EntityManager. The 3D path's first-cut: when
 * `?renderer=3d` and the bootstrap skipped 2D `renderNeighbourhood`,
 * the 2D drainEvents loop is still running (it owns chat / local
 * player movement / etc). To avoid double-consumption, this function
 * is a no-op when `scene3d.useSharedDrain` is true (the default for
 * Phase 7.4b — the 2D drainEvents calls
 * `window.scene3dEntityHook(events)` to forward the entity-shaped
 * events without re-draining).
 *
 * **For the standalone capture path** (Phase 7.4b synthetic test +
 * any future renderer-only host), the EntityManager's drain calls
 * `sessionHandle.pollEntityUpdates()` directly; that's the same path
 * the 2D drainEvents uses, so as long as only one of the two is
 * active per frame, no double-consumption occurs.
 *
 * A15-Q3.3 (2026-06-12): retired to a thin poll → `dispatchEntityUpdate`
 * → `.free()` wrapper over the unified core. The pre-Q3 legacy arm is
 * preserved verbatim behind `?legacyDirectDrain=on`
 * (`_legacyDirectDrainArm` below) as the rollback hatch; live 3D mode is
 * unaffected in either state (the `useSharedDrain` early-return fires
 * first). Net capture-path change (default): gains the live-arm-only
 * features (per-guid pos-slot stash, F4-3 indoor-gated Z-reconcile) and
 * keeps D1-D5 via the Q3.2 ports — capture now matches live exactly.
 */
function drainEntityEvents3D(scene3d, sessionHandle) {
  if (!sessionHandle || typeof sessionHandle.pollEntityUpdates !== "function") {
    // Capture-script path: the EntityManager exposes a synthetic
    // injector window.__phase74_inject_event(upd) that capture
    // scripts can call to feed events without a live session. That
    // path doesn't go through here — it calls EntityManager methods
    // directly.
    return;
  }
  // Phase 7.4b coexistence shim: when the 2D drainEvents has already
  // consumed events this frame, scene3d.useSharedDrain is true and
  // each entity update was forwarded via window.__entitiesHook below.
  // Skip the wasm round-trip in that case.
  if (scene3d.useSharedDrain) return;
  // A15-Q3.3 rollback hatch: verbatim pre-Q3 legacy arm.
  if (LEGACY_DIRECT_DRAIN_ON) return _legacyDirectDrainArm(scene3d, sessionHandle);
  let updates;
  try {
    updates = sessionHandle.pollEntityUpdates();
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._drainWarned) {
      scene3d._drainWarned = true;
      console.warn("[phase7.4b] pollEntityUpdates threw:", e);
    }
    return;
  }
  if (!updates || updates.length === 0) return;
  const em = scene3d.entityManager;
  for (const upd of updates) {
    dispatchEntityUpdate(scene3d, em, upd); // unified core (Q3.1+Q3.2) — never frees
    // The wrapper OWNS the wasm-bindgen lifetime (the hook path never
    // frees — the 2D drainEvents loop owns it there).
    if (typeof upd.free === "function") {
      try { upd.free(); } catch (_) {}
    }
  }
}

/**
 * A15-Q3.3 — the pre-Q3 direct-drain arm, moved verbatim (private, not
 * exported). Reachable ONLY via `?legacyDirectDrain=on` from the wrapper
 * above (rollback hatch for a capture path that silently depends on a
 * dead-arm quirk, e.g. the bare setPose without the F4-3 raycast).
 * Delete at flag retirement (post-eye-test).
 */
function _legacyDirectDrainArm(scene3d, sessionHandle) {
  let updates;
  try {
    updates = sessionHandle.pollEntityUpdates();
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._drainWarned) {
      scene3d._drainWarned = true;
      console.warn("[phase7.4b] pollEntityUpdates threw:", e);
    }
    return;
  }
  if (!updates || updates.length === 0) return;
  const em = scene3d.entityManager;
  for (const upd of updates) {
    try { window.__diag?.wire?.onEntityUpdate?.(upd); } catch (_) {}
    try {
      const kind = upd.kind | 0;
      if (kind === KIND_SPAWN) {
        // Snapshot before async — the wasm-bindgen handle will be
        // .free()'d at the end of this loop iteration, but the spawn
        // is async + may await the keyframe fetch.
        const meta = toMeta(upd);
        em.spawn(meta);
        // FU-1 (2026-06-11, ?wieldHandAttach=on): LOGIN-time wielded
        // items never get a kind=49 Wielder-transition event (the wield
        // predates the session), so no attach is ever requested and the
        // weapon renders "dropped" at the feet. Nudge the wielder
        // re-sync for every spawned guid: if it wields anything,
        // flushWieldedDirty enumerates entityWieldedItems() and
        // requests the attaches (child-not-yet-spawned ordering is
        // handled by _pendingAttach). Covers the local player on login
        // AND NPCs spawning pre-armed. No-op for non-wielders.
        if (em._wieldHandAttach) {
          try { em._markWielderDirty?.(meta.guid, { retry: _isWielderCapable(meta), spawn: true }); } catch (_) {}
        }
      } else if (kind === KIND_REMOVE) {
        // A4 (2026-05-18): prune __lastEntityWorldPos on despawn to bound Map growth.
        const g = upd.guid >>> 0;
        em.remove(g);
        if (window.__lastEntityWorldPos) window.__lastEntityWorldPos.delete(g);
        // F18-4: prune the multiAction stamp-dedup so a reused guid (a
        // respawned creature) isn't silently refused its first action.
        _actionStamps.delete(g);
      } else if (kind === KIND_POSITION) {
        // The 2D path translates LB-local → world; the 3D path's
        // setPose takes world coords already (rig.position is world,
        // not relative to entitiesGroup which is identity-rooted).
        const lbId = upd.landblockId >>> 0;
        const lbX = (lbId >>> 24) & 0xff;
        const lbY = (lbId >>> 16) & 0xff;
        const wx = lbX * 192.0 + (upd.x ?? 0);
        const wy = lbY * 192.0 + (upd.y ?? 0);
        const g = upd.guid >>> 0;
        // Cohere-B follow-on (2026-05-12): skip the snap-to-server for
        // the local player. `applyLocalPlayerPoseFromIntegrator` runs
        // every rAF and reads the wasm integrator's pose directly, so
        // KIND_POSITION events for the local guid would just fight that
        // (the server pose lags client integration when, e.g., Run skill
        // is low). Non-local entities still snap as authoritative.
        if (!isLocalPlayerGuid(g)) {
          em.setPose(
            g,
            wx,
            wy,
            upd.z ?? 0,
            upd.qw ?? 1,
            upd.qx ?? 0,
            upd.qy ?? 0,
            upd.qz ?? 0
          );
        }
      } else if (kind === KIND_VELOCITY) {
        // Keep velocity hints around for future extrapolation; not
        // currently consumed. A2: mutate-in-place scratch.
        _velScratch.guid = upd.guid >>> 0;
        _velScratch.vx = upd.vx ?? 0;
        _velScratch.vy = upd.vy ?? 0;
        _velScratch.vz = upd.vz ?? 0;
        _velScratch.omegaZ = upd.omegaZ ?? 0;
        em.setVelocity(_velScratch);
      } else if (kind === KIND_MOTION) {
        const motionGuid = upd.guid >>> 0;
        // DIM10/A-2 (2026-06-05): the local player's gait is client-predicted —
        // W3.1 fires setMotion on keystate (index.html ~10207). Re-dispatching
        // the server's UpdateMotion echo to the local rig FIGHTS that predictor:
        // the echoed command can differ from the prediction (server's skill-
        // derived WalkForward vs the predicted RunForward, or a stance/link
        // mismatch), so the run clip keeps crossfading and never loops cleanly
        // ("running animation interrupts"). Retail is autonomy=2 (local owns its
        // locomotion frames). Mirror the KIND_POSITION local-guid skip (:1211)
        // and the 2D path's kind=5 skip (index.html ~6305). Remote entities
        // still drive their gait from the server echo.
        const st = (upd.motionStance ?? 0) >>> 0;
        const motionCmd = (upd.motionCommand ?? 0) >>> 0;
        // SG-B (2026-06-09): the kind=5 EntityUpdate now surfaces the wire
        // `is_autonomous` bit (UpdateMotion 0xF74C). ACE marks the player's
        // own predicted gait echo `is_autonomous=true` (client-initiated)
        // and a server-FORCED motion `is_autonomous=false` (server-initiated
        // — forced sit/sleep/paralysis-hold/quest-emote via
        // `EnqueueBroadcastMotion`). The synthesised local touchdown/ledge-
        // fall kind=5 emissions carry `true` (predictor owns them).
        const isAuto = !!upd.isAutonomous;
        // FORCE_MOTION_LOCAL (B5#2 + SG-B): when ON, let a server-FORCED
        // NON-LOCOMOTION pose/action through to the local rig instead of
        // swallowing it. Three ANDed gates: (1) the flag, (2) the server
        // marked it forced (`!isAuto`) — so an autonomous non-locomotion
        // action the player triggered is still skipped (no double-play with
        // prediction), and (3) it is not a locomotion-class command
        // (Walk/Run/Stop/Ready/Turn/Sidestep/Fall) — defence-in-depth so the
        // B9 client-gait predictor is NEVER overridden even if the autonomous
        // bit is mis-set. (A genuinely server-FORCED locomotion — e.g. a
        // forced-walk emote — is intentionally still deferred to the
        // predictor by gate 3; revisit after the 1070 eye-test.) Default OFF →
        // `forceLocal` is always false → byte-identical to the old skip.
        const forceLocal =
          FORCE_MOTION_LOCAL_ON &&
          !isAuto &&
          !isLocalGaitLocomotionCmd(motionCmd);
        if (forceLocal || !isLocalPlayerGuid(motionGuid)) {
          // A1 (2026-05-29): forward the server's per-motion playback speed
          // (UpdateMotion.forward_speed) so EntityManager.setMotion scales the
          // animation framerate. Defaults to 1.0 (no scaling) when absent.
          em.setMotion(
            motionGuid,
            motionCmd,
            st,
            +(upd.motionSpeed ?? 1.0)
          );
        } else if (st !== 0) {
          // Track B9 (2026-06-08): keep skipping the server's local
          // LOCOMOTION command (the predictor owns the gait), but restore
          // the server-authoritative STANCE half of UpdateMotion 0xF74C.
          // setLocalStance re-poses ONLY the Ready/idle base layer on a
          // stance change and never disturbs the active walk/run clip.
          em.setLocalStance(motionGuid, st);
        }
        // F3-4 (bughunt 2026-06-09): sticky-attack target rides on model_id of
        // KIND_MOTION (0 = none/clear). Remote-only — the local player is never
        // sticky. While set, EntityManager.tick glues the mob to the moving
        // target so a kited melee monster tracks the player instead of freezing.
        // A2-P3 R2 (?stickyRetail=on): this arm STAYS the flag-OFF path — when
        // the wasm StickyManager owns a remote, its sticky-flagged
        // pollRemotePoses rows clear this glue per row (drainRemotePoses).
        if (!isLocalPlayerGuid(motionGuid) && typeof em.setStickyTarget === "function") {
          em.setStickyTarget(motionGuid, upd.modelId >>> 0);
        }
        // F3-5 (bughunt 2026-06-09): per-creature run rate rides on `vx` for
        // KIND_MOTION (0 = none). Remote-only — drives the velScale gait tempo
        // off the creature's own rate, not the local player's.
        if (!isLocalPlayerGuid(motionGuid) && typeof em.setEntityRunRate === "function") {
          em.setEntityRunRate(motionGuid, +(upd.vx ?? 0));
        }
        // Wave 10 Phase 10.1 (2026-05-26) — removed the
        // Fallen→setAirborne(false) coupling here. The wasm-side
        // touchdown emission now uses `kind=18
        // EntityAirborneChanged{local_guid, 0}` + `setMotion(Ready)`
        // (see lib.rs Wave 10.1 comment block in the TickMovement
        // arm), so the kind=18 recv handler at `index.html` owns
        // clearing the local arms-up overlay. The `Fallen` motion-
        // command no longer arrives from the wasm post-tick diff
        // for local-player landings — if it ever does arrive for
        // some other entity, the classifier still routes it through
        // entities.js STATIONARY (intentional, mirrors retail).
      } else if (kind === KIND_MOTION_ACTION) {
        // Wave 2 (2026-06-08) — one-shot Action-class command (creature
        // attack swing B10, local eat/drink B6, emote/gesture). The wasm
        // side already EXPANDED it to the full 32-bit MotionCommand and
        // applied the 15-bit stamp-dedup, so we just route it through
        // setMotion → classifyMotionCommand → _tryPlayLink, which plays it
        // as a LoopOnce OVERLAY on top of the active locomotion cycle.
        //
        // Unlike KIND_MOTION, this fires for EVERY guid INCLUDING the local
        // player: the command is ONLY ever an Action-class one-shot (never
        // a locomotion command), so playing it does not touch the client-
        // predicted gait — the local LOCOMOTION skip above is left intact
        // (B9 gait predictor unaffected; C1).
        const actionGuid = upd.guid >>> 0;
        const actionCmd = (upd.motionCommand ?? 0) >>> 0;
        const actionStance = (upd.motionStance ?? 0) >>> 0;
        // F6-2 — if picking.js just played this swing optimistically for
        // the local player, skip the server echo so it doesn't double-
        // play / restart the same clip ~RTT later. Remote guids and
        // non-matching commands are unaffected.
        if (actionCmd !== 0 && em.consumeLocalSwingEcho?.(actionGuid, actionCmd)) {
          // echo consumed — optimistic swing already covered it.
        } else if (actionCmd !== 0 && typeof em.setMotion === "function") {
          em.setMotion(actionGuid, actionCmd, actionStance, +(upd.motionSpeed ?? 1.0));
          // FU-3 (2026-06-11): under ?serverSwing=on the local rig has no
          // click-time swing anymore, and setMotion's MT clip doesn't
          // animate the local rig. Fire the procedural shoulder pose at
          // this (server-timed, post-MoveTo) moment for attack-class
          // commands (0x51..0x6E per the swing-classification table;
          // 0x50 FallDown excluded).
          if (SERVER_SWING_ON && isLocalPlayerGuid(actionGuid)) {
            const low = actionCmd & 0xFFFF;
            if (low >= 0x51 && low <= 0x6E) {
              try { em.setSwingPose?.(actionGuid); } catch (_) {}
            }
          }
        }
      } else if (kind === KIND_TURN) {
        // F3-3 (bughunt 2026-06-09): server TurnTo* directive — turn the rig to
        // face the absolute target heading (qw/qx/qy/qz). Remote-only; the local
        // player owns its own facing (client-predicted).
        const turnGuid = upd.guid >>> 0;
        if (!isLocalPlayerGuid(turnGuid) && typeof em.applyTurnDirective === "function") {
          // G-5 (?turnOmega=on): forward the wire MoveToParameters.speed
          // (surfaced on omega_z) so the slerp can rate-limit to retail.
          em.applyTurnDirective(turnGuid, upd.qw ?? 1, upd.qx ?? 0, upd.qy ?? 0, upd.qz ?? 0, +(upd.omegaZ ?? 0));
        }
      } else if (kind === KIND_APPEARANCE) {
        // Wave 7.3 — mid-game equip change. The wasm UpdateObject arm
        // packs only the four substitution-relevant fields; everything
        // else is zeroed. EntityManager.applyAppearance re-invokes the
        // spawn-time animation cache with the new opts.
        em.applyAppearance?.(upd.guid >>> 0, {
          modelChanges: _sliceFromScratch(upd.modelChanges, 0),
          textureChanges: _sliceFromScratch(upd.textureChanges, 1),
          subPalettes: _sliceFromScratch(upd.subPalettes, 2),
          paletteId: (upd.paletteId ?? 0) >>> 0,
          // R7 (?runtimeObjScale=on): runtime scale/translucency (sentinels
          // 0 / -1 = no change; applyAppearance gates on the flag).
          objScale: +(upd.objScale ?? 0),
          physicsTranslucency: +(upd.physicsTranslucency ?? -1),
        });
      } else if (kind === KIND_ATTACH) {
        // Render-completeness audit (2026-05-29) — wielded item equipped
        // or unequipped. model_id is the wielder guid (0 = detach back to
        // world / hide). motionCommand = holding-location key (RightHand=1,
        // …); motionStance = the child's grip placement key. EntityManager
        // parents the child rig under the wielder's part node at the
        // resolved holding-location frame.
        const childGuid = upd.guid >>> 0;
        const parentGuid = (upd.modelId ?? 0) >>> 0;
        em.attachChildToParent?.(
          childGuid,
          parentGuid,
          (upd.motionCommand ?? 0) >>> 0,
          (upd.motionStance ?? 0) >>> 0
        );
      } else if (kind === KIND_META_REFRESH) {
        // Not yet consumed — Phase 7.5 will wire portal-destination
        // updates to nameplate / chip overlays.
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[phase7.4b] entity drain dispatch:", e);
    }
    if (typeof upd.free === "function") {
      try {
        upd.free();
      } catch (_) {}
    }
  }
}

/**
 * Install a shared-drain hook on the page that the 2D drainEvents
 * forwards to. When ?renderer=3d is active AND the 2D drainEvents
 * is also running (current state per Phase 7.0–7.3), the 2D path
 * already consumes pollEntityUpdates(); this hook lets it forward
 * the full event objects (before .free()) into the 3D path.
 *
 * The 2D drainEvents already does its work; we only need it to copy
 * the relevant fields into a plain JS object and pass to the
 * EntityManager. To keep coupling minimal, this exposes a single
 * window-level callback that index.html can call inside its
 * drainEvents loop.
 *
 * Called from init3D after EntityManager is constructed.
 */
export function installSharedDrainHook(scene3d) {
  if (!scene3d?.entityManager) return;
  scene3d.useSharedDrain = true;
  // Window-level hook the 2D path can call. Phase 7.5 accepts EITHER
  // a single EntityUpdate OR an array of them — the 2D drainEvents at
  // index.html (the `window.__scene3dEntityHook?.(entityUpdates)`
  // forward in drainEvents — A15-Q4 comment-rot fix, was
  // "index.html:6021") now passes the whole `entityUpdates` array in one
  // call after pollEntityUpdates() returns, while older capture
  // scripts (capture_phase7_4_entities.cjs mode 2) still call once per
  // event. Both forms are accepted; the array form is more efficient
  // (one hook call per drain instead of N). Each event is read but
  // NOT freed — the 2D loop owns the lifetime; we just observe.
  const em = scene3d.entityManager;
  // eslint-disable-next-line no-undef
  if (typeof window !== "undefined") {
    // A15-Q3.1 (2026-06-12): the per-update dispatch body was hoisted to
    // the module-scope `dispatchEntityUpdate` (see above) so both drain
    // paths share ONE core. Resolve `entityManager` at CALL time (not
    // capture time) so a scene3d re-init can never leave the hook bound
    // to a stale manager (the same late-binding rationale as S4's
    // `getEntityManager: () => scene3d.entityManager` pattern). The local
    // name `dispatchOne` is kept so the `_prewarmFromBatch` / hook /
    // backlog blocks below are textually undisturbed.
    //
    // A15-Q4 (`?unifiedDispatch=on`, default-off): dispatchOne delegates
    // to a `createEntityDispatcher` "3d" backend table built once per
    // installSharedDrainHook call. Its handlers are the SAME `_arm*`
    // functions the flag-off `dispatchEntityUpdate` if-chain calls —
    // behavior identical by construction. The NEUTRAL table is EMPTY by
    // invariant (neutral concerns — world streaming, worldObjectManager
    // feed — run exactly once, at the index.html drain: the hook
    // receives the same array the 2D for-loop iterates). KIND
    // .META_REFRESH is deliberately ABSENT from the 3D backend (no 3D
    // consumer yet — S3 OPEN QUESTION 2); the dispatcher surfaces it as
    // a one-time accounting info. Neither route ever frees `upd`.
    const _dispatcher3d = UNIFIED_DISPATCH_ON
      ? createEntityDispatcher({
          label: "3d",
          neutral: {},
          backend: {
            [KIND.POSITION]: (upd) => _armPosition(scene3d, scene3d.entityManager, upd),
            [KIND.SPAWN]: (upd) => _armSpawn(scene3d, scene3d.entityManager, upd),
            [KIND.REMOVE]: (upd) => _armRemove(scene3d, scene3d.entityManager, upd),
            [KIND.VELOCITY]: (upd) => _armVelocity(scene3d, scene3d.entityManager, upd),
            [KIND.MOTION]: (upd) => _armMotion(scene3d, scene3d.entityManager, upd),
            [KIND.APPEARANCE]: (upd) => _armAppearance(scene3d, scene3d.entityManager, upd),
            [KIND.ATTACH]: (upd) => _armAttach(scene3d, scene3d.entityManager, upd),
            [KIND.MOTION_ACTION]: (upd) => _armMotionAction(scene3d, scene3d.entityManager, upd),
            [KIND.TURN]: (upd) => _armTurn(scene3d, scene3d.entityManager, upd),
          },
        })
      : null;
    const dispatchOne = _dispatcher3d
      ? (upd) => {
          if (!upd) return;
          _wireDiagTap(upd); // D1 — same tap as the flag-off route
          _dispatcher3d.dispatch(upd);
        }
      : (upd) => dispatchEntityUpdate(scene3d, scene3d.entityManager, upd);
    // 2026-05-28 perf: when an entity batch arrives in one tick, extract
    // every unique setupId (modelId) ahead of dispatching and fire a
    // single AnimationCache.getBatch(...) — this pre-warms the wasm-side
    // `shards` cache so each subsequent em.spawn(meta) → animationCache
    // .get(...) hits a warm fetcher instead of paying the cold-fetch
    // (mean 558ms per spawn observed in the spawn-trace data). The
    // getBatch call is fire-and-forget: the per-spawn .get(...) will
    // either await the in-flight prewarm promise or hit the now-warm
    // wasm cache. Idempotent — re-fires for already-prewarmed setupIds
    // are filtered internally.
    const _prewarmFromBatch = (arr) => {
      const batchFn = scene3d?.wasmExports?.fetchEntityAnimationKeyframesBatch;
      if (typeof batchFn !== "function") return;
      if (!em?.animationCache?.getBatch) return;
      const setupIds = new Set();
      for (let i = 0; i < arr.length; i += 1) {
        const upd = arr[i];
        if (!upd) continue;
        if ((upd.kind | 0) !== KIND_SPAWN) continue;
        const mid = (upd.modelId >>> 0);
        if (mid !== 0) setupIds.add(mid);
      }
      if (setupIds.size < 2) return; // single-spawn batch — prewarm overhead not worth it
      em.animationCache.getBatch([...setupIds], batchFn).catch(() => {});
    };

    // eslint-disable-next-line no-undef
    window.__scene3dEntityHook = function entityHook(updOrArray) {
      if (!updOrArray) return;
      // Array form (Phase 7.5 — 2D drainEvents passes the whole
      // pollEntityUpdates() array in one call). Iterate read-only;
      // the 2D loop owns the `.free()` lifetime.
      if (typeof updOrArray.length === "number" && typeof updOrArray !== "string") {
        _prewarmFromBatch(updOrArray);
        for (let i = 0; i < updOrArray.length; i += 1) {
          dispatchOne(updOrArray[i]);
        }
        return;
      }
      // Single-event form (Phase 7.4b — capture_phase7_4_entities.cjs
      // mode 2 still calls the hook once per event).
      dispatchOne(updOrArray);
    };

    // A8-M3: scene3d-owned ClientEvent dispatcher (kind=17 visibility). The
    // 2D drainEvents forwards rig-affecting ClientEvents here under
    // ?unifiedClientEvent=on; flag-off keeps the legacy index.html arm.
    // Install is UNCONDITIONAL (like __scene3dEntityHook above); in pure-2D
    // sessions installSharedDrainHook never runs, so the hook stays
    // undefined and the legacy arm runs exactly as today. `getEntityManager`
    // late-binds through scene3d.entityManager (same rationale as the
    // call-time resolution in dispatchOne, A15-Q3.1 above).
    // eslint-disable-next-line no-undef
    window.__scene3dClientEventHook = createClientEventDispatcher({
      getEntityManager: () => scene3d.entityManager,
    });

    // Workstream E (3D camera/game-feel fix): drain the pre-init3D
    // backlog now that the real dispatcher is wired. The buffering
    // stub installed at index.html module-init pushed cloned events
    // into `window.__scene3dEntityBacklog` for every drainEvents tick
    // that fired before init3D resolved. Replay those events through
    // the real dispatcher so the local player's KIND_SPAWN (emitted
    // ~+2 s post-SelectCharacter by Workstream A) builds a rig instead
    // of being silently dropped. Idempotent — splice(0) drains the
    // array; a second call (renderer hot-swap) sees an empty backlog.
    //
    // Each entry is a plain-JS clone produced by
    // `__scene3dCloneEntityUpdate`; `dispatchOne` reads the same
    // properties (kind, guid, modelId, etc.) so the clone IS the wire
    // shape from the dispatcher's perspective. `toMeta(clone)` works
    // identically on the wasm-bindgen handle and the plain-JS clone
    // because both expose the same numeric / array getters.
    //
    // Replay ordering: the backlog often contains ~80-90 NPC SPAWNs +
    // 1 local-player SPAWN intermixed. `em.spawn()` is async and
    // serialized on the wasm-bindgen single-threaded
    // fetchEntityAnimationKeyframes round-trip (≈150 ms per spawn);
    // 90 spawns = ~13 s wall-clock to complete. To make the local
    // player's rig visible quickly (so the camera follow can latch
    // onto it without a 13-s "no rig" gap), we PRIORITISE the local
    // player's SPAWN to the front of the dispatch queue. Other event
    // kinds (POSITION / MOTION / VELOCITY) for the local player also
    // float to the front so their first KIND_POSITION reconcile lands
    // immediately. The remaining NPC spawns dispatch in original
    // arrival order behind the local-player batch.
    // eslint-disable-next-line no-undef
    const backlog = window.__scene3dEntityBacklog;
    if (Array.isArray(backlog) && backlog.length > 0) {
      const queued = backlog.splice(0);
      // eslint-disable-next-line no-undef
      let localGuid = null;
      // eslint-disable-next-line no-undef
      if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
        try {
          const g = window.getLocalPlayerGuid();
          if (g !== null && g !== undefined) localGuid = g >>> 0;
        } catch (_) {}
      }
      // Partition: local-player events first (stable order within),
      // then everything else (stable order within).
      const localEvents = [];
      const otherEvents = [];
      for (const upd of queued) {
        if (localGuid !== null && (upd.guid >>> 0) === localGuid) {
          localEvents.push(upd);
        } else {
          otherEvents.push(upd);
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `[workstream-E] replaying ${queued.length} pre-init3D entity events ` +
        `(kinds=${
          (() => {
            const counts = {};
            for (const e of queued) counts[e.kind] = (counts[e.kind] || 0) + 1;
            return Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(",");
          })()
        }, localGuid=${localGuid !== null ? "0x" + localGuid.toString(16) : "null"}, ` +
        `local=${localEvents.length}, other=${otherEvents.length}) through 3D EntityManager`
      );
      // 2026-05-28 perf: prewarm the AnimationCache for every setup we're
      // about to spawn so each em.spawn() lands a warm wasm cache.
      _prewarmFromBatch(queued);
      for (const upd of localEvents) {
        dispatchOne(upd);
      }
      for (const upd of otherEvents) {
        dispatchOne(upd);
      }
    }
  }
}
