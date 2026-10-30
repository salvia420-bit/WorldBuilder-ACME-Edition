// tests/occlusion_cull_rigs.test.mjs — `?occlusionCull=rigs` (round-3 plan
// R3-0 / R3-6, 2026-10-30): occlusion proxies for ENTITY RIGS only.
//
// R3-6 retires the occlusion-query proxies cell half first. Its 1070 arm
// (queue item M1b-OCC) compares the default (cells + rigs) against `=rigs`
// and `=off`. Before this value existed the reader (`!(off|0|false|no)`) read
// `rigs` as ON, so the arm was silently an A/A. This suite pins:
//   1. the reader: `rigs` (any case) ⇒ "rigs"; off/0/false/no ⇒ "off";
//      absent or anything else ⇒ "on" — the default and the old values are
//      unchanged;
//   2. under `?occlusionCull=rigs`, a cell candidate (cells.js passes the
//      numeric cell id) gets NO proxy and NO query and always reads visible,
//      while a rig candidate (entities.js passes "e<guid>") still gets its
//      proxy and hides exactly as in the default mode;
//   3. the default mode still proxies both kinds, and its stats keep their
//      shape (the `cellsSkipped` counter exists only under =rigs);
//   4. `window.__occlusionCull.mode` reports what is live (the bench records it).
//
// The flag is read once at import, so each URL gets its own module instance
// (a distinct `?case=` specifier) with `globalThis.location` stubbed around
// the import.
//
// Run:  cd apps/holtburger-web && node tests/occlusion_cull_rigs.test.mjs

import * as THREE from "three";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

const MODULE = "../scene3d/occlusion_cull.js";
let _case = 0;
async function loadUnder(search) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "location");
  const prev = globalThis.location;
  globalThis.location = { search };
  try {
    return await import(new URL(`${MODULE}?case=${++_case}`, import.meta.url).href);
  } finally {
    if (had) globalThis.location = prev; else delete globalThis.location;
  }
}

// Fake WebGL2 query surface (as test_occlusion_cull.mjs): a result lands one
// frame after issue; `nextResult` decides it (0 = occluded).
function fakeGl() {
  return {
    ANY_SAMPLES_PASSED_CONSERVATIVE: 0x8d6a,
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
    active: null,
    created: 0,
    deleted: 0,
    begun: 0,
    nextResult: () => 0,
    createQuery() { this.created++; return { result: 0, pendingFrames: 0 }; },
    deleteQuery() { this.deleted++; },
    beginQuery(_t, q) { if (this.active) throw new Error("nested query"); this.active = q; this.begun++; },
    endQuery() { const q = this.active; this.active = null; q.result = this.nextResult(q); q.pendingFrames = 1; },
    getQueryParameter(q, p) {
      if (p === this.QUERY_RESULT_AVAILABLE) return q.pendingFrames <= 0;
      if (p === this.QUERY_RESULT) return q.result;
      return 0;
    },
  };
}

// A scene3d stand-in for getOcclusionCuller, plus a "world frame" in the
// client's call order: cells.js beginFrame + cell want(), then entities.js
// rig want(), then the render that runs the drawn proxies' query hooks.
function world(mod) {
  const gl = fakeGl();
  const renderer = { getContext: () => gl };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 100);
  camera.updateMatrixWorld();
  const scene3d = { renderer, scene };
  const prevWindow = globalThis.window;
  globalThis.window = globalThis;
  let occ, diag;
  try {
    occ = mod.getOcclusionCuller(scene3d, THREE);
    diag = globalThis.__occlusionCull;
  } finally {
    if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
  }
  const render = () => {
    if (!occ) return;
    for (const m of occ.group.children) {
      if (!m.visible || !occ.group.visible) continue;
      m.onBeforeRender(renderer, scene, camera);
      m.onAfterRender(renderer, scene, camera);
    }
    for (const p of occ.proxies.values()) if (p.query) p.query.pendingFrames -= 1;
  };
  return { gl, renderer, scene, camera, scene3d, occ, diag, render };
}

// A real outdoor-visible interior cell id (Holtburg room a9b40121) and a rig key
// exactly as entities.js builds it.
const CELL = 0xa9b40121 >>> 0;
const RIG = "e" + (0x50000a01 >>> 0);
const CELL_BOX = [10, -1, -1, 14, 3, 3];
const RIG_BOX = [20, -1, -1, 21, 1, 1];
const FRAMES = 10;

function run(w, armed = true) {
  const cells = [], rigs = [];
  for (let f = 0; f < FRAMES; f++) {
    w.occ.beginFrame(w.camera, armed);
    cells.push(w.occ.want(CELL, ...CELL_BOX));
    rigs.push(w.occ.want(RIG, ...RIG_BOX));
    w.render();
  }
  return { cells, rigs };
}

const PRE_STATS_KEYS = "proxies,issued,resolved,hidden,pendingMax,guarded,restores";

