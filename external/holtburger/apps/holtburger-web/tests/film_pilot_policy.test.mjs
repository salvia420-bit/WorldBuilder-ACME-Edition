// tests/film_pilot_policy.test.mjs
//
// WHY: in AC Film Mode the camera pilot is flown either by JEV (TypeSafe's
// System-One model) reading the criteria text in scene3d/film/pilot/questions.js,
// or by the deterministic code policy (policy_code.js) — the no-key fallback,
// the test/rehearsal mock and the shadow-agreement baseline. If the code and the
// criteria disagree, shadow agreement is meaningless and the fallback flies a
// different camera than the one JEV was told about. This suite executes the real
// modules and pins that agreement:
//   P1  a table of 47 synthetic SensorFrames (open meadow, dungeon corridor, tree
//       ahead-left, wall dead ahead with the roomier side, low wall with can_rise
//       yes/no, overhang, boxed in by ttc, touching, contact with an escape,
//       trunk briefly vs long hidden, foliage/wall/creature/smoke/unknown occluders,
//       framing too small/large/off-centre/out of frame, no subject, and technique
//       lateral bounds under 2 m: drift up to the bound, a spent side, no lateral
//       freedom, an imminent contact whose only escape side is spent) → expected
//       answers for all five questions; plus a sweep that flies a drift up to the
//       lateral bound of every preset width;
//   P2  for every table row, the state paths each rule keyed on are named in the
//       chosen criterion (or its instructions) and their exact words are quoted;
//   P3  an INDEPENDENT transcription of the criteria text (written from the text,
//       not from policy_code.js) agrees with the code policy on every table row and
//       on 3000 seeded random states, and exactly one option's criterion holds
//       each time (criteria are mutually exclusive and exhaustive); and what the occluder_action
//       instructions promise about soft occluders holds in code: fade for every soft kind, the mapper
//       fades the sensors' ids (a placed tree / prop key, an entity guid, a particle key) and, with
//       none (a procedural tree, a big or unsized prop), reroutes by itself;
//   P4  answers are in the exact Decisions-API shape (validated by questions.js
//       and by the Node JEV client), hard probabilities, question subsets;
//   P5  neutralAnswers, answersAgree (thresholded scores / noul), determinism and
//       NaN/empty robustness.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its pure pilot modules.
// Run from apps/holtburger-web/: node tests/film_pilot_policy.test.mjs

import assert from "node:assert/strict";

const W = await import("../scene3d/film/pilot/sense_words.js");
const S = await import("../scene3d/film/pilot/scene_state.js");
const Q = await import("../scene3d/film/pilot/questions.js");
const P = await import("../scene3d/film/pilot/policy_code.js");
const M = await import("../scene3d/film/pilot/mapper.js");
const R = await import("../scene3d/film/core/rng.js");
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

const sec = (range, kind) => ({ range, kind });
const wallAhead = (r, kind = "wall") => ({ center: sec(r, kind) });
const SUBJ = (o) => ({ subject: { visibleFrac: 1, unseenSec: 0, ndc: [0, 0], sizeRatio: 1, occluderKind: null, ...o } });

