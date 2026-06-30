// Phase 7.5 — camera controllers: follow / orbit / top-down.
//
// Three controllers hot-swappable on `C` keypress:
//
//   - follow: PerspectiveCamera behind the player, mouse-look via
//     PointerLockControls (click canvas to grab pointer, Esc to
//     release). WASD intent is camera-relative — we project the
//     (forwardInput, strafeInput) vector through followYaw into
//     world XY axes, sign-clamp to -1/0/+1, and pass to
//     `sessionHandle.setMovementInput(forward, strafe, turn, run)`.
//   - orbit: OrbitControls (mouse drag rotates around player target,
//     wheel zooms, right-drag pans). WASD does NOT drive movement in
//     orbit mode — orbit is for free look / inspection.
//   - topDown: OrthographicCamera looking straight down at the
//     player. WASD drives WORLD-FIXED movement (W = north regardless
//     of orbit angle, since the ortho view is unrotated). Wheel
//     zooms via `camera.zoom`.
//
// Coordinate-system note: callers pass `getPlayerWorldPos()` that
// returns AC-world coordinates `{x, y, z}` (x east, y north, z up).
// The scene3d worldRoot already carries the AC-Z-up → three-Y-up
// rotation, so camera positions set here are ALSO in AC coords; the
// scene's worldRoot rotation handles the visual mapping.
//
// Camera-relative WASD → world conversion math (the load-bearing bit
// for Phase 7.5):
//
//   inputForward = (W ? 1 : 0) - (S ? 1 : 0)   // intent forward
//   inputStrafe  = (D ? 1 : 0) - (A ? 1 : 0)   // intent right
//
//   At followYaw = 0, the camera looks toward AC +Y (north). So
//   pressing W with yaw=0 should produce setMovementInput(+1, 0, ...).
//
//   At followYaw = π/2, the camera looks toward AC +X (east). So
//   pressing W with yaw=π/2 should produce setMovementInput(0, +1, ...).
//
//   Rotation matrix for "camera-frame intent → world-axis direction":
//     worldDx = inputForward * sin(yaw) + inputStrafe * cos(yaw)
//     worldDy = inputForward * cos(yaw) - inputStrafe * sin(yaw)
//
//   Sign-clamp each to -1/0/+1 so the wasm API contract (i8 in [-1,1])
//   is honoured. Diagonal WASD (e.g. W+D) → both world axes nonzero
//   simultaneously; we do NOT normalize the vector — the wasm side
//   treats forward/strafe as direction units, not magnitudes.
//
//   forward = clampSign(worldDy)
//   strafe  = clampSign(worldDx)
//
// **Sit-with-it note:** ACE's MovementSystem currently interprets
// (forward, strafe) in the player's LOCAL frame (not world frame).
// The 2D path's pattern: Q/E turns the player and WASD goes in the
// player's current heading direction. So strict camera-relative
// motion in 3D mode would need EITHER turn-to-align logic (snap
// player heading to follow yaw on WASD press) OR a wasm-side
// world-fixed variant of SetMovementInput. The Phase 7.5 spec asks
// us to produce the camera-relative (world-axis) form anyway — that
// becomes correct as soon as the player heading matches the camera
// yaw (turn-to-align is a Phase 7.5 follow-on listed in the report).
// At yaw=0 (camera facing north and player facing north), the result
// is identical to the 2D path; live validation against tailnet1
// confirms the math doesn't BREAK the existing flow.
//
// Follow-on #2 (2026-05-10): turn-to-align landed. When the user
// holds WASD in follow mode, `computeMovementFromKeys` emits a
// `turn = sign(followYaw - playerHeading)` delta so ACE's
// MovementSystem rotates the player heading toward the camera yaw
// at `RUN_HELD_TURN_SPEED_RAD_PER_SEC = 1.5 rad/s`. Once
// `|headingError| < TURN_DEAD_ZONE` the auto-turn releases and Q/E
// manual turn takes precedence again. Combined with the existing
// camera-relative (forward, strafe) math, the player visually walks
// in the camera-facing direction even before the heading has aligned:
// the wasm-side (forward, strafe) is rotated by `followYaw` AND by
// `-playerHeading` (so the local-frame motion ACE consumes is in the
// camera direction regardless of where the player currently faces),
// and the new `turn` delta closes the heading gap. Convergence time
// is bounded by `|headingError| / 1.5 s` — a 90° pan settles in ≈1 s,
// a 180° turn in ≈2 s.
//
// **Workstream D restore (2026-05-11).** The 2026-05-11 debug session
// reverted this math to raw player-local-frame WASD because
// `getLocalPlayerHeading()` always returned 0 (the wasm eager-WorldState
// path swallowed the local-player KIND_SPAWN, so the 3D rig was never
// built and the quaternion-derived heading collapsed to the identity).
// Every WASD axis flipped after a teleport. Workstream A's new
// `__sessionHandle.getLocalPlayerPose().heading` export lands the
// authoritative integrator heading directly — no need for the 3D rig
// to build. With that wired as the primary heading source (and the
// quaternion-based callback as fallback for the pre-spawn / unit-test
// path), the math below works correctly.
//
// Heading-source priority in `computeMovementFromKeys`:
//   1. `__sessionHandle.getLocalPlayerPose().heading` — authoritative
//      integrator heading, available post-Workstream-A. Same convention
//      as `followYaw` (CW from +Y north).
//   2. `this.getPlayerHeading()` — the 3D rig's quaternion-derived yaw,
//      available once Workstream E builds the local-player rig (today
//      unreliable on the eager-WorldState path).
//   3. `0` (north). Pre-spawn the auto-turn delta is sign-clamped on a
//      heading error that may be large; the wasm side drops
//      SetMovementInput pre-EnteredWorld anyway, so the early auto-turn
//      doesn't reach ACE.
//
// World-frame intent → player-local-frame rotation (the load-bearing
// bit for the camera-relative feel):
//   Given world-frame intent (worldDx along +X east, worldDy along +Y
//   north) and player heading h (CW from +Y north), the player's local
//   forward (+Y in local frame) points world-(sin h, cos h) and local
//   right (+X in local frame) points world-(cos h, -sin h). The
//   inverse rotation (world → local) is:
//     localF = worldDx * sin(h) + worldDy * cos(h)
//     localS = worldDx * cos(h) - worldDy * sin(h)
//
// Sanity check: at h=0 (north) and yaw=0, W → (worldDx=0, worldDy=1)
//   → (localF=1, localS=0). ACE walks forward in local frame.
//   At h=0 and yaw=π/2 (camera east), W → (worldDx=1, worldDy=0)
//   → (localF=0, localS=1). ACE strafes right in local frame, which
//   in world coords is east — exactly camera-forward. ✓
//   At h=π/2 (player east) and yaw=π/2 (camera east, aligned), W →
//   (worldDx=1, worldDy=0). Local rotate: localF = 1*1 + 0*0 = 1,
//   localS = 1*0 - 0*1 = 0. ACE walks forward in local frame, which
//   is east in world coords. ✓
//
// Precedence rule (manual Q/E overrides auto-turn): if Q or E is held,
// `turn = sign(qeTurn)` directly — the auto-turn is suppressed for the
// duration of the manual press. This matches the user expectation that
// pressing Q/E means "I want to manually steer right now", not "I want
// my manual steer to fight the auto-turn". Inside the dead zone the
// auto-turn is 0 and Q/E is the only contributor anyway.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { acToThree } from "./adapter.js";
import {
  getInputController,
  readInputFunnelFlag,
  // A14-I3 (?retailRunKeys=on) — the single run-modifier resolution
  // (Shift XOR persisted ToggleRun option, retail SetHoldRun
  // acclient.c:716978). Flag-off returns the legacy `!shift`.
  resolveRunModifier,
} from "./input.js";
// A12-C2/C3 (2026-06-12): retail camera math (zoom continuum / in-head /
// near-fade / stiffness / mouse filter). Pure module, headless-tested by
// tests/camera_retail_math.test.cjs. Only consulted behind the default-off
// flags read in the constructor below.
import {
  retailZoomStep,
  nearFadeOpacity,
  stiffnessFrac,
  filterMouseDelta,
  clampInHeadDirZ,
  IN_HEAD_FORWARD_M,
  CAMERA_DEFAULT_PIVOT_Z,
  STIFFNESS_SNAP_DIST_M,
  STIFFNESS_TELEPORT_SNAP_M,
} from "./camera_math.js";

/**
 * Mode-cycle order on `C` press: follow → topDown → orbit → follow.
 *
 * topDown is the de-facto minimap (camera looks straight down at the
 * player), so the user gets it on the FIRST tap of `C` from the
 * default follow mode. orbit is the rarely-used inspection mode and
 * sits at the back of the cycle.
 */
export const CAMERA_MODES = ["follow", "topDown", "orbit"];

/** Pitch clamp (radians) for follow camera. 0 = level horizon; +π/2 = straight down. */
// Phase 3 (Cohere-D follow-on, 2026-05-12): widened pitch range so the
// camera can angle upward. The prior `FOLLOW_PITCH_MIN = 0.1`
// (≈ 5.7°) clamped the camera to always be above the player's eye —
// user couldn't see sky or building tops. `-0.5` (≈ -29°) lets the
// camera drop below the player; the new lookAt-with-pitch offset in
// `positionCamera` redirects the view upward at the same time so the
// user actually sees the sky.
const FOLLOW_PITCH_MIN = -0.5;
const FOLLOW_PITCH_MAX = 1.4;
// LookAt distance for the camera-direction pitch offset (see
// `positionCamera` follow branch). Controls how far in front of the
// player the lookAt target sits at pitch=0, and how steeply it lifts
// or drops with mouse-pitch. 4 m matches `followDistance` so the
// view direction is parallel to the camera-position offset at most
// pitches.
const LOOK_LIFT_DIST_M = 4.0;

/** Mouse-look sensitivity (radians per pixel) for follow PointerLock. */
const POINTER_YAW_SENS = 0.0025;
const POINTER_PITCH_SENS = 0.0020;

/** Top-down ortho view: metres visible vertically at zoom=1. */
const TOPDOWN_FRUSTUM_HEIGHT_M = 100.0;
const TOPDOWN_HEIGHT_M = 300.0;
const TOPDOWN_ZOOM_MIN = 0.2;
const TOPDOWN_ZOOM_MAX = 8.0;

/**
 * Pure-smoothing reconcile: hard-snap the predicted pose to the integrator
 * when they diverge by more than this (metres) within a single landblock —
 * a server force-position rubberband. Matches the legacy `> 5 m` reconcile
 * snap so a large correction teleports instead of oozing over ~tau ms.
 */
const PRED_SMOOTH_SNAP_DIST_M = 5.0;

/** Round a real to its sign-clamped int8. */
function clampSign(v) {
  if (v > 1e-3) return 1;
  if (v < -1e-3) return -1;
  return 0;
}

/**
 * Follow-on #2 (2026-05-10) — wrap an angle (radians) to `[-π, π]`.
 * Used by the turn-to-align math so a heading error that crosses the
 * +π/-π discontinuity (e.g. player at +π facing south, camera at -π+ε
 * also facing south but stored on the other side of the wrap) takes
 * the short way around rather than the long way.
 */
function wrapAngle(rad) {
  let r = rad;
  // Reduce to [-π, π] via the standard `atan2(sin, cos)` trick — no
  // loop, no NaN propagation for finite inputs.
  r = Math.atan2(Math.sin(r), Math.cos(r));
  return r;
}

/**
 * Follow-on #2 — heading-error dead zone (radians). When the player's
 * yaw is within this band of `followYaw`, the auto-turn releases and
 * Q/E manual turn takes precedence. 0.05 rad ≈ 2.9°, smaller than the
 * one-tick `turn_speed * dt` increment ACE applies (≈3.5 rad/s · 50 ms
 * = 0.175 rad/tick), so the player won't oscillate across the dead
 * zone on a single tick — the system settles with one or two ticks
 * of overshoot at most.
 */
const TURN_DEAD_ZONE = 0.05;

