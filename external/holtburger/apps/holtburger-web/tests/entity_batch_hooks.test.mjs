// tests/entity_batch_hooks.test.mjs — R3-4 stage A `?entityBatch`: per-entity
// material mutations on a BATCHED rig, through the real EntityManager methods
// (scene3d/entities.js `_spawnMaterialRampTween`, `_getOrCloneEntityMaterial`,
// `_applyCamFadeToInst`, `applyObjectTranslucency`, `_applySelectionLighting`)
// and the routing in scene3d/gpu_batch/entity_batch.js (`routeRamp`,
// `noteClone`, `demote`, the re-promote poll).
//
//   1. a TransparentPart 0 -> 0 ramp on all 17 parts (the human AFK cycle)
//      makes NO clone of a batched surface (today it clones every surface of
//      the rig for good): leaf materials, `_entityMaterials` and the state
//      rows stay authored, the rig stays active, 7 draws; only the
//      legacy-only placeholder surface goes down today's path (cloned, as
//      today). The flag-off arm of the same ramps clones every surface.
//   2. 1 -> 1 on part 3 collapses EVERY leaf of that surface entity-wide (the
//      parts it is alone on: zero part rows; the parts it shares: zero
//      `hbEntPart` vertices), the draws stay 7, and the collapsed leaves stay
//      raycastable (the facade hits the leaf itself), as the legacy rig's
//      opacity-0 clone does; a snap show (time 0, -> 0) clears it.
//   3. a real fade (Transparent 0 -> 1 over 0.3 s) demotes first: leaves
//      unparked, batch mesh hidden, the tween runs on legacy clones as today;
//      ending at 1 it STAYS demoted; a fade-in back to 0 re-promotes the rig
//      with the clones as members and rows equal to authored (verify()).
//   4. a hidden surface is materialized into the legacy rig at a demote
//      (today's hide path), so the legacy rig shows what the batch showed.
//   5. any `_getOrCloneEntityMaterial` caller demotes BEFORE the re-point:
//      `_repointEntityMeshes` only ever sees unparked leaves.
//   6. `?fadeAlphaParity=off`: a show demotes (only a hide is exact there).
//   7. Luminous (8) / Diffuse (10) ramps demote; camera fade, object
//      translucency and selection flash demote and re-promote when authored
//      again.
//   4b. a hide whose tween would still be running is put back into
//      `_materialHookTweens` at the demote (today's body would still have it).
//   4c. so is a SHOW (0 -> 0) the batch took: at the demote the surface gets
//      today's clone at 0 and the still-running tween, which then overwrites
//      the camera fade that demoted the rig, exactly as on the flag-off rig.
//   7c. texture velocity and an ethereal ghost (`?etherealGhost=on`) demote
//      by their own reason (H8, before the owner's clone loop); the ghost
//      re-promotes once cleared, a stopped scroll keeps its offset (its
//      per-entity maps cannot batch: the rig stays on its legacy leaves).
//   8. a SHARED member that turns translucent in place (no clone: the leaf
//      keeps its original material) demotes its rigs (member drift) and they
//      stay demoted until it is opaque again — the re-promote poll
//      re-qualifies every leaf, not only re-pointed ones.
//   9. `_ethereal` with `?etherealGhost` off is state only (no visual): it
//      does not hold a rig legacy.
//   10. a CONSTANT ramp tween (the AFK 0 -> 0 show taken by today's body
//      before the plan) does not hold the plan; a moving one does.
//   11. demotes count toward the re-plan limit (design §9.2): every demote
//      adds one, and demote / re-promote cycles end `legacy:unstable` past the
//      limit; an active rig forgives one count per
//      ENTITY_BATCH_CHURN_FORGIVE_FRAMES.
//
// Run from apps/holtburger-web/:  node tests/entity_batch_hooks.test.mjs

import * as R from "./entity_batch_rig.mjs";
import assert from "node:assert/strict";

const { THREE, EB, D } = R;
const { LIGHTING_MODE } = await import("../scene3d/selection_lighting.js");
const { check, done } = R.suite("entity_batch_hooks");

await check("0. the batch module exists", () => R.requireBatch());

