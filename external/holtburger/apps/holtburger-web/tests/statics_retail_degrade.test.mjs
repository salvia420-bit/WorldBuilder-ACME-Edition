// ?retailDegrade=on (scene3d/statics.js, OPT-IN, default OFF) — statics
// THREE.LOD switch-ins from retail GfxObjDegradeInfo::get_degrade
// (acclient.c:332356): d' = max(|d| / scale - 50, 0) (Render::s_rDegradeDistance,
// :45516), first level with d' < ideal + (max - ideal) * deg_mul, the last
// level past the end; deg_mul = RETAIL_DEG_MUL (1.0).
//
// Pins:
//   A  0x11000001 shape (self 10/25/50, self 25/50/100, L2 50/100/200, NULL):
//      deg_mul 1 → base 0..150 m then L2; scale 2 → L2 from 300 m; deg_mul 0
//      → L2 from 100 m. levelOfBand = [0, 0, 1, 1] (NULL keeps L2 drawing).
//   B  a non-monotone chain drops the never-picked middle level; a
//      non-monotone LAST level still draws (retail walks off the end).
//   C  parity sweep: for d in 0..400 m (0.25 m steps), the level a real
//      THREE.LOD picks from the returned switch-ins == levelOfBand[
//      selectDegradeLevel(levels, d / scale, degMul)] (part_degrade.js, the
//      decomp port) — many chains, deg_mul 1 / 0 / -1, scale 1 / 2 / 0.5.
//   D  the real fetchDegradedGeometries + buildSingletonNode /
//      buildInstancedNode under the flag: built LOD distances and the drawn
//      geometry per distance.
//   E  a chain that folds entirely into the base keeps one PARKED level (the
//      node stays a THREE.LOD; level 0 draws at every distance).
//   F  billboard-mode and band-0-is-not-the-base edges.
//   G  flag OFF: the legacy bandSwapDistances output and the built LOD are
//      byte-identical (pinned arrays); flag-off entries carry no retail keys.
//   H  the flag parser (exact `=on`) + stats + RETAIL_DEG_MUL source.
import * as THREE from "three";
import {
  __lodTestSeams,
  __retailDegradeTestSeams,
  __setLodCollapseDupForTest,
  __setRetailDegradeForTest,
  retailBandSwapDistances,
  retailDegradeEnabled,
  retailDegradeStats,
  RETAIL_DEGRADE_PARKED,
} from "../scene3d/statics.js";
import * as partDegrade from "../scene3d/part_degrade.js";
import { meshToGeometryGroups } from "../scene3d/adapter.js";

const { selectDegradeLevel } = partDegrade;
// render-perf-4's constant; statics.js falls back to 1.0 without it.
const RETAIL_DEG_MUL = typeof partDegrade.RETAIL_DEG_MUL === "number" ? partDegrade.RETAIL_DEG_MUL : 1.0;