/**
 * Build an OrthographicCamera framed for the top-down view. The
 * frustum height is fixed at construction time; `camera.zoom` is the
 * runtime knob. Aspect re-derives from the canvas at construction +
 * on resize.
 */
export function createOrthoCamera(canvas) {
  const w = canvas.clientWidth || canvas.width || 1280;
  const h = canvas.clientHeight || canvas.height || 720;
  const aspect = w / h;
  const halfH = TOPDOWN_FRUSTUM_HEIGHT_M / 2;
  const halfW = halfH * aspect;
  const cam = new THREE.OrthographicCamera(
    -halfW, halfW, halfH, -halfH, 0.1, 5000
  );
  cam.zoom = 1.0;
  cam.updateProjectionMatrix();
  // Phase 5 PView render-order fix (2026-05-25) — mirror the main camera's
  // layer mask. cellsGroup + entitiesGroup live on layer 1 (RENDER_LAYER_INDOOR)
  // so the renderer can interleave a depth-clear between terrain and EnvCells
  // when the camera is inside a building. Topdown camera defaults to layer 0
  // (terrain only) which would hide all NPCs + cottage interiors — enable
  // layer 1 so the topdown view stays complete.
  cam.layers.enable(1);
  return cam;
}

/**
 * Three-mode camera switcher with input-to-movement plumbing.
 *
 * Constructed once per init3D. Owns the keyState (WASD/QE/shift), the
 * follow-mode mouse-look state (followYaw, followPitch), the active
 * controller instance (PointerLockControls or OrbitControls), and the
 * `C` key listener that cycles modes.
 *
 * Each per-rAF `tick(dt)`:
 *   1. Reads current player world pos from `getPlayerWorldPos`.
 *   2. Positions the active camera according to the current mode.
 *   3. Computes (forward, strafe, turn, run) from keystate +
 *      followYaw and calls `sessionHandle.setMovementInput(...)` if
 *      the signature changed.
 *
 * `activeCamera` is the camera the render loop should draw with.
 * Updated on `switchMode`; the render loop reads it through
 * `liveScene3d.cameraSwitcher.activeCamera`.
 */
export class CameraSwitcher {
  /**
   * @param {object} args
   * @param {object} args.scene3d - liveScene3d (we read entityManager etc.)
   * @param {THREE.PerspectiveCamera} args.perspectiveCamera
   * @param {THREE.OrthographicCamera} args.orthoCamera
   * @param {HTMLElement} args.domElement - typically the WebGL canvas
   * @param {object} args.sessionHandle - SessionHandle or mock
   * @param {Function} args.getPlayerWorldPos - () => {x, y, z}
   * @param {Function} [args.getPlayerHeading] - () => radians in
   *   followYaw convention (CW from +Y north). Optional; if missing,
   *   the turn-to-align math collapses to "use 0" — i.e. the auto-turn
   *   tries to rotate the player to face the camera even pre-spawn,
   *   which is harmless because ACE drops SetMovementInput before
   *   EnteredWorld anyway. The 3D path's `index.js` wires this to
   *   `entityManager.getLocalPlayerHeading()` so live sessions always
   *   pass the real value.
   */
  constructor({
    scene3d,
    perspectiveCamera,
    orthoCamera,
    domElement,
    sessionHandle,
    getPlayerWorldPos,
    getPlayerHeading,
  }) {
    this.scene3d = scene3d;
    this.persp = perspectiveCamera;
    this.ortho = orthoCamera;
    this.domElement = domElement;
    // Accept either an object (legacy contract) or a function (lazy
    // resolver). The 3D feature-flag block in index.html calls init3D
    // BEFORE the login form completes, so `window.__sessionHandle` is
    // `undefined` at the moment cameraSwitcher is constructed. Capturing
    // it directly would freeze the null forever; instead we read it
    // each tick. Backwards-compatible with the synthetic tests (which
    // pass a mock SessionHandle object).
    this._getSessionHandle =
      typeof sessionHandle === "function"
        ? sessionHandle
        : () => sessionHandle;
    // Keep the legacy field so existing reads (none today, but defensive)
    // still see something — but use the resolver in _dispatchMovement.
    Object.defineProperty(this, "sessionHandle", {
      get: () => this._getSessionHandle(),
      configurable: true,
    });
    this.getPlayerWorldPos = getPlayerWorldPos;
    this.getPlayerHeading = getPlayerHeading;

    // Mode state.
    this.mode = "follow";
    this.activeCamera = perspectiveCamera; // updated by switchMode

    // Follow-camera state. Yaw=0 → camera looking toward AC +Y
    // (north), matching player heading=0 convention. Pitch is the
    // tilt down from horizon (positive looks down).
    this.followYaw = 0.0;
    this.followPitch = 0.3;
    this.followDistance = 6.0; // metres behind player

    // Per-mode controller (PointerLock for follow, Orbit for orbit,
    // null for topDown). Constructed lazily in `switchMode` to avoid
    // grabbing the pointer or mouse drag on the page before the
    // first switchMode call.
    this.controls = null;

    // Keystate. Bound by `_installKeyListeners` to WASD/QE/Shift +
    // the `C` mode-cycle key. Mirrors the 2D path's keyState shape
    // (`index.html:5473`) so existing code paths can be carried over.
    this.keys = {
      w: false, a: false, s: false, d: false,
      q: false, e: false, shift: false,
    };

    // Last input signature sent to setMovementInput (so we only fire
    // on change, matching the 2D path's pattern at index.html:6219).
    this.lastInputSig = "0,0,0,false";
    this.setMovementInputCount = 0;
    // Issue 6 (2026-06-03): dedicated sig for the LOCAL player rig's locomotion
    // dispatch, gated independently of lastInputSig (which only advances on
    // setMovementInput success). null forces the first dispatch to fire.
    this.lastRigMotionSig = null;
    // Issue 5 (2026-06-03): one-shot latch so entering orbit dispatches Ready to
    // the rig exactly once (not every frame) instead of freezing on the last clip.
    this._orbitRigStopped = false;

    // Workstream B (2026-05-11) — client-side prediction state for the
    // 3D follow camera. ACE-side simulation runs at the integrator's
    // tick rate (60+ Hz); wasm fans out `KIND_POSITION` at <= 30 Hz
    // (Workstream A); the network/proxy adds jitter. Without prediction
    // the camera lerps in discrete server steps and the viewport feels
    // ratchety even on a clean ACE.
    //
    // Mirrors the 2D path's prediction block at `index.html:6144-6207`.
    // While WASD is held in follow mode, `tick(dt)` advances
    // `predictedPlayerPos` along the heading vector from
    // `__sessionHandle.getLocalPlayerPose().heading` at
    // run/walk/strafe/backstep speeds copied from `index.html` via
    // `window.__movementConstants`. When a fresh `__lastEntityWorldPos`
    // entry lands (detected via the `ts` field added in
    // `loop.js:dispatchOne`), the predicted pose snap-or-lerps toward
    // the authoritative server pose so drift never accumulates.
    //
    // `lastReconcileTs` is the `__lastEntityWorldPos.get(guid).ts` value
    // we last reconciled against — incoming updates with a strictly
    // greater `ts` are "new" and reset the lerp.
    //
    // `lerpTargetX/Y/Z` + `lerpDurationMs` carry the in-flight lerp
    // toward server pose. While `lerpRemainingMs > 0`, the prediction
    // is a blend `predictedPos -> lerpTarget` over `lerpDurationMs`.
    // Snap-mode (large delta) sets `lerpRemainingMs = 0` and writes
    // the pose directly.
    //
    // `lastTickMs` is the wall-clock `performance.now()` from the
    // previous `tick(dt)`; we use it both to gate "no rAF since last
    // tick" (prevents predictedPos from jumping when a hidden tab
    // resumes) and to advance the in-flight lerp.
    //
    // Initially null until the first authoritative pose arrives — the
    // prediction layer falls through to the existing three-tier
    // fallback in `getLocalPlayerWorldPos` until then.
    //
    // Debug ring buffer (`_predictionTrace`) captures the last 256
    // samples for post-hoc analysis; toggled by setting
    // `window.__predTrace3d = true` in the console. Off by default
    // (the per-rAF push is cheap but the GC pressure adds up over a
    // long session).
    this.predictedPlayerPos = null; // { x, y, z, lastReconcileTs }
    this._lerpTargetX = 0.0;
    this._lerpTargetY = 0.0;
    this._lerpTargetZ = 0.0;
    this._lerpRemainingMs = 0.0;
    this._lerpDurationMs = 150.0; // middle of the 100-300 ms band from
    // the spec; tuned by eye-test if drift is visible.
    this._predLastTickMs = null;

    // Local-rig pose source: the wasm integrator's collided pose, mirrored
    // by `_smoothToIntegrator` (a direct-assign since the 2026-06-05 FULL
    // COLLAPSE). The wasm runtime body is the single retail-faithful
    // CPhysicsObj-equivalent — it predicts locally AND reconciles against
    // the server — so the JS layer must NOT advance or re-smooth on top.
    //
    // RETIRED (2026-06-29): the legacy Workstream-B JS predictor
    // (`_reconcilePrediction`/`_advancePrediction`/`_applyPredictionLerp`,
    // formerly reachable via `window.__predPureSmooth === false`) was a
    // SECOND forward integrator that marched rendered X/Y at a flat 4.5 m/s
    // with no collision, fighting the wasm body — the dual-predictor
    // sawtooth / snap-back. It is no longer wired into `tick()`. The
    // `_predLastTickMs` / `_lerp*` fields above remain only because the
    // retired methods (kept for the historical `.mjs` A/B harnesses) read
    // them; nothing in the runtime path does.
    // Last integrator landblockId seen by `_smoothToIntegrator`. A
    // change between frames means a teleport / LB transition (world
    // coords jump by a multiple of 192 m), so we hard-snap instead of
    // easing. `null` until the first authoritative pose. The exponential
    // ease itself reuses `_lerpDurationMs` (150 ms) as its time-constant
    // so the perceived smoothness matches the legacy reconcile lerp.
    this._predPrevLandblockId = null;
    this._predictionWarned = false;
    this._predictionTrace = [];
    this._predictionTraceCapacity = 256;

    // Listeners registered for cleanup in `dispose()`.
    //
    // C1 split (2026-06-07): `_listeners` holds ONLY the per-mode DOM
    // listeners that `switchMode()` tears down on each mode change (the
    // 4 follow-mode mouse handlers). The page-global input listeners
    // (blur/keydown/keyup/wheel/C) live in `_globalListeners` and are
    // installed ONCE in the constructor — they must survive switchMode's
    // cleanup, otherwise the very first `switchMode("follow")` call from
    // the constructor wipes the WASD/mode-cycle handlers it just added.
    this._listeners = [];
    this._globalListeners = [];

    // A12-C2/C3 (2026-06-12) — retail camera flags, all default-OFF. Read
    // once at construction (camera is rebuilt on reload; no live toggle).
    //   ?retailCamZoom=on      → C2 zoom continuum + in-head + near-fade.
    //   ?camStiffness=<0..1>   → C3 frame smoothing (absent/0 = hard-lock,
    //                            today's behavior; retail default feel ≈ 0.5).
    //   ?mouseSmooth=<0..1>    → C3 FilterMouseInput two-sample smoothing.
    //   ?mouseSens=<mult>      → C3 option surface: sensitivity multiplier.
    //   ?mouseInvertY=on       → C3 option surface: invert mouse pitch.
    {
      const params =
        typeof window !== "undefined" && window.location
          ? new URLSearchParams(window.location.search)
          : null;
      this._retailZoomOn =
        params?.get("retailCamZoom")?.toLowerCase() !== "off";
      const stiff = params ? parseFloat(params.get("camStiffness")) : NaN;
      this._camStiffness =
        Number.isFinite(stiff) && stiff > 0 ? Math.min(stiff, 1.0) : null;
      const msm = params ? parseFloat(params.get("mouseSmooth")) : NaN;
      this._mouseSmooth =
        Number.isFinite(msm) && msm > 0 ? Math.min(msm, 1.0) : null;
      const msens = params ? parseFloat(params.get("mouseSens")) : NaN;
      this._mouseSensMult =
        Number.isFinite(msens) && msens > 0 ? msens : 1.0;
      this._mouseInvertY =
        params?.get("mouseInvertY")?.toLowerCase() === "on";
    }
    // C2 state: first-person latch (followDistance keeps its third-person
    // value while in-head so bookkeeping survives the round trip).
    this._inHead = false;
    // C2 state: last opacity pushed to the local-player fade helper —
    // dedupe so the per-frame fade only touches materials on change.
    this._camFadeLastOpacity = 1.0;
    // C3 state: FilterMouseInput two-sample holder (camera_math contract).
    this._mlFilter = { lastDX: 0, lastDY: 0, lastT: -1 };
    // C3 state: smoothed-camera scratch (allocated lazily; null forces the
    // first stiffness frame to hard-snap so there's no swoosh from origin).
    this._stiffSeeded = false;
    this._stiffTmp = null;

    this._installKeyListeners();
    this._installModeToggle();

    // A14-I1 (?inputFunnel=on): register THIS camera's per-mode movement
    // mapping as the shared InputController's policy, so the single funnel
    // applies orbit-suppress / topDown world-fixed / follow passthrough at
    // the one dispatch site. Default OFF — when off, the controller is never
    // consulted and `_dispatchMovement` runs the legacy path unchanged. The
    // policy receives the raw keystate-derived tristate axes and returns the
    // mode-mapped axes (null = orbit suppression). It re-reads `this.mode`
    // each call so a mid-stride `C`-cycle is honoured live.
    this._inputFunnelOn = readInputFunnelFlag();
    if (this._inputFunnelOn) {
      try {
        const ctrl = getInputController();
        ctrl.setMovementPolicy((raw) => this._movementPolicy(raw));
      } catch (_) { /* never break camera init on the funnel wiring */ }
    }

    // Initial mode entry.
    this.switchMode("follow");
  }

