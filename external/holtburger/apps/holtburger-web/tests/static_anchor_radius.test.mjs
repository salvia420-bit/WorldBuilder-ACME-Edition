// tests/static_anchor_radius.test.mjs — ?staticAnchorFreeze + ?staticScriptRadius (2026-10-17).
// Live on the 1070 at Linvak Tukal the object ring held 14,268 static default_script
// anchors (the drizzle scenery 0x02000407/0x02000406), all walked and matrix-updated
// every frame, and every one carried a ticking emitter although RP6 draws nothing
// past 220 m.
//   F1  the setting parses: absent/garbage/out of range → 2, N in 1..12, off/0/false/no → null
//   F2  freeze: the anchor's world matrix includes its parents (worldRoot's axis
//       rotation) without a prior render walk; the subtree stops auto-updating; hidden
//   F3  the statics cull walk leaves a frozen anchor hidden
//   F4  the tick tears down only a far landblock's default_script emitters (a
//       synthesized emitter of the same landblock survives), keeps the hysteresis
//       band, bumps the anchor epoch, and does nothing until the player set changes
//   F5  approaching a deferred landblock rebuilds it through the builder host
//   F6  the tick works from the liveScene3d facade (state + manager on the host)
//   F7  RP6's cull sphere reads a frozen anchor's matrixWorld, never getWorldPosition
//
// Run from apps/holtburger-web/:  node tests/static_anchor_radius.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};

const S = await import("../scene3d/statics.js");
const {
  staticScriptRadiusSetting, __setStaticScriptRadiusForTest, tickStaticScriptRadius,
  __setStaticScriptRebuildForTest, __freezeStaticScriptAnchorForTest, __cullStaticsWalkForTest,
} = S;

const lb = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;

test("F1: the radius setting parses", () => {
  const saved = globalThis.location;
  const cases = [["", 2], ["?staticScriptRadius=3", 3], ["?staticScriptRadius=1", 1], ["?staticScriptRadius=12", 12],
    ["?staticScriptRadius=13", 2], ["?staticScriptRadius=banana", 2], ["?staticScriptRadius=off", null],
    ["?staticScriptRadius=0", null], ["?staticScriptRadius=FALSE", null], ["?staticScriptRadius=no", null]];
  try {
    for (const [search, want] of cases) {
      globalThis.location = { search };
      __setStaticScriptRadiusForTest(undefined);
      assert.equal(staticScriptRadiusSetting(), want, search);
    }
  } finally {
    globalThis.location = saved;
    __setStaticScriptRadiusForTest(2);
  }
});

test("F2: freeze computes the world matrix through its parents, stops auto-update, hides", () => {
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2; // AC Z-up → three Y-up, never walked yet
  const statics = new THREE.Group();
  worldRoot.add(statics);
  const anchor = new THREE.Group();
  anchor.position.set(100, 50, 7);
  anchor.userData = { isStaticScriptAnchor: true };
  const part = new THREE.Object3D();
  part.position.set(0, 0, 2);
  anchor.add(part);
  statics.add(anchor);
  __freezeStaticScriptAnchorForTest(anchor);
  const p = new THREE.Vector3().setFromMatrixPosition(anchor.matrixWorld);
  assert.ok(Math.abs(p.x - 100) < 1e-6 && Math.abs(p.y - 7) < 1e-6 && Math.abs(p.z + 50) < 1e-6, `anchor world ${p.toArray()}`);
  const q = new THREE.Vector3().setFromMatrixPosition(part.matrixWorld);
  assert.ok(Math.abs(q.y - 9) < 1e-6, `part frame world ${q.toArray()}`);
  for (const o of [anchor, part]) {
    assert.equal(o.matrixAutoUpdate, false);
    assert.equal(o.matrixWorldAutoUpdate, false);
  }
  assert.equal(anchor.visible, false);
  assert.equal(anchor.userData.__anchorFrozen, true);
  // A later forced walk recomputes nothing different.
  const before = anchor.matrixWorld.clone();
  worldRoot.updateMatrixWorld(true);
  assert.ok(anchor.matrixWorld.equals(before));
});

