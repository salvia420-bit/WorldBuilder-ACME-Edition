// ?statBatchValueKey (2026-08-06) — headless test for VALUE-keyed bucket
// merging in scene3d/static_batch_x.js.
//
// The claim under test is a correctness claim, not a perf one (the flag is worth
// ~6 drawn buckets ≈ 0.24 ms on the 1070 — see the module header for the
// measurement that corrected the 1.3 ms it was commissioned on). A BatchedMesh
// applies ONE material to EVERY instance, so a merge is only legal when the
// surviving material renders every member identically. This file proves the key
// is a superset of what three r184 reads off a material: two equal-by-value
// materials share a bucket, and materials differing in ANY single keyed field —
// program-cache fields, `WebGLState.setMaterial` bound state, per-material
// uniform values, texture identity, our onBeforeCompile patch flags, userData —
// do NOT. Plus the lifetime half: evicting one member's landblock leaves the
// others intact, and reaping an empty merged bucket removes EVERY object key
// that resolved to it (a survivor would hand a disposed BatchedMesh to the next
// feed).
//
// Run: cd apps/holtburger-web/ && node test_stat_batch_value_key.mjs
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
if (!tp) { console.log("stat-batch-value-key test: SKIP (three not located)."); process.exit(0); }
const THREE = await import("file://" + tp);

console.log("?statBatchValueKey — value-keyed static batch bucket merging");
console.log("=========================");

// The REAL batched-material variant (batched_material_variant.js, default-ON
// since 2026-10-06): the import strip below would otherwise leave the module's
// `typeof batchedMaterialFor === "function"` seams false, and every bucket would
// draw its member directly — not the configuration that ships.
const V = await import("file://" + resolvePath(__dirname, "scene3d/batched_material_variant.js"));
const VARIANT_ARGS = ["batchedMaterialFor", "holdBatchedMaterial", "releaseBatchedMaterial"];
const variantFns = [V.batchedMaterialFor, V.holdBatchedMaterial, V.releaseBatchedMaterial];

const SBX_PATH = resolvePath(__dirname, "scene3d/static_batch_x.js");
const sbxSrc = readFileSync(SBX_PATH, "utf8");
const stripped = sbxSrc
  .replace(/^\s*import\s+.*$/gm, "")
  .replace(/^\s*export\s+function\s+/gm, "function ")
  .replace(/^\s*export\s+const\s+/gm, "const ");
const factory = new Function(
  "THREE", ...VARIANT_ARGS,
  stripped +
    "\n; return { statBatchChunkEnabled, __setStatBatchChunkForTest, __resetStatBatchXForTest, " +
    "statBatchValueKeyEnabled, __setStatBatchValueKeyForTest, __materialValueKeyForTest, " +
    "consolidateStaticSingletonsCrossLb, evictStaticBatchXForLb, tickStatBatchXOptimize, getStatBatchXStats };"
);
const M = factory(THREE, ...variantFns);
M.__setStatBatchChunkForTest(true);

// ---- mocks (same shape as test_static_batch_x.mjs) -------------------------
function triGeom(tris = 1) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(tris * 9);
  for (let i = 0; i < tris; i++) pos.set([0, 0, 0, 1, 0, 0, 0, 1, 0], i * 9);
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(tris * 9), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(tris * 6), 2));
  return g;
}
function singleton(surfaceDid, x, lbId, geom, mat) {
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, 0, 0);
  m.userData = { surfaceDid, landblockId: lbId >>> 0 };
  return m;
}
// The real statics population: one shared `map` object per surface DID
// (MaterialCache mints exactly one DataTexture per DID), so a merge candidate
// pair shares the texture object.
const SHARED_TEX = new THREE.Texture();
function surfMat(over = {}) {
  const m = new THREE.MeshStandardMaterial({ map: SHARED_TEX });
  m.userData = { surfaceDid: 0x0a00 };
  Object.assign(m, over);
  return m;
}
const feed = (sc, lb, mat, n = 2, geom = triGeom(1)) => {
  const nodes = [];
  for (let i = 0; i < n; i++) nodes.push(singleton(0x0a00, i, lb, geom, mat));
  return M.consolidateStaticSingletonsCrossLb(nodes, sc, lb);
};
const bms = (sc) => sc.staticsGroup.children.filter((c) => c.isBatchedMesh);