async function activeRig(guid = 0x50000701, opts = {}) {
  const w = await R.world(true);
  const inst = await w.spawn(guid, 10, 10, 0, opts);
  w.settle();
  assert.equal(inst._hbBatch.status, "active");
  return { w, inst, b: inst._hbBatch, eb: w.em._entityBatch };
}
const clean = (eb) => {
  const v = eb.verify();
  assert.deepEqual([v.rowMismatches, v.stateMismatches, v.parkMismatches, v.attrMismatches], [0, 0, 0, 0], JSON.stringify(v.details));
};
const leafOfDid = (inst, did) => R.leavesOf(inst).filter((l) => l.userData.surfaceDid === did);
const AFK = { rampStart: 0, rampEnd: 0, rampTime: 0.833 };
// Material ramp tweens run on the wall clock (performance.now): age them.
const ageTweens = (inst, ms) => { for (const tw of inst._materialHookTweens || []) tw.startMs -= ms; };

await check("1. TransparentPart 0 -> 0 on every part: no clone of a batched surface, still active", async () => {
  const { w, inst, b, eb } = await activeRig();
  const mats = R.leavesOf(inst).map((l) => l.material);
  let clones = 0;
  const clone0 = THREE.Material.prototype.clone;
  THREE.Material.prototype.clone = function () { clones += 1; return clone0.call(this); };
  try {
    for (let p = 0; p < 17; p += 1) w.em._spawnMaterialRampTween(inst, 7, p, AFK);
    w.frame(10);
  } finally { THREE.Material.prototype.clone = clone0; }
  assert.equal(b.status, "active");
  assert.deepEqual([...(inst._entityMaterials || new Map()).keys()], [D.NOTHING], "only the legacy placeholder took today's path");
  assert.equal(clones, 1, "one clone (the legacy-only surface), not one per surface");
  R.leavesOf(inst).forEach((l, i) => { if (l.userData.surfaceDid !== D.NOTHING) assert.equal(l.material, mats[i]); });
  assert.equal(w.drawsOf().length, 7);
  assert.ok(eb.stats().hooks["7:show"] >= 16);
  clean(eb);
  // Today's path (flag off): the same ramps clone every surface of the rig.
  const off = await R.world(false);
  const o = await off.spawn(0x50000702);
  off.frame(2);
  for (let p = 0; p < 17; p += 1) off.em._spawnMaterialRampTween(o, 7, p, AFK);
  assert.equal(o._entityMaterials.size, 9, "flag off: all nine surfaces cloned");
});

await check("2. 1 -> 1 collapses the surface entity-wide; the leaves stay raycastable; a snap show clears", async () => {
  const { w, inst, b, eb } = await activeRig(0x50000711);
  w.em._spawnMaterialRampTween(inst, 7, 3, { rampStart: 1, rampEnd: 1, rampTime: 0.4 });
  w.frame(2);
  assert.equal(b.status, "active");
  assert.equal(inst._entityMaterials?.has(D.A) ?? false, false, "no clone");
  const plan = b.plan;
  const rows = eb._partRows.data;
  const aParts = new Set();
  plan.batch.forEach((c, i) => {
    if (c.did === D.A) { assert.equal(b.collapsed[i], 1); aParts.add(c.part); } else assert.equal(b.collapsed[i], 0);
  });
  assert.deepEqual([...aParts].sort((x, y) => x - y), [0, 3, 5, 9, 16]);
  for (const p of [0, 3, 5, 9]) { // A is the part's only batched leaf: the part row is zero
    assert.equal(b.partAllCollapsed[p], 1);
    const r = plan.partRow[p];
    for (let k = 0; k < 16; k += 1) assert.equal(rows[r * 16 + k], 0, `part ${p} row zeroed`);
  }
  const i16 = plan.batch.findIndex((c) => c.did === D.A && c.part === 16);
  const sl = b.slices[i16];
  assert.equal(b.partAllCollapsed[16], 0);
  for (let v = sl.vertexStart; v < sl.vertexStart + sl.vertexCount; v += 1) assert.equal(b.attrPart.array[v], 0, "the head's A vertices collapse");
  const h1 = plan.batch.findIndex((c) => c.did === D.H1);
  assert.equal(b.attrPart.array[b.slices[h1].vertexStart], plan.partRow[16], "the rest of the head draws");
  assert.equal(w.drawsOf().length, 7);
  // Raycast: the facade answers with the leaf itself (the legacy rig hits its opacity-0 clone the same way).
  w.scene.updateMatrixWorld();
  const leaf = leafOfDid(inst, D.A).find((l) => l.userData.partIndex === 3);
  const c = new THREE.Vector3();
  leaf.geometry.computeBoundingSphere();
  c.copy(leaf.geometry.boundingSphere.center).applyMatrix4(leaf.matrixWorld);
  const rc = new THREE.Raycaster();
  rc.layers.enable(1);
  const from = c.clone().add(new THREE.Vector3(0, 0, 3));
  rc.set(from, c.clone().sub(from).normalize());
  const hits = rc.intersectObject(inst.root, true);
  assert.ok(hits.some((h) => h.object === leaf), "the collapsed leaf is still hit");
  assert.ok(hits.every((h) => !h.object.userData?.hbBatchMesh), "hits name leaves, never the batch mesh");
  // Snap show.
  w.em._spawnMaterialRampTween(inst, 7, 3, { rampStart: 1, rampEnd: 0, rampTime: 0 });
  w.frame(2);
  assert.equal(b.hiddenDids, null);
  assert.ok(b.collapsed.every((x) => x === 0));
  for (const p of [0, 3, 5, 9]) assert.notEqual(rows[plan.partRow[p] * 16 + 15], 0, `part ${p} row rewritten`);
  clean(eb);
});

