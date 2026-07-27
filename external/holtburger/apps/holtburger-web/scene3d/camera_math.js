// A12-C2/C3 (2026-06-12, unification survey) — pure retail camera math.
//
// Extracted into an import-free module so the unit halves run headless
// under plain node (tests/camera_retail_math.test.cjs) — camera.js pulls
// three.js + OrbitControls and can't be imported outside the browser.
//
// Every constant and formula below is cited against the retail decomp
// (~/ac-headers/acclient.c). camera.js consumes these behind the
// default-off flags `?retailCamZoom=on` (C2) / `?camStiffness=` /
// `?mouseSmooth=` (C3); with the flags off none of this code runs.

// ---- C2: retail zoom continuum -------------------------------------------

/**
 * `CameraManager::m_rCameraAdjustmentSpeed` default — set in the
 * CameraManager ctor (acclient.c:147921, raw 1109393408 = 40.0f).
 */
export const RETAIL_CAM_ADJUST_SPEED = 40.0;

/**
 * Retail Closer/Farther run per-frame while the latch is held, scaling
 * viewer_offset by `1 ∓ dt * adjustSpeed * 0.2` (Closer acclient.c:149014-
 * 149020, Farther acclient.c:149105-149111). Our zoom input is per-EVENT
 * (a wheel notch / a PageUp press), so we map ONE notch to ONE retail
 * frame at a nominal 60 Hz dt. Conservative choice, documented:
 * per-notch factor = 1 ∓ 40 * (1/60) * 0.2 = 1 ∓ 0.1333…
 */
export const RETAIL_ZOOM_NOTCH_DT = 1 / 60;
export const RETAIL_ZOOM_IN_FACTOR =
  1 - RETAIL_CAM_ADJUST_SPEED * RETAIL_ZOOM_NOTCH_DT * 0.2;
export const RETAIL_ZOOM_OUT_FACTOR =
  1 + RETAIL_CAM_ADJUST_SPEED * RETAIL_ZOOM_NOTCH_DT * 0.2;

/**
 * Closer refuses to shrink the offset below radius 0.5 m
 * (acclient.c:149023 `sqrt(...) >= 0.5`). Retail reaches first person via
 * the separate SetInHead keybind (acclient.c:146997 → 149230); per the
 * A12-C2 plan we instead COLLAPSE to in-head when a zoom-in step would
 * cross the 0.5 floor — the "zoom continuum" UX.
 */
export const RETAIL_ZOOM_MIN_RADIUS = 0.5;

/**
 * Farther refuses offsets beyond |x|,|y| ≤ 10 (z ≤ 450 is the map-mode
 * raise; our follow offset is a behind-the-player scalar so the 10 m
 * horizontal clamp is the binding one) — acclient.c:149119.
 */
export const RETAIL_ZOOM_MAX_RADIUS = 10.0;

/**
 * In-head viewer_offset is (0, 0.18, 0): 0.18 m in FRONT of the pivot
 * (CameraSet::SetInHead acclient.c:149230-149262; InHead test
 * acclient.c:148094 compares against 0.18000001).
 */
export const IN_HEAD_FORWARD_M = 0.18;

/** `CAMERA_DEFAULT_PIVOT_Z` — acclient.c:39550. */
export const CAMERA_DEFAULT_PIVOT_Z = 1.5;

/**
 * Farther FROM in-head jumps straight to viewer_offset (0, -0.6, 0.5)
 * (acclient.c:149093 packed const 4539628427595585946 = f32 pair
 * y=-0.6, z=0.5) after re-seating the pivot at CAMERA_DEFAULT_PIVOT_Z.
 * Our scalar follow-distance equivalent is the offset's radius.
 */
export const IN_HEAD_EXIT_RADIUS = Math.hypot(0.6, 0.5); // ≈ 0.781 m

