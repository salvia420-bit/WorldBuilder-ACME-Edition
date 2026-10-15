// tests/film_registry.test.mjs
//
// WHY: in AC Film Mode the director (a Claude Code session) writes shots as
// JSON — `{technique:'drone.orbit-poi', duration:8, params:{radius:30}}` — and
// technique ids/params are API. The registry is the only gate between that
// untrusted JSON and technique code: unknown techniques, unknown / mistyped /
// out-of-range / bad-enum params must fail with READABLE FilmShotErrors the
// director can fix, defaults must be filled, the technique's needs (subject,
// path, indoor/outdoor) enforced, the RNG seeded deterministically from the
// spec, and the catalog (`film techniques`, `__film.techniques()`) must be
// JSON-serialisable. This suite EXECUTES scene3d/film/shots/registry.js and
// shots/index.js and proves:
//   R1  defineTechnique validation + defaults (needs, bounds, capture, reveal);
//   R2  isolated registries, duplicates, replace, lookups;
//   R3  buildShot validation: unknown technique (with suggestions), bad spec,
//       out-of-range, wrong type, integer, enum, vec3, unknown/required params,
//       duration / fov / roll (radians) / ease / framing / bounds;
//   R4  defaults filled into the normalised spec the technique receives;
//       context defaults (groundZ → null fn, aspect 16/9, fps 30, rng, anchor,
//       subjectAt); needs enforcement;
//   R5  result stamping (technique, family, bounds precedence, subject, meta),
//       build failures wrapped, determinism of seeded builds;
//   R6  listTechniques JSON round trip, family filter; shots/index.js exports
//       and registers every shipped technique (catalog ids unique, families
//       match prefixes, catalog JSON-safe) — classic/drone lanes add entries;
//   R7  `list` params (fpv.fpv-run zones / tricks): item schema + per-type
//       variants + optional fields + a cross-field check, validated in
//       defineTechnique and buildShot with readable BAD_PARAMs that name the
//       list (details.param) and the item path, defaults deep-copied, and the
//       item schema in the JSON catalog.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its pure shot modules.
// Run from apps/holtburger-web/: node tests/film_registry.test.mjs

import assert from "node:assert/strict";

const RG = await import("../scene3d/film/shots/registry.js");
const TR = await import("../scene3d/film/shots/trajectory.js");
const FR = await import("../scene3d/film/shots/framing.js");
const SH = await import("../scene3d/film/shots/index.js");
const { FilmShotError, FilmError } = await import("../scene3d/film/core/errors.js");

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
/** Matcher: FilmShotError with the code and (optionally) a message pattern. */
function shotErr(code, re) {
  return (e) => {
    assert.ok(e instanceof FilmShotError, `expected FilmShotError, got ${e && e.name}: ${e && e.message}`);
    assert.equal(e.code, code, `code (message: ${e.message})`);
    if (re) assert.match(e.message, re);
    return true;
  };
}

/** smootherstep, local to the test technique. */
const smooth = (u) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (x * (6 * x - 15) + 10);
};

/**
 * A realistic test technique build: a dolly toward the subject's framing aim
 * point (eased), ground-clamped via clampToEnvelope, looking at the aim point,
 * with a seeded lateral jitter drawn from ctx.rng (to test determinism).
 */
function buildDolly(spec, ctx) {
  const s = ctx.subject;
  const endD = FR.distanceForFraming(spec.params.endFraming, s.height, spec.fov);
  const aim = TR.aimSubject(ctx, spec.framing);
  const j = spec.params.jitter * (ctx.rng() - 0.5);
  return TR.makeTrajectory({
    technique: spec.technique,
    duration: spec.duration,
    positionAt: (t) => {
      const d = spec.params.startDistance + (endD - spec.params.startDistance) * smooth(t / spec.duration);
      const a = aim(t);
      return TR.clampToEnvelope([a[0] + j + spec.params.offset[0], a[1] - d, a[2]], ctx);
    },
    orientAt: TR.orientLookAt(aim, { roll: spec.roll }),
    fov: spec.fov,
    subject: s,
  });
}

/** Definition of the test technique (overridable fields). */
function dollyDef(over = {}) {
  return {
    id: "classic.test-dolly",
    name: "Test dolly",
    description: "Moves straight toward the subject.",
    whenToUse: "Unit tests of the registry.",
    params: {
      startDistance: { type: "number", default: 8, min: 1, max: 50, unit: "m", desc: "Distance from the subject at the start." },
      endFraming: { type: "enum", values: ["MS", "MCU", "CU"], default: "MCU", desc: "Framing at the end of the move." },
      side: { type: "enum", values: ["left", "front", "right"], default: "front", desc: "Approach side." },
      jitter: { type: "number", default: 0, min: 0, max: 1, desc: "Seeded lateral jitter amplitude (m)." },
      steps: { type: "number", integer: true, default: 4, min: 1, max: 10, desc: "Integer knob." },
      lockRoll: { type: "boolean", default: true, desc: "Keep the horizon level." },
      label: { type: "string", default: "A", desc: "Free text." },
      offset: { type: "vec3", default: [0, 0, 0], desc: "World offset of the aim point." },
    },
    needs: { subject: true },
    defaultBounds: { maxLateral: 0.75 },
    defaultDuration: 5,
    build: buildDolly,
    ...over,
  };
}

