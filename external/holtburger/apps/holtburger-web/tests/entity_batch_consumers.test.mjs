// tests/entity_batch_consumers.test.mjs — R3-4 stage A `?entityBatch`
// ("Design A0": batched leaves stay in the graph, parked on layer 31): every
// consumer that reads the rig sees today's rig. Two worlds of
// tests/entity_batch_rig.mjs — flag OFF (legacy) and flag ON (batched) — with
// the same spawns and the same frames (identical poses), compared:
//
//   a. Raycaster.intersectObjects(roots, true) (picking.js's polygon pass,
//      layers 0 + 1) returns the SAME leaves at the SAME distances (the
//      batch mesh's facade raycasts the parked leaves as themselves; no hit
//      ever names the batch mesh), including a `visible = false` leaf (hit,
//      as today; picking's walk-up filters it) and a material-hidden one;
//   b. picking.js's sphere fallback (`pickBySphere`, spliced from the source):
//      with the F1 / P1 patch applied, the candidate spheres are equal; until
//      it is applied the check proves the gap instead (no batched rig is a
//      candidate) and says so;
//   c. Box3.setFromObject(root) — the occlusion proxy box `_occEntityBox`
//      and selection brackets — is equal (the batch mesh's object-level box
//      is empty);
//   d. ragdoll `drawnPartMask`, limbs `partMinZFromInstance` and the
//      play_effect body metrics (Box3 over the part Groups) are equal;
//   e. `inst.demoteBatch("dismember")` (dismember.js's P6 hook): legacy for
//      life, every leaf back on its home layer, the batch mesh gone, and
//      dismember's `_partMeshes(part)[0].material` is the first leaf's;
//   f. the layer stamps (`_stampEntityIndoorLayer` H11 and the attach stamp
//      H12, spliced from entities.js) keep parked leaves parked and move
//      their home mask; a stamp that does not know the convention is undone
//      by the next tick (counted `reparked`).
//
// Run from apps/holtburger-web/:  node tests/entity_batch_consumers.test.mjs

import * as R from "./entity_batch_rig.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { THREE, EB, D } = R;
const { drawnPartMask } = await import("../scene3d/ragdoll.js");
const { partMinZFromInstance } = await import("../scene3d/limbs.js");
const { pickNearestSphereHit } = await import("../scene3d/pick_math.js");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { check, done } = R.suite("entity_batch_consumers");

await check("0. the batch module exists", () => R.requireBatch());

const GUIDS = [0x50000c01, 0x50000c02];
async function pair() {
  const mk = async (batch) => {
    const w = await R.world(batch);
    const a = await w.spawn(GUIDS[0], 10, 10, 0);
    const b = await w.spawn(GUIDS[1], 10.8, 10, 0, { paletteId: 0x04000a01 });
    // Rest frames for limbs (the mock's rest pose is empty).
    for (const r of [a, b]) {
      r._restOrigins = new Float32Array(r.parts.length * 3).map((_, i) => 0.05 * i);
      r._restOrientations = new Float32Array(r.parts.length * 4).map((_, i) => (i % 4 === 0 ? 1 : 0));
    }
    // A degraded leaf and a material-hidden one, before anything plans.
    R.leavesOf(a)[5].visible = false;
    const lh = R.leavesOf(b)[7];
    lh.material = lh.material.clone();
    lh.material.visible = false;
    w.frame(12); // the same frames in both worlds: identical poses (the batch settles in ~3)
    w.scene.updateMatrixWorld();
    return { w, a, b };
  };
  const L = await mk(false);
  const B = await mk(true);
  assert.equal(B.a._hbBatch.status, "active");
  assert.equal(B.b._hbBatch.status, "active");
  return { L, B };
}
const id = (o) => `${o.parent?.name}/${o.name}`;

