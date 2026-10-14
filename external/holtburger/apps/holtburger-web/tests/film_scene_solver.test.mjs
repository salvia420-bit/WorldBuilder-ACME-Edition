// tests/film_scene_solver.test.mjs
//
// WHY: AC Film Mode's scout turns a shot INTENT ("medium shot, eye level,
// subject on the left third, backlit, not behind a tree") into concrete camera
// poses with scene3d/film/scene/solver.js, the page measures them, the solver
// scores them, and JEV chooses among the solver's worded options
// (describeCandidate → tools/film/lib/jev_tasks.mjs pickCandidate). If the
// candidates are not deterministic, not where the intent asked (angle band,
// light side, thirds mark, shot size), under the ground, or if the scores and
// words disagree with the measurements, the director and JEV choose blind.
// This suite EXECUTES the real module and proves:
//   S1  normalizeIntent: defaults and readable FilmShotErrors for bad values;
//   S2  determinism (same seed → identical poses; ctx.rng; count; ids c1..cN;
//       valid unit quaternions);
//   S3  framing: every candidate hits its shot-size scale (±8 % variety) and its
//       placement mark — cross-checked by projecting the aim point through a
//       REAL three 0.184 PerspectiveCamera built from the pose; tight framings
//       take a longer lens instead of crowding the subject; a fixed fov is kept;
//   S4  angles: eye / high / low elevation bands, top-down straight down with
//       the subject on its mark (no gimbal spin), heading continuity;
//   S5  light: front / back / rim azimuths from ctx.sun; a sun below the
//       horizon or an indoor scene ignores the light intent;
//   S6  view relative to the subject heading;
//   S7  below-ground rejection on hilly terrain, lifted low angles, a pit where
//       nothing honours the angle (relaxed fill), cameras never inside the subject;
//   S8  indoor floor / ceiling envelope (groundZ ignored indoors);
//   S9  candidateMetrics: composition, framing scale, light angle, sun in frame,
//       below ground, measured pass-through;
//   S10 scoreCandidate: hard violations, soft terms, monotonic costs, reasons;
//   S11 describeCandidate words (clearance as the pilot's WORD_BOUNDS distance word,
//       metres truncated into that band); rankCandidates order / ids / errors;
//   S12 end-to-end: generate → measure (fake wall occluding one side) → rank.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — solver.js is one of its pure scene modules.
// Run from apps/holtburger-web/: node tests/film_scene_solver.test.mjs

import assert from "node:assert/strict";

const S = await import("../scene3d/film/scene/solver.js");
const SW = await import("../scene3d/film/pilot/sense_words.js");
const FR = await import("../scene3d/film/shots/framing.js");
const G = await import("../scene3d/film/core/gimbal.js");
const { mulberry32 } = await import("../scene3d/film/core/rng.js");
const { FilmShotError } = await import("../scene3d/film/core/errors.js");
const THREE = await import("three");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err && err.message ? err.message : err}`);
  }
}

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? "value"}: ${a} vs ${b} (eps ${eps})`);
}
const DEG = Math.PI / 180;
const angDiff = (a, b) => {
  const d = (((a - b) % 360) + 540) % 360 - 180;
  return Math.abs(d);
};

const SUBJ = Object.freeze({ pos: [21000, 34000, 50], height: 1.8, radius: 0.4, heading: 30 * DEG });
const flat = () => 50;
const CTX = Object.freeze({ groundZ: flat, aspect: 16 / 9 });

/** Project an AC world point through a REAL three camera built from the pose. */
function threeNdc(pose, point, aspect) {
  const cam = new THREE.PerspectiveCamera(pose.fov, aspect, 0.1, 5000);
  cam.position.set(...G.acToThreePos(pose.pos));
  cam.quaternion.set(...G.acQuatToThree(pose.q));
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  const v = new THREE.Vector3(...G.acToThreePos(point)).project(cam);
  return [v.x, v.y];
}

// ---------------------------------------------------------------------------
// S1 intent
// ---------------------------------------------------------------------------
check("S1 normalizeIntent fills defaults and rejects unknown values readably", () => {
  const d = S.normalizeIntent({});
  assert.equal(d.framing, "MS");
  assert.equal(d.angle, "eye");
  assert.equal(d.minClearance, 1);
  assert.equal(d.maxOcclusion, 0.2);
  assert.equal(d.light, null);
  assert.equal(S.normalizeIntent({ framing: "cu", light: "backlit", angle: "TOP" }).framing, "CU");
  assert.equal(S.normalizeIntent({ light: "backlit" }).light, "back");
  assert.equal(S.normalizeIntent({ maxOcclusion: 3 }).maxOcclusion, 1);
  const bad = (intent, code, re) => assert.throws(() => S.normalizeIntent(intent),
    (e) => e instanceof FilmShotError && e.code === code && re.test(e.message));
  bad({ angle: "dutch" }, "BAD_INTENT", /eye, high, low, top/);
  bad({ light: "side" }, "BAD_INTENT", /front, back, rim/);
  bad({ view: "behind" }, "BAD_INTENT", /three-quarter/);
  bad({ framing: "XL" }, "BAD_FRAMING", /EWS/);
  assert.throws(() => S.normalizeIntent({ side: "middle" }), FilmShotError);
});