await check("3. a real fade demotes (tween on legacy clones); ending at 1 stays demoted; fading back re-promotes", async () => {
  const { w, inst, b, eb } = await activeRig(0x50000721);
  w.em._spawnMaterialRampTween(inst, 20, -1, { rampStart: 0, rampEnd: 1, rampTime: 0.3 });
  assert.equal(b.status, "demoted");
  assert.equal(b.reason, "fade:transparentRamp");
  for (const l of R.leavesOf(inst)) assert.notEqual(l.userData.hbParked, true);
  assert.equal(b.mesh.visible, false);
  assert.ok(inst._materialHookTweens && inst._materialHookTweens.length >= 8, "today's tween runs");
  ageTweens(inst, 150);
  w.frame(4);
  const mid = leafOfDid(inst, D.B)[0].material;
  assert.ok(mid.transparent && mid.opacity < 1 && mid.opacity > 0, "fading on the legacy clone");
  assert.equal(w.drawsOf().length, 19, "legacy leaves draw while faded");
  ageTweens(inst, 1000);
  w.frame(60);
  assert.equal(b.status, "demoted", "ended at 1: stays demoted");
  assert.equal(leafOfDid(inst, D.B)[0].material.opacity, 0);
  w.em._spawnMaterialRampTween(inst, 20, -1, { rampStart: 1, rampEnd: 0, rampTime: 0.2 });
  w.frame(4);
  assert.equal(b.status, "demoted", "fading in");
  ageTweens(inst, 1000);
  w.frame(80);
  assert.equal(b.status, "active", "re-promoted once authored again");
  const m = leafOfDid(inst, D.B)[0].material;
  assert.equal(m.userData.__disposable, true, "the member is the entity's clone now");
  assert.equal(b.plan.members[b.plan.batch.findIndex((c) => c.did === D.B)], m);
  assert.equal(w.drawsOf().length, 7);
  clean(eb);
});

await check("4. a hidden surface is materialized into the legacy rig at a demote", async () => {
  const { w, inst, b } = await activeRig(0x50000731);
  w.em._spawnMaterialRampTween(inst, 7, 1, { rampStart: 1, rampEnd: 1, rampTime: 0.1 });
  w.frame(2);
  assert.ok(b.hiddenDids && b.hiddenDids.has(D.B));
  w.em._applyCamFadeToInst(inst, 0.5);
  assert.equal(b.status, "demoted");
  const bm = leafOfDid(inst, D.B)[0].material;
  assert.equal(bm.userData.__disposable, true);
  assert.ok(bm.opacity === 0 || bm.visible === false, "B is hidden on the legacy rig too");
  assert.equal(b.hiddenDids, null);
});

await check("4b. a hide whose tween would still run is put back into _materialHookTweens at a demote", async () => {
  const { w, inst, b } = await activeRig(0x50000735);
  w.em._spawnMaterialRampTween(inst, 7, 1, { rampStart: 1, rampEnd: 1, rampTime: 60 });
  w.frame(2);
  assert.ok(b.hiddenDids && b.hiddenDids.has(D.B));
  assert.equal(inst._materialHookTweens ?? null, null, "the batch took the hook: no tween while active");
  w.em._applyCamFadeToInst(inst, 0.5);
  assert.equal(b.status, "demoted");
  const tw = (inst._materialHookTweens || []).filter((t) => t.surfaceDid === D.B);
  assert.equal(tw.length, 1, "today's tween is back");
  assert.deepEqual([tw[0].hookType, tw[0].rampStart, tw[0].rampEnd, tw[0].durationMs], [7, 1, 1, 60000]);
  w.frame(3);
  const bm = leafOfDid(inst, D.B)[0].material;
  assert.ok(bm.opacity === 0 || bm.visible === false, "still hidden while the tween runs");
});

