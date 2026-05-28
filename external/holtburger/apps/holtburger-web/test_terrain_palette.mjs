// Wave 2.A / Agent 2.A — terrain palette LUT unit tests.
//
// Run with:
//   cd /home/wbterminal/WorldBuilder-ACME-Edition
//   node external/holtburger/apps/holtburger-web/test_terrain_palette.mjs
//
// Exits non-zero on any failure.
//
// ===========================================================================
// What this exercises
// ===========================================================================
//
// `scene3d/terrain.js` ships `loadTerrainPaletteLut()` — fetches
// `data/terrain_palette.json`, builds a 32×1 RGBA `THREE.DataTexture`,
// returns `{ texture, rgba }`. The Rust dump tool
// (`cargo run -p holtburger-dat --example dump_terrain_palette`) is
// the source of truth for the JSON; this test asserts the loader
// round-trips four well-known retail Region-1 ("Dereth") entries
// correctly through the byte buffer (no channel swap, no off-by-one).
//
// Tight-coupling friction:
//   - `terrain.js` imports `"three"` as a bare specifier. Same workaround
//     as `test_play_effect_resolver.mjs` — Node module-resolution hook
//     points `"three"` at the local `_three_stub.mjs`, extended in this
//     test if necessary to cover the symbols `loadTerrainPaletteLut`
//     touches (`DataTexture`, the format/type/filter constants,
//     colour-space constant).
//   - `terrain.js` also imports `./adapter.js` which transitively pulls
//     in `THREE.DataArrayTexture`, `THREE.Vector2`, etc. The test stub
//     is widened to no-op shells for everything the import graph hits.
//   - `fetch` is global; we polyfill it to read the JSON straight off
//     disk (no HTTP server) so the test is self-contained.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { register } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Step 1: register a `"three"` stub if not already present -----------
//
// `_three_stub_loader.mjs` + `_three_stub.mjs` already exist in this dir
// (committed for `test_play_effect_resolver.mjs`). The stub there only
// covers a subset of THREE; we widen it idempotently if our needs
// aren't already satisfied. The widening writes a sibling stub file —
// `_three_stub_palette.mjs` — and a sibling resolver — so we don't
// stomp the play-effect tests' more minimal stub.

const STUB_LOADER_PATH = resolvePath(__dirname, "_three_stub_palette_loader.mjs");
const STUB_THREE_PATH = resolvePath(__dirname, "_three_stub_palette.mjs");