// ---------------------------------------------------------------------------
// S2 determinism
// ---------------------------------------------------------------------------
check("S2 same seed → identical candidates; different seed → different; ids and quaternions", () => {
  const a = S.generateCandidates({ framing: "MS" }, SUBJ, CTX, { seed: 42 });
  const b = S.generateCandidates({ framing: "MS" }, SUBJ, CTX, { seed: 42 });
  const c = S.generateCandidates({ framing: "MS" }, SUBJ, CTX, { seed: 43 });
  assert.equal(a.length, 12, "default count 12");
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.notDeepEqual(a.map((p) => p.pos), c.map((p) => p.pos));
  a.forEach((p, i) => {
    assert.equal(p.meta.id, `c${i + 1}`);
    assert.equal(p.meta.index, i);
    assert.ok(!/^\d+$/.test(p.meta.id), "never integer-like (JEV choice keys)");
    near(Math.hypot(...p.q), 1, 1e-9, "unit quaternion");
    for (const v of [...p.pos, p.h, p.p, p.r, p.fov]) assert.ok(Number.isFinite(v));
  });
  const r1 = S.generateCandidates({}, SUBJ, CTX, { rng: mulberry32(7), count: 5 });
  const r2 = S.generateCandidates({}, SUBJ, { ...CTX, rng: mulberry32(7) }, { count: 5 });
  assert.equal(r1.length, 5);
  assert.deepEqual(r1.map((p) => p.pos), r2.map((p) => p.pos), "opts.rng and ctx.rng are the same stream");
  assert.deepEqual(S.generateCandidates({}, SUBJ, CTX, { count: 0 }), []);
  const anchorOnly = S.generateCandidates({ framing: "WS" }, null, { anchor: [10, 10, 0] }, { count: 2 });
  assert.equal(anchorOnly.length, 2, "ctx.anchor stands in for a subject");
  assert.throws(() => S.generateCandidates({}, null, {}), (e) => e instanceof FilmShotError && e.code === "MISSING_SUBJECT");
});

// ---------------------------------------------------------------------------
// S3 framing
// ---------------------------------------------------------------------------
check("S3 every candidate hits its shot size and its thirds mark (three.js cross-check)", () => {
  for (const framing of ["ECU", "CU", "MS", "FS", "WS", "EWS"]) {
    for (const side of ["left", "right", "center"]) {
      const intent = { framing, side };
      const cands = S.generateCandidates(intent, SUBJ, CTX, { seed: 3, count: 6 });
      assert.equal(cands.length, 6, `${framing}/${side}`);
      const aim = FR.aimPointForFraming(framing, SUBJ);
      const vertical = FR.aimHeightFraction(framing) >= 0.85 ? 1 / 3 : 0;
      const sx = side === "left" ? -1 / 3 : side === "right" ? 1 / 3 : 0;
      for (const p of cands) {
        const m = S.candidateMetrics(p, SUBJ, CTX, {}, intent);
        assert.ok(m.sizeRatio > 0.9 && m.sizeRatio < 1.1, `${framing} size ${m.sizeRatio}`);
        assert.ok(m.composition.inFrame);
        assert.ok(m.composition.thirdsError < 1e-6, `${framing}/${side} thirds error ${m.composition.thirdsError}`);
        const [x, y] = threeNdc(p, aim, 16 / 9);
        near(x, sx, 1e-6, `${framing}/${side} three ndc x`);
        near(y, vertical, 1e-6, `${framing}/${side} three ndc y`);
      }
    }
  }
});

check("S3 a Dutch angle (intent.roll) keeps the subject exactly on its mark, top-down too", () => {
  for (const [angle, framing] of [["eye", "MS"], ["high", "FS"], ["top", "WS"]]) {
    const intent = { framing, angle, side: "right", roll: 12 * DEG };
    const cands = S.generateCandidates(intent, SUBJ, CTX, { seed: 14, count: 5 });
    assert.equal(cands.length, 5, `${angle}`);
    const aim = FR.aimPointForFraming(framing, SUBJ);
    const vertical = FR.aimHeightFraction(framing) >= 0.85 ? 1 / 3 : 0;
    for (const p of cands) {
      near(p.r, 12 * DEG, 1e-9, "roll kept");
      const [x, y] = threeNdc(p, aim, 16 / 9);
      near(x, 1 / 3, 1e-6, `${angle} rolled ndc x`);
      near(y, vertical, 1e-6, `${angle} rolled ndc y`);
      const m = S.candidateMetrics(p, SUBJ, CTX, {}, intent);
      if (angle !== "top") {
        near(m.composition.horizonTiltDeg, 12, 1e-6, "horizon tilt = roll");
        assert.ok(!S.scoreCandidate(m, intent).reasons.some((r) => /tilted/.test(r)), "asked tilt not penalised");
      }
    }
  }
});