const LB1 = 0x96960000 >>> 0, LB2 = 0x97970000 >>> 0; // same 3x3 region
const LB3 = 0xccdd0000 >>> 0;                         // far region

// ===== 1. the reader =====
M.__setStatBatchValueKeyForTest(undefined);
check("1: statBatchValueKey defaults ON in a headless location", M.statBatchValueKeyEnabled() === true);
{
  const body = (sbxSrc.match(/export function statBatchValueKeyEnabled\(\)[\s\S]*?\n}/) || [""])[0];
  check("2: reader is the DEFAULT-ON `=off` escape shape + memoised + fail-soft to ON",
    /let on = true/.test(body) && /v === "off"/.test(body) && /_valueKeyFlag !== undefined/.test(body) &&
    /catch \(_\) \{ on = true; \}/.test(body));
}
M.__setStatBatchValueKeyForTest(true);

// ===== 2. equal by value ⇒ ONE bucket =====
M.__resetStatBatchXForTest();
{
  const sc = { staticsGroup: new THREE.Group() };
  const a = surfMat(), b = surfMat();
  check("3: two DISTINCT material objects, equal by value, produce equal keys",
    a !== b && M.__materialValueKeyForTest(a) === M.__materialValueKeyForTest(b));
  feed(sc, LB1, a);
  feed(sc, LB2, b); // a SECOND landblock in the same region (a re-feed of LB1
                    // would excise LB1's own contribution first — idempotence)
  const st = M.getStatBatchXStats();
  check("4: ...and share ONE bucket (4 instances, 1 BatchedMesh, 1 draw not 2)",
    bms(sc).length === 1 && st.buckets === 1 && st.instances === 4,
    `buckets=${st.buckets} instances=${st.instances}`);
  check("5: the bucket belongs to the FIRST object (never re-pointed; it draws through a's batched variant) and both are tracked",
    bms(sc)[0].userData.material === a && V.memberMaterialOf(bms(sc)[0].material) === a &&
    bms(sc)[0].userData.mergedMaterials.size === 2);
  check("6: the census reports the merge (merges 1, bucketsSaved 1, mats 2)",
    st.valueKey.enabled === true && st.valueKey.merges === 1 && st.valueKey.bucketsSaved === 1 &&
    st.valueKey.mergedBuckets === 1 && st.detail[0].mats === 2,
    JSON.stringify(st.valueKey));
}

