// 2026-10-06 — ?batchMatVariant variants are shape-identical CLONES synced
// once per frame (scene3d/batched_material_variant.js), not Object.create()
// prototypes (which made three's material reads megamorphic).
//
// Run:
//   cd apps/holtburger-web/
//   node test_batch_mat_variant_clone.mjs

import * as THREE from "three";
import { batchedMaterialFor, memberMaterialOf, syncBatchMatVariants, holdBatchedMaterial, releaseBatchedMaterial, batchMatVariantStats } from "./scene3d/batched_material_variant.js";
const m = new THREE.MeshStandardMaterial({ color: 0x336699, opacity: 0.5, transparent: true });
m.onBeforeCompile = () => {}; m.userData.x = 1;
const v = batchedMaterialFor(m);
let failed = 0, passed = 0;
const ok = (n, c) => { console.log(`  [${c ? "OK" : "FAIL"}] ${n}`); c ? passed++ : failed++; };
ok("distinct object, same class", v !== m && v.constructor === m.constructor);
ok("member lookup", memberMaterialOf(v) === m);
ok("own (not inherited) props", Object.getPrototypeOf(v) === Object.getPrototypeOf(m) && Object.prototype.hasOwnProperty.call(v, "opacity"));
ok("shares color/userData objects", v.color === m.color && v.userData === m.userData && v.onBeforeCompile === m.onBeforeCompile);
ok("own id/uuid", v.id !== m.id && v.uuid !== m.uuid);
const keysM = Object.keys(m).filter((k) => !["id", "uuid", "_listeners"].includes(k)), keysV = Object.keys(v).filter((k) => !["id", "uuid", "_listeners"].includes(k));
ok("same own-key order as the member (same hidden class)", keysM.join() === keysV.join());
m.opacity = 0.25; m.map = new THREE.Texture(); m.needsUpdate = true; m.customProgramCacheKey = () => "x";
syncBatchMatVariants();
ok("sync: opacity follows", v.opacity === 0.25);
ok("sync: re-seated map follows", v.map === m.map);
ok("sync: version follows (recompile with the member)", v.version === m.version);
ok("sync: a NEW own key after a version bump follows", v.customProgramCacheKey === m.customProgramCacheKey);
let mDisposed = 0, vDisposed = 0; m.addEventListener("dispose", () => mDisposed++); v.addEventListener("dispose", () => vDisposed++);
v.dispose();
ok("disposing the bucket material disposes the member (legacy meaning), once each", mDisposed === 1 && vDisposed === 1);
ok("a disposed member's variant is no longer synced/handed out", batchedMaterialFor(m) !== v);

// A key changed outside the per-frame hot list still arrives via the sweep.
{
  const m2 = new THREE.MeshStandardMaterial({ roughness: 0.4 });
  const v2 = batchedMaterialFor(m2);
  m2.roughness = 0.9; // not a hot key
  for (let i = 0; i < 40; i++) syncBatchMatVariants();
  ok("a non-hot key change reaches the variant within one full sweep", v2.roughness === 0.9);
  m2.roughness = 0.1;
  syncBatchMatVariants();
  ok("…and is promoted to the per-frame list afterwards", v2.roughness === 0.1);
}
// 2026-10-07 HOLDERS — a variant leaves the per-frame sync set when the last
// BatchedMesh holding it is released, and that disposes the variant ONLY.
{
  const m3 = new THREE.MeshStandardMaterial({ color: 0x884422 });
  const base = batchMatVariantStats();
  const bmA = { material: batchedMaterialFor(m3) }, bmB = { material: batchedMaterialFor(m3) };
  const v3 = bmA.material;
  ok("hold: two batches share one variant", v3 === bmB.material && v3 !== m3);
  holdBatchedMaterial(bmA); holdBatchedMaterial(bmB); holdBatchedMaterial(bmA);
  ok("hold: counted once per batch", batchMatVariantStats().holders === base.holders + 2);
  let m3Disposed = 0, v3Disposed = 0;
  m3.addEventListener("dispose", () => m3Disposed++); v3.addEventListener("dispose", () => v3Disposed++);
  releaseBatchedMaterial(bmA);
  ok("release: still live while another batch holds it", batchMatVariantStats().live === base.live + 1 && v3Disposed === 0);
  ok("release: idempotent per batch", releaseBatchedMaterial(bmA) === false && batchMatVariantStats().holders === base.holders + 1);
  releaseBatchedMaterial(bmB);
  const st = batchMatVariantStats();
  ok("last release: variant leaves the sync set", st.live === base.live && st.holders === base.holders && st.dropped === base.dropped + 1);
  ok("last release: the variant is disposed, the member is NOT", v3Disposed === 1 && m3Disposed === 0);
  m3.dispose();
  ok("last release: the member's listener is unhooked (its dispose no longer reaches the old variant)", v3Disposed === 1 && m3Disposed === 1);
  const m4 = new THREE.MeshStandardMaterial();
  const v4a = batchedMaterialFor(m4);
  const bmC = { material: v4a };
  holdBatchedMaterial(bmC); releaseBatchedMaterial(bmC);
  ok("a re-batched member gets a fresh variant", batchedMaterialFor(m4) !== v4a);
  // Held while the flag was off (bucket draws the member), then switched on at
  // runtime: the variant made by the A/B seam still drops with the last holder.
  const m5 = new THREE.MeshStandardMaterial();
  const bmD = { material: m5 };
  holdBatchedMaterial(bmD);
  bmD.material = batchedMaterialFor(m5);
  const live5 = batchMatVariantStats().live;
  releaseBatchedMaterial(bmD);
  ok("a member held with the flag off still drops its later variant", batchMatVariantStats().live === live5 - 1);
}
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
