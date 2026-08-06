// 2026-08-05 — the texture census against the REAL three r184, not a stub.
//
// WHY THIS EXISTS SEPARATELY FROM `test_texture_census.mjs`: that suite passed
// 38/38 while the byte accounting DOUBLE-CHARGED every DataTexture on the page,
// because in real three `texture.image` and `texture.source.data` are the SAME
// object and the walk visited both. A stub hierarchy cannot show you that. This
// file imports the actual r0.184.0 build — the same version `index.html:969`
// pins in its import map — and caught the bug in one run, along with the
// decision to charge the whole ArrayBuffer once rather than sum view lengths
// (BC7 mip levels are disjoint subarrays of one payload, which is pinned whole
// while any level lives).
//
// `three` resolves from `node_modules/`, which is gitignored, so a fresh clone
// SKIPS this suite rather than failing it — the skip is loud, because silently
// passing on a checkout that never ran a single assertion is worse than red.
//
// Run:
//   cd apps/holtburger-web/
//   node test_texture_census_real_three.mjs

let THREE;
try {
  THREE = await import('three');
} catch (_) {
  console.log('SKIP — no local `three` in node_modules (gitignored). This suite is the');
  console.log('       only thing that tests the census against the real class hierarchy;');
  console.log('       run `npm i three@0.184.0` in apps/holtburger-web/ to enable it.');
  process.exit(0);
}
const {
  installTextureCensus, textureCensus, textureCpuBytes, __resetTextureCensusForTests,
} = await import('./scene3d/texture_census.js');

let fail = 0;
const ck = (n, ok, d) => { console.log(`  [${ok ? 'OK' : 'FAIL'}] ${n}${d ? ' — ' + d : ''}`); if (!ok) fail++; };

ck('Texture does not define its own addEventListener (the override must shadow the inherited one)',
   !Object.prototype.hasOwnProperty.call(THREE.Texture.prototype, 'addEventListener'));
ck('EventDispatcher is where it comes from',
   typeof THREE.Texture.prototype.addEventListener === 'function');

__resetTextureCensusForTests();
ck('install on real THREE', installTextureCensus(THREE) === true);

const data = new Uint8Array(64 * 64 * 4);
const dt = new THREE.DataTexture(data, 64, 64, THREE.RGBAFormat, THREE.UnsignedByteType);
const dat = new THREE.DataArrayTexture(new Uint8Array(32 * 32 * 4 * 3), 32, 32, 3);
const payload = new Uint8Array(4096);
const ct = new THREE.CompressedTexture(
  [{ data: payload.subarray(0, 2048), width: 32, height: 32 },
   { data: payload.subarray(2048, 3072), width: 16, height: 16 }],
  32, 32, THREE.RGBA_BPTC_Format,
);
const canvasTex = new THREE.Texture({ width: 8, height: 8 }); // canvas-shaped: no .data

// What WebGLTextures does at first upload (three.module.js:11711).
for (const t of [dt, dat, ct, canvasTex]) t.addEventListener('dispose', () => {});

ck('DataTexture bytes come from image.data', textureCpuBytes(dt, null) === 64 * 64 * 4,
   String(textureCpuBytes(dt, null)));
ck('DataArrayTexture bytes are the whole layered array', textureCpuBytes(dat, null) === 32 * 32 * 4 * 3,
   String(textureCpuBytes(dat, null)));
// 4096, not the 3072 of summed view lengths: the two mip levels are subarrays
// of ONE 4096-byte payload, and that whole buffer stays pinned while either
// view lives. Charging view lengths would under-report the real retention.
ck('CompressedTexture bytes come from mipmaps and charge the pinned buffer',
   textureCpuBytes(ct, null) === 4096, String(textureCpuBytes(ct, null)));
ck('a canvas-shaped texture charges 0', textureCpuBytes(canvasTex, null) === 0);

// Mip levels that are subarrays of ONE payload must be charged once across a walk.
const seen = new Set();
const shared = textureCpuBytes(ct, seen);
ck('subarray mip levels charge the whole pinned payload, once', shared === payload.byteLength,
   `${shared} vs payload ${payload.byteLength}`);

const scene = new THREE.Scene();
const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: dt }));
scene.add(mesh);
const c = textureCensus(scene);
ck('all four traced through the real hierarchy', c.traced === 4, `traced=${c.traced}`);
ck('the in-scene one is reachable', c.reachable === 1, `reachable=${c.reachable}`);
ck('the other three are orphans', c.orphanedAlive === 3, `orphans=${c.orphanedAlive}`);
ck('canvas-backed counted separately', c.canvasBackedOrEmpty === 1, String(c.canvasBackedOrEmpty));
ck('shader-uniform textures are walked too', (() => {
  const sm = new THREE.ShaderMaterial({ uniforms: { uMap: { value: dat } }, vertexShader: 'void main(){}', fragmentShader: 'void main(){}' });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sm));
  return textureCensus(scene).reachable === 2;
})());

// The real dispose path must still work through the wrapper.
let disposeFired = 0;
dt.addEventListener('dispose', () => disposeFired++);
dt.dispose();
ck('dispose still dispatches three\'s own event', disposeFired === 1);
ck('disposeCalls counted', textureCensus(scene).disposeCalls === 1);

// The needsUpdate setter must be the PRIMARY trace point, or every origin in
// the report names the render loop instead of the creating call site.
__resetTextureCensusForTests();
installTextureCensus(THREE);
function makeItHere() {
  const t = new THREE.DataTexture(new Uint8Array(16), 2, 2, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;   // what every creation site in the app does
  return t;
}
const made = makeItHere();
const c2 = textureCensus({ traverse(fn) { fn({}); } });
ck('needsUpdate traces at CREATION', c2.traced === 1, `traced=${c2.traced}`);
const org = Object.keys(c2.byOrigin)[0] || '';
ck('...and the origin names the creating file, not the render loop',
   /test_texture_census_real_three\.mjs:\d+/.test(org), org);
ck('version still increments through the wrapped setter', made.version === 1, String(made.version));

console.log(fail === 0 ? '\nreal-three: PASS' : `\nreal-three: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
