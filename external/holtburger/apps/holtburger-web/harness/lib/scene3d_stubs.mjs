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
  // ./bc7_textures.js — CLIP-ALPHA guard (2026-10-07). Only reached past the
  // `bc7Available()` gate above, which is false here; `null` is the real
  // "nothing to protect" answer.
  bc7ClipAlphaGateFor: "() => null",
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
  // ./luminous_night.js — `?lumNight` registration (2026-10-07). "Not
  // tracked" = false, and the real function only writes `userData.hbLumBase`
  // plus (at night) a scaled `emissiveIntensity`, so a spliced suite sees the
  // un-dimmed noon value it always asserted.
  registerLuminousMaterial: "() => false",
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
// 2026-10-08 (moveto-4 follow-up): entities.js reads `remoteMoveToPhaseEnabled()`
// at module load (`REMOTE_MOVETO_PHASE_ON`). The module is pure, so each name
// is the GENUINE export of an inlined copy (an IIFE expression, so a suite that
// splices both preludes gets each name exactly once).
const genuineRemoteMoveToPhase = (name) =>
  "(() => {\n" +
  stripExports(readFileSync(new URL("../../scene3d/remote_moveto_phase.js", import.meta.url), "utf8")) +
  `\nreturn ${name};\n})()`;

export const ENTITIES_JS_TOPLEVEL_STUBS = Object.freeze({
  readSelectionIndicatorMode: '() => "brackets"',
  limbDamageEnabled: "() => false",
  ragdollEnabled: "() => false",
  readRigModuleFlag: "() => false",
  remoteMoveToPhaseEnabled: genuineRemoteMoveToPhase("remoteMoveToPhaseEnabled"),
  planRemoteMoveToPhase: genuineRemoteMoveToPhase("planRemoteMoveToPhase"),
  remoteMoveToHintReapply: genuineRemoteMoveToPhase("remoteMoveToHintReapply"),
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
 * constructor calls `createPreCreateBuffer()` (./pre_create_buffer.js) and,
 * since 2026-10-06, `partDegradeEnabled()` / `new PartDegrade()`
 * (./part_degrade.js; `tick` reads PART_DEGRADE_INTERVAL_S) and
 * `linkMissIsDefect` (./motion_link_diag.js, `_tryPlayLink`). All pure,
 * dependency-free modules, so the GENUINE sources are inlined rather than
 * stubbed — they are part of the spawn / tick paths these suites drive.
 */
export function entitiesCtorPrelude() {
  const pcb = readFileSync(new URL("../../scene3d/pre_create_buffer.js", import.meta.url), "utf8");
  const pd = readFileSync(new URL("../../scene3d/part_degrade.js", import.meta.url), "utf8");
  const mld = readFileSync(new URL("../../scene3d/motion_link_diag.js", import.meta.url), "utf8");
  // Bugs 2/15/18 (2026-10-07): `fullMotionCommand` (setMotion's canonical
  // full-command boundary). Pure; wrapped so its private tables cannot
  // collide with entities.js top-level names.
  const mcf = readFileSync(new URL("../../scene3d/motion/motion_command_full.js", import.meta.url), "utf8");
  // 2026-10-08: the playhead hook-timing helpers (`_fireHook`'s direction
  // gate, `_drainUnifiedHooks`, animation.js's frame-exit retime) and the
  // one-shot hand-back (`tick`). Pure; wrapped like fullMotionCommand.
  const hw = readFileSync(new URL("../../scene3d/hook_windows.js", import.meta.url), "utf8");
  const hb = readFileSync(new URL("../../scene3d/motion/handback.js", import.meta.url), "utf8");
  const hwNames = "unifiedHookTime, drainHookWindows, framesCrossedBackward, hookFiresInDirection, retimeHooksToFrameExit";
  return "// === pre_create_buffer.js (genuine) ===\n" + stripExports(pcb) + "\n" +
    "// === part_degrade.js (genuine) ===\n" + stripExports(pd) + "\n" +
    "// === motion_link_diag.js (genuine) ===\n" + stripExports(mld) + "\n" +
    "// === motion/motion_command_full.js (genuine) ===\n" +
    "const fullMotionCommand = (() => {\n" + stripExports(mcf) + "\nreturn fullMotionCommand;\n})();\n" +
    "// === hook_windows.js + motion/handback.js (genuine) ===\n" +
    `const { ${hwNames} } = (() => {\n` + stripExports(hw) + `\nreturn { ${hwNames} };\n})();\n` +
    "const { oneShotSpill, handBackToCycle } = (() => {\n" + stripExports(hb) +
    "\nreturn { oneShotSpill, handBackToCycle };\n})();\n" +
    // 2026-10-07 — terrain rounding step 3 (./visual_ground.js): the
    // EntityInstance constructor calls installVisualGroundRoot and `tick`
    // calls visualGroundBeginFrame. Not inlined (it imports terrain_round /
    // terrain_oracle / frame_pose); stubbed to the real answers in a spliced
    // suite: no terrain bake has published a drawn fillet, so every rig's
    // offset is 0 and nothing reads the per-frame snapshot (its own suite,
    // test_visual_ground.mjs, drives the genuine module).
    "// === visual_ground.js (inert: no drawn fillet) ===\n" +
    "const installVisualGroundRoot = () => false;\nconst visualGroundBeginFrame = () => {};\n";
}