/** An isolated registry holding the test technique. */
function fresh(defOver) {
  const reg = RG.createRegistry();
  reg.registerTechnique(dollyDef(defOver));
  return reg;
}
const SUBJECT = { pos: [100, 200, 10], height: 1.8, radius: 0.45 };
const CTX = { subject: SUBJECT, groundZ: () => 10 };

// ---------------------------------------------------------------------------
// R1 definitions
// ---------------------------------------------------------------------------

check("R1 defineTechnique fills defaults and freezes; catalog-relevant fields normalised", () => {
  const d = RG.defineTechnique({ id: "drone.test-min", name: "Min", description: "d", whenToUse: "w", build: () => null });
  assert.equal(d.family, "drone");
  assert.deepEqual({ ...d.needs }, { subject: false, path: false, indoor: null });
  assert.deepEqual({ ...d.defaultBounds }, { ...TR.DEFAULT_BOUNDS });
  assert.deepEqual({ ...d.params }, {});
  assert.equal(d.capture, "stepped");
  assert.equal(d.reveal, false);
  assert.deepEqual([...d.tags], []);
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.params) && Object.isFrozen(d.needs) && Object.isFrozen(d.defaultBounds));
  const full = RG.defineTechnique(dollyDef({ defaultFraming: "cu", tags: ["push"], capture: "realtime", reveal: true }));
  assert.equal(full.defaultFraming, "CU");
  assert.equal(full.defaultBounds.maxLateral, 0.75);
  assert.equal(full.defaultBounds.maxRise, TR.DEFAULT_BOUNDS.maxRise);
  assert.deepEqual([...full.params.offset.default], [0, 0, 0]);
  assert.ok(Object.isFrozen(full.params.offset.default));
  assert.deepEqual(RG.defineTechnique(full), full, "idempotent on normalised defs");
});

check("R1 defineTechnique rejects malformed definitions with readable BAD_TECHNIQUE_DEF errors", () => {
  const base = dollyDef();
  const cases = [
    [{ id: "classic.Dolly" }, /id must look like/],
    [{ id: "cinema.dolly" }, /id must look like/],
    [{ id: 42 }, /id must look like/],
    [{ family: "drone" }, /family "drone" must match the id prefix "classic"/],
    [{ name: "" }, /name must be a non-empty string/],
    [{ whenToUse: undefined }, /whenToUse must be a non-empty string/],
    [{ build: undefined }, /build\(spec, ctx\)/],
    [{ params: { x: { type: "number", default: 1 } } }, /param "x": desc .* is required/],
    [{ params: { x: { type: "float", desc: "d" } } }, /type must be one of number \| string \| boolean \| enum \| vec3/],
    [{ params: { x: { type: "enum", desc: "d" } } }, /enum params need a non-empty values array/],
    [{ params: { x: { type: "enum", desc: "d", values: ["a", "a"] } } }, /unique/],
    [{ params: { x: { type: "enum", desc: "d", values: ["a"], default: "b" } } }, /default is invalid/],
    [{ params: { x: { type: "number", desc: "d", min: 2, max: 1 } } }, /min 2 > max 1/],
    [{ params: { x: { type: "number", desc: "d", min: 0, max: 1, default: 5 } } }, /default is invalid/],
    [{ params: { x: { type: "boolean", desc: "d", default: "yes" } } }, /default is invalid/],
    [{ params: { x: { type: "vec3", desc: "d", default: [1, 2] } } }, /default is invalid/],
    [{ params: { x: { type: "string", desc: "d", min: 1 } } }, /min is only valid for number params/],
    [{ params: { x: { type: "number", desc: "d", values: [1] } } }, /values is only valid for enum params/],
    [{ params: { "bad name": { type: "number", desc: "d" } } }, /name must be an identifier/],
    [{ needs: { subjects: true } }, /unknown needs key "subjects"/],
    [{ needs: { indoor: "maybe" } }, /needs.indoor must be true, false or null/],
    [{ defaultBounds: { maxRise: -1 } }, /defaultBounds: bounds.maxRise/],
    [{ defaultDuration: 0 }, /defaultDuration/],
    [{ defaultFov: 175 }, /defaultFov/],
    [{ defaultEase: "bounce" }, /defaultEase "bounce" is not an easing/],
    [{ defaultFraming: "XXL" }, /defaultFraming: unknown framing/],
    [{ capture: "live" }, /capture must be stepped \| realtime/],
    [{ tags: ["ok", ""] }, /tags must be an array/],
  ];
  for (const [over, re] of cases) {
    assert.throws(() => RG.defineTechnique({ ...base, ...over }), shotErr("BAD_TECHNIQUE_DEF", re), JSON.stringify(over));
  }
  assert.throws(() => RG.defineTechnique(null), shotErr("BAD_TECHNIQUE_DEF"));
});

// ---------------------------------------------------------------------------
// R2 registries
// ---------------------------------------------------------------------------

