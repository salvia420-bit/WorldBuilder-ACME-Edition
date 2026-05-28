/**
 * Defender-facing Sneak Attack prediction — Wave 5 / Phase 9 of the
 * CombatManeuverTable fixes plan
 * (`external/holtburger/docs/cmt-fixes-plan-2026-05-26.md`).
 *
 * Pure client-side predictor that returns `true` when the attacker is
 * in the defender's rear hemisphere at swing-fire time. The bonus
 * itself (+10/+20 Damage Rating, see acpedia "Sneak Attack") is
 * server-authoritative — this helper exists so the UI can light up a
 * "Sneak Ready" indicator before the wire-side `damageDealt` event
 * confirms the hit. The wire payload to `sessionHandle.attack()` and
 * `sessionHandle.missileAttack()` is unchanged: this is purely a UI
 * preview signal.
 *
 * ## Threshold source
 *
 * The 90° (π/2 rad) rear-hemisphere cone is ported VERBATIM from ACE's
 * `Creature_Combat.cs::GetSneakAttackMod`
 * (`~/ace-server/Source/ACE.Server/WorldObjects/Creature_Combat.cs:762-763`):
 *
 *     var angle = creatureTarget.GetAngle(this);
 *     var behind = Math.Abs(angle) > 90.0f;
 *
 * where `GetAngle(target)` (`Creature_Navigation.cs:31-46`) returns the
 * 2D angle in degrees between the defender's `Location.GetCurrentDir()`
 * and the normalized 2D displacement from defender to attacker. We
 * mirror that exactly: `behind = angle_between(defenderForward, da) > 90°`,
 * which is equivalent to `dot(defenderForward, da_unit) < 0` since
 * `cos(90°) = 0`. The wiki ("Sneak Attack" page) confirms 100% chance
 * to sneak attack from behind — the only positional gate.
 *
 * ## AC coord convention
 *
 * AC uses a Z-up frame; "heading" is yaw around +Z. The defender's
 * forward unit vector is derived from `Vector3.Transform(Vector3.UnitY,
 * Rotation)` (`ACE.Entity/Position.cs:80-83`). For a pure +Z rotation
 * by angle θ, that resolves to `(-sin θ, cos θ, 0)`:
 *
 *     Rz(θ) · (0, 1, 0)ᵀ = (-sin θ, cos θ, 0)ᵀ
 *
 * Cross-checked against `entities.js::getLocalPlayerHeading` (line
 * ~3374) which extracts the raw yaw from the AC quaternion via
 * `atan2(2(qw·qz + qx·qy), 1 - 2(qy² + qz²))` — the same formula the
 * wasm-side `publish_local_player_pose` uses to derive
 * `LocalPlayerPose::heading` (`src/lib.rs:20535-20537`). Both produce
 * "raw yaw" in the same CCW-around-+Z math convention, so passing
 * either the local pose's `heading` field OR the entity manager's
 * `getHeading(guid)` into this helper yields a defender-forward
 * vector in the same world frame as `attackerPose - defenderPose`.
 *
 * Z component is intentionally ignored — Sneak Attack is a 2D facing
 * check (ACE's `GetAngle` zeroes `targetDir.Z` before normalizing,
 * `Creature_Navigation.cs:41`). An attacker directly above or below
 * the defender produces no horizontal displacement and falls back to
 * the conservative "not behind" path.
 *
 * @module ui/ac_sneak_attack_predict
 */

/**
 * Rear-hemisphere threshold in radians. Ported verbatim from ACE
 * `Creature_Combat.cs:763` — `Math.Abs(angle) > 90.0f`. An attacker
 * whose displacement-from-defender makes an angle GREATER than this
 * with the defender's forward vector is "behind" → Sneak Attack
 * activates (100% chance per the wiki).
 *
 * @type {number}
 */
export const SNEAK_ATTACK_CONE_RAD = Math.PI / 2;