console.log("PART 1 — the ?occlusionCull reader");
{
  const mod = await loadUnder("");
  const parse = mod.occlusionCullModeFromSearch;
  check("occlusionCullModeFromSearch is exported", typeof parse === "function");
  if (typeof parse === "function") {
    const table = [
      ["", "on"], ["?x=1", "on"], ["?occlusionCull=", "on"], ["?occlusionCull=on", "on"],
      ["?occlusionCull=1", "on"], ["?occlusionCull=true", "on"], ["?occlusionCull=yes", "on"],
      ["?occlusionCull=rig", "on"], ["?occlusionCull=cells", "on"],
      ["?occlusionCull=off", "off"], ["?occlusionCull=OFF", "off"], ["?occlusionCull=0", "off"],
      ["?occlusionCull=false", "off"], ["?occlusionCull=no", "off"],
      ["?occlusionCull=rigs", "rigs"], ["?occlusionCull=RIGS", "rigs"], ["?a=1&occlusionCull=Rigs", "rigs"],
    ];
    const bad = table.filter(([s, want]) => parse(s) !== want).map(([s, want]) => `${s || "(none)"}→${parse(s)}≠${want}`);
    check("every value maps as documented (old values unchanged)", bad.length === 0, bad.join("; "));
    check("no search at all ⇒ on", parse(undefined) === "on" && parse(null) === "on");
  }
}

console.log("PART 2 — default (no ?occlusionCull): cells AND rigs get proxies, as before");
{
  const mod = await loadUnder("");
  check("enabled by default", mod.occlusionCullEnabled() === true);
  const w = world(mod);
  check("the default builds a culler", !!w.occ);
  const { cells, rigs } = run(w);
  check("the occluded cell hides after its occluded results", cells[0] === true && cells[FRAMES - 1] === false, cells.join(","));
  check("the occluded rig hides after its occluded results", rigs[0] === true && rigs[FRAMES - 1] === false, rigs.join(","));
  check("both candidates own a proxy", w.occ.proxies.has(CELL) && w.occ.proxies.has(RIG) && w.occ.group.children.length === 2);
  check("both candidates are queried (one query object each)", w.gl.created === 2, `created=${w.gl.created}`);
  check("default stats keep their pre-=rigs shape", Object.keys(w.occ.stats).join(",") === PRE_STATS_KEYS, Object.keys(w.occ.stats).join(","));
  check("the culler is not rigs-only", !w.occ.rigsOnly);
  check("window.__occlusionCull.mode reads \"on\"", w.diag?.mode === "on", String(w.diag?.mode));
}

console.log("PART 3 — ?occlusionCull=rigs: cell candidates get no proxy, rig candidates still do");
{
  const mod = await loadUnder("?occlusionCull=rigs");
  check("still enabled (rigs are culled)", mod.occlusionCullEnabled() === true);
  check("occlusionCullMode() reads \"rigs\"", mod.occlusionCullMode?.() === "rigs", String(mod.occlusionCullMode?.()));
  const w = world(mod);
  check("=rigs builds a culler", !!w.occ);
  const { cells, rigs } = run(w);
  check("the occluded cell always reads visible", cells.every((v) => v === true), cells.join(","));
  check("the cell has no proxy", !w.occ.proxies.has(CELL));
  check("the rig keeps its proxy and hides after its occluded results", w.occ.proxies.has(RIG) && rigs[0] === true && rigs[FRAMES - 1] === false, rigs.join(","));
  check("only the rig's proxy is in the group", w.occ.group.children.length === 1);
  check("only the rig is queried", w.gl.created === 1, `created=${w.gl.created}`);
  // The rig re-queries once per frame (each result lands the next frame); a
  // cell proxy would double that.
  check("only the rig's queries were begun", w.gl.begun === FRAMES && w.occ.stats.issued === FRAMES,
    `begun=${w.gl.begun} issued=${w.occ.stats.issued}`);
  check("every cell candidate was counted as skipped", w.occ.stats.cellsSkipped === FRAMES, String(w.occ.stats.cellsSkipped));
  check("window.__occlusionCull.mode reads \"rigs\"", w.diag?.mode === "rigs", String(w.diag?.mode));

  // The rig half is the default's, frame for frame.
  const d = world(await loadUnder(""));
  const dr = run(d).rigs;
  check("the rig's verdicts match the default mode frame for frame", dr.join(",") === rigs.join(","), `default ${dr.join(",")} vs rigs ${rigs.join(",")}`);
}

console.log("PART 4 — =rigs keeps the disarm and the camera guard");
{
  const mod = await loadUnder("?occlusionCull=rigs");
  const w = world(mod);
  const { cells, rigs } = run(w, false);
  check("disarmed (indoors): everything visible", cells.every(Boolean) && rigs.every(Boolean));
  check("disarmed: no proxy, no query", w.occ.proxies.size === 0 && w.gl.created === 0);
  w.occ.beginFrame(w.camera, true);
  check("a rig around the camera reads visible and issues no query",
    w.occ.want(RIG, -5, -5, 95, 5, 5, 105) === true && w.gl.created === 0 && w.occ.stats.guarded === 1);
}

console.log("PART 5 — the constructor option, and =off still builds nothing");
{
  const mod = await loadUnder("");
  const gl = fakeGl();
  const renderer = { getContext: () => gl };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 100);
  camera.updateMatrixWorld();
  const occ = new mod.OcclusionCuller(THREE, renderer, scene, { mode: "rigs" });
  occ.beginFrame(camera, true);
  check("{ mode: \"rigs\" } on a default-URL module: the cell gets no proxy", occ.want(CELL, ...CELL_BOX) === true && !occ.proxies.has(CELL));
  check("…and the rig does", occ.want(RIG, ...RIG_BOX) === true && occ.proxies.has(RIG));
  const plain = new mod.OcclusionCuller(THREE, { getContext: () => fakeGl() }, new THREE.Scene());
  check("no option on a default-URL module: not rigs-only", !plain.rigsOnly);
  const off = await loadUnder("?occlusionCull=off");
  check("=off: disabled and no culler", off.occlusionCullEnabled() === false && world(off).occ === null);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
