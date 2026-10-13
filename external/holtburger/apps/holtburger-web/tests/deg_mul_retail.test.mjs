// tests/deg_mul_retail.test.mjs — render-perf-4 (2026-10-13): retail runs GfxObjDegradeInfo
// at Render::deg_mul 1.0, not 0.
//
// Retail ships `Render::auto_update_deg_mul = true` (acclient.c:45520, the "Automatic degrades"
// preference), so `GfxObjDegradeInfo::get_degrade` (:332383) reads Render::deg_mul, and
// `Render::CalcDegLevel` (:380231) moves it every tick. part_degrade.js used to hold deg_mul at
// 0 and call that "retail's neutral point".
//
//   1. calcDegLevelStep (the CalcDegLevel port, with its 30-entry degmulhist) climbs 0 -> exactly
//      1.0 (float32) in ten steps at 60 and 24 fps and holds there; at 16 fps it stops within one
//      step of 1.0; at 13 fps every step is under 0.01 and the history freezes it; at 5 fps it
//      falls to -1. RETAIL_DEG_MUL is the >= 20 fps fixed point.
//   2. The human body chain (real portal.dat 0x110006C6) hides at 134 m at deg_mul 1 as at 0:
//      its last drawn level is 84 / 84 / 84.
//   3. A chain whose last drawn level is (50, 84, 120) hides at 50 + 120 = 170 m at deg_mul 1
//      (134 m at deg_mul 0).
//   4. selectDegradeLevel and the PartDegrade constructor keep their deg_mul-0 defaults; a
//      PartDegrade given RETAIL_DEG_MUL draws that chain at 150 m.
//   5. The EntityManager construction site passes RETAIL_DEG_MUL under ?partDegrade=on (and
//      builds no PartDegrade without it).
//
// Run from apps/holtburger-web/:  node tests/deg_mul_retail.test.mjs

import {
  calcDegLevelStep,
  selectDegradeLevel,
  parseDegradeInfo,
  PartDegrade,
  RETAIL_DEG_MUL,
  DEG_MUL_HISTORY,
  MIN_FRAMERATE,
  IDEAL_FRAMERATE,
  MAX_FRAMERATE,
} from "../scene3d/part_degrade.js";

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };

/** Run `steps` CalcDegLevel passes at a fixed frame rate from deg_mul `start` (fresh history). */
function run(fps, steps, start = 0) {
  const hist = new Float32Array(DEG_MUL_HISTORY);
  hist.fill(start);
  let d = start;
  const seq = [];
  for (let i = 0; i < steps; i++) { d = calcDegLevelStep(fps, d, hist); seq.push(d); }
  return { d, seq, hist };
}

