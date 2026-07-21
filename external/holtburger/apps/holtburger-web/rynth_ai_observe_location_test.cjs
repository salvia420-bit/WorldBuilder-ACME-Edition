#!/usr/bin/env node
// rynth_ai_observe_location_test.cjs — unit tests for the LOCATION block
// (rynth/ai/extensions.js observe(), DESIGN-surveyor-frontier-2026-07-21.md
// WS-B). Exercises composeAiExtensions()'s directorDeps.observe end-to-end
// over a mock host/bot, driving rynth/ai/explore_memory.js's ExploreMemory
// through the SAME shared instance the composition returns
// (ext.exploreMemory) so timing can be made deterministic by overriding its
// `now` after construction — extensions.js's own instantiation stays the
// frozen `new ExploreMemory()` (no injected clock), per WS-B.
//
// Companion to rynth_explore_memory_test.cjs (ExploreMemory unit tests) and
// rynth_ai_observe_test.cjs (observe.js buildObservation unit tests) —
// per DESIGN-surveyor-frontier-2026-07-21.md's WS-E test list, this file is
// the "observe() LOCATION-block tests: block present, Frontier line format,
// CORRECTION gated on loopVerdict, shape/{text,data} preserved, old lines not
// regressed" slice.
//
// Run: node rynth_ai_observe_location_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  const modUrl = (p) => pathToFileURL(path.join(__dirname, p)).href;
  const { composeAiExtensions } = await import(modUrl("rynth/ai/extensions.js"));
  const { DEDUPE_WINDOW_MS, TILE_M } = await import(modUrl("rynth/ai/explore_memory.js"));

  function makeJournal() {
    const entries = [];
    return { entries, add: (kind, text) => entries.push({ kind, text }), renderTail: () => "" };
  }

  // Holtburg-area fixture (matches rynth_ai_observe_test.cjs's known-coords
  // pose) so the "Here:" line names a real town.
  const CELL = 0xa9b40015;
  let POSE = { objCellId: CELL, x: 60, y: 100, z: 12 };

  function makeBot() {
    const listeners = [];
    return {
      emit: (e) => listeners.forEach((fn) => fn(e)),
      kernel: { status: { running: true, kills: 0 } },
      combat: { priorities: {}, _scanTargets: () => [] },
      loot: { minValue: 0 },
      vitals: { _fractions: () => ({ hp: 1, stam: 1, mana: 1 }) },
      host: {
        onEvent: (fn) => listeners.push(fn),
        onTick: () => {},
        NearbyGuids: () => [0x5001, 0x5002],
        TryGetObjectName: (g) => ({ 0x5001: "Jonathan", 0x5002: "Door" }[g] ?? null),
        UseObject: () => true,
        GiveObject: () => true,
        TryGetPlayerInventory: () => [],
        TryGetPlayerPose: () => POSE,
        WriteToChat: () => {},
      },
    };
  }

  const mkExt = (bot, cfgExtra) =>
    composeAiExtensions(bot, {
      journal: makeJournal(),
      config: { knowledge: false, dungeonNav: false, wbt: false, economy: false, advancement: false, ...cfgExtra },
    });

  // ── basic shape: {text,data} preserved, LOCATION block present + first ───
  {
    const bot = makeBot();
    const ext = mkExt(bot);
    const o = ext.directorDeps.observe(bot, { journalTail: "j", now: 1000 });
    check("observe returns {text,data}", typeof o.text === "string" && "data" in o, JSON.stringify(Object.keys(o)));
    check("LOCATION block is present", /^LOCATION \(harness ground truth — trust this over your own memory\):/m.test(o.text));
    check("LOCATION block is injected FIRST (highest authority)", o.text.startsWith("LOCATION ("), o.text.slice(0, 60));
    check("base observation text still present", /uptime: /.test(o.text) && /kernel: /.test(o.text));
    check("Here line names the town (outdoor)", /  Here: outdoors in Holtburg/.test(o.text), (o.text.match(/  Here:.*/) || [])[0]);
    check("Here line shows tile + floor", /\(tile -?\d+,-?\d+, floor -?\d+\)/.test(o.text), (o.text.match(/  Here:.*/) || [])[0]);
    check("Here line shows visit count", /Been here 1×\./.test(o.text), (o.text.match(/  Here:.*/) || [])[0]);
    check("indoor cell hex shown for an EnvCell pose (low16=0x0015 is outdoor -> omitted)",
      !/indoor cell/.test(o.text)); // fixture cell 0xa9b40015 is OUTDOOR (low16<0x100)
    check("Covered line present", /  Covered: \d+ tiles \/ \d+ landblocks this session; \d+ tiles in this landblock\./.test(o.text),
      (o.text.match(/  Covered:.*/) || [])[0]);
    check("no Was line on the very first observation", !/  Was: /.test(o.text));
    check("no CORRECTION on the very first observation", !/  CORRECTION: /.test(o.text));
  }

  // ── indoor pose renders "indoor cell 0x...." ──────────────────────────────
  {
    const bot = makeBot();
    POSE = { objCellId: 0xa9b40129, x: 10, y: 10, z: 0 }; // low16=0x0129 -> EnvCell
    const ext = mkExt(bot);
    const o = ext.directorDeps.observe(bot, { now: 1000 });
    check("building interior named for an EnvCell pose", /inside a building in Holtburg \(cell 0xA9B40129\)/.test(o.text), (o.text.match(/  Here:.*/) || [])[0]);
    POSE = { objCellId: CELL, x: 60, y: 100, z: 12 }; // restore fixture
  }

  // ── Frontier line: always present once a tile is known, correct format ───
  {
    const bot = makeBot();
    const ext = mkExt(bot);
    const o = ext.directorDeps.observe(bot, { now: 1000 });
    check("Frontier line present", /  Frontier: nearest UNVISITED ground is ~\d+m [NESW]{1,2} \(landblock 0x[0-9A-F]{4}\)\./.test(o.text),
      (o.text.match(/  Frontier:.*/) || [])[0]);
  }

  // ── already tried here: folds the old tried: line into LOCATION ──────────
  {
    const bot = makeBot();
    const ext = mkExt(bot);
    await ext.directorDeps.execute(bot, [{ type: "use_object", object: "Door" }, { type: "use_object", object: "Door" }]);
    const o = ext.directorDeps.observe(bot, { now: 1000 });
    check("already tried here line present with repeat count", /  already tried here: Door 0x5002 \(x2\)/.test(o.text),
      (o.text.match(/  already tried here:.*/) || [])[0]);
    check("old bare 'tried:' line is gone (superseded by 'already tried here:')", !/^tried: /m.test(o.text));
    check("old bare 'explored:' line is gone (superseded by Covered:)", !/^explored: /m.test(o.text));
  }

  // ── Was line + CORRECTION gated on loopVerdict, using the shared instance ─
  // extensions.js instantiates `new ExploreMemory()` with the real clock
  // (frozen per WS-B) — override .now on the returned shared instance so this
  // test can drive many "check-ins" deterministically without sleeping.
  {
    const bot = makeBot();
    const ext = mkExt(bot);
    let t = 2_000_000;
    ext.exploreMemory.now = () => t;

    // first check-in: establishes the tile, no CORRECTION yet
    let o = ext.directorDeps.observe(bot, { now: t });
    check("no CORRECTION on the very first check-in", !/  CORRECTION: /.test(o.text));

    // repeat check-ins on the SAME pose/tile, spaced beyond the dual-driver
    // dedupe window, to climb variation() into severity>=1 territory.
    for (let i = 0; i < 3; i++) {
      t += DEDUPE_WINDOW_MS + 100;
      o = ext.directorDeps.observe(bot, { now: t });
    }
    check("CORRECTION appears once loopVerdict is looping", /  CORRECTION: /.test(o.text), (o.text.match(/  CORRECTION:.*/) || [])[0]);
    check("CORRECTION matches ExploreMemory.loopVerdict().correction",
      o.text.includes(`  CORRECTION: ${ext.exploreMemory.loopVerdict().correction}`));
    check("Been here N× reflects the repeated check-ins", /Been here 4×\./.test(o.text), (o.text.match(/  Here:.*/) || [])[0]);
  }

  // ── Was line + bouncing clause on A<->B oscillation ───────────────────────
  {
    const bot = makeBot();
    const ext = mkExt(bot);
    let t = 3_000_000;
    ext.exploreMemory.now = () => t;

    const CELL_A = { objCellId: CELL, x: 60, y: 100, z: 12 };
    const CELL_B = { objCellId: CELL, x: 60, y: 100 + TILE_M, z: 12 }; // adjacent tile

    let o;
    const seq = [CELL_A, CELL_B, CELL_A, CELL_B, CELL_A, CELL_B];
    for (const p of seq) {
      POSE = p;
      t += DEDUPE_WINDOW_MS + 100;
      o = ext.directorDeps.observe(bot, { now: t });
    }
    check("Was line present after a tile transition", /  Was: cell 0x/.test(o.text), (o.text.match(/  Was:.*/) || [])[0]);
    check("Was line flags the A<->B bounce", /you keep bouncing between these two — THIS IS A LOOP/.test(o.text),
      (o.text.match(/  Was:.*/) || [])[0]);
    check("CORRECTION also fires on oscillation", /  CORRECTION: /.test(o.text));
    POSE = { objCellId: CELL, x: 60, y: 100, z: 12 }; // restore fixture
  }

  // ── dual-driver de-dupe survives an extensions.js check-in cadence ────────
  // Two "observe()" calls that land within the dedupe window (simulating a
  // director check-in and a pressure tick landing at nearly the same real
  // moment) must NOT double-count a tile visit.
  {
    const bot = makeBot();
    const ext = mkExt(bot);
    let t = 4_000_000;
    ext.exploreMemory.now = () => t;
    ext.directorDeps.observe(bot, { now: t });
    t += 100; // well within DEDUPE_WINDOW_MS
    const o = ext.directorDeps.observe(bot, { now: t });
    check("near-simultaneous observe() calls do not double-count a visit", /Been here 1×\./.test(o.text),
      (o.text.match(/  Here:.*/) || [])[0]);
  }

  // ── other observation sections preserved (mission/scratchpad/deltas/heard) ─
  {
    const bot = makeBot();
    const ext = mkExt(bot, { memory: true });
    await ext.directorDeps.execute(bot, [{ type: "update_scratchpad", text: "goals: explore" }]);
    bot.emit({ kind: 2, text: "Jonathan says hello", u32: 0, u32b: 2 });
    const o1 = ext.directorDeps.observe(bot, { now: 1000 });
    const o2 = ext.directorDeps.observe(bot, { now: 2000 });
    check("scratchpad section still present", /SCRATCHPAD/.test(o2.text) || /goals: explore/.test(o2.text), o2.text.slice(0, 400));
    check("heard-since-last-checkin section still present", /heard since last check-in:/.test(o1.text) || /heard since last check-in:/.test(o2.text));
  }

  // ── hostile bot (no pose available at all): LOCATION renders "unknown",
  // never throws, and never names a stale tile ──────────────────────────────
  {
    const bot = makeBot();
    const ext = mkExt(bot);
    const hostile = { get host() { throw new Error("boom"); } };
    let threw = false, o = null;
    try { o = ext.directorDeps.observe(hostile, { now: 1000 }); } catch { threw = true; }
    check("hostile bot never throws", !threw && typeof o?.text === "string");
    check("LOCATION block still present (as 'unknown', not absent)", /^LOCATION \(/m.test(o.text));
    check("Here line says position unknown when pose is unavailable",
      /  Here: position unknown \(respawn\/streaming gap\)/.test(o.text), (o.text.match(/  Here:.*/) || [])[0]);
    check("no Frontier/CORRECTION toward garbage coords when pose is unavailable",
      !/  Frontier: /.test(o.text) && !/  CORRECTION: /.test(o.text));
  }

  // ── cell-0 pose (death/respawn streaming gap, VALIDATION follow-up
  // 2026-07-21): objCellId===0 must NOT be read as a real (outdoor) location —
  // it is a streaming gap, not a place. The LOCATION block must say so instead
  // of naming a tile/town/indoor-outdoor, and must not point Frontier/
  // CORRECTION at coordinates derived from it. The last known-good tile must
  // not be silently re-reported as "here" either.
  {
    const bot = makeBot();
    const ext = mkExt(bot);

    // establish a real, known-good tile first (as if standing in Holtburg)
    POSE = { objCellId: CELL, x: 60, y: 100, z: 12 };
    const oBefore = ext.directorDeps.observe(bot, { now: 1000 });
    check("pre-respawn: LOCATION names the real tile", /  Here: outdoors in Holtburg/.test(oBefore.text));
    const visitsBefore = ext.exploreMemory.current.visits;

    // death -> academy respawn: host reports objCellId 0 for a beat
    POSE = { objCellId: 0, x: 23.8, y: -30, z: 0 };
    const oGap = ext.directorDeps.observe(bot, { now: 2000 });
    check("cell-0 pose: Here line reports position unknown, not a tile/town",
      /  Here: position unknown \(respawn\/streaming gap\)/.test(oGap.text), (oGap.text.match(/  Here:.*/) || [])[0]);
    check("cell-0 pose: does not silently keep reporting the stale prior tile as here",
      !/  Here: outdoors in Holtburg/.test(oGap.text));
    check("cell-0 pose: no Frontier line toward garbage coords", !/  Frontier: /.test(oGap.text));
    check("cell-0 pose: no CORRECTION line toward garbage coords", !/  CORRECTION: /.test(oGap.text));
    check("cell-0 pose: exploreMemory does not record a tile for it (visits unchanged)",
      ext.exploreMemory.current.visits === visitsBefore, `before=${visitsBefore} after=${ext.exploreMemory.current.visits}`);
    check("cell-0 pose: exploreMemory.current stays the last known-good tile (not corrupted)",
      ext.exploreMemory.current.cell === CELL);

    // recovery: a real pose next check-in resumes normally
    POSE = { objCellId: CELL, x: 61, y: 101, z: 12 };
    const oAfter = ext.directorDeps.observe(bot, { now: 3000 });
    check("post-respawn: LOCATION resumes naming the real tile", /  Here: outdoors in Holtburg/.test(oAfter.text));

    POSE = { objCellId: CELL, x: 60, y: 100, z: 12 }; // restore fixture
  }

  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
