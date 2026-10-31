// tests/entity_batch_parity.test.mjs — R3-4 stage A `?entityBatch`: the
// batch world against today's world, FRAME BY FRAME, under the mutations that
// leave the batch (scene3d/gpu_batch/entity_batch.js + its hooks in
// scene3d/entities.js).
//
// Two worlds in one process (tests/entity_batch_rig.mjs: the REAL
// EntityManager, three r184 over the recording fake WebGL2): L = the flag off
// (today), B = `?entityBatch` on. The same spawns, the same frames and the
// same scripted mutations in both. Per rendered frame, for every leaf the
// user would SEE —
//   L: a leaf three drew whose material is not opacity-0 transparent;
//   B: such a leaf drawn as a legacy leaf, or a leaf of a DRAWN batch group
//      whose `hbEntPart` vertices and part row are non-zero and which is in
//      the frustum —
// the two sets must be equal. For every batch-drawn leaf: its kit state row
// must equal packLayerState(the L leaf's material) at the row's layer, its
// layer's texture must be the L leaf's map (or byte-equal), and its world
// placement (batch mesh matrixWorld x part row x vertex) must equal the L
// leaf's matrixWorld x vertex to f32. The part rows used are the bytes the GL
// RECEIVED (the last texSubImage2D / texImage2D of the part-row texture), not
// the CPU array. For every leaf drawn as a LEGACY leaf in both worlds (a
// demoted rig, a legacy-routed leaf): the material three drew in B must carry
// the L material's pass state (layer_state.js sameSurfaceState: opacity,
// transparent, depthWrite, alpha ref, diffuse, luminosity, blend, side, fog)
// and its map (or byte-equal).
//
//   1. a TransparentPart hide (1 -> 1) on an active rig, then an unrelated
//      map re-upload on another surface of the rig (the batch re-plans; today
//      shows nothing new): the hide must survive the re-plan.
//   2. the same hide (and a long show on rig 0), then a WebGL context loss
//      and restore in B; then a camera fade on rig 0 inside the show.
//   3. the same hide, then a real ReplaceObject (`_fireReplaceObjectHook`, a
//      new gfx that carries the hidden surface): B is legacy AT ONCE (H10,
//      before any tick: no frame of the old batch part next to the new
//      leaves) and the new leaf of the hidden surface is hidden as today.
//   4. an equip (the real `_applyAppearanceHotSwap`, a recolor) while a hide's
//      tween is still running: today that tween writes the new composite (it
//      stays hidden); a FINISHED hide does not survive an equip in either.
//   5. in-place member edits that keep the run key (a colour; an alphaTest
//      value): every frame's state rows follow (the per-tick
//      writeFromMaterial).
//   6. the part rows the GL received follow the pose frame after frame (the
//      late hook's flush), and equal the CPU rows.
//   7. a leaf with its own transform (TRS, and a manual matrix) stays a
//      legacy leaf, placed as today.
//   8. an animated surface (MaterialCache._animatedMaterials) stays a legacy
//      leaf: no re-plan per animation frame, its frames drawn as today.
//   9. a routed hide supersedes an older (constant, still running) show tween
//      of its surface, as today's body does: after a re-plan the old tween
//      must not un-hide it.
//  10. a routed SHOW (the AFK 0 -> 0, 0.833 s) and then, inside its tween, a
//      camera fade (rig 0) / an object translucency (rig 1): today the show's
//      tween writes opacity 1 over the fade every tick and its last tick
//      leaves it opaque; the demoted batch rig must draw the same, during and
//      after the tween.
//  11. a routed show survives a re-plan (the teardown writes it back with its
//      running tween; a fade inside it is overwritten as today; the new
//      members are per-entity clones, as today's show left them); a show that
//      has FINISHED leaves the fade alone in both worlds.
//  12. an equip (the real hot-swap) while a show's tween runs: today the
//      tween goes on writing the new materials, so a later fade inside it is
//      overwritten; the batch rig must draw the same.
//  13. a routed show then a routed hide of one surface (and a hide then a
//      show): the last one wins at an exit, as today's supersede rule says.
//
// Run from apps/holtburger-web/:  node tests/entity_batch_parity.test.mjs

import * as R from "./entity_batch_rig.mjs";
import assert from "node:assert/strict";

const { THREE, KIT, D } = R;
const LS = await import("../scene3d/gpu_batch/layer_state.js");
const LIB = R.LIB;
const { check, done } = R.suite("entity_batch_parity");

await check("0. the batch module exists", () => R.requireBatch());

const PAL = { paletteId: 0x04000a01, subPalettes: Uint32Array.of(0x0400aa01, 0, 8) };
const PAL2 = { paletteId: 0x04000a02, subPalettes: Uint32Array.of(0x0400bb02, 0, 8) };