  // ---- mode switcher ------------------------------------------------

  /**
   * Switch to the named mode. Disposes the previous controller +
   * constructs the new one. Reads `getPlayerWorldPos()` so the new
   * camera frames the player from the moment it activates.
   */
  switchMode(next) {
    if (!CAMERA_MODES.includes(next)) {
      // eslint-disable-next-line no-console
      console.warn(`[cameraSwitcher] unknown mode "${next}"; ignoring`);
      return;
    }
    // Tear down the previous controller.
    if (this.controls && typeof this.controls.dispose === "function") {
      try {
        this.controls.dispose();
      } catch (_) {}
    }
    this.controls = null;

    // Wave 2 / F1 fix (2026-05-28) — remove the previous mode's
    // DOM listeners before the new mode's build appends fresh ones.
    // Without this, every switchMode call leaks 4 listeners onto the
    // canvas/document so right-clicks fire the radial menu N times
    // after N toggles.
    if (Array.isArray(this._listeners) && this._listeners.length > 0) {
      for (const entry of this._listeners) {
        if (!entry) continue;
        const [evtName, fn, target] = entry;
        try { target?.removeEventListener?.(evtName, fn); } catch (_) {}
      }
      this._listeners.length = 0;
    }

    this.mode = next;
    if (next === "follow") {
      // Retail Asheron's Call mouselook: cursor stays visible (no
      // PointerLock), right-mouse-button HELD + dragged turns the
      // camera (yaw + pitch on followYaw/followPitch). Left-click
      // stays reserved for entity picking — see scene3d/picking.js.
      // The browser context menu is suppressed on the canvas so
      // right-drag can drive the camera unhindered.
      if (this.domElement) {
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        let downX = 0;
        let downY = 0;
        let candidateGuid = null;
        const onContextMenu = (ev) => {
          ev.preventDefault();
          return false;
        };
        const onMouseDown = (ev) => {
          if (ev.button !== 2) return;
          dragging = true;
          lastX = ev.clientX;
          lastY = ev.clientY;
          downX = ev.clientX;
          downY = ev.clientY;
          candidateGuid =
            typeof window !== "undefined" &&
            typeof window.__pickEntityAt === "function"
              ? window.__pickEntityAt(ev.clientX, ev.clientY)
              : null;
          ev.preventDefault();
        };
        const onMouseMove = (ev) => {
          if (!dragging) return;
          let mx = ev.clientX - lastX;
          let my = ev.clientY - lastY;
          lastX = ev.clientX;
          lastY = ev.clientY;
          // A12-C3 (?mouseSmooth=<0..1>): retail FilterMouseInput two-sample
          // smoothing on the RAW deltas, before sensitivity — the same order
          // retail's MouseLookHandler uses (filter acclient.c:148138-148163,
          // scale after at 149300-149303). Off (null) = identity, the exact
          // pre-C3 statements.
          if (this._mouseSmooth != null) {
            const f = filterMouseDelta(
              this._mlFilter, mx, my, this._mouseSmooth,
              performance.now() / 1000,
            );
            mx = f.dx;
            my = f.dy;
          }
          // A12-C3 option surface: sensitivity multiplier + invert-Y
          // (retail m_MouseLookSensitivity / m_InvertMouseLookYAxis,
          // acclient.c:149300-149309). Defaults 1.0 / off = no-op.
          if (this._mouseInvertY) my = -my;
          this.followYaw += mx * POINTER_YAW_SENS * this._mouseSensMult;
          this.followPitch += my * POINTER_PITCH_SENS * this._mouseSensMult;
          if (this.followPitch < FOLLOW_PITCH_MIN)
            this.followPitch = FOLLOW_PITCH_MIN;
          if (this.followPitch > FOLLOW_PITCH_MAX)
            this.followPitch = FOLLOW_PITCH_MAX;
        };
        const onMouseUp = (ev) => {
          if (ev.button !== 2) return;
          dragging = false;
          const dx = ev.clientX - downX;
          const dy = ev.clientY - downY;
          // 5px² — small enough to not eat deliberate orbits
          if (dx * dx + dy * dy < 25 && candidateGuid != null) {
            if (
              typeof window !== "undefined" &&
              typeof window.__openContextMenuFor === "function"
            ) {
              try {
                window.__openContextMenuFor({
                  source: "scene3d",
                  guid: candidateGuid,
                  clientX: ev.clientX,
                  clientY: ev.clientY,
                });
              } catch (_) {}
            } else if (
              typeof window !== "undefined" &&
              typeof window.__openRadialMenuFor === "function"
            ) {
              try {
                window.__openRadialMenuFor(candidateGuid, ev.clientX, ev.clientY);
              } catch (_) {}
            } else if (
              typeof window !== "undefined" &&
              typeof window.__showExamineFor === "function"
            ) {
              try {
                window.__showExamineFor(candidateGuid);
              } catch (_) {}
            }
          }
          candidateGuid = null;
        };
        this.domElement.addEventListener("contextmenu", onContextMenu);
        this.domElement.addEventListener("mousedown", onMouseDown);
        this._listeners.push(["contextmenu", onContextMenu, this.domElement]);
        this._listeners.push(["mousedown", onMouseDown, this.domElement]);
        if (typeof document !== "undefined") {
          document.addEventListener("mousemove", onMouseMove);
          document.addEventListener("mouseup", onMouseUp);
          this._listeners.push(["mousemove", onMouseMove, document]);
          this._listeners.push(["mouseup", onMouseUp, document]);
        }
      }
      this.activeCamera = this.persp;
    } else if (next === "orbit") {
      // OrbitControls maintains its own target + handles mouse
      // drag/wheel internally. We tick `controls.update()` each frame
      // and set `.target` to the player's world pos so the camera
      // tracks when the player moves.
      //
      // 2026-05-18 — coord-space fix. Previously this branch:
      //   oc.target.set(0, 0, 0)
      //   this.persp.position.set(p.x + 8, p.y - 12, p.z + 8)
      //   this.persp.lookAt(p.x, p.y, p.z)
      // — the position/lookAt arguments are in AC coords (x east,
      // y north, z up) but persp lives outside worldRoot and expects
      // three.js coords (x east, y up, z south). So `p.y - 12` was
      // burying the camera 12 m below the player, and the target
      // (0,0,0) made OrbitControls orbit around the WORLD ORIGIN
      // instead of the player. Net effect: in Holtburg the user saw
      // sky + clearColor with no terrain, because the camera was
      // below ground looking at empty space far from Holtburg.
      // Fix: apply acToThree to every position/target value.
      const p = this._safePlayerPos();
      // Offset semantics preserved from prior code: 8 m east, 12 m
      // south, 8 m up (back-and-above-the-player-ish view).
      const camPos = acToThree(p.x + 8, p.y - 12, p.z + 8);
      const lookTarget = acToThree(p.x, p.y, p.z + 1.0);
      if (this.domElement) {
        try {
          const oc = new OrbitControls(this.persp, this.domElement);
          oc.enableDamping = true;
          oc.dampingFactor = 0.08;
          oc.target.set(...lookTarget);
          this.controls = oc;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("[cameraSwitcher] OrbitControls init failed:", e);
        }
      }
      // Position the camera at an initial offset so OrbitControls
      // has a starting orientation. positionCamera() in the orbit
      // branch only updates `.target`; it does NOT overwrite
      // camera.position (so the user's drag isn't fought).
      this.persp.position.set(...camPos);
      this.persp.lookAt(...lookTarget);
      this.activeCamera = this.persp;
    } else if (next === "topDown") {
      // Ortho top-down. activeCamera flips to the ortho instance.
      // No controller — wheel zooms via the keystate listener; pan
      // is implicit (the camera follows the player).
      this.activeCamera = this.ortho;
    }
  }

  /**
   * C1 (#4): the camera the render loop / picker should use RIGHT NOW.
   * Returns `activeCamera` (the ortho instance in topDown, persp in
   * follow/orbit) — NOT `this.persp`. picking.js:323 and the debug
   * overlay read this; returning persp would re-break top-down/ortho
   * picking (the ray would be cast from the frozen perspective camera).
   */
  getActive() {
    return this.activeCamera;
  }

  // ---- per-rAF tick -------------------------------------------------

  /**
   * Per-frame update. Driven from `loop.js` `tickPerFrame`.
   * - Mirrors `predictedPlayerPos` onto the wasm integrator's
   *   authoritative collided world pose via `_smoothToIntegrator`
   *   (a direct-assign since the 2026-06-05 FULL COLLAPSE). The rig and
   *   follow-camera therefore render the physics pose 1:1, exactly as
   *   retail renders off its single CPhysicsObj.
   * - Positions the active camera (consuming `predictedPlayerPos` via
   *   `getLocalPlayerWorldPos` → cameraSwitcher fallback).
   * - Computes movement input from keystate + camera yaw and forwards
   *   to `sessionHandle.setMovementInput` on change.
   * - Calls `controls.update()` for OrbitControls damping (no-op for
   *   other modes).
   *
   * The legacy collision-blind JS predictor was retired 2026-06-29
   * (see the `_advancePrediction` banner); `tick()` no longer has a
   * predict / reconcile / lerp branch.
   */
  tick(dt) {
    // Single source of truth: mirror the wasm integrator's collided pose.
    // Do NOT re-introduce a JS predictor or smoother on top of the wasm
    // body — that second forward integrator (flat 4.5 m/s, collision-blind)
    // was the snap-back / dual-predictor sawtooth, retired 2026-06-29.
    this._smoothToIntegrator(dt);
    this.positionCamera(dt);
    if (this.controls && typeof this.controls.update === "function") {
      try {
        this.controls.update();
      } catch (_) {}
    }
    this._dispatchMovement();
  }

  // ---- camera positioning ------------------------------------------

