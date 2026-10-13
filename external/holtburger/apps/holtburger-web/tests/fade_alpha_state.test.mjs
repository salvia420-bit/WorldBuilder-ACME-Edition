// tests/fade_alpha_state.test.mjs — lighting-materials-1 + -2 (2026-10-13,
// `?fadeAlphaParity`): the render state of a FADED entity part.
//
// Retail fades a part through a private CMaterial with alpha < 1
// (CPhysicsPart::SetTranslucency, acclient.c:315488), and D3DPolyRender::
// SetSurface (acclient.c:454529-454550) draws an opaque or ClipMap surface
// carrying such a material with the alpha test OFF, SRCALPHA/INVSRCALPHA and no
// depth writes; already-blended surfaces keep their factors. At the default
// translucency RestoreMaterial drops the copy and the Surface bits decide again.
//
//   1. module: a ClipMap material faded to 0.5 loses its alpha test and blends;
//      back at 1 every authored flag returns and the record is dropped.
//   2. module: Additive / Alpha / the `?clipMapOpaque=off` ONE/INVSRCALPHA arm.
//   3. module: the snapshot is idempotent while faded; a ramp bumps `version`
//      only at the fade's start and end; an in-place re-author is kept.
//   4. module: `?fadeAlphaParity=off` is a no-op; the flag parser.
//   5. real EntityManager: camera fade 1 → 0 → 1 on an Alpha surface ends
//      blended (was: opaque after every first-person round trip); on a ClipMap
//      surface the fade drops the test and the restore brings it back.
//   6. real EntityManager: object translucency (ghost T=0.5) on a ClipMap part;
//      composition with the camera fade restores only when both are gone.
//   7. real EntityManager: Transparent(20) hook ramps through the tween clock;
//      a value-0 hook keeps an Alpha surface blended; ethereal toggle.
//   8. wiring: all four owners snapshot before they write and sync after.
//
// Run from apps/holtburger-web/:  node tests/fade_alpha_state.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const THREE = await import("three");
const F = await import("../scene3d/fade_alpha_state.js");
const { EntityManager } = await import("../scene3d/entities.js");

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};

const DDS_REF = 200 / 255;
const PAL_REF = 100 / 255;
const clipMap = (ref = DDS_REF) =>
  new THREE.MeshStandardMaterial({ alphaTest: ref, transparent: false, depthWrite: true });
const alphaSurface = () =>
  new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false, opacity: 1 });
const additive = () =>
  new THREE.MeshStandardMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
const opaque = () => new THREE.MeshStandardMaterial();
const flags = (m) => ({
  transparent: m.transparent, depthWrite: m.depthWrite, alphaTest: m.alphaTest,
  blending: m.blending, blendSrc: m.blendSrc, blendDst: m.blendDst, blendEquation: m.blendEquation,
});

console.log("-- 1-4 the module ---------------------------------------------");

await check("1a: a DDS ClipMap faded to 0.5 drops its alpha test and blends", () => {
  const m = clipMap();
  assert.equal(F.snapshotAuthoredAlpha(m, ""), true);
  m.opacity = 0.5;
  assert.equal(F.syncFadeAlpha(m, ""), true);
  assert.equal(m.alphaTest, 0, "0.5 < 0.784 would discard the whole part");
  assert.equal(m.transparent, true);
  assert.equal(m.depthWrite, false);
  assert.equal(m.blending, THREE.NormalBlending);
});

await check("1b: back at opacity 1 every authored flag returns and the record is dropped", () => {
  const m = clipMap(PAL_REF);
  const before = flags(m);
  F.snapshotAuthoredAlpha(m, "");
  m.opacity = 0.25;
  F.syncFadeAlpha(m, "");
  m.opacity = 1;
  assert.equal(F.syncFadeAlpha(m, ""), false);
  assert.deepEqual(flags(m), before);
  assert.equal(m.userData.__authoredAlpha, undefined);
});

