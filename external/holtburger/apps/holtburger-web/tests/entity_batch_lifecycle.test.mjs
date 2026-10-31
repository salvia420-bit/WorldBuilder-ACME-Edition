// tests/entity_batch_lifecycle.test.mjs — R3-4 stage A `?entityBatch`
// (DEFAULT OFF): the lifecycle of a batched rig (scene3d/gpu_batch/
// entity_batch.js + its hooks in scene3d/entities.js), on the shared world of
// tests/entity_batch_rig.mjs (the REAL EntityManager spawning 17-part rigs,
// three r184 over the recording fake WebGL2).
//
//   1. flag OFF is byte-identical: a fixed scenario (two rigs, one recolored;
//      walking; TransparentPart 0 -> 0 and 1 -> 1 ramps; a camera fade and
//      back) gives, phase by phase, the SAME scene graph, the SAME draw
//      program + uniform snapshots, the SAME GL call counts and the SAME
//      programs as the pre-change tree did (golden below: captured by the
//      very same `flagOffFingerprint()` on a scratch copy of the tree before
//      R3-4, entities.js + no entity_batch.js); no `window.__entityBatch`,
//      the kit never touched (`kitSummary().budget === null`), and
//      `em._entityBatch === null`.
//   2. flag ON: two plain rigs and two recolored ones 76 -> 28 draws (each
//      rig: 19 legacy leaves -> 7 batch runs), every rig active, the leaves
//      parked on layer 31, verify() clean (part rows, state rows, slots).
//   3. qualification: wireframe / shadows keep the batch inert (nothing
//      allocated); weaponFx and a VFX-plan leaf keep their rig legacy for
//      life; a mapless (spawn-race fallback) leaf waits, and the rig batches
//      once the leaf heals; a single-surface rig stays legacy
//      (`nothingToBatch`).
//   4. an equip (the real `_applyAppearanceHotSwap`, a new recolor) tears the
//      batch down (legacy leaves back) and re-plans it on new leaves with a
//      new entry key and new value-keyed layers.
//   4b. ReplaceObject keeps a rig legacy for life: the H10 teardown (legacy
//      leaves back, batch mesh gone, no re-plan), and — without the hook — a
//      `replaced` leaf appearing under a part is caught by the next tick's
//      structure guard the same way;
//   5. release (`em.remove`): the first rig frees its part rows, layer refs,
//      state refs and entry user, while the class materials and the shared
//      entry stay for the second rig; the second rig's release leaves 0
//      live layers, 0 state rows, 0 part rows, the entry idle.
//   6. a WebGL context loss and restore: torn down at the canvas event
//      (legacy back), NO GL delete of an object made before the loss, the
//      batch re-planned and active again on the restored context.
//   7. the SwiftShader smoke's arms (harness/glsl_smoke/entity_batch_lib.mjs
//      runEntityArm, the orchestrator runs the browser smoke) dry-run here
//      on the fake GL: humans / clamp (the light-clamp chain) / mixed
//      (translucent + luminous legacy leaves in a batched rig) / front
//      (`?perPolyCull` FrontSide class) / flash (demoted) / overlap reach the
//      statuses the smoke expects, with fewer draws than the off load.
//   1b. the module allocates nothing at import: no top-level `new`, array or
//      object literal in scene3d/gpu_batch/entity_batch.js (entities.js
//      imports it statically, so this runs with the flag off too).
//   7b. every field of the smoke's ARMS table is read by the smoke.
//   8. EntityManager.dispose() disposes the batch (H15): records released,
//      leaves unparked, part rows / class materials freed, no
//      `window.__entityBatch` left behind.
//   9. the overlap keeps the leaves drawn until three has drawn every class
//      material once: a rig built while nothing renders stays in overlap with
//      its leaves unparked; after its first drawn frame it activates.
//   10. the tick's dt <= 0 exit (the dt-recovery window) syncs the batch too
//      (H4), and the particle call stays that branch's last statement (the
//      pin test_particle_clock.mjs reads).
//   11. the shared-entry key is the appearance the leaves were BUILT from:
//      the spawn's own (post-LOD) modelChanges, not `inst.meta`'s.
//   12. a batch mesh clones and serializes: its record link is not
//      enumerable (Object3D.copy / toJSON stringify `userData`).
//
// Run from apps/holtburger-web/:  node tests/entity_batch_lifecycle.test.mjs

