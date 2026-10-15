// tests/film_shots_drone.test.mjs
//
// WHY: the director (a Claude Code session) writes aerial shots as technique
// ids + params — `{technique:'drone.pass-over', duration:12}` — and relies on
// every SPEC §2.12 drone.* / fpv.* technique to honour its duration, stay
// continuous and NaN-free, keep its subject in frame, stay above the terrain
// (and inside dungeon floors/ceilings), and move smoothly where naive cameras
// break: straight down (a drone pass-over must slew, never flip) and through
// 90° corridor turns. This suite EXECUTES scene3d/film/shots/drone.js through
// the real registry (shots/index.js) and proves:
//   D1  catalog: exactly the SPEC ids, families, documented params, declared
//       bounds, JSON-safe, registered;
//   D2  every technique with defaults (and an odd duration) validates at
//       30 fps, honours the duration, is pure in t, deterministic, NaN-free;
//   D3  subject coverage ≥ 95 % for every subject-aiming technique;
//   D4  ground clearance ≥ groundZ + 0.7 m on a sloped, bumpy synthetic
//       terrain (and indoor floor/ceiling bounds);
//   D5  drone.pass-over: |Δh| ≤ maxYawRate·dt every frame through nadir,
//       pitch reaches ≤ −88°, no heading flips (a stateless look-at DOES
//       flip), three.js r184 projection/up-vector cross-check;
//   D6  fpv.fpv-corridor on L- and Z-shaped routes: inside a 1 m tube around
//       the filleted route, heading turns smoothly through each 90° turn,
//       banks into the turn;
//   D7  fpv.fpv-flip: full 360° rotation, sign-continuous quaternions
//       (qEnsureContinuity), about the requested body axis;
//   D8  per-technique geometry (orbit radius, helix/spiral ranges, dronie,
//       boom, reveals, top-down family, chase/lead/side on a moving subject,
//       parallax, terrain-skim AGL, canyon banking, boomerang, fly-by,
//       pano, hyperlapse meta in game-days/s (timeRate sky-seconds ÷ the
//       client's AC_DAY_LENGTH_S) driven through the real film clock: a
//       small, uniform, monotone sky step per frame, vertigo constant size,
//       flythrough/fpv-gap through the gap, fpv-dive, fpv-proximity);
//   D9  readable errors for missing context / bad params; degenerate inputs;
//   D10 every speed-profiled technique (flythrough, terrain-skim, canyon-run, fpv
//       dive / proximity / gap / corridor / run) reports meta.lengthM, overspeed AND
//       peakSpeed (≈ the measured peak) — the take player's flight check reads them.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its pure shot modules.
// Run from apps/holtburger-web/: node tests/film_shots_drone.test.mjs

import assert from "node:assert/strict";

const SH = await import("../scene3d/film/shots/index.js");
const DR = await import("../scene3d/film/shots/drone.js");
const TR = await import("../scene3d/film/shots/trajectory.js");
const FR = await import("../scene3d/film/shots/framing.js");
const G = await import("../scene3d/film/core/gimbal.js");
const Q = await import("../scene3d/film/core/quat.js");
const SP = await import("../scene3d/film/core/spline.js");
const { FilmShotError } = await import("../scene3d/film/core/errors.js");
const SKY = await import("../scene3d/sky_game_date.js");
const CK = await import("../scene3d/film/runtime/film_clock.js");
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
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err && err.message ? err.message : err}`);
  }
}

const PI = Math.PI;
const DEG = PI / 180;
const FPS = 30;

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? "value"}: ${a} vs ${b} (eps ${eps})`);
}
function shotErr(code, re) {
  return (e) => {
    assert.ok(e instanceof FilmShotError, `expected FilmShotError, got ${e && e.name}: ${e && e.message}`);
    assert.equal(e.code, code, `code (message: ${e.message})`);
    if (re) assert.match(e.message, re);
    return true;
  };
}
const hdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Pose samples on the 30 fps frame grid. */
function frames(traj, fps = FPS) {
  return TR.frameTimes(traj.duration, fps).map((t) => traj.sample(t));
}
function segDist(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  let t = L2 > 0 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}
function polyDist(p, poly) {
  let d = Infinity;
  for (let i = 1; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i - 1], poly[i]));
  return d;
}
function issuesText(v) {
  return v.issues.slice(0, 4).map((i) => i.message).join(" | ");
}

// ---------------------------------------------------------------------------
// synthetic world: a sloped, bumpy hillside, a subject standing on it, a gentle
// valley path, dungeon routes
// ---------------------------------------------------------------------------
const X0 = 30016, Y0 = 32128;
/** ≈ 7.6° slope rising to the east-north-east plus ±0.8 m bumps. */
const ground = (x, y) => 50 + 0.12 * (x - X0) + 0.06 * (y - Y0) + 0.8 * Math.sin(x / 23) * Math.cos(y / 31);
const SUBJECT = Object.freeze({ pos: [X0, Y0, ground(X0, Y0)], height: 1.8, radius: 0.5, heading: 0.4 });
const VALLEY = [];
for (let i = 0; i <= 8; i++) {
  const x = X0 - 160 + i * 40, y = Y0 + 25 * Math.sin(i * 0.9);
  VALLEY.push([x, y, ground(x, y) - 3]);
}
const ROUTE_L = [[100, 200, 1.6], [120, 200, 1.6], [120, 215, 1.6]];
const ROUTE_Z = [[100, 200, 1.6], [115, 200, 1.6], [115, 212, 1.6], [130, 212, 1.6]];
const INDOOR = (route) => ({ route, floor: () => 0, ceiling: () => 3.4 });

const SPEC_DRONE = ["flyover", "flythrough", "orbit-poi", "helix", "dronie", "boom-rise", "rising-reveal", "tilt-reveal",
  "top-down", "top-down-rise", "top-down-track", "pass-over", "parallax-slide", "terrain-skim", "canyon-run", "chase",
  "lead", "side-track", "boomerang", "fly-by", "spiral-descent", "pano-360", "hyperlapse-orbit", "vertigo-drone"].map((n) => `drone.${n}`);
const SPEC_FPV = ["fpv-dive", "fpv-proximity", "fpv-gap", "fpv-flip", "fpv-corridor", "fpv-run"].map((n) => `fpv.${n}`);
const ALL = [...SH.DRONE_TECHNIQUES, ...SH.FPV_TECHNIQUES];

/** Techniques that aim the camera at the subject the whole shot (SPEC: keep it in frame ≥ 95 %). */
const AIMING = new Set(["drone.orbit-poi", "drone.helix", "drone.dronie", "drone.boom-rise", "drone.top-down",
  "drone.top-down-rise", "drone.top-down-track", "drone.pass-over", "drone.parallax-slide", "drone.chase", "drone.lead",
  "drone.side-track", "drone.boomerang", "drone.fly-by", "drone.spiral-descent", "drone.hyperlapse-orbit", "drone.vertigo-drone"]);

/** A context that satisfies the technique's needs on the synthetic hillside. */
function ctxFor(def, extra = {}) {
  if (def.id === "fpv.fpv-corridor") return { indoor: INDOOR(ROUTE_L), anchor: [100, 200, 0], ...extra };
  const c = { subject: SUBJECT, groundZ: ground, aspect: 16 / 9, fps: FPS };
  // fpv.fpv-run flies a racing line (ctx.path or ctx.indoor.route; needs.path is false so a route alone works)
  if (def.needs.path || def.id === "fpv.fpv-run") c.path = VALLEY;
  return { ...c, ...extra };
}
const isOutdoor = (def) => def.id !== "fpv.fpv-corridor";

