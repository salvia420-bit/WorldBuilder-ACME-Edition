// scene3d/ragdoll.js — Phase 4 death-time ragdoll (?ragdoll — DEFAULT ON, =off escape).
//
// Replaces the *look* of the authored Ready→Dead collapse with a physical
// tumble: a verlet particle per setup part, distance constraints along the
// Setup `parent_index` joint graph, a ground plane (flat, or sampled from the
// optional environment bridge so corpses stack on terrain and on each other),
// and per-part orientation swung by the bone direction. Runs in MODEL SPACE
// (part Groups are root-local; AC up = +Z and heading is a yaw about Z, so
// root-local −Z is always "down").
//
// DYNAMICS MODEL (2026-08-02 rewrite — "jenga tower", not "soft slump"):
//   1. STRUCTURE. Beyond the bone (parent) and bend (grandparent) links, every
//      node is braced to 2-3 automatically chosen anchor nodes. Distances to
//      three non-collinear anchors pin a point completely, so with the braces
//      at full gain the whole creature is a quasi-rigid body: it cannot sag,
//      shear or fold. That is the tower before you pull the block.
//   2. PROGRESSIVE GIVE. Each brace (and each bend link) carries its own
//      randomized [t0, t1] window over the first ~0.3-1.8 s across which its
//      gain smoothsteps to zero, biased so extremities let go before the core.
//      The body therefore topples as a unit, hinges at whatever is touching
//      the ground, and only then crumples — joint by joint, in a different
//      order every death.
//   3. TOPPLE, NOT SINK. The death impulse seeds a rigid-body ANGULAR velocity
//      about a horizontal axis through a ground pivot (the leading edge of the
//      lowest nodes), not a downward shove, plus a randomized TWIST about the
//      vertical through the body centre — bodies rotate as they go over.
//   4. VARIETY. Direction jitter, topple rate, twist sign/magnitude, per-node
//      jitter, joint give order/timing and floor bounce are all drawn from a
//      per-death PRNG (`opts.seed` makes a death reproducible for tests). No
//      module-scope randomness.
//
// Safety model mirrors Phase 2's limp exactly: we never touch the mixer, the
// tracks, or the Group graph — every frame we overwrite part.position /
// part.quaternion AFTER all rig writers ran (post-evaluation), and only while
// `inst._ragdoll` exists. The authored collapse still plays underneath and
// still sizes the death-hold window (`inst._deathEndAt`), so entity lifetime
// and corpse handoff timing are untouched. Retail ground truth (decomp
// 2026-08-02): death was pure animation, so there is no behaviour to stay
// compatible with; the one retail invariant — Dead may play without ground
// contact — holds trivially here.
//
// No three.js import: this module is bare-node importable (test suites import
// scene3d modules directly), so vector/quaternion math is hand-rolled on
// plain arrays, same policy as limbs.js.

import { ensureLimbRegistry, getLimbRegistry } from "./limbs.js";

export function ragdollEnabled() {
  try {
    return new URLSearchParams(window.location.search).get("ragdoll") !== "off";
  } catch (_e) {
    return false;
  }
}

/* ── tunables (exported for the 1070 retune session) ─────────────────── */
export const RAGDOLL_GRAVITY = 9.8; // m/s^2, model-space −Z
export const RAGDOLL_DAMPING = 0.985; // per-step velocity retention
export const RAGDOLL_FLOOR_FRICTION = 0.55; // horizontal velocity kept on contact
export const RAGDOLL_NODE_RADIUS = 0.06; // floor clearance per part origin
export const RAGDOLL_ITERATIONS = 3; // constraint relaxation passes
export const RAGDOLL_IMPULSE = 2.2; // m/s baseline topple push
export const RAGDOLL_IMPULSE_CRIT = 4.2; // m/s crit-death push
export const RAGDOLL_SETTLE_EPS = 0.0012; // max node move (m/step) counted as rest
export const RAGDOLL_SETTLE_FRAMES = 24; // consecutive rest steps before freeze
export const RAGDOLL_MAX_TIME = 14; // s hard stop (a sim can never run forever)
export const RAGDOLL_CALM_DAMPING = 0.9; // damping a long-lived sim decays to
export const RAGDOLL_CALM_START = 5.0; // s before the extra damping ramps in
export const RAGDOLL_CALM_SPAN = 4.0; // s over which it ramps
export const RAGDOLL_ITERATIONS_RIGID = 5; // relaxation passes while the braces hold

/* structural resistance ("jenga") */
export const RAGDOLL_BRACE_STIFF = 1.0; // rigidity strut stiffness at full gain
export const RAGDOLL_BEND_RIGID = 1.0; // grandparent stiffness while rigid (rests at 0.5)
export const RAGDOLL_GIVE_MIN = 0.3; // s — earliest a joint starts to let go
export const RAGDOLL_GIVE_SPAN = 0.95; // s — spread of give-start times
export const RAGDOLL_GIVE_RAMP = 0.45; // s — nominal give duration per joint
export const RAGDOLL_CORE_BIAS = 0.55; // how strongly tree depth orders the give

/* topple seeding */
export const RAGDOLL_TOPPLE_GAIN = 1.0; // scales the seeded angular rate
export const RAGDOLL_TOPPLE_RATE_CAP = 0.6; // × sqrt(g/height): hard ceiling so
// short, wide creatures topple instead of cartwheeling. Gravity, not the
// impulse, does most of the work once the pivot lead puts the body off balance.
export const RAGDOLL_TWIST = 2.2; // rad/s peak spin about the vertical
export const RAGDOLL_DIR_JITTER = 0.9; // rad, total spread around the given dir
export const RAGDOLL_PIVOT_LEAD = 0.18; // pivot offset along the fall dir (× body height)
export const RAGDOLL_LINEAR_FRAC = 0.25; // fraction of the impulse kept as a shove
export const RAGDOLL_JITTER = 0.12; // m/s per-node asymmetry
export const RAGDOLL_BOUNCE_MAX = 0.35; // peak floor restitution

const MAX_DT = 1 / 30; // clamp so a tab restore cannot explode the sim
const ROOT = 0xffffffff;

/* ── pure math (node-tested) ─────────────────────────────────────────── */

