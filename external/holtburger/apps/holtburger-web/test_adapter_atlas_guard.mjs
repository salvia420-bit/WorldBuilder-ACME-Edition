// test_adapter_atlas_guard.mjs — gate for adapter-guard (#likely:adapter-guard).
//
// buildTerrainAtlasArrayBytes() previously guarded its input with
//   if (!Array.isArray(t) && !t.length)
// which (a) never fired for an empty array `[]` (Array.isArray([]) is true,
// so the `&&` short-circuits) and (b) THREW a TypeError on `null` (reading
// `null.length`) instead of a descriptive Error. The fix:
//   if (!Array.isArray(t) || t.length === 0)
// + a message hardened with `t?.length`.
//
// adapter.js can't be imported under node (bare `three` specifier), so we
// extract just buildTerrainAtlasArrayBytes from the source and evaluate it
// with stub module constants + a minimal document/ImageData stub. This
// exercises the REAL guard text from the file.
//
// Run from apps/holtburger-web:
//   node test_adapter_atlas_guard.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adapterSrc = readFileSync(
  resolvePath(__dirname, "scene3d", "adapter.js"),
  "utf8"
);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

console.log("== adapter-guard buildTerrainAtlasArrayBytes ==");

// Extract the function body verbatim from the real source.
const fnMatch = adapterSrc.match(
  /export function buildTerrainAtlasArrayBytes\(terrainTextures\)\s*\{([\s\S]*?)\n\}/
);
if (!fnMatch) {
  console.log("  [FAIL] could not locate buildTerrainAtlasArrayBytes in adapter.js");
  process.exit(1);
}

// Minimal stubs for the module-level constants the body references + DOM.
const ATLAS_TILE_PX = 512;
const ATLAS_DEPTH = 33;

// Tiny canvas/ImageData/document stubs — only the 33-element (valid) path
// touches these; the guard error paths throw before any of this runs.
class ImageDataStub {
  constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
}
function makeCtx() {
  return {
    putImageData() {},
    clearRect() {},
    drawImage() {},
    getImageData(_x, _y, w, h) {
      return new ImageDataStub(new Uint8ClampedArray(w * h * 4), w, h);
    },
  };
}
const documentStub = {
  createElement() {
    return { width: 0, height: 0, getContext: makeCtx };
  },
};

const builder = new Function(
  "ATLAS_TILE_PX",
  "ATLAS_DEPTH",
  "document",
  "ImageData",
  `return function buildTerrainAtlasArrayBytes(terrainTextures) {${fnMatch[1]}\n};`
)(ATLAS_TILE_PX, ATLAS_DEPTH, documentStub, ImageDataStub);

const GUARD_RE = /not a non-empty array/;

// 1. null → descriptive Error (not a raw TypeError reading .length).
{
  let err = null;
  try { builder(null); } catch (e) { err = e; }
  check(
    "null input throws a descriptive Error (not a TypeError)",
    err instanceof Error && GUARD_RE.test(err.message) && !(err instanceof TypeError),
    `err=${err && err.message}`
  );
}

// 2. empty array → descriptive Error (the old `&&` guard missed this).
{
  let err = null;
  try { builder([]); } catch (e) { err = e; }
  check(
    "empty-array input throws the descriptive guard Error",
    err instanceof Error && GUARD_RE.test(err.message),
    `err=${err && err.message}`
  );
}

// 3. A 33-element array of valid 512x512 tiles PROCEEDS past the guard
//    (must not throw the array-like guard error).
{
  const tiles = [];
  for (let i = 0; i < ATLAS_DEPTH; i++) {
    tiles.push({
      terrainType: i,
      width: ATLAS_TILE_PX,
      height: ATLAS_TILE_PX,
      pixels: new Uint8Array(ATLAS_TILE_PX * ATLAS_TILE_PX * 4),
    });
  }
  let err = null;
  try { builder(tiles); } catch (e) { err = e; }
  check(
    "33-element valid array proceeds past the guard (no guard Error)",
    !(err && GUARD_RE.test(err.message)),
    err ? `unexpected guard error: ${err.message}` : "no guard error"
  );
}

// 4. Wrong-length (non-empty) array still hits the depth check, not the
//    array-like guard — proves we didn't over-broaden the new guard.
{
  let err = null;
  try { builder([{ terrainType: 0, width: 512, height: 512, pixels: new Uint8Array(4) }]); }
  catch (e) { err = e; }
  check(
    "1-element array passes array-like guard, fails depth check instead",
    err instanceof Error && !GUARD_RE.test(err.message) && /expected 33/.test(err.message),
    `err=${err && err.message}`
  );
}

// ---- Summary --------------------------------------------------------
console.log("=========================");
if (failed === 0) {
  console.log(`PASS: ${passed}/${passed} adapter atlas-guard checks green.`);
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
  process.exit(1);
}
