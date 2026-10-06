// 2026-10-06 — `?particleSharedAlpha` (scene3d/particles/particle_manager.js SharedAlphaBuckets):
// the static and world ParticleManagers append their alpha particles of one (gfxobj, layer) to
// ONE bucket, so a single back-to-front sort orders overlapping plumes of both.
//
// Run:
//   cd apps/holtburger-web/
//   node test_particle_shared_alpha.mjs

import * as THREE from "three";
import {
  SharedAlphaBuckets,
  _alphaMatSig,
  _sortBucketBackToFront,
  particleSharedAlphaEnabled,
  setParticleSharedAlphaFlag,
} from "./scene3d/particles/particle_manager.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

const world = new THREE.Group();
const staticsGroup = new THREE.Group(), entitiesGroup = new THREE.Group(), shifted = new THREE.Group();
shifted.position.set(0, 0, 50);
world.add(staticsGroup, entitiesGroup, shifted);
world.updateMatrixWorld(true);
const tex = new THREE.Texture();
const baseMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.1 });
const SIG = _alphaMatSig(baseMat);
const makeIm = () => new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), baseMat.clone(), 16);
const mm = new THREE.Matrix4();
const append = (b, zs) => { for (const z of zs) { b.im.setMatrixAt(b.n, mm.makeTranslation(0, 0, z)); b.im.setColorAt(b.n, new THREE.Color(z / 10, 0, 0)); b.n++; } };
const order = (b) => { const out = []; for (let i = 0; i < b.im.count; i++) { b.im.getMatrixAt(i, mm); out.push(mm.elements[14]); } return out.join(","); };
const cam = new THREE.Vector3(0, 0, 0);
const reg = new SharedAlphaBuckets();
const KEY = "16842687|0|a";

console.log("two managers, one bucket");
{
  // frame 1: statics tick first, then the world manager
  const a = reg.acquire(KEY, staticsGroup, SIG, makeIm, 1);
  append(a, [5, 1]);
  reg.finalize(1, cam, _sortBucketBackToFront);
  check("after the first manager: its own two particles, sorted", order(a) === "5,1", order(a));
  const b = reg.acquire(KEY, entitiesGroup, SIG, makeIm, 1);
  check("the second manager gets the SAME bucket", a === b && reg.buckets.size === 1 && reg.stats.created === 1);
  append(b, [9, 3]);
  reg.finalize(1, cam, _sortBucketBackToFront);
  check("after both: one back-to-front list across both managers", order(b) === "9,5,3,1", order(b));
  check("opacity (instance colour) travels with each instance", (() => { const c = new THREE.Color(); b.im.getColorAt(0, c); return Math.round(c.r * 10) === 9; })());
  check("the bucket is parented once, to the first host", staticsGroup.children.includes(b.im) && !entitiesGroup.children.includes(b.im));
}
{
  // frame 2: the other tick order; the world manager appends first
  const b = reg.acquire(KEY, entitiesGroup, SIG, makeIm, 2);
  check("a new frame resets the bucket on its first append", b.n === 0);
  append(b, [2]);
  reg.finalize(2, cam, _sortBucketBackToFront);
  const a = reg.acquire(KEY, staticsGroup, SIG, makeIm, 2);
  append(a, [8, 4]);
  reg.finalize(2, cam, _sortBucketBackToFront);
  check("either tick order ends with the full sorted list", order(a) === "8,4,2", order(a));
}
{
  // frame 3: the statics manager has nothing; its finalize parks the bucket, the world append revives it
  reg.finalize(3, cam, _sortBucketBackToFront);
  const b0 = reg.buckets.get(KEY);
  check("a finalize before any append this frame parks the bucket dark", b0.im.count === 0);
  const b = reg.acquire(KEY, entitiesGroup, SIG, makeIm, 3);
  append(b, [7]);
  reg.finalize(3, cam, _sortBucketBackToFront);
  check("...and a later append in the same frame publishes it", b.im.count === 1 && order(b) === "7" && b.idle === 0);
}

console.log("\nidle and reap");
{
  const b = reg.buckets.get(KEY);
  let f = 10;
  for (let i = 0; i < 5; i++, f++) { reg.finalize(f, cam, _sortBucketBackToFront); reg.finalize(f, cam, _sortBucketBackToFront); }
  check("two finalizes per frame count ONE idle frame", b.idle === 5 && b.im.count === 0, `idle ${b.idle}`);
  for (let i = 0; i < 400 && reg.buckets.size; i++, f++) reg.finalize(f, cam, _sortBucketBackToFront);
  check("reaped after the idle window, removed from its scene", reg.buckets.size === 0 && reg.stats.reaped === 1 && !staticsGroup.children.includes(b.im));
}

console.log("\nwho may share");
{
  const a = reg.acquire(KEY, staticsGroup, SIG, makeIm, 100);
  check("a host with a different world transform cannot join", reg.acquire(KEY, shifted, SIG, makeIm, 100) === null && reg.stats.rejectedScene === 1);
  const other = new THREE.MeshBasicMaterial({ map: new THREE.Texture(), transparent: true, alphaTest: 0.1 });
  check("a different texture / material state cannot join", reg.acquire(KEY, entitiesGroup, _alphaMatSig(other), makeIm, 100) === null && reg.stats.rejectedMat === 1);
  check("the original sharer keeps its bucket", reg.acquire(KEY, staticsGroup, SIG, makeIm, 100) === a);
}

console.log("\nflag");
{
  setParticleSharedAlphaFlag(false);
  check("setter off", particleSharedAlphaEnabled() === false);
  setParticleSharedAlphaFlag(true);
  check("setter on", particleSharedAlphaEnabled() === true);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