// ===== 3. one case per keyed field: ANY difference ⇒ separate buckets =====
// Every entry is something three r184 reads: program-cache parameters
// (getParameters :7431), WebGLState.setMaterial bound state (:10383), or a
// per-material uniform value (refreshMaterialUniforms). None of the last six
// were in the prototype key that produced the original −35 estimate.
{
  const cases = [
    ["side (DoubleSide vs the FrontSide default — different faces drawn)", { side: THREE.DoubleSide }],
    ["transparent", { transparent: true }],
    ["opacity (a uniform, NOT a program parameter)", { opacity: 0.5 }],
    ["alphaTest", { alphaTest: 0.5 }],
    ["depthWrite", { depthWrite: false }],
    ["depthTest", { depthTest: false }],
    ["depthFunc", { depthFunc: THREE.AlwaysDepth }],
    ["colorWrite", { colorWrite: false }],
    ["blending", { blending: THREE.AdditiveBlending }],
    ["blendSrc (CustomBlending operand)", { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor }],
    ["premultipliedAlpha", { premultipliedAlpha: true }],
    ["alphaToCoverage", { alphaToCoverage: true }],
    ["polygonOffset", { polygonOffset: true, polygonOffsetFactor: -1 }],
    ["stencilWrite", { stencilWrite: true }],
    ["vertexColors", { vertexColors: true }],
    ["flatShading", { flatShading: true }],
    ["fog", { fog: false }],
    ["toneMapped", { toneMapped: false }],
    ["dithering", { dithering: true }],
    ["wireframe", { wireframe: true }],
    ["forceSinglePass", { forceSinglePass: true }],
    ["roughness", { roughness: 0.25 }],
    ["metalness", { metalness: 0.75 }],
    ["emissiveIntensity", { emissiveIntensity: 1.5 }],
    ["aoMapIntensity", { aoMapIntensity: 0.5 }],
    ["envMapIntensity", { envMapIntensity: 2 }],
    ["bumpScale", { bumpScale: 2 }],
    ["displacementScale", { displacementScale: 2 }],
    ["shadowSide", { shadowSide: THREE.BackSide }],
  ];
  let bad = [];
  const ref = M.__materialValueKeyForTest(surfMat());
  for (const [name, over] of cases) {
    if (M.__materialValueKeyForTest(surfMat(over)) === ref) bad.push(name);
  }
  check(`7: every scalar/state field separates keys (${cases.length} cases)`,
    bad.length === 0, bad.join(", "));

  // Object-valued fields — copied by value, so a fresh Color/Vector2 with a
  // different value must still separate.
  const colored = surfMat(); colored.color.setHex(0x804020);
  const emissive = surfMat(); emissive.emissive.setHex(0x112233);
  const nscale = surfMat(); nscale.normalScale.set(0.25, 0.25);
  check("8: Color/Vector-valued fields separate keys (color, emissive, normalScale)",
    M.__materialValueKeyForTest(colored) !== ref &&
    M.__materialValueKeyForTest(emissive) !== ref &&
    M.__materialValueKeyForTest(nscale) !== ref);

  // Texture identity — the axis this change deliberately does NOT merge across.
  const otherTex = surfMat(); otherTex.map = new THREE.Texture();
  const normalMap = surfMat(); normalMap.normalMap = new THREE.Texture();
  const emissiveMap = surfMat(); emissiveMap.emissiveMap = SHARED_TEX;
  check("9: texture identity stays in the key (map / normalMap / emissiveMap)",
    M.__materialValueKeyForTest(otherTex) !== ref &&
    M.__materialValueKeyForTest(normalMap) !== ref &&
    M.__materialValueKeyForTest(emissiveMap) !== ref);

  // `defines` and material type.
  const defined = surfMat(); defined.defines = { USE_X: 1 };
  check("10: `defines` and material `type` separate keys",
    M.__materialValueKeyForTest(defined) !== ref &&
    M.__materialValueKeyForTest(new THREE.MeshBasicMaterial({ map: SHARED_TEX })) !== ref);

  // userData — carries `surfaceDid` plus every shader-patch marker, and is what
  // keeps a POM/detail-tile-bound material from merging across surfaces.
  const otherDid = surfMat(); otherDid.userData = { surfaceDid: 0x0b00 };
  const translucency = surfMat(); translucency.userData = { surfaceDid: 0x0a00, __baseTranslucency: 1 };
  check("11: userData is in the key (surfaceDid, and the __baseTranslucency ?skipDeadBatch reads)",
    M.__materialValueKeyForTest(otherDid) !== ref &&
    M.__materialValueKeyForTest(translucency) !== ref);

  // Our onBeforeCompile patch sets, via customProgramCacheKey — this is what
  // keeps a floorBias / staticBias / cellBaked CLONE out of its base's bucket.
  // Modelled exactly as materials.js does it: a userData flag read lazily by an
  // installed customProgramCacheKey.
  const biased = surfMat();
  biased.userData = { surfaceDid: 0x0a00, __floorBiased: true };
  biased.onBeforeCompile = function (shader) { void shader; };
  biased.customProgramCacheKey = function () { return `hb|f${this.userData.__floorBiased ? 1 : 0}`; };
  const plain = surfMat();
  plain.onBeforeCompile = function (shader) { void shader; };
  plain.customProgramCacheKey = function () { return `hb|f${this.userData.__floorBiased ? 1 : 0}`; };
  check("12: a depth-bias CLONE never merges into its base's bucket (customProgramCacheKey)",
    M.__materialValueKeyForTest(biased) !== M.__materialValueKeyForTest(plain));

  // Anything the key cannot compare is UNMERGEABLE, never optimistically equal.
  const weird = surfMat(); weird.onBeforeRender = function () {};
  const clipped = surfMat(); clipped.clippingPlanes = [new THREE.Plane()];
  const thrower = surfMat();
  thrower.customProgramCacheKey = function () { throw new Error("nope"); };
  check("13: unknown own function / array / throwing cache-key ⇒ null (own bucket, never a merge)",
    M.__materialValueKeyForTest(weird) === null &&
    M.__materialValueKeyForTest(clipped) === null &&
    M.__materialValueKeyForTest(thrower) === null);

  // Identity/bookkeeping fields must NOT separate, or nothing would ever merge.
  const named = surfMat(); named.name = "different"; named.needsUpdate = true;
  check("14: uuid / name / version(needsUpdate) are NOT in the key",
    M.__materialValueKeyForTest(named) === ref);
}