await check("4c. a show is materialized at a demote like a hide: today's clone at 0 and its still-running tween, which then overwrites the fade", async () => {
  const SHOW = { rampStart: 0, rampEnd: 0, rampTime: 60 };
  const run = async (w, inst) => {
    w.em._spawnMaterialRampTween(inst, 7, 1, SHOW);
    w.frame(2);
    w.em._applyCamFadeToInst(inst, 0.5);
    const bm = leafOfDid(inst, D.B)[0].material;
    const atFade = [bm.userData.__disposable === true, bm.transparent, bm.opacity];
    w.frame(1);
    const tw = (inst._materialHookTweens || []).filter((t) => t.surfaceDid === D.B).map((t) => [t.hookType, t.rampStart, t.rampEnd, t.durationMs]);
    return { atFade, after: [bm.transparent, bm.opacity, bm.depthWrite], tw, same: leafOfDid(inst, D.B)[0].material === bm };
  };
  // Today (flag off).
  const off = await R.world(false);
  const o = await off.spawn(0x50000738);
  off.frame(2);
  const today = await run(off, o);
  assert.deepEqual(today.atFade, [true, true, 0.5], "today: the fade writes the show's clone");
  assert.deepEqual(today.after, [false, 1, true], "today: the show's tween overwrites the fade on the next tick");
  // Batch: the rig is active when the show comes (no clone, no tween), demoted by the fade.
  const { w, inst, b } = await activeRig(0x50000737);
  const before = leafOfDid(inst, D.B)[0].material;
  w.em._spawnMaterialRampTween(inst, 7, 1, SHOW);
  assert.equal(b.status, "active");
  assert.equal(leafOfDid(inst, D.B)[0].material, before, "no clone while active");
  assert.equal((inst._materialHookTweens || []).filter((t) => t.surfaceDid === D.B).length, 0, "no tween while active");
  w.frame(2);
  w.em._applyCamFadeToInst(inst, 0.5);
  assert.equal(b.status, "demoted");
  const tw = (inst._materialHookTweens || []).filter((t) => t.surfaceDid === D.B);
  assert.equal(tw.length, 1, "today's tween is back");
  assert.deepEqual([tw[0].hookType, tw[0].rampStart, tw[0].rampEnd, tw[0].durationMs], [7, 0, 0, 60000]);
  const bm = leafOfDid(inst, D.B)[0].material;
  assert.deepEqual([bm.userData.__disposable === true, bm.transparent, bm.opacity], today.atFade, "the fade wrote the entity's clone, as today");
  w.frame(1);
  assert.deepEqual([bm.transparent, bm.opacity, bm.depthWrite], today.after, "and the show's tween overwrote it, as today");
  assert.deepEqual(tw.map((t) => [t.hookType, t.rampStart, t.rampEnd, t.durationMs]), today.tw);
});

await check("5. any clone-getter caller demotes BEFORE the re-point", async () => {
  const { w, inst, b } = await activeRig(0x50000741);
  const seen = [];
  const rp = w.em._repointEntityMeshes;
  w.em._repointEntityMeshes = function (i, did, mat) {
    for (const l of R.leavesOf(i)) if (l.userData.surfaceDid === did) seen.push(l.userData.hbParked === true);
    return rp.call(this, i, did, mat);
  };
  const m = w.em._getOrCloneEntityMaterial(inst, D.C);
  assert.ok(m && m.userData.__disposable);
  assert.equal(b.status, "demoted");
  assert.equal(b.reason, "clone:other");
  assert.ok(seen.length >= 3 && seen.every((x) => x === false), "every re-pointed leaf was unparked");
  // The clone is authored: the poll re-promotes with it as the member.
  w.frame(40);
  assert.equal(b.status, "active");
});

await check("6. ?fadeAlphaParity=off: a show demotes", async () => {
  const { inst, b, eb } = await activeRig(0x50000751);
  const r = eb.routeRamp(inst, 7, 3, AFK, false);
  assert.equal(r, null);
  assert.equal(b.status, "demoted");
  assert.equal(b.reason, "fade:transparentRamp");
  assert.equal(EB.classifyTransparentRamp(1, 1, 0.5, false), "hide", "a hide is still exact");
});

