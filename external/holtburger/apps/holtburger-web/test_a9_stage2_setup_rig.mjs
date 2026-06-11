// A9-Stage2 (2026-06-11 unification survey, Stage 2) — single JS
// rig-constructor module (`scene3d/setup_rig.js`).
//
// Survey: docs/2026-06-11-unification-survey/agents/A9-part-array-setup.md
// §3 divergence #2 (SPLIT-BRAIN, ~5 setup→scene construction sites) + §4
// Stage 2. Acceptance bar: **byte-identical transforms** vs the pre-
// extraction inline code, on a fixture setup.
//
// This test imports the three extracted pure functions and asserts each
// produces output IDENTICAL to a hand-written reference copy of the legacy
// inline code (the code that now lives only on the `?rigModule=off` branch
// of entities.js / buildings.js), driven by a minimal THREE fake — no
// browser, no three.js, no wasm.
//
//   PART 1 — applyRestPoseFrame: position triple + AC(qw,qx,qy,qz)→three
//            (qx,qy,qz,qw) quaternion reorder, for several fixture parts +
//            the hasRestPose=false identity case. Compared field-by-field
//            against the legacy `partGroup.position.set(...)` +
//            `quaternion.set(qx,qy,qz,qw)` block.
//   PART 2 — buildPartSurfaceMeshes: mesh name, userData, shadow gate,
//            child-add order, geometry-registration order — compared against
//            the legacy per-surface loop.
//   PART 3 — createPartFramesProxy: length, integer-index world-frame reads,
//            out-of-range/undefined, `in` (has) — compared against the
//            legacy inline Proxy.
//
// Run: cd apps/holtburger-web/ && node test_a9_stage2_setup_rig.mjs

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";
import {
  readRigModuleFlag,
  applyRestPoseFrame,
  buildPartSurfaceMeshes,
  createPartFramesProxy,
} from "./scene3d/setup_rig.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

// ---------------------------------------------------------------------
// Minimal THREE fake — only what the module touches. Matches three's
// observable semantics for the operations under test.
// ---------------------------------------------------------------------
class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
}
class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
}
class Group {
  constructor() {
    this.position = new Vec3();
    this.quaternion = new Quat();
    this.children = [];
    this.name = "";
    this.userData = undefined;
    this._worldUpdated = 0;
  }
  add(c) { this.children.push(c); }
  updateWorldMatrix() { this._worldUpdated += 1; }
  // For the Proxy test: "world" frame = local frame (root at identity).
  getWorldPosition(out) { return out.copy(this.position); }
  getWorldQuaternion(out) { return out.copy(this.quaternion); }
}
class Mesh {
  constructor(geometry, material) {
    this.geometry = geometry;
    this.material = material;
    this.name = "";
    this.userData = undefined;
    this.castShadow = false;
  }
}
const THREE = { Vector3: Vec3, Quaternion: Quat, Group, Mesh };

// ---------------------------------------------------------------------
// Legacy reference implementations — verbatim ports of the inline code
// that now lives on the `?rigModule=off` branches.
// ---------------------------------------------------------------------
function legacyApplyRestPose(partGroup, origins, orientations, p, hasRestPose) {
  if (hasRestPose) {
    partGroup.position.set(origins[p * 3 + 0], origins[p * 3 + 1], origins[p * 3 + 2]);
    const qw = orientations[p * 4 + 0];
    const qx = orientations[p * 4 + 1];
    const qy = orientations[p * 4 + 2];
    const qz = orientations[p * 4 + 3];
    partGroup.quaternion.set(qx, qy, qz, qw);
  }
}
function legacyBuildPartSurfaceMeshes(partGroup, conv, p, guid, resolveMaterial, castShadow, canCast, onGeom) {
  if (!conv) return;
  for (const g of conv.groups) {
    const did = g.surfaceDid >>> 0;
    const mat = resolveMaterial(g);
    const m = new THREE.Mesh(g.geometry, mat);
    m.name = `part_${p}_surface_${did.toString(16)}`;
    m.userData = { guid, partIndex: p, surfaceDid: did };
    if (castShadow) m.castShadow = canCast(mat);
    partGroup.add(m);
    onGeom(g.geometry);
  }
}
function legacyPartFramesProxy(parts) {
  const partFrameCache = [];
  return new Proxy([], {
    get(_t, prop) {
      if (prop === "length") return parts.length;
      const idx = typeof prop === "string" ? Number(prop) : NaN;
      if (!Number.isInteger(idx) || idx < 0 || idx >= parts.length) return undefined;
      const part = parts[idx];
      if (!part) return undefined;
      let frame = partFrameCache[idx];
      if (!frame) {
        frame = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
        partFrameCache[idx] = frame;
      }
      part.updateWorldMatrix(true, false);
      part.getWorldPosition(frame.position);
      part.getWorldQuaternion(frame.quaternion);
      return frame;
    },
    has(_t, prop) {
      const idx = typeof prop === "string" ? Number(prop) : NaN;
      return Number.isInteger(idx) && idx >= 0 && idx < parts.length;
    },
  });
}

const eqQuat = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;
const eqVec = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;