// ===== 4. the separation is real at the bucket level, not just the key =====
M.__resetStatBatchXForTest();
{
  const sc = { staticsGroup: new THREE.Group() };
  const a = surfMat(), b = surfMat({ opacity: 0.5 });
  feed(sc, LB1, a); feed(sc, LB2, b);
  const st = M.getStatBatchXStats();
  check("15: differing materials keep their own buckets (2 buckets, 0 merges)",
    st.buckets === 2 && st.valueKey.merges === 0 && bms(sc).length === 2,
    `buckets=${st.buckets} merges=${st.valueKey.merges}`);
}

// ===== 5. merging is per REGION, never global =====
M.__resetStatBatchXForTest();
{
  const sc = { staticsGroup: new THREE.Group() };
  feed(sc, LB1, surfMat());
  feed(sc, LB3, surfMat()); // equal by value, DIFFERENT 3x3 region
  const st = M.getStatBatchXStats();
  check("16: equal-by-value materials in different regions do NOT merge (spatial bounds hold)",
    st.buckets === 2 && st.valueKey.merges === 0, `buckets=${st.buckets}`);
}

// ===== 6. lifetime: evicting one member's LB leaves the others intact =====
M.__resetStatBatchXForTest();
{
  const sc = { staticsGroup: new THREE.Group() };
  const a = surfMat(), b = surfMat();
  feed(sc, LB1, a, 3);
  feed(sc, LB2, b, 2); // joins a's bucket by value
  const bm = bms(sc)[0];
  check("17: two LBs, two material objects, ONE bucket, 5 instances",
    bms(sc).length === 1 && bm.userData.instances === 5 && bm.userData.mergedMaterials.size === 2,
    `instances=${bm.userData.instances}`);
  M.evictStaticBatchXForLb(LB2);
  check("18: evicting the JOINER's landblock leaves the bucket + the other LB's instances alive",
    sc.staticsGroup.children.includes(bm) && bm.userData.instances === 3 && bm.instanceCount === 3,
    `instances=${bm.userData.instances}`);
  // ...and the other direction: evicting the LB that CREATED the bucket.
  M.evictStaticBatchXForLb(LB1);
  check("19: evicting the CREATOR's landblock empties and reaps the bucket",
    !sc.staticsGroup.children.includes(bm) && M.getStatBatchXStats().buckets === 0);
  // The reap must have dropped BOTH object keys — a survivor would hand this
  // disposed BatchedMesh back to the next feed (statics silently invisible).
  const r = feed(sc, LB1, b, 2);
  const after = bms(sc);
  check("20: a re-feed of the JOINER material builds a FRESH bucket (no stale key survived the reap)",
    !!r && after.length === 1 && after[0] !== bm && after[0].userData.instances === 2,
    `same=${after[0] === bm}`);
}

