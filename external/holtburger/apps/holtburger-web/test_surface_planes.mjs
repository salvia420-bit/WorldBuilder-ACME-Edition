// 2026-08-05 — the atlas-staging seam (`scene3d/surface_planes.js`).
//
// The atlas stages layers by reading `THREE.DataTexture.image.data`, which is
// exactly the 1,332 MB of CPU copies we want to stop retaining. This seam makes
// the texture one source rather than the only source. What must hold:
//
//   PART 1 — tier 1 wins when the texture still has its bytes, and the answer is
//            byte-identical to reading `img.data` directly. Zero behaviour change
//            on a page where nothing has released anything.
//   PART 2 — tier 2 (the wasm memo) answers when the texture's copy is gone.
//   PART 3 — tier 3 is an honest MISS, never zeros. A consumer handed a
//            zero-filled plane would render a subtly wrong surface forever and
//            never know; "not this tick" is ordinary control flow here.
//   PART 4 — `canSupplyPlanes` is the batching predicate. It must answer YES from
//            the wasm side alone, because that is the whole point: with the CPU
//            copies gone, an `img.data` gate would unbatch every static and walk
//            back into the ~5,400-draw-call wall.
//   PART 5 — a stale `pkg/` (no `surfacePlanesCached` export) degrades to tier 1
//            + tier 3 instead of throwing.
//   PART 6 — wasm-bindgen handles are freed, or the seam becomes its own retainer.
//
// Run:
//   cd apps/holtburger-web/
//   node test_surface_planes.mjs

import {
  PLANE, initSurfacePlanes, planeFor, canSupplyPlanes, warmPlanes,
  surfacePlanesStats, __resetSurfacePlanesForTests,
} from "./scene3d/surface_planes.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

const tex = (bytes, w = 4, h = 4) =>
  bytes == null ? { image: { width: w, height: h } } : { image: { data: bytes, width: w, height: h } };

/** A wasm stub whose memo holds one DID. Counts frees so PART 6 can assert. */
function fakeWasm(memo) {
  const freed = { n: 0 };
  return {
    freed,
    surfacePlanesCached(did) {
      const m = memo[did];
      if (!m) return null;
      return {
        width: m.w, height: m.h,
        pixels: m.albedo, normalPixels: m.normal, heightPixels: m.height,
        free() { freed.n += 1; },
      };
    },
    surfacePlanesCachedHas(did) { return !!memo[did]; },
    async fetch_surfaces_pixels(dids) {
      return [...dids].map(() => ({ free() { freed.n += 1; } }));
    },
  };
}

console.log("PART 1 — tier 1: the texture's own bytes");
{
  __resetSurfacePlanesForTests();
  const albedo = new Uint8Array([1, 2, 3, 4]);
  const mat = { map: tex(albedo, 2, 2) };
  const p = planeFor(mat, PLANE.ALBEDO, 0x06001234);
  check("answers from the texture", p?.source === "texture", JSON.stringify(p?.source));
  check("hands back the SAME buffer, not a copy", p.data === albedo);
  check("carries the texture's dims", p.width === 2 && p.height === 2);
  check("counted as a texture hit", surfacePlanesStats().fromTexture === 1);
}

console.log("PART 2 — tier 2: the wasm memo when the copy is gone");
{
  __resetSurfacePlanesForTests();
  const did = 0x06005678;
  const wasmAlbedo = new Uint8Array([9, 9, 9, 9]);
  const wasmNormal = new Uint8Array([7, 7, 7, 7]);
  initSurfacePlanes(fakeWasm({ [did]: { w: 8, h: 8, albedo: wasmAlbedo, normal: wasmNormal } }));
  const released = { map: tex(null), normalMap: tex(null) }; // uploaded, CPU copy dropped
  const a = planeFor(released, PLANE.ALBEDO, did);
  check("albedo comes from wasm", a?.source === "wasm" && a.data === wasmAlbedo, JSON.stringify(a?.source));
  check("...with the wasm dims", a.width === 8 && a.height === 8);
  const n = planeFor(released, PLANE.NORMAL, did);
  check("normal comes from wasm too", n?.source === "wasm" && n.data === wasmNormal);
  check("counted as wasm hits", surfacePlanesStats().fromWasm === 2, JSON.stringify(surfacePlanesStats()));

  // Roughness/AO are texchan sidecars, NOT in the decode memo. They must MISS
  // rather than hand back albedo-shaped bytes.
  const r = planeFor(released, PLANE.ROUGHNESS, did);
  check("roughness is not faked from the memo", r === null, JSON.stringify(r));
}

