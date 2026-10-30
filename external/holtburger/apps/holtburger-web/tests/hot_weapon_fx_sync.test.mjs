// tests/hot_weapon_fx_sync.test.mjs — lane F2 (2026-10-26): `?hotWeaponFxSync`,
// the generated straight-line surface-field mirror in scene3d/vfx/weapon_fx.js
// `_syncDelta` (lane F's hotMatVariant trick on a fixed key list).
//
// CLAIM: with the flag on, every weapon clone material and its snapshot hold
// exactly what the shipped keyed loop leaves (Object.is per field, the colour /
// emissive components, `version` — needsUpdate and the alphaTest accessor bump
// it), after every sync, over base materials of five classes; an own accessor
// on a base is read the same number of times; a non-writable target throws in
// both (strict like the module); and the generated body is the shipped
// statement per MATERIAL_SURFACE_FIELDS key in the same order.
//
// HOW: two instances of weapon_fx.js (distinct import URLs): REF with the flag
// forced off, GEN forced on. [1] drives `_syncDelta` directly on paired records;
// [2] drives real weapons (weaponFxBegin / weaponFxMaterial / tickWeaponFx) whose
// base materials change live (texture re-seats, fades, blending, alphaTest,
// colours), and compares every clone after every tick.
//
// Run:   cd apps/holtburger-web && node tests/hot_weapon_fx_sync.test.mjs
// Bench: node tests/hot_weapon_fx_sync.test.mjs --bench=off   (then --bench=on; one arm per process)

import * as THREE from "three";

globalThis.window = globalThis.window || { location: { search: "" }, addEventListener: () => {}, removeEventListener: () => {} };

const P = new URL("../scene3d/vfx/weapon_fx.js", import.meta.url).href;
const REF = await import(P + "?ref");
const GEN = await import(P + "?gen");
REF.__setHotWeaponFxSyncForTest(false);
GEN.__setHotWeaponFxSyncForTest(true);
const { MaterialCache, VFX_GLOBALS, MATERIAL_SURFACE_FIELDS } = await import("../scene3d/materials.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

const TEX = Array.from({ length: 6 }, () => new THREE.Texture());
const CLASSES = [THREE.MeshStandardMaterial, THREE.MeshLambertMaterial, THREE.MeshBasicMaterial, THREE.MeshPhongMaterial, THREE.MeshPhysicalMaterial];

function matDiff(a, b) {
  for (const k of MATERIAL_SURFACE_FIELDS) if (!Object.is(a[k], b[k])) return `${k}: ${String(a[k])} vs ${String(b[k])}`;
  for (const c of ["color", "emissive"]) {
    const x = a[c], y = b[c];
    if (!!x !== !!y) return `${c} presence`;
    if (x && (!Object.is(x.r, y.r) || !Object.is(x.g, y.g) || !Object.is(x.b, y.b))) return `${c} differs`;
  }
  if (a.version !== b.version) return `version ${a.version} vs ${b.version}`;
  return null;
}
function snapDiff(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.join() !== kb.join()) return "snap keys";
  for (const k of ka) if (!Object.is(a[k], b[k])) return `snap ${k}: ${String(a[k])} vs ${String(b[k])}`;
  return null;
}
// one live change to a base material (decided once, applied to both worlds)
function mutate(base, r, texOf) {
  const x = r();
  if (x < 0.15) base.map = texOf((r() * TEX.length) | 0);
  else if (x < 0.25) base.opacity = r() < 0.2 ? -0 : r();
  else if (x < 0.32) base.transparent = !base.transparent;
  else if (x < 0.38) base.alphaTest = r() < 0.5 ? 0 : 0.5;             // accessor: bumps version across 0
  else if (x < 0.43) base.blending = (r() * 5) | 0;
  else if (x < 0.48) base.depthWrite = !base.depthWrite;
  else if (x < 0.52) base.emissiveIntensity = r() * 3;
  else if (x < 0.56) base.normalMap = r() < 0.5 ? null : texOf((r() * TEX.length) | 0);
  else if (x < 0.6) base.fog = !base.fog;
  else if (x < 0.64) { base.roughness = r(); base.metalness = r() < 0.1 ? NaN : r(); }
  else if (x < 0.68) base.color.setRGB(r(), r(), r());
  else if (x < 0.71) base.emissive?.setRGB(r(), 0, r());
  else if (x < 0.73) base.forceSinglePass = !base.forceSinglePass;
  else if (x < 0.75) { base.blendSrc = 200 + ((r() * 10) | 0); base.blendEquation = 100 + ((r() * 4) | 0); }
  // else: no change this frame (the common case)
}

