// tests/luminous_night_clone.test.mjs
//
// 2026-10-13 `?lumCloneAdopt` (DEFAULT ON; `off/0/false/no` escape).
// `?lumNight` dims ambient-like Surface luminosity at night by rewriting
// `emissiveIntensity` on every TRACKED material (luminous_night.js). Only the
// cache material was tracked. entities.js `_getOrCloneEntityMaterial` clones it
// whenever an entity needs a private material (object translucency,
// Transparent / Luminous / Diffuse hooks, TextureVelocity, the camera fade);
// three's Material.copy JSON-copies userData, so the clone carried `hbLumBase`,
// `registerLuminousMaterial` refused it, and its glow froze at whatever scale
// was live at clone time (noon clone = full glow all night, night clone = dim
// all day).
//
//   C1  flag parsing: absent/on/garbage -> on, off-forms -> off.
//   C2  the verifier's plan: register, clone (REAL three clone), adopt twice
//       (idempotent: tracked === 2), scale 0.25 -> both read 0.125; a clone
//       whose hbLumBase was deleted, a light source's clone, a non-luminous
//       clone and the registered original itself are all ignored.
//   C3  a clone made at night takes the day value back; `?lumCloneAdopt=off`
//       touches nothing (the pre-change freeze, byte-identical).
//   C4  releaseLuminousMaterial: the Luminous hook's raw 1.0 survives the next
//       scale change; the escape keeps today's behaviour.
//   C5  the REAL `_getOrCloneEntityMaterial` / `_applyRampValueToMaterial`
//       bodies (spliced from entities.js): plain clone, paletted __cacheOwned
//       upgrade, Luminous hook release, and the escape through the getter.
//   C6  wiring: both clone sites adopt, the hook releases before its write.
//
// Fails on the pre-change code: adoptLuminousClone / releaseLuminousMaterial
// do not exist, and a clone keeps its clone-time emissiveIntensity.
//
// Run: node tests/luminous_night_clone.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const src = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

const L = await import("../scene3d/luminous_night.js");
const tracked = () => L.luminousNightState().tracked;
// Every material stays strongly reachable for the whole run so a GC between
// two `tracked` reads cannot change the count under us.
const keep = [];
const lumMat = (ei, extra = {}) => {
  const m = new THREE.MeshStandardMaterial({ emissive: 0xffffff, emissiveIntensity: ei });
  m.userData = { ...extra };
  keep.push(m);
  return m;
};
const cloneOf = (m) => { const c = m.clone(); keep.push(c); return c; };

// ---------------------------------------------------------------------------
console.log("\n-- C1 flag ----------------------------------------------------");
{
  check("absent / empty -> on", L.lumCloneAdoptEnabled("") === true && L.lumCloneAdoptEnabled("?x=1") === true);
  check("=on / garbage -> on", L.lumCloneAdoptEnabled("?lumCloneAdopt=on") === true && L.lumCloneAdoptEnabled("?lumCloneAdopt=maybe") === true);
  check("off / 0 / false / no / OFF -> off",
    ["off", "0", "false", "no", "OFF"].every((v) => L.lumCloneAdoptEnabled(`?lumCloneAdopt=${v}`) === false));
  check("node default (no window) -> on", L.lumCloneAdoptEnabled() === true);
}

// ---------------------------------------------------------------------------
console.log("\n-- C2 register / clone / adopt -------------------------------");
{
  L.applyLuminousScale(1);
  const m = lumMat(0.5);
  check("registerLuminousMaterial(m, 0.5)", L.registerLuminousMaterial(m, 0.5) === true && tracked() === 1);
  const c = cloneOf(m);
  check("premise: three's clone copies hbLumBase into userData", c.userData.hbLumBase === 0.5 && c.userData !== m.userData);
  check("premise: so registerLuminousMaterial refuses the clone", L.registerLuminousMaterial(c, 0.5) === false && tracked() === 1);
  check("adoptLuminousClone(c) tracks it", L.adoptLuminousClone(c) === true && tracked() === 2);
  check("adopting again is a no-op (tracked === 2)", L.adoptLuminousClone(c) === false && tracked() === 2);
  check("adopting the registered original is a no-op", L.adoptLuminousClone(m) === false && tracked() === 2);
  L.applyLuminousScale(0.25);
  check("scale 0.25: original reads 0.125", near(m.emissiveIntensity, 0.125), `got ${m.emissiveIntensity}`);
  check("scale 0.25: the clone follows (0.125)", near(c.emissiveIntensity, 0.125), `got ${c.emissiveIntensity}`);
  const stripped = cloneOf(m);
  delete stripped.userData.hbLumBase;
  const before = stripped.emissiveIntensity;
  check("a clone with hbLumBase deleted is ignored",
    L.adoptLuminousClone(stripped) === false && tracked() === 2 && stripped.emissiveIntensity === before);
  const brazier = lumMat(1.0);
  L.registerLuminousMaterial(brazier, 1.0);
  const bc = cloneOf(brazier);
  check("a light source's clone (no hbLumBase) is ignored and keeps its glow",
    L.adoptLuminousClone(bc) === false && bc.emissiveIntensity === 1.0 && tracked() === 2);
  const plain = new THREE.MeshStandardMaterial(); keep.push(plain);
  check("a non-luminous material is ignored", L.adoptLuminousClone(plain) === false && plain.emissiveIntensity === 1);
  check("null is ignored", L.adoptLuminousClone(null) === false && L.releaseLuminousMaterial(null) === false);
  L.applyLuminousScale(1);
  check("day: both back to 0.5", near(m.emissiveIntensity, 0.5) && near(c.emissiveIntensity, 0.5));
}