check("R2 isolated registries; duplicate ids throw unless replace; lookups", () => {
  const reg = fresh();
  assert.equal(reg.size(), 1);
  assert.equal(reg.hasTechnique("classic.test-dolly"), true);
  assert.deepEqual(reg.techniqueIds(), ["classic.test-dolly"]);
  assert.equal(reg.getTechnique("classic.test-dolly").name, "Test dolly");
  assert.equal(reg.getTechnique("classic.nope"), null);
  assert.equal(reg.getTechnique(undefined), null);
  assert.throws(() => reg.registerTechnique(dollyDef()), shotErr("DUPLICATE_TECHNIQUE", /already registered/));
  const replaced = reg.registerTechnique(dollyDef({ name: "Dolly v2" }), { replace: true });
  assert.equal(replaced.name, "Dolly v2");
  assert.equal(reg.getTechnique("classic.test-dolly").name, "Dolly v2");
  assert.equal(RG.createRegistry().size(), 0, "registries are independent");
  assert.equal(RG.getTechnique("classic.test-dolly"), null, "default registry untouched");
});

// ---------------------------------------------------------------------------
// R3 buildShot validation
// ---------------------------------------------------------------------------

check("R3 unknown technique → UNKNOWN_TECHNIQUE with suggestions; malformed spec → BAD_SPEC", () => {
  const reg = fresh();
  assert.throws(() => reg.buildShot({ technique: "classic.test-doly", duration: 3 }, CTX),
    shotErr("UNKNOWN_TECHNIQUE", /unknown technique "classic.test-doly" \(did you mean "classic.test-dolly"\?\)/));
  try {
    reg.buildShot({ technique: "drone.warp-drive", duration: 3 }, CTX);
    assert.fail("should throw");
  } catch (e) {
    assert.equal(e.code, "UNKNOWN_TECHNIQUE");
    assert.deepEqual(e.details.suggestions, []);
    assert.match(e.message, /1 techniques are registered; see listTechniques\(\)/);
    assert.ok(e instanceof FilmError);
    assert.deepEqual(JSON.parse(JSON.stringify(e.toJSON())).code, "UNKNOWN_TECHNIQUE");
  }
  assert.throws(() => reg.buildShot(null, CTX), shotErr("BAD_SPEC"));
  assert.throws(() => reg.buildShot([], CTX), shotErr("BAD_SPEC"));
  assert.throws(() => reg.buildShot({ duration: 3 }, CTX), shotErr("BAD_SPEC", /spec.technique must be a technique id string/));
});

check("R3 param validation: out-of-range, wrong type, integer, enum, vec3, unknown and required params", () => {
  const reg = fresh();
  const b = (params) => reg.buildShot({ technique: "classic.test-dolly", duration: 3, params }, CTX);
  assert.throws(() => b({ startDistance: 80 }), shotErr("BAD_PARAM", /param "startDistance" must be in \[1, 50\] m \(got 80\)/));
  assert.throws(() => b({ startDistance: 0.5 }), shotErr("BAD_PARAM", /in \[1, 50\]/));
  assert.throws(() => b({ startDistance: "8" }), shotErr("BAD_PARAM", /must be a finite number \(got "8"\)/));
  assert.throws(() => b({ startDistance: NaN }), shotErr("BAD_PARAM", /finite number/));
  assert.throws(() => b({ steps: 2.5 }), shotErr("BAD_PARAM", /must be an integer/));
  assert.throws(() => b({ lockRoll: 1 }), shotErr("BAD_PARAM", /must be true or false \(got 1\)/));
  assert.throws(() => b({ label: 5 }), shotErr("BAD_PARAM", /must be a string/));
  assert.throws(() => b({ endFraming: "ECU" }), shotErr("BAD_PARAM", /must be one of "MS" \| "MCU" \| "CU" \(got "ECU"\)/));
  assert.throws(() => b({ offset: [1, 2] }), shotErr("BAD_PARAM", /finite \[x, y, z\]/));
  assert.throws(() => b({ offset: [1, 2, NaN] }), shotErr("BAD_PARAM", /finite \[x, y, z\]/));
  assert.throws(() => b({ startDistanse: 5 }), shotErr("BAD_PARAM", /unknown param "startDistanse" \(did you mean "startDistance"\?\)/));
  assert.throws(() => b("fast"), shotErr("BAD_PARAM", /params must be an object/));
  try {
    b({ startDistance: 80 });
  } catch (e) {
    assert.deepEqual(e.details, { technique: "classic.test-dolly", param: "startDistance", value: 80, min: 1, max: 50 });
  }
  const req = RG.createRegistry();
  req.registerTechnique(dollyDef({ id: "classic.test-req", params: { radius: { type: "number", min: 1, desc: "Orbit radius." } }, needs: {} }));
  assert.throws(() => req.buildShot({ technique: "classic.test-req", duration: 3 }), shotErr("BAD_PARAM", /param "radius" is required \(Orbit radius.\)/));
});

check("R3 spec fields: duration, fov, roll (radians), ease, framing, bounds", () => {
  const reg = fresh({ defaultDuration: undefined });
  const b = (spec) => reg.buildShot({ technique: "classic.test-dolly", duration: 3, ...spec }, CTX);
  assert.throws(() => b({ duration: undefined }), shotErr("BAD_SPEC", /duration must be a number in \(0, 600\]/));
  assert.throws(() => b({ duration: 0 }), shotErr("BAD_SPEC", /duration/));
  assert.throws(() => b({ duration: 601 }), shotErr("BAD_SPEC", /duration/));
  assert.throws(() => b({ duration: "5" }), shotErr("BAD_SPEC", /duration/));
  assert.throws(() => b({ fov: 0 }), shotErr("BAD_SPEC", /fov must be a number in \[1, 170\]/));
  assert.throws(() => b({ roll: 15 }), shotErr("BAD_SPEC", /roll must be a number of RADIANS/));
  assert.throws(() => b({ ease: "bouncy" }), shotErr("BAD_SPEC", /ease "bouncy" is not an easing/));
  assert.throws(() => b({ framing: "XL" }), shotErr("BAD_SPEC", /unknown framing "XL"/));
  assert.throws(() => b({ bounds: { maxRise: -2 } }), shotErr("BAD_SPEC", /bounds.maxRise/));
  assert.throws(() => b({ bounds: { lateral: 1 } }), shotErr("BAD_SPEC", /unknown bounds key "lateral"/));
  const withDefault = fresh();
  assert.equal(withDefault.buildShot({ technique: "classic.test-dolly" }, CTX).duration, 5, "technique defaultDuration");
});