/**
 * Return `true` if `attackerPose` is in the defender's rear hemisphere
 * (the 180° cone behind the defender's forward direction), `false`
 * otherwise. Conservative on missing inputs — any null/NaN/undefined
 * pose component or a missing heading returns `false`.
 *
 * The check is 2D (XY plane). Z components on the poses are ignored
 * to match ACE's `GetAngle(WorldObject)` which zeroes the Z component
 * of the displacement before normalizing.
 *
 * @param {object} args
 * @param {{ x: number, y: number, z?: number } | null | undefined} args.attackerPose
 *   AC-world-frame position of the attacker.
 * @param {{ x: number, y: number, z?: number } | null | undefined} args.defenderPose
 *   AC-world-frame position of the defender.
 * @param {number | null | undefined} args.defenderHeadingRad
 *   Defender's yaw in radians (raw-yaw CCW-around-+Z convention as
 *   extracted by `entities.js::getLocalPlayerHeading` / wasm
 *   `LocalPlayerPose::heading`). `null` / `undefined` / NaN → returns
 *   `false`.
 * @returns {boolean}
 */
export function isAttackerBehindDefender({
  attackerPose,
  defenderPose,
  defenderHeadingRad,
} = {}) {
  if (!attackerPose || !defenderPose) return false;
  if (defenderHeadingRad === null || defenderHeadingRad === undefined) return false;
  if (!Number.isFinite(defenderHeadingRad)) return false;

  const ax = attackerPose.x;
  const ay = attackerPose.y;
  const dx = defenderPose.x;
  const dy = defenderPose.y;
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return false;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;

  // Displacement defender → attacker, in the XY plane.
  const vx = ax - dx;
  const vy = ay - dy;
  const distSq = vx * vx + vy * vy;
  // Stack-on-defender (or numerical near-zero) → no meaningful angle.
  // Match ACE's normalize-zero-vector behaviour, which would produce
  // NaN downstream; we collapse to "not behind".
  if (distSq < 1e-12) return false;

  // Defender forward unit vector, AC convention:
  //   Rz(h) · UnitY = (-sin h, cos h, 0)
  // (see header comment for the cross-reference to ACE Position.cs:82).
  const h = defenderHeadingRad;
  const fx = -Math.sin(h);
  const fy = Math.cos(h);

  // dot(forward, displacement_unit) = cos(angle). The displacement
  // vector doesn't need to be normalized for the sign test: the
  // distance scalar is strictly positive (guarded above), so the sign
  // of `(fx*vx + fy*vy)` matches the sign of `cos(angle)`.
  //
  // Behind ⇔ angle > 90° ⇔ cos(angle) < 0 ⇔ dot < 0. Exclusive `<` not
  // `<=` so an attacker exactly broadside (dot=0) is NOT considered
  // behind, mirroring ACE's strict `Math.Abs(angle) > 90.0f`.
  const dot = fx * vx + fy * vy;
  return dot < 0;
}

// =====================================================================
// Inline unit tests — `node ui/ac_sneak_attack_predict.js`
// =====================================================================
//
// The `holtburger-web` app has no project-wide test runner; tests for
// pure helpers run as a bottom-of-file `main` gated on `import.meta`.
// Mirrors the pattern used by `ui/graphics_settings.js::__test_only`
// and aligns with `node --check` clean. Run with:
//
//     node external/holtburger/apps/holtburger-web/ui/ac_sneak_attack_predict.js
//
// Exits non-zero on any assertion failure so CI / wrapper scripts can
// hook the result.