// ===== 7. late mutation: both guards =====
M.__resetStatBatchXForTest();
{
  // GUARD 1 — the resident bucket's material mutates before another material
  // asks to join. The stale index entry must be re-keyed, not honoured.
  const sc = { staticsGroup: new THREE.Group() };
  const a = surfMat();
  feed(sc, LB1, a);
  a.opacity = 0.25;                       // e.g. _reseatSurfaceState landing late
  const b = surfMat();                    // still the ORIGINAL value
  feed(sc, LB2, b);
  const st = M.getStatBatchXStats();
  check("21: GUARD 1 — a mutated bucket material is re-keyed, the joiner gets its own bucket",
    st.buckets === 2 && st.valueKey.merges === 0 && st.valueKey.rekeyed === 1,
    JSON.stringify({ buckets: st.buckets, merges: st.valueKey.merges, rekeyed: st.valueKey.rekeyed }));
}
M.__resetStatBatchXForTest();
{
  // GUARD 2 — a MEMBER mutates after joining (the animated-surface `.map` swap /
  // BC7 re-point class). The merged bucket is orphaned on the optimize tick: it
  // keeps rendering and draining, and the next feed builds fresh.
  const sc = { staticsGroup: new THREE.Group() };
  const a = surfMat(), b = surfMat();
  feed(sc, LB1, a);
  feed(sc, LB2, b);
  const bm = bms(sc)[0];
  check("22: merged before the mutation (1 bucket, 2 materials)",
    bms(sc).length === 1 && bm.userData.mergedMaterials.size === 2);
  b.map = new THREE.Texture();            // the animated-frame / BC7 swap
  M.tickStatBatchXOptimize();
  const st = M.getStatBatchXStats();
  check("23: GUARD 2 — divergence is DETECTED and counted, and the bucket keeps rendering",
    st.valueKey.diverged === 1 && sc.staticsGroup.children.includes(bm) && bm.visible !== false,
    JSON.stringify(st.valueKey));
  M.tickStatBatchXOptimize(); // a second tick must not re-count the same divergence
  check("24: the orphan stays in the CENSUS (it is still drawing) and is adjudicated once",
    M.getStatBatchXStats().buckets === 1 && M.getStatBatchXStats().valueKey.diverged === 1,
    JSON.stringify({ buckets: M.getStatBatchXStats().buckets, diverged: M.getStatBatchXStats().valueKey.diverged }));
  const r = feed(sc, LB1, a, 2);
  check("24b: ...the orphan is out of the index, so the next feed builds a FRESH bucket",
    !!r && bms(sc).length === 2 && bms(sc)[1] !== bm);
  check("25: the orphan still evicts + reaps through the normal per-LB path",
    (() => {
      M.evictStaticBatchXForLb(LB2);
      return !sc.staticsGroup.children.includes(bm);
    })());
}

// ===== 8. `=off` is the pre-2026-08-06 path =====
M.__resetStatBatchXForTest();
M.__setStatBatchValueKeyForTest(false);
{
  const sc = { staticsGroup: new THREE.Group() };
  feed(sc, LB1, surfMat());
  feed(sc, LB2, surfMat());
  const st = M.getStatBatchXStats();
  check("26: flag OFF — equal-by-value materials keep separate buckets (object keying, verbatim)",
    st.buckets === 2 && st.valueKey.enabled === false && st.valueKey.merges === 0 &&
    st.valueKey.keyed === 0 && st.detail[0].mats === 1,
    JSON.stringify({ buckets: st.buckets, keyed: st.valueKey.keyed }));
}
M.__setStatBatchValueKeyForTest(true);

