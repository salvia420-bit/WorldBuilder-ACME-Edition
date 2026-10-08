// ragdoll_stack.test.mjs — a ragdoll that lands on another body must come to REST.
//
// 2026-10-07 field report (pack fight, Banderlings/Tumeroks killed close
// together): "when one death ragdoll falls onto another corpse it kinda
// started jiggling". Headless repro (this file's §5 world, 17-part Banderling
// Setup 0x02000E08): with the pre-fix bridge, B landing on A ran to the 14 s
// hard stop in ~30% of pack deaths and needed >4 s in ~70% when A died up to
// 0.6 s earlier. Three defects in scene3d/ragdoll_env.js fed it:
//   (a) a settled body was a flat disc with a VERTICAL CLIFF at its rim. The
//       sim projects nodes straight up, so a node on the rim flipped between
//       "floor" and "body top" every step — dropped, was swung back under the
//       rim by its bones, and was teleported up again: a 10-30 Hz limit cycle
//       fed by the projection lift (the one energy source the governor allows);
//   (b) a pack-mate still mid-topple was snapshotted at B's death as a lying
//       body: a 0.6-0.9 m platform that stayed in the air after the body hit
//       the ground (B floated on it and hung off its cliff), and two creatures
//       dying together each read the other that way;
//   (c) any node inside a footprint was lifted onto it — the feet of a
//       creature standing beside a fresh corpse were hoisted 0.9 m in a step.
// Fixes: a continuous body profile + limb bumps (a), tracked bodies + death
// order (b, `?ragdollStackLive`), STACK_STEP_UP_M (c).
//
// `three` is import-stubbed (no Raycaster ⇒ no walls), which isolates the
// floor/stacking path under test — same setup as ragdoll_env.test.mjs.
//
// Run: node tests/ragdoll_stack.test.mjs   (from apps/holtburger-web/)

import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(resolvePath(__dirname, "../_three_stub_loader.mjs")).href);

const {
  initSim,
  stepSim,
  setSimRoot,
  settledFootprint,
  RAGDOLL_MAX_TIME,
  RAGDOLL_MAX_SPEED,
  RAGDOLL_SETTLE_EPS,
} = await import("../scene3d/ragdoll.js");
const {
  envForRagdoll,
  registerSettledBody,
  clearSettledBodies,
  STACK_STEP_UP_M,
  STACK_BODY_HEIGHT_MAX_M,
} = await import("../scene3d/ragdoll_env.js");

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}
function section(n) {
  console.log(`\n— ${n}`);
}

/* ── real rigs (portal.dat Setup, Default placement frame origins) ──────
 * Both are 17-part, THREE-ROOT forests (torso + two legs), exactly what
 * limbs.js hands the live ragdoll (wasm fetchSetupParentIndex is the raw
 * Setup parent_index).
 */