/** Deterministic PRNG so a seeded death replays exactly (mulberry32). */
function mulberry32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const validParent = (p, n) => p !== ROOT && p !== undefined && p !== null && p >= 0 && p < n;

/** smoothstep-out: 1 while t<=t0, 0 once t>=t1 (a joint letting go). */
function giveGain(t, t0, t1) {
  if (!(t1 > t0)) return 0;
  if (t <= t0) return 1;
  if (t >= t1) return 0;
  const u = (t1 - t) / (t1 - t0);
  return u * u * (3 - 2 * u);
}

/**
 * Distance constraints from a Setup parent-index array: one per parent link
 * (bone — always stiff, bones do not stretch) and one per grandparent link
 * (bend — stiff early so chains stay straight, relaxing to 0.5 as the body
 * gives). Rest lengths and the per-joint give window [t0, t1] are filled in
 * by `initSim` from the death-moment pose.
 */
export function buildConstraints(parentIndex) {
  const cons = [];
  const n = parentIndex.length;
  for (let i = 0; i < n; i++) {
    const p = parentIndex[i];
    if (!validParent(p, n)) continue;
    cons.push({ a: i, b: p, rest: 0, stiff: 1.0, kind: "bone", t0: 0, t1: 0 });
    const gp = parentIndex[p];
    if (validParent(gp, n)) {
      cons.push({ a: i, b: gp, rest: 0, stiff: 0.5, kind: "bend", t0: 0, t1: 0 });
    }
  }
  return cons;
}

/** Tree depth of every node (root = 0); cycle-safe. */
export function buildDepths(parentIndex) {
  const n = parentIndex.length;
  const depth = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let cur = i;
    let d = 0;
    for (let guard = 0; guard < n; guard++) {
      const p = parentIndex[cur];
      if (!validParent(p, n) || p === cur) break;
      cur = p;
      d++;
    }
    depth[i] = d;
  }
  return depth;
}

/**
 * Rigidity struts ("braces"): every node is tied to 2-3 anchor nodes chosen to
 * span the body (the lowest node, the node farthest from it, the node farthest
 * off that line). Distances to three non-collinear points pin a particle
 * outright, so at full gain the creature behaves as ONE rigid object — it
 * topples instead of slumping. Each strut then fades out over its own
 * randomized window, so the body gives progressively and differently every
 * death.
 *
 * `rand` is a 0..1 generator; `depth` comes from buildDepths (deeper joints
 * let go earlier — limbs flop before the torso).
 */
export function buildBraces(parentIndex, positions, rand = Math.random, depth = null) {
  const n = parentIndex.length;
  const braces = [];
  if (n < 4) return braces;
  const d = depth || buildDepths(parentIndex);
  let maxDepth = 1;
  for (let i = 0; i < n; i++) if (d[i] > maxDepth) maxDepth = d[i];

  const dist = (i, j) =>
    Math.hypot(
      positions[i * 3] - positions[j * 3],
      positions[i * 3 + 1] - positions[j * 3 + 1],
      positions[i * 3 + 2] - positions[j * 3 + 2],
    );

  // a1 = lowest node (the part most likely already touching the ground)
  let a1 = 0;
  for (let i = 1; i < n; i++) if (positions[i * 3 + 2] < positions[a1 * 3 + 2]) a1 = i;
  // a2 = farthest from a1
  let a2 = -1;
  let best = 0;
  for (let i = 0; i < n; i++) {
    if (i === a1) continue;
    const l = dist(i, a1);
    if (l > best) {
      best = l;
      a2 = i;
    }
  }
  if (a2 < 0 || best < 1e-4) return braces;
  // a3 = farthest off the a1→a2 line (dropped when the rig is collinear —
  // two anchors already pin a collinear body up to a spin about its own axis)
  const vx = (positions[a2 * 3] - positions[a1 * 3]) / best;
  const vy = (positions[a2 * 3 + 1] - positions[a1 * 3 + 1]) / best;
  const vz = (positions[a2 * 3 + 2] - positions[a1 * 3 + 2]) / best;
  let a3 = -1;
  let bestPerp = 0;
  for (let i = 0; i < n; i++) {
    if (i === a1 || i === a2) continue;
    const wx = positions[i * 3] - positions[a1 * 3];
    const wy = positions[i * 3 + 1] - positions[a1 * 3 + 1];
    const wz = positions[i * 3 + 2] - positions[a1 * 3 + 2];
    const dp = wx * vx + wy * vy + wz * vz;
    const perp = Math.hypot(wx - dp * vx, wy - dp * vy, wz - dp * vz);
    if (perp > bestPerp) {
      bestPerp = perp;
      a3 = i;
    }
  }
  const anchors = a3 >= 0 && bestPerp > 1e-3 * best ? [a1, a2, a3] : [a1, a2];

  const window = (coreness, extraHold) => {
    const t0 =
      RAGDOLL_GIVE_MIN +
      RAGDOLL_GIVE_SPAN * (RAGDOLL_CORE_BIAS * coreness + (1 - RAGDOLL_CORE_BIAS) * rand()) +
      extraHold;
    return { t0, t1: t0 + RAGDOLL_GIVE_RAMP * (0.6 + 0.8 * rand()) };
  };

  for (let i = 0; i < n; i++) {
    if (anchors.indexOf(i) >= 0) continue;
    const coreness = 1 - d[i] / maxDepth; // 1 = torso/root, 0 = fingertip
    for (const a of anchors) {
      const rest = dist(i, a);
      if (!(rest > 1e-4)) continue;
      const w = window(coreness, 0);
      braces.push({ a: i, b: a, rest, t0: w.t0, t1: w.t1 });
    }
  }
  // the anchor triangle itself is the core — it lets go last
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      const rest = dist(anchors[i], anchors[j]);
      if (!(rest > 1e-4)) continue;
      const w = window(1, RAGDOLL_GIVE_SPAN * 0.25);
      braces.push({ a: anchors[i], b: anchors[j], rest, t0: w.t0, t1: w.t1 });
    }
  }
  return braces;
}