// ===== 9. ?skipDeadBatch keeps working across a merge =====
M.__resetStatBatchXForTest();
{
  // The predicate is INJECTED (statics.js installs materials.js
  // `materialRendersNothing`); model its exact clause set here. Every field it
  // reads is in the merge key, which is what makes "every member of a merged
  // bucket is equally invisible" still true.
  const sbxDead = `(m) => !!m && m.transparent === true && (m.opacity ?? 1) <= 0 &&
    m.blending === ${THREE.NormalBlending} && m.depthWrite === false &&
    +(m.userData?.__baseTranslucency ?? 0) >= 1`;
  const deadFn = new Function(`return ${sbxDead}`)();
  const f2 = new Function("THREE", ...VARIANT_ARGS, stripped + "\n; return { setDeadBatchPredicate, consolidateStaticSingletonsCrossLb, " +
    "getStatBatchXStats, __setStatBatchChunkForTest, __setStatBatchValueKeyForTest };");
  const M3 = f2(THREE, ...variantFns);
  M3.__setStatBatchChunkForTest(true);
  M3.__setStatBatchValueKeyForTest(true);
  M3.setDeadBatchPredicate(deadFn);
  const sc = { staticsGroup: new THREE.Group() };
  const mk = () => {
    const m = new THREE.MeshStandardMaterial({ map: SHARED_TEX, transparent: true, opacity: 0, depthWrite: false });
    m.userData = { surfaceDid: 0x0a00, __baseTranslucency: 1 };
    return m;
  };
  const d1 = mk(), d2 = mk();
  for (const [lb, mat] of [[LB1, d1], [LB2, d2]]) {
    const nodes = [];
    for (let i = 0; i < 2; i++) nodes.push(singleton(0x0a00, i, lb, triGeom(1), mat));
    M3.consolidateStaticSingletonsCrossLb(nodes, sc, lb);
  }
  const st = M3.getStatBatchXStats();
  const bm = sc.staticsGroup.children.filter((c) => c.isBatchedMesh)[0];
  check("27: two invisible-by-value materials merge AND the merged bucket is still marked dead",
    st.buckets === 1 && st.valueKey.merges === 1 &&
    bm.userData.__deadBatch === true && bm.visible === false && st.deadBatch.buckets === 1,
    JSON.stringify({ buckets: st.buckets, dead: st.deadBatch.buckets }));
}

M.__resetStatBatchXForTest();
{
  // RENDERER BOOKKEEPING (2026-10-10). Whatever object is drawn gets per-object
  // stamps: draw_sort_program.js `__dspTok/__dspFrame/__dspKey` (`__dspFrame`
  // moves every frame) and async_link_guard.js `__hbLinkOk*` (`__hbLinkOkOwner`
  // is an object reference). A member also drawn on plain meshes carries them,
  // and so does the bucket's batched variant — which also trails its member by up
  // to a frame (synced once per frame). None of it is render state.
  const sc = { staticsGroup: new THREE.Group() };
  const a = surfMat(), b = surfMat();
  Object.assign(a, { __dspTok: 7, __dspFrame: 100, __dspKey: "p12", __hbLinkOk: a.version,
    __hbLinkOkOwner: a, __hbLinkOkCombo: "c", __hbLinkOkListen: true });
  check("28: renderer bookkeeping does not change a material's value key",
    M.__materialValueKeyForTest(a) !== null && M.__materialValueKeyForTest(a) === M.__materialValueKeyForTest(b));
  feed(sc, LB1, a);
  feed(sc, LB2, b);
  const bm = bms(sc)[0];
  Object.assign(bm.material, { __dspFrame: 101, __hbLinkOkOwner: bm.material }); // the variant is drawn
  a.__dspFrame = 102;
  a.roughness = 0.31; b.roughness = 0.31; // both members change alike, before the variant syncs
  M.tickStatBatchXOptimize();
  const st = M.getStatBatchXStats();
  check("29: a merge survives the tick: stamps on members and variant, and a variant one frame stale",
    bms(sc).length === 1 && bm.material !== a && st.valueKey.merges === 1 && st.valueKey.diverged === 0 &&
    bm.userData.mergedMaterials.size === 2,
    JSON.stringify({ buckets: bms(sc).length, valueKey: st.valueKey }));
}

console.log("=========================");
console.log(`stat-batch-value-key test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
