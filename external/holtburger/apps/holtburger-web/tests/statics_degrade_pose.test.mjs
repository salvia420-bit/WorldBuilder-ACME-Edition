// ?degradePose (scene3d/statics.js, DEFAULT-ON, `=off` escape) — a statics
// degrade band draws where the Setup draws its part.
//
// A band is a GfxObj for the Setup's PART (retail CPhysicsPart::
// UpdateViewerDistance / calc_draw_frame). The bands were fetched as raw 0x01
// GfxObjs and drawn at the Setup origin, so a static whose Setup lifts, turns
// or scales its part (a town sign's Resting frame lifts it +4.66 m) dropped,
// slid or tilted whenever a band was active and popped back at full detail.
// The wasm hands the full-detail pose over as ModelMesh.degradePartFrame
// (lib.rs resolve_degrade_part_frame, pinned natively by
// degrade_part_frame_poses_bands_like_the_full_mesh); this suite pins the JS
// half over the REAL fetchDegradedGeometries / buildSingletonNode /
// buildInstancedNode / billboard orienter (statics.js `__lodTestSeams`):
//   A  degradeBandPose: frame → matrix; rejects bad lengths / NaN / mirroring
//   B  every band clone is posed R·(S·v)+T, carries its pose, owns its userData
//   C  two models citing ONE band each keep their own pose and lodDist
//   D  `?degradePose=off` and a model without a frame draw the bands as fetched
//   E  the built LOD (singleton + instanced) holds the posed geometry
//   F  a posed billboard leaf pivots round the PART origin and faces the camera
//   G  the pose survives the bake worker (bake_transfer) and the shared cache
//   H  the flag parser
import * as THREE from "three";
import {
  __lodTestSeams,
  __setDegradePoseForTest,
  __setLodCollapseDupForTest,
  degradeBandPose,
  degradePoseEnabled,
  degradePoseStats,
} from "../scene3d/statics.js";
import { serializeModelMesh, reconstructModelMesh } from "../scene3d/bake_transfer.js";
import { StaticGeomCache } from "../scene3d/static_geom_cache.js";