const ROOT = 0xffffffff;
const BANDERLING = {
  // Setup 0x02000E08 (Banderling Scout/Raider/Smasher/…)
  parent: [ROOT, 0, 1, 2, 3, 1, 5, 6, ROOT, 8, 9, ROOT, 11, 12, 1, 10, 13],
  pos: [
    0, 0, 0.8725, 0.0, 0.0265, 0.9979, -0.2087, 0.2339, 1.1994, -0.2451, 0.2639, 0.7118, -0.2113, 0.3161, 0.5429,
    0.2097, 0.2244, 1.2063, 0.2632, 0.2633, 0.7164, 0.2448, 0.3125, 0.5442, -0.115, 0.0, 0.7975, -0.1694, 0.1717,
    0.4962, -0.1665, -0.0074, 0.0615, 0.115, -0.0, 0.8025, 0.1812, 0.1683, 0.5038, 0.1603, -0.0087, 0.0634, 0.0,
    0.2842, 1.2494, -0.1778, 0.0426, 0.0231, 0.1738, 0.0389, 0.0228,
  ],
};
const TUMEROK = {
  // Setup 0x0200140C (Tumerok Champion)
  parent: [ROOT, ROOT, 1, 2, 3, ROOT, 5, 6, 7, 0, 9, 10, 11, 9, 13, 14, 9],
  pos: [
    0, 0, 0.9625, -0.1063, 0.0, 0.9625, -0.0912, 0.0, 0.5325, -0.0782, -0.0783, 0.0878, -0.0888, 0.0309, 0.0173,
    0.1063, -0.0, 0.9625, 0.0912, 0.0, 0.5325, 0.0773, -0.0784, 0.0878, 0.0919, 0.0296, 0.0173, 0, 0, 1.19, -0.2255,
    -0.0179, 1.4924, -0.2803, 0.1108, 1.0695, -0.2695, 0.2099, 0.9318, 0.2255, -0.0179, 1.4924, 0.3012, 0.0239,
    1.0537, 0.2979, 0.0902, 0.8973, 0.0, 0.0134, 1.5875,
  ],
};
// kill_impulse.js FALL_STYLES knobs
const STYLES = [
  { topple: 1.0, twist: 1.0, spread: 0.55 }, // topple
  { topple: 0.9, twist: 2.1, spread: 0.8 }, // spinout
  { topple: 0.32, twist: 0.7, spread: 1.5 }, // crumple
  { topple: 1.15, twist: 0.8, spread: 0.5 }, // faceplant
  { topple: 1.1, twist: 0.9, spread: 0.7 }, // backflop
];

const GROUND = 10;
const DT = 1 / 60;

/* ── a minimal entity world: what entities.js + applyRagdoll do per frame ──
 * Every ragdoll steps in the same frame loop and writes its parts (applyRagdoll),
 * the corpse arrives HIDDEN 0.3 s after each death and the creature root snaps
 * onto it (`_tryCorpseDeathHandoff`), and once the sim rests the sprawl moves to
 * the corpse and the creature leaves the entity map (finishReveal).
 */
