// tests/static_early_out.test.mjs
//
// `?staticEarlyOut` (handoff P2 / L0, 2026-10-22; DEFAULT ON since 2026-10-23,
// escapes off/0/false/no) — opaque, unsorted statics chunk buckets
// (scene3d/static_batch_x.js) and ?buildingMatBatch buckets (scene3d/buildings.js)
// drop the per-instance sphere cull so three r184's BatchedMesh early-out
//     if ( ! this._visibilityChanged && ! this.perObjectFrustumCulled && ! this.sortObjects ) return;
// fires on settled frames. Plus improvement hunt B9a: building buckets are
// opted into ?batchedRuns (default on) with `markBatchedRuns`.
//
// Everything runs on the SHIPPED modules (real three r184 BatchedMesh, the real
// static_batch_x.js / buildings.js / batched_runs.js), no re-derivation:
//   E1  flag grammar: absent / junk / on / 1 / true / yes = on; off / 0 / false / no = off.
//   E2  flag OFF = today's settings exactly, bucket for bucket (sort, per-object
//       cull, node cull, the own memo override), and applyStaticEarlyOut
//       touches nothing.
//   E3  flag ON: opaque + ClipMap (alpha-tested, not transparent) buckets have
//       perObjectFrustumCulled=false, sortObjects=false, frustumCulled=true and
//       no own onBeforeRender; translucent (sorted) and wireframe buckets are
//       unchanged against the OFF arm.
//   E4  three's early-out really fires: the first call lists every visible
//       instance (off-screen ones too); later calls from other cameras and the
//       shadow route rebuild nothing (indirect texture version unchanged).
//   E5  OFF arm still culls per instance (the instance far off-screen is not in
//       its list) — the population difference the flag trades.
//   E6  park / unpark (setVisibleAt) rebuild the list once each.
//   E7  node cull kept: boundingSphere is null after each membership change and
//       recomputes over every active instance.
//   E8  sort flip (?statBatchNoSort re-derivation): sorted -> opaque puts the
//       bucket on the early-out (override removed, list rebuilt), back again
//       restores the cull and the very same override function.
//   E9  live seam (`window.__staticEarlyOut.off` path) reverts / re-applies
//       chunk AND building buckets.
//   E10 census: walk.earlyOut + per-bucket `earlyOut`.
//   E11 billboard-tagged LOD nodes never enter a bucket (they stay on today's
//       path under the flag) — tickStaticsBillboards cannot defeat the early-out.
//   E12 B9a: building buckets are marked for runs in BOTH arms and draw as
//       instanced runs through the batchedRuns renderBufferDirect wrapper.
//   E13 buildings under the flag: opaque bucket on the early-out, node cull and
//       anchor kept; flag off = pOFC true exactly as before.
//   E14 (2026-10-23 review p2eo-1) live seam with a diag hook in the slot (the
//       submitted sampler, frame_split objHooks): each arm still gets its real
//       override shape, before and after the diag disarms; detached building
//       buckets (park, deferAttach) follow the seam when re-attached.
//
// Run: cd apps/holtburger-web/ && node tests/static_early_out.test.mjs

globalThis.window ??= {};
window.location ??= { search: "" };
window.requestAnimationFrame ??= () => 0;
globalThis.location ??= window.location;

const THREE = await import("three");
const SBX = await import("../scene3d/static_batch_x.js");
const BMV = await import("../scene3d/batched_material_variant.js");
const RUNS = await import("../scene3d/batched_runs.js");
const B = await import("../scene3d/buildings.js");

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
function triGeom() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(9), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(6), 2));
  return g;
}
// One unique map per material: the value key never fuses two surfaces.
function mockMat(opts = {}) {
  const m = new THREE.MeshBasicMaterial(opts);
  m.map = new THREE.Texture();
  return m;
}
function singleton(surfaceDid, x, lbId, geom, mat) {
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, 0, 0);
  m.updateMatrix();
  m.userData = { surfaceDid, landblockId: lbId >>> 0 };
  return m;
}
const LB1 = 0x96960000 >>> 0;
const LB2 = 0x97970000 >>> 0; // same 3x3 region as LB1
const S_OPAQUE = 0x0a00, S_CLIP = 0x0b00, S_GLASS = 0x0c00, S_WIRE = 0x0d00;
const FAR_X = 5000; // far outside the test camera's frustum