/** One world of the pair: draws hooked, the part-row bytes the GL received captured. */
async function side(batch, rigs, opts) {
  const S = { batch, draws: [], gpuRows: null, gpuUploads: 0 };
  S.w = await R.world(batch, {
    ...(opts.world || {}),
    onCall: (name, args) => {
      if (!batch || !S.w || (name !== "texSubImage2D" && name !== "texImage2D")) return;
      const eb = S.w.em._entityBatch;
      const pr = eb && eb._partRows;
      if (!pr || !pr.data) return;
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === pr.data) { S.gpuRows = Float32Array.from(pr.data); S.gpuUploads += 1; return; }
      }
    },
  });
  S.live = globalThis.window.liveScene3d;
  S.rigs = [];
  for (const r of rigs) S.rigs.push(await S.w.spawn(r.guid, r.x, r.y, 0, r.o || {}));
  if (opts.afterSpawn) opts.afterSpawn(S);
  S.w.aim(S.rigs[opts.aimAt ?? 0], opts.aimDist ?? 4);
  const rbd = S.w.renderer.renderBufferDirect;
  S.w.renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    S.draws.push({ object, group, material });
    return rbd.apply(this, arguments);
  };
  return S;
}

/** L (flag off) first: building B resets the kit, which L never touches. */
async function pair(rigs, opts = {}) {
  const L = await side(false, rigs, opts);
  const B = await side(true, rigs, opts);
  const P = {
    L, B, problems: [], frames: 0, batchLeaves: 0, legacyLeaves: 0,
    use(S) { globalThis.window.liveScene3d = S.live; },
    both(fn) { for (const S of [L, B]) { P.use(S); fn(S); } },
    async bothAsync(fn) { for (const S of [L, B]) { P.use(S); await fn(S); } },
    /** n frames: tick both, render both, compare. */
    run(n, tag, o = {}) {
      for (let i = 0; i < n; i += 1) {
        P.both((S) => {
          if (o.preTick) o.preTick(S);
          S.w.tickOnly(1 / 60);
        });
        P.compare(`${tag}#${i}`);
      }
    },
    /** Render both (no tick) and compare. */
    compare(tag) {
      P.frames += 1;
      for (const S of [L, B]) { P.use(S); S.draws.length = 0; S.w.renderer.render(S.w.scene, S.w.camera); }
      P.use(B);
      compareFrame(P, tag);
    },
  };
  return P;
}

const leafId = (leaf) => {
  const ud = leaf.userData;
  const idx = leaf.parent ? leaf.parent.children.indexOf(leaf) : -1;
  return `${(ud.guid >>> 0).toString(16)}/${ud.partIndex}/${idx}/${leaf.name}`;
};

const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();
function inFrustum(S, leaf) {
  const cam = S.w.camera;
  _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_pm, cam.coordinateSystem, cam.reversedDepth);
  return _frustum.intersectsObject(leaf);
}

function visibleSet(S) {
  const out = new Map();
  const eb = S.w.em._entityBatch;
  for (const d of S.draws) {
    const o = d.object;
    if (o.userData && o.userData.hbBatchMesh) {
      const b = o.userData.hbRecord;
      if (!b || !b.plan) continue;
      const gi = o.geometry.groups.indexOf(d.group);
      const run = b.plan.runs[gi];
      const rows = S.gpuRows;
      for (let i = run.first; i < run.first + run.count; i += 1) {
        const leaf = b.leaves[i];
        const sl = b.slices[i];
        const pr = b.attrPart.array[sl.vertexStart];
        if (pr === 0) continue;
        if (!rows || rows.length < pr * 16 + 16) { out.set(leafId(leaf), { kind: "batch", leaf, noRows: true }); continue; }
        let zero = true;
        for (let k = 0; k < 16; k += 1) if (rows[pr * 16 + k] !== 0) { zero = false; break; }
        if (zero) continue;
        if (!inFrustum(S, leaf)) continue;
        const row = b.plan.memberRefs.get(b.plan.members[i]);
        out.set(leafId(leaf), { kind: "batch", leaf, slot: b.attrSlot.array[sl.vertexStart], row, pr, mesh: o, rows, eb });
      }
    } else if (o.isMesh && o.userData && o.userData.surfaceDid !== undefined) {
      const m = d.material;
      if (m.transparent && m.opacity === 0) continue;
      out.set(leafId(o), { kind: "legacy", leaf: o, material: m });
    }
  }
  return out;
}

const _st = LS.layerStateFromMaterial(null);
const _pack = new Float32Array(LS.LAYER_STATE_FLOATS);
const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _c = new THREE.Vector3();
const _rowM = new THREE.Matrix4();