function makeWorld(stackLive) {
  clearSettledBodies();
  const map = new Map();
  const live = {
    entitiesGroup: null,
    worldRoot: null,
    cellsGroup: null,
    buildingsGroup: null,
    entityManager: { entityMap: map },
    sessionHandle: { terrainHeightAt: () => GROUND },
  };
  const w = { map, live, t: 0, stackLive };
  w.spawn = (guid, rig, x, y, yaw) => {
    const inst = {
      guid,
      rig,
      root: {
        position: { x, y, z: GROUND },
        quaternion: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) },
        scale: { x: 1, y: 1, z: 1 },
      },
      parts: rig.parent.map((_p, i) => ({ position: { x: rig.pos[i * 3], y: rig.pos[i * 3 + 1], z: rig.pos[i * 3 + 2] } })),
      meta: { objDescFlags: 0 },
      maxSpeed: 0,
    };
    map.set(guid, inst);
    return inst;
  };
  w.kill = (inst, dirWorld, seed, style) => {
    inst._deathAt = w.t * 1000 + inst.guid * 1e-6;
    const q = inst.root.quaternion;
    const yaw = 2 * Math.atan2(q.z, q.w);
    const c = Math.cos(-yaw);
    const s = Math.sin(-yaw);
    const dx = dirWorld[0] * c - dirWorld[1] * s;
    const dy = dirWorld[0] * s + dirWorld[1] * c;
    const pos = Float64Array.from(inst.parts.flatMap((p) => [p.position.x, p.position.y, p.position.z]));
    const env = envForRagdoll(inst, { live, ...(stackLive === undefined ? {} : { stackLive }) });
    inst.sim = initSim(inst.rig.parent, pos, {
      floorZ: 0,
      env,
      impulse: [dx * 2.2, dy * 2.2, 0.77],
      dir: [dx, dy],
      seed,
      toppleScale: style.topple,
      twistScale: style.twist,
      dirJitter: style.spread,
    });
    inst.killT = w.t;
  };
  w.step = () => {
    w.t += DT;
    for (const inst of [...map.values()]) {
      // handoff: hidden corpse arrives, then reveal + creature removal
      if (inst.sim && !inst.corpse && w.t >= inst.killT + 0.3) {
        const corpse = {
          guid: inst.guid + 100,
          root: { position: { ...inst.root.position }, quaternion: { ...inst.root.quaternion }, scale: { x: 1, y: 1, z: 1 } },
          parts: inst.parts.map((_p, i) => ({ position: { x: 0, y: i * 0.09, z: 0.15 } })), // authored prone stand-in
          meta: { objDescFlags: 0x2000 },
          _hiddenForHandoff: true,
        };
        map.set(corpse.guid, corpse);
        inst.corpse = corpse;
      }
      if (inst.corpse && !inst.removed && inst.sim.done && w.t >= inst.doneT + 0.1) {
        inst.corpse.parts = inst.parts.map((p) => ({ position: { ...p.position } }));
        inst.corpse._ragdollFrozenPose = { n: inst.parts.length };
        inst.corpse._hiddenForHandoff = false;
        map.delete(inst.guid);
        inst.removed = true;
      }
      const sim = inst.sim;
      if (!sim || sim.done) continue;
      setSimRoot(sim, inst.root.position, inst.root.quaternion, inst.root.scale);
      stepSim(sim, DT);
      for (let i = 0; i < sim.n; i++) {
        const p = inst.parts[i].position;
        p.x = sim.pos[i * 3];
        p.y = sim.pos[i * 3 + 1];
        p.z = sim.pos[i * 3 + 2];
        const sp = Math.hypot(sim.pos[i * 3] - sim.prev[i * 3], sim.pos[i * 3 + 1] - sim.prev[i * 3 + 1], sim.pos[i * 3 + 2] - sim.prev[i * 3 + 2]) / DT;
        if (sp > inst.maxSpeed) inst.maxSpeed = sp;
      }
      if (sim.done && inst.doneT === undefined) {
        inst.doneT = w.t;
        const f = settledFootprint(sim); // what ragdoll.js reportSettled registers
        if (f) registerSettledBody(f.x, f.y, f.top, f.r);
      }
    }
  };
  return w;
}

/** AC-frame node positions of an instance. */
function acNodes(inst) {
  const q = inst.root.quaternion;
  const yaw = 2 * Math.atan2(q.z, q.w);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const rp = inst.root.position;
  return inst.parts.map((p) => [
    rp.x + p.position.x * c - p.position.y * s,
    rp.y + p.position.x * s + p.position.y * c,
    rp.z + p.position.z,
  ]);
}

/**
 * A dies; B, standing 0.6-1.4 m away, dies `delay` s later toppling over A's
 * body. Returns per-B diagnostics.
 */
