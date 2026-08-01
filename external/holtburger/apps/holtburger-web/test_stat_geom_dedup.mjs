// ?statGeomDedup (2026-08-01) — headless test for the CONTENT-KEY geometry
// dedup in scene3d/static_batch_x.js (perf-synthesis §3: "geometry is 54.9x
// duplicated because static_batch_x.js:234 dedups on OBJECT IDENTITY").
//
// Proves: exact-match opt-in reader (never the `!== "off"` idiom), flag-off is
// the untouched legacy path (source-text + behavioural), key stability across
// separately-decoded geometries, key SEPARATION for every dimension that can
// change the bytes (modelId / surfaceDid / doubleSided / partial decode /
// substituted model), the dedup map is scoped to the BUCKET object (never
// cross-bucket, never cross-region), and refcounted per-LB eviction keeps a
// shared geometry alive until the LAST landblock leaves while still removing
// exactly the departing LB's instances.
//
// Run: cd apps/holtburger-web/ && node test_stat_geom_dedup.mjs
// (needs `three` resolvable or THREE_PATH=/path/to/three.module.js)

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };

function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) return process.env.THREE_PATH;
  try { return require.resolve("three"); } catch (_) { return null; }
}
const tp = locateThree();
if (!tp) { console.log("stat-geom-dedup test: SKIP (three not located)."); process.exit(0); }
const THREE = await import("file://" + tp);

console.log("?statGeomDedup — content-key static geometry dedup");
console.log("=========================");

const SBX_PATH = resolvePath(__dirname, "scene3d/static_batch_x.js");
const STATICS_PATH = resolvePath(__dirname, "scene3d/statics.js");
const sbxSrc = readFileSync(SBX_PATH, "utf8");
const staticsSrc = readFileSync(STATICS_PATH, "utf8");

// Load static_batch_x.js with the three import stripped (module only uses THREE).
const stripped = sbxSrc
  .replace(/^\s*import\s+.*$/gm, "")
  .replace(/^\s*export\s+function\s+/gm, "function ")
  .replace(/^\s*export\s+const\s+/gm, "const ");
const factory = new Function(
  "THREE",
  stripped +
    "\n; return { statBatchChunkEnabled, __setStatBatchChunkForTest, __resetStatBatchXForTest, " +
    "statGeomDedupEnabled, __setStatGeomDedupForTest, stampStaticContentKeys, " +
    "consolidateStaticSingletonsCrossLb, evictStaticBatchXForLb, tickStatBatchXOptimize, getStatBatchXStats };"
);
const M = factory(THREE);
M.__setStatBatchChunkForTest(true);

// ---------------------------------------------------------------------------
// mocks — statics singleton geometries are NON-indexed {position, uv, normal}
// (adapter.js meshToGeometryGroups). `seed` varies the vertex CONTENT so the
// fingerprint half of the key is exercised.
// ---------------------------------------------------------------------------
function triGeom(tris = 1, seed = 0) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(tris * 9);
  for (let i = 0; i < tris; i++) {
    pos.set([seed, 0, 0, 1 + seed, 0, 0, 0, 1 + seed, 0], i * 9);
  }
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(tris * 9), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(tris * 6), 2));
  return g;
}
// A `meshToGeometryGroups` output group.
const grp = (geometry, surfaceDid, doubleSided = true) => ({ geometry, surfaceDid, doubleSided });
function singleton(surfaceDid, x, lbId, geom, mat, modelId = 0x01000001) {
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, 0, 0);
  m.userData = { modelId, surfaceDid, landblockId: lbId >>> 0 };
  return m;
}
const keyOf = (geom) => geom.userData && geom.userData.__statContentKey;

const LB1 = 0x96960000 >>> 0, LB2 = 0x97970000 >>> 0; // (150,150)/(151,151) → SAME 3x3 region
const LB3 = 0xccdd0000 >>> 0;                         // (204,221) → FAR region

// ===== 1. flag reader: exact-match opt-in, default OFF =====
M.__setStatGeomDedupForTest(undefined);
check("1: statGeomDedup defaults OFF (no ?statGeomDedup in a headless location)",
  M.statGeomDedupEnabled() === false);
{
  const body = (sbxSrc.match(/export function statGeomDedupEnabled\(\)[\s\S]*?\n}/) || [""])[0];
  check("2: reader is EXACT-match `=== \"on\"` (url-flags.md header rule)",
    /v === "on"/.test(body) && !/!==\s*"off"/.test(body) && /let on = false/.test(body),
    body.split("\n").find((l) => l.includes("on =")) || "?");
  check("3: reader is memoised + fail-soft to OFF (try/catch → on = false)",
    /_dedupFlag !== undefined/.test(body) && /catch \(_\) \{ on = false; \}/.test(body));
}