await check("7a. Luminous (8) and Diffuse (10) ramps demote", async () => {
  for (const [hook, why] of [[8, "ramp:luminous"], [10, "ramp:diffuse"], [9, "ramp:luminous"], [11, "ramp:diffuse"]]) {
    const { w, inst, b } = await activeRig(0x50000760 + hook);
    w.em._spawnMaterialRampTween(inst, hook, hook & 1 ? 2 : -1, { rampStart: 0.2, rampEnd: 0.8, rampTime: 0.2 });
    assert.equal(b.status, "demoted");
    assert.equal(b.reason, why);
  }
});

await check("7b. camera fade / object translucency / selection flash demote and re-promote", async () => {
  {
    const { w, inst, b, eb } = await activeRig(0x50000771);
    w.em._applyCamFadeToInst(inst, 0.4);
    assert.equal(b.status, "demoted"); assert.equal(b.reason, "fade:camera");
    w.frame(20);
    assert.equal(b.status, "demoted", "still faded");
    w.em._applyCamFadeToInst(inst, 1);
    w.frame(40);
    assert.equal(b.status, "active");
    clean(eb);
  }
  {
    const { w, inst, b, eb } = await activeRig(0x50000772);
    w.em.applyObjectTranslucency(0x50000772, 0.5);
    assert.equal(b.status, "demoted"); assert.equal(b.reason, "fade:objectTranslucency");
    w.frame(20);
    assert.equal(b.status, "demoted");
    w.em.applyObjectTranslucency(0x50000772, 0);
    w.frame(40);
    assert.equal(b.status, "active");
    clean(eb);
  }
  {
    const { w, b, eb } = await activeRig(0x50000773);
    w.em._applySelectionLighting(0x50000773, LIGHTING_MODE.HIGH);
    assert.equal(b.status, "demoted"); assert.equal(b.reason, "selectionFlash");
    w.frame(20);
    assert.equal(b.status, "demoted", "lit");
    w.em._applySelectionLighting(0x50000773, LIGHTING_MODE.RESTORE);
    w.frame(40);
    assert.equal(b.status, "active");
    clean(eb);
  }
});

await check("7c. texture velocity / an ethereal ghost demote by their own reason (H8); the ghost re-promotes once cleared", async () => {
  {
    const { w, inst, b, eb } = await activeRig(0x50000775);
    w.em._setTextureVelocity(inst, -1, 0.25, 0);
    assert.equal(b.status, "demoted");
    assert.equal(b.reason, "texVel", "H8: demoted before the clone loop (not 'clone:other')");
    w.frame(30);
    assert.equal(b.status, "demoted", "scrolling");
    w.em._setTextureVelocity(inst, -1, 0, 0);
    w.frame(60);
    // Stopped, the scrolled per-entity maps keep their offset (as today):
    // those leaves cannot batch, so the rig stays on its legacy leaves.
    const leaf = R.leavesOf(inst)[0];
    assert.notEqual(leaf.material.map.offset.x, 0);
    assert.ok(EB.leafRouteReason(leaf, { animated: () => false }), "a scrolled map is not batchable");
    assert.equal(b.status, "demoted");
    assert.equal(b.reason, "texVel");
    for (const l of R.leavesOf(inst)) assert.notEqual(l.userData.hbParked, true);
    void eb;
  }
  {
    const { w, inst, b, eb } = await activeRig(0x50000776);
    eb._etherealGhost = true; // as ?etherealGhost=on hands it to the constructor
    w.em._applyEtherealToEntity(inst, true);
    assert.equal(b.status, "demoted");
    assert.equal(b.reason, "fade:ethereal", "H8: demoted before the clone loop (not 'clone:other')");
    w.frame(30);
    assert.equal(b.status, "demoted", "ghosted");
    w.em._applyEtherealToEntity(inst, false);
    w.frame(60);
    assert.equal(b.status, "active");
    clean(eb);
  }
});

