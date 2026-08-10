// cell_fusion.js node battery (E1-DIRTY fix, 2026-08-10).
//
// The defect class this pins: buildFusedMesh assumed NON-indexed per-surface
// geometries; T13's bundle groups are INDEXED views over shared whole-cell
// vertex streams. Fusing them with the non-indexed copy renders the raw
// vertex stream as triangle soup (the R9 290 "fractured interiors" finding).
//
// What must hold:
//   PART 1 — legacy non-indexed slabs: fused output byte-identical to the
//            old concatenation (positions/uv/normals/groups).
//   PART 2 — indexed shared-stream bundle groups: fused triangle multiset
//            per materialIndex ≡ each group's own indexed triangles; groups
//            are in INDEX units; attributes are the SHARED stream objects
//            (no de-index copy).
//   PART 3 — acBakedLight rides both shapes (normalized u8, itemSize 3).
//   PART 4 — defensive mixed bucket: de-indexed correctly.
//
// Run:  cd apps/holtburger-web/ && node harness/test_cell_fusion.mjs

import * as THREE from "three";
import { fuseSurfaceGroups } from "../scene3d/cell_fusion.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL ${msg}`);
  }
}

// ---- helpers ---------------------------------------------------------------

// Extract the triangle list a renderer would draw for one geometry group:
// honors the index when present; returns flat [x,y,z]×3 per triangle.
function trianglesOf(geom, group) {
  const pos = geom.attributes.position;
  const idx = geom.getIndex();
  const out = [];
  for (let k = 0; k < group.count; k += 3) {
    const tri = [];
    for (let c = 0; c < 3; c += 1) {
      const raw = group.start + k + c;
      const v = idx ? idx.array[raw] : raw;
      tri.push([pos.getX(v), pos.getY(v), pos.getZ(v)]);
    }
    out.push(tri);
  }
  return out.map((t) => JSON.stringify(t)).sort();
}

// ---- fixtures --------------------------------------------------------------

// Shared-stream fixture: 6 vertices, two indexed groups over them (the T13
// bundle shape — one _entryAttributes per cell, per-group compact index).
function bundleBucket({ baked = true } = {}) {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 2, 0, 2, 1]);
  const normals = new Float32Array(18).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0));
  const bakedArr = new Uint8Array(18).map((_, i) => i * 10);
  const posAttr = new THREE.BufferAttribute(positions, 3, false);
  const uvAttr = new THREE.BufferAttribute(uvs, 2, false);
  const normAttr = new THREE.BufferAttribute(normals, 3, false);
  const bakedAttr = new THREE.BufferAttribute(bakedArr, 3, true);
  const mk = (indexArr) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", posAttr);
    g.setAttribute("uv", uvAttr);
    g.setAttribute("normal", normAttr);
    if (baked) g.setAttribute("acBakedLight", bakedAttr);
    g.setIndex(new THREE.BufferAttribute(indexArr, 1, false));
    return { group: { geometry: g } };
  };
  // group A: quad 0-1-2 / 0-2-3; group B: quad 1-4-5 / 1-5-2 (vertex reuse
  // across triangles — the shape a non-indexed copy cannot reproduce).
  return {
    bucket: [
      mk(new Uint16Array([0, 1, 2, 0, 2, 3])),
      mk(new Uint16Array([1, 4, 5, 1, 5, 2])),
    ],
    posAttr,
  };
}

// Legacy fixture: two non-indexed slabs (one triangle each).
function legacyBucket() {
  const mk = (x0) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(
        new Float32Array([x0, 0, 0, x0 + 1, 0, 0, x0 + 1, 1, 0]),
        3,
        false
      )
    );
    g.setAttribute(
      "uv",
      new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1]), 2, false)
    );
    g.setAttribute(
      "normal",
      new THREE.BufferAttribute(
        new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        3,
        false
      )
    );
    g.setAttribute(
      "acBakedLight",
      new THREE.BufferAttribute(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), 3, true)
    );
    return { group: { geometry: g } };
  };
  return [mk(0), mk(10)];
}