function sameBytes(ta, tb) {
  const da = ta && ta.image && ta.image.data, db = tb && tb.image && tb.image.data;
  if (!da || !db || da.length !== db.length) return false;
  for (let q = 0; q < da.length; q += 1) if (da[q] !== db[q]) return false;
  return true;
}

const _stL = LS.layerStateFromMaterial(null), _stB = LS.layerStateFromMaterial(null);

function compareFrame(P, tag) {
  const el = visibleSet(P.L), ebs = visibleSet(P.B);
  const onlyL = [...el.keys()].filter((k) => !ebs.has(k));
  const onlyB = [...ebs.keys()].filter((k) => !el.has(k));
  if (onlyL.length || onlyB.length) P.problems.push(`${tag}: visible sets differ: onlyToday=${onlyL.slice(0, 3)} onlyBatch=${onlyB.slice(0, 3)}`);
  const table = KIT.kitStateTable().rows.data;
  for (const [k, e] of ebs) {
    const le = el.get(k);
    if (!le) continue;
    if (e.kind === "legacy") {
      if (le.kind !== "legacy") continue;
      P.legacyLeaves += 1;
      LS.fillStateFromMaterial(_stL, le.material);
      LS.fillStateFromMaterial(_stB, e.material);
      if (!LS.sameSurfaceState(_stL, _stB)) P.problems.push(`${tag}: legacy ${k}: ${LS.surfaceStateDiff(_stB, _stL).join(", ")} (batch world vs today)`);
      if (le.material.map !== e.material.map && !sameBytes(le.material.map, e.material.map)) P.problems.push(`${tag}: legacy map ${k}`);
      continue;
    }
    if (e.noRows) { P.problems.push(`${tag}: ${k}: no part rows reached the GL`); continue; }
    P.batchLeaves += 1;
    LS.packLayerState(LS.fillStateFromMaterial(_st, le.material), e.row.layer, _pack, 0, e.row.nrmLayer);
    for (let q = 0; q < LS.LAYER_STATE_FLOATS; q += 1) {
      if (table[e.slot * LS.LAYER_STATE_FLOATS + q] !== _pack[q]) { P.problems.push(`${tag}: state ${k}[${q}] batch=${table[e.slot * LS.LAYER_STATE_FLOATS + q]} today=${_pack[q]}`); break; }
    }
    if (le.material.map !== e.row.member.map && !sameBytes(le.material.map, e.row.member.map)) P.problems.push(`${tag}: map ${k}`);
    _rowM.fromArray(e.rows, e.pr * 16);
    const pa = le.leaf.geometry.attributes.position;
    let worst = 0;
    for (let q = 0; q < pa.count; q += 1) {
      _v.fromBufferAttribute(pa, q);
      _a.copy(_v).applyMatrix4(le.leaf.matrixWorld);
      _c.copy(_v).applyMatrix4(_rowM).applyMatrix4(e.mesh.matrixWorld);
      worst = Math.max(worst, _a.distanceTo(_c) / Math.max(1, _a.length()));
    }
    if (worst > 5e-7) P.problems.push(`${tag}: placement ${k} rel ${worst.toExponential(2)}`);
  }
}

const noProblems = (P) => assert.equal(P.problems.length, 0, `${P.problems.length} problems over ${P.frames} frames: ${P.problems.slice(0, 4).join(" || ")}`);
const leavesOfDid = (inst, did) => R.leavesOf(inst).filter((l) => l.userData.surfaceDid === did);
const HIDE = { rampStart: 1, rampEnd: 1, rampTime: 0.25 };
const RIGS = [{ guid: 0x53000001, x: 10, y: 10 }, { guid: 0x53000002, x: 10.7, y: 10, o: PAL }, { guid: 0x53000003, x: 11.4, y: 10, o: PAL2 }];
const clean = (eb) => {
  const v = eb.verify();
  assert.deepEqual([v.rowMismatches, v.stateMismatches, v.parkMismatches, v.attrMismatches], [0, 0, 0, 0], JSON.stringify(v.details));
};

async function hiddenPair(guidBase) {
  const rigs = RIGS.map((r, i) => ({ ...r, guid: guidBase + i }));
  const P = await pair(rigs, { aimAt: 1, aimDist: 5 });
  P.run(14, "settle");
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.status), ["active", "active", "active"]);
  // A hide on rig 1's part 3 (surface A, entity-wide): a batch state write in B.
  P.both((S) => S.w.em._spawnMaterialRampTween(S.rigs[1], 7, 3, HIDE));
  assert.ok(P.B.rigs[1]._hbBatch.hiddenDids && P.B.rigs[1]._hbBatch.hiddenDids.has(D.A), "B took the hide");
  assert.equal(P.B.rigs[1]._hbBatch.status, "active");
  P.run(4, "hide");
  return P;
}

