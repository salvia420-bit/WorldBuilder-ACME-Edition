// tests/film_plan_schema.test.mjs — film mode Plan JSON v1: defaults (normalizePlan) and validation (validatePlan).
//
// WHY: film mode (`?filmMode=on`, flag filmMode, DEFAULT OFF) is directed by a Claude Code session that hand-writes
// plan.json; every mistake that slips through costs a ≈10 s teleport and a take on the 1070. These checks run the REAL
// tools/film/plan/schema.mjs against the shipped example plan, a minimal plan and one broken plan per error class,
// asserting that each problem is reported at the exact JSON path (`shots[0].params.radius`) with a useful message,
// that advice (missing standing order, moving actor captured stepped, beats without a song) is a WARNING, that the
// injected technique registry is honoured, and that validation is total (never throws on garbage).
//
// Run from apps/holtburger-web/: node tests/film_plan_schema.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CAPTURE_MODES,
  DRY_ROUTE_LEG_M,
  FRAMING_NAMES,
  KNOWN_TECHNIQUE_IDS,
  LOOK_DOF_KEYS,
  PLAN_FIELDS,
  SHOT_BOUND_RULES,
  PLAN_VERSION,
  STANDING_ORDER_MAX,
  TRANSITION_TYPES,
  XFADE_FOR,
  assertValidPlan,
  checkStandingOrder,
  examplePlan,
  normalizePlan,
  parseDuration,
  parseStart,
  shotSpec,
  shotUsesSong,
  techniqueFamily,
  validatePlan,
} from "../tools/film/plan/schema.mjs";
import { FilmPlanError } from "../scene3d/film/core/errors.js";
import { hashString } from "../scene3d/film/core/rng.js";
import * as SHOTS from "../scene3d/film/shots/index.js";

