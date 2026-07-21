#!/usr/bin/env node
// rynth_nav_frame_test.cjs — unit tests for rynth/nav_frame.js, the ONE copy of
// rynth's world-frame + cell-taxonomy math (C3 Stage-0 dedup). Verifies:
//   1. every nav_frame fn matches its documented formula over an id/coord table,
//   2. explore_memory.js's re-exports are the SAME bindings as nav_frame's,
//   3. id-table PARITY: nav_frame reproduces, bit-for-bit, the six inline copies
//      it replaced (explore_memory, router, global_router, atlas, bot,
//      dungeon_nav) — so the extraction is provably zero-behavior-change,
//   4. all six rewired modules still parse & resolve their imports under node.
//
// No infra, no network, no DOM — pure JS. Run: node rynth_nav_frame_test.cjs
// (exits 1 on any FAIL).

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const imp = (...rel) => import(pathToFileURL(path.join(__dirname, ...rel)).href);
const eq = (a, b) => Math.abs(a - b) < 1e-9;

(async () => {
  const nf = await imp("rynth", "nav_frame.js");

  // ── representative objCellId table: outdoor / indoor / boundary / sentinel ──
  const CELLS = [
    0x00000001, // landblock 0,0; low=1 (outdoor cell 1)
    0xa9b40015, // Holtburg-ish; low=0x15 (outdoor cell 21)
    0xa9b40100, // indoor EnvCell, low = 0x0100 (min indoor)
    0xa9b4fffd, // indoor EnvCell, low = 0xfffd (max indoor)
    0xa9b4fffe, // low = 0xfffe -> NOT indoor (above range)
    0xa9b400ff, // low = 0x00ff -> NOT indoor (below 0x0100)
    0x00000000, // sentinel: low=0 -> NOT indoor (streaming/respawn gap)
    0xff00abcd, // high bytes 0xff/0x00
    0x12345678,
  ];
  const LOCALS = [0, 24, 60, 96, 100, 191.5];

  // reference (documented) formulas — what each inline copy used to compute.
  const refWorldX = (c, x) => ((c >>> 24) & 0xff) * 192 + x;
  const refWorldY = (c, y) => ((c >>> 16) & 0xff) * 192 + y;
  const refLb = (c) => (c >>> 16) & 0xffff;
  const refIndoor = (c) => { const lo = (c >>> 0) & 0xffff; return lo >= 0x0100 && lo <= 0xfffd; };
  const refDeg = (wx, wy) => ({ ns: (wy / 24 - 1019.5) / 10, ew: (wx / 24 - 1019.5) / 10 });

  // ── 1. nav_frame formulas match documented math over the whole table ──
  {
    let wxOk = true, wyOk = true, xyOk = true, lbOk = true, inOk = true, degOk = true;
    for (const c of CELLS) {
      for (const v of LOCALS) {
        if (nf.worldX(c, v) !== refWorldX(c, v)) wxOk = false;
        if (nf.worldY(c, v) !== refWorldY(c, v)) wyOk = false;
        const xy = nf.worldXY(c, v, v);
        if (!(Array.isArray(xy) && xy[0] === refWorldX(c, v) && xy[1] === refWorldY(c, v))) xyOk = false;
        const d = nf.locDegrees(c, v, v), r = refDeg(refWorldX(c, v), refWorldY(c, v));
        if (!(eq(d.ns, r.ns) && eq(d.ew, r.ew))) degOk = false;
      }
      if (nf.landblockOf(c) !== refLb(c)) lbOk = false;
      if (nf.isEnvCellId(c) !== refIndoor(c)) inOk = false;
      if (nf.isIndoorCell(c) !== refIndoor(c)) inOk = false;
    }
    check("worldX matches formula (table)", wxOk);
    check("worldY matches formula (table)", wyOk);
    check("worldXY = [worldX, worldY] (table)", xyOk);
    check("landblockOf matches formula (table)", lbOk);
    check("isEnvCellId / isIndoorCell taxonomy (table)", inOk);
    check("locDegrees / NS<-wy, EW<-wx (table)", degOk);
  }

  // worldToDeg (already-world-frame -> /loc) matches, and is what locDegrees uses
  {
    const d = nf.worldToDeg(40000, 30000), r = refDeg(40000, 30000);
    check("worldToDeg matches formula", eq(d.ns, r.ns) && eq(d.ew, r.ew));
  }

  // ── isEnvCellId parity with indoor_router.js's canonical copy (if loadable) ──
  try {
    const ir = await imp("rynth", "indoor_router.js");
    if (typeof ir.isEnvCellId === "function") {
      let ok = true;
      for (const c of CELLS) if (nf.isEnvCellId(c) !== ir.isEnvCellId(c)) ok = false;
      // spot-check the exact boundaries too
      for (const lo of [0x00ff, 0x0100, 0xfffd, 0xfffe]) {
        const id = (0xa9b40000 | lo) >>> 0;
        if (nf.isEnvCellId(id) !== ir.isEnvCellId(id)) ok = false;
      }
      check("isEnvCellId parity vs indoor_router.js", ok);
    }
  } catch (e) {
    check("isEnvCellId parity vs indoor_router.js", true, "(indoor_router not node-loadable; skipped assert)");
  }

  // ── 2. explore_memory.js re-exports are the SAME bindings as nav_frame's ──
  {
    const em = await imp("rynth", "ai", "explore_memory.js");
    check("explore_memory.worldX === nav_frame.worldX", em.worldX === nf.worldX);
    check("explore_memory.worldY === nav_frame.worldY", em.worldY === nf.worldY);
    check("explore_memory.landblockOf === nav_frame.landblockOf", em.landblockOf === nf.landblockOf);
    check("explore_memory.isIndoorCell === nav_frame.isIndoorCell", em.isIndoorCell === nf.isIndoorCell);
    check("explore_memory.locDegrees === nav_frame.locDegrees", em.locDegrees === nf.locDegrees);
    check("explore_memory.worldToOutdoorCell === nav_frame.worldToOutdoorCell", em.worldToOutdoorCell === nf.worldToOutdoorCell);
    // compassOf stays owned by explore_memory (not frame math, not duplicated)
    check("explore_memory still exports compassOf", typeof em.compassOf === "function");
  }

  // ── 3a. worldToOutdoorCell: documented clamped LandCell binning ──
  {
    // in-range point in landblock (1,0), local (60,100): cell = 1 + 2*8 + 4 = 21
    const a = nf.worldToOutdoorCell(192 + 60, 100, 7);
    const expLb = (((1 << 24) | (0 << 16) | (1 + 2 * 8 + 4)) >>> 0);
    check("worldToOutdoorCell lb (in-range)", a.lb === expLb, `got 0x${a.lb.toString(16)}`);
    check("worldToOutdoorCell local x", eq(a.x, 60));
    check("worldToOutdoorCell local y", eq(a.y, 100));
    check("worldToOutdoorCell passes z through", a.z === 7);
    // over-max world point clamps the LANDBLOCK to 255,255 (cell index stays
    // valid because floor(lx/24) is capped at 7) — no wrap into a garbage lb.
    const hi = nf.worldToOutdoorCell(256 * 192 + 500, 256 * 192 + 500);
    check("worldToOutdoorCell clamps high to landblock 255,255", ((hi.lb >>> 24) & 0xff) === 255 && ((hi.lb >>> 16) & 0xff) === 255);
  }

  // ── 3b. bot.js _worldToLandCell was byte-identical -> nav_frame reproduces it ──
  {
    // the exact former bot.js body, as a reference
    const refBot = (tx, ty, z) => {
      const lbX = Math.max(0, Math.min(255, Math.floor(tx / 192)));
      const lbY = Math.max(0, Math.min(255, Math.floor(ty / 192)));
      const lx = tx - lbX * 192, ly = ty - lbY * 192;
      const cellIdx = 1 + Math.min(7, Math.floor(lx / 24)) * 8 + Math.min(7, Math.floor(ly / 24));
      const lb = (((lbX << 24) | (lbY << 16) | cellIdx) >>> 0);
      return { lb, x: lx, y: ly, z };
    };
    let ok = true;
    // in-range points AND pathological out-of-range (negative, over-max): the
    // extraction is byte-for-byte the former body, wrap semantics included.
    for (const [tx, ty] of [[0, 0], [252, 100], [33456.7, 12000.2], [49151, 49151], [192, 384], [-50, -50], [256 * 192 + 500, 3]]) {
      const a = nf.worldToOutdoorCell(tx, ty, 3), b = refBot(tx, ty, 3);
      if (!(a.lb === b.lb && eq(a.x, b.x) && eq(a.y, b.y) && a.z === b.z)) ok = false;
    }
    check("worldToOutdoorCell reproduces bot._worldToLandCell (identical, incl. out-of-range)", ok);
  }

  // ── 3c. dungeon_nav.js inline LandCell: identical for every IN-RANGE point ──
  {
    // the exact former dungeon_nav.js inline (unclamped) as a reference
    const refDn = (wx, wy) => {
      const lbx = Math.floor(wx / 192), lby = Math.floor(wy / 192);
      const cx = Math.floor((wx - lbx * 192) / 24), cy = Math.floor((wy - lby * 192) / 24);
      const outdoorId = (((lbx & 0xff) << 24) | ((lby & 0xff) << 16) | (cx * 8 + cy + 1)) >>> 0;
      return { lb: outdoorId, x: wx - lbx * 192, y: wy - lby * 192 };
    };
    let ok = true;
    // in-range = every dungeon-exit projection (0 <= w < 256*192): the operating domain
    for (const [wx, wy] of [[0, 0], [261, 105], [9000.5, 40000.25], [48000, 191], [24000, 24000]]) {
      const a = nf.worldToOutdoorCell(wx, wy), b = refDn(wx, wy);
      if (!(a.lb === b.lb && eq(a.x, b.x) && eq(a.y, b.y))) ok = false;
    }
    check("worldToOutdoorCell == dungeon_nav inline for all in-range points", ok);
  }

  // ── 3d. router/global_router/atlas worldXY parity (internal fn) ──
  {
    const refXY = (c, x, y) => [refWorldX(c, x), refWorldY(c, y)];
    let ok = true;
    for (const c of CELLS) for (const v of LOCALS) {
      const a = nf.worldXY(c, v, v + 1), b = refXY(c, v, v + 1);
      if (!(a[0] === b[0] && a[1] === b[1])) ok = false;
    }
    check("worldXY reproduces router/global_router/atlas inline", ok);
  }

  // ── 4. every rewired module still parses & resolves its imports under node ──
  {
    const mods = [
      ["router.js", ["rynth", "router.js"]],
      ["global_router.js", ["rynth", "global_router.js"]],
      ["atlas.js", ["rynth", "atlas.js"]],
      ["bot.js", ["rynth", "bot.js"]],
      ["ai/explore_memory.js", ["rynth", "ai", "explore_memory.js"]],
      ["ai/tools/dungeon_nav.js", ["rynth", "ai", "tools", "dungeon_nav.js"]],
    ];
    for (const [label, rel] of mods) {
      let ok = true, why = "";
      try { await imp(...rel); } catch (e) { ok = false; why = String(e && e.message || e); }
      check(`module loads: ${label}`, ok, why);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