await check("1. a hide survives a re-plan (an unrelated map re-upload)", async () => {
  const P = await hiddenPair(0x53000101);
  const eb = P.B.w.em._entityBatch;
  const r0 = eb.stats().replans;
  P.both((S) => { leavesOfDid(S.rigs[1], D.C)[0].material.map.needsUpdate = true; });
  P.run(16, "replan");
  assert.ok(eb.stats().replans > r0, "B re-planned");
  assert.equal(P.B.rigs[1]._hbBatch.status, "active", "re-batched");
  for (const l of leavesOfDid(P.B.rigs[1], D.A)) assert.notEqual(l.userData.hbParked, true, "the hidden surface is a legacy leaf now (today's hidden clone)");
  noProblems(P);
  assert.ok(P.batchLeaves > 100, `${P.batchLeaves} batch-drawn leaves compared`);
  clean(eb);
});

await check("2. a hide (and a show) survives a context loss and restore", async () => {
  const P = await hiddenPair(0x53000201);
  // And a long show on rig 0 (B takes it): its tween must outlive the reset.
  P.both((S) => S.w.em._spawnMaterialRampTween(S.rigs[0], 7, -1, { rampStart: 0, rampEnd: 0, rampTime: 60 }));
  const routed0 = P.B.rigs[0]._hbBatch.plan ? [...P.B.rigs[0]._hbBatch.plan.batchedDids].filter((d) => !P.B.rigs[0]._hbBatch.plan.legacyDids.has(d)) : [];
  assert.ok(routed0.length >= 8);
  assert.equal((P.B.rigs[0]._materialHookTweens || []).filter((t) => routed0.includes(t.surfaceDid >>> 0)).length, 0, "B took the show of its routed surfaces");
  P.use(P.B);
  P.B.w.loseContext();
  // (A lost context draws nothing in B: tick both, compare after the restore.)
  for (let i = 0; i < 3; i += 1) P.both((S) => S.w.tickOnly(1 / 60));
  P.use(P.B);
  P.B.w.restoreContext();
  P.run(40, "restored");
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.status), ["active", "active", "active"]);
  assert.ok(P.B.w.em._entityBatch.stats().contextResets >= 1);
  // A camera fade on rig 0 inside the show: today's tween overwrites it.
  P.both((S) => S.w.em._applyCamFadeToInst(S.rigs[0], 0.5));
  P.run(10, "faded");
  noProblems(P);
  clean(P.B.w.em._entityBatch);
});

/** The mock wasm's GfxObj for ReplaceObject: one part carrying surfaces A and C. */
function installReplaceGfx(S) {
  S.w.wasm.fetchBuildingPlacement = async () => {
    const meshes = LIB.partMeshesFor(THREE, [[D.A, D.C]]);
    return { partCount: 1, takePartMeshes() { return meshes.splice(0); }, free() {} };
  };
}

await check("3. a hide survives ReplaceObject; the rig is legacy at the hook (H10), before any tick", async () => {
  const P = await hiddenPair(0x53000301);
  P.both(installReplaceGfx);
  await P.bothAsync(async (S) => { await S.w.em._fireReplaceObjectHook(S.rigs[1], 4, 0x01000d01); });
  const b = P.B.rigs[1]._hbBatch;
  assert.equal(b.status, "legacy");
  assert.equal(b.reason, "replaceObject", "torn down by the hook itself, not by the next tick's structure guard");
  assert.equal(P.B.rigs[1].root.children.some((c) => c.userData?.hbBatchMesh), false, "batch mesh gone at the hook");
  const fresh = P.B.rigs[1].parts[4].children.filter((c) => c.userData?.replaced && c.userData.surfaceDid === D.A);
  assert.equal(fresh.length, 1, "the new gfx carries the hidden surface");
  P.compare("hook");   // a render with no tick in between
  P.run(20, "after");
  noProblems(P);
});