// expect: m = maneuver, r = risk, lost, occ = occluder_action, fr = framing (subject answers omitted when no subject)
// Optional 4th element: buildPilotState opts ({bounds, current}) — the shot's pilot bounds and offsets.
const ROWS = [
  ["open meadow", {}, { m: "hold_path", r: 0, lost: false, occ: "ignore", fr: "keep" }],
  ["dungeon corridor: walls beside, far sectors close, nothing ahead",
    { sides: { left: 1.5, right: 1.5 }, sectors: { far_left: sec(2.8, "wall"), left: sec(5.4, "wall"), right: sec(5.4, "wall"), far_right: sec(2.8, "wall") },
      nearest: { range: 1.5, kind: "wall", bearingDeg: -90 }, limits: { roomLeft: 0.5, roomRight: 0.5 } },
    { m: "hold_path", r: 1 }],
  ["tree close ahead-left, room right",
    { sectors: { left: sec(3, "tree") }, nearest: { range: 3, kind: "tree", bearingDeg: -16 }, limits: { roomLeft: 5, roomRight: 5 } },
    { m: "drift_right", r: 0 }],
  ["tree very close ahead-right, some room left",
    { sectors: { right: sec(1.5, "tree") }, nearest: { range: 1.5, kind: "tree", bearingDeg: 16 }, limits: { roomLeft: 3, roomRight: 5 } },
    { m: "drift_left", r: 1 }],
  ["wall dead ahead, room both sides, left roomier",
    { sectors: { ...wallAhead(3), left: sec(6, "wall"), right: sec(6, "wall") }, freeAhead: { level: 3, above: 3, below: 3 },
      nearest: { range: 3, kind: "wall", bearingDeg: 0 }, pathAhead: { ttc: 1.5, kind: "wall" }, limits: { roomLeft: 5, roomRight: 3 } },
    { m: "drift_left", r: 1 }],
  ["wall dead ahead, room both sides, right roomier",
    { sectors: { ...wallAhead(3), left: sec(6, "wall"), right: sec(6, "wall") }, freeAhead: { level: 3, above: 3, below: 3 },
      nearest: { range: 3, kind: "wall" }, pathAhead: { ttc: 1.5, kind: "wall" }, limits: { roomLeft: 3, roomRight: 5 } },
    { m: "drift_right", r: 1 }],
  ["wall dead ahead, equal room, right sector farther",
    { sectors: { ...wallAhead(3), left: sec(5, "rock"), right: sec(12, "rock") }, freeAhead: { level: 3, above: 3, below: 3 }, nearest: { range: 3, kind: "wall" } },
    { m: "drift_right", r: 0 }],
  ["wall dead ahead, equal room and sectors, far_right farther",
    { sectors: { ...wallAhead(3), left: sec(6, "rock"), right: sec(6, "rock"), far_left: sec(10, "tree"), far_right: sec(30, "tree") },
      freeAhead: { level: 3, above: 3, below: 3 }, nearest: { range: 3, kind: "wall" } },
    { m: "drift_right", r: 0 }],
  ["wall dead ahead, full tie → left",
    { sectors: { ...wallAhead(3), left: sec(6, "rock"), right: sec(6, "rock") }, freeAhead: { level: 3, above: 3, below: 3 }, nearest: { range: 3, kind: "wall" } },
    { m: "drift_left", r: 0 }],
  ["low wall, free air above, can_rise yes",
    { sectors: { ...wallAhead(3), left: sec(3.2, "wall"), right: sec(3.2, "wall") }, freeAhead: { level: 3, above: I, below: 3 },
      nearest: { range: 3, kind: "wall" }, pathAhead: { ttc: 3, kind: "wall" }, limits: { canRise: true } },
    { m: "rise", r: 0 }],
  ["low wall, can_rise no, contact later → boxed in, slow_down",
    { sectors: { ...wallAhead(3), left: sec(3.2, "wall"), right: sec(3.2, "wall") }, freeAhead: { level: 3, above: I, below: 3 },
      nearest: { range: 3, kind: "wall" }, pathAhead: { ttc: 3, kind: "wall" }, limits: { canRise: false } },
    { m: "slow_down", r: 0 }],
  ["low wall, can_rise no, contact imminent → back_off",
    { sectors: { ...wallAhead(3), left: sec(3.2, "wall"), right: sec(3.2, "wall") }, freeAhead: { level: 3, above: I, below: 3 },
      nearest: { range: 3, kind: "wall" }, pathAhead: { ttc: 0.5, kind: "wall" }, limits: { canRise: false } },
    { m: "back_off", r: 2 }],
  ["low wall, can_rise no, left sector open with room → drift_left",
    { sectors: { ...wallAhead(3), left: sec(6, "wall"), right: sec(3.2, "wall") }, freeAhead: { level: 3, above: I, below: 3 },
      nearest: { range: 3, kind: "wall" }, limits: { canRise: false, roomLeft: 3 } },
    { m: "drift_left", r: 0 }],
  ["wall ahead, air above only one step freer → no rise (boxed in)",
    { sectors: { ...wallAhead(3, "tree"), left: sec(3, "tree"), right: sec(3, "tree") }, freeAhead: { level: 3, above: 5, below: 3 },
      nearest: { range: 3, kind: "tree" }, limits: { canRise: true } },
    { m: "slow_down", r: 0 }],
  ["overhang above, free space below, can_sink yes",
    { sectors: { ...wallAhead(3, "rock"), left: sec(3.5, "rock"), right: sec(3.5, "rock") }, freeAhead: { level: 3, above: 1.5, below: 20 },
      sides: { up: 1.5 }, nearest: { range: 1.5, kind: "rock", bearingDeg: 0, elevDeg: 70 }, limits: { canSink: true } },
    { m: "sink", r: 1 }],
  ["overhang above, can_sink no → slow_down",
    { sectors: { ...wallAhead(3, "rock"), left: sec(3.5, "rock"), right: sec(3.5, "rock") }, freeAhead: { level: 3, above: 1.5, below: 20 },
      nearest: { range: 1.5, kind: "rock", elevDeg: 70 }, limits: { canSink: false } },
    { m: "slow_down", r: 1 }],
  ["rise and sink both open → rise wins",
    { sectors: { ...wallAhead(3, "rock"), left: sec(3, "rock"), right: sec(3, "rock") }, freeAhead: { level: 3, above: I, below: I }, nearest: { range: 3, kind: "rock" } },
    { m: "rise", r: 0 }],
  ["boxed in, contact soon → slow_down",
    { sectors: { far_left: sec(1.8, "wall"), left: sec(1.8, "wall"), center: sec(1.8, "wall"), right: sec(1.8, "wall"), far_right: sec(1.8, "wall") },
      freeAhead: { level: 1.8, above: 1.8, below: 1.8 }, nearest: { range: 1.8, kind: "wall" }, pathAhead: { ttc: 1.5, kind: "wall" },
      limits: { canRise: false, canSink: false, roomLeft: 0.3, roomRight: 0.3 } },
    { m: "slow_down", r: 1 }],
  ["boxed in, contact imminent → back_off",
    { sectors: { far_left: sec(1.8, "wall"), left: sec(1.8, "wall"), center: sec(1.8, "wall"), right: sec(1.8, "wall"), far_right: sec(1.8, "wall") },
      freeAhead: { level: 1.8, above: 1.8, below: 1.8 }, nearest: { range: 1.8, kind: "wall" }, pathAhead: { ttc: 0.5, kind: "wall" },
      limits: { canRise: false, canSink: false, roomLeft: 0.3, roomRight: 0.3 } },
    { m: "back_off", r: 2 }],
  ["touching a rock at the right → back_off",
    { nearest: { range: 0.5, kind: "rock", bearingDeg: 60 }, sides: { right: 0.5 } },
    { m: "back_off", r: 2 }],
  ["touching, obstacle behind → slow_down",
    { nearest: { range: 0.5, kind: "wall", bearingDeg: 170 }, sides: { back: 0.5 } },
    { m: "slow_down", r: 2 }],
  ["creature on the path (contact soon), sides clear → tie goes left",
    { pathAhead: { ttc: 1.5, kind: "creature" }, nearest: { range: 6, kind: "creature" } },
    { m: "drift_left", r: 1 }],
  ["imminent contact with an escape to the right → drift_right, not back_off",
    { sectors: { center: sec(1.5, "creature"), left: sec(1.5, "tree") }, freeAhead: { level: 1.5, above: 1.5, below: 1.5 },
      nearest: { range: 1.5, kind: "creature" }, pathAhead: { ttc: 0.5, kind: "creature" }, limits: { roomLeft: 0.5, roomRight: 5 } },
    { m: "drift_right", r: 2 }],
  ["subject briefly hidden behind a trunk (not lost)",
    SUBJ({ visibleFrac: 0, unseenSec: 0.5, occluderKind: "tree" }),
    { m: "hold_path", r: 0, lost: false, occ: "ignore", fr: "keep" }],
  ["subject hidden long behind a wall (lost)",
    SUBJ({ visibleFrac: 0, unseenSec: 4, occluderKind: "wall" }),
    { lost: true, occ: "reroute", fr: "keep" }],
  ["subject hidden a while behind a building (not lost yet)",
    SUBJ({ visibleFrac: 0.05, unseenSec: 2, occluderKind: "building" }),
    { lost: false, occ: "reroute", fr: "keep" }],
  ["foliage, subject mostly hidden → fade",
    SUBJ({ visibleFrac: 0.25, unseenSec: 0, occluderKind: "tree" }),
    { lost: false, occ: "fade", fr: "keep" }],
  ["thin foliage, subject partly hidden → ignore",
    SUBJ({ visibleFrac: 0.6, unseenSec: 0, occluderKind: "tree" }),
    { lost: false, occ: "ignore", fr: "keep" }],
  ["creature in front of the subject, mostly hidden → wait",
    SUBJ({ visibleFrac: 0.2, unseenSec: 0, occluderKind: "creature" }),
    { occ: "wait", fr: "keep" }],
  ["smoke cloud hides the subject for 1.5 s → fade",
    SUBJ({ visibleFrac: 0.05, unseenSec: 1.5, occluderKind: "smoke" }),
    { lost: false, occ: "fade", fr: "keep" }],
  ["unknown occluder kind → ignore",
    SUBJ({ visibleFrac: 0.2, unseenSec: 0, occluderKind: "mystery" }),
    { occ: "ignore", fr: "keep" }],
  ["subject just vanished behind a rock (timer not started) → brief → ignore",
    SUBJ({ visibleFrac: 0.02, unseenSec: 0, occluderKind: "rock" }),
    { lost: false, occ: "ignore", fr: "keep" }],
  ["framing: too small, centred → tighten", SUBJ({ sizeRatio: 0.6 }), { fr: "tighten", occ: "ignore" }],
  ["framing: much too small → tighten", SUBJ({ sizeRatio: 0.3 }), { fr: "tighten" }],
  ["framing: too large → widen", SUBJ({ sizeRatio: 1.6 }), { fr: "widen" }],
  ["framing: much too large → widen", SUBJ({ sizeRatio: 3 }), { fr: "widen" }],
  ["framing: near the right edge → recenter", SUBJ({ ndc: [0.9, 0.1] }), { fr: "recenter" }],
  ["framing: near the edge AND too small → recenter has priority", SUBJ({ ndc: [-0.95, 0], sizeRatio: 0.6 }), { fr: "recenter" }],
  ["framing: thirds placement → keep", SUBJ({ ndc: [0.33, -0.1] }), { fr: "keep" }],
  ["framing: subject behind the camera but unoccluded → recenter", SUBJ({ ndc: null }), { fr: "recenter" }],
  ["no subject (pure landscape flyover)", { subject: null }, { m: "hold_path", r: 0, noSubject: true }],
  // Technique lateral bounds under 2 m (classic body 0.15 / timed 0.3 / locked 0.5 / close 0.6 / ground 0.8 /
  // move 1.5, drone B_GAP 0.3 / B_CORRIDOR 0.5 / B_CLOSE 1.5): the sensed room stays the room word, the
  // bound is the separate yes/no limits.can_drift_left/right (jev-0).
  ["classic move bounds (maxLateral 1.5): tree 3 m dead ahead, right blocked, 10 m open left, no rise/sink → drift_left",
    { sectors: { center: sec(3, "tree"), right: sec(3, "tree") }, freeAhead: { level: 3, above: 3, below: 3 },
      nearest: { range: 3, kind: "tree" }, limits: { canRise: false, canSink: false, roomLeft: 10, roomRight: 1 } },
    { m: "drift_left", r: 0 },
    { bounds: { maxLateral: 1.5 }, current: { lateral: 0 } }],
  ["classic body bounds (maxLateral 0.15): wall ahead, left very close, room right → drift_right",
    { sectors: { center: sec(3, "wall"), left: sec(1.5, "wall") }, freeAhead: { level: 3, above: 3, below: 3 },
      nearest: { range: 1.5, kind: "wall", bearingDeg: -30 }, limits: { canRise: false, canSink: false, roomLeft: 0.3, roomRight: 6 } },
    { m: "drift_right", r: 1 },
    { bounds: { maxLateral: 0.15 } }],
  ["locked bounds (maxLateral 0.5), left bound spent at −0.5 m → drift_right although the left senses more room",
    { sectors: { center: sec(3, "tree") }, freeAhead: { level: 3, above: 3, below: 3 },
      nearest: { range: 3, kind: "tree" }, limits: { canRise: false, canSink: false, roomLeft: 10, roomRight: 3 } },
    { m: "drift_right", r: 0 },
    { bounds: { maxLateral: 0.5 }, current: { lateral: -0.5 } }],
  ["maxLateral 0 (no lateral freedom): tree ahead, open both sides → boxed in, slow_down",
    { sectors: { center: sec(3, "tree") }, freeAhead: { level: 3, above: 3, below: 3 },
      nearest: { range: 3, kind: "tree" }, limits: { canRise: false, canSink: false, roomLeft: 10, roomRight: 10 } },
    { m: "slow_down", r: 0 },
    { bounds: { maxLateral: 0 } }],
  ["maxLateral 2 with half the left bound spent: the SENSED room picks the side (left plenty > right some) → drift_left",
    { sectors: { ...wallAhead(3), left: sec(6, "rock"), right: sec(6, "rock") }, freeAhead: { level: 3, above: 3, below: 3 },
      nearest: { range: 3, kind: "wall" }, limits: { canRise: false, canSink: false, roomLeft: 10, roomRight: 3 } },
    { m: "drift_left", r: 0 },
    { bounds: { maxLateral: 2 }, current: { lateral: -1 } }],
  ["imminent contact, the only open side's lateral bound is spent → no ESCAPE → back_off",
    { sectors: { center: sec(1.5, "creature"), left: sec(1.5, "tree") }, freeAhead: { level: 1.5, above: 1.5, below: 1.5 },
      nearest: { range: 1.5, kind: "creature" }, pathAhead: { ttc: 0.5, kind: "creature" }, limits: { roomLeft: 0.5, roomRight: 5 } },
    { m: "back_off", r: 2 },
    { bounds: { maxLateral: 1 }, current: { lateral: 1 } }],
];

