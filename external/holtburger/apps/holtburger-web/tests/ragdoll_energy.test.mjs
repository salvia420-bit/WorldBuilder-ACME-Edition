// ragdoll_energy.test.mjs — the "ragdolls must never fly away" contract.
//
// 2026-08-02. Field report: a death ragdoll that twisted (or otherwise reached
// a bad constraint state) could GAIN energy and launch into the air. Three
// solver defects fed it:
//   (a) the floor projection inside the relaxation loop moved `pos` without
//       moving `prev`, so penetration depth became upward velocity;
//   (b) the contact pass then read that post-projection velocity as "rising",
//       skipped the restitution branch entirely and kept the whole thing;
//   (c) nothing bounded the over-constrained Gauss-Seidel solve (bone + bend +
//       three braces per node, 5 iterations/step) against inventing energy.
// The fix tracks the projection depth per node per step, subtracts it back out
// at contact, clamps per-node speed (and upward speed specifically), and runs a
// ratcheting MECHANICAL-ENERGY GOVERNOR so E = Σ(½v² + g·z) is monotonically
// non-increasing after arming.
//
// This suite asserts the invariant directly over seeded, deliberately nasty
// configurations — heavy twist, launch-into-the-floor impulses, degenerate and
// collinear rigs, sloped/rising environment floors.
//
// Run: node tests/ragdoll_energy.test.mjs   (from apps/holtburger-web/)

import {
  initSim,
  stepSim,
  buildConstraints,
  buildBraces,
  buildDepths,
  RAGDOLL_GRAVITY,
  RAGDOLL_MAX_UP_SPEED,
  RAGDOLL_MAX_SPEED,
  RAGDOLL_MAX_TIME,
} from "../scene3d/ragdoll.js";

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("  FAIL:", msg);
  }
}
function section(name) {
  console.log(`\n— ${name}`);
}

/* ── rigs ─────────────────────────────────────────────────────────────
 * Model space: +Z up, +Y forward, +X right (AC). Parent index 0xFFFFFFFF = root.
 */
const ROOT = 0xffffffff;

/** A biped: pelvis → spine → head, plus two 3-segment legs and two arms. */
function biped() {
  const parent = [ROOT, 0, 1, 1, 3, 1, 5, 0, 7, 8, 0, 10, 11];
  const pos = [
    0.0, 0.0, 1.00, // 0 pelvis
    0.0, 0.0, 1.35, // 1 chest
    0.0, 0.0, 1.70, // 2 head
    -0.22, 0.0, 1.45, // 3 L shoulder
    -0.45, 0.0, 1.15, // 4 L hand
    0.22, 0.0, 1.45, // 5 R shoulder
    0.45, 0.0, 1.15, // 6 R hand
    -0.14, 0.0, 0.95, // 7 L hip
    -0.16, 0.0, 0.50, // 8 L knee
    -0.16, 0.05, 0.06, // 9 L foot
    0.14, 0.0, 0.95, // 10 R hip
    0.16, 0.0, 0.50, // 11 R knee
    0.16, 0.05, 0.06, // 12 R foot
  ];
  return { parent, pos: Float64Array.from(pos) };
}

/** A quadruped: body + 4 two-segment legs + head. Wide, low, easy to spin. */
function quadruped() {
  const parent = [ROOT, 0, 1, 0, 3, 0, 5, 0, 7, 0, 9];
  const pos = [
    0.0, 0.0, 0.80, // 0 body
    0.0, 0.55, 0.85, // 1 neck
    0.0, 0.85, 0.95, // 2 head
    -0.35, 0.35, 0.55, // 3 LF thigh
    -0.38, 0.38, 0.05, // 4 LF foot
    0.35, 0.35, 0.55, // 5 RF thigh
    0.38, 0.38, 0.05, // 6 RF foot
    -0.35, -0.35, 0.55, // 7 LB thigh
    -0.38, -0.38, 0.05, // 8 LB foot
    0.35, -0.35, 0.55, // 9 RB thigh
    0.38, -0.38, 0.05, // 10 RB foot
  ];
  return { parent, pos: Float64Array.from(pos) };
}

/** Degenerate: every node on one vertical line (collinear ⇒ 2 brace anchors). */
function pole() {
  const parent = [ROOT, 0, 1, 2, 3];
  const pos = [0, 0, 0.1, 0, 0, 0.5, 0, 0, 0.9, 0, 0, 1.3, 0, 0, 1.7];
  return { parent, pos: Float64Array.from(pos) };
}