await check("4. an equip while a hide's tween runs keeps it hidden as today; a finished hide is gone in both", async () => {
  const rigs = [{ guid: 0x53000401, x: 10, y: 10, o: PAL }, { guid: 0x53000402, x: 10.7, y: 10, o: PAL }];
  const P = await pair(rigs, { aimAt: 0, aimDist: 5 });
  P.run(14, "settle");
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.status), ["active", "active"]);
  // Rig 0: a long hide (its tween still runs at the equip); rig 1: a hide that has finished.
  P.both((S) => {
    S.w.em._spawnMaterialRampTween(S.rigs[0], 7, 3, { rampStart: 1, rampEnd: 1, rampTime: 60 });
    S.w.em._spawnMaterialRampTween(S.rigs[1], 7, 3, { rampStart: 1, rampEnd: 1, rampTime: 0 });
  });
  P.run(4, "hides");
  await P.bothAsync(async (S) => {
    for (const r of S.rigs) {
      const m = { ...r.meta, paletteId: 0x04000b07, subPalettes: Uint32Array.of(0x0400cc03, 0, 8) };
      assert.equal(await S.w.em._applyAppearanceHotSwap(r, m, r.guid), true);
    }
  });
  P.run(30, "equipped");
  noProblems(P);
  const visA = (S, r) => leavesOfDid(S.rigs[r], D.A).filter((l) => !(l.material.transparent && l.material.opacity === 0)).length;
  assert.equal(visA(P.L, 0), 0, "today: the running tween hides the new composite");
  assert.ok(visA(P.L, 1) > 0, "today: a finished hide does not survive the equip");
});

await check("5. in-place member edits (a colour, an alphaTest value): the state rows follow every frame", async () => {
  const P = await pair([{ guid: 0x53000501, x: 10, y: 10 }, { guid: 0x53000502, x: 10.7, y: 10, o: PAL }], { aimAt: 0, aimDist: 5 });
  P.run(14, "settle");
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.status), ["active", "active"]);
  const eb = P.B.w.em._entityBatch;
  const d0 = eb.stats().demotes, r0 = eb.stats().replans;
  P.both((S) => {
    leavesOfDid(S.rigs[0], D.C)[0].material.color.setRGB(0.55, 0.7, 0.9);   // a shared cache member
    leavesOfDid(S.rigs[1], D.B)[0].material.color.setRGB(0.8, 0.6, 0.4);    // a per-entity composite
    const clip = leavesOfDid(S.rigs[0], D.CLIP)[0].material;
    assert.ok(clip.alphaTest > 0);
    clip.alphaTest = 0.31;                                                   // still a cut-out: same run key
  });
  P.run(6, "edited");
  assert.equal(eb.stats().demotes, d0, "no demote");
  assert.equal(eb.stats().replans, r0, "no re-plan");
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.status), ["active", "active"]);
  noProblems(P);
  clean(eb);
});

await check("6. the part rows the GL received follow the pose and equal the CPU rows", async () => {
  const P = await pair([{ guid: 0x53000601, x: 10, y: 10 }], { aimAt: 0 });
  P.run(14, "settle");
  assert.equal(P.B.rigs[0]._hbBatch.status, "active");
  const eb = P.B.w.em._entityBatch;
  let moved = 0;
  for (let f = 0; f < 10; f += 1) {
    const u0 = P.B.gpuUploads;
    const cpu0 = Float32Array.from(eb._partRows.data);
    P.run(1, `walk${f}`);
    const changed = Array.from(eb._partRows.data).some((x, i) => x !== cpu0[i]);
    if (changed) {
      moved += 1;
      assert.ok(P.B.gpuUploads > u0, `frame ${f}: the pose moved, so the part rows were uploaded again`);
    }
    assert.deepEqual(Array.from(P.B.gpuRows), Array.from(eb._partRows.data), `frame ${f}: GL rows = CPU rows`);
  }
  assert.ok(moved >= 3, `the pose moved on ${moved} of 10 frames`);
  noProblems(P);
});

await check("7. a leaf with its own transform stays a legacy leaf, placed as today", async () => {
  const set = (S) => {
    const r = S.rigs[0];
    const trs = leavesOfDid(r, D.E)[0];
    trs.position.set(0.02, -0.01, 0.03);
    trs.scale.set(1.1, 0.9, 1);
    const man = leavesOfDid(r, D.H1)[0];
    man.matrixAutoUpdate = false;
    man.matrix.makeTranslation(0, 0.04, -0.02);
  };
  const P = await pair([{ guid: 0x53000701, x: 10, y: 10 }], { aimAt: 0, afterSpawn: set });
  P.run(16, "settle");
  const b = P.B.rigs[0]._hbBatch;
  assert.equal(b.status, "active");
  assert.ok((P.B.w.em._entityBatch.stats().leafRoutes.leafTransform | 0) >= 2, JSON.stringify(P.B.w.em._entityBatch.stats().leafRoutes));
  assert.notEqual(leavesOfDid(P.B.rigs[0], D.E)[0].userData.hbParked, true);
  assert.notEqual(leavesOfDid(P.B.rigs[0], D.H1)[0].userData.hbParked, true);
  P.run(6, "walk");
  noProblems(P);
});

