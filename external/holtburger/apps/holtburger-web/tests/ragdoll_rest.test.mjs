// ragdoll_rest.test.mjs — a death ragdoll ends when it stops doing VISIBLE work.
//
// 2026-10-11 owner report: "when a creature is killed sometimes the ragdoll
// takes too long to complete its animation as the user is waiting to loot the
// corpse but its not actually doing much useful animation wise, shreths for
// example." The corpse stays hidden until the sim rests (entities.js
// `finishReveal`), so the long tail was dead time on screen.
//
// Why shreths: Setup 0x020005A7 (Blood/Hunter/Vorous/Malus/Gauloth/Fire/
// Rendeath Shreth; 0x020005C4 Gnawer/Carrion is the same part graph) has 25
// parts, three roots (torso 0, hind legs 8 and 11) and chains up to five links
// deep — and TEN of the parts (15-24) are GfxObj 0x010001EC, a 3-vertex
// locator whose only surface 0x08000015 has translucency 1: built hidden by
// setup_rig.js `materialRendersNothing`, but still verlet nodes. The legacy
// freeze ("every node < 1.2 mm/step for 24 steps") failed on them, on a floor
// creep of the flat body (frustrated bend links sliding it ~1 mm/step), and
// on bounded jitter. `?ragdollRest` (scene3d/ragdoll.js RAGDOLL_REST_* block):
// drawn-node mask, a rest-box window, a speed-for-time step test, calm-phase
// stiction, per-time calm damping, 6 s hard stop.
//
// Run: node tests/ragdoll_rest.test.mjs   (from apps/holtburger-web/)

import {
  initSim,
  stepSim,
  drawnPartMask,
  ragdollRestEnabled,
  RAGDOLL_MAX_TIME,
  RAGDOLL_MAX_TIME_LEGACY,
  RAGDOLL_CALM_START,
  RAGDOLL_REST_EPS_MIN,
  RAGDOLL_REST_EPS_MAX,
} from "../scene3d/ragdoll.js";

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

/* ── rigs ──────────────────────────────────────────────────────────────
 * Shreth Setup 0x020005A7, client_portal.dat (flags 0x5 = HasParent |
 * AllowFreeHeading): parent_index and the Default (key 0) placement frame
 * origins, read with ACE.DatLoader's SetupModel layout. Model space, +Z up. */
const ROOT = 0xffffffff;
const R = (a) => a.map((p) => (p < 0 ? ROOT : p));
const SHRETH = {
  parent: R([-1, 0, 1, 2, 3, 1, 5, 6, -1, 8, 9, -1, 11, 12, 1, 14, 14, 7, 4, 3, 6, 9, 12, 1, 1]),
  pos: [
    [0.0, 0.0, 1.2375], [0.0, 0.233, 1.4641], [-0.415, 0.683, 1.7124], [-0.57, 1.0549, 0.7003],
    [-0.57, 1.2634, 0.3238], [0.4325, 0.6839, 1.7135], [0.5875, 1.056, 0.6984], [0.5875, 1.2671, 0.3234],
    [-0.11, -0.055, 1.1925], [-0.2652, 0.2663, 0.7433], [-0.2182, 0.079, 0.18], [0.135, -0.055, 1.1925],
    [0.2875, 0.2619, 0.7459], [0.2145, 0.0749, 0.1842], [0.0, 0.7702, 1.8614], [-0.1, 1.0607, 1.836],
    [0.1, 1.0607, 1.836], [0.4125, 1.3862, 0.2871], [-0.395, 1.3824, 0.2873], [-0.57, 0.7807, 1.0526],
    [0.5875, 0.7817, 1.0498], [-0.2725, 0.4199, 0.7281], [0.2921, 0.427, 0.7377], [0.23, 0.7676, 1.8219],
    [-0.2325, 0.7676, 1.8219],
  ].flat(),
  // parts 15-24: GfxObj 0x010001EC (never drawn)
  drawn: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};