/** First child of each part (longest rest bone wins) — orientation bones. */
export function buildBoneChildren(parentIndex, positions) {
  const child = new Array(parentIndex.length).fill(-1);
  const best = new Array(parentIndex.length).fill(0);
  for (let i = 0; i < parentIndex.length; i++) {
    const p = parentIndex[i];
    if (!validParent(p, parentIndex.length)) continue;
    const dx = positions[i * 3] - positions[p * 3];
    const dy = positions[i * 3 + 1] - positions[p * 3 + 1];
    const dz = positions[i * 3 + 2] - positions[p * 3 + 2];
    const len = Math.hypot(dx, dy, dz);
    if (len > best[p]) {
      best[p] = len;
      child[p] = i;
    }
  }
  return child;
}

/**
 * Build a sim from flat death-moment part positions (length 3n).
 *
 * Options:
 *   floorZ    flat fallback ground plane (model space)
 *   impulse   [vx, vy, vz] — the XY sets the fall DIRECTION and the topple
 *             rate (it is NOT applied as a downward shove any more), Z is a
 *             straight upward pop so crits hop before they go over
 *   seed      uint32; omit for a fresh random death
 *   dir       [dx, dy] explicit fall direction (overrides the impulse XY dir)
 *   env       { floorZAt(acX, acY), constrainAC(pos, radius) } or null
 */
export function initSim(
  parentIndex,
  positions,
  { floorZ = 0, impulse = [0, 0, 0], dt = 1 / 60, seed = null, dir = null, env = null } = {},
) {
  const n = parentIndex.length;
  const pos = Float64Array.from(positions);
  const prev = new Float64Array(n * 3);
  const rand = mulberry32(seed === null || seed === undefined ? (Math.random() * 4294967296) >>> 0 : seed);

  /* body extents + centres --------------------------------------------- */
  let zMin = Infinity;
  let zMax = -Infinity;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const z = pos[i * 3 + 2];
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
    cx += pos[i * 3];
    cy += pos[i * 3 + 1];
  }
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax)) {
    zMin = 0;
    zMax = 0;
  }
  cx = n ? cx / n : 0;
  cy = n ? cy / n : 0;
  const height = Math.max(0.25, zMax - zMin);

  /* fall direction (jittered) + rates ---------------------------------- */
  const ix0 = impulse[0] || 0;
  const iy0 = impulse[1] || 0;
  const speed = Math.hypot(ix0, iy0);
  let ang;
  if (dir && Number.isFinite(dir[0]) && (dir[0] !== 0 || dir[1] !== 0)) ang = Math.atan2(dir[1], dir[0]);
  else if (speed > 1e-6) ang = Math.atan2(iy0, ix0);
  else ang = rand() * Math.PI * 2;
  ang += (rand() - 0.5) * RAGDOLL_DIR_JITTER;
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);

  // angular rate about the horizontal axis perpendicular to the fall dir,
  // signed so the TOP of the body swings toward (dx, dy): ω = rate·(−dy, dx, 0)
  // cap FIRST, jitter after — capping the jittered value would clip the spread
  // away on small creatures and make every one of their deaths identical.
  const rate =
    Math.min(
      ((speed || RAGDOLL_IMPULSE) / height) * RAGDOLL_TOPPLE_GAIN,
      RAGDOLL_TOPPLE_RATE_CAP * Math.sqrt(RAGDOLL_GRAVITY / height),
    ) *
    (0.7 + 0.6 * rand());
  const ox = -dy * rate;
  const oy = dx * rate;
  const twist = RAGDOLL_TWIST * (rand() < 0.5 ? -1 : 1) * (0.35 + 0.65 * rand());

  /* ground pivot: the leading edge of the lowest nodes ------------------ */
  let px = 0;
  let py = 0;
  let cnt = 0;
  const lowBand = zMin + 0.25 * height;
  for (let i = 0; i < n; i++) {
    if (pos[i * 3 + 2] <= lowBand) {
      px += pos[i * 3];
      py += pos[i * 3 + 1];
      cnt++;
    }
  }
  if (cnt) {
    px /= cnt;
    py /= cnt;
  } else {
    px = cx;
    py = cy;
  }
  px += dx * RAGDOLL_PIVOT_LEAD * height;
  py += dy * RAGDOLL_PIVOT_LEAD * height;
  const pz = zMin;

  /* seed velocities as ω × r (+ shove, pop, per-node jitter) ------------ */
  const shove = RAGDOLL_LINEAR_FRAC * (speed || 0);
  const pop = impulse[2] || 0;
  const jitter = RAGDOLL_JITTER * (0.3 + (speed || 0) / RAGDOLL_IMPULSE);
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const rx = pos[i3] - px;
    const ry = pos[i3 + 1] - py;
    const rz = pos[i3 + 2] - pz;
    // topple: (ox, oy, 0) × r
    let vx = oy * rz;
    let vy = -ox * rz;
    let vz = ox * ry - oy * rx;
    // twist: (0, 0, twist) × (r about the body centre)
    vx -= twist * (pos[i3 + 1] - cy);
    vy += twist * (pos[i3] - cx);
    vx += dx * shove + (rand() - 0.5) * jitter;
    vy += dy * shove + (rand() - 0.5) * jitter;
    vz += pop + (rand() - 0.5) * jitter;
    prev[i3] = pos[i3] - vx * dt;
    prev[i3 + 1] = pos[i3 + 1] - vy * dt;
    prev[i3 + 2] = pos[i3 + 2] - vz * dt;
  }

  /* structure + per-joint give schedule --------------------------------- */
  const depth = buildDepths(parentIndex);
  let maxDepth = 1;
  for (let i = 0; i < n; i++) if (depth[i] > maxDepth) maxDepth = depth[i];
  const constraints = buildConstraints(parentIndex);
  for (const c of constraints) {
    const ax = c.a * 3;
    const bx = c.b * 3;
    c.rest = Math.hypot(pos[ax] - pos[bx], pos[ax + 1] - pos[bx + 1], pos[ax + 2] - pos[bx + 2]);
    if (c.kind === "bend") {
      const coreness = 1 - depth[c.a] / maxDepth;
      c.t0 =
        RAGDOLL_GIVE_MIN + RAGDOLL_GIVE_SPAN * (RAGDOLL_CORE_BIAS * coreness + (1 - RAGDOLL_CORE_BIAS) * rand());
      c.t1 = c.t0 + RAGDOLL_GIVE_RAMP * (0.6 + 0.8 * rand());
    }
  }
  const braces = buildBraces(parentIndex, pos, rand, depth);
  let braceEndT = 0;
  for (const b of braces) if (b.t1 > braceEndT) braceEndT = b.t1;
  for (const c of constraints) if (c.t1 > braceEndT) braceEndT = c.t1;

  const support = new Float64Array(n);
  support.fill(floorZ);

  return {
    n,
    pos,
    prev,
    constraints,
    braces,
    kEff: new Float64Array(constraints.length),
    kBrace: new Float64Array(braces.length),
    support,
    floorZ,
    braceEndT,
    bounce: RAGDOLL_BOUNCE_MAX * rand() * rand(), // skewed low: most deaths thud
    t: 0,
    settled: 0,
    done: false,
    // environment bridge (all optional; null ⇒ flat floorZ, exactly as before)
    env: env && (typeof env.floorZAt === "function" || typeof env.constrainAC === "function") ? env : null,
    rootPos: new Float64Array(3),
    rootQuat: Float64Array.from([0, 0, 0, 1]),
    rootScale: Float64Array.from([1, 1, 1]),
    rootValid: false,
    _flatSupport: floorZ,
    _v: new Float64Array(3), // scratch — stepSim allocates nothing
    _ac: { x: 0, y: 0, z: 0 }, // scratch handed to env.constrainAC
    // telemetry (read by __diag.ragdoll.state)
    seedDir: [dx, dy],
    twist,
  };
}

