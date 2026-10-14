// tests/film_pilot_words.test.mjs
//
// WHY: the AC Film Mode camera pilot asks JEV (TypeSafe's System-One decision
// model) for bounded maneuvers several times a second. JEV is "not a
// calculator": it judges reliably only when code turns every measurement into
// a named bucket and the question criteria quote those exact bucket names with
// explicit boundaries. A boundary that drifts between the bucketers and the
// criteria text, a state leaf that leaks a raw number, a fingerprint that
// changes when nothing changed (burning paid JEV calls), or a malformed
// Decisions-API body would all fail silently in flight. This suite executes the
// real pilot modules:
//   W1  sense_words.js   WORD_BOUNDS (SPEC §2.14 boundaries, exact edges, NaN-safe
//                        bucketers, rankOf / leadingWord / bandText helpers)
//   W2  scene_state.js   SensorFrame → words-only state (every SPEC field, no
//                        numbers, subject/no-subject, shot-bound limits, sanitising)
//   W3  fingerprint.js   stable, key-order independent, excludes `current`
//   W4  questions.js     Decisions-API questions valid (cross-checked with the Node
//                        JEV client's validator), conservative default first,
//                        criteria quote WORD_BOUNDS words + boundaries
//   W5  buildDecisionRequest / parseDecisionAnswers (body shape, answers by name,
//                        malformed answers rejected; agrees with tools/film/lib/jev.mjs)
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its pure pilot modules.
// Run from apps/holtburger-web/: node tests/film_pilot_words.test.mjs

import assert from "node:assert/strict";

const W = await import("../scene3d/film/pilot/sense_words.js");
const S = await import("../scene3d/film/pilot/scene_state.js");
const F = await import("../scene3d/film/pilot/fingerprint.js");
const Q = await import("../scene3d/film/pilot/questions.js");
const E = await import("../scene3d/film/core/errors.js");
const J = await import("../tools/film/lib/jev.mjs");

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

const I = Infinity;

