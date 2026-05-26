/**
 * Aim-level motion dispatch for missile attacks — Wave 3 / Phase 7 of
 * the CombatManeuverTable fixes plan
 * (`external/holtburger/docs/cmt-fixes-plan-2026-05-26.md`).
 *
 * Ports `Creature_Missile.cs::GetAimLevel(Vector3 velocity)` from
 * `~/ace-server/Source/ACE.Server/WorldObjects/Creature_Missile.cs:435-472`
 * (verbatim — same branch tree, same thresholds) into a JS helper the
 * picking.js missile branch + index.html `dispatchRemoteSwing` can call
 * to resolve an `AimHigh{15..90}` / `AimLevel` / `AimLow{15..90}`
 * MotionCommand u32 from a target-relative velocity vector.
 *
 * ## Why this helper exists
 *
 * The Phase 6 audit at
 * `crates/holtburger-dat/examples/dump_cmt_ranged_rows.rs` proved retail
 * `CombatManeuverTable` 0x30000000 has ZERO rows for ranged stances
 * (`BowCombat`, `CrossbowCombat`, `SlingCombat`, `ThrownWeaponCombat`,
 * `AtlatlCombat`). The retail / ACE missile dispatch at
 * `Player_Missile.cs:207` resolves a motion via `GetAimLevel(velocity)`
 * → `EnqueueMotionPersist(actionChain, aimLevel)`, skipping the CMT
 * lookup entirely. Wave 2 Phase 6 wired the missile branch through the
 * CMT chain for diag symmetry (and to record the predictable miss);
 * this helper plugs the post-miss `setSwingPose` fallback with the
 * actual aim-level motion so the client mirrors the server.
 *
 * ## Prediction-quality trade-off
 *
 * The server-authoritative path in `Creature_Missile.cs::GetAimVelocity`
 * (lines 236-252) builds a gravity-compensated arc through
 * `GetProjectileVelocity` and includes an eye-height offset
 * (`origin.Z += Height * ProjSpawnHeight`). For *client-side
 * prediction* the direct-line normalized direction `(target - origin)`
 * is good enough — the server still arbitrates the actual shot, and
 * the `UpdateMotion` (kind=5) wire event will overwrite the predicted
 * motion if the server picks a different aim-level. The visible cost
 * is a one-frame mismatch at the extremes (firing at a target ~50m
 * away whose Z delta is small enough to bucket-flip between AimLevel
 * and AimLow15 once gravity drop is factored in — typically invisible).
 *
 * @todo Port `Creature_Missile.cs:236-252 GetAimVelocity` for retail-
 *   exact bucket assignment. Requires `Height * ProjSpawnHeight` on
 *   the wielding entity (~waist height for humanoids, varies for
 *   creatures), which is on the wire via `PropertyFloat::Height /
 *   ProjectileSpawnHeight` but not currently surfaced on either the
 *   local-player session or `EntityInstance.meta`.
 * @todo Eye-height offset (origin.Z bump) — see prediction-quality
 *   note above. Skipped for v1; impacts the bucket-flip frequency at
 *   long range only.
 *
 * ## Sources cross-referenced
 *
 * - **ACE port source (canonical):**
 *   `~/ace-server/Source/ACE.Server/WorldObjects/Creature_Missile.cs:435-472`
 *   — verbatim if/else branch tree, 13 buckets at 15° intervals.
 * - **MotionCommand enum values:**
 *   `~/ace-server/Source/ACE.Entity/Enum/MotionCommand.cs:37-49` —
 *   `AimLevel = 0x4000001E` plus 6 high (`AimHigh{15..90}`) and 6 low
 *   (`AimLow{15..90}`). All 13 are mirrored in the committed
 *   `apps/holtburger-web/data/motion-command-names.json` for diag
 *   readability.
 * - **Call sites that pick the motion server-side:**
 *   `~/ace-server/Source/ACE.Server/WorldObjects/Player_Missile.cs:207`
 *   feeds it through `EnqueueMotionPersist`.
 */