const built = ROWS.map(([name, over, want, opts]) => {
  const sf = frame(over);
  const state = S.buildPilotState(sf, { standingOrder: "Test shot.", technique: "drone.flyover", ...(opts ?? {}) });
  return { name, sf, state, want, answers: P.codePolicy(sf, state) };
});

// ---------------------------------------------------------------------------
// Independent transcription of the criteria TEXT (deliberately not using
// policy_code.js or PILOT_RULES: the word lists below are read off the text).
// ---------------------------------------------------------------------------

const DIST = ["touching", "very close", "close", "near", "medium", "far", "clear"];
const ROOM = ["none", "little", "some", "plenty"];
const lead = (text, words) => [...words].sort((a, b) => b.length - a.length).find((w) => text === w || String(text).startsWith(`${w} `) || String(text).startsWith(`${w}(`));
const dr = (text) => DIST.indexOf(lead(text, DIST) ?? "clear");
const isClose = (text) => ["touching", "very close", "close"].includes(lead(text, DIST));
const farEnough = (text) => ["near", "medium", "far", "clear"].includes(lead(text, DIST));

function criteriaManeuver(s) {
  const o = s.obstacles;
  const f = s.free_space;
  const contact = s.path_ahead.contact_in;
  const BLOCKED = isClose(o.left) || isClose(o.ahead) || isClose(o.right) || isClose(f.level_ahead) || ["imminent", "soon"].includes(contact);
  const RISE_OK = BLOCKED && isClose(f.level_ahead) && dr(f.above_ahead) >= dr(f.level_ahead) + 2 && s.limits.can_rise === "yes";
  const SINK_OK = BLOCKED && isClose(f.level_ahead) && dr(f.below_ahead) >= dr(f.level_ahead) + 2 && s.limits.can_sink === "yes";
  const LEFT_OK = BLOCKED && s.limits.can_drift_left === "yes" && ["some", "plenty"].includes(s.limits.room_left) && farEnough(o.left);
  const RIGHT_OK = BLOCKED && s.limits.can_drift_right === "yes" && ["some", "plenty"].includes(s.limits.room_right) && farEnough(o.right);
  const ESCAPE = RISE_OK || SINK_OK || LEFT_OK || RIGHT_OK;
  const BACK = s.nearest.range === "touching" || (contact === "imminent" && !ESCAPE);
  const behindTooClose = ["touching", "very close"].includes(lead(o.behind, DIST));
  const rl = ROOM.indexOf(s.limits.room_left);
  const rr = ROOM.indexOf(s.limits.room_right);
  const leftRoomier = rl > rr || (rl === rr && dr(o.left) > dr(o.right)) || (rl === rr && dr(o.left) === dr(o.right) && dr(o.far_left) >= dr(o.far_right));
  const rightRoomier = rr > rl || (rl === rr && dr(o.right) > dr(o.left)) || (rl === rr && dr(o.left) === dr(o.right) && dr(o.far_right) > dr(o.far_left));
  return {
    hold_path: !BLOCKED && s.nearest.range !== "touching",
    drift_left: BLOCKED && !BACK && !RISE_OK && !SINK_OK && LEFT_OK && (!RIGHT_OK || leftRoomier),
    drift_right: BLOCKED && !BACK && !RISE_OK && !SINK_OK && RIGHT_OK && (!LEFT_OK || rightRoomier),
    rise: RISE_OK && !BACK,
    sink: SINK_OK && !RISE_OK && !BACK,
    slow_down: (BLOCKED && !ESCAPE && !BACK) || (BACK && behindTooClose),
    back_off: BACK && !behindTooClose,
  };
}

