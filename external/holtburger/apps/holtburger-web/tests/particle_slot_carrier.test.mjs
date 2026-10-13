// tests/particle_slot_carrier.test.mjs
//
// Slot carriers (2026-10-13, `?particleSlotCarrier`, DEFAULT ON). On the
// instanced particle path (`?particleInstancing`, default ON) the per-slot
// meshes never render: `_appendInstances` reads back only their transform and
// opacity, and the bucket draws with its own material. Every slot still got its
// own `baseMaterial.clone()` just to hold that one opacity float. Now the slots
// share ONE carrier material and particle.js setTranslucency writes the opacity
// to `mesh.userData.__op`; real clones are made only when an instanced emitter
// goes (back) to the per-mesh path.
//
//   S1  byte-identity: a legacy arm (`setParticleSlotCarrierFlag(false)`) and a
//       carrier arm, deterministic clock + RNG, additive + alpha emitters with
//       respawns, opacity lerps, lazy slot growth and billboarding: every
//       bucket's instanceMatrix + instanceColor are identical for 30 ticks
//       (stock buckets: all of instanceColor; `?particleFx` buckets: the
//       opacity channel + the translation).
//   S2  the carrier arm: every built slot of every instanced emitter holds the
//       ONE shared carrier; zero slot clones (base.clone() spy counts only the
//       bucket materials); the cache base materials are untouched.
//   S3  runtime toggle OFF (`setInstancing(false)`): every slot gets a distinct
//       `__disposable` clone, opacity = its `userData.__op`, the right blend
//       branch, and the live meshes rejoin the scene; ON again: `_instAlpha`
//       and `_instBaseMat` from the stored base (a carrier cannot be probed),
//       clones parked in the pool, slots back on the carrier, buckets rebuilt.
//   S4  bucket-attach failure fallback: clones carrying the live opacity, and
//       a lazy grow after the fallback clones (not the carrier).
//   S5  the carrier is never pooled, disposed or touched by the additive fog
//       walk; `?particleInstancing=off` (instancing:false) never uses it.
//   S6  setTranslucency on a carrier vs a normal material; the flag reader.
//
// Fails on the pre-change code: `setParticleSlotCarrierFlag` / `_isSlotCarrier`
// do not exist, and every instanced slot holds its own clone.
//
// Run: node tests/particle_slot_carrier.test.mjs

import * as THREE from "three";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

// particleInstancingEnabled() / particleSlotCarrierEnabled() read the BARE
// `location` (globalThis.location); set it before the first addEmitter.
globalThis.location = { search: "" };
globalThis.window = { location: globalThis.location };
const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
cam.updateMatrixWorld(true);
window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };

const { setCurrentTime, setRng } = await import("../scene3d/particles/time_rng.js");
const FX = await import("../scene3d/particles/particle_fx.js");
const { setTranslucency } = await import("../scene3d/particles/particle.js");
const PM = await import("../scene3d/particles/particle_manager.js");
const {
  ParticleManager,
  setParticleSlotCarrierFlag,
  particleSlotCarrierEnabled,
  _isSlotCarrier,
} = PM;

let t = 1000;
setCurrentTime(() => t);
let seed = 1;
const lcg = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
setRng(lcg);

const tex = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
const GFX_ADD = 0x0100c001, GFX_ALPHA = 0x0100c002;
// Base cache materials, as materials.js getParticleUnlit builds them.
function makeBases() {
  const add = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  add.blending = THREE.AdditiveBlending;
  add.userData = { __cacheOwned: true, surfaceTypeFlags: 0x10000 };
  const alpha = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
  alpha.userData = { __cacheOwned: true, surfaceTypeFlags: 0x100 };
  // base.clone() spy: on the instanced path only the bucket materials clone it.
  const clones = { n: 0 };
  for (const b of [add, alpha]) {
    const orig = b.clone;
    b.clone = function () { clones.n += 1; return orig.call(this); };
  }
  const snap = (m) => JSON.stringify([m.uuid, m.opacity, m.blending, m.fog, m.depthWrite, m.alphaTest,
    m.transparent, m.forceSinglePass, m.version, m.userData]);
  return { add, alpha, clones, snap, map: new Map([[GFX_ADD, add], [GFX_ALPHA, alpha]]) };
}
const quad = new THREE.PlaneGeometry(1, 1);
const noPosGeom = new THREE.BufferGeometry(); // `_instGeometryFor` → null ⇒ attach failure

