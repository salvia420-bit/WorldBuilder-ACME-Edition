// tests/selection_lighting.test.mjs — lighting-materials-6 (2026-10-13,
// `?selectionFlash=on`, DEFAULT OFF): retail's click flash.
//
// Retail UIElement_SmartBoxWrapper::RecvNotice_SmartBoxObjectFound
// (acclient.c:275631) restores the object still blinking when a find moves off
// it, and a find for sr_Select or above lights the found object HIGH
// (CPhysicsObj::SetLighting(0.99, 1.0)) with m_cFlipCount = 1 and a 0.2 s timer.
// Global_Loop (:275388) then flips LOW / HIGH / LOW and restores on the 5th
// count. ApplyLighting (:275174): LOW = (0.0, 0.35), HIGH = (0.99, 1.0).
//
//   1. module: the state machine — HIGH → LOW → HIGH → LOW → restore at
//      0 / 0.2 / 0.4 / 0.6 / 0.8 s; MouseOver lights nothing; a new find
//      restores the old guid first; Drop / TargetedUse light but do not select.
//   2. module: the levels on real three materials — HIGH is color 0 + emissive
//      0.99 over `map`, LOW is 0.35 × the authored colour, restore is exact;
//      the emissiveMap define flips twice per flash; luminous / unlit skipped.
//   3. module: the flag is an exact `=on` opt-in.
//   4. real EntityManager: a flash clones the entity's own surfaces, leaves the
//      shared cache material, luminous surfaces and the wielded child alone,
//      and the restore brings every written material back; off = no-op.
//   5. wiring: picking.js mouse paths only — never setSelectedTarget /
//      selectionChanged, and nothing under rynth/ or plugins/.
//
// Run from apps/holtburger-web/:  node tests/selection_lighting.test.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const THREE = await import("three");
const S = await import("../scene3d/selection_lighting.js");
const { EntityManager } = await import("../scene3d/entities.js");

const { SEARCH_REASON: R, LIGHTING_MODE: M } = S;

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const rgb = (c) => [c.r, c.g, c.b];
const assertRgb = (c, want, msg) => {
  for (let i = 0; i < 3; i++) assert.ok(near(rgb(c)[i], want[i]), `${msg}: got ${rgb(c)} want ${want}`);
};

function recorder() {
  const calls = [];
  const sl = new S.SelectionLighting((g, mode) => calls.push([g, mode]));
  return { sl, calls };
}

console.log("-- 1 the state machine -----------------------------------------");

const G = 0x50000001, H = 0x50000002;

await check("1a: Select → HIGH at 0, LOW 0.2, HIGH 0.4, LOW 0.6, restore 0.8", () => {
  const { sl, calls } = recorder();
  assert.equal(sl.objectFound(G, R.Select, 0), true, "sr_Select selects");
  assert.deepEqual(calls, [[G, M.HIGH]]);
  assert.equal(sl.flipCount, 1);
  assert.ok(near(sl.timeNextFlip, 0.2));
  sl.tick(0.1);
  assert.equal(calls.length, 1, "nothing before the 0.2 s deadline");
  sl.tick(0.2);
  sl.tick(0.4);
  sl.tick(0.6);
  sl.tick(0.8);
  assert.deepEqual(calls, [[G, M.HIGH], [G, M.LOW], [G, M.HIGH], [G, M.LOW], [G, M.RESTORE]]);
  assert.equal(sl.flipCount, 0);
  assert.equal(sl.litGuid, 0);
  assert.equal(sl.active, false);
  sl.tick(1.0);
  sl.tick(5.0);
  assert.equal(calls.length, 5, "idle after the restore");
});

await check("1b: one late frame advances one step (retail re-arms from cur_time)", () => {
  const { sl, calls } = recorder();
  sl.objectFound(G, R.Select, 10);
  sl.tick(10.7);
  assert.deepEqual(calls.at(-1), [G, M.LOW], "a late frame is one flip, not three");
  assert.ok(near(sl.timeNextFlip, 10.9));
});

await check("1c: MouseOver lights nothing (and never selects)", () => {
  const { sl, calls } = recorder();
  assert.equal(sl.objectFound(G, R.MouseOver, 0), false);
  assert.equal(sl.objectFound(G, R.None, 0), false);
  assert.deepEqual(calls, []);
  assert.equal(sl.active, false);
});

