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

import { tickCellVisibility3D, tickPvsLoadExpansion } from "./cells.js";
import { tickLightingForCellState } from "./lighting.js";
import { getTerrainVisualZ, cullTerrainGroup } from "./terrain.js?v=phase-d-batch";
import { SHADOW_RECEIVE_RANGE_SQ_M as BUILDINGS_SHADOW_RANGE_SQ_M } from "./buildings.js";
import {
  SHADOW_RECEIVE_RANGE_SQ_M as STATICS_SHADOW_RANGE_SQ_M,
  cullStaticsGroup,
} from "./statics.js";
// FCULL (2026-06-08) — app-level frustum + distance render cull. loop.js
// owns the import graph: it wires the per-domain cull fns into culling.js
// (a three-only leaf module) via `setCullers`, then runs the coherent pass
// as ONE CRITICAL per-frame step (below). `tickEntityRenderVisibility`
// lives in entities.js so it can reach the EntityManager's private state.
import { tickFrustumCull, setCullers } from "./culling.js";
import { tickEntityRenderVisibility } from "./entities.js";

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

// Entity-update kind constants — mirror the wasm `ENTITY_UPDATE_KIND_*`
// constants from `crates/holtburger-session/src/lib.rs`. Listed here
// for readability of `drainEntityEvents3D`'s dispatch.
const KIND_POSITION = 0;
const KIND_SPAWN = 1;
const KIND_REMOVE = 2;
const KIND_META_REFRESH = 3;
const KIND_VELOCITY = 4;
const KIND_MOTION = 5;
const KIND_APPEARANCE = 6;
// Render-completeness audit (2026-05-29) — wielded-item attach/detach.
// Reuses EntityUpdate fields: model_id = parent (wielder) guid (0 = detach),
// motionCommand = ParentEvent.location, motionStance = ParentEvent.placement.
const KIND_ATTACH = 7;
// Wave 2 (2026-06-08) — a one-shot Action-class motion command (creature
// attack swing B10, local eat/drink B6, emote/gesture) from the UpdateMotion
// action `commands` list. motionCommand is the FULL 32-bit MotionCommand
// (already expanded in Rust); motionStance is current_style; motionSpeed is
// the per-action playback speed. Played as a LoopOnce OVERLAY via
// em.setMotion → classifyMotionCommand → _tryPlayLink for EVERY guid
// INCLUDING the local player — it never carries a locomotion command, so the
// local-gait LOCOMOTION skip in the KIND_MOTION arms stays untouched (B9).
const KIND_MOTION_ACTION = 8;

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
// `em.setMotion` IFF the command is NOT one of the predictor-owned
// locomotion/stop/ready/fall signals (see `isLocalGaitLocomotionCmd`),
// while still skipping every routine gait echo so local prediction (B9) is
// preserved. When OFF, behaviour is byte-identical to today (skip → stance
// only). Default OFF pending a 1070 GPU eye-test.
//
// WIRE-SIGNAL CAVEAT (see blocked[] in the track handoff): the current wasm
// bridge derives the kind=5 `motion_command` EXCLUSIVELY from the
// UpdateMotion `forward_command` / StopCompletely / MoveTo / airborne-edge
// paths (apps/holtburger-web/src/lib.rs ~31847, ~37079, ~37146), all of
// which are locomotion-family commands (Walk/Run/Stop/Ready/Falling/Fallen/
// MoveTo-hint). It does NOT surface the wire `is_autonomous` bit
// (movement/types.rs MotionItem.packed_sequence bit 15) nor the forced
// `commands` list (sit/sleep/state-emotes ride that Vec, drained via the
// separate KIND_MOTION_ACTION + pollMotionActions channels). So the
// command-class discriminator below is the cleanest CORRECT signal
// available from kind=5 today: it correctly lets a non-locomotion
// `forward_command` through, but a fully-general "is this server-forced"
// gate would need the wasm side to surface `is_autonomous` (or route the
// forced `commands` items to the local player). Until then a forced pose
// that arrives ONLY as a `commands` MotionItem still flows through
// KIND_MOTION_ACTION (which already runs for the local guid), not here.
const FORCE_MOTION_LOCAL_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("forceMotionLocal")?.toLowerCase() === "on"
    );
  } catch (_) {
    return false;
  }
})();

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

// A2 (perf plan 2026-05-18) — module-scratch object passed to
// `em.setVelocity` so we don't allocate a fresh `{guid,vx,vy,vz,omegaZ}`
// on every KIND_VELOCITY event. `setVelocity` copies the fields into
// `inst.lastVel` synchronously and does not retain a reference, so a
// single shared scratch is safe across both drain paths.
const _velScratch = { guid: 0, vx: 0, vy: 0, vz: 0, omegaZ: 0 };