// LocalVelocity emitters that die and respawn inside 30 ticks, with jittered
// scale + translucency (the opacity lerp the carrier must reproduce).
const info = (hw, over = {}) => ({
  id: 0x3200fff0 + (hw & 0xf), emitterType: 1, particleType: 2, gfxObjId: 0, hwGfxObjId: hw,
  birthrate: 0.03, maxParticles: 16, initialParticles: 3, totalParticles: 0, totalSeconds: 1000,
  lifespan: 0.45, lifespanRand: 0.2, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 1,
  minOffset: 0, maxOffset: 0.5, aX: 0.3, aY: 1.2, aZ: 0.1, minA: 0.5, maxA: 1.5,
  bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0, scaleRand: 0.2, startScale: 0.5, finalScale: 1.5,
  transRand: 0.1, startTrans: 0.1, finalTrans: 0.9, isParentLocal: false, billboard: false,
  ...over,
});
const flush = () => new Promise((r) => setImmediate(r));
const slotsOf = (mgr, id) => mgr.particleTable.get(id).partStorage.filter(Boolean);

async function buildArm(carrier, { fx = false } = {}) {
  setParticleSlotCarrierFlag(carrier);
  FX.setParticleFxFlag(fx);
  t = 1000;
  seed = 1;
  const bases = makeBases();
  const group = new THREE.Group();
  const anchor = new THREE.Object3D(); anchor.position.set(0, 0, -10);
  group.add(anchor);
  group.updateMatrixWorld(true);
  const mgr = new ParticleManager({
    scene: group, instancing: true,
    geometryFactory: (hw) => ((hw >>> 0) === 0x0100c0ff ? noPosGeom : quad),
    materialFactory: (hw) => bases.map.get(hw >>> 0) ?? bases.add,
  });
  const idAdd = await mgr.addEmitter({ emitterInfo: info(GFX_ADD), parent: anchor });
  // billboarded alpha emitter: the camera-facing pass rewrites slot rotations
  const idAlpha = await mgr.addEmitter({ emitterInfo: info(GFX_ALPHA, { billboard: true }), parent: anchor });
  return { mgr, group, anchor, bases, idAdd, idAlpha };
}

function snapshot(mgr) {
  const out = {};
  for (const [key, b] of mgr._instBuckets) {
    const im = b.im;
    out[key] = {
      count: im.count,
      m: Array.from(im.instanceMatrix.array.subarray(0, im.count * 16)),
      c: im.instanceColor ? Array.from(im.instanceColor.array.subarray(0, im.count * 3)) : [],
      fx: im.userData?.particleFx === true,
    };
  }
  return out;
}

async function runTicks(arm, n) {
  const snaps = [];
  for (let i = 0; i < n; i += 1) {
    t += 0.05;
    arm.mgr.tick();
    snaps.push(snapshot(arm.mgr));
    await flush(); // let a lazy slot grow (async meshFactory) settle, same in both arms
  }
  return snaps;
}

const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