check("S3 tight framings take a longer lens instead of crowding the subject; a fixed fov is kept", () => {
  const cu = S.generateCandidates({ framing: "CU" }, SUBJ, CTX, { seed: 1, count: 4 });
  for (const p of cu) {
    assert.ok(p.fov < 30, `CU lens narrowed (fov ${p.fov})`);
    assert.ok(p.meta.distance >= SUBJ.radius + 0.5 - 1e-6, `never closer than radius + 0.5 (${p.meta.distance})`);
  }
  const fixed = S.generateCandidates({ framing: "CU", fov: 60 }, SUBJ, CTX, { seed: 1, count: 4 });
  for (const p of fixed) {
    near(p.fov, 60, 1e-12, "intent.fov kept");
    assert.ok(p.meta.distance >= SUBJ.radius + 0.5 - 1e-6);
  }
  const ws = S.generateCandidates({ framing: "WS" }, SUBJ, CTX, { seed: 1, count: 4 });
  for (const p of ws) near(p.fov, 60, 1e-12, "wide shots keep the default lens");
  const opt = S.generateCandidates({ framing: "WS" }, SUBJ, { ...CTX, fov: 40 }, { seed: 1, count: 2, fov: 35 });
  near(opt[0].fov, 35, 1e-12, "opts.fov wins over ctx.fov");
});

// ---------------------------------------------------------------------------
// S4 angles
// ---------------------------------------------------------------------------
check("S4 eye / high / low candidates sit in their elevation bands", () => {
  for (const [angle, framing] of [["eye", "MS"], ["high", "FS"], ["low", "MS"], ["high", "CU"]]) {
    const band = S.SOLVER_ANGLES[angle];
    const cands = S.generateCandidates({ framing, angle }, SUBJ, CTX, { seed: 9, count: 8 });
    assert.equal(cands.length, 8, `${angle}/${framing}`);
    for (const p of cands) {
      const e = p.meta.elevationDeg;
      assert.ok(e >= band.minDeg - 1e-6 && e <= band.maxDeg + 1e-6, `${angle} elevation ${e}`);
      const m = S.candidateMetrics(p, SUBJ, CTX, {}, { framing, angle });
      assert.equal(m.angle, angle, `${angle} classified ${m.angle}`);
      if (angle === "high") assert.ok(p.p < -15 * DEG, "looks down");
      if (angle === "low") assert.ok(p.p > 0, "looks up");
    }
  }
});

check("S4 top-down: straight down, subject on its mark, frame-up = the subject's heading", () => {
  const intent = { framing: "WS", angle: "top", side: "left" };
  const cands = S.generateCandidates(intent, SUBJ, CTX, { seed: 2, count: 8 });
  assert.equal(cands.length, 8);
  const aim = FR.aimPointForFraming("WS", SUBJ);
  for (const p of cands) {
    assert.ok(p.p <= -80 * DEG, `steep (${p.p / DEG}°)`);
    assert.ok(p.pos[2] > SUBJ.pos[2] + SUBJ.height + 0.2, "above the head");
    const [x, y] = threeNdc(p, aim, 16 / 9);
    near(x, -1 / 3, 1e-6, "three ndc x on the left third");
    near(y, 0, 1e-6, "three ndc y centre (WS)");
    const m = S.candidateMetrics(p, SUBJ, CTX, {}, intent);
    assert.equal(m.angle, "top");
    assert.equal(m.lightAngleDeg, null, "no light word top-down");
    near(m.sizeRatio, m.sizeRatio, 0, "finite");
    assert.ok(m.sizeRatio > 0.9 && m.sizeRatio < 1.1, `top WS framing scale ${m.sizeRatio}`);
  }
  // Exactly straight down (inside the hold cone): heading = subject heading → no spin.
  const nadir = cands.filter((p) => Math.abs(p.p + Math.PI / 2) < 1e-9);
  for (const p of nadir) near(p.h, SUBJ.heading, 1e-9, "nadir heading = subject heading");
});