/** Feed one LB into fresh module state; returns the buckets by surface. */
function feedArm(flagOn) {
  SBX.__resetStatBatchXForTest();
  SBX.__setStatBatchChunkForTest(true);
  SBX.__setStatBatchNoSortForTest(false);
  SBX.__setStaticEarlyOutForTest(flagOn);
  const scene3d = { staticsGroup: new THREE.Group(), buildingsGroup: new THREE.Group() };
  const mats = {
    [S_OPAQUE]: mockMat(),
    [S_CLIP]: mockMat({ alphaTest: 0.784 }), // ?clipMapOpaque: alpha-tested, transparent=false
    [S_GLASS]: mockMat({ transparent: true, depthWrite: false, opacity: 0.5 }),
    [S_WIRE]: mockMat({ wireframe: true }),
  };
  const nodes = [];
  for (const did of [S_OPAQUE, S_CLIP, S_GLASS, S_WIRE]) {
    const g = triGeom();
    for (let i = 0; i < 4; i++) nodes.push(singleton(did, i * 2, LB1, g, mats[did]));
    nodes.push(singleton(did, FAR_X, LB1, g, mats[did])); // the off-screen instance
  }
  // Billboard-tagged LOD (statics.js tagBillboardLod shape).
  const lod = new THREE.LOD();
  lod.addLevel(new THREE.Mesh(triGeom(), mats[S_OPAQUE]), 0);
  lod.addLevel(new THREE.Mesh(triGeom(), mats[S_OPAQUE]), 50);
  lod.userData = { surfaceDid: S_OPAQUE, landblockId: LB1, billboardMode: 4, billboardLevel: 1 };
  nodes.push(lod);
  const r = SBX.consolidateStaticSingletonsCrossLb(nodes, scene3d, LB1);
  const by = {};
  for (const c of scene3d.staticsGroup.children) {
    if (!c.isBatchedMesh) continue;
    by[c.userData.surfaceDid] = c;
  }
  return { scene3d, mats, by, r, lod };
}

const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
cam.position.set(4, 0, 30); cam.lookAt(4, 0, 0); cam.updateMatrixWorld(true);
cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
const cam2 = cam.clone();
cam2.position.set(6, 1, 28); cam2.lookAt(6, 0, 0); cam2.updateMatrixWorld(true);
cam2.matrixWorldInverse.copy(cam2.matrixWorld).invert();
const shadowCam = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 200);
shadowCam.position.set(0, 0, 80); shadowCam.lookAt(0, 0, 0); shadowCam.updateMatrixWorld(true);
shadowCam.matrixWorldInverse.copy(shadowCam.matrixWorld).invert();

/** One draw's list as "start:count:id" (what the GPU would be told to draw). */
function listOf(bm) {
  const n = bm._multiDrawCount | 0;
  const ids = bm._indirectTexture.image.data;
  const out = [];
  for (let k = 0; k < n; k++) out.push(`${bm._multiDrawStarts[k]}:${bm._multiDrawCounts[k]}:${ids[k]}`);
  return out;
}
function drawOnce(bm, camera = cam) {
  bm.updateMatrixWorld(true);
  bm.onBeforeRender(null, null, camera, bm.geometry, bm.material, null);
}
function bucketTuple(bm) {
  return {
    sortObjects: bm.sortObjects,
    pOFC: bm.perObjectFrustumCulled,
    frustumCulled: bm.frustumCulled,
    ownOBR: hasOwn(bm, "onBeforeRender") ? bm.onBeforeRender : null,
    castShadow: bm.castShadow,
    receiveShadow: bm.receiveShadow,
    instances: bm.userData.instances,
  };
}

// ---------------------------------------------------------------------------
console.log("\n-- E1 flag grammar ---------------------------------------------------");
{
  const read = (search) => {
    globalThis.location.search = search;
    SBX.__setStaticEarlyOutForTest(undefined);
    const v = SBX.staticEarlyOutEnabled();
    return v;
  };
  check("absent => on (default on since 2026-10-23)", read("") === true);
  check("=off / =0 / =false / =NO => off",
    read("?staticEarlyOut=off") === false && read("?staticEarlyOut=0") === false
    && read("?staticEarlyOut=false") === false && read("?staticEarlyOut=NO") === false);
  check("junk (=enabled / =2) => on (only off/0/false/no escape)",
    read("?staticEarlyOut=enabled") === true && read("?staticEarlyOut=2") === true);
  check("=on / =1 / =true / =yes => on",
    read("?staticEarlyOut=on") && read("?staticEarlyOut=1") && read("?staticEarlyOut=true") && read("?staticEarlyOut=YES"));
  // 2026-10-23 review (p2eo-2): read the non-default once, then change the URL —
  // a read that re-parsed location.search every call would flip here. (The old
  // check read "" twice and asserted the default, which no implementation can
  // fail.) Since the default went on (2026-10-23) the non-default is OFF.
  const first = read("?staticEarlyOut=off");
  globalThis.location.search = "";
  check("memoised after the first read (a later URL change is not re-read)", first === false && SBX.staticEarlyOutEnabled() === false);
  SBX.__setStaticEarlyOutForTest(undefined);
  check("the test seam's undefined re-reads the URL", SBX.staticEarlyOutEnabled() === true);
}