/** The REAL technique registry (every shipped technique registered by shots/index.js). */
const REAL = { getTechnique: SHOTS.getTechnique, buildShot: SHOTS.buildShot };

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e && e.message ? e.message : e}`);
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────

/** Fake SPEC §2.11 registry: every catalogue id exists; a few carry real-looking param schemas and needs. */
const DEFS = {
  "drone.orbit-poi": {
    params: {
      radius: { type: "number", default: 30, min: 2, max: 500 },
      heightAGL: { type: "number", default: 20, min: 1, max: 400 },
      direction: { type: "enum", default: "cw", values: ["cw", "ccw"] },
      keepLevel: { type: "boolean", default: true },
      center: { type: "vec3", default: null },
      label: { type: "string", default: "" },
    },
    needs: { subject: true, path: false, indoor: false },
  },
  "fpv.fpv-corridor": { params: { speed: { type: "number", default: 6, min: 0.5, max: 25 } }, needs: { subject: false, path: true, indoor: true } },
  "drone.canyon-run": { params: {}, needs: { subject: false, path: true, indoor: false } },
  "classic.static": { params: {}, needs: { subject: false, path: false, indoor: null } },
  "classic.tracking-follow": { params: {}, needs: { subject: true, path: false, indoor: null }, capture: "realtime" },
};
function makeRegistry({ buildShot } = {}) {
  const calls = [];
  return {
    calls,
    getTechnique(id) {
      calls.push(id);
      if (!KNOWN_TECHNIQUE_IDS.includes(id)) return null;
      const d = DEFS[id] || { params: {}, needs: { subject: false, path: false, indoor: null } };
      return { id, family: techniqueFamily(id), name: id, ...d };
    },
    ...(buildShot ? { buildShot } : {}),
  };
}

/** A small valid plan; `mut(plan)` breaks one thing. */
function basePlan(mut) {
  const p = {
    version: 1,
    title: "Test reel",
    sites: [
      { id: "gate", teleport: "@telepoi Holtburg", anchor: [32532, 34567.1, 94] },
      { id: "crypt", teleport: "@teleloc 0x01F60289 96.70 -10.00 0.00 -0.7193 0.0000 0.0000 -0.6947", cell: "0x01F60289", anchor: { cell: "0x01F60289", local: [96.7, -10, 0] } },
    ],
    shots: [
      {
        id: "s010", site: "gate", technique: "drone.orbit-poi", duration: { sec: 6 },
        subject: { kind: "point", pos: [32532, 34567, 95] }, params: { radius: 30, direction: "ccw" },
        standingOrder: "Orbit the lifestone at 30 m; foliage may be faded, never cut through a roof.",
      },
      {
        id: "s020", site: "crypt", technique: "fpv.fpv-corridor", duration: { sec: 4 },
        route: { fromCell: "0x01F60289", toCell: "0x01F6027A" },
        standingOrder: "Thread the corridor and keep at least 1 m from every wall.",
      },
    ],
  };
  if (mut) mut(p);
  return p;
}

const paths = (list) => list.map((e) => e.path);
function expectError(plan, path, re, opts) {
  const v = validatePlan(plan, opts);
  assert.equal(v.ok, false, `expected an error at ${path}`);
  const hit = v.errors.find((e) => e.path === path);
  assert.ok(hit, `no error at ${path}; got ${JSON.stringify(v.errors)}`);
  if (re) assert.match(hit.message, re);
  return v;
}
function expectWarning(plan, path, re, opts) {
  const v = validatePlan(plan, opts);
  const hit = v.warnings.find((e) => e.path === path);
  assert.ok(hit, `no warning at ${path}; got warnings ${JSON.stringify(v.warnings)} errors ${JSON.stringify(v.errors)}`);
  if (re) assert.match(hit.message, re);
  return v;
}

// ── example + defaults ──────────────────────────────────────────────────────────────────────────────────────

console.log("film_plan_schema: example plan and defaults");

check("examplePlan() is valid with no warnings, with and without the registry; 3 sites, 8 shots incl. the docs-lane must-haves", () => {
  const ex = examplePlan();
  assert.equal(ex.sites.length, 3);
  assert.equal(ex.shots.length, 8);
  const techs = ex.shots.map((s) => s.technique);
  for (const t of ["fpv.fpv-corridor", "drone.pass-over", "classic.rack-focus"]) assert.ok(techs.includes(t), t);
  for (const opts of [{}, { registry: makeRegistry() }]) {
    const v = validatePlan(ex, opts);
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.deepEqual(v.warnings, []);
  }
  assert.notEqual(examplePlan(), examplePlan(), "fresh object every call");
});

check("normalizePlan fills defaults: 1920x1080@30 stepped, cut, pilot jev, capture stepped, seeds, sites", () => {
  const raw = {
    title: "Minimal",
    sites: [{ id: "a", teleport: "@telepoi Holtburg", anchor: [100, 200, 30] }],
    shots: [{ id: "s1", site: "a", technique: "classic.static", duration: 4 }],
  };
  const before = JSON.stringify(raw);
  const p = normalizePlan(raw);
  assert.equal(JSON.stringify(raw), before, "input not mutated");
  assert.equal(p.version, PLAN_VERSION);
  assert.deepEqual(p.format, { width: 1920, height: 1080, fps: 30, capture: "stepped" });
  assert.deepEqual(p.defaults.transition, { type: "cut", durationSec: 0 });
  assert.equal(p.defaults.pilot.mode, "jev");
  assert.deepEqual(p.edit, { fadeInSec: 0, fadeOutSec: 0 });
  assert.equal(p.song, null);
  const s = p.shots[0];
  assert.deepEqual(s.duration, { sec: 4 });
  assert.deepEqual(s.transition, { type: "cut", durationSec: 0 });
  assert.equal(s.pilot.mode, "jev");
  assert.equal(s.capture.mode, "stepped");
  assert.equal(s.family, "classic");
  assert.deepEqual(s.params, {});
  assert.equal(s.seed, hashString("Minimal|s1"));
  assert.equal(s.standingOrder, null);
  const site = p.sites[0];
  assert.equal(site.indoor, false);
  assert.deepEqual(site.lbKeys, ["0x00010000"], "landblock of world (100,200) = lbX 0, lbY 1");
  assert.equal(site.interiorLb, null);
  assert.equal(site.settleSec, 0);
  assert.deepEqual(site.ready, { settleSec: 3, timeoutSec: 90 });
  assert.equal(site.name, "a");
});

check("normalizePlan is idempotent and deterministic on the example", () => {
  const a = normalizePlan(examplePlan());
  assert.deepEqual(normalizePlan(a), a);
  assert.deepEqual(normalizePlan(examplePlan()), a);
});

check("anchor {cell, local} → world metres; indoor/interiorLb/lbKeys from an EnvCell id; hex ids canonical", () => {
  const p = normalizePlan(basePlan());
  const crypt = p.sites[1];
  assert.deepEqual(crypt.anchor, [1 * 192 + 96.7, 0xf6 * 192 - 10, 0]);
  assert.equal(crypt.cell, "0x01F60289");
  assert.equal(crypt.indoor, true);
  assert.deepEqual(crypt.lbKeys, ["0x01F60000"]);
  assert.equal(crypt.interiorLb, "0x01F60000");
  const q = normalizePlan(basePlan((pl) => { pl.sites[0].cell = 0xa9b40019; pl.sites[0].lbKeys = ["a9b40019"]; }));
  assert.equal(q.sites[0].cell, "0xA9B40019");
  assert.deepEqual(q.sites[0].lbKeys, ["0xA9B40000"], "lbKeys masked to the landblock");
});

check("shorthand: durations '2 bars' / '8 beats' / '3.5s' / number, start number, subject 'player'", () => {
  assert.deepEqual(parseDuration("2 bars"), { bars: 2 });
  assert.deepEqual(parseDuration("8 beats"), { beats: 8 });
  assert.deepEqual(parseDuration("3.5s"), { sec: 3.5 });
  assert.deepEqual(parseDuration(4), { sec: 4 });
  assert.deepEqual(parseDuration({ bars: 1 }), { bars: 1 });
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration({ sec: 1, beats: 2 }), null);
  assert.deepEqual(parseStart(12.5), { sec: 12.5 });
  assert.deepEqual(parseStart({ section: 2 }), { section: 2 });
  assert.equal(parseStart({ when: 2 }), null);
  const p = normalizePlan(basePlan((pl) => { pl.shots[0].duration = "2 bars"; pl.shots[0].subject = "player"; pl.shots[0].start = 3; }));
  assert.deepEqual(p.shots[0].duration, { bars: 2 });
  assert.deepEqual(p.shots[0].subject, { kind: "player" });
  assert.deepEqual(p.shots[0].start, { sec: 3 });
  assert.equal(shotUsesSong(p.shots[0]), true);
  assert.equal(shotUsesSong(p.shots[1]), false);
});

check("capture defaults to realtime (auto) when the actor moves or an entity subject is moving; explicit wins", () => {
  const p = normalizePlan(basePlan((pl) => {
    pl.shots[0].subject = { kind: "entity", ref: "Town Crier", moving: true };
    pl.shots[1].actor = { moveTo: [1, 2, 3] };
  }));
  assert.equal(p.shots[0].capture.mode, "realtime");
  assert.equal(p.shots[0].capture.auto, true);
  assert.equal(p.shots[1].capture.mode, "realtime");
  assert.equal(p.shots[1].actor.moves, true, "moveTo implies moves");
  const q = normalizePlan(basePlan((pl) => { pl.format = { capture: "realtime" }; }));
  assert.equal(q.shots[0].capture.mode, "realtime", "format.capture is the plan default");
  assert.equal(q.format.width, 1920);
});

check("look merges defaults ← site ← shot; transitions get durationSec 0.5 and the xfade name", () => {
  const p = normalizePlan(basePlan((pl) => {
    pl.defaults = { look: { timeOfDay: "noon", grade: "warm" }, transition: "dissolve" };
    pl.sites[0].look = { timeOfDay: "dusk" };
    pl.shots[0].look = { fog: "white" };
    pl.shots[1].transition = { type: "fade", durationSec: 1 };
  }));
  assert.deepEqual(p.shots[0].look, { timeOfDay: "dusk", grade: "warm", fog: "white" });
  assert.deepEqual(p.shots[1].look, { timeOfDay: "noon", grade: "warm" });
  assert.deepEqual(p.shots[0].transition, { type: "dissolve", durationSec: 0.5, xfade: XFADE_FOR.dissolve });
  assert.deepEqual(p.shots[1].transition, { type: "fade", durationSec: 1, xfade: "fadeblack" });
  assert.deepEqual(TRANSITION_TYPES, ["cut", "dissolve", "fade", "fadewhite"]);
  assert.deepEqual(CAPTURE_MODES, ["stepped", "realtime"]);
});

check("shotSpec builds the SPEC §2.11 ShotSpec for a take duration", () => {
  const p = normalizePlan(basePlan((pl) => { pl.shots[0].framing = "WS"; pl.shots[0].fov = 50; pl.shots[0].ease = "sineInOut"; }));
  const spec = shotSpec(p.shots[0], 6.5);
  assert.deepEqual(spec, {
    technique: "drone.orbit-poi", duration: 6.5, params: { radius: 30, direction: "ccw" }, seed: p.shots[0].seed,
    framing: "WS", subject: { kind: "point", pos: [32532, 34567, 95] }, fov: 50, ease: "sineInOut",
  });
  spec.params.radius = 1;
  assert.equal(p.shots[0].params.radius, 30, "spec params are a copy");
});

check("PLAN_FIELDS documents every top-level area; catalogue has 63 unique SPEC §2.12 ids", () => {
  const all = PLAN_FIELDS.map((f) => f.path).join(" ");
  for (const k of ["version", "format.fps", "song.offsetSec", "sites[].teleport", "sites[].anchor", "shots[].duration", "shots[].standingOrder", "shots[].transition", "shots[].capture.mode"]) {
    assert.ok(all.includes(k), k);
  }
  assert.equal(KNOWN_TECHNIQUE_IDS.length, 63);
  assert.equal(new Set(KNOWN_TECHNIQUE_IDS).size, 63);
  assert.equal(techniqueFamily("fpv.fpv-flip"), "fpv");
  assert.equal(techniqueFamily("cinema.x"), null);
  assert.deepEqual(FRAMING_NAMES, ["EWS", "WS", "FS", "MWS", "MS", "MCU", "CU", "ECU"]);
});

// ── error classes ───────────────────────────────────────────────────────────────────────────────────────────

console.log("film_plan_schema: errors (each with its JSON path)");

check("validation is total: garbage never throws, always ok:false with paths", () => {
  for (const g of [null, undefined, 42, "plan", [], { sites: "x", shots: {} }, { sites: [null, 5], shots: [null, "s"] },
    { version: 1, sites: [{ id: {}, anchor: { cell: "zz" } }], shots: [{ id: "a", duration: { sec: NaN }, subject: 7, transition: 5, pilot: 3, capture: [] }] }]) {
    const v = validatePlan(g);
    assert.equal(v.ok, false, JSON.stringify(g));
    assert.ok(v.errors.length > 0);
    for (const e of v.errors) assert.equal(typeof e.path, "string");
  }
  assert.deepEqual(paths(validatePlan(null).errors), [""]);
});

check("plan-level: version, format.fps/width/capture, sites/shots arrays, edit fades, song offset", () => {
  expectError(basePlan((p) => { p.version = 2; }), "version", /version 2/);
  expectError(basePlan((p) => { p.format = { fps: 29.97 }; }), "format.fps", /integer/);
  expectError(basePlan((p) => { p.format = { width: 1281 }; }), "format.width", /even/);
  expectError(basePlan((p) => { p.format = { capture: "fast" }; }), "format.capture", /stepped, realtime/);
  expectError(basePlan((p) => { p.sites = []; }), "sites", /non-empty/);
  expectError(basePlan((p) => { p.shots = []; }), "shots", /EDIT order/);
  expectError(basePlan((p) => { p.edit = { fadeOutSec: -1 }; }), "edit.fadeOutSec");
  expectError(basePlan((p) => { p.song = { offsetSec: -3 }; }), "song.offsetSec");
  expectWarning(basePlan((p) => { delete p.version; }), "version", /assuming 1/);
  expectWarning(basePlan((p) => { p.shotz = []; }), "shotz", /did you mean "shots"/);
});

check("sites: id pattern + uniqueness, teleport '@' / single line, anchor, cell, unused site", () => {
  expectError(basePlan((p) => { p.sites[1].id = "gate"; p.shots[1].site = "gate"; }), "sites[1].id", /duplicate site id "gate"/);
  expectError(basePlan((p) => { p.sites[0].id = "../etc"; }), "sites[0].id", /must match/);
  expectError(basePlan((p) => { p.sites[0].teleport = "telepoi Holtburg"; }), "sites[0].teleport", /start with '@'/);
  expectError(basePlan((p) => { p.sites[0].teleport = "@telepoi Holtburg\n@shutdown"; }), "sites[0].teleport", /single line/);
  expectError(basePlan((p) => { delete p.sites[0].teleport; }), "sites[0].teleport");
  expectWarning(basePlan((p) => { p.sites[0].teleport = "@home"; }), "sites[0].teleport", /not one of @teleloc/);
  expectError(basePlan((p) => { p.sites[0].anchor = [1, 2]; }), "sites[0].anchor", /\[x, y, z\]/);
  expectError(basePlan((p) => { p.sites[0].cell = "nowhere"; }), "sites[0].cell", /cell id/);
  expectWarning(basePlan((p) => { p.sites[0].anchor = [84, 7.1, 94]; }), "sites[0].anchor", /open ocean.*local coordinates passed as world/);
  expectWarning(basePlan((p) => { p.sites[0].anchor = [84, 7.1, 94]; p.sites[0].cell = "0xA9B40019"; }), "sites[0].anchor", /not the cell's 0xA9B40000/);
  expectWarning(basePlan((p) => { p.sites[0].anchor = [60000, 10, 94]; }), "sites[0].anchor", /outside the 0\.\.49152 m world square/);
  assert.deepEqual(validatePlan(basePlan((p) => { p.sites[0].cell = "0xA9B40019"; })).warnings, [], "matching cell + world anchor: no warning");
  expectWarning(basePlan((p) => { p.sites.push({ id: "spare", teleport: "@telepoi Arwic", anchor: [100, 100, 10] }); }), "sites[2]", /never used/);
});

check("shots: id pattern + uniqueness, unknown site with did-you-mean", () => {
  expectError(basePlan((p) => { p.shots[1].id = "s010"; }), "shots[1].id", /duplicate shot id "s010"/);
  expectError(basePlan((p) => { p.shots[0].id = "../../evil"; }), "shots[0].id", /takes\/<id>\.mp4/);
  expectError(basePlan((p) => { p.shots[0].id = "has space"; }), "shots[0].id");
  expectError(basePlan((p) => { p.shots[0].site = "gat"; }), "shots[0].site", /unknown site "gat" \(did you mean "gate"\?\)/);
});

check("technique: malformed id is an error; unknown id is an error WITH the registry, a warning without", () => {
  expectError(basePlan((p) => { p.shots[0].technique = "orbit"; }), "shots[0].technique", /family classic\|drone\|fpv/);
  const reg = makeRegistry();
  expectError(basePlan((p) => { p.shots[0].technique = "drone.orbit-pio"; }), "shots[0].technique", /unknown technique "drone.orbit-pio".*did you mean "drone.orbit-poi"/, { registry: reg });
  assert.ok(reg.calls.includes("drone.orbit-pio"), "registry.getTechnique consulted");
  const v = expectWarning(basePlan((p) => { p.shots[0].technique = "drone.orbit-pio"; }), "shots[0].technique", /not in the SPEC/);
  assert.equal(v.ok, true, "without a registry an unknown well-formed id is only a warning");
  const throwing = { getTechnique() { throw new Error("boom"); } };
  expectError(basePlan(), "shots[0].technique", /unknown technique/, { registry: throwing });
});

check("params validated against def.params: unknown name, number min/max, enum, boolean, vec3, string", () => {
  const registry = makeRegistry();
  expectError(basePlan((p) => { p.shots[0].params = { radiuss: 5 }; }), "shots[0].params.radiuss", /unknown param "radiuss".*did you mean "radius"/, { registry });
  expectError(basePlan((p) => { p.shots[0].params = { radius: 1 }; }), "shots[0].params.radius", /below the minimum 2/, { registry });
  expectError(basePlan((p) => { p.shots[0].params = { radius: 900 }; }), "shots[0].params.radius", /above the maximum 500/, { registry });
  expectError(basePlan((p) => { p.shots[0].params = { radius: "far" }; }), "shots[0].params.radius", /must be a number/, { registry });
  expectError(basePlan((p) => { p.shots[0].params = { direction: "sideways" }; }), "shots[0].params.direction", /"cw", "ccw"/, { registry });
  expectError(basePlan((p) => { p.shots[0].params = { keepLevel: "yes" }; }), "shots[0].params.keepLevel", /true or false/, { registry });
  expectError(basePlan((p) => { p.shots[0].params = { center: [1, 2] }; }), "shots[0].params.center", /\[x, y, z\]/, { registry });
  expectError(basePlan((p) => { p.shots[0].params = { label: 3 }; }), "shots[0].params.label", /string/, { registry });
  assert.equal(validatePlan(basePlan((p) => { p.shots[0].params = { radius: 2, heightAGL: 400, direction: "cw", keepLevel: false, center: [1, 2, 3], label: "x" }; }), { registry }).ok, true, "boundaries inclusive");
});

check("registry needs: subject required, path required, unsatisfiable indoor mismatch is an error", () => {
  const registry = makeRegistry();
  expectError(basePlan((p) => { delete p.shots[0].subject; }), "shots[0].subject", /needs a subject/, { registry });
  expectError(basePlan((p) => { delete p.shots[1].route; }), "shots[1].path", /needs a path/, { registry });
  assert.equal(validatePlan(basePlan((p) => { delete p.shots[1].route; p.shots[1].path = [[288, 47220, 1], [280, 47220, 1]]; }), { registry }).ok, true, "explicit path satisfies needs.path");
  expectError(basePlan((p) => { p.shots[1].site = "gate"; delete p.shots[1].route; p.shots[1].path = [[1, 2, 3], [4, 5, 6]]; }), "shots[1].technique", /indoor technique.*outdoors.*no indoor route/, { registry });
  const routed = expectWarning(basePlan((p) => { p.shots[1].site = "gate"; }), "shots[1].technique", /indoor technique.*outdoors.*route supplies/, { registry });
  assert.equal(routed.errors.some((e) => e.path === "shots[1].technique"), false, "an indoor route satisfies the page's indoor context");
  expectError(basePlan((p) => { p.shots[0].site = "crypt"; }), "shots[0].technique", /outdoor technique.*indoors.*fail after the teleport/, { registry });
});

check("duration: required, exactly one of sec/beats/bars, > 0; beats/bars without a song warn", () => {
  expectError(basePlan((p) => { delete p.shots[0].duration; }), "shots[0].duration", /required/);
  expectError(basePlan((p) => { p.shots[0].duration = { sec: 0 }; }), "shots[0].duration.sec", /> 0/);
  expectError(basePlan((p) => { p.shots[0].duration = { sec: -2 }; }), "shots[0].duration.sec");
  expectError(basePlan((p) => { p.shots[0].duration = { beats: 4, bars: 1 }; }), "shots[0].duration", /exactly one/);
  expectError(basePlan((p) => { p.shots[0].duration = "a while"; }), "shots[0].duration");
  expectError(basePlan((p) => { p.shots[0].duration = { minutes: 1 }; }), "shots[0].duration");
  const v = expectWarning(basePlan((p) => { p.shots[0].duration = { bars: 2 }; }), "shots[0].duration", /needs a song analysis/);
  assert.equal(v.ok, true);
  const w = validatePlan(basePlan((p) => { p.shots[0].duration = { bars: 2 }; p.song = { analysis: "song.json" }; }));
  assert.equal(w.warnings.filter((x) => x.path === "shots[0].duration").length, 0, "no warning once plan.song exists");
});

check("start: one of sec/beat/bar/section, integer song indices", () => {
  expectError(basePlan((p) => { p.shots[1].start = { bar: 1.5 }; p.song = {}; }), "shots[1].start.bar", /integer/);
  expectError(basePlan((p) => { p.shots[1].start = { when: 3 }; }), "shots[1].start", /\{sec\}, \{beat\}/);
  expectError(basePlan((p) => { p.shots[1].start = { sec: -1 }; }), "shots[1].start.sec");
  expectWarning(basePlan((p) => { p.shots[1].start = { section: 1 }; }), "shots[1].start", /needs a song/);
});

check("subject kinds point/entity/player/path with required fields", () => {
  expectError(basePlan((p) => { p.shots[0].subject = { kind: "point" }; }), "shots[0].subject.pos", /pos: \[x, y, z\]/);
  expectError(basePlan((p) => { p.shots[0].subject = { kind: "entity" }; }), "shots[0].subject.ref", /guid/);
  expectError(basePlan((p) => { p.shots[0].subject = { kind: "entity", ref: "Crier", moving: "yes" }; }), "shots[0].subject.moving");
  expectError(basePlan((p) => { p.shots[0].subject = { kind: "path", points: [[1, 2, 3]] }; }), "shots[0].subject.points", /at least 2/);
  expectError(basePlan((p) => { p.shots[0].subject = { kind: "path", points: [[1, 2, 3], [1, 2]] }; }), "shots[0].subject.points[1]");
  expectError(basePlan((p) => { p.shots[0].subject = { kind: "ghost" }; }), "shots[0].subject.kind", /point, entity, player, path/);
  expectError(basePlan((p) => { p.shots[0].subject = 7; }), "shots[0].subject");
  expectError(basePlan((p) => { p.shots[0].subject = { kind: "point", pos: [1, 2, 3], radius: 0 }; }), "shots[0].subject.radius");
  for (const subj of [{ kind: "player" }, { kind: "entity", ref: 0x80001234 }, { kind: "entity", ref: "0x80001234", moving: false }, { kind: "path", points: [[1, 2, 3], [4, 5, 6]] }]) {
    assert.equal(validatePlan(basePlan((p) => { p.shots[1].subject = subj; })).ok, true, JSON.stringify(subj));
  }
});

check("standingOrder: one sentence ≤ 300 chars, single line; missing is a WARNING", () => {
  const v = expectWarning(basePlan((p) => { delete p.shots[0].standingOrder; }), "shots[0].standingOrder", /JEV pilot reads/);
  assert.equal(v.ok, true);
  expectError(basePlan((p) => { p.shots[0].standingOrder = `Hold ${"steady ".repeat(60)}now.`; }), "shots[0].standingOrder", new RegExp(`at most ${STANDING_ORDER_MAX}`));
  expectError(basePlan((p) => { p.shots[0].standingOrder = "Keep 2 m from trunks. Never lose the lifestone."; }), "shots[0].standingOrder", /ONE sentence/);
  expectError(basePlan((p) => { p.shots[0].standingOrder = "Keep 2 m from trunks\nnever lose it"; }), "shots[0].standingOrder", /single line/);
  expectError(basePlan((p) => { p.shots[0].standingOrder = 42; }), "shots[0].standingOrder");
  assert.equal(checkStandingOrder("Keep 2.5 m from the trunks, e.g. oaks and pines; never lose the lifestone.").ok, true);
  assert.equal(checkStandingOrder("x".repeat(STANDING_ORDER_MAX)).ok, true, "exactly the limit is fine");
  assert.equal(checkStandingOrder("x".repeat(STANDING_ORDER_MAX + 1)).ok, false);
  assert.equal(checkStandingOrder("Stop! Then rise.").ok, false);
  assert.equal(checkStandingOrder("   ").ok, false);
});

check("capture: realtime required for moving actor / moving entity (warn when explicitly stepped)", () => {
  const a = expectWarning(basePlan((p) => { p.shots[0].actor = { emote: "/wave", moves: true }; p.shots[0].capture = { mode: "stepped" }; }),
    "shots[0].capture.mode", /actor moves.*realtime/);
  assert.equal(a.ok, true, "advice, not an error");
  expectWarning(basePlan((p) => { p.shots[0].subject = { kind: "entity", ref: "Drudge", moving: true }; p.shots[0].capture = "stepped"; }),
    "shots[0].capture.mode", /subject entity is moving/);
  const b = validatePlan(basePlan((p) => { p.shots[0].subject = { kind: "entity", ref: "Drudge", moving: true }; }));
  assert.equal(b.warnings.filter((w) => w.path === "shots[0].capture.mode").length, 0, "auto realtime → no warning");
  assert.equal(b.plan.shots[0].capture.mode, "realtime");
  expectError(basePlan((p) => { p.shots[0].capture = { mode: "fast" }; }), "shots[0].capture.mode");
});

check("player subject + walking actor (moveTo / moves) → subject.moving true (the page follows it live); explicit wins; validated", () => {
  const walkTo = (subject, actor, more = {}) => basePlan((p) => { p.shots[0].subject = subject; p.shots[0].actor = actor; Object.assign(p.shots[0], more); });
  const a = normalizePlan(walkTo("player", { moveTo: [32552, 34567, 94] }));
  assert.deepEqual(a.shots[0].subject, { kind: "player", moving: true }, "moveTo walks the player subject");
  assert.equal(a.shots[0].capture.mode, "realtime");
  assert.deepEqual(normalizePlan(a), a, "idempotent");
  assert.deepEqual(shotSpec(a.shots[0], 6).subject, { kind: "player", moving: true }, "the ShotSpec the page builds from carries it");
  assert.equal(normalizePlan(walkTo({ kind: "player" }, { emote: "/wave", moves: true })).shots[0].subject.moving, true, "moves: true");
  assert.deepEqual(normalizePlan(walkTo({ kind: "player" }, { emote: "/bow" })).shots[0].subject, { kind: "player" }, "standing actor → no moving");
  assert.deepEqual(normalizePlan(walkTo({ kind: "player" }, null)).shots[0].subject, { kind: "player" }, "no actor → no moving");
  assert.equal(normalizePlan(walkTo({ kind: "entity", ref: "Drudge" }, { moveTo: [1, 2, 3] })).shots[0].subject.moving, false, "the actor is the player, not the entity");
  // validatePlan normalizes too: the compiled take inherits it, and the walk needs no warning.
  const v = validatePlan(walkTo("player", { moveTo: [32552, 34567, 94] }));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.plan.shots[0].subject.moving, true);
  assert.deepEqual(v.warnings.filter((w) => w.path.startsWith("shots[0].subject") || w.path === "shots[0].capture.mode"), []);
  // Explicit moving:false wins but warns (framing stays on the start point); a non-boolean is an error.
  const off = expectWarning(walkTo({ kind: "player", moving: false }, { moveTo: [32552, 34567, 94] }), "shots[0].subject.moving", /actor walks.*moving: false/);
  assert.equal(off.plan.shots[0].subject.moving, false);
  expectError(walkTo({ kind: "player", moving: "yes" }, null), "shots[0].subject.moving", /true or false/);
  // An explicitly moving player (no actor) is server-driven motion too: realtime by default, stepped warns.
  assert.equal(normalizePlan(walkTo({ kind: "player", moving: true }, null)).shots[0].capture.mode, "realtime");
  expectWarning(walkTo({ kind: "player", moving: true }, null, { capture: "stepped" }), "shots[0].capture.mode", /subject player is moving/);
  // moveTo with an explicit moves:false still walks (moveTo wins, as for capture) and the warning names the actor.
  expectWarning(walkTo({ kind: "point", pos: [32532, 34567, 95] }, { moveTo: [1, 2, 3], moves: false }, { capture: "stepped" }), "shots[0].capture.mode", /the actor moves/);
});

check("transition, framing, fov, roll, ease, seed, pilot, actor, look, route, cell", () => {
  expectError(basePlan((p) => { p.shots[1].transition = "wipe"; }), "shots[1].transition.type", /cut, dissolve, fade, fadewhite/);
  expectError(basePlan((p) => { p.shots[1].transition = { type: "dissolve", durationSec: 0 }; }), "shots[1].transition.durationSec");
  expectError(basePlan((p) => { p.shots[1].transition = { type: "dissolve", durationSec: 9 }; }), "shots[1].transition.durationSec", /≤ 5/);
  expectError(basePlan((p) => { p.shots[1].transition = { type: "dissolve", xfade: "spinny" }; }), "shots[1].transition.xfade");
  assert.equal(validatePlan(basePlan((p) => { p.shots[1].transition = { type: "dissolve", xfade: "wipeleft" }; })).ok, true);
  expectError(basePlan((p) => { p.shots[0].framing = "MEDIUM"; }), "shots[0].framing", /EWS, WS/);
  expectError(basePlan((p) => { p.shots[0].fov = 200; }), "shots[0].fov", /vertical degrees/);
  expectError(basePlan((p) => { p.shots[0].roll = 4; }), "shots[0].roll", /radians/);
  expectError(basePlan((p) => { p.shots[0].ease = "sineInOtu"; }), "shots[0].ease", /did you mean "sineInOut"/);
  expectError(basePlan((p) => { p.shots[0].seed = -1; }), "shots[0].seed");
  expectError(basePlan((p) => { p.shots[0].pilot = { mode: "auto" }; }), "shots[0].pilot.mode", /jev, code, shadow/);
  expectError(basePlan((p) => { p.defaults = { pilot: { mode: "autopilot" } }; }), "defaults.pilot.mode");
  expectError(basePlan((p) => { p.shots[0].actor = { moveTo: [1, 2] }; }), "shots[0].actor.moveTo");
  expectError(basePlan((p) => { p.shots[0].actor = { emote: "" }; }), "shots[0].actor.emote");
  expectWarning(basePlan((p) => { p.shots[0].actor = { dance: true }; }), "shots[0].actor.dance");
  expectError(basePlan((p) => { p.shots[0].look = { grade: "sepia" }; }), "shots[0].look.grade");
  expectError(basePlan((p) => { p.shots[0].look = { timeOfDay: "teatime" }; }), "shots[0].look.timeOfDay", /dawn/);
  expectError(basePlan((p) => { p.shots[0].look = { timeOfDay: 1.5 }; }), "shots[0].look.timeOfDay");
  expectError(basePlan((p) => { p.sites[0].look = { fog: "purple" }; }), "sites[0].look.fog");
  expectWarning(basePlan((p) => { p.shots[0].look = { sparkle: 1 }; }), "shots[0].look.sparkle", /unknown look key/);
  expectError(basePlan((p) => { p.shots[1].route = { fromCell: "0xA9B40019", toCell: "0x01F6027A" }; }), "shots[1].route.fromCell", /not an indoor EnvCell/);
  expectError(basePlan((p) => { p.shots[1].route = { fromCell: "0x01F60289" }; }), "shots[1].route.toCell");
  expectError(basePlan((p) => { p.shots[1].cell = "cellar"; }), "shots[1].cell");
  expectWarning(basePlan((p) => { p.shots[0].standingorder = "x"; }), "shots[0].standingorder", /did you mean "standingOrder"/);
  expectWarning(basePlan((p) => { p.shots[1].section = 2; }), "shots[1].section", /ignored.*start: \{section: N\}/);
});

check("assertValidPlan returns the normalized plan or throws FilmPlanError with details.errors", () => {
  const p = assertValidPlan(basePlan());
  assert.equal(p.format.fps, 30);
  try {
    assertValidPlan(basePlan((pl) => { pl.shots[0].site = "nope"; pl.shots[1].id = "s010"; }));
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof FilmPlanError);
    assert.equal(e.code, "PLAN_INVALID");
    assert.deepEqual(paths(e.details.errors).sort(), ["shots[0].site", "shots[1].id"]);
    assert.match(e.message, /2 error\(s\)/);
  }
});

check("dryBuild with registry.buildShot: failures become warnings, the spec carries the duration", () => {
  const seen = [];
  const registry = makeRegistry({
    buildShot(spec, ctx) {
      seen.push({ spec, ctx });
      if (spec.technique === "fpv.fpv-corridor") throw new Error("no indoor route in ctx");
      return { id: "t", duration: spec.duration };
    },
  });
  const v = validatePlan(basePlan(), { registry, dryBuild: true });
  assert.equal(v.ok, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].spec.duration, 6);
  assert.deepEqual(seen[0].ctx.anchor, [32532, 34567.1, 94]);
  assert.deepEqual(seen[0].ctx.subject.pos, [32532, 34567, 95]);
  assert.equal(seen[0].ctx.groundZ(1, 2), null);
  const w = v.warnings.find((x) => x.path === "shots[1]");
  assert.ok(w && /dry build of fpv\.fpv-corridor failed.*no indoor route/.test(w.message), JSON.stringify(v.warnings));
});

// ── capture hint, bounds, look.dof, dry-build route ─────────────────────────────────────────────────────────

console.log("film_plan_schema: capture hint, shot bounds, look.dof, dry-build route");

/** A one-site outdoor plan whose single shot is `shot` (id s1, site a). */
function onePlan(shot, extra = {}) {
  return {
    version: 1, title: "One shot",
    sites: [{ id: "a", teleport: "@telepoi Holtburg", anchor: [32532, 34567.1, 94] }],
    shots: [{ id: "s1", site: "a", duration: { sec: 4 }, standingOrder: "Hold the subject in frame at 6 m.", ...shot }],
    ...extra,
  };
}
const captureWarn = (v) => v.warnings.find((w) => w.path === "shots[0].capture.mode");

check("capture hint (registry): realtime-hint technique + entity/player subject → realtime (auto); point → stepped + warning", () => {
  const registry = makeRegistry();
  for (const subject of [{ kind: "player" }, "player", { kind: "entity", ref: "Town Crier" }]) {
    const v = validatePlan(onePlan({ technique: "classic.tracking-follow", subject }), { registry });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.deepEqual(v.plan.shots[0].capture, { mode: "realtime", auto: true }, JSON.stringify(subject));
    assert.equal(captureWarn(v), undefined, "auto realtime → no capture warning");
    assert.deepEqual(normalizePlan(onePlan({ technique: "classic.tracking-follow", subject }), { registry }).shots[0].capture, { mode: "realtime", auto: true });
  }
  // Without a registry the hint is unknown: the plan default stands (no false warning either).
  const bare = validatePlan(onePlan({ technique: "classic.tracking-follow", subject: { kind: "player" } }));
  assert.equal(bare.plan.shots[0].capture.mode, "stepped");
  assert.equal(captureWarn(bare), undefined);
  // A point subject cannot be server-driven: stays stepped, the director is told.
  const pt = expectWarning(onePlan({ technique: "classic.tracking-follow", subject: { kind: "point", pos: [32532, 34567, 95] } }),
    "shots[0].capture.mode", /classic\.tracking-follow is made for a moving, server-driven subject \(capture hint "realtime"\) but the subject is a fixed point/, { registry });
  assert.equal(pt.ok, true, "advice, not an error");
  assert.equal(pt.plan.shots[0].capture.mode, "stepped");
  // Explicit capture wins: stepped on a (static) player is the director's call → silent; realtime on a point → silent.
  const ex = validatePlan(onePlan({ technique: "classic.tracking-follow", subject: { kind: "player" }, capture: "stepped" }), { registry });
  assert.equal(ex.plan.shots[0].capture.mode, "stepped");
  assert.equal(captureWarn(ex), undefined);
  const rt = validatePlan(onePlan({ technique: "classic.tracking-follow", subject: { kind: "point", pos: [1, 2, 3] }, capture: "realtime" }), { registry });
  assert.equal(captureWarn(rt), undefined);
  // …but an explicitly stepped MOVING entity still gets the stronger existing warning.
  expectWarning(onePlan({ technique: "classic.tracking-follow", subject: { kind: "entity", ref: "Drudge", moving: true }, capture: "stepped" }),
    "shots[0].capture.mode", /subject entity is moving/, { registry });
  // format.capture realtime: the point shot is realtime anyway → no warning.
  const fr = validatePlan(onePlan({ technique: "classic.tracking-follow", subject: { kind: "point", pos: [1, 2, 3] } }, { format: { capture: "realtime" } }), { registry });
  assert.equal(fr.plan.shots[0].capture.mode, "realtime");
  assert.equal(captureWarn(fr), undefined);
  // Idempotent with the registry.
  const n1 = normalizePlan(onePlan({ technique: "classic.tracking-follow", subject: { kind: "player" } }), { registry });
  assert.deepEqual(normalizePlan(n1, { registry }), n1);
});

check("capture hint with the REAL registry: the 7 realtime-hint techniques; drone.chase on the player → realtime, tracking-side on a point warns", () => {
  const hinted = SHOTS.REGISTERED_TECHNIQUE_IDS.filter((id) => SHOTS.getTechnique(id).capture === "realtime").sort();
  assert.deepEqual(hinted, ["classic.tracking-follow", "classic.tracking-lead", "classic.tracking-side", "drone.chase", "drone.lead", "drone.side-track", "drone.top-down-track"]);
  for (const id of hinted) {
    const v = validatePlan(onePlan({ technique: id, subject: { kind: "player" } }), { registry: REAL, dryBuild: true });
    assert.equal(v.ok, true, `${id}: ${JSON.stringify(v.errors)}`);
    assert.equal(v.plan.shots[0].capture.mode, "realtime", id);
    assert.deepEqual(v.warnings, [], `${id}: ${JSON.stringify(v.warnings)}`);
  }
  expectWarning(onePlan({ technique: "classic.tracking-side", subject: { kind: "point", pos: [32532, 34567, 95] } }),
    "shots[0].capture.mode", /capture hint "realtime"/, { registry: REAL });
  const orbit = validatePlan(onePlan({ technique: "drone.orbit-poi", subject: { kind: "player" } }), { registry: REAL });
  assert.equal(orbit.plan.shots[0].capture.mode, "stepped", "a stepped-hint technique keeps the plan default");
  assert.equal(captureWarn(orbit), undefined);
});

check("shot bounds: accepted, normalized (null default), passed through shotSpec; keys + ranges = trajectory.js normalizeBounds", () => {
  assert.ok(PLAN_FIELDS.some((f) => f.path === "shots[].bounds"), "documented in PLAN_FIELDS");
  assert.deepEqual(Object.keys(SHOT_BOUND_RULES), [...SHOTS.BOUND_KEYS], "same keys as the registry's Bounds");
  for (const [k, r] of Object.entries(SHOT_BOUND_RULES)) {
    const accepts = (v) => { try { SHOTS.normalizeBounds({ [k]: v }); return true; } catch { return false; } };
    const okHere = (v) => validatePlan(onePlan({ technique: "classic.static", bounds: { [k]: v } })).ok;
    const probes = [r.min, r.min - 0.01, r.min + 0.5, Number.isFinite(r.max) ? r.max : 1e6, Number.isFinite(r.max) ? r.max + 0.01 : -1e6, NaN, "1"];
    for (const v of probes) assert.equal(okHere(v), accepts(v), `${k} = ${String(v)}: schema and normalizeBounds disagree`);
  }
  const v = validatePlan(onePlan({ technique: "classic.static", bounds: { maxLateral: 0.5, maxSpeedScale: 1, minSpeedScale: null } }));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.warnings.find((w) => /bounds/.test(w.path)), undefined, "bounds is a known shot key");
  assert.deepEqual(v.plan.shots[0].bounds, { maxLateral: 0.5, maxSpeedScale: 1, minSpeedScale: null });
  assert.deepEqual(shotSpec(v.plan.shots[0], 4).bounds, { maxLateral: 0.5, maxSpeedScale: 1 }, "null keys dropped (= technique default)");
  const none = normalizePlan(onePlan({ technique: "classic.static" })).shots[0];
  assert.equal(none.bounds, null);
  assert.equal("bounds" in shotSpec(none, 4), false, "no override → no spec.bounds (the trajectory keeps its own)");
  assert.equal("bounds" in shotSpec(normalizePlan(onePlan({ technique: "classic.static", bounds: { maxRise: null } })).shots[0], 4), false, "all-null → omitted");
  // The page builds from take.spec: the override reaches the trajectory, completed from the technique's defaultBounds.
  const traj = SHOTS.buildShot(shotSpec(v.plan.shots[0], 4), { anchor: [32532, 34567.1, 94] });
  assert.deepEqual(traj.bounds, { ...SHOTS.getTechnique("classic.static").defaultBounds, maxLateral: 0.5, maxSpeedScale: 1 });
});

check("shot bounds errors: unknown key (did you mean), out of range per key, not an object", () => {
  expectError(onePlan({ technique: "classic.static", bounds: { maxLaterl: 1 } }), "shots[0].bounds.maxLaterl", /unknown bounds key "maxLaterl" \(did you mean "maxLateral"/);
  expectError(onePlan({ technique: "classic.static", bounds: { maxLateral: -1 } }), "shots[0].bounds.maxLateral", /≥ 0/);
  expectError(onePlan({ technique: "classic.static", bounds: { maxSink: -0.1 } }), "shots[0].bounds.maxSink");
  expectError(onePlan({ technique: "classic.static", bounds: { minSpeedScale: 1.5 } }), "shots[0].bounds.minSpeedScale", /≤ 1/);
  expectError(onePlan({ technique: "classic.static", bounds: { maxSpeedScale: 0.9 } }), "shots[0].bounds.maxSpeedScale", /≥ 1/);
  expectError(onePlan({ technique: "classic.static", bounds: { maxDistanceScale: 0.5 } }), "shots[0].bounds.maxDistanceScale", /≥ 1/);
  expectError(onePlan({ technique: "classic.static", bounds: { maxRise: Infinity } }), "shots[0].bounds.maxRise", /finite/);
  expectError(onePlan({ technique: "classic.static", bounds: "tight" }), "shots[0].bounds", /bounds must be an object/);
  expectError(onePlan({ technique: "classic.static", bounds: [1, 2] }), "shots[0].bounds");
  const edges = { maxLateral: 0, maxRise: 0, maxSink: 0, minSpeedScale: 0, maxSpeedScale: 1, maxDistanceScale: 1 };
  assert.equal(validatePlan(onePlan({ technique: "classic.static", bounds: edges })).ok, true, "edges inclusive");
  assert.equal(validatePlan(onePlan({ technique: "classic.static", bounds: { minSpeedScale: 1 } })).ok, true);
});

check("look.dof: focusRange must be > 0 (window.__dof setter), others ≥ 0; enabled boolean; target shape; unknown keys warn", () => {
  expectError(onePlan({ technique: "classic.static", look: { dof: { focusRange: 0 } } }), "shots[0].look.dof.focusRange", /dof\.focusRange must be > 0 \(got 0\)/);
  expectError(onePlan({ technique: "classic.static", look: { dof: { focusRange: -2 } } }), "shots[0].look.dof.focusRange");
  expectError(onePlan({ technique: "classic.static", look: { dof: { focusDistance: -1 } } }), "shots[0].look.dof.focusDistance", /≥ 0/);
  expectError(onePlan({ technique: "classic.static", look: { dof: { bokehScale: Infinity } } }), "shots[0].look.dof.bokehScale", /finite/);
  expectError(onePlan({ technique: "classic.static", look: { dof: { enabled: "yes" } } }), "shots[0].look.dof.enabled", /true or false/);
  expectError(onePlan({ technique: "classic.static", look: { dof: { target: [1, 2] } } }), "shots[0].look.dof.target", /THREE-world/);
  expectError(onePlan({ technique: "classic.static", look: { dof: { target: "lifestone" } } }), "shots[0].look.dof.target");
  expectError(onePlan({ technique: "classic.static" }, { defaults: { look: { dof: 3 } } }), "defaults.look.dof", /dof must be/);
  expectError(onePlan({ technique: "classic.static" }, { sites: [{ id: "a", teleport: "@telepoi Holtburg", anchor: [32532, 34567.1, 94], look: { dof: { focusRange: 0 } } }] }), "sites[0].look.dof.focusRange");
  expectWarning(onePlan({ technique: "classic.static", look: { dof: { focusRang: 3 } } }), "shots[0].look.dof.focusRang", /unknown dof key "focusRang" \(did you mean "focusRange"\?\).*ignores it/);
  expectWarning(onePlan({ technique: "classic.static", look: { dof: { target: [32532, 34567, 95] } } }), "shots[0].look.dof.target", /AC world coordinates pasted/);
  const okDofs = [
    { focusRange: 0.01, focusDistance: 0, bokehScale: 0 }, { focusRange: 3, bokehScale: 2, enabled: false },
    { focusDistance: 12, target: null }, { target: [32532, 95, -34567] }, { target: { x: 1, y: 2, z: 3 } },
    { focusRange: null, focusDistance: null, bokehScale: null }, {},
  ];
  for (const dof of okDofs) {
    const v = validatePlan(onePlan({ technique: "classic.static", look: { dof } }));
    assert.equal(v.ok, true, `${JSON.stringify(dof)}: ${JSON.stringify(v.errors)}`);
    assert.deepEqual(v.warnings, [], `${JSON.stringify(dof)}: ${JSON.stringify(v.warnings)}`);
  }
  assert.deepEqual(LOOK_DOF_KEYS, ["focusDistance", "focusRange", "bokehScale", "enabled", "target"]);
});

check("look.dof rules are pinned to the real seam: createFilmDof setters (focusRange positive) + runtime/look.js forwarded keys", () => {
  const src = readFileSync(new URL("../scene3d/atmosphere_pipeline.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function createFilmDof("), src.indexOf("export function createAtmospherePipeline("));
  assert.ok(body.length > 100, "createFilmDof found");
  assert.match(body, /positive \? v <= 0 : v < 0/, "num(): positive → > 0, else ≥ 0");
  assert.match(body, /set focusRange\(v\) \{[^}]*num\("focusRange", v, true\)/, "focusRange is the strictly positive one");
  assert.match(body, /set focusDistance\(v\) \{[^}]*num\("focusDistance", v, false\)/);
  assert.match(body, /set bokehScale\(v\) \{[^}]*num\("bokehScale", v, false\)/);
  const look = readFileSync(new URL("../scene3d/film/runtime/look.js", import.meta.url), "utf8");
  const dofSet = look.slice(look.indexOf("dof: {"), look.indexOf("function relight("));
  for (const k of ["focusRange", "bokehScale", "focusDistance", "target", "enabled"]) assert.ok(dofSet.includes(k), `look.js dof.set handles ${k}`);
});

check("dry build: a shot with a route gets a synthetic indoor L route through the anchor; an indoor site gets indoor:{}", () => {
  const seen = [];
  const registry = makeRegistry({ buildShot(spec, ctx) { seen.push({ spec, ctx }); return { id: "t", duration: spec.duration }; } });
  const plan = basePlan((p) => {
    p.shots.push({ id: "s030", site: "crypt", technique: "classic.static", duration: { sec: 2 }, standingOrder: "Hold still." });
  });
  const v = validatePlan(plan, { registry, dryBuild: true });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.warnings, []);
  const [outdoor, routed, indoorNoRoute] = seen.map((x) => x.ctx);
  assert.equal(outdoor.indoor, undefined, "outdoor shot: no indoor context");
  const a = v.plan.sites[1].anchor;
  assert.deepEqual(routed.indoor.route, [[a[0] - DRY_ROUTE_LEG_M, a[1], a[2]], a, [a[0], a[1] + DRY_ROUTE_LEG_M, a[2]]], "2-leg L, corner at the anchor");
  const [p0, p1, p2] = routed.indoor.route;
  const dot = (p1[0] - p0[0]) * (p2[0] - p1[0]) + (p1[1] - p0[1]) * (p2[1] - p1[1]);
  assert.equal(dot, 0, "one 90° corner");
  assert.deepEqual(indoorNoRoute.indoor, {}, "indoor site without a route: indoor:{} as in the page");
});

check("dry build with the REAL registry: examplePlan has zero warnings; its all-seconds variant dry-builds fpv.fpv-corridor via the route", () => {
  const v = validatePlan(examplePlan(), { registry: REAL, dryBuild: true });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.warnings, []);
  // Music-video durations are beats/bars (not dry-built); make every shot {sec} so all 8 — the dungeon corridor
  // shot with only a `route` included — are really built offline.
  const secs = examplePlan();
  delete secs.song;
  for (const s of secs.shots) { s.duration = { sec: 4 }; delete s.start; }
  let builds = 0;
  const counting = { getTechnique: REAL.getTechnique, buildShot: (spec, ctx) => { builds++; return REAL.buildShot(spec, ctx); } };
  const w = validatePlan(secs, { registry: counting, dryBuild: true });
  assert.equal(w.ok, true, JSON.stringify(w.errors));
  assert.equal(builds, 8, "every shot dry-built");
  assert.deepEqual(w.warnings, [], JSON.stringify(w.warnings));
  // fpv.fpv-corridor really needs the route: with the route removed (and no path) the real build fails → warning.
  const noRoute = examplePlan();
  noRoute.shots[3].duration = { sec: 4 };
  noRoute.shots[3].path = [[288, 47220, 1], [280, 47220, 1]];
  delete noRoute.shots[3].route;
  assert.deepEqual(validatePlan(noRoute, { registry: REAL, dryBuild: true }).warnings, [], "an explicit path also satisfies it");
  delete noRoute.shots[3].path;
  expectWarning(noRoute, "shots[3]", /dry build of fpv\.fpv-corridor failed.*needs a route/, { registry: REAL, dryBuild: true });
});

check("dry build is skipped for an indoor/outdoor technique mismatch (one error, no dry-build warning)", () => {
  const plan = basePlan((p) => { p.shots[1] = { id: "s020", site: "crypt", technique: "drone.pass-over", duration: { sec: 4 }, subject: { kind: "point", pos: [288.7, 47222, 1.5] }, standingOrder: "Pass over the altar." }; });
  const v = validatePlan(plan, { registry: REAL, dryBuild: true });
  assert.equal(v.ok, false, "an outdoor-only technique at an indoor site cannot build on the page");
  assert.deepEqual(v.errors.map((e) => e.path), ["shots[1].technique"], JSON.stringify(v.errors));
  assert.match(v.errors[0].message, /outdoor technique but site "crypt" is indoors/);
  assert.deepEqual(v.warnings.filter((w) => w.path.startsWith("shots[1]")), [], JSON.stringify(v.warnings));
});

console.log(`film_plan_schema: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