/** Table check: fn(input) === expected for every row. */
function table(fn, rows, label) {
  for (const [input, want] of rows) {
    const got = Array.isArray(input) ? fn(...input) : fn(input);
    assert.equal(got, want, `${label}(${JSON.stringify(input)}) → ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

/** A complete open-air SensorFrame (SPEC §3.1) with overrides merged one level deep. */
function frame(over = {}) {
  const f = {
    t: 0,
    pose: { pos: [0, 0, 10], h: 0, p: 0, r: 0, q: [1, 0, 0, 0], fov: 60 },
    speedMps: 4,
    sectors: {
      far_left: { range: I, kind: null },
      left: { range: I, kind: null },
      center: { range: I, kind: null },
      right: { range: I, kind: null },
      far_right: { range: I, kind: null },
    },
    freeAhead: { level: I, above: I, below: I },
    sides: { left: I, right: I, up: I, down: I, back: I },
    nearest: { range: I, kind: null, bearingDeg: 0, elevDeg: 0 },
    pathAhead: { ttc: I, kind: null },
    subject: { visibleFrac: 1, unseenSec: 0, ndc: [0, 0], sizeRatio: 1, occluderKind: null },
    particles: { onLens: null, inView: [] },
    limits: { canRise: true, canSink: true, roomLeft: 5, roomRight: 5, ceiling: I },
    ages: {},
  };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && f[k] && typeof f[k] === "object") f[k] = { ...f[k], ...v };
    else f[k] = v;
  }
  return f;
}

/** Every leaf path of an object. */
function leaves(o, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...leaves(v, p));
    else out.push([p, v]);
  }
  return out;
}

console.log("W1 sense_words.js — WORD_BOUNDS and bucketers");

check("WORD_BOUNDS is deep-frozen and every scale is strictly increasing, ending at Infinity", () => {
  assert.ok(Object.isFrozen(W.WORD_BOUNDS));
  for (const name of W.SCALE_NAMES) {
    const s = W.WORD_BOUNDS[name];
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.bands), `${name} frozen`);
    let prev = -I;
    for (const b of s.bands) {
      assert.ok(Object.isFrozen(b), `${name} band frozen`);
      assert.ok(b.max > prev || (b.max === prev && !b.inclusive), `${name}: bands must increase (${b.max} after ${prev})`);
      prev = b.max;
    }
    assert.equal(s.bands[s.bands.length - 1].max, I, `${name} last band unbounded`);
  }
  assert.throws(() => {
    "use strict";
    W.WORD_BOUNDS.distance.bands[0].max = 99;
  });
});

check("SPEC §2.14 boundaries: distance / ttc / visibility / unseen / size words and edges", () => {
  const b = (scale) => W.WORD_BOUNDS[scale].bands.map((x) => [x.word, x.max, !!x.inclusive]);
  assert.deepEqual(b("distance"), [
    ["touching", 0.75, false], ["very close", 2, false], ["close", 4, false], ["near", 8, false],
    ["medium", 16, false], ["far", 40, false], ["clear", I, false],
  ]);
  assert.deepEqual(b("ttc"), [["imminent", 0.75, false], ["soon", 2, false], ["later", 5, false], ["none", I, false]]);
  assert.deepEqual(b("visibility"), [["fully hidden", 0.1, false], ["mostly hidden", 0.4, false], ["partly hidden", 0.8, false], ["clear", I, false]]);
  assert.deepEqual(b("unseen"), [["not hidden", 0, true], ["brief", 1, false], ["a while", 3, false], ["long", I, false]]);
  assert.deepEqual(b("size"), [
    ["much too small", 0.5, false], ["too small", 0.8, false], ["right", 1.25, true], ["too large", 2, true], ["much too large", I, false],
  ]);
});

check("distanceWord: exact edges, negative → touching, NaN/null/Infinity → clear", () => {
  table(W.distanceWord, [
    [0, "touching"], [0.7499, "touching"], [0.75, "very close"], [1.999, "very close"], [2, "close"], [3.999, "close"],
    [4, "near"], [7.99, "near"], [8, "medium"], [16, "far"], [39.9, "far"], [40, "clear"], [I, "clear"],
    [-1, "touching"], [-I, "touching"], [NaN, "clear"], [null, "clear"], [undefined, "clear"], ["3", "close"],
  ], "distanceWord");
});

check("ttcWord: imminent <0.75, soon <2, later <5, else none; invalid → none", () => {
  table(W.ttcWord, [
    [0, "imminent"], [0.74, "imminent"], [0.75, "soon"], [1.99, "soon"], [2, "later"], [4.99, "later"], [5, "none"],
    [I, "none"], [NaN, "none"], [null, "none"], [-0.5, "none"],
  ], "ttcWord");
});

check("bearingWord: + = right, |b| bands 10/35/80/150, wraps, NaN → unknown", () => {
  table(W.bearingWord, [
    [0, "dead ahead"], [9.99, "dead ahead"], [-9.99, "dead ahead"], [10, "ahead-right"], [-10, "ahead-left"],
    [34.9, "ahead-right"], [35, "right"], [-79, "left"], [80, "behind-right"], [-149, "behind-left"], [150, "behind"],
    [180, "behind"], [-180, "behind"], [370, "ahead-right"], [-350, "ahead-right"], [NaN, "unknown"], [null, "unknown"],
  ], "bearingWord");
});

check("elevationWord: level / slightly / above|below / overhead|underneath, clamped, NaN → unknown", () => {
  table(W.elevationWord, [
    [0, "level"], [9.9, "level"], [10, "slightly above"], [-15, "slightly below"], [30, "above"], [-59, "below"],
    [60, "overhead"], [-90, "underneath"], [200, "overhead"], [NaN, "unknown"],
  ], "elevationWord");
});

check("visibilityWord / unseenWord / sizeWord: edges and robust inputs", () => {
  table(W.visibilityWord, [
    [0, "fully hidden"], [0.0999, "fully hidden"], [0.1, "mostly hidden"], [0.39, "mostly hidden"], [0.4, "partly hidden"],
    [0.79, "partly hidden"], [0.8, "clear"], [1, "clear"], [1.5, "clear"], [-0.2, "fully hidden"], [NaN, "clear"], [null, "clear"],
  ], "visibilityWord");
  table(W.unseenWord, [
    [0, "not hidden"], [-1, "not hidden"], [0.01, "brief"], [0.999, "brief"], [1, "a while"], [2.99, "a while"], [3, "long"],
    [I, "long"], [NaN, "not hidden"], [null, "not hidden"],
  ], "unseenWord");
  table(W.sizeWord, [
    [0.49, "much too small"], [0.5, "too small"], [0.79, "too small"], [0.8, "right"], [1, "right"], [1.25, "right"],
    [1.2501, "too large"], [2, "too large"], [2.0001, "much too large"], [I, "much too large"], [-1, "much too small"],
    [0, "much too small"], [NaN, "right"], [null, "right"],
  ], "sizeWord");
});

check("offsetWord: bands on max|NDC|, direction words, null/NaN → out of frame", () => {
  table(W.offsetWord, [
    [[0, 0], "centred"], [[0.19, -0.19], "centred"], [[0.2, 0], "slightly off-centre (right)"],
    [[-0.3, 0.3], "slightly off-centre (up-left)"], [[0.6, -0.1], "off-centre (right)"], [[0, -0.7], "off-centre (down)"],
    [[0.85, 0], "near the edge (right)"], [[0.9, 0.5], "near the edge (up-right)"], [[1, 0], "out of frame (right)"],
    [[-3, 0.2], "out of frame (left)"], [[null, null], "out of frame"], [[NaN, 0], "out of frame"],
  ], "offsetWord");
  assert.equal(W.offsetWord([0.5, 0.5]), "off-centre (up-right)", "array form");
  assert.equal(W.offsetWord(null), "out of frame");
});

check("speed / since / room / density / yesNo bucketers", () => {
  table(W.speedWord, [[0, "stopped"], [0.25, "creeping"], [-2, "slow"], [3, "moderate"], [7, "fast"], [15, "very fast"], [NaN, "stopped"]], "speedWord");
  table(W.sinceWord, [[0, "just now"], [0.5, "recently"], [1.5, "a while"], [4, "long"], [-1, "just now"], [NaN, "just now"]], "sinceWord");
  table(W.roomWord, [
    [0, "none"], [0.75, "little"], [2, "some"], [4, "plenty"], [I, "plenty"], [true, "plenty"], [false, "none"],
    [-1, "none"], [NaN, "none"], [null, "none"],
  ], "roomWord");
  table(W.densityWord, [[0, "thin"], [0.3, "moderate"], [0.7, "thick"], [NaN, "thin"]], "densityWord");
  table(W.yesNo, [[true, "yes"], [false, "no"], [1, "no"], [null, "no"]], "yesNo");
});

check("kindWord / occluderClass normalise kinds", () => {
  table((k, f) => W.kindWord(k, f), [
    [["Tree"], "tree"], [["smoke"], "particles"], [["FIRE"], "particles"], [["scenery"], "tree"], [["monster"], "creature"],
    [["xyz"], "obstacle"], [["xyz", "unknown"], "unknown"], [[null], "obstacle"], [[42], "obstacle"], [["  "], "obstacle"],
  ], "kindWord");
  for (const k of W.OBSTACLE_KINDS) assert.notEqual(W.occluderClass(k), null, `${k} must belong to an occluder class`);
  assert.equal(W.occluderClass("tree"), "soft");
  assert.equal(W.occluderClass("wall"), "solid");
  assert.equal(W.occluderClass("creature"), "moving");
  assert.equal(W.occluderClass("unknown"), null);
});

check("rankOf / leadingWord / wordsUpTo / wordsFrom / scaleWords", () => {
  assert.deepEqual(W.scaleWords("distance"), ["touching", "very close", "close", "near", "medium", "far", "clear"]);
  assert.equal(W.rankOf("close", "distance"), 2);
  assert.equal(W.rankOf("close tree", "distance"), 2);
  assert.equal(W.rankOf("very close wall", "distance"), 1, "longest match wins");
  assert.equal(W.rankOf("clear", "distance"), 6);
  assert.equal(W.rankOf("closet", "distance"), -1, "prefix must end at a word boundary");
  assert.equal(W.rankOf("near the edge (left)", "offset"), 3);
  assert.equal(W.rankOf("ahead-left", "bearing"), 1);
  assert.equal(W.rankOf("ahead-right", "bearing"), 1);
  assert.equal(W.rankOf("nope", "distance"), -1);
  assert.equal(W.rankOf(42, "distance"), -1);
  assert.equal(W.rankOf("b", ["a", "b", "c"]), 1);
  assert.equal(W.rankOf("x", "no-such-scale"), -1);
  assert.equal(W.leadingWord("far rock", "distance"), "far");
  assert.equal(W.leadingWord("out of frame (left)", "offset"), "out of frame");
  assert.equal(W.leadingWord("rocky", "distance"), null);
  assert.deepEqual(W.wordsUpTo("distance", "close"), ["touching", "very close", "close"]);
  assert.deepEqual(W.wordsFrom("room", "some"), ["some", "plenty"]);
  assert.deepEqual(W.wordsUpTo("distance", "nope"), []);
});

check("bandText / quoteBand are generated from WORD_BOUNDS", () => {
  assert.equal(W.bandText("distance", "touching"), "under 0.75 m");
  assert.equal(W.bandText("distance", "close"), "2–4 m");
  assert.equal(W.bandText("distance", "clear"), "nothing within 40 m");
  assert.equal(W.bandText("ttc", "soon"), "0.75–2 s");
  assert.equal(W.bandText("speed", "very fast"), "15 m/s or more");
  assert.equal(W.bandText("bearing", "ahead-left"), "10–35°");
  assert.equal(W.bandText("room", "plenty"), "4 m or more");
  assert.equal(W.bandText("distance", "nope"), "");
  assert.equal(W.quoteBand("distance", "close"), '"close" (2–4 m)');
  // Every band of every scale yields a non-empty description.
  for (const name of W.SCALE_NAMES) for (const w of W.scaleWords(name)) assert.ok(W.bandText(name, w).length > 0, `${name}/${w}`);
});

console.log("W2 scene_state.js — SensorFrame → words-only state");

check("full frame → every SPEC field present, words only, STATE_PATHS exact", () => {
  const st = S.buildPilotState(frame(), { standingOrder: "Glide past the lifestone.", technique: "drone.flyover", goal: "reveal" });
  assert.ok(S.isWordsOnly(st), "every leaf is a string");
  const paths = leaves(st).map(([p]) => p);
  assert.deepEqual(paths, [...S.STATE_PATHS]);
  assert.equal(st.standing_order, "Glide past the lifestone.");
  assert.deepEqual(st.shot, { technique: "drone.flyover", goal: "reveal" });
  assert.equal(st.camera.speed, "moderate");
  for (const k of Object.keys(st.obstacles)) assert.equal(st.obstacles[k], "clear", k);
  assert.deepEqual(st.free_space, { level_ahead: "clear", above_ahead: "clear", below_ahead: "clear" });
  assert.deepEqual(st.nearest, { kind: "none", range: "clear", side: "none" });
  assert.deepEqual(st.path_ahead, { contact_in: "none", blocker: "none" });
  assert.deepEqual(st.subject, { visibility: "clear", unseen_for: "not hidden", in_frame: "centred", size: "right", occluded_by: "nothing" });
  assert.deepEqual(st.particles, { on_lens: "none", in_view: "none" });
  assert.deepEqual(st.limits, {
    can_rise: "yes", can_sink: "yes", can_drift_left: "yes", can_drift_right: "yes", room_left: "plenty", room_right: "plenty", ceiling: "clear",
  });
  assert.deepEqual(Object.keys(st.limits), ["can_rise", "can_sink", "can_drift_left", "can_drift_right", "room_left", "room_right", "ceiling"]);
  assert.deepEqual(st.current, { maneuver: "hold_path", since: "just now" });
});

check("sectors/sides map to the SPEC obstacle slots as '<range> <kind>'", () => {
  const st = S.buildPilotState(
    frame({
      sectors: { far_left: { range: 30, kind: "rock" }, left: { range: 3, kind: "tree" }, center: { range: 1.5, kind: "wall" },
        right: { range: 6, kind: "smoke" }, far_right: { range: 0.5, kind: "mystery" } },
      sides: { left: 1.2, right: { range: 9, kind: "building" }, up: { range: 2.5, kind: "terrain" }, down: 0.6, back: 50 },
    }),
  );
  assert.deepEqual(st.obstacles, {
    far_left: "far rock", left: "close tree", ahead: "very close wall", right: "near particles", far_right: "touching obstacle",
    above: "close terrain", below: "touching obstacle", left_side: "very close obstacle", right_side: "medium building", behind: "clear",
  });
});

check("nearest: bearing side, overhead/underneath → above/below, path_ahead blocker", () => {
  let st = S.buildPilotState(frame({ nearest: { range: 1.5, kind: "Tree", bearingDeg: -20, elevDeg: 5 }, pathAhead: { ttc: 1.2, kind: "rock" } }));
  assert.deepEqual(st.nearest, { kind: "tree", range: "very close", side: "ahead-left" });
  assert.deepEqual(st.path_ahead, { contact_in: "soon", blocker: "rock" });
  st = S.buildPilotState(frame({ nearest: { range: 1, kind: "building", bearingDeg: 0, elevDeg: 75 } }));
  assert.equal(st.nearest.side, "above");
  st = S.buildPilotState(frame({ nearest: { range: 1, kind: "terrain", bearingDeg: 90, elevDeg: -80 } }));
  assert.equal(st.nearest.side, "below");
  st = S.buildPilotState(frame({ nearest: { range: 3, kind: "rock", bearingDeg: NaN } }));
  assert.equal(st.nearest.side, "unknown");
  st = S.buildPilotState(frame({ pathAhead: { ttc: 9, kind: "rock" } }));
  assert.deepEqual(st.path_ahead, { contact_in: "none", blocker: "none" });
});

check("subject words: occluder, just-hidden → brief, ndc null → out of frame, no subject", () => {
  let st = S.buildPilotState(frame({ subject: { visibleFrac: 0.25, unseenSec: 0, ndc: [0.9, 0.1], sizeRatio: 0.6, occluderKind: "tree" } }));
  assert.deepEqual(st.subject, { visibility: "mostly hidden", unseen_for: "not hidden", in_frame: "near the edge (right)", size: "too small", occluded_by: "tree" });
  st = S.buildPilotState(frame({ subject: { visibleFrac: 0.02, unseenSec: 0, ndc: null, sizeRatio: 1, occluderKind: undefined } }));
  assert.equal(st.subject.unseen_for, "brief", "fully hidden with a not-yet-started timer is a brief occlusion");
  assert.equal(st.subject.in_frame, "out of frame");
  assert.equal(st.subject.occluded_by, "unknown");
  st = S.buildPilotState(frame({ subject: null }));
  for (const v of Object.values(st.subject)) assert.equal(v, S.NO_SUBJECT);
  st = S.buildPilotState(frame(), { hasSubject: false });
  assert.equal(st.subject.visibility, S.NO_SUBJECT, "opts.hasSubject false wins");
});

check("particles: on-lens density + family, nearest occluding cloud first", () => {
  const st = S.buildPilotState(
    frame({
      particles: {
        onLens: { family: "Smoke!", density: 0.8 },
        inView: [{ family: "fire", occludes: false, range: 2 }, { family: "smoke", occludes: true, range: 6 }, { family: "dust", occludes: true, range: 3 }],
      },
    }),
  );
  assert.equal(st.particles.on_lens, "thick smoke");
  assert.equal(st.particles.in_view, "close dust blocking the view (+2 more)");
});

check("limits: booleans → yes/no (unknown → no), room fallback to side clearance, shot bounds → can_* yes/no", () => {
  let st = S.buildPilotState(frame({ limits: { canRise: undefined, canSink: false, roomLeft: undefined, roomRight: false, ceiling: 3 }, sides: { left: 1.5 } }));
  assert.deepEqual(st.limits, {
    can_rise: "no", can_sink: "no", can_drift_left: "yes", can_drift_right: "yes", room_left: "little", room_right: "none", ceiling: "close",
  });
  st = S.buildPilotState(frame(), { bounds: { maxLateral: 3, maxRise: 4, maxSink: 1 }, current: { lateral: -3, vertical: 4 } });
  assert.equal(st.limits.can_drift_left, "no", "already drifted the full lateral bound to the left");
  assert.equal(st.limits.can_drift_right, "yes", "6 m back across the path to the right bound");
  assert.equal(st.limits.room_left, "plenty", "the sensed room is never capped by the shot bound");
  assert.equal(st.limits.room_right, "plenty");
  assert.equal(st.limits.can_rise, "no", "at maxRise");
  assert.equal(st.limits.can_sink, "yes");
  st = S.buildPilotState(frame(), { bounds: { maxSink: 1 }, current: { vertical: -1 } });
  assert.equal(st.limits.can_sink, "no", "at maxSink");
});

check("limits: a lateral bound under 2 m keeps the sensed room word and gates the drift by can_drift_* (jev-0)", () => {
  // Technique presets declare maxLateral 0.15 … 1.5 m (classic body/timed/locked/close/ground/move,
  // drone B_GAP/B_CORRIDOR/B_CLOSE/B_FPV). Capping room_left/right by the bound made every drift
  // unreachable for them ("some" ≥ 2 m); the bound is now a separate yes/no like can_rise.
  const open = frame({ limits: { roomLeft: 10, roomRight: 10 } });
  for (const maxLateral of [0.15, 0.3, 0.5, 0.6, 0.8, 1.5, 2, 3, 6]) {
    const st = S.buildPilotState(open, { bounds: { maxLateral }, current: { lateral: 0 } });
    assert.equal(st.limits.room_left, "plenty", `maxLateral ${maxLateral}: sensed 10 m stays "plenty"`);
    assert.equal(st.limits.room_right, "plenty", `maxLateral ${maxLateral}`);
    assert.equal(st.limits.can_drift_left, "yes", `maxLateral ${maxLateral}: nothing spent yet`);
    assert.equal(st.limits.can_drift_right, "yes", `maxLateral ${maxLateral}`);
  }
  const at = (maxLateral, lateral) => S.buildPilotState(open, { bounds: { maxLateral }, current: { lateral } }).limits;
  const slack = S.BOUND_SLACK_M;
  assert.equal(slack, 0.05);
  assert.deepEqual([at(1.5, -1.4).can_drift_left, at(1.5, -1.4).can_drift_right], ["yes", "yes"], "0.1 m of left bound left");
  assert.deepEqual([at(1.5, -1.46).can_drift_left, at(1.5, -1.46).can_drift_right], ["no", "yes"], "0.04 m left (under the slack) = spent");
  assert.deepEqual([at(0.6, 0.6).can_drift_left, at(0.6, 0.6).can_drift_right], ["yes", "no"], "right bound spent");
  assert.deepEqual([at(0, 0).can_drift_left, at(0, 0).can_drift_right], ["no", "no"], "maxLateral 0 = no lateral freedom");
  assert.equal(at(0.6, 0.6).room_right, "plenty", "spent bound never rewrites the sensed room");
  // No bounds (or a bad maxLateral) → unbounded; the sensed room alone limits the drift.
  for (const bounds of [undefined, {}, { maxLateral: -1 }, { maxLateral: NaN }]) {
    const st = S.buildPilotState(open, { bounds, current: { lateral: -50 } });
    assert.deepEqual([st.limits.can_drift_left, st.limits.can_drift_right], ["yes", "yes"], JSON.stringify(bounds));
  }
  // Sensed room is still the room the sensors report, whatever the bound.
  const tight = S.buildPilotState(frame({ limits: { roomLeft: 0.5, roomRight: 3 } }), { bounds: { maxLateral: 6 } });
  assert.deepEqual([tight.limits.room_left, tight.limits.room_right], ["none", "some"]);
});

check("current maneuver/since and text sanitising (control chars, length cap, defaults)", () => {
  const long = `Hold low. ${"keep the lifestone centred and ".repeat(20)}end`;
  let st = S.buildPilotState(frame(), { standingOrder: "  fly\u0000 low\n\tand   slow ", current: { maneuver: "rise", since: 2 } });
  assert.equal(st.standing_order, "fly low and slow");
  assert.deepEqual(st.current, { maneuver: "rise", since: "a while" });
  st = S.buildPilotState(frame(), { standingOrder: long, current: { maneuver: "teleport", since: "recently" } });
  assert.ok(st.standing_order.length <= S.MAX_STANDING_ORDER_CHARS, "standing order capped");
  assert.ok(!st.standing_order.endsWith(" "), "cut on a word boundary");
  assert.deepEqual(st.current, { maneuver: "hold_path", since: "recently" }, "unknown maneuver → hold_path");
  st = S.buildPilotState(frame(), { standingOrder: 42, technique: "", goal: null });
  assert.equal(st.standing_order, S.DEFAULT_STANDING_ORDER);
  assert.equal(st.shot.technique, "unknown");
});

check("empty / null / NaN frames never throw and still give words only", () => {
  for (const sf of [null, undefined, {}, 42, "x", frame({ speedMps: NaN, nearest: { range: NaN }, freeAhead: { level: NaN },
    sectors: { left: NaN, center: { range: "x" } }, subject: { visibleFrac: NaN, unseenSec: NaN, ndc: [NaN, 1], sizeRatio: NaN },
    limits: { roomLeft: NaN, ceiling: NaN }, particles: { inView: [null, 5, { range: NaN }] } })]) {
    const st = S.buildPilotState(sf, null);
    assert.ok(S.isWordsOnly(st), `words only for ${JSON.stringify(sf)}`);
    assert.deepEqual(leaves(st).map(([p]) => p), [...S.STATE_PATHS]);
  }
});

check("slotRange / obstacleText / stateWord / isWordsOnly helpers", () => {
  assert.equal(S.slotRange(3), 3);
  assert.equal(S.slotRange({ range: 2 }), 2);
  assert.equal(S.slotRange(null), I);
  assert.equal(S.slotRange(NaN), I);
  assert.equal(S.obstacleText(3, "tree"), "close tree");
  assert.equal(S.obstacleText(I, "tree"), "clear");
  assert.equal(S.stateWord({ a: { b: "x" } }, "a.b"), "x");
  assert.equal(S.stateWord({ a: "x" }, "a.b"), undefined);
  assert.equal(S.isWordsOnly({ a: { b: "x" } }), true);
  assert.equal(S.isWordsOnly({ a: { b: 1 } }), false);
});

console.log("W3 fingerprint.js — bucketed-scene fingerprint");

check("fingerprint is key-order independent and ignores `current`", () => {
  const a = S.buildPilotState(frame(), { current: { maneuver: "rise", since: 0.1 } });
  const b = S.buildPilotState(frame(), { current: { maneuver: "sink", since: 9 } });
  assert.equal(F.sceneFingerprint(a), F.sceneFingerprint(b));
  const reordered = Object.fromEntries(Object.entries(a).reverse().map(([k, v]) => [k, v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse()) : v]));
  assert.equal(F.sceneFingerprint(reordered), F.sceneFingerprint(a));
  assert.ok(!F.sceneFingerprint(a).includes('"current"'));
});

check("fingerprint is stable inside a bucket and changes when a word changes", () => {
  const fp = (r) => F.sceneFingerprint(S.buildPilotState(frame({ sectors: { center: { range: r, kind: "tree" } } })));
  assert.equal(fp(2.1), fp(3.9), "both 'close'");
  assert.notEqual(fp(3.9), fp(4.1), "'close' → 'near'");
  assert.notEqual(
    F.sceneFingerprint(S.buildPilotState(frame(), { standingOrder: "A." })),
    F.sceneFingerprint(S.buildPilotState(frame(), { standingOrder: "B." })),
    "the standing order is part of the scene",
  );
});

check("stableStringify / fingerprintHash edge cases", () => {
  assert.equal(F.stableStringify({ b: 1, a: [2, NaN, undefined], c: undefined }), '{"a":[2,null,null],"b":1}');
  const cyc = { a: 1 };
  cyc.self = cyc;
  assert.equal(F.stableStringify(cyc), '{"a":1,"self":"[cycle]"}');
  assert.equal(F.stableStringify(undefined), "null");
  assert.equal(F.sceneFingerprint(null), "null");
  const h = F.fingerprintHash(S.buildPilotState(frame()));
  assert.match(h, /^[0-9a-f]{8}$/);
  assert.equal(h, F.fingerprintHash(F.sceneFingerprint(S.buildPilotState(frame()))));
});

console.log("W4 questions.js — Decisions-API questions");

check("PILOT_QUESTIONS pass the Node JEV client's validator and are deep-frozen", () => {
  const v = J.validateQuestions(JSON.parse(JSON.stringify(Q.PILOT_QUESTIONS)));
  assert.ok(v.ok, v.issues.join("; "));
  assert.ok(Object.isFrozen(Q.PILOT_QUESTIONS.maneuver.criteria));
  assert.ok(Object.isFrozen(Q.PILOT_RULES.riskHigh.contact));
});

check("SPEC option order: conservative default first; risk 3 levels; noul true/false", () => {
  assert.deepEqual(Object.keys(Q.PILOT_QUESTIONS.maneuver.criteria), ["hold_path", "drift_left", "drift_right", "rise", "sink", "slow_down", "back_off"]);
  assert.deepEqual(Object.keys(Q.PILOT_QUESTIONS.occluder_action.criteria), ["ignore", "fade", "reroute", "wait"]);
  assert.deepEqual(Object.keys(Q.PILOT_QUESTIONS.framing.criteria), ["keep", "recenter", "widen", "tighten"]);
  assert.equal(Q.PILOT_QUESTIONS.risk.type, "score");
  assert.equal(Q.PILOT_QUESTIONS.risk.criteria.length, 3);
  Q.RISK_LEVELS.forEach((lvl, i) => assert.ok(Q.PILOT_QUESTIONS.risk.criteria[i].startsWith(`${lvl}:`), `level ${i} is "${lvl}"`));
  assert.equal(Q.PILOT_QUESTIONS.subject_lost.type, "noul");
  assert.deepEqual(Object.keys(Q.PILOT_QUESTIONS.subject_lost.criteria), ["true", "false"]);
  assert.match(Q.PILOT_QUESTIONS.maneuver.criteria.hold_path, /^Default/);
  assert.match(Q.PILOT_QUESTIONS.occluder_action.criteria.ignore, /^Default/);
  assert.match(Q.PILOT_QUESTIONS.framing.criteria.keep, /^Default/);
});

check("every choice criterion states when it is correct AND its main exclusion", () => {
  for (const id of ["maneuver", "occluder_action", "framing"]) {
    for (const [opt, text] of Object.entries(Q.PILOT_QUESTIONS[id].criteria)) {
      assert.match(text, /Correct when/, `${id}.${opt} says when it is correct`);
      assert.match(text, /Not (when|for)/, `${id}.${opt} states an exclusion`);
    }
  }
});

check("criteria quote WORD_BOUNDS words with their generated boundaries", () => {
  const all = JSON.stringify(Q.PILOT_QUESTIONS);
  const text = (id) => `${Q.PILOT_QUESTIONS[id].instructions} ${JSON.stringify(Q.PILOT_QUESTIONS[id].criteria)}`;
  // The full distance ladder with boundaries is in the maneuver instructions.
  for (const w of W.scaleWords("distance")) assert.ok(Q.PILOT_QUESTIONS.maneuver.instructions.includes(W.quoteBand("distance", w)), `ladder has ${w}`);
  for (const w of W.scaleWords("room")) assert.ok(Q.PILOT_QUESTIONS.maneuver.instructions.includes(W.quoteBand("room", w)), `room ladder has ${w}`);
  assert.ok(text("maneuver").includes(W.quoteBand("ttc", "imminent")));
  assert.ok(text("risk").includes(W.quoteBand("ttc", "soon").replace(/"/g, '\\"')));
  assert.ok(text("risk").includes(W.quoteBand("distance", "touching").replace(/"/g, '\\"')));
  assert.ok(text("subject_lost").includes(W.quoteBand("unseen", "long").replace(/"/g, '\\"')));
  assert.ok(text("occluder_action").includes(W.quoteBand("visibility", "mostly hidden")));
  assert.ok(text("framing").includes(W.quoteBand("size", "right").replace(/"/g, '\\"')));
  // Every word named by PILOT_RULES appears quoted somewhere in the questions.
  const ruleWords = new Set();
  const walk = (v) => (typeof v === "string" ? ruleWords.add(v) : v && typeof v === "object" && Object.values(v).forEach(walk));
  walk(Q.PILOT_RULES);
  for (const w of ruleWords) assert.ok(all.includes(`\\"${w}\\"`), `rule word "${w}" is quoted in the criteria`);
  for (const c of Object.values(W.OCCLUDER_CLASSES)) for (const k of c) assert.ok(text("occluder_action").includes(`"${k}"`), k);
});

check("occluder_action instructions say precisely what the runtime fades and what it reroutes by itself (r3-small; r4: procedural scenery never fades)", () => {
  const ins = Q.PILOT_QUESTIONS.occluder_action.instructions;
  // the round-2 text promised a blanket fade of every soft occluder
  assert.equal(/can fade them out/.test(ins), false, ins);
  // the round-3 text promised "a tree" fades: procedural (terrain) trees never get a fade key (r4-scenery-fade)
  assert.equal(/fades a tree\b/.test(ins), false, ins);
  assert.match(ins, /the film runtime fades placed props and placed trees of known size, entities and particle smoke; procedural \(terrain\) trees and rocks are rerouted around/);
  assert.match(ins, /as are a big prop \(only a small one such as a barrel or a crate fades\) and placements too close together to tell apart; the runtime makes that reroute by itself/);
  assert.match(ins, /the fade rule below still applies to every soft kind/);
  // the kind lists stay generated from OCCLUDER_CLASSES (quoted, in order)
  const quoted = (ws) => ws.map((w) => `"${w}"`);
  for (const [cls, words] of Object.entries(W.OCCLUDER_CLASSES)) {
    const at = ins.indexOf(`${cls} = `);
    assert.ok(at >= 0, `${cls} list present`);
    let from = at;
    for (const w of quoted(words)) {
      const i = ins.indexOf(w, from);
      assert.ok(i >= from, `${cls}: ${w} listed in order`);
      from = i + w.length;
    }
  }
  // and the fade criterion still names exactly the soft kinds the instructions describe
  assert.ok(Q.PILOT_QUESTIONS.occluder_action.criteria.fade.includes(`is soft: ${quoted(W.OCCLUDER_CLASSES.soft).slice(0, -1).join(", ")} or ${quoted(W.OCCLUDER_CLASSES.soft).at(-1)}`));
});

check("every backticked field in the questions is a real state path", () => {
  const paths = new Set(S.STATE_PATHS);
  const fields = new Set();
  for (const qn of Object.values(Q.PILOT_QUESTIONS)) {
    const t = `${qn.instructions} ${Object.values(qn.criteria).join(" ")}`;
    for (const m of t.matchAll(/`([a-z_.*]+)`/g)) fields.add(m[1]);
  }
  assert.ok(fields.size >= 20, `found ${fields.size} referenced fields`);
  for (const f of fields) assert.ok(paths.has(f) || f === "obstacles.*", `\`${f}\` is not a state path`);
});

