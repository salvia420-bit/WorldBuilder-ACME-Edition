// ?lodCollapseDup (scene3d/statics.js, DEFAULT-ON, `=off` escape) — a statics
// THREE.LOD must not carry duplicate full-detail levels.
//
// Retail degrade chains open with the base GfxObj itself (0x11000001 names
// 0x0100376A in bands 0 AND 1; all 4,131 chain-carrying GfxObjs in the base
// portal.dat start with band 0 = self). fetchDegradedGeometries used to clone
// one BufferGeometry per band, so the LOD swapped between identical meshes.
//
// Runs the REAL fetchDegradedGeometries + buildSingletonNode /
// buildInstancedNode (statics.js `__lodTestSeams`) over stub wasm meshes and
// pins:
//   A  0x11000001 shape: both self bands drop; the next real level keeps its
//      switch distance (50 m) in the built LOD, singleton AND instanced.
//   B  all bands self: the first is kept so the node stays a THREE.LOD.
//   C  a canopy-softened base (normals differ from a fresh decode) keeps
//      band 0; band 1 (same gfx as band 0) still drops.
//   D  a billboard list (degradeMode >= 2) is left exactly as-is.
//   E  distance preservation: a bumped band (20 < 24 → 24.001) and an
//      unauthored fallback band (index-based 200 m) keep their distances.
//   F  per-surface: a surface the next band lacks keeps one level (LOD stays).
//   G  without base groups only band-to-band repeats collapse.
//   H  a non-adjacent self band ([X, self]) is NOT a duplicate.
//   I  ?lodCollapseDup=off reproduces the uncollapsed chain.
//   J  the flag parser.
import * as THREE from "three";
import {
  __lodTestSeams,
  __setLodCollapseDupForTest,
  lodCollapseDupEnabled,
  lodCollapseDupStats,
} from "../scene3d/statics.js";
import { meshToGeometryGroups } from "../scene3d/adapter.js";

