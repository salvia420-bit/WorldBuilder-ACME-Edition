// tests/surface_anim_flag.test.mjs
//
// dat-parser-1 (2026-10-13) `?surfaceAnim=on` (DEFAULT OFF). A 2-entry
// SurfaceTexture (0x05) is a retail DETAIL PAIR — acclient.c
// ImgTex::GetSurfaceDID draws level[0] (client_highres.dat HiFi) unless
// Render::ShouldDropHighDetail(), else level[1] — never animation frames. The
// "animated surface" path (wasm `fetchSurfaceAnimFrames` →
// MaterialCache._maybeSetupSurfaceAnimation → tickAnimatedSurfaces at 4 Hz)
// now only arms under `?surfaceAnim=on`.
//
//   F1  surfaceAnimEnabled: only the exact `on` value enables it.
//   F2  surfaceAnimFramesFetch: null by default (even with the export), the
//       wasm getter under `=on`, null on a stale pkg/ without the export.
//   F3  the SHIPPED getOrCreateMaterialCache (statics.js): default → the
//       MaterialCache gets animFramesFetch=null, _maybeSetupSurfaceAnimation
//       never calls the getter, tickAnimatedSurfaces leaves `.map` alone.
//   F4  `?surfaceAnim=on` positive control: the getter is handed through and a
//       2-frame bundle still installs + cycles (the opt-in path is intact).
//   F5  source: statics.js is the only production `animFramesFetch:` site and
//       it goes through the gate.
//
// Fails on the pre-change code: surface_anim_flag.js does not exist and
// statics.js handed `wasmExports.fetchSurfaceAnimFrames` over unconditionally.
//
// Run: node tests/surface_anim_flag.test.mjs

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const src = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// statics.js arms a self-managed rAF at module scope: stub it out (same
// shims as tests/static_script_hooktime.test.mjs).
globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;
window.requestAnimationFrame = () => 0;
window.cancelAnimationFrame = () => {};

const F = await import("../scene3d/surface_anim_flag.js");

// ---------------------------------------------------------------------------
console.log("\n-- F1 surfaceAnimEnabled -------------------------------------");
{
  check("absent → off", F.surfaceAnimEnabled("") === false);
  check("?surfaceAnim=on → on", F.surfaceAnimEnabled("?surfaceAnim=on") === true);
  check("on among other params", F.surfaceAnimEnabled("?nosw=1&surfaceAnim=on&wireframe=1") === true);
  for (const v of ["off", "1", "true", "yes", "ON", "On", ""]) {
    check(`?surfaceAnim=${v} → off (opt-in is exact)`, F.surfaceAnimEnabled(`?surfaceAnim=${v}`) === false);
  }
  globalThis.location.search = "?surfaceAnim=on";
  check("no arg reads location.search (on)", F.surfaceAnimEnabled() === true);
  globalThis.location.search = "";
  check("no arg reads location.search (absent)", F.surfaceAnimEnabled() === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- F2 surfaceAnimFramesFetch ---------------------------------");
const getter = async () => null;
{
  check("default → null even with the export",
    F.surfaceAnimFramesFetch({ fetchSurfaceAnimFrames: getter }, "") === null);
  check("=on → the wasm getter",
    F.surfaceAnimFramesFetch({ fetchSurfaceAnimFrames: getter }, "?surfaceAnim=on") === getter);
  check("=on, stale pkg/ without the export → null",
    F.surfaceAnimFramesFetch({}, "?surfaceAnim=on") === null);
  check("=on, non-function export → null",
    F.surfaceAnimFramesFetch({ fetchSurfaceAnimFrames: 7 }, "?surfaceAnim=on") === null);
  check("=on, no wasmExports → null",
    F.surfaceAnimFramesFetch(undefined, "?surfaceAnim=on") === null);
}

// ---------------------------------------------------------------------------
console.log("\n-- F3 default: the shipped MaterialCache never fetches frames --");
const { getOrCreateMaterialCache } = await import("../scene3d/statics.js");
function makeTex(tag) {
  return { __tag: tag, wrapS: 1000, wrapT: 1000, magFilter: 1006, minFilter: 1008, anisotropy: 1, flipY: false, dispose() {} };
}
function spyGetter(bundle) {
  const calls = [];
  const fn = async (did) => { calls.push(did >>> 0); return bundle ? bundle() : null; };
  return { fn, calls };
}
const twoFrameBundle = () => ({
  frameCount: 2, width: 1, height: 1,
  takePixels: () => new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]),
  free() {},
});
const DID = 0x08001234;
{
  globalThis.location.search = "";
  const spy = spyGetter(twoFrameBundle);
  const scene3d = { wasmExports: { fetchSurfaceAnimFrames: spy.fn } };
  const mc = getOrCreateMaterialCache(scene3d);
  check("MaterialCache built", !!mc && scene3d.materialCache === mc);
  check("animFramesFetch is null by default", mc._animFramesFetch === null);
  const base = makeTex("base");
  const mat = { map: base, emissiveMap: null };
  mc.materials.set(DID, mat);
  mc._maybeSetupSurfaceAnimation(DID, mat, base);
  await tick(); await tick();
  check("getter never called", spy.calls.length === 0, `calls=${spy.calls.length}`);
  check("DID not even marked checked", mc._animChecked.size === 0);
  check("no animated materials", mc._animatedMaterials.size === 0);
  mc.tickAnimatedSurfaces(1.0);
  check("tickAnimatedSurfaces is a no-op (map unchanged)", mat.map === base);
}