// ---------------------------------------------------------------------------
console.log("-- S1 byte-identity: legacy clones vs slot carriers --------------------");
let carrierArm = null;
for (const fx of [false, true]) {
  const legacy = await buildArm(false, { fx });
  const legacySnaps = await runTicks(legacy, 30);
  const carrier = await buildArm(true, { fx });
  const carrierSnaps = await runTicks(carrier, 30);
  const tag = fx ? "?particleFx on" : "stock buckets";
  let ticksWithBoth = 0, mismatches = [], opacities = new Set();
  for (let i = 0; i < 30; i += 1) {
    const a = legacySnaps[i], b = carrierSnaps[i];
    const ka = Object.keys(a).sort().join(","), kb = Object.keys(b).sort().join(",");
    if (ka !== kb) { mismatches.push(`tick ${i}: buckets ${ka} vs ${kb}`); continue; }
    let both = 0;
    for (const k of Object.keys(a)) {
      const x = a[k], y = b[k];
      if (x.count > 0) both += 1;
      if (x.count !== y.count) { mismatches.push(`tick ${i} ${k}: count ${x.count} vs ${y.count}`); continue; }
      if (fx) {
        // FX seeds come from a module-level xorshift that runs on across arms;
        // compare what the carrier change can touch: opacity (r) + translation.
        for (let j = 0; j < x.count; j += 1) {
          opacities.add(x.c[j * 3]);
          if (!Object.is(x.c[j * 3], y.c[j * 3])) { mismatches.push(`tick ${i} ${k}: op[${j}]`); break; }
          if (!same(x.m.slice(j * 16 + 12, j * 16 + 15), y.m.slice(j * 16 + 12, j * 16 + 15))) {
            mismatches.push(`tick ${i} ${k}: pos[${j}]`); break;
          }
        }
      } else {
        for (let j = 0; j < x.count; j += 1) opacities.add(x.c[j * 3]);
        if (!same(x.m, y.m)) mismatches.push(`tick ${i} ${k}: instanceMatrix`);
        if (!same(x.c, y.c)) mismatches.push(`tick ${i} ${k}: instanceColor`);
      }
    }
    if (both === 2) ticksWithBoth += 1;
  }
  const lE = legacy.mgr.particleTable.get(legacy.idAdd);
  check(`${tag}: precondition — both buckets drew on most ticks`, ticksWithBoth >= 25, `${ticksWithBoth}/30`);
  check(`${tag}: precondition — particles died and respawned (more emitted than slots built)`,
    lE.totalEmitted > lE._createdSlots, `emitted ${lE.totalEmitted}, slots ${lE._createdSlots}`);
  check(`${tag}: precondition — opacity varies across instances (non-vacuous colour compare)`, opacities.size > 10,
    `${opacities.size} distinct`);
  check(`${tag}: precondition — lazy slot growth happened`, lE._createdSlots > 9, `slots ${lE._createdSlots}`);
  check(`${tag}: instance buffers identical across 30 ticks`, mismatches.length === 0, mismatches.slice(0, 4).join("; "));
  if (fx) {
    const anyFx = Object.values(legacySnaps[29]).some((s) => s.fx);
    check(`${tag}: precondition — the buckets really are FX buckets`, anyFx);
  } else {
    carrierArm = { legacy, carrier };
  }
}
FX.setParticleFxFlag(false);

