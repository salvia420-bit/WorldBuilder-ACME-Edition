// F17 (2026-07-03, physics-parity dossier A row 42) — pure helpers for the
// `?rustPose=on` render flag: the LOCAL player's rendered rig/camera pose
// comes straight from the wasm integrator
// (`SessionHandle.getLocalPlayerPose()`), bypassing the JS smoothing stack
// (the cameraSwitcher `predictedPlayerPos` mirror + the loop.js RIG_Z ease).
//
// Retail truth: the drawn parts ARE m_position — `CPhysicsObj::set_frame`
// (acclient.c:321328) writes `m_position.frame` and immediately pushes it
// into the render part array (`CPartArray::SetFrame`, acclient.c:321350);
// interpolation/constraint happen INSIDE the sim (InterpolationManager /
// ConstraintManager mutate m_position during UseTime), never as a
// render-side smoothing layer. The JS layers existed to hide a reconcile
// oscillation whose Rust-side cause was fixed 2026-07-03 (leash lattice +
// autonomy latch), so the bypass is now viable pending the 1070 A/B.
//
// Import-free by design so the unit half runs headless under plain node
// (tests/rust_pose.test.cjs) — loop.js/camera.js pull three.js and can't
// be imported outside the browser (same split as camera_math.js).

/**
 * Parse `?rustPose=on` (or `&rustPose=on`) from a `location.search`
 * string. DEFAULT OFF — feel-affecting render change, pending a 1070 A/B
 * (dossier A plan row 9: A/B first, delete the legacy layers after).
 * Only an exact case-insensitive `on` enables; anything else (absent,
 * `off`, `1`, garbage) stays off. Same reader shape as loop.js
 * `LEGACY_DIRECT_DRAIN_ON`.
 *
 * @param {string|null|undefined} search - window.location.search
 * @returns {boolean}
 */
export function parseRustPoseFlag(search) {
  // F-2026-07-03: DEFAULT-ON (was `=on` to enable); only `=off`
  // disables. Flipped after the F17 drift report showed the flag-off
  // residual is only the RIG_Z ease + a direct-assign mirror (the
  // 150 ms predictor was already dead code since 2026-06-29) — the
  // 5-10 Hz jitter watch stays on the 1070 A/B recipe; `=off` is the
  // escape and the rollback if jitter appears.
  try {
    return (
      new URLSearchParams(search ?? "").get("rustPose")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return true;
  }
}

/**
 * Convert a wasm `LocalPlayerPose` (landblock-local x/y ∈ 0..192 +
 * `landblockId`; z already world; heading = compass-bearing radians) into
 * the world-space render pose `{x, y, z, qw, qz}` the rig/camera consume.
 *
 * Same lb-local → world convention as loop.js `_armPosition` and
 * camera.js `_integratorWorldPose`:
 *   `wx = ((lbId>>>24)&0xff)*192 + x`, `wy = ((lbId>>>16)&0xff)*192 + y`.
 * Same heading → quaternion math as the legacy apply path in
 * `applyLocalPlayerPoseFromIntegrator` (yaw-only about AC +Z):
 *   `qw = cos(h/2), qz = sin(h/2)`.
 *
 * Returns `null` when the pose is missing or any coordinate is
 * non-finite (pre-spawn / read failure) — callers keep the last applied
 * pose, matching the legacy path's null-`predicted` early return. A
 * missing/non-finite heading degrades to 0 (north), exactly like the
 * legacy apply path's `let heading = 0` default. A missing `landblockId`
 * coerces via `>>> 0` to 0 (lb 0x00,0x00), matching
 * `_integratorWorldPose`.
 *
 * @param {{x:number,y:number,z:number,heading?:number,landblockId?:number}|null|undefined} pose
 * @returns {{x:number,y:number,z:number,qw:number,qz:number}|null}
 */
export function rustPoseWorldFromPose(pose) {
  if (!pose) return null;
  const lx = pose.x;
  const ly = pose.y;
  const lz = pose.z;
  if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) {
    return null;
  }
  const lbId = pose.landblockId >>> 0;
  const heading =
    typeof pose.heading === "number" && Number.isFinite(pose.heading)
      ? pose.heading
      : 0.0;
  return {
    x: ((lbId >>> 24) & 0xff) * 192.0 + lx,
    y: ((lbId >>> 16) & 0xff) * 192.0 + ly,
    z: lz,
    qw: Math.cos(heading * 0.5),
    qz: Math.sin(heading * 0.5),
  };
}
