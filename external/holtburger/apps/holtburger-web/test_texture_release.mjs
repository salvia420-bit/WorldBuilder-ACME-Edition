// 2026-08-05 — task 4: releasing the CPU-side texture copy after upload
// (`scene3d/texture_release.js`), the 1,332 MB lever.
//
// This is the most dangerous change in the residency plan, so the suite is
// mostly about what it must REFUSE to do:
//
//   PART 1 — default OFF, strict `=on`. Turning this on before the atlas reads
//            through the seam unbatches every static; it must not be reachable
//            by a typo.
//   PART 2 — the excluded classes are excluded BY CONSTRUCTION, not by luck:
//            atlas arrays (their CPU buffer is what `addLayerUpdate` re-uploads
//            from), pooled per-LB planes, canvas-backed textures, and anything
//            with no `surfaceDid` to refill from.
//   PART 3 — the hook is three's `onUpdate` and it CHAINS: an existing callback
//            still runs. (`onUpload` does not exist — an earlier draft of this
//            plan cited it, which is exactly the kind of thing a test pins.)
//   PART 4 — register BEFORE release. A context loss landing between the two
//            would find a texture with no pixels and nothing telling anyone to
//            refill it.
//   PART 5 — the refill actually puts pixels back, and reports a MISS rather
//            than zeros when it cannot.
//
// Run:
//   cd apps/holtburger-web/
//   node test_texture_release.mjs

import {
  texFreeCpuEnabled, armCpuRelease, releaseNow, disarmCpuRelease,
  textureReleaseStats, __resetTextureReleaseForTests,
} from "./scene3d/texture_release.js";
import {
  releasedTextureCount, rehydrateReleasedTextures, textureRehydrateStats,
  __resetTextureRehydrateForTests,
} from "./scene3d/texture_rehydrate.js";
import { initSurfacePlanes, __resetSurfacePlanesForTests } from "./scene3d/surface_planes.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

const DID = 0x06001234;
function mkTex(bytes = 64, extra = {}) {
  return {
    isTexture: true, isDataTexture: true, id: Math.floor(Math.random() * 1e9),
    image: { data: new Uint8Array(bytes), width: 4, height: 4 },
    version: 0,
    set needsUpdate(v) { if (v === true) this.version += 1; },
    ...extra,
  };
}
function reset() {
  __resetTextureReleaseForTests();
  __resetTextureRehydrateForTests();
  __resetSurfacePlanesForTests();
}

console.log("PART 1 — default OFF, strict opt-in");
{
  check("absent is OFF", texFreeCpuEnabled("") === false);
  for (const s of ["?texFreeCpu=1", "?texFreeCpu=true", "?texFreeCpu", "?texFreeCpu=yes", "?texFreeCpu=off"]) {
    check(`"${s}" is OFF`, texFreeCpuEnabled(s) === false);
  }
  check("only =on arms", texFreeCpuEnabled("?texFreeCpu=on") === true);
  reset();
  check("arming is a no-op while the flag is off", armCpuRelease(mkTex(), "albedo", DID) === false);
}

console.log("PART 2 — the excluded classes");
{
  reset();
  const cases = [
    ["a DataArrayTexture (its CPU buffer is addLayerUpdate's staging copy)",
     mkTex(64, { isDataArrayTexture: true })],
    ["a CompressedArrayTexture (same reason)", mkTex(64, { isCompressedArrayTexture: true })],
    ["a Data3DTexture", mkTex(64, { isData3DTexture: true })],
    ["a pooled per-LB plane (recycled and rewritten forever)",
     mkTex(64, { userData: { __rp4Pooled: true } })],
    ["a canvas-backed texture (no typed array to release)",
     { isTexture: true, id: 1, image: { width: 4, height: 4 } }],
  ];
  for (const [label, t] of cases) {
    check(`refuses ${label}`, armCpuRelease(t, "albedo", DID, { force: true }) === false);
  }
  check("refuses a texture with no surfaceDid to refill from",
        armCpuRelease(mkTex(), "albedo", 0, { force: true }) === false);
  check("all of those counted as skips", textureReleaseStats().skipped === 6,
        String(textureReleaseStats().skipped));
  check("and NOTHING was registered for re-hydration", releasedTextureCount() === 0);
}

console.log("PART 3 — the hook is onUpdate, and it chains");
{
  reset();
  const t = mkTex(256);
  let priorRan = 0;
  t.onUpdate = () => { priorRan += 1; };
  check("arms with force", armCpuRelease(t, "albedo", DID, { force: true }) === true);
  check("arming is idempotent", armCpuRelease(t, "albedo", DID, { force: true }) === true);
  check("the CPU copy is still there before upload", t.image.data?.byteLength === 256);
  t.onUpdate(t);                                  // what three does post-upload
  check("the pre-existing onUpdate still ran", priorRan === 1, `ran=${priorRan}`);
  check("the CPU copy is gone after upload", t.image.data === null);
  check("counted", textureReleaseStats().released === 1 && textureReleaseStats().bytesReleased === 256,
        JSON.stringify(textureReleaseStats()));
}

console.log("PART 4 — registered BEFORE released");
{
  reset();
  const t = mkTex(128);
  releaseNow(t, "albedo", DID);
  check("an entry exists for it", releasedTextureCount() === 1, String(releasedTextureCount()));
  check("...and the pixels are gone", t.image.data === null);
  check("disarm drops the entry", disarmCpuRelease(t) === true && releasedTextureCount() === 0);
}

console.log("PART 5 — the refill round-trip");
{
  reset();
  const restored = new Uint8Array([5, 5, 5, 5]);
  initSurfacePlanes({
    surfacePlanesCached: () => ({ width: 4, height: 4, pixels: restored, free() {} }),
    surfacePlanesCachedHas: () => true,
    async fetch_surfaces_pixels() { return []; },
  });
  const t = mkTex(4);
  releaseNow(t, "albedo", DID);
  check("released", t.image.data === null);
  const r = await rehydrateReleasedTextures({ reason: "test" });
  check("the pass reports no failures", (r?.failed ?? textureRehydrateStats().failed) === 0,
        JSON.stringify(r ?? textureRehydrateStats()));
  check("the pixels came back", t.image.data === restored, String(t.image.data?.byteLength));
  check("counted as a refill", textureReleaseStats().refilled === 1);

  // ...and when wasm cannot supply, it must be a MISS, never zeros.
  reset();
  initSurfacePlanes({ surfacePlanesCached: () => null, surfacePlanesCachedHas: () => false });
  const t2 = mkTex(4);
  releaseNow(t2, "albedo", DID);
  await rehydrateReleasedTextures({ reason: "test-miss" });
  check("an unsupplyable refill is a loud MISS", textureRehydrateStats().failed >= 1,
        JSON.stringify(textureRehydrateStats()));
  check("...and it did NOT invent zeros", t2.image.data === null || t2.image.data === undefined,
        String(t2.image.data));
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