// ---------------------------------------------------------------------------
console.log("D1 catalog");
// ---------------------------------------------------------------------------
check("DRONE_TECHNIQUES / FPV_TECHNIQUES are exactly the SPEC §2.12 ids, in order, with matching families", () => {
  assert.deepEqual(DR.DRONE_TECHNIQUES.map((d) => d.id), SPEC_DRONE);
  assert.deepEqual(DR.FPV_TECHNIQUES.map((d) => d.id), SPEC_FPV);
  for (const d of DR.DRONE_TECHNIQUES) assert.equal(d.family, "drone");
  for (const d of DR.FPV_TECHNIQUES) assert.equal(d.family, "fpv");
  assert.equal(SH.DRONE_TECHNIQUES, DR.DRONE_TECHNIQUES, "index re-exports the same arrays");
  for (const id of [...SPEC_DRONE, ...SPEC_FPV]) assert.ok(SH.getTechnique(id), `${id} registered`);
  assert.deepEqual(SH.listTechniques({ family: "drone" }).map((e) => e.id), SPEC_DRONE);
  assert.deepEqual(SH.listTechniques({ family: "fpv" }).map((e) => e.id), SPEC_FPV);
});

check("every def documents its params, declares non-default sensible bounds, a duration, and a JSON-safe catalog entry", () => {
  for (const d of ALL) {
    assert.ok(d.description.length > 60 && d.whenToUse.length > 30, `${d.id} documented`);
    const names = Object.keys(d.params);
    assert.ok(names.length >= 3, `${d.id} has params`);
    for (const n of names) {
      assert.ok(d.params[n].desc.length >= 10, `${d.id}.${n} desc`);
      assert.notEqual(d.params[n].default, undefined, `${d.id}.${n} has a default (defaults must build)`);
    }
    const b = d.defaultBounds;
    assert.notDeepEqual({ ...b }, { ...TR.DEFAULT_BOUNDS }, `${d.id} declares its own bounds`);
    assert.ok(b.maxLateral > 0 && b.maxLateral <= 3 && b.maxRise > 0 && b.maxRise <= 6 && b.maxSink > 0 && b.maxSink <= 2, `${d.id} bounds sane`);
    assert.ok(b.minSpeedScale > 0 && b.minSpeedScale < 1 && b.maxSpeedScale >= 1 && b.maxSpeedScale <= 1.5, `${d.id} speed bounds`);
    assert.ok(d.defaultDuration > 0, `${d.id} defaultDuration`);
  }
  const cat = SH.listTechniques({ family: ["drone", "fpv"] });
  assert.equal(cat.length, 30);
  assert.deepEqual(JSON.parse(JSON.stringify(cat)), cat);
  for (const id of ["drone.chase", "drone.lead", "drone.side-track", "drone.top-down-track"]) assert.equal(SH.getTechnique(id).capture, "realtime");
  for (const id of ["drone.rising-reveal", "drone.tilt-reveal"]) assert.equal(SH.getTechnique(id).reveal, true);
  // fpv bounds are tighter than aerial drone bounds; the corridor tightest
  assert.ok(SH.getTechnique("fpv.fpv-corridor").defaultBounds.maxLateral < SH.getTechnique("drone.orbit-poi").defaultBounds.maxLateral);
});

// ---------------------------------------------------------------------------
console.log("D2 every technique: validates at 30 fps, honours duration, pure, deterministic");
// ---------------------------------------------------------------------------
for (const def of ALL) {
  check(`${def.id}: defaults + 7.3 s validate, duration honoured, pure in t, deterministic`, () => {
    for (const duration of [undefined, 7.3]) {
      const spec = duration === undefined ? { technique: def.id } : { technique: def.id, duration };
      const tr = SH.buildShot(spec, ctxFor(def));
      const D = duration === undefined ? def.defaultDuration : duration;
      assert.equal(tr.duration, D, "duration");
      assert.equal(tr.technique, def.id);
      assert.equal(tr.family, def.family);
      assert.equal(tr.sample(D).t, D);
      assert.deepEqual(tr.sample(D + 3).pos, tr.sample(D).pos, "t clamps at the end");
      assert.deepEqual(tr.sample(-1).pos, tr.sample(0).pos, "t clamps at 0");
      const v = TR.validateTrajectory(tr, { fps: FPS });
      assert.ok(v.ok, `validate (D=${D}): ${issuesText(v)}`);
      assert.ok(["cinema", "fpv", "indoor"].includes(tr.meta.flightPreset), "meta.flightPreset");
      // purity: random-access sampling returns identical poses regardless of order
      const ts = [0.37 * D, 0.91 * D, 0.12 * D, 0.37 * D];
      const a = ts.map((t) => tr.sample(t));
      assert.deepEqual(a[0], a[3], "sample(t) is pure");
      // determinism: an identical spec builds an identical baked table
      const tr2 = SH.buildShot(spec, ctxFor(def));
      assert.equal(TR.bakeTrajectory(tr, FPS).checksum, TR.bakeTrajectory(tr2, FPS).checksum, "deterministic");
    }
  });
}

// ---------------------------------------------------------------------------
console.log("D3 subject in frame / D4 ground clearance");
// ---------------------------------------------------------------------------
for (const def of ALL) {
  if (AIMING.has(def.id)) {
    check(`${def.id}: subject in frame ≥ 95 % of 30 fps samples`, () => {
      const tr = SH.buildShot({ technique: def.id }, ctxFor(def));
      const cov = TR.subjectCoverage(tr, { framing: tr.meta.spec.framing, fps: FPS, aspect: 16 / 9 });
      assert.ok(cov.fraction >= 0.95, `coverage ${cov.fraction.toFixed(3)} (first miss t=${cov.firstMiss})`);
    });
  }
  if (isOutdoor(def)) {
    check(`${def.id}: ≥ 0.7 m above a sloped, bumpy groundZ at every frame (defaults and 5 s)`, () => {
      for (const duration of [undefined, 5]) {
        const tr = SH.buildShot(duration ? { technique: def.id, duration } : { technique: def.id }, ctxFor(def));
        for (const p of frames(tr)) {
          const g = ground(p.pos[0], p.pos[1]);
          assert.ok(p.pos[2] >= g + 0.7 - 1e-9, `t=${p.t.toFixed(3)} clearance ${(p.pos[2] - g).toFixed(3)} m`);
        }
      }
    });
  }
}

check("indoor context: drone moves stay between ctx.indoor.floor and ceiling; flight preset 'indoor'", () => {
  for (const id of ["drone.orbit-poi", "drone.helix", "drone.boom-rise", "drone.top-down", "drone.chase", "drone.fly-by"]) {
    const ctx = { subject: { pos: [50, 50, 0], height: 1.8, radius: 0.4 }, indoor: { floor: () => 0, ceiling: () => 6 } };
    const tr = SH.buildShot({ technique: id }, ctx);
    for (const p of frames(tr)) assert.ok(p.pos[2] >= 0.5 - 1e-9 && p.pos[2] <= 6 - 0.3 + 1e-9, `${id} z=${p.pos[2]}`);
    assert.equal(tr.meta.flightPreset, "indoor", id);
    assert.ok(TR.validateTrajectory(tr).ok, id);
  }
});