/**
 * `CAMERA_MOUSELOOK_LIMIT` (acclient.c:39549): in-head look-direction z
 * is clamped to ±0.8 (Raise/Lower bodies, acclient.c:148398-148409).
 */
export const IN_HEAD_DIR_Z_CLAMP = 0.8;

/**
 * One retail-style zoom step over a scalar follow radius.
 *
 * @param {{radius:number, inHead:boolean}} state current zoom state
 * @param {number} dir -1 = closer (zoom in), +1 = farther (zoom out)
 * @returns {{radius:number, inHead:boolean}} next state (input not mutated)
 *
 * Semantics (all cited above):
 *  - closer while in-head: no-op (retail Closer early-outs on the exact
 *    in-head offset, acclient.c:149006).
 *  - closer crossing the 0.5 floor: collapse to in-head, radius kept for
 *    bookkeeping (retail refuses the step; the collapse is the C2 plan's
 *    continuum choice).
 *  - farther from in-head: leave in-head at IN_HEAD_EXIT_RADIUS
 *    (acclient.c:149093-149097).
 *  - farther beyond 10 m: refused, radius unchanged (acclient.c:149119
 *    skips the apply entirely when the clamp trips).
 */
export function retailZoomStep(state, dir) {
  const radius = state.radius;
  if (dir < 0) {
    if (state.inHead) return { radius, inHead: true };
    const next = radius * RETAIL_ZOOM_IN_FACTOR;
    if (next < RETAIL_ZOOM_MIN_RADIUS) return { radius, inHead: true };
    return { radius: next, inHead: false };
  }
  if (state.inHead) {
    return { radius: IN_HEAD_EXIT_RADIUS, inHead: false };
  }
  const next = radius * RETAIL_ZOOM_OUT_FACTOR;
  if (next > RETAIL_ZOOM_MAX_RADIUS) return { radius, inHead: false };
  return { radius: next, inHead: false };
}

// ---- C2: player near-fade --------------------------------------------------

export const NEAR_FADE_OUTER_M = 0.45; // acclient.c:149195 (0.44999999)
export const NEAR_FADE_INNER_M = 0.2;  // acclient.c:149206

/**
 * Player opacity for a camera-to-pivot distance `d` (third person).
 * Retail (CameraSet::UpdateCamera, acclient.c:149190-149216) sets
 * translucency `t = 1 - (0.2 - d) / (0.2 - 0.45)` clamped to [0,1] when
 * d < 0.45, i.e. opacity = (d - 0.2) / 0.25:
 *   d ≥ 0.45 → 1.0 (opaque); d = 0.2 → 0.0 (invisible); linear between.
 * In-head retail sets translucency 1.0 = fully INVISIBLE
 * (acclient.c:149187 SetTranslucencyHierarchical(player, 1.0)) — note the
 * A12 report's "opaque in-head" phrasing misread the decomp; translucency
 * 1.0 hides the player so you don't see your own head. Callers pass
 * opacity 0 for in-head.
 */
export function nearFadeOpacity(d) {
  if (!(d < NEAR_FADE_OUTER_M)) return 1.0;
  const o = (d - NEAR_FADE_INNER_M) / (NEAR_FADE_OUTER_M - NEAR_FADE_INNER_M);
  return o < 0 ? 0.0 : (o > 1 ? 1.0 : o);
}

// ---- C3: stiffness smoothing -----------------------------------------------

/**
 * Per-frame interpolation fraction toward the sought camera frame:
 * `frac = stiffness * quantum * 10`, clamped to 1; stiffness within
 * 2e-4 of 1.0 snaps outright (CameraManager::UpdateCamera,
 * acclient.c:147796-147825 — the `<= 1.0 - 0.00019999999` guard).
 */
export function stiffnessFrac(stiffness, dt) {
  if (!(stiffness > 0) || !(dt > 0)) return 1.0;
  if (stiffness > 1.0 - 0.0002) return 1.0;
  const frac = stiffness * dt * 10.0;
  return frac > 1.0 ? 1.0 : frac;
}