function criteriaRisk(s) {
  const c = s.path_ahead.contact_in;
  const n = s.nearest.range;
  return {
    0: ["later", "none"].includes(c) && ["close", "near", "medium", "far", "clear"].includes(n),
    1: (c === "soon" || n === "very close") && !(c === "imminent" || n === "touching"),
    2: c === "imminent" || n === "touching",
  };
}

function criteriaLost(s) {
  return { true: s.subject.unseen_for === "long", false: ["not hidden", "brief", "a while"].includes(s.subject.unseen_for) };
}

function criteriaOccluder(s) {
  const { visibility: v, unseen_for: u, occluded_by: k } = s.subject;
  const HIDDEN = ["fully hidden", "mostly hidden"].includes(v) && u !== "brief";
  return {
    ignore: ["clear", "partly hidden"].includes(v) || u === "brief" || ["nothing", "unknown"].includes(k),
    fade: HIDDEN && ["tree", "prop", "particles"].includes(k),
    reroute: HIDDEN && ["wall", "building", "rock", "terrain", "door"].includes(k),
    wait: HIDDEN && ["creature", "player"].includes(k),
  };
}

function criteriaFraming(s) {
  const { visibility: v, in_frame: where, size } = s.subject;
  const starts = (list) => list.some((w) => where === w || where.startsWith(`${w} `));
  const edge = starts(["near the edge", "out of frame"]);
  return {
    keep: (starts(["centred", "slightly off-centre", "off-centre"]) && size === "right") || v === "fully hidden",
    recenter: edge && v !== "fully hidden",
    widen: ["too large", "much too large"].includes(size) && !edge && v !== "fully hidden",
    tighten: ["too small", "much too small"].includes(size) && !edge && v !== "fully hidden",
  };
}