// ---------------------------------------------------------------------------
console.log("\n-- C3 night clone / escape -----------------------------------");
{
  const m = lumMat(0.235);
  L.registerLuminousMaterial(m, 0.235);
  L.applyLuminousScale(0.25);
  const n0 = tracked();
  const nightClone = cloneOf(m);
  check("a clone made at night copies the dimmed value", near(nightClone.emissiveIntensity, 0.235 * 0.25));
  check("...and adopting it keeps the live night value", L.adoptLuminousClone(nightClone) === true && near(nightClone.emissiveIntensity, 0.235 * 0.25));
  L.applyLuminousScale(1);
  check("day restores the clone to its authored 0.235 (was: dim all day)", near(nightClone.emissiveIntensity, 0.235), `got ${nightClone.emissiveIntensity}`);
  L.applyLuminousScale(0.25);
  const off = cloneOf(m);
  const offBefore = off.emissiveIntensity;
  const offUd = JSON.stringify(off.userData);
  check("?lumCloneAdopt=off: not adopted, nothing written",
    L.adoptLuminousClone(off, "?lumCloneAdopt=off") === false && off.emissiveIntensity === offBefore
    && JSON.stringify(off.userData) === offUd && tracked() === n0 + 1);
  L.applyLuminousScale(1);
  check("?lumCloneAdopt=off: the clone keeps the pre-change freeze", off.emissiveIntensity === offBefore);
}

// ---------------------------------------------------------------------------
console.log("\n-- C4 release (Luminous hook owns the emissive) --------------");
{
  L.applyLuminousScale(1);
  const m = lumMat(0.5);
  L.registerLuminousMaterial(m, 0.5);
  const c = cloneOf(m);
  L.adoptLuminousClone(c);
  const n0 = tracked();
  check("escape: release is a no-op under ?lumCloneAdopt=off",
    L.releaseLuminousMaterial(c, "?lumCloneAdopt=off") === false && tracked() === n0 && c.userData.hbLumBase === 0.5);
  check("release drops the clone and its hbLumBase",
    L.releaseLuminousMaterial(c) === true && tracked() === n0 - 1 && c.userData.hbLumBase === undefined);
  c.emissiveIntensity = 1.0; // the hook's raw write
  L.applyLuminousScale(0.25);
  check("the hook's 1.0 survives the next scale change", c.emissiveIntensity === 1.0);
  check("...while the cache material still dims", near(m.emissiveIntensity, 0.125));
  check("a released material is never re-adopted", L.adoptLuminousClone(c) === false && c.emissiveIntensity === 1.0);
  check("releasing an untracked material is a no-op", L.releaseLuminousMaterial(c) === false);
  L.applyLuminousScale(1);
}