await check("1d: a new find restores the old guid first, then lights the new one", () => {
  const { sl, calls } = recorder();
  sl.objectFound(G, R.Select, 0);
  sl.tick(0.2);
  sl.objectFound(H, R.Select, 0.3);
  assert.deepEqual(calls, [[G, M.HIGH], [G, M.LOW], [G, M.RESTORE], [H, M.HIGH]]);
  assert.equal(sl.litGuid, H);
  assert.equal(sl.flipCount, 1);
  assert.ok(near(sl.timeNextFlip, 0.5));
});

await check("1e: re-finding the blinking object re-lights it and re-arms, no restore", () => {
  const { sl, calls } = recorder();
  sl.objectFound(G, R.Select, 0);
  sl.tick(0.2);
  sl.tick(0.4);
  sl.objectFound(G, R.Use, 0.5); // the double-click's second press
  assert.deepEqual(calls, [[G, M.HIGH], [G, M.LOW], [G, M.HIGH], [G, M.HIGH]]);
  assert.equal(sl.flipCount, 1);
  assert.ok(near(sl.timeNextFlip, 0.7));
});

await check("1f: a MouseOver find of another object (or nothing) ends the blink; the same object does not", () => {
  const { sl, calls } = recorder();
  sl.objectFound(G, R.Select, 0);
  sl.objectFound(G, R.MouseOver, 0.05);
  assert.deepEqual(calls, [[G, M.HIGH]], "same object under the mouse: no change");
  assert.equal(sl.active, true);
  sl.objectFound(0, R.MouseOver, 0.1);
  assert.deepEqual(calls, [[G, M.HIGH], [G, M.RESTORE]]);
  assert.equal(sl.active, false);
  sl.tick(0.2);
  assert.equal(calls.length, 2, "no flip after the cancel");
  const b = recorder();
  b.sl.objectFound(G, R.Select, 0);
  b.sl.objectFound(H, R.MouseOver, 0.1);
  assert.deepEqual(b.calls, [[G, M.HIGH], [G, M.RESTORE]], "MouseOver on H restores G and does not light H");
});

await check("1g: Drop and TargetedUse light but do not select; Select / Examine / Use / Drag do", () => {
  for (const [reason, selects] of [
    [R.Drop, false], [R.TargetedUse, false],
    [R.Select, true], [R.Examine, true], [R.Use, true], [R.Drag, true],
  ]) {
    const { sl, calls } = recorder();
    assert.equal(sl.objectFound(G, reason, 0), selects, `reason ${reason}`);
    assert.deepEqual(calls, [[G, M.HIGH]], `reason ${reason} lights`);
    assert.equal(S.searchReasonSelects(reason), selects);
    assert.equal(S.searchReasonLights(reason), true);
  }
  assert.equal(S.searchReasonLights(R.MouseOver), false);
  assert.equal(S.searchReasonSelects(R.MouseOver), false);
});

await check("1h: after a finished flash a new find restores nothing (it was already restored)", () => {
  const { sl, calls } = recorder();
  sl.objectFound(G, R.Select, 0);
  for (const t of [0.2, 0.4, 0.6, 0.8]) sl.tick(t);
  sl.objectFound(H, R.Select, 2);
  assert.deepEqual(calls.slice(5), [[H, M.HIGH]]);
});

await check("1i: a find of nothing lights nothing; clear() restores a running blink", () => {
  const { sl, calls } = recorder();
  assert.equal(sl.objectFound(0, R.Select, 0), false);
  assert.deepEqual(calls, []);
  sl.objectFound(G, R.Select, 0);
  sl.clear();
  assert.deepEqual(calls, [[G, M.HIGH], [G, M.RESTORE]]);
  sl.clear();
  assert.equal(calls.length, 2, "clear when idle is a no-op");
});

await check("1j: selectionFlipStep and the retail constants", () => {
  assert.deepEqual(S.selectionFlipStep(1), { flipCount: 2, mode: M.LOW, rearm: true });
  assert.deepEqual(S.selectionFlipStep(2), { flipCount: 3, mode: M.HIGH, rearm: true });
  assert.deepEqual(S.selectionFlipStep(3), { flipCount: 4, mode: M.LOW, rearm: true });
  assert.deepEqual(S.selectionFlipStep(4), { flipCount: 0, mode: M.RESTORE, rearm: false });
  assert.deepEqual({ ...S.LIGHT_LOW }, { luminosity: 0.0, diffuse: 0.35 });
  assert.deepEqual({ ...S.LIGHT_HIGH }, { luminosity: 0.99, diffuse: 1.0 });
  assert.equal(S.SELECTION_FLIP_TIME, 0.2);
  assert.equal(S.SELECTION_FLIP_END, 5);
  assert.deepEqual({ ...M }, { RESTORE: 0, LOW: 1, HIGH: 2 });
  assert.deepEqual(Object.values(R), [0, 1, 2, 3, 4, 5, 6, 7]);
});