import * as R from "./entity_batch_rig.mjs";
import assert from "node:assert/strict";

const { THREE, EB, KIT, D } = R;
const { check, done } = R.suite("entity_batch_lifecycle");

// Captured 2026-10-30 by flagOffFingerprint() on the PRE-change tree
// (r3-batching/r3-4/impl/pretree: entities.js before R3-4, no
// entity_batch.js). `batchProp` there is "undefined" (no property); with the
// flag off it is now `null` (the constructor's one new field).
const GOLDEN = {
  phases: [
    { tag: "walk", draws: 38, graph: "9b9f0b7e", nodes: 79, snaps: "59acafcb", counts: "018b00fe" },
    { tag: "ramps", draws: 38, graph: "9b9f0b7e", nodes: 79, snaps: "5d66ccb6", counts: "881adc6f" },
    { tag: "camFade", draws: 38, graph: "9b9f0b7e", nodes: 79, snaps: "57c76530", counts: "881adc6f" },
    { tag: "back", draws: 38, graph: "9b9f0b7e", nodes: 79, snaps: "20b9c546", counts: "881adc6f" },
  ],
  programs: "decc9fed", programCount: 11, diagGlobal: "undefined", kitBudget: "null",
};

await check("0. the batch module exists", () => R.requireBatch());

await check("1. flag OFF: the scene graph, draw stream, GL counts and programs equal the pre-change tree's", async () => {
  const fp = await R.flagOffFingerprint();
  const { batchProp, ...rest } = fp;
  assert.equal(batchProp, "null", "EntityManager._entityBatch is null with the flag off");
  assert.deepEqual(rest, GOLDEN);
});

const fs = await import("node:fs");
const SRC_EB = fs.readFileSync(new URL("../scene3d/gpu_batch/entity_batch.js", import.meta.url), "utf8");
const SRC_ENT = fs.readFileSync(new URL("../scene3d/entities.js", import.meta.url), "utf8");