/** Mechanical energy of a sim, measured exactly the way stepSim measures it. */
function energyOf(sim, dt) {
  let ke = 0;
  let pe = 0;
  const invDt = 1 / dt;
  for (let i = 0; i < sim.n; i++) {
    const ix = i * 3;
    const vx = (sim.pos[ix] - sim.prev[ix]) * invDt;
    const vy = (sim.pos[ix + 1] - sim.prev[ix + 1]) * invDt;
    const vz = (sim.pos[ix + 2] - sim.prev[ix + 2]) * invDt;
    ke += 0.5 * (vx * vx + vy * vy + vz * vz);
    pe += RAGDOLL_GRAVITY * 0.5 * (sim.pos[ix + 2] + sim.prev[ix + 2]);
  }
  return { ke, pe, E: ke + pe };
}

/**
 * Run a sim to completion (or the hard stop) collecting the invariants.
 * Returns { maxE, e0, maxRise, maxSpeed, nan, steps, done, settledT }.
 */
function centroidZ(sim) {
  let z = 0;
  for (let i = 0; i < sim.n; i++) z += sim.pos[i * 3 + 2];
  return sim.n ? z / sim.n : 0;
}

function run(sim, dt = 1 / 60, maxSteps = Math.ceil(RAGDOLL_MAX_TIME * 60) + 30) {
  const z0 = new Float64Array(sim.n);
  for (let i = 0; i < sim.n; i++) z0[i] = sim.pos[i * 3 + 2];
  const c0 = centroidZ(sim);
  let e0 = null;
  let maxE = -Infinity;
  let maxRise = -Infinity;
  let maxCentroidRise = -Infinity;
  let maxSpeed = 0;
  let nan = false;
  let steps = 0;
  let settledT = null;
  for (let s = 0; s < maxSteps && !sim.done; s++) {
    stepSim(sim, dt);
    steps++;
    const e = energyOf(sim, dt);
    if (e0 === null) e0 = e.E;
    if (e.E > maxE) maxE = e.E;
    const cr = centroidZ(sim) - c0;
    if (cr > maxCentroidRise) maxCentroidRise = cr;
    for (let i = 0; i < sim.n; i++) {
      const ix = i * 3;
      for (let k = 0; k < 3; k++) if (!Number.isFinite(sim.pos[ix + k])) nan = true;
      const rise = sim.pos[ix + 2] - z0[i];
      if (rise > maxRise) maxRise = rise;
      const sp =
        Math.hypot(
          sim.pos[ix] - sim.prev[ix],
          sim.pos[ix + 1] - sim.prev[ix + 1],
          sim.pos[ix + 2] - sim.prev[ix + 2],
        ) / dt;
      if (sp > maxSpeed) maxSpeed = sp;
    }
    if (sim.done && settledT === null) settledT = sim.t;
  }
  return { maxE, e0, maxRise, maxCentroidRise, maxSpeed, nan, steps, done: sim.done, settledT };
}

/* ── 1. structural sanity ─────────────────────────────────────────────── */
section("structure");
{
  const { parent, pos } = biped();
  const cons = buildConstraints(parent);
  ok(cons.length > 0, "biped produces constraints");
  ok(cons.every((c) => c.a !== c.b), "no self-constraints");
  const depth = buildDepths(parent);
  ok(depth[0] === 0 && depth[9] === 3, `depths: pelvis 0, L foot 3 (got ${depth[0]}/${depth[9]})`);
  const braces = buildBraces(parent, pos, () => 0.5, depth);
  ok(braces.length > 0, "biped braces the rig");
  ok(braces.every((b) => b.t1 > b.t0), "every brace has a positive give window");
  const poleR = pole();
  const poleBraces = buildBraces(poleR.parent, poleR.pos, () => 0.5);
  ok(Array.isArray(poleBraces), "collinear rig braces without throwing");
}

