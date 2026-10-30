// tests/pool_size_to_content.test.mjs — ?poolSizeToContent (2026-10-26, stage-2
// S1c; docs/2026-10-26-rust-residency-design.md §4, lane notes
// docs/2026-10-26-rust-cull.md). pool_registry.js sizes a pool's FIRST
// allocation from the feed that creates it (static_batch_x's chunk rule:
// twice the need, power of two, [1,024, 16,384]) instead of always 16,384
// vertices, and the census reports each pool's real buffer bytes. Locks:
//   P1  the flag reader (default off) and the sizing rule (== the chunk rule)
//   P2  PIXEL IDENTITY: the same plans fed through a flag-off and a flag-on
//       registry give pools with identical geometry ranges, identical vertex /
//       index data over the used extent, identical instances (geometry id,
//       matrix, visibility) — through a park / adopt, LOD band pairs and a
//       later feed that outgrows the first allocation (setGeometrySize)
//   P3  memory: flag on, allocated ≤ 4 × used over a realistic population;
//       flag off, every pool still allocates 16,384 vertices
//   P4  the census: flag on reports the real buffers (36 B / vertex: pos +
//       normal + uv + aLayer; u16 indices); flag off is unchanged (24 B)
//   P5  a geometry source without `sizeOf` keeps today's allocation
//
// Run from apps/holtburger-web/:  node tests/pool_size_to_content.test.mjs

import * as THREE from "three";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };

const { applyBatchedMeshColorTextureFix } = await import("../scene3d/three_batchedmesh_colortexture_fix.js");
const PR = await import("../scene3d/pool_registry.js");
const { classKeyOf, passClassOf } = await import("../scene3d/pool_class_key.js");
const { normalizeForPool } = await import("../scene3d/pool_material.js");

applyBatchedMeshColorTextureFix(THREE);

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

const PLAIN_PATCH = { d: 0, c: 0, p: 0, l: 0, a: 0, b: 0, f: 0, s: 0, k: 0, v: "" };
function rec(over = {}) {
  return {
    domain: "st", transparent: false, alphaTest: 0, depthWrite: true, blending: 1, blendTriple: null, wrap: "c", side: 2,
    patch: { ...PLAIN_PATCH }, vfxConfigKey: null, texW: 256, texH: 256, texCompressed: true, hasTex: true,
    castShadow: true, receiveShadow: true, ...over,
  };
}
// Source geometry the producer would hold: indexed, with some unreferenced
// vertices (normalizeForPool drops them — `sizeOf` is an upper bound).
function srcGeom(nVerts, seed) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(nVerts * 3), nor = new Float32Array(nVerts * 3), uv = new Float32Array(nVerts * 2);
  for (let i = 0; i < pos.length; i++) pos[i] = Math.sin(seed * 31 + i * 0.7) * 5;
  for (let i = 0; i < nor.length; i++) nor[i] = Math.cos(seed + i);
  for (let i = 0; i < uv.length; i++) uv[i] = (i * 0.013 + seed) % 1;
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  const idx = [];
  for (let i = 0; i + 2 < nVerts - 2; i += 3) idx.push(i, i + 1, i + 2); // the last vertices stay unreferenced
  g.setIndex(idx);
  return g;
}
const SOURCES = new Map();
for (let k = 0; k < 40; k++) SOURCES.set(`m${k}|0`, srcGeom(24 + ((k * 37) % 300), k));
// What pool_producer.js hands the registry: `get` builds the pool form,
// `sizeOf` (the S1c addition) reads the source's counts without building it.
function geomSource({ withSize = true } = {}) {
  const gs = {
    get: (contentKey, layer) => { const s = SOURCES.get(contentKey); return s ? normalizeForPool(s, layer) : null; },
  };
  if (withSize) {
    gs.sizeOf = (contentKey) => {
      const s = SOURCES.get(contentKey);
      const pos = s && s.attributes.position;
      return pos ? { verts: pos.count, indices: s.index ? s.index.count : pos.count } : null;
    };
  }
  return gs;
}
function member(k, sector, over = {}) {
  const axes = rec(over.axes || {});
  const m4 = new THREE.Matrix4().makeTranslation(k * 3.5, -k * 1.25, k * 0.5);
  return {
    domain: axes.domain, classKey: classKeyOf(axes), passClass: passClassOf(axes), sectorKey: sector,
    contentKey: `m${k % 40}|0`, layer: k % 3, matrix: m4.toArray(), rsId: 0x06001000 + (k % 7), ...over,
  };
}
const plan = (tile, members) => ({ tile, lbs: [], members, counts: {} });
function makeRegistry(search) {
  return new PR.PoolRegistry({
    THREE, group: new THREE.Group(), warn: () => {}, search,
    materialFactory: () => new THREE.MeshStandardMaterial(),
  });
}

