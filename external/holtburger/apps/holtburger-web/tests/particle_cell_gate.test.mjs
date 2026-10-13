// tests/particle_cell_gate.test.mjs
//
// particles-scripts-3 (2026-10-13) — `?particleCellGate=on` (OPT-IN, default
// OFF), the RENDER-ONLY EnvCell gate for interior static default_script
// emitters (scene3d/particles/particle_manager.js `_emitterCellHidden`).
//
// Interior braziers/torches/fountains are anchored in `staticsGroup`, so they
// drew while cells.js had their cell container hidden. Retail never stops
// SIMULATING an indoor emitter for that (CObjCell::IsInView is a 6-byte
// `return 1`; only CLandCell overrides it, acclient.c:354835), it only does not
// draw the cell's objects. So the gate must keep updateParticles() running and
// withhold the draw only.
//
//   G1  instanced, flag ON, container hidden: the emitter still emits and ages
//       (totalEmitted / lastUpdateTime advance, not RP6-culled, no freeze stamp)
//       and contributes ZERO instances; stats + cellHiddenLastTick count it.
//   G2  simulation parity: a hidden arm and a visible arm (same clock + RNG)
//       end with byte-identical emitter state — the gate changes no sim.
//   G3  container visible again → instances on the very next tick.
//   G4  detached container (no parent) = hidden; unresolved cellId, an anchor
//       without cellId, and a throwing lookup all draw (bail open).
//   G5  per-mesh path (instancing off): occupied slots hidden every tick while
//       the particles keep aging; shown again by the next live update.
//   G6  flag OFF (`?particleCellGate` absent or `=off`): a manager WITH a
//       lookup and a hidden container is instance-buffer identical to a
//       manager with no lookup at all (today's behaviour).
//   G7  the flag reader is an exact `=on` opt-in.
//   G8  source pins: cells.js scriptedInteriorStatics items carry `cellId`;
//       statics.js stamps it on the anchor and injects the registry lookup.
//
// Fails on the pre-change code: `setParticleCellGateFlag` /
// `readParticleCellGateFlag` / `_emitterCellHidden` do not exist, and no
// manager accepts a `cellLookup`.
//
// Run: node tests/particle_cell_gate.test.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

// particleInstancingEnabled() reads the BARE `location`; the cell gate reads
// window.location. Both default (empty search) before the first addEmitter.
globalThis.location = { search: "" };
globalThis.window = { location: globalThis.location };
const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
cam.updateMatrixWorld(true);
window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };

const { setCurrentTime, setRng } = await import("../scene3d/particles/time_rng.js");
const FX = await import("../scene3d/particles/particle_fx.js");
const PM = await import("../scene3d/particles/particle_manager.js");
const {
  ParticleManager,
  PARTICLE_RP6_STATS,
  setParticleCellGateFlag,
  readParticleCellGateFlag,
  particleCellGateEnabled,
  _emitterCellHidden,
} = PM;

let t = 1000;
setCurrentTime(() => t);
let seed = 1;
const lcg = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
setRng(lcg);

const CELL = 0x01d90105;
const tex = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
function additiveBase() {
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.blending = THREE.AdditiveBlending;
  m.userData = { __cacheOwned: true, surfaceTypeFlags: 0x10000 };
  return m;
}
const quad = new THREE.PlaneGeometry(1, 1);

// A torch-like emitter that dies and respawns inside the run, with jittered
// scale + translucency (so the instance colours are not all equal).
const info = (over = {}) => ({
  id: 0x3200fff1, emitterType: 1, particleType: 2, gfxObjId: 0, hwGfxObjId: 0x0100c001,
  birthrate: 0.03, maxParticles: 16, initialParticles: 3, totalParticles: 0, totalSeconds: 1000,
  lifespan: 0.45, lifespanRand: 0.2, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 1,
  minOffset: 0, maxOffset: 0.5, aX: 0.3, aY: 1.2, aZ: 0.1, minA: 0.5, maxA: 1.5,
  bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0, scaleRand: 0.2, startScale: 0.5, finalScale: 1.5,
  transRand: 0.1, startTrans: 0.1, finalTrans: 0.9, isParentLocal: false, billboard: false,
  ...over,
});
const flush = () => new Promise((r) => setImmediate(r));