// ---------------------------------------------------------------------------
console.log("D5 drone.pass-over: the gimbal tracks through −90° without flipping");
// ---------------------------------------------------------------------------
const passCtx = { subject: SUBJECT, groundZ: ground };
check("yaw-slew (default): |Δh| ≤ maxYawRate·dt every frame, pitch reaches ≤ −88°, p ∈ [−90°, 90°], validates", () => {
  const tr = SH.buildShot({ technique: "drone.pass-over" }, passCtx);
  const P = tr.meta.spec.params;
  assert.equal(P.nadirMode, "yaw-slew");
  const lim = P.maxYawRateDeg * DEG / FPS;
  const fr = frames(tr);
  let minP = 0, maxDh = 0;
  for (let k = 0; k < fr.length; k++) {
    const p = fr[k];
    assert.ok(p.p >= -PI / 2 - 1e-12 && p.p <= PI / 2 + 1e-12, "pitch range");
    if (k > 0) maxDh = Math.max(maxDh, Math.abs(p.h - fr[k - 1].h));
    minP = Math.min(minP, p.p);
  }
  assert.ok(maxDh <= lim + 1e-6, `max |Δh| ${maxDh / DEG}° per frame > ${lim / DEG}°`);
  assert.ok(minP <= -88 * DEG, `pitch only reached ${minP / DEG}°`);
  // the heading really slews ≈180° (camera ends looking back at the subject)
  near(Math.abs(G.shortestAngleDiff(fr[fr.length - 1].h, fr[0].h)), PI, 15 * DEG, "heading slewed round");
  const v = TR.validateTrajectory(tr);
  assert.ok(v.ok && v.counts["heading-flip"] === 0, issuesText(v));
  const kf = tr.keyframes.find((k) => k.label === "overhead");
  assert.ok(kf && Math.abs(kf.t - tr.duration / 2) < 1e-6, "overhead keyframe at mid-shot");
});

check("the same pass with a stateless look-at flips (heading-flip), the pass-over technique does not", () => {
  const tr = SH.buildShot({ technique: "drone.pass-over" }, passCtx);
  const naive = TR.makeTrajectory({
    duration: tr.duration,
    positionAt: (t) => tr.sample(t).pos,
    orientAt: TR.orientLookAt(TR.aimSubject({ subject: SUBJECT }, "WS")),
  });
  assert.ok(TR.validateTrajectory(naive).counts["heading-flip"] > 0, "stateless look-at flips at nadir");
  assert.equal(TR.validateTrajectory(tr).counts["heading-flip"], 0);
});

check("hold and pitch-through nadir modes validate; subject stays in frame; slower slew limit honoured", () => {
  for (const nadirMode of ["hold", "pitch-through"]) {
    const tr = SH.buildShot({ technique: "drone.pass-over", params: { nadirMode } }, passCtx);
    const v = TR.validateTrajectory(tr);
    assert.ok(v.ok, `${nadirMode}: ${issuesText(v)}`);
    assert.ok(TR.subjectCoverage(tr, { framing: "WS" }).fraction >= 0.95, nadirMode);
  }
  const slow = SH.buildShot({ technique: "drone.pass-over", params: { maxYawRateDeg: 45 } }, passCtx);
  const fr = frames(slow);
  for (let k = 1; k < fr.length; k++) assert.ok(Math.abs(fr[k].h - fr[k - 1].h) <= 45 * DEG / FPS + 1e-6);
});

check("three.js r184 cross-check: projection matches projectToNdc and the camera up vector never jumps through nadir", () => {
  const tr = SH.buildShot({ technique: "drone.pass-over" }, passCtx);
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const aim = FR.aimPointForFraming("WS", SUBJECT);
  const aimThree = new THREE.Vector3(...G.acToThreePos(aim));
  let prevUp = null;
  const maxStep = (tr.meta.spec.params.maxYawRateDeg + tr.meta.spec.params.maxPitchRateDeg) * DEG / FPS;
  for (const p of frames(tr)) {
    cam.position.set(...G.acToThreePos(p.pos));
    cam.quaternion.set(...G.acQuatToThree(p.q));
    cam.fov = p.fov;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    const ndc = aimThree.clone().project(cam);
    const mine = FR.projectToNdc(p, aim, p.fov, 16 / 9);
    near(ndc.x, mine.x, 1e-6, "ndc.x");
    near(ndc.y, mine.y, 1e-6, "ndc.y");
    assert.ok(Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1, `subject on screen at t=${p.t}`);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    if (prevUp) assert.ok(up.angleTo(prevUp) <= maxStep + 1e-6, `three up vector jumped ${up.angleTo(prevUp) / DEG}° at t=${p.t}`);
    prevUp = up;
  }
});

// ---------------------------------------------------------------------------
console.log("D6 fpv.fpv-corridor through 90° turns");
// ---------------------------------------------------------------------------
for (const [name, route, turns] of [["L", ROUTE_L, [-1]], ["Z", ROUTE_Z, [-1, 1]]]) {
  check(`${name}-route: inside a 1 m tube around the filleted route, smooth heading through each 90° turn, banks into it`, () => {
    const tr = SH.buildShot({ technique: "fpv.fpv-corridor", duration: 9 }, { indoor: INDOOR(route), anchor: route[0] });
    const r = tr.meta.spec.params.cornerRadius;
    const fil = SP.filletPolyline(route, r);
    const fr = frames(tr);
    let maxTube = 0;
    for (const p of fr) maxTube = Math.max(maxTube, polyDist(p.pos, fil));
    assert.ok(maxTube <= 1.0, `left the 1 m tube: ${maxTube.toFixed(3)} m`);
    assert.ok(maxTube <= 0.25, `tube deviation ${maxTube.toFixed(3)} m (curvature smoothing should stay well inside)`);
    // heading: continuous, bounded rate, bounded rate change; net turn = sum of the route's turns
    const hs = fr.map((p) => p.h);
    const d1 = hs.slice(1).map((h, i) => h - hs[i]);
    const d2 = d1.slice(1).map((x, i) => x - d1[i]);
    assert.ok(Math.max(...d1.map(Math.abs)) <= 6 * DEG, `max heading step ${Math.max(...d1.map(Math.abs)) / DEG}°/frame`);
    assert.ok(Math.max(...d2.map(Math.abs)) <= 1.0 * DEG, `heading rate jumps ${Math.max(...d2.map(Math.abs)) / DEG}°/frame²`);
    near(hs[0], 90 * DEG, 1e-6, "starts heading east");
    const net = turns.reduce((a, s) => a + s * 90 * DEG, 0);
    near(hs[hs.length - 1] - hs[0], net, 2 * DEG, "net heading change");
    // each turn is monotone (no wobble): split frames by turn sign of Δh
    for (const sgn of turns) {
      const steps = d1.filter((x) => Math.sign(x) === sgn && Math.abs(x) > 1e-4);
      near(steps.reduce((a, b) => a + b, 0), sgn * 90 * DEG, 2 * DEG, `turn ${sgn > 0 ? "right" : "left"} sums to 90°`);
    }
    // bank into the turn: left turns roll < 0, right turns roll > 0; roll continuous
    for (const sgn of turns) {
      const banks = fr.filter((p, i) => i > 0 && Math.sign(d1[i - 1]) === sgn && Math.abs(d1[i - 1]) > 1 * DEG).map((p) => p.r);
      assert.ok(banks.length > 3 && banks.every((b) => Math.sign(b) === sgn), `bank sign for ${sgn > 0 ? "right" : "left"} turn`);
    }
    const rs = fr.map((p) => p.r);
    for (let i = 1; i < rs.length; i++) assert.ok(Math.abs(rs[i] - rs[i - 1]) <= 3 * DEG, `roll step ${(rs[i] - rs[i - 1]) / DEG}°`);
    for (const p of fr) assert.ok(p.pos[2] >= 0.5 - 1e-9 && p.pos[2] <= 3.1 + 1e-9, "inside floor/ceiling");
    assert.ok(TR.validateTrajectory(tr).ok);
    assert.equal(tr.meta.flightPreset, "fpv");
  });
}