// ---- PART 1: legacy non-indexed slabs --------------------------------------
console.log("PART 1 — legacy non-indexed slabs");
{
  const bucket = legacyBucket();
  const fused = fuseSurfaceGroups(bucket, true);
  ok(!fused.getIndex(), "legacy fusion stays non-indexed");
  ok(fused.attributes.position.count === 6, "6 fused vertices");
  ok(fused.groups.length === 2, "two material groups");
  ok(
    fused.groups[0].start === 0 &&
      fused.groups[0].count === 3 &&
      fused.groups[1].start === 3 &&
      fused.groups[1].count === 3,
    "vertex-unit group ranges"
  );
  for (let i = 0; i < 2; i += 1) {
    const want = trianglesOf(bucket[i].group.geometry, {
      start: 0,
      count: 3,
    });
    const got = trianglesOf(fused, fused.groups[i]);
    ok(
      JSON.stringify(want) === JSON.stringify(got),
      `group ${i} triangles identical`
    );
  }
  ok(
    fused.getAttribute("acBakedLight") &&
      fused.getAttribute("acBakedLight").array[3] === 4,
    "baked colours concatenated"
  );
}

// ---- PART 2: indexed shared-stream bundle groups ---------------------------
console.log("PART 2 — indexed shared-stream bundle groups");
{
  const { bucket, posAttr } = bundleBucket();
  const fused = fuseSurfaceGroups(bucket, true);
  ok(!!fused.getIndex(), "bundle fusion is indexed");
  ok(
    fused.attributes.position === posAttr,
    "shared vertex stream reused (no de-index copy)"
  );
  ok(fused.groups.length === 2, "two material groups");
  ok(
    fused.groups[0].start === 0 &&
      fused.groups[0].count === 6 &&
      fused.groups[1].start === 6 &&
      fused.groups[1].count === 6,
    "INDEX-unit group ranges"
  );
  for (let i = 0; i < 2; i += 1) {
    const src = bucket[i].group.geometry;
    const want = trianglesOf(src, { start: 0, count: src.getIndex().count });
    const got = trianglesOf(fused, fused.groups[i]);
    ok(
      JSON.stringify(want) === JSON.stringify(got),
      `group ${i} triangle multiset identical (the fracture pin)`
    );
  }
  ok(
    fused.getAttribute("acBakedLight") &&
      fused.getAttribute("acBakedLight").normalized === true,
    "acBakedLight shared, normalized"
  );
}

// ---- PART 3: bundle shape without bake ------------------------------------
console.log("PART 3 — bundle shape without bake");
{
  const { bucket } = bundleBucket({ baked: false });
  const fused = fuseSurfaceGroups(bucket, false);
  ok(!fused.getAttribute("acBakedLight"), "no baked attribute when cellBaked=false");
  ok(!!fused.getIndex(), "still indexed");
}

// ---- PART 4: defensive mixed bucket ----------------------------------------
console.log("PART 4 — mixed bucket de-indexes correctly");
{
  const { bucket } = bundleBucket();
  const legacy = legacyBucket();
  const mixed = [bucket[0], legacy[0]];
  const fused = fuseSurfaceGroups(mixed, true);
  ok(!fused.getIndex(), "mixed fusion de-indexes to non-indexed");
  ok(
    fused.groups[0].count === 6 && fused.groups[1].count === 3,
    "per-group output vertex counts (index count / slab count)"
  );
  const wantA = trianglesOf(bucket[0].group.geometry, {
    start: 0,
    count: bucket[0].group.geometry.getIndex().count,
  });
  const gotA = trianglesOf(fused, fused.groups[0]);
  ok(JSON.stringify(wantA) === JSON.stringify(gotA), "indexed member de-indexed exactly");
  const wantB = trianglesOf(legacy[0].group.geometry, { start: 0, count: 3 });
  const gotB = trianglesOf(fused, fused.groups[1]);
  ok(JSON.stringify(wantB) === JSON.stringify(gotB), "non-indexed member copied exactly");
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