await check("8. a shared member turning translucent in place: demoted until opaque again", async () => {
  const { w, inst, b, eb } = await activeRig(0x50000781);
  const leaf = leafOfDid(inst, D.C)[0];
  const m = leaf.material; // the cache material, shared, never cloned here
  m.transparent = true;
  m.opacity = 0.5;
  w.frame(1);
  assert.equal(b.status, "demoted");
  assert.equal(b.reason, "drift:blend");
  assert.equal(leaf.material, m, "no clone: the leaf keeps its original member");
  const demotes = eb.stats().demotes;
  w.frame(60);
  assert.equal(b.status, "demoted", "still translucent: stays demoted (every leaf is re-qualified)");
  assert.equal(eb.stats().demotes, demotes, "a persisting drift does not demote again");
  m.transparent = false;
  m.opacity = 1;
  w.frame(40);
  assert.equal(b.status, "active");
  assert.equal(w.drawsOf().length, 7);
  clean(eb);
});

await check("9. `_ethereal` with ?etherealGhost off is state only: it does not hold the plan", async () => {
  const w = await R.world(true);
  const inst = await w.spawn(0x50000791);
  assert.equal(inst._hbBatch.status, "pending");
  inst._ethereal = true; // entities.js hook 6 with ETHEREAL_GHOST off: state only
  w.settle();
  assert.equal(inst._hbBatch.status, "active");
  assert.equal(w.drawsOf().length, 7);
  assert.equal(w.em._entityBatch._etherealGhost, false, "the default (retail: no visual)");
});

await check("10. a constant ramp tween does not hold the plan; a moving one does", async () => {
  const w = await R.world(true);
  const a = await w.spawn(0x500007a1);
  const c = await w.spawn(0x500007a2, 11, 10, 0);
  assert.equal(a._hbBatch.status, "pending");
  // Before the plan, today's body takes the hooks (clones + tweens).
  for (let p = 0; p < 17; p += 1) w.em._spawnMaterialRampTween(a, 7, p, { rampStart: 0, rampEnd: 0, rampTime: 60 });
  w.em._spawnMaterialRampTween(c, 7, 1, { rampStart: 0, rampEnd: 0.5, rampTime: 60 });
  assert.ok(a._materialHookTweens.length >= 9 && c._materialHookTweens.length === 1);
  w.settle(60);
  assert.equal(a._hbBatch.status, "active", "the AFK show's constant tweens do not hold the plan");
  assert.ok(a._materialHookTweens && a._materialHookTweens.length >= 9, "the tweens still run");
  assert.equal(c._hbBatch.status, "pending");
  assert.equal(c._hbBatch.reason, "fadeOwner:ramp", "a moving tween holds it");
  clean(w.em._entityBatch);
});

await check("11. demotes count toward the re-plan limit; an active rig forgives one per CHURN_FORGIVE_FRAMES", async () => {
  const { w, inst, b } = await activeRig(0x500007b1);
  let cycles = 0;
  for (; cycles < 12; cycles += 1) {
    const r0 = b.replans;
    w.em._applyCamFadeToInst(inst, 0.5);
    if (b.status === "legacy") break;
    assert.equal(b.status, "demoted");
    assert.equal(b.replans, r0 + 1, `cycle ${cycles}: the demote counts`);
    w.em._applyCamFadeToInst(inst, 1);
    w.frame(20);
    assert.equal(b.status, "active", `cycle ${cycles} re-promoted`);
  }
  assert.ok(cycles <= EB.ENTITY_BATCH_REPLAN_LIMIT, `unstable after ${cycles} full cycles`);
  assert.equal(b.status, "legacy");
  assert.equal(b.reason, "unstable");
  for (const l of R.leavesOf(inst)) assert.notEqual(l.userData.hbParked, true);
  assert.equal(inst.root.children.some((c) => c.userData?.hbBatchMesh), false);
  w.em._applyCamFadeToInst(inst, 1);
  w.frame(40);
  assert.equal(b.status, "legacy", "for life");
  // The forgiveness: a rig that stays active long enough earns one back.
  const r2 = await activeRig(0x500007b2);
  for (let k = 0; k < 3; k += 1) { r2.w.em._applyCamFadeToInst(r2.inst, 0.5); r2.w.em._applyCamFadeToInst(r2.inst, 1); r2.w.frame(20); }
  assert.equal(r2.b.status, "active");
  const n = r2.b.replans;
  assert.ok(n >= 3);
  r2.w.frame(5);
  assert.equal(r2.b.replans, n, "not forgiven before the window");
  r2.b.activeSince -= EB.ENTITY_BATCH_CHURN_FORGIVE_FRAMES;
  r2.w.frame(1);
  assert.equal(r2.b.replans, n - 1);
  r2.w.frame(5);
  assert.equal(r2.b.replans, n - 1, "one per window");
});

done();