console.log("1. Render::CalcDegLevel port (acclient.c:380231)");
await check("retail constants: framerates 8 / 10 / 20, 30-entry history, RETAIL_DEG_MUL 1", () => {
  assert(MIN_FRAMERATE === 8 && IDEAL_FRAMERATE === 10 && MAX_FRAMERATE === 20, "framerates");
  assert(DEG_MUL_HISTORY === 30, `history ${DEG_MUL_HISTORY}`);
  assert(RETAIL_DEG_MUL === 1, `RETAIL_DEG_MUL ${RETAIL_DEG_MUL}`);
});
for (const fps of [60, 24]) {
  await check(`${fps} fps: +0.1 per step, exactly 1.0 after ten steps, then holds`, () => {
    const { d, seq, hist } = run(fps, 40);
    assert(Math.abs(seq[0] - 0.1) < 1e-6, `first step ${seq[0]}`);
    assert(seq[8] < 1, `step 9 already 1 (${seq[8]})`);
    assert(seq[9] === 1, `step 10 = ${seq[9]} (float32 must clamp to exactly 1.0, not 0.9999999)`);
    assert(seq.slice(9).every((x) => x === 1), "drifted after reaching 1");
    assert(d === RETAIL_DEG_MUL, `steady state ${d}`);
    assert(hist[DEG_MUL_HISTORY - 1] === 1, "degmulhist[29] records the current deg_mul");
  });
}
await check("20 fps (very-high weight alone) also lands on exactly 1.0", () => {
  const { d } = run(20, 40);
  assert(d === 1, `${d}`);
});
await check("16 fps: smaller steps (>= 0.01); stops within one step of 1.0", () => {
  const { d, seq } = run(16, 200);
  const step = seq[0];
  assert(step >= 0.01 && step < 0.1, `step ${step}`);
  assert(d > 0.98 && d <= 1 && 1 - d < step, `steady state ${d}`);
  // the clamped final candidate (1.0) is < 0.01 from the current value -> the history refuses it
  const hist = new Float32Array(DEG_MUL_HISTORY).fill(d);
  assert(calcDegLevelStep(16, d, hist) === d, "held");
});
await check("13 fps: every step < 0.01 -> the history freezes deg_mul where it is", () => {
  assert(run(13, 100, 0).d === 0, "from 0");
  assert(run(13, 100, 1).d === 1, "from 1");
  const half = Math.fround(0.5);
  assert(run(13, 100, half).d === half, "from 0.5");
});
await check("5 fps: -0.15 per step down to -1", () => {
  const { d, seq } = run(5, 20, 1);
  assert(Math.abs(seq[0] - Math.fround(0.85)) < 1e-6, `first step ${seq[0]}`);
  assert(d === -1, `${d}`);
});
await check("a return to a recent value is refused (30-entry hysteresis)", () => {
  // hist holds 0.25 somewhere in the window; from 0.15 at 60 fps the candidate 0.25 is refused
  const hist = new Float32Array(DEG_MUL_HISTORY).fill(Math.fround(0.15));
  hist[5] = Math.fround(0.25);
  const d0 = Math.fround(0.15);
  assert(calcDegLevelStep(60, d0, hist) === d0, "refused");
  assert(hist[DEG_MUL_HISTORY - 1] === d0, "history records the unchanged value");
});

const FLT_MAX = 3.4028235e38;
const chain = (levels) => parseDegradeInfo({ degrades: levels.map(([gfx_obj_id, degrade_mode, min_dist, ideal_dist, max_dist]) => ({ gfx_obj_id, degrade_mode, min_dist, ideal_dist, max_dist })) });
// Real portal.dat 0x110006C6 (human male part 0), as in test_part_degrade.mjs.
const HUMAN_PART0 = chain([
  [0x01001887, 1, 0, 3, 7], [0x0100004e, 1, 0, 5, 10], [0x010001a2, 1, 3, 7, 18],
  [0x010001a0, 1, 10, 15, 30], [0x010001f1, 5, 84, 84, 84], [0, 1, FLT_MAX, FLT_MAX, FLT_MAX],
]);
// Synthetic: last drawn level (min 50, ideal 84, max 120).
const WIDE = chain([[0x01000001, 1, 0, 3, 7], [0x01000002, 1, 50, 84, 120], [0, 1, FLT_MAX, FLT_MAX, FLT_MAX]]);
const drawn = (L, d, m) => L[selectDegradeLevel(L, d, m)].gfx !== 0;

console.log("\n2. human body chain at deg_mul 1");
await check("133.9 m drawn (level 4), 134 m NULL — same as deg_mul 0", () => {
  assert(selectDegradeLevel(HUMAN_PART0, 133.9, 1) === 4 && drawn(HUMAN_PART0, 133.9, 1), "133.9 m");
  assert(!drawn(HUMAN_PART0, 134, 1) && !drawn(HUMAN_PART0, 5000, 1), "134 m / 5 km");
  assert(drawn(HUMAN_PART0, 133.9, 0) && !drawn(HUMAN_PART0, 134, 0), "deg_mul 0 agrees");
});
await check("deg_mul 1 moves the near levels out to max_dist (level 0 until 57 m)", () => {
  assert(selectDegradeLevel(HUMAN_PART0, 56.9, 1) === 0 && selectDegradeLevel(HUMAN_PART0, 57, 1) === 1, "level 0 -> 1 at 50 + 7");
});