await check("2a: an Additive surface keeps its blend while faded", () => {
  const m = additive();
  F.snapshotAuthoredAlpha(m, "");
  m.opacity = 0.5;
  F.syncFadeAlpha(m, "");
  assert.equal(m.blending, THREE.AdditiveBlending);
  assert.equal(m.transparent, true);
  assert.equal(m.depthWrite, false);
  m.opacity = 1;
  F.syncFadeAlpha(m, "");
  assert.equal(m.blending, THREE.AdditiveBlending);
  assert.equal(m.transparent, true);
});

await check("2b: an Alpha surface stays blended through a fade cycle", () => {
  const m = alphaSurface();
  F.snapshotAuthoredAlpha(m, "");
  m.opacity = 0; m.transparent = true;
  F.syncFadeAlpha(m, "");
  m.opacity = 1; m.transparent = false; // the old `opacity < 1.0` restore guess
  F.syncFadeAlpha(m, "");
  assert.equal(m.transparent, true, "an Alpha 0x100 surface must keep blending at opacity 1");
  assert.equal(m.depthWrite, false);
  assert.equal(m.blending, THREE.NormalBlending);
});

await check("2c: the ?clipMapOpaque=off ONE/INVSRCALPHA arm fades SRCALPHA/INVSRCALPHA, then gets its factors back", () => {
  const m = new THREE.MeshStandardMaterial({
    alphaTest: DDS_REF, transparent: true, depthWrite: true, blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
  });
  const before = flags(m);
  F.snapshotAuthoredAlpha(m, "");
  m.opacity = 0.6;
  F.syncFadeAlpha(m, "");
  assert.equal(m.blending, THREE.NormalBlending, "retail forces 5/6 on the ClipMap arm (acclient.c:454537)");
  assert.equal(m.alphaTest, 0);
  assert.equal(m.depthWrite, false);
  m.opacity = 1;
  F.syncFadeAlpha(m, "");
  assert.deepEqual(flags(m), before);
});

await check("2d: an authored-translucent surface (opacity 0.6) is faded only below 0.6", () => {
  const m = new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false, opacity: 0.6 });
  F.snapshotAuthoredAlpha(m, "");
  m.opacity = 0.6;
  assert.equal(F.syncFadeAlpha(m, ""), false);
  assert.equal(m.transparent, true);
  F.snapshotAuthoredAlpha(m, "");
  m.opacity = 0.3;
  assert.equal(F.syncFadeAlpha(m, ""), true);
});

await check("3a: the snapshot is idempotent while faded", () => {
  const m = clipMap();
  F.snapshotAuthoredAlpha(m, "");
  m.opacity = 0.5;
  F.syncFadeAlpha(m, "");
  assert.equal(F.snapshotAuthoredAlpha(m, ""), false, "a second snapshot mid-fade must not re-record");
  assert.equal(m.userData.__authoredAlpha.alphaTest, DDS_REF);
  assert.equal(m.userData.__authoredAlpha.transparent, false);
  assert.equal(m.userData.__authoredAlpha.depthWrite, true);
  assert.equal(m.userData.__authoredAlpha.opacity, 1);
});

await check("3b: a whole ramp bumps `version` at its start and its end only", () => {
  const m = clipMap();
  const v0 = m.version;
  for (let i = 1; i <= 64; i++) {
    F.snapshotAuthoredAlpha(m, "");
    m.opacity = 1 - i / 128;
    F.syncFadeAlpha(m, "");
  }
  assert.equal(m.version, v0 + 1, "one USE_ALPHATEST swap for the whole fade-out");
  F.snapshotAuthoredAlpha(m, "");
  m.opacity = 1;
  F.syncFadeAlpha(m, "");
  assert.equal(m.version, v0 + 2);
  assert.equal(m.alphaTest, DDS_REF);
});

await check("3c: an alpha test re-authored in place mid-fade is kept at the restore", () => {
  const m = opaque(); // e.g. a weapon-fx clone still on its grey fallback base
  F.snapshotAuthoredAlpha(m, "");
  m.opacity = 0.5;
  F.syncFadeAlpha(m, "");
  m.alphaTest = PAL_REF; // the real ClipMap surface lands on it (adopted in place)
  m.opacity = 1;
  F.syncFadeAlpha(m, "");
  assert.equal(m.alphaTest, PAL_REF);
});