// The scripted population: 6 sectors × 2 classes, 9 tiles, LOD band pairs,
// then one big late feed into an existing pool (growth past the first size).
function script(reg, gs) {
  const transl = { axes: { transparent: true, depthWrite: false } };
  for (let t = 0; t < 9; t++) {
    const ms = [];
    for (let j = 0; j < 14; j++) {
      const k = t * 14 + j;
      const sector = `s${t % 6}x0`;
      ms.push(member(k, sector, j % 5 === 4 ? transl : {}));
      if (j % 7 === 3) ms.push(member(k, sector, { bandGids: [`m${(k + 1) % 40}|0`, `m${(k + 2) % 40}|0`], band: j % 2 }));
    }
    reg.feedTile(plan(t, ms), gs);
  }
  reg.parkTile(3);
  reg.adoptTile(3);
  // A late, large feed into sector s0x0's opaque pool: outgrows a sized-to-content first allocation.
  const big = [];
  for (let j = 0; j < 160; j++) big.push(member(1000 + j, "s0x0", { contentKey: `m${j % 40}|${j % 4}` }));
  reg.feedTile(plan(20, big), gs);
}

// Everything a draw reads from a pool, over the used extent.
function poolSnapshot(reg) {
  const out = [];
  const m = new THREE.Matrix4();
  for (const [key, p] of [...reg.pools.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const bm = p.mesh;
    const g = bm.geometry;
    out.push(key, bm._geometryCount, bm._instanceInfo.length, p.usedVerts, p.usedIndices);
    for (const gi of bm._geometryInfo) out.push(gi.vertexStart, gi.vertexCount, gi.reservedVertexCount, gi.indexStart, gi.indexCount, gi.reservedIndexCount, gi.active ? 1 : 0);
    for (const name of Object.keys(g.attributes).sort()) {
      const a = g.attributes[name];
      out.push(name, a.itemSize);
      const n = p.usedVerts * a.itemSize;
      for (let i = 0; i < n; i++) out.push(a.array[i]);
    }
    if (g.index) for (let i = 0; i < p.usedIndices; i++) out.push(g.index.array[i]);
    for (let i = 0; i < bm._instanceInfo.length; i++) {
      const info = bm._instanceInfo[i];
      out.push(info.active ? 1 : 0, info.visible ? 1 : 0, info.geometryIndex);
      if (info.active) { bm.getMatrixAt(i, m); out.push(...m.elements); }
    }
  }
  return out;
}
function sameBits(a, b) {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return `index ${i}: ${a[i]} vs ${b[i]}`;
  return null;
}

console.log("?poolSizeToContent — S1c");
{
  check("P1 default ON (2026-10-26); off / 0 / false / no disarm it; on spellings and garbage keep it",
    PR.poolSizeToContentEnabled("") === true &&
    ["on", "1", "true", "YES", "maybe"].every((v) => PR.poolSizeToContentEnabled(`?poolSizeToContent=${v}`)) &&
    ["off", "0", "false", "NO"].every((v) => !PR.poolSizeToContentEnabled(`?poolSizeToContent=${v}`)));
  // The chunk rule, as static_batch_x.js `_initialBucketVerts` states it.
  const rule = (v, i) => { const need = Math.max(v, Math.ceil(i / 2)) * 2; let s = 1024; while (s < need && s < 16384) s *= 2; return s; };
  const cases = [[0, 0], [1, 3], [511, 1500], [512, 1024], [513, 900], [4000, 6000], [8191, 0], [8193, 0], [100000, 300000]];
  check("P1 the first allocation follows the chunk rule (floor 1,024, ceiling 16,384)",
    cases.every(([v, i]) => PR.poolInitialVerts(v, i) === rule(v, i)), cases.map(([v, i]) => PR.poolInitialVerts(v, i)).join(","));
}

const OFF = makeRegistry("?poolSizeToContent=off");
const ON = makeRegistry("?poolSizeToContent=on");
script(OFF, geomSource());
script(ON, geomSource());
{
  const a = poolSnapshot(OFF), b = poolSnapshot(ON);
  check(`P2 every pool's ranges, vertex / index data, instances, matrices and visibility identical (${OFF.pools.size} pools, ${a.length} values)`,
    OFF.pools.size > 6 && sameBits(a, b) === null, sameBits(a, b) || "");
  const grew = [...ON.pools.values()].some((p) => p.maxVerts > PR.poolInitialVerts(0, 0) && p.mesh._geometryInfo.length > 0);
  check("P2 a sized pool still grew when a later feed outgrew it", ON._stats.growthDoublings > 0 && grew,
    `growth ${ON._stats.growthDoublings}`);
  check("P2 park → adopt round-tripped in both arms", OFF._stats.parks === 1 && ON._stats.parks === 1 && OFF._stats.adopts === 1 && ON._stats.adopts === 1);
}
{
  const gOff = OFF.geometryBytes(), gOn = ON.geometryBytes();
  check(`P3 flag on: allocated ≤ 4 × used (${gOn.allocated} vs ${gOn.used})`, gOn.used > 0 && gOn.allocated <= 4 * gOn.used);
  check("P3 flag off: every pool still starts at 16,384 vertices",
    [...OFF.pools.values()].every((p) => p.maxVerts >= PR.POOL_INIT_VERTS) && OFF._stats.sizedToContent === 0);
  check(`P3 flag on: pools sized to content (${ON._stats.sizedToContent} of ${ON._stats.poolsCreated})`, ON._stats.sizedToContent > 0);
  // Real buffer bytes, summed by hand.
  let alloc = 0, used = 0;
  for (const p of ON.pools.values()) {
    const g = p.mesh.geometry;
    let per = 0;
    for (const a of Object.values(g.attributes)) { alloc += a.array.byteLength; per += a.itemSize * a.array.BYTES_PER_ELEMENT; }
    if (g.index) alloc += g.index.array.byteLength;
    used += p.usedVerts * per + p.usedIndices * (g.index ? g.index.array.BYTES_PER_ELEMENT : 2);
  }
  const anyPer = (() => { const p = [...ON.pools.values()][0]; let per = 0; for (const a of Object.values(p.mesh.geometry.attributes)) per += a.itemSize * a.array.BYTES_PER_ELEMENT; return per; })();
  check(`P4 flag on: the census reports the real buffers (${anyPer} B per pool vertex)`,
    gOn.allocated === alloc && gOn.used === used && anyPer === PR.POOL_VERTEX_BYTES_ACTUAL);
  const legacy = [...OFF.pools.values()].reduce((s, p) => s + p.maxVerts * 24 + p.maxIndices * 2, 0);
  check("P4 flag off: the census is unchanged (the 24 B legacy denominator)", gOff.allocated === legacy && PR.POOL_VERTEX_BYTES === 24);
  const c = ON.census();
  check("P4 census exposes the arm and the count", c.geometry.sizeToContent === true && c.geometry.sizedToContent === ON._stats.sizedToContent);
  check(`P3 heap: ${(gOff.allocated / 1024).toFixed(0)} KB (legacy census) → ${(gOn.allocated / 1024).toFixed(0)} KB real`, gOn.allocated < gOff.allocated);
}
{
  const R = makeRegistry("?poolSizeToContent=on");
  script(R, geomSource({ withSize: false }));
  check("P5 a source without sizeOf keeps today's allocation", R._stats.sizedToContent === 0 &&
    [...R.pools.values()].every((p) => p.maxVerts >= PR.POOL_INIT_VERTS));
  check("P5 …and identical content", sameBits(poolSnapshot(R), poolSnapshot(OFF)) === null);
}

console.log(`\npool_size_to_content: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