/** Point the sim at the entity root's AC transform (cheap; called per frame). */
export function setSimRoot(sim, position, quaternion, scale) {
  if (!sim) return false;
  if (!position || !quaternion) {
    sim.rootValid = false;
    return false;
  }
  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z) ||
    !Number.isFinite(quaternion.w)
  ) {
    sim.rootValid = false;
    return false;
  }
  sim.rootPos[0] = position.x;
  sim.rootPos[1] = position.y;
  sim.rootPos[2] = position.z;
  sim.rootQuat[0] = quaternion.x;
  sim.rootQuat[1] = quaternion.y;
  sim.rootQuat[2] = quaternion.z;
  sim.rootQuat[3] = quaternion.w;
  sim.rootScale[0] = scale && Number.isFinite(scale.x) && scale.x !== 0 ? scale.x : 1;
  sim.rootScale[1] = scale && Number.isFinite(scale.y) && scale.y !== 0 ? scale.y : 1;
  sim.rootScale[2] = scale && Number.isFinite(scale.z) && scale.z !== 0 ? scale.z : 1;
  sim.rootValid = true;
  return true;
}

/** out = q · v (q = [x,y,z,w]); `conj` rotates by the inverse instead. */
function qrot(q, x, y, z, out, conj) {
  const s = conj ? -1 : 1;
  const qx = q[0] * s;
  const qy = q[1] * s;
  const qz = q[2] * s;
  const qw = q[3];
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  out[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  out[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  out[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
}

/**
 * Per-node ground height (and lateral push-out) from the environment bridge —
 * this is what lets a corpse come to rest on a slope, a stair, or ANOTHER
 * corpse instead of on a flat plane through the entity's own origin.
 *
 * Nodes are lifted into the AC/entitiesGroup frame with the root transform,
 * queried once per step (never per relaxation iteration — floorZAt may be a
 * raycast), and the answers are folded back into model space. The height
 * mapping assumes the root rotation is a yaw about Z — it always is, AC
 * headings are yaw-only, which is the assumption the whole module makes.
 * Any failure at any step falls back to the flat floor, silently.
 */
function updateSupport(sim) {
  const { n, pos, prev, support, env } = sim;
  if (!env || !sim.rootValid) {
    if (sim._flatSupport !== sim.floorZ) {
      support.fill(sim.floorZ);
      sim._flatSupport = sim.floorZ;
    }
    return;
  }
  sim._flatSupport = null;
  const rp = sim.rootPos;
  const rq = sim.rootQuat;
  const rs = sim.rootScale;
  const v = sim._v;
  const ac = sim._ac;
  const scZ = rs[2] || 1;
  const radiusAC = RAGDOLL_NODE_RADIUS * ((Math.abs(rs[0]) + Math.abs(rs[1])) * 0.5 || 1);
  const hasFloor = typeof env.floorZAt === "function";
  const hasWall = typeof env.constrainAC === "function";
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    qrot(rq, pos[i3] * rs[0], pos[i3 + 1] * rs[1], pos[i3 + 2] * rs[2], v, false);
    const ax = rp[0] + v[0];
    const ay = rp[1] + v[1];
    const az = rp[2] + v[2];
    let fz = sim.floorZ;
    if (hasFloor) {
      let z;
      try {
        z = env.floorZAt(ax, ay);
      } catch (_e) {
        z = undefined;
      }
      if (Number.isFinite(z)) {
        const local = (z - rp[2]) / scZ;
        if (Math.abs(local) < 1e4) fz = local;
      }
    }
    support[i] = fz;
    if (!hasWall) continue;
    ac.x = ax;
    ac.y = ay;
    ac.z = az;
    try {
      env.constrainAC(ac, radiusAC);
    } catch (_e) {
      ac.x = ax;
      ac.y = ay;
      ac.z = az;
    }
    const ddx = ac.x - ax;
    const ddy = ac.y - ay;
    const ddz = ac.z - az;
    if (!Number.isFinite(ddx) || !Number.isFinite(ddy) || !Number.isFinite(ddz)) continue;
    if (ddx === 0 && ddy === 0 && ddz === 0) continue;
    qrot(rq, ddx, ddy, ddz, v, true);
    const lx = v[0] / rs[0];
    const ly = v[1] / rs[1];
    const lz = v[2] / rs[2];
    if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) continue;
    // translate pos AND prev together: a push-out must not inject velocity
    pos[i3] += lx;
    pos[i3 + 1] += ly;
    pos[i3 + 2] += lz;
    prev[i3] += lx;
    prev[i3 + 1] += ly;
    prev[i3 + 2] += lz;
  }
}

/** One verlet step; returns the largest node displacement (m). */
export function stepSim(sim, dt) {
  if (!sim || sim.done) return 0;
  if (!(dt > 0)) dt = 1 / 60;
  if (dt > MAX_DT) dt = MAX_DT;
  const { n, pos, prev, constraints, braces, kEff, kBrace, support } = sim;
  sim.t += dt;
  const t = sim.t;
  const g = RAGDOLL_GRAVITY * dt * dt;

  let damp = RAGDOLL_DAMPING;
  if (t > RAGDOLL_CALM_START) {
    const f = Math.min(1, (t - RAGDOLL_CALM_START) / RAGDOLL_CALM_SPAN);
    damp = RAGDOLL_DAMPING + (RAGDOLL_CALM_DAMPING - RAGDOLL_DAMPING) * f;
  }

  /* integrate ----------------------------------------------------------- */
  for (let i = 0; i < n; i++) {
    const ix = i * 3;
    const x = pos[ix];
    const y = pos[ix + 1];
    const z = pos[ix + 2];
    const vx = (x - prev[ix]) * damp;
    const vy = (y - prev[ix + 1]) * damp;
    const vz = (z - prev[ix + 2]) * damp;
    prev[ix] = x;
    prev[ix + 1] = y;
    prev[ix + 2] = z;
    pos[ix] = x + vx;
    pos[ix + 1] = y + vy;
    pos[ix + 2] = z + vz - g;
  }

  /* ground / walls: one environment query per node per step ------------- */
  updateSupport(sim);

  /* stiffness schedule — the "give" -------------------------------------- */
  const rigid = t < sim.braceEndT;
  for (let i = 0; i < constraints.length; i++) {
    const c = constraints[i];
    kEff[i] = c.t1 > 0 ? c.stiff + (RAGDOLL_BEND_RIGID - c.stiff) * giveGain(t, c.t0, c.t1) : c.stiff;
  }
  if (rigid) {
    for (let i = 0; i < braces.length; i++) {
      const b = braces[i];
      kBrace[i] = RAGDOLL_BRACE_STIFF * giveGain(t, b.t0, b.t1);
    }
  }

  /* relax --------------------------------------------------------------- */
  const iters = rigid ? RAGDOLL_ITERATIONS_RIGID : RAGDOLL_ITERATIONS;
  for (let iter = 0; iter < iters; iter++) {
    for (let ci = 0; ci < constraints.length; ci++) {
      const c = constraints[ci];
      const ax = c.a * 3;
      const bx = c.b * 3;
      const dx = pos[ax] - pos[bx];
      const dy = pos[ax + 1] - pos[bx + 1];
      const dz = pos[ax + 2] - pos[bx + 2];
      // sqrt, not Math.hypot: hypot is variadic (slow + allocates) and this is
      // the hottest loop in the module.
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
      const k = ((len - c.rest) / len) * 0.5 * kEff[ci];
      pos[ax] -= dx * k;
      pos[ax + 1] -= dy * k;
      pos[ax + 2] -= dz * k;
      pos[bx] += dx * k;
      pos[bx + 1] += dy * k;
      pos[bx + 2] += dz * k;
    }
    if (rigid) {
      for (let bi = 0; bi < braces.length; bi++) {
        const kb = kBrace[bi];
        if (kb <= 0) continue;
        const b = braces[bi];
        const ax = b.a * 3;
        const bx = b.b * 3;
        const dx = pos[ax] - pos[bx];
        const dy = pos[ax + 1] - pos[bx + 1];
        const dz = pos[ax + 2] - pos[bx + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
        const k = ((len - b.rest) / len) * 0.5 * kb;
        pos[ax] -= dx * k;
        pos[ax + 1] -= dy * k;
        pos[ax + 2] -= dz * k;
        pos[bx] += dx * k;
        pos[bx + 1] += dy * k;
        pos[bx + 2] += dz * k;
      }
    }
    for (let i = 0; i < n; i++) {
      const iz = i * 3 + 2;
      const min = support[i] + RAGDOLL_NODE_RADIUS;
      if (pos[iz] < min) pos[iz] = min;
    }
  }

  /* NaN scrub + settle metric ------------------------------------------- */
  let maxMove = 0;
  for (let i = 0; i < n; i++) {
    const ix = i * 3;
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(pos[ix + k])) pos[ix + k] = Number.isFinite(prev[ix + k]) ? prev[ix + k] : 0;
      if (!Number.isFinite(prev[ix + k])) prev[ix + k] = pos[ix + k];
    }
    const mx = pos[ix] - prev[ix];
    const my = pos[ix + 1] - prev[ix + 1];
    const mz = pos[ix + 2] - prev[ix + 2];
    const m = mx * mx + my * my + mz * mz;
    if (m > maxMove) maxMove = m;
  }
  maxMove = Math.sqrt(maxMove);

  /* contact: ground friction + (randomized) bounce ---------------------- */
  const bounce = sim.bounce;
  for (let i = 0; i < n; i++) {
    const ix = i * 3;
    if (pos[ix + 2] > support[i] + RAGDOLL_NODE_RADIUS + 1e-6) continue;
    prev[ix] = pos[ix] - (pos[ix] - prev[ix]) * RAGDOLL_FLOOR_FRICTION;
    prev[ix + 1] = pos[ix + 1] - (pos[ix + 1] - prev[ix + 1]) * RAGDOLL_FLOOR_FRICTION;
    const vz = pos[ix + 2] - prev[ix + 2];
    if (vz < 0) prev[ix + 2] = pos[ix + 2] + vz * bounce; // reflect, scaled
  }

  /* freeze — never mid-topple: the braces must have finished giving ----- */
  if (maxMove < RAGDOLL_SETTLE_EPS && t > sim.braceEndT) {
    if (++sim.settled >= RAGDOLL_SETTLE_FRAMES) sim.done = true;
  } else {
    sim.settled = 0;
  }
  if (t >= RAGDOLL_MAX_TIME) sim.done = true;
  return maxMove;
}