/** Banderling Setup 0x02000E08 (17 parts, all drawn) — the "normal" control. */
const BANDERLING = {
  parent: R([-1, 0, 1, 2, 3, 1, 5, 6, -1, 8, 9, -1, 11, 12, 1, 10, 13]),
  pos: [
    0, 0, 0.8725, 0.0, 0.0265, 0.9979, -0.2087, 0.2339, 1.1994, -0.2451, 0.2639, 0.7118, -0.2113, 0.3161, 0.5429,
    0.2097, 0.2244, 1.2063, 0.2632, 0.2633, 0.7164, 0.2448, 0.3125, 0.5442, -0.115, 0.0, 0.7975, -0.1694, 0.1717,
    0.4962, -0.1665, -0.0074, 0.0615, 0.115, -0.0, 0.8025, 0.1812, 0.1683, 0.5038, 0.1603, -0.0087, 0.0634, 0.0,
    0.2842, 1.2494, -0.1778, 0.0426, 0.0231, 0.1738, 0.0389, 0.0228,
  ],
  drawn: null,
};
// kill_impulse.js FALL_STYLES knobs
const STYLES = [
  { topple: 1.0, twist: 1.0, spread: 0.55 },
  { topple: 0.9, twist: 2.1, spread: 0.8 },
  { topple: 0.32, twist: 0.7, spread: 1.5 },
  { topple: 1.15, twist: 0.8, spread: 0.5 },
  { topple: 1.1, twist: 0.9, spread: 0.7 },
];

function death(rig, s, extra = {}) {
  const style = STYLES[s % 5];
  const mag = s % 7 === 0 ? 4.2 : 2.2; // every 7th a crit
  const ang = (s * 2.399) % (Math.PI * 2);
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  return initSim(rig.parent, Float64Array.from(rig.pos), {
    floorZ: 0,
    impulse: [dx * mag, dy * mag, 0.35 * mag],
    dir: [dx, dy],
    seed: 0x500 + s,
    toppleScale: style.topple,
    twistScale: style.twist,
    dirJitter: style.spread,
    drawn: rig.drawn,
    ...extra,
  });
}

/**
 * Run to the freeze. Returns the freeze time, what froze it, the last time a
 * DRAWN node moved faster than 0.3 m/s (clearly visible motion), and the pose
 * at the last step with t ≤ 2.4 s.
 */
function run(sim, dt, drawn) {
  const prev = Float64Array.from(sim.pos);
  let lastFast = 0;
  let pose24 = null;
  while (!sim.done) {
    stepSim(sim, dt);
    let v = 0;
    for (let i = 0; i < sim.n; i++) {
      if (drawn && !drawn[i]) continue;
      const m = Math.hypot(sim.pos[i * 3] - prev[i * 3], sim.pos[i * 3 + 1] - prev[i * 3 + 1], sim.pos[i * 3 + 2] - prev[i * 3 + 2]);
      if (m > v) v = m;
    }
    prev.set(sim.pos);
    if (v / dt > 0.3) lastFast = sim.t;
    if (sim.t <= 2.4 + 1e-9) pose24 = Float64Array.from(sim.pos);
  }
  return { t: sim.t, by: sim.restedBy, lastFast, pose24 };
}

const q = (a, p) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(p * b.length))];
};

/* ── 1. the drawn-part mask ────────────────────────────────────────────── */
section("drawnPartMask — which parts can put a pixel on screen");
{
  const mesh = (visible = true) => ({ isMesh: true, visible, children: [] });
  const parts = [
    { children: [mesh()] }, // ordinary part
    { children: [mesh(false)] }, // materialRendersNothing (0x08000015) locator
    { children: [] }, // empty part group
    { children: [{ isMesh: false, visible: true, children: [mesh()] }] }, // held item under the hand
    { children: [{ isMesh: false, visible: false, children: [mesh()] }] }, // …under a hidden group
    { visible: false, children: [mesh()] }, // part hidden for distance — can come back
    {}, // unknown shape
  ];
  const m = drawnPartMask(parts);
  ok(m.length === parts.length, "one entry per part");
  ok(m[0] === 1, "a part with a visible mesh is drawn");
  ok(m[1] === 0, "a part whose only mesh renders nothing is not");
  ok(m[2] === 0, "an empty part group is not");
  ok(m[3] === 1, "a visible mesh under a visible child group (held item) counts");
  ok(m[4] === 0, "…under a hidden child group it does not");
  ok(m[5] === 1, "the part Group's own visibility (degrade) is not consulted");
  ok(m[6] === 1, "an unknown part shape counts (pre-mask behaviour)");
  ok(drawnPartMask(null).length === 0 && drawnPartMask([]).length === 0, "no parts → empty mask");
}