// ---------------------------------------------------------------------------
console.log("\n-- E2 flag OFF = today's settings ------------------------------------");
const OFF = feedArm(false);
{
  const all = Object.values(OFF.by);
  check("4 buckets (opaque, clip, glass, wire)", all.length === 4, `got ${all.length}`);
  check("every OFF bucket: perObjectFrustumCulled=true, frustumCulled=true",
    all.every((bm) => bm.perObjectFrustumCulled === true && bm.frustumCulled === true));
  check("OFF sort = !!mat.transparent (glass sorted, opaque/clip/wire not)",
    OFF.by[S_GLASS].sortObjects === true && OFF.by[S_OPAQUE].sortObjects === false &&
      OFF.by[S_CLIP].sortObjects === false && OFF.by[S_WIRE].sortObjects === false);
  const ov = OFF.by[S_OPAQUE].onBeforeRender;
  check("every OFF bucket carries the one shared own memo override (default ?statBatchMemo=slack)",
    all.every((bm) => hasOwn(bm, "onBeforeRender") && bm.onBeforeRender === ov) && typeof ov === "function");
  const st = SBX.getStatBatchXStats();
  check("census: earlyOut disabled, 0 buckets, 0 applied", st.walk.earlyOut.enabled === false &&
    st.walk.earlyOut.buckets === 0 && st.walk.earlyOut.applied === 0 && st.detail.every((d) => d.earlyOut === false));
  check("memo installed on all 4", st.walk.installed === 4, `installed=${st.walk.installed}`);
  // applyStaticEarlyOut with the flag off touches nothing at all.
  const bm = new THREE.BatchedMesh(4, 16, 32, new THREE.MeshBasicMaterial());
  bm.sortObjects = false;
  bm._visibilityChanged = false;
  const r = SBX.applyStaticEarlyOut(bm);
  check("flag off: applyStaticEarlyOut returns false and writes nothing",
    r === false && bm.perObjectFrustumCulled === true && bm._visibilityChanged === false && !hasOwn(bm, "onBeforeRender"));
}
const OFF_TUPLES = Object.fromEntries(Object.entries(OFF.by).map(([k, bm]) => [k, bucketTuple(bm)]));