await check("3d: a clone of a faded material carries the record with the owners' keys", () => {
  const m = clipMap();
  F.snapshotAuthoredAlpha(m, "");
  m.userData.__preCamFadeOpacity = 1;
  m.opacity = 0.5;
  F.syncFadeAlpha(m, "");
  const c = m.clone();
  c.opacity = 1;
  F.syncFadeAlpha(c, "");
  assert.equal(c.alphaTest, DDS_REF);
  assert.equal(c.transparent, false);
  assert.equal(c.depthWrite, true);
});

await check("3e: restoreAuthoredAlpha puts the flags back whatever the opacity", () => {
  const m = clipMap();
  F.snapshotAuthoredAlpha(m, "");
  m.opacity = 0.5;
  F.syncFadeAlpha(m, "");
  assert.equal(F.restoreAuthoredAlpha(m), true);
  assert.equal(m.alphaTest, DDS_REF);
  assert.equal(m.transparent, false);
  assert.equal(F.restoreAuthoredAlpha(m), false, "no record left");
});

await check("4a: ?fadeAlphaParity=off is a no-op (the pre-change state)", () => {
  const m = clipMap();
  assert.equal(F.snapshotAuthoredAlpha(m, "?fadeAlphaParity=off"), false);
  m.opacity = 0.5; m.transparent = true;
  assert.equal(F.syncFadeAlpha(m, "?fadeAlphaParity=off"), false);
  assert.equal(m.alphaTest, DDS_REF);
  assert.equal(m.userData.__authoredAlpha, undefined);
});

await check("4b: fadeAlphaParityEnabled parses the escape", () => {
  assert.equal(F.fadeAlphaParityEnabled(""), true);
  assert.equal(F.fadeAlphaParityEnabled("?fadeAlphaParity=on"), true);
  assert.equal(F.fadeAlphaParityEnabled("?fadeAlphaParity=off"), false);
  assert.equal(F.fadeAlphaParityEnabled("?fadeAlphaParity=OFF"), false);
  assert.equal(F.fadeAlphaParityEnabled("?x=1&fadeAlphaParity=0"), false);
  assert.equal(F.fadeAlphaParityEnabled("?fadeAlphaParity=false"), false);
  assert.equal(F.fadeAlphaParityEnabled("?fadeAlphaParity=no"), false);
  assert.equal(F.fadeAlphaParityEnabled(), true, "node has no window: the default");
});

console.log("-- 5-7 the real EntityManager ---------------------------------");

const P = 0x50000001;
const CLIP_DID = 0x08000301, ALPHA_DID = 0x08000302, OPAQUE_DID = 0x08000303, ADD_DID = 0x08000304;

function setup(dids = [CLIP_DID, ALPHA_DID, OPAQUE_DID, ADD_DID]) {
  const shared = new Map([
    [CLIP_DID, clipMap()],
    [ALPHA_DID, alphaSurface()],
    [OPAQUE_DID, opaque()],
    [ADD_DID, additive()],
  ]);
  for (const m of shared.values()) m.userData = { __cacheOwned: true };
  const materialCache = {
    fallbackMaterial: new THREE.MeshBasicMaterial(),
    getCached: (did) => shared.get(did >>> 0) ?? null,
  };
  const entitiesGroup = new THREE.Group();
  const em = new EntityManager({ entitiesGroup, materialCache }, {});
  const root = new THREE.Group();
  const parts = dids.map((did) => {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), shared.get(did));
    mesh.userData = { guid: P, surfaceDid: did };
    g.add(mesh);
    root.add(g);
    return g;
  });
  entitiesGroup.add(root);
  const inst = {
    guid: P, root, parts, meta: { setupId: 0x02000001 },
    _attachedParentGuid: null, _attachedChildren: null,
    dispose() { root.parent?.remove(root); },
  };
  em.entityMap.set(P, inst);
  const mat = (did) => parts[dids.indexOf(did)].children.find((o) => o.isMesh).material;
  return { em, inst, shared, mat };
}