check("questionsFor: subject questions only with a subject; framing switchable; size within JEV limits", () => {
  assert.deepEqual(Object.keys(Q.questionsFor()), ["maneuver", "risk", "subject_lost", "occluder_action", "framing"]);
  assert.deepEqual(Object.keys(Q.questionsFor({ hasSubject: false })), ["maneuver", "risk"]);
  assert.deepEqual(Object.keys(Q.questionsFor({ hasSubject: true, framing: false })), ["maneuver", "risk", "subject_lost", "occluder_action"]);
  assert.equal(Q.questionsFor().maneuver, Q.PILOT_QUESTIONS.maneuver);
  // JEV: 32k tokens for state + the longest question — stay far below in characters.
  for (const qn of Object.values(Q.PILOT_QUESTIONS)) assert.ok(JSON.stringify(qn).length < 8000, "question text stays compact");
  assert.ok(JSON.stringify(Q.PILOT_QUESTIONS).length < 16000);
});

console.log("W5 buildDecisionRequest / parseDecisionAnswers");

check("buildDecisionRequest: exact body keys, pinned model, contract-only question copies", () => {
  const st = S.buildPilotState(frame());
  const qs = { ...Q.questionsFor(), extra: { type: "noul", instructions: "Is it night?", criteria: { true: "yes", false: "no" }, junk: 1 } };
  const body = Q.buildDecisionRequest(st, qs);
  assert.deepEqual(Object.keys(body), ["model", "state", "questions"]);
  assert.equal(body.model, "typesafe/jev-1.13");
  assert.equal(body.model, Q.JEV_PILOT_MODEL);
  assert.equal(body.state, st);
  assert.notEqual(body.questions.maneuver, Q.PILOT_QUESTIONS.maneuver, "copied, not the frozen original");
  assert.deepEqual(body.questions.maneuver, { ...Q.PILOT_QUESTIONS.maneuver, criteria: { ...Q.PILOT_QUESTIONS.maneuver.criteria } });
  assert.deepEqual(Object.keys(body.questions.extra), ["type", "instructions", "criteria"]);
  assert.ok(J.validateQuestions(body.questions).ok);
  assert.equal(Q.buildDecisionRequest(st, qs, { model: "~typesafe/jev-latest" }).model, "~typesafe/jev-latest");
  assert.doesNotThrow(() => JSON.stringify(body));
});