// ---------------------------------------------------------------------------
console.log("\n-- F4 ?surfaceAnim=on: the opt-in path is intact -------------");
{
  globalThis.location.search = "?surfaceAnim=on";
  const spy = spyGetter(twoFrameBundle);
  const scene3d = { wasmExports: { fetchSurfaceAnimFrames: spy.fn } };
  const mc = getOrCreateMaterialCache(scene3d);
  check("animFramesFetch is the wasm getter", mc._animFramesFetch === spy.fn);
  const base = makeTex("base");
  const mat = { map: base, emissiveMap: base };
  mc.materials.set(DID, mat);
  mc._maybeSetupSurfaceAnimation(DID, mat, base);
  for (let i = 0; i < 5; i += 1) await tick();
  check("getter called once with the DID", spy.calls.length === 1 && spy.calls[0] === DID,
    `calls=${JSON.stringify(spy.calls)}`);
  check("2-frame bundle installed", mc._animatedMaterials.size === 1 && mat.map !== base);
  const f0 = mat.map;
  mc.tickAnimatedSurfaces(0.3);
  check("tick advances the frame (map + emissive alias)", mat.map !== f0 && mat.emissiveMap === mat.map);
  globalThis.location.search = "";
}

// ---------------------------------------------------------------------------
console.log("\n-- F5 source: every production animFramesFetch site is gated --");
{
  const statics = src("scene3d/statics.js");
  check("statics.js passes animFramesFetch through the gate",
    /animFramesFetch:\s*surfaceAnimFramesFetch\(scene3d\.wasmExports\)/.test(statics));
  check("statics.js no longer hands the raw export over",
    !/animFramesFetch:\s*scene3d\.wasmExports\?\.fetchSurfaceAnimFrames/.test(statics));
  const sites = [];
  for (const dir of ["scene3d", "app", "plugins", "ui", "rynth"]) {
    let files = [];
    try { files = readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".js")); } catch (_) { continue; }
    for (const f of files) {
      const rel = `${dir}/${f}`;
      if (/animFramesFetch\s*:/.test(src(rel))) sites.push(rel);
    }
  }
  check("statics.js is the only production animFramesFetch site",
    sites.length === 1 && sites[0] === "scene3d/statics.js", JSON.stringify(sites));
}

console.log(`\nsurface anim flag: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