await check("8. an animated surface stays a legacy leaf (no re-plan per animation frame), drawn as today", async () => {
  const animate = (S) => {
    const mat = leavesOfDid(S.rigs[0], D.E)[0].material;
    assert.ok(mat && mat.map && !mat.userData.__disposable, "the shared cache material of E");
    const f0 = mat.map;
    const px = R.pixelsFor(D.E, 9);
    const f1 = new THREE.DataTexture(px, f0.image.width, f0.image.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    f1.needsUpdate = true;
    S.w.mc._animatedMaterials.set(D.E, { mat, frames: [f0, f1], idx: 0, accumS: 0, cyclesEmissive: false });
  };
  const P = await pair([{ guid: 0x53000801, x: 10, y: 10 }], { aimAt: 0, afterSpawn: animate });
  const tickAnim = { preTick: (S) => S.w.mc.tickAnimatedSurfaces(1 / 60) };
  P.run(16, "settle", tickAnim);
  const eb = P.B.w.em._entityBatch;
  const b = P.B.rigs[0]._hbBatch;
  assert.equal(b.status, "active");
  assert.ok((eb.stats().leafRoutes.animatedSurface | 0) >= 1, JSON.stringify(eb.stats().leafRoutes));
  for (const l of leavesOfDid(P.B.rigs[0], D.E)) assert.notEqual(l.userData.hbParked, true);
  const r0 = eb.stats().replans;
  P.run(60, "animating", tickAnim);
  assert.equal(eb.stats().replans, r0, "an animation frame is not a re-plan");
  assert.equal(b.status, "active");
  noProblems(P);
});

await check("9. a routed hide supersedes an older show tween of its surface (it cannot un-hide it later)", async () => {
  // Before the plan, today's body takes an AFK show (constant, 60 s) on every part in both worlds.
  const afk = (S) => { for (let p = 0; p < 17; p += 1) S.w.em._spawnMaterialRampTween(S.rigs[0], 7, p, { rampStart: 0, rampEnd: 0, rampTime: 60 }); };
  const P = await pair([{ guid: 0x53000901, x: 10, y: 10 }], { aimAt: 0, afterSpawn: afk });
  P.run(16, "settle");
  const b = P.B.rigs[0]._hbBatch;
  assert.equal(b.status, "active", "planned with the constant tweens running");
  // A snap hide on part 3 (surface A): B takes it; today's body drops the show tween of A.
  P.both((S) => S.w.em._spawnMaterialRampTween(S.rigs[0], 7, 3, { rampStart: 1, rampEnd: 1, rampTime: 0 }));
  assert.ok(b.hiddenDids && b.hiddenDids.has(D.A));
  const opa = (S) => (S.rigs[0]._materialHookTweens || []).filter((t) => t.surfaceDid === D.A && (t.hookType === 7 || t.hookType === 20)).length;
  assert.equal(opa(P.B), 0, "B dropped the older show tween of A");
  P.run(3, "hidden");
  assert.equal(opa(P.L), 0, "today: the snap's own tween has run and the show tween is gone");
  // A re-plan (an unrelated map re-upload) writes the hide back; nothing may un-hide it.
  P.both((S) => { leavesOfDid(S.rigs[0], D.C)[0].material.map.needsUpdate = true; });
  P.run(20, "replan");
  noProblems(P);
});

// The material tweens run on the wall clock (`performance.now()` at the stamp
// and in the tick): a skew moves both worlds past a tween's end without
// waiting for it.
const _realNow = performance.now.bind(performance);
let _skewMs = 0;
performance.now = () => _realNow() + _skewMs;

/** The surfaces of a rig that an active batch routes a ramp for (routeRamp's split). */
const routedDids = (inst) => {
  const plan = inst._hbBatch.plan;
  return [...plan.batchedDids].filter((d) => !plan.legacyDids.has(d));
};
/** [opaque, faded] leaf counts of `dids` on a rig (the material three would draw). */
const opaqueFaded = (inst, dids) => {
  let opaque = 0, faded = 0;
  for (const l of R.leavesOf(inst)) {
    if (!dids.includes(l.userData.surfaceDid)) continue;
    const m = l.material;
    if (m.opacity === 1 && m.transparent === false) opaque += 1;
    else if (m.transparent === true && Math.abs(m.opacity - 0.5) < 1e-6) faded += 1;
  }
  return [opaque, faded];
};
/** Per leaf of `dids`: is its material a per-entity clone (today's ramp path)? */
const perEntity = (inst, dids) => R.leavesOf(inst).filter((l) => dids.includes(l.userData.surfaceDid)).map((l) => l.material.userData.__disposable === true);
const SHOW_AFK = { rampStart: 0, rampEnd: 0, rampTime: 0.833 };
const SHOW_LONG = { rampStart: 0, rampEnd: 0, rampTime: 60 };
const SHOW_SNAP = { rampStart: 0, rampEnd: 0, rampTime: 0 };

/** Both rigs active, the show taken by B with no clone and no tween of a routed surface. */
function showTaken(P, beforeMats, dids) {
  P.B.rigs.forEach((r, i) => {
    assert.equal(r._hbBatch.status, "active", `rig ${i} still active after the show`);
    const now = r._entityMaterials || new Map();
    for (const d of dids[i]) assert.equal(now.get(d), beforeMats[i].get(d), `rig ${i}: no clone of 0x${d.toString(16)} at the show`);
    const tw = (r._materialHookTweens || []).filter((t) => dids[i].includes(t.surfaceDid >>> 0));
    assert.equal(tw.length, 0, `rig ${i}: no tween of a routed surface`);
  });
}

await check("10. a routed show, then a camera fade / object translucency inside its tween: drawn as today (the tween overwrites the fade, during and after it)", async () => {
  const P = await pair([{ guid: 0x53000a01, x: 10, y: 10, o: PAL }, { guid: 0x53000a02, x: 10.7, y: 10 }], { aimAt: 0, aimDist: 5 });
  P.run(14, "settle");
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.status), ["active", "active"]);
  const dids = P.B.rigs.map(routedDids);
  assert.ok(dids.every((l) => l.length >= 8), JSON.stringify(dids.map((l) => l.length)));
  const before = P.B.rigs.map((r) => new Map(r._entityMaterials || []));
  // The AFK show (whole object) on both rigs: B takes it as a state write.
  P.both((S) => { for (const r of S.rigs) S.w.em._spawnMaterialRampTween(r, 7, -1, SHOW_AFK); });
  showTaken(P, before, dids);
  P.run(2, "shown");
  // Inside the show's 0.833 s: a camera fade on rig 0, an object translucency on rig 1.
  P.both((S) => {
    S.w.em._applyCamFadeToInst(S.rigs[0], 0.5);
    S.w.em._applyObjectTranslucencyToEntity(S.rigs[1], 0.5);
  });
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.status), ["demoted", "demoted"]);
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.reason), ["fade:camera", "fade:objectTranslucency"]);
  P.run(20, "insideShow");
  _skewMs += 1000; // past the show's end: its last tick ran in both worlds
  P.run(20, "afterShow");
  // Today (the scenario is not vacuous): the show's tween overwrote both fades.
  P.L.rigs.forEach((r, i) => {
    const [opaque, faded] = opaqueFaded(r, dids[i]);
    assert.ok(opaque >= 8 && faded === 0, `today rig ${i}: ${opaque} opaque, ${faded} faded`);
  });
  noProblems(P);
  assert.ok(P.legacyLeaves > 500, `${P.legacyLeaves} legacy-drawn leaves compared`);
  clean(P.B.w.em._entityBatch);
});