// ---------------------------------------------------------------------------
// S5 light
// ---------------------------------------------------------------------------
const SUN = Object.freeze({ h: 90 * DEG, p: 25 * DEG }); // the sun is in the east
check("S5 front / back / rim light place the camera relative to ctx.sun", () => {
  const ctx = { ...CTX, sun: SUN };
  const front = S.generateCandidates({ framing: "FS", light: "front" }, SUBJ, ctx, { seed: 4, count: 8 });
  for (const p of front) {
    assert.ok(angDiff(p.meta.azimuthDeg, 90) <= 40, `front az ${p.meta.azimuthDeg}`);
    assert.ok(p.meta.lightAngleDeg < 45, `front-lit (${p.meta.lightAngleDeg})`);
  }
  const back = S.generateCandidates({ framing: "FS", light: "back" }, SUBJ, ctx, { seed: 4, count: 8 });
  for (const p of back) {
    assert.ok(angDiff(p.meta.azimuthDeg, 270) <= 30, `back az ${p.meta.azimuthDeg}`);
    assert.ok(p.meta.lightAngleDeg > 150, `backlit (${p.meta.lightAngleDeg})`);
    assert.equal(S.lightWord(p.meta.lightAngleDeg), "backlit");
  }
  const rim = S.generateCandidates({ framing: "FS", light: "rim" }, SUBJ, ctx, { seed: 4, count: 8 });
  const sides = new Set();
  for (const p of rim) {
    near(p.meta.lightAngleDeg, 140, 15, "rim light angle");
    sides.add(angDiff(p.meta.azimuthDeg, 230) < angDiff(p.meta.azimuthDeg, 310) ? "south" : "north");
  }
  assert.equal(sides.size, 2, "both rim lobes sampled");
});

check("S5 a sun below the horizon or an indoor scene ignores the light intent", () => {
  const night = S.generateCandidates({ framing: "FS", light: "back" }, { ...SUBJ, heading: undefined },
    { ...CTX, sun: { h: 90 * DEG, p: -20 * DEG } }, { seed: 4, count: 12 });
  const azs = night.map((p) => p.meta.azimuthDeg);
  assert.ok(Math.max(...azs) - Math.min(...azs) > 270, "full circle without a usable sun");
  for (const p of night) assert.equal(p.meta.lightAngleDeg, null);
  const inside = S.generateCandidates({ framing: "FS", light: "back" }, SUBJ,
    { sun: SUN, indoor: { floor: () => 50, ceiling: () => 56 } }, { seed: 4, count: 4 });
  for (const p of inside) assert.equal(p.meta.lightAngleDeg, null);
  near(S.lightAngleDeg([10, 0, 0], [0, 0, 0], { h: 90 * DEG, p: 0.3 }), 0, 1e-9, "camera on the sun side");
  near(S.lightAngleDeg([-10, 0, 0], [0, 0, 0], { h: 90 * DEG, p: 0.3 }), 180, 1e-9, "camera facing the sun");
  assert.equal(S.lightAngleDeg([0, 0, 5], [0, 0, 0], { h: 1, p: 1 }), null, "straight above");
  assert.equal(S.lightAngleDeg([1, 0, 0], [0, 0, 0], null), null);
  assert.deepEqual([10, 60, 130, 170].map(S.lightWord), ["front-lit", "side-lit", "rim-lit", "backlit"]);
});

// ---------------------------------------------------------------------------
// S6 view
// ---------------------------------------------------------------------------
check("S6 views are relative to the subject's heading; no heading → the full circle", () => {
  const prof = S.generateCandidates({ framing: "MS", view: "profile" }, SUBJ, CTX, { seed: 5, count: 8 });
  for (const p of prof) {
    const rel = Math.min(angDiff(p.meta.azimuthDeg, 30 + 90), angDiff(p.meta.azimuthDeg, 30 - 90));
    assert.ok(rel <= 21, `profile az ${p.meta.azimuthDeg}`);
  }
  const back = S.generateCandidates({ framing: "MS", view: "back" }, SUBJ, CTX, { seed: 5, count: 6 });
  for (const p of back) assert.ok(angDiff(p.meta.azimuthDeg, 210) <= 21, `back az ${p.meta.azimuthDeg}`);
  const front = S.generateCandidates({ framing: "MS" }, SUBJ, CTX, { seed: 5, count: 8 });
  for (const p of front) assert.ok(angDiff(p.meta.azimuthDeg, 30) <= 75, `default = front hemisphere (${p.meta.azimuthDeg})`);
  const any = S.generateCandidates({ framing: "MS", view: "any" }, SUBJ, CTX, { seed: 5, count: 12 });
  const azs = any.map((p) => p.meta.azimuthDeg).sort((a, b) => a - b);
  let gap = 0;
  for (let i = 0; i < azs.length; i++) gap = Math.max(gap, ((azs[(i + 1) % azs.length] - azs[i]) + 360) % 360);
  assert.ok(gap < 90, `view any spreads round the subject (largest gap ${gap.toFixed(1)}°)`);
});