await check("a. the polygon raycast returns the same leaves at the same distances", async () => {
  const { L, B } = await pair();
  const rays = [];
  for (const inst of [L.a, L.b]) {
    for (const leaf of R.leavesOf(inst)) {
      leaf.geometry.computeBoundingSphere();
      const c = leaf.geometry.boundingSphere.center.clone().applyMatrix4(leaf.matrixWorld);
      for (const off of [[0, 0, 3], [0.4, 1.5, 2.5], [-2, 0.3, 1]]) rays.push([c.clone().add(new THREE.Vector3(...off)), c]);
    }
  }
  let nonEmpty = 0, hidden = 0;
  for (const [from, to] of rays) {
    const cast = (S) => {
      const rc = new THREE.Raycaster();
      rc.layers.enable(1);
      rc.set(from, to.clone().sub(from).normalize());
      return rc.intersectObjects([S.a.root, S.b.root], true);
    };
    const hl = cast(L), hb = cast(B);
    assert.deepEqual(hb.map((h) => id(h.object)), hl.map((h) => id(h.object)));
    hb.forEach((h, i) => assert.equal(h.distance, hl[i].distance));
    assert.ok(hb.every((h) => !h.object.userData?.hbBatchMesh));
    if (hb.length) nonEmpty += 1;
    if (hb.some((h) => h.object.visible === false || h.object.material.visible === false)) hidden += 1;
  }
  assert.ok(nonEmpty > 60, `rays with hits: ${nonEmpty}`);
  assert.ok(hidden >= 2, "the hidden leaves are hit as today");
});

await check("b. the sphere fallback (picking.js pickBySphere): candidates equal with P1, the gap documented without it", async () => {
  const src = readFileSync(join(ROOT, "scene3d/picking.js"), "utf8");
  const start = src.indexOf("  function pickBySphere(");
  const end = src.indexOf("\n  }\n", start);
  assert.ok(start > 0 && end > start);
  const body = src.slice(start, end + 4);
  const patched = /hbHomeMask/.test(body);
  const { L, B } = await pair();
  const spheresOf = (S) => {
    const rc = new THREE.Raycaster();
    rc.layers.enable(1);
    const c = new THREE.Vector3(); S.a.root.getWorldPosition(c);
    rc.set(c.clone().add(new THREE.Vector3(0.3, 0.8, 4)), new THREE.Vector3(0, -0.15, -1).normalize());
    const recs = [];
    // eslint-disable-next-line no-new-func
    const pick = new Function("raycaster", "drawnChain", "_pickSphere", "_pickSpheres", "pickNearestSphereHit",
      `${body}\nreturn pickBySphere;`)(rc, (o) => { for (let x = o; x; x = x.parent) if (x.visible === false) return false; return true; },
      new THREE.Sphere(), recs, (o, d, s, n) => { recs.length = n; return pickNearestSphereHit(o, d, s, n); });
    const guidByRoot = new Map([[S.a.root, GUIDS[0]], [S.b.root, GUIDS[1]]]);
    const hit = pick(S.w.em, guidByRoot, 0, null);
    return { hit, recs: recs.map((r) => [r.guid, r.cx, r.cy, r.cz, r.r]) };
  };
  const sl = spheresOf(L), sb = spheresOf(B);
  assert.ok(sl.recs.length >= 30, `legacy candidates ${sl.recs.length}`);
  if (patched) {
    assert.deepEqual(sb.recs, sl.recs, "P1: the same candidate spheres");
    assert.deepEqual(sb.hit, sl.hit);
  } else {
    // Without P1 a parked leaf fails `raycaster.layers.test(m.layers)`: only
    // the legacy leaves of batched rigs remain candidates. This is the gap
    // P1 closes (r3-4 design §17 F1; forOrchestrator); flip to the equality
    // above by applying it.
    assert.ok(sb.recs.length < sl.recs.length, "documented gap: batched leaves are not sphere candidates without P1");
    console.log(`    note: picking.js P1 not applied — sphere candidates legacy ${sl.recs.length} vs batched ${sb.recs.length}`);
  }
});

await check("c. Box3.setFromObject(root) (occlusion proxy box, selection brackets) is equal", async () => {
  const { L, B } = await pair();
  for (const k of ["a", "b"]) {
    const bl = new THREE.Box3().setFromObject(L[k].root), bb = new THREE.Box3().setFromObject(B[k].root);
    assert.deepEqual(bb.min.toArray(), bl.min.toArray());
    assert.deepEqual(bb.max.toArray(), bl.max.toArray());
    assert.ok(!bb.isEmpty());
    assert.ok(B[k].root.children.some((c) => c.userData?.hbBatchMesh), "the batch mesh was in the walk");
  }
});