test("F3: the statics cull walk leaves a frozen anchor hidden", () => {
  const group = new THREE.Group();
  const anchor = new THREE.Group();
  anchor.userData = { isStaticScriptAnchor: true };
  group.add(anchor);
  __freezeStaticScriptAnchorForTest(anchor);
  const plain = new THREE.Group(); // no cull sphere → the walk restores it
  plain.visible = false;
  group.add(plain);
  const culler = { isSphereInFrustum: () => true, getDistanceSq: () => 0 };
  __cullStaticsWalkForTest(group, group.children, culler);
  assert.equal(anchor.visible, false, "frozen anchor stays hidden");
  assert.equal(plain.visible, true, "control: an ordinary sphere-less node is restored");
});

function makeWorld() {
  const staticsGroup = new THREE.Group();
  const table = new Map();
  let nextId = 1;
  const destroyed = [];
  const mgr = { particleTable: table, destroyParticleEmitter(id) { destroyed.push(id); table.delete(id); } };
  const rebuilds = [];
  const host = { staticsGroup, staticsBakedLbs: new Set(), _staticParticleManager: mgr };
  staticsGroup.userData.__staticsHost = host;
  const anchorsByLb = new Map();
  const addLb = (key, nAnchors, { synth = false } = {}) => {
    host.staticsBakedLbs.add(key);
    const list = [];
    for (let i = 0; i < nAnchors; i++) {
      const a = new THREE.Group();
      // A chained anchor: the attach stamps `__scriptDeferred = false` when it
      // runs the chain (unset = attach still in flight, which the tick skips).
      a.userData = { isStaticScriptAnchor: true, landblockId: (key | 0x0001) >>> 0, defaultScriptId: 0x33000113,
        __scriptDeferred: false };
      staticsGroup.add(a);
      table.set(nextId++, { parent: a });
      list.push(a);
    }
    if (synth) {
      const other = new THREE.Object3D();
      other.userData = { landblockId: key };
      staticsGroup.add(other);
      table.set(nextId++, { parent: other, synthesized: true });
    }
    anchorsByLb.set(key, list);
  };
  // The facade the loop ticks with: same staticsGroup + baked set, no manager.
  const facade = { staticsGroup, staticsBakedLbs: host.staticsBakedLbs };
  __setStaticScriptRebuildForTest((h, anchors) => { rebuilds.push({ h, anchors }); });
  return { host, facade, mgr, table, destroyed, rebuilds, anchorsByLb, addLb };
}

test("F4: far landblocks lose only their default_script emitters; hysteresis holds", () => {
  __setStaticScriptRadiusForTest(2);
  const w = makeWorld();
  const C = lb(0xa2, 0x1e);
  w.addLb(C, 2);                    // d0
  w.addLb(lb(0xa4, 0x1e), 2);       // d2
  w.addLb(lb(0xa5, 0x1e), 2);       // d3: inside the n+1 hysteresis band
  w.addLb(lb(0xa6, 0x1e), 3, { synth: true }); // d4: torn down
  const far = w.anchorsByLb.get(lb(0xa6, 0x1e));
  const epochs0 = far.map((a) => a.userData.__scriptEpoch | 0);
  tickStaticScriptRadius(w.facade, new Set([C]));
  assert.equal(w.destroyed.length, 3, "the far landblock's three anchor emitters");
  assert.ok([...w.table.values()].some((e) => e.synthesized), "its synthesized emitter survives");
  assert.equal(w.table.size, 2 + 2 + 2 + 1);
  for (const [i, a] of far.entries()) {
    assert.equal(a.userData.__scriptDeferred, true);
    assert.equal(a.userData.__scriptEpoch, epochs0[i] + 1);
  }
  for (const k of [C, lb(0xa4, 0x1e), lb(0xa5, 0x1e)]) {
    for (const a of w.anchorsByLb.get(k)) assert.notEqual(a.userData.__scriptDeferred, true, (k >>> 0).toString(16));
  }
  // Same player set → no work.
  w.destroyed.length = 0;
  tickStaticScriptRadius(w.facade, new Set([C]));
  assert.equal(w.destroyed.length, 0);
  assert.equal(w.rebuilds.length, 0);
});