// ===== 2. stamping =====
M.__setStatGeomDedupForTest(false);
{
  const g = triGeom(2, 1);
  check("4: flag OFF stamps NOTHING (feed path can never see a key)",
    M.stampStaticContentKeys(0x01000001, [grp(g, 0x0a00)]) === 0 && keyOf(g) === undefined);
}
M.__setStatGeomDedupForTest(true);
{
  // Two INDEPENDENT decodes of the same model — the exact cross-LB case.
  const a = triGeom(2, 1), b = triGeom(2, 1);
  M.stampStaticContentKeys(0x01000001, [grp(a, 0x0a00)]);
  M.stampStaticContentKeys(0x01000001, [grp(b, 0x0a00)]);
  check("5: key is STABLE across two separately-built geometries of one model",
    typeof keyOf(a) === "string" && keyOf(a) === keyOf(b), keyOf(a));

  const other = triGeom(2, 1);
  M.stampStaticContentKeys(0x01000002, [grp(other, 0x0a00)]);
  check("6: different modelId ⇒ different key (byte-identical content must NOT fuse models)",
    keyOf(other) !== keyOf(a), `${keyOf(other)} vs ${keyOf(a)}`);

  const surf2 = triGeom(2, 1);
  M.stampStaticContentKeys(0x01000001, [grp(surf2, 0x0b00)]);
  check("7: different surfaceDid ⇒ different key", keyOf(surf2) !== keyOf(a));

  // ?perPolyCull splits one surfaceDid into a DoubleSide and a FrontSide group;
  // statics calls getCached(did) WITHOUT the side arg, so both land in ONE
  // bucket. Same identity, different triangles → must key apart.
  const dbl = triGeom(2, 1), front = triGeom(2, 1);
  M.stampStaticContentKeys(0x01000001, [grp(dbl, 0x0a00, true)]);
  M.stampStaticContentKeys(0x01000001, [grp(front, 0x0a00, false)]);
  check("8: doubleSided is part of the key (the two ?perPolyCull sidedness groups share a bucket)",
    keyOf(dbl) !== keyOf(front), `${keyOf(dbl)} vs ${keyOf(front)}`);

  // A decode-starved PARTIAL mesh (fewer tris) is accepted after the retry cap
  // — it must never be reused for, or reuse, the complete decode.
  const partial = triGeom(1, 1);
  M.stampStaticContentKeys(0x01000001, [grp(partial, 0x0a00)]);
  check("9: partial decode (fewer tris, same ids) ⇒ different key (vertex count in key)",
    keyOf(partial) !== keyOf(a), `${keyOf(partial)} vs ${keyOf(a)}`);

  // Same counts + same ids, DIFFERENT vertex content (a substituted / texture-
  // swapped variant, or any decode that is not the base one) — caught by the
  // bounded position fingerprint.
  const substituted = triGeom(2, 7);
  M.stampStaticContentKeys(0x01000001, [grp(substituted, 0x0a00)]);
  check("10: same ids + same counts but DIFFERENT vertices ⇒ different key (position fingerprint)",
    keyOf(substituted) !== keyOf(a), `${keyOf(substituted)} vs ${keyOf(a)}`);

  const before = keyOf(a);
  M.stampStaticContentKeys(0x0100dead, [grp(a, 0x0f00)]);
  check("11: re-stamping is idempotent (an already-keyed geometry is never re-keyed)",
    keyOf(a) === before);
}

// ===== 3. flag OFF is the legacy path, behaviourally =====
M.__resetStatBatchXForTest();
M.__setStatGeomDedupForTest(false);
{
  const sc = { staticsGroup: new THREE.Group() };
  const mat = new THREE.MeshBasicMaterial();
  const g1 = triGeom(2, 1), g2 = triGeom(2, 1); // identical content, 2 objects
  M.consolidateStaticSingletonsCrossLb(
    [singleton(0x0a00, 0, LB1, g1, mat), singleton(0x0a00, 1, LB1, g1, mat)], sc, LB1);
  M.consolidateStaticSingletonsCrossLb(
    [singleton(0x0a00, 2, LB2, g2, mat), singleton(0x0a00, 3, LB2, g2, mat)], sc, LB2);
  const bm = sc.staticsGroup.children[0];
  check("12: flag OFF — two LBs with identical geometry keep TWO copies (the measured bug)",
    bm.userData.gidVerts.size === 2 && bm.userData.instances === 4 && bm.userData.dedupGids === null,
    `gids=${bm.userData.gidVerts.size} instances=${bm.userData.instances}`);
  const st = M.getStatBatchXStats();
  check("13: flag OFF — zero dedup work recorded (hits/adds both 0, enabled false)",
    st.dedup.enabled === false && st.dedup.hits === 0 && st.dedup.adds === 0,
    JSON.stringify(st.dedup));
}