await check("5a: camera fade 1 → 0 → 1 leaves an Alpha surface blended (lighting-materials-2)", () => {
  const { em, mat } = setup();
  em.setLocalPlayerCameraOpacity(P, 0);
  assert.equal(mat(ALPHA_DID).opacity, 0);
  em.setLocalPlayerCameraOpacity(P, 1);
  const m = mat(ALPHA_DID);
  assert.equal(m.opacity, 1);
  assert.equal(m.transparent, true, "was: transparent=false after the in-head round trip");
  assert.equal(m.depthWrite, false);
  assert.equal(m.blending, THREE.NormalBlending);
  assert.equal(m.userData.__authoredAlpha, undefined);
});

await check("5b: camera near-fade on a ClipMap part drops the test; backing off restores it", () => {
  const { em, shared, mat } = setup();
  em.setLocalPlayerCameraOpacity(P, 0.5);
  const m = mat(CLIP_DID);
  assert.notEqual(m, shared.get(CLIP_DID), "a per-entity clone");
  assert.equal(m.opacity, 0.5);
  assert.equal(m.alphaTest, 0);
  assert.equal(m.transparent, true);
  assert.equal(shared.get(CLIP_DID).alphaTest, DDS_REF, "the cache material is untouched");
  em.setLocalPlayerCameraOpacity(P, 1);
  assert.equal(m.alphaTest, DDS_REF);
  assert.equal(m.transparent, false);
  assert.equal(m.depthWrite, true);
});

await check("5c: an opaque surface and an Additive one round-trip to their authored flags", () => {
  const { em, mat } = setup();
  em.setLocalPlayerCameraOpacity(P, 0.25);
  em.setLocalPlayerCameraOpacity(P, 1);
  assert.equal(mat(OPAQUE_DID).transparent, false);
  assert.equal(mat(OPAQUE_DID).depthWrite, true);
  assert.equal(mat(ADD_DID).transparent, true);
  assert.equal(mat(ADD_DID).blending, THREE.AdditiveBlending);
});

await check("6a: object translucency T=0.5 (a ghost) keeps its ClipMap parts, fading", () => {
  const { em, mat } = setup();
  em.applyObjectTranslucency(P, 0.5);
  const m = mat(CLIP_DID);
  assert.equal(m.opacity, 0.5);
  assert.equal(m.alphaTest, 0, "0.5 < 0.784: the part was discarded outright");
  em.applyObjectTranslucency(P, 0);
  assert.equal(m.alphaTest, DDS_REF);
  assert.equal(m.transparent, false);
  assert.equal(mat(ALPHA_DID).transparent, true);
});

await check("6b: object translucency + camera fade: faded until BOTH are gone", () => {
  const { em, mat } = setup();
  em.applyObjectTranslucency(P, 0.5);
  em.setLocalPlayerCameraOpacity(P, 0.5);
  const m = mat(CLIP_DID);
  assert.equal(m.opacity, 0.25);
  em.setLocalPlayerCameraOpacity(P, 1);
  assert.equal(m.opacity, 0.5);
  assert.equal(m.alphaTest, 0, "still faded by the object translucency");
  assert.equal(m.transparent, true);
  em.applyObjectTranslucency(P, 0);
  assert.equal(m.opacity, 1);
  assert.equal(m.alphaTest, DDS_REF);
  assert.equal(m.transparent, false);
  assert.equal(m.depthWrite, true);
});