/* ── 2. the shreth: rests soon after it stops moving ───────────────────── */
section("shreth 0x020005A7 (25 parts, 10 locators): settle time, rest model vs legacy (60 Hz, 150 deaths)");
{
  const dt = 1 / 60;
  const N = 150;
  const nw = [];
  const old = [];
  const tailNew = [];
  const tailOld = [];
  let caps = 0;
  let windowRests = 0;
  let toppleDiffers = 0;
  let toppleCompared = 0;
  for (let s = 0; s < N; s++) {
    const a = run(death(SHRETH, s), dt, SHRETH.drawn);
    const b = run(death(SHRETH, s, { rest: false }), dt, SHRETH.drawn);
    nw.push(a.t);
    old.push(b.t);
    tailNew.push(a.t - a.lastFast);
    tailOld.push(b.t - b.lastFast);
    if (a.by === "cap") caps++;
    if (a.by === "window") windowRests++;
    // the liked topple/crumple: identical while the new sim is still live
    if (a.t > 2.4 && a.pose24 && b.pose24) {
      toppleCompared++;
      for (let i = 0; i < a.pose24.length; i++) {
        if (a.pose24[i] !== b.pose24[i]) {
          toppleDiffers++;
          break;
        }
      }
    }
  }
  console.log(
    `    legacy: p50 ${q(old, 0.5).toFixed(2)} s, p90 ${q(old, 0.9).toFixed(2)} s, max ${q(old, 1).toFixed(2)} s; ` +
      `still → frozen p90 ${q(tailOld, 0.9).toFixed(2)} s`,
  );
  console.log(
    `    rest:   p50 ${q(nw, 0.5).toFixed(2)} s, p90 ${q(nw, 0.9).toFixed(2)} s, max ${q(nw, 1).toFixed(2)} s; ` +
      `still → frozen p90 ${q(tailNew, 0.9).toFixed(2)} s; ${windowRests} by the rest box, ${caps} hard stops`,
  );
  ok(caps === 0, `no shreth death reaches the ${RAGDOLL_MAX_TIME} s hard stop (${caps})`);
  ok(q(nw, 0.9) <= 4.0, `p90 settle ≤ 4.0 s (legacy ${q(old, 0.9).toFixed(2)} s, got ${q(nw, 0.9).toFixed(2)} s)`);
  ok(q(nw, 1) < 5.5, `worst settle < 5.5 s (legacy ${q(old, 1).toFixed(2)} s, got ${q(nw, 1).toFixed(2)} s)`);
  ok(
    q(old, 0.9) - q(nw, 0.9) >= 1.0,
    `the long tail is cut: p90 at least 1 s sooner than legacy (${q(old, 0.9).toFixed(2)} → ${q(nw, 0.9).toFixed(2)} s)`,
  );
  ok(
    q(tailNew, 0.9) <= 1.0,
    `frozen within 1 s of the last visible (> 0.3 m/s) motion, p90 (legacy ${q(tailOld, 0.9).toFixed(2)} s, got ${q(tailNew, 0.9).toFixed(2)} s)`,
  );
  ok(windowRests > 0, "the rest box freezes some deaths the per-step test would not");
  ok(toppleCompared > 100, `most deaths are still live at 2.4 s (${toppleCompared}/${N})`);
  ok(toppleDiffers === 0, `the topple/crumple before ${RAGDOLL_CALM_START} s is bit-identical to legacy (${toppleDiffers} differ)`);
}