// One arm: a manager over a group, an anchor in front of the camera (never
// RP6-culled), and a registry stand-in shaped like `scene3d.cellContainers3d`.
async function buildArm({ instancing = true, lookup = true, cellId = CELL, emitterOver = {} } = {}) {
  t = 1000;
  seed = 1;
  const group = new THREE.Group();
  const cellsGroup = new THREE.Group();
  const container = new THREE.Group();
  container.userData = { cellId: CELL, isEnvCell: true };
  cellsGroup.add(container);
  const registry = new Map([[CELL, container]]);
  const anchor = new THREE.Object3D();
  anchor.position.set(0, 0, -10);
  anchor.userData = { isStaticScriptAnchor: true, isCellStaticScriptAnchor: true };
  if (cellId != null) anchor.userData.cellId = cellId;
  group.add(anchor);
  group.updateMatrixWorld(true);
  const opts = {
    scene: group,
    instancing,
    geometryFactory: () => quad,
    materialFactory: () => additiveBase(),
  };
  const lookups = { n: 0 };
  if (lookup === true) {
    opts.cellLookup = (cid) => { lookups.n += 1; return registry.get(cid >>> 0); };
  } else if (typeof lookup === "function") {
    opts.cellLookup = lookup;
  }
  const mgr = new ParticleManager(opts);
  const id = await mgr.addEmitter({ emitterInfo: info(emitterOver), parent: anchor });
  const emitter = mgr.particleTable.get(id);
  return { mgr, group, anchor, container, registry, cellsGroup, emitter, lookups };
}

const instanceCount = (mgr) => {
  let n = 0;
  for (const b of mgr._instBuckets.values()) n += b.im.count | 0;
  return n;
};
const liveParts = (e) => e.parts.filter(Boolean);
const visibleParts = (e) => liveParts(e).filter((m) => m.visible === true).length;
function simState(e) {
  const lifetimes = [];
  for (let i = 0; i < e.parts.length; i += 1) {
    if (e.parts[i] && e.particles[i]) lifetimes.push(e.particles[i].lifetime);
  }
  return JSON.stringify({
    totalEmitted: e.totalEmitted, numParticles: e.numParticles, stopped: e.stopped,
    lastUpdateTime: e.lastUpdateTime, lastEmitTime: e.lastEmitTime, lifetimes,
    pos: liveParts(e).map((m) => [m.position.x, m.position.y, m.position.z]),
  });
}
async function ticks(arm, n, each) {
  for (let i = 0; i < n; i += 1) {
    t += 0.05;
    arm.mgr.tick();
    if (each) each(i);
    await flush(); // let a lazy slot grow (async meshFactory) settle
  }
}

// ---------------------------------------------------------------------------
console.log("-- G1 instanced, flag ON, hidden cell: simulates, draws nothing ---------");
setParticleCellGateFlag(true);
{
  const arm = await buildArm();
  const e = arm.emitter;
  check("precondition: the emitter is on the instanced path", e._instKey !== null && e._instKey !== undefined);
  // Visible first: it draws (the gate is not a blanket off-switch).
  await ticks(arm, 6);
  check("precondition: visible cell draws instances", instanceCount(arm.mgr) > 0, `count=${instanceCount(arm.mgr)}`);

  arm.container.visible = false;
  const emitted0 = e.totalEmitted;
  const s0 = { ...PARTICLE_RP6_STATS };
  let maxCount = 0, everCulled = false, frozen = false;
  await ticks(arm, 30, () => {
    maxCount = Math.max(maxCount, instanceCount(arm.mgr));
    everCulled ||= e._rp6Culled === true;
    frozen ||= e._rp6FrozenAt !== undefined;
  });
  check("hidden cell: zero instances on every tick", maxCount === 0, `max=${maxCount}`);
  check("hidden cell: the emitter kept EMITTING (updateParticles ran)", e.totalEmitted > emitted0,
    `totalEmitted ${emitted0} -> ${e.totalEmitted}`);
  check("hidden cell: the emitter kept AGING (lastUpdateTime is this tick)", e.lastUpdateTime === t,
    `lastUpdateTime=${e.lastUpdateTime} t=${t}`);
  check("hidden cell: live particles exist to withhold", e.numParticles > 0, `numParticles=${e.numParticles}`);
  check("not routed through the RP6 cull (no _rp6Culled, no freeze stamp)", !everCulled && !frozen);
  check("PARTICLE_RP6_STATS.cellHiddenEmitterTicks counted 30 emitter-ticks",
    PARTICLE_RP6_STATS.cellHiddenEmitterTicks - s0.cellHiddenEmitterTicks === 30,
    `${PARTICLE_RP6_STATS.cellHiddenEmitterTicks - s0.cellHiddenEmitterTicks}`);
  check("PARTICLE_RP6_STATS.cellHiddenParticleTicks counted the withheld particles",
    PARTICLE_RP6_STATS.cellHiddenParticleTicks - s0.cellHiddenParticleTicks > 30);
  check("manager.cellHiddenLastTick === 1", arm.mgr.cellHiddenLastTick === 1, `${arm.mgr.cellHiddenLastTick}`);
  check("the container is looked up per check (not cached)", arm.lookups.n >= 36, `lookups=${arm.lookups.n}`);
  const d = typeof window.__particleCellGateDiag === "function" ? window.__particleCellGateDiag() : null;
  check("window.__particleCellGateDiag reports the gate", !!d && d.on === true && d.hiddenLastTick >= 1,
    JSON.stringify(d));

  // ---- G3: visible again -> the next tick draws.
  console.log("-- G3 cell visible again -> instances on the next tick ------------------");
  arm.container.visible = true;
  t += 0.05;
  arm.mgr.tick();
  const live = liveParts(e).filter((m) => m.visible !== false).length;
  check("re-shown cell: instances back on the very next tick", instanceCount(arm.mgr) > 0 && instanceCount(arm.mgr) === live,
    `count=${instanceCount(arm.mgr)} live=${live}`);
  check("re-shown cell: cellHiddenLastTick back to 0", arm.mgr.cellHiddenLastTick === 0);

  // Registry swap (LRU re-bake): a NEW container under the same cellId wins.
  const fresh = new THREE.Group();
  fresh.visible = false;
  arm.cellsGroup.add(fresh);
  arm.registry.set(CELL, fresh);
  t += 0.05;
  arm.mgr.tick();
  check("re-baked container (same cellId, new object, hidden) is honoured at once", instanceCount(arm.mgr) === 0);
}