function packDeath(s, delay, rig = BANDERLING, stackLive) {
  const w = makeWorld(stackLive);
  const angA = (s * 0.7) % (Math.PI * 2);
  const dirA = [Math.cos(angA), Math.sin(angA)];
  const d = 0.6 + (0.8 * ((s * 37) % 11)) / 10;
  const off = [-dirA[1] * d + dirA[0] * 0.6, dirA[0] * d + dirA[1] * 0.6];
  const A = w.spawn(1, rig, 100, 200, (s * 1.3) % 6.28);
  const B = w.spawn(2, rig, 100 + off[0], 200 + off[1], (s * 2.1) % 6.28);
  const toA = [dirA[0] * 0.6 - off[0], dirA[1] * 0.6 - off[1]];
  const l = Math.hypot(toA[0], toA[1]);
  w.kill(A, dirA, 0x900 + s, STYLES[(s + 2) % 5]);
  let bKilled = false;
  let lateMoves = 0;
  let bSteps = 0;
  for (let st = 0; st < (delay + 16) * 60; st++) {
    if (!bKilled && w.t >= delay - 1e-9) {
      w.kill(B, [toA[0] / l, toA[1] / l], 0x1900 + s, STYLES[s % 5]);
      bKilled = true;
    }
    const wasDone = B.sim ? B.sim.done : true;
    const prevPos = B.sim ? Float64Array.from(B.sim.pos) : null;
    w.step();
    if (B.sim && !wasDone) {
      bSteps++;
      let m = 0;
      for (let i = 0; i < prevPos.length; i += 3) {
        m = Math.max(m, Math.hypot(B.sim.pos[i] - prevPos[i], B.sim.pos[i + 1] - prevPos[i + 1], B.sim.pos[i + 2] - prevPos[i + 2]));
      }
      if (B.sim.t > 4 && m >= RAGDOLL_SETTLE_EPS) lateMoves++;
    }
    if (bKilled && B.sim.done && A.sim.done) break;
  }
  // drape: B nodes within 0.15 m (horizontally) of an A node must sit above it;
  // B nodes > 0.15 m off the ground must have some A node within 0.4 m.
  const a = acNodes(A);
  const b = acNodes(B);
  let through = 0;
  let floating = 0;
  let pairs = 0;
  for (const pb of b) {
    let near = Infinity;
    let below = null;
    for (const pa of a) {
      const dd = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      if (dd < near) near = dd;
      if (dd < 0.15 && (below === null || pa[2] > below)) below = pa[2];
    }
    if (below !== null) {
      pairs++;
      if (pb[2] - below < 0.03) through++;
    }
    if (near > 0.4 && pb[2] - GROUND > 0.15) floating++;
  }
  return {
    settled: B.sim.done && B.sim.t < RAGDOLL_MAX_TIME,
    t: B.sim.t,
    lateMoves,
    maxSpeed: B.maxSpeed,
    through,
    floating,
    pairs,
    bodies: B.sim.env ? B.sim.env.bodyCount : 0,
    tracked: B.sim.env ? B.sim.env.trackedBodies : 0,
  };
}

/* ── 1. a body's surface is CONTINUOUS (defect a) ─────────────────────── */
section("body surface has no rim cliff");
{
  const w = makeWorld(); // (clears the registry)
  registerSettledBody(101, 200, GROUND + 0.4, 0.8);
  const inst = { root: { position: { x: 100, y: 200, z: GROUND } }, _outdoorCellIdx: 2 };
  const env = envForRagdoll(inst, { live: w.live });
  ok(env && env.bodyCount === 1, "the registered body is gathered");
  let worstJump = 0;
  let prev = env.floorZAt(99.9, 200);
  for (let x = 99.9; x <= 102.1; x += 0.001) {
    const z = env.floorZAt(x, 200);
    worstJump = Math.max(worstJump, Math.abs(z - prev));
    prev = z;
  }
  console.log(`    worst support change per 1 mm across the body: ${(worstJump * 1000).toFixed(2)} mm`);
  ok(worstJump < 0.005, `support never jumps more than 5 mm per 1 mm of travel (pre-fix: the whole 0.4 m at the rim; got ${(worstJump * 1000).toFixed(2)} mm)`);
  ok(Math.abs(env.floorZAt(101, 200) - (GROUND + 0.4)) < 1e-9, "…and the body's centre still reads its full top");
  ok(env.floorZAt(102.5, 200) === GROUND, "…and outside the footprint it is the floor");
  clearSettledBodies();
}