/* ── 3. a normal rig is not slowed down ───────────────────────────────── */
section("banderling 0x02000E08 (17 drawn parts): no regression");
{
  const dt = 1 / 60;
  const nw = [];
  const old = [];
  for (let s = 0; s < 80; s++) {
    nw.push(run(death(BANDERLING, s), dt, null).t);
    old.push(run(death(BANDERLING, s, { rest: false }), dt, null).t);
  }
  console.log(`    legacy p90 ${q(old, 0.9).toFixed(2)} s → rest p90 ${q(nw, 0.9).toFixed(2)} s`);
  ok(q(nw, 0.9) <= q(old, 0.9) + 1e-9, "p90 is no later than legacy");
  ok(q(nw, 1) <= q(old, 1) + 0.05, "worst is no later than legacy");
}

/* ── 4. frame-rate independence ───────────────────────────────────────── */
section("shreth at 30 Hz and 144 Hz");
{
  for (const hz of [30, 144]) {
    const dt = 1 / hz;
    const nw = [];
    const old = [];
    let caps = 0;
    for (let s = 0; s < 60; s++) {
      const a = run(death(SHRETH, s), dt, SHRETH.drawn);
      nw.push(a.t);
      if (a.by === "cap") caps++;
      old.push(run(death(SHRETH, s, { rest: false }), dt, SHRETH.drawn).t);
    }
    console.log(`    ${hz} Hz: legacy p90 ${q(old, 0.9).toFixed(2)} s → rest p90 ${q(nw, 0.9).toFixed(2)} s, ${caps} hard stops`);
    ok(caps === 0, `${hz} Hz: no hard stops (${caps})`);
    ok(q(nw, 0.9) <= 4.5, `${hz} Hz: p90 settle ≤ 4.5 s (got ${q(nw, 0.9).toFixed(2)} s)`);
  }
}

/* ── 5. the rest box: bounded jitter is rest, invisible nodes never count ── */
section("bounded in-place jitter rests; an undrawn node's motion is ignored");
{
  const dt = 1 / 60;
  // A floor that vibrates ±2 mm at 15 Hz under a flat 4-node rig: every step
  // moves the resting nodes up to ~3 mm (the per-step test never passes), but
  // they never leave the 6 mm rest box (RAGDOLL_REST_EPS_MIN — a rig this low
  // gets the minimum).
  const parent = [ROOT, 0, 1, 2];
  const pos = Float64Array.from([0, 0, 0.06, 0.3, 0, 0.06, 0.6, 0, 0.06, 0.6, 0.3, 0.06]);
  const mk = (rest, amp = 0.002) => {
    let t = 0;
    const env = {
      floorZAt() {
        return amp * Math.sin(t * 2 * Math.PI * 15);
      },
    };
    const sim = initSim(parent, pos, { floorZ: 0, impulse: [0, 0, 0], seed: 3, env, rest });
    sim.rootValid = true; // identity AC transform
    sim.rootQuat[3] = 1;
    return {
      sim,
      step() {
        t += dt;
        stepSim(sim, dt);
      },
    };
  };
  const a = mk(true);
  while (!a.sim.done) a.step();
  ok(a.sim.restedBy === "window" && a.sim.t < 3, `rest model: the rest box freezes it (${a.sim.restedBy} at ${a.sim.t.toFixed(2)} s)`);
  const b = mk(false);
  while (!b.sim.done) b.step();
  ok(b.sim.t >= RAGDOLL_MAX_TIME_LEGACY - 1e-9, `legacy: the same body runs to the ${RAGDOLL_MAX_TIME_LEGACY} s hard stop (${b.sim.t.toFixed(2)} s)`);
  const c = mk(true, 0.05); // ±5 cm: real motion, never "rest"
  while (!c.sim.done) c.step();
  ok(c.sim.restedBy === "cap" && Math.abs(c.sim.t - RAGDOLL_MAX_TIME) < 0.02, `a body that keeps visibly moving stops at the ${RAGDOLL_MAX_TIME} s hard stop (${c.sim.restedBy} at ${c.sim.t.toFixed(2)} s)`);

  // Same vibrating floor under ONE leaf only, drawn vs undrawn: only the
  // undrawn version is allowed to rest while that leaf keeps moving.
  const leafEnv = (amp) => {
    let t = 0;
    return {
      env: { floorZAt: (x) => (x > 0.5 ? amp * Math.sin(t * 2 * Math.PI * 15) : 0) },
      tick() {
        t += dt;
      },
    };
  };
  const leaf = (drawn) => {
    const e = leafEnv(0.05);
    const sim = initSim([ROOT, 0, 1], Float64Array.from([0, 0, 0.06, 0.3, 0, 0.06, 0.62, 0, 0.06]), {
      floorZ: 0,
      impulse: [0, 0, 0],
      seed: 4,
      env: e.env,
      drawn,
    });
    sim.rootValid = true;
    sim.rootQuat[3] = 1;
    while (!sim.done) {
      e.tick();
      stepSim(sim, dt);
    }
    return sim;
  };
  const shown = leaf([1, 1, 1]);
  const hidden = leaf([1, 1, 0]);
  ok(shown.restedBy === "cap", `a DRAWN leaf bouncing 5 cm keeps the sim live to the hard stop (${shown.restedBy})`);
  ok(hidden.restedBy !== "cap" && hidden.t < 3, `the same leaf UNDRAWN does not hold the freeze (${hidden.restedBy} at ${hidden.t.toFixed(2)} s)`);
}