// ---------------------------------------------------------------------------
console.log("-- S2 carrier arm: one shared carrier, zero slot clones ----------------");
const { legacy, carrier } = carrierArm;
{
  const slots = [...slotsOf(carrier.mgr, carrier.idAdd), ...slotsOf(carrier.mgr, carrier.idAlpha)];
  const mats = new Set(slots.map((m) => m.material));
  check("every built slot of both instanced emitters shares ONE material", slots.length > 18 && mats.size === 1,
    `${slots.length} slots, ${mats.size} materials`);
  const carrierMat = slots[0].material;
  check("...and it is the slot carrier", _isSlotCarrier(carrierMat) && carrierMat.visible === false);
  check("the carrier is never written: opacity still its default", carrierMat.opacity === 1);
  const d = carrier.mgr.instancingDiag();
  check("instancingDiag: every slot a carrier, no slot material", d.slotCarriers === slots.length && d.slotMaterials === 0,
    JSON.stringify({ slotCarriers: d.slotCarriers, slotMaterials: d.slotMaterials }));
  const buckets = carrier.mgr._instBuckets.size;
  check("base.clone() called only for the bucket materials (0 slot clones)", carrier.bases.clones.n === buckets,
    `${carrier.bases.clones.n} clones, ${buckets} buckets`);
  const dl = legacy.mgr.instancingDiag();
  check("legacy arm (contrast): one clone per slot plus the buckets",
    dl.slotCarriers === 0 && dl.slotMaterials > 18 && legacy.bases.clones.n === dl.slotMaterials + legacy.mgr._instBuckets.size,
    `${legacy.bases.clones.n} clones, ${dl.slotMaterials} slots`);
  const live = slots.filter((m) => m.visible);
  check("live carrier slots carry their opacity in userData.__op",
    live.length > 0 && live.every((m) => typeof m.userData.__op === "number" && m.userData.__op >= 0 && m.userData.__op <= 1),
    `${live.length} live`);
  check("carrier slot meshes stay off the scene graph", slots.every((m) => m.parent === null));
  const baseSnapNow = [carrier.bases.snap(carrier.bases.add), carrier.bases.snap(carrier.bases.alpha)];
  // A fresh pair of bases built the same way, never handed to a manager.
  const pristine = makeBases();
  const strip = (s) => { const a = JSON.parse(s); a[0] = "uuid"; return JSON.stringify(a); };
  check("cache base materials untouched (opacity, blending, fog, version, userData)",
    strip(baseSnapNow[0]) === strip(pristine.snap(pristine.add)) && strip(baseSnapNow[1]) === strip(pristine.snap(pristine.alpha)),
    `${baseSnapNow[0]} | ${baseSnapNow[1]}`);
  check("bucket materials still come from the cache base (alpha bucket keeps the base texture)",
    [...carrier.mgr._instBuckets.values()].every((b) => b.im.material.map === tex));
}

