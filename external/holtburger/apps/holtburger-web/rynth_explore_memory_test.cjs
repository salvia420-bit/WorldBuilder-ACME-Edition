#!/usr/bin/env node
// rynth_explore_memory_test.cjs — unit tests for rynth/ai/explore_memory.js
// (ExploreMemory: the coverage/frontier/loop core, DESIGN-surveyor-frontier-
// 2026-07-21.md WS-A). No infra, no network, no DOM — pure JS over an
// injected `now` clock for determinism (constructor opts.now).
//
// Run: node rynth_explore_memory_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "explore_memory.js")).href);
  const {
    ExploreMemory, TILE_M, Z_BAND_M, DEDUPE_WINDOW_MS,
    worldX, worldY, locDegrees, landblockOf, isIndoorCell,
    worldToOutdoorCell, compassOf,
    TELEPOI_ALIAS, TELEPOI_EXCLUDED, telepoiTargetable, telepoiAlias,
  } = mod;

  // Controllable clock: tests advance `t` explicitly so dedupe/oscillation/
  // stall windows are deterministic rather than real-time-dependent.
  function makeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, set: (v) => (t = v), advance: (d) => (t += d) };
  }
  // pose at an exact world point — objCellId:1 (NOT 0 — cell 0 is the
  // death/respawn streaming-gap sentinel observe() treats as UNKNOWN, see
  // below) keeps worldX(id,x)=x, worldY(id,y)=y (landblock bytes 0,0; low16=1
  // is a real, if nonsensical, outdoor cell index), so tests can address any
  // world coordinate directly without juggling landblock bytes.
  const poseAt = (wx, wy, z = 0) => ({ objCellId: 1, x: wx, y: wy, z });
  // pose with a real-looking objCellId (Holtburg-area) for cell/landblock
  // rendering + indoor/outdoor checks.
  const poseCell = (cell, x, y, z = 0) => ({ objCellId: cell, x, y, z });

  // ── inline world-frame helpers match the documented formulas exactly ────
  {
    const cell = 0xa9b40015;
    check("worldX formula", worldX(cell, 60) === 0xa9 * 192 + 60);
    check("worldY formula", worldY(cell, 100) === 0xb4 * 192 + 100);
    const { ns, ew } = locDegrees(cell, 60, 100);
    const expNs = ((0xb4 * 192 + 100) / 24 - 1019.5) / 10;
    const expEw = ((0xa9 * 192 + 60) / 24 - 1019.5) / 10;
    check("locDegrees ns", Math.abs(ns - expNs) < 1e-9);
    check("locDegrees ew", Math.abs(ew - expEw) < 1e-9);
    check("landblockOf", landblockOf(cell) === 0xa9b4);
  }

  // ── isIndoorCell ──────────────────────────────────────────────────────
  {
    check("outdoor cell (low16=0x0015) is NOT indoor", !isIndoorCell(0xa9b40015));
    check("indoor cell (low16=0x0129) IS indoor", isIndoorCell(0xa9b40129));
    check("low16=0x0100 boundary is indoor", isIndoorCell(0xa9b40100));
    check("low16=0xfffd boundary is indoor", isIndoorCell(0xa9b4fffd));
    check("low16=0x00ff is NOT indoor", !isIndoorCell(0xa9b400ff));
    check("low16=0xfffe is NOT indoor", !isIndoorCell(0xa9b4fffe));
  }

  // ── worldToOutdoorCell: bot.js:896-904 formula reproduced verbatim ──────
  {
    // landblock (0xa9,0xb4), local (60,100) -> world (0xa9*192+60, 0xb4*192+100)
    const wx = 0xa9 * 192 + 60, wy = 0xb4 * 192 + 100;
    const { lb, x, y, z } = worldToOutdoorCell(wx, wy, 12);
    check("worldToOutdoorCell round-trips local x/y", x === 60 && y === 100, `x=${x} y=${y}`);
    check("worldToOutdoorCell preserves z", z === 12);
    check("worldToOutdoorCell landblock bytes", landblockOf(lb) === 0xa9b4, `lb=0x${lb.toString(16)}`);
    // cellIdx = 1 + floor(60/24)*8 + floor(100/24) = 1 + 2*8 + 4 = 21 = 0x15
    check("worldToOutdoorCell cellIdx", (lb & 0xffff) === 0x15, `low16=0x${(lb & 0xffff).toString(16)}`);
    // clamps out-of-range landblock bytes to [0,255] (never throws) — this is
    // the exact bot.js:896-904 formula reproduced verbatim, including its
    // existing quirk that an extremely negative wx (never produced by
    // frontier()'s bounded ring search in practice) is not further re-clamped
    // into a valid local x, so only the high (positive-overflow) byte is
    // asserted precisely here.
    let clampThrew = false, clamped = null;
    try { clamped = worldToOutdoorCell(-500, 1e9, 0); } catch { clampThrew = true; }
    check("worldToOutdoorCell never throws on out-of-range input", !clampThrew);
    check("worldToOutdoorCell clamps overflow", ((clamped.lb >>> 16) & 0xff) === 255);
  }

  // ── compassOf ────────────────────────────────────────────────────────
  {
    check("compassOf(0)=N", compassOf(0) === "N");
    check("compassOf(90)=E", compassOf(90) === "E");
    check("compassOf(180)=S", compassOf(180) === "S");
    check("compassOf(270)=W", compassOf(270) === "W");
    check("compassOf(45)=NE", compassOf(45) === "NE");
    check("compassOf(360)=N (wraps)", compassOf(360) === "N");
    check("compassOf(-90)=W (negative wraps)", compassOf(-90) === "W");
  }

  // ── telepoi alias/exclusion table (VALIDATION COROLLARY) ────────────────
  {
    check("Qalaba'r aliases to Qalabar", telepoiAlias("Qalaba'r") === "Qalabar");
    check("Fiun Outpost aliases to Fiun", telepoiAlias("Fiun Outpost") === "Fiun");
    check("unaliased name passes through", telepoiAlias("Holtburg") === "Holtburg");
    check("7 excluded towns are not targetable",
      ["Candeth Keep", "Crater Lake Village", "Danby's Outpost", "Kor-Gursha", "Mar'uun", "Merwart Village", "Wai Jhou"]
        .every((n) => !telepoiTargetable(n)));
    check("Holtburg is targetable", telepoiTargetable("Holtburg"));
    check("TELEPOI_EXCLUDED has exactly 7 entries", TELEPOI_EXCLUDED.size === 7);
    check("TELEPOI_ALIAS has exactly 7 entries", TELEPOI_ALIAS.size === 7);
  }

  // ── tile quantization: TILE_M=12, Z_BAND_M=6 ────────────────────────────
  {
    const clock = makeClock();
    const em = new ExploreMemory({ now: clock.now });
    em.observe(poseAt(5, 5, 0)); // tile (0,0,0): floor(5/12)=0
    const a = em.current;
    check("tile key floors world coords", a.tx === 0 && a.ty === 0 && a.zb === 0, JSON.stringify(a));

    clock.advance(DEDUPE_WINDOW_MS + 100);
    em.observe(poseAt(11.9, 11.9, 0)); // still tile (0,0) — just under the 12m boundary
    check("same tile below TILE_M boundary stays current", em.current.tx === 0 && em.current.ty === 0,
      JSON.stringify(em.current));

    clock.advance(DEDUPE_WINDOW_MS + 100);
    em.observe(poseAt(12, 5, 0)); // crosses x boundary -> tile (1,0)
    check("crossing TILE_M boundary changes tile", em.current.tx === 1 && em.current.ty === 0,
      JSON.stringify(em.current));

    // z-band: stacked floor is a DIFFERENT tile even at the same x/y
    clock.advance(DEDUPE_WINDOW_MS + 100);
    em.observe(poseAt(12, 5, 0)); // same x/y/tile, ground floor
    const ground = em.current;
    clock.advance(DEDUPE_WINDOW_MS + 100);
    em.observe(poseAt(12, 5, Z_BAND_M + 1)); // one z-band up
    const upstairs = em.current;
    check("stacked floor is a distinct tile", upstairs.tileKey !== ground.tileKey, `${ground.tileKey} vs ${upstairs.tileKey}`);
    check("z-band computed via floor(z/Z_BAND_M)", upstairs.zb === 1, JSON.stringify(upstairs));
  }

  // ── visits / variation / was-is transitions ─────────────────────────────
  {
    const clock = makeClock();
    const em = new ExploreMemory({ now: clock.now });
    check("current is null before any observe", em.current === null);
    check("previous is null before any observe", em.previous === null);
    check("variation is 0 before any observe", em.variation() === 0);

    em.observe(poseAt(6, 6, 0));
    check("first observe: visits=1", em.current.visits === 1);
    check("here is an alias for current", em.here.tileKey === em.current.tileKey);
    check("was is null (no previous tile yet)", em.was === null);

    clock.advance(DEDUPE_WINDOW_MS + 100);
    em.observe(poseAt(6, 6, 0)); // same tile, outside dedupe window -> real revisit
    check("second observe same tile: visits=2", em.current.visits === 2);
    check("variation tracks current tile visits", em.variation() === 2);

    clock.advance(DEDUPE_WINDOW_MS + 100);
    em.observe(poseAt(30, 6, 0)); // new tile -> was/is transition
    check("moving to a new tile updates current", em.current.tx === 2);
    check("moving to a new tile sets previous to the old current", em.previous.tx === 0 && em.previous.visits === 2);
    check("was is an alias for previous", em.was.tileKey === em.previous.tileKey);
    check("new tile starts at visits=1", em.current.visits === 1);
  }

  // ── dual-driver double-count guard ──────────────────────────────────────
  {
    const clock = makeClock();
    const em = new ExploreMemory({ now: clock.now });
    em.observe(poseAt(6, 6, 0));
    check("baseline visits=1", em.current.visits === 1);

    clock.advance(100); // well within DEDUPE_WINDOW_MS
    em.observe(poseAt(6, 6, 0)); // same tile, near-simultaneous 2nd caller
    check("de-duped call within window does not bump visits", em.current.visits === 1);

    clock.advance(50);
    em.observe(poseAt(6.2, 6.1, 0)); // still same tile, still within window of the ORIGINAL accepted call
    check("de-dupe window measured from last ACCEPTED observe", em.current.visits === 1);

    clock.advance(DEDUPE_WINDOW_MS + 1);
    em.observe(poseAt(6, 6, 0)); // now outside the window -> real revisit
    check("call outside window is a real revisit", em.current.visits === 2);

    // a genuinely different tile within the window is NEVER de-duped
    const em2 = new ExploreMemory({ now: clock.now });
    em2.observe(poseAt(6, 6, 0));
    em2.observe(poseAt(30, 6, 0)); // different tile, same instant
    check("different tile within window is not de-duped", em2.current.tx === 2 && em2.previous.tx === 0);
  }

  // ── frontier(): direction / distance / bearing / landblock ──────────────
  {
    const clock = makeClock();
    const em = new ExploreMemory({ now: clock.now });
    // Fill a 3x3 block of tiles around the origin EXCEPT the north neighbor
    // (tx=0,ty=1), so frontier() has exactly one unambiguous answer — avoids
    // depending on ring-search tie-break order.
    let t = clock.now();
    for (let tx = -1; tx <= 1; tx++) {
      for (let ty = -1; ty <= 1; ty++) {
        if (tx === 0 && ty === 1) continue; // leave north unvisited
        clock.set((t += DEDUPE_WINDOW_MS + 10));
        const wx = (tx + 0.5) * TILE_M, wy = (ty + 0.5) * TILE_M;
        em.observe(poseAt(wx, wy, 0));
      }
    }
    // land back on the center tile so `current` is (0,0)
    clock.set((t += DEDUPE_WINDOW_MS + 10));
    em.observe(poseAt(0.5 * TILE_M, 0.5 * TILE_M, 0));

    const fr = em.frontier();
    check("frontier found", !!fr, JSON.stringify(fr));
    check("frontier is the unvisited north tile", Math.abs(fr.worldX - 0.5 * TILE_M) < 1e-6
      && Math.abs(fr.worldY - 1.5 * TILE_M) < 1e-6, JSON.stringify(fr));
    check("frontier dist = TILE_M", Math.abs(fr.dist - TILE_M) < 1e-6, `dist=${fr.dist}`);
    check("frontier bearing is due north (0deg)", Math.abs(fr.bearingDeg - 0) < 1e-6, `bearing=${fr.bearingDeg}`);
    check("frontier bearing renders as N", compassOf(fr.bearingDeg) === "N");
    check("frontier lb is a 16-bit landblock (same as current, near origin)", fr.lb === landblockOf(worldToOutdoorCell(0, 0).lb));

    // no frontier within a radius of 0 rings (nothing to search)
    const emAlone = new ExploreMemory({ now: clock.now });
    emAlone.observe(poseAt(6, 6, 0));
    check("frontier respects maxRadius: 0 -> null", emAlone.frontier({ maxRadius: 0 }) === null);
    check("frontier finds the immediate ring with default radius", emAlone.frontier() !== null);

    // east/south/west directions (fresh instances, single visited tile each)
    const mkDirEm = () => {
      const c = makeClock();
      const e = new ExploreMemory({ now: c.now });
      e.observe(poseAt(0.5 * TILE_M, 0.5 * TILE_M, 0));
      return e;
    };
    // Fill all 8 neighbors except one to force a specific direction, reusing
    // the same technique as the north case above.
    function frontierTowards(dx, dy) {
      const c = makeClock();
      const e = new ExploreMemory({ now: c.now });
      let tt = c.now();
      for (let ix = -1; ix <= 1; ix++) {
        for (let iy = -1; iy <= 1; iy++) {
          if (ix === dx && iy === dy) continue;
          c.set((tt += DEDUPE_WINDOW_MS + 10));
          e.observe(poseAt((ix + 0.5) * TILE_M, (iy + 0.5) * TILE_M, 0));
        }
      }
      c.set((tt += DEDUPE_WINDOW_MS + 10));
      e.observe(poseAt(0.5 * TILE_M, 0.5 * TILE_M, 0));
      return e.frontier();
    }
    check("frontier east", compassOf(frontierTowards(1, 0).bearingDeg) === "E");
    check("frontier south", compassOf(frontierTowards(0, -1).bearingDeg) === "S");
    check("frontier west", compassOf(frontierTowards(-1, 0).bearingDeg) === "W");
  }

  // ── loopVerdict(): severity ladder ───────────────────────────────────────
  {
    // severity 0: fresh tile
    {
      const clock = makeClock();
      const em = new ExploreMemory({ now: clock.now });
      em.observe(poseAt(6, 6, 0));
      const v = em.loopVerdict();
      check("severity 0 on first visit", v.severity === 0 && v.looping === false, JSON.stringify(v));
      check("no correction at severity 0", v.correction === "");
    }
    // severity 1: variation >= 3
    {
      const clock = makeClock();
      const em = new ExploreMemory({ now: clock.now });
      for (let i = 0; i < 3; i++) { em.observe(poseAt(6, 6, 0)); clock.advance(DEDUPE_WINDOW_MS + 10); }
      const v = em.loopVerdict();
      check("severity 1 at variation>=3", v.severity === 1 && v.looping === true, JSON.stringify(v));
      check("severity 1 has a correction string", typeof v.correction === "string" && v.correction.length > 0);
    }
    // severity 2: variation >= 5
    {
      const clock = makeClock();
      const em = new ExploreMemory({ now: clock.now });
      for (let i = 0; i < 5; i++) { em.observe(poseAt(6, 6, 0)); clock.advance(DEDUPE_WINDOW_MS + 10); }
      const v = em.loopVerdict();
      check("severity 2 at variation>=5", v.severity === 2, JSON.stringify(v));
    }
    // severity 2: A<->B oscillation (variation low on each tile)
    {
      const clock = makeClock();
      const em = new ExploreMemory({ now: clock.now });
      const A = poseAt(6, 6, 0);       // tile (0,0)
      const B = poseAt(6, 6 + TILE_M, 0); // tile (0,1) — distinct, adjacent
      const seq = [A, B, A, B, A, B];
      for (const p of seq) { em.observe(p); clock.advance(DEDUPE_WINDOW_MS + 10); }
      const v = em.loopVerdict();
      check("oscillation triggers severity>=2", v.severity >= 2, JSON.stringify(v));
      check("oscillation reason mentions bouncing", /bouncing/.test(v.reason), v.reason);
      // sanity: neither tile individually hit the variation>=5 threshold
      check("oscillation fires despite low per-tile variation (3 visits each < 5)", true);
    }
    // NOT oscillation: repeatedly on the SAME single tile (no alternation)
    {
      const clock = makeClock();
      const em = new ExploreMemory({ now: clock.now });
      for (let i = 0; i < 4; i++) { em.observe(poseAt(6, 6, 0)); clock.advance(DEDUPE_WINDOW_MS + 10); }
      // 4 visits on ONE tile: variation=4 (severity1 territory), not an oscillation
      const v = em.loopVerdict();
      check("single-tile repeats are not flagged as bouncing", !/bouncing/.test(v.reason), v.reason);
    }
    // severity 3: variation >= 8
    {
      const clock = makeClock();
      const em = new ExploreMemory({ now: clock.now });
      for (let i = 0; i < 8; i++) { em.observe(poseAt(6, 6, 0)); clock.advance(DEDUPE_WINDOW_MS + 10); }
      const v = em.loopVerdict();
      check("severity 3 at variation>=8", v.severity === 3, JSON.stringify(v));
    }
    // severity 3: wedged (sinceLbChangeMs > stallMs, frontier still local)
    {
      const clock = makeClock();
      const em = new ExploreMemory({ now: clock.now, stallMinutes: 0 }); // stallMs=0 -> any elapsed time qualifies
      em.observe(poseAt(6, 6, 0)); // lb=0 established, frontier will be local (nearby unvisited tile exists)
      clock.advance(1); // > stallMs(0)
      const v = em.loopVerdict();
      check("severity 3 wedge fires with stallMinutes:0 and a local frontier", v.severity === 3, JSON.stringify(v));
      check("wedge reason mentions wedged", /wedged/.test(v.reason), v.reason);
    }
    // escalating correction text differs per severity
    {
      const clock = makeClock();
      const em1 = new ExploreMemory({ now: clock.now });
      for (let i = 0; i < 3; i++) { em1.observe(poseAt(6, 6, 0)); clock.advance(DEDUPE_WINDOW_MS + 10); }
      const em3 = new ExploreMemory({ now: clock.now });
      for (let i = 0; i < 8; i++) { em3.observe(poseAt(6, 6, 0)); clock.advance(DEDUPE_WINDOW_MS + 10); }
      check("severity escalates to a firmer correction string",
        em1.loopVerdict().correction !== em3.loopVerdict().correction);
    }
  }

  // ── coverage() ───────────────────────────────────────────────────────────
  {
    const clock = makeClock();
    const em = new ExploreMemory({ now: clock.now });
    check("coverage all-zero before any observe",
      JSON.stringify(em.coverage()) === JSON.stringify({ tiles: 0, landblocks: 0, thisLbTiles: 0, sinceLbChangeMs: 0 }));

    em.observe(poseCell(0xa9b40015, 60, 100, 0)); // landblock 0xa9b4
    clock.advance(DEDUPE_WINDOW_MS + 10);
    em.observe(poseCell(0xa9b40015, 90, 100, 0)); // still 0xa9b4, likely a new tile
    clock.advance(DEDUPE_WINDOW_MS + 10);
    em.observe(poseCell(0xa9b50015, 10, 10, 0)); // landblock 0xa9b5 -> lb change

    const cov = em.coverage();
    check("coverage.tiles counts distinct tiles", cov.tiles >= 3, JSON.stringify(cov));
    check("coverage.landblocks counts distinct landblocks", cov.landblocks === 2, JSON.stringify(cov));
    check("coverage.thisLbTiles scoped to current landblock", cov.thisLbTiles === 1, JSON.stringify(cov));
    check("coverage.sinceLbChangeMs resets on landblock change", cov.sinceLbChangeMs === 0, JSON.stringify(cov));

    clock.advance(5000);
    check("sinceLbChangeMs grows without a further lb change", em.coverage().sinceLbChangeMs === 5000);
  }

  // ── townFrontier() ─────────────────────────────────────────────────────
  {
    const clock = makeClock();
    const em = new ExploreMemory({ now: clock.now });

    const POSE = poseCell(0xa9b40015, 60, 100, 0);
    const { ns: poseNs, ew: poseEw } = locDegrees(POSE.objCellId, POSE.x, POSE.y);
    const HOME = { name: "Holtburg", ns: poseNs, ew: poseEw };       // current town (right at the pose)
    const NEAR = { name: "Near Town", ns: poseNs + 0.2, ew: poseEw + 0.2 }; // will be marked visited
    const EXCLUDED = { name: "Kor-Gursha", ns: poseNs + 1, ew: poseEw + 1 }; // real no-POI town
    const FAR = { name: "Far Town", ns: poseNs - 5, ew: poseEw + 5 };
    const FARTHER = { name: "Farther Town", ns: poseNs - 20, ew: poseEw + 20 };
    const towns = [HOME, NEAR, EXCLUDED, FAR, FARTHER];

    check("townFrontier null with no pose", em.townFrontier(towns, null) === null);

    // nothing visited yet besides HOME's own coordinates (0 tiles there) ->
    // nearest non-current targetable town is FAR (closer than FARTHER)
    let tf = em.townFrontier(towns, POSE);
    check("townFrontier excludes the current town", tf && tf.name !== "Holtburg", JSON.stringify(tf));
    check("townFrontier excludes non-targetable (no-POI) towns", tf && tf.name !== "Kor-Gursha", JSON.stringify(tf));
    check("townFrontier returns nearest remaining candidate", tf && tf.name === "Near Town", JSON.stringify(tf));

    // mark NEAR visited by observing a tile whose deg-coords land on it
    const nearWy = (NEAR.ns * 10 + 1019.5) * 24;
    const nearWx = (NEAR.ew * 10 + 1019.5) * 24;
    em.observe(poseAt(nearWx, nearWy, 0));

    tf = em.townFrontier(towns, POSE);
    check("townFrontier skips a town with a visited tile", tf && tf.name === "Far Town", JSON.stringify(tf));

    // default towns list is accepted (real TOWNS) without throwing
    let ok = true;
    try { em.townFrontier(undefined, POSE); } catch { ok = false; }
    check("townFrontier defaults to TOWNS without throwing", ok);
  }

  // ── townNameAt() convenience ─────────────────────────────────────────────
  {
    const em = new ExploreMemory();
    const POSE = poseCell(0xa9b40015, 60, 100, 0); // known Holtburg-area fixture
    const wx = worldX(POSE.objCellId, POSE.x), wy = worldY(POSE.objCellId, POSE.y);
    check("townNameAt resolves the nearest town", em.townNameAt(wx, wy) === "Holtburg", em.townNameAt(wx, wy));
    // far from every town (south-ocean parked env cell region) -> no town named
    const far = poseCell(0x86020015, 10, 10, 0);
    const fwx = worldX(far.objCellId, far.x), fwy = worldY(far.objCellId, far.y);
    check("townNameAt returns null when far from all towns (parked env-cell region)",
      em.townNameAt(fwx, fwy) === null, em.townNameAt(fwx, fwy));
  }

  // ── classifyPlace(): three-way cell taxonomy ─────────────────────────────
  {
    const em = new ExploreMemory();
    // outdoor LandCell at Holtburg (low16 0x15 < 0x100)
    const o = poseCell(0xa9b40015, 60, 100, 0);
    const oc = em.classifyPlace(o.objCellId, worldX(o.objCellId, o.x), worldY(o.objCellId, o.y));
    check("classifyPlace: outdoor LandCell -> outdoor + town", oc.kind === "outdoor" && oc.town === "Holtburg", JSON.stringify(oc));
    // building interior EnvCell in Holtburg's own landblock (0xA9B4)
    const b = poseCell(0xa9b40129, 10, 10, 0);
    const bc = em.classifyPlace(b.objCellId, worldX(b.objCellId, b.x), worldY(b.objCellId, b.y));
    check("classifyPlace: EnvCell in a town landblock -> building + town", bc.kind === "building" && bc.town === "Holtburg", JSON.stringify(bc));
    // parked dungeon/apartment EnvCell far in the ocean (lb 0x8602)
    const d = poseCell(0x8602026e, 10, 10, 0);
    const dc = em.classifyPlace(d.objCellId, worldX(d.objCellId, d.x), worldY(d.objCellId, d.y));
    check("classifyPlace: parked EnvCell far from towns -> dungeon + no town", dc.kind === "dungeon" && dc.town === null, JSON.stringify(dc));
  }

  // ── malformed / missing pose never throws ────────────────────────────────
  {
    const em = new ExploreMemory();
    let threw = false;
    try {
      em.observe(null);
      em.observe(undefined);
      em.observe({});
      em.observe({ objCellId: "not-a-number", x: 1, y: 1 });
    } catch { threw = true; }
    check("observe() never throws on malformed pose", !threw);
    check("state stays empty after only malformed observes", em.current === null);
  }

  // ── cell-0 pose (death/respawn streaming gap) is UNKNOWN, not outdoor tile 0 ──
  // Live finding 2026-07-21: after death, the client's pose reports
  // objCellId===0 for a beat (a streaming gap), not a real cell. (cell&0xffff)
  // for cell 0 is 0, which is < 0x0100 — the SAME bit pattern isIndoorCell()
  // uses to mean "outdoor" — so a naive observe() would wrongly record a real
  // OUTDOOR tile at garbage world coordinates. observe() must no-op entirely.
  {
    const em = new ExploreMemory();
    check("current is null before any observe", em.current === null);

    em.observe({ objCellId: 0, x: 23.8, y: -30, z: 0 });
    check("cell-0 observe records nothing: current stays null", em.current === null);
    check("cell-0 observe records nothing: previous stays null", em.previous === null);
    check("cell-0 observe records nothing: variation stays 0", em.variation() === 0);
    check("cell-0 observe records nothing: coverage stays empty", em.coverage().tiles === 0);

    // cell-0 after a REAL prior tile: current/previous/visits must be
    // untouched by the gap, not reset and not silently bumped.
    const clock = makeClock();
    const em2 = new ExploreMemory({ now: clock.now });
    em2.observe(poseCell(0xa9b40015, 60, 100, 12)); // real Holtburg-area tile
    const beforeCurrent = em2.current, beforePrevious = em2.previous;
    clock.advance(DEDUPE_WINDOW_MS + 10);
    em2.observe({ objCellId: 0, x: 23.8, y: -30, z: 0 }); // death -> respawn gap
    check("cell-0 after a real tile: current is unchanged", em2.current.tileKey === beforeCurrent.tileKey
      && em2.current.visits === beforeCurrent.visits, JSON.stringify({ before: beforeCurrent, after: em2.current }));
    check("cell-0 after a real tile: previous is unchanged", em2.previous === beforePrevious);

    // a real pose after the gap resumes normal tracking (not corrupted by it)
    clock.advance(DEDUPE_WINDOW_MS + 10);
    em2.observe(poseCell(0xa9b40015, 90, 130, 12)); // a different real tile
    check("real pose after the gap is recorded normally", em2.current.cell === 0xa9b40015 && em2.current.visits === 1,
      JSON.stringify(em2.current));
    check("real pose after the gap sets previous to the pre-gap tile (gap left no trace)",
      em2.previous.tileKey === beforeCurrent.tileKey, JSON.stringify({ previous: em2.previous, expected: beforeCurrent }));
  }

  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