await check("11. a routed show survives a re-plan (its running tween overwrites a later fade, as today); a finished show leaves the fade alone", async () => {
  const P = await pair([{ guid: 0x53000b01, x: 10, y: 10 }, { guid: 0x53000b02, x: 10.7, y: 10, o: PAL }], { aimAt: 0, aimDist: 5 });
  P.run(14, "settle");
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.status), ["active", "active"]);
  const dids = P.B.rigs.map(routedDids);
  const before = P.B.rigs.map((r) => new Map(r._entityMaterials || []));
  // Rig 0: a long show (still running at the fade); rig 1: a snap show (over at the next tick).
  P.both((S) => {
    S.w.em._spawnMaterialRampTween(S.rigs[0], 7, -1, SHOW_LONG);
    S.w.em._spawnMaterialRampTween(S.rigs[1], 7, -1, SHOW_SNAP);
  });
  showTaken(P, before, dids);
  P.run(3, "shown");
  // A re-plan of both rigs (an unrelated map re-upload): B's teardown writes the shows back.
  const eb = P.B.w.em._entityBatch;
  const r0 = eb.stats().replans;
  P.both((S) => { for (const r of S.rigs) leavesOfDid(r, D.C)[0].material.map.needsUpdate = true; });
  P.run(16, "replan");
  assert.ok(eb.stats().replans >= r0 + 2, `B re-planned both rigs (${eb.stats().replans - r0})`);
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.status), ["active", "active"], "re-batched");
  // Today the show cloned every surface (running or finished): the teardown
  // wrote those per-entity clones back, so the new members are clones too.
  for (let i = 0; i < 2; i += 1) assert.deepEqual(perEntity(P.B.rigs[i], dids[i]), perEntity(P.L.rigs[i], dids[i]), `rig ${i}: per-entity materials as today`);
  assert.ok(perEntity(P.L.rigs[1], dids[1]).every(Boolean), "today: the finished show left clones");
  P.both((S) => { for (const r of S.rigs) S.w.em._applyCamFadeToInst(r, 0.5); });
  P.run(20, "faded");
  const [o0, f0] = opaqueFaded(P.L.rigs[0], dids[0]);
  assert.ok(o0 >= 8 && f0 === 0, `today rig 0 (running show): ${o0} opaque, ${f0} faded`);
  const [o1, f1] = opaqueFaded(P.L.rigs[1], dids[1]);
  assert.ok(f1 >= 8 && o1 === 0, `today rig 1 (finished show): ${o1} opaque, ${f1} faded`);
  noProblems(P);
  clean(eb);
});