check("fpv-corridor slows into the turns (curvature-limited profile) and uses ctx.path outside dungeons", () => {
  const tr = SH.buildShot({ technique: "fpv.fpv-corridor", duration: 9 }, { indoor: INDOOR(ROUTE_L), anchor: ROUTE_L[0] });
  const fr = frames(tr);
  const speeds = fr.slice(1).map((p, i) => dist3(p.pos, fr[i].pos) * FPS);
  const turnIdx = fr.findIndex((p) => hdist(p.pos, [120, 200]) < 1.5);
  assert.ok(turnIdx > 0, "passes the corner");
  assert.ok(speeds[turnIdx] < 0.6 * Math.max(...speeds), `turn speed ${speeds[turnIdx].toFixed(2)} vs peak ${Math.max(...speeds).toFixed(2)}`);
  const out = SH.buildShot({ technique: "fpv.fpv-corridor", duration: 6 }, { path: ROUTE_Z });
  assert.ok(TR.validateTrajectory(out).ok);
  assert.ok(polyDist(out.sample(3).pos, SP.filletPolyline(ROUTE_Z, 1.5)) < 0.25);
});

// ---------------------------------------------------------------------------
console.log("D7 fpv.fpv-flip");
// ---------------------------------------------------------------------------
for (const axis of ["roll", "pitch"]) {
  check(`${axis} flip: one full 360° rotation, sign-continuous quaternions, about the ${axis} axis, validates`, () => {
    const tr = SH.buildShot({ technique: "fpv.fpv-flip", params: { axis } }, { subject: SUBJECT, groundZ: ground });
    const { start, end } = tr.meta.flip;
    let prev = null, total = 0;
    const N = 2400;
    for (let k = 0; k <= N; k++) {
      let q = tr.sample((tr.duration * k) / N).q;
      if (prev) {
        q = Q.qEnsureContinuity(prev, q);
        assert.ok(Q.qDot(prev, q) > 0.99, "consecutive quaternions continuous");
        total += Q.qAngle(prev, q);
      }
      prev = q;
    }
    near(total, 2 * PI, 0.5 * DEG, "accumulated rotation");
    // relative rotation base⁻¹·q is about the local axis; quarter way through the flip it is 90°
    const base = tr.sample(0).q;
    const mid = tr.sample(start + (end - start) / 2).q;
    const rel = Q.qMul(Q.qConj(base), mid);
    const axisV = Q.qLog(rel);
    const ax = axis === "roll" ? [0, 1, 0] : [1, 0, 0];
    const l = Math.hypot(...axisV);
    assert.ok(l > 0.1, "rotated at mid flip");
    near(Math.abs((axisV[0] * ax[0] + axisV[1] * ax[1] + axisV[2] * ax[2]) / l), 1, 1e-6, "rotation axis");
    near(Q.qAngle(base, mid), PI, 1e-6, "half way = 180°");
    assert.ok(Q.qAngle(tr.sample(0).q, tr.sample(tr.duration).q) < 1e-9, "ends in the base orientation");
    const v = TR.validateTrajectory(tr);
    assert.ok(v.ok, issuesText(v));
    assert.ok(v.stats.maxAngularSpeedDeg <= 240, "default flip readable at 30 fps");
  });
}

check("a fast 0.6 s triple flip still completes 1080° continuously (validated with an FPV angular limit)", () => {
  const tr = SH.buildShot({ technique: "fpv.fpv-flip", duration: 4, params: { flipDuration: 0.6, turns: 3, direction: "negative" } }, { subject: SUBJECT, groundZ: ground });
  let prev = null, total = 0;
  for (let k = 0; k <= 8000; k++) {
    let q = tr.sample((4 * k) / 8000).q;
    if (prev) {
      q = Q.qEnsureContinuity(prev, q);
      total += Q.qAngle(prev, q);
    }
    prev = q;
  }
  near(total, 6 * PI, 1 * DEG, "1080°");
  assert.ok(TR.validateTrajectory(tr, { fps: 120, maxAngularSpeedDeg: 3600 }).ok);
});

// ---------------------------------------------------------------------------
console.log("D8 per-technique geometry");
// ---------------------------------------------------------------------------
const C = SUBJECT.pos;
const base = { subject: SUBJECT, groundZ: ground };
const flat = { subject: { pos: [X0, Y0, 50], height: 1.8, radius: 0.5, heading: 0.4 }, groundZ: () => 50 };

check("orbit-poi: constant radius, swept angle = revolutions·360°, looks at the subject, ≥ heightAGL", () => {
  const tr = SH.buildShot({ technique: "drone.orbit-poi", params: { radius: 25, revolutions: 0.5, heightAGL: 12, direction: "ccw" } }, base);
  const fr = frames(tr);
  for (const p of fr) {
    near(hdist(p.pos, C), 25, 1e-9, "radius");
    assert.ok(p.pos[2] >= C[2] + 12 - 1e-9);
  }
  const b0 = Math.atan2(fr[0].pos[0] - C[0], fr[0].pos[1] - C[1]);
  const b1 = Math.atan2(fr[fr.length - 1].pos[0] - C[0], fr[fr.length - 1].pos[1] - C[1]);
  near(Math.abs(G.shortestAngleDiff(b1, b0)), PI, 1e-6, "half orbit");
  near(b0, SUBJECT.heading, 1e-9, "starts in front of the subject (bearing 0 relative)");
  assert.ok(G.shortestAngleDiff(Math.atan2(fr[3].pos[0] - C[0], fr[3].pos[1] - C[1]), b0) < 0, "ccw = bearing decreasing");
});

check("helix / spiral-descent: radius and height move between their ranges monotonically", () => {
  const h = frames(SH.buildShot({ technique: "drone.helix" }, flat));
  const s = frames(SH.buildShot({ technique: "drone.spiral-descent" }, flat));
  const c = flat.subject.pos;
  near(hdist(h[0].pos, c), 15, 1e-6); near(hdist(h[h.length - 1].pos, c), 30, 1e-6);
  near(h[0].pos[2], 50 + 4, 0.35); near(h[h.length - 1].pos[2], 50 + 40, 1e-6);
  near(hdist(s[0].pos, c), 40, 1e-6); near(hdist(s[s.length - 1].pos, c), 12, 1e-6);
  for (let i = 1; i < h.length; i++) assert.ok(h[i].pos[2] >= h[i - 1].pos[2] - 1e-9 && s[i].pos[2] <= s[i - 1].pos[2] + 1e-9);
});

check("dronie: starts at framing distance (≥ 2.5 m), flies back + up in one line keeping the subject centred", () => {
  const tr = SH.buildShot({ technique: "drone.dronie" }, flat);
  const fr = frames(tr);
  const c = flat.subject.pos;
  near(hdist(fr[0].pos, c), 2.5, 1e-6, "auto start distance");
  near(hdist(fr[fr.length - 1].pos, c), 60, 1e-6);
  for (let i = 1; i < fr.length; i++) assert.ok(hdist(fr[i].pos, c) >= hdist(fr[i - 1].pos, c) - 1e-9 && fr[i].pos[2] >= fr[i - 1].pos[2] - 1e-9);
  for (const p of fr) {
    const m = FR.compositionMetrics(p, flat.subject, p.fov, 16 / 9, { framing: "FS" });
    assert.ok(m.centerError < 1e-6, "centred");
  }
});