if (!existsSync(STUB_THREE_PATH)) {
  // Minimal THREE shim covering only what `terrain.js` + transitively
  // imported `adapter.js` + `materials.js` touch at module-import time
  // and inside `loadTerrainPaletteLut()`. Render-path classes can be
  // no-op shells — the test never instantiates a real GL context.
  writeFileSync(STUB_THREE_PATH, `
class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } set(x,y){this.x=x;this.y=y;return this;} clone(){return new Vector2(this.x,this.y);} }
class Vector3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this;} set(x,y,z){this.x=x;this.y=y;this.z=z;return this;} setScalar(s){this.x=this.y=this.z=s;return this;} clone(){return new Vector3(this.x,this.y,this.z);} normalize(){const l=Math.hypot(this.x,this.y,this.z)||1;this.x/=l;this.y/=l;this.z/=l;return this;} }
class Vector4 { constructor(x=0,y=0,z=0,w=0){this.x=x;this.y=y;this.z=z;this.w=w;} }
class Matrix4 { constructor(){} clone(){return new Matrix4();} }
class Quaternion { constructor(x=0,y=0,z=0,w=1){this.x=x;this.y=y;this.z=z;this.w=w;} }
class Color { constructor(){} }
class BufferAttribute { constructor(arr,size,norm){this.array=arr;this.itemSize=size;this.normalized=norm;} }
class BufferGeometry { constructor(){this.attributes={};this.index=null;} setAttribute(name,attr){this.attributes[name]=attr;return this;} setIndex(i){this.index=i;return this;} computeBoundingSphere(){} computeVertexNormals(){} dispose(){} }
class Object3D {
  constructor(){this.position=new Vector3();this.scale=new Vector3(1,1,1);this.rotation={x:0,y:0,z:0};this.children=[];this.parent=null;this.name="";this.userData={};this.renderOrder=0;}
  add(c){this.children.push(c);c.parent=this;}
  remove(c){const i=this.children.indexOf(c);if(i>=0){this.children.splice(i,1);c.parent=null;}}
}
class Mesh extends Object3D { constructor(geom,mat){super();this.geometry=geom;this.material=mat;this.receiveShadow=false;this.castShadow=false;} }
class SphereGeometry { constructor(){} dispose(){} }
class TorusGeometry { constructor(){} dispose(){} }
class BoxGeometry { constructor(){} dispose(){} }
class PlaneGeometry { constructor(){} dispose(){} }
class MeshBasicMaterial { constructor(opts={}){Object.assign(this,opts);this.userData={};} dispose(){} }
class MeshStandardMaterial { constructor(opts={}){Object.assign(this,opts);this.userData={};} dispose(){} }
class ShaderMaterial { constructor(opts={}){Object.assign(this,opts);this.userData={};} dispose(){} }
class Material { dispose(){} }
class Texture { constructor(){this.colorSpace=0;this.needsUpdate=false;} dispose(){} }
class DataTexture {
  constructor(data,w,h,format,type){
    this.image={data,width:w,height:h};
    this.format=format;
    this.type=type;
    this.colorSpace=0;
    this.magFilter=0;
    this.minFilter=0;
    this.generateMipmaps=true;
    this.wrapS=0;
    this.wrapT=0;
    this.needsUpdate=false;
  }
  dispose(){}
}
class DataArrayTexture {
  constructor(data,w,h,depth){
    this.image={data,width:w,height:h,depth};
    this.colorSpace=0;
    this.needsUpdate=false;
  }
  dispose(){}
}
class CanvasTexture {
  constructor(canvas){this.canvas=canvas;this.needsUpdate=false;}
  dispose(){}
}
class Raycaster {
  constructor(){this.ray={origin:new Vector3(),direction:new Vector3()};}
  set(origin,direction){this.ray.origin.copy(origin);this.ray.direction.copy(direction);}
  intersectObject(){return [];}
  intersectObjects(){return [];}
}
const RGBAFormat = 1023;
const UnsignedByteType = 1009;
const NearestFilter = 1003;
const LinearFilter = 1006;
const LinearMipmapLinearFilter = 1008;
const ClampToEdgeWrapping = 1001;
const RepeatWrapping = 1000;
const SRGBColorSpace = "srgb";
const LinearSRGBColorSpace = "srgb-linear";
const NoColorSpace = "";
const AdditiveBlending = 2;
const FrontSide = 0;
const DoubleSide = 2;
const GLSL3 = "300 es";
export {
  Vector2, Vector3, Vector4, Matrix4, Quaternion, Color,
  BufferAttribute, BufferGeometry,
  Object3D, Mesh,
  SphereGeometry, TorusGeometry, BoxGeometry, PlaneGeometry,
  MeshBasicMaterial, MeshStandardMaterial, ShaderMaterial, Material,
  Texture, DataTexture, DataArrayTexture, CanvasTexture, Raycaster,
  RGBAFormat, UnsignedByteType,
  NearestFilter, LinearFilter, LinearMipmapLinearFilter,
  ClampToEdgeWrapping, RepeatWrapping,
  SRGBColorSpace, LinearSRGBColorSpace, NoColorSpace,
  AdditiveBlending, FrontSide, DoubleSide,
  GLSL3,
};
`);
}

if (!existsSync(STUB_LOADER_PATH)) {
  writeFileSync(STUB_LOADER_PATH, `
import { pathToFileURL } from "node:url";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB = pathToFileURL(resolvePath(__dirname, "_three_stub_palette.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "three") {
    return { url: STUB, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
`);
}

register(pathToFileURL(STUB_LOADER_PATH).href, import.meta.url);