// ── [1] _syncDelta on paired records ─────────────────────────────────────────
let readsA = 0, readsB = 0;
function makeRecs(seed, which) {
  const r = rng(seed);
  const recs = [];
  for (let i = 0; i < 90; i++) {
    const C = CLASSES[(r() * CLASSES.length) | 0];
    const base = new C({ map: TEX[(r() * TEX.length) | 0] });
    if (r() < 0.3) { base.transparent = true; base.opacity = r(); }
    if (r() < 0.2) base.userData.extra = i;                            // shape variety (hidden classes)
    if (i % 17 === 3) {                                                // an own accessor the mirror reads
      let op = base.opacity;
      Object.defineProperty(base, "opacity", { configurable: true, enumerable: true,
        get() { if (which === "A") readsA += 1; else readsB += 1; return op; }, set(v) { op = v; } });
    }
    const mat = base.clone();
    const rec = { did: i, mat, base, snap: (which === "A" ? REF : GEN).__snapForTest(base), cacheBase: false };
    recs.push(rec);
  }
  return recs;
}
check("[1] _syncDelta: generated mirror leaves every clone and snapshot identical (90 records x 1,500 syncs)", () => {
  const A = makeRecs(5, "A"), B = makeRecs(5, "B");
  const ra = rng(11), rb = rng(11);
  let compared = 0;
  for (let f = 0; f < 1500; f++) {
    for (let i = 0; i < A.length; i++) {
      mutate(A[i].base, ra, (k) => TEX[k]);
      mutate(B[i].base, rb, (k) => TEX[k]);
      REF.__syncDeltaForTest(A[i]);
      GEN.__syncDeltaForTest(B[i]);
      const d = matDiff(A[i].mat, B[i].mat) || snapDiff(A[i].snap, B[i].snap);
      if (d) throw new Error(`frame ${f} rec ${i}: ${d}`);
      compared += 1;
    }
  }
  assert(readsA === readsB && readsA > 0, `accessor reads ${readsA} vs ${readsB}`);
  assert(compared === 135000, `compared ${compared}`);
});

check("[2] the generated body is the shipped statement per key, in MATERIAL_SURFACE_FIELDS order, strict", () => {
  const src = GEN.__weaponFxSyncSourceForTest();
  assert(src && src.includes('"use strict"'), "not strict");
  let at = -1;
  for (const k of MATERIAL_SURFACE_FIELDS) {
    const i = src.indexOf(`x = b.${k}; if (x !== s.${k}) { m.${k} = x; s.${k} = x;`);
    assert(i > at, `statement for ${k} missing or out of order`);
    at = i;
  }
  const prog = ["map", "normalMap", "emissiveMap", "roughnessMap", "aoMap", "transparent", "alphaTest", "blending", "fog", "forceSinglePass"];
  for (const k of MATERIAL_SURFACE_FIELDS) {
    const line = src.split("\n").find((l) => l.startsWith(`x = b.${k};`));
    assert(line.includes("prog = true") === prog.includes(k), `prog flag for ${k}`);
  }
});

check("[3] a non-writable target field throws in both (strict, like the module)", () => {
  const mk = () => {
    const base = new THREE.MeshBasicMaterial({ map: TEX[0] });
    const mat = base.clone();
    Object.defineProperty(mat, "opacity", { value: 1, writable: false, configurable: true });
    return { mat, base };
  };
  const a = mk(), b = mk();
  a.snap = REF.__snapForTest(a.base); b.snap = GEN.__snapForTest(b.base);
  a.base.opacity = 0.5; b.base.opacity = 0.5;
  let ta = null, tb = null;
  try { REF.__syncDeltaForTest(a); } catch (e) { ta = e.constructor.name; }
  try { GEN.__syncDeltaForTest(b); } catch (e) { tb = e.constructor.name; }
  assert(ta === "TypeError" && tb === "TypeError", `${ta} vs ${tb}`);
  assert(a.mat.map === b.mat.map && a.snap.opacity === b.snap.opacity, "partial writes differ");
});

