// tests/film_shots_classic.test.mjs
//
// WHY: the director (a Claude Code session) writes shots by technique id —
// `{technique:'classic.push-in', duration:6, framing:'MCU'}` — and trusts the
// classic grammar to behave like real cinematography: the subject stays in
// frame, the camera never dips under the ground, tilts reach straight down
// with no gimbal flip, a bird's-eye is EXACTLY −90°, a dolly zoom holds the
// subject's size while the background warps, an orbit closes on itself, a
// whip pan is fast but continuous, a rack focus pulls monotonically, and
// tracking shots keep their distance from a moving subject. Every take is
// recorded stepped from these trajectories, so a NaN, a teleport or a flip
// here is a ruined shot on the GTX-1070. This suite EXECUTES
// scene3d/film/shots/classic.js through the real registry and proves:
//   C1  catalog: exactly the SPEC §2.12 classic ids, documented, registered by
//       shots/index.js, JSON-safe;
//   C2  EVERY technique with defaults against a standard context (1.8 m
//       subject, flat ground): duration honoured (default and explicit),
//       validateTrajectory ok at 30 fps, subject in frame ≥ 95% (except
//       reveals that start off-subject and POV, whose subject is the camera),
//       ≥ 0.7 m ground clearance, continuous Pose.h, deterministic bakes;
//   C3  robustness: sloped ground, indoor floor/ceiling, no subject (anchor
//       point of interest), coincident secondary/occluder, very short and
//       long shots, readable errors;
//   C4  targeted behaviour of every family (dolly-zoom height constant ≤ 3%,
//       tilt to ±90° without flip, bird's-eye p === −π/2, orbit closure,
//       whip-pan peak speed, rack-focus monotone, tracking distance ±15% on a
//       moving subject, dolly/truck/pedestal/crane geometry, dialogue, POV,
//       snorricam, reveal, angles, handheld seeding, time-lapse meta, …);
//   C5  the exported rig helpers (followSpring, travelHeadingTrack,
//       frontBearing) and a cross-check of classic poses against REAL three
//       0.184 cameras.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its pure shot modules.
// Run from apps/holtburger-web/: node tests/film_shots_classic.test.mjs

import assert from "node:assert/strict";

