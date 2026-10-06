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

import { readFileSync } from "node:fs";
import { stripExports } from "./splice_module.mjs";

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
  // ./bc7_textures.js — CTX-LOSS-MIRRORS lane-T fetch-miss counter (imported
  // as `noteFullTierFetchMiss as _noteFullFetchMiss`); only reachable with
  // texCompressedOnly active, and the real one only bumps a stats counter.
  _noteFullFetchMiss: "() => {}",
  // ./bc7_textures.js — RSID-MARKER. Called on EVERY surface-backed material
  // build (flag-independent), so this mirrors the real stamp exactly (minus
  // the module-private stats bump): a suite reading `userData.__texRsId`
  // sees the production value.
  stampRsId: "(mat, rsId) => { const rs = rsId >>> 0; if (!mat || !rs) return 0; const ud = (mat.userData = mat.userData || {}); ud.__texRsId = rs; return rs; }",
  // ./bc7_textures.js — T15R rehydrate-v3 mirror seam. Only the ST5 upgrade
  // arms one and only the demote/evict paths unregister, so both are
  // unreachable with the flag off; the return values match the real
  // functions' "nothing to do" answers.
  registerFullTierMirror: "() => false",
  unregisterFullTierMirror: "() => false",
  // ./xu7_textures.js — ST5 lane-T transcode entry; unreachable flag-OFF.
  transcodeXu7WithNra: "async () => null",
  // ./bandwidth_tier.js — `?bandwidth` (2026-10-06). "Not a low session" is
  // the default arm (fast link / no measurement), so the statics full-tier
  // upgrade veto never fires and every suite sees today's behaviour.
  lowBandwidth: "() => false",
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

/**
 * Stubs for the imported symbols `scene3d/entities.js` CALLS AT MODULE TOP
 * LEVEL (a `const X = reader();` at file scope). Every other entities.js
 * import is only referenced inside method bodies, so a splice that never
 * reaches those methods needs no stub for it; these four are evaluated the
 * moment the spliced body runs and throw a bare ReferenceError without one.
 *
 * Measured 2026-10-05 by loading adapter+animation+entities with only these
 * names defined. Values are each reader's own answer when `window` is absent /
 * carries no query flag — which is exactly what the Node harness has:
 *   - readSelectionIndicatorMode  (selection_brackets.js) → "brackets"
 *   - limbDamageEnabled / ragdollEnabled (limbs.js / ragdoll.js) → false
 *     (both readers return false with no window.location; the browser
 *     default-ON arms need limbs.js/ragdoll.js, which no suite splices)
 *   - readRigModuleFlag (setup_rig.js) → false
 */
export const ENTITIES_JS_TOPLEVEL_STUBS = Object.freeze({
  readSelectionIndicatorMode: '() => "brackets"',
  limbDamageEnabled: "() => false",
  ragdollEnabled: "() => false",
  readRigModuleFlag: "() => false",
});

/**
 * `const X = ...;` prelude for {@link ENTITIES_JS_TOPLEVEL_STUBS}, skipping any
 * name in `except` (a suite that already declares its own shim for one).
 */
export function entitiesToplevelPrelude(except = []) {
  return Object.entries(ENTITIES_JS_TOPLEVEL_STUBS)
    .filter(([n]) => !except.includes(n))
    .map(([n, init]) => `const ${n} = ${init};`)
    .join("\n") + "\n";
}

/**
 * Source to splice so `new EntityManager(...)` can be constructed: its
 * constructor calls `createPreCreateBuffer()` (./pre_create_buffer.js, a pure
 * dependency-free module). Rather than a stub, the GENUINE module is inlined —
 * the A8-M4 pre-create buffer is part of the spawn path these suites drive.
 * Measured 2026-10-05: it is the only import the constructor touches.
 */
export function entitiesCtorPrelude() {
  const src = readFileSync(new URL("../../scene3d/pre_create_buffer.js", import.meta.url), "utf8");
  return "// === pre_create_buffer.js (genuine) ===\n" + stripExports(src) + "\n";
}