/** The single option whose criterion holds (asserts exactly one). */
function only(holds, label) {
  const on = Object.entries(holds).filter(([, v]) => v).map(([k]) => k);
  assert.equal(on.length, 1, `${label}: exactly one criterion must hold, got [${on.join(", ")}]`);
  return on[0];
}

/** Compare the transcribed criteria against the code policy for one state. */
function agreeOnState(state, label) {
  const hasSubject = state.subject.visibility !== S.NO_SUBJECT;
  const a = P.codePolicy(null, state);
  assert.equal(only(criteriaManeuver(state), `${label} maneuver`), a.maneuver.choice, `${label}: maneuver`);
  assert.equal(Number(only(criteriaRisk(state), `${label} risk`)), a.risk.score, `${label}: risk`);
  if (!hasSubject) return;
  assert.equal(only(criteriaLost(state), `${label} lost`) === "true" ? 1 : 0, a.subject_lost.noul, `${label}: subject_lost`);
  assert.equal(only(criteriaOccluder(state), `${label} occluder`), a.occluder_action.choice, `${label}: occluder`);
  assert.equal(only(criteriaFraming(state), `${label} framing`), a.framing.choice, `${label}: framing`);
}

console.log(`P1 code policy on ${ROWS.length} synthetic SensorFrames`);

check(`table has ≥ 25 frames covering every maneuver, occluder action and framing action (${ROWS.length})`, () => {
  assert.ok(ROWS.length >= 25);
  const seen = { m: new Set(), occ: new Set(), fr: new Set(), r: new Set() };
  for (const b of built) {
    seen.m.add(b.answers.maneuver.choice);
    seen.r.add(b.answers.risk.score);
    if (b.answers.occluder_action) seen.occ.add(b.answers.occluder_action.choice);
    if (b.answers.framing) seen.fr.add(b.answers.framing.choice);
  }
  assert.deepEqual([...seen.m].sort(), [...Q.MANEUVERS].sort());
  assert.deepEqual([...seen.occ].sort(), [...Q.OCCLUDER_ACTIONS].sort());
  assert.deepEqual([...seen.fr].sort(), [...Q.FRAMING_ACTIONS].sort());
  assert.deepEqual([...seen.r].sort(), [0, 1, 2]);
});

for (const b of built) {
  check(b.name, () => {
    const { want, answers: a } = b;
    if (want.m !== undefined) assert.equal(a.maneuver.choice, want.m, `maneuver (${P.decideManeuver(b.state).rule})`);
    if (want.r !== undefined) assert.equal(a.risk.score, want.r, "risk");
    if (want.noSubject) {
      assert.deepEqual(Object.keys(a), ["maneuver", "risk"], "no subject → no subject questions");
      return;
    }
    if (want.lost !== undefined) assert.equal(a.subject_lost.noul, want.lost ? 1 : 0, "subject_lost");
    if (want.occ !== undefined) assert.equal(a.occluder_action.choice, want.occ, "occluder_action");
    if (want.fr !== undefined) assert.equal(a.framing.choice, want.fr, "framing");
  });
}

console.log("P2 the deciding fields and words are named in the chosen criterion");