// ===== 4. flag ON — the cross-LB copy collapses =====
M.__resetStatBatchXForTest();
M.__setStatGeomDedupForTest(true);
const sc = { staticsGroup: new THREE.Group() };
const matA = new THREE.MeshBasicMaterial();
let bmA;
{
  // Two LBs in the SAME region decode the same model independently.
  const gLb1 = triGeom(2, 1), gLb2 = triGeom(2, 1);
  M.stampStaticContentKeys(0x01000001, [grp(gLb1, 0x0a00)]);
  M.stampStaticContentKeys(0x01000001, [grp(gLb2, 0x0a00)]);
  const n1 = [];
  for (let i = 0; i < 5; i++) n1.push(singleton(0x0a00, i, LB1, gLb1, matA));
  const n2 = [];
  for (let i = 0; i < 4; i++) n2.push(singleton(0x0a00, 100 + i, LB2, gLb2, matA));
  const r1 = M.consolidateStaticSingletonsCrossLb(n1, sc, LB1);
  const r2 = M.consolidateStaticSingletonsCrossLb(n2, sc, LB2);
  bmA = sc.staticsGroup.children.find((c) => c.isBatchedMesh);
  check("14: flag ON — the second LB REUSES the geometry id (1 copy, not 2)",
    !!r1 && !!r2 && bmA.userData.gidVerts.size === 1,
    `gids=${bmA.userData.gidVerts.size}`);
  check("15: every placement still gets its OWN instance (9 = 5 + 4)",
    bmA.userData.instances === 9 && bmA.instanceCount === 9,
    `instances=${bmA.userData.instances} instanceCount=${bmA.instanceCount}`);
  check("16: per-instance matrices are untouched by the reuse (x = 0..4 and 100..103)", (() => {
    const mtmp = new THREE.Matrix4();
    const xs = [];
    for (let i = 0; i < bmA._instanceInfo.length; i++) {
      if (bmA._instanceInfo[i] && bmA._instanceInfo[i].active) {
        bmA.getMatrixAt(i, mtmp); xs.push(Math.round(mtmp.elements[12]));
      }
    }
    xs.sort((a, b) => a - b);
    return xs.length === 9 && xs[0] === 0 && xs[4] === 4 && xs[5] === 100 && xs[8] === 103;
  })());
  check("17: every instance points at the ONE shared geometry id", (() => {
    const gids = new Set();
    for (const inf of bmA._instanceInfo) if (inf && inf.active) gids.add(inf.geometryIndex);
    return gids.size === 1;
  })());
  const st = M.getStatBatchXStats();
  check("18: dedup counters attribute the win (1 add, 1 hit)",
    st.dedup.enabled === true && st.dedup.adds === 1 && st.dedup.hits === 1,
    JSON.stringify(st.dedup));
  check("19: bucket census reports gids vs distinct content keys (the duplication factor)",
    st.detail[0].gids === 1 && st.detail[0].dedupGids === 1,
    JSON.stringify({ gids: st.detail[0].gids, dedupGids: st.detail[0].dedupGids }));
}