/** q = shortest arc rotating unit vector a onto unit vector b; [x,y,z,w]. */
export function quatFromUnitVectors(ax, ay, az, bx, by, bz) {
  const dot = ax * bx + ay * by + az * bz;
  if (dot < -0.999999) {
    // opposite: 180° about any axis orthogonal to a
    let ox = -ay;
    let oy = ax;
    let oz = 0;
    if (Math.hypot(ox, oy, oz) < 1e-6) {
      ox = 0;
      oy = -az;
      oz = ay;
    }
    const l = Math.hypot(ox, oy, oz) || 1;
    return [ox / l, oy / l, oz / l, 0];
  }
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const w = 1 + dot;
  const l = Math.hypot(cx, cy, cz, w) || 1;
  return [cx / l, cy / l, cz / l, w / l];
}

/** Hamilton product q1*q2, both [x,y,z,w]. */
export function quatMul(q1, q2) {
  const [x1, y1, z1, w1] = q1;
  const [x2, y2, z2, w2] = q2;
  return [
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
  ];
}

/* ── environment bridge ──────────────────────────────────────────────────
 * ./ragdoll_env.js is an OPTIONAL sibling that exports
 *   envForRagdoll(inst) -> { floorZAt(acX, acY) -> acZ,
 *                            constrainAC(pos {x,y,z}, radius) -> void } | null
 * in the AC/entitiesGroup frame. It is resolved through a GUARDED DYNAMIC
 * import rather than a static one on purpose: scene3d modules are served raw
 * (no bundler), so a missing or throwing ragdoll_env.js behind a static import
 * would take the whole entities.js → scene3d import graph down with it. With
 * the module absent the ragdoll behaves exactly as it did on the flat floor.
 */