check("every rule's state paths are backticked and their words quoted in the chosen option's text", () => {
  const QS = Q.PILOT_QUESTIONS;
  const scaleFor = (path) => {
    if (path.startsWith("obstacles.") || path.startsWith("free_space.") || path === "nearest.range") return "distance";
    if (path === "subject.in_frame") return "offset";
    return null;
  };
  let checks = 0;
  for (const b of built) {
    const ex = P.explainPolicy(b.state);
    const parts = [
      ["maneuver", ex.maneuver.uses, QS.maneuver.criteria[ex.maneuver.choice]],
      ["risk", ex.risk.uses, QS.risk.criteria[ex.risk.score]],
    ];
    if (b.state.subject.visibility !== S.NO_SUBJECT) {
      parts.push(["subject_lost", ex.subject_lost.uses, QS.subject_lost.criteria[String(ex.subject_lost.lost)]]);
      parts.push(["occluder_action", ex.occluder_action.uses, QS.occluder_action.criteria[ex.occluder_action.choice]]);
      parts.push(["framing", ex.framing.uses, QS.framing.criteria[ex.framing.choice]]);
    }
    for (const [id, uses, criterion] of parts) {
      const text = `${QS[id].instructions} ${criterion}`;
      for (const path of uses) {
        assert.ok(text.includes(`\`${path}\``), `${b.name}: ${id} keyed on \`${path}\` but its text never names it`);
        const raw = S.stateWord(b.state, path);
        const scale = scaleFor(path);
        const word = scale ? W.leadingWord(raw, scale) ?? raw : raw;
        assert.ok(text.includes(`"${word}"`), `${b.name}: ${id} keyed on ${path} = "${word}" but the text never quotes it`);
        checks += 1;
      }
    }
  }
  assert.ok(checks > 150, `checked ${checks} field/word references`);
});

console.log("P3 independent transcription of the criteria text agrees with the code");

check("transcribed criteria pick exactly one option and agree with codePolicy on every table row", () => {
  for (const b of built) agreeOnState(b.state, b.name);
});

check("a drift runs up to the shot's lateral bound for every preset width, then the pilot slows (jev-0)", () => {
  // Tree 3 m dead ahead, right sector blocked, 10 m sensed room on the left, no rise or sink:
  // the only escape is left. Fly it: each tick the policy decides, a drift_left moves 1 cm.
  const sf = frame({ sectors: { center: sec(3, "tree"), right: sec(3, "tree") }, freeAhead: { level: 3, above: 3, below: 3 },
    nearest: { range: 3, kind: "tree" }, limits: { canRise: false, canSink: false, roomLeft: 10, roomRight: 1 } });
  const STEP = 0.01;
  for (const maxLateral of [0.15, 0.3, 0.5, 0.6, 0.8, 1.5, 2, 3, 6]) {
    let lateral = 0;
    let maneuver = "hold_path";
    let steps = 0;
    for (;;) {
      const state = S.buildPilotState(sf, { bounds: { maxLateral }, current: { lateral, maneuver } });
      assert.equal(state.limits.room_left, "plenty", `maxLateral ${maxLateral}: the sensed room word is never capped`);
      agreeOnState(state, `maxLateral ${maxLateral} at ${lateral.toFixed(2)} m`);
      maneuver = P.decideManeuver(state).choice;
      if (maneuver !== "drift_left") break;
      lateral = Math.max(-maxLateral, lateral - STEP);
      steps += 1;
      assert.ok(steps < 10000, "the drift ends");
    }
    assert.ok(steps > 0, `maxLateral ${maxLateral}: the first decision is drift_left (was slow_down when the bound capped the room)`);
    assert.equal(maneuver, "slow_down", `maxLateral ${maxLateral}: boxed in once the bound is spent`);
    assert.ok(lateral <= -(maxLateral - S.BOUND_SLACK_M) + 1e-9, `maxLateral ${maxLateral}: drifted only to ${lateral.toFixed(2)} m`);
    assert.ok(lateral >= -maxLateral - 1e-9, `maxLateral ${maxLateral}: never past the bound`);
  }
});

check("transcription word lists are the words the criteria actually quote", () => {
  const all = JSON.stringify(Q.PILOT_QUESTIONS);
  for (const w of [...DIST, ...ROOM, "imminent", "soon", "later", "none", "yes", "fully hidden", "mostly hidden", "partly hidden",
    "not hidden", "brief", "a while", "long", "near the edge", "out of frame", "centred", "slightly off-centre", "off-centre",
    "too small", "much too small", "too large", "much too large", "right", "nothing", "unknown", "tree", "prop", "particles",
    "wall", "building", "rock", "terrain", "door", "creature", "player"]) {
    assert.ok(all.includes(`\\"${w}\\"`), `"${w}" is quoted in the criteria`);
  }
});