// ---------------------------------------------------------------------------
console.log("-- G2 simulation parity: hidden arm == visible arm ----------------------");
{
  const hidden = await buildArm();
  hidden.container.visible = false;
  await ticks(hidden, 40);
  const a = simState(hidden.emitter);
  const visible = await buildArm();
  await ticks(visible, 40);
  const b = simState(visible.emitter);
  check("precondition: the visible arm drew", instanceCount(visible.mgr) > 0);
  check("precondition: the hidden arm drew nothing", instanceCount(hidden.mgr) === 0);
  check("precondition: particles died and respawned", visible.emitter.totalEmitted > 16,
    `emitted ${visible.emitter.totalEmitted}`);
  check("emitter state byte-identical across arms (render-only gate)", a === b,
    a === b ? "" : `${a.slice(0, 120)} vs ${b.slice(0, 120)}`);
}

// ---------------------------------------------------------------------------
console.log("-- G4 detached / unresolved / no cellId / throwing lookup ---------------");
{
  const arm = await buildArm();
  arm.cellsGroup.remove(arm.container); // still registered, visible, but detached
  await ticks(arm, 6);
  check("detached container counts as hidden", instanceCount(arm.mgr) === 0 && arm.mgr.cellHiddenLastTick === 1);
}
{
  const arm = await buildArm();
  arm.registry.delete(CELL);
  await ticks(arm, 6);
  check("unresolved cellId draws (bail open)", instanceCount(arm.mgr) > 0);
}
{
  const arm = await buildArm({ cellId: null });
  arm.container.visible = false;
  await ticks(arm, 6);
  check("anchor without cellId (outdoor twin) is never gated", instanceCount(arm.mgr) > 0 && arm.lookups.n === 0,
    `lookups=${arm.lookups.n}`);
}
{
  const arm = await buildArm({ lookup: () => { throw new Error("boom"); } });
  await ticks(arm, 6);
  check("a throwing lookup draws (bail open, tick survives)", instanceCount(arm.mgr) > 0);
}
{
  const stub = (visible, parent) => () => ({ visible, parent });
  const e = { parent: { userData: { cellId: CELL } } };
  check("_emitterCellHidden: visible + attached -> false", _emitterCellHidden(e, stub(true, {})) === false);
  check("_emitterCellHidden: hidden -> true", _emitterCellHidden(e, stub(false, {})) === true);
  check("_emitterCellHidden: detached -> true", _emitterCellHidden(e, stub(true, null)) === true);
  check("_emitterCellHidden: no parent anchor -> false", _emitterCellHidden({ parent: null }, stub(false, {})) === false);
  let seen = null;
  _emitterCellHidden({ parent: { userData: { cellId: -2116681467 } } }, (c) => { seen = c; return null; });
  check("_emitterCellHidden looks the cellId up unsigned", seen === (-2116681467 >>> 0), `${seen}`);
}