test("F5/F6: approaching a deferred landblock rebuilds it through the builder host", () => {
  __setStaticScriptRadiusForTest(2);
  const w = makeWorld();
  const far = lb(0xa6, 0x1e);
  w.addLb(lb(0xa2, 0x1e), 1);
  w.addLb(far, 2);
  tickStaticScriptRadius(w.facade, new Set([lb(0xa2, 0x1e)]));
  assert.equal(w.host._staticScriptRadius.deferred.has(far), true, "state lives on the host");
  assert.equal(w.facade._staticScriptRadius, undefined, "not on the facade");
  // Step to d3 (hysteresis band): nothing rebuilt yet.
  tickStaticScriptRadius(w.facade, new Set([lb(0xa3, 0x1e)]));
  assert.equal(w.rebuilds.length, 0);
  // Step to d2: rebuilt, flags cleared.
  tickStaticScriptRadius(w.facade, new Set([lb(0xa4, 0x1e)]));
  assert.equal(w.rebuilds.length, 1);
  assert.equal(w.rebuilds[0].h, w.host, "rebuild runs on the host");
  assert.deepEqual(w.rebuilds[0].anchors, w.anchorsByLb.get(far));
  for (const a of w.anchorsByLb.get(far)) assert.equal(a.userData.__scriptDeferred, false);
  assert.equal(w.host._staticScriptRadius.deferred.has(far), false);
  // An evicted landblock leaves the deferred set on the next crossing.
  tickStaticScriptRadius(w.facade, new Set([lb(0xa9, 0x1e)])); // a2 now d7 → deferred
  assert.equal(w.host._staticScriptRadius.deferred.has(lb(0xa2, 0x1e)), true);
  w.host.staticsBakedLbs.delete(lb(0xa2, 0x1e));
  tickStaticScriptRadius(w.facade, new Set([lb(0xaa, 0x1e)]));
  assert.equal(w.host._staticScriptRadius.deferred.has(lb(0xa2, 0x1e)), false);
});

test("off: the tick is inert", () => {
  __setStaticScriptRadiusForTest(null);
  const w = makeWorld();
  w.addLb(lb(0xa6, 0x1e), 2);
  tickStaticScriptRadius(w.facade, new Set([lb(0xa2, 0x1e)]));
  assert.equal(w.destroyed.length, 0);
  assert.equal(w.table.size, 2);
  __setStaticScriptRadiusForTest(2);
});

test("F7: RP6 reads a frozen anchor's matrixWorld directly", async () => {
  const { rp6CullSphere } = await import("../scene3d/particles/particle_manager.js");
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  const anchor = new THREE.Group();
  anchor.position.set(10, 20, 30);
  anchor.userData = { isStaticScriptAnchor: true };
  worldRoot.add(anchor);
  __freezeStaticScriptAnchorForTest(anchor);
  let calls = 0;
  anchor.getWorldPosition = function (v) { calls += 1; return THREE.Object3D.prototype.getWorldPosition.call(this, v); };
  const out = new THREE.Vector3();
  rp6CullSphere({ parent: anchor, partIndex: -1, info: {} }, out);
  assert.equal(calls, 0, "no parent-chain recompose");
  const want = new THREE.Vector3().setFromMatrixPosition(anchor.matrixWorld);
  assert.ok(out.distanceTo(want) < 1e-9, `${out.toArray()} vs ${want.toArray()}`);
});