// ---------------------------------------------------------------------------
console.log("-- S3 runtime toggle OFF / ON ------------------------------------------");
{
  const { mgr, group, bases, idAdd, idAlpha } = carrier;
  const eAdd = mgr.particleTable.get(idAdd), eAlpha = mgr.particleTable.get(idAlpha);
  const opBefore = new Map();
  for (const e of [eAdd, eAlpha]) for (const m of e.partStorage) if (m && m.userData.__op !== undefined) opBefore.set(m, m.userData.__op);
  const liveBefore = [eAdd, eAlpha].flatMap((e) => e.parts.filter(Boolean));
  const r = mgr.setInstancing(false);
  check("toggle OFF flipped both emitters", r.flipped === 2 && r.instEmitters === 0, JSON.stringify({ flipped: r.flipped }));
  const addSlots = eAdd.partStorage.filter(Boolean), alphaSlots = eAlpha.partStorage.filter(Boolean);
  const all = [...addSlots, ...alphaSlots];
  check("OFF: no slot holds the carrier", all.every((m) => !_isSlotCarrier(m.material)));
  check("OFF: every slot has a DISTINCT clone", new Set(all.map((m) => m.material)).size === all.length, `${all.length} slots`);
  check("OFF: clones are __disposable, not cache-owned, pool-keyed",
    all.every((m) => m.material.userData.__disposable === true && m.material.userData.__cacheOwned === false &&
      typeof m.material.userData.__poolKey === "string"));
  check("OFF: each clone's opacity = its slot's userData.__op",
    [...opBefore].every(([m, op]) => m.material.opacity === op), `${opBefore.size} slots with an opacity`);
  check("OFF: additive branch — AdditiveBlending, depthWrite off, forceSinglePass, unfogged (retail)",
    addSlots.every((m) => m.material.blending === THREE.AdditiveBlending && m.material.depthWrite === false &&
      m.material.forceSinglePass === true && m.material.fog === false));
  check("OFF: alpha branch — NormalBlending, alphaTest 0.1, depthWrite on, forceSinglePass",
    alphaSlots.every((m) => m.material.blending === THREE.NormalBlending && m.material.alphaTest === 0.1 &&
      m.material.depthWrite === true && m.material.forceSinglePass === true));
  check("OFF: live meshes rejoined the scene", liveBefore.length > 0 && liveBefore.every((m) => m.parent === group),
    `${liveBefore.length} live`);
  check("OFF: buckets dropped", mgr._instBuckets.size === 0);
  check("OFF: later lazy grows clone (carrier mode cleared)", eAdd._slotCarrier === false && eAlpha._slotCarrier === false);
  // the per-mesh path keeps writing the material's opacity
  for (let i = 0; i < 3; i += 1) { t += 0.05; mgr.tick(); await flush(); }
  const liveNow = [eAdd, eAlpha].flatMap((e) => e.parts.filter(Boolean)).filter((m) => m.visible);
  check("per-mesh ticks: material.opacity tracks userData.__op on every live slot",
    liveNow.length > 0 && liveNow.every((m) => m.material.opacity === m.userData.__op && m.parent === group),
    `${liveNow.length} live`);
  check("per-mesh ticks: no bucket rebuilt", mgr._instBuckets.size === 0);

  const clonesBefore = new Set(all.map((m) => m.material));
  const r2 = mgr.setInstancing(true);
  check("toggle ON flipped both back", r2.flipped === 2 && r2.instEmitters === 2);
  check("ON: _instAlpha from the stored blend class (additive → false, alpha → true)",
    eAdd._instAlpha === false && eAlpha._instAlpha === true);
  check("ON: _instBaseMat is the cache base, not a slot material",
    eAdd._instBaseMat === bases.add && eAlpha._instBaseMat === bases.alpha);
  const allOn = [...eAdd.partStorage, ...eAlpha.partStorage].filter(Boolean);
  check("ON: slots back on the carrier", allOn.every((m) => _isSlotCarrier(m.material)));
  const pooled = new Set();
  for (const arr of mgr._materialPool.values()) for (const m of arr) pooled.add(m);
  check("ON: their clones parked in the per-slot pool", [...clonesBefore].every((m) => pooled.has(m)),
    `${[...clonesBefore].filter((m) => pooled.has(m)).length}/${clonesBefore.size}`);
  check("ON: slot meshes pulled from the scene", allOn.every((m) => m.parent === null));
  for (let i = 0; i < 2; i += 1) { t += 0.05; mgr.tick(); await flush(); }
  const names = [...mgr._instBuckets.values()].map((b) => b.im.name).sort();
  check("ON: buckets rebuilt with the right blend keys",
    names.join(",") === [`particle-inst-0x${GFX_ADD.toString(16)}`, `particle-inst-0x${GFX_ALPHA.toString(16)}-a`].sort().join(","),
    names.join(","));
  check("ON: buckets drew", [...mgr._instBuckets.values()].every((b) => b.im.count > 0));
}

// ---------------------------------------------------------------------------
console.log("-- S4 bucket-attach failure fallback --------------------------------------");
{
  setParticleSlotCarrierFlag(true);
  const bases = makeBases();
  const group = new THREE.Group();
  const anchor = new THREE.Object3D(); anchor.position.set(0, 0, -10);
  group.add(anchor);
  const mgr = new ParticleManager({
    scene: group, instancing: true,
    geometryFactory: () => noPosGeom,
    materialFactory: () => bases.add,
  });
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => { warned.push(a.join(" ")); };
  const id = await mgr.addEmitter({
    emitterInfo: info(GFX_ADD, { maxParticles: 24, initialParticles: 2, lifespan: 50, lifespanRand: 0, birthrate: 0.001 }),
    parent: anchor,
  });
  console.warn = warn;
  const e = mgr.particleTable.get(id);
  check("precondition: the attach failed and fell back", e && e._instKey === null &&
    warned.some((w) => w.includes("bucket attach failed")), warned.join(" | "));
  const built = e.partStorage.filter(Boolean);
  check("fallback: every built slot has its own clone", built.length > 0 && built.every((m) => !_isSlotCarrier(m.material)) &&
    new Set(built.map((m) => m.material)).size === built.length, `${built.length} slots`);
  const live = e.parts.filter(Boolean);
  check("fallback: the t=0 burst's clones carry the live opacity",
    live.length === 2 && live.every((m) => m.material.opacity === m.userData.__op), `${live.length} live`);
  check("fallback: carrier mode cleared", e._slotCarrier === false);
  const builtBefore = e._createdSlots;
  for (let i = 0; i < 12; i += 1) { t += 0.05; mgr.tick(); await flush(); }
  const grown = e.partStorage.slice(builtBefore).filter(Boolean);
  check("fallback: a lazy grow AFTER the fallback clones (never the carrier)",
    grown.length > 0 && grown.every((m) => !_isSlotCarrier(m.material) && m.material.userData.__disposable === true),
    `${grown.length} grown slots`);
  check("fallback: newly emitted particles join the scene with a real material",
    e.parts.filter(Boolean).some((m) => m.parent === group && !_isSlotCarrier(m.material)));
  mgr.destroyParticleEmitter(id);
}