/* ── 2. THE invariant: energy after arming never rises ─────────────────── */
section("energy is one-way (200 seeded deaths × 2 rigs)");
{
  const rigs = [biped(), quadruped()];
  let worstRatio = 0;
  let worstRise = -Infinity;
  let worstCentroid = -Infinity;
  let worstSpeed = 0;
  let anyNaN = false;
  let notSettled = 0;
  const dt = 1 / 60;
  for (let s = 0; s < 200; s++) {
    const rig = rigs[s % 2];
    const ang = (s / 200) * Math.PI * 2;
    // Deliberately nasty: full-strength crit impulse, maximum twist, and a
    // downward "pop" on every fourth death so the body is driven INTO the
    // floor — the exact condition that used to launch it.
    const sim = initSim(rig.parent, rig.pos, {
      floorZ: 0,
      impulse: [Math.cos(ang) * 4.2, Math.sin(ang) * 4.2, s % 4 === 0 ? -2.5 : 1.5],
      seed: 0x1000 + s,
      twistScale: 2.2,
      toppleScale: 1.4,
    });
    const r = run(sim, dt);
    if (r.nan) anyNaN = true;
    const ratio = r.e0 > 0 ? r.maxE / r.e0 : 1;
    if (ratio > worstRatio) worstRatio = ratio;
    if (r.maxRise > worstRise) worstRise = r.maxRise;
    if (r.maxCentroidRise > worstCentroid) worstCentroid = r.maxCentroidRise;
    if (r.maxSpeed > worstSpeed) worstSpeed = r.maxSpeed;
    if (!r.done) notSettled++;
  }
  console.log(
    `    worst E/E0 = ${worstRatio.toFixed(4)}, worst node rise = ${worstRise.toFixed(3)} m, ` +
      `worst CENTROID rise = ${worstCentroid.toFixed(3)} m, ` +
      `worst speed = ${worstSpeed.toFixed(2)} m/s, unsettled = ${notSettled}/200`,
  );
  ok(!anyNaN, "no NaN in any of the 200 seeded sims");
  ok(worstRatio <= 1.01, `mechanical energy never exceeds arm-time energy (max ratio ${worstRatio.toFixed(4)})`);
  // The launch signature is the BODY leaving the ground; a single node arcing
  // up as the rig cartwheels is exactly what a topple looks like, so the tight
  // bound belongs on the centroid.
  ok(
    worstCentroid <= 0.35,
    `the body's centre never leaves the ground (worst centroid rise ${worstCentroid.toFixed(3)} m)`,
  );
  ok(worstRise <= 1.3, `no single node teleports skyward (worst ${worstRise.toFixed(3)} m)`);
  ok(
    worstSpeed <= RAGDOLL_MAX_SPEED * 1.02,
    `per-node speed stays under the ${RAGDOLL_MAX_SPEED} m/s ceiling (worst ${worstSpeed.toFixed(2)})`,
  );
  ok(notSettled === 0, `every sim settles or hard-stops inside ${RAGDOLL_MAX_TIME}s (${notSettled} did not)`);
}

/* ── 3. the twist case specifically ───────────────────────────────────── */
section("pure twist cannot pump");
{
  const dt = 1 / 60;
  let worst = 0;
  let worstRise = -Infinity;
  for (let s = 0; s < 60; s++) {
    const rig = quadruped(); // wide + low: maximum brace/floor conflict
    const sim = initSim(rig.parent, rig.pos, {
      floorZ: 0,
      impulse: [0, 0, 0],
      seed: 0x7000 + s,
      twistScale: 3.0, // way past anything the runtime ever asks for
      toppleScale: 0.05, // almost no topple: the spin is all there is
    });
    const r = run(sim, dt);
    const ratio = r.e0 > 0 ? r.maxE / r.e0 : 1;
    if (ratio > worst) worst = ratio;
    if (r.maxRise > worstRise) worstRise = r.maxRise;
  }
  console.log(`    worst E/E0 = ${worst.toFixed(4)}, worst rise = ${worstRise.toFixed(3)} m`);
  ok(worst <= 1.01, `a spinning body never gains energy (max ratio ${worst.toFixed(4)})`);
  ok(worstRise <= 0.6, `a spinning body never climbs (worst rise ${worstRise.toFixed(3)} m)`);
}

/* ── 4. deep floor penetration is de-energised, not reflected ──────────── */
section("floor penetration never launches");
{
  const dt = 1 / 60;
  const rig = biped();
  // Start the whole rig 0.4 m BELOW the floor with a large downward velocity:
  // the projection has to lift every node out in one step. Pre-fix this was an
  // instant launch (the depth became upward velocity on every node at once).
  const sunk = Float64Array.from(rig.pos);
  for (let i = 0; i < sunk.length; i += 3) sunk[i + 2] -= 0.4;
  const sim = initSim(rig.parent, sunk, {
    floorZ: 0,
    impulse: [1.0, 0.4, -6.0],
    seed: 0xbeef,
  });
  const r = run(sim, dt);
  console.log(
    `    node rise = ${r.maxRise.toFixed(3)} m, centroid rise = ${r.maxCentroidRise.toFixed(3)} m, ` +
      `speed = ${r.maxSpeed.toFixed(2)} m/s, E/E0 = ${(r.maxE / r.e0).toFixed(4)}`,
  );
  ok(!r.nan, "no NaN after a full-body penetration");
  ok(r.maxE / r.e0 <= 1.01, "penetration recovery does not create energy");
  // Everything starts 0.4 m under the floor, so the body MUST rise ~0.4 m to
  // get out. The contract is that it stops there — one clamped ballistic hop
  // (v²/2g at the upward ceiling) is the entire allowance.
  const allowance = 0.4 + (RAGDOLL_MAX_UP_SPEED * RAGDOLL_MAX_UP_SPEED) / (2 * RAGDOLL_GRAVITY) + 0.1;
  ok(
    r.maxCentroidRise <= allowance,
    `the rig climbs out and stops (centroid rise ${r.maxCentroidRise.toFixed(3)} m, allowance ${allowance.toFixed(3)})`,
  );
  ok(r.done, "the penetrating sim still settles");
}