// Multi-action motion queue (2026-06-06, approach B) — `?multiAction=on` (default
// OFF) FIFO-plays the Action-class `commands` list (emotes / gestures) that the
// single motion_command path drops, drained from the wasm `pollMotionActions`
// side-channel. Default OFF: needs a 1070 eye-test + a reachability confirmation
// (the wasm side logs `commands.len() > 1`). NOTE: cosmetic actions, NOT the
// strafe-cast / cast-break tech (those are SubState ForwardCommand + the sidestep
// axis — a separate gap).
const MULTI_ACTION_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("multiAction")?.toLowerCase() === "on"
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

// Drain the wasm multi-action side-channel (`pollMotionActions`, flat 4-u32
// groups: [guid, command_low, packed_sequence, stance]) and FIFO-play each NEW
// action per entity. No-op unless `?multiAction=on`. Plays via `em.setMotion`
// (same path the single motion_command uses) — Action-class commands resolve to
// their one-shot clip; unresolved ones no-op harmlessly. Local guid is skipped.
function drainMotionActions(scene3d, sessionHandle) {
  if (!MULTI_ACTION_ON) return;
  if (!sessionHandle || typeof sessionHandle.pollMotionActions !== "function") return;
  let flat;
  try {
    flat = sessionHandle.pollMotionActions();
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

// Casting-ingredient axes (2026-06-06) — `?castAxes=on` (default OFF) surfaces
// the remote sidestep + turn axes the single forward_command path drops, so a
// remote strafe-casting shows footwork and a remote turning in place shows the
// turn cycle. These are the retail casting *ingredients* (acclient
// get_state_velocity uses all three axes); built so a retail-faithful cast
// sequence renders fully, NOT forcing anything. Default OFF (needs a 1070
// eye-test). Drains the wasm `pollMotionAxes` side-channel.
const CAST_AXES_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("castAxes")?.toLowerCase() === "on"
    );
  } catch (_) {
    return false;
  }
})();