// ---------------------------------------------------------------------------
console.log("-- S5 the carrier is nobody's to free; instancing:false never uses it ------");
{
  setParticleSlotCarrierFlag(true);
  const bases = makeBases();
  const group = new THREE.Group();
  const anchor = new THREE.Object3D(); anchor.position.set(0, 0, -10);
  group.add(anchor);
  const mk = (instancing) => new ParticleManager({
    scene: group, instancing, geometryFactory: () => quad, materialFactory: (hw) => bases.map.get(hw >>> 0),
  });
  const mgr = mk(true);
  const id = await mgr.addEmitter({ emitterInfo: info(GFX_ADD), parent: anchor });
  for (let i = 0; i < 4; i += 1) { t += 0.05; mgr.tick(); await flush(); }
  const carrierMat = slotsOf(mgr, id)[0].material;
  check("precondition: instanced slots hold the carrier", _isSlotCarrier(carrierMat));
  let disposed = 0;
  carrierMat.addEventListener("dispose", () => { disposed += 1; });
  const v0 = carrierMat.version, fog0 = carrierMat.fog;
  window.__additiveFogBlack("fade");
  const d = window.__additiveFogBlack("retail");
  check("additive fog walk never touches the carrier", carrierMat.version === v0 && carrierMat.fog === fog0, JSON.stringify(d));
  mgr.destroyParticleEmitter(id);
  const pooled = [...mgr._materialPool.values()].some((a) => a.includes(carrierMat));
  check("teardown: the carrier is neither disposed nor pooled", disposed === 0 && !pooled);
  mgr._reclaimSlotMaterial(carrierMat);
  check("_reclaimSlotMaterial(carrier) is a no-op", disposed === 0 &&
    ![...mgr._materialPool.values()].some((a) => a.includes(carrierMat)));
  // an emitter that auto-finishes (tick() teardown) takes the same path
  const id2 = await mgr.addEmitter({
    emitterInfo: info(GFX_ADD, { totalSeconds: 0, totalParticles: 2, initialParticles: 2, lifespan: 0.05, lifespanRand: 0 }),
    parent: anchor,
  });
  for (let i = 0; i < 10 && mgr.particleTable.has(id2); i += 1) { t += 0.05; mgr.tick(); await flush(); }
  check("auto-finish teardown: carrier still alive and unpooled", !mgr.particleTable.has(id2) && disposed === 0 &&
    ![...mgr._materialPool.values()].some((a) => a.includes(carrierMat)));

  // `?particleInstancing=off` analogue: the per-mesh path clones as always.
  const mgrOff = mk(false);
  const idOff = await mgrOff.addEmitter({ emitterInfo: info(GFX_ADD), parent: anchor });
  for (let i = 0; i < 4; i += 1) { t += 0.05; mgrOff.tick(); await flush(); }
  const offSlots = slotsOf(mgrOff, idOff);
  check("instancing:false: no carrier, one clone per slot",
    offSlots.length > 0 && offSlots.every((m) => !_isSlotCarrier(m.material)) &&
      new Set(offSlots.map((m) => m.material)).size === offSlots.length);
  const offLive = offSlots.filter((m) => m.visible);
  check("instancing:false: live meshes in the scene, material.opacity written as before",
    offLive.length > 0 && offLive.every((m) => m.parent === group && m.material.opacity === m.userData.__op));
  mgrOff.destroyParticleEmitter(idOff);

  // `?particleSlotCarrier=off`: the instanced path clones per slot again.
  setParticleSlotCarrierFlag(false);
  const idEsc = await mgr.addEmitter({ emitterInfo: info(GFX_ALPHA), parent: anchor });
  const escSlots = slotsOf(mgr, idEsc);
  check("?particleSlotCarrier=off: instanced emitter, a clone per slot",
    mgr.particleTable.get(idEsc)._instKey != null && escSlots.every((m) => !_isSlotCarrier(m.material)) &&
      new Set(escSlots.map((m) => m.material)).size === escSlots.length);
  mgr.destroyParticleEmitter(idEsc);
  setParticleSlotCarrierFlag(true);
}