// ===== 5. the map is scoped to the BUCKET object =====
{
  const matB = new THREE.MeshBasicMaterial();
  const gSameContent = triGeom(2, 1);
  M.stampStaticContentKeys(0x01000001, [grp(gSameContent, 0x0a00)]); // SAME key as bmA's
  M.consolidateStaticSingletonsCrossLb(
    [singleton(0x0a00, 7, LB1, gSameContent, matB), singleton(0x0a00, 8, LB1, gSameContent, matB)],
    sc, LB1);
  const bmB = sc.staticsGroup.children.find((c) => c.material === matB);
  check("20: a DIFFERENT material bucket never reuses another bucket's id (own dedupGids map)",
    !!bmB && bmB !== bmA && bmB.userData.gidVerts.size === 1 && bmB.userData.dedupGids.size === 1 &&
      bmB.userData.dedupGids !== bmA.userData.dedupGids,
    `bmB gids=${bmB && bmB.userData.gidVerts.size}`);

  const gFar = triGeom(2, 1);
  M.stampStaticContentKeys(0x01000001, [grp(gFar, 0x0a00)]);
  M.consolidateStaticSingletonsCrossLb(
    [singleton(0x0a00, 9, LB3, gFar, matA), singleton(0x0a00, 10, LB3, gFar, matA)], sc, LB3);
  const bmFar = sc.staticsGroup.children.find((c) => /^static-batch-c-r68x73-/.test(c.name));
  check("21: a FAR region gets its OWN bucket + its OWN copy (chunk bounds preserved)",
    !!bmFar && bmFar !== bmA && bmFar.userData.gidVerts.size === 1,
    `far=${bmFar && bmFar.name}`);
  check("22: the map lives on the bucket userData, so it dies with the BatchedMesh (no cross-LB leak)",
    bmA.userData.dedupGids instanceof Map && bmFar.userData.dedupGids instanceof Map &&
      bmA.userData.dedupGids !== bmFar.userData.dedupGids &&
      /ud\.dedupGids \|\| \(ud\.dedupGids = new Map\(\)\)/.test(sbxSrc));
  M.evictStaticBatchXForLb(LB3);
}

// ===== 6. refcounted eviction — the correctness core =====
{
  M.evictStaticBatchXForLb(LB1);
  check("23: evict(LB1) removes EXACTLY LB1's 5 instances; LB2's 4 survive",
    bmA.userData.instances === 4 && bmA.instanceCount === 4,
    `instances=${bmA.userData.instances}`);
  check("24: the SHARED geometry survives its first LB (refcount, not deleteGeometry cascade)",
    bmA.userData.gidVerts.size === 1 && bmA.userData.deadVerts === 0 &&
      bmA.userData.dedupGids.size === 1,
    `gids=${bmA.userData.gidVerts.size} dead=${bmA.userData.deadVerts}`);
  check("25: the survivors are LB2's placements, matrices intact (x = 100..103)", (() => {
    const mtmp = new THREE.Matrix4();
    const xs = [];
    for (let i = 0; i < bmA._instanceInfo.length; i++) {
      if (bmA._instanceInfo[i] && bmA._instanceInfo[i].active) {
        bmA.getMatrixAt(i, mtmp); xs.push(Math.round(mtmp.elements[12]));
      }
    }
    xs.sort((a, b) => a - b);
    return xs.length === 4 && xs[0] === 100 && xs[3] === 103;
  })());

  M.evictStaticBatchXForLb(LB2);
  check("26: evict of the LAST referencing LB deletes the geometry + drops the key",
    bmA.userData.instances === 0 && bmA.instanceCount === 0 &&
      bmA.userData.gidVerts.size === 0 && bmA.userData.dedupGids.size === 0 &&
      bmA.userData.deadVerts === 6,
    `gids=${bmA.userData.gidVerts.size} keys=${bmA.userData.dedupGids.size} dead=${bmA.userData.deadVerts}`);
  check("27: the bucket itself is never removed/disposed per-LB (it spans the region)",
    sc.staticsGroup.children.includes(bmA));
  M.tickStatBatchXOptimize();
  check("28: lazy optimize() still reclaims the freed extent after a dedup eviction",
    bmA.userData.deadVerts === 0, `used=${bmA.userData.usedVerts}`);
}

// ===== 7. re-feed idempotence under dedup =====
{
  M.__resetStatBatchXForTest();
  const s2 = { staticsGroup: new THREE.Group() };
  const mat = new THREE.MeshBasicMaterial();
  const mk = () => {
    const g = triGeom(2, 3);
    M.stampStaticContentKeys(0x01000009, [grp(g, 0x0e00)]);
    return [singleton(0x0e00, 0, LB1, g, mat), singleton(0x0e00, 1, LB1, g, mat), singleton(0x0e00, 2, LB1, g, mat)];
  };
  M.consolidateStaticSingletonsCrossLb(mk(), s2, LB1);
  const a1 = M.getStatBatchXStats();
  M.consolidateStaticSingletonsCrossLb(mk(), s2, LB1); // re-bake, no evict between
  const a2 = M.getStatBatchXStats();
  const bm = s2.staticsGroup.children[0];
  check("29: re-feeding the same LB replaces rather than appends (instances 3, 1 gid, 1 key)",
    a1.instances === 3 && a2.instances === 3 && bm.userData.gidVerts.size === 1 &&
      bm.userData.dedupGids.size === 1 && a2.lbsFed === 1,
    `after1=${a1.instances} after2=${a2.instances} gids=${bm.userData.gidVerts.size}`);
}