check("boom-rise: fixed xy, monotone rise, keepAim tilts down; keepAim=false holds tiltDeg", () => {
  const fr = frames(SH.buildShot({ technique: "drone.boom-rise" }, flat));
  for (const p of fr) { near(p.pos[0], fr[0].pos[0], 1e-9); near(p.pos[1], fr[0].pos[1], 1e-9); }
  for (let i = 1; i < fr.length; i++) assert.ok(fr[i].pos[2] >= fr[i - 1].pos[2] - 1e-9 && fr[i].p <= fr[i - 1].p + 1e-9);
  const lv = frames(SH.buildShot({ technique: "drone.boom-rise", params: { keepAim: false, tiltDeg: -5 } }, flat));
  for (const p of lv) near(p.p, -5 * DEG, 1e-9);
});

check("rising-reveal: starts looking up at the obstacle, ends above it + clearance pitched near the horizon", () => {
  const tr = SH.buildShot({ technique: "drone.rising-reveal" }, flat);
  const fr = frames(tr);
  const P = tr.meta.spec.params;
  assert.ok(fr[0].p > 0, "looks up at the obstacle face");
  near(fr[fr.length - 1].pos[2], 50 + P.obstacleHeight + P.clearance, 1e-6, "end height");
  near(fr[fr.length - 1].p, P.endPitchDeg * DEG, 1e-9, "end pitch");
  for (let i = 1; i < fr.length; i++) assert.ok(fr[i].p <= fr[i - 1].p + 1e-9, "pitch tilts monotonically");
});

check("tilt-reveal: pitch −80° → −10° monotone with a 4 m forward drift at constant height", () => {
  const fr = frames(SH.buildShot({ technique: "drone.tilt-reveal" }, flat));
  near(fr[0].p, -80 * DEG, 1e-9); near(fr[fr.length - 1].p, -10 * DEG, 1e-9);
  for (let i = 1; i < fr.length; i++) assert.ok(fr[i].p >= fr[i - 1].p - 1e-12);
  near(hdist(fr[0].pos, fr[fr.length - 1].pos), 4, 1e-6);
  for (const p of fr) near(p.pos[2], 70, 1e-6);
});

check("top-down: exact nadir, image rotation = rotateDeg, subject centred; off-nadir pitch keeps it centred", () => {
  for (const pitchDeg of [-90, -84]) {
    const tr = SH.buildShot({ technique: "drone.top-down", params: { rotateDeg: 120, pitchDeg } }, flat);
    const fr = frames(tr);
    for (const p of fr) {
      near(p.p, pitchDeg * DEG, 1e-9);
      const m = FR.compositionMetrics(p, flat.subject, p.fov, 16 / 9, { framing: "WS" });
      assert.ok(m.centerError < 1e-6, `centred (pitch ${pitchDeg})`);
    }
    near(fr[fr.length - 1].h - fr[0].h, 120 * DEG, 1e-9, "rotation");
    assert.ok(TR.validateTrajectory(tr).ok);
  }
});

check("top-down-rise: nadir climb from ≥ subject top + 1.5 m to heightEnd, subject centred", () => {
  const fr = frames(SH.buildShot({ technique: "drone.top-down-rise" }, flat));
  assert.ok(fr[0].pos[2] >= 50 + 1.8 + 1.5 - 1e-9);
  near(fr[fr.length - 1].pos[2], 130, 1e-6);
  for (let i = 1; i < fr.length; i++) assert.ok(fr[i].pos[2] >= fr[i - 1].pos[2] - 1e-9);
  for (const p of fr) { near(p.p, -PI / 2, 1e-12); near(hdist(p.pos, flat.subject.pos), 0, 1e-9); }
});

// moving subject: walks east at 3 m/s, curving north after 4 s
const walker = (t) => {
  const tt = Math.max(0, t);
  const x = X0 + 3 * Math.min(tt, 4) + (tt > 4 ? 12 * Math.sin((tt - 4) / 4) : 0);
  const y = Y0 + (tt > 4 ? 12 * (1 - Math.cos((tt - 4) / 4)) : 0);
  return { pos: [x, y, ground(x, y)], height: 1.8, radius: 0.5 };
};
const movingCtx = { subjectAt: walker, groundZ: ground };

check("chase / lead / side-track on a moving subject: placement relative to travel, distance, coverage, clearance", () => {
  for (const [id, want] of [["drone.chase", "behind"], ["drone.lead", "ahead"], ["drone.side-track", "right"]]) {
    const tr = SH.buildShot({ technique: id, duration: 9 }, movingCtx);
    assert.ok(tr.meta.moving, `${id} sees motion`);
    assert.ok(TR.subjectCoverage(tr, { framing: "FS" }).fraction >= 0.95, `${id} coverage`);
    for (const t of [1, 2, 3]) {
      const p = tr.sample(t).pos, s = walker(t).pos;
      const rel = [p[0] - s[0], p[1] - s[1]];
      near(Math.hypot(...rel), 8, 0.5, `${id} distance`);
      if (want === "behind") assert.ok(rel[0] < -7, `${id} behind (east travel)`);
      if (want === "ahead") assert.ok(rel[0] > 7, `${id} ahead`);
      if (want === "right") assert.ok(rel[1] < -7, `${id} on the right (south of an eastbound subject)`);
    }
    for (const p of frames(tr)) assert.ok(p.pos[2] >= ground(p.pos[0], p.pos[1]) + 0.7 - 1e-9);
    assert.ok(TR.validateTrajectory(tr).ok, id);
  }
});

check("top-down-track: stays over the moving subject (≤ 0.6 m), nadir, image up follows travel", () => {
  const tr = SH.buildShot({ technique: "drone.top-down-track", duration: 9 }, movingCtx);
  for (const p of frames(tr)) {
    assert.ok(hdist(p.pos, walker(p.t).pos) <= 0.6, `t=${p.t} offset ${hdist(p.pos, walker(p.t).pos)}`);
    near(p.p, -PI / 2, 1e-12);
  }
  near(tr.sample(2).h, PI / 2, 5 * DEG, "heading east while walking east");
  assert.ok(tr.sample(8.5).h < 80 * DEG, "turns north with the subject");
});

check("parallax-slide: lateral travel = slide, counter-pan = panAmount of the bearing change", () => {
  const tr = SH.buildShot({ technique: "drone.parallax-slide" }, flat);
  const fr = frames(tr);
  near(hdist(fr[0].pos, fr[fr.length - 1].pos), 12, 1e-6);
  const c = FR.aimPointForFraming("WS", flat.subject);
  for (const p of [fr[0], fr[fr.length - 1]]) {
    const la = G.lookRotation(p.pos, c, { headingHint: p.h });
    const hc = flat.subject.heading + PI;
    near(G.shortestAngleDiff(p.h, hc), 0.35 * G.shortestAngleDiff(la.h, hc), 1e-9, "pan share");
  }
  const truck = frames(SH.buildShot({ technique: "drone.parallax-slide", params: { panAmount: 0 } }, flat));
  for (const p of truck) near(p.h, truck[0].h, 1e-12);
});

check("terrain-skim: AGL within [1.5, 6] m over bumps, pitches with the slope, level heading", () => {
  const tr = SH.buildShot({ technique: "drone.terrain-skim", params: { headingDeg: 90, relativeToSubject: false } }, base);
  const fr = frames(tr);
  let pitchSum = 0;
  for (const p of fr) {
    const agl = p.pos[2] - ground(p.pos[0], p.pos[1]);
    assert.ok(agl >= 1.5 && agl <= 6, `AGL ${agl.toFixed(2)}`);
    near(p.h, PI / 2, 1e-6, "heading east");
    pitchSum += p.p;
  }
  near(pitchSum / fr.length, Math.atan(0.12) - 4 * DEG, 2.5 * DEG, "mean pitch follows the uphill slope + tilt");
  near(dist3(fr[0].pos, fr[fr.length - 1].pos), 10 * 10, 2, "covers speed × duration");
});

