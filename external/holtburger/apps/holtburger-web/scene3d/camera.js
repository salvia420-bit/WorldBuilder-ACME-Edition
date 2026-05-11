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
// over a handful of ticks. Once `|headingError| < TURN_DEAD_ZONE`
// the auto-turn releases and Q/E manual turn takes precedence again.
// Combined with the existing camera-relative (forward, strafe) math,
// the player visually walks in the camera-facing direction even
// before the heading has aligned: the wasm-side (forward, strafe)
// is still rotated by `followYaw`, and the new `turn` delta closes
// the heading gap. Once `playerHeading == followYaw`, the per-tick
// forward/strafe values are stable and only `turn` flickers — the
// integrator settles within a few hundred ms of pure forward motion.
// Precedence rule: Q/E intent ADDS to the auto-turn outside the dead
// zone (so the user can override the auto-turn by holding Q or E)
// but the result is still sign-clamped to -1/0/+1. Inside the dead
// zone Q/E behaves as before.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { acToThree } from "./adapter.js";

/** Mode-cycle order on `C` press: follow → orbit → topDown → follow. */
export const CAMERA_MODES = ["follow", "orbit", "topDown"];

/** Pitch clamp (radians) for follow camera. 0 = level horizon; +π/2 = straight down. */
const FOLLOW_PITCH_MIN = 0.1;
const FOLLOW_PITCH_MAX = 1.4;

/** Mouse-look sensitivity (radians per pixel) for follow PointerLock. */
const POINTER_YAW_SENS = 0.0025;
const POINTER_PITCH_SENS = 0.0020;