if (typeof process !== "undefined" && process.argv && import.meta.url === `file://${process.argv[1]}`) {
  let pass = 0;
  let fail = 0;
  function assert(cond, label) {
    if (cond) {
      pass += 1;
      console.log(`  ok   ${label}`);
    } else {
      fail += 1;
      console.error(`  FAIL ${label}`);
    }
  }

  // Defender at origin, facing "north" (+Y direction at heading=0,
  // since AC forward = (-sin 0, cos 0) = (0, 1)).
  const defender = { x: 100, y: 100, z: 80 };
  const headingNorth = 0; // forward = (0, +1)

  // 1) Attacker directly BEHIND defender (in -Y direction from defender).
  //    Displacement defender → attacker = (0, -5). Forward = (0, +1).
  //    dot = 0*0 + 1*(-5) = -5 < 0 → behind = true.
  assert(
    isAttackerBehindDefender({
      attackerPose: { x: 100, y: 95, z: 80 },
      defenderPose: defender,
      defenderHeadingRad: headingNorth,
    }) === true,
    "attacker directly behind (north-facing defender, attacker to south) → true",
  );

  // 2) Attacker directly IN FRONT of defender (in +Y direction).
  //    Displacement = (0, +5). dot = 0*0 + 1*5 = +5 > 0 → behind = false.
  assert(
    isAttackerBehindDefender({
      attackerPose: { x: 100, y: 105, z: 80 },
      defenderPose: defender,
      defenderHeadingRad: headingNorth,
    }) === false,
    "attacker directly in front → false",
  );

  // 3) Attacker directly to the SIDE (broadside). At heading=0, side =
  //    +X or -X direction. Displacement = (+5, 0). dot = 0*5 + 1*0 = 0,
  //    NOT < 0 → behind = false. Confirms strict-greater 90° matches
  //    ACE's `> 90.0f` (an attacker exactly broadside is on the cone
  //    boundary and gets no sneak bonus — same as front).
  assert(
    isAttackerBehindDefender({
      attackerPose: { x: 105, y: 100, z: 80 },
      defenderPose: defender,
      defenderHeadingRad: headingNorth,
    }) === false,
    "attacker exactly broadside (boundary case, dot=0) → false",
  );

  // 4) Attacker directly ABOVE defender (z-axis only). 2D displacement
  //    is (0, 0) → distSq guard returns false. Confirms the helper
  //    ignores the Z axis and falls back to the conservative path on
  //    zero horizontal separation.
  assert(
    isAttackerBehindDefender({
      attackerPose: { x: 100, y: 100, z: 120 },
      defenderPose: defender,
      defenderHeadingRad: headingNorth,
    }) === false,
    "attacker directly above (no XY separation) → false (z ignored)",
  );

  // 5) Defender with NO heading data (null) → returns false conservatively.
  //    Matches the picking.js callsite guard: if `em.getHeading(guid)`
  //    returns null (entity hasn't received a MotionUpdate yet), we
  //    must not emit `sneakAttackPredicted`.
  assert(
    isAttackerBehindDefender({
      attackerPose: { x: 100, y: 95, z: 80 },
      defenderPose: defender,
      defenderHeadingRad: null,
    }) === false,
    "defender heading = null → false (conservative)",
  );

  // 6) Defender facing east (heading=π/2). At h=π/2:
  //    forward = (-sin(π/2), cos(π/2), 0) = (-1, 0, 0). Wait —
  //    that's facing WEST, not east. The "east" naming refers to AC's
  //    own compass convention; what we care about for the predicate
  //    is consistency with the AC convention chosen.
  //
  //    Attacker in +X direction from defender (displacement = (+5, 0)).
  //    dot = (-1)*5 + 0*0 = -5 < 0 → behind = true.
  //    (Defender's forward is -X; attacker is at +X, i.e. directly
  //    behind the defender.) Confirms the helper rotates the forward
  //    vector correctly with heading.
  assert(
    isAttackerBehindDefender({
      attackerPose: { x: 105, y: 100, z: 80 },
      defenderPose: defender,
      defenderHeadingRad: Math.PI / 2,
    }) === true,
    "defender at heading=π/2 (forward=-X), attacker at +X → true (rotated forward)",
  );

  // 7) Non-finite heading (NaN) → false.
  assert(
    isAttackerBehindDefender({
      attackerPose: { x: 100, y: 95, z: 80 },
      defenderPose: defender,
      defenderHeadingRad: Number.NaN,
    }) === false,
    "defender heading = NaN → false (conservative)",
  );

  // Threshold constant sanity.
  assert(
    SNEAK_ATTACK_CONE_RAD === Math.PI / 2,
    "SNEAK_ATTACK_CONE_RAD === π/2 (ACE Creature_Combat.cs:763 `> 90.0f`)",
  );

  console.log(`\nsneak-attack-predict: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