const { fetchDegradedGeometries, buildSingletonNode, buildInstancedNode } = __lodTestSeams;
const { bandSwapDistances } = __retailDegradeTestSeams;

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) pass += 1;
  else { fail += 1; console.error(`FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}
const FLT_MAX = 3.4028234663852886e38;
const L = (gfx, min, ideal, max, mode = 1) => ({ gfx, mode, min, ideal, max });

// The level index a real THREE.LOD (hysteresis 0) draws at distance d.
function lodFor(dists) {
  const lod = new THREE.LOD();
  const objs = [new THREE.Object3D()];
  lod.addLevel(objs[0], 0);
  for (const dist of dists) {
    const o = new THREE.Object3D();
    objs.push(o);
    lod.addLevel(o, dist);
  }
  return (d) => objs.indexOf(lod.getObjectForDistance(d));
}

const M = 0x0100376a, L2 = 0x010037a7, X = 0x01003770, Y = 0x01003771;
const SHAPE = [L(M, 10, 25, 50), L(M, 25, 50, 100), L(L2, 50, 100, 200), L(0, FLT_MAX, FLT_MAX, FLT_MAX)];

// ── A — the 0x11000001 shape ───────────────────────────────────────────
{
  const r1 = retailBandSwapDistances(SHAPE, M, 1, 1);
  check("A: deg_mul 1 → one level after the base", r1.levels.length === 1, JSON.stringify(r1.levels));
  check("A: that level is L2 (band 2)", r1.levels[0]?.gfx === L2 && r1.levels[0]?.band === 2);
  check("A: L2 from 150 m (50 + max_1 100)", r1.levels[0]?.dist === 150, String(r1.levels[0]?.dist));
  check("A: levelOfBand = [0,0,1,1]", r1.levelOfBand.join() === "0,0,1,1", r1.levelOfBand.join());
  const r2 = retailBandSwapDistances(SHAPE, M, 1, 2);
  check("A: scale 2 → L2 from 300 m", r2.levels.length === 1 && r2.levels[0].dist === 300, JSON.stringify(r2.levels));
  const r0 = retailBandSwapDistances(SHAPE, M, 0, 1);
  check("A: deg_mul 0 → L2 from 100 m (50 + ideal_1 50)", r0.levels.length === 1 && r0.levels[0].dist === 100, JSON.stringify(r0.levels));
  const rd = retailBandSwapDistances(SHAPE, M);
  check("A: default deg_mul is RETAIL_DEG_MUL (150 m)", rd.levels[0]?.dist === 150);
  const pick = lodFor(r1.levels.map((l) => l.dist));
  check("A: THREE.LOD draws the base at 149.75 m", pick(149.75) === 0);
  check("A: THREE.LOD draws L2 at 150 m", pick(150) === 1);
  check("A: retail picks band 1 (base) at 149.75 m", selectDegradeLevel(SHAPE, 149.75, 1) === 1);
  check("A: retail picks band 2 (L2) at 150 m", selectDegradeLevel(SHAPE, 150, 1) === 2);
}

// ── B — never-picked levels ────────────────────────────────────────────
{
  // T = 100, 50, 200 at deg_mul 1: band 1 is never picked.
  const chain = [L(M, 100, 100, 100), L(X, 50, 50, 50), L(Y, 200, 200, 200)];
  const r = retailBandSwapDistances(chain, M, 1, 1);
  check("B: unreachable middle level dropped", r.levels.length === 1 && r.levels[0].gfx === Y, JSON.stringify(r.levels));
  check("B: Y from 50 + 100 = 150 m", r.levels[0]?.dist === 150);
  check("B: levelOfBand = [0,-1,1]", r.levelOfBand.join() === "0,-1,1", r.levelOfBand.join());
  // A non-monotone LAST level still draws: retail walks off the end to it.
  const last = retailBandSwapDistances([L(M, 100, 100, 100), L(X, 50, 50, 50)], M, 1, 1);
  check("B: non-monotone last level kept at 150 m", last.levels.length === 1 && last.levels[0].gfx === X && last.levels[0].dist === 150, JSON.stringify(last.levels));
  // Threshold <= 0 on band 0: band 1 draws from 0 m.
  const zero = retailBandSwapDistances([L(X, 0, 0, 0), L(Y, 10, 20, 30)], M, 1, 1);
  check("B: T_0 <= 0 → band 1 from 0 m", zero.levels.length === 1 && zero.levels[0].gfx === Y && zero.levels[0].dist === 0, JSON.stringify(zero.levels));
  check("B: T_0 <= 0 → band 0 never picked", zero.levelOfBand[0] === -1);
}

// ── C — parity sweep against part_degrade.js selectDegradeLevel ─────────
{
  const human = [L(M, 0, 3, 3), L(X, 3, 5, 5), L(Y, 5, 7, 7), L(L2, 7, 15, 15), L(X, 15, 84, 84), L(0, 84, FLT_MAX, FLT_MAX)];
  const chains = {
    shape: SHAPE,
    nonMonotone: [L(M, 100, 100, 100), L(X, 50, 50, 50), L(Y, 200, 200, 200), L(0, 300, 300, 300)],
    human,
    nullMiddle: [L(M, 10, 20, 40), L(0, 20, 40, 60), L(X, 40, 80, 120), L(0, 120, FLT_MAX, FLT_MAX)],
    baseAgain: [L(M, 10, 20, 30), L(X, 20, 40, 60), L(M, 40, 80, 120), L(Y, 80, 160, 240)],
    band0NotBase: [L(X, 10, 25, 50), L(M, 25, 50, 100), L(Y, 50, 100, 200)],
    zeroFirst: [L(X, 0, 0, 0), L(M, 10, 20, 30), L(Y, 30, 60, 90)],
    billboard: [L(M, 10, 25, 50, 1), L(M, 25, 50, 100, 4), L(X, 50, 100, 200, 4)],
    single: [L(M, 10, 25, 50)],
    singleOther: [L(X, 10, 25, 50)],
    allBase: [L(M, 10, 25, 50), L(M, 25, 50, 100), L(0, FLT_MAX, FLT_MAX, FLT_MAX)],
  };
  let samples = 0, mismatches = 0;
  for (const [name, chain] of Object.entries(chains)) {
    for (const degMul of [1, 0, -1, 0.5]) {
      for (const scale of [1, 2, 0.5]) {
        const r = retailBandSwapDistances(chain, M, degMul, scale);
        const dists = r.levels.map((l) => l.dist);
        let ascending = true;
        for (let i = 1; i < dists.length; i += 1) if (!(dists[i] > dists[i - 1])) ascending = false;
        check(`C: ${name} dm${degMul} s${scale} switch-ins ascending`, ascending, dists.join());
        const pick = lodFor(dists);
        let firstBad = null;
        for (let q = 0; q <= 1600; q += 1) {
          const d = q * 0.25;
          const want = r.levelOfBand[selectDegradeLevel(chain, d / scale, degMul)];
          const got = pick(d);
          samples += 1;
          if (got !== want) {
            mismatches += 1;
            if (!firstBad) firstBad = `d=${d} lod=${got} retail=${want}`;
          }
        }
        check(`C: ${name} dm${degMul} s${scale} THREE.LOD == retail pick`, firstBad === null, firstBad || "");
        // Every drawn level shows the GfxObj retail shows (NULL → the level before).
        for (let i = 0; i < chain.length; i += 1) {
          const lv = r.levelOfBand[i];
          if (lv < 0 || chain[i].gfx === 0) continue;
          const gfx = lv === 0 ? M : r.levels[lv - 1].gfx;
          check(`C: ${name} dm${degMul} s${scale} band ${i} draws its own GfxObj`, gfx === chain[i].gfx, `${gfx.toString(16)} vs ${chain[i].gfx.toString(16)}`);
        }
      }
    }
  }
  check("C: sweep covered every sample", samples === 11 * 4 * 3 * 1601 && mismatches === 0, `${samples} samples, ${mismatches} mismatches`);
}

// ── stub wasm ModelMesh (as tests/lod_collapse_dup.test.mjs) ───────────
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
    triCount: tris, positions, normals, uvs,
    surfaceIndices: sIdx, surfaces: Uint32Array.from(surfaces),
    didDegrade: 0, decodeMisses: 0, free() {},
  };
}
const S1 = 0x08000101, S2 = 0x08000102;
const MESHES = new Map([
  [M, () => makeMesh(1, [S1])],
  [L2, () => makeMesh(2, [S1])],
  [X, () => makeMesh(3, [S1])],
  [Y, () => makeMesh(4, [S1])],
]);
const fetchModelMeshes = async (ids) => Array.from(ids, (id) => (MESHES.get(id >>> 0) || (() => null))());
const CHAIN_ID = 0x11000001;
function chainFetcher(levels) {
  return async () => JSON.stringify({
    id: CHAIN_ID,
    degrades: levels.map((l) => ({
      gfx_obj_id: l.gfx, degrade_mode: l.mode, min_dist: l.min, ideal_dist: l.ideal, max_dist: l.max,
    })),
  });
}
const keyOf = (did) => `${did >>> 0}|1`; // degradedSurfaceKey(did, doubleSided=true)
async function run(retail, collapse, modelId, levels, withBase = true) {
  __setRetailDegradeForTest(retail);
  __setLodCollapseDupForTest(collapse);
  const base = withBase ? new Map([[modelId, meshToGeometryGroups(MESHES.get(modelId)()).groups]]) : null;
  const res = await fetchDegradedGeometries(new Map([[modelId, CHAIN_ID]]), fetchModelMeshes, chainFetcher(levels), base);
  return { res, base };
}
const mat = new THREE.MeshBasicMaterial();
const placementAt = (scale) => ({ landblockId: 0xa9b40001, x: 10, y: 20, z: 5, rotationZ: 0, scale, source: "scenery" });
function singleton(modelId, geom, levels, scale = 1) {
  return buildSingletonNode({
    placement: placementAt(scale), modelId, surfaceDid: S1, geom, degradedLevels: levels, mat,
    staticsShadow: false, staticsMatCastsShadow: false, staticsReceiveShadow: false,
  });
}
function instanced(modelId, geom, levels) {
  const m4 = new THREE.Matrix4();
  return buildInstancedNode({
    modelId, surfaceDid: S1, group: [placementAt(1), { ...placementAt(2), x: 30 }], geom, degradedLevels: levels, mat,
    placementMatrix: () => m4, staticsShadow: false, staticsMatCastsShadow: false, staticsReceiveShadow: false,
  });
}
const posOf = (g) => Array.from(g.attributes.position.array).join();
const freshPos = (id) => posOf(meshToGeometryGroups(MESHES.get(id)()).groups[0].geometry);

// ── D — the real fetch + node builders under the flag ──────────────────
{
  const before = retailDegradeStats();
  const { res, base } = await run(true, true, M, SHAPE);
  const list = res.get(M)?.get(keyOf(S1));
  check("D: one level (L2) — self bands not cloned", list && list.length === 1, list ? String(list.length) : "none");
  check("D: level is L2's geometry", list && posOf(list[0].geometry) === freshPos(L2));
  check("D: scale-1 switch-in 150 + retailBand 2", list && list[0].dist === 150 && list[0].retailBand === 2 && !list[0].parked);
  const after = retailDegradeStats();
  check("D: stats count chain / level / 2 folded / 1 NULL kept",
    after.chains - before.chains === 1 && after.levels - before.levels === 1 &&
      after.folded - before.folded === 2 && after.nullKept - before.nullKept === 1,
    JSON.stringify({ before, after }));
  const baseGeom = base.get(M)[0].geometry;
  const s1 = singleton(M, baseGeom, list, 1);
  check("D: singleton scale 1 LOD = [0,150]", s1.isLod && s1.node.levels.map((l) => l.distance).join() === "0,150");
  const s2 = singleton(M, baseGeom, list, 2);
  check("D: singleton scale 2 LOD = [0,300]", s2.isLod && s2.node.levels.map((l) => l.distance).join() === "0,300");
  check("D: hysteresis 0 on every level", s2.node.levels.every((l) => l.hysteresis === 0));
  // Drawn geometry per distance == the GfxObj retail draws (scale 2).
  const r = retailBandSwapDistances(SHAPE, M, RETAIL_DEG_MUL, 2);
  let bad = null;
  for (let q = 0; q <= 1600 && !bad; q += 1) {
    const d = q * 0.25;
    const lv = r.levelOfBand[selectDegradeLevel(SHAPE, d / 2, RETAIL_DEG_MUL)];
    const wantGeom = lv === 0 ? baseGeom : list[lv - 1].geometry;
    if (s2.node.getObjectForDistance(d).geometry !== wantGeom) bad = `d=${d}`;
  }
  check("D: singleton draws retail's GfxObj at every distance (scale 2)", bad === null, bad || "");
  const inst = instanced(M, baseGeom, list);
  check("D: instanced LOD = [0,150] (scale 1)", inst.isLod && inst.node.levels.map((l) => l.distance).join() === "0,150");
}

// ── E — a chain folding entirely into the base parks one level ─────────
{
  const allBase = [L(M, 10, 25, 50), L(M, 25, 50, 100), L(0, FLT_MAX, FLT_MAX, FLT_MAX)];
  const before = retailDegradeStats();
  const { res, base } = await run(true, true, M, allBase);
  const list = res.get(M)?.get(keyOf(S1));
  check("E: one parked level", list && list.length === 1 && list[0].parked === true && list[0].dist === RETAIL_DEGRADE_PARKED);
  check("E: parked level has billboard mode 0", list && list[0].degradeMode === 0);
  check("E: stats count the parked list", retailDegradeStats().parked - before.parked === 1);
  const baseGeom = base.get(M)[0].geometry;
  for (const scale of [1, 3]) {
    const s = singleton(M, baseGeom, list, scale);
    check(`E: scale ${scale} node stays a THREE.LOD`, s.isLod && s.node.isLOD);
    check(`E: scale ${scale} parked switch-in unscaled`, s.node.levels[1].distance === RETAIL_DEGRADE_PARKED);
    check(`E: scale ${scale} base drawn at 0 / 400 / 1e9 m`,
      [0, 400, 1e9].every((d) => s.node.getObjectForDistance(d).geometry === baseGeom));
    // THREE.LOD.update leaves the parked level hidden.
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(1e6, 0, 0);
    cam.updateMatrixWorld(true);
    s.node.updateMatrixWorld(true);
    s.node.update(cam);
    check(`E: scale ${scale} update hides the parked level`, s.node.levels[0].object.visible === true && s.node.levels[1].object.visible === false);
  }
  const inst = instanced(M, baseGeom, list);
  check("E: instanced node stays a THREE.LOD", inst.isLod && inst.node.levels[1].distance === RETAIL_DEGRADE_PARKED);
}

// ── F — edges ──────────────────────────────────────────────────────────
{
  // A billboard band naming the base is a level of its own (base draws unrotated).
  const bb = [L(M, 10, 25, 50, 1), L(M, 25, 50, 100, 4), L(X, 50, 100, 200, 4)];
  const r = retailBandSwapDistances(bb, M, 1, 1);
  check("F: billboard self band kept (mode 4)", r.levels.length === 2 && r.levels[0].gfx === M && r.levels[0].mode === 4 && r.levels[0].dist === 100, JSON.stringify(r.levels));
  check("F: next billboard band after it at 150 m", r.levels[1]?.gfx === X && r.levels[1]?.dist === 150);
  const { res, base } = await run(true, true, M, bb);
  const list = res.get(M)?.get(keyOf(S1));
  const s = singleton(M, base.get(M)[0].geometry, list, 1);
  check("F: built billboard LOD = [0,100,150] tagged mode 4", s.isLod && s.node.levels.map((l) => l.distance).join() === "0,100,150" && s.node.userData.billboardMode === 4,
    s.node.levels.map((l) => l.distance).join());
  // Band 0 is not the base: retail draws band 0 from 0 m.
  const other = [L(X, 10, 25, 50), L(M, 25, 50, 100)];
  const ro = retailBandSwapDistances(other, M, 1, 1);
  check("F: band-0-not-base → X at 0, base back at 100 m", ro.levels.length === 2 && ro.levels[0].gfx === X && ro.levels[0].dist === 0 && ro.levels[1].gfx === M && ro.levels[1].dist === 100, JSON.stringify(ro.levels));
  const { res: res2, base: base2 } = await run(true, true, M, other);
  const l2 = res2.get(M)?.get(keyOf(S1));
  const s2 = singleton(M, base2.get(M)[0].geometry, l2, 1);
  check("F: band-0-not-base LOD draws X at 0 m", s2.isLod && posOf(s2.node.getObjectForDistance(0).geometry) === freshPos(X));
  // Malformed numbers never throw; NaN thresholds stop the walk like retail's compare.
  const nan = retailBandSwapDistances([L(M, 10, NaN, 50), L(X, 10, 20, 30)], M, 1, 1);
  check("F: NaN threshold → the walk never passes it", nan.levels.length === 0 && nan.levelOfBand.join() === "0,-1", JSON.stringify(nan));
  check("F: NaN parity", selectDegradeLevel([L(M, 10, NaN, 50), L(X, 10, 20, 30)], 1e6, 1) === 0);
  check("F: empty / junk input → no levels", retailBandSwapDistances(null, M).levels.length === 0 && retailBandSwapDistances([], M).levelOfBand.length === 0);
  // Missing surface in an emitted band keeps the earlier level for that surface.
  const M2 = 0x01004000;
  MESHES.set(M2, () => makeMesh(5, [S1, S2]));
  const { res: res3 } = await run(true, true, M2, [L(M2, 10, 25, 50), L(L2, 25, 50, 100)]);
  const r3 = res3.get(M2);
  check("F: S1 gets L2 at 100 m", r3?.get(keyOf(S1))?.length === 1 && r3.get(keyOf(S1))[0].dist === 100);
  check("F: S2 (absent from L2) keeps a parked level", r3?.get(keyOf(S2))?.length === 1 && r3.get(keyOf(S2))[0].parked === true);
}

// ── G — flag OFF is the legacy path, byte-identical ────────────────────
{
  check("G: bandSwapDistances authored", bandSwapDistances([{ dist: 10 }, { dist: 25 }, { dist: 50 }]).join() === "10,25,50");
  check("G: bandSwapDistances unauthored fallback", bandSwapDistances([{ dist: null }, { dist: 0 }]).join() === "100,200");
  const bumped = bandSwapDistances([{ dist: 24 }, { dist: 20 }, { dist: 80 }]);
  check("G: bandSwapDistances bump", bumped.length === 3 && bumped[0] === 24 && bumped[1] === 24 + 0.001 && bumped[2] === 80, bumped.join());
  const { res: offNoCollapse, base } = await run(false, false, M, SHAPE);
  const lnc = offNoCollapse.get(M).get(keyOf(S1));
  check("G: off (collapse off) keeps the 3 band levels at min_dist", lnc.map((l) => l.dist).join() === "10,25,50");
  check("G: off entries carry exactly geometry/dist/degradeMode",
    lnc.every((l) => Object.keys(l).join() === "geometry,dist,degradeMode"));
  const baseGeom = base.get(M)[0].geometry;
  check("G: off singleton LOD = [0,10,25,50] (scale 2 ignored)",
    singleton(M, baseGeom, lnc, 2).node.levels.map((l) => l.distance).join() === "0,10,25,50");
  const { res: offCollapse } = await run(false, true, M, SHAPE);
  const lc = offCollapse.get(M).get(keyOf(S1));
  check("G: off (?lodCollapseDup default) singleton LOD = [0,50]",
    singleton(M, baseGeom, lc, 1).node.levels.map((l) => l.distance).join() === "0,50");
  check("G: off instanced LOD = [0,10,25,50]",
    instanced(M, baseGeom, lnc).node.levels.map((l) => l.distance).join() === "0,10,25,50");
  check("G: retailLevelSwapDistances ignores legacy lists",
    __retailDegradeTestSeams.retailLevelSwapDistances(lnc, 2) === null);
}

// ── H — flag parser / stats / constants ────────────────────────────────
check("H: absent → off", retailDegradeEnabled("") === false);
check("H: =on → on", retailDegradeEnabled("?retailDegrade=on") === true);
check("H: =on among others → on", retailDegradeEnabled("?nosw=1&retailDegrade=on") === true);
check("H: =1 → off (exact opt-in)", retailDegradeEnabled("?retailDegrade=1") === false);
check("H: =ON → off (exact opt-in)", retailDegradeEnabled("?retailDegrade=ON") === false);
check("H: =off → off", retailDegradeEnabled("?retailDegrade=off") === false);
check("H: no location in node → off", retailDegradeEnabled(undefined) === false);
__setRetailDegradeForTest(undefined);
const st = retailDegradeStats();
check("H: stats report the flag OFF by default", st.enabled === false);
check("H: stats deg_mul = part_degrade RETAIL_DEG_MUL", st.degMul === RETAIL_DEG_MUL && RETAIL_DEG_MUL === 1);
check("H: parked switch-in is Number.MAX_VALUE", RETAIL_DEGRADE_PARKED === Number.MAX_VALUE);

console.log(`statics_retail_degrade: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