console.log("-- 2 the levels on three materials -----------------------------");

function textured(color = 1) {
  const m = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  m.color.setRGB(color, color, color);
  return m;
}

await check("2a: textured HIGH = color 0 + emissive 0.99 over map; LOW = 0.35 × authored; restore exact", () => {
  const m = textured(0.6);
  m.emissiveIntensity = 0.7;
  const v0 = m.version;
  assert.equal(S.applySelectionLighting(m, M.HIGH), true);
  assertRgb(m.color, [0, 0, 0], "HIGH colour");
  assertRgb(m.emissive, [0.99, 0.99, 0.99], "HIGH emissive");
  assert.equal(m.emissiveIntensity, 1);
  assert.equal(m.emissiveMap, m.map, "HIGH modulates the emissive by the texel");
  assert.equal(m.version, v0 + 1, "the emissiveMap appeared: one program swap");
  assert.equal(S.selectionLit(m), true);
  assert.equal(S.applySelectionLighting(m, M.LOW), true);
  assertRgb(m.color, [0.21, 0.21, 0.21], "LOW = 0.35 × the authored 0.6 tint");
  assertRgb(m.emissive, [0, 0, 0], "LOW emissive");
  assert.equal(m.emissiveMap, m.map, "the map stays on through LOW");
  S.applySelectionLighting(m, M.HIGH);
  S.applySelectionLighting(m, M.LOW);
  assert.equal(m.version, v0 + 1, "no define flip inside the flash");
  assert.equal(S.applySelectionLighting(m, M.RESTORE), true);
  assertRgb(m.color, [0.6, 0.6, 0.6], "restored colour");
  assertRgb(m.emissive, [0, 0, 0], "restored emissive");
  assert.equal(m.emissiveIntensity, 0.7);
  assert.equal(m.emissiveMap, null);
  assert.equal(m.version, v0 + 2, "two define flips per flash");
  assert.equal(S.selectionLit(m), false);
  assert.equal(S.restoreSelectionLighting(m), false, "a second restore is a no-op");
});

await check("2b: an untextured surface: HIGH emissive is its own colour × 0.99, no emissiveMap", () => {
  const m = new THREE.MeshStandardMaterial();
  m.color.setRGB(0.5, 0.25, 1);
  const v0 = m.version;
  S.applySelectionLighting(m, M.HIGH);
  assertRgb(m.emissive, [0.495, 0.2475, 0.99], "HIGH emissive");
  assertRgb(m.color, [0, 0, 0], "HIGH colour");
  assert.equal(m.emissiveMap, null);
  S.applySelectionLighting(m, M.RESTORE);
  assertRgb(m.color, [0.5, 0.25, 1], "restored");
  assert.equal(m.version, v0, "no define change at all");
});

await check("2c: an authored emissiveMap (a Luminous hook's) and emissive survive the flash", () => {
  const m = textured();
  m.emissiveMap = m.map;
  m.emissive.setRGB(0.3, 0.3, 0.3);
  const v0 = m.version;
  S.applySelectionLighting(m, M.HIGH);
  S.applySelectionLighting(m, M.LOW);
  S.applySelectionLighting(m, M.RESTORE);
  assert.equal(m.emissiveMap, m.map);
  assertRgb(m.emissive, [0.3, 0.3, 0.3], "hook emissive back");
  assert.equal(m.version, v0);
});

await check("2d: luminous surfaces and unlit materials are skipped", () => {
  const lum = textured();
  lum.userData.__surfaceLuminosity = 0.5;
  lum.emissive.setRGB(1, 1, 1);
  assert.equal(S.selectionLightable(lum), false);
  assert.equal(S.applySelectionLighting(lum, M.HIGH), false);
  assertRgb(lum.color, [1, 1, 1], "luminous colour untouched");
  assert.equal(lum.emissiveMap, null);
  const basic = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
  assert.equal(S.selectionLightable(basic), false, "wireframe-mode MeshBasic");
  assert.equal(S.applySelectionLighting(basic, M.HIGH), false);
  assert.equal(S.selectionLightable(null), false);
  assert.equal(S.applySelectionLighting(null, M.RESTORE), false);
});