const CL = await import("../scene3d/film/shots/classic.js");
const RG = await import("../scene3d/film/shots/registry.js");
const TR = await import("../scene3d/film/shots/trajectory.js");
const FR = await import("../scene3d/film/shots/framing.js");
const GB = await import("../scene3d/film/core/gimbal.js");
const QT = await import("../scene3d/film/core/quat.js");
const { EASINGS: EASE } = await import("../scene3d/film/core/easing.js");
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
function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? "value"}: ${a} vs ${b} (eps ${eps})`);
}
function shotErr(code, re) {
  return (e) => {
    assert.ok(e instanceof FilmShotError, `expected FilmShotError, got ${e && e.name}: ${e && e.message}`);
    if (code) assert.equal(e.code, code, `code (message: ${e.message})`);
    if (re) assert.match(e.message, re);
    return true;
  };
}

const DEG = Math.PI / 180;
const SPEC_IDS = [
  "static", "pan", "tilt", "roll", "zoom", "dolly-in", "dolly-out", "truck", "pedestal", "crane", "arc", "orbit",
  "tracking-follow", "tracking-lead", "tracking-side", "push-in", "pull-out-reveal", "dolly-zoom", "whip-pan",
  "rack-focus", "over-the-shoulder", "pov", "two-shot", "establishing", "high-angle", "low-angle", "birds-eye",
  "worms-eye", "handheld", "steadicam", "snorricam", "reveal-from-occluder", "time-lapse", "hyperlapse",
].map((n) => `classic.${n}`);
/** Techniques whose subject legitimately leaves the frame: whip-pan starts off-subject, POV's subject is the camera. */
const NO_COVERAGE = new Set(["classic.whip-pan", "classic.pov"]);

/** Isolated registry holding exactly the classic techniques (independent of other lanes' files). */
const REG = RG.createRegistry();
for (const d of CL.CLASSIC_TECHNIQUES) REG.registerTechnique(d);
const build = (spec, ctx) => REG.buildShot(spec, ctx);

const GROUND = 50;
const SUBJ = Object.freeze({ pos: [1000, 2000, GROUND], height: 1.8, radius: 0.45, heading: 0.6 });
const STD = Object.freeze({ subject: SUBJ, groundZ: () => GROUND, anchor: [1003, 1996, GROUND], aspect: 16 / 9 });
const ASPECT = 16 / 9;

const times = (tr, fps = 30) => TR.frameTimes(tr.duration, fps);
const validate = (tr, extra) => TR.validateTrajectory(tr, { fps: 30, ...(tr.meta.motionLimits || {}), ...(extra || {}) });

/** Subject in frame: the framing's aim point or the eye line projects in front with |ndc| ≤ 1. */
function inFrame(pose, subj, framing) {
  const pts = [FR.aimPointForFraming(framing, subj), [subj.pos[0], subj.pos[1], subj.pos[2] + 0.9 * subj.height]];
  return pts.some((pt) => {
    const P = FR.projectToNdc(pose, pt, pose.fov, ASPECT);
    return P.inFront && Math.abs(P.x) <= 1 && Math.abs(P.y) <= 1;
  });
}
function coverage(tr, subjAt, framing) {
  const ts = times(tr);
  let n = 0;
  for (const t of ts) if (inFrame(tr.sample(t), subjAt(t), framing)) n += 1;
  return n / ts.length;
}
function minClearance(tr, groundZ) {
  let m = Infinity;
  for (const t of times(tr)) {
    const p = tr.sample(t);
    m = Math.min(m, p.pos[2] - groundZ(p.pos[0], p.pos[1]));
  }
  return m;
}
function maxHeadingStep(tr) {
  let m = 0, prev = null;
  for (const t of times(tr)) {
    const p = tr.sample(t);
    if (prev !== null) m = Math.max(m, Math.abs(p.h - prev));
    prev = p.h;
  }
  return m;
}
function allFinite(tr) {
  for (const t of times(tr)) {
    const p = tr.sample(t);
    const vals = [...p.pos, p.h, p.p, p.r, ...p.q, p.fov, ...(p.focus !== undefined ? [p.focus] : [])];
    if (!vals.every(Number.isFinite)) return false;
  }
  return true;
}
const hdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------------------------------------------------------------------------
// C1 catalog
// ---------------------------------------------------------------------------

check("C1 CLASSIC_TECHNIQUES = exactly the SPEC §2.12 classic ids, in order, normalised and documented", () => {
  assert.deepEqual(CL.CLASSIC_TECHNIQUES.map((d) => d.id), SPEC_IDS);
  assert.deepEqual([...CL.CLASSIC_TECHNIQUE_IDS], SPEC_IDS);
  for (const d of CL.CLASSIC_TECHNIQUES) {
    assert.ok(Object.isFrozen(d), `${d.id} frozen (defineTechnique result)`);
    assert.equal(d.family, "classic");
    assert.ok(d.name && d.description.length > 40 && d.whenToUse.length > 20, `${d.id} documented`);
    assert.ok(Number.isFinite(d.defaultDuration) && d.defaultDuration > 0, `${d.id} defaultDuration`);
    assert.ok(Object.keys(d.params).length > 0, `${d.id} has params`);
    for (const [k, s] of Object.entries(d.params)) {
      assert.ok(s.desc && s.desc.length > 10, `${d.id}.${k} desc`);
      assert.notEqual(s.default, undefined, `${d.id}.${k} has a default (builds with defaults)`);
    }
    for (const k of TR.BOUND_KEYS) assert.ok(Number.isFinite(d.defaultBounds[k]), `${d.id} bounds.${k}`);
  }
});

await checkAsync("C1 shots/index.js registers every classic technique into the default registry; catalog JSON-safe", async () => {
  const SH = await import("../scene3d/film/shots/index.js");
  for (const id of SPEC_IDS) assert.ok(SH.getTechnique(id), `registered ${id}`);
  const cat = SH.listTechniques({ family: "classic" });
  assert.deepEqual(cat.map((e) => e.id), SPEC_IDS);
  assert.deepEqual(JSON.parse(JSON.stringify(cat)), cat);
  const tr = SH.buildShot({ technique: "classic.static", duration: 2 }, STD);
  assert.equal(tr.technique, "classic.static");
  assert.equal(tr.family, "classic");
});

check("C1 needs / capture / reveal hints are sensible", () => {
  const get = (id) => REG.getTechnique(id);
  for (const id of ["classic.tracking-follow", "classic.tracking-lead", "classic.tracking-side"]) {
    assert.equal(get(id).capture, "realtime", `${id} capture hint`);
    assert.equal(get(id).defaultBounds.minSpeedScale, 1, `${id} pinned progress rate (keeps pace with the subject)`);
    assert.equal(get(id).defaultBounds.maxSpeedScale, 1);
  }
  for (const id of ["classic.whip-pan", "classic.pull-out-reveal", "classic.reveal-from-occluder"]) assert.equal(get(id).reveal, true, id);
  for (const id of ["classic.pov", "classic.snorricam", "classic.over-the-shoulder", "classic.two-shot", "classic.dolly-zoom",
    "classic.tracking-follow", "classic.reveal-from-occluder", "classic.rack-focus"]) {
    assert.equal(get(id).needs.subject, true, `${id} needs a subject`);
  }
  for (const id of ["classic.static", "classic.pan", "classic.tilt", "classic.establishing", "classic.birds-eye", "classic.time-lapse"]) {
    assert.equal(get(id).needs.subject, false, `${id} works without a subject`);
  }
});

// ---------------------------------------------------------------------------
// C2 every technique with defaults
// ---------------------------------------------------------------------------

const DEFAULT_BUILDS = new Map();
for (const id of SPEC_IDS) {
  check(`C2 ${id}: defaults → duration, valid at 30 fps, subject in frame, ≥ 0.7 m clearance, continuous heading`, () => {
    const def = REG.getTechnique(id);
    const tr = build({ technique: id }, STD);
    DEFAULT_BUILDS.set(id, tr);
    assert.equal(tr.duration, def.defaultDuration, "default duration");
    assert.equal(tr.technique, id);
    assert.equal(tr.family, "classic");
    const v = validate(tr);
    assert.ok(v.ok, `validateTrajectory: ${JSON.stringify(v.issues.slice(0, 3))}`);
    assert.ok(allFinite(tr), "NaN-free");
    const cov = coverage(tr, (t) => TR.subjectAtTime(STD, t) || SUBJ, tr.meta.spec.framing);
    if (!NO_COVERAGE.has(id)) assert.ok(cov >= 0.95, `subject in frame ${(cov * 100).toFixed(1)}%`);
    assert.ok(minClearance(tr, STD.groundZ) >= TR.GROUND_CLEARANCE - 1e-9, `clearance ${minClearance(tr, STD.groundZ)}`);
    assert.ok(maxHeadingStep(tr) < 0.5, `Pose.h step ${maxHeadingStep(tr)} rad/frame`);
    const explicit = build({ technique: id, duration: 4.2 }, STD);
    assert.equal(explicit.duration, 4.2, "explicit duration");
    const v2 = validate(explicit);
    assert.ok(v2.ok, `explicit duration valid: ${JSON.stringify(v2.issues.slice(0, 2))}`);
    assert.deepEqual(TR.bakeTrajectory(build({ technique: id }, STD), 30).checksum, TR.bakeTrajectory(tr, 30).checksum, "deterministic");
    assert.deepEqual(JSON.parse(JSON.stringify(tr.meta)), tr.meta, "meta JSON-safe");
  });
}

check("C2 every documented param changes the take (no dead knobs), in the mode where it applies", () => {
  const SEC = [SUBJ.pos[0] + 2, SUBJ.pos[1] + 1.5, GROUND];
  const walk = (t) => ({ pos: [1000 + 2 * Math.sin(0.3 * t) * 4, 2000 + 2.2 * t, GROUND], height: 1.8, radius: 0.45 });
  const moving = new Set(["classic.tracking-follow", "classic.tracking-lead", "classic.tracking-side", "classic.steadicam", "classic.snorricam", "classic.pov"]);
  // Params that only act in a mode: the base spec puts the technique in that mode for both builds.
  const MODE = {
    "classic.pan": { pitchDeg: { params: { relative: false } } },
    "classic.rack-focus": { fromM: { params: { fromTarget: "metres" } }, toM: { params: { toTarget: "metres" } } },
    "classic.handheld": { pushM: { framing: "FS", params: { base: "push-in" } } },
    "classic.over-the-shoulder": { secondaryHeight: { params: { secondary: SEC } } },
    "classic.two-shot": { secondaryHeight: { params: { secondary: SEC } } },
    "classic.steadicam": { glideM: { framing: "WS" } },
  };
  const signature = (tr) => {
    const meta = { ...tr.meta };
    delete meta.spec;
    return `${TR.bakeTrajectory(tr, 30).checksum}|${JSON.stringify(meta)}`;
  };
  const candidates = (s) => {
    if (s.type === "boolean") return [!s.default];
    if (s.type === "enum") return s.values.filter((v) => v !== s.default);
    if (s.type === "vec3") return [SEC];
    const hi = s.max !== undefined ? s.max : s.default + 10, lo = s.min !== undefined ? s.min : s.default - 10;
    return [hi - s.default > 1e-9 ? s.default + 0.3 * (hi - s.default) : s.default - 0.3 * (s.default - lo)];
  };
  let checked = 0;
  for (const d of CL.CLASSIC_TECHNIQUES) {
    const ctx = moving.has(d.id) ? { subjectAt: walk, groundZ: () => GROUND, anchor: STD.anchor } : STD;
    for (const [name, schema] of Object.entries(d.params)) {
      const mode = (MODE[d.id] && MODE[d.id][name]) || {};
      const base = { technique: d.id, duration: 6, ...(mode.framing ? { framing: mode.framing } : {}) };
      const baseParams = mode.params || {};
      const ref = signature(build({ ...base, params: { ...baseParams } }, ctx));
      const reacts = candidates(schema).some((v) => {
        try {
          return signature(build({ ...base, params: { ...baseParams, [name]: v } }, ctx)) !== ref;
        } catch (e) {
          if (e instanceof FilmShotError) return true; // a readable refusal also proves the param is read
          throw e;
        }
      });
      assert.ok(reacts, `${d.id}: param "${name}" has no effect`);
      checked += 1;
    }
  }
  assert.ok(checked > 200, `checked ${checked} params`);
});

check("C2 the ease param is honoured (dolly-in linear vs sineInOut; linear = constant speed)", () => {
  const lin = build({ technique: "classic.dolly-in", ease: "linear" }, STD);
  const sio = build({ technique: "classic.dolly-in", ease: "sineInOut" }, STD);
  const D = lin.duration;
  assert.ok(dist3(lin.sample(D * 0.2).pos, sio.sample(D * 0.2).pos) > 0.05, "different shape");
  const sp = [];
  for (let k = 1; k <= 10; k++) sp.push(dist3(lin.sample((D * k) / 10).pos, lin.sample((D * (k - 1)) / 10).pos));
  for (const s of sp) near(s, sp[0], 1e-6, "linear dolly step");
  near(dist3(lin.sample(0).pos, sio.sample(0).pos), 0, 1e-9, "same start");
  near(dist3(lin.sample(D).pos, sio.sample(D).pos), 0, 1e-9, "same end");
});

// ---------------------------------------------------------------------------
// C3 robustness
// ---------------------------------------------------------------------------

check("C3 sloped terrain: every technique keeps ≥ 0.7 m clearance and stays valid", () => {
  const slope = (x, y) => GROUND + 0.35 * (x - 1000) + 0.15 * (y - 2000);
  const ctx = { ...STD, groundZ: slope };
  for (const id of SPEC_IDS) {
    const tr = build({ technique: id }, ctx);
    const v = validate(tr);
    assert.ok(v.ok, `${id}: ${JSON.stringify(v.issues.slice(0, 2))}`);
    assert.ok(minClearance(tr, slope) >= TR.GROUND_CLEARANCE - 1e-9, `${id} clearance ${minClearance(tr, slope)}`);
  }
});

check("C3 indoor floor/ceiling: every technique stays between floor+0.5 and ceiling−0.3", () => {
  const ctx = { ...STD, groundZ: () => null, indoor: { floor: () => GROUND, ceiling: () => GROUND + 4.5 } };
  for (const id of SPEC_IDS) {
    const tr = build({ technique: id }, ctx);
    const v = validate(tr);
    assert.ok(v.ok, `${id}: ${JSON.stringify(v.issues.slice(0, 2))}`);
    for (const t of times(tr)) {
      const z = tr.sample(t).pos[2];
      assert.ok(z >= GROUND + 0.5 - 1e-9 && z <= GROUND + 4.5 - 0.3 + 1e-9, `${id} z=${z} at t=${t}`);
    }
  }
});

check("C3 no subject: subject-optional techniques frame ctx.anchor as a point of interest; the others refuse readably", () => {
  const anchor = [5000, 6000, 20];
  const ctx = { anchor, groundZ: () => 20 };
  for (const d of CL.CLASSIC_TECHNIQUES) {
    if (d.needs.subject) {
      assert.throws(() => build({ technique: d.id }, ctx), shotErr("MISSING_CONTEXT", /needs a subject/), d.id);
      continue;
    }
    const tr = build({ technique: d.id }, ctx);
    const v = validate(tr);
    assert.ok(v.ok, `${d.id}: ${JSON.stringify(v.issues.slice(0, 2))}`);
    assert.ok(minClearance(tr, () => 20) >= 0.7 - 1e-9, `${d.id} clearance`);
    if (d.id !== "classic.whip-pan") {
      const poi = { pos: anchor, height: 1.8, radius: 0.45 };
      assert.ok(coverage(tr, () => poi, tr.meta.spec.framing) >= 0.95, `${d.id} frames the anchor`);
    }
    assert.equal(tr.meta.rig.virtualSubject, true, `${d.id} reports the virtual subject`);
  }
});

check("C3 very short (0.1 s) shots stay NaN-free and in range; long (120 s) shots fully validate", () => {
  for (const id of SPEC_IDS) {
    // A 0.1 s orbit is a physically absurd request: its SPEED is legitimately flagged, but it must not break.
    const short = build({ technique: id, duration: 0.1 }, STD);
    assert.equal(short.duration, 0.1);
    const vs = TR.validateTrajectory(short, { fps: 30 });
    for (const code of ["nan", "sample-error", "pitch-range", "fov-range", "structure"]) assert.equal(vs.counts[code], 0, `${id} @0.1s ${code}`);
    assert.ok(allFinite(short), `${id} @0.1s finite`);
    const long = build({ technique: id, duration: 120 }, STD);
    assert.equal(long.duration, 120);
    const vl = validate(long);
    assert.ok(vl.ok, `${id} @120s: ${JSON.stringify(vl.issues.slice(0, 2))}`);
  }
});

check("C3 subject without heading and no anchor offset: front falls back to the sun, then north", () => {
  const s = { pos: [100, 100, 0], height: 1.8, radius: 0.45 };
  const sun = build({ technique: "classic.static", params: { elevationDeg: 0 } }, { subject: s, groundZ: () => 0, sun: { h: Math.PI / 2, p: 0.5 } });
  const p0 = sun.sample(0).pos;
  assert.ok(p0[0] > 100.5 && Math.abs(p0[1] - 100) < 1e-6, `camera east of the subject (sun side): ${p0}`);
  const north = build({ technique: "classic.static", params: { elevationDeg: 0 } }, { subject: s, groundZ: () => 0 });
  const p1 = north.sample(0).pos;
  assert.ok(p1[1] > 100.5 && Math.abs(p1[0] - 100) < 1e-6, `camera north of the subject: ${p1}`);
  const compass = build({ technique: "classic.static", params: { azimuthRef: "compass", azimuthDeg: 180, elevationDeg: 0 } }, STD);
  assert.ok(compass.sample(0).pos[1] < SUBJ.pos[1] - 0.5, "compass 180 = camera south of the subject");
});

check("C3 coincident secondary / occluder fall back to virtual ones; readable errors for impossible params", () => {
  const ots = build({ technique: "classic.over-the-shoulder", params: { secondary: SUBJ.pos.slice() } }, STD);
  assert.ok(validate(ots).ok);
  assert.equal(ots.meta.secondary.source, "virtual");
  const two = build({ technique: "classic.two-shot", params: { secondary: [SUBJ.pos[0] + 0.1, SUBJ.pos[1], GROUND] } }, STD);
  assert.ok(validate(two).ok);
  assert.equal(two.meta.secondary.source, "virtual");
  const rev = build({ technique: "classic.reveal-from-occluder", params: { occluder: [SUBJ.pos[0], SUBJ.pos[1], GROUND + 0.9] } }, STD);
  assert.ok(validate(rev).ok);
  assert.equal(rev.meta.revealOccluder.source, "virtual");
  assert.throws(() => build({ technique: "classic.tilt", params: { relative: false, toDeg: -120 } }, STD),
    shotErr("BAD_PARAM", /classic\.tilt: absolute toDeg must be within \[−90, 90\]/));
  assert.throws(() => build({ technique: "classic.birds-eye", params: { heightM: 1 } }, STD),
    shotErr("BAD_PARAM", /classic\.birds-eye: the camera must stay ≥ 2\.30 m above/));
  assert.throws(() => build({ technique: "classic.orbit", params: { revolution: 2 } }, STD),
    shotErr("BAD_PARAM", /unknown param "revolution" \(did you mean "revolutions"\?\)/));
  assert.throws(() => build({ technique: "classic.whip-pan", params: { whipSec: 0.6 } }, STD), shotErr("BAD_PARAM", /whipSec/));
});

// ---------------------------------------------------------------------------
// C4 targeted behaviour
// ---------------------------------------------------------------------------

check("C4 dolly-zoom: subject frame-height fraction constant within 3% while fov and distance change", () => {
  for (const [framing, toFovDeg] of [["MS", 25], ["FS", 100], ["WS", 15]]) {
    const tr = build({ technique: "classic.dolly-zoom", framing, params: { toFovDeg } }, STD);
    assert.ok(validate(tr).ok, `${framing} → ${toFovDeg}°`);
    const hf = times(tr).map((t) => {
      const p = tr.sample(t);
      return FR.compositionMetrics(p, SUBJ, p.fov, ASPECT, { framing }).heightFrac;
    });
    const mean = hf.reduce((a, b) => a + b, 0) / hf.length;
    assert.ok((Math.max(...hf) - Math.min(...hf)) / mean <= 0.03, `heightFrac spread ${Math.min(...hf)}..${Math.max(...hf)}`);
    near(mean, 1 / FR.FRAMINGS[framing], 0.03 / FR.FRAMINGS[framing], "the framing's frame-height fraction");
    near(tr.sample(0).fov, 60, 1e-6, "start fov = shot fov");
    near(tr.sample(tr.duration).fov, toFovDeg, 1e-6, "end fov");
    const d0 = dist3(tr.sample(0).pos, FR.aimPointForFraming(framing, SUBJ));
    const d1 = dist3(tr.sample(tr.duration).pos, FR.aimPointForFraming(framing, SUBJ));
    assert.ok(toFovDeg < 60 ? d1 > d0 * 2 : d1 < d0 * 0.5, `dollies ${toFovDeg < 60 ? "out" : "in"}: ${d0} → ${d1}`);
  }
  const capped = build({ technique: "classic.dolly-zoom", params: { toFovDeg: 110 } }, STD);
  assert.ok(capped.sample(capped.duration).fov < 110, "MS at 110° would put the lens inside the subject: capped by the standoff");
  assert.ok(dist3(capped.sample(capped.duration).pos, FR.aimPointForFraming("MS", SUBJ)) >= 0.75 - 1e-9);
});

check("C4 tilt to −90° and +90°: exact end pitch, heading held (no flip), q continuous", () => {
  for (const toDeg of [-90, 90]) {
    const tr = build({ technique: "classic.tilt", params: { relative: false, fromDeg: 0, toDeg } }, STD);
    const end = tr.sample(tr.duration);
    assert.equal(end.p, toDeg < 0 ? -Math.PI / 2 : Math.PI / 2, "exactly ±π/2");
    assert.ok(validate(tr).ok);
    const h0 = tr.sample(0).h;
    let prevQ = null, prevH = null;
    for (const t of TR.frameTimes(tr.duration, 120)) {
      const p = tr.sample(t);
      assert.equal(p.h, h0, "heading held");
      if (prevQ) assert.ok(QT.qAngle(prevQ, p.q) < 3 * DEG, "small per-step rotation");
      const hq = GB.hprFromQuat(p.q, prevH === null ? h0 : prevH).h;
      if (prevH !== null) assert.ok(Math.abs(hq - prevH) < 1e-6, `quaternion heading continuous at t=${t}`);
      prevQ = p.q;
      prevH = hq;
    }
    const fwd = QT.qToBasis(end.q).forward;
    near(fwd[2], toDeg < 0 ? -1 : 1, 1e-12, "forward vertical");
  }
});

check("C4 tilt relative default: tilts down from 20° above the subject onto it", () => {
  const tr = DEFAULT_BUILDS.get("classic.tilt");
  const m0 = FR.compositionMetrics(tr.sample(0), SUBJ, undefined, ASPECT, { framing: "FS" });
  const m1 = FR.compositionMetrics(tr.sample(tr.duration), SUBJ, undefined, ASPECT, { framing: "FS" });
  assert.ok(m0.ndc[1] < -0.5, `starts above the subject (subject low in frame): ${m0.ndc[1]}`);
  near(m1.ndc[1], 0, 1e-9, "ends centred");
});

check("C4 birds-eye: p === −π/2 exactly at every sample; rotation = continuous image rotation; directly above", () => {
  const tr = build({ technique: "classic.birds-eye", params: { rotateDeg: 180, riseM: 3 } }, STD);
  assert.ok(validate(tr).ok);
  let prev = null;
  for (const t of TR.frameTimes(tr.duration, 60)) {
    const p = tr.sample(t);
    assert.equal(p.p, -Math.PI / 2, `pitch at t=${t}`);
    near(hdist(p.pos, SUBJ.pos), 0, 1e-9, "directly above");
    if (prev) assert.ok(QT.qAngle(prev, p.q) < 6 * DEG, "continuous rotation");
    prev = p.q;
  }
  const a = tr.sample(0), b = tr.sample(tr.duration);
  near(b.h - a.h, Math.PI, 1e-9, "heading turned 180° (image rotated)");
  near(b.pos[2] - a.pos[2], 3, 1e-9, "rose 3 m");
  near(a.h, SUBJ.heading, 1e-12, "image-up = the subject's front");
});

check("C4 orbit: one revolution returns exactly to the start; half-way is opposite; distance constant", () => {
  const tr = DEFAULT_BUILDS.get("classic.orbit");
  const a = tr.sample(0), b = tr.sample(tr.duration), m = tr.sample(tr.duration / 2);
  near(dist3(a.pos, b.pos), 0, 1e-9, "position closes");
  assert.ok(QT.qAngle(a.q, b.q) < 1e-9, "orientation closes");
  const c = FR.aimPointForFraming("FS", SUBJ);
  const va = [a.pos[0] - c[0], a.pos[1] - c[1]], vm = [m.pos[0] - c[0], m.pos[1] - c[1]];
  assert.ok(va[0] * vm[0] + va[1] * vm[1] < 0, "opposite side at half time");
  for (const t of times(tr)) near(dist3(tr.sample(t).pos, c), tr.meta.rig.distance, 1e-9, "radius");
  const ccw = build({ technique: "classic.orbit", params: { direction: "ccw", revolutions: 2 } }, STD);
  near(dist3(ccw.sample(0).pos, ccw.sample(ccw.duration).pos), 0, 1e-9, "2 revolutions close too");
  near(ccw.sample(ccw.duration).h - ccw.sample(0).h, -4 * Math.PI, 1e-6, "ccw: heading unwrapped through −720°");
});

check("C4 whip-pan: hold / ≤0.35 s whip with high but continuous angular speed / hold, lands on the subject", () => {
  const tr = DEFAULT_BUILDS.get("classic.whip-pan");
  const fps = 240;
  const ts = TR.frameTimes(tr.duration, fps);
  const w = [];
  for (let k = 1; k < ts.length; k++) w.push(QT.qAngle(tr.sample(ts[k - 1]).q, tr.sample(ts[k]).q) * fps / DEG);
  const peak = Math.max(...w);
  assert.ok(peak > 400, `peak angular speed ${peak}°/s (a whip, far above the 240°/s default)`);
  assert.ok(peak <= tr.meta.motionLimits.maxAngularSpeedDeg, "within the declared motion limit");
  for (let k = 1; k < w.length; k++) assert.ok(Math.abs(w[k] - w[k - 1]) <= 0.12 * peak, `smooth speed profile at sample ${k}`);
  const active = ts.slice(1).filter((t, k) => w[k] > 0.02 * peak);
  assert.ok(active[active.length - 1] - active[0] <= 0.35 + 2 / fps, `whip lasts ${active[active.length - 1] - active[0]} s`);
  near(tr.meta.whip.endSec - tr.meta.whip.startSec, 0.25, 1e-12);
  const turned = tr.sample(tr.duration).h - tr.sample(0).h;
  near(turned, 90 * DEG, 1e-9, "90° to the right");
  const endM = FR.compositionMetrics(tr.sample(tr.duration), SUBJ, undefined, ASPECT, { framing: "MS" });
  assert.ok(endM.inFrame && endM.centerError < 1e-6, "lands centred on the subject");
  const startM = FR.compositionMetrics(tr.sample(0), SUBJ, undefined, ASPECT, { framing: "MS" });
  assert.equal(startM.inFrame, false, "starts off-subject");
  assert.equal(validate(tr, { maxAngularSpeedDeg: 240 }).ok, false, "the default 240°/s limit would flag it (hence meta.motionLimits)");
});

check("C4 rack-focus: focus channel present, monotone from the foreground to the subject distance", () => {
  const tr = DEFAULT_BUILDS.get("classic.rack-focus");
  const ts = TR.frameTimes(tr.duration, 60);
  const f = ts.map((t) => tr.sample(t).focus);
  assert.ok(f.every(Number.isFinite), "every pose has focus");
  for (let k = 1; k < f.length; k++) assert.ok(f[k] >= f[k - 1] - 1e-12, `monotone at ${ts[k]}`);
  const subjD = dist3(tr.sample(tr.duration).pos, FR.aimPointForFraming("MS", SUBJ));
  near(f[f.length - 1], subjD, 1e-9, "ends on the subject distance");
  near(f[0], Math.max(0.3, 0.35 * subjD), 1e-9, "starts on the foreground");
  const { pullStartSec, pullSec } = tr.meta.rackFocus;
  for (const t of ts) {
    if (t < pullStartSec - 1e-9) near(tr.sample(t).focus, f[0], 1e-12, "held before the pull");
    if (t > pullStartSec + pullSec + 1e-9) near(tr.sample(t).focus, f[f.length - 1], 1e-12, "held after the pull");
  }
  const back = build({ technique: "classic.rack-focus", params: { fromTarget: "subject", toTarget: "metres", toM: 40 } }, STD);
  const fb = TR.frameTimes(back.duration, 60).map((t) => back.sample(t).focus);
  for (let k = 1; k < fb.length; k++) assert.ok(fb[k] >= fb[k - 1] - 1e-12, "subject → 40 m monotone");
  near(fb[fb.length - 1], 40, 1e-12);
  const baked = TR.bakeTrajectory(tr, 30);
  assert.ok(baked.rows[9] > 0 && baked.rows[(baked.frames - 1) * 11 + 9] > baked.rows[9], "focus column baked");
});

/** A subject walking a gentle curve at ≈2.4 m/s. */
const walker = (t) => {
  const ang = 0.08 * t, R = 30;
  return { pos: [1000 + R * Math.sin(ang), 2000 + R * (1 - Math.cos(ang)), GROUND], height: 1.8, radius: 0.45 };
};
const MOVING = { subjectAt: walker, groundZ: () => GROUND, aspect: ASPECT };

check("C4 tracking-follow on a moving subject: distance within ±15%, behind it, in frame", () => {
  const tr = build({ technique: "classic.tracking-follow", duration: 10 }, MOVING);
  assert.ok(validate(tr).ok);
  const d = tr.meta.tracking.distance;
  for (const t of times(tr)) {
    const p = tr.sample(t), s = walker(t);
    const aim = FR.aimPointForFraming("WS", s);
    const ratio = dist3(p.pos, aim) / d;
    assert.ok(ratio >= 0.85 && ratio <= 1.15, `distance ratio ${ratio} at t=${t}`);
    const ahead = walker(t + 0.1);
    const dir = [ahead.pos[0] - s.pos[0], ahead.pos[1] - s.pos[1]];
    assert.ok((p.pos[0] - s.pos[0]) * dir[0] + (p.pos[1] - s.pos[1]) * dir[1] < 0, "camera behind the subject");
  }
  assert.ok(coverage(tr, walker, "WS") >= 0.95);
});

check("C4 tracking-lead / tracking-side on a moving subject: ahead / beside, distance ±15%, side lead room", () => {
  const lead = build({ technique: "classic.tracking-lead", duration: 10 }, MOVING);
  const side = build({ technique: "classic.tracking-side", duration: 10 }, MOVING);
  for (const [tr, kind] of [[lead, "lead"], [side, "side"]]) {
    assert.ok(validate(tr).ok, kind);
    assert.ok(coverage(tr, walker, "FS") >= 0.95, `${kind} coverage`);
    const d = tr.meta.tracking.distance;
    for (const t of times(tr)) {
      const p = tr.sample(t), s = walker(t);
      const ratio = dist3(p.pos, FR.aimPointForFraming("FS", s)) / d;
      assert.ok(ratio >= 0.85 && ratio <= 1.15, `${kind} distance ratio ${ratio}`);
      const ahead = walker(t + 0.1);
      const dir = [ahead.pos[0] - s.pos[0], ahead.pos[1] - s.pos[1]];
      const rel = [p.pos[0] - s.pos[0], p.pos[1] - s.pos[1]];
      const along = (rel[0] * dir[0] + rel[1] * dir[1]) / Math.hypot(...dir) / Math.hypot(...rel);
      if (kind === "lead") assert.ok(along > 0.9, "camera ahead");
      else assert.ok(Math.abs(along) < 0.25, `camera beside (cos ${along})`);
    }
  }
  const mid = side.sample(5);
  const m = FR.compositionMetrics(mid, walker(5), undefined, ASPECT, { framing: "FS" });
  near(m.ndc[0], -1 / 3, 0.08, "side-right: subject moving screen-right sits on the left third");
});

check("C4 spring rigs at run speed (7 m/s): default framing distance held ±15%; a trailing rig never enters the subject", () => {
  const runner = (t) => ({ pos: [1000 + 7 * t, 2000 + 0.5 * Math.sin(0.4 * t), GROUND], height: 1.8, radius: 0.45 });
  const ctx = { subjectAt: runner, groundZ: () => GROUND };
  for (const id of ["classic.tracking-follow", "classic.tracking-lead", "classic.tracking-side"]) {
    const tr = build({ technique: id, duration: 6 }, ctx);
    assert.ok(validate(tr).ok, id);
    const fr = tr.meta.spec.framing;
    for (const t of times(tr)) {
      const ratio = dist3(tr.sample(t).pos, FR.aimPointForFraming(fr, runner(t))) / tr.meta.tracking.distance;
      assert.ok(ratio > 0.85 && ratio < 1.15, `${id} ratio ${ratio} at t=${t}`);
    }
  }
  for (const id of ["classic.tracking-lead", "classic.steadicam"]) {
    const tr = build({ technique: id, duration: 6, framing: "MS", params: { feedForward: 0.2, lag: 1.5 } }, ctx);
    assert.ok(validate(tr).ok, id);
    for (const t of times(tr)) {
      const d = dist3(tr.sample(t).pos, FR.aimPointForFraming("MS", runner(t)));
      assert.ok(d > 0.45 + 0.15 - 1e-9, `${id} lens ${d} m from the eye line (inside the body?) at t=${t}`);
    }
  }
});

check("C4 dolly-in / dolly-out / push-in / pull-out-reveal: along the view axis between framing distances", () => {
  for (const [id, closer] of [["classic.dolly-in", true], ["classic.dolly-out", false], ["classic.push-in", true], ["classic.pull-out-reveal", false]]) {
    const tr = DEFAULT_BUILDS.get(id);
    const dm = tr.meta.dolly;
    const c0 = FR.aimPointForFraming(dm.fromFraming, SUBJ), c1 = FR.aimPointForFraming(dm.toFraming, SUBJ);
    near(dist3(tr.sample(0).pos, c0), dm.fromDistance, 1e-6, `${id} start distance`);
    near(dist3(tr.sample(tr.duration).pos, c1), dm.toDistance, 1e-6, `${id} end distance`);
    assert.ok(closer ? dm.toDistance < dm.fromDistance : dm.toDistance > dm.fromDistance, `${id} direction`);
    const fov = tr.sample(0).fov;
    near(dm.fromDistance, Math.max(0.75, FR.distanceForFraming(dm.fromFraming, 1.8, fov)), 1e-9, `${id} from framing math`);
    let prevD = null;
    for (const t of times(tr)) {
      const p = tr.sample(t);
      const dd = hdist(p.pos, SUBJ.pos);
      if (prevD !== null) assert.ok(closer ? dd <= prevD + 1e-9 : dd >= prevD - 1e-9, `${id} monotone distance`);
      prevD = dd;
    }
  }
  const din = DEFAULT_BUILDS.get("classic.dolly-in");
  const a = din.sample(0), b = din.sample(din.duration);
  const move = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]];
  const f = QT.qToBasis(a.q).forward;
  const cos = (move[0] * f[0] + move[1] * f[1]) / Math.hypot(...move) / Math.hypot(f[0], f[1]);
  assert.ok(cos > Math.cos(1 * DEG), `dolly travels along the view axis (cos ${cos})`);
  const per = build({ technique: "classic.pull-out-reveal", ease: "linear" }, STD);
  const dm = per.meta.dolly;
  near(hdist(per.sample(per.duration / 2).pos, SUBJ.pos) / Math.cos(15 * DEG),
    Math.sqrt(dm.fromDistance * dm.toDistance), 0.05 * Math.sqrt(dm.fromDistance * dm.toDistance), "perceptual profile: geometric midpoint");
  assert.ok(per.sample(per.duration).p < per.sample(0).p - 10 * DEG, "pull-out rises (looks down more at the end)");
});

check("C4 zoom: camera locked, fov from the shot fov to the end framing's fov", () => {
  const tr = DEFAULT_BUILDS.get("classic.zoom");
  const p0 = tr.sample(0).pos;
  for (const t of times(tr)) assert.deepEqual(tr.sample(t).pos, p0);
  near(tr.sample(0).fov, 60, 1e-9);
  const d = dist3(p0, FR.aimPointForFraming("WS", SUBJ));
  near(tr.sample(tr.duration).fov, FR.fovForFraming("MCU", 1.8, d), 1e-9, "end fov frames MCU");
  const fovs = times(tr).map((t) => tr.sample(t).fov);
  for (let k = 1; k < fovs.length; k++) assert.ok(fovs[k] <= fovs[k - 1] + 1e-12, "monotone zoom in");
});

check("C4 truck / pedestal / crane geometry", () => {
  const tk = DEFAULT_BUILDS.get("classic.truck");
  const a = tk.sample(0), b = tk.sample(tk.duration);
  const mv = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]];
  near(Math.hypot(...mv), 3, 1e-9, "truck travel");
  const mid = tk.sample(tk.duration / 2);
  const f = QT.qToBasis(mid.q).forward;
  near((mv[0] * f[0] + mv[1] * f[1]) / 3 / Math.hypot(f[0], f[1]), 0, 1e-6, "lateral (perpendicular to the view axis mid-move)");
  const r = QT.qToBasis(mid.q).right;
  assert.ok(mv[0] * r[0] + mv[1] * r[1] > 0, "moves to the camera's right");
  const fixed = build({ technique: "classic.truck", params: { keepAim: false } }, STD);
  assert.ok(QT.qAngle(fixed.sample(0).q, fixed.sample(fixed.duration).q) < 1e-12, "keepAim false: fixed head");
  const pd = DEFAULT_BUILDS.get("classic.pedestal");
  const pa = pd.sample(0), pb = pd.sample(pd.duration);
  near(hdist(pa.pos, pb.pos), 0, 1e-9, "pedestal is vertical");
  // The start sits inside the 0.5 m soft band above the 0.7 m ground floor, which lifts it a little.
  near(pb.pos[2] - pa.pos[2], 1.5, 0.05, "rises ≈1.5 m");
  const high = build({ technique: "classic.pedestal", params: { elevationDeg: 30 } }, STD);
  near(high.sample(high.duration).pos[2] - high.sample(0).pos[2], 1.5, 1e-9, "exactly riseM clear of the ground band");
  assert.ok(pb.p < pa.p, "tilts down to keep the subject");
  const crd = DEFAULT_BUILDS.get("classic.crane");
  near(crd.sample(crd.duration).pos[2] - crd.sample(0).pos[2], 3, 0.1, "default crane rises ≈riseM (starts at hip height, in the soft ground band)");
  assert.ok(crd.sample(crd.duration).p < crd.sample(0).p - 25 * DEG, "ends looking down on the subject");
  const cr = build({ technique: "classic.crane", params: { elevationDeg: 20 } }, STD);
  const ca = cr.sample(0), cb = cr.sample(cr.duration);
  near(cb.pos[2] - ca.pos[2], 3, 1e-9, "crane rises riseM");
  const base = cr.meta.crane.base;
  near(dist3(ca.pos, base), cr.meta.crane.armM, 1e-9, "tip on the arm (start)");
  near(dist3(cr.sample(cr.duration / 3).pos, base), cr.meta.crane.armM, 1e-9, "tip on the arm (mid)");
  const swing = Math.atan2(cb.pos[0] - base[0], cb.pos[1] - base[1]) - Math.atan2(ca.pos[0] - base[0], ca.pos[1] - base[1]);
  near(GB.wrapPi(swing), 25 * DEG, 1e-9, "swings 25° about the base");
});

check("C4 pan / roll / arc deliver their sweeps", () => {
  const pan = DEFAULT_BUILDS.get("classic.pan");
  near(pan.sample(pan.duration).h - pan.sample(0).h, 30 * DEG, 1e-9, "pan −30° → 0°");
  const abs = build({ technique: "classic.pan", params: { relative: false, fromDeg: 170, toDeg: 300, pitchDeg: -10 } }, STD);
  near(abs.sample(abs.duration).h - abs.sample(0).h, 130 * DEG, 1e-9, "absolute pan crosses south continuously");
  assert.ok(validate(abs).ok && maxHeadingStep(abs) < 0.1);
  const roll = DEFAULT_BUILDS.get("classic.roll");
  near(roll.sample(roll.duration).r - roll.sample(0).r, 15 * DEG, 1e-9, "dutch 0 → 15°");
  const m = FR.compositionMetrics(roll.sample(roll.duration), SUBJ, undefined, ASPECT, { framing: "MS" });
  near(m.horizonTiltDeg, 15, 0.5, "horizon visibly tilted");
  const arc = DEFAULT_BUILDS.get("classic.arc");
  const c = FR.aimPointForFraming("MWS", SUBJ);
  const b0 = Math.atan2(arc.sample(0).pos[0] - c[0], arc.sample(0).pos[1] - c[1]);
  const b1 = Math.atan2(arc.sample(arc.duration).pos[0] - c[0], arc.sample(arc.duration).pos[1] - c[1]);
  near(GB.wrapPi(b1 - b0), 45 * DEG, 1e-9, "arc sweeps 45° clockwise");
  near(GB.wrapPi((b0 + b1) / 2 - SUBJ.heading), 0, 1e-9, "centred on the subject's front");
});

check("C4 over-the-shoulder: behind the secondary's right shoulder, long lens, subject on the right third", () => {
  const B = [SUBJ.pos[0] + Math.sin(SUBJ.heading) * 1.8, SUBJ.pos[1] + Math.cos(SUBJ.heading) * 1.8, GROUND];
  const tr = build({ technique: "classic.over-the-shoulder", params: { secondary: B } }, STD);
  assert.ok(validate(tr).ok);
  assert.equal(tr.meta.secondary.source, "param");
  const p = tr.sample(0);
  const u = [(SUBJ.pos[0] - B[0]) / 1.8, (SUBJ.pos[1] - B[1]) / 1.8];
  const rel = [p.pos[0] - B[0], p.pos[1] - B[1]];
  assert.ok(rel[0] * u[0] + rel[1] * u[1] < -0.3, "behind the secondary");
  assert.ok(rel[0] * u[1] - rel[1] * u[0] > 0.2, "on its right");
  near(p.pos[2] - GROUND, 0.82 * 1.8 + 0.12, 1e-6, "shoulder height");
  assert.ok(p.fov < 30, `long lens (fov ${p.fov})`);
  const m = FR.compositionMetrics(p, SUBJ, p.fov, ASPECT, { framing: "MCU" });
  near(m.ndc[0], 1 / 3, 0.05, "subject on the right third");
  const sh = FR.projectToNdc(p, [B[0], B[1], GROUND + 0.82 * 1.8], p.fov, ASPECT);
  assert.ok(sh.inFront && sh.x < 0, "the secondary's shoulder is in the left part of the frame (dirty single)");
  assert.ok(coverage(tr, () => SUBJ, "MCU") >= 0.95);
  const ctxSec = build({ technique: "classic.over-the-shoulder" }, { ...STD, secondary: { pos: B, height: 1.7 } });
  assert.equal(ctxSec.meta.secondary.source, "ctx");
});

check("C4 two-shot: both characters in frame for every sample, camera off the line between them", () => {
  const B = [SUBJ.pos[0] + 2.5, SUBJ.pos[1], GROUND];
  const tr = build({ technique: "classic.two-shot", params: { secondary: B } }, STD);
  assert.ok(validate(tr).ok);
  const sB = { pos: B, height: 1.8, radius: 0.45 };
  assert.ok(coverage(tr, () => SUBJ, "MWS") === 1, "subject always in frame");
  assert.ok(coverage(tr, () => sB, "MWS") === 1, "secondary always in frame");
  for (const t of times(tr)) {
    const p = tr.sample(t);
    for (const s of [SUBJ, sB]) {
      const r = FR.subjectScreenRect(p, s, p.fov, ASPECT);
      assert.ok(r.x0 > -1 && r.x1 < 1, "whole bodies fit horizontally");
    }
  }
  const p0 = tr.sample(0).pos;
  assert.ok(p0[1] < SUBJ.pos[1] - 2, "camera south of the east-running A–B line, on the anchor's side");
  near(p0[0], SUBJ.pos[0] + 1.25, 1.0, "facing the midpoint of the pair (± the 6° drift)");
  assert.equal(tr.meta.side, "right", "auto: the anchor lies to the right (south) of the subject → secondary line");
  const left = build({ technique: "classic.two-shot", params: { secondary: B, side: "left" } }, STD);
  assert.ok(left.sample(0).pos[1] > SUBJ.pos[1] + 2, "side left = north of the line");
});

check("C4 pov: eye height and heading of the subject, gentle bob only, follows a moving subject's travel", () => {
  const tr = DEFAULT_BUILDS.get("classic.pov");
  for (const t of times(tr)) {
    const p = tr.sample(t);
    near(p.pos[2] - GROUND, 0.92 * 1.8, 0.02, "eye height");
    near(p.h, SUBJ.heading, 0.5 * DEG, "subject heading");
    near(p.p, -4 * DEG, 0.6 * DEG, "pitch");
  }
  assert.equal(tr.meta.subjectIsCamera, true);
  const mv = build({ technique: "classic.pov", duration: 8 }, MOVING);
  assert.ok(validate(mv).ok);
  const p = mv.sample(4), s = walker(4), ahead = walker(4.1);
  const travel = Math.atan2(ahead.pos[0] - s.pos[0], ahead.pos[1] - s.pos[1]);
  near(GB.wrapPi(p.h - travel), 0, 5 * DEG, "looks along the travel direction");
  const zs = times(mv).filter((t) => t > 2).map((t) => mv.sample(t).pos[2]);
  assert.ok(Math.max(...zs) - Math.min(...zs) > 0.02, "walking bob present");
  assert.ok(Math.max(...zs) - Math.min(...zs) < 0.1, "bob is subtle");
});

check("C4 snorricam: rig locked to the moving subject — constant arm, subject pinned near frame centre", () => {
  const tr = build({ technique: "classic.snorricam", duration: 8 }, MOVING);
  assert.ok(validate(tr).ok);
  const arm = tr.meta.snorricam.armM;
  near(arm, 0.75, 1e-12, "0.7 m arm lengthened to the 0.45 + 0.3 m standoff");
  for (const t of times(tr)) {
    const p = tr.sample(t), s = walker(t);
    near(hdist(p.pos, s.pos), arm, 0.03, "arm length");
    const m = FR.compositionMetrics(p, s, p.fov, ASPECT, { framing: "MCU" });
    assert.ok(Math.abs(m.ndc[0]) < 0.15 && Math.abs(m.ndc[1]) < 0.25, `subject pinned (${m.ndc})`);
  }
});

check("C4 reveal-from-occluder: the occluder blocks the line of sight at the start and clears it at the end", () => {
  const occ = [SUBJ.pos[0] + Math.sin(SUBJ.heading) * 3, SUBJ.pos[1] + Math.cos(SUBJ.heading) * 3, GROUND];
  const tr = build({ technique: "classic.reveal-from-occluder", params: { occluder: occ, occluderRadius: 0.5 } }, STD);
  assert.ok(validate(tr).ok);
  const segDist = (a, b, c) => {
    const ab = [b[0] - a[0], b[1] - a[1]], ac = [c[0] - a[0], c[1] - a[1]];
    const u = Math.max(0, Math.min(1, (ab[0] * ac[0] + ab[1] * ac[1]) / (ab[0] ** 2 + ab[1] ** 2)));
    return Math.hypot(a[0] + ab[0] * u - c[0], a[1] + ab[1] * u - c[1]);
  };
  const start = tr.sample(0).pos, end = tr.sample(tr.duration).pos;
  assert.ok(segDist(start, SUBJ.pos, occ) < 0.5, "hidden at the start");
  assert.ok(segDist(end, SUBJ.pos, occ) >= 0.5 + 0.45, `revealed at the end (${segDist(end, SUBJ.pos, occ)})`);
  near(dist3(tr.sample(0.1 * tr.duration).pos, start), 0, 1e-12, "holds hidden first");
  assert.deepEqual(tr.meta.revealOccluder.pos, occ);
  assert.ok(coverage(tr, () => SUBJ, "MS") >= 0.95, "aimed at the subject throughout");
});

check("C4 angle shots: high looks down, low and worm's-eye look up from low lenses, establishing is high and wide", () => {
  for (const t of times(DEFAULT_BUILDS.get("classic.high-angle"))) assert.ok(DEFAULT_BUILDS.get("classic.high-angle").sample(t).p < -25 * DEG);
  const low = DEFAULT_BUILDS.get("classic.low-angle");
  for (const t of times(low)) {
    const p = low.sample(t);
    assert.ok(p.p > 10 * DEG, "low angle looks up");
    assert.ok(p.pos[2] - GROUND < 1.3, "lens below the waist");
  }
  const worm = DEFAULT_BUILDS.get("classic.worms-eye");
  const pw = worm.sample(0);
  assert.ok(pw.pos[2] - GROUND <= 0.8, `lens near the ground (${pw.pos[2] - GROUND})`);
  assert.ok(pw.p > 35 * DEG, `steep look-up (${pw.p / DEG}°)`);
  const spin = build({ technique: "classic.worms-eye", params: { spinDeg: 90 } }, STD);
  near(spin.sample(spin.duration).r - spin.sample(0).r, 90 * DEG, 1e-9, "spin rolls the sky");
  const est = DEFAULT_BUILDS.get("classic.establishing");
  for (const t of times(est)) {
    const p = est.sample(t);
    assert.ok(p.pos[2] - GROUND >= 24.9, "high");
    assert.ok(hdist(p.pos, SUBJ.pos) > 70, "wide");
  }
});

check("C4 handheld: seeded, bounded shake on top of the base; same seed = same take, other seed differs", () => {
  const a = build({ technique: "classic.handheld", seed: 11 }, STD);
  const b = build({ technique: "classic.handheld", seed: 11 }, STD);
  const c = build({ technique: "classic.handheld", seed: 12 }, STD);
  assert.equal(TR.bakeTrajectory(a, 30).checksum, TR.bakeTrajectory(b, 30).checksum);
  assert.notEqual(TR.bakeTrajectory(a, 30).checksum, TR.bakeTrajectory(c, 30).checksum);
  const calm = build({ technique: "classic.handheld", seed: 11, params: { amplitudeDeg: 0, posAmplitude: 0 } }, STD);
  let maxAng = 0, maxPos = 0;
  for (const t of times(a)) {
    maxAng = Math.max(maxAng, QT.qAngle(a.sample(t).q, calm.sample(t).q));
    maxPos = Math.max(maxPos, dist3(a.sample(t).pos, calm.sample(t).pos));
  }
  // |dh|, |dp| ≤ amplitude, |dr| ≤ amplitude/2 → the rotation between shaken and calm ≤ 2.5 × amplitude.
  assert.ok(maxAng > 0.05 * DEG && maxAng <= 2.5 * 0.6 * DEG, `angular shake ${maxAng / DEG}°`);
  assert.ok(maxPos > 0.001 && maxPos <= Math.sqrt(3) * 0.03 + 1e-9, `positional shake ${maxPos} m`);
  let wobble = 0;
  for (const t of times(a)) {
    const m = FR.compositionMetrics(a.sample(t), SUBJ, undefined, ASPECT, { framing: "MS" });
    wobble = Math.max(wobble, m.centerError);
  }
  assert.ok(wobble > 0.01 && wobble < 0.3, `the subject wobbles visibly but stays near centre (${wobble})`);
  const push = build({ technique: "classic.handheld", framing: "FS", params: { base: "push-in" } }, STD);
  assert.ok(hdist(push.sample(push.duration).pos, SUBJ.pos) < hdist(push.sample(0).pos, SUBJ.pos) - 0.4, "push-in base");
  const tight = build({ technique: "classic.handheld", params: { base: "push-in", pushM: 5 } }, STD);
  for (const t of times(tight)) assert.ok(dist3(tight.sample(t).pos, FR.aimPointForFraming("MS", SUBJ)) > 0.75 - 0.06, "push stops at the standoff");
});

check("C4 steadicam: floating walk with gait bob on a moving subject, glide on a static one", () => {
  const mv = build({ technique: "classic.steadicam", duration: 10 }, MOVING);
  assert.ok(validate(mv).ok);
  assert.ok(coverage(mv, walker, "MWS") >= 0.95);
  const d = mv.meta.rig.distance, glide = mv.meta.steadicam.glideM;
  assert.ok(glide > 0 && glide <= 0.8, "glide limited by the standoff");
  for (const t of times(mv)) {
    const want = d - glide * EASE.sineInOut(t / mv.duration);
    const ratio = dist3(mv.sample(t).pos, FR.aimPointForFraming("MWS", walker(t))) / want;
    assert.ok(ratio > 0.85 && ratio < 1.15, `distance ratio ${ratio} at t=${t}`);
  }
  const zs = times(mv).filter((t) => t > 2).map((t) => mv.sample(t).pos[2]);
  assert.ok(Math.max(...zs) - Math.min(...zs) > 0.01, "gait bob while walking");
  const st = DEFAULT_BUILDS.get("classic.steadicam");
  const g0 = hdist(st.sample(0).pos, SUBJ.pos), g1 = hdist(st.sample(st.duration).pos, SUBJ.pos);
  assert.ok(st.meta.steadicam.glideM > 0.3, "glide (0.8 m asked, limited by the 0.75 m standoff from MWS)");
  assert.ok(g0 - g1 > 0.9 * st.meta.steadicam.glideM, `glides closer (${g0} → ${g1})`);
  assert.ok(validate(st).ok);
});

check("C4 time-lapse and hyperlapse: meta.timeLapse {rate}; time-lapse locked, hyperlapse moves", () => {
  const tl = build({ technique: "classic.time-lapse", params: { rate: 0.05 } }, STD);
  assert.deepEqual(tl.meta.timeLapse, { rate: 0.05, unit: "game-days/s" });
  const p0 = tl.sample(0);
  for (const t of times(tl)) assert.ok(dist3(tl.sample(t).pos, p0.pos) === 0 && QT.qAngle(tl.sample(t).q, p0.q) < 1e-12, "locked");
  for (const move of ["truck", "push", "arc"]) {
    const hl = build({ technique: "classic.hyperlapse", params: { move, moveM: 10 } }, STD);
    assert.equal(hl.meta.timeLapse.rate, 0.02);
    assert.ok(validate(hl).ok, move);
    assert.ok(dist3(hl.sample(0).pos, hl.sample(hl.duration).pos) > 2, `${move} moves`);
    assert.ok(coverage(hl, () => SUBJ, "WS") >= 0.95, `${move} keeps the subject`);
    const steps = [];
    for (let k = 1; k <= 8; k++) steps.push(dist3(hl.sample((hl.duration * k) / 8).pos, hl.sample((hl.duration * (k - 1)) / 8).pos));
    // Linear ease → steady travel (the push ends inside the soft ground band, which bends z by < 0.5%).
    if (move !== "arc") for (const s of steps) near(s, steps[0], 0.005 * steps[0], `${move} steady (linear ease)`);
  }
});

check("C4 moving subject with fixed rigs: the head follows (static / dolly / orbit keep the subject in frame)", () => {
  const slow = (t) => ({ pos: [1000 + 0.4 * t, 2000, GROUND], height: 1.8, radius: 0.45, heading: 0.6 });
  const ctx = { subjectAt: slow, groundZ: () => GROUND };
  for (const id of ["classic.static", "classic.dolly-in", "classic.orbit", "classic.rack-focus", "classic.high-angle"]) {
    const tr = build({ technique: id }, ctx);
    assert.ok(validate(tr).ok, id);
    assert.ok(coverage(tr, slow, tr.meta.spec.framing) >= 0.95, id);
  }
});

// ---------------------------------------------------------------------------
// C5 exported helpers + three cross-check
// ---------------------------------------------------------------------------

check("C5 followSpring: zero steady lag with full feed-forward, (1−ff)·v·T lag otherwise, smooth start/stop", () => {
  const D = 6;
  const target = (t) => [2 * t, 0, 0];
  const full = CL.followSpring(target, D, { smoothTime: 0.5, feedForward: 1 });
  for (const t of [0, 1.3, 3, 6]) near(full.at(t)[0], 2 * t, 1e-9, "no lag");
  const half = CL.followSpring(target, D, { smoothTime: 0.5, feedForward: 0.5 });
  for (const t of [0, 2, 6]) near(half.at(t)[0], 2 * t - 0.5 * 2 * 0.5, 1e-9, "steady lag (1−ff)·v·T");
  near(half.velocityAt(3)[0], 2, 1e-9, "velocity");
  const jump = (t) => [t < 1 ? 0 : 5, 0, 0];
  const plain = CL.followSpring(jump, D, { smoothTime: 0.4, feedForward: 0 });
  let maxX = -Infinity;
  for (let t = 0; t <= D; t += 0.01) maxX = Math.max(maxX, plain.at(t)[0]);
  assert.ok(maxX <= 5 + 1e-6, `critically damped without feed-forward: no overshoot (${maxX})`);
  near(plain.at(D)[0], 5, 1e-3, "settles");
  const snapped = CL.followSpring(jump, D, { smoothTime: 0.4, feedForward: 1 });
  let maxS = -Infinity;
  for (let t = 0; t <= D; t += 0.01) maxS = Math.max(maxS, snapped.at(t)[0]);
  assert.ok(maxS <= 5 * 1.1, `a 5 m position snap is not launched past by the feed-forward (peak ${maxS})`);
  near(snapped.at(D)[0], 5, 1e-3, "settles");
  const fast = CL.followSpring((t) => [40 * t, 0, 0], D, { smoothTime: 0.5, maxFeedSpeed: 30 });
  near(fast.at(3)[0], 120 - 2 * (40 - 30) / 4, 1e-6, "feed-forward capped at maxFeedSpeed: the excess 10 m/s lags 2·Δv/ω");
  const rigid = CL.followSpring(target, D, { smoothTime: 0 });
  near(rigid.at(2.5)[0], 5, 1e-9, "smoothTime 0 = the target");
  assert.deepEqual(CL.followSpring(() => [1, 2, 3], 0).at(5), [1, 2, 3], "zero duration");
  assert.throws(() => CL.followSpring(() => [NaN, 0, 0], 1), (e) => e instanceof FilmShotError);
  assert.throws(() => CL.followSpring(null, 1), (e) => e instanceof FilmShotError);
});

check("C5 travelHeadingTrack: travel direction when moving, facing when still, continuous through ±π", () => {
  const east = CL.travelHeadingTrack({ subjectAt: (t) => ({ pos: [t * 2, 0, 0], height: 1.8, radius: 0.45 }) }, 4);
  near(east.headingAt(2), Math.PI / 2, 1e-6, "east");
  near(east.speedAt(3), 2, 1e-3, "speed");
  const still = CL.travelHeadingTrack({ subject: { pos: [0, 0, 0], height: 1.8, radius: 0.45, heading: 1.2 } }, 3);
  near(still.headingAt(1.5), 1.2, 1e-12, "facing");
  near(still.speedAt(1.5), 0, 1e-12);
  const circle = CL.travelHeadingTrack({ subjectAt: (t) => ({ pos: [10 * Math.sin(0.5 * t), 10 * Math.cos(0.5 * t), 0], height: 1.8, radius: 0.45 }) }, 20);
  let prev = circle.headingAt(0), maxStep = 0;
  for (let t = 0.05; t <= 20; t += 0.05) {
    const h = circle.headingAt(t);
    maxStep = Math.max(maxStep, Math.abs(h - prev));
    prev = h;
  }
  assert.ok(maxStep < 0.05, "no wrap jumps");
  assert.ok(circle.headingAt(20) - circle.headingAt(0) > 8, "unwrapped over > 1 turn");
});

check("C5 frontBearing: heading > anchor side > sun > north", () => {
  const s = { pos: [0, 0, 0] };
  near(CL.frontBearing({}, { ...s, heading: 2 }), 2, 0);
  near(CL.frontBearing({ anchor: [5, 0, 0] }, s), Math.PI / 2, 1e-12);
  near(CL.frontBearing({ anchor: [0.2, 0.2, 0], sun: { h: -1, p: 0.3 } }, s), -1, 0);
  near(CL.frontBearing({}, s), 0, 0);
});

check("C5 classic poses in REAL three 0.184 cameras: bird's-eye looks down with image-up = heading; NDC parity", () => {
  const cam = new THREE.PerspectiveCamera(60, ASPECT, 0.1, 5000);
  const place = (pose) => {
    cam.position.set(...GB.acToThreePos(pose.pos));
    cam.quaternion.set(...GB.acQuatToThree(pose.q));
    cam.fov = pose.fov;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  };
  const be = build({ technique: "classic.birds-eye", params: { rotateDeg: 90 } }, STD);
  for (const t of [0, be.duration / 2, be.duration]) {
    const pose = be.sample(t);
    place(pose);
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    near(dir.y, -1, 1e-9, "three camera looks straight down");
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    near(up.x, Math.sin(pose.h), 1e-9, "image-up x = sin h");
    near(up.z, -Math.cos(pose.h), 1e-9, "image-up = AC heading (three z = −north)");
  }
  for (const id of ["classic.roll", "classic.over-the-shoulder", "classic.low-angle", "classic.handheld", "classic.tracking-side"]) {
    const tr = DEFAULT_BUILDS.get(id);
    for (const t of [0, tr.duration * 0.5, tr.duration]) {
      const pose = tr.sample(t);
      place(pose);
      const aim = FR.aimPointForFraming(tr.meta.spec.framing, SUBJ);
      const v = new THREE.Vector3(...GB.acToThreePos(aim)).project(cam);
      const P = FR.projectToNdc(pose, aim, pose.fov, ASPECT);
      near(P.x, v.x, 1e-6, `${id} ndc x`);
      near(P.y, v.y, 1e-6, `${id} ndc y`);
      assert.ok(Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1, `${id} subject on screen in three`);
    }
  }
});

// The take player re-anchors live-subject takes to the subject every frame (review math-0 /
// contracts-0): the rigs are built against a PURE reference track (index.js: the prepare-time
// pose, extrapolated by its velocity from 0.3 m/s), and the take player assumes the travel
// heading they were built for is atan2(v) on a moving reference, else the subject's heading,
// else frontBearing (anchor side, then the sun). These checks pin that contract.
check("live-subject contract: tracking rigs on a pure reference track are pure in t and keyed to the heading the take player assumes", () => {
  const v = [3, -1, 0];
  const s0 = { pos: SUBJ.pos.slice(), height: 1.8, radius: 0.45, heading: 0.6 };
  const ref = (t) => ({ ...s0, pos: [s0.pos[0] + v[0] * t, s0.pos[1] + v[1] * t, s0.pos[2]] });
  const ctx = RG.ctxDefaults({ subject: s0, subjectAt: ref, groundZ: () => GROUND, aspect: ASPECT });
  const track = CL.travelHeadingTrack(ctx, 8);
  for (const t of [0, 1.3, 4, 8]) near(track.headingAt(t), Math.atan2(v[0], v[1]), 1e-9, `moving reference heading at t=${t}`);
  for (const id of ["classic.tracking-follow", "classic.tracking-side", "classic.steadicam"]) {
    const tr = RG.buildShot({ technique: id, duration: 8 }, { subject: s0, subjectAt: ref, groundZ: () => GROUND, aspect: ASPECT });
    const a = tr.sample(3.7), b = tr.sample(3.7);
    assert.deepEqual(a, b, `${id}: random access is pure`);
    // constant velocity is tracked without lag (feedForward 1): the rig rides with the reference
    const p0 = tr.sample(1).pos, p1 = tr.sample(6).pos;
    near(p1[0] - p0[0], v[0] * 5, 0.05 * Math.hypot(v[0], v[1]) * 5 + 0.3, `${id} dx`);
    near(p1[1] - p0[1], v[1] * 5, 0.05 * Math.hypot(v[0], v[1]) * 5 + 0.3, `${id} dy`);
  }
  // a standing reference: its heading, else the anchor side, else the sun's bearing
  const still = RG.ctxDefaults({ subject: s0, groundZ: () => GROUND });
  near(CL.travelHeadingTrack(still, 4).headingAt(2), 0.6, 1e-9, "standing: the subject's heading");
  const bare = { pos: SUBJ.pos.slice(), height: 1.8, radius: 0.45 };
  near(CL.frontBearing({ anchor: [bare.pos[0] - 10, bare.pos[1], bare.pos[2]], sun: { h: 1.2, p: 0.3 } }, bare), -Math.PI / 2, 1e-12, "anchor side first");
  near(CL.frontBearing({ anchor: bare.pos.slice(), sun: { h: 1.2, p: 0.3 } }, bare), 1.2, 1e-12, "then the sun side");
  const sunCtx = RG.ctxDefaults({ subject: bare, sun: { h: 1.2, p: 0.3 }, groundZ: () => GROUND });
  near(CL.travelHeadingTrack(sunCtx, 4).headingAt(2), 1.2, 1e-9, "an unheaded standing subject is keyed to the sun side");
});

console.log(`film_shots_classic: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