/* ── 6. schedule + flag ────────────────────────────────────────────────── */
section("schedule and ?ragdollRest");
{
  const a = death(SHRETH, 1);
  const b = death(SHRETH, 1, { rest: false });
  ok(a.restModel && a.maxTime === RAGDOLL_MAX_TIME && RAGDOLL_MAX_TIME === 6, "rest model: 6 s hard stop");
  ok(!b.restModel && b.maxTime === RAGDOLL_MAX_TIME_LEGACY && b.calmStart === 5, "legacy: 14 s hard stop, calm from 5 s");
  ok(a.calmStart >= RAGDOLL_CALM_START && a.calmStart >= a.braceEndT, "the calm never starts before the joints have given");
  ok(a.dampStart > a.calmStart, "stiction first, the extra damping after it");
  ok(a.visCount === 15 && b.visCount === 25, "shreth: 15 drawn nodes (legacy counts all 25)");
  ok(a.restEps >= RAGDOLL_REST_EPS_MIN && a.restEps <= RAGDOLL_REST_EPS_MAX && Math.abs(a.restEps - 0.006 * (1.8614 - 0.18)) < 1e-9, `rest box scales with body height (${(a.restEps * 1000).toFixed(1)} mm)`);
  const none = initSim([ROOT, 0], Float64Array.from([0, 0, 1, 0, 0, 1.4]), { drawn: [0, 0] });
  ok(none.visCount === 2, "a rig with nothing drawn falls back to every node");

  const prevWindow = globalThis.window;
  try {
    globalThis.window = { location: { search: "" } };
    ok(ragdollRestEnabled() === true, "?ragdollRest absent → on");
    for (const v of ["off", "0", "false", "OFF"]) {
      globalThis.window = { location: { search: `?ragdollRest=${v}` } };
      ok(ragdollRestEnabled() === false, `?ragdollRest=${v} → off`);
    }
    globalThis.window = { location: { search: "?ragdollRest=on" } };
    ok(ragdollRestEnabled() === true, "?ragdollRest=on → on");
    globalThis.window = { location: { search: "?ragdollRest=off" } };
    ok(death(SHRETH, 2).restModel === false, "initSim reads the flag by default");
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
  ok(ragdollRestEnabled() === true, "no window (bare node) → on");
}

console.log(`\nragdoll_rest: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