// ---------------------------------------------------------------------------
// S7 ground
// ---------------------------------------------------------------------------
check("S7 hilly terrain: no candidate is ever under ground + 0.7 m", () => {
  const hills = (x, y) => 50 + 3 * Math.sin(x * 0.7) + 2 * Math.cos(y * 0.9);
  for (const angle of ["eye", "low", "high"]) {
    for (const framing of ["CU", "MS", "FS", "WS"]) {
      const cands = S.generateCandidates({ framing, angle }, { ...SUBJ, pos: [21000, 34000, hills(21000, 34000)] },
        { groundZ: hills }, { seed: 11, count: 10 });
      for (const p of cands) {
        assert.ok(p.pos[2] >= hills(p.pos[0], p.pos[1]) + 0.7 - 1e-9, `${angle}/${framing} z ${p.pos[2]}`);
      }
    }
  }
});

check("S7 a low wide shot on flat ground is lifted onto the clearance plane, not dropped", () => {
  const cands = S.generateCandidates({ framing: "FS", angle: "low" }, SUBJ, CTX, { seed: 6, count: 6 });
  assert.equal(cands.length, 6);
  for (const p of cands) {
    near(p.pos[2], 50 + 0.7, 2e-6, "on the ground clearance plane");
    assert.equal(p.meta.lifted, true);
    assert.equal(p.meta.relaxed, false);
    assert.ok(p.meta.elevationDeg < 0, "still below the aim point");
  }
});

check("S7 a pit nothing can film at eye level: strict pass rejects, relaxed fill is flagged", () => {
  const pit = (x, y) => (Math.hypot(x - SUBJ.pos[0], y - SUBJ.pos[1]) < 0.6 ? 50 : 60);
  const cands = S.generateCandidates({ framing: "MS", angle: "eye" }, SUBJ, { groundZ: pit }, { seed: 8, count: 4 });
  assert.ok(cands.stats.rejected.ground >= 32, `strict attempts rejected (${cands.stats.rejected.ground})`);
  assert.equal(cands.length, 4);
  assert.equal(cands.stats.relaxed, 4);
  for (const p of cands) {
    assert.equal(p.meta.relaxed, true);
    assert.ok(p.pos[2] >= pit(p.pos[0], p.pos[1]) + 0.7 - 1e-9, "never under the rim");
    const m = S.candidateMetrics(p, SUBJ, { groundZ: pit }, {}, { framing: "MS" });
    const s = S.scoreCandidate(m, { framing: "MS", angle: "eye" });
    assert.ok(s.reasons.some((r) => /wanted eye level/.test(r)), `angle mismatch explained: ${s.reasons}`);
  }
  for (const p of S.generateCandidates({ framing: "ECU" }, SUBJ, CTX, { seed: 1, count: 12 })) {
    const hd = Math.hypot(p.pos[0] - SUBJ.pos[0], p.pos[1] - SUBJ.pos[1]);
    assert.ok(hd >= SUBJ.radius + 0.25, "never inside the subject");
  }
});

// ---------------------------------------------------------------------------
// S8 indoor
// ---------------------------------------------------------------------------
check("S8 indoor: inside floor + 0.3 … ceiling − 0.3; groundZ ignored", () => {
  const indoor = { floor: () => 50, ceiling: () => 52.2 };
  const ctx = { groundZ: () => 500, indoor };
  const cands = S.generateCandidates({ framing: "FS", angle: "high" }, SUBJ, ctx, { seed: 12, count: 8 });
  assert.ok(cands.length > 0);
  for (const p of cands) {
    assert.ok(p.pos[2] >= 50.3 - 1e-9 && p.pos[2] <= 51.9 + 1e-9, `z ${p.pos[2]}`);
    const m = S.candidateMetrics(p, SUBJ, ctx, {}, { framing: "FS", angle: "high" });
    assert.equal(m.groundClearance, null, "no ground indoors");
    assert.equal(m.belowGround, false);
  }
  assert.ok(cands.some((p) => p.meta.lifted), "some lowered under the ceiling");
  const lowCeil = { indoor: { floor: () => 50, ceiling: () => 53.5 } };
  const tops = S.generateCandidates({ framing: "WS", angle: "top", side: "left" }, SUBJ, lowCeil, { seed: 13, count: 6 });
  assert.equal(tops.length, 6, "top-down under a low ceiling");
  const aimWS = FR.aimPointForFraming("WS", SUBJ);
  for (const p of tops) {
    assert.ok(p.pos[2] <= 53.2 + 1e-9, `under the ceiling clearance (z ${p.pos[2]})`);
    assert.ok(p.pos[2] > SUBJ.pos[2] + SUBJ.height + 0.2, "above the head");
    near(threeNdc(p, aimWS, 16 / 9)[0], -1 / 3, 1e-6, "still on the left third");
  }
  const closet = S.generateCandidates({ framing: "MS" }, SUBJ, { indoor: { floor: () => 50, ceiling: () => 50.4 } }, { count: 3 });
  assert.equal(closet.length, 0, "no room between floor and ceiling");
  assert.ok(closet.stats.rejected.indoor > 0);
});