// ---------------------------------------------------------------------------
// R4 defaults + context
// ---------------------------------------------------------------------------

check("R4 the technique receives a normalised spec with every default filled", () => {
  const reg = RG.createRegistry();
  let seen = null;
  const def = dollyDef({ build: (spec, ctx) => { seen = { spec, ctx }; return buildDolly(spec, ctx); } });
  reg.registerTechnique(def);
  reg.buildShot({ technique: "classic.test-dolly", duration: 4, params: { startDistance: 12 }, framing: "mcu", id: "shot-7" }, CTX);
  const s = seen.spec;
  assert.deepEqual(s.params, { startDistance: 12, endFraming: "MCU", side: "front", jitter: 0, steps: 4, lockRoll: true, label: "A", offset: [0, 0, 0] });
  assert.equal(s.technique, "classic.test-dolly");
  assert.equal(s.duration, 4);
  assert.equal(s.framing, "MCU");
  assert.equal(s.fov, 60);
  assert.equal(s.roll, 0);
  assert.equal(s.ease, "sineInOut");
  assert.equal(s.id, "shot-7");
  assert.ok(Number.isInteger(s.seed) && s.seed >= 0 && s.seed < 2 ** 32);
  s.params.offset[0] = 99;
  assert.deepEqual([...reg.getTechnique("classic.test-dolly").params.offset.default], [0, 0, 0], "defaults are copied, not shared");
  const reg2 = RG.createRegistry();
  reg2.registerTechnique(dollyDef({ defaultFov: 35, defaultEase: "cubicInOut", defaultFraming: "CU",
    build: (spec, ctx) => { seen = { spec, ctx }; return buildDolly(spec, ctx); } }));
  reg2.buildShot({ technique: "classic.test-dolly", duration: 2 }, CTX);
  assert.equal(seen.spec.fov, 35);
  assert.equal(seen.spec.ease, "cubicInOut");
  assert.equal(seen.spec.framing, "CU");
});

check("R4 ctxDefaults: null groundZ fn, aspect 16/9, fps 30, anchor, subjectAt, seeded rng, indoor, sun", () => {
  const c = RG.ctxDefaults({});
  assert.equal(c.groundZ(1, 2), null);
  assert.equal(c.aspect, 16 / 9);
  assert.equal(c.fps, 30);
  assert.deepEqual(c.anchor, [0, 0, 0]);
  assert.equal(c.subject, null);
  assert.equal(c.subjectAt, null);
  assert.equal(c.indoor, null);
  assert.equal(c.path, undefined);
  assert.equal(c.sun, undefined);
  assert.equal(typeof c.rng, "function");
  const r1 = RG.ctxDefaults({}, { technique: "classic.x", seed: 42 });
  const r2 = RG.ctxDefaults({}, { technique: "classic.x", seed: 42 });
  assert.equal(r1.seed, 42);
  assert.deepEqual([r1.rng(), r1.rng(), r1.rng()], [r2.rng(), r2.rng(), r2.rng()], "seeded from spec.seed");
  const h1 = RG.ctxDefaults({}, { technique: "classic.x", duration: 3 });
  const h2 = RG.ctxDefaults({}, { duration: 3, technique: "classic.x" });
  const h3 = RG.ctxDefaults({}, { technique: "classic.x", duration: 4 });
  assert.equal(h1.seed, h2.seed, "hash of the spec ignores key order");
  assert.notEqual(h1.seed, h3.seed);
  const g = RG.ctxDefaults({ groundZ: (x) => (x > 0 ? 5 : x < 0 ? NaN : (() => { throw new Error("no data"); })()) });
  assert.equal(g.groundZ(1, 0), 5);
  assert.equal(g.groundZ(-1, 0), null);
  assert.equal(g.groundZ(0, 0), null, "throwing callback → null");
  const m = RG.ctxDefaults({ subject: { pos: [1, 2, 3], height: 2, velocity: [1, 0, 0], heading: "east" }, aspect: 2.39, fps: 24, sun: { h: 1, p: 0.5 } });
  assert.deepEqual(m.anchor, [1, 2, 3]);
  assert.equal(m.subject.heading, undefined, "non-numeric heading dropped");
  assert.deepEqual(m.subjectAt(2).pos, [3, 2, 3], "velocity extrapolation");
  assert.equal(m.aspect, 2.39);
  assert.equal(m.fps, 24);
  assert.deepEqual(m.sun, { h: 1, p: 0.5 });
  const fnOnly = RG.ctxDefaults({ subjectAt: (t) => ({ pos: [t, 0, 0] }) });
  assert.deepEqual(fnOnly.subject.pos, [0, 0, 0], "subject from subjectAt(0)");
  assert.deepEqual(fnOnly.subjectAt(4).pos, [4, 0, 0]);
  assert.equal(fnOnly.subjectAt(4).height, 1.8, "normalised");
  const fromSpec = RG.ctxDefaults({}, { subject: { pos: [5, 5, 5] } });
  assert.deepEqual(fromSpec.subject.pos, [5, 5, 5]);
  assert.equal(RG.ctxDefaults({}, { subject: "player" }).subject, null, "a subject REFERENCE is left for the runtime");
  const ind = RG.ctxDefaults({ indoor: { route: [[0, 0, 0], [5, 0, 0]], ceiling: () => 4, floor: () => "x" }, path: [[1, 1, 1], [2, 2, 2]] });
  assert.deepEqual(ind.indoor.route, [[0, 0, 0], [5, 0, 0]]);
  assert.equal(ind.indoor.ceiling(0, 0), 4);
  assert.equal(ind.indoor.floor(0, 0), null);
  assert.deepEqual(ind.anchor, [1, 1, 1], "anchor from the path");
  assert.throws(() => RG.ctxDefaults({ path: [[0, 0, 0], [1, NaN, 0]] }), shotErr("BAD_CONTEXT", /ctx.path\[1\]/));
  assert.throws(() => RG.ctxDefaults({ anchor: [1, 2] }), shotErr("BAD_CONTEXT", /ctx.anchor/));
  assert.throws(() => RG.ctxDefaults({ subject: { pos: "here" } }), shotErr("BAD_CONTEXT", /ctx.subject/));
  assert.throws(() => RG.ctxDefaults([1]), shotErr("BAD_CONTEXT"));
});