/**
 * Origin early-out distance: retail skips the interpolated frame when the
 * result is within 2*2e-4 m of the sought frame and the rotation is
 * `close_rotation` within F_EPSILON_37 (acclient.c:147845-147853). We
 * only need the origin half (three.js quaternion slerp converges on its
 * own); exported for the camera's snap check.
 */
export const STIFFNESS_SNAP_DIST_M = 0.0004;

/**
 * Ours-only guard (documented deviation): a teleport jumps the sought
 * frame by hundreds of metres; retail's stiffness camera would swoosh
 * across the world. Snap when the camera is further than this from the
 * sought position.
 */
export const STIFFNESS_TELEPORT_SNAP_M = 50.0;

// ---- C3: mouse-look filter --------------------------------------------------

/**
 * `CameraSet::FilterMouseInput` (acclient.c:148138-148163), exact decomp
 * transliteration:
 *   - if (now - lastTime) ≤ 0.25 s: avg = (lastFiltered + raw) * 0.5,
 *     else avg = raw;
 *   - out = raw * (1 - amount) + avg * amount;
 *   - lastFiltered ← out, lastTime ← now.
 * `state` is a per-camera mutable holder {lastDX, lastDY, lastT}; amount
 * ∈ [0,1] is `m_MouseSmoothingAmount` (?mouseSmooth=). amount=0 is the
 * identity. Operates on RAW deltas BEFORE sensitivity scaling, same as
 * retail (MouseLookHandler filters first, scales after,
 * acclient.c:149300-149303).
 */
export const MOUSE_FILTER_WINDOW_S = 0.25;

export function filterMouseDelta(state, dx, dy, amount, nowSec) {
  let avgX = dx;
  let avgY = dy;
  if (nowSec - state.lastT <= MOUSE_FILTER_WINDOW_S) {
    avgX = (state.lastDX + dx) * 0.5;
    avgY = (state.lastDY + dy) * 0.5;
  }
  const keep = 1.0 - amount;
  const outX = dx * keep + avgX * amount;
  const outY = dy * keep + avgY * amount;
  state.lastDX = outX;
  state.lastDY = outY;
  state.lastT = nowSec;
  return { dx: outX, dy: outY };
}

/** Clamp an in-head view-direction z component to ±CAMERA_MOUSELOOK_LIMIT. */
export function clampInHeadDirZ(z) {
  if (z > IN_HEAD_DIR_Z_CLAMP) return IN_HEAD_DIR_Z_CLAMP;
  if (z < -IN_HEAD_DIR_Z_CLAMP) return -IN_HEAD_DIR_Z_CLAMP;
  return z;
}

// ---- C1: cast facing dead-zone + camera cast-bias (2026-07-12) ------------
//
// Retail/ACE only re-turns a caster toward a targeted-spell target when the
// caster is OUTSIDE `spellcast_max_angle` (Player_Magic.cs IsWithinAngle /
// TurnTo_Magic; PropertyManager default = 20°). Within that band ACE early-
// exits the turn and just casts. Our turn-to-face loop (picking.js
// turnToFaceThenAct) historically early-exited at only 0.05 rad (~2.86°) —
// ~7× tighter — so it turned (and swung the follow camera) for headings ACE
// would have left alone. `?castFacing20=on` widens the client dead-zone to
// ACE's 20° so the client only turns when the server would.

/** Legacy tight turn-to-face early-exit (~2.86°). Flag-OFF behaviour. */
export const FACE_DEADZONE_TIGHT_RAD = 0.05;

/**
 * ACE `spellcast_max_angle` default = 20° (Player_Magic.cs IsWithinAngle,
 * Managers/PropertyManager.cs "retail seemed to default to value of around
 * 20"). 20° = 0.34906585… rad ("~0.349 rad" in the dossier).
 */
export const FACE_DEADZONE_WIDE_RAD = (20 * Math.PI) / 180;