  positionCamera(dt) {
    const p = this._safePlayerPos();
    if (this.mode === "follow") {
      // A12-C2 (?retailCamZoom=on): first-person is the min endpoint of
      // the zoom continuum, not a fourth mode — retail's in-head IS the
      // viewer_offset (0, 0.18, 0) point (acclient.c:147680-147687).
      if (this._retailZoomOn && this._inHead) {
        this._positionInHead(p);
        return;
      }
      // Camera position = player + offset(yaw, pitch, distance).
      // Camera-forward direction (player-facing-toward) in AC XY:
      //   (sin yaw, cos yaw). Camera sits BEHIND the player along
      // negative-forward, raised by pitch * distance, distance back.
      const cosPitch = Math.cos(this.followPitch);
      const sinPitch = Math.sin(this.followPitch);
      const horizDist = this.followDistance * cosPitch;
      const vertDist = this.followDistance * sinPitch;
      const forwardX = Math.sin(this.followYaw);
      const forwardY = Math.cos(this.followYaw);
      // Camera offset is negative-forward (behind player), elevated.
      // Coords are AC-native here; acToThree applies the worldRoot
      // rotation on the way out so the camera lands where geometry
      // actually renders (Phase 7.7 audit fix).
      const idealX = p.x - forwardX * horizDist;
      const idealY = p.y - forwardY * horizDist;
      // Ideal camera Z = player z + pitch lift + safety lift. The
      // safety lift is small (1.0 m) now that the heightfield sweep
      // can clamp the camera off the ground continuously — without
      // the sweep the old code used a fat 8 m fixed lift to dodge
      // clipping into Holtburg hillsides.
      const idealZ = p.z + vertDist + 1.0;

      // Workstream C (3D camera collision, 2026-05-11): chain the
      // wasm-side collision sweeps to clip the camera against
      // terrain, buildings, building-interior triangles, statics,
      // and EnvCell triangles. Order matters: cheapest rejects first,
      // most expensive last. Each sweep narrows the camera's target
      // toward the player; the nearest hit wins.
      let finalX = idealX, finalY = idealY, finalZ = idealZ;
      const camera = this._clipCameraAgainstWorld(p, finalX, finalY, finalZ);
      finalX = camera.x; finalY = camera.y; finalZ = camera.z;

      // Phase 3 (Cohere-D follow-on, 2026-05-12): lookAt moves with
      // mouse-pitch so the view direction genuinely tilts up/down,
      // not just orbits around a fixed head-height point.
      //   - followPitch = 0  → lookAt at player's eye (1.6 m), view
      //     horizontal.
      //   - followPitch > 0 (looking down) → lookAt drops below the
      //     eye, view tilts down at the ground.
      //   - followPitch < 0 (looking up) → lookAt lifts above the
      //     eye, view tilts up at the sky.
      // The lift distance matches `LOOK_LIFT_DIST_M` so the
      // camera-to-lookAt vector aligns roughly with the camera's
      // negative-position offset at most pitches — view feels like
      // a natural camera tilt.
      //
      // Pre-Phase-3 behaviour was lookAt fixed at
      // `(p.x, p.y, p.z + 1.6)`; sky/building tops were unreachable
      // because the view always pointed at the player's head.
      const lookLift = -Math.sin(this.followPitch) * LOOK_LIFT_DIST_M;
      const lookX = p.x, lookY = p.y, lookZ = p.z + 1.6 + lookLift;
      if (this._camStiffness != null) {
        // A12-C3 (?camStiffness=): exponential interpolation of the camera
        // frame toward the sought (clipped) frame instead of the hard-set.
        this._applyStiffness(dt, finalX, finalY, finalZ, lookX, lookY, lookZ);
      } else {
        this.persp.position.set(...acToThree(finalX, finalY, finalZ));
        this.persp.lookAt(...acToThree(lookX, lookY, lookZ));
      }
      if (this._retailZoomOn) {
        // A12-C2 near-fade: fade the local player as the (actual) camera
        // closes on the pivot (p + CAMERA_DEFAULT_PIVOT_Z). Distance is
        // rotation-invariant, so measure in three.js space directly.
        const [pvx, pvy, pvz] = acToThree(p.x, p.y, p.z + CAMERA_DEFAULT_PIVOT_Z);
        const ddx = this.persp.position.x - pvx;
        const ddy = this.persp.position.y - pvy;
        const ddz = this.persp.position.z - pvz;
        const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        this._applyCameraPlayerFade(nearFadeOpacity(d));
      }
    } else if (this.mode === "orbit") {
      // A12-C2: a mid-fade player must not stay ghosted when the user
      // C-cycles out of follow mode — restore full opacity once.
      if (this._retailZoomOn) this._applyCameraPlayerFade(1.0);
      // OrbitControls owns position. We only retarget. Damping in
      // .update() smooths the target slide. Target is in three.js
      // world coords (camera lives outside worldRoot), so apply the
      // acToThree mapping.
      if (this.controls && this.controls.target) {
        this.controls.target.set(...acToThree(p.x, p.y, p.z + 1.0));
      }
    } else if (this.mode === "topDown") {
      // A12-C2: same fade-restore as the orbit branch.
      if (this._retailZoomOn) this._applyCameraPlayerFade(1.0);
      // Ortho looking straight down at player. AC +Z up → three +Y up.
      // After the worldRoot rotation, AC +Y north maps to three.js -Z,
      // so camera.up = (0, 0, -1) keeps AC north at the top of the
      // screen (was (0,1,0) which sat parallel to the view direction
      // post-rotation = degenerate).
      this.ortho.position.set(...acToThree(p.x, p.y, p.z + TOPDOWN_HEIGHT_M));
      this.ortho.up.set(0, 0, -1);
      this.ortho.lookAt(...acToThree(p.x, p.y, p.z));
    }
  }

  /**
   * Workstream C (3D camera collision, 2026-05-11): chain the wasm-side
   * collision sweeps to clip the camera target against terrain,
   * outdoor building AABBs, building-interior triangles, statics, and
   * EnvCell triangles. Returns the final camera position `{x, y, z}`.
   *
   * Sweep chain (cheapest → most expensive):
   *   1. **Terrain heightfield clamp.** Continuous (bilinear), so no
   *      jitter on slopes — beats discrete poly-vs-poly tests on
   *      Holtburg's gentle hills.
   *   2. **Outdoor building AABB sweep** (`cameraSweepCollision`). Fast
   *      Minkowski-sum slab test; rejects most frames.
   *   3. **Building-interior triangle sweep** (`sweepSphereAgainstBuilding-
   *      Mesh`). Per-`physics_polygon` triangle, lifted through the
   *      placement frame. Catches interior + basement walls the
   *      coarse AABB misses.
   *   4. **Outdoor static sweep** (`sweepSphereAgainstStatics`). Same
   *      Minkowski-sum AABB test, but against the tree/sign/prop
   *      index.
   *   5. **EnvCell triangle sweep** (`sweepSphereAgainstCellMesh`),
   *      gated on the cells in the BFS render set. Dungeons + apartments.
   *
   * Each hit clips `final` to `start + (final - start) * (t - backoff)`,
   * so subsequent sweeps run against the already-clipped target. The
   * 0.2 m backoff keeps the camera slightly off the surface so the
   * pull-in tracks smoothly when the player walks toward a wall.
   *
   * Returns `{x, y, z}` to be passed to `acToThree(...)` by the caller.
   * No-ops when the SessionHandle isn't wired (synthetic test path) or
   * pre-spawn (the shadow scene is empty and every sweep returns null).
   */
  _clipCameraAgainstWorld(playerPos, idealX, idealY, idealZ) {
    const handle = this._getSessionHandle();
    const CAM_RADIUS = 0.5; // metres
    const BACKOFF = 0.2; // metres short of contact

    let finalX = idealX, finalY = idealY, finalZ = idealZ;
    if (!handle) {
      return { x: finalX, y: finalY, z: finalZ };
    }

    // ---- 1. Continuous heightfield clamp ----
    try {
      if (typeof handle.terrainHeightAt === "function") {
        const terrainZ = handle.terrainHeightAt(finalX, finalY);
        if (typeof terrainZ === "number" && Number.isFinite(terrainZ)) {
          const minZ = terrainZ + CAM_RADIUS + BACKOFF;
          if (finalZ < minZ) {
            finalZ = minZ;
          }
        }
      }
    } catch (_) {}

    // The chain of sweep sweeps operates against (start, end) =
    // (headPos, finalCamPos). When a hit lands at parametric `t`,
    // we clip `final` to `start + delta * (t - backoff/delta_len)`.
    const startX = playerPos.x;
    const startY = playerPos.y;
    const startZ = playerPos.z + 1.6;

    const clipFinalTo = (hit) => {
      // hit.t in [0, 1]; clamp to a tiny minimum so we don't snap the
      // camera to the player's head.
      const dx = finalX - startX, dy = finalY - startY, dz = finalZ - startZ;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-3) return;
      const backoffT = BACKOFF / len;
      const t = Math.max(0.0, hit.t - backoffT);
      finalX = startX + dx * t;
      finalY = startY + dy * t;
      finalZ = startZ + dz * t;
    };

    // Get the player's current landblock id from the session handle.
    let landblockId = 0;
    try {
      const pose = handle.getLocalPlayerPose?.();
      if (pose && typeof pose.landblockId === "number") {
        landblockId = pose.landblockId;
      }
    } catch (_) {}

    if (landblockId !== 0) {
      // ---- 2. Outdoor building AABB sweep ----
      try {
        if (typeof handle.cameraSweepCollision === "function") {
          const hit = handle.cameraSweepCollision(
            startX, startY, startZ,
            finalX, finalY, finalZ,
            CAM_RADIUS,
            landblockId,
          );
          if (hit) clipFinalTo(hit);
        }
      } catch (_) {}

      // ---- 3. Building-interior triangle sweep ----
      try {
        if (typeof handle.sweepSphereAgainstBuildingMesh === "function") {
          const hit = handle.sweepSphereAgainstBuildingMesh(
            startX, startY, startZ,
            finalX, finalY, finalZ,
            CAM_RADIUS,
            landblockId,
          );
          if (hit) clipFinalTo(hit);
        }
      } catch (_) {}

      // ---- 4. Outdoor static sweep ----
      try {
        if (typeof handle.sweepSphereAgainstStatics === "function") {
          const hit = handle.sweepSphereAgainstStatics(
            startX, startY, startZ,
            finalX, finalY, finalZ,
            CAM_RADIUS,
            landblockId,
          );
          if (hit) clipFinalTo(hit);
        }
      } catch (_) {}
    }

    // ---- 5. EnvCell triangle sweep (cells in current render set) ----
    try {
      if (
        typeof handle.sweepSphereAgainstCellMesh === "function" &&
        typeof handle.getRenderSet === "function"
      ) {
        const renderSet = handle.getRenderSet(1);
        if (renderSet && renderSet.length > 0) {
          // Pass as a Uint32Array (wasm-bindgen `&[u32]` expects this).
          const cellArr = renderSet instanceof Uint32Array
            ? renderSet
            : new Uint32Array(renderSet);
          const hit = handle.sweepSphereAgainstCellMesh(
            startX, startY, startZ,
            finalX, finalY, finalZ,
            CAM_RADIUS,
            cellArr,
          );
          if (hit) clipFinalTo(hit);
        }
      }
    } catch (_) {}