/* ── 2. a body does not hoist a node that is beside/under it (defect c) ── */
section("no hoisting onto a body from below");
{
  clearSettledBodies();
  // a pack-mate that has only just died: still standing (clamps to 0.9 m)
  const w = makeWorld(true);
  const A = w.spawn(1, BANDERLING, 101, 200, 0);
  A._deathAt = 0;
  const me = { _deathAt: 5, root: { position: { x: 100, y: 200, z: GROUND } }, _outdoorCellIdx: 2 };
  const env = envForRagdoll(me, { live: w.live });
  ok(env && env.bodyCount === 1, "the earlier-dying pack-mate is gathered");
  const top = env.floorZAt(101, 200);
  ok(top > GROUND + 0.5 && top <= GROUND + STACK_BODY_HEIGHT_MAX_M + 1e-9, `it reads as a (clamped) tall body (${(top - GROUND).toFixed(2)} m)`);
  // my foot at ankle height inside its footprint (its own feet are ankle-high
  // bumps there, so a few cm is legitimate — its 0.9 m top is not)
  const foot = env.floorZAt(101, 200, GROUND + 0.06);
  ok(foot - GROUND < STACK_STEP_UP_M,
    `a node at the ankle beside it is not hoisted onto it (pre-fix: ${(top - GROUND).toFixed(2)} m in one step; got ${(foot - GROUND).toFixed(2)} m)`);
  const landing = env.floorZAt(101, 200, top - STACK_STEP_UP_M * 0.5);
  ok(landing === top, "a node coming down onto it from above IS supported");
  clearSettledBodies();
}

/* ── 3. death order: who may rest on whom (defect b) ─────────────────── */
section("death order is a DAG");
{
  clearSettledBodies();
  const w = makeWorld(true);
  const A = w.spawn(1, BANDERLING, 101, 200, 0);
  const me = { _deathAt: 1000, root: { position: { x: 100, y: 200, z: GROUND } }, _outdoorCellIdx: 2 };
  A._deathAt = 999;
  ok(envForRagdoll(me, { live: w.live }).bodyCount === 1, "a creature that went down BEFORE me is under me");
  A._deathAt = 1000;
  const same = envForRagdoll(me, { live: w.live });
  ok(!same || same.bodyCount === 0, "one that went down in the same instant is not");
  A._deathAt = 1001;
  const later = envForRagdoll(me, { live: w.live });
  ok(!later || later.bodyCount === 0, "one that went down AFTER me is not (pre-fix: both read each other)");
  A._ragdollFrozenPose = { n: 17 };
  ok(envForRagdoll(me, { live: w.live }).bodyCount === 1, "a corpse sprawl always is");
  const legacy = envForRagdoll(me, { live: w.live, stackLive: false });
  ok(legacy && legacy.trackedBodies === 0 && legacy.stackLive === false, "?ragdollStackLive=off falls back to the one-shot snapshot");
  clearSettledBodies();
}

/* ── 4. a tracked body follows its pose; handoff keeps the surface ────── */
section("tracked body surface");
{
  clearSettledBodies();
  const w = makeWorld(true);
  const A = w.spawn(1, BANDERLING, 101, 200, 0);
  A._deathAt = 0;
  for (const p of A.parts) p.position.z = 0.6; // mid-fall
  const me = { _deathAt: 5, root: { position: { x: 100, y: 200, z: GROUND } }, _outdoorCellIdx: 2 };
  const env = envForRagdoll(me, { live: w.live });
  ok(env.trackedBodies === 1, "the dying pack-mate is tracked");
  const cx = 101 + A.parts.reduce((s, p) => s + p.position.x, 0) / A.parts.length;
  const cy = 200 + A.parts.reduce((s, p) => s + p.position.y, 0) / A.parts.length;
  const high = env.floorZAt(cx, cy);
  for (const p of A.parts) p.position.z = 0.1; // …and it hits the ground
  env.beginStep();
  const low = env.floorZAt(cx, cy);
  console.log(`    surface over the body: ${(high - GROUND).toFixed(2)} m mid-fall → ${(low - GROUND).toFixed(2)} m on the ground`);
  ok(low < high - 0.3, "the surface follows the body down (pre-fix: frozen at the mid-fall height)");
  w.map.delete(1); // handoff: creature removed, corpse takes the same sprawl
  for (const p of A.parts) p.position.z = 5; // a disposed rig must not be read
  env.beginStep();
  ok(Math.abs(env.floorZAt(cx, cy) - low) < 1e-9, "a body removed at the handoff keeps its last surface");
  // a corpse hidden for the handoff contributes nothing until revealed
  const w2 = makeWorld(true);
  const C = w2.spawn(7, BANDERLING, 101, 200, 0);
  for (const p of C.parts) p.position.z = 0.15;
  C.meta.objDescFlags = 0x2000;
  C._hiddenForHandoff = true;
  const env2 = envForRagdoll(me, { live: w2.live });
  ok(env2.floorZAt(cx, cy) === GROUND, "a hidden (handoff) corpse is not a surface yet");
  C._hiddenForHandoff = false;
  env2.beginStep();
  ok(env2.floorZAt(cx, cy) > GROUND + 0.1, "…and is once revealed");
  clearSettledBodies();
}