/**
 * Pick the turn-to-face early-exit dead-zone. `castFacing20` true → ACE's
 * 20° band (only turn when the server would); false → legacy 0.05 rad.
 * Pure selection logic pinned by tests/test_c1_facing_camera.cjs.
 */
export function faceDeadzoneRad(castFacing20) {
  return castFacing20 ? FACE_DEADZONE_WIDE_RAD : FACE_DEADZONE_TIGHT_RAD;
}

/**
 * C1 — the per-frame turn-to-face gate DECISION, extracted pure so a unit test
 * can pin it directly (the instrument the `?castFacing20` flag actually gates).
 *
 * `turnDelta` = signed bearing error (rad) between the caster heading and the
 * bearing to the target. `deadzoneRad` = the selected early-exit band
 * (`faceDeadzoneRad(castFacing20)`). `elapsedMs`/`timeoutMs` = the stall-cap so
 * a bad bearing can't loop forever.
 *
 * Returns `{ done, turn }` where `turn ∈ {-1, 0, +1}`:
 *  - inside the dead-zone (|turnDelta| ≤ deadzoneRad) OR past the timeout ⇒
 *    `{ done: true, turn: 0 }` — the caller issues the NEUTRAL
 *    `setMovementInput(0,0,0)` stop and casts; it NEVER issues a turn command.
 *  - otherwise ⇒ `{ done: false, turn: ±1 }` — keep turning toward the target.
 *
 * The load-bearing invariant: `done === true ⇒ turn === 0`. So under
 * `?castFacing20=on` (deadzone = 20°) a bearing error inside 20° yields
 * `turn === 0` — the client issues no turn, matching ACE's `spellcast_max_angle`
 * early-exit. Behaviour-identical to the old inline gate (picking.js).
 */
export function faceTurnStep(turnDelta, deadzoneRad, elapsedMs, timeoutMs) {
  if (Math.abs(turnDelta) <= deadzoneRad || elapsedMs > timeoutMs) {
    return { done: true, turn: 0 };
  }
  return { done: false, turn: turnDelta > 0 ? 1 : -1 };
}

/**
 * Autofollow default truth. The `?autoFollow` reader is `!== "off"`, so
 * autofollow is DEFAULT-ON — absent/any-value ⇒ on, only the literal "off"
 * disables it. (The old camera.js docstring wrongly said "default OFF"; this
 * function is the single source of truth the test pins.)
 */
export function autoFollowDefaultOn(flagVal) {
  return String(flagVal ?? "").toLowerCase() !== "off";
}

/**
 * Camera cast-bias (`?castCamBias=on`) — max fraction to blend the follow
 * lookAt from the player toward the active cast target while a targeted cast
 * is in flight (0 = no bias, 1 = look straight at the target). Kept partial so
 * the player stays framed; the target is only pulled toward center.
 */
export const CAST_CAM_BIAS_MAX = 0.5;

/** Exponential ease rate (per second) for the cast-bias blend in/out. */
export const CAST_CAM_BIAS_RATE = 6.0;

/**
 * How long a single `setCastBiasTarget` call holds before it self-expires and
 * the lookAt lerps back (covers the turn + windup of a normal cast).
 */
export const CAST_CAM_BIAS_TTL_MS = 2200;

/**
 * Advance the cast-bias blend amount one frame toward its goal (1 while a cast
 * is active, 0 otherwise) with an exponential ease. Pure — pinned by tests.
 */
export function castBiasStep(amt, active, dt, rate = CAST_CAM_BIAS_RATE) {
  const goal = active ? 1 : 0;
  const frac = 1 - Math.exp(-rate * (dt > 0 ? dt : 0));
  return amt + (goal - amt) * frac;
}

// ---- P0.3 / LIVE-03: degenerate follow-camera basis guard -----------------