check("canyon-run: follows the valley (≤ 2 m off the filleted line), stays ≥ heightAGL above it, banks with the bends", () => {
  const tr = SH.buildShot({ technique: "drone.canyon-run" }, { groundZ: ground, path: VALLEY });
  const fr = frames(tr);
  const fil = SP.filletPolyline(VALLEY.map((p) => [p[0], p[1], 0]), 15);
  for (const p of fr) assert.ok(polyDist([p.pos[0], p.pos[1], 0], fil) <= 2, "follows the valley");
  const hs = fr.map((p) => p.h);
  let agree = 0, total = 0;
  for (let i = 1; i < fr.length - 1; i++) {
    const rate = (hs[i + 1] - hs[i - 1]) * FPS / 2;
    if (Math.abs(rate) > 0.08) { total += 1; if (Math.sign(fr[i].r) === Math.sign(rate)) agree += 1; }
  }
  assert.ok(total > 10 && agree / total > 0.9, `bank sign agrees with turn direction ${agree}/${total}`);
  assert.ok(Math.max(...fr.map((p) => Math.abs(p.r))) <= 25 * DEG + 1e-9);
});

check("boomerang: in to `near` at mid-shot (zero radial speed), back out to `far` higher than it started", () => {
  const tr = SH.buildShot({ technique: "drone.boomerang" }, flat);
  const c = flat.subject.pos;
  const D = tr.duration;
  near(hdist(tr.sample(D / 2).pos, c), 8, 1e-9);
  near(hdist(tr.sample(0).pos, c), 30, 1e-9);
  near(hdist(tr.sample(D).pos, c), 30, 1e-9);
  near(tr.sample(D).pos[2] - tr.sample(0).pos[2], 8, 1e-6, "rise on the way out");
  near(hdist(tr.sample(D / 2 + 0.01).pos, c) - hdist(tr.sample(D / 2 - 0.01).pos, c), 0, 1e-3, "smooth turnaround");
  assert.ok(tr.keyframes.some((k) => k.label === "turn"));
});

check("fly-by: closest approach = offset at mid-shot with the subject centred; peak yaw rate ≈ speed/offset", () => {
  const tr = SH.buildShot({ technique: "drone.fly-by" }, flat);
  const c = flat.subject.pos;
  near(hdist(tr.sample(tr.duration / 2).pos, c), 6, 1e-9);
  const fr = frames(tr);
  let peak = 0;
  for (let i = 1; i < fr.length; i++) peak = Math.max(peak, Math.abs(fr[i].h - fr[i - 1].h) * FPS);
  near(peak, 12 / 6, 0.15, "peak yaw rate rad/s");
  const m = FR.compositionMetrics(tr.sample(tr.duration / 2), flat.subject, 60, 16 / 9, { framing: "FS" });
  assert.ok(m.centerError < 1e-6);
});

check("pano-360: hovers in place, yaws exactly 360°, level gimbal", () => {
  const fr = frames(SH.buildShot({ technique: "drone.pano-360" }, flat));
  near(fr[fr.length - 1].h - fr[0].h, 2 * PI, 1e-9);
  for (const p of fr) { near(p.p, 0, 1e-12); near(dist3(p.pos, fr[0].pos), 0, 1e-12); }
});

check("hyperlapse-orbit: meta.timeLapse = {rate: timeRate / AC_DAY_LENGTH_S, unit: 'game-days/s'} (classic's unit); orbits at the radius", () => {
  assert.equal(SKY.AC_DAY_LENGTH_S, 7620, "the client's real seconds per Dereth day");
  const tr = SH.buildShot({ technique: "drone.hyperlapse-orbit", params: { timeRate: 240 } }, flat);
  assert.deepEqual(tr.meta.timeLapse, { rate: 240 / SKY.AC_DAY_LENGTH_S, unit: "game-days/s" });
  near(hdist(tr.sample(3).pos, flat.subject.pos), 40, 1e-9);
  const def = SH.buildShot({ technique: "drone.hyperlapse-orbit" }, flat);
  assert.equal(def.meta.spec.params.timeRate, 150);
  assert.deepEqual(def.meta.timeLapse, { rate: 150 / SKY.AC_DAY_LENGTH_S, unit: "game-days/s" });
  // The unit film_clock reads and classic.time-lapse emits; the default is in classic's ballpark (0.02 game-days/s).
  const classic = SH.buildShot({ technique: "classic.time-lapse" }, flat);
  assert.equal(def.meta.timeLapse.unit, classic.meta.timeLapse.unit);
  assert.ok(def.meta.timeLapse.rate > 0.5 * classic.meta.timeLapse.rate && def.meta.timeLapse.rate < 2 * classic.meta.timeLapse.rate,
    `default ${def.meta.timeLapse.rate} vs classic ${classic.meta.timeLapse.rate} game-days/s`);
  // Every legal timeRate advances well under a tenth of a day per frame at 24 fps (far from the 0.5-day aliasing point).
  const P = DR.DRONE_TECHNIQUES.find((d) => d.id === "drone.hyperlapse-orbit").params.timeRate;
  assert.equal(P.unit, "sky-s/s");
  for (const timeRate of [P.min, P.default, P.max]) {
    const r = SH.buildShot({ technique: "drone.hyperlapse-orbit", params: { timeRate } }, flat).meta.timeLapse.rate;
    assert.ok(r > 0 && r / 24 < 0.025, `timeRate ${timeRate} → ${r} game-days/s`);
  }
});

/** A fake page for the real film clock: __renderOnce stamps frameTime and fires postRender; the sky override is recorded. */
function fakeClockPage(skyNow = 0.25) {
  let wall = 1000;
  const live = { frameTime: { tsMs: wall, tsSec: wall / 1000, dt: 0.016 } };
  const sky = [];
  const win = { performance: { now: () => wall } };
  win.__renderOnce = (ts) => {
    Promise.resolve().then(() => {
      const prev = live.frameTime.tsMs;
      live.frameTime = { tsMs: ts, tsSec: ts / 1000, dt: (ts - prev) / 1000 };
      live.film?.preFrame?.(ts, live.frameTime.dt);
      live.film?.postRender?.();
    });
    return true;
  };
  const sessionHandle = {
    setSkyTimeOverride(v) { sky.push(v); return true; },
    getSkyState() { return { timeOfDayNormalized: skyNow, free() {} }; },
  };
  return { sky, deps: { liveScene3d: live, window: win, sessionHandle, now: () => wall, sleep: async (ms) => { wall += ms; } } };
}
/** Sky advance between two normalised times, through midnight. */
const skyStep = (a, b) => ((b - a) % 1 + 1) % 1;