check("3000 seeded random word states: exactly one criterion holds per question and it matches codePolicy", () => {
  const rng = R.mulberry32("film-pilot-policy");
  const pick = (arr) => R.rngPick(rng, arr);
  const kinds = [...W.OBSTACLE_KINDS, "obstacle"];
  const obst = () => {
    const w = pick(DIST);
    return w === "clear" ? "clear" : `${w} ${pick(kinds)}`;
  };
  const dirs = ["left", "right", "up", "down", "up-left", "down-right"];
  const inFrame = () => {
    const w = pick(W.scaleWords("offset"));
    return w === "centred" ? w : rng() < 0.2 && w === "out of frame" ? w : `${w} (${pick(dirs)})`;
  };
  for (let i = 0; i < 3000; i++) {
    const hasSubject = rng() < 0.8;
    const vis = pick(W.scaleWords("visibility"));
    const state = {
      standing_order: "Random.",
      shot: { technique: "x", goal: "y" },
      camera: { speed: pick(W.scaleWords("speed")) },
      obstacles: {
        far_left: obst(), left: obst(), ahead: obst(), right: obst(), far_right: obst(),
        above: obst(), below: obst(), left_side: obst(), right_side: obst(), behind: obst(),
      },
      free_space: { level_ahead: pick(DIST), above_ahead: pick(DIST), below_ahead: pick(DIST) },
      nearest: { kind: pick(kinds), range: pick(DIST), side: pick(W.scaleWords("bearing")) },
      path_ahead: { contact_in: pick(W.scaleWords("ttc")), blocker: pick(kinds) },
      subject: hasSubject
        ? {
            visibility: vis,
            unseen_for: pick(W.scaleWords("unseen")),
            in_frame: inFrame(),
            size: pick(W.scaleWords("size")),
            occluded_by: vis === "clear" ? "nothing" : pick([...W.OBSTACLE_KINDS, "unknown"]),
          }
        : { visibility: S.NO_SUBJECT, unseen_for: S.NO_SUBJECT, in_frame: S.NO_SUBJECT, size: S.NO_SUBJECT, occluded_by: S.NO_SUBJECT },
      particles: { on_lens: "none", in_view: "none" },
      limits: {
        can_rise: pick(["yes", "no"]), can_sink: pick(["yes", "no"]), can_drift_left: pick(["yes", "no"]), can_drift_right: pick(["yes", "no"]),
        room_left: pick(ROOM), room_right: pick(ROOM), ceiling: pick(DIST),
      },
      current: { maneuver: pick(Q.MANEUVERS), since: pick(W.scaleWords("since")) },
    };
    agreeOnState(state, `random #${i}`);
  }
});

check("soft occluders (r3-small, r4-scenery-fade): what the occluder_action instructions promise is what codePolicy + the mapper do — fade for every soft kind; the fade hides the ids the sensors gave (placed trees / props, entities, particle smoke), and with none (a procedural tree, a big or unsized prop, placements too close to tell apart) it reroutes by itself", () => {
  const ins = Q.PILOT_QUESTIONS.occluder_action.instructions;
  assert.match(ins, /fades placed props and placed trees of known size, entities and particle smoke/);
  assert.match(ins, /procedural \(terrain\) trees and rocks are rerouted around/);
  assert.match(ins, /the runtime makes that reroute by itself/);
  // occluder kinds as the sensors report them → the soft class → fade (subject mostly hidden, timer running);
  // ids as the sensors give them: a placed tree's / prop's object key, an entity prop's guid, a particle key
  // (sensors never give a procedural scenery tree an id — film_perception W16 / S16)
  for (const [kind, ids] of [["tree", ["placement:a9b40000:object:12"]], ["prop", ["placement:a9b40000:object:3"]], ["prop", [0x80000123]], ["smoke", ["fx:0x50000001:2"]]]) {
    const sfFade = frame(SUBJ({ visibleFrac: 0.2, unseenSec: 1, occluderKind: kind }));
    const st = S.buildPilotState(sfFade, { standingOrder: "Foliage may be faded.", technique: "drone.orbit" });
    assert.equal(W.occluderClass(st.subject.occluded_by), "soft", `${kind} → ${st.subject.occluded_by} is soft`);
    const a = P.codePolicy(sfFade, st);
    assert.equal(a.occluder_action.choice, "fade", `${kind}: the code policy answers fade`);
    assert.equal(only(criteriaOccluder(st), kind), "fade", `${kind}: the transcribed criteria agree`);
    // the sensors named fadeable ids (a placed tree, a small prop of known size, an entity, a particle cloud) → they are faded
    const m = M.createResidualMapper();
    let sp = m.apply(a, { sceneTime: 0, now: 0, sensorFrame: { ...sfFade, subject: { ...sfFade.subject, occluderIds: ids } } });
    assert.deepEqual([sp.fadeIds, sp.reroute, m.stats().fadeFallbacks], [ids, false, 0], `${kind}: fades its id`);
    // no fadeable id (a procedural tree, a big or unsized prop, overlapping placements, an ambiguous hit) → reroute, never a no-op
    m.reset();
    sp = m.apply(a, { sceneTime: 0, now: 0, sensorFrame: { ...sfFade, subject: { ...sfFade.subject, occluderIds: [] } } });
    assert.deepEqual([sp.fadeIds, sp.reroute, m.stats().fadeFallbacks], [[], true, 1], `${kind}: reroutes by itself`);
  }
});

console.log("P4 Decisions-API answer shape");