await check("2e: a texture re-seated mid-flash is followed without a define flip", () => {
  const m = textured();
  S.applySelectionLighting(m, M.HIGH);
  const v1 = m.version;
  m.map = new THREE.Texture();
  S.applySelectionLighting(m, M.LOW);
  S.applySelectionLighting(m, M.HIGH);
  assert.equal(m.emissiveMap, m.map);
  assert.equal(m.version, v1);
  S.applySelectionLighting(m, M.RESTORE);
  assert.equal(m.emissiveMap, null);
});

console.log("-- 3 the flag ---------------------------------------------------");

await check("3a: ?selectionFlash is an exact `=on` opt-in", () => {
  assert.equal(S.selectionFlashEnabled("?selectionFlash=on"), true);
  for (const q of ["", "?selectionFlash", "?selectionFlash=1", "?selectionFlash=true", "?selectionFlash=ON", "?selectionFlash=off"]) {
    assert.equal(S.selectionFlashEnabled(q), false, q);
  }
  S._setSelectionFlashEnabledForTest(null);
  assert.equal(S.selectionFlashEnabled(), false, "node has no window: default OFF");
});

console.log("-- 4 the real EntityManager -------------------------------------");

const P = 0x50000010, SWORD = 0x50000011;
const OPAQUE_DID = 0x08000401, LUM_DID = 0x08000402, PLAIN_DID = 0x08000403, SWORD_DID = 0x08000404;

function setup() {
  const lum = textured();
  lum.emissive.setRGB(1, 1, 1);
  lum.emissiveIntensity = 0.5;
  lum.emissiveMap = lum.map;
  const plain = new THREE.MeshStandardMaterial();
  plain.color.setRGB(0.4, 0.5, 0.6);
  const shared = new Map([
    [OPAQUE_DID, textured(0.8)],
    [LUM_DID, lum],
    [PLAIN_DID, plain],
    [SWORD_DID, textured()],
  ]);
  for (const m of shared.values()) m.userData = { ...m.userData, __cacheOwned: true };
  lum.userData.__surfaceLuminosity = 0.5;
  const materialCache = {
    fallbackMaterial: new THREE.MeshBasicMaterial(),
    getCached: (did) => shared.get(did >>> 0) ?? null,
  };
  const entitiesGroup = new THREE.Group();
  const em = new EntityManager({ entitiesGroup, materialCache }, {});
  const mkInst = (guid, dids) => {
    const root = new THREE.Group();
    const parts = dids.map((did) => {
      const g = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), shared.get(did));
      mesh.userData = { guid, surfaceDid: did };
      g.add(mesh);
      root.add(g);
      return g;
    });
    return {
      guid, root, parts, meta: { setupId: 0x02000001 },
      _attachedParentGuid: null, _attachedChildren: null,
      dispose() { root.parent?.remove(root); },
    };
  };
  const inst = mkInst(P, [OPAQUE_DID, LUM_DID, PLAIN_DID]);
  entitiesGroup.add(inst.root);
  // A wielded sword: its own entity, its root mounted under the wielder's part.
  const sword = mkInst(SWORD, [SWORD_DID]);
  sword.root.userData.__attachedChildOf = P;
  sword._attachedParentGuid = P;
  inst.parts[0].add(sword.root);
  em.entityMap.set(P, inst);
  em.entityMap.set(SWORD, sword);
  const mat = (i, did) => i.parts.flatMap((p) => p.children).find((o) => o.isMesh && o.userData.surfaceDid === did).material;
  return { em, inst, sword, shared, mat };
}

await check("4a: flag off — selectionFlashFound is a no-op, nothing cloned", () => {
  S._setSelectionFlashEnabledForTest(false);
  const { em, inst, shared, mat } = setup();
  assert.equal(em.selectionFlashFound(P, R.Select), false);
  assert.equal(em._selFlash, undefined, "no controller on the default path");
  assert.equal(em.selectionFlashActive(), false);
  assert.equal(mat(inst, OPAQUE_DID), shared.get(OPAQUE_DID), "still the shared cache material");
  assert.equal(inst._entityMaterials, undefined);
});