const { fetchDegradedGeometries, buildSingletonNode, buildInstancedNode } = __lodTestSeams;

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) pass += 1;
  else { fail += 1; console.error(`FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}
function near(a, b) { return Math.abs(a - b) < 1e-6; }

// ── stub wasm ModelMesh ────────────────────────────────────────────────
// `surfaces` = unique surface DIDs; each triangle t uses surface t % n.
function makeMesh(seed, surfaces, tris = 4) {
  const positions = new Float32Array(tris * 9);
  const normals = new Float32Array(tris * 9);
  const uvs = new Float32Array(tris * 6);
  const sIdx = new Uint8Array(tris);
  for (let i = 0; i < positions.length; i += 1) positions[i] = seed * 10 + i * 0.25;
  for (let i = 0; i < normals.length; i += 3) { normals[i] = 0; normals[i + 1] = 0; normals[i + 2] = 1; }
  for (let i = 0; i < uvs.length; i += 1) uvs[i] = ((seed + i) % 7) / 7;
  for (let t = 0; t < tris; t += 1) sIdx[t] = t % surfaces.length;
  return {
    triCount: tris,
    positions, normals, uvs,
    surfaceIndices: sIdx,
    surfaces: Uint32Array.from(surfaces),
    didDegrade: 0,
    decodeMisses: 0,
    free() {},
  };
}

const S1 = 0x08000101, S2 = 0x08000102;
const M = 0x0100376a, X = 0x01003770, B = 0x01003771, C = 0x01003772;
const MESHES = new Map([
  [M, () => makeMesh(1, [S1])],
  [X, () => makeMesh(2, [S1])],
  [B, () => makeMesh(3, [S1])],
  [C, () => makeMesh(4, [S1])],
]);
const fetchModelMeshes = async (ids) => Array.from(ids, (id) => (MESHES.get(id >>> 0) || (() => null))());

function chainFetcher(chains) {
  return async (chainId) => {
    const bands = chains.get(chainId >>> 0);
    if (!bands) return "null";
    return JSON.stringify({
      id: chainId,
      degrades: bands.map(([gfx, mode, min]) => ({
        gfx_obj_id: gfx, degrade_mode: mode, min_dist: min, ideal_dist: min, max_dist: min * 2,
      })),
    });
  };
}
const MAXF = 3.4028234663852886e38;

// The primary path's base groups for a model (meshToGeometryGroups, as
// fetchPrimaryGeometries builds them).
function baseGroupsFor(modelId, mesh) {
  return new Map([[modelId, meshToGeometryGroups(mesh).groups]]);
}
const keyOf = (did) => `${did >>> 0}|1`; // degradedSurfaceKey(did, doubleSided=true)

async function run(collapse, modelId, bands, baseGroupsByModel) {
  __setLodCollapseDupForTest(collapse);
  const chains = new Map([[0x11000001, bands]]);
  return fetchDegradedGeometries(
    new Map([[modelId, 0x11000001]]),
    fetchModelMeshes,
    chainFetcher(chains),
    baseGroupsByModel
  );
}

const mat = new THREE.MeshBasicMaterial();
const placement = { landblockId: 0xa9b40001, x: 10, y: 20, z: 5, rotationZ: 0, scale: 1, source: "scenery" };
function singletonDists(modelId, geom, levels) {
  const { node, isLod } = buildSingletonNode({
    placement, modelId, surfaceDid: S1, geom, degradedLevels: levels, mat,
    staticsShadow: false, staticsMatCastsShadow: false, staticsReceiveShadow: false,
  });
  return { isLod, node, dists: isLod ? node.levels.map((l) => l.distance) : [] };
}
function instancedDists(modelId, geom, levels) {
  const m4 = new THREE.Matrix4();
  const { node, isLod } = buildInstancedNode({
    modelId, surfaceDid: S1, group: [placement, { ...placement, x: 30 }], geom, degradedLevels: levels, mat,
    placementMatrix: () => m4, staticsShadow: false, staticsMatCastsShadow: false, staticsReceiveShadow: false,
  });
  return { isLod, node, dists: isLod ? node.levels.map((l) => l.distance) : [] };
}
function posBytesEqual(a, b) {
  const x = a.attributes.position.array, y = b.attributes.position.array;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}
const freshGroup = (id) => meshToGeometryGroups(MESHES.get(id)()).groups[0].geometry;

// ── A — the 0x11000001 shape ───────────────────────────────────────────
{
  const bands = [[M, 1, 10], [M, 1, 25], [X, 1, 50], [0, 1, MAXF]];
  const base = baseGroupsFor(M, MESHES.get(M)());
  const baseGeom = base.get(M)[0].geometry;
  const before = lodCollapseDupStats();
  const on = (await run(true, M, bands, base)).get(M).get(keyOf(S1));
  const off = (await run(false, M, bands, base)).get(M).get(keyOf(S1));
  check("A: off keeps the 3 band levels", off.length === 3, `got ${off.length}`);
  check("A: on keeps only the real band", on.length === 1, `got ${on.length}`);
  check("A: survivor is X's geometry", posBytesEqual(on[0].geometry, freshGroup(X)));
  check("A: survivor dist 50", near(on[0].dist, 50) && near(on[0].geometry.userData.lodDist, 50));
  const sOff = singletonDists(M, baseGeom, off);
  const sOn = singletonDists(M, baseGeom, on);
  check("A: off singleton LOD = [0,10,25,50]", sOff.isLod && sOff.dists.join() === "0,10,25,50", sOff.dists.join());
  check("A: on singleton LOD = [0,50]", sOn.isLod && sOn.dists.join() === "0,50", sOn.dists.join());
  check("A: next real level's switch distance unchanged (singleton)", near(sOn.dists[1], sOff.dists[3]));
  check("A: level 0 is the base geometry", sOn.node.levels[0].object.geometry === baseGeom);
  const iOff = instancedDists(M, baseGeom, off);
  const iOn = instancedDists(M, baseGeom, on);
  check("A: on instanced LOD = [0,50]", iOn.isLod && iOn.dists.join() === "0,50", iOn.dists.join());
  check("A: next real level's switch distance unchanged (instanced)", near(iOn.dists[1], iOff.dists[3]));
  const after = lodCollapseDupStats();
  check("A: stats count the 2 dropped levels", after.levelsDropped - before.levelsDropped === 2 && after.listsCollapsed - before.listsCollapsed === 1,
    JSON.stringify({ before, after }));
}

// ── B — every band is the base: keep the first so the node stays an LOD ──
{
  const bands = [[M, 1, 10], [M, 1, 25]];
  const base = baseGroupsFor(M, MESHES.get(M)());
  const baseGeom = base.get(M)[0].geometry;
  const on = (await run(true, M, bands, base)).get(M).get(keyOf(S1));
  check("B: all-duplicate list keeps exactly one level", on.length === 1, `got ${on.length}`);
  check("B: kept level is the first band (10 m)", near(on[0].dist, 10));
  const s = singletonDists(M, baseGeom, on);
  check("B: node is still a THREE.LOD", s.isLod && s.node.isLOD && s.dists.join() === "0,10", s.dists.join());
  const single = (await run(true, M, [[M, 1, 100]], base)).get(M).get(keyOf(S1));
  check("B: single self band untouched", single.length === 1 && near(single[0].dist, 100));
}

// ── C — canopy-softened base differs from a fresh decode ───────────────
{
  const bands = [[M, 1, 10], [M, 1, 25], [X, 1, 50]];
  const base = baseGroupsFor(M, MESHES.get(M)());
  const g = base.get(M)[0].geometry;
  g.attributes.normal.array[2] = 0.5; // what softenCanopyGroups does in place
  g.userData.hbCanopySoft = true;
  const on = (await run(true, M, bands, base)).get(M).get(keyOf(S1));
  check("C: softened base keeps band 0, drops band 1", on.length === 2, `got ${on.length}`);
  check("C: kept band 0 is an unsoftened clone", on[0].geometry.attributes.normal.array[2] === 1);
  check("C: distances [10, 50]", near(on[0].dist, 10) && near(on[1].dist, 50));
  const s = singletonDists(M, g, on);
  check("C: LOD = [0,10,50]", s.dists.join() === "0,10,50", s.dists.join());
}

// ── D — billboard lists are left as-is ─────────────────────────────────
{
  const bands = [[M, 1, 10], [M, 1, 25], [X, 5, 50]];
  const base = baseGroupsFor(M, MESHES.get(M)());
  const on = (await run(true, M, bands, base)).get(M).get(keyOf(S1));
  const off = (await run(false, M, bands, base)).get(M).get(keyOf(S1));
  check("D: billboard list keeps every level", on.length === 3 && off.length === 3);
  check("D: dists identical to off", on.map((l) => l.dist).join() === off.map((l) => l.dist).join());
  const self = (await run(true, M, [[M, 2, 64]], base)).get(M).get(keyOf(S1));
  check("D: single self band with mode 2 kept", self.length === 1 && self[0].degradeMode === 2);
}

// ── E — survivors keep the distance they had in the full list ───────────
{
  const base = baseGroupsFor(M, MESHES.get(M)());
  const baseGeom = base.get(M)[0].geometry;
  // B authored 20 < band 0's 24 → bandSwapDistances bumps it to 24.001.
  const bumped = [[M, 1, 24], [B, 1, 20], [C, 1, 80]];
  const offE = singletonDists(M, baseGeom, (await run(false, M, bumped, base)).get(M).get(keyOf(S1)));
  const onE = singletonDists(M, baseGeom, (await run(true, M, bumped, base)).get(M).get(keyOf(S1)));
  check("E: off LOD = [0,24,24.001,80]", offE.dists.length === 4 && near(offE.dists[2], 24.001), offE.dists.join());
  check("E: bumped band keeps 24.001", onE.dists.length === 3 && near(onE.dists[1], 24.001) && near(onE.dists[2], 80), onE.dists.join());
  // Unauthored distances (min_dist 0) use the index-based 100 m spread.
  const unauthored = [[M, 1, 0], [B, 1, 0]];
  const offU = singletonDists(M, baseGeom, (await run(false, M, unauthored, base)).get(M).get(keyOf(S1)));
  const onU = singletonDists(M, baseGeom, (await run(true, M, unauthored, base)).get(M).get(keyOf(S1)));
  check("E: off fallback LOD = [0,100,200]", offU.dists.join() === "0,100,200", offU.dists.join());
  check("E: on keeps B at its 200 m fallback", onU.dists.join() === "0,200", onU.dists.join());
}

// ── F — per-surface lists ──────────────────────────────────────────────
{
  const M2 = 0x01004000, X2 = 0x01004001;
  MESHES.set(M2, () => makeMesh(5, [S1, S2]));
  MESHES.set(X2, () => makeMesh(6, [S1]));
  const base = baseGroupsFor(M2, MESHES.get(M2)());
  const res = (await run(true, M2, [[M2, 1, 10], [X2, 1, 50]], base)).get(M2);
  const l1 = res.get(keyOf(S1)), l2 = res.get(keyOf(S2));
  check("F: S1 drops the self band, keeps X2", l1 && l1.length === 1 && near(l1[0].dist, 50));
  check("F: S2 (absent from X2) keeps one level", l2 && l2.length === 1 && near(l2[0].dist, 10));
}

// ── G — no base groups: only band-to-band repeats collapse ─────────────
{
  const on = (await run(true, M, [[M, 1, 10], [M, 1, 25], [X, 1, 50]], null)).get(M).get(keyOf(S1));
  check("G: band 0 kept, band 1 dropped", on.length === 2 && near(on[0].dist, 10) && near(on[1].dist, 50));
}

// ── H — a self band after a different band is not a duplicate ──────────
{
  const base = baseGroupsFor(M, MESHES.get(M)());
  const on = (await run(true, M, [[X, 1, 10], [M, 1, 50]], base)).get(M).get(keyOf(S1));
  check("H: [X, self] keeps both", on.length === 2 && near(on[0].dist, 10) && near(on[1].dist, 50));
}

// ── I — ?lodCollapseDup=off is the uncollapsed chain ───────────────────
{
  const base = baseGroupsFor(M, MESHES.get(M)());
  const off = (await run(false, M, [[M, 1, 10], [M, 1, 25], [X, 1, 50]], base)).get(M).get(keyOf(S1));
  check("I: off keeps authored band dists", off.map((l) => l.dist).join() === "10,25,50");
  check("I: off clones are distinct geometries", new Set(off.map((l) => l.geometry)).size === 3);
  const unauth = (await run(false, M, [[M, 1, 0]], base)).get(M).get(keyOf(S1));
  check("I: off leaves an unauthored dist null", unauth[0].dist === null && unauth[0].geometry.userData.lodDist === undefined);
}

// ── J — flag parser ────────────────────────────────────────────────────
check("J: absent → on", lodCollapseDupEnabled("") === true);
check("J: =off → off", lodCollapseDupEnabled("?lodCollapseDup=off") === false);
check("J: =0 → off", lodCollapseDupEnabled("?nosw=1&lodCollapseDup=0") === false);
check("J: =false → off", lodCollapseDupEnabled("?lodCollapseDup=false") === false);
check("J: =OFF → off", lodCollapseDupEnabled("?lodCollapseDup=OFF") === false);
check("J: =on → on", lodCollapseDupEnabled("?lodCollapseDup=on") === true);
check("J: no location in node → on", lodCollapseDupEnabled(undefined) === true);

console.log(`lod_collapse_dup: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