/** Top-down ortho view: metres visible vertically at zoom=1. */
const TOPDOWN_FRUSTUM_HEIGHT_M = 100.0;
const TOPDOWN_HEIGHT_M = 300.0;
const TOPDOWN_ZOOM_MIN = 0.2;
const TOPDOWN_ZOOM_MAX = 8.0;

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

    // Listeners registered for cleanup in `dispose()`.
    this._listeners = [];

    this._installKeyListeners();
    this._installModeToggle();

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

    this.mode = next;
    if (next === "follow") {
      // PointerLockControls steers followYaw/followPitch on mousemove
      // when the pointer is locked. We install onmousemove + lock on
      // click manually because PointerLockControls' default behaviour
      // (.lock() on click) sometimes races initial canvas focus.
      if (this.domElement) {
        try {
          const plc = new PointerLockControls(this.persp, this.domElement);
          this.controls = plc;
          // PointerLockControls fires a `mousemove`-equivalent via
          // its own internal listener — but we want to steer
          // followYaw/followPitch (not the camera object directly,
          // since the per-tick positionCamera() recomputes from
          // these). Hook into mousemove on document while locked.
          const onMove = (ev) => {
            if (!plc.isLocked) return;
            const mx = ev.movementX || 0;
            const my = ev.movementY || 0;
            // Standard FPS mouse-look convention: mouse-right turns the
            // camera right (yaw increases in our clockwise-from-north
            // followYaw frame), mouse-down looks down (pitch increases).
            // Inverted from Phase 7.5's original sign so users without
            // the "invert X" preference get the expected feel.
            this.followYaw += mx * POINTER_YAW_SENS;
            this.followPitch += my * POINTER_PITCH_SENS;
            // Clamp pitch to keep camera from flipping over.
            if (this.followPitch < FOLLOW_PITCH_MIN)
              this.followPitch = FOLLOW_PITCH_MIN;
            if (this.followPitch > FOLLOW_PITCH_MAX)
              this.followPitch = FOLLOW_PITCH_MAX;
          };
          if (typeof document !== "undefined") {
            document.addEventListener("mousemove", onMove);
            this._listeners.push(["mousemove", onMove, document]);
          }
          // Click-to-lock: grab pointer when user clicks the canvas.
          const onClick = () => {
            if (this.mode === "follow" && !plc.isLocked) {
              try { plc.lock(); } catch (_) {}
            }
          };
          if (this.domElement) {
            this.domElement.addEventListener("click", onClick);
            this._listeners.push(["click", onClick, this.domElement]);
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("[cameraSwitcher] PointerLockControls init failed:", e);
        }
      }
      this.activeCamera = this.persp;
    } else if (next === "orbit") {
      // OrbitControls maintains its own target + handles mouse
      // drag/wheel internally. We tick `controls.update()` each frame
      // and set `.target` to the player's world pos so the camera
      // tracks when the player moves.
      if (this.domElement) {
        try {
          const oc = new OrbitControls(this.persp, this.domElement);
          oc.enableDamping = true;
          oc.dampingFactor = 0.08;
          oc.target.set(0, 0, 0);
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
      const p = this._safePlayerPos();
      this.persp.position.set(p.x + 8, p.y - 12, p.z + 8);
      this.persp.lookAt(p.x, p.y, p.z);
      this.activeCamera = this.persp;
    } else if (next === "topDown") {
      // Ortho top-down. activeCamera flips to the ortho instance.
      // No controller — wheel zooms via the keystate listener; pan
      // is implicit (the camera follows the player).
      this.activeCamera = this.ortho;
    }
  }

  // ---- per-rAF tick -------------------------------------------------

  /**
   * Per-frame update. Driven from `loop.js` `tickPerFrame`.
   * - Positions the active camera.
   * - Computes movement input from keystate + camera yaw and forwards
   *   to `sessionHandle.setMovementInput` on change.
   * - Calls `controls.update()` for OrbitControls damping (no-op for
   *   other modes).
   */
  tick(dt) {
    this.positionCamera(dt);
    if (this.controls && typeof this.controls.update === "function") {
      try {
        this.controls.update();
      } catch (_) {}
    }
    this._dispatchMovement();
  }

  // ---- camera positioning ------------------------------------------

  positionCamera(_dt) {
    const p = this._safePlayerPos();
    if (this.mode === "follow") {
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
      const cx = p.x - forwardX * horizDist;
      const cy = p.y - forwardY * horizDist;
      // Camera height: lift well above the player so Holtburg's terrain
      // doesn't clip the camera into a hillside. Without a wasm-side
      // heightmap lookup at the camera's XY, the cheap fix is a fixed
      // ~8 m lift — enough to clear typical landblock relief. The pitch
      // already tilts the camera down to keep the player framed.
      const cz = p.z + vertDist + 8.0;
      this.persp.position.set(...acToThree(cx, cy, cz));
      // Look at the player's head (z + 1.6 ≈ eye height).
      this.persp.lookAt(...acToThree(p.x, p.y, p.z + 1.6));
    } else if (this.mode === "orbit") {
      // OrbitControls owns position. We only retarget. Damping in
      // .update() smooths the target slide. Target is in three.js
      // world coords (camera lives outside worldRoot), so apply the
      // acToThree mapping.
      if (this.controls && this.controls.target) {
        this.controls.target.set(...acToThree(p.x, p.y, p.z + 1.0));
      }
    } else if (this.mode === "topDown") {
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

  // ---- input → movement conversion (load-bearing math) -------------

  /**
   * Camera-relative WASD → wasm setMovementInput contract.
   *
   * In follow mode: rotate intent vector by `followYaw` to produce
   * world-axis (forward, strafe). At yaw=0 this is the identity
   * (W → forward=+1; D → strafe=+1). At yaw=π/2 the camera is facing
   * AC +X (east), so W (camera-forward) should produce world-east
   * motion, which is strafe=+1 in world-fixed terms.
   *
   * **Follow-on #2 (2026-05-10) — turn-to-align.** ACE's MovementSystem
   * consumes (forward, strafe) in the player's LOCAL frame, not world.
   * So the camera-relative `forward = clampSign(worldDy)` form only
   * walks the player along the camera-facing direction once
   * `playerHeading == followYaw`. To converge on alignment, we emit
   * `turn = sign(followYaw - playerHeading)` while WASD is held; ACE
   * rotates the player heading ~3.5 rad/s, so within ~300 ms (about 6
   * rAF ticks at 50 ms each) the player's heading lands inside the
   * `TURN_DEAD_ZONE` and the walking direction stabilises. Combined
   * with the camera-relative (forward, strafe) math, the player
   * visually walks toward the camera-facing point of interest from the
   * first key press — the path curves slightly until alignment, then
   * goes straight. Auto-turn only fires when WASD is held; idle Q/E
   * still drives the manual turn unchanged.
   *
   * Precedence: Q/E intent is ADDED to the auto-turn delta and the
   * sum is sign-clamped. So holding Q (left) while auto-turn is +1
   * (right) cancels out → turn=0 — the user wins. Inside the dead
   * zone the auto-turn is 0 and Q/E is the only contributor.
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
    const run = !k.shift;

    if (this.mode === "topDown") {
      // World-fixed (no yaw rotation). Forward = +Y, strafe = +X.
      return {
        forward: clampSign(inputForward),
        strafe: clampSign(inputStrafe),
        turn: clampSign(qeTurn),
        run,
      };
    }

    // Follow mode — raw WASD in the player's local frame, matching the
    // 2D path (index.html:6219-6235). The Phase 7.5 design rotated
    // intent through `followYaw` and used an auto-turn that read
    // `getLocalPlayerHeading()` to align the player with the camera,
    // but the wasm eager-WorldState path never spawns the local-player
    // rig in the 3D EntityManager, so `getLocalPlayerHeading()` always
    // falls back to 0. That makes every WASD axis flip whenever the
    // actual player heading isn't 0 — exactly what users see after a
    // teleport (W→S, A↔D, mouse pan inverted). Drop the world-rotation
    // entirely and let Q/E manual-turn the player as in retail AC.
    // The camera still tracks the player's POSITION; orientation just
    // doesn't auto-couple anymore until the wasm side gains a
    // KIND_SPAWN emission for the eager-path local player.
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
    if (!m) return; // orbit suppression
    const sig = `${m.forward},${m.strafe},${m.turn},${m.run}`;
    if (sig === this.lastInputSig) return;
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
      this._listeners.push(["blur", onBlur, window]);
    }
    this._listeners.push(["keydown", onKeyDown, document]);
    this._listeners.push(["keyup", onKeyUp, document]);

    // Wheel zoom for top-down mode.
    if (this.domElement) {
      const onWheel = (ev) => {
        if (this.mode !== "topDown") return;
        const factor = ev.deltaY > 0 ? 1 / 1.15 : 1.15;
        const next = this.ortho.zoom * factor;
        if (next < TOPDOWN_ZOOM_MIN || next > TOPDOWN_ZOOM_MAX) return;
        this.ortho.zoom = next;
        this.ortho.updateProjectionMatrix();
      };
      this.domElement.addEventListener("wheel", onWheel, { passive: true });
      this._listeners.push(["wheel", onWheel, this.domElement]);
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
    this._listeners.push(["keydown", onKeyDown, document]);
  }

  // ---- helpers ------------------------------------------------------

  _safePlayerPos() {
    try {
      const p = this.getPlayerWorldPos?.();
      if (p && typeof p.x === "number" && typeof p.y === "number") {
        return { x: p.x, y: p.y, z: typeof p.z === "number" ? p.z : 80 };
      }
    } catch (_) {}
    // Holtburg centre fallback.
    return {
      x: 0xa9 * 192 + 96,
      y: 0xb4 * 192 + 96,
      z: 80,
    };
  }

  // ---- teardown -----------------------------------------------------

  dispose() {
    if (this.controls && typeof this.controls.dispose === "function") {
      try { this.controls.dispose(); } catch (_) {}
    }
    this.controls = null;
    for (const [type, fn, target] of this._listeners) {
      try {
        target.removeEventListener(type, fn);
      } catch (_) {}
    }
    this._listeners = [];
  }
}