let _envMod; // undefined = untried, null = unavailable
let _envPromise = null;
function loadEnvModule() {
  if (_envMod !== undefined) return Promise.resolve(_envMod);
  if (!_envPromise) {
    _envPromise = import("./ragdoll_env.js")
      .then((m) => {
        _envMod = m && typeof m.envForRagdoll === "function" ? m : null;
        return _envMod;
      })
      .catch(() => {
        _envMod = null;
        return null;
      });
  }
  return _envPromise;
}

/* ── runtime (browser only from here down) ───────────────────────────── */

function readRoot(sim, root) {
  if (!root) {
    sim.rootValid = false;
    return;
  }
  setSimRoot(sim, root.position, root.quaternion, root.scale);
}

/**
 * Tell the environment module where this body came to rest, so the NEXT
 * ragdoll can drape over it (ragdoll_env.js:registerSettledBody — the corpse-
 * stacks-on-corpse feedback loop). Once per sim, at the freeze transition;
 * optional in every direction (no module / no method / no root ⇒ skipped).
 */
function reportSettled(sim) {
  const mod = _envMod;
  if (!mod || typeof mod.registerSettledBody !== "function" || !sim.rootValid || !sim.n) return;
  const rp = sim.rootPos;
  const rq = sim.rootQuat;
  const rs = sim.rootScale;
  const v = sim._v;
  let sx = 0;
  let sy = 0;
  let topZ = -Infinity;
  for (let i = 0; i < sim.n; i++) {
    const i3 = i * 3;
    qrot(rq, sim.pos[i3] * rs[0], sim.pos[i3 + 1] * rs[1], sim.pos[i3 + 2] * rs[2], v, false);
    sx += rp[0] + v[0];
    sy += rp[1] + v[1];
    const z = rp[2] + v[2];
    if (z > topZ) topZ = z;
  }
  const cx = sx / sim.n;
  const cy = sy / sim.n;
  let r2 = 0;
  for (let i = 0; i < sim.n; i++) {
    const i3 = i * 3;
    qrot(rq, sim.pos[i3] * rs[0], sim.pos[i3 + 1] * rs[1], sim.pos[i3 + 2] * rs[2], v, false);
    const dx = rp[0] + v[0] - cx;
    const dy = rp[1] + v[1] - cy;
    const d = dx * dx + dy * dy;
    if (d > r2) r2 = d;
  }
  const scXY = (Math.abs(rs[0]) + Math.abs(rs[1])) * 0.5 || 1;
  try {
    mod.registerSettledBody(cx, cy, topZ + RAGDOLL_NODE_RADIUS * Math.abs(rs[2] || 1), Math.sqrt(r2) + RAGDOLL_NODE_RADIUS * scXY);
  } catch (_e) {
    /* enrichment only — a throwing registry must never break the death */
  }
}

/**
 * Arm a ragdoll on a freshly-dead entity. Fire-and-forget async: resolves the
 * limb registry (cached per setupId; one wasm round-trip cold), the optional
 * environment bridge, and captures the death-moment pose. No-ops (returns
 * null) when the flag is off, the entity has no parts/hierarchy, or a ragdoll
 * is already armed.
 *
 * opts: { dir: [dx, dy], critical: bool, seed: uint32 }
 */