// =====================================================================
// PART 1 — applyRestPoseFrame transform equality on a fixture setup.
// =====================================================================
// Fixture: 3-part setup. Non-trivial origins + non-identity AC quats so
// the wire-order reorder is actually exercised (not a no-op identity).
const fixtureOrigins = new Float32Array([
  0.1, 0.2, 0.3,
  -1.5, 2.25, 0.0,
  4.0, -0.5, 3.14,
]);
const fixtureOrients = new Float32Array([
  // (qw, qx, qy, qz)
  0.70710678, 0.70710678, 0.0, 0.0,
  0.0, 0.0, 1.0, 0.0,
  0.5, 0.5, 0.5, 0.5,
]);
{
  let allMatch = true;
  for (let p = 0; p < 3; p += 1) {
    const a = new Group();
    const b = new Group();
    applyRestPoseFrame(THREE, a, fixtureOrigins, fixtureOrients, p, true);
    legacyApplyRestPose(b, fixtureOrigins, fixtureOrients, p, true);
    if (!eqVec(a.position, b.position) || !eqQuat(a.quaternion, b.quaternion)) {
      allMatch = false;
    }
  }
  check("PART1 applyRestPoseFrame ≡ legacy inline (3 fixture parts, position + AC→three quat)", allMatch);

  // Spot-check the actual reorder on part 0: AC (w=.707,x=.707,y=0,z=0)
  // → three (x=.707,y=0,z=0,w=.707).
  const a0 = new Group();
  applyRestPoseFrame(THREE, a0, fixtureOrigins, fixtureOrients, 0, true);
  check("PART1 quaternion reorder is AC(qw,qx,qy,qz)→three(qx,qy,qz,qw)",
    a0.quaternion.x === fixtureOrients[1] &&
    a0.quaternion.y === fixtureOrients[2] &&
    a0.quaternion.z === fixtureOrients[3] &&
    a0.quaternion.w === fixtureOrients[0]);

  // hasRestPose=false → identity (Group stays at construction defaults).
  const aId = new Group();
  const bId = new Group();
  applyRestPoseFrame(THREE, aId, fixtureOrigins, fixtureOrients, 0, false);
  legacyApplyRestPose(bId, fixtureOrigins, fixtureOrients, 0, false);
  check("PART1 hasRestPose=false leaves Group at identity (≡ legacy)",
    eqVec(aId.position, new Vec3(0, 0, 0)) &&
    eqQuat(aId.quaternion, new Quat(0, 0, 0, 1)) &&
    eqVec(aId.position, bId.position) && eqQuat(aId.quaternion, bId.quaternion));
}

// =====================================================================
// PART 2 — buildPartSurfaceMeshes equality on a fixture multi-surface part.
// =====================================================================
{
  const fixtureConv = {
    groups: [
      { geometry: { id: "geoA" }, surfaceDid: 0x05000abc, doubleSided: true },
      { geometry: { id: "geoB" }, surfaceDid: 0x0500ffff, doubleSided: false },
    ],
  };
  const guid = 0x80001234 >>> 0;
  // Deterministic material resolver keyed on did; shadow predicate keyed on
  // the resolved material so the gate is actually exercised both ways.
  const resolveMaterial = (g) => ({ matFor: g.surfaceDid >>> 0 });
  const canCast = (mat) => (mat.matFor & 0x1) === 0; // even did casts

  function run(builder) {
    const partGroup = new Group();
    const registered = [];
    builder(partGroup, (geo) => registered.push(geo));
    return {
      meshes: partGroup.children.map((m) => ({
        name: m.name,
        userData: m.userData,
        castShadow: m.castShadow,
        geometry: m.geometry,
        material: m.material,
      })),
      registered,
    };
  }

  const aOut = run((pg, onGeom) =>
    buildPartSurfaceMeshes(THREE, {
      partGroup: pg,
      conv: fixtureConv,
      partIndex: 2,
      guid,
      resolveMaterial,
      castShadow: true,
      materialCanCastShadow: canCast,
      onGeometry: onGeom,
    }));
  const bOut = run((pg, onGeom) =>
    legacyBuildPartSurfaceMeshes(pg, fixtureConv, 2, guid, resolveMaterial, true, canCast, onGeom));

  check("PART2 buildPartSurfaceMeshes ≡ legacy (names/userData/shadow/material/geometry + order)",
    JSON.stringify(aOut) === JSON.stringify(bOut));
  check("PART2 mesh names follow part_<p>_surface_<hex>",
    aOut.meshes[0].name === "part_2_surface_5000abc" &&
    aOut.meshes[1].name === "part_2_surface_500ffff");
  check("PART2 shadow gate honours the predicate (even did casts, odd does not)",
    aOut.meshes[0].castShadow === true && aOut.meshes[1].castShadow === false);
  check("PART2 geometry registered once per surface, in order",
    aOut.registered.length === 2 &&
    aOut.registered[0].id === "geoA" && aOut.registered[1].id === "geoB");

  // castShadow=false → no predicate calls, castShadow stays default false.
  const noShadow = run((pg, onGeom) =>
    buildPartSurfaceMeshes(THREE, {
      partGroup: pg, conv: fixtureConv, partIndex: 0, guid,
      resolveMaterial, castShadow: false, materialCanCastShadow: canCast, onGeometry: onGeom,
    }));
  check("PART2 castShadow=false leaves every mesh castShadow=false",
    noShadow.meshes.every((m) => m.castShadow === false));

  // null conv → no-op (matches `if (!conv) continue/return`).
  const nullConv = run((pg, onGeom) =>
    buildPartSurfaceMeshes(THREE, {
      partGroup: pg, conv: null, partIndex: 0, guid,
      resolveMaterial, castShadow: true, materialCanCastShadow: canCast, onGeometry: onGeom,
    }));
  check("PART2 null conv builds no meshes (≡ legacy guard)",
    nullConv.meshes.length === 0 && nullConv.registered.length === 0);
}