check("R4 needs enforcement: subject, path, indoor-only, outdoor-only → MISSING_CONTEXT", () => {
  const reg = fresh();
  assert.throws(() => reg.buildShot({ technique: "classic.test-dolly", duration: 3 }, {}),
    shotErr("MISSING_CONTEXT", /needs a subject/));
  assert.ok(TR.isTrajectory(reg.buildShot({ technique: "classic.test-dolly", duration: 3, subject: { pos: [0, 0, 0] } })), "spec.subject with a position suffices");
  const mk = (id, needs) => {
    const r = RG.createRegistry();
    r.registerTechnique(dollyDef({ id, needs }));
    return (ctx) => r.buildShot({ technique: id, duration: 2 }, { subject: SUBJECT, ...ctx });
  };
  const pathShot = mk("drone.test-path", { subject: true, path: true });
  assert.throws(() => pathShot({}), shotErr("MISSING_CONTEXT", /needs a path/));
  assert.throws(() => pathShot({ path: [[0, 0, 0]] }), shotErr("MISSING_CONTEXT", /at least 2 points/));
  assert.ok(TR.isTrajectory(pathShot({ path: [[0, 0, 0], [1, 1, 1]] })));
  const indoorShot = mk("fpv.test-corridor", { subject: true, indoor: true });
  assert.throws(() => indoorShot({}), shotErr("MISSING_CONTEXT", /indoor technique/));
  assert.ok(TR.isTrajectory(indoorShot({ indoor: { floor: () => 9 } })));
  const outdoorShot = mk("drone.test-skim", { subject: true, indoor: false });
  assert.throws(() => outdoorShot({ indoor: {} }), shotErr("MISSING_CONTEXT", /outdoor-only/));
  assert.ok(TR.isTrajectory(outdoorShot({})));
});

// ---------------------------------------------------------------------------
// R5 results
// ---------------------------------------------------------------------------

check("R5 result stamping: technique, family, bounds precedence, subject, meta; validates clean", () => {
  const reg = fresh();
  const tr = reg.buildShot({ technique: "classic.test-dolly", duration: 4, params: { startDistance: 10 }, seed: 7 }, CTX);
  assert.equal(tr.technique, "classic.test-dolly");
  assert.equal(tr.family, "classic");
  assert.equal(tr.duration, 4);
  assert.equal(tr.id, "classic.test-dolly#00000007");
  assert.deepEqual(tr.bounds, { ...TR.DEFAULT_BOUNDS, maxLateral: 0.75 }, "technique defaultBounds");
  assert.equal(TR.hasExplicitBounds(tr), true);
  assert.deepEqual(tr.subject.pos, SUBJECT.pos);
  assert.equal(typeof tr.subjectAt, "function");
  assert.equal(tr.meta.capture, "stepped");
  assert.equal(tr.meta.reveal, false);
  assert.equal(tr.meta.techniqueName, "Test dolly");
  assert.equal(tr.meta.spec.seed, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(tr.meta)), tr.meta, "meta JSON-safe");
  const v = TR.validateTrajectory(tr);
  assert.equal(v.ok, true, JSON.stringify(v.issues.slice(0, 3)));
  assert.ok(TR.subjectCoverage(tr, { framing: "MS" }).fraction >= 0.95);
  for (const t of [0, 2, 4]) assert.ok(tr.sample(t).pos[2] >= 10.7 - 1e-9, "ground clearance respected");
  const over = reg.buildShot({ technique: "classic.test-dolly", duration: 4, bounds: { maxRise: 0.1 } }, CTX);
  assert.equal(over.bounds.maxRise, 0.1, "spec.bounds wins");
  assert.equal(over.bounds.maxLateral, 0.75, "rest from the technique");
  const reg2 = RG.createRegistry();
  reg2.registerTechnique(dollyDef({ build: (spec, ctx) => TR.makeTrajectory({ duration: spec.duration, positionAt: [0, 0, 20], orientAt: { h: 0, p: 0 }, bounds: { maxSink: 0.2 } }) }));
  const explicit = reg2.buildShot({ technique: "classic.test-dolly", duration: 2 }, CTX);
  assert.equal(explicit.bounds.maxSink, 0.2, "explicit trajectory bounds override defaults");
  assert.equal(explicit.bounds.maxLateral, TR.DEFAULT_BOUNDS.maxLateral);
  assert.equal(reg.buildShot({ technique: "classic.test-dolly", duration: 2, id: "my-shot" }, CTX).id, "my-shot");
});