console.log("\n3. a chain whose last drawn level has max > ideal");
await check("(50, 84, 120): drawn at 169.9 m, NULL at 170 m with deg_mul 1", () => {
  assert(selectDegradeLevel(WIDE, 169.9, 1) === 1 && drawn(WIDE, 169.9, 1), "169.9 m");
  assert(!drawn(WIDE, 170, 1), "170 m");
});
await check("... and NULL from 134 m at deg_mul 0", () => {
  assert(drawn(WIDE, 133.9, 0) && !drawn(WIDE, 134, 0), "deg_mul 0");
});

console.log("\n4. defaults stay deg_mul 0; RETAIL_DEG_MUL threads through PartDegrade");
await check("selectDegradeLevel default deg_mul is 0", () => {
  assert(selectDegradeLevel(WIDE, 150) === selectDegradeLevel(WIDE, 150, 0), "default = 0");
  assert(selectDegradeLevel(WIDE, 150) !== selectDegradeLevel(WIDE, 150, 1), "differs from 1 at 150 m");
});
await check("PartDegrade: default degMul 0 hides the wide part at 150 m; RETAIL_DEG_MUL draws it", async () => {
  const wideJson = JSON.stringify({ degrades: [
    { gfx_obj_id: 0x01000001, degrade_mode: 1, min_dist: 0, ideal_dist: 3, max_dist: 7 },
    { gfx_obj_id: 0x01000002, degrade_mode: 1, min_dist: 50, ideal_dist: 84, max_dist: 120 },
    { gfx_obj_id: 0, degrade_mode: 1, min_dist: FLT_MAX, ideal_dist: FLT_MAX, max_dist: FLT_MAX },
  ] });
  const fetchInfo = async () => wideJson;
  const mesh = () => ({ isMesh: true, name: "part_0_surface_1", visible: true, userData: {}, matrixWorldNeedsUpdate: false });
  const rig = (x) => {
    const e = new Array(16).fill(0); e[0] = 1; e[5] = 1; e[10] = 1; e[15] = 1; e[12] = x;
    return { guid: 7, root: { matrixWorld: { elements: e } }, parts: [{ children: [mesh()], userData: { didDegrade: 0x11000099 } }] };
  };
  const cam = { x: 0, y: 0, z: 0 };
  const pd0 = new PartDegrade({ fetchInfo });
  const pd1 = new PartDegrade({ fetchInfo, degMul: RETAIL_DEG_MUL });
  assert(pd0.degMul === 0, `constructor default ${pd0.degMul}`);
  assert(pd1.degMul === 1, `explicit ${pd1.degMul}`);
  const r0 = rig(150), r1 = rig(150), r1far = rig(171);
  pd0.tick([r0], cam, 0); pd1.tick([r1, r1far], cam, 0);
  await new Promise((r) => setTimeout(r, 0));
  pd0.tick([r0], cam, 0); pd1.tick([r1, r1far], cam, 0);
  assert(!r0.parts[0].children[0].visible, "deg_mul 0: hidden at 150 m");
  assert(r1.parts[0].children[0].visible, "deg_mul 1: drawn at 150 m");
  assert(!r1far.parts[0].children[0].visible, "deg_mul 1: hidden at 171 m");
});

console.log("\n5. EntityManager construction site");
await check("?partDegrade=on builds PartDegrade with degMul RETAIL_DEG_MUL; absent builds none", async () => {
  const THREE = await import("three");
  const { EntityManager } = await import("../scene3d/entities.js");
  const prevWindow = globalThis.window;
  try {
    globalThis.window = { location: { search: "?partDegrade=on" } };
    const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, {});
    assert(em._partDegrade instanceof PartDegrade, "PartDegrade built");
    assert(em._partDegrade.degMul === RETAIL_DEG_MUL, `degMul ${em._partDegrade.degMul}`);
    globalThis.window = { location: { search: "" } };
    const em2 = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, {});
    assert(em2._partDegrade === null, "default OFF: no PartDegrade");
  } finally {
    if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
  }
});

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