// ---------------------------------------------------------------------------
// S9 metrics
// ---------------------------------------------------------------------------
check("S9 candidateMetrics: composition, light, sun in frame, ground, measured fields", () => {
  const ctx = { ...CTX, sun: { h: 270 * DEG, p: 8 * DEG } }; // low sun in the west
  const [p] = S.generateCandidates({ framing: "FS", light: "back" }, SUBJ, ctx, { seed: 21, count: 1 });
  const m = S.candidateMetrics(p, SUBJ, ctx, {
    visibleFrac: 1.4, occluderKind: " ", clearance: -2, nearestKind: "tree", particleRisk: 0.5, particleFamily: "smoke",
  }, { framing: "FS", light: "back" });
  assert.equal(m.visibleFrac, 1, "clamped");
  assert.equal(m.occluderKind, null);
  assert.equal(m.clearance, 0, "clamped at 0");
  assert.equal(m.particleRisk, 0.5);
  assert.equal(m.particleFamily, "smoke");
  assert.ok(m.lightAngleDeg > 150);
  assert.equal(m.sunInFrame, true, "facing a low sun");
  near(m.groundClearance, p.pos[2] - 50, 1e-9, "ground clearance");
  assert.equal(m.belowGround, false);
  assert.ok(m.composition && m.composition.inFrame);
  near(m.distance, p.meta.distance, 1e-9, "distance");
  const under = S.candidateMetrics({ ...p, pos: [p.pos[0], p.pos[1], 49] }, SUBJ, ctx, {}, { framing: "FS" });
  assert.equal(under.belowGround, true);
  const unmeasured = S.candidateMetrics(p, SUBJ, ctx);
  assert.equal(unmeasured.visibleFrac, null);
  assert.equal(unmeasured.clearance, null);
  assert.equal(unmeasured.particleRisk, 0);
  assert.equal(S.candidateMetrics(p, SUBJ, ctx, { clearance: Infinity }).clearance, Infinity);
  assert.throws(() => S.candidateMetrics({ pos: [NaN, 0, 0] }, SUBJ), FilmShotError);
  near(S.framingScale([0, -2, 1], [0, 1, 0], [0, 0, 1], 1.8, 60), 1.8 / (4 * Math.tan(30 * DEG)), 1e-12, "framingScale");
  assert.equal(S.framingScale([0, 2, 1], [0, 1, 0], [0, 0, 1], 1.8, 60), null, "aim behind");
  assert.deepEqual([70, 20, -10, 0].map(S.angleForElevation), ["top", "high", "low", "eye"]);
});

// ---------------------------------------------------------------------------
// S10 score
// ---------------------------------------------------------------------------
function cleanMetrics(over = {}) {
  return {
    visibleFrac: 1, occluderKind: null, clearance: 6, nearestKind: "tree", particleRisk: 0, particleFamily: null,
    composition: { inFrame: true, inFront: true, ndc: [-1 / 3, 1 / 3], thirdsError: 0, headroom: 0.12, horizonTiltDeg: 0, sizeRatio: 1 },
    sizeRatio: 1, lightAngleDeg: 175, sunInFrame: false, belowGround: false, angle: "eye", ...over,
  };
}
check("S10 a clean candidate is ok and cheap; hard violations dominate", () => {
  const intent = { framing: "MS", light: "back", minClearance: 1, maxOcclusion: 0.2 };
  const clean = S.scoreCandidate(cleanMetrics(), intent);
  assert.equal(clean.ok, true);
  assert.ok(clean.cost < 1, `clean cost ${clean.cost}`);
  const occl = S.scoreCandidate(cleanMetrics({ visibleFrac: 0.6, occluderKind: "scenery" }), intent);
  assert.equal(occl.ok, false);
  assert.ok(occl.cost >= 100);
  assert.ok(occl.reasons.some((r) => r === "subject 40% hidden by tree (max 20%)"), occl.reasons.join(" | "));
  const tight = S.scoreCandidate(cleanMetrics({ clearance: 0.4, nearestKind: "wall" }), intent);
  assert.equal(tight.ok, false);
  assert.ok(tight.reasons.includes("0.4 m from wall, under the 1 m minimum"), tight.reasons.join(" | "));
  const out = S.scoreCandidate(cleanMetrics({ composition: { inFrame: false, inFront: false } }), intent);
  assert.equal(out.ok, false);
  assert.ok(out.reasons.includes("subject behind the camera"));
  const under = S.scoreCandidate(cleanMetrics({ belowGround: true }), intent);
  assert.ok(under.cost >= 1000, "under the ground ranks last of all");
  assert.equal(S.scoreCandidate({}, intent).ok, false, "no composition → out of frame");
});