check("R5 build failures are wrapped (BUILD_FAILED) and wrong durations rejected", () => {
  const mk = (build) => {
    const r = RG.createRegistry();
    r.registerTechnique(dollyDef({ build }));
    return () => r.buildShot({ technique: "classic.test-dolly", duration: 3 }, CTX);
  };
  assert.throws(mk(() => { throw new TypeError("x is undefined"); }), (e) => {
    shotErr("BUILD_FAILED", /classic.test-dolly: build failed: x is undefined/)(e);
    assert.ok(e.cause instanceof TypeError);
    return true;
  });
  assert.throws(mk(() => ({ not: "a trajectory" })), shotErr("BUILD_FAILED", /did not return a Trajectory/));
  assert.throws(mk(() => TR.makeTrajectory({ duration: 2.5, positionAt: [0, 0, 0], orientAt: { h: 0, p: 0 } })),
    shotErr("BUILD_FAILED", /returned duration 2.5, the spec asked for 3/));
  assert.throws(mk(() => TR.makeTrajectory({ duration: 3, positionAt: () => [NaN, 0, 0], orientAt: { h: 0, p: 0 } })),
    shotErr("NAN_POSE"), "FilmShotErrors pass through");
  assert.throws(mk(() => { throw new FilmError("core said no", "BAD_ARGUMENT"); }),
    shotErr("BAD_ARGUMENT", /classic.test-dolly: core said no/), "plain FilmErrors become FilmShotErrors");
});

check("R5 determinism: same spec → identical take; seed changes the seeded draws", () => {
  const reg = fresh();
  const spec = { technique: "classic.test-dolly", duration: 3, params: { jitter: 1 } };
  const a = TR.bakeTrajectory(reg.buildShot(spec, CTX), 30);
  const b = TR.bakeTrajectory(reg.buildShot({ ...spec, params: { ...spec.params } }, CTX), 30);
  assert.equal(a.checksum, b.checksum);
  const callerRng = () => 0.999;
  const c = TR.bakeTrajectory(reg.buildShot(spec, { ...CTX, rng: callerRng }), 30);
  assert.equal(c.checksum, a.checksum, "buildShot always re-seeds rng from the spec");
  const d = TR.bakeTrajectory(reg.buildShot({ ...spec, seed: 12345 }, CTX), 30);
  assert.notEqual(d.checksum, a.checksum);
  const e = TR.bakeTrajectory(reg.buildShot({ ...spec, seed: 12345 }, CTX), 30);
  assert.equal(e.checksum, d.checksum);
  assert.equal(RG.specSeed({ seed: "take-3" }), RG.specSeed({ seed: "take-3", technique: "other" }));
});

// ---------------------------------------------------------------------------
// R6 catalog + index
// ---------------------------------------------------------------------------

check("R6 listTechniques: JSON round trip, params documented, family filter, unknown family", () => {
  const reg = fresh({ tags: ["push", "intimate"], defaultFov: 40 });
  reg.registerTechnique(dollyDef({ id: "drone.test-orbit", needs: { subject: true, indoor: false } }));
  reg.registerTechnique(dollyDef({ id: "fpv.test-dive", capture: "realtime", reveal: true }));
  const cat = reg.listTechniques();
  assert.equal(cat.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(cat)), cat, "JSON-serialisable without loss");
  const e = cat[0];
  assert.deepEqual(Object.keys(e).sort(), ["capture", "defaultBounds", "defaultDuration", "defaultFov", "description", "family", "id",
    "name", "needs", "params", "reveal", "tags", "whenToUse"].sort());
  assert.deepEqual(e.params.startDistance, { type: "number", desc: "Distance from the subject at the start.", default: 8, min: 1, max: 50, unit: "m" });
  assert.deepEqual(e.params.endFraming.values, ["MS", "MCU", "CU"]);
  assert.equal(e.params.steps.integer, true);
  assert.deepEqual(e.params.offset.default, [0, 0, 0]);
  assert.deepEqual(e.tags, ["push", "intimate"]);
  for (const entry of cat) for (const p of Object.values(entry.params)) assert.ok(p.desc.length > 0, "every param documented");
  assert.deepEqual(reg.listTechniques({ family: "drone" }).map((x) => x.id), ["drone.test-orbit"]);
  assert.deepEqual(reg.listTechniques({ family: ["fpv", "classic"] }).map((x) => x.id), ["classic.test-dolly", "fpv.test-dive"]);
  assert.throws(() => reg.listTechniques({ family: "cinema" }), shotErr("UNKNOWN_FAMILY", /valid: classic, drone, fpv/));
  cat[0].params.startDistance.max = 1e9;
  assert.equal(reg.getTechnique("classic.test-dolly").params.startDistance.max, 50, "catalog is a copy");
  const req = RG.createRegistry();
  req.registerTechnique(dollyDef({ id: "classic.test-req", params: { radius: { type: "number", desc: "r" } } }));
  assert.equal(req.listTechniques()[0].params.radius.required, true);
});

