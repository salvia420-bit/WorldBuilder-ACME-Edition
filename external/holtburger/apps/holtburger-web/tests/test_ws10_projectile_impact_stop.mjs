// node tests/test_ws10_projectile_impact_stop.mjs
// WS10 (2026-07-12) — models scene3d/entities.js projectile flight patches:
//   PATCH 1: setVelocity impact-stop (?projectileImpactStop, default-ON)
//   PATCH 2: spawn ground-clamp bypass for MISSILE projectiles
//            (?projectileGroundClampSkip, default-ON)
// Pure JS, no THREE / no browser. Mirrors the integrator (_tickBallisticProjectiles),
// the impact-stop clear in setVelocity, and the _spawnImpl ground-clamp gate.

const G = -9.8; // PROJECTILE_GRAVITY_Z, AC frame (z up)

// --- PATCH 1 model: integrator + impact-stop -------------------------------
function makeInst() {
  return {
    _ballistic: true,
    _ballisticGravity: true,
    lastVel: { vx: 5, vy: 0, vz: 0 },
    pos: { x: 0, y: 0, z: 100 },
  };
}
function tick(inst, step) {
  if (!inst._ballistic) return;
  const lv = inst.lastVel;
  if (inst._ballisticGravity) lv.vz += G * step;
  inst.pos.x += lv.vx * step;
  inst.pos.y += lv.vy * step;
  inst.pos.z += lv.vz * step;
}
function setVelocity(inst, upd, { impactStopOn, isProjectile }) {
  inst.lastVel = { vx: upd.vx ?? 0, vy: upd.vy ?? 0, vz: upd.vz ?? 0 };
  if (impactStopOn && inst._ballistic && isProjectile) {
    inst._ballistic = false;
    inst._ballisticGravity = false;
  }
}

// --- PATCH 2 model: spawn ground-clamp gate --------------------------------
// _groundClampZ lifts a buried outdoor object up onto the terrain surface.
function groundClampZ(z, terrainZ) {
  const buryDepth = terrainZ - z;
  return buryDepth > 0.1 ? terrainZ : z;
}
// The _spawnImpl gate: wz = (skipOn && isProjectile) ? authoredZ : clamp(authoredZ)
function spawnWz(authoredZ, terrainZ, { skipOn, isProjectile }) {
  return (skipOn && isProjectile)
    ? authoredZ
    : groundClampZ(authoredZ, terrainZ);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };

// ==== PATCH 1 =============================================================
// (a) arc falls while flying
{
  const a = makeInst();
  for (let i = 0; i < 10; i++) tick(a, 0.1);
  ok(a.pos.z < 100, "(a) arc projectile drops under gravity while flying");
}
// (b) impact-stop (flag on, is projectile): no further fall
{
  const b = makeInst();
  for (let i = 0; i < 5; i++) tick(b, 0.1);
  const zAtImpact = b.pos.z;
  setVelocity(b, { vx: 0, vy: 0, vz: 0 }, { impactStopOn: true, isProjectile: true });
  for (let i = 0; i < 50; i++) tick(b, 0.1); // 5 s husk window
  ok(Math.abs(b.pos.z - zAtImpact) < 1e-9, "(b) impact-stop freezes z after VectorUpdate");
  ok(b._ballistic === false, "(b) _ballistic cleared on impact");
  ok(b._ballisticGravity === false, "(b) _ballisticGravity cleared on impact");
}
// (c) flag off: legacy sink continues
{
  const c = makeInst();
  for (let i = 0; i < 5; i++) tick(c, 0.1);
  const zAtImpactC = c.pos.z;
  setVelocity(c, { vx: 0, vy: 0, vz: 0 }, { impactStopOn: false, isProjectile: true });
  for (let i = 0; i < 50; i++) tick(c, 0.1);
  ok(zAtImpactC - c.pos.z > 100, "(c) flag-off husk keeps sinking >100m (legacy, masked by NoDraw)");
}
// (d) non-projectile VectorUpdate (remote entity dead-reckon) is untouched:
//     even with flag on, a non-projectile keeps integrating.
{
  const d = makeInst();
  setVelocity(d, { vx: 0, vy: 0, vz: 0 }, { impactStopOn: true, isProjectile: false });
  ok(d._ballistic === true, "(d) non-projectile VectorUpdate does not clear _ballistic");
  for (let i = 0; i < 10; i++) tick(d, 0.1);
  ok(d.pos.z < 100, "(d) non-projectile keeps integrating (gravity still applied)");
}

// ==== PATCH 2 =============================================================
// (e) projectile spawned below terrain, flag on: authored Z preserved (not lifted)
{
  const wz = spawnWz(/*authoredZ*/ 100.0, /*terrainZ*/ 105.0, { skipOn: true, isProjectile: true });
  ok(Math.abs(wz - 100.0) < 1e-9, "(e) projectile below terrain keeps authored launch Z (no clamp)");
}
// (f) projectile flag off: legacy clamp lifts it onto terrain
{
  const wz = spawnWz(100.0, 105.0, { skipOn: false, isProjectile: true });
  ok(Math.abs(wz - 105.0) < 1e-9, "(f) flag-off projectile is clamped to terrain (legacy)");
}
// (g) non-projectile is always clamped regardless of the projectile flag
{
  const wz = spawnWz(100.0, 105.0, { skipOn: true, isProjectile: false });
  ok(Math.abs(wz - 105.0) < 1e-9, "(g) non-projectile still ground-clamped (skip flag scoped to projectiles)");
}
// (h) projectile above terrain: authored Z preserved either way (no bury)
{
  const on = spawnWz(110.0, 105.0, { skipOn: true, isProjectile: true });
  const off = spawnWz(110.0, 105.0, { skipOn: false, isProjectile: true });
  ok(Math.abs(on - 110.0) < 1e-9 && Math.abs(off - 110.0) < 1e-9,
     "(h) projectile above terrain keeps authored Z regardless of flag");
}

console.log(`WS10 projectile impact-stop + ground-clamp-skip: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