// ---------------------------------------------------------------------------
console.log("\n-- C5 the real entities.js bodies ----------------------------");
const ENT = src("scene3d/entities.js");
function method(name) {
  const m = new RegExp(`\\n  ${name}\\([^)]*\\) \\{\\n`).exec(ENT);
  if (!m) throw new Error(`entities.js: method ${name} not found`);
  const start = m.index + 1;
  const end = ENT.indexOf("\n  }\n", start);
  return ENT.slice(start, end + 4);
}
function managerClass(adopt) {
  return new Function(
    "weaponFxOwnedMaterial", "adoptLuminousClone", "releaseLuminousMaterial",
    `return class {\n${method("_getOrCloneEntityMaterial")}\n${method("_repointEntityMeshes")}\n${method("_applyRampValueToMaterial")}\n};`,
  )(() => null, adopt, L.releaseLuminousMaterial);
}
function rig(did, mat) {
  const part = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.userData.surfaceDid = did;
  part.add(mesh);
  return { inst: { parts: [part] }, mesh };
}
{
  const DID = 0x08000ab1;
  L.applyLuminousScale(1);
  const shared = lumMat(0.5, { __cacheOwned: true });
  L.registerLuminousMaterial(shared, 0.5);
  const fallback = new THREE.MeshStandardMaterial(); keep.push(fallback);
  const Mgr = managerClass(L.adoptLuminousClone);
  const mgr = new Mgr();
  mgr.materialCache = { getCached: (d) => (d === DID ? shared : null), fallbackMaterial: fallback };

  // (a) noon clone of a cache material (object translucency / camera fade).
  const a = rig(DID, shared);
  const n0 = tracked();
  const ca = mgr._getOrCloneEntityMaterial(a.inst, DID);
  keep.push(ca);
  check("getter clones the cache material and re-points the mesh",
    ca && ca !== shared && a.mesh.material === ca && ca.userData.__disposable === true && !ca.userData.__cacheOwned);
  check("...and the clone is tracked", tracked() === n0 + 1);
  check("a second request returns the same clone, still tracked once",
    mgr._getOrCloneEntityMaterial(a.inst, DID) === ca && tracked() === n0 + 1);
  L.applyLuminousScale(0.25);
  check("night: the noon clone dims with its peers (was: full glow all night)",
    near(ca.emissiveIntensity, 0.125) && near(shared.emissiveIntensity, 0.125), `got ${ca.emissiveIntensity}`);

  // (b) the paletted __cacheOwned upgrade, made at night.
  const pal = lumMat(0.5, { __cacheOwned: true, __paletteKey: "k" });
  L.registerLuminousMaterial(pal, 0.5);
  const b = rig(DID, pal);
  b.inst._entityMaterials = new Map([[DID, pal]]);
  const cb = mgr._getOrCloneEntityMaterial(b.inst, DID);
  keep.push(cb);
  check("paletted cache entry is upgraded to a private clone",
    cb !== pal && b.mesh.material === cb && !cb.userData.__cacheOwned && near(cb.emissiveIntensity, 0.125));
  L.applyLuminousScale(1);
  check("day: the night clone takes its authored 0.5 back (was: dim all day)", near(cb.emissiveIntensity, 0.5), `got ${cb.emissiveIntensity}`);
  check("...and the shared paletted material is untouched by the clone", pal.userData.__cacheOwned === true && near(pal.emissiveIntensity, 0.5));

  // (c) a Luminous(8) hook value on the tracked clone.
  const n1 = tracked();
  mgr._applyRampValueToMaterial(8, ca, 0.6);
  check("Luminous hook writes emissive = value at intensity 1.0",
    near(ca.emissive.r, 0.6) && ca.emissiveIntensity === 1.0);
  check("...and releases the clone from ?lumNight", tracked() === n1 - 1 && ca.userData.hbLumBase === undefined);
  L.applyLuminousScale(0.25);
  check("the next night-scale change leaves the hook's 1.0 alone", ca.emissiveIntensity === 1.0);
  check("...while the untouched clone still dims", near(cb.emissiveIntensity, 0.125));
  mgr._applyRampValueToMaterial(20, cb, 0.5);
  check("a Transparent hook does not release (opacity only)", tracked() === n1 - 1 && near(cb.opacity, 0.5));
  L.applyLuminousScale(1);

  // (d) the escape, through the real getter.
  const MgrOff = managerClass((m) => L.adoptLuminousClone(m, "?lumCloneAdopt=off"));
  const off = new MgrOff();
  off.materialCache = mgr.materialCache;
  L.applyLuminousScale(0.25);
  const d = rig(DID, shared);
  const n2 = tracked();
  const cd = off._getOrCloneEntityMaterial(d.inst, DID);
  keep.push(cd);
  check("?lumCloneAdopt=off: the clone is not tracked", tracked() === n2 && near(cd.emissiveIntensity, 0.125));
  L.applyLuminousScale(1);
  check("?lumCloneAdopt=off: it keeps the pre-change freeze", near(cd.emissiveIntensity, 0.125));
}

// ---------------------------------------------------------------------------
console.log("\n-- C6 wiring --------------------------------------------------");
{
  const getter = method("_getOrCloneEntityMaterial");
  check("entities.js imports adopt + release from luminous_night.js",
    /import \{[^}]*\badoptLuminousClone\b[^}]*\breleaseLuminousMaterial\b[^}]*\} from "\.\/luminous_night\.js"/.test(ENT));
  check("both clone sites in _getOrCloneEntityMaterial adopt the clone",
    (getter.match(/adoptLuminousClone\((owned|cloned)\)/g) || []).length === 2
    && getter.indexOf("adoptLuminousClone(owned)") > getter.indexOf("existing.clone()")
    && getter.indexOf("adoptLuminousClone(cloned)") > getter.indexOf("shared.clone()"));
  const ramp = method("_applyRampValueToMaterial");
  const rel = ramp.indexOf("releaseLuminousMaterial(material)");
  check("the Luminous hook releases before it writes emissiveIntensity = 1.0",
    rel > 0 && rel < ramp.indexOf("material.emissiveIntensity = 1.0"));
}

console.log(`\nluminous night clones: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
