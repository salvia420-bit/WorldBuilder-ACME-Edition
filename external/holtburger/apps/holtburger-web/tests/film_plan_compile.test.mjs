// tests/film_plan_compile.test.mjs — film mode plan compiler (beat grid, handles, shooting schedule) and assembly
// (ffmpeg filter graph, CMX3600 EDL).
//
// WHY: film mode (`?filmMode=on`, flag filmMode, DEFAULT OFF) cuts music videos on the song's beats, shoots by SITE
// (a teleport is ≈10 s; never record across one) and reassembles takes in edit order. If a cut misses its beat, a
// dissolve has no handle material, or an xfade offset is a frame off, the finished video drifts against the music.
// These checks run the REAL tools/film/plan/{compile,edl}.mjs on a realistic 6-shot / 3-site plan with a 120 BPM song
// analysis built in-test (beats, bars, sections), plus edge cases: no song, off-grid beats, song offset, gaps,
// overlaps, clamped transitions, the greedy site order, the shoot-time estimate, the exact ffmpeg filter string for
// 3 segments with one dissolve, one shared 1/fps time base at every xfade (concat re-timed with settb — verified
// once against real ffmpeg 7.0.2, see edl.mjs), audio mapping, and CMX3600 timecodes at 30 fps. Pure string
// building — nothing runs.
//
// Run from apps/holtburger-web/: node tests/film_plan_compile.test.mjs

import assert from "node:assert/strict";
import {
  COMPILE_DEFAULTS,
  compilePlan,
  estimateShootTime,
  greedySiteOrder,
  songGrid,
} from "../tools/film/plan/compile.mjs";
import {
  assemblyArgv,
  buildAssembly,
  framesToTimecode,
  timecodeToFrames,
  toCmx3600,
} from "../tools/film/plan/edl.mjs";
import { examplePlan, KNOWN_TECHNIQUE_IDS } from "../tools/film/plan/schema.mjs";
import { FilmPlanError } from "../scene3d/film/core/errors.js";
import * as SHOTS from "../scene3d/film/shots/index.js";

/** The REAL technique registry (shots/index.js registers every shipped technique). */
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

/**
 * SongAnalysis-shaped fixture (tools/film/audio/analyze.mjs): 120 BPM 4/4 → beat 0.5 s, bar 2 s, starting at `t0`.
 * Sections (bars): intro 0–3, verse 4–11, chorus 12–19, outro 20–end.
 */
function song120({ t0 = 0, durationSec = 64 } = {}) {
  const beats = [];
  for (let k = 0; t0 + k * 0.5 <= durationSec - 0.25; k++) beats.push(t0 + k * 0.5);
  const bars = [];
  for (let i = 0; t0 + i * 2 + 2 <= durationSec + 1e-9; i++) bars.push({ i, start: t0 + i * 2, end: t0 + i * 2 + 2 });
  const sec = (i, b0, b1, label, role) => ({ i, start: t0 + b0 * 2, end: t0 + b1 * 2, startBar: b0, endBar: b1, label, role, energy: 0.5, repeatOf: null });
  return {
    version: 1, durationSec, sampleRate: 22050, tempo: { bpm: 120, confidence: 0.95 },
    beats, downbeats: bars.map((b) => b.start), bars,
    sections: [sec(0, 0, 4, "A", "intro"), sec(1, 4, 12, "B", "verse"), sec(2, 12, 20, "C", "chorus"), sec(3, 20, bars.length, "D", "outro")],
    energy: { hopSec: 0.5, values: [] },
  };
}

/** The realistic plan: 6 shots over 3 sites in EDIT order A, B, A, C, B, C (gate/tower/grove). */
function realisticPlan() {
  return {
    version: 1,
    title: "Gate, Tower, Grove",
    kind: "music-video",
    song: { file: "song/track.mp3", analysis: "song/song.json", offsetSec: 0 },
    edit: { fadeOutSec: 1 },
    sites: [
      { id: "gate", teleport: "@telepoi Holtburg", anchor: [1000, 1000, 50] },
      { id: "tower", teleport: "@tele 42.10N 33.60E", anchor: [9000, 9000, 80] },
      { id: "grove", teleport: "@teleloc 0x05050015 50.00 20.00 55.00 1.0000 0.0000 0.0000 0.0000", anchor: [1150, 1200, 55], settleSec: 1.5 },
    ],
    shots: [
      { id: "s010", site: "gate", technique: "drone.rising-reveal", duration: { bars: 4 },
        standingOrder: "Rise over the gate toward the town; keep 3 m from the walls." },
      { id: "s020", site: "tower", technique: "classic.dolly-in", duration: { sec: 3.8 }, transition: "dissolve",
        subject: { kind: "point", pos: [9000, 9010, 85] }, standingOrder: "Push in on the tower door; nothing may cross the lens." },
      { id: "s030", site: "gate", technique: "classic.orbit", duration: { beats: 8 },
        subject: { kind: "point", pos: [1000, 1010, 52] }, standingOrder: "Orbit the lifestone at 12 m; foliage may be faded." },
      { id: "s040", site: "grove", technique: "drone.orbit-poi", duration: { sec: 4.6 },
        subject: { kind: "point", pos: [1150, 1210, 56] }, standingOrder: "Circle the grove at 30 m; climb rather than swerve near tree tops." },
      { id: "s050", site: "tower", technique: "classic.tracking-follow", duration: { sec: 3.2 }, transition: { type: "fade", durationSec: 1 },
        subject: { kind: "entity", ref: "Town Crier", moving: true }, standingOrder: "Follow the crier at 4 m; never lose him for more than a second." },
      { id: "s060", site: "grove", technique: "drone.dronie", duration: { bars: 4 }, start: { bar: 12 }, transition: "dissolve",
        subject: { kind: "player" }, standingOrder: "Pull back and up from the avatar in one line; keep 3 m from branches." },
    ],
  };
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const byId = (tl) => Object.fromEntries(tl.items.map((it) => [it.shotId, it]));
function throwsCode(fn, code, re) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, "expected a throw");
  assert.ok(err instanceof FilmPlanError, `expected FilmPlanError, got ${err && err.name}: ${err && err.message}`);
  assert.equal(err.code, code, err.message);
  if (re) assert.match(err.message, re);
  return err;
}

// ── compile: the realistic plan ─────────────────────────────────────────────────────────────────────────────

console.log("film_plan_compile: realistic plan on a 120 BPM song");

const SONG = song120();
const TL = compilePlan(realisticPlan(), { song: SONG });
const IT = byId(TL);

check("timeline header: version, fps, size, duration on the grid, song meta, no warnings", () => {
  assert.equal(TL.version, 1);
  assert.equal(TL.fps, 30);
  assert.equal(TL.width, 1920);
  assert.equal(TL.height, 1080);
  assert.equal(TL.duration, 32);
  assert.equal(TL.frames, 960);
  assert.deepEqual(TL.song, { file: "song/track.mp3", analysis: "song/song.json", offsetSec: 0, bpm: 120, durationSec: 64 });
  assert.deepEqual(TL.fadeOut, { durationSec: 1, color: "black" });
  assert.equal(TL.fadeIn, null);
  assert.deepEqual(TL.warnings, []);
  assert.match(TL.source.planHash, /^[0-9a-f]{8}$/);
});