// ---- Step 2: polyfill global `fetch` to read JSON off disk --------------
//
// `loadTerrainPaletteLut()` does `fetch("./data/terrain_palette.json")`.
// In Node we resolve that relative to the apps/holtburger-web dir
// (where terrain.js conceptually lives) and read the file directly.

const PALETTE_JSON_PATH = resolvePath(__dirname, "data/terrain_palette.json");

if (typeof globalThis.fetch === "undefined" || !globalThis.__terrainPaletteFetchStubInstalled) {
  globalThis.fetch = async (url, _opts) => {
    if (typeof url === "string" && url.endsWith("data/terrain_palette.json")) {
      const text = readFileSync(PALETTE_JSON_PATH, "utf8");
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(text),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  globalThis.__terrainPaletteFetchStubInstalled = true;
}

// ---- Step 3: now safe to import terrain.js + run assertions ------------

const terrainUrl =
  pathToFileURL(resolvePath(__dirname, "scene3d/terrain.js")).href;
const {
  loadTerrainPaletteLut,
  getTerrainPaletteTextureSync,
  _resetTerrainPaletteLutForTest,
  DEFAULT_TERRAIN_PALETTE_STRENGTH,
} = await import(terrainUrl);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// ---- Test 1: loader returns a 32-entry palette + texture ---------------

console.log("Test 1: loader basic shape");
_resetTerrainPaletteLutForTest();
const lut = await loadTerrainPaletteLut();
check("loader resolves non-null", lut !== null, `got=${typeof lut}`);
check("returns rgba Uint8Array", lut?.rgba instanceof Uint8Array, `got=${lut?.rgba?.constructor?.name}`);
check(
  "rgba length is 32*4 = 128",
  lut?.rgba?.length === 128,
  `got=${lut?.rgba?.length}`,
);
check("returns DataTexture", lut?.texture != null, `got=${typeof lut?.texture}`);
check(
  "texture has needsUpdate=true",
  lut?.texture?.needsUpdate === true,
  `got=${lut?.texture?.needsUpdate}`,
);
check(
  "texture is 32x1",
  lut?.texture?.image?.width === 32 && lut?.texture?.image?.height === 1,
  `got=${lut?.texture?.image?.width}x${lut?.texture?.image?.height}`,
);

// ---- Test 2: well-known retail Region-1 ("Dereth") palette samples ----
//
// Truth source: `apps/holtburger-web/data/terrain_palette.json`, which
// was generated from `client_portal.dat` Region 0x13000000 via the Rust
// dump. The four indices below are spot-checks chosen for visual
// distinctiveness — they're not "load-bearing" individually, but
// asserting all four passes makes a channel-swap regression
// (e.g. PhatSDK RGBAUnion BGRA byte order) immediately visible: water
// would render red, sand would render blue, etc.

console.log("Test 2: known retail palette samples (Dereth region)");
const samples = [
  { idx: 1,  name: "Grassland",          r: 100, g: 220, b: 100, a: 255 },
  { idx: 3,  name: "LushGrass",          r:  70, g: 250, b:  70, a: 255 },
  { idx: 15, name: "Snow",               r: 250, g: 250, b: 250, a: 255 },
  { idx: 16, name: "WaterRunning",       r: 100, g: 100, b: 200, a: 255 },
  { idx: 20, name: "WaterDeepSea",       r:  10, g:  70, b: 100, a: 255 },
];
for (const s of samples) {
  const off = s.idx * 4;
  const r = lut.rgba[off + 0];
  const g = lut.rgba[off + 1];
  const b = lut.rgba[off + 2];
  const a = lut.rgba[off + 3];
  const ok = r === s.r && g === s.g && b === s.b && a === s.a;
  check(
    `palette[${s.idx}] (${s.name})`,
    ok,
    `got=(${r},${g},${b},${a}) expected=(${s.r},${s.g},${s.b},${s.a})`,
  );
}

// ---- Test 3: memoisation — second call returns same texture handle ----

console.log("Test 3: memoisation");
const lut2 = await loadTerrainPaletteLut();
check(
  "second loadTerrainPaletteLut() reuses singleton",
  lut2 === lut,
  `same=${lut2 === lut}`,
);
check(
  "getTerrainPaletteTextureSync() returns the loaded texture",
  getTerrainPaletteTextureSync() === lut.texture,
  `match=${getTerrainPaletteTextureSync() === lut.texture}`,
);

// ---- Test 4: tint-strength default is sane ----------------------------

console.log("Test 4: default tint strength");
check(
  "DEFAULT_TERRAIN_PALETTE_STRENGTH is in [0, 1]",
  DEFAULT_TERRAIN_PALETTE_STRENGTH >= 0 && DEFAULT_TERRAIN_PALETTE_STRENGTH <= 1,
  `got=${DEFAULT_TERRAIN_PALETTE_STRENGTH}`,
);
check(
  "DEFAULT_TERRAIN_PALETTE_STRENGTH preserves atlas as primary signal",
  DEFAULT_TERRAIN_PALETTE_STRENGTH > 0 && DEFAULT_TERRAIN_PALETTE_STRENGTH < 0.5,
  `got=${DEFAULT_TERRAIN_PALETTE_STRENGTH}`,
);

// ---- Test 5: shader-side bilinear blend math sanity --------------------
//
// The shader does `paletteBlend = p00*w00 + p10*w10 + p01*w01 + p11*w11`
// then `tint = mix(white, paletteBlend, strength)`; finally `result *=
// tint`. Validate that for a uniform-code cell (all four corners share
// the same terrain code), the tint reduces to mix(white, paletteFor(code),
// strength) — i.e. uniform palette across the cell.

console.log("Test 5: uniform-code cell bilinear blend");
function paletteFor(rgba, code) {
  const off = code * 4;
  return [rgba[off + 0] / 255, rgba[off + 1] / 255, rgba[off + 2] / 255];
}
function bilinearBlend(c00, c10, c01, c11, fu, fv) {
  const w00 = (1 - fu) * (1 - fv);
  const w10 = fu * (1 - fv);
  const w01 = (1 - fu) * fv;
  const w11 = fu * fv;
  return [
    c00[0] * w00 + c10[0] * w10 + c01[0] * w01 + c11[0] * w11,
    c00[1] * w00 + c10[1] * w10 + c01[1] * w01 + c11[1] * w11,
    c00[2] * w00 + c10[2] * w10 + c01[2] * w01 + c11[2] * w11,
  ];
}
for (const code of [1, 3, 15, 16, 20]) {
  const p = paletteFor(lut.rgba, code);
  // Cell fully on the same code — all four corners identical.
  const blended = bilinearBlend(p, p, p, p, 0.5, 0.5);
  const eq =
    Math.abs(blended[0] - p[0]) < 1e-6 &&
    Math.abs(blended[1] - p[1]) < 1e-6 &&
    Math.abs(blended[2] - p[2]) < 1e-6;
  check(
    `uniform-code ${code} bilinear blend = palette[${code}]`,
    eq,
    `got=[${blended.map((x) => x.toFixed(3)).join(",")}] expected=[${p.map((x) => x.toFixed(3)).join(",")}]`,
  );
}

// ---- Test 6: fetch-failure fail-silent contract ----------------------
//
// If the JSON fetch fails (file missing, HTTP error, parse error), the
// loader must resolve to `null` so the terrain shader's
// `uTerrainPaletteEnabled=0` path renders unchanged. No throws.

console.log("Test 6: fetch failure → null (fail-silent)");
_resetTerrainPaletteLutForTest();
const origFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
let threw = false;
let result = "DIDN'T-RUN";
try {
  result = await loadTerrainPaletteLut();
} catch (e) {
  threw = true;
  console.log(`    [DBG] loader threw: ${e?.message ?? e}`);
}
check("did not throw on fetch failure", !threw);
check("returned null on fetch failure", result === null, `got=${typeof result}`);
globalThis.fetch = origFetch;

// ---- Summary ----------------------------------------------------------

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