check("codePolicy answers validate against both parsers and are hard (p = 1, confidence 1)", () => {
  for (const b of built) {
    const qs = Q.questionsFor({ hasSubject: b.sf.subject != null });
    const a = b.answers;
    assert.deepEqual(Object.keys(a), Object.keys(qs));
    assert.deepEqual(Q.parseDecisionAnswers(a, qs), a, `${b.name}: round-trips through parseDecisionAnswers`);
    assert.deepEqual(J.parseAnswers(a, qs), a, `${b.name}: accepted by the Node JEV client`);
    for (const [id, ans] of Object.entries(a)) {
      if (ans.type === "noul") {
        assert.deepEqual(Object.keys(ans), ["type", "noul"]);
        assert.ok(ans.noul === 0 || ans.noul === 1);
        continue;
      }
      assert.equal(ans.confidence, 1, id);
      const probs = Object.values(ans.probabilities);
      assert.equal(probs.reduce((x, y) => x + y, 0), 1, `${id} sums to 1`);
      const key = ans.type === "choice" ? ans.choice : String(ans.score);
      assert.equal(ans.probabilities[key], 1, `${id} chosen p = 1`);
      if (ans.type === "choice") assert.deepEqual(Object.keys(ans.probabilities), Object.keys(qs[id].criteria));
      else assert.deepEqual(Object.keys(ans.probabilities), ["0", "1", "2"]);
    }
  }
});

check("codePolicy answers only the asked questions; unknown questions get a conservative default", () => {
  const b = built[3];
  const only2 = P.codePolicy(b.sf, b.state, { questions: { risk: Q.PILOT_QUESTIONS.risk } });
  assert.deepEqual(Object.keys(only2), ["risk"]);
  const custom = P.codePolicy(b.sf, b.state, {
    questions: {
      tone: { type: "choice", instructions: "Mood?", criteria: { calm: "a", tense: "b" } },
      level: { type: "score", instructions: "How?", criteria: ["a", "b", "c", "d"] },
      night: { type: "noul", instructions: "Night?" },
    },
  });
  assert.equal(custom.tone.choice, "calm");
  assert.equal(custom.level.score, 0);
  assert.deepEqual(Object.keys(custom.level.probabilities), ["0", "1", "2", "3"]);
  assert.deepEqual(custom.night, { type: "noul", noul: 0 });
});

console.log("P5 neutral answers, agreement metric, determinism, robustness");

check("neutralAnswers = conservative first options, risk 0, not lost", () => {
  const n = P.neutralAnswers();
  assert.equal(n.maneuver.choice, "hold_path");
  assert.equal(n.risk.score, 0);
  assert.equal(n.subject_lost.noul, 0);
  assert.equal(n.occluder_action.choice, "ignore");
  assert.equal(n.framing.choice, "keep");
  assert.deepEqual(Object.keys(P.neutralAnswers(Q.questionsFor({ hasSubject: false }))), ["maneuver", "risk"]);
});

check("answersAgree: choice equality, thresholded score levels, noul side of 0.5", () => {
  const code = built[0].answers;
  assert.deepEqual(P.answersAgree(code, code), {
    agree: true, compared: 5, perQuestion: { maneuver: true, risk: true, subject_lost: true, occluder_action: true, framing: true },
  });
  const jev = {
    maneuver: { type: "choice", choice: "rise" },
    risk: { type: "score", score: 0.4 },
    subject_lost: { type: "noul", noul: 0.49 },
    occluder_action: { type: "choice", choice: "ignore" },
  };
  const r = P.answersAgree(jev, code);
  assert.equal(r.agree, false);
  assert.equal(r.compared, 4, "framing missing on one side is not compared");
  assert.deepEqual(r.perQuestion, { maneuver: false, risk: true, subject_lost: true, occluder_action: true });
  assert.equal(P.answersAgree({ risk: { type: "score", score: 1.6 } }, { risk: { type: "score", score: 1 } }).agree, false);
  assert.equal(P.answersAgree({ risk: { type: "score", score: 1.4 } }, { risk: { type: "score", score: 1 } }).agree, true);
  assert.equal(P.answersAgree({ l: { type: "noul", noul: 0.6 } }, { l: { type: "noul", noul: 1 } }).agree, true);
  assert.equal(P.answersAgree({ l: { type: "noul", noul: 0.4 } }, { l: { type: "noul", noul: 1 } }).agree, false);
  assert.deepEqual(P.answersAgree(null, code), { agree: null, compared: 0, perQuestion: {} });
  assert.equal(P.scoreLevel({ score: 1.5 }), 2);
  assert.equal(P.scoreLevel({ score: NaN }), null);
});

check("deterministic and side-effect free (frozen state input, repeated calls identical)", () => {
  for (const b of built) {
    const frozen = JSON.parse(JSON.stringify(b.state));
    const deepFreeze = (o) => (Object.freeze(o), Object.values(o).forEach((v) => v && typeof v === "object" && deepFreeze(v)), o);
    deepFreeze(frozen);
    assert.deepEqual(P.codePolicy(b.sf, frozen), b.answers);
    assert.deepEqual(P.codePolicy(b.sf, frozen), P.codePolicy(b.sf, frozen));
  }
});

check("robust to null / empty / NaN inputs (falls back to hold_path, never throws)", () => {
  for (const [sf, st] of [[null, null], [{}, null], [undefined, undefined], [frame({ nearest: { range: NaN }, pathAhead: { ttc: NaN } }), null], [null, {}], [null, { obstacles: 5 }]]) {
    const a = P.codePolicy(sf, st);
    assert.equal(a.maneuver.choice, "hold_path", JSON.stringify([sf, st]));
    assert.equal(a.risk.score, 0);
  }
  assert.equal(P.decideManeuver(null).choice, "hold_path");
  assert.equal(P.decideFraming({}).choice, "keep");
  assert.equal(P.decideOccluder({}).choice, "ignore");
});

console.log(`film_pilot_policy: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
