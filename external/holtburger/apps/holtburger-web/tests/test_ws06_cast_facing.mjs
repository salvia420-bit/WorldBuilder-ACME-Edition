// WS06 (2026-07-12) — cast facing math validation.
//
// Mirrors turnToFaceThenAct's bearing (`atan2(dx, dy)`, scene3d/picking.js)
// against the wasm compass heading convention (src/lib.rs ~29002:
//   "yaw=0 -> facing +Y (north); yaw=pi/2 -> facing +X (east)").
// AC-world forward(theta) = (sin theta, cos theta) [x=East, y=North], and the
// bearing that faces (dx,dy) is exactly atan2(dx,dy). This is the "bolt not
// sideways at cast-send" invariant, plus the turn-delta short-way sign, the
// convergence loop, and the reface-needed predicate (authentic to ACE's
// IsWithinAngle / spellcast_max_angle).
//
// Run: node tests/test_ws06_cast_facing.mjs   (from apps/holtburger-web/)

let pass = 0, fail = 0;
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.error("FAIL:", name); } }
function normalizeAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
const bearingToTarget = (dx, dy) => Math.atan2(dx, dy);        // picking.js turnToFaceThenAct
const forward = (h) => ({ x: Math.sin(h), y: Math.cos(h) });  // lib.rs compass convention

// (a) N/E/S/W bearings.
check("north dx=0,dy=+ -> 0", approx(bearingToTarget(0, 10), 0));
check("east  dx=+,dy=0 -> +pi/2", approx(bearingToTarget(10, 0), Math.PI / 2));
check("west  dx=-,dy=0 -> -pi/2", approx(bearingToTarget(-10, 0), -Math.PI / 2));
check("south dx=0,dy=- -> pi", approx(Math.abs(bearingToTarget(0, -10)), Math.PI));

// (b) forward(atan2(dx,dy)) . targetDir == 1 for every quadrant (bolt not sideways).
for (const [dx, dy] of [[10, 0], [0, 10], [-7, 3], [4, -9], [-5, -5], [8, 8], [0.1, -12], [13, 0.2]]) {
  const L = Math.hypot(dx, dy), h = bearingToTarget(dx, dy), f = forward(h);
  check(`facing (${dx},${dy}) forward.dir==1`, approx(f.x * (dx / L) + f.y * (dy / L), 1, 1e-9));
}

// (c) turn-delta sign drives the short way.
function turnStep(heading, dx, dy) {
  const d = normalizeAngle(bearingToTarget(dx, dy) - heading);
  if (Math.abs(d) <= 0.05) return 0;
  return d > 0 ? 1 : -1;
}
check("north facing, east target -> +1", turnStep(0, 10, 0) === 1);
check("north facing, west target -> -1", turnStep(0, -10, 0) === -1);
check("east facing, north target -> -1", turnStep(Math.PI / 2, 0, 10) === -1);
check("aligned -> 0", turnStep(0, 0, 10) === 0);

// (d) the convergence loop settles facing the target.
function simulateFace(h0, dx, dy, rate = 0.15, maxIter = 500) {
  let h = h0;
  for (let i = 0; i < maxIter; i++) {
    const s = turnStep(h, dx, dy);
    if (s === 0) return h;
    const d = normalizeAngle(bearingToTarget(dx, dy) - h);
    h = normalizeAngle(h + s * Math.min(rate, Math.abs(d)));
  }
  return h;
}
for (const [dx, dy] of [[10, 0], [-10, 0], [3, -8], [-6, -2], [9, 5]]) {
  const hf = simulateFace(1.3, dx, dy), f = forward(hf), L = Math.hypot(dx, dy);
  check(`converge faces (${dx},${dy})`, f.x * (dx / L) + f.y * (dy / L) > Math.cos(0.06));
}

// (e) reface-needed fires when the target strafes past tolerance, quiet within
// it (authentic to ACE IsWithinAngle vs spellcast_max_angle).
function refaceNeeded(heading, dx, dy, thr) {
  return Math.abs(normalizeAngle(bearingToTarget(dx, dy) - heading)) > thr;
}
const THR = 5 * Math.PI / 180;
check("reface fires when target strafed 90deg", refaceNeeded(0, 10, 0.5, THR) === true);
check("no reface within tolerance", refaceNeeded(0, 0.05, 10, THR) === false);

console.log(`\nWS06 cast-facing: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