await check("4b: a click flash lights the entity's own surfaces through per-entity clones", () => {
  S._setSelectionFlashEnabledForTest(true);
  const { em, inst, sword, shared, mat } = setup();
  assert.equal(em.selectionFlashFound(P, R.Select), true);
  assert.equal(em.selectionFlashActive(), true);
  const op = mat(inst, OPAQUE_DID);
  assert.notEqual(op, shared.get(OPAQUE_DID), "cloned, never the shared cache material");
  assert.equal(op.userData.__cacheOwned, undefined);
  assertRgb(op.color, [0, 0, 0], "HIGH colour");
  assertRgb(op.emissive, [0.99, 0.99, 0.99], "HIGH emissive");
  assert.equal(op.emissiveMap, op.map);
  assertRgb(shared.get(OPAQUE_DID).color, [0.8, 0.8, 0.8], "the shared material is untouched");
  assert.equal(shared.get(OPAQUE_DID).emissiveMap, null);
  const plain = mat(inst, PLAIN_DID);
  assertRgb(plain.emissive, [0.396, 0.495, 0.594], "untextured HIGH = own colour × 0.99");
  assert.equal(mat(inst, LUM_DID), shared.get(LUM_DID), "a luminous surface is not even cloned");
  assert.equal(mat(sword, SWORD_DID), shared.get(SWORD_DID), "the wielded child keeps its own material");
  assert.equal(sword._entityMaterials, undefined);
  S._setSelectionFlashEnabledForTest(null);
});

await check("4c: the flips and the restore land on the same clones; restore is exact", () => {
  S._setSelectionFlashEnabledForTest(true);
  const { em, inst, mat } = setup();
  em.selectionFlashFound(P, R.Select);
  const op = mat(inst, OPAQUE_DID);
  const plain = mat(inst, PLAIN_DID);
  const fl = em._selFlash;
  let t = fl.timeNextFlip;
  fl.tick(t);
  assertRgb(op.color, [0.28, 0.28, 0.28], "LOW = 0.35 × authored 0.8");
  assertRgb(op.emissive, [0, 0, 0], "LOW emissive");
  t = fl.timeNextFlip; fl.tick(t);
  assertRgb(op.color, [0, 0, 0], "HIGH again");
  t = fl.timeNextFlip; fl.tick(t);
  t = fl.timeNextFlip; fl.tick(t);
  assert.equal(em.selectionFlashActive(), false);
  assert.equal(mat(inst, OPAQUE_DID), op, "the clone stays on the mesh");
  assertRgb(op.color, [0.8, 0.8, 0.8], "restored colour");
  assertRgb(op.emissive, [0, 0, 0], "restored emissive");
  assert.equal(op.emissiveMap, null, "restored emissiveMap");
  assertRgb(plain.color, [0.4, 0.5, 0.6], "untextured restored");
  assert.equal(em._selFlashMats.size, 0);
  S._setSelectionFlashEnabledForTest(null);
});

await check("4d: clicking another entity mid-flash restores the first one", () => {
  S._setSelectionFlashEnabledForTest(true);
  const { em, inst, sword, mat } = setup();
  em.selectionFlashFound(P, R.Select);
  const op = mat(inst, OPAQUE_DID);
  em.selectionFlashFound(SWORD, R.Select);
  assertRgb(op.color, [0.8, 0.8, 0.8], "first entity restored");
  const sw = mat(sword, SWORD_DID);
  assertRgb(sw.color, [0, 0, 0], "the clicked sword is lit");
  em.selectionFlashFound(0, R.MouseOver);
  assertRgb(sw.color, [1, 1, 1], "moving off it restores it");
  assert.equal(em.selectionFlashActive(), false);
  S._setSelectionFlashEnabledForTest(null);
});

await check("4e: Drop lights without selecting; an unknown guid is harmless", () => {
  S._setSelectionFlashEnabledForTest(true);
  const { em, inst, mat } = setup();
  assert.equal(em.selectionFlashFound(P, R.Drop), false);
  assertRgb(mat(inst, OPAQUE_DID).color, [0, 0, 0], "lit");
  assert.equal(em.getSelectedTarget(), 0, "the flash never selects");
  assert.equal(em.selectionFlashFound(0x5000ffff, R.Select), true);
  assertRgb(mat(inst, OPAQUE_DID).color, [0.8, 0.8, 0.8], "previous restored");
  S._setSelectionFlashEnabledForTest(null);
});