/* ── 5. a RISING environment floor lifts, it does not throw ────────────── */
section("rising support lifts without throwing");
{
  const dt = 1 / 60;
  const rig = biped();
  // An env whose floor climbs steeply under the body (walking a corpse up onto
  // another corpse). Energy has to be allowed to rise as pure potential — but
  // never as velocity.
  let t = 0;
  const env = {
    floorZAt() {
      return Math.min(0.9, t * 0.35);
    },
  };
  const sim = initSim(rig.parent, rig.pos, { floorZ: 0, impulse: [1, 0, 0], seed: 7, env });
  sim.rootValid = true; // pretend the AC root transform is known (identity)
  sim.rootQuat[3] = 1;
  let maxSpeed = 0;
  for (let s = 0; s < 600 && !sim.done; s++) {
    t += dt;
    stepSim(sim, dt);
    for (let i = 0; i < sim.n; i++) {
      const ix = i * 3;
      const sp =
        Math.hypot(sim.pos[ix] - sim.prev[ix], sim.pos[ix + 1] - sim.prev[ix + 1], sim.pos[ix + 2] - sim.prev[ix + 2]) /
        dt;
      if (sp > maxSpeed) maxSpeed = sp;
    }
  }
  console.log(`    max speed on a rising floor = ${maxSpeed.toFixed(2)} m/s, trims = ${sim.trims}`);
  ok(maxSpeed <= RAGDOLL_MAX_SPEED * 1.02, "a rising floor never accelerates the body past the ceiling");
  ok(Number.isFinite(sim.energy), "energy stays finite with an active environment bridge");
}

/* ── 6. degenerate rigs ───────────────────────────────────────────────── */
section("degenerate rigs");
{
  const dt = 1 / 60;
  const cases = [
    ["collinear pole", pole()],
    ["single node", { parent: [ROOT], pos: Float64Array.from([0, 0, 1]) }],
    ["two nodes", { parent: [ROOT, 0], pos: Float64Array.from([0, 0, 1, 0, 0, 1.4]) }],
    [
      "coincident nodes",
      { parent: [ROOT, 0, 1, 2], pos: Float64Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) },
    ],
  ];
  for (const [name, rig] of cases) {
    const sim = initSim(rig.parent, rig.pos, { floorZ: 0, impulse: [3, 2, 1], seed: 99, twistScale: 2 });
    const r = run(sim, dt, 400);
    ok(!r.nan, `${name}: no NaN`);
    ok(r.maxRise <= 1.2, `${name}: no launch (rise ${r.maxRise.toFixed(3)} m)`);
  }
}

/* ── 7. determinism ───────────────────────────────────────────────────── */
section("seeded determinism");
{
  const dt = 1 / 60;
  const rig = biped();
  const mk = () => initSim(rig.parent, rig.pos, { floorZ: 0, impulse: [2, 1, 0.5], seed: 0x1234, twistScale: 1.3 });
  const a = mk();
  const b = mk();
  for (let i = 0; i < 240; i++) {
    stepSim(a, dt);
    stepSim(b, dt);
  }
  let same = true;
  for (let i = 0; i < a.pos.length; i++) if (a.pos[i] !== b.pos[i]) same = false;
  ok(same, "the same seed replays the same death bit-for-bit");
  ok(a.trims === b.trims, "governor trims are deterministic too");
}

/* ── 8. the governor is not over-damping a normal death ───────────────── */
section("a normal death still tumbles");
{
  const dt = 1 / 60;
  const rig = biped();
  let moved = 0;
  let rotated = 0;
  for (let s = 0; s < 40; s++) {
    const ang = (s / 40) * Math.PI * 2;
    const sim = initSim(rig.parent, rig.pos, {
      floorZ: 0,
      impulse: [Math.cos(ang) * 2.2, Math.sin(ang) * 2.2, 0.77],
      seed: 0x2200 + s,
    });
    const headZ0 = sim.pos[2 * 3 + 2];
    run(sim, dt);
    const headZ1 = sim.pos[2 * 3 + 2];
    // A toppled biped's head ends up near the ground, not still standing.
    if (headZ1 < headZ0 * 0.65) rotated++;
    const dx = sim.pos[0] - rig.pos[0];
    const dy = sim.pos[1] - rig.pos[1];
    if (Math.hypot(dx, dy) > 0.05) moved++;
  }
  console.log(`    toppled ${rotated}/40, translated ${moved}/40`);
  ok(rotated >= 34, `bodies still go over (${rotated}/40 dropped the head)`);
  ok(moved >= 30, `bodies still travel (${moved}/40 moved the pelvis)`);
}

console.log(`\nragdoll_energy: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