check("R6 shots/index.js: API exported, shipped catalog registered, unique, JSON-safe, family = prefix", () => {
  for (const fn of ["listTechniques", "buildShot", "getTechnique", "registerTechnique", "defineTechnique", "ctxDefaults", "createRegistry",
    "makeTrajectory", "bakeTrajectory", "trajectoryFromTable", "validateTrajectory", "orientLookAt", "aimSubject",
    "distanceForFraming", "projectToNdc", "compositionMetrics"]) {
    assert.equal(typeof SH[fn], "function", `index exports ${fn}`);
  }
  assert.equal(SH.buildShot, RG.buildShot, "same default registry");
  assert.ok(Array.isArray(SH.CLASSIC_TECHNIQUES) && Array.isArray(SH.DRONE_TECHNIQUES) && Array.isArray(SH.FPV_TECHNIQUES));
  const ids = SH.REGISTERED_TECHNIQUE_IDS;
  assert.equal(ids.length, SH.CLASSIC_TECHNIQUES.length + SH.DRONE_TECHNIQUES.length + SH.FPV_TECHNIQUES.length);
  assert.equal(new Set(ids).size, ids.length, "ids unique");
  const cat = SH.listTechniques();
  assert.deepEqual(cat.map((e) => e.id), ids);
  assert.deepEqual(JSON.parse(JSON.stringify(cat)), cat, "shipped catalog JSON-safe");
  for (const e of cat) {
    assert.equal(e.id.split(".")[0], e.family);
    assert.ok(SH.getTechnique(e.id));
  }
  for (const d of SH.CLASSIC_TECHNIQUES) assert.equal(d.family, "classic");
  for (const d of SH.DRONE_TECHNIQUES) assert.equal(d.family, "drone");
  for (const d of SH.FPV_TECHNIQUES) assert.equal(d.family, "fpv");
  assert.throws(() => SH.buildShot({ technique: "classic.not-a-real-technique", duration: 2 }), shotErr("UNKNOWN_TECHNIQUE"));
});

// ---------------------------------------------------------------------------
// R7 list params
// ---------------------------------------------------------------------------

/** A list param: waypoints {kind, at, …} with per-kind fields, an optional field and a check. */
const LIST_PARAM = {
  type: "list",
  desc: "Waypoints along the move.",
  default: [{ kind: "pause", at: 1 }],
  maxItems: 3,
  item: {
    kind: { type: "enum", values: ["pause", "look", "spin"], desc: "What happens at the waypoint." },
    at: { type: "number", min: 0, max: 100, unit: "s", desc: "When it happens." },
    note: { type: "string", optional: true, desc: "Free note (optional)." },
  },
  variants: {
    key: "kind",
    fields: {
      look: { target: { type: "vec3", default: [0, 0, 0], desc: "Point to look at." } },
      spin: { turns: { type: "number", integer: true, default: 1, min: 1, max: 3, desc: "Full turns." }, dir: { type: "enum", values: ["cw", "ccw"], default: "cw", desc: "Spin direction." } },
    },
  },
  check: (it) => (it.kind === "spin" && it.at < 0.5 ? `a spin needs at ≥ 0.5 (got ${it.at})` : null),
};

check("R7 list params: item / variants / optional / check validated; defaults filled per item and deep-copied; catalog shows the schema", () => {
  const reg = fresh({ params: { ...dollyDef().params, marks: LIST_PARAM } });
  const def = reg.getTechnique("classic.test-dolly");
  assert.equal(def.params.marks.type, "list");
  assert.ok(RG.PARAM_TYPES.includes("list"));
  let seen = null;
  const spy = RG.createRegistry();
  spy.registerTechnique(dollyDef({ params: { ...dollyDef().params, marks: LIST_PARAM }, build: (spec, ctx) => { seen = spec.params.marks; return buildDolly(spec, ctx); } }));
  spy.buildShot({ technique: "classic.test-dolly", params: { marks: [{ kind: "spin", at: 2 }, { kind: "look", at: 3, note: "hi" }, { kind: "pause", at: 4 }] } }, CTX);
  assert.deepEqual(seen, [{ kind: "spin", at: 2, turns: 1, dir: "cw" }, { kind: "look", at: 3, note: "hi", target: [0, 0, 0] }, { kind: "pause", at: 4 }]);
  // defaults: filled, and never shared (mutating one build's params cannot leak into the next)
  spy.buildShot({ technique: "classic.test-dolly" }, CTX);
  assert.deepEqual(seen, [{ kind: "pause", at: 1 }]);
  seen[0].at = 99;
  spy.buildShot({ technique: "classic.test-dolly" }, CTX);
  assert.equal(seen[0].at, 1, "default deep-copied");
  assert.ok(Object.isFrozen(def.params.marks.default) && Object.isFrozen(def.params.marks.default[0]));
  // catalog: JSON-safe, item + variants + optional + maxItems, no functions
  const e = reg.listTechniques()[0].params.marks;
  assert.deepEqual(JSON.parse(JSON.stringify(e)), e);
  assert.deepEqual(e.default, [{ kind: "pause", at: 1 }]);
  assert.equal(e.item.at.required, true);
  assert.equal(e.item.note.optional, true);
  assert.deepEqual(e.variants.fields.spin.turns, { type: "number", desc: "Full turns.", default: 1, min: 1, max: 3, integer: true });
  assert.equal(e.maxItems, 3);
  assert.equal(e.check, undefined);
});