// ===== 8. unstamped geometry under flag ON falls through to the legacy path =====
{
  M.__resetStatBatchXForTest();
  const s3 = { staticsGroup: new THREE.Group() };
  const mat = new THREE.MeshBasicMaterial();
  const gU1 = triGeom(2, 1), gU2 = triGeom(2, 1); // identical, but NO stamp
  M.consolidateStaticSingletonsCrossLb(
    [singleton(0x0a00, 0, LB1, gU1, mat), singleton(0x0a00, 1, LB1, gU1, mat)], s3, LB1);
  M.consolidateStaticSingletonsCrossLb(
    [singleton(0x0a00, 2, LB2, gU2, mat), singleton(0x0a00, 3, LB2, gU2, mat)], s3, LB2);
  const bm = s3.staticsGroup.children[0];
  check("30: unkeyed geometry keeps the legacy per-feed identity behaviour (2 gids, no map entry)",
    bm.userData.gidVerts.size === 2 && bm.userData.instances === 4 &&
      (bm.userData.dedupGids === null || bm.userData.dedupGids.size === 0),
    `gids=${bm.userData.gidVerts.size}`);
  M.evictStaticBatchXForLb(LB1);
  check("31: legacy cascade eviction still applies to unkeyed ids (LB1 gone, LB2 intact)",
    bm.userData.instances === 2 && bm.instanceCount === 2 && bm.userData.deadVerts === 6,
    `instances=${bm.userData.instances} dead=${bm.userData.deadVerts}`);
}

// ===== 9. source-text: the flag-off path is untouched =====
{
  check("32: the feed reads the flag ONCE per feed, not per node",
    /const dedupOn = statGeomDedupEnabled\(\);/.test(sbxSrc) &&
      (sbxSrc.match(/statGeomDedupEnabled\(\)/g) || []).length <= 4);
  check("33: no key lookup happens on the flag-off path (`dedupOn ? _contentKeyOf` guard)",
    /const ckey = dedupOn \? _contentKeyOf\(m\.geometry\) : null;/.test(sbxSrc));
  check("34: eviction branches on the record, so an unkeyed record takes the byte-identical legacy path",
    /if \(m\.entry\) \{/.test(sbxSrc) && /let removedInstances = 0;/.test(sbxSrc));
  check("35: deleteGeometry only runs at refs.size === 0 (never cascades another LB's instances)",
    /m\.entry\.refs\.delete\(key\);/.test(sbxSrc) &&
      /if \(m\.entry\.refs\.size === 0\) \{[\s\S]{0,200}deleteGeometry\(m\.gid\)/.test(sbxSrc));
  check("36: this LB's instances are removed individually via deleteInstance",
    /m\.bm\.deleteInstance\(iid\)/.test(sbxSrc));
  check("37: the instance id is recorded BEFORE setMatrixAt (a throw cannot orphan it)",
    /if \(rec\) rec\.iids\.push\(iid\);\s*\n\s*bm\.setMatrixAt/.test(sbxSrc));
}

// ===== 10. statics.js wiring =====
{
  check("38: statics.js imports the stamper from static_batch_x.js",
    /import \{[^}]*stampStaticContentKeys[^}]*\} from "\.\/static_batch_x\.js";/.test(staticsSrc));
  const fn = (staticsSrc.match(/async function fetchPrimaryGeometries\([\s\S]*?\n\}/) || [""])[0];
  check("39: the stamp sits in fetchPrimaryGeometries — the ONE decode seam both bakers share",
    /stampStaticContentKeys\(id, groups\);/.test(fn) &&
      /const primary = await fetchPrimaryGeometries\(uniqueModelIds, mmFetch\);/.test(staticsSrc) &&
      (staticsSrc.match(/await fetchPrimaryGeometries\(/g) || []).length === 2,
    `callers=${(staticsSrc.match(/await fetchPrimaryGeometries\(/g) || []).length}`);
  check("40: the stamp is per (model, surface) — inside the per-model loop, never per placement",
    /const \{ groups \} = meshToGeometryGroups\(m\);[\s\S]{0,700}stampStaticContentKeys\(id, groups\);/.test(fn) &&
      !/stampStaticContentKeys/.test(staticsSrc.slice(staticsSrc.indexOf("function buildSingletonNode"))));
}

console.log("=========================");
console.log(`stat-geom-dedup test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