console.log("PART 3 — tier 3: an honest miss");
{
  __resetSurfacePlanesForTests();
  initSurfacePlanes(fakeWasm({}));
  const p = planeFor({ map: tex(null) }, PLANE.ALBEDO, 0x06009999);
  check("returns null, never a zero-filled plane", p === null);
  check("counted as a miss", surfacePlanesStats().miss === 1);
  check("no source is claimed", p?.source === undefined);
  // An empty typed array is as bad as null bytes — it must not read as a hit.
  const empty = planeFor({ map: tex(new Uint8Array(0)) }, PLANE.ALBEDO, 0);
  check("a zero-length buffer is a miss, not a hit", empty === null);
}

console.log("PART 4 — canSupplyPlanes is the batching predicate");
{
  __resetSurfacePlanesForTests();
  const did = 0x0600ABCD;
  initSurfacePlanes(fakeWasm({ [did]: { w: 4, h: 4, albedo: new Uint8Array(4) } }));
  check("yes when the texture has bytes",
        canSupplyPlanes({ map: tex(new Uint8Array(4)) }, 0) === true);
  check("YES from wasm alone with the CPU copy released — the point of the seam",
        canSupplyPlanes({ map: tex(null) }, did) === true);
  check("no when neither can supply",
        canSupplyPlanes({ map: tex(null) }, 0x06000000) === false);
}

console.log("PART 5 — a stale pkg degrades, never throws");
{
  __resetSurfacePlanesForTests();
  initSurfacePlanes({ /* pkg predating the export */ });
  let threw = false;
  let p;
  try { p = planeFor({ map: tex(null) }, PLANE.ALBEDO, 0x06001111); } catch (_) { threw = true; }
  check("planeFor does not throw", !threw);
  check("...it misses", p === null);
  check("canSupplyPlanes falls back to the texture only",
        canSupplyPlanes({ map: tex(null) }, 0x06001111) === false &&
        canSupplyPlanes({ map: tex(new Uint8Array(4)) }, 0x06001111) === true);
  check("stats report the wasm tier as not ready", surfacePlanesStats().wasmReady === false);
}

console.log("PART 6 — handles are freed, and warm is batched");
{
  __resetSurfacePlanesForTests();
  const did = 0x06002222;
  const w = fakeWasm({ [did]: { w: 4, h: 4, albedo: new Uint8Array(4) } });
  initSurfacePlanes(w);
  planeFor({ map: tex(null) }, PLANE.ALBEDO, did);
  check("the SurfacePixels handle is freed after reading a plane", w.freed.n === 1,
        `freed=${w.freed.n}`);
  const before = w.freed.n;
  const n = await warmPlanes([did, did, 0x06003333, 0]);
  check("warm dedupes and drops falsy dids", n === 2, `warmed=${n}`);
  check("warm frees every handle it takes", w.freed.n === before + 2,
        `freed delta=${w.freed.n - before}`);
  check("warm counted", surfacePlanesStats().warmCompleted === 2);
  __resetSurfacePlanesForTests();
  check("warm with no wasm is a no-op, not a throw", (await warmPlanes([1, 2, 3])) === 0);
}

console.log("PART 7 — the shipped page threads the exports through");
{
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "index.html"), "utf8");
  // THE curated-opts trap this codebase documents in four places: `wasmExports`
  // handed to init3D is a hand-written object, not the module namespace. An
  // export missing from it is `undefined` at the reader, and this seam would
  // then run texture-only forever — i.e. silently do nothing, which is the one
  // failure mode it must not have.
  check("index.html lists surfacePlanesCached in the curated init3D opts",
        /surfacePlanesCached:\s*__hbWasmNs\.surfacePlanesCached/.test(html));
  check("...and surfacePlanesCachedHas",
        /surfacePlanesCachedHas:\s*__hbWasmNs\.surfacePlanesCachedHas/.test(html));
  // The seam needs a DID and the material is all the atlas has. Stamped on the
  // single write path into the per-DID maps, so it cannot drift from them.
  const mats = readFileSync(join(here, "scene3d", "materials.js"), "utf8");
  check("MaterialCache stamps surfaceDid on every cached material",
        /_installCacheEntry\(did, mat, tex, normalTex, heightTex\) \{[\s\S]{0,900}?userData = \{ \.\.\.\(mat\.userData \|\| \{\}\), surfaceDid: did >>> 0 \}/.test(mats));
  const rs = readFileSync(join(here, "src", "lib.rs"), "utf8");
  check("the wasm export exists and is memo-ONLY (never fetches on the sync path)",
        /js_name = surfacePlanesCached\)/.test(rs) &&
        /pub fn surface_planes_cached\(surface_did: u32\) -> Option<SurfacePixels> \{\n    surface_memo_get\(surface_did\)/.test(rs));
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