check("S10 soft terms grow monotonically and explain themselves", () => {
  const intent = { framing: "MS", light: "back" };
  const cost = (over) => S.scoreCandidate(cleanMetrics(over), intent).cost;
  assert.ok(cost({ visibleFrac: 0.9 }) < cost({ visibleFrac: 0.82 }), "more occlusion costs more");
  assert.ok(cost({ clearance: 5 }) < cost({ clearance: 1.5 }), "closer obstacles cost more");
  assert.ok(cost({ particleRisk: 0.2 }) < cost({ particleRisk: 0.9 }), "particles");
  assert.ok(cost({ sizeRatio: 1.1 }) < cost({ sizeRatio: 1.6 }), "size error");
  assert.ok(cost({ composition: { ...cleanMetrics().composition, thirdsError: 0.1 } })
    < cost({ composition: { ...cleanMetrics().composition, thirdsError: 0.5 } }), "thirds error");
  const reasons = (over) => S.scoreCandidate(cleanMetrics(over), intent).reasons;
  assert.ok(reasons({ lightAngleDeg: 20 }).includes("front-lit, wanted backlit"));
  assert.deepEqual(reasons({ lightAngleDeg: 165 }), [], "within the backlight tolerance");
  assert.ok(reasons({ particleRisk: 0.9, particleFamily: "smoke" }).includes("thick smoke in view"));
  assert.ok(reasons({ sizeRatio: 0.45 }).some((r) => r.startsWith("subject much too small")));
  assert.ok(reasons({ angle: "high" }).includes("high angle, wanted eye level"));
  assert.ok(reasons({ composition: { ...cleanMetrics().composition, headroom: -0.2 } }).includes("head cut off"));
  assert.ok(reasons({ composition: { ...cleanMetrics().composition, horizonTiltDeg: 12 } }).includes("horizon tilted 12°"));
  assert.deepEqual(S.scoreCandidate(cleanMetrics({ composition: { ...cleanMetrics().composition, horizonTiltDeg: 12 } }),
    { framing: "MS", light: "back", roll: 12 * DEG }).reasons, [], "an asked Dutch angle is not a tilt");
  const sun = S.scoreCandidate(cleanMetrics({ sunInFrame: true, lightAngleDeg: 100 }), { framing: "MS" });
  assert.ok(sun.reasons.includes("sun in frame"));
  assert.ok(!S.scoreCandidate(cleanMetrics({ sunInFrame: true }), intent).reasons.includes("sun in frame"), "allowed when backlit");
  const unknown = S.scoreCandidate(cleanMetrics({ visibleFrac: null, clearance: null, lightAngleDeg: null }), intent);
  assert.equal(unknown.ok, true, "missing measurements cost nothing");
});

// ---------------------------------------------------------------------------
// S11 words + ranking
// ---------------------------------------------------------------------------
check("S11 describeCandidate: short words for JEV", () => {
  const words = S.describeCandidate({
    visibleFrac: 1, clearance: 4.2, nearestKind: "tree", lightAngleDeg: 170, angle: "eye",
    composition: { inFrame: true, ndc: [-0.33, 0.3], sizeRatio: 1 }, sizeRatio: 1,
  });
  assert.equal(words, "clear view, nearest tree near (4.2 m), subject on left third, backlit, eye level");
  assert.equal(S.describeCandidate({
    visibleFrac: 0.5, occluderKind: "boulder", clearance: Infinity, sizeRatio: 0.6,
    composition: { inFrame: true, ndc: [0.05, 0], sizeRatio: 1 }, particleRisk: 0.8, particleFamily: "smoke", angle: "high",
  }), "subject partly hidden by rock, open space around the camera, subject centred, subject too small, thick smoke in view, high angle");
  assert.equal(S.describeCandidate({ clearance: 0.64, nearestKind: "scenery", composition: { inFrame: false }, sunInFrame: true }),
    "nearest tree touching (0.64 m), subject out of frame, sun in frame");
  assert.equal(S.describeCandidate({ visibleFrac: 0.25, occluderKind: "tree", clearance: 1.5, nearestKind: "rock" }),
    "subject mostly hidden by tree, nearest rock very close (1.5 m)");
  assert.equal(S.describeCandidate({ clearance: 45, nearestKind: "building" }), "open space around the camera (nearest building 45 m)");
  assert.equal(S.describeCandidate({ clearance: -0.3 }), "nearest obstacle touching (0 m)", "embedded → touching, never negative");
  assert.equal(S.describeCandidate({ composition: { inFrame: true, ndc: [0.8, 0] }, lightAngleDeg: 100 }),
    "subject near right edge, side-lit");
  assert.equal(S.describeCandidate({}), "");
  assert.equal(S.describeCandidate(null), "");
});