// ── [4] real weapons through tickWeaponFx ────────────────────────────────────
function spearPartGroups(did) {
  const geo = new THREE.CylinderGeometry(0.03, 0.03, 2.0, 8, 4);
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, 0.4);
  return [{ groups: [{ geometry: geo, surfaceDid: did }], surfaceDids: [did] }];
}
function makeArsenal(M, n, seed) {
  const csmState = { uniforms: Object.fromEntries(["uCsmShadowMap0", "uCsmShadowMap1", "uCsmShadowMap2", "uCsmMatrix0", "uCsmMatrix1", "uCsmMatrix2", "uCsmSplits", "uCsmFar", "uCsmBlend"].map((k) => [k, { value: null }])) };
  const mc = new MaterialCache({ csmState });
  const r = rng(seed);
  const entities = new Map();
  const weapons = [];
  M._resetWeaponFxForTest();
  for (let i = 0; i < n; i++) {
    const did = 0x08000100 + i;
    const inst = { guid: 0x80000a00 + i, root: new THREE.Group(), parts: [new THREE.Group()], _attachedParentGuid: null };
    inst.root.add(inst.parts[0]);
    const pg = spearPartGroups(did);
    const st = M.weaponFxBegin({ inst, guid: inst.guid, name: i % 3 ? "Atlan Spear" : "Long Sword", uiEffects: [0x20, 0x80, 0x1, 0][i % 4],
      archetype: i % 3 ? "tip-flex" : "rigid-glint", partGroups: pg, materialCache: mc, nowMs: 0 });
    const C = CLASSES[(r() * CLASSES.length) | 0];
    const base = new C({ map: TEX[(r() * TEX.length) | 0] });
    base.userData = { __cacheOwned: true };
    if (i % 2) mc.materials.set(did, base);                             // a cache base (adoption path) or a paletted one
    const mat = M.weaponFxMaterial(st, did, base);
    const mesh = new THREE.Mesh(pg[0].groups[0].geometry, mat);
    mesh.userData = { surfaceDid: did };
    inst.parts[0].add(mesh);
    inst._wfx = st;
    M.weaponFxCommit(st);
    entities.set(inst.guid, inst);
    weapons.push({ st, base, did, mc, mesh, inst });
  }
  const scene3d = { entityManager: { entityMap: entities }, renderer: { toneMappingExposure: 5 }, camera: new THREE.PerspectiveCamera() };
  return { weapons, scene3d };
}
check("[4] tickWeaponFx: 40 weapons, live base changes, every clone identical after every tick (600 ticks)", () => {
  const WA = makeArsenal(REF, 40, 3);
  const WB = makeArsenal(GEN, 40, 3);
  const ra = rng(21), rb = rng(21);
  let t = 0, compared = 0;
  for (let f = 0; f < 600; f++) {
    t += 1000 / 60;
    VFX_GLOBALS.uTime.value = t / 1000;
    for (let i = 0; i < WA.weapons.length; i++) {
      mutate(WA.weapons[i].base, ra, (k) => TEX[k]);
      mutate(WB.weapons[i].base, rb, (k) => TEX[k]);
    }
    if (f % 97 === 50) {                                                 // a cache base replaced (late texture): adoption
      for (const W of [WA, WB]) {
        const w = W.weapons[1];
        const nb = new THREE.MeshStandardMaterial({ map: TEX[5], opacity: 0.25, transparent: true });
        nb.userData = { __cacheOwned: true };
        w.mc.materials.set(w.did, nb);
        w.base = nb;
      }
    }
    REF.tickWeaponFx(WA.scene3d, t);
    GEN.tickWeaponFx(WB.scene3d, t);
    for (let i = 0; i < WA.weapons.length; i++) {
      const ma = WA.weapons[i].mesh.material, mb = WB.weapons[i].mesh.material;
      const d = matDiff(ma, mb);
      if (d) throw new Error(`tick ${f} weapon ${i}: ${d}`);
      const sa = WA.weapons[i].st.mats.get(WA.weapons[i].did), sb = WB.weapons[i].st.mats.get(WB.weapons[i].did);
      const ds = snapDiff(sa.snap, sb.snap);
      if (ds) throw new Error(`tick ${f} weapon ${i}: ${ds}`);
      compared += 1;
    }
  }
  assert(compared === 24000, `compared ${compared}`);
});

{
  const { __setRustFlagForTest, rustFlag } = await import("../scene3d/rust/scene_core.js");
  __setRustFlagForTest("hotWeaponFxSync", undefined);
  check("[5] ?hotWeaponFxSync defaults OFF (rustFlag reader, no query)", () => assert(rustFlag("hotWeaponFxSync", false) === false, "default must be off"));
}

// ── bench: one arm per process ───────────────────────────────────────────────
const BENCH_ARM = (process.argv.find((a) => a.startsWith("--bench=")) || "").slice(8);
if (BENCH_ARM) {
  const M = BENCH_ARM === "on" ? GEN : REF;
  const recs = makeRecs(9, BENCH_ARM === "on" ? "B" : "A").slice(0, 80);
  const r = rng(4);
  const step = () => { for (let i = 0; i < recs.length; i++) { if (r() < 0.05) mutate(recs[i].base, r, (k) => TEX[k]); M.__syncDeltaForTest(recs[i]); } };
  for (let i = 0; i < 3000; i++) step();
  let best = Infinity;
  for (let round = 0; round < 5; round++) {
    const N = 3000, t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) step();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / N / 1000);
  }
  const { weapons, scene3d } = makeArsenal(M, 40, 3);
  let t = 0;
  const tick = () => { t += 16.7; VFX_GLOBALS.uTime.value = t / 1000; for (let i = 0; i < weapons.length; i++) if (r() < 0.05) mutate(weapons[i].base, r, (k) => TEX[k]); M.tickWeaponFx(scene3d, t); };
  for (let i = 0; i < 2000; i++) tick();
  let bestTick = Infinity;
  for (let round = 0; round < 5; round++) {
    const N = 2000, t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) tick();
    bestTick = Math.min(bestTick, Number(process.hrtime.bigint() - t0) / N / 1000);
  }
  console.log(`  bench ${BENCH_ARM === "on" ? "?hotWeaponFxSync=on" : "shipped           "}: _syncDelta ${best.toFixed(2)} us per 80 records, tickWeaponFx ${bestTick.toFixed(2)} us per 40 weapons`);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