export async function startRagdoll(inst, opts = {}) {
  if (!ragdollEnabled() || !inst?.parts?.length || inst._ragdoll) return null;
  const setupId = inst._setupId ?? inst.setupId;
  if (!setupId) return null;
  let reg = getLimbRegistry(setupId);
  if (!reg) {
    try {
      reg = await ensureLimbRegistry(setupId, inst);
    } catch (_e) {
      reg = null;
    }
  }
  const parentIndex = reg?.parentIndex;
  if (!parentIndex || parentIndex.length !== inst.parts.length) {
    // eslint-disable-next-line no-console
    console.info(`[ragdoll] not armed for 0x${(Number(inst.guid) >>> 0).toString(16)}: ${!parentIndex ? "no limb registry (wasm export missing / LOD 0x01 setup?)" : `parentIndex ${parentIndex.length} vs parts ${inst.parts.length}`}`);
    return null;
  }
  if (inst._ragdoll || !inst.root?.parent) return null; // died/removed during await

  let env = null;
  try {
    const mod = await loadEnvModule();
    if (mod) env = mod.envForRagdoll(inst) || null;
  } catch (_e) {
    env = null;
  }
  if (inst._ragdoll || !inst.root?.parent) return null; // died/removed during await

  const n = inst.parts.length;
  const positions = new Float64Array(n * 3);
  const q0 = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = inst.parts[i];
    positions[i * 3] = p.position.x;
    positions[i * 3 + 1] = p.position.y;
    positions[i * 3 + 2] = p.position.z;
    q0[i] = [p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w];
  }
  // Topple direction: caller-provided (e.g. away from the killing blow) or a
  // random yaw. Magnitude jumps for crit deaths; initSim jitters both, and the
  // per-death seed decides twist, joint-give order, jitter and bounce.
  const mag = opts.critical ? RAGDOLL_IMPULSE_CRIT : RAGDOLL_IMPULSE;
  const given = opts.dir && Number.isFinite(opts.dir[0]) && Number.isFinite(opts.dir[1]) ? opts.dir : null;
  const dl = given ? Math.hypot(given[0], given[1]) || 1 : 1;
  const dx = given ? given[0] / dl : 1;
  const dy = given ? given[1] / dl : 0;
  const seed =
    opts.seed === undefined || opts.seed === null ? (Math.random() * 4294967296) >>> 0 : opts.seed >>> 0;
  const sim = initSim(parentIndex, positions, {
    floorZ: 0,
    impulse: [dx * mag, dy * mag, 0.35 * mag],
    dir: given ? [dx, dy] : null,
    seed,
    env,
  });
  readRoot(sim, inst.root);
  const boneChild = buildBoneChildren(parentIndex, positions);
  const restDir = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const c = boneChild[i];
    if (c < 0) continue;
    const bx = positions[c * 3] - positions[i * 3];
    const by = positions[c * 3 + 1] - positions[i * 3 + 1];
    const bz = positions[c * 3 + 2] - positions[i * 3 + 2];
    const l = Math.hypot(bx, by, bz);
    if (l > 1e-4) restDir[i] = [bx / l, by / l, bz / l];
  }
  inst._ragdoll = { sim, parentIndex, boneChild, restDir, q0, swing: new Array(n).fill(null), seed, reported: false };
  return inst._ragdoll;
}

/**
 * Per-frame pose overwrite; call AFTER every other rig writer (mixer, unified
 * poseRigAt, jump tween, limp). Cheap early-out when no ragdoll is armed.
 */
export function applyRagdoll(inst, dt) {
  const rd = inst?._ragdoll;
  if (!rd) return;
  const { sim, parentIndex, boneChild, restDir, q0, swing } = rd;
  if (!sim.done) {
    // refresh the AC transform every frame: the root can still be moving while
    // the body settles, and the environment queries are in the AC frame.
    readRoot(sim, inst.root);
    stepSim(sim, Math.min(MAX_DT, dt || 1 / 60));
    if (sim.done && !rd.reported) {
      rd.reported = true;
      reportSettled(sim);
    }
  }
  const n = sim.n;
  for (let i = 0; i < n; i++) {
    swing[i] = null;
    const d0 = restDir[i];
    const c = boneChild[i];
    if (d0 && c >= 0) {
      const bx = sim.pos[c * 3] - sim.pos[i * 3];
      const by = sim.pos[c * 3 + 1] - sim.pos[i * 3 + 1];
      const bz = sim.pos[c * 3 + 2] - sim.pos[i * 3 + 2];
      const l = Math.hypot(bx, by, bz);
      if (l > 1e-4) swing[i] = quatFromUnitVectors(d0[0], d0[1], d0[2], bx / l, by / l, bz / l);
    }
  }
  for (let i = 0; i < n; i++) {
    const part = inst.parts[i];
    if (!part) continue;
    part.position.set(sim.pos[i * 3], sim.pos[i * 3 + 1], sim.pos[i * 3 + 2]);
    // leaves ride their parent's swing so hands/feet follow the limb
    const s = swing[i] || (parentIndex[i] !== ROOT ? swing[parentIndex[i]] : null);
    if (s) {
      const q = quatMul(s, q0[i]);
      part.quaternion.set(q[0], q[1], q[2], q[3]);
    }
  }
}

/** Disarm and leave the rig wherever the sim put it (corpse takes over). */
export function stopRagdoll(inst) {
  if (inst) inst._ragdoll = null;
}

/* ── corpse pose persistence ─────────────────────────────────────────────
 * The lootable corpse is a SEPARATE server object that spawns holding the
 * authored prone pose. To keep the ragdoll's sprawl without breaking loot,
 * the death handoff copies the dying creature's final part transforms onto
 * the corpse rig as a FROZEN post-mixer overwrite: the corpse object (and so
 * its picking meshes, selection, nameplate, server position) is completely
 * untouched — only its part Groups are re-posed every frame, exactly the way
 * applyRagdoll re-poses the dying creature. Clickability is unaffected
 * because the same meshes render in the new pose.
 */

/** Snapshot an entity's current part transforms as a flat frozen pose. */
export function captureRagdollPose(inst) {
  const n = inst?.parts?.length || 0;
  if (!n) return null;
  const pos = new Float32Array(n * 3);
  const quat = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = inst.parts[i];
    pos[i * 3] = p.position.x;
    pos[i * 3 + 1] = p.position.y;
    pos[i * 3 + 2] = p.position.z;
    quat[i * 4] = p.quaternion.x;
    quat[i * 4 + 1] = p.quaternion.y;
    quat[i * 4 + 2] = p.quaternion.z;
    quat[i * 4 + 3] = p.quaternion.w;
  }
  return { n, pos, quat };
}

/**
 * Copy the dying creature's settled ragdoll pose onto the corpse rig.
 * Part-count guard: corpse setups occasionally differ from the creature's
 * (ObjDesc variants) — on mismatch we do nothing and the corpse shows the
 * authored prone pose, which is the safe pre-ragdoll behaviour.
 */
export function transferRagdollPose(fromInst, toInst) {
  if (!fromInst?._ragdoll || !toInst?.parts) return false;
  const pose = captureRagdollPose(fromInst);
  if (!pose) return false;
  _archiveCorpsePose(toInst.guid, pose);
  if (toInst.parts.length === 0) {
    // Corpse rig not built yet — stash and let the tick promote it once the
    // part Groups exist (promotePendingPose).
    toInst._ragdollPendingPose = pose;
    // eslint-disable-next-line no-console
    console.info("[ragdoll] corpse pose transfer: pending (corpse rig not built yet)");
    return true;
  }
  if (pose.n !== toInst.parts.length) {
    // eslint-disable-next-line no-console
    console.info(`[ragdoll] corpse pose transfer: part-count mismatch (${pose.n} vs ${toInst.parts.length}) — authored prone pose kept`);
    return false;
  }
  toInst._ragdollFrozenPose = pose;
  // eslint-disable-next-line no-console
  console.info("[ragdoll] corpse pose transfer: ok,", pose.n, "parts");
  return true;
}