const { fetchDegradedGeometries, buildSingletonNode, buildInstancedNode, orientBillboardLeaf } = __lodTestSeams;

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) pass += 1;
  else { fail += 1; console.error(`FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}
const near = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;

// ── stub wasm ModelMesh: one triangle per surface ─────────────────────────
function makeMesh(seed, surfaces) {
  const tris = surfaces.length;
  const positions = new Float32Array(tris * 9);
  const normals = new Float32Array(tris * 9);
  const uvs = new Float32Array(tris * 6);
  const sIdx = new Uint8Array(tris);
  for (let i = 0; i < positions.length; i += 1) positions[i] = seed + (i % 9) * 0.25 - 0.5;
  for (let i = 0; i < normals.length; i += 3) { normals[i] = 0; normals[i + 1] = 1; normals[i + 2] = 0; }
  for (let t = 0; t < tris; t += 1) sIdx[t] = t;
  return {
    triCount: tris, positions, normals, uvs, surfaceIndices: sIdx,
    surfaces: Uint32Array.from(surfaces), didDegrade: 0, decodeMisses: 0, free() {},
  };
}
const S1 = 0x08000201;
const BAND = 0x01004153, BAND2 = 0x01004154;
const SETUP_A = 0x02001820, SETUP_B = 0x02001823;
const RAW = new Map([[BAND, () => makeMesh(1, [S1])], [BAND2, () => makeMesh(2, [S1])]]);
const fetchModelMeshes = async (ids) => Array.from(ids, (id) => (RAW.get(id >>> 0) || (() => null))());
const rawPositions = (id) => RAW.get(id)().positions;
const MAXF = 3.4028234663852886e38;
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
const keyOf = (did) => `${did >>> 0}|1`;
// AC frame [ox,oy,oz, qw,qx,qy,qz, sx,sy,sz]: 0x02001820 lowers its part 2.9 m;
// the second one lifts, tilts 30° about X and doubles it.
const half = (15 * Math.PI) / 180;
const FRAME_A = Float32Array.from([0, 0, -2.9, 1, 0, 0, 0, 1, 1, 1]);
const FRAME_B = Float32Array.from([0.5, -0.25, 4.66, Math.cos(half), Math.sin(half), 0, 0, 2, 2, 2]);
function poseOf(frame) {
  const [ox, oy, oz, qw, qx, qy, qz, sx, sy, sz] = frame;
  return new THREE.Matrix4().compose(new THREE.Vector3(ox, oy, oz), new THREE.Quaternion(qx, qy, qz, qw).normalize(), new THREE.Vector3(sx, sy, sz));
}
function expectPosed(geom, rawId, frame) {
  const m = poseOf(frame);
  const raw = rawPositions(rawId);
  const got = geom.attributes.position.array;
  if (got.length !== raw.length) return `len ${got.length} vs ${raw.length}`;
  const v = new THREE.Vector3();
  for (let i = 0; i < raw.length; i += 3) {
    v.set(raw[i], raw[i + 1], raw[i + 2]).applyMatrix4(m);
    if (!near(v.x, got[i]) || !near(v.y, got[i + 1]) || !near(v.z, got[i + 2])) {
      return `vertex ${i / 3}: (${got[i]}, ${got[i + 1]}, ${got[i + 2]}) vs (${v.x}, ${v.y}, ${v.z})`;
    }
  }
  return "";
}
async function run(models, chains, frames) {
  return fetchDegradedGeometries(models, fetchModelMeshes, chainFetcher(chains), null, frames);
}

__setLodCollapseDupForTest(true);

// ── A — the frame parser ───────────────────────────────────────────────────
{
  const p = degradeBandPose(FRAME_B);
  check("A: a 10-float frame parses", !!p && p.matrix.isMatrix4);
  check("A: origin + quaternion carried (three order)", p && near(p.o.z, 4.66) && near(p.q.x, Math.sin(half)) && near(p.q.w, Math.cos(half)));
  check("A: wrong length → null", degradeBandPose(new Float32Array(7)) === null && degradeBandPose(null) === null);
  check("A: NaN → null", degradeBandPose(Float32Array.from([0, 0, NaN, 1, 0, 0, 0, 1, 1, 1])) === null);
  check("A: a mirroring scale → null", degradeBandPose(Float32Array.from([0, 0, 1, 1, 0, 0, 0, -1, 1, 1])) === null);
  check("A: a zero quaternion → null", degradeBandPose(Float32Array.from([0, 0, 1, 0, 0, 0, 0, 1, 1, 1])) === null);
}

// ── B / C — posed clones, own userData, per-model poses ────────────────────
{
  __setDegradePoseForTest(true);
  const before = degradePoseStats();
  // Two Setups share ONE band GfxObj (and its source geometry) with different
  // part poses and different swap distances.
  const chains = new Map([[0x11001017, [[BAND, 1, 20], [0, 1, MAXF]]], [0x11001018, [[BAND, 1, 35], [0, 1, MAXF]]]]);
  const out = await run(
    new Map([[SETUP_A, 0x11001017], [SETUP_B, 0x11001018]]),
    chains,
    new Map([[SETUP_A, FRAME_A], [SETUP_B, FRAME_B]])
  );
  const la = out.get(SETUP_A)?.get(keyOf(S1));
  const lb = out.get(SETUP_B)?.get(keyOf(S1));
  check("B: both models get their band level", la?.length === 1 && lb?.length === 1);
  const ga = la[0].geometry, gb = lb[0].geometry;
  const ea = expectPosed(ga, BAND, FRAME_A);
  check("B: model A's band is lowered 2.9 m (T·R·S·v)", ea === "", ea);
  const eb = expectPosed(gb, BAND, FRAME_B);
  check("B: model B's band is lifted, tilted and doubled", eb === "", eb);
  check("B: the normal follows the tilt (R·n)", (() => {
    const n = gb.attributes.normal.array;
    const want = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(Math.sin(half), 0, 0, Math.cos(half)));
    return near(n[0], want.x) && near(n[1], want.y) && near(n[2], want.z);
  })());
  check("C: each clone owns its userData (no shared object)", ga.userData !== gb.userData);
  check("C: per-model lodDist kept (20 vs 35)", ga.userData.lodDist === 20 && gb.userData.lodDist === 35,
    `${ga.userData.lodDist} / ${gb.userData.lodDist}`);
  check("C: per-model pose kept", near(ga.userData.degradePose?.o.z, -2.9) && near(gb.userData.degradePose?.o.z, 4.66));
  // raw z spans 1.0 .. 2.5 (box centre 1.75); lowered 2.9 m → centre -1.15
  check("B: the bounding sphere moved with the band", near(ga.boundingSphere.center.z, -1.15, 1e-4),
    `${ga.boundingSphere.center.z}`);
  const after = degradePoseStats();
  check("B: diag counts the posed models / bands", after.modelsPosed - before.modelsPosed === 2 && after.bandsPosed - before.bandsPosed === 2);
}

// ── D — off, and models without a frame ────────────────────────────────────
{
  const chains = new Map([[0x11001017, [[BAND, 1, 20], [0, 1, MAXF]]]]);
  __setDegradePoseForTest(false);
  const off = await run(new Map([[SETUP_A, 0x11001017]]), chains, new Map([[SETUP_A, FRAME_A]]));
  const g = off.get(SETUP_A).get(keyOf(S1))[0].geometry;
  check("D: ?degradePose=off draws the band as fetched", expectPosed(g, BAND, Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 1, 1])) === "");
  check("D: off carries no pose", !g.userData.degradePose);
  __setDegradePoseForTest(true);
  const none = await run(new Map([[BAND2, 0x11001017]]), new Map([[0x11001017, [[BAND, 1, 20], [0, 1, MAXF]]]]), new Map());
  const g2 = none.get(BAND2).get(keyOf(S1))[0].geometry;
  check("D: a model without a frame (raw 0x01 / stale pkg) is unchanged", expectPosed(g2, BAND, Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 1, 1])) === "" && !g2.userData.degradePose);
  const legacyArgs = await fetchDegradedGeometries(new Map([[SETUP_A, 0x11001017]]), fetchModelMeshes, chainFetcher(chains), null);
  check("D: the old 4-argument call still works (no frames)", !legacyArgs.get(SETUP_A).get(keyOf(S1))[0].geometry.userData.degradePose);
}

// ── E — the built LOD holds the posed band ────────────────────────────────
const mat = new THREE.MeshBasicMaterial();
const placement = { landblockId: 0xa9b40001, x: 10, y: 20, z: 5, rotationZ: 0, scale: 1, source: "landblockinfo" };
{
  __setDegradePoseForTest(true);
  const chains = new Map([[0x11001018, [[BAND, 1, 35], [0, 1, MAXF]]]]);
  const out = await run(new Map([[SETUP_B, 0x11001018]]), chains, new Map([[SETUP_B, FRAME_B]]));
  const levels = out.get(SETUP_B).get(keyOf(S1));
  const full = new THREE.BufferGeometry();
  full.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  const { node, isLod } = buildSingletonNode({
    placement, modelId: SETUP_B, surfaceDid: S1, geom: full, degradedLevels: levels, mat,
    staticsShadow: false, staticsMatCastsShadow: false, staticsReceiveShadow: false,
  });
  check("E: singleton LOD built", isLod && node.levels.length === 2);
  check("E: singleton band leaf draws the posed geometry at identity", node.levels[1].object.geometry === levels[0].geometry &&
    node.levels[1].object.position.lengthSq() === 0);
  const m4 = new THREE.Matrix4();
  const inst = buildInstancedNode({
    modelId: SETUP_B, surfaceDid: S1, group: [placement, { ...placement, x: 30 }], geom: full, degradedLevels: levels, mat,
    placementMatrix: () => m4, staticsShadow: false, staticsMatCastsShadow: false, staticsReceiveShadow: false,
  });
  check("E: instanced band leaf uses the posed geometry", inst.isLod && inst.node.levels[1].object.geometry === levels[0].geometry);
}

// ── F — billboard pivot round the PART ────────────────────────────────────
{
  __setDegradePoseForTest(true);
  // a mode-5 (axis) billboard band on a part 1.085 m off the Setup origin
  const FR = Float32Array.from([0, -1.085, 0.015, 1, 0, 0, 0, 1, 1, 1]);
  const chains = new Map([[0x1100094a, [[BAND, 5, 20], [0, 1, MAXF]]]]);
  const out = await run(new Map([[SETUP_A, 0x1100094a]]), chains, new Map([[SETUP_A, FR]]));
  const g = out.get(SETUP_A).get(keyOf(S1))[0].geometry;
  check("F: the billboard band is posed too", expectPosed(g, BAND, FR) === "");
  const leaf = new THREE.Mesh(g, mat);
  const part = new THREE.Vector3(0, -1.085, 0.015);
  for (const cam of [new THREE.Vector3(30, 0, 2), new THREE.Vector3(-25, 10, 2), new THREE.Vector3(0, -40, 5)]) {
    orientBillboardLeaf(leaf, cam, 5);
    leaf.updateMatrix();
    const pivot = part.clone().applyMatrix4(leaf.matrix);
    check(`F: camera ${cam.toArray()} — the part origin stays put`, pivot.distanceTo(part) < 1e-5, pivot.toArray().join(","));
    // the leaf's +X (the card's facing axis) turns toward the camera seen from the part
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(leaf.quaternion);
    const want = cam.clone().sub(part).setZ(0).normalize();
    check(`F: camera ${cam.toArray()} — faces the camera from the part`, fwd.setZ(0).normalize().dot(want) > 0.9999);
  }
  // without a pose the leaf keeps the LOD origin (pre-fix behaviour)
  const bare = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  orientBillboardLeaf(bare, new THREE.Vector3(30, 0, 2), 5);
  check("F: an unposed leaf stays at the LOD origin", bare.position.lengthSq() === 0);
  // full billboard (mode 2) keeps the pivot too
  orientBillboardLeaf(leaf, new THREE.Vector3(20, 5, 12), 2);
  leaf.updateMatrix();
  check("F: mode 2 keeps the part origin put", part.clone().applyMatrix4(leaf.matrix).distanceTo(part) < 1e-5);
}

// ── G — bake worker + shared cache carry the frame ────────────────────────
{
  const frame = Float32Array.from(FRAME_B);
  const wasmLike = { ...makeMesh(1, [S1]), bbox: new Float32Array(6), sidesTypes: new Uint8Array(1), get degradePartFrame() { return frame.slice(); } };
  const { mesh } = serializeModelMesh(wasmLike);
  const r = reconstructModelMesh(mesh);
  check("G: bake_transfer round-trips degradePartFrame", r.degradePartFrame instanceof Float32Array && r.degradePartFrame.length === 10 &&
    Array.from(r.degradePartFrame).every((v, i) => v === frame[i]));
  const stale = reconstructModelMesh(serializeModelMesh({ ...wasmLike, degradePartFrame: undefined }).mesh);
  check("G: a stale worker (no getter) reads no frame", stale.degradePartFrame === undefined);
  const empty = reconstructModelMesh(serializeModelMesh({ ...wasmLike, degradePartFrame: new Float32Array(0) }).mesh);
  check("G: an empty frame (nothing to pose) reads no frame", empty.degradePartFrame === undefined);
  const cache = new StaticGeomCache();
  const e = cache.insert(SETUP_B, { groups: [], didDegrade: 0x11001018, degradePartFrame: frame });
  check("G: the shared cache keeps the frame for a later chain resolve", e.degradePartFrame === frame && e.degraded === null);
}

// ── H — the flag parser ───────────────────────────────────────────────────
check("H: absent → on", degradePoseEnabled("") === true && degradePoseEnabled("?foo=1") === true);
for (const v of ["off", "0", "false", "no", "OFF"]) check(`H: ${v} → off`, degradePoseEnabled(`?degradePose=${v}`) === false);
check("H: on → on", degradePoseEnabled("?degradePose=on") === true);

__setDegradePoseForTest(undefined);
__setLodCollapseDupForTest(undefined);
console.log(`statics_degrade_pose: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