await check("4f: setSelectedTarget never starts a flash (keyboard cycling / Rynth SelectObject)", () => {
  S._setSelectionFlashEnabledForTest(true);
  const { em, inst, shared, mat } = setup();
  em.setSelectedTarget(P);
  assert.equal(em.selectionFlashActive(), false);
  assert.equal(mat(inst, OPAQUE_DID), shared.get(OPAQUE_DID));
  S._setSelectionFlashEnabledForTest(null);
});

console.log("-- 5 wiring -----------------------------------------------------");

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const ENT = src("scene3d/entities.js");
const PICK = src("scene3d/picking.js");

function methodBody(text, sig) {
  const i = text.indexOf(`\n  ${sig}`);
  assert.ok(i >= 0, `${sig} not found`);
  const end = text.indexOf("\n  }\n", i + 1);
  return text.slice(i, end + 4);
}

await check("5a: setSelectedTarget does not call the flash module", () => {
  const body = methodBody(ENT, "setSelectedTarget(guid) {");
  for (const k of ["selectionFlash", "_selFlash", "SelectionLighting", "applySelectionLighting", "_applySelectionLighting"]) {
    assert.ok(!body.includes(k), `setSelectedTarget mentions ${k}`);
  }
  // entities.js never starts a flash itself; only picking.js does.
  assert.equal((ENT.match(/selectionFlashFound\(/g) || []).length, 1, "only the definition");
});

await check("5b: picking.js feeds Select / TargetedUse / Drop / MouseOver from its mouse handlers", () => {
  const down = PICK.slice(PICK.indexOf("function onPointerDown(ev) {"), PICK.indexOf('canvas.addEventListener("pointerdown", onPointerDown);'));
  const sel = down.indexOf("selectionFlash(newGuid, SEARCH_REASON.Select)");
  assert.ok(sel > down.indexOf("setSelectedTarget?.(guid)"), "Select after the selection");
  const tu = down.indexOf("selectionFlash(guid, SEARCH_REASON.TargetedUse)");
  assert.ok(tu > 0 && tu < down.indexOf("window.__useTargeting.resolve(guid >>> 0)"), "TargetedUse on the target pick");
  assert.ok(down.includes("selectionFlash(0, SEARCH_REASON.Select)"), "a click on nothing");
  const drop = PICK.slice(PICK.indexOf("function onCanvasDrop(ev) {"), PICK.indexOf('canvas.addEventListener("dragover"'));
  assert.ok(drop.includes("SEARCH_REASON.Drop"), "Drop in onCanvasDrop");
  assert.ok(PICK.includes("SEARCH_REASON.MouseOver"), "the mouse-over re-find");
  assert.ok(PICK.includes('if (SELECTION_FLASH) canvas.addEventListener("pointermove", onPointerMoveSelectionFlash);'),
    "the re-find listener exists only with the flag on");
  assert.ok(PICK.includes('canvas.removeEventListener("pointermove", onPointerMoveSelectionFlash);'));
  assert.ok(/function selectionFlash\(guid, reason\) \{\n\s+if \(!SELECTION_FLASH\) return;/.test(PICK), "flag-gated helper");
  assert.ok(PICK.includes('const SELECTION_FLASH = typeof selectionFlashEnabled === "function" ? selectionFlashEnabled() : false;'));
  // No selectionChanged listener drives it.
  assert.ok(!/selectionChanged[^\n]*selectionFlash/.test(PICK));
});

await check("5c: nothing under rynth/ or plugins/ reaches the flash", () => {
  const walk = (dir, out = []) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(m?js|cjs)$/.test(n)) out.push(p);
    }
    return out;
  };
  const root = new URL("..", import.meta.url).pathname;
  for (const dir of ["rynth", "plugins"]) {
    for (const f of walk(join(root, dir))) {
      const t = readFileSync(f, "utf8");
      assert.ok(!/selectionFlash|selection_lighting/.test(t), `${f} references the flash`);
    }
  }
});

await check("5d: the flip clock runs from EntityManager.tick before the dt early-out", () => {
  const body = methodBody(ENT, "tick(dt) {");
  const t = body.indexOf("if (this._selFlash) this._selFlash.tick(selectionFlashNow());");
  assert.ok(t > 0, "tick drives the flips");
  assert.ok(t < body.indexOf("if (!(dt > 0)) {"), "before the dt-recovery early return");
});

console.log(`\nselection_lighting: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