await check("1b. the module allocates nothing at import (no top-level new / array / object literal)", () => {
  const bad = [];
  for (const line of SRC_EB.split("\n")) {
    const m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const rhs = m[2];
    if (/^(?:\(|async\s*\(|function\b)/.test(rhs)) continue; // a function value (code, not data)
    if (/\bnew\s|^\[|^\{|Object\.(?:freeze|create|assign)\(|\bnew$/.test(rhs)) bad.push(line.trim());
  }
  assert.deepEqual(bad, []);
});

const PAL = { paletteId: 0x04000a01, subPalettes: Uint32Array.of(0x0400aa01, 0, 8) };
const PAL2 = { paletteId: 0x04000a01, subPalettes: Uint32Array.of(0x0400bb02, 0, 8) };

await check("2. flag ON: four rigs 76 -> 28 draws, all active, leaves parked, verify clean", async () => {
  const w = await R.world(true);
  const rigs = [await w.spawn(0x50000201, 10, 10, 0), await w.spawn(0x50000202, 10.6, 10, 0),
    await w.spawn(0x50000203, 11.2, 10, 0, PAL), await w.spawn(0x50000204, 11.8, 10, 0, PAL2)];
  const legacy = w.drawsOf();
  assert.equal(legacy.length, 76, "4 x 19 legacy leaves before the first sync");
  w.settle();
  const st = w.em._entityBatch.stats();
  assert.deepEqual(st.byStatus, { active: 4 });
  const draws = w.drawsOf();
  assert.equal(draws.length, 28);
  assert.ok(draws.every((d) => d.kind === "drawArraysInstanced"), "batch draws only (the hidden placeholder draws nothing)");
  for (const r of rigs) {
    for (const l of R.leavesOf(r)) {
      if (l.userData.surfaceDid === D.NOTHING) { assert.equal(l.layers.mask, 2, "legacy leaf stays on layer 1"); continue; }
      assert.equal(l.userData.hbParked, true);
      assert.equal(l.layers.mask, EB.ENTITY_PARK_MASK);
      assert.equal(l.userData.hbHomeMask, 2);
    }
    const mesh = r.root.children.find((c) => c.userData?.hbBatchMesh);
    assert.ok(mesh && mesh.isInstancedMesh && mesh.visible && mesh.layers.mask === 2);
  }
  const v = w.em._entityBatch.verify();
  assert.equal(v.entities, 4);
  assert.deepEqual([v.rowMismatches, v.stateMismatches, v.parkMismatches, v.attrMismatches], [0, 0, 0, 0], JSON.stringify(v.details));
  assert.equal(typeof globalThis.window.__entityBatch?.stats, "function", "diag global with the flag on");
});

await check("3a. wireframe / shadows: the batch is inert (nothing allocated, legacy draws)", async () => {
  for (const [s3, why] of [[{ wireframeMode: true }, "wireframe"], [{ shadowsEnabled: true }, "shadowCaster"], [{ csmEnabled: true }, "shadowCaster"]]) {
    const w = await R.world(true, { scene3d: s3 });
    const inst = await w.spawn(0x50000301);
    w.settle(8);
    const st = w.em._entityBatch.stats();
    assert.equal(st.inert, why);
    assert.equal(inst._hbBatch, undefined);
    assert.equal(st.entities, 0);
    assert.equal(KIT.kitSummary().pages, null, `${why}: no array pages`);
    assert.equal(w.drawsOf().length, 19);
  }
});

await check("3b. weaponFx and a VFX-plan leaf: legacy for life", async () => {
  const w = await R.world(true);
  const a = await w.spawn(0x50000311);
  const b = await w.spawn(0x50000312, 11, 10, 0);
  a._wfx = { test: true };
  const leaf = R.leavesOf(b)[3];
  const vfx = leaf.material.clone();
  vfx.userData = { ...leaf.material.userData, __vfxSetKey: "frag:test" };
  leaf.material = vfx;
  w.settle(8);
  a._wfx = null;
  w.frame(40);
  assert.equal(a._hbBatch.status, "legacy");
  assert.equal(a._hbBatch.reason, "weaponFx");
  assert.equal(b._hbBatch.status, "legacy");
  assert.equal(b._hbBatch.reason, "vfxPlan");
  assert.equal(w.drawsOf().length, 38);
});

await check("3c. a mapless (fallback) leaf waits; healed, the rig batches", async () => {
  const w = await R.world(true);
  const inst = await w.spawn(0x50000321);
  const leaf = R.leavesOf(inst)[2];
  const real = leaf.material;
  leaf.material = w.mc.fallbackMaterial;
  w.frame(30);
  assert.equal(inst._hbBatch.status, "pending");
  assert.equal(inst._hbBatch.reason, "mapless");
  assert.equal(w.em._entityBatch.stats().live.mapless, 1);
  leaf.material = real; // the refresh ladder's swap
  w.settle(80);
  assert.equal(inst._hbBatch.status, "active");
  assert.equal(w.drawsOf().length, 7);
});

await check("3d. a single-surface rig stays legacy (nothingToBatch)", async () => {
  const w = await R.world(true, { parts: [[D.A]] });
  const inst = await w.spawn(0x50000331);
  w.settle(8);
  assert.equal(inst._hbBatch.status, "legacy");
  assert.equal(inst._hbBatch.reason, "nothingToBatch");
  assert.equal(w.drawsOf().length, 1);
});

await check("4. an equip (real hot-swap, new recolor) tears down, then re-plans on the new leaves", async () => {
  const w = await R.world(true);
  const inst = await w.spawn(0x50000401, 10, 10, 0, PAL);
  w.settle();
  const b = inst._hbBatch;
  assert.equal(b.status, "active");
  const key0 = b.plan.key;
  const leaves0 = R.leavesOf(inst);
  const meta = { ...R.spawnMeta(0x50000401, 10, 10, 0, { paletteId: 0x04000b07, subPalettes: Uint32Array.of(0x0400cc03, 0, 8) }), modelChanges: Uint32Array.of(3, 0x01000abc) };
  const ok = await w.em._applyAppearanceHotSwap(inst, meta, 0x50000401);
  assert.equal(ok, true, "hot-swap applied");
  for (const l of leaves0) assert.notEqual(l.userData.hbParked, true, "old leaves were unparked before removal");
  assert.equal(inst.root.children.some((c) => c.userData?.hbBatchMesh), false, "batch mesh gone");
  assert.equal(b.status, "pending");
  assert.equal(w.drawsOf().length, 19, "legacy leaves on screen");
  w.settle();
  assert.equal(b.status, "active");
  assert.notEqual(b.plan.key, key0, "new entry key (modelChanges are in it)");
  for (const l of R.leavesOf(inst)) if (l.userData.surfaceDid !== D.NOTHING) assert.equal(l.userData.hbParked, true);
  assert.ok(w.em._entityBatch.stats().replanReasons["rebuilt:hotSwap"] >= 1);
  assert.equal(w.drawsOf().length, 7);
  const v = w.em._entityBatch.verify();
  assert.deepEqual([v.rowMismatches, v.stateMismatches, v.parkMismatches, v.attrMismatches], [0, 0, 0, 0]);
});

await check("4b. ReplaceObject: legacy for life (the H10 teardown, and the structure guard without it)", async () => {
  const w = await R.world(true);
  const a = await w.spawn(0x50000451);
  const c = await w.spawn(0x50000452, 11, 10, 0);
  w.settle();
  // H10, as _fireReplaceObjectHook calls it before its children swap.
  w.em._entityBatch.teardown(a, "replaceObject", { permanent: true });
  assert.equal(a._hbBatch.status, "legacy");
  assert.equal(a._hbBatch.reason, "replaceObject");
  for (const l of R.leavesOf(a)) assert.notEqual(l.userData.hbParked, true);
  assert.equal(a.root.children.some((x) => x.userData?.hbBatchMesh), false);
  // No hook: a replaced leaf shows up under part 3 (the hook's own naming).
  const part = c.parts[3];
  const old = part.children.find((x) => x.isMesh);
  part.remove(old);
  const m = new THREE.Mesh(old.geometry.clone(), old.material);
  m.name = `part_3_surface_${old.userData.surfaceDid.toString(16)}_replaced`;
  m.userData = { guid: 0x50000452, partIndex: 3, surfaceDid: old.userData.surfaceDid, replaced: true };
  part.add(m);
  w.frame(1);
  assert.equal(c._hbBatch.status, "legacy");
  assert.equal(c._hbBatch.reason, "structure:replaced");
  for (const l of R.leavesOf(c)) assert.notEqual(l.userData.hbParked, true);
  w.frame(40);
  assert.equal(a._hbBatch.status, "legacy");
  assert.equal(c._hbBatch.status, "legacy");
  assert.equal(w.drawsOf().length, 38, "both rigs draw their legacy leaves");
});

await check("5. release frees refs; shared entry + class materials outlive the first user", async () => {
  const w = await R.world(true);
  await w.spawn(0x50000501, 10, 10, 0, PAL);
  await w.spawn(0x50000502, 11, 10, 0, PAL2);
  w.settle();
  const eb = w.em._entityBatch;
  const s0 = eb.stats();
  assert.equal(s0.entries.live, 1, "two recolored rigs share one entry");
  const pagesLive0 = s0.kit.pages.live;
  assert.equal(s0.rows.partRows, 34);
  const classMats0 = s0.classMaterials;
  const mesh2 = w.em.entityMap.get(0x50000502).root.children.find((c) => c.userData?.hbBatchMesh);
  w.em.remove(0x50000501);
  const s1 = eb.stats();
  assert.equal(s1.entities, 1);
  assert.equal(s1.rows.partRows, 17, "17 part rows freed");
  assert.equal(s1.entries.live, 1, "entry still live (one user)");
  assert.equal(s1.classMaterials, classMats0, "class materials kept for the other user");
  assert.equal(s1.kit.pages.live, pagesLive0, "equal composites: the layers are still referenced by the second rig");
  assert.equal(w.drawsOf().length, 7, "the second rig still draws its batch");
  assert.ok(mesh2.parent, "second rig's batch mesh untouched");
  w.em.remove(0x50000502);
  const s2 = eb.stats();
  assert.equal(s2.entities, 0);
  assert.equal(s2.rows.partRows, 0);
  assert.equal(s2.stateRows, 0);
  assert.equal(s2.classMaterials, 0);
  assert.equal(s2.entries.live, 0);
  assert.equal(s2.entries.idle, 1, "the entry idles (CPU arrays only)");
  assert.equal(s2.kit.pages.live, 0, "no live layer");
  assert.equal(KIT.kitStateTable().rows.rowsUsed >= 1, true);
});

await check("6. context loss + restore: torn down at the event, no GL delete of the lost generation, rebuilt", async () => {
  const calls = [];
  let recording = false;
  const w = await R.world(true, { onCall: (n, a) => { if (recording) calls.push([n, Array.from(a)]); } });
  const inst = await w.spawn(0x50000601, 10, 10, 0, PAL);
  w.settle();
  assert.equal(inst._hbBatch.status, "active");
  // The fake GL numbers objects in creation order: every object of the
  // generation about to die has an id below this mark.
  const mark = w.gl.createBuffer().__id;
  recording = true;
  w.loseContext();
  assert.equal(inst._hbBatch.status, "pending", "torn down at the canvas event");
  for (const l of R.leavesOf(inst)) assert.notEqual(l.userData.hbParked, true, "legacy back");
  assert.equal(inst.root.children.some((c) => c.userData?.hbBatchMesh), false);
  w.frame(3);
  w.restoreContext();
  w.settle(60);
  recording = false;
  assert.equal(inst._hbBatch.status, "active", "re-planned and active on the restored context");
  assert.ok(w.em._entityBatch.stats().contextResets >= 1);
  assert.equal(w.drawsOf().length, 7);
  const bad = calls.filter(([n, a]) => /^delete/.test(n) && a[0] && typeof a[0].__id === "number" && a[0].__id < mark);
  assert.equal(bad.length, 0, `deleted objects of the lost generation: ${JSON.stringify(bad.map(([n, a]) => [n, a[0].__kind, a[0].__id]).slice(0, 8))}`);
  // The torn-down geometry of the lost generation was not leaked into the live one either.
  const v = w.em._entityBatch.verify();
  assert.deepEqual([v.rowMismatches, v.stateMismatches, v.parkMismatches, v.attrMismatches], [0, 0, 0, 0]);
});

await check("7. the smoke arms dry-run in node (statuses, draws, routes)", async () => {
  const LIB = R.LIB;
  const mods = {
    entities: { EntityManager: R.EntityManager }, entityBatch: EB, kit: KIT, materials: R.M, adapter: R.ADAPTER,
    selectionLighting: await import("../scene3d/selection_lighting.js"),
  };
  const want = {
    humans: ["active", "active", "active", "active"], clamp: ["active", "active"], mixed: ["active", "active"],
    front: ["active", "active"], flash: ["demoted", "active"],
  };
  const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
  const mkRenderer = () => { const gl = createFakeWebGL2(); return new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl }); };
  for (const [arm, st] of Object.entries(want)) {
    const off = await LIB.runEntityArm(THREE, mkRenderer(), mods, { arm, batch: false, frames: 12 });
    const offCalls = off.scene && (() => { const r = globalThis.window.liveScene3d.renderer; r.render(off.scene, off.camera); return r.info.render.calls; })();
    const on = await LIB.runEntityArm(THREE, mkRenderer(), mods, { arm, batch: true, frames: 12 });
    const r = globalThis.window.liveScene3d.renderer;
    r.render(on.scene, on.camera);
    assert.deepEqual(on.status, st, arm);
    assert.ok(r.info.render.calls < offCalls, `${arm}: ${r.info.render.calls} < ${offCalls}`);
    const v = on.verify;
    assert.deepEqual([v.rowMismatches, v.stateMismatches, v.parkMismatches, v.attrMismatches], [0, 0, 0, 0], arm);
    if (arm === "mixed") {
      assert.ok(on.stats.leafRoutes.translucent >= 2, "translucent leaves legacy");
      assert.ok((on.stats.leafRoutes["map:emissiveMap"] || 0) + (on.stats.leafRoutes.luminous || 0) >= 2, "luminous leaves legacy");
    }
    if (arm === "clamp") assert.ok(on.stats.programKeys.some((k) => k.startsWith("hb|d0|c0|p0|l1")), "the light-clamp class");
    if (arm === "front") {
      const keys = new Set(on.rigs.flatMap((x) => x._hbBatch.mesh.material.map((m) => m.customProgramCacheKey())));
      assert.ok([...keys].some((k) => /\.front\|/.test(k)), "a FrontSide class");
    }
    if (arm === "flash") assert.equal(on.rigs[0]._hbBatch.reason, "selectionFlash");
  }
  const ov = await LIB.runEntityArm(THREE, mkRenderer(), mods, { arm: "overlap", batch: true, readFrame: () => [] });
  assert.equal(ov.overlap.built, 4, "every rig built at the overlap frame");
  assert.ok(ov.overlap.overlapRigs >= 1, "at least one rig draws batch + legacy");
  assert.ok(ov.overlap.frames >= 1 && ov.overlap.frames < 300);
});

await check("7b. every field of the smoke's ARMS table is read by the smoke", () => {
  // Read as text (the smoke itself is a browser job: the orchestrator runs it).
  const src = fs.readFileSync(new URL("../harness/glsl_smoke/entity_batch_smoke.mjs", import.meta.url), "utf8");
  const i0 = src.indexOf("const ARMS = {");
  const i1 = src.indexOf("};", i0);
  assert.ok(i0 > 0 && i1 > i0, "the ARMS table");
  const fields = new Set([...src.slice(i0, i1).matchAll(/([A-Za-z]+):\s*(?:\[|true|false|\d)/g)].map((m) => m[1]));
  fields.delete("status");
  assert.ok(fields.size >= 2, [...fields].join(","));
  const rest = src.slice(i1);
  for (const f of fields) assert.ok(rest.includes(`want.${f}`), `ARMS field ${f} is never read`);
  assert.ok(rest.includes("want.status"));
});

await check("8. EntityManager.dispose() disposes the batch (H15)", async () => {
  const w = await R.world(true);
  const inst = await w.spawn(0x50000801);
  w.settle();
  const eb = w.em._entityBatch;
  assert.equal(inst._hbBatch.status, "active");
  assert.equal(typeof globalThis.window.__entityBatch, "object");
  assert.ok(eb._classMats.size > 0 && eb._partRows);
  w.em.dispose();
  assert.equal(typeof globalThis.window.__entityBatch, "undefined", "no diag global left behind");
  assert.equal(eb._records.size, 0);
  assert.equal(inst._hbBatch, undefined);
  assert.equal(eb._classMats.size, 0, "class materials freed");
  assert.equal(eb._partRows, null, "part-row texture freed");
  assert.equal(R.leavesOf(inst).filter((l) => l.userData.hbParked === true).length, 0, "no leaf left parked");
});

await check("9. the overlap keeps the leaves drawn until every class material has drawn once", async () => {
  const w = await R.world(true);
  const inst = await w.spawn(0x50000901);
  const b = inst._hbBatch;
  let n = 0;
  for (; n < 200 && b.status !== "overlap"; n += 1) w.frame(1, 1 / 60, false); // ticks, no render
  assert.equal(b.status, "overlap", "built without a render");
  w.frame(30, 1 / 60, false);
  assert.equal(b.status, "overlap", "nothing drew the class materials: still overlapping");
  assert.equal(R.leavesOf(inst).filter((l) => l.userData.hbParked === true).length, 0, "the legacy leaves still draw");
  assert.equal(b.mesh.visible, true);
  w.frame(1);                       // tick + the first render that draws the batch
  assert.equal(b.status, "overlap", "activation waits for the next sync");
  w.frame(1);
  assert.equal(b.status, "active");
  assert.ok(R.leavesOf(inst).filter((l) => l.userData.hbParked === true).length >= 17);
});

await check("10. the dt <= 0 exit syncs the batch (H4); the particle call stays the branch's last statement", async () => {
  const w = await R.world(true);
  const inst = await w.spawn(0x50000a01);
  const eb = w.em._entityBatch;
  const f0 = eb._frameNo;
  for (let i = 0; i < 6; i += 1) w.em.tick(0);
  assert.equal(eb._frameNo, f0 + 6, "one sync per dt-recovery tick");
  assert.notEqual(inst._hbBatch.status, "pending", "the plan advanced in dt-recovery ticks");
  assert.match(SRC_ENT, /if \(this\._entityBatch\) this\._entityBatch\.sync\(\);\s*if \(particleClockMode\(\) === "off"\) this\.tickParticlesAndScripts\(\);\s*return;/);
});

await check("11. the entry key is the spawn's own (post-LOD) appearance, not inst.meta's", async () => {
  const w = await R.world(true);
  const inst = await w.spawn(0x50000b01);
  const b = inst._hbBatch;
  assert.equal(b.status, "pending");
  // The spawn hands the batch the modelChanges it built the rig from (with a
  // LOD part swap PREPENDED locally; `inst.meta` never carries that): make
  // the two differ.
  inst.meta = { ...inst.meta, modelChanges: Uint32Array.of(0, 0x01000999) };
  w.settle();
  assert.equal(b.status, "active");
  const seg = b.plan.key.split("|")[1];
  assert.equal(seg, (b.modelChanges && b.modelChanges.length) ? Array.from(b.modelChanges, (x) => (x >>> 0).toString(16)).join(",") : "-");
  assert.ok(!b.plan.key.includes("1000999"), "not keyed on inst.meta");
});

await check("12. a batch mesh clones and serializes (its record link is not enumerable)", async () => {
  const w = await R.world(true);
  const inst = await w.spawn(0x50000c01);
  w.settle();
  const b = inst._hbBatch;
  const mesh = inst.root.children.find((c) => c.userData?.hbBatchMesh);
  assert.ok(mesh && mesh.userData.hbRecord === b, "the record is reachable");
  assert.equal(JSON.stringify(mesh.userData), '{"hbBatchMesh":true}');
  assert.doesNotThrow(() => inst.root.clone(true), "Object3D.copy stringifies userData");
  const c = mesh.clone();
  assert.equal(c.userData.hbRecord, undefined, "a clone is not the batch");
});

done();