// =====================================================================
// PART 3 — createPartFramesProxy equality.
// =====================================================================
{
  function makeParts() {
    const p0 = new Group(); p0.position.set(1, 2, 3); p0.quaternion.set(0, 0, 0, 1);
    const p1 = new Group(); p1.position.set(-4, 5, 6); p1.quaternion.set(0.5, 0.5, 0.5, 0.5);
    return [p0, p1];
  }
  const newProxy = createPartFramesProxy(THREE, makeParts());
  const oldProxy = legacyPartFramesProxy(makeParts());

  check("PART3 length matches part count (new ≡ legacy)",
    newProxy.length === 2 && oldProxy.length === 2);

  let frameMatch = true;
  for (let i = 0; i < 2; i += 1) {
    const a = newProxy[i];
    const b = oldProxy[i];
    if (!eqVec(a.position, b.position) || !eqQuat(a.quaternion, b.quaternion)) frameMatch = false;
  }
  check("PART3 integer-index world-frame reads ≡ legacy", frameMatch);

  // Index 0 returns the part's (world==local-at-root) frame.
  check("PART3 index frame reflects the part transform",
    newProxy[0].position.x === 1 && newProxy[0].position.z === 3 &&
    eqQuat(newProxy[1].quaternion, new Quat(0.5, 0.5, 0.5, 0.5)));

  // Frame objects are cached per index (same object on repeat reads).
  check("PART3 frame object is cached per index (no per-read alloc)",
    newProxy[0] === newProxy[0]);

  check("PART3 out-of-range / negative / non-integer → undefined (≡ legacy)",
    newProxy[2] === undefined && oldProxy[2] === undefined &&
    newProxy[-1] === undefined && oldProxy[-1] === undefined &&
    newProxy.nope === undefined && oldProxy.nope === undefined);

  check("PART3 `in` (has) trap matches legacy",
    (0 in newProxy) === (0 in oldProxy) &&
    (1 in newProxy) === (1 in oldProxy) &&
    (2 in newProxy) === (2 in oldProxy));
}

// =====================================================================
// PART 4 — flag default + static wiring.
// =====================================================================
// readRigModuleFlag default ON in a non-browser ctx (no window).
check("PART4 readRigModuleFlag default ON (no window / no flag)", readRigModuleFlag() === true);

const entitiesSrc = readFileSync(joinPath(__dirname, "scene3d", "entities.js"), "utf8");
const buildingsSrc = readFileSync(joinPath(__dirname, "scene3d", "buildings.js"), "utf8");
const rigSrc = readFileSync(joinPath(__dirname, "scene3d", "setup_rig.js"), "utf8");

check("PART4 entities.js imports the rig module + reads the flag once",
  /from\s*["']\.\/setup_rig\.js["']/.test(entitiesSrc) &&
  /const\s+RIG_MODULE_ON\s*=\s*readRigModuleFlag\(\)/.test(entitiesSrc));
check("PART4 entities.js spawn + hot-swap route through buildPartSurfaceMeshes under the flag",
  (entitiesSrc.match(/buildPartSurfaceMeshes\(THREE,/g) || []).length >= 2);
check("PART4 entities.js keeps the legacy inline path on the flag-off branch",
  /\}\s*else\s*\{\s*\n\s*\/\/ === Legacy inline path/.test(entitiesSrc));
check("PART4 entities.js partFrames routes through createPartFramesProxy under the flag",
  /root\.partFrames\s*=\s*createPartFramesProxy\(THREE,\s*parts\)/.test(entitiesSrc));
check("PART4 buildings.js adopts applyRestPoseFrame for the hinge frame",
  /from\s*["']\.\/setup_rig\.js["']/.test(buildingsSrc) &&
  /applyRestPoseFrame\(\s*\n?\s*THREE,\s*\n?\s*hingeWrapper/.test(buildingsSrc));
check("PART4 setup_rig.js makes NO material decisions (A10 seam — no materialCache ref)",
  !/materialCache/.test(rigSrc));

const flagsDoc = readFileSync(joinPath(__dirname, "docs", "url-flags.md"), "utf8");
check("PART4 url-flags.md documents ?rigModule",
  /`rigModule`/.test(flagsDoc) && /A9-Stage2/.test(flagsDoc));

// =====================================================================
console.log(`\nA9-Stage2 setup_rig: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