function drainMotionAxes(scene3d, sessionHandle) {
  if (!CAST_AXES_ON) return;
  if (!sessionHandle || typeof sessionHandle.pollMotionAxes !== "function") return;
  let flat;
  try {
    flat = sessionHandle.pollMotionAxes();
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
// fix (`index.html:4191-4214`) explicitly skips syncing the local
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
  // Visual-vs-collision Z reconcile. `posZ` is the wasm integrator's
  // bilinear standing-Z (matches what ACE physics agrees on); the
  // rendered terrain mesh interpolates with Catmull-Rom and can sit up
  // to VISUAL_VS_COLLISION_MAX_M (0.3 m) above bilinear on peaks. That
  // delta was rendering the player's feet inside the ground. Raycast
  // the rendered terrain at the player's XY and use the visual Z if
  // the cast hits — physics/server pose stays untouched (see
  // `getTerrainVisualZ` doc in terrain.js).
  //
  // Track B2 (2026-06-08): only clamp to the terrain mesh while
  // grounded. Mid-jump the integrator's ballistic `posZ` IS the rig's
  // altitude — clamping it to `getTerrainVisualZ` every frame flattened
  // the gravity arc so the rig never left the ground (only the camera,
  // which reads raw integrator Z, flew up). When airborne, render at the
  // raw `posZ` so the arc reaches the rig.
  let renderZ = isOnGround
    ? getTerrainVisualZ(scene3d, predicted.x, predicted.y, posZ)
    : posZ;

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
  for (const mat of scene3d.terrainMaterials) {
    if (mat?.uniforms?.uTime) {
      mat.uniforms.uTime.value = tSec;
    }
  }
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
  for (const mat of scene3d.terrainMaterials) {
    const v = mat?.uniforms?.uSunDir?.value;
    if (v && typeof v.set === "function") {
      v.set(sx, sy, sz);
    }
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

    const scan = profile?._weather ?? null;
    // W5 indoor flag — reuse the skyDome's freshly-read indoor state when
    // present (it reads isCurrentCellIndoor() each tick); fall back to a
    // direct read so the manager still gates when the dome is absent.
    let indoor = scene3d?.skyDome?._lastIsIndoor;
    if (typeof indoor !== "boolean" && handle &&
        typeof handle.isCurrentCellIndoor === "function") {
      try { indoor = !!handle.isCurrentCellIndoor(); } catch (_) { indoor = false; }
    }
    if (typeof indoor !== "boolean") indoor = false;

    // W2/W5 — push environment to the weather manager (precip type + gate).
    if (scene3d?.weatherEffects?.setEnvironment) {
      scene3d.weatherEffects.setEnvironment({
        indoor,
        streakGfxId: scan?.streak_gfx_id ?? 0,
        hasDroplets: scan?.has_droplets ?? false,
      });
    }

    // W1 — drive the parametric sky-dome weather billboard host with the
    // same snapshot array (the host gates itself on its `?skyWeather`
    // flag + the props/window bits, and no-ops indoors).
    if (scene3d?.skyDome?.updateWeatherSkyObjects) {
      scene3d.skyDome.updateWeatherSkyObjects(skyObjects, indoor);
    }
  } catch (_) {
    // Weather wiring must never kill the frame.
  }
}

// === Wave R1.C — fog color lerp (2026-05-28) ===
//
// Parse `?fogLerp=on` from the page URL. Returns true only for the
// literal value "on" (case-insensitive); missing/any other value is
// false. Mirrors `terrain.js::readTerrainModulationFlag` exactly,
// including the try/catch so the non-browser Node harness (which has
// no `window`) doesn't throw. Cached once because the URL can't change
// without a reload.
let _fogLerpFlagCache;
function readFogLerpFlag() {
  if (_fogLerpFlagCache !== undefined) return _fogLerpFlagCache;
  try {
    if (typeof window === "undefined" || !window.location) {
      _fogLerpFlagCache = false;
      return false;
    }
    const v = new URLSearchParams(window.location.search).get("fogLerp");
    _fogLerpFlagCache = typeof v === "string" && v.toLowerCase() === "on";
  } catch (_) {
    _fogLerpFlagCache = false;
  }
  return _fogLerpFlagCache;
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
  const fog = scene3d?.scene?.fog;
  if (!fog || !fog.color || typeof fog.color.setHex !== "function") return;
  const state = scene3d.skyLightingController?._lastState ?? null;
  if (!state) return;
  const useLerp = readFogLerpFlag();
  const argb = useLerp
    ? (state.fogColorArgbLerp >>> 0)
    : (state.fogColorArgb >>> 0);
  if (!Number.isFinite(argb)) return;
  const rgb = argb & 0xffffff;
  fog.color.setHex(rgb);
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
      fog.near = fogMin;
      fog.far = fogMax;
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

  // ── CRITICAL #1 — cell visibility (gates the whole scene). ───────────
  tickCellVisibility3D(scene3d, sessionHandle);
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
  // expansion (paired with STATICS_RING_RADIUS=2 and BUILDINGS_RING_RADIUS=2
  // boot rings in index.js). Reads the wasm renderSet and triggers
  // `loadStaticsForLandblock` + `loadBuildingsForLandblock` for any LB the
  // player can see but hasn't entered yet. Both hooks are idempotent + cheap,
  // so RP3 throttles the per-frame renderSet scan + ring expand to ~10 Hz:
  // the loads themselves are still async, this just stops re-walking the
  // renderSet 60×/s when nothing has moved. Force-runs on staleness so a
  // budget-starved frame can never stall scenery prefetch indefinitely.
  if (!_rp3 || _rp3ShouldRun(_rp3, RP3_G_PVS, _rp3TsSec, _rp3NowMs())) {
    tickPvsLoadExpansion(scene3d, sessionHandle);
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
  }
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
    motionCommand: (upd.motionCommand ?? 0) >>> 0,
    motionStance: (upd.motionStance ?? 0) >>> 0,
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
  };
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
 * Currently always direct-drains. The 2D-coexistence story is a
 * Phase 7.5 wiring concern — when that lands, the 2D drainEvents
 * will gate its `pollEntityUpdates()` call on `!useRenderer3d` and
 * 3D will get the full stream uncontested.
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
      } else if (kind === KIND_REMOVE) {
        // A4 (2026-05-18): prune __lastEntityWorldPos on despawn to bound Map growth.
        const g = upd.guid >>> 0;
        em.remove(g);
        if (window.__lastEntityWorldPos) window.__lastEntityWorldPos.delete(g);
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
        // FORCE_MOTION_LOCAL (B5#2): when ON, let a server-FORCED
        // NON-LOCOMOTION pose/action through to the local rig instead of
        // swallowing it. A locomotion-class command (Walk/Run/Stop/Ready/
        // Turn/Sidestep/Fall) is still skipped so the B9 client-gait
        // predictor is never overridden (see flag header). Default OFF →
        // `forceLocal` is always false → byte-identical to the old skip.
        const forceLocal =
          FORCE_MOTION_LOCAL_ON && !isLocalGaitLocomotionCmd(motionCmd);
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
        if (actionCmd !== 0 && typeof em.setMotion === "function") {
          em.setMotion(actionGuid, actionCmd, actionStance, +(upd.motionSpeed ?? 1.0));
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
  // index.html:6021 now passes the whole `entityUpdates` array in one
  // call after pollEntityUpdates() returns, while older capture
  // scripts (capture_phase7_4_entities.cjs mode 2) still call once per
  // event. Both forms are accepted; the array form is more efficient
  // (one hook call per drain instead of N). Each event is read but
  // NOT freed — the 2D loop owns the lifetime; we just observe.
  const em = scene3d.entityManager;
  // eslint-disable-next-line no-undef
  if (typeof window !== "undefined") {
    function dispatchOne(upd) {
      if (!upd) return;
      try {
        const kind = upd.kind | 0;
        if (kind === KIND_SPAWN) {
          em.spawn(toMeta(upd));
        } else if (kind === KIND_REMOVE) {
          // A4 (2026-05-18): prune __lastEntityWorldPos on despawn to bound Map growth.
          const g = upd.guid >>> 0;
          em.remove(g);
          if (window.__lastEntityWorldPos) window.__lastEntityWorldPos.delete(g);
        } else if (kind === KIND_POSITION) {
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
            // Visual-vs-collision Z reconcile (same rationale as the
            // local-player path in applyLocalPlayerPoseFromIntegrator):
            // server sends bilinear-collision Z; Catmull-Rom render
            // surface deviates by up to 0.3 m. Raycast lifts the
            // remote rig to the visible terrain so other players don't
            // appear partially buried. Returns wz unchanged when the
            // ray misses (indoor envcells, unloaded LBs, etc.) so
            // non-terrain placements stay server-authoritative.
            const renderWz = getTerrainVisualZ(scene3d, wx, wy, wz);
            em.setPose(
              g,
              wx, wy, renderWz,
              upd.qw ?? 1, upd.qx ?? 0, upd.qy ?? 0, upd.qz ?? 0
            );
          }
        } else if (kind === KIND_VELOCITY) {
          // A2: mutate-in-place scratch (same as the older drain path).
          _velScratch.guid = upd.guid >>> 0;
          _velScratch.vx = upd.vx ?? 0;
          _velScratch.vy = upd.vy ?? 0;
          _velScratch.vz = upd.vz ?? 0;
          _velScratch.omegaZ = upd.omegaZ ?? 0;
          em.setVelocity(_velScratch);
        } else if (kind === KIND_MOTION) {
          const motionGuid = upd.guid >>> 0;
          // DIM10/A-2 (2026-06-05): skip the local player — its gait is
          // client-predicted (W3.1, index.html ~10207); re-dispatching the
          // server echo fights the predictor and breaks the run loop. See the
          // matching block above (~:1232) for the full rationale.
          const st = (upd.motionStance ?? 0) >>> 0;
          const motionCmd = (upd.motionCommand ?? 0) >>> 0;
          // FORCE_MOTION_LOCAL (B5#2): mirror the direct-drain arm above —
          // when ON, a server-FORCED NON-LOCOMOTION pose/action passes
          // through to the local rig; a locomotion-class echo is still
          // skipped to preserve the B9 client-gait predictor. Default OFF →
          // byte-identical to the prior unconditional skip.
          const forceLocal =
            FORCE_MOTION_LOCAL_ON && !isLocalGaitLocomotionCmd(motionCmd);
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
            // restore the server-authoritative STANCE (see matching block
            // above ~:1619). setLocalStance touches only the Ready/idle base
            // pose and never the predictor-owned walk/run clip.
            em.setLocalStance(motionGuid, st);
          }
          // Wave 10 Phase 10.1 (2026-05-26) — removed the
          // Fallen→setAirborne(false) coupling here. See the matching
          // comment in the direct-drain path above; the local arms-up
          // overlay now clears via `kind=18` recv-side dispatch
          // (lib.rs Wave 10.1 + index.html kind=18 handler).
        } else if (kind === KIND_MOTION_ACTION) {
          // Wave 2 (2026-06-08) — one-shot Action-class command overlay.
          // Mirrors the direct-drain arm above: setMotion plays it as a
          // LoopOnce overlay for EVERY guid INCLUDING the local player
          // (the command is never a locomotion command, so the local gait
          // predictor / B9 LOCOMOTION skip is left intact; C1). The wasm
          // side already expanded the full 32-bit command and stamp-deduped.
          const actionGuid = upd.guid >>> 0;
          const actionCmd = (upd.motionCommand ?? 0) >>> 0;
          const actionStance = (upd.motionStance ?? 0) >>> 0;
          if (actionCmd !== 0 && typeof em.setMotion === "function") {
            em.setMotion(actionGuid, actionCmd, actionStance, +(upd.motionSpeed ?? 1.0));
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[phase7.4b] shared-drain hook dispatch:", e);
      }
    }
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
