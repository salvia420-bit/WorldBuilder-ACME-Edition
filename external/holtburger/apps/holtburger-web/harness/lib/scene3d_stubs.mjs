// harness/lib/scene3d_stubs.mjs — explicit stubs for scene3d modules spliced
// into `new Function()` by the headless suites.
//
// One shared map instead of a per-suite hand-list: the 2026-08-03 review (F2)
// found four suites broken because `scene3d/materials.js` grew imports their
// private strippers/stubs never learned about. Centralising means the next
// import is fixed in one place, and `spliceModule()` fails loudly naming the
// symbol rather than dying inside `new Function` with a bare SyntaxError.
//
// Values are DELIBERATELY narrow (typed no-ops returning the inert value), not
// a permissive catch-all proxy: a truthy catch-all silently makes any
// assertion that touches it unfalsifiable.

/** Stubs for every module `scene3d/materials.js` statically imports. */
export const MATERIALS_JS_STUBS = Object.freeze({
  // ./adapter.js — pixel→texture uploads. Suites that need a real texture
  // override these; the default is "no texture produced".
  surfacePixelsToTexture: "() => null",
  surfacePixelsToNormalTexture: "() => null",
  surfacePixelsToHeightTexture: "() => null",
  surfacePixelsToRoughnessTexture: "() => null",
  surfacePixelsToAoTexture: "() => null",
  // ./vfx_flags.js
  aoMapIntensityValue: "() => 0.6",
  materialBakeEnabled: "() => false",
  // ./quality.js
  getQuality: "() => null",
  // ./suite_assets.js
  SuiteAssetSource: "class {}",
  loadTexchanManifest: "() => null",
  // ./adapter.js — ST5: module-wide aniso preset (1 = three's stock value,
  // what an uninitialised adapter returns).
  getAdapterMaxAnisotropy: "() => 1",
  // ./bc7_textures.js — inert unless ?texBc7=on AND the GPU reports BPTC.
  bc7Available: "() => false",
  bc7TextureBytes: "() => 0",
  upgradeMaterialToBc7: "() => false",
  // ./bc7_textures.js — ST5 (`?texCompressedOnly`): inactive is the default
  // arm (flag OFF), so the compressed-only branch never fires and the
  // remaining symbols are unreachable-but-declared (explicit inert stubs,
  // not a proxy, per this file's rule).
  texCompressedOnlyActive: "() => false",
  texCompressedOnlyNs: "() => ({ wasmNs: null, controller: null })",
  parseHbc7: "() => { throw new Error('stub parseHbc7 called with texCompressedOnly inactive'); }",
  makeBc7Texture: "() => { throw new Error('stub makeBc7Texture called with texCompressedOnly inactive'); }",
  bc7Source: "() => null",
  _bumpBc7Stat: "() => {}",
  atlasRefeed: "() => 0",
  // ./xu7_textures.js — ST5 lane-T transcode entry; unreachable flag-OFF.
  transcodeXu7WithNra: "async () => null",
  // ./texture_release.js — `?texFreeCpu` CPU-side release arming. Returns
  // false = "not armed", which is also what the real function returns with the
  // flag off, so no suite's assertions change shape. The one call site is
  // inside `_finishSurface`; nothing reads the return.
  armCpuRelease: "() => false",
  // ./surface_planes.js — the plane TAGS (`armCpuRelease`'s second argument).
  // Real string values, not sentinels: a suite that ever asserts on the tag
  // should see the production string.
  PLANE: '{ ALBEDO: "albedo", NORMAL: "normal", HEIGHT: "height", ROUGHNESS: "roughness", AO: "ao" }',
});