// ---------------------------------------------------------------------------
console.log("\n-- E5 OFF arm culls per instance --------------------------------------");
{
  const bm = OFF.by[S_OPAQUE];
  drawOnce(bm);
  const ids = listOf(bm).map((s) => Number(s.split(":")[2]));
  check("OFF: the far instance (x=5000) is culled out of the list; the 4 in view are in",
    ids.length === 4 && !ids.includes(4), `ids=${ids}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- E3 flag ON: opaque buckets on the early-out ------------------------");
const ON = feedArm(true);
{
  for (const did of [S_OPAQUE, S_CLIP]) {
    const bm = ON.by[did];
    check(`ON 0x${did.toString(16)}: pOFC=false, sortObjects=false, frustumCulled=true, no own onBeforeRender`,
      bm.perObjectFrustumCulled === false && bm.sortObjects === false && bm.frustumCulled === true &&
        !hasOwn(bm, "onBeforeRender") && bm.onBeforeRender === THREE.BatchedMesh.prototype.onBeforeRender);
  }
  const glass = bucketTuple(ON.by[S_GLASS]);
  const wire = bucketTuple(ON.by[S_WIRE]);
  check("ON translucent (sorted) bucket == OFF arm's, field for field (incl. the same override function)",
    JSON.stringify({ ...glass, ownOBR: !!glass.ownOBR }) === JSON.stringify({ ...OFF_TUPLES[S_GLASS], ownOBR: !!OFF_TUPLES[S_GLASS].ownOBR }) &&
      glass.ownOBR === OFF_TUPLES[S_GLASS].ownOBR);
  check("ON wireframe bucket stays culled (three bakes wireframe into the list) == OFF arm's",
    wire.pOFC === true && wire.sortObjects === false && wire.ownOBR === OFF_TUPLES[S_WIRE].ownOBR);
  check("ON opaque shadow flags / instance counts unchanged vs OFF",
    ON.by[S_OPAQUE].castShadow === OFF_TUPLES[S_OPAQUE].castShadow &&
      ON.by[S_OPAQUE].userData.instances === OFF_TUPLES[S_OPAQUE].instances);
  check("ON: the new bucket starts dirty (three builds its list once)", ON.by[S_OPAQUE]._visibilityChanged === true);
}

// ---------------------------------------------------------------------------
console.log("\n-- E4 three's early-out fires -----------------------------------------");
{
  const bm = ON.by[S_OPAQUE];
  drawOnce(bm, cam);
  const first = listOf(bm);
  const ids = first.map((s) => Number(s.split(":")[2])).sort((a, b) => a - b);
  check("first call lists EVERY visible instance, the off-screen one too (5 of 5)",
    ids.join(",") === "0,1,2,3,4", `ids=${ids}`);
  check("three consumed the flag", bm._visibilityChanged === false);
  const tex = bm._indirectTexture;
  const v0 = tex.version;
  drawOnce(bm, cam2);
  drawOnce(bm, cam);
  check("later calls from other cameras rebuild nothing (indirect version, list, count unchanged)",
    tex.version === v0 && JSON.stringify(listOf(bm)) === JSON.stringify(first));
  bm.onBeforeShadow(null, bm, cam, shadowCam, bm.geometry, new THREE.MeshDepthMaterial(), null);
  check("the shadow route (onBeforeShadow -> onBeforeRender) early-outs too", tex.version === v0);
  check("three's early-out condition holds on entry (what batchedRuns L1 calls quiet)",
    bm._visibilityChanged === false && bm.perObjectFrustumCulled === false && bm.sortObjects === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- E6 park / unpark rebuild once ----------------------------------------");
{
  const bm = ON.by[S_OPAQUE];
  const tex = bm._indirectTexture;
  const v0 = tex.version;
  const hidden = SBX.parkStaticBatchXForLb(LB1);
  check("park hid this LB's instances (setVisibleAt) and flagged the bucket", hidden > 0 && bm._visibilityChanged === true);
  drawOnce(bm, cam);
  check("one rebuild: parked instances leave the list", (bm._multiDrawCount | 0) === 0 && tex.version === v0 + 1);
  drawOnce(bm, cam2);
  check("then settled again", tex.version === v0 + 1);
  SBX.unparkStaticBatchXForLb(LB1);
  drawOnce(bm, cam);
  check("unpark: one rebuild, all 5 back", (bm._multiDrawCount | 0) === 5 && tex.version === v0 + 2);
}

// ---------------------------------------------------------------------------
console.log("\n-- E7 node cull kept: lazy bounding sphere -------------------------------");
{
  const bm = ON.by[S_OPAQUE];
  check("boundingSphere is lazy (still null: the feed nulled it, nothing culled the node since)", bm.boundingSphere === null);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  bm.updateMatrixWorld(true);
  check("node test computes it (Frustum.intersectsObject) and the node is in view", frustum.intersectsObject(bm) && bm.boundingSphere !== null);
  const s = bm.boundingSphere;
  check("it covers every active instance, the off-screen one included",
    s.containsPoint(new THREE.Vector3(0, 0, 0)) && s.containsPoint(new THREE.Vector3(FAR_X, 0, 0)), `r=${s.radius}`);
  // A second LB feeding the same region bucket nulls it again (membership change).
  const g = triGeom();
  const more = [singleton(S_OPAQUE, 40, LB2, g, ON.mats[S_OPAQUE]), singleton(S_OPAQUE, 42, LB2, g, ON.mats[S_OPAQUE])];
  SBX.consolidateStaticSingletonsCrossLb(more, ON.scene3d, LB2);
  check("a feed into the bucket nulls the sphere (recomputed at the next cull)", bm.boundingSphere === null);
  check("and flags the list for one rebuild", bm._visibilityChanged === true);
  drawOnce(bm, cam);
  check("the rebuilt list carries the new members (7)", (bm._multiDrawCount | 0) === 7, `n=${bm._multiDrawCount}`);
  SBX.evictStaticBatchXForLb(LB2);
  check("evict nulls the sphere and flags a rebuild", bm.boundingSphere === null && bm._visibilityChanged === true);
  drawOnce(bm, cam);
  check("back to 5 after the evict", (bm._multiDrawCount | 0) === 5);
}

// ---------------------------------------------------------------------------
console.log("\n-- E8 sort flip under ?statBatchNoSort -----------------------------------");
{
  const S = feedArm(true);
  SBX.__setStatBatchNoSortForTest(true);
  const glass = S.by[S_GLASS];
  const mat = S.mats[S_GLASS];
  const ov = glass.onBeforeRender;
  check("setup: translucent bucket sorted + culled + own override", glass.sortObjects === true && glass.perObjectFrustumCulled === true && hasOwn(glass, "onBeforeRender"));
  // Draw it once while sorted: its list is now CULLED for `cam` (no far instance)
  // and three's flag is consumed — the state a flip must not inherit.
  drawOnce(glass, cam);
  check("setup: sorted draw culled the far instance (4 listed) and consumed the flag",
    (glass._multiDrawCount | 0) === 4 && glass._visibilityChanged === false);
  // _reseatSurfaceState-style flip of the MEMBER; the variant follows at the frame sync.
  mat.transparent = false; mat.depthWrite = true; mat.needsUpdate = true;
  BMV.syncBatchMatVariants();
  SBX.tickStatBatchXOptimize();
  check("opaque now: unsorted, on the early-out, override removed, list rebuilt once",
    glass.sortObjects === false && glass.perObjectFrustumCulled === false && !hasOwn(glass, "onBeforeRender") &&
      glass._visibilityChanged === true);
  drawOnce(glass, cam);
  check("the rebuilt list holds every visible instance", (glass._multiDrawCount | 0) === 5);
  mat.transparent = true; mat.depthWrite = false; mat.needsUpdate = true;
  BMV.syncBatchMatVariants();
  SBX.tickStatBatchXOptimize();
  check("translucent again: sorted, per-object cull back, the SAME override function reinstalled",
    glass.sortObjects === true && glass.perObjectFrustumCulled === true && glass.onBeforeRender === ov);
  const st = SBX.getStatBatchXStats().walk.earlyOut;
  check("applied / reverted counted (2 initial + 1 flip / 1 flip back)", st.applied === 3 && st.reverted === 1, JSON.stringify(st));
  SBX.__setStatBatchNoSortForTest(false);
}

// ---------------------------------------------------------------------------
console.log("\n-- E11 billboard LODs never enter a bucket ------------------------------");
{
  check("flag ON: the billboard-tagged LOD comes back in `out`, verbatim", ON.r && ON.r.out.includes(ON.lod));
  const inBucket = ON.scene3d.staticsGroup.children.some((c) => c === ON.lod);
  check("and is not consumed into any bucket (stays a THREE.LOD node on today's path)", !inBucket && ON.lod.isLOD === true);
  const { out, batches } = B.consolidateBuildingSurfaces([ON.lod, ON.lod.levels[0].object]);
  check("buildings refuse LOD nodes too (passthrough, no batch)", batches.length === 0 && out.includes(ON.lod));
}

// ---------------------------------------------------------------------------
console.log("\n-- E12/E13 buildings: B9a runs mark + early-out ---------------------------");
const LBB = 0xa21efffe >>> 0;
function buildingNodes() {
  const mat = new THREE.MeshStandardMaterial({ color: 0x808080 });
  const g1 = triGeom(), g2 = triGeom();
  g1.setIndex([0, 1, 2]); g2.setIndex([0, 2, 1]);
  const nodes = [];
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(i % 3 === 0 ? g2 : g1, mat);
    m.position.set(0xa2 * 192 + 10 + i * 3, 0x1e * 192 + 20, 1);
    m.userData = { landblockId: LBB, surfaceDid: 0x08000101 };
    m.castShadow = true; m.receiveShadow = true;
    nodes.push(m);
  }
  return nodes;
}
let BLD_ON = null;
{
  SBX.__setStaticEarlyOutForTest(false);
  B.__setBuildingMatBatchForTest(true);
  const before = B.buildingBatchStats();
  const offRes = B.consolidateBuildingSurfaces(buildingNodes());
  const bOff = offRes.batches[0];
  check("OFF: one building bucket", offRes.batches.length === 1 && !!bOff);
  check("OFF: today's shape exactly (sortObjects=false, pOFC=true, frustumCulled=true, no own OBR)",
    bOff.sortObjects === false && bOff.perObjectFrustumCulled === true && bOff.frustumCulled === true && !hasOwn(bOff, "onBeforeRender"));
  check("OFF: no re-attach listener either (p2eo-1's `added` hook is flag-on only)",
    !(bOff._listeners && bOff._listeners.added && bOff._listeners.added.length));
  check("B9a OFF arm too: the bucket is marked for ?batchedRuns", RUNS.isBatchedRunsMarked(bOff) === true);
  const mid = B.buildingBatchStats();
  check("tally: runsMarked +1, earlyOut +0 with the flag off",
    mid.runsMarked - (before.runsMarked | 0) === 1 && (mid.earlyOut | 0) === (before.earlyOut | 0));

  SBX.__setStaticEarlyOutForTest(true);
  const onRes = B.consolidateBuildingSurfaces(buildingNodes());
  const bOn = onRes.batches[0];
  BLD_ON = bOn;
  check("ON: building bucket on the early-out (pOFC=false, sortObjects=false), node cull kept",
    bOn.perObjectFrustumCulled === false && bOn.sortObjects === false && bOn.frustumCulled === true && !hasOwn(bOn, "onBeforeRender"));
  check("ON: anchor + landblock id unchanged", bOn.position.x === 0xa2 * 192 && bOn.position.y === 0x1e * 192 && bOn.userData.landblockId === LBB);
  check("ON: one re-attach listener (the `added` hook, p2eo-1)",
    !!bOn._listeners && Array.isArray(bOn._listeners.added) && bOn._listeners.added.length === 1);
  check("ON: still marked for runs", RUNS.isBatchedRunsMarked(bOn) === true);
  const after = B.buildingBatchStats();
  check("tally: earlyOut +1", after.earlyOut - mid.earlyOut === 1 && after.runsMarked - mid.runsMarked === 1);
  check("static_batch_x census counts it as external", SBX.getStatBatchXStats().walk.earlyOut.external >= 1);

  // Early-out on the building bucket: one build, then nothing.
  bOn.updateMatrixWorld(true);
  const bcam = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  bcam.position.set(0xa2 * 192 + 20, 0x1e * 192 + 20, 60); bcam.lookAt(0xa2 * 192 + 20, 0x1e * 192 + 20, 0);
  bcam.updateMatrixWorld(true); bcam.matrixWorldInverse.copy(bcam.matrixWorld).invert();
  bOn.onBeforeRender(null, null, bcam, bOn.geometry, bOn.material, null);
  const v0 = bOn._indirectTexture.version;
  bOn.onBeforeRender(null, null, cam, bOn.geometry, bOn.material, null); // a camera looking elsewhere
  check("building bucket: all 6 listed once, then early-out (version unchanged)",
    (bOn._multiDrawCount | 0) === 6 && bOn._indirectTexture.version === v0);

  // B9a at the draw: the batchedRuns wrapper turns the bucket into instanced runs.
  RUNS.__setBatchedRunsChunksForTest(true);
  const calls = [];
  const ext = {
    multiDrawElementsWEBGL(mode, counts, co, type, offsets, oo, drawCount) { calls.push({ kind: "elems", n: drawCount }); },
    multiDrawElementsInstancedWEBGL(mode, counts, co, type, offsets, oo, inst, io, drawCount) {
      calls.push({ kind: "inst", n: drawCount, inst: [...inst].slice(io, io + drawCount) });
    },
  };
  const r = {
    info: { render: { frame: 0 } },
    extensions: { has: (n) => n === "WEBGL_multi_draw", get: () => ext },
    renderBufferDirect(camera, scene, geometry, material, object) {
      if (object.isBatchedMesh && object._multiDrawCount > 0) {
        ext.multiDrawElementsWEBGL(4, object._multiDrawCounts, 0, 5125, object._multiDrawStarts, 0, object._multiDrawCount);
      }
    },
  };
  RUNS.installBatchedRuns(r);
  r.renderBufferDirect(bcam, null, bOn.geometry, bOn.material, bOn);
  const last = calls[calls.length - 1];
  check("B9a: the building bucket's 6 ranges reach GL as 2 instanced runs (4 + 2)",
    !!last && last.kind === "inst" && last.n === 2 && last.inst.reduce((a, b) => a + b, 0) === 6, JSON.stringify(last));
  r.renderBufferDirect(bcam, null, bOff.geometry, bOff.material, bOff); // OFF-arm bucket: never drawn yet => empty list
  RUNS.uninstallBatchedRuns(r);
  RUNS.__setBatchedRunsChunksForTest(false);
}

// ---------------------------------------------------------------------------
console.log("\n-- E9 live seam -------------------------------------------------------------");
{
  const S = feedArm(true);
  S.scene3d.buildingsGroup.add(BLD_ON);
  const op = S.by[S_OPAQUE];
  const n = SBX.__setStaticEarlyOutOffForTest(true, S.scene3d);
  check("seam off: re-applied chunk + building buckets", n === 5, `n=${n}`);
  check("seam off: opaque chunk bucket back to the per-object cull + own memo override",
    op.perObjectFrustumCulled === true && hasOwn(op, "onBeforeRender") && op.onBeforeRender === S.by[S_GLASS].onBeforeRender);
  check("seam off: building bucket back to the per-object cull", BLD_ON.perObjectFrustumCulled === true);
  check("seam off: census says off", SBX.getStatBatchXStats().walk.earlyOut.off === true && SBX.getStatBatchXStats().walk.earlyOut.buckets === 0);
  SBX.__setStaticEarlyOutOffForTest(false, S.scene3d);
  check("seam on again: both back on the early-out, override gone, lists flagged for one rebuild",
    op.perObjectFrustumCulled === false && !hasOwn(op, "onBeforeRender") && op._visibilityChanged === true &&
      BLD_ON.perObjectFrustumCulled === false && BLD_ON._visibilityChanged === true);
  check("window seam present", !!window.__staticEarlyOut && typeof window.__staticEarlyOut.stats === "function");
}

// ---------------------------------------------------------------------------
// 2026-10-23 review (p2eo-1). The live seam used to pick "reinstall or delete
// the memo override" by `hasOwnProperty`, so a diag hook in the slot (the
// submitted sampler and frame_split objHooks both install OWN wrappers) read as
// "already has its override": seam OFF left an early-out bucket on the
// per-object cull WITHOUT the memo (an OFF arm slower than the real default),
// and the diag's disarm then left it without one for the session. Separately a
// detached building bucket (LRU park, deferAttach prewarm) missed the live walk
// and came back in the other arm's mode. Real sampler, real frame_split (stub
// renderer: three's list API only), real three add/remove.
console.log("\n-- E14 live seam vs diag hooks + detached building buckets ------------------");
{
  const ATL = await import("../scene3d/static_atlas.js");
  const FS = await import("../scene3d/frame_split.js");
  const S = feedArm(true);
  const op = S.by[S_OPAQUE];
  const glass = S.by[S_GLASS];
  const memoOv = glass.onBeforeRender; // the one shared own override of a culled bucket
  const protoOBR = THREE.BatchedMesh.prototype.onBeforeRender;

  // (a) static_atlas armStatMergeSubmittedSampler on an early-out bucket.
  const armed = ATL.armStatMergeSubmittedSampler(S.scene3d.staticsGroup);
  check("setup: sampler armed; on the early-out bucket it is an own hook, not the memo",
    armed.armed === 4 && hasOwn(op, "onBeforeRender") && op.onBeforeRender !== memoOv && glass.onBeforeRender === memoOv);
  SBX.__setStaticEarlyOutOffForTest(true, S.scene3d);
  check("seam off with the sampler in the slot: per-object cull AND the memo override (today's default arm)",
    op.perObjectFrustumCulled === true && hasOwn(op, "onBeforeRender") && op.onBeforeRender === memoOv);
  ATL.disarmStatMergeSubmittedSampler(S.scene3d.staticsGroup);
  check("sampler disarm leaves the memo override (identity-checked, not its hook)",
    op.onBeforeRender === memoOv && glass.onBeforeRender === memoOv);
  SBX.__setStaticEarlyOutOffForTest(false, S.scene3d);
  check("seam on: back on the early-out, no own hook", op.perObjectFrustumCulled === false && !hasOwn(op, "onBeforeRender"));

  // (b) frame_split objHooks: adopts every non-default hook off the list.
  const list = { opaque: [], transmissive: [], transparent: [], init() { this.opaque.length = 0; }, finish() {}, sort() {} };
  const fsScene = new THREE.Scene();
  const rnd = {
    renderLists: { get: () => list },
    render() { list.init(); for (const o of [op, glass]) list.opaque.push({ object: o }); list.finish(); },
  };
  const a1 = FS.armFrameSplit({ renderer: rnd, scene: fsScene, objHooks: true, rbd: false });
  rnd.render(fsScene, cam);
  const fsGlass = glass.onBeforeRender;
  check("setup: frame_split adopted both (own timing wrappers over the prototype / the memo)",
    a1.armed === true && hasOwn(op, "onBeforeRender") && op.onBeforeRender !== protoOBR && fsGlass !== memoOv);
  SBX.__setStaticEarlyOutOffForTest(true, S.scene3d);
  check("seam off with frame_split in the slot: the memo override is installed", op.perObjectFrustumCulled === true && op.onBeforeRender === memoOv);
  check("a bucket whose mode did not change keeps the diag wrapper (no churn)", glass.onBeforeRender === fsGlass);
  rnd.render(fsScene, cam); // frame_split re-adopts the memo override
  FS.disarmFrameSplit();
  check("frame_split disarm: both culled buckets carry the memo override",
    hasOwn(op, "onBeforeRender") && op.onBeforeRender === memoOv && glass.onBeforeRender === memoOv);
  // Reverse: frame_split wraps the memo, then the seam goes on.
  FS.armFrameSplit({ renderer: rnd, scene: fsScene, objHooks: true, rbd: false });
  rnd.render(fsScene, cam);
  check("setup: frame_split wraps the memo override", hasOwn(op, "onBeforeRender") && op.onBeforeRender !== memoOv);
  SBX.__setStaticEarlyOutOffForTest(false, S.scene3d);
  check("seam on with the memo wrapped: the slot is emptied (no memo on an early-out bucket)",
    op.perObjectFrustumCulled === false && !hasOwn(op, "onBeforeRender"));
  FS.disarmFrameSplit();
  check("and frame_split's stale row does not bring the memo back", !hasOwn(op, "onBeforeRender") && op.onBeforeRender === protoOBR);

  // (c) detached building buckets follow the seam on re-attach (three's add).
  const bld = B.consolidateBuildingSurfaces(buildingNodes()).batches[0];
  S.scene3d.buildingsGroup.add(bld);
  S.scene3d.buildingsGroup.remove(bld); // landblock_lru park: detached
  SBX.__setStaticEarlyOutOffForTest(true, S.scene3d);
  check("setup: the parked building bucket is outside the live walk", bld.perObjectFrustumCulled === false);
  S.scene3d.buildingsGroup.add(bld); // unpark
  check("re-attach after seam off: per-object cull back, list flagged for one rebuild",
    bld.perObjectFrustumCulled === true && bld._visibilityChanged === true);
  S.scene3d.buildingsGroup.remove(bld);
  SBX.__setStaticEarlyOutOffForTest(false, S.scene3d);
  S.scene3d.buildingsGroup.add(bld);
  check("re-attach after seam on: back on the early-out", bld.perObjectFrustumCulled === false);
  SBX.__setStaticEarlyOutOffForTest(true, S.scene3d);
  const late = B.consolidateBuildingSurfaces(buildingNodes()).batches[0]; // deferAttach: built, not attached
  SBX.__setStaticEarlyOutOffForTest(false, S.scene3d);
  S.scene3d.buildingsGroup.add(late);
  check("built during seam off, attached after it flipped on: on the early-out", late.perObjectFrustumCulled === false);
  check("still one listener after many re-applies (addEventListener dedups the shared function)",
    bld._listeners.added.length === 1 && late._listeners.added.length === 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- E10 census ---------------------------------------------------------------");
{
  const S = feedArm(true);
  const st = SBX.getStatBatchXStats();
  const eo = st.walk.earlyOut;
  check("earlyOut: enabled, 2 buckets (opaque + clip), 10 slots, 2 gids",
    eo.enabled === true && eo.buckets === 2 && eo.slots === 10 && eo.gids === 2, JSON.stringify(eo));
  check("per-bucket detail flags exactly the opaque + clip buckets",
    st.detail.filter((d) => d.earlyOut).length === 2 && st.detail.filter((d) => d.earlyOut && d.sorted).length === 0);
  check("memo installed only on the 2 culled buckets (glass + wire)", st.walk.installed === 2, `installed=${st.walk.installed}`);
  check("drawn census (visible + live)", eo.drawnBuckets === 2 && eo.drawnSlots === 10);
  void S;
}

SBX.__setStaticEarlyOutForTest(undefined);
B.__setBuildingMatBatchForTest(undefined);
SBX.__resetStatBatchXForTest();
console.log(`\nstatic_early_out: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