await checkAsync("hyperlapse-orbit meta through the real film clock: the sky advances a small, uniform, monotone step every frame (never frozen, never strobing)", async () => {
  for (const [timeRate, fps, maxStep] of [[undefined, 30, 0.01], [45, 30, 0.01], [1, 30, 0.01], [3600, 24, 0.025]]) {
    const spec = { technique: "drone.hyperlapse-orbit", ...(timeRate === undefined ? {} : { params: { timeRate } }) };
    const tr = SH.buildShot(spec, flat);
    const rate = tr.meta.timeLapse.rate;
    const page = fakeClockPage();
    const clock = CK.createFilmClock({ fps, ...page.deps });
    // take_player hands the trajectory's meta.timeLapse straight to begin(); start at dusk so the run crosses midnight.
    const b = clock.begin({ timeOfDay: "dusk", timeLapse: tr.meta.timeLapse });
    assert.equal(b.sky.rate, rate, "the clock reads the technique's rate unchanged");
    const n = timeRate === undefined ? TR.frameTimes(tr.duration, fps).length : 2 * fps;
    for (let k = 0; k < n; k++) await clock.step();
    await clock.end({ keepSky: true });
    assert.equal(page.sky.length, n);
    const label = `timeRate ${timeRate ?? "default"} @${fps}`;
    near(page.sky[0], CK.TIME_OF_DAY_PRESETS.dusk, 1e-12, `${label}: frame 0 at dusk`);
    for (let k = 1; k < n; k++) {
      const d = skyStep(page.sky[k - 1], page.sky[k]);
      assert.ok(d > 0 && d < maxStep, `${label}: frame ${k} sky step ${d}`);
      near(d, rate / fps, 1e-9, `${label}: uniform step`);
    }
    if (timeRate === undefined) {
      // the default 15 s shot spans ≈ 7 game-hours: dusk well into the night, across midnight
      const total = (n - 1) * rate / fps;
      assert.ok(total > 0.25 && total < 0.35, `default shot spans ${total} game-days`);
      near(page.sky[n - 1], (CK.TIME_OF_DAY_PRESETS.dusk + total) % 1, 1e-9, "ends past midnight");
    }
  }
  // Regression contrast: the pre-fix meta {rate: 60} (sky SECONDS read as game-DAYS) advanced exactly 2 days per frame — a frozen sky.
  const page = fakeClockPage();
  const clock = CK.createFilmClock({ fps: 30, ...page.deps });
  clock.begin({ timeOfDay: 0.25, timeLapse: { rate: 60 } });
  for (let k = 0; k < 4; k++) await clock.step();
  await clock.end({ keepSky: true });
  for (const t of page.sky) near(t, 0.25, 1e-9, "unit-mismatched rate freezes the sky");
});

check("vertigo-drone: subject size constant (dolly-zoom) while fov narrows going out / widens going in", () => {
  for (const direction of ["out", "in"]) {
    const tr = SH.buildShot({ technique: "drone.vertigo-drone", params: { direction } }, flat);
    const fr = frames(tr);
    // the dolly-zoom invariant — aim distance × tan(fov/2) — is held exactly ...
    const aim = FR.aimPointForFraming("MS", flat.subject);
    const K = fr.map((p) => dist3(p.pos, aim) * Math.tan((p.fov * DEG) / 2));
    for (const k of K) near(k, K[0], 1e-6, `${direction}: invariant`);
    // ... so an extended 1.8 m body seen from 3 m keeps its projected height within the residual
    // perspective change of its feet/head depths (< 4 %)
    const sizes = fr.map((p) => FR.compositionMetrics(p, flat.subject, p.fov, 16 / 9, { framing: "MS" }).heightFrac);
    for (const s of sizes) near(s / sizes[0], 1, 0.04, `${direction}: constant size`);
    if (direction === "out") assert.ok(fr[fr.length - 1].fov < fr[0].fov / 3, "zooms in while flying out");
    else assert.ok(fr[fr.length - 1].fov > fr[0].fov, "zooms out while pushing in");
    near(direction === "out" ? fr[0].fov : fr[fr.length - 1].fov, 60, 1e-9, "the near end uses the shot fov");
    assert.ok(TR.validateTrajectory(tr).ok);
  }
});

check("flyover: level pass at refZ + heightAGL along the heading; 'track' pitches to nadir over the subject", () => {
  const tr = SH.buildShot({ technique: "drone.flyover" }, flat);
  for (const p of frames(tr)) { near(p.pos[2], 80, 0.05); near(p.p, -35 * DEG, 1e-12); near(p.h, 0.4, 1e-12); }
  const tk = SH.buildShot({ technique: "drone.flyover", params: { gimbal: "track" } }, flat);
  assert.ok(tk.sample(tk.duration / 2 + 0.05).p <= -88 * DEG);
  assert.ok(tk.sample(0).p > -60 * DEG);
  assert.ok(TR.validateTrajectory(tk).ok);
});

check("flythrough: passes exactly through the gap centre aligned with its normal, slower at the gap", () => {
  const gp = [X0 + 5, Y0 + 2, 54];
  const n = [1, 0.2, 0];
  const tr = SH.buildShot({ technique: "drone.flythrough", params: { gapPos: gp, gapNormal: n } }, flat);
  const tg = tr.meta.gapT;
  const p = tr.sample(tg);
  assert.ok(dist3(p.pos, gp) <= 0.02, `misses the gap by ${dist3(p.pos, gp)}`);
  const f = G.forwardFromHP(p.h, p.p);
  const nn = Math.hypot(...n);
  assert.ok((f[0] * n[0] + f[1] * n[1] + f[2] * n[2]) / nn >= Math.cos(1 * DEG), "aligned with the gap normal");
  const sp = (t) => dist3(tr.sample(t + 0.01).pos, tr.sample(t - 0.01).pos) / 0.02;
  assert.ok(sp(tg) < 0.75 * sp(0.05), `speed at gap ${sp(tg).toFixed(2)} vs start ${sp(0.05).toFixed(2)}`);
  assert.deepEqual(tr.meta.gap.pos, gp);
  // ctx.gap works too
  const tr2 = SH.buildShot({ technique: "drone.flythrough" }, { ...flat, gap: { pos: gp, normal: n, width: 2, height: 3 } });
  assert.ok(dist3(tr2.sample(tr2.meta.gapT).pos, gp) <= 0.02);
});

check("fpv-gap: banked approach turn, then threads the gap centre along its normal at speed", () => {
  const gp = [X0 + 10, Y0 - 4, 55];
  const n = [0, 1, 0];
  const tr = SH.buildShot({ technique: "fpv.fpv-gap", params: { gapPos: gp, gapNormal: n } }, flat);
  const p = tr.sample(tr.meta.gapT);
  assert.ok(dist3(p.pos, gp) <= 0.05, `misses the gap by ${dist3(p.pos, gp)}`);
  const f = G.forwardFromHP(p.h, p.p);
  assert.ok(f[1] >= Math.cos(2 * DEG), "aligned with the gap normal");
  assert.ok(Math.abs(p.r) < 2 * DEG, "wings level through the gap");
  const fr = frames(tr);
  assert.ok(Math.max(...fr.map((q) => Math.abs(q.r))) > 5 * DEG, "banks in the approach turn");
  assert.ok(TR.validateTrajectory(tr).ok);
});

check("fpv-dive: steep dive (camera ≤ −55° with uptilt, path ≥ 60° steep), pull-out to level near the base", () => {
  const tr = SH.buildShot({ technique: "fpv.fpv-dive" }, flat);
  const fr = frames(tr);
  const minP = Math.min(...fr.map((p) => p.p));
  assert.ok(minP <= -55 * DEG && minP >= -90 * DEG, `min camera pitch ${minP / DEG}`);
  let steep = 0;
  for (let i = 1; i < fr.length; i++) {
    const d = [fr[i].pos[0] - fr[i - 1].pos[0], fr[i].pos[1] - fr[i - 1].pos[1], fr[i].pos[2] - fr[i - 1].pos[2]];
    steep = Math.min(steep, Math.atan2(d[2], Math.hypot(d[0], d[1])));
  }
  assert.ok(steep <= -60 * DEG, `flight path only ${steep / DEG}°`);
  assert.ok(Math.abs(fr[fr.length - 1].p) < 10 * DEG, "levels out");
  near(fr[fr.length - 1].pos[2], 50 + 2.5, 0.3, "pull-out height");
  const noUp = frames(SH.buildShot({ technique: "fpv.fpv-dive", params: { uptiltDeg: 0 } }, flat));
  assert.ok(Math.min(...noUp.map((p) => p.p)) < minP - 10 * DEG, "uptilt lifts the dive view");
});