check("R7 list params: bad values are BAD_PARAM naming the list (details.param) and the item path, with suggestions", () => {
  const reg = fresh({ params: { ...dollyDef().params, marks: LIST_PARAM } });
  const err = (marks) => {
    try {
      reg.buildShot({ technique: "classic.test-dolly", params: { marks } }, CTX);
    } catch (e) {
      return e;
    }
    assert.fail("expected BAD_PARAM");
  };
  const cases = [
    [{ kind: "pause", at: 1 }, /param "marks" must be a list \(array\) of \{kind, at, note\} items/, {}],
    [[1, 2, 3, 4], /has 4 items \(at most 3\)/, {}],
    [[7], /item \[0\] must be an object/, { index: 0 }],
    [[{ kind: "pause" }], /item \[0\] \("pause"\): field "at" is required \(When it happens\.\)/, { index: 0, field: "at" }],
    [[{ kind: "spin", at: 2, trns: 2 }], /item \[0\] \("spin"\): unknown field "trns" \(did you mean "turns"\?\) — valid fields: kind, at, note, turns, dir/, { field: "trns", path: "marks[0].trns" }],
    [[{ kind: "pause", at: 2, turns: 2 }], /unknown field "turns"/, {}],
    [[{ kind: "spin", at: 2, turns: 1.5 }], /param "marks\[0\]\.turns" must be an integer/, { path: "marks[0].turns", field: "turns", index: 0 }],
    [[{ kind: "jump", at: 2 }], /param "marks\[0\]\.kind" must be one of "pause" \| "look" \| "spin"/, { path: "marks[0].kind" }],
    [[{ kind: "look", at: 2, target: [1, 2] }], /marks\[0\]\.target" must be a finite \[x, y, z\]/, {}],
    [[{ kind: "pause", at: 1 }, { kind: "spin", at: 0.2 }], /item \[1\] \("spin"\): a spin needs at ≥ 0\.5 \(got 0\.2\)/, { index: 1 }],
    [[{ kind: "pause", at: -1 }], /marks\[0\]\.at" must be in \[0, 100\] s \(got -1\)/, {}],
  ];
  for (const [v, re, det] of cases) {
    const e = err(v);
    assert.ok(e instanceof FilmShotError, String(e));
    assert.equal(e.code, "BAD_PARAM", e.message);
    assert.match(e.message, re);
    assert.equal(e.details.param, "marks", `details.param for ${e.message}`);
    assert.equal(e.details.technique, "classic.test-dolly");
    for (const [k, x] of Object.entries(det)) assert.deepEqual(e.details[k], x, `details.${k} (${e.message})`);
  }
});

check("R7 list params: malformed list schemas are BAD_TECHNIQUE_DEF", () => {
  const bad = (marks, re) => assert.throws(() => RG.defineTechnique(dollyDef({ params: { ...dollyDef().params, marks } })), shotErr("BAD_TECHNIQUE_DEF", re));
  const base = { type: "list", desc: "x", default: [] };
  bad({ ...base }, /item must be a non-empty object/);
  bad({ ...base, item: { a: { type: "list", desc: "nested", item: { b: { type: "number", desc: "b" } } } } }, /item field "a": type must be one of number \| string \| boolean \| enum \| vec3/);
  bad({ ...base, item: { "a-b": { type: "number", desc: "x" } } }, /identifier/);
  bad({ ...base, item: { a: { type: "number", desc: "a" } }, variants: { key: "a", fields: {} } }, /variants\.key "a" must name an enum field/);
  bad({ ...base, item: { k: { type: "enum", values: ["x"], desc: "k" } }, variants: { key: "k", fields: { y: { z: { type: "number", desc: "z" } } } } }, /"y" is not a value of item\.k/);
  bad({ ...base, item: { k: { type: "enum", values: ["x"], desc: "k" } }, variants: { key: "k", fields: { x: { k: { type: "number", desc: "z" } } } } }, /collides/);
  bad({ ...base, item: { a: { type: "number", desc: "a" } }, maxItems: 1.5 }, /maxItems must be an integer/);
  bad({ ...base, item: { a: { type: "number", desc: "a", optional: true, default: 1 } } }, /optional field has no default/);
  bad({ ...base, default: [{ b: 1 }], item: { a: { type: "number", desc: "a" } } }, /default is invalid/);
  bad({ ...base, item: { a: { type: "number", desc: "a" } }, check: "nope" }, /check must be a function/);
  assert.throws(() => RG.defineTechnique(dollyDef({ params: { ...dollyDef().params, n: { type: "number", desc: "n", optional: true } } })), shotErr("BAD_TECHNIQUE_DEF", /optional is only valid for list item fields/));
  assert.throws(() => RG.defineTechnique(dollyDef({ params: { ...dollyDef().params, n: { type: "number", desc: "n", maxItems: 3 } } })), shotErr("BAD_TECHNIQUE_DEF", /maxItems is only valid for list params/));
});

console.log(`film_registry: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