await check("d. ragdoll drawnPartMask, limbs partMinZFromInstance, play_effect body metrics are equal", async () => {
  const { L, B } = await pair();
  for (const k of ["a", "b"]) {
    assert.deepEqual(drawnPartMask(B[k].parts), drawnPartMask(L[k].parts));
    const zl = partMinZFromInstance(L[k]), zb = partMinZFromInstance(B[k]);
    assert.ok(Array.isArray(zl) && zl.filter((x) => x !== undefined).length >= 16);
    assert.deepEqual(zb, zl);
    const body = (inst) => { const b = new THREE.Box3(); for (const p of inst.parts) b.expandByObject(p); return [b.min.toArray(), b.max.toArray()]; };
    assert.deepEqual(body(B[k]), body(L[k]));
  }
});

await check("e. demoteBatch('dismember'): legacy for life, leaves home, dismember sees the first leaf", async () => {
  const { B } = await pair();
  const inst = B.a;
  const first = R.leavesOf(inst).filter((l) => l.userData.partIndex === 4)[0];
  assert.equal(typeof inst.demoteBatch, "function");
  inst.demoteBatch("dismember");
  assert.equal(inst._hbBatch.status, "legacy");
  assert.equal(inst._hbBatch.reason, "dismember");
  assert.equal(inst.demoteBatch, undefined, "the hook is gone with the batch");
  for (const l of R.leavesOf(inst)) { assert.notEqual(l.userData.hbParked, true); assert.equal(l.layers.mask, 2); }
  assert.equal(inst.root.children.some((c) => c.userData?.hbBatchMesh), false);
  const partMeshes = inst.parts[4].children.filter((c) => c.isMesh && c.geometry); // dismember.js _partMeshes
  assert.equal(partMeshes[0], first);
  assert.equal(partMeshes[0].material, first.material);
  B.w.frame(40);
  assert.equal(inst._hbBatch.status, "legacy", "stays legacy");
});

function spliceStamp() {
  const src = readFileSync(join(ROOT, "scene3d/entities.js"), "utf8");
  const s = src.indexOf("function _stampEntityIndoorLayer(scene3d, obj) {");
  const e = src.indexOf("\n}\n", s);
  // eslint-disable-next-line no-new-func
  const stamp = new Function(`${src.slice(s, e + 2)}\nreturn _stampEntityIndoorLayer;`)();
  const a = src.indexOf("      c.root.traverse((o) => {\n        if (o.__filmCleanMask !== undefined) o.__filmCleanMask = 1 << 1;");
  const b = src.indexOf("      });", a);
  // eslint-disable-next-line no-new-func
  const attach = new Function("c", `${src.slice(a, b + 9)}`);
  return { stamp, attach };
}

await check("f. the layer stamps keep parked leaves parked; an unaware stamp is undone next tick", async () => {
  const { B } = await pair();
  const { stamp, attach } = spliceStamp();
  const inst = B.a;
  const parked = R.leavesOf(inst).filter((l) => l.userData.hbParked === true);
  assert.ok(parked.length >= 18);
  for (const l of parked) l.userData.hbHomeMask = 1; // pretend they came home on layer 0
  stamp({ entitiesGroup: B.w.entitiesGroup }, inst.root);
  for (const l of parked) { assert.equal(l.layers.mask, EB.ENTITY_PARK_MASK); assert.equal(l.userData.hbHomeMask, 2); }
  const mesh = inst.root.children.find((c) => c.userData?.hbBatchMesh);
  assert.equal(mesh.layers.mask, 2, "the batch mesh is stamped like any node");
  attach({ root: B.b.root });
  for (const l of R.leavesOf(B.b)) if (l.userData.hbParked) assert.equal(l.layers.mask, EB.ENTITY_PARK_MASK);
  // A walk that does not know the convention un-parks: the tick re-parks.
  const r0 = B.w.em._entityBatch.stats().reparked;
  inst.root.traverse((o) => o.layers.set(1));
  B.w.frame(1);
  for (const l of parked) assert.equal(l.layers.mask, EB.ENTITY_PARK_MASK);
  assert.equal(B.w.em._entityBatch.stats().reparked, r0 + parked.length);
  assert.equal(B.w.drawsOf().length, 14);
});

done();