/* ── 5. THE regression: pack deaths come to rest ───────────────────────── */
section("pack fight: B lands on A and SETTLES (17-part Banderling / Tumerok)");
{
  const cases = [];
  for (const delay of [0, 0.3, 0.6, 1.0, 4.0]) {
    for (let s = 0; s < 8; s++) cases.push({ s, delay, rig: s % 4 === 3 ? TUMEROK : BANDERLING });
  }
  let settled = 0;
  let over4 = 0;
  let worstT = 0;
  let worstLate = 0;
  let worstSpeed = 0;
  let through = 0;
  let floating = 0;
  let pairs = 0;
  let stacked = 0;
  for (const c of cases) {
    const r = packDeath(c.s, c.delay, c.rig);
    if (r.settled) settled++;
    if (r.t > 4) over4++;
    worstT = Math.max(worstT, r.t);
    worstLate = Math.max(worstLate, r.lateMoves);
    worstSpeed = Math.max(worstSpeed, r.maxSpeed);
    through += r.through;
    floating += r.floating;
    pairs += r.pairs;
    if (r.bodies > 0) stacked++;
  }
  const N = cases.length;
  console.log(
    `    ${settled}/${N} rested via the settle metric (worst ${worstT.toFixed(2)} s, ${over4} past 4 s); ` +
      `worst moving steps after 4 s ${worstLate}; B-over-A node pairs ${pairs}, through ${through}, floating ${floating}`,
  );
  ok(stacked >= N - 2, `B actually had A under it (${stacked}/${N})`);
  ok(settled === N, `every stacked death rests through the settle metric, never the ${RAGDOLL_MAX_TIME} s hard stop (${settled}/${N})`);
  ok(over4 <= 2, `stacked deaths rest about as fast as flat-ground ones (${over4}/${N} past 4 s)`);
  ok(worstLate <= 90, `no sustained jiggle: ≤ 1.5 s of above-rest motion after 4 s (worst ${worstLate} steps)`);
  ok(pairs >= N, `B drapes over A (${pairs} B nodes directly over an A node)`);
  ok(through === 0, `…and never through it (${through} B nodes level with/below the A node under them)`);
  ok(floating === 0, `…and never on a phantom (${floating} B nodes > 0.15 m up with no A node within 0.4 m)`);
  ok(worstSpeed <= RAGDOLL_MAX_SPEED * 1.02, `energy guarantees hold on a body: per-node speed ≤ ${RAGDOLL_MAX_SPEED} m/s (worst ${worstSpeed.toFixed(2)})`);
}

/* ── 6. the legacy escape still rests (continuous profile is unconditional) ─ */
section("?ragdollStackLive=off still settles on a SETTLED corpse");
{
  let settled = 0;
  let N = 0;
  for (let s = 0; s < 8; s++) {
    const r = packDeath(s, 4.0, BANDERLING, false);
    N++;
    if (r.settled && r.t < 6) settled++;
  }
  ok(settled === N, `legacy snapshot + continuous profile: ${settled}/${N} rest within 6 s`);
}

console.log(`\nragdoll_stack: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