check("buildDecisionRequest rejects a missing state or malformed questions with FilmError", () => {
  const st = S.buildPilotState(frame());
  const bad = [
    [null, Q.questionsFor()], [st, {}], [st, null], [st, { a: { type: "choice", instructions: "x", criteria: { one: "1" } } }],
    [st, { a: { type: "score", instructions: "x", criteria: ["only"] } }], [st, { a: { type: "noul", instructions: "x", criteria: { true: "y" } } }],
    [st, { a: { type: "vote", instructions: "x" } }], [st, { a: { type: "noul", instructions: " " } }],
  ];
  for (const [s, q] of bad) {
    assert.throws(() => Q.buildDecisionRequest(s, q), (e) => e instanceof E.FilmError && e.code === Q.BAD_ANSWER_CODE, JSON.stringify(q));
  }
});

check("parseDecisionAnswers: all three types, probabilities looked up by name in any key order", () => {
  const qs = Q.questionsFor();
  const raw = {
    id: "dec-1",
    answers: {
      maneuver: { type: "choice", choice: "drift_left", probabilities: { back_off: 0.05, drift_left: 0.7, hold_path: 0.25 } },
      risk: { type: "score", score: 1.3, probabilities: { 2: 0.2, 0: 0.1, 1: 0.7 } },
      subject_lost: { type: "noul", noul: 0.12 },
      occluder_action: { choice: "fade", confidence: 0.9 },
      framing: { type: "choice", choice: "keep", confidence: 1.7, probabilities: { keep: 2, widen: 2 } },
      unasked: { type: "choice", choice: "x" },
    },
  };
  const a = Q.parseDecisionAnswers(raw, qs);
  assert.deepEqual(Object.keys(a), Object.keys(qs), "unasked ids ignored");
  assert.deepEqual(Object.keys(a.maneuver.probabilities), [...Q.MANEUVERS], "rebuilt in criteria order");
  assert.equal(a.maneuver.probabilities.drift_left, 0.7);
  assert.equal(a.maneuver.probabilities.rise, 0);
  assert.equal(a.maneuver.confidence, 0.7, "confidence derived from P(choice)");
  assert.deepEqual(Object.keys(a.risk.probabilities), ["0", "1", "2"]);
  assert.equal(a.risk.score, 1.3);
  assert.equal(a.risk.confidence, 0.7, "P(round(score))");
  assert.deepEqual(a.subject_lost, { type: "noul", noul: 0.12 });
  assert.deepEqual(a.occluder_action, { type: "choice", choice: "fade", confidence: 0.9, probabilities: null });
  assert.equal(a.framing.confidence, 1, "confidence clamped");
  assert.equal(a.framing.probabilities.keep, 0.5, "normalised");
  // Same normalisation as the Node client.
  assert.deepEqual(Q.parseDecisionAnswers(raw, qs), J.parseAnswers(raw.answers, qs));
  // Bare map and JSON string are accepted.
  assert.deepEqual(Q.parseDecisionAnswers(raw.answers, qs), a);
  assert.deepEqual(Q.parseDecisionAnswers(JSON.stringify(raw), qs), a);
});

