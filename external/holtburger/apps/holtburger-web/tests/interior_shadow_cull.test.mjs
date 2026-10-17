// interior_shadow_cull.test.mjs — ?interiorShadowCull (scene3d/interior_shadow_cull.js).
//
// Perf 2026-10-17: interior rooms cast no sun shadows while the camera is
// outdoors (54 interior shadow draws a frame at LB 0xE632 on the 1070). The
// behaviour that MUST NOT drift:
//   §1 outdoors every Mesh under a drawn cell container stops casting; indoors
//      each one casts exactly as it was BUILT (non-casters stay non-casters).
//   §2 the per-frame call is O(1) once a container is stamped, and a container
//      that gains children (walls-first statics, animated props) is re-synced.
//   §3 the forced raster only fires on a manually-driven shadow map (RP5).
//   §4 `?interiorShadowCull=off` and the live `.off` seam keep the built casters.
//   §5 cells.js still runs the sync from the visibility tick.
//
// Run: node tests/interior_shadow_cull.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import {
  interiorCastWanted,
  syncCellShadowCast,
  requestShadowRaster,
  getInteriorShadowCullStats,
  interiorShadowCullEnabled,
  __setInteriorShadowCullOffForTest,
} from "../scene3d/interior_shadow_cull.js";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  [OK] ${name}`);
}

function mesh(cast) {
  const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}

/** A cell container shaped like cells.js builds it: meshGroup(fused walls) + props. */
function cellContainer() {
  const c = new THREE.Group();
  c.userData = { cellId: 0xe6320100, isEnvCell: true };
  const meshGroup = new THREE.Group();
  meshGroup.add(mesh(true)); // fused opaque walls
  meshGroup.add(mesh(false)); // fused transparent (never casts)
  c.add(meshGroup);
  c.add(mesh(true)); // a prop
  const anchor = new THREE.Group(); // ?cellStaticMerge anchor (no mesh)
  anchor.userData = { isCellStatic: true, mergedInto: true };
  c.add(anchor);
  return c;
}

function casts(c) {
  const out = [];
  c.traverse((o) => { if (o.isMesh) out.push(o.castShadow); });
  return out;
}

await test("flag defaults ON (no location in node)", () => {
  assert.equal(interiorShadowCullEnabled(), true);
  assert.equal(interiorCastWanted(false), false, "outdoors: no interior casters");
  assert.equal(interiorCastWanted(true), true, "indoors: built casters");
});

await test("§1 outdoors drops every caster, indoors restores exactly the built ones", () => {
  const c = cellContainer();
  assert.deepEqual(casts(c), [true, false, true]);
  assert.equal(syncCellShadowCast(c, false), true, "a visible caster changed");
  assert.deepEqual(casts(c), [false, false, false]);
  assert.equal(syncCellShadowCast(c, true), true);
  assert.deepEqual(casts(c), [true, false, true], "the transparent bucket stays a non-caster");
});

await test("§1 indoors-first: stamping a container changes nothing", () => {
  const c = cellContainer();
  assert.equal(syncCellShadowCast(c, true), false);
  assert.deepEqual(casts(c), [true, false, true]);
});

await test("§2 stamped container: repeat calls are no-ops", () => {
  const c = cellContainer();
  syncCellShadowCast(c, false);
  const before = getInteriorShadowCullStats().syncs;
  for (let i = 0; i < 5; i++) assert.equal(syncCellShadowCast(c, false), false);
  assert.equal(getInteriorShadowCullStats().syncs, before, "no traversal while stamped");
});

await test("§2 a late child (walls-first statics / animated prop) is re-synced", () => {
  const c = cellContainer();
  syncCellShadowCast(c, false);
  const late = mesh(true);
  c.add(late);
  assert.equal(syncCellShadowCast(c, false), true);
  assert.equal(late.castShadow, false);
  assert.equal(late.userData.__baseCast, true, "its built value is remembered");
  syncCellShadowCast(c, true);
  assert.equal(late.castShadow, true);
});

await test("§2 a container with no userData is ignored", () => {
  assert.equal(syncCellShadowCast(null, false), false);
  assert.equal(syncCellShadowCast({}, false), false);
});

await test("§3 the forced raster only drives a manually-rastered shadow map", () => {
  const before = getInteriorShadowCullStats().rasters;
  const gated = { shadowMap: { enabled: true, autoUpdate: false, needsUpdate: false } };
  assert.equal(requestShadowRaster(gated), true);
  assert.equal(gated.shadowMap.needsUpdate, true);
  const auto = { shadowMap: { enabled: true, autoUpdate: true, needsUpdate: false } };
  assert.equal(requestShadowRaster(auto), false, "three already rasters every frame");
  assert.equal(auto.shadowMap.needsUpdate, false);
  const off = { shadowMap: { enabled: false, autoUpdate: false, needsUpdate: false } };
  assert.equal(requestShadowRaster(off), false, "shadows disabled");
  assert.equal(requestShadowRaster(null), false);
  assert.equal(getInteriorShadowCullStats().rasters, before + 1);
});

await test("§4 live .off seam keeps the built casters outdoors", () => {
  __setInteriorShadowCullOffForTest(true);
  try {
    assert.equal(interiorCastWanted(false), true);
  } finally {
    __setInteriorShadowCullOffForTest(false);
  }
  assert.equal(interiorCastWanted(false), false);
});

await test("§4 ?interiorShadowCull=off disables the cull", async () => {
  // Module-level flag: re-import a fresh instance under a fake location.
  const saved = globalThis.location;
  globalThis.location = { search: "?interiorShadowCull=off" };
  try {
    const m = await import("../scene3d/interior_shadow_cull.js?off=" + Date.now());
    assert.equal(m.interiorShadowCullEnabled(), false);
    assert.equal(m.interiorCastWanted(false), true);
  } finally {
    if (saved === undefined) delete globalThis.location;
    else globalThis.location = saved;
  }
});

await test("§5 cells.js syncs casters from the visibility tick", () => {
  const src = readFileSync(new URL("../scene3d/cells.js", import.meta.url), "utf8");
  const tick = src.slice(src.indexOf("export function tickCellVisibility3D"));
  assert.ok(/interiorCastWanted\(isIndoor\)/.test(tick), "cast mode keyed on the viewer cell");
  assert.ok((tick.match(/syncCellShadowCast\(container, castOn\)/g) || []).length >= 2, "both container loops sync");
  assert.ok(/requestShadowRaster\(scene3d\.renderer\)/.test(tick), "one raster when a caster changed");
});

console.log(`\ninterior_shadow_cull: ${passed} passed`);