/* ── corpse pose archive ────────────────────────────────────────────────
 * The sprawl lives on the client INSTANCE, but corpses are constantly
 * removed and re-materialized (walk away/back, dungeon cell transitions,
 * PVS churn) — every re-spawn was a fresh rig in the authored prone pose
 * ("the old corpses come back", 2026-08-02 field report). Poses are
 * archived per corpse GUID at transfer time and re-applied when a corpse
 * spawn with a known guid commits (entities.js → window.__ragdollCorpseRestore).
 * Bounded + TTL'd; server guid reuse is defused by the TTL.
 */
const CORPSE_POSE_MAX = 48;
const CORPSE_POSE_TTL_MS = 10 * 60 * 1000;
const _corpsePoses = new Map(); // guid -> { pose, expiresAt }

function _archiveCorpsePose(guid, pose) {
  const g = Number(guid) >>> 0;
  if (!g || !pose) return;
  const now = performance.now();
  for (const [k, v] of _corpsePoses) {
    if (v.expiresAt < now) _corpsePoses.delete(k);
  }
  while (_corpsePoses.size >= CORPSE_POSE_MAX) {
    _corpsePoses.delete(_corpsePoses.keys().next().value);
  }
  _corpsePoses.set(g, { pose, expiresAt: now + CORPSE_POSE_TTL_MS });
}

/**
 * Re-apply an archived sprawl to a freshly (re-)spawned corpse instance.
 * Returns true when a pose was restored (caller skips the death handoff —
 * the dying creature is long gone on a re-materialization).
 */
export function restoreCorpsePose(inst) {
  const g = Number(inst?.guid) >>> 0;
  const entry = g ? _corpsePoses.get(g) : null;
  if (!entry) return false;
  if (entry.expiresAt < performance.now()) {
    _corpsePoses.delete(g);
    return false;
  }
  entry.expiresAt = performance.now() + CORPSE_POSE_TTL_MS; // refresh
  if (inst.parts?.length === entry.pose.n) {
    inst._ragdollFrozenPose = entry.pose;
  } else {
    inst._ragdollPendingPose = entry.pose; // rig still building → promote later
  }
  // eslint-disable-next-line no-console
  console.info(`[ragdoll] corpse 0x${g.toString(16)}: archived sprawl restored on re-spawn`);
  return true;
}

/** Promote a stashed pose once the corpse rig finishes building. */
export function promotePendingPose(inst) {
  const p = inst?._ragdollPendingPose;
  if (!p || !inst.parts?.length) return;
  if (inst.parts.length === p.n) {
    inst._ragdollFrozenPose = p;
    inst._ragdollPendingPose = null;
  } else if (inst.parts.length > 0) {
    inst._ragdollPendingPose = null; // real mismatch — give up quietly
  }
}

/** Re-assert a frozen pose after the corpse's own rig writers ran. */
export function applyFrozenPose(inst) {
  const fp = inst?._ragdollFrozenPose;
  if (!fp) return;
  for (let i = 0; i < fp.n; i++) {
    const part = inst.parts[i];
    if (!part) continue;
    part.position.set(fp.pos[i * 3], fp.pos[i * 3 + 1], fp.pos[i * 3 + 2]);
    part.quaternion.set(fp.quat[i * 4], fp.quat[i * 4 + 1], fp.quat[i * 4 + 2], fp.quat[i * 4 + 3]);
  }
}

/* ── diag surface (registered from diag.js attach list) ──────────────── */
export function attachRagdoll(diag) {
  // entities.js re-applies archived corpse sprawls through this hook on
  // corpse re-spawn (no import — window-hook pattern, gated RAGDOLL_ON at
  // the call site).
  window.__ragdollCorpseRestore = restoreCorpsePose;
  const findInst = (guid) => {
    const em = window.liveScene3d?.entityManager;
    if (!em?.entityMap) return null;
    // Accept an EntityInstance directly, any numeric form (signed/unsigned),
    // or a string; last resort scans values (diag-only, O(n) is fine).
    if (guid && typeof guid === "object" && guid.parts) return guid;
    const k = Number(guid) >>> 0;
    const hit = em.entityMap.get(guid) || em.entityMap.get(k);
    if (hit) return hit;
    for (const i of em.entityMap.values()) {
      if ((Number(i.guid) >>> 0) === k) return i;
    }
    return null;
  };
  diag.ragdoll = {
    enabled: ragdollEnabled,
    /** Arm a ragdoll on a LIVING entity for testing: __diag.ragdoll.kill(guid, {critical:true}) */
    async kill(guid, opts = {}) {
      const inst = findInst(guid);
      if (!inst) return { error: "no such entity" };
      const rd = await startRagdoll(inst, opts);
      return rd
        ? { ok: true, nodes: rd.sim.n, seed: rd.seed, braces: rd.sim.braces.length, env: !!rd.sim.env }
        : { error: "not armed (flag off / no hierarchy?)" };
    },
    stop(guid) {
      const inst = findInst(guid);
      if (!inst) return { error: "no such entity" };
      stopRagdoll(inst);
      return { ok: true };
    },
    state(guid) {
      const rd = findInst(guid)?._ragdoll;
      if (!rd) return null;
      const s = rd.sim;
      return {
        nodes: s.n,
        t: +s.t.toFixed(3),
        rigid: s.t < s.braceEndT,
        braceEndT: +s.braceEndT.toFixed(3),
        braces: s.braces.length,
        twist: +s.twist.toFixed(2),
        dir: s.seedDir,
        bounce: +s.bounce.toFixed(3),
        env: !!s.env,
        seed: rd.seed,
        settled: s.settled,
        done: s.done,
      };
    },
  };
}