// ---------------------------------------------------------------------------
console.log("-- S6 setTranslucency + flag reader ----------------------------------------");
{
  const fakeCarrier = new THREE.MeshBasicMaterial({ visible: false });
  fakeCarrier.userData = { __slotCarrier: true };
  const mc = new THREE.Mesh(quad, fakeCarrier);
  setTranslucency(mc, 0.25);
  check("carrier mesh: __op = 1 - t, carrier opacity untouched, visible",
    mc.userData.__op === 0.75 && fakeCarrier.opacity === 1 && mc.visible === true);
  setTranslucency(mc, 1.0);
  check("carrier mesh: t >= 1 ⇒ __op 0, NoDraw (visible false)", mc.userData.__op === 0 && mc.visible === false && fakeCarrier.opacity === 1);
  const mm = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ transparent: true }));
  setTranslucency(mm, 0.7);
  check("normal mesh: material.opacity AND __op = 1 - t (bit-identical)",
    mm.material.opacity === mm.userData.__op && Math.abs(mm.material.opacity - 0.3) < 1e-12 && mm.visible === true);
  setTranslucency(mm, 1.5);
  check("normal mesh: t >= 1 ⇒ opacity 0, NoDraw", mm.material.opacity === 0 && mm.userData.__op === 0 && mm.visible === false);
  const pojo = { material: { opacity: 1 }, visible: false };
  setTranslucency(pojo, 0.5);
  check("plain-object mesh (no userData) still works", pojo.material.opacity === 0.5 && pojo.visible === true);

  const reads = {};
  for (const v of ["", "?particleSlotCarrier=on", "?particleSlotCarrier=1", "?particleSlotCarrier=garbage",
    "?particleSlotCarrier=off", "?particleSlotCarrier=0", "?particleSlotCarrier=false", "?particleSlotCarrier=NO"]) {
    globalThis.location.search = v;
    setParticleSlotCarrierFlag(null);
    reads[v || "(absent)"] = particleSlotCarrierEnabled();
  }
  check("flag: absent / on / garbage ⇒ ON (default)",
    reads["(absent)"] && reads["?particleSlotCarrier=on"] && reads["?particleSlotCarrier=1"] && reads["?particleSlotCarrier=garbage"],
    JSON.stringify(reads));
  check("flag: off / 0 / false / no ⇒ OFF",
    !reads["?particleSlotCarrier=off"] && !reads["?particleSlotCarrier=0"] && !reads["?particleSlotCarrier=false"] &&
      !reads["?particleSlotCarrier=NO"], JSON.stringify(reads));
  globalThis.location.search = "";
  setParticleSlotCarrierFlag(null);
}

setCurrentTime(null);
setRng(null);
FX.setParticleFxFlag(null);
console.log(`\nparticle slot carriers: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