check("S11 describeCandidate states clearance with every WORD_BOUNDS distance word, metres inside the band (jev-2)", () => {
  // JEV's pick rule quotes distance words ("touching", "very close"); the option texts must
  // contain those exact words, not raw metres JEV would have to bucket itself.
  const bands = SW.WORD_BOUNDS.distance.bands;
  let lo = 0;
  for (const band of bands) {
    const hi = band.max;
    const samples = Number.isFinite(hi) ? [lo, (lo + hi) / 2, hi - 1e-6, hi - 1e-12] : [lo, lo * 2.5];
    for (const v of samples) {
      const t = S.describeCandidate({ clearance: v, nearestKind: "wall" });
      const want = SW.distanceWord(v);
      assert.equal(want, band.word, `sample ${v} sits in ${band.word}`);
      if (want === "clear") {
        assert.match(t, /^open space around the camera \(nearest wall [\d.]+ m\)$/, `${v} → ${t}`);
      } else {
        assert.ok(t.startsWith(`nearest wall ${want} (`), `${v} m → "${t}" names the band word "${want}"`);
      }
      const m = Number(/([\d.]+) m\)$/.exec(t)[1]);
      assert.equal(SW.distanceWord(m), want, `${v} m: the metre detail ${m} stays inside "${want}"`);
      assert.ok(m <= v + 1e-9, `${v} m: truncated, never rounded up (${m})`);
    }
    lo = hi;
  }
});

check("S11 rankCandidates: ok first, then cost, ties by input order; errors", () => {
  const poses = [{ meta: { id: "c1" } }, { meta: { id: "c2" } }, {}, { meta: { id: "c4" } }];
  const metrics = [
    cleanMetrics({ visibleFrac: 0.3 }),             // hard
    cleanMetrics({ clearance: 1.5 }),               // ok, mild
    cleanMetrics(),                                 // ok, best
    cleanMetrics(),                                 // ok, tie with index 2
  ];
  const ranked = S.rankCandidates(poses, metrics, { framing: "MS", light: "back" });
  assert.deepEqual(ranked.map((r) => r.id), ["c3", "c4", "c2", "c1"]);
  assert.equal(ranked[0].index, 2);
  assert.equal(ranked[3].ok, false);
  assert.ok(ranked.every((r) => typeof r.words === "string" && Array.isArray(r.reasons) && Number.isFinite(r.cost)));
  assert.deepEqual(S.rankCandidates([], [], {}), []);
  assert.throws(() => S.rankCandidates([{}], [], {}), (e) => e instanceof FilmShotError && e.code === "BAD_ARGUMENT");
  assert.throws(() => S.rankCandidates(null, [], {}), FilmShotError);
});

// ---------------------------------------------------------------------------
// S12 end to end
// ---------------------------------------------------------------------------
check("S12 generate → measure → rank: the occluded side loses, words match the winner", () => {
  const intent = { framing: "FS", side: "left", view: "any", minClearance: 1, maxOcclusion: 0.2 };
  const cands = S.generateCandidates(intent, SUBJ, CTX, { seed: 33, count: 12 });
  // A wall runs north-south 0.9 m east of the subject: cameras east of it see nothing.
  const WALL_X = SUBJ.pos[0] + 0.9;
  const measure = (p) => {
    const east = p.pos[0] > WALL_X;
    return east
      ? { visibleFrac: 0, occluderKind: "wall", clearance: Math.max(0, p.pos[0] - WALL_X), nearestKind: "wall" }
      : { visibleFrac: 1, clearance: Math.max(1.2, WALL_X - p.pos[0] + 1), nearestKind: "wall" };
  };
  const metrics = cands.map((p) => S.candidateMetrics(p, SUBJ, CTX, measure(p), intent));
  const ranked = S.rankCandidates(cands, metrics, intent);
  assert.ok(cands.some((p) => p.pos[0] > WALL_X), "some candidates behind the wall");
  assert.ok(cands.some((p) => p.pos[0] <= WALL_X), "some candidates in front of it");
  const best = ranked[0];
  assert.equal(best.ok, true);
  assert.ok(best.pose.pos[0] <= WALL_X, "the winner sees the subject");
  assert.ok(best.words.startsWith(`clear view, nearest wall ${SW.distanceWord(best.metrics.clearance)} (`), best.words);
  assert.match(best.words, /^clear view, nearest wall (very close|close|near|medium|far) \([\d.]+ m\), subject on left third/);
  for (const r of ranked.filter((x) => x.pose.pos[0] > WALL_X)) {
    assert.equal(r.ok, false);
    assert.match(r.words, /subject fully hidden by wall/);
  }
  const jevOptions = ranked.map((r) => ({ id: r.id, words: r.words }));
  assert.equal(new Set(jevOptions.map((o) => o.id)).size, jevOptions.length, "unique option ids");
  assert.doesNotThrow(() => JSON.stringify(ranked), "JSON-safe");
});

console.log(`film_scene_solver: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