/**
 * Minimum horizontal (AC XY) separation between the follow camera's origin
 * and its lookAt point. Below this the `lookAt` basis carries no yaw at all
 * and every heading consumer that normalises the camera forward divides by
 * zero.
 *
 * PHY-07-LIVE-RUN-2026-07-26 §LIVE-03 measured exactly this state live: the
 * camera world matrix's horizontal forward components were `(0, 0)`
 * (`-m[8] = 0`, `-m[10] = 0`) and the run's turn loop silently froze at one
 * constant heading error (`turnErrSeq` = -123.9 for all 24 iterations).
 *
 * How it happens: `_clipCameraAgainstWorld` clips the camera toward the
 * player's head along the ideal offset, and `clipFinalTo` allows `t = 0`
 * (`Math.max(0.0, hit.t - backoffT)`), which snaps the camera origin ONTO
 * `(playerX, playerY, playerZ + 1.6)`. The follow lookAt is anchored at
 * `(playerX, playerY, …)` too, so the camera→lookAt vector becomes purely
 * vertical. Wedged-indoors (LIVE-01) and hard-clipped-against-a-wall are both
 * ways to reach it.
 *
 * 0.5 m is chosen so the recovered basis still has a normalisable horizontal
 * component (≥ ~0.12 against the largest possible ±4 m `LOOK_LIFT_DIST_M`
 * vertical) without visibly swinging the view when the guard fires.
 */
export const MIN_LOOK_HORIZ_M = 0.5;

/**
 * Guard the follow camera's horizontal basis. Given the camera origin, the
 * sought lookAt point, and the follow-yaw forward direction, return a lookAt
 * whose horizontal offset from the origin is never degenerate.
 *
 * `fallback` is `{ x, y }` — normally `(sin followYaw, cos followYaw)`, which
 * is a unit vector by construction and therefore the natural "last-good
 * heading". `lastGood` is the caller's cached previous healthy direction, used
 * only when `fallback` is itself unusable (NaN yaw). World AC north `(0, 1)`
 * is the final backstop, so this function CANNOT return a zero basis.
 *
 * Returns `{ x, y, degenerate, dirX, dirY }` — `dirX/dirY` is the unit
 * horizontal heading the caller should cache as its next `lastGood`.
 * Pure — pinned by tests/camera_retail_math.test.cjs.
 */
export function guardLookHorizontal(
  camX, camY, lookX, lookY, fallback, lastGood,
) {
  const dx = lookX - camX;
  const dy = lookY - camY;
  const horiz = Math.sqrt(dx * dx + dy * dy);
  if (Number.isFinite(horiz) && horiz >= MIN_LOOK_HORIZ_M) {
    return {
      x: lookX, y: lookY, degenerate: false,
      dirX: dx / horiz, dirY: dy / horiz,
    };
  }
  // Degenerate (or non-finite): rebuild a heading from the first usable
  // source. followYaw first, then the cached last-good, then AC +Y north.
  const candidates = [
    fallback,
    // Preserve the (near-)degenerate direction's sign if it is at least
    // finite and nonzero — a 1e-9 offset still says which way we were facing.
    (Number.isFinite(horiz) && horiz > 0) ? { x: dx / horiz, y: dy / horiz } : null,
    lastGood,
    { x: 0, y: 1 },
  ];
  let dirX = 0, dirY = 1;
  for (const c of candidates) {
    if (!c) continue;
    const cx = c.x, cy = c.y;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    const len = Math.sqrt(cx * cx + cy * cy);
    if (!(len > 1e-6) || !Number.isFinite(len)) continue;
    dirX = cx / len;
    dirY = cy / len;
    break;
  }
  const safeCamX = Number.isFinite(camX) ? camX : 0;
  const safeCamY = Number.isFinite(camY) ? camY : 0;
  return {
    x: safeCamX + dirX * MIN_LOOK_HORIZ_M,
    y: safeCamY + dirY * MIN_LOOK_HORIZ_M,
    degenerate: true,
    dirX, dirY,
  };
}