check("edit times: contiguous in plan order, every cut on a beat, bars honoured, sec durations snapped", () => {
  const want = { s010: [0, 8], s020: [8, 12], s030: [12, 16], s040: [16, 20.5], s050: [20.5, 24], s060: [24, 32] };
  for (const [id, [a, b]] of Object.entries(want)) {
    assert.equal(IT[id].editIn, a, `${id} in`);
    assert.equal(IT[id].editOut, b, `${id} out`);
    assert.equal(IT[id].editInFrame, a * 30);
    assert.equal(IT[id].editOutFrame, b * 30);
  }
  TL.items.forEach((it, i) => {
    if (i) assert.equal(it.editIn, TL.items[i - 1].editOut, "contiguous");
    assert.ok(SONG.beats.some((t) => near(t, it.editOut)), `${it.shotId} out ${it.editOut} on a beat`);
  });
  assert.equal(IT.s010.snap, "bar");
  assert.equal(IT.s010.editDuration, 8, "{bars:4} = 4 × 2 s");
  assert.equal(IT.s030.snap, "beat");
  assert.equal(IT.s030.editDuration, 4, "{beats:8} = 8 × 0.5 s");
  assert.equal(IT.s020.snap, "beat", "3.8 s → 4.0 (nearest beat)");
  assert.equal(IT.s040.editDuration, 4.5, "4.6 s → nearest beat 20.5");
  assert.equal(IT.s050.snap, "section", "23.7 is within ½ bar of the chorus at 24 → lands ON the section downbeat");
  assert.equal(IT.s060.explicitStart, true);
  assert.deepEqual(IT.s060.requested.start, { bar: 12 });
  assert.deepEqual(IT.s060.section, { i: 2, label: "C", role: "chorus" });
  assert.deepEqual(IT.s010.section, { i: 0, label: "A", role: "intro" });
});

check("handles only around dissolves/fades; takeDuration = edit + handles; transitions carry the xfade", () => {
  const h = Object.fromEntries(TL.items.map((it) => [it.shotId, [it.handleIn, it.handleOut]]));
  assert.deepEqual(h, { s010: [0, 0.5], s020: [0.5, 0], s030: [0, 0], s040: [0, 1], s050: [1, 0.5], s060: [0.5, 0] });
  for (const it of TL.items) {
    assert.ok(near(it.takeDuration, it.editDuration + it.handleIn + it.handleOut), it.shotId);
    assert.equal(it.takeFrames, Math.round(it.takeDuration * 30));
  }
  assert.deepEqual(IT.s010.transitionIn, { type: "cut", durationSec: 0 });
  assert.deepEqual(IT.s020.transitionIn, { type: "dissolve", durationSec: 0.5, xfade: "fade" });
  assert.deepEqual(IT.s050.transitionIn, { type: "fade", durationSec: 1, xfade: "fadeblack" });
  assert.deepEqual(IT.s060.transitionIn, { type: "dissolve", durationSec: 0.5, xfade: "fade" });
});

check("preRoll = max(6/fps, 0.25) + site settle; capture modes; techniques", () => {
  for (const id of ["s010", "s020", "s030", "s050"]) assert.equal(IT[id].preRollSec, 0.25, id);
  for (const id of ["s040", "s060"]) assert.equal(IT[id].preRollSec, 1.75, `${id} (grove settleSec 1.5)`);
  assert.equal(IT.s050.captureMode, "realtime", "moving entity subject → realtime");
  assert.equal(TL.items.filter((it) => it.captureMode === "stepped").length, 5);
  assert.equal(IT.s040.technique, "drone.orbit-poi");
  assert.equal(IT.s040.family, "drone");
  const t20 = compilePlan({ ...realisticPlan(), format: { fps: 20 } }, { song: SONG });
  assert.equal(t20.items[0].preRollSec, 0.3, "6 frames at 20 fps = 0.3 s");
});

check("schedule: grouped by site, greedy nearest-anchor order from the first site, edit order inside a site", () => {
  assert.deepEqual(TL.schedule.map((e) => e.siteId), ["gate", "grove", "tower"], "plan first-use order is gate, tower, grove");
  assert.deepEqual(TL.schedule.map((e) => e.shots), [["s010", "s030"], ["s040", "s060"], ["s020", "s050"]]);
  assert.equal(TL.schedule[0].travelM, null);
  assert.equal(TL.schedule[1].travelM, Math.round(Math.hypot(150, 200, 5) * 1000) / 1000);
  assert.ok(TL.schedule[2].travelM > 10000);
  const gate = TL.schedule[0];
  assert.equal(gate.teleport, "@telepoi Holtburg");
  assert.deepEqual(gate.anchor, [1000, 1000, 50]);
  assert.deepEqual(gate.ready, { lbKeys: [((5 << 24) | (5 << 16)) >>> 0], interiorLb: null, settleSec: 3, timeoutSec: 90 });
  assert.deepEqual(gate.prewarm.points, [[1000, 1000, 50], [1000, 1010, 52]]);
  assert.equal(gate.prewarm.radius, COMPILE_DEFAULTS.prewarmRadius);
  assert.ok(near(gate.takeSec, IT.s010.takeDuration + IT.s010.preRollSec + IT.s030.takeDuration + IT.s030.preRollSec));
  const ids = TL.schedule.flatMap((e) => e.shots).sort();
  assert.deepEqual(ids, TL.items.map((it) => it.shotId).sort(), "every shot scheduled exactly once");
});

check("item.take is what __film.prepare needs: ShotSpec at take length, offsets, pilot/capture/look", () => {
  const t = IT.s050.take;
  assert.equal(t.spec.technique, "classic.tracking-follow");
  assert.equal(t.spec.duration, IT.s050.takeDuration);
  assert.deepEqual(t.spec.subject, { kind: "entity", ref: "Town Crier", moving: true });
  assert.equal(t.editOffsetSec, 1, "the edit starts after the 1 s handle");
  assert.deepEqual(t.capture, { mode: "realtime", fps: 30, width: 1920, height: 1080 });
  assert.equal(t.pilot.mode, "jev");
  assert.match(t.standingOrder, /^Follow the crier/);
  assert.equal(IT.s060.take.showAvatar, true, "player subject must be visible");
  assert.equal(IT.s010.take.showAvatar, false);
  assert.deepEqual(IT.s010.take.anchor, [1000, 1000, 50]);
  assert.equal(typeof IT.s010.take.spec.seed, "number");
});