check("fpv-proximity: holds `offset` from the surface line, leans toward the surface side", () => {
  for (const side of ["right", "left"]) {
    const tr = SH.buildShot({ technique: "fpv.fpv-proximity", params: { side, headingDeg: 0, relativeToSubject: false } }, base);
    const s = side === "right" ? 1 : -1;
    for (const p of frames(tr)) {
      near(p.pos[0], X0 - s * 1.5, 1e-6, "lateral offset from the surface line (north-south through the anchor)");
      near(p.r, s * 8 * DEG, 1e-6, "lean toward the surface");
    }
  }
});

// ---------------------------------------------------------------------------
console.log("D10 speed-profile meta (review math-2 round 2: the take player's flight check reads it)");
// ---------------------------------------------------------------------------
/** Largest frame-to-frame speed of a shot sampled at `fps`. */
function measuredPeak(tr, fps = 60) {
  const fr = frames(tr, fps);
  let pk = 0;
  for (let i = 1; i < fr.length; i++) pk = Math.max(pk, dist3(fr[i].pos, fr[i - 1].pos) / (fr[i].t - fr[i - 1].t));
  return pk;
}
const PROFILED = ["drone.flythrough", "drone.terrain-skim", "drone.canyon-run", "fpv.fpv-dive", "fpv.fpv-proximity", "fpv.fpv-gap", "fpv.fpv-corridor", "fpv.fpv-run"];
check("every technique flown on a fitted speed profile reports meta.lengthM, meta.overspeed AND meta.peakSpeed (≈ the measured peak at linear ease)", () => {
  const seen = [];
  for (const def of ALL) {
    for (const duration of [undefined, 7.3]) {
      const tr = SH.buildShot(duration ? { technique: def.id, duration } : { technique: def.id }, ctxFor(def));
      const m = tr.meta;
      const profiled = Object.prototype.hasOwnProperty.call(m, "overspeed");
      if (!profiled) {
        assert.equal(m.peakSpeed, undefined, `${def.id}: a peakSpeed without a profile`);
        continue;
      }
      if (duration === undefined) seen.push(def.id);
      assert.equal(typeof m.overspeed, "boolean", `${def.id}: meta.overspeed`);
      assert.ok(Number.isFinite(m.peakSpeed) && m.peakSpeed >= 0, `${def.id} (D=${tr.duration}): meta.peakSpeed ${m.peakSpeed}`);
      assert.ok(Number.isFinite(m.lengthM) && m.lengthM > 0, `${def.id}: meta.lengthM ${m.lengthM}`);
      const pk = measuredPeak(tr);
      assert.ok(Math.abs(pk - m.peakSpeed) <= 0.05 * m.peakSpeed + 0.05, `${def.id} (D=${tr.duration}): meta.peakSpeed ${m.peakSpeed.toFixed(2)} vs measured ${pk.toFixed(2)} m/s`);
    }
  }
  assert.deepEqual(seen.sort(), PROFILED.slice().sort(), "the profiled techniques");
  // flythrough through a gap (slow zone): the peak either side of the gap, above the mean
  const gp = [X0 + 5, Y0 + 2, 54];
  const g = SH.buildShot({ technique: "drone.flythrough", duration: 12, params: { gapPos: gp, gapNormal: [1, 0.2, 0], speed: 8, gapSpeed: 0.3 } }, flat);
  assert.ok(g.meta.peakSpeed > (g.meta.lengthM / 12) * 1.05, `gap pass: peak ${g.meta.peakSpeed.toFixed(2)} vs mean ${(g.meta.lengthM / 12).toFixed(2)}`);
  near(measuredPeak(g), g.meta.peakSpeed, 0.05 * g.meta.peakSpeed, "gap pass: measured peak");
});

// ---------------------------------------------------------------------------
console.log("D9 errors and degenerate inputs");
// ---------------------------------------------------------------------------
check("missing context / bad params give readable FilmShotErrors", () => {
  assert.throws(() => SH.buildShot({ technique: "drone.dronie" }, { anchor: [0, 0, 0] }), shotErr("MISSING_CONTEXT", /needs a subject/));
  assert.throws(() => SH.buildShot({ technique: "drone.canyon-run" }, base), shotErr("MISSING_CONTEXT", /needs a path/));
  assert.throws(() => SH.buildShot({ technique: "fpv.fpv-corridor" }, { anchor: [0, 0, 0] }), shotErr("MISSING_CONTEXT", /ctx\.indoor\.route/));
  assert.throws(() => SH.buildShot({ technique: "fpv.fpv-run" }, { anchor: [0, 0, 0] }), shotErr("MISSING_CONTEXT", /racing line/));
  assert.throws(() => SH.buildShot({ technique: "fpv.fpv-run", params: { tricks: [{ type: "loop", s: 1 }] } }, { path: VALLEY }), shotErr("BAD_PARAM", /tricks\[0\]\.type/));
  assert.throws(() => SH.buildShot({ technique: "drone.terrain-skim" }, { ...base, indoor: { floor: () => 0 } }), shotErr("MISSING_CONTEXT", /outdoor-only/));
  assert.throws(() => SH.buildShot({ technique: "drone.orbit-poi", params: { radius: -1 } }, base), shotErr("BAD_PARAM", /radius/));
  assert.throws(() => SH.buildShot({ technique: "fpv.fpv-flip", params: { turns: 1.5 } }, base), shotErr("BAD_PARAM", /integer/));
  assert.throws(() => SH.buildShot({ technique: "drone.pass-over", params: { nadirMode: "flip" } }, base), shotErr("BAD_PARAM", /yaw-slew/));
  assert.throws(() => SH.buildShot({ technique: "drone.flythrough", params: { gap: {} } }, base), shotErr("BAD_PARAM", /unknown param "gap"/));
});

check("degenerate inputs stay finite: coincident route, zero-length moves, anchor-only context, no groundZ", () => {
  const still = SH.buildShot({ technique: "fpv.fpv-corridor", duration: 2 }, { indoor: { route: [[5, 5, 1.5], [5, 5, 1.5]] } });
  assert.ok(TR.validateTrajectory(still).ok);
  assert.deepEqual(still.sample(1).pos, [5, 5, 1.5]);
  const hoverRun = SH.buildShot({ technique: "fpv.fpv-run", duration: 2, params: { throttleBobM: 0 } }, { indoor: { route: [[5, 5, 1.5], [5, 5, 1.5]] } });
  assert.ok(TR.validateTrajectory(hoverRun).ok);
  assert.deepEqual(hoverRun.sample(1).pos, [5, 5, 1.5]);
  for (const id of ["drone.orbit-poi", "drone.pass-over", "drone.flyover", "drone.top-down", "drone.pano-360", "drone.flythrough", "fpv.fpv-gap", "fpv.fpv-flip", "fpv.fpv-dive", "drone.terrain-skim", "fpv.fpv-proximity"]) {
    const tr = SH.buildShot({ technique: id, duration: 3 }, { anchor: [1000, 2000, 30] });
    const v = TR.validateTrajectory(tr);
    assert.ok(v.ok, `${id} anchor-only: ${issuesText(v)}`);
  }
  const zero = SH.buildShot({ technique: "drone.flyover", duration: 2, params: { speed: 0.5 } }, flat);
  assert.ok(TR.validateTrajectory(zero).ok);
  const hover = SH.buildShot({ technique: "fpv.fpv-flip", duration: 3, params: { speed: 0 } }, flat);
  near(hdist(hover.sample(0).pos, hover.sample(3).pos), 0, 1e-9, "hover flip stays put");
});

console.log(`film_shots_drone: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