/**
 * MotionCommand u32 values for the 13 aim-level animations. Frozen
 * because callers may use this as a lookup table (e.g. `AIM_MOTIONS.AimHigh45`)
 * in addition to going through `getAimLevelForVelocity`.
 *
 * @type {Readonly<{
 *   AimLevel: 0x4000001E,
 *   AimHigh15: 0x4000001F, AimHigh30: 0x40000020, AimHigh45: 0x40000021,
 *   AimHigh60: 0x40000022, AimHigh75: 0x40000023, AimHigh90: 0x40000024,
 *   AimLow15: 0x40000025, AimLow30: 0x40000026, AimLow45: 0x40000027,
 *   AimLow60: 0x40000028, AimLow75: 0x40000029, AimLow90: 0x4000002A,
 * }>}
 */
export const AIM_MOTIONS = Object.freeze({
  AimLevel:  0x4000001E,
  AimHigh15: 0x4000001F,
  AimHigh30: 0x40000020,
  AimHigh45: 0x40000021,
  AimHigh60: 0x40000022,
  AimHigh75: 0x40000023,
  AimHigh90: 0x40000024,
  AimLow15:  0x40000025,
  AimLow30:  0x40000026,
  AimLow45:  0x40000027,
  AimLow60:  0x40000028,
  AimLow75:  0x40000029,
  AimLow90:  0x4000002A,
});

/**
 * Resolve an aim-level `MotionCommand` u32 from a target-relative
 * velocity vector. Ports `Creature_Missile.cs::GetAimLevel:435` —
 * normalizes the vector, multiplies the z-component by 90° to get an
 * angle in degrees, and buckets it into one of 13 motions at 15°
 * intervals.
 *
 * Coordinate convention: AC world frame, z-up. `velocity` is typically
 * computed as `(targetPos - shooterPos)` for client-side prediction;
 * the server uses a gravity-arc velocity instead, but the bucket
 * boundaries are wide enough (15°) that direct-line is good enough for
 * the visible swing motion (see module docstring "Prediction-quality
 * trade-off").
 *
 * @param {{ x: number, y: number, z: number } | null | undefined} velocity
 *   AC-coord velocity vector. Zero / null / non-finite components fall
 *   back to `AimLevel`.
 * @returns {number} One of the 13 `AIM_MOTIONS` u32 values.
 */
export function getAimLevelForVelocity(velocity) {
  // Zero / missing vector → AimLevel matches ACE's default-init
  // `var aimLevel = MotionCommand.AimLevel;` at line 440 (no branch
  // taken when velocity normalizes to zero / NaN).
  if (!velocity) return AIM_MOTIONS.AimLevel;
  const vx = +velocity.x;
  const vy = +velocity.y;
  const vz = +velocity.z;
  if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) {
    return AIM_MOTIONS.AimLevel;
  }
  const lenSq = vx * vx + vy * vy + vz * vz;
  if (lenSq === 0) return AIM_MOTIONS.AimLevel;
  const len = Math.sqrt(lenSq);
  // Vector3.Normalize(velocity).Z * 90.0f — ACE line 438.
  const zAngle = (vz / len) * 90.0;

  // Verbatim branch tree from Creature_Missile.cs:442-467. The `>=`
  // boundaries on the high side and `>` on the low side mirror ACE
  // exactly so an edge-case input (e.g. zAngle == 7.5 → AimHigh15;
  // zAngle == -7.5 → AimLow15, NOT AimLevel) matches retail.
  if (zAngle >= 82.5)  return AIM_MOTIONS.AimHigh90;
  if (zAngle >= 67.5)  return AIM_MOTIONS.AimHigh75;
  if (zAngle >= 52.5)  return AIM_MOTIONS.AimHigh60;
  if (zAngle >= 37.5)  return AIM_MOTIONS.AimHigh45;
  if (zAngle >= 22.5)  return AIM_MOTIONS.AimHigh30;
  if (zAngle >= 7.5)   return AIM_MOTIONS.AimHigh15;
  if (zAngle > -7.5)   return AIM_MOTIONS.AimLevel;
  if (zAngle > -22.5)  return AIM_MOTIONS.AimLow15;
  if (zAngle > -37.5)  return AIM_MOTIONS.AimLow30;
  if (zAngle > -52.5)  return AIM_MOTIONS.AimLow45;
  if (zAngle > -67.5)  return AIM_MOTIONS.AimLow60;
  if (zAngle > -82.5)  return AIM_MOTIONS.AimLow75;
  return AIM_MOTIONS.AimLow90;
}