// ---------------------------------------------------------------------------
console.log("-- G5 per-mesh path: slots hidden, particles still age -----------------");
{
  const arm = await buildArm({ instancing: false });
  const e = arm.emitter;
  check("precondition: per-mesh path", e._instKey === null || e._instKey === undefined);
  await ticks(arm, 6);
  check("precondition: visible cell shows its slots", visibleParts(e) > 0, `visible=${visibleParts(e)}`);
  arm.container.visible = false;
  const emitted0 = e.totalEmitted;
  let maxVisible = 0;
  await ticks(arm, 30, () => { maxVisible = Math.max(maxVisible, visibleParts(e)); });
  check("hidden cell: no occupied slot visible after any tick", maxVisible === 0, `max=${maxVisible}`);
  check("hidden cell: the emitter kept emitting", e.totalEmitted > emitted0 && e.numParticles > 0,
    `emitted ${emitted0} -> ${e.totalEmitted}, live ${e.numParticles}`);
  arm.container.visible = true;
  t += 0.05;
  arm.mgr.tick();
  const live = liveParts(e).length;
  check("re-shown cell: the next live update shows the slots again", visibleParts(e) > 0 && visibleParts(e) <= live,
    `visible=${visibleParts(e)} live=${live}`);
}

// ---------------------------------------------------------------------------
console.log("-- G6 flag OFF == today (no lookup) ------------------------------------");
setParticleCellGateFlag(false);
for (const fx of [false, null]) {
  // fx=false: stock buckets, every byte compared. fx=null: the default
  // (`?particleFx` ON) — its third colour channel packs a seed drawn from a
  // module-level xorshift that runs on across arms, so that one channel is
  // skipped; opacity, age and every matrix are still compared.
  FX.setParticleFxFlag(fx);
  const tag = fx === false ? "stock buckets" : "default (?particleFx)";
  const snaps = async (arm) => {
    const out = [];
    await ticks(arm, 30, () => {
      const s = [];
      for (const [k, b] of arm.mgr._instBuckets) {
        const im = b.im;
        const fxB = im.userData?.particleFx === true;
        const col = im.instanceColor ? Array.from(im.instanceColor.array.subarray(0, im.count * 3)) : [];
        s.push([k, im.count, fxB, Array.from(im.instanceMatrix.array.subarray(0, im.count * 16)),
          fxB ? col.filter((_, j) => j % 3 !== 2) : col]);
      }
      out.push(JSON.stringify(s));
    });
    return out;
  };
  const gated = await buildArm(); // has a lookup...
  gated.container.visible = false; // ...and a hidden cell
  const a = await snaps(gated);
  const today = await buildArm({ lookup: false });
  const b = await snaps(today);
  const mism = a.filter((s, i) => s !== b[i]).length;
  check(`flag OFF, ${tag}: the gated arm still draws`, instanceCount(gated.mgr) > 0);
  const anyFx = [...gated.mgr._instBuckets.values()].some((bk) => bk.im.userData?.particleFx === true);
  check(`precondition: ${tag} arm ${fx === false ? "is not" : "is"} on FX buckets`, anyFx === (fx !== false));
  check(`flag OFF, ${tag}: instance buffers identical to a no-lookup manager for 30 ticks`, mism === 0,
    `${mism} ticks differ`);
  check(`flag OFF, ${tag}: the lookup is never consulted`, gated.lookups.n === 0, `lookups=${gated.lookups.n}`);
  check(`flag OFF, ${tag}: cellHiddenLastTick stays 0`, gated.mgr.cellHiddenLastTick === 0);
}
FX.setParticleFxFlag(null);

// ---------------------------------------------------------------------------
console.log("-- G7 flag reader ------------------------------------------------------");
check("`?particleCellGate=on` -> on", readParticleCellGateFlag("?particleCellGate=on") === true);
check("absent -> off (default)", readParticleCellGateFlag("") === false && readParticleCellGateFlag("?foo=on") === false);
check("`=off` / `=1` / `=true` -> off (exact opt-in only)",
  !readParticleCellGateFlag("?particleCellGate=off") && !readParticleCellGateFlag("?particleCellGate=1")
  && !readParticleCellGateFlag("?particleCellGate=true"));
setParticleCellGateFlag(null);
check("bare page (no search) reads OFF", particleCellGateEnabled() === false);

// ---------------------------------------------------------------------------
console.log("-- G8 source pins ------------------------------------------------------");
{
  const cells = readFileSync(join(ROOT, "scene3d/cells.js"), "utf8");
  const statics = readFileSync(join(ROOT, "scene3d/statics.js"), "utf8");
  const at = cells.indexOf("scriptedInteriorStatics.push({");
  const item = at >= 0 ? cells.slice(at, cells.indexOf("});", at)) : "";
  check("cells.js scriptedInteriorStatics items carry cellId", /\bcellId:\s*snap\.cellId\b/.test(item));
  check("statics.js stamps anchor.userData.cellId from the item",
    /anchor\.userData\.cellId\s*=\s*it\.cellId\s*>>>\s*0/.test(statics));
  check("statics.js injects a cellLookup reading scene3d.cellContainers3d per call",
    /cellLookup:\s*\(cellId\)\s*=>\s*\{[\s\S]{0,120}scene3d\.cellContainers3d[\s\S]{0,120}\.get\(cellId/.test(statics));
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