check("deterministic, JSON-safe, input not mutated", () => {
  const plan = realisticPlan();
  const before = JSON.stringify(plan);
  const a = compilePlan(plan, { song: SONG });
  const b = compilePlan(realisticPlan(), { song: song120() });
  assert.equal(JSON.stringify(plan), before);
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

check("the shipped examplePlan compiles cleanly on the grid", () => {
  const tl = compilePlan(examplePlan(), { song: song120({ durationSec: 80 }) });
  assert.deepEqual(tl.warnings, []);
  assert.equal(tl.items.length, 8);
  assert.equal(tl.schedule.length, 3);
  tl.items.forEach((it, i) => { if (i) assert.equal(it.editIn, tl.items[i - 1].editOut); });
  assert.deepEqual(tl.fadeIn, { durationSec: 1, color: "black" });
  const crypt = tl.schedule.find((e) => e.siteId === "holtburg-dungeon");
  assert.equal(crypt.indoor, true);
  assert.equal(crypt.ready.interiorLb, 0x01f60000);
  assert.equal(byId(tl).s040.take.cell, "0x01F60289", "dungeon takes seed the viewer cell");
  assert.deepEqual(byId(tl).s040.take.route, { fromCell: "0x01F60289", toCell: "0x01F6027A" });
  const real = compilePlan(examplePlan(), { song: song120({ durationSec: 80 }), registry: REAL });
  assert.deepEqual(real.warnings, [], "clean against the REAL registry too");
  assert.deepEqual(real.items.map((it) => it.captureMode), new Array(8).fill("stepped"));
});

/** Three {sec} shots at one outdoor site: a realtime-hint chase on the player, the same on a point, a bounded orbit. */
function hintPlan() {
  return {
    version: 1, title: "Hints",
    sites: [{ id: "a", teleport: "@telepoi Holtburg", anchor: [32532, 34567.1, 94] }],
    shots: [
      { id: "chase", site: "a", technique: "drone.chase", duration: { sec: 4 }, subject: { kind: "player" }, standingOrder: "Chase the avatar at 8 m." },
      { id: "lead", site: "a", technique: "classic.tracking-lead", duration: { sec: 4 }, subject: { kind: "point", pos: [32532, 34567, 95] }, standingOrder: "Lead the lifestone." },
      { id: "orbit", site: "a", technique: "drone.orbit-poi", duration: { sec: 4 }, subject: { kind: "point", pos: [32532, 34567, 95] },
        bounds: { maxLateral: 0.5, maxRise: 1, maxDistanceScale: 1.1 }, standingOrder: "Orbit the lifestone at 30 m." },
    ],
  };
}

check("capture hint: with the REAL registry a drone.chase of the player compiles realtime; a tracking shot of a point warns", () => {
  const tl = compilePlan(hintPlan(), { registry: REAL });
  const it = byId(tl);
  assert.equal(it.chase.captureMode, "realtime", "server-driven subject of a realtime-hint technique");
  assert.equal(it.chase.take.capture.mode, "realtime", "the take the page plays is realtime too");
  assert.equal(it.lead.captureMode, "stepped");
  assert.equal(it.orbit.captureMode, "stepped", "stepped-hint technique keeps format.capture");
  assert.deepEqual(tl.warnings.map((w) => w.path), ["shots[1].capture.mode"], JSON.stringify(tl.warnings));
  assert.match(tl.warnings[0].message, /classic\.tracking-lead .*capture hint "realtime".*fixed point/);
  const e = estimateShootTime(tl);
  assert.equal(e.perShot.find((x) => x.shotId === "chase").mode, "realtime");
  assert.match(e.text, /2 stepped at 8 fps, 1 realtime/);
  // No registry → the hint is unknown and the plan default stands (validate/compile with the registry, as the CLI does).
  assert.equal(byId(compilePlan(hintPlan())).chase.captureMode, "stepped");
  // An explicit capture always wins.
  const p = hintPlan();
  p.shots[0].capture = "stepped";
  assert.equal(byId(compilePlan(p, { registry: REAL })).chase.captureMode, "stepped");
});

check("shot bounds reach item.take.spec and the trajectory the page builds from it", () => {
  const tl = compilePlan(hintPlan(), { registry: REAL });
  const orbit = byId(tl).orbit;
  assert.deepEqual(orbit.take.spec.bounds, { maxLateral: 0.5, maxRise: 1, maxDistanceScale: 1.1 });
  assert.equal("bounds" in byId(tl).chase.take.spec, false, "no override → no spec.bounds");
  const traj = SHOTS.buildShot(orbit.take.spec, { anchor: orbit.take.anchor, subject: { pos: [32532, 34567, 95], radius: 0.6, height: 1.8 } });
  assert.deepEqual(traj.bounds, { ...SHOTS.getTechnique("drone.orbit-poi").defaultBounds, maxLateral: 0.5, maxRise: 1, maxDistanceScale: 1.1 });
  const bad = hintPlan();
  bad.shots[2].bounds = { maxSpeedScale: 0.5 };
  throwsCode(() => compilePlan(bad, { registry: REAL }), "PLAN_INVALID", /shots\[2\]\.bounds\.maxSpeedScale/);
});

// ── compile: edge cases ─────────────────────────────────────────────────────────────────────────────────────

console.log("film_plan_compile: edge cases");

function secPlan(shots, extra = {}) {
  return {
    version: 1, title: "Edges",
    sites: [{ id: "a", teleport: "@telepoi Holtburg", anchor: [1000, 1000, 50] }],
    shots: shots.map((s, i) => ({ id: `s${i + 1}`, site: "a", technique: "classic.static", standingOrder: "Hold still.", ...s })),
    ...extra,
  };
}

check("no song: seconds as written (frame-quantised); musical units throw SONG_REQUIRED naming the shots", () => {
  const tl = compilePlan(secPlan([{ duration: { sec: 3.8 } }, { duration: { sec: 2.21 } }]));
  assert.deepEqual(tl.items.map((it) => [it.editIn, it.editOut]), [[0, 3.8], [3.8, 6]], "6.01 s → frame 180");
  assert.deepEqual(tl.items.map((it) => it.editOutFrame), [114, 180]);
  assert.equal(tl.items[0].snap, "none");
  assert.equal(tl.song, null);
  const err = throwsCode(() => compilePlan(secPlan([{ duration: { sec: 2 } }, { duration: { beats: 4 } }, { duration: 2, start: { bar: 3 } }])), "SONG_REQUIRED", /s2, s3.*--song/);
  assert.deepEqual(err.details.shots, ["s2", "s3"]);
});

check("an invalid plan throws PLAN_INVALID with the validation errors; a registry rejection too", () => {
  const e = throwsCode(() => compilePlan(secPlan([{ duration: { sec: 0 } }])), "PLAN_INVALID", /shots\[0\]\.duration\.sec/);
  assert.equal(e.details.errors[0].path, "shots[0].duration.sec");
  const registry = { getTechnique: (id) => (id === "classic.static" ? null : { id, params: {}, needs: {} }) };
  throwsCode(() => compilePlan(secPlan([{ duration: 2 }]), { registry }), "PLAN_INVALID", /unknown technique "classic.static"/);
});

check("off-grid beats (first beat 0.37 s): every cut lands on a beat (within half a frame)", () => {
  const song = song120({ t0: 0.37 });
  const tl = compilePlan(secPlan([{ duration: { sec: 2 } }, { duration: { beats: 3 } }, { duration: { sec: 1.3 } }, { duration: { bars: 1 } }], { song: {} }), { song });
  for (const it of tl.items) assert.ok(song.beats.some((t) => Math.abs(t - it.editOut) <= 0.5 / 30 + 1e-9), `${it.shotId} out ${it.editOut}`);
  assert.ok(near(tl.items[0].editOut, 1.866667), "2.0 → nearest beat 1.87 (frame 56)");
});

check("song.offsetSec shifts the grid: edit t = song t − offset; start.bar uses SONG bar indices", () => {
  const song = song120({ t0: 0.25 });
  const plan = secPlan([{ duration: { sec: 1.1 } }, { duration: { bars: 1 }, start: { bar: 6 } }], { song: { file: "x.mp3", offsetSec: 10 } });
  const tl = compilePlan(plan, { song });
  assert.ok(near(tl.items[0].editOut, 1.266667), "song beats at 10.25+k/2 → edit 0.25+k/2; 1.1 → 1.25 (frame-quantised)");
  assert.equal(tl.items[1].editIn, 2.266667, "bar 6 = song 12.25 s = edit 2.25 s (frame 68)");
  assert.equal(tl.song.offsetSec, 10);
  assert.ok(tl.warnings.some((w) => w.path === "shots[1].start" && /gap/.test(w.message)));
});

/** True when `t` is within half a frame (30 fps; editOut is rounded to 1e-6 s) of a song downbeat (`bars[k].start`, offset applied). */
const onDownbeat = (song, t, offsetSec = 0) => song.bars.some((b) => Math.abs(b.start - offsetSec - t) <= 0.5 / 30 + 1e-6);

check("{bars} from the pickup (first downbeat at 0.5 s, edit 0 before it): bars count from bar 0, cuts at 8.5 / 16.5 / 20.5", () => {
  const song = song120({ t0: 0.5 });
  const tl = compilePlan(secPlan([{ duration: { bars: 4 } }, { duration: { bars: 4 } }, { duration: { bars: 2 } }], { song: { offsetSec: 0 } }), { song });
  assert.deepEqual(tl.items.map((it) => [it.editIn, it.editOut]), [[0, 8.5], [8.5, 16.5], [16.5, 20.5]], "pickup (0–0.5 s) joins the first shot");
  for (const it of tl.items) {
    assert.equal(it.snap, "bar", it.shotId);
    assert.ok(onDownbeat(song, it.editOut), `${it.shotId} out ${it.editOut} on a downbeat`);
  }
  assert.ok(near(tl.items[0].editOut, song.bars[4].start) && near(tl.items[1].editOut, song.bars[8].start) && near(tl.items[2].editOut, song.bars[10].start));
  assert.equal(tl.items[0].editDuration, 8.5, "4 bars + the 0.5 s pickup");
  assert.equal(tl.items[1].editDuration, 8, "contiguous {bars} after a downbeat cut: exactly 4 bars");
  assert.deepEqual(tl.warnings, []);
});

check("{bars} from the pickup (first downbeat at 1.1 s): every cut on bars[k].start; a fractional n from the pickup still cuts on a beat", () => {
  const song = song120({ t0: 1.1 });
  const tl = compilePlan(secPlan([{ duration: { bars: 4 } }, { duration: { bars: 4 } }, { duration: { bars: 2 } }], { song: {} }), { song });
  const want = [song.bars[4].start, song.bars[8].start, song.bars[10].start];
  tl.items.forEach((it, i) => assert.ok(Math.abs(it.editOut - want[i]) <= 0.5 / 30 + 1e-9, `${it.shotId} out ${it.editOut} ≠ bar start ${want[i]}`));
  assert.deepEqual(tl.items.map((it) => it.editOut), [9.1, 17.1, 21.1]);
  const frac = compilePlan(secPlan([{ duration: { bars: 1.5 } }, { duration: { bars: 2 } }], { song: {} }), { song });
  assert.equal(frac.items[0].editOut, 4.1, "1.5 bars counted from bar 0 (1.1 s) → 4.1 s, a beat");
  assert.ok(song.beats.some((t) => near(t, frac.items[0].editOut)));
});

check("{bars} run from the pickup then start:{section}: contiguous, no gap or trim warning", () => {
  for (const t0 of [0.5, 1.1]) {
    const song = song120({ t0 });
    const tl = compilePlan(secPlan([
      { duration: { bars: 4 } }, { duration: { bars: 4 } }, { duration: { bars: 4 } },
      { duration: { bars: 2 }, start: { section: 2 } },
    ], { song: {} }), { song });
    assert.deepEqual(tl.warnings, [], `t0 ${t0}: ${JSON.stringify(tl.warnings)}`);
    assert.equal(tl.items[3].editIn, tl.items[2].editOut, `t0 ${t0}: the chorus starts where the run ends`);
    assert.ok(near(tl.items[3].editIn, song.sections[2].start), `t0 ${t0}: section 2 at ${song.sections[2].start}`);
    assert.deepEqual(tl.items[3].section, { i: 2, label: "C", role: "chorus" });
  }
});

check("{bars} at edit 0 mid-bar (song.offsetSec inside a bar) counts from the next downbeat; other mid-bar starts keep the length", () => {
  const song = song120({ t0: 0.25 });
  // offsetSec 10 → edit downbeats at 0.25 + 2k (edit 0 sits ⅞ into a bar, half a beat before the next downbeat).
  const tl = compilePlan(secPlan([{ duration: { bars: 2 } }, { duration: { bars: 2 } }], { song: { offsetSec: 10 } }), { song });
  assert.deepEqual(tl.items.map((it) => it.editOut), [4.266667, 8.266667], "4.25 / 8.25 s, frame-quantised");
  for (const it of tl.items) assert.ok(onDownbeat(song, it.editOut, 10), `${it.shotId} out ${it.editOut} on a downbeat`);
  // A genuinely mid-bar start (after a {beats} shot) keeps its length and lands on the nearest beat (unchanged rule).
  const s0 = song120();
  const mid = compilePlan(secPlan([{ duration: { beats: 2 } }, { duration: { bars: 1 } }, { duration: { bars: 1 }, start: { sec: 5 } }], { song: {} }), { song: s0 });
  assert.deepEqual(mid.items.map((it) => [it.editIn, it.editOut]), [[0, 1], [1, 3], [5, 7]], "1 bar = 2 s from mid-bar; explicit {sec} start mid-bar too");
  assert.ok(!onDownbeat(s0, mid.items[1].editOut) && s0.beats.some((t) => near(t, mid.items[1].editOut)), "on a beat, not a downbeat");
  // A shot exactly on a downbeat (t0 = 0, the realistic plan) is unchanged: {bars:4} = 8 s.
  assert.equal(compilePlan(secPlan([{ duration: { bars: 4 } }], { song: {} }), { song: s0 }).items[0].editOut, 8);
});

// Round-2 regression (tooling-3 follow-up): the round-1 pickup rule sent an edit-0 start that is only slightly PAST a
// downbeat to the NEXT bar, so the first {bars:n} shot became n + 1 bars and every following cut was a bar late.
// Each case runs three contiguous {bars} shots and checks every cut against the downbeat it must hit.
const BAR_RUN = [{ duration: { bars: 4 } }, { duration: { bars: 4 } }, { duration: { bars: 2 } }];
const r6 = (x) => Math.round(x * 1e6) / 1e6;
/** Compile BAR_RUN at `offsetSec`; assert cut i is within half a frame of song bar `fromBar + [4, 8, 10][i]`. */
function barRunCuts(song, offsetSec, fromBar) {
  const tl = compilePlan(secPlan(BAR_RUN, { song: { offsetSec } }), { song });
  const want = [4, 8, 10].map((d) => song.bars[fromBar + d].start - offsetSec);
  tl.items.forEach((it, i) => {
    assert.equal(it.snap, "bar", `offsetSec ${offsetSec}: ${it.shotId}`);
    assert.ok(Math.abs(it.editOut - want[i]) <= 0.5 / 30 + 1e-6,
      `offsetSec ${offsetSec}: ${it.shotId} cuts at ${it.editOut}, want song bar ${fromBar + [4, 8, 10][i]} (edit ${r6(want[i])})`);
    assert.ok(onDownbeat(song, it.editOut, offsetSec), `offsetSec ${offsetSec}: ${it.shotId} out ${it.editOut} on a downbeat`);
  });
  assert.deepEqual(tl.warnings, [], `offsetSec ${offsetSec}: ${JSON.stringify(tl.warnings)}`);
  return tl;
}

check("{bars} with song.offsetSec on / 2 ms after / 2 ms before a downbeat, and a real pickup: every cut on its downbeat", () => {
  assert.equal(COMPILE_DEFAULTS.barLineTolBeats, 0.5, "a start within half a beat of a bar line is on it");
  const s0 = song120();
  // Song bar 4 is at 8 s. Exactly on it, 2 ms after it, 2 ms before it: count from bar 4 → cuts on bars 8, 12, 14.
  for (const off of [8, 8.002, 7.998]) {
    const tl = barRunCuts(s0, off, 4);
    assert.deepEqual(tl.items.map((it) => [it.editIn, it.editOut]), [[0, 8], [8, 16], [16, 20]], `offsetSec ${off}: frame-quantised`);
    assert.equal(tl.items[0].editDuration, 8, `offsetSec ${off}: the first {bars:4} is 4 bars, not 5`);
  }
  // A real pickup: first downbeat at 0.51 s, offset 0 → the 0.51 s pickup joins shot 1, cuts on bars 4, 8, 10.
  const pk = barRunCuts(song120({ t0: 0.51 }), 0, 0);
  assert.deepEqual(pk.items.map((it) => it.editOut), [8.5, 16.5, 20.5], "8.51 / 16.51 / 20.51 s on the 30 fps frame grid");
  assert.equal(pk.items[1].editDuration, 8, "after the pickup shot: exactly 4 bars");
});

check("{bars}: offsetSec copied from `song analyze` (one decimal) just past a downbeat still cuts on bar k + n; contiguous into start:{section}", () => {
  // Checker probes: 8.001 / 8.01 on a grid at 0 (bar 4 = 8 s) used to make {bars:4} 10 s.
  for (const off of [8.001, 8.01]) assert.equal(barRunCuts(song120(), off, 4).items[0].editOut, 8, `offsetSec ${off}`);
  // Verse downbeat at 8.98 s (bar 4 of a t0 = 0.98 grid); analyze prints it as 0:09.0 and the director copies 9.0.
  const song = song120({ t0: 0.98 });
  barRunCuts(song, 9.0, 4);
  // 2 + 6 bars from the verse reach the chorus (section 2, bar 12) exactly: no trim, no gap.
  const tl = compilePlan(secPlan([
    { duration: { bars: 2 } }, { duration: { bars: 6 } }, { duration: { bars: 4 }, start: { section: 2 } },
  ], { song: { offsetSec: 9.0 } }), { song });
  assert.deepEqual(tl.warnings, [], JSON.stringify(tl.warnings));
  assert.ok(Math.abs(tl.items[0].editOut - (song.bars[6].start - 9)) <= 0.5 / 30 + 1e-6, `v1 out ${tl.items[0].editOut} = bar 6 (2 bars, not 3)`);
  assert.equal(tl.items[2].editIn, tl.items[1].editOut, "the chorus starts where the verse run ends");
  assert.ok(Math.abs(tl.items[2].editIn - (song.sections[2].start - 9)) <= 0.5 / 30 + 1e-6, `chorus in ${tl.items[2].editIn} = section 2`);
  assert.equal(tl.items[0].section.i, 1, "edit 0 is in the verse");
});

check("{bars} tolerance edges: half a beat past a downbeat is on it; further into the bar counts from the next; non-zero starts too", () => {
  const s0 = song120();
  // 0.2 s past bar 4 (< half a beat = 0.25 s) → on bar 4: the first cut on bar 8 (16 − 8.2 = 7.8 s).
  assert.deepEqual(compilePlan(secPlan(BAR_RUN, { song: { offsetSec: 8.2 } }), { song: s0 }).items.map((it) => it.editOut), [7.8, 15.8, 19.8]);
  // 0.3 s past bar 4 (> half a beat) → edit 0 opens mid-bar → next downbeat (bar 5): cuts on bars 9, 13, 15.
  barRunCuts(s0, 8.3, 5);
  assert.deepEqual(compilePlan(secPlan(BAR_RUN, { song: { offsetSec: 8.3 } }), { song: s0 }).items.map((it) => it.editOut), [9.7, 17.7, 21.7]);
  // A non-zero explicit start just after / just before a bar line counts from that bar: {bars:1} from 4.1 or 3.9 → bar 3 (6 s).
  for (const st of [4.1, 3.9]) {
    const tl = compilePlan(secPlan([{ duration: { sec: 3.5 } }, { duration: { bars: 1 }, start: { sec: st } }], { song: {} }), { song: s0 });
    assert.equal(tl.items[1].editOut, 6, `start ${st}`);
    assert.equal(tl.items[1].snap, "bar");
  }
  // A start well inside a bar after a {beats} shot still keeps its length (1 bar from 1 s → 3 s, a beat).
  const mid = compilePlan(secPlan([{ duration: { beats: 2 } }, { duration: { bars: 1 } }], { song: {} }), { song: s0 });
  assert.deepEqual(mid.items.map((it) => it.editOut), [1, 3]);
});

check("a player subject whose actor walks reaches item.take (and spec) with moving: true; a standing actor does not", () => {
  const plan = secPlan([
    { technique: "classic.pan", duration: 4, subject: "player", actor: { moveTo: [1020, 1000, 50] } },
    { technique: "classic.static", duration: 4, subject: { kind: "player" }, actor: { emote: "/bow" } },
  ]);
  const tl = compilePlan(plan, { registry: REAL });
  const [walk, bow] = tl.items;
  assert.deepEqual(walk.take.subject, { kind: "player", moving: true });
  assert.deepEqual(walk.take.spec.subject, { kind: "player", moving: true });
  assert.equal(walk.captureMode, "realtime");
  assert.equal(walk.take.showAvatar, true);
  assert.deepEqual(bow.take.subject, { kind: "player" }, "standing actor → static player subject");
  assert.equal(bow.captureMode, "stepped");
});

check("explicit start after the previous end = black gap (warning); before it = previous trimmed (warning)", () => {
  const gap = compilePlan(secPlan([{ duration: 4 }, { duration: 2, start: { sec: 6 } }]));
  assert.deepEqual(gap.items.map((it) => [it.editIn, it.editOut]), [[0, 4], [6, 8]]);
  assert.ok(gap.warnings.some((w) => w.path === "shots[1].start" && /2 s gap \(black\) between s1 and s2/.test(w.message)));
  const over = compilePlan(secPlan([{ duration: 4 }, { duration: 2, start: { sec: 3 } }]));
  assert.deepEqual(over.items.map((it) => [it.editIn, it.editOut]), [[0, 3], [3, 5]]);
  assert.ok(over.warnings.some((w) => /s1 is trimmed to 3 s/.test(w.message)));
  throwsCode(() => compilePlan(secPlan([{ duration: 4, start: { sec: 2 } }, { duration: 2, start: { sec: 2 } }])), "PLAN_INVALID", /edit order/);
});

check("transitions: first-shot fade = program fade-in (no handles); dissolve across a gap = cut; clamped to fit", () => {
  const a = compilePlan(secPlan([{ duration: 4, transition: { type: "fadewhite", durationSec: 1 } }, { duration: 4 }]));
  assert.deepEqual(a.fadeIn, { durationSec: 1, color: "white" });
  assert.equal(a.items[0].handleIn, 0);
  const b = compilePlan(secPlan([{ duration: 4 }, { duration: 2, start: { sec: 5 }, transition: "dissolve" }]));
  assert.deepEqual(b.items[1].transitionIn, { type: "cut", durationSec: 0 });
  assert.equal(b.items[0].handleOut, 0);
  assert.ok(b.warnings.some((w) => /cannot cross the gap/.test(w.message)));
  const c = compilePlan(secPlan([{ duration: 4 }, { duration: 0.4, transition: { type: "dissolve", durationSec: 2 } }]));
  assert.equal(c.items[1].transitionIn.durationSec, 0.8, "post half (0.4 s) must fit the 0.4 s shot");
  assert.equal(c.items[1].handleIn, 0.8);
  assert.equal(c.items[0].handleOut, 0.8);
  assert.ok(c.warnings.some((w) => /shortened from 2 s to 0\.8 s/.test(w.message)));
});

check("songGrid: inverse beat/bar maps, extrapolation, bars from downbeats, bpm fallback, bad input", () => {
  const g = songGrid(song120({ t0: 0.37 }));
  for (const t of [0.37, 1.1, 5.555, 30]) assert.ok(near(g.beatTime(g.beatPos(t)), t, 1e-9));
  assert.ok(near(g.beatTime(-2), 0.37 - 1));
  assert.ok(near(g.beatTime(g.beats.length + 3), g.beats[g.beats.length - 1] + 2));
  assert.ok(near(g.barTime(3), 6.37));
  assert.ok(near(g.nearestDownbeat(7.1), 6.37));
  assert.ok(near(g.ceilBeat(1.0), 1.37));
  const noBars = songGrid({ beats: [0, 0.5, 1, 1.5, 2, 2.5], downbeats: [0, 2] });
  assert.ok(near(noBars.barLen, 2));
  const bpmOnly = songGrid({ tempo: { bpm: 100 }, durationSec: 12, beats: [] });
  assert.ok(near(bpmOnly.period, 0.6));
  assert.ok(near(bpmOnly.barTime(1), 2.4), "every 4th synthesised beat");
  throwsCode(() => songGrid({ beats: [1] }), "SONG_INVALID");
  throwsCode(() => songGrid(null), "SONG_INVALID");
});

check("edit longer than the song warns; greedySiteOrder is stable on ties", () => {
  const tl = compilePlan(secPlan([{ duration: { bars: 10 } }], { song: {} }), { song: song120({ durationSec: 12 }) });
  assert.ok(tl.warnings.some((w) => /past the end of the song/.test(w.message)));
  const order = greedySiteOrder([
    { id: "a", anchor: [0, 0, 0] }, { id: "b", anchor: [10, 0, 0] }, { id: "c", anchor: [-10, 0, 0] }, { id: "d", anchor: [100, 0, 0] },
  ]);
  assert.deepEqual(order.map((o) => o.id), ["a", "b", "c", "d"], "tie b/c → b (first in edit order); from b, c (20 m) beats d (90 m)");
  assert.deepEqual(order.map((o) => o.travelM), [null, 10, 20, 110]);
  const swapped = greedySiteOrder([{ id: "a", anchor: [0, 0, 0] }, { id: "c", anchor: [-10, 0, 0] }, { id: "b", anchor: [10, 0, 0] }]);
  assert.deepEqual(swapped.map((o) => o.id), ["a", "c", "b"], "tie broken by input (edit) order");
});

check("estimateShootTime: teleports + settles + stepped frames at stepFps, realtime at wall clock", () => {
  const e = estimateShootTime(TL);
  assert.equal(e.teleports, 3);
  assert.equal(e.takes, 6);
  let render = 0;
  let frames = 0;
  for (const it of TL.items) {
    const f = Math.ceil((it.takeDuration + it.preRollSec) * 30 - 1e-6);
    frames += f;
    render += it.captureMode === "realtime" ? it.takeDuration + it.preRollSec : f / 8;
  }
  assert.equal(e.frames, frames);
  assert.ok(near(e.renderTotalSec, render, 1e-3));
  assert.ok(near(e.totalSec, 3 * (12 + 5) + render, 1e-3));
  assert.equal(e.teleportTotalSec, 36);
  assert.equal(e.settleTotalSec, 15);
  assert.equal(e.perShot.find((x) => x.shotId === "s050").sec, 5.25, "realtime: 5 s take + 0.25 s pre-roll");
  assert.equal(e.perSite.length, 3);
  assert.match(e.text, /3 teleport\(s\).*6 take\(s\).*5 stepped at 8 fps, 1 realtime/);
  const fast = estimateShootTime(TL, { teleportSec: 10, settleSec: 0, stepFps: 30 });
  assert.ok(fast.totalSec < e.totalSec);
  throwsCode(() => estimateShootTime({}), "TIMELINE_INVALID");
});

// ── assembly ────────────────────────────────────────────────────────────────────────────────────────────────

console.log("film_plan_compile: assembly (ffmpeg filter graph)");

/** Three 4 s shots: A cut, B with a dissolve of `d` s, C cut. */
function threeShot(d = 1, extra = {}) {
  return compilePlan(secPlan([
    { duration: 4 },
    { duration: 4, transition: { type: "dissolve", durationSec: d } },
    { duration: 4 },
  ], { title: "Three Shots", ...extra }));
}
const takesFor = (tl, fps = 30) => Object.fromEntries(tl.items.map((it, i) => [it.shotId, { file: `takes/${"abc"[i] || it.shotId}.mp4`, fps, frames: Math.round(it.takeDuration * fps), durationSec: it.takeDuration }]));
const CHAIN = "setpts=PTS-STARTPTS,fps=30,scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p";

check("3 segments, one 1 s dissolve: trims, source ranges and the exact filter string", () => {
  const tl = threeShot(1);
  const a = buildAssembly(tl, takesFor(tl));
  const seg = a.segments.map((s) => [s.shotId, s.trimIn, s.trimOut, s.srcIn, s.srcOut, s.transition.type]);
  assert.deepEqual(seg, [
    ["s1", 0, 4, 0, 4.5, "cut"],
    ["s2", 1, 5, 0.5, 5, "dissolve"],
    ["s3", 0, 4, 0, 4, "cut"],
  ]);
  assert.deepEqual(a.segments[1].transition, { type: "dissolve", durationSec: 1, xfade: "fade" });
  assert.equal(a.ffmpeg.filterComplex, [
    `[0:v]trim=start_frame=0:end_frame=135,${CHAIN}[e0]`,
    `[1:v]trim=start_frame=15:end_frame=150,${CHAIN}[e1]`,
    `[2:v]trim=start_frame=0:end_frame=120,${CHAIN}[e2]`,
    "[e1][e2]concat=n=2:v=1:a=0,settb=1/30[r1]",
    "[e0][r1]xfade=transition=fade:duration=1:offset=3.5[x1]",
    "[x1]format=yuv420p[vout]",
  ].join(";"));
  assert.deepEqual(a.ffmpeg.inputs, ["-i", "takes/a.mp4", "-i", "takes/b.mp4", "-i", "takes/c.mp4"]);
  assert.deepEqual(a.ffmpeg.map, ["-map", "[vout]"]);
  assert.equal(a.audio, null);
  assert.equal(a.totalSec, 12);
  // program length = Σ segment lengths − Σ dissolves = 135 + (135 + 120) − 30 = 360 frames
  const len = a.segments.reduce((s, x) => s + Math.round((x.srcOut - x.srcIn) * 30), 0) - 30;
  assert.equal(len, a.totalFrames);
});

check("odd-frame dissolve (0.5 s = 15 frames) splits 7 before / 8 after the cut; offset rounds down", () => {
  const tl = threeShot(0.5);
  const a = buildAssembly(tl, takesFor(tl));
  assert.match(a.ffmpeg.filterComplex, /\[0:v\]trim=start_frame=0:end_frame=128,/);
  assert.match(a.ffmpeg.filterComplex, /\[1:v\]trim=start_frame=8:end_frame=135,/);
  assert.match(a.ffmpeg.filterComplex, /xfade=transition=fade:duration=0\.5:offset=3\.766666\[x1\]/);
});

check("two dissolves + a fade: xfade chain offsets, fadeblack, fades from the timeline/options", () => {
  const tl = compilePlan(secPlan([
    { duration: 4 }, { duration: 3, transition: { type: "dissolve", durationSec: 1 } },
    { duration: 5, transition: { type: "fade", durationSec: 2 } }, { duration: 4 },
  ], { edit: { fadeInSec: 0.5, fadeOutSec: 1 } }));
  const a = buildAssembly(tl, takesFor(tl));
  const fc = a.ffmpeg.filterComplex;
  assert.match(fc, /\[e0\]\[e1\]xfade=transition=fade:duration=1:offset=3\.5\[x1\]/);
  assert.match(fc, /\[e2\]\[e3\]concat=n=2:v=1:a=0,settb=1\/30\[r2\]/);
  assert.match(fc, /\[x1\]\[r2\]xfade=transition=fadeblack:duration=2:offset=6\[x2\]/);
  assert.match(fc, /\[x2\]fade=t=in:start_frame=0:nb_frames=15:color=black,fade=t=out:start_frame=450:nb_frames=30:color=black,format=yuv420p\[vout\]$/);
  assert.equal(a.totalSec, 16);
  const noFade = buildAssembly(tl, takesFor(tl), { fadeInSec: 0, fadeOutSec: 0 });
  assert.match(noFade.ffmpeg.filterComplex, /\[x2\]format=yuv420p\[vout\]$/);
});

check("audio: song mapped with -ss offset, trimmed to the program, faded with the picture", () => {
  const tl = threeShot(1, { song: { file: "song/track.mp3", offsetSec: 10 }, edit: { fadeOutSec: 1 } });
  const a = buildAssembly(tl, takesFor(tl));
  assert.deepEqual(a.audio, { file: "song/track.mp3", offsetSec: 10 });
  assert.deepEqual(a.ffmpeg.inputs.slice(-4), ["-ss", "10", "-i", "song/track.mp3"]);
  assert.match(a.ffmpeg.filterComplex, /;\[3:a\]atrim=duration=12,asetpts=PTS-STARTPTS,afade=t=out:st=11:d=1\[aout\]$/);
  assert.deepEqual(a.ffmpeg.map, ["-map", "[vout]", "-map", "[aout]"]);
  const b = buildAssembly(tl, takesFor(tl), { audioFile: "/abs/other.wav", audioOffsetSec: 2.5 });
  assert.deepEqual(b.ffmpeg.inputs.slice(-4), ["-ss", "2.5", "-i", "/abs/other.wav"]);
  const argv = assemblyArgv(a, { out: "edit/final.mp4" });
  assert.deepEqual(argv.slice(0, 2), ["-hide_banner", "-y"]);
  const fcAt = argv.indexOf("-filter_complex");
  assert.equal(argv[fcAt + 1], a.ffmpeg.filterComplex);
  for (const x of ["libx264", "yuv420p", "aac", "-shortest", "+faststart"]) assert.ok(argv.includes(x), x);
  assert.equal(argv[argv.length - 1], "edit/final.mp4");
  throwsCode(() => assemblyArgv(a, {}), "BAD_ARGUMENT");
});

check("gaps become exact black fillers; leading black when the first shot starts late", () => {
  const tl = compilePlan(secPlan([{ duration: 2, start: { sec: 1 } }, { duration: 2, start: { sec: 4 } }]));
  const a = buildAssembly(tl, takesFor(tl));
  assert.deepEqual(a.segments.map((s) => [s.kind, s.editIn, s.editOut]), [["black", 0, 1], ["take", 1, 3], ["black", 3, 4], ["take", 4, 6]]);
  assert.match(a.ffmpeg.filterComplex, /^color=c=black:s=1920x1080:r=30,trim=end_frame=30,setpts=PTS-STARTPTS,setsar=1,format=yuv420p\[e0\];/);
  assert.match(a.ffmpeg.filterComplex, /\[e0\]\[e1\]\[e2\]\[e3\]concat=n=4:v=1:a=0,settb=1\/30\[r0\];\[r0\]format=yuv420p\[vout\]$/);
  assert.equal(a.ffmpeg.inputs.length, 4, "black needs no input");
  assert.equal(a.totalSec, 6);
});

check("takes: missing → TAKES_MISSING or black; short → last frame held; hopeless → TAKE_TOO_SHORT; 60 fps takes", () => {
  const tl = threeShot(1);
  const takes = takesFor(tl);
  delete takes.s3;
  const e = throwsCode(() => buildAssembly(tl, takes), "TAKES_MISSING", /s3/);
  assert.deepEqual(e.details.missing, ["s3"]);
  const blk = buildAssembly(tl, takes, { missing: "black" });
  assert.equal(blk.segments[2].kind, "black");
  assert.ok(blk.warnings.some((w) => /no take for s3/.test(w.message)));
  const short = takesFor(tl);
  short.s1.frames = 130;
  const s = buildAssembly(tl, short);
  assert.match(s.ffmpeg.filterComplex, /\[0:v\]trim=start_frame=0:end_frame=135,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=5,fps=30/);
  assert.ok(s.warnings.some((w) => /5 frame\(s\) short/.test(w.message)));
  const tiny = takesFor(tl);
  tiny.s2.frames = 10;
  throwsCode(() => buildAssembly(tl, tiny), "TAKE_TOO_SHORT");
  const hi = buildAssembly(tl, takesFor(tl, 60));
  assert.match(hi.ffmpeg.filterComplex, /\[1:v\]trim=start_frame=30:end_frame=300,setpts=PTS-STARTPTS,fps=30,/);
  throwsCode(() => buildAssembly({ items: [] }, {}), "TIMELINE_INVALID");
});

/**
 * Time base each filter-graph label carries, from the chain that produces it (null = unknown): a take chain ends
 * at 1/F after `fps=F`, a filler starts at `color=…:r=F`, `concat` emits 1/1000000 unless re-timed by `settb`,
 * `xfade` inherits its first input.
 */
function labelTimebases(fc) {
  const tb = {};
  for (const chain of fc.split(";")) {
    const out = /\[(\w+)\]$/.exec(chain);
    if (!out) continue;
    const ins = [...chain.matchAll(/^((?:\[[\w:]+\])*)/g)][0][1].match(/[\w:]+/g) || [];
    const settb = /settb=(?:expr=)?1\/(\d+)\[\w+\]$/.exec(chain);
    let v = null;
    if (settb) v = `1/${settb[1]}`;
    else if (/concat=/.test(chain)) v = "1/1000000";
    else if (/xfade=/.test(chain)) v = tb[ins[0]] ?? null;
    else if (/^color=.*:r=(\d+)/.test(chain)) v = `1/${/:r=(\d+)/.exec(chain)[1]}`;
    else if (/,fps=(\d+),/.test(chain)) v = `1/${/,fps=(\d+),/.exec(chain)[1]}`;
    else if (ins.length === 1 && tb[ins[0]] !== undefined) v = tb[ins[0]];
    tb[out[1]] = v;
  }
  return tb;
}

check("one time base: every xfade input is 1/fps — concat outputs re-timed with settb (ffmpeg 7 xfade rejects 1/1000000)", () => {
  const topologies = {
    "dissolve then cut": [{ duration: 4 }, { duration: 4, transition: { type: "dissolve", durationSec: 1 } }, { duration: 4 }],
    "cut then fade": [{ duration: 4 }, { duration: 4 }, { duration: 4, transition: { type: "fade", durationSec: 1 } }],
    "cut, dissolve, cut, fade": [{ duration: 3 }, { duration: 3 }, { duration: 3, transition: { type: "dissolve", durationSec: 1 } }, { duration: 3 },
      { duration: 3, transition: { type: "fade", durationSec: 2 } }],
    "gap then cuts": [{ duration: 2, start: { sec: 1 } }, { duration: 2 }, { duration: 2, start: { sec: 6 } }],
  };
  for (const [name, shots] of Object.entries(topologies)) {
    const tl = compilePlan(secPlan(shots, { edit: { fadeInSec: 0.5, fadeOutSec: 0.5 } }));
    const a = buildAssembly(tl, takesFor(tl, 60));
    const fc = a.ffmpeg.filterComplex;
    const tb = labelTimebases(fc);
    const concats = fc.split(";").filter((c) => /concat=/.test(c));
    assert.ok(concats.length >= 1, `${name}: has a cut run`);
    for (const c of concats) assert.match(c, /concat=n=\d+:v=1:a=0,settb=1\/30\[r\d+\]$/, `${name}: ${c}`);
    for (const c of fc.split(";").filter((x) => /xfade=/.test(x))) {
      const [x, y] = c.match(/^\[(\w+)\]\[(\w+)\]/).slice(1);
      assert.equal(tb[x], "1/30", `${name}: first xfade input [${x}] time base`);
      assert.equal(tb[y], "1/30", `${name}: second xfade input [${y}] time base`);
    }
    assert.equal(tb.vout, "1/30", `${name}: program time base`);
  }
});

check("assembly of the realistic timeline: program length, xfade count, inputs in edit order", () => {
  const a = buildAssembly(TL, takesFor(TL));
  assert.equal(a.totalFrames, TL.frames);
  assert.equal((a.ffmpeg.filterComplex.match(/xfade=/g) || []).length, 3);
  assert.deepEqual(a.ffmpeg.inputFiles.filter((f) => f.kind === "video").map((f) => f.file), ["takes/a.mp4", "takes/b.mp4", "takes/c.mp4", "takes/s040.mp4", "takes/s050.mp4", "takes/s060.mp4"]);
  assert.match(a.ffmpeg.filterComplex, /xfade=transition=fadeblack:duration=1:offset=20\[x2\]/, "fade into s050 centred on 20.5 s");
  assert.match(a.ffmpeg.filterComplex, /\[6:a\]atrim=duration=32,asetpts=PTS-STARTPTS,afade=t=out:st=31:d=1\[aout\]/);
});

// ── EDL ─────────────────────────────────────────────────────────────────────────────────────────────────────

console.log("film_plan_compile: CMX3600 EDL");

check("timecode helpers: non-drop at 30 fps", () => {
  assert.equal(framesToTimecode(0, 30), "00:00:00:00");
  assert.equal(framesToTimecode(1799, 30), "00:00:59:29");
  assert.equal(framesToTimecode(108000, 30), "01:00:00:00");
  assert.equal(framesToTimecode(108000 + 105, 30), "01:00:03:15");
  assert.equal(timecodeToFrames("01:00:03:15", 30), 108105);
  assert.equal(timecodeToFrames(42, 30), 42);
  throwsCode(() => timecodeToFrames("01:00:00:30", 30), "BAD_ARGUMENT");
  throwsCode(() => timecodeToFrames("1h", 30), "BAD_ARGUMENT");
  throwsCode(() => framesToTimecode(1.5, 30), "BAD_ARGUMENT");
});

check("CMX3600 for 3 shots with a 1 s dissolve: exact text at 30 fps", () => {
  const tl = threeShot(1);
  const edl = toCmx3600(tl, takesFor(tl));
  assert.equal(edl, [
    "TITLE: Three Shots",
    "FCM: NON-DROP FRAME",
    "",
    "001  AX       V     C        00:00:00:00 00:00:03:15 01:00:00:00 01:00:03:15",
    "* FROM CLIP NAME: a.mp4",
    "",
    "002  AX       V     C        00:00:03:15 00:00:03:15 01:00:03:15 01:00:03:15",
    "002  AX       V     D    030 00:00:00:15 00:00:05:00 01:00:03:15 01:00:08:00",
    "* FROM CLIP NAME: a.mp4",
    "* TO CLIP NAME: b.mp4",
    "",
    "003  AX       V     C        00:00:00:00 00:00:04:00 01:00:08:00 01:00:12:00",
    "* FROM CLIP NAME: c.mp4",
    "",
  ].join("\n"));
  // Column layout: event(3) 2sp reel(8) sp chan(5) sp trans(4) sp dur(3) sp tc tc tc tc
  for (const l of edl.split("\n").filter((x) => /^\d{3} /.test(x))) {
    assert.equal(l.length, 76, l);
    assert.match(l.slice(29), /^(\d{2}:\d{2}:\d{2}:\d{2} ){3}\d{2}:\d{2}:\d{2}:\d{2}$/);
  }
});

check("CMX3600: record start, shot reels, fades from/to BL, gaps, audio event, missing takes named by shot", () => {
  const tl = compilePlan(secPlan([{ duration: 2 }, { duration: 2, start: { sec: 3 } }], {
    title: "Edge\nCases", edit: { fadeInSec: 0.5, fadeOutSec: 1 }, song: { file: "/music/track.mp3", offsetSec: 2 },
  }));
  const edl = toCmx3600(tl, { s1: { file: "/p/takes/s1.mp4", fps: 30, frames: 60 } }, { recordStart: "00:00:00:00", reel: "shot" });
  const lines = edl.split("\n");
  assert.equal(lines[0], "TITLE: Edge Cases");
  assert.ok(lines.includes("001  BL       V     C        00:00:00:00 00:00:00:00 00:00:00:00 00:00:00:00"));
  assert.ok(lines.includes("001  S1       V     D    015 00:00:00:00 00:00:02:00 00:00:00:00 00:00:02:00"), edl);
  assert.ok(lines.includes("002  BL       V     C        00:00:00:00 00:00:01:00 00:00:02:00 00:00:03:00"), "gap = BL event");
  assert.ok(lines.includes("003  S2       V     C        00:00:00:00 00:00:01:00 00:00:03:00 00:00:04:00"));
  assert.ok(lines.includes("* FROM CLIP NAME: s2.mp4"), "missing take named <shotId>.mp4");
  assert.ok(lines.includes("004  S2       V     C        00:00:01:00 00:00:01:00 00:00:04:00 00:00:04:00"));
  assert.ok(lines.includes("004  BL       V     D    030 00:00:00:00 00:00:01:00 00:00:04:00 00:00:05:00"));
  assert.ok(lines.includes("005  AX       A     C        00:00:02:00 00:00:07:00 00:00:00:00 00:00:05:00"), "song from its offset");
  assert.ok(lines.includes("* FROM CLIP NAME: track.mp3"));
  assert.ok(!toCmx3600(tl, {}, { audio: false }).includes(" A     C "));
});

check("CMX3600 of the realistic timeline: one event per shot + fade-out, record ends at 01:00:32:00", () => {
  const edl = toCmx3600(TL, takesFor(TL));
  const ev = new Set(edl.split("\n").filter((l) => /^\d{3} /.test(l)).map((l) => l.slice(0, 3)));
  assert.equal(ev.size, 6 + 1 + 1, "6 shots + fade-out + audio");
  assert.ok(edl.includes("01:00:31:00 01:00:32:00\n* FROM CLIP NAME: s060.mp4\n* TO CLIP NAME: BLACK"));
  assert.ok(edl.includes("D    030 "), "the 1 s fade into s050 is a 30-frame dissolve event");
  assert.ok(KNOWN_TECHNIQUE_IDS.length > 0);
});

console.log(`film_plan_compile: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
