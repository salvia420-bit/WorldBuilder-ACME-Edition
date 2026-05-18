// scene3d/sun_direction.js — shared AC sun-direction conversion.
//
// AC publishes the sun as (heading, pitch) in DEGREES: heading is
// measured on the world XY plane from +Y (north), clockwise; pitch is
// the angle above the horizon. The AC unit vector in AC coords is
//
//     (cos(pitch) * sin(heading),  // AC east
//      cos(pitch) * cos(heading),  // AC north
//      sin(pitch))                 // AC up
//
// Then the AC→three transform `(ax, ay, az) → (ax, az, -ay)` (same
// rotation `worldRoot.rotation.x = -π/2` applies to its children)
// gives:
//
//     three_x =  cos(pitch) * sin(heading)         [east]
//     three_y =  sin(pitch)                        [up]
//     three_z = -cos(pitch) * cos(heading)         [south]
//
// Empirically verified by Sky-I-C's `sun_visibility_probe` (NE→ENE→N→
// W→SW arc across t∈[0.04, 0.18] matches the canonical east-to-west
// sky path) and the Dereth-noon eye-test `dir_heading=90, dir_pitch=
// 67.35` → strongly positive Y.
//
// Consumed by:
//   - sky_lighting.js — DirectionalLight position
//   - cloud_volume.js — CloudsEffect sunDirection uniform
//   - atmosphere_lights.js — SunDirectionalLight + SkyLightProbe
//   - atmosphere_sky.js — SkyMaterial + StarsMaterial sunDirection
//
// Centralised here so the formula has ONE source of truth — see
// INTERACTING_LAYERS_ANALYSIS.md ("Sun-direction computed four times")
// for the deduplication context.

const DEG_TO_RAD = Math.PI / 180;

/**
 * Convert AC sun heading + pitch (degrees) to a unit direction vector
 * in three.js world space. Writes into `outVec` in place; returns it
 * for chaining.
 *
 * `outVec` only needs a `.set(x, y, z)` method — any THREE.Vector3,
 * any pmndrs vec3, or any test mock with the same shape works.
 *
 * @param {number} headingDeg AC sun heading (deg, 0 = north, CW)
 * @param {number} pitchDeg AC sun pitch (deg above horizon)
 * @param {{set: (x: number, y: number, z: number) => any}} outVec
 * @returns {typeof outVec}
 */
export function sunDirFromHeadingPitch(headingDeg, pitchDeg, outVec) {
  const headingRad = headingDeg * DEG_TO_RAD;
  const pitchRad = pitchDeg * DEG_TO_RAD;
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  outVec.set(
    cp * Math.sin(headingRad),
    sp,
    -cp * Math.cos(headingRad),
  );
  return outVec;
}

/**
 * Convert AC sun heading + pitch (degrees) to a three.js world-space
 * position at radius `distance`. Returns a fresh `[x, y, z]` array,
 * suitable for `light.position.set(...result)` destructuring.
 *
 * For per-frame use with a stable target vector, prefer
 * `sunDirFromHeadingPitch` + `outVec.multiplyScalar(distance)` to
 * avoid the per-call array allocation. The array form is kept for
 * code paths that read it via array destructuring.
 *
 * @param {number} headingDeg
 * @param {number} pitchDeg
 * @param {number} distance
 * @returns {[number, number, number]}
 */
export function sunPositionFromHeadingPitch(headingDeg, pitchDeg, distance) {
  const headingRad = headingDeg * DEG_TO_RAD;
  const pitchRad = pitchDeg * DEG_TO_RAD;
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  return [
    distance * cp * Math.sin(headingRad),
    distance * sp,
    -distance * cp * Math.cos(headingRad),
  ];
}