    return { x: finalX, y: finalY, z: finalZ };
  }

  // ---- A12-C2/C3 retail camera (default-off) ------------------------

  /**
   * A12-C2 — first-person (in-head) frame. Retail `CameraSet::SetInHead`
   * (acclient.c:149230-149262): viewer_offset (0, 0.18, 0) off the pivot
   * (player + CAMERA_DEFAULT_PIVOT_Z), translational stiffness forced to
   * 1.0 — so this is a HARD-SET even when `?camStiffness=` is active.
   * View direction comes from followYaw/followPitch with the retail
   * in-head dir-z clamp ±0.8 (acclient.c:148398-148409); followPitch
   * positive looks DOWN → dirZ = -sin(pitch).
   *
   * Deliberately NO collision pull-in: the camera sits inside the
   * player's own collision sphere, so the sweep chain would clip it to
   * the head every frame (and retail's camera never collides anyway).
   * The player is hidden outright — retail in-head sets
   * SetTranslucencyHierarchical(player, 1.0) = fully invisible
   * (acclient.c:149187).
   */
  _positionInHead(p) {
    const fx = Math.sin(this.followYaw);
    const fy = Math.cos(this.followYaw);
    const camX = p.x + fx * IN_HEAD_FORWARD_M;
    const camY = p.y + fy * IN_HEAD_FORWARD_M;
    const camZ = p.z + CAMERA_DEFAULT_PIVOT_Z;
    const dirZ = clampInHeadDirZ(-Math.sin(this.followPitch));
    const horiz = Math.sqrt(Math.max(0, 1 - dirZ * dirZ));
    this.persp.position.set(...acToThree(camX, camY, camZ));
    this.persp.lookAt(...acToThree(
      camX + fx * horiz * LOOK_LIFT_DIST_M,
      camY + fy * horiz * LOOK_LIFT_DIST_M,
      camZ + dirZ * LOOK_LIFT_DIST_M,
    ));
    // Re-seed the C3 smoother on the way back out to third person so the
    // first post-in-head frame snaps instead of swooshing from the head.
    this._stiffSeeded = false;
    this._applyCameraPlayerFade(0.0);
  }

  /**
   * A12-C3 — retail stiffness smoothing (CameraManager::UpdateCamera,
   * acclient.c:147796-147853): interpolate origin and rotation SEPARATELY
   * toward the sought frame by `frac = clamp(stiffness * dt * 10, 0, 1)`,
   * snapping when stiffness ≈ 1.0 or within the 4e-4 m early-out. Ours-only
   * deviation (documented in camera_math.js): snap on > 50 m sought-frame
   * jumps (teleports) — retail has no client teleports mid-stiffness to
   * worry about because the pivot pose itself snaps server-side.
   */
  _applyStiffness(dt, finalX, finalY, finalZ, lookX, lookY, lookZ) {
    if (!this._stiffTmp) {
      this._stiffTmp = {
        pos: new THREE.Vector3(),
        look: new THREE.Vector3(),
        m: new THREE.Matrix4(),
        q: new THREE.Quaternion(),
      };
    }
    const t = this._stiffTmp;
    t.pos.set(...acToThree(finalX, finalY, finalZ));
    t.look.set(...acToThree(lookX, lookY, lookZ));
    const frac = stiffnessFrac(this._camStiffness, dt);
    const dist = this.persp.position.distanceTo(t.pos);
    if (!this._stiffSeeded || frac >= 1.0 || dist > STIFFNESS_TELEPORT_SNAP_M) {
      this.persp.position.copy(t.pos);
      this.persp.lookAt(t.look);
      this._stiffSeeded = true;
      return;
    }
    if (dist <= STIFFNESS_SNAP_DIST_M) {
      this.persp.position.copy(t.pos);
    } else {
      this.persp.position.lerp(t.pos, frac);
    }
    // Sought rotation = the frame the hard-set path would have produced
    // (lookAt from the SOUGHT origin). Matrix4.lookAt(eye, target, up) is
    // exactly what Object3D.lookAt uses for cameras.
    t.m.lookAt(t.pos, t.look, this.persp.up);
    t.q.setFromRotationMatrix(t.m);
    this.persp.quaternion.slerp(t.q, frac);
  }

  /**
   * A12-C2 — push a camera-driven opacity onto the local player rig via
   * the entities.js helper. Quantized to 1/128 + deduped so the per-frame
   * fade only touches materials when it visibly changes. Never throws
   * (pre-spawn / synthetic-test paths have no entityManager or guid).
   */
  _applyCameraPlayerFade(opacity) {
    const q = Math.round(opacity * 128) / 128;
    if (q === this._camFadeLastOpacity) return;
    const em = this.scene3d && this.scene3d.entityManager;
    if (!em || typeof em.setLocalPlayerCameraOpacity !== "function") return;
    const lpgFn =
      typeof window !== "undefined" ? window.getLocalPlayerGuid : null;
    const localGuid = typeof lpgFn === "function" ? lpgFn() : null;
    if (localGuid == null) return;
    try {
      em.setLocalPlayerCameraOpacity(localGuid >>> 0, q);
      this._camFadeLastOpacity = q;
    } catch (_) {}
  }

  /**
   * A12-C2 — one zoom notch on the retail continuum (wheel / PageUp /
   * PageDown in follow mode). Pure math in camera_math.js.
   */
  _retailZoomNotch(dir) {
    const next = retailZoomStep(
      { radius: this.followDistance, inHead: this._inHead },
      dir,
    );
    this.followDistance = next.radius;
    this._inHead = next.inHead;
  }

  // ---- prediction (Workstream B) — RETIRED 2026-06-29 --------------
  //
  // The three methods below (`_reconcilePrediction`, `_advancePrediction`,
  // `_applyPredictionLerp`) are the legacy collision-blind JS predictor: a
  // second forward integrator that marched rendered X/Y at a flat 4.5 m/s
  // with no collision and lerped back toward the server pose. It fought the
  // wasm integrator (the single retail-faithful physics body) and produced
  // the dual-predictor sawtooth / snap-back. They are NO LONGER WIRED into
  // `tick()` (see `_smoothToIntegrator`, the sole runtime pose source) and
  // are retained only so the historical `.mjs` A/B harnesses still link.
  // DO NOT re-wire them into the runtime — a JS predictor / smoother on top
  // of the wasm body is exactly the bug that was removed.

  /**
   * Workstream B (2026-05-11) — reconcile `predictedPlayerPos` against
   * any fresh server pose landed in `__lastEntityWorldPos` since the
   * last reconcile. Mirrors the 2D path's authoritative-pose snap in
   * `handlePositionUpdate` (`index.html:~4115`) for the 3D follow
   * camera.
   *
   * Reconciliation rules:
   *   - First time we see a pose: seed `predictedPlayerPos` directly
   *     from the server (no lerp; pre-spawn → first-spawn transition).
   *   - Delta magnitude > 5 m: treat as a teleport. Snap predicted to
   *     server pose and clear any in-flight lerp.
   *   - Otherwise: start a 150 ms lerp from current predicted pose to
   *     server pose. `_applyPredictionLerp(dt)` consumes the lerp.
   *
   * `lastReconcileTs` is the server's `ts` we last reconciled against.
   * Only `ts > lastReconcileTs` triggers a re-reconcile, so a stale
   * server pose (e.g. between 30 Hz emits) doesn't keep pulling the
   * prediction back to the same point on every rAF.
   */
  _reconcilePrediction() {
    if (typeof window === "undefined") return;
    // Resolve the local-player GUID. Mirrors the same fallback chain as
    // entities.js#getLocalPlayerWorldPos so the prediction layer
    // converges on the same GUID as the rest of the 3D path.
    const lpgFn = window.getLocalPlayerGuid;
    let guid = (typeof lpgFn === "function") ? lpgFn() : null;
    const lastMap = window.__lastEntityWorldPos;
    if ((guid === null || guid === undefined) && lastMap) {
      for (const k of lastMap.keys()) {
        if (((k >>> 0) & 0xF0000000) === 0x50000000) {
          guid = k >>> 0;
          break;
        }
      }
    }
    if (guid === null || guid === undefined) return;
    const serverPose = lastMap && typeof lastMap.get === "function"
      ? lastMap.get(guid >>> 0)
      : null;
    if (!serverPose) return;
    const sx = serverPose.x;
    const sy = serverPose.y;
    const sz = serverPose.z;
    const sts = typeof serverPose.ts === "number" ? serverPose.ts : 0;
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;

    // First-time seed — no lerp, just plant the flag.
    if (!this.predictedPlayerPos) {
      this.predictedPlayerPos = {
        x: sx, y: sy, z: sz,
        lastReconcileTs: sts,
      };
      this._lerpRemainingMs = 0.0;
      return;
    }

    // Already up-to-date — nothing fresh from the server since our
    // last reconcile. Common case: ACE emits at 30 Hz, rAF runs at 60+
    // Hz, so half of frames see no change in `serverPose.ts`.
    if (sts <= this.predictedPlayerPos.lastReconcileTs) return;

    const px = this.predictedPlayerPos.x;
    const py = this.predictedPlayerPos.y;
    const pz = this.predictedPlayerPos.z;
    const dx = sx - px;
    const dy = sy - py;
    const dz = sz - pz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Snap on large delta (teleport, rubberband, init). The 5 m
    // threshold comes from the spec — comfortably larger than worst-case
    // single-tick drift at 4.5 m/s × 33 ms ≈ 0.15 m.
    if (dist > 5.0) {
      this.predictedPlayerPos.x = sx;
      this.predictedPlayerPos.y = sy;
      this.predictedPlayerPos.z = sz;
      this.predictedPlayerPos.lastReconcileTs = sts;
      this._lerpRemainingMs = 0.0;
      return;
    }

    // Small drift — start a lerp toward the server pose. Setting the
    // target every time a fresh server pose arrives means the lerp
    // chases the latest authoritative state; the in-flight blend in
    // `_applyPredictionLerp` smooths the rough edges between 30 Hz
    // updates.
    this._lerpTargetX = sx;
    this._lerpTargetY = sy;
    this._lerpTargetZ = sz;
    this._lerpRemainingMs = this._lerpDurationMs;
    this.predictedPlayerPos.lastReconcileTs = sts;
  }

  /**
   * Workstream B (2026-05-11) — advance `predictedPlayerPos` by the
   * current WASD intent vector for `dt` seconds. Mirrors the 2D
   * prediction block at `index.html:6168-6235` for the 3D path.
   *
   * Heading source priority:
   *   1. `__sessionHandle.getLocalPlayerPose().heading` — authoritative
   *      integrator heading, available post-Workstream-A (lands on the
   *      first heartbeat tick after EnteredWorld).
   *   2. `this.getPlayerHeading()` — the 3D rig's quaternion-derived
   *      yaw, available once the EntityManager builds the local-player
   *      rig (post-Workstream-E, currently unreliable).
   *   3. `0` — north-facing default. Pre-spawn `predictedPlayerPos` is
   *      `null` anyway, so this branch only fires in the brief window
   *      after the first server pose lands but before the first
   *      heartbeat tick publishes a heading.
   *
   * Speed constants come from `window.__movementConstants` (exposed by
   * `index.html` so 2D and 3D prediction stay in sync). If the page
   * hasn't run the login closure yet (`__movementConstants` undefined),
   * the prediction silently no-ops — the predicted pose stays anchored
   * at whatever the last server pose was, and the camera tracks that.
   *
   * Convention bridge (heading → world delta): the 3D follow camera
   * uses the **compass-bearing** convention (CW-from-+Y-north) for
   * heading, identical to `followYaw` in `positionCamera`'s forward
   * vector `(sin yaw, cos yaw)`. This DIFFERS from the 2D path's
   * formula at `index.html:6212-6230` because the 2D path's heading
   * is offset by `SPRITE_HEADING_OFFSET = π/2` to account for the
   * sprite-coordinate convention (sprite rotation 0 = facing screen-
   * east, not screen-up). For the 3D path, the wasm-side
   * `getLocalPlayerPose().heading` is the raw compass bearing — yaw=0
   * means +Y north, yaw=π/2 means +X east — so we use the same
   * `(sin h, cos h)` math the camera uses internally.
   *
   *   - forward in heading: `dx = +sin(h) * speed * dt`,
   *                         `dy = +cos(h) * speed * dt`
   *     (heading=0 north → (0, +speed); heading=π/2 east → (+speed, 0))
   *   - backstep: forward direction flipped, walk speed
   *   - strafe right (D, +1): heading + π/2 (right of forward), walk speed
   *   - strafe left (A, -1):  heading - π/2 (left of forward),  walk speed
   *
   * Forward axis takes priority over strafe (the wire format's
   * `Locomotion` carries a single direction), so W+D produces forward
   * motion only — strafe only applies when forward is zero.
   *
   * Q/E manual turn: the prediction layer does NOT integrate heading
   * locally. The server-authoritative pose's heading is the source of
   * truth, and the next reconcile pulls it in. Spinning in place
   * (forward=0, turn=±1) → predicted pose stays still (correct —
   * the player rotates without translating). This matches the 2D
   * prediction block, which DOES integrate heading locally but only to
   * keep `sprite.rotation` in sync; the actual translation still uses
   * the integrated heading. The 3D path defers heading-integration
   * to the server because the wasm-side authoritative heading is
   * already exposed via `getLocalPlayerPose()`.
   */
  _advancePrediction(dt) {
    if (typeof window === "undefined") return;
    if (this.mode !== "follow") return; // topDown / orbit don't need prediction
    if (!this.predictedPlayerPos) return; // pre-spawn — no anchor

    // Capture wall-clock for the trace buffer + the lerp ledger.
    const now = (typeof performance !== "undefined" && performance.now)
      ? performance.now()
      : Date.now();

    // Skip the very first tick after seeding — no `dt` baseline yet.
    if (this._predLastTickMs === null) {
      this._predLastTickMs = now;
      return;
    }
    this._predLastTickMs = now;

    // Cap dt at 100 ms to clamp big jumps when a hidden tab resumes
    // and rAF fires after a multi-second pause (matches 2D path's
    // `Math.min((now - lastPredictionTime) / 1000, 0.1)`).
    const dtSafe = Math.min(dt, 0.1);
    if (!(dtSafe > 0)) return;

    const k = this.keys;
    const inputForward = (k.w ? 1 : 0) - (k.s ? 1 : 0);
    const inputStrafe = (k.d ? 1 : 0) - (k.a ? 1 : 0);
    if (inputForward === 0 && inputStrafe === 0) {
      // No WASD held — no advancement. The reconcile path will still
      // drag predicted toward server pose if the integrator continues
      // to advance (e.g. on a slope where gravity matters), but the
      // client doesn't extrapolate without input.
      return;
    }

    // Constants from the 2D path's prediction block, hoisted onto
    // window.__movementConstants by index.html. Hard-coded fallbacks
    // mirror the values at `index.html:5346-5349` so the prediction
    // doesn't silently no-op if the constants aren't exposed yet —
    // but the eslint rule against magic numbers is appeased by the
    // `??` rather than redeclared literals.
    const consts = window.__movementConstants ?? {};
    const RUN_SPEED = consts.FALLBACK_RUN_RATE_SCALAR ?? 4.5;
    const WALK_SPEED = consts.WALK_FORWARD_SPEED ?? 1.0;

    // Heading source. getLocalPlayerPose() is the post-Workstream-A
    // authoritative read; falls back to `getPlayerHeading()` (3D rig
    // quaternion) pre-spawn or in unit-test mocks.
    let heading = null;
    const handle = this._getSessionHandle?.();
    if (handle && typeof handle.getLocalPlayerPose === "function") {
      try {
        const pose = handle.getLocalPlayerPose();
        if (pose && typeof pose.heading === "number"
            && Number.isFinite(pose.heading)) {
          heading = pose.heading;
        }
      } catch (_) {}
    }
    if (heading === null && typeof this.getPlayerHeading === "function") {
      try {
        const h = this.getPlayerHeading();
        if (typeof h === "number" && Number.isFinite(h)) heading = h;
      } catch (_) {}
    }
    if (heading === null) heading = 0.0;

    // A14-I3: Shift XOR ToggleRun option under ?retailRunKeys=on;
    // flag-off = legacy !shift (byte-identical).
    const run = resolveRunModifier(k.shift, handle);
    let advanced = false;
    // Per-second velocity (m/s) captured during integration so the oracle
    // tap below can report it. Set in whichever branch advances.
    let predVx = 0.0, predVy = 0.0;
    if (inputForward !== 0) {
      // Forward in heading direction; backstep flips by π and uses
      // walk speed. Compass-bearing convention: heading=0 → +Y north,
      // heading=π/2 → +X east. dx=+sin(h)*speed, dy=+cos(h)*speed.
      let effHeading = heading;
      let speed = run ? RUN_SPEED : WALK_SPEED;
      if (inputForward < 0) {
        effHeading = heading + Math.PI;
        speed = WALK_SPEED;
      }
      predVx = Math.sin(effHeading) * speed;
      predVy = Math.cos(effHeading) * speed;
      this.predictedPlayerPos.x += predVx * dtSafe;
      this.predictedPlayerPos.y += predVy * dtSafe;
      advanced = true;
    } else if (inputStrafe !== 0) {
      // Strafe right (D, +1) = heading + π/2; strafe left (A, -1) =
      // heading - π/2. Always walk speed (matches 2D path's
      // strafe-as-walk-speed convention).
      const effHeading = heading + inputStrafe * (Math.PI / 2);
      predVx = Math.sin(effHeading) * WALK_SPEED;
      predVy = Math.cos(effHeading) * WALK_SPEED;
      this.predictedPlayerPos.x += predVx * dtSafe;
      this.predictedPlayerPos.y += predVy * dtSafe;
      advanced = true;
    }

    // Item 5 / Wave 3.F oracle shadow (2026-06-18) — ports the retired 2D rAF
    // tap (index.html:8318, gated on the now-dead 2D sprite) to the 3D path.
    // Writes the pure-prediction frame into the wasm shadow so
    // capture_physics_replay.cjs can diff CLIENT prediction vs the C# server
    // oracle. ADDITIVE + WRITE-ONLY: it only populates a validation buffer
    // (read back via getLastClientPrediction); nothing reads it into
    // predictedPlayerPos, so it can NEVER cause snapback.
    //
    // Coordinate space: predictedPlayerPos is WORLD coords (seeded from
    // __lastEntityWorldPos, wx=((lbId>>>24)&0xff)*192+localX). The 2D tap — the
    // physics_replay calibration reference — fed localEntry.sprite.x (= wx,
    // world; legacy/entity_2d.js:87), so the faithful port passes world coords
    // directly. NOTE the Rust doc on set_last_client_prediction says
    // "landblock-local (0..192)" — that's stale vs the actual 2D caller;
    // physics_replay is the arbiter of the expected space. velocity_* use the
    // 3D integrator's per-second velocity (sin/cos heading), NOT the 2D path's
    // screen-space (-cos/sin). vz=0 — z is server-authoritative, not
    // client-integrated. UNVALIDATED in this env (no Playwright); the
    // loads/spawns smoke does NOT cover it — needs physics_replay.
    if (advanced && handle && typeof handle.setLastClientPrediction === "function") {
      // tick_count: monotonically advancing on frames with non-zero input
      // (the contract the 2D path met at index.html:8219).
      window.__predTickCount = (window.__predTickCount || 0) + 1;
      try {
        handle.setLastClientPrediction(
          this.predictedPlayerPos.x,
          this.predictedPlayerPos.y,
          this.predictedPlayerPos.z,
          predVx,
          predVy,
          0.0, // vz — JS integrator doesn't simulate z (server-authoritative).
          true, // on_ground default; jump arc is server-side today.
          (window.__predTickCount || 0) >>> 0,
          now,
        );
      } catch (_) {
        // Channel-closed on disconnect; safe to swallow (matches the 2D tap).
      }
    }

    // Optional debug trace — pushes `(t, predX, predY, authX, authY)`
    // for post-hoc smoothness analysis. Enabled by setting
    // `window.__predTrace3d = true` in the console; off by default.
    if (advanced && window.__predTrace3d === true) {
      let authX = null, authY = null;
      try {
        const pose = handle?.getLocalPlayerPose?.();
        if (pose) {
          // pose.x / pose.y are landblock-local (0..192); convert to
          // world coords using landblockId.
          const lbX = ((pose.landblockId >>> 24) & 0xff) * 192.0;
          const lbY = ((pose.landblockId >>> 16) & 0xff) * 192.0;
          authX = lbX + pose.x;
          authY = lbY + pose.y;
        }
      } catch (_) {}
      this._predictionTrace.push({
        t: now,
        predX: this.predictedPlayerPos.x,
        predY: this.predictedPlayerPos.y,
        authX, authY,
      });
      if (this._predictionTrace.length > this._predictionTraceCapacity) {
        this._predictionTrace.shift();
      }
    }
  }

  /**
   * Workstream B (2026-05-11) — apply any in-flight lerp from
   * `_reconcilePrediction` toward the server pose. The lerp duration
   * (`_lerpDurationMs`) is 150 ms — middle of the 100-300 ms band from
   * the spec. Shorter durations are more responsive but show micro-
   * stutter on a network with jitter; longer durations smooth more but
   * the predicted pose drifts further from the authoritative pose
   * before each reconcile.
   *
   * Math: `predicted += (target - predicted) * (step / remaining)`,
   * where `step = min(dt_ms, remaining)`. This is an inverse-time lerp
   * — each step is a fraction of the remaining gap, so the lerp
   * converges asymptotically on the target without overshooting.
   * Equivalent in steady-state to `predicted = lerp(predicted, target,
   * step / remaining)` and self-correcting if the target moves
   * mid-lerp (which happens every 33 ms at 30 Hz emit cadence).
   */
  _applyPredictionLerp(dt) {
    if (!this.predictedPlayerPos) return;
    if (!(this._lerpRemainingMs > 0)) return;
    const dtMs = dt * 1000.0;
    const step = Math.min(dtMs, this._lerpRemainingMs);
    const frac = step / this._lerpRemainingMs;
    this.predictedPlayerPos.x +=
      (this._lerpTargetX - this.predictedPlayerPos.x) * frac;
    this.predictedPlayerPos.y +=
      (this._lerpTargetY - this.predictedPlayerPos.y) * frac;
    this.predictedPlayerPos.z +=
      (this._lerpTargetZ - this.predictedPlayerPos.z) * frac;
    this._lerpRemainingMs -= step;
    if (this._lerpRemainingMs < 1e-3) this._lerpRemainingMs = 0.0;
  }

  /**
   * GAP 2 (2026-06-02) — read the authoritative integrator pose and
   * convert it from landblock-local (x,y ∈ 0..192) to world coords,
   * matching the convention `loop.js` uses to fill
   * `__lastEntityWorldPos` (`wx = ((lbId>>>24)&0xff)*192 + localX`).
   * The wasm `getLocalPlayerPose()` is the single source of truth: the
   * Rust integrator advances it every TickMovement and reconciliation
   * snaps it against ACE force/teleport sequences. Returns `null` when
   * the handle/pose isn't ready (pre-spawn) so the caller no-ops.
   */
  _integratorWorldPose() {
    const handle = this._getSessionHandle?.();
    if (!handle || typeof handle.getLocalPlayerPose !== "function") return null;
    let pose;
    try {
      pose = handle.getLocalPlayerPose();
    } catch (_) {
      return null;
    }
    if (!pose) return null;
    const lx = pose.x;
    const ly = pose.y;
    const lz = pose.z;
    if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) {
      return null;
    }
    const lbId = (pose.landblockId >>> 0);
    const lbX = (lbId >>> 24) & 0xff;
    const lbY = (lbId >>> 16) & 0xff;
    return {
      x: lbX * 192.0 + lx,
      y: lbY * 192.0 + ly,
      z: lz,
      landblockId: lbId,
    };
  }

  /**
   * Local-rig pose source — mirror the wasm integrator's authoritative
   * collided world pose onto `predictedPlayerPos` each frame. The wasm
   * runtime body is the single retail-faithful CPhysicsObj-equivalent
   * (it predicts locally AND reconciles against the server), so the JS
   * layer only mirrors it; it does NOT predict speed or smooth on top.
   *
   * Since the 2026-06-05 FULL COLLAPSE this is a DIRECT-ASSIGN, not an
   * ease: the rendered avatar IS the physics pose (including
   * teleports / force-positions, which the wasm pose already reflects),
   * exactly as retail renders off its own CPhysicsObj. The earlier
   * exponential ease (`frac = 1 - exp(-dt_ms / tau)`) and the manual
   * landblock-crossing hard-snap were removed — re-smoothing on top of
   * the wasm body was itself the "slightly off from retail" snap-back.
   * The `_lerp*` / `_predPrevLandblockId` fields are retained only for the
   * retired predictor methods + the first-pose seed path below.
   */
  _smoothToIntegrator(dt) {
    if (typeof window === "undefined") return;
    const target = this._integratorWorldPose();
    if (!target) return; // pre-spawn — leave predicted pose / fallback as-is

    // First authoritative pose — plant the predicted pose directly (no
    // ease; matches the legacy first-time seed in `_reconcilePrediction`).
    if (!this.predictedPlayerPos) {
      this.predictedPlayerPos = {
        x: target.x, y: target.y, z: target.z,
        lastReconcileTs: 0,
      };
      this._predPrevLandblockId = target.landblockId;
      return;
    }

    // 2026-06-05 FULL COLLAPSE — render the local rig DIRECTLY at the
    // wasm-owned integrator pose. No JS exponential ease, no JS hard-snap
    // branches, no academy no-snap policy. The wasm side is the single
    // retail-faithful CPhysicsObj-equivalent: it already predicts locally
    // AND reconciles against the server. The JS layer re-smoothing/snapping
    // on top was the "slightly off from retail" divergence (it produced the
    // visible snap-back). Direct-assign so the rendered avatar IS the physics
    // pose, exactly as retail renders off its own CPhysicsObj — including
    // teleports/force-positions, which the wasm pose already reflects.
    // (The legacy JS WASD predictor was RETIRED from the runtime 2026-06-29;
    // `tick()` always takes this path — see the `_advancePrediction` banner.)
    this.predictedPlayerPos.x = target.x;
    this.predictedPlayerPos.y = target.y;
    this.predictedPlayerPos.z = target.z;
    this._predPrevLandblockId = target.landblockId;
  }

  /**
   * Workstream B (2026-05-11) — expose the predicted pose to
   * `entities.js#getLocalPlayerWorldPos` so the follow camera reads
   * the smooth-interpolated position instead of the discrete-stepped
   * stash. Returns `null` pre-spawn (predicted hasn't been seeded);
   * the caller falls back to the existing three-tier resolution.
   */
  getPredictedPlayerWorldPos() {
    if (!this.predictedPlayerPos) return null;
    return {
      x: this.predictedPlayerPos.x,
      y: this.predictedPlayerPos.y,
      z: this.predictedPlayerPos.z,
    };
  }

  // ---- input → movement conversion (load-bearing math) -------------

  /**
   * Camera-relative WASD → wasm setMovementInput contract.
   *
   * In follow mode: rotate (inputForward, inputStrafe) by `followYaw`
   * → world-frame intent (worldDx along +X east, worldDy along +Y
   * north). Then rotate world-frame intent by `-playerHeading` →
   * player-local intent (forward, strafe in the player's body frame
   * — which is what ACE's MovementSystem consumes). With these two
   * rotations chained, pressing W always walks the player toward
   * camera-forward; the path curves slightly until the auto-turn
   * (below) brings playerHeading into alignment with followYaw, then
   * stabilises to a straight line.
   *
   * **Workstream D auto-turn-to-align (2026-05-11 restore).** ACE's
   * MovementSystem rotates the player heading at
   * `RUN_HELD_TURN_SPEED_RAD_PER_SEC = 1.5 rad/s` (see
   * `crates/holtburger-core/src/client/movement/common.rs:29`) when
   * `turn` is held and the player is running. Emit
   * `turn = sign(followYaw - playerHeading)` while WASD is held; ACE
   * rotates at 1.5 rad/s, so the convergence time is bounded by
   * `|headingError| / 1.5 s`. A 90° pan (π/2 rad) settles in ≈1 s; a
   * 180° turn (π rad) settles in ≈2 s. (The original spec doc claimed
   * "~300 ms" for the auto-turn convergence; that's only true for
   * misalignments under ~25°. Larger pans take proportionally longer.)
   * Once `|headingError| < TURN_DEAD_ZONE` the auto-turn releases.
   * Combined with the camera-relative (forward, strafe) math above,
   * the player visually walks toward the camera-facing point of
   * interest from the first key press.
   *
   * The 2026-05-11 debug session reverted this math to raw player-
   * local-frame WASD because the heading source was always 0 (the
   * wasm eager-WorldState path swallowed local-player KIND_SPAWN, so
   * the 3D rig's quaternion was the identity). Workstream A's new
   * `__sessionHandle.getLocalPlayerPose().heading` export lands the
   * authoritative integrator heading directly. Heading-source
   * priority: (1) `__sessionHandle.getLocalPlayerPose().heading`,
   * (2) `this.getPlayerHeading()` (3D rig quaternion fallback),
   * (3) `0` (north) pre-spawn.
   *
   * Precedence (spec rule #5): manual Q/E overrides auto-turn. When
   * Q or E is held, `turn = sign(qeTurn)` directly, bypassing the
   * auto-turn for that tick. The user expects pressing Q/E to mean
   * "I want to steer right now", not "fight the auto-turn".  Inside
   * the dead zone (|headingError| < TURN_DEAD_ZONE) the auto-turn is
   * 0 anyway, so Q/E flows through unchanged.
   *
   * In topDown mode: WASD is world-fixed (no yaw rotation). W → +Y
   * north, D → +X east. Mirrors the 2D path's top-down convention so
   * the camera-mode switch doesn't reverse the user's spatial
   * expectation. No turn-to-align (camera is rotation-independent).
   *
   * In orbit mode: returns null — orbit is free-look, the player
   * does not move under WASD.
   *
   * Diagonal WASD (W+D) emits forward=±1 AND strafe=±1 simultaneously;
   * we sign-clamp each axis after rotation, we do NOT normalize.
   *
   * Q/E always map to turn = -1/+1 in any mode where motion is sent
   * (follow + topDown). Shift = walk modifier (run-by-default).
   */
  /**
   * A14-I1 movement policy: map RAW keystate-derived tristate axes through
   * the current camera mode, for the shared InputController funnel.
   *
   *   orbit   → null (free-look; movement suppressed)
   *   topDown → world-fixed passthrough (forward=+Y, strafe=+X)
   *   follow  → player-local passthrough
   *
   * This is the policy half of `computeMovementFromKeys` extracted so the
   * single funnel can apply it to a keystate it owns. `computeMovementFromKeys`
   * (the legacy path) still reads `this.keys` directly; both produce identical
   * axes for identical input — the only mode that actually transforms is the
   * (deliberately passthrough today) follow/topDown pair, so this is a pure
   * suppression gate plus sign-clamp. Kept tiny on purpose for Stage I1.
   *
   * @param {{forward:number,strafe:number,turn:number,run:boolean}} raw
   */
  _movementPolicy(raw) {
    if (this.mode === "orbit") return null;
    // follow + topDown both consume player-local-frame intent directly today
    // (camera-relative + auto-turn math was removed in the Cohere-D Phase 1
    // pass; see computeMovementFromKeys). Sign-clamp is applied by the
    // controller; return the raw axes unchanged.
    return {
      forward: raw.forward,
      strafe: raw.strafe,
      turn: raw.turn,
      run: raw.run,
    };
  }

  computeMovementFromKeys() {
    if (this.mode === "orbit") {
      // Orbit suppresses movement. Caller should NOT call
      // setMovementInput in this mode.
      return null;
    }
    const k = this.keys;
    const inputForward = (k.w ? 1 : 0) - (k.s ? 1 : 0);
    const inputStrafe = (k.d ? 1 : 0) - (k.a ? 1 : 0);
    const qeTurn = (k.e ? 1 : 0) - (k.q ? 1 : 0);
    // A14-I3: Shift XOR ToggleRun option under ?retailRunKeys=on;
    // flag-off = legacy !shift (byte-identical).
    const run = resolveRunModifier(k.shift, this._getSessionHandle?.());

    if (this.mode === "topDown") {
      // World-fixed (no yaw rotation). Forward = +Y, strafe = +X.
      return {
        forward: clampSign(inputForward),
        strafe: clampSign(inputStrafe),
        turn: clampSign(qeTurn),
        run,
      };
    }

    // Follow mode — Phase 1 (Cohere-D follow-on, 2026-05-12):
    // hard-disabled mouse-influence-on-movement. WASD now drives in
    // the player's local body frame; mouse moves the camera only. The
    // character does not auto-turn to face the camera, and the
    // camera's yaw does NOT redirect the W/A/S/D intent vector.
    //
    // Removed (vs Workstream D's original 2026-05-11 implementation):
    //   - Camera-yaw rotation of (inputForward, inputStrafe) to a
    //     world-axis intent vector (`worldDx`, `worldDy`).
    //   - Player-heading rotation to a player-local frame.
    //   - Auto-turn-to-align (driving player heading toward
    //     `followYaw` while WASD held).
    //
    // ACE's `setMovementInput(forward, strafe, turn, run)` consumes
    // player-local-frame intent directly — forward=+1 means "walk
    // forward in the player's facing direction" regardless of camera
    // angle. The keystate (k.w/k.a/k.s/k.d/k.q/k.e) IS that intent;
    // no transform needed.
    //
    // Restore reference if mouse-influenced movement comes back as a
    // deliberate feature later: commit f7c4ae4 (last camera.js
    // touching this) carried the camera-relative + auto-turn math at
    // approximately camera.js:1144-1212.
    //
    // Phase 2 / Cohere-D will fix the wasm integrator gate that
    // currently drops strafe + turn inputs — at that point A/D and
    // Q/E start producing visible motion. This Phase 1 change is
    // forward-compatible: the keystate is already shaped correctly,
    // it just doesn't reach the integrator's strafe/turn paths.
    return {
      forward: clampSign(inputForward),
      strafe: clampSign(inputStrafe),
      turn: clampSign(qeTurn),
      run,
    };
  }

  _dispatchMovement() {
    const handle = this._getSessionHandle();
    if (!handle || typeof handle.setMovementInput !== "function") {
      return;
    }
    const m = this.computeMovementFromKeys();
    if (!m) {
      // Orbit suppression. Issue 5 (2026-06-03): the rig must not freeze on
      // the last locomotion clip when the user toggles into orbit mid-stride.
      // Dispatch Ready ONCE on the transition into orbit (guarded by
      // _orbitRigStopped so it does not re-fire every frame), then bail.
      if (!this._orbitRigStopped) {
        this._orbitRigStopped = true;
        // 0x41000003 = Ready (stop → idle), same constant as the idle branch
        // in _dispatchLocalRigMotion below.
        this._dispatchLocalRigMotion({ forward: 0, strafe: 0, turn: 0, run: true });
        // Force the next non-orbit dispatch to re-fire even if the keystate
        // signature is unchanged, since the rig is now parked on Ready.
        this.lastRigMotionSig = null;
        // ...and clear lastInputSig too. The `if (sig === this.lastInputSig)
        // return` gate below runs BEFORE the rig re-dispatch, so leaving it set
        // makes the orbit→follow re-press (same key still held) early-return
        // and the rig re-dispatch the lastRigMotionSig=null reset above was
        // written to trigger is never reached — the avatar then slides forward
        // in the idle pose. Nulling both forces the one re-dispatch intended.
        this.lastInputSig = null;
      }
      return;
    }
    this._orbitRigStopped = false;
    const sig = `${m.forward},${m.strafe},${m.turn},${m.run}`;
    if (sig === this.lastInputSig) return;
    if (this._inputFunnelOn) {
      // A14-I1 (?inputFunnel=on): route the SINGLE `setMovementInput` call
      // through the shared InputController so the index.html rAF dispatcher
      // and this camera dispatcher dedupe against ONE shared signature (no
      // cross-site stomp). The controller already applied this camera's
      // policy (orbit-suppress handled above via `m === null`), so pass the
      // resolved axes straight through. The local-rig animation side-effect
      // below still fires off `sig` — only the wasm boundary moved.
      try {
        const ctrl = getInputController();
        ctrl.dispatch(handle, m);
        this.lastInputSig = sig;
        this.setMovementInputCount += 1;
      } catch (e) {
        if (!this._dispatchWarned) {
          this._dispatchWarned = true;
          // eslint-disable-next-line no-console
          console.warn("[cameraSwitcher] funnel dispatch rejected:", String(e?.message ?? e));
        }
      }
    } else {
      try {
        handle.setMovementInput(m.forward, m.strafe, m.turn, m.run);
        this.lastInputSig = sig;
        this.setMovementInputCount += 1;
      } catch (e) {
        // Wasm side rejects pre-EnteredWorld; that's fine, the keystate
        // change will be retried on the next press.
        // eslint-disable-next-line no-console
        if (!this._dispatchWarned) {
          this._dispatchWarned = true;
          console.warn("[cameraSwitcher] setMovementInput rejected:", String(e?.message ?? e));
        }
      }
    }
    // 2026-06-03 — drive the LOCAL player rig's locomotion ANIMATION. ACE does
    // not echo the local player's own UpdateMotion back (the client predicts its
    // own motion), so without this the local rig sits on the idle/Ready clip
    // (cmd 0x0) while running. Mirror the jump dispatch (index.html:~8389): map
    // the movement intent to a MotionCommand and feed the rig via
    // entityManager.setMotion. Issue 6 (2026-06-03): gate the rig dispatch on its
    // OWN signature (lastRigMotionSig) rather than lastInputSig — lastInputSig
    // only advances on setMovementInput SUCCESS, so coupling the rig path to it
    // would let the rig re-dispatch every frame in the pre-EnteredWorld window
    // where setMovementInput throws. setMotion is idempotent on (cmd, stance), so
    // this is behaviorally identical once in-world.
    if (sig !== this.lastRigMotionSig) {
      this.lastRigMotionSig = sig;
      this._dispatchLocalRigMotion(m);
    }
  }

  /**
   * Map player-local movement intent → primary locomotion MotionCommand and
   * dispatch it to the local player's rig. Forward dominates (a diagonal
   * run+strafe plays the run cycle); then strafe; then turn-in-place; else
   * Ready (stop → idle). Constants per the motion-interp deep dive.
   */
  _dispatchLocalRigMotion(m) {
    const em = this.scene3d && this.scene3d.entityManager;
    if (!em || typeof em.setMotion !== "function") return;
    const lpgFn = (typeof window !== "undefined") ? window.getLocalPlayerGuid : null;
    const localGuid = typeof lpgFn === "function" ? lpgFn() : null;
    if (localGuid == null) return;
    const g = localGuid >>> 0;
    // F15-3 (2026-06-27, ?localRigCombo=on) — compose the local rig from
    // INDEPENDENT forward + sidestep slots (retail CMotionInterp drives
    // forward/sidestep/turn commands concurrently, acclient.c:344147) instead of
    // the single dominant clip below. Fixes (a) BACKWARD: emit WalkForward at
    // motionSpeed -1 so the default-on ?signedMotionSpeed plays the forward clip
    // in REVERSE (retail WalkBackwards = WalkForward negated, acclient.c:343746)
    // — the legacy path sent the distinct WalkBackwards cmd at +1.0, which never
    // triggers the reverse; and (b) COMBINATIONAL: layer the additive sidestep
    // blend (setSidestepLayer) over the forward/backward base so backward-left /
    // forward-right diagonals animate both axes instead of collapsing to one
    // clip. Left-vs-right strafe reverse + a dedicated turn slot stay follow-ons
    // (setSidestepLayer collapses Left→Right; matches the F15-2 deferral).
    // DEFAULT-ON (validated 2026-06-27 on the local rig: backward→motionSign −1,
    // backward-left→sign −1 + sidestep slot 0x6500000f; `=off` escape). Lazy
    // module-once flag read.
    if (this._localRigCombo === undefined) {
      try {
        this._localRigCombo = typeof window !== "undefined" &&
          new URLSearchParams(window.location.search).get("localRigCombo") !== "off";
      } catch (_) { this._localRigCombo = false; }
    }
    if (this._localRigCombo) {
      let fwdCmd, fwdSpeed = 1.0;
      if (m.forward > 0) { fwdCmd = m.run ? 0x44000007 : 0x45000005; }   // Run / Walk Forward
      else if (m.forward < 0) { fwdCmd = 0x45000005; fwdSpeed = -1.0; }  // WalkForward reversed
      else if (m.strafe !== 0) { fwdCmd = 0x41000003; }                 // idle base under a pure strafe
      else if (m.turn > 0) { fwdCmd = 0x6500000d; }                     // TurnRight
      else if (m.turn < 0) { fwdCmd = 0x6500000e; }                     // TurnLeft
      else { fwdCmd = 0x41000003; }                                     // Ready (stop → idle)
      const sideCmd = m.strafe !== 0 ? 0x6500000f : 0;                  // SideStepRight (layer collapses L→R)
      const sideSpeed = m.strafe < 0 ? -1.0 : 1.0;
      let stanceC = 0x8000003d;                                         // NonCombat fallback
      try { if (typeof em.getStance === "function") { const s = (em.getStance(g) >>> 0); if (s) stanceC = s; } } catch (_) {}
      try {
        em.setMotion(g, fwdCmd, stanceC, fwdSpeed);
        if (typeof em.setSidestepLayer === "function") em.setSidestepLayer(g, sideCmd, stanceC, sideSpeed);
      } catch (e) {
        if (!this._rigDispatchWarned) {
          this._rigDispatchWarned = true;
          console.warn("[cameraSwitcher] local-rig combo setMotion failed:", String(e?.message ?? e));
        }
      }
      return;
    }
    let cmd;
    if (m.forward > 0) cmd = m.run ? 0x44000007 : 0x45000005;   // Run / Walk Forward
    else if (m.forward < 0) cmd = 0x45000006;                   // WalkBackwards
    // Issue 4 (2026-06-03): pure sidestep is dispatched here as the FORWARD
    // command via setMotion (a full-weight clip swap), NOT via
    // entityManager.setSidestepLayer (a 0.5-weight additive blend layered over
    // a forward base clip). As a result _resolveStateGroundSpeed reads sidestep
    // from inst._sidestepCommand (entities.js:~4421), which only setSidestepLayer
    // populates — so the velScale getter returns null for a camera-dispatched
    // pure strafe and the cycleTimeScale falls back to the (no-op) rig-XZ EMA.
    // This is HARMLESS: sidestep |velocity|≈0, so the EMA-derived cycleTimeScale
    // no-ops anyway. We deliberately do NOT route through setSidestepLayer: that
    // is a visible-animation change (additive blend vs. full clip swap) that
    // cannot be validated without a GPU eye-test.
    else if (m.strafe > 0) cmd = 0x6500000f;                    // SideStepRight
    else if (m.strafe < 0) cmd = 0x65000010;                    // SideStepLeft
    else if (m.turn > 0) cmd = 0x6500000d;                      // TurnRight
    else if (m.turn < 0) cmd = 0x6500000e;                      // TurnLeft
    else cmd = 0x41000003;                                      // Ready (stop → idle)
    let stance = 0x8000003d;                                    // NonCombat fallback
    // getStance failure is benign — fall through to the NonCombat default.
    try { if (typeof em.getStance === "function") { const s = (em.getStance(g) >>> 0); if (s) stance = s; } } catch (_) {}
    try {
      em.setMotion(g, cmd, stance);
    } catch (e) {
      // Issue 8 (2026-06-03): surface a real setMotion failure ONCE (the jump
      // path logs its dispatch errors; this path previously swallowed them).
      // Mirror the _dispatchWarned latch above so a genuine fault is visible
      // without per-frame console spam.
      // eslint-disable-next-line no-console
      if (!this._rigDispatchWarned) {
        this._rigDispatchWarned = true;
        console.warn("[cameraSwitcher] local-rig setMotion failed:", String(e?.message ?? e));
      }
    }
  }

  // ---- listeners ----------------------------------------------------

  _installKeyListeners() {
    if (typeof document === "undefined") return;
    const movementKeys = new Set(["w", "a", "s", "d", "q", "e"]);
    const isTypingInForm = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const onKeyDown = (ev) => {
      if (isTypingInForm()) return;
      const k = (ev.key || "").toLowerCase();
      if (movementKeys.has(k)) {
        this.keys[k] = true;
        // Don't preventDefault — let other paths (2D) still see WASD.
        return;
      }
      if (ev.key === "Shift") {
        this.keys.shift = true;
        return;
      }
      // A12-C2 (?retailCamZoom=on): PageUp = closer (zoom in), PageDown =
      // farther — the plan's keyboard half of the wheel continuum. The
      // retail binds are CameraCloser/CameraFarther latches
      // (acclient.c:146992-147110); the PageUp/PageDown assignment is our
      // choice (documented, no DAT keymap claim). preventDefault stops the
      // browser page-scroll.
      if (this._retailZoomOn && this.mode === "follow") {
        if (ev.key === "PageUp") {
          this._retailZoomNotch(-1);
          ev.preventDefault();
        } else if (ev.key === "PageDown") {
          this._retailZoomNotch(1);
          ev.preventDefault();
        }
      }
    };
    const onKeyUp = (ev) => {
      const k = (ev.key || "").toLowerCase();
      if (movementKeys.has(k)) {
        this.keys[k] = false;
      } else if (ev.key === "Shift") {
        this.keys.shift = false;
      }
    };
    const onBlur = () => {
      for (const key of Object.keys(this.keys)) this.keys[key] = false;
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    if (typeof window !== "undefined") {
      window.addEventListener("blur", onBlur);
      this._globalListeners.push(["blur", onBlur, window]);
    }
    this._globalListeners.push(["keydown", onKeyDown, document]);
    this._globalListeners.push(["keyup", onKeyUp, document]);

    // Wheel zoom for top-down mode.
    if (this.domElement) {
      const onWheel = (ev) => {
        // A12-C2 (?retailCamZoom=on): wheel drives the follow-mode zoom
        // continuum. deltaY > 0 (wheel toward user) = farther, matching
        // the topDown branch's zoom-out convention below.
        if (this.mode === "follow") {
          if (this._retailZoomOn) {
            this._retailZoomNotch(ev.deltaY > 0 ? 1 : -1);
          }
          return;
        }
        if (this.mode !== "topDown") return;
        const factor = ev.deltaY > 0 ? 1 / 1.15 : 1.15;
        const next = this.ortho.zoom * factor;
        if (next < TOPDOWN_ZOOM_MIN || next > TOPDOWN_ZOOM_MAX) return;
        this.ortho.zoom = next;
        this.ortho.updateProjectionMatrix();
      };
      this.domElement.addEventListener("wheel", onWheel, { passive: true });
      this._globalListeners.push(["wheel", onWheel, this.domElement]);
    }
  }

  _installModeToggle() {
    if (typeof document === "undefined") return;
    const isTypingInForm = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const onKeyDown = (ev) => {
      if (isTypingInForm()) return;
      if ((ev.key || "").toLowerCase() === "c") {
        const idx = CAMERA_MODES.indexOf(this.mode);
        const next = CAMERA_MODES[(idx + 1) % CAMERA_MODES.length];
        this.switchMode(next);
        // eslint-disable-next-line no-console
        console.log(`[cameraSwitcher] mode → ${next}`);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    this._globalListeners.push(["keydown", onKeyDown, document]);
  }

  // ---- helpers ------------------------------------------------------

  _safePlayerPos() {
    try {
      const p = this.getPlayerWorldPos?.();
      if (p && typeof p.x === "number" && typeof p.y === "number") {
        return { x: p.x, y: p.y, z: typeof p.z === "number" ? p.z : 80 };
      }
    } catch (_) {}
    // Pre-spawn neutral fallback (Holtburg no longer special). Only reached if
    // getPlayerWorldPos throws/returns nothing before the first Spawn lands; the
    // live player rig wins immediately after.
    return { x: 0, y: 0, z: 80 };
  }

  // ---- teardown -----------------------------------------------------

  dispose() {
    // A12-C2: never leave the local player ghosted past camera teardown.
    if (this._retailZoomOn) {
      try { this._applyCameraPlayerFade(1.0); } catch (_) {}
    }
    if (this.controls && typeof this.controls.dispose === "function") {
      try { this.controls.dispose(); } catch (_) {}
    }
    this.controls = null;
    // C1 split: free BOTH the per-mode listeners and the page-global
    // input listeners. dispose() is page-teardown, not a mode change, so
    // (unlike switchMode) it must drop the global handlers too.
    for (const [type, fn, target] of [...this._listeners, ...this._globalListeners]) {
      try {
        target.removeEventListener(type, fn);
      } catch (_) {}
    }
    this._listeners = [];
    this._globalListeners = [];
  }
}