check("parseDecisionAnswers rejects malformed answers with FilmError JEV_BAD_ANSWER", () => {
  const qs = Q.questionsFor({ hasSubject: false });
  const ok = { maneuver: { type: "choice", choice: "hold_path" }, risk: { type: "score", score: 0 } };
  const isBad = (e) => e instanceof E.FilmError && e.code === Q.BAD_ANSWER_CODE;
  const cases = [
    "{not json", 42, null, [], {},
    { maneuver: ok.maneuver },
    { ...ok, maneuver: { type: "choice", choice: "teleport" } },
    { ...ok, maneuver: { type: "score", score: 1 } },
    { ...ok, risk: { type: "score", score: 2.5 } },
    { ...ok, risk: { type: "score", score: -0.2 } },
    { ...ok, risk: { type: "score", score: "abc" } },
    { ...ok, maneuver: { type: "choice", choice: "rise", probabilities: { rise: -1 } } },
    { ...ok, maneuver: { type: "choice", choice: "rise", probabilities: [1] } },
  ];
  for (const raw of cases) assert.throws(() => Q.parseDecisionAnswers(raw, qs), isBad, JSON.stringify(raw));
  assert.throws(() => Q.parseDecisionAnswers({ s: { type: "noul", noul: 1.2 } }), isBad);
  assert.throws(() => Q.parseDecisionAnswers({ s: { type: "mystery" } }), isBad);
  // Without questions: validated by each answer's own type.
  const free = Q.parseDecisionAnswers({ s: { type: "noul", noul: 1 }, c: { type: "choice", choice: "a", probabilities: { b: 1, a: 3 } } });
  assert.deepEqual(free.s, { type: "noul", noul: 1 });
  assert.equal(free.c.confidence, 0.75);
});

console.log(`film_pilot_words: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