await check("12. an equip while a show's tween runs: the tween goes on writing the new materials over a later fade, as today", async () => {
  const P = await pair([{ guid: 0x53000c01, x: 10, y: 10, o: PAL }, { guid: 0x53000c02, x: 10.7, y: 10, o: PAL }], { aimAt: 0, aimDist: 5 });
  P.run(14, "settle");
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.status), ["active", "active"]);
  const dids = P.B.rigs.map(routedDids);
  const before = P.B.rigs.map((r) => new Map(r._entityMaterials || []));
  P.both((S) => {
    S.w.em._spawnMaterialRampTween(S.rigs[0], 7, -1, SHOW_LONG);
    S.w.em._spawnMaterialRampTween(S.rigs[1], 7, -1, SHOW_SNAP);
  });
  showTaken(P, before, dids);
  P.run(3, "shown");
  await P.bothAsync(async (S) => {
    for (const r of S.rigs) {
      const m = { ...r.meta, paletteId: 0x04000b07, subPalettes: Uint32Array.of(0x0400cc03, 0, 8) };
      assert.equal(await S.w.em._applyAppearanceHotSwap(r, m, r.guid), true);
    }
  });
  P.run(20, "equipped");
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.status), ["active", "active"], "re-batched after the equip");
  P.both((S) => { for (const r of S.rigs) S.w.em._applyCamFadeToInst(r, 0.5); });
  P.run(20, "faded");
  const after = P.L.rigs.map((r) => opaqueFaded(r, dids[0].concat(dids[1])));
  assert.ok(after[0][0] >= 4, `today rig 0: the running show tween overwrites the fade on the new materials (${after[0]})`);
  assert.equal(after[1][0], 0, `today rig 1: the finished show is gone with the equip (${after[1]})`);
  noProblems(P);
  clean(P.B.w.em._entityBatch);
});

await check("13. the last of a routed show and a routed hide of one surface wins at an exit (today's supersede)", async () => {
  const P = await pair([{ guid: 0x53000d01, x: 10, y: 10 }, { guid: 0x53000d02, x: 10.7, y: 10, o: PAL }], { aimAt: 0, aimDist: 5 });
  P.run(14, "settle");
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.status), ["active", "active"]);
  const dids = P.B.rigs.map(routedDids);
  const before = P.B.rigs.map((r) => new Map(r._entityMaterials || []));
  // Rig 0: a long show, then a snap hide of part 3 (surface A, entity-wide).
  // Rig 1: a long hide of part 3, then a long show of it.
  P.both((S) => {
    S.w.em._spawnMaterialRampTween(S.rigs[0], 7, -1, SHOW_LONG);
    S.w.em._spawnMaterialRampTween(S.rigs[0], 7, 3, { rampStart: 1, rampEnd: 1, rampTime: 0 });
    S.w.em._spawnMaterialRampTween(S.rigs[1], 7, 3, { rampStart: 1, rampEnd: 1, rampTime: 60 });
    S.w.em._spawnMaterialRampTween(S.rigs[1], 7, 3, SHOW_LONG);
  });
  showTaken(P, before, dids);
  P.run(3, "routed");
  // A re-plan of both, then a camera fade inside the running tweens.
  P.both((S) => { for (const r of S.rigs) leavesOfDid(r, D.C)[0].material.map.needsUpdate = true; });
  P.run(16, "replan");
  assert.deepEqual(P.B.rigs.map((r) => r._hbBatch.status), ["active", "active"], "re-batched");
  P.both((S) => { for (const r of S.rigs) S.w.em._applyCamFadeToInst(r, 0.5); });
  P.run(20, "faded");
  const shown = (S, r) => leavesOfDid(S.rigs[r], D.A).filter((l) => !(l.material.transparent && l.material.opacity === 0)).length;
  assert.equal(shown(P.L, 0), 0, "today rig 0: the hide came last, A stays hidden");
  assert.ok(shown(P.L, 1) > 0, "today rig 1: the show came last, A is drawn");
  noProblems(P);
  clean(P.B.w.em._entityBatch);
});

done();