await check("7a: a Transparent(20) ramp 0 → 1 through the tween clock, then back to 0", () => {
  const { em, inst, mat } = setup();
  em._spawnMaterialRampTween(inst, 20, -1, { rampStart: 0, rampEnd: 0.6, rampTime: 0 });
  em._tickMaterialHooks(inst, 1 / 60, performance.now() + 1);
  const m = mat(CLIP_DID);
  assert.ok(Math.abs(m.opacity - 0.4) < 1e-6, `opacity ${m.opacity}`);
  assert.equal(m.alphaTest, 0);
  assert.equal(m.transparent, true);
  em._spawnMaterialRampTween(inst, 20, -1, { rampStart: 0.6, rampEnd: 0, rampTime: 0 });
  em._tickMaterialHooks(inst, 1 / 60, performance.now() + 1);
  assert.equal(m.opacity, 1);
  assert.equal(m.alphaTest, DDS_REF);
  assert.equal(m.transparent, false);
  assert.equal(m.depthWrite, true);
});

await check("7b: a value-0 Transparent hook keeps an Alpha surface blended", () => {
  const { em, inst, mat } = setup();
  em._spawnMaterialRampTween(inst, 20, -1, { rampStart: 0, rampEnd: 0, rampTime: 0 });
  const m = mat(ALPHA_DID);
  assert.equal(m.opacity, 1);
  assert.equal(m.transparent, true, "was: `flooredValue > 0` turned it opaque");
  assert.equal(m.depthWrite, false);
  assert.equal(mat(OPAQUE_DID).transparent, false);
});

await check("7c: the ethereal hint fades a ClipMap part and restores it", () => {
  const { em, inst, mat } = setup();
  em._applyEtherealToEntity(inst, true);
  const m = mat(CLIP_DID);
  assert.equal(m.opacity, 0.4);
  assert.equal(m.alphaTest, 0);
  em._applyEtherealToEntity(inst, false);
  assert.equal(m.alphaTest, DDS_REF);
  assert.equal(m.transparent, false);
  assert.equal(mat(ALPHA_DID).transparent, true);
});

console.log("-- 8 wiring ----------------------------------------------------");

await check("8: the four owners snapshot before they write and sync after", () => {
  const src = readFileSync(new URL("../scene3d/entities.js", import.meta.url), "utf8");
  assert.match(src, /import \{[^}]*\bsnapshotAuthoredAlpha\b[^}]*\bsyncFadeAlpha\b[^}]*\} from "\.\/fade_alpha_state\.js"/);
  const body = (sig) => {
    const i = src.indexOf(sig);
    assert.ok(i >= 0, `missing ${sig}`);
    return src.slice(i, src.indexOf("\n  }\n", i));
  };
  for (const sig of [
    "_applyEtherealToEntity(inst, ethereal) {",
    "_applyObjectTranslucencyToEntity(inst, translucency) {",
    "_applyCamFadeToInst(inst, o) {",
  ]) {
    const b = body(sig);
    const snap = b.indexOf("snapshotAuthoredAlpha(mat)");
    const sync = b.lastIndexOf("syncFadeAlpha(mat)");
    assert.ok(snap > 0 && snap < b.indexOf("mat.opacity ="), `${sig} snapshots before its first write`);
    assert.ok(sync > b.lastIndexOf("mat.transparent ="), `${sig} syncs after its last write`);
  }
  const ramp = body("_applyMaterialRamp(hookType, mat, value) {");
  assert.ok(ramp.indexOf("snapshotAuthoredAlpha(mat)") < ramp.indexOf("this._applyRampValueToMaterial(")
    && ramp.indexOf("syncFadeAlpha(mat)") > ramp.indexOf("this._applyRampValueToMaterial("));
  // Every tween-clock write goes through the bracket.
  const direct = src.match(/this\._applyRampValueToMaterial\(/g) || [];
  assert.equal(direct.length, 1, "only _applyMaterialRamp calls _applyRampValueToMaterial");
  assert.ok((src.match(/this\._applyMaterialRamp\(/g) || []).length >= 3);
  // camera_retail_math.test.cjs pins the per-owner opacity snapshot keys.
  for (const k of ["__preCamFadeOpacity", "__preCamFadeDepthWrite", "__preObjTransOpacity", "__preEtherealOpacity"]) {
    assert.ok(src.includes(k), k);
  }
});

console.log(`\nfade_alpha_state: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
