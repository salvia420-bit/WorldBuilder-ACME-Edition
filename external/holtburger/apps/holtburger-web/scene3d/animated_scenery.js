// Task #7 (2026-06-23) — true mesh-animated scenery (flags / banners / animated
// foliage / windmills).
//
// Distinct from the sky-bird / butterfly Swarm work: these are SCENERY
// SetupModels whose `default_animation` (0x03 Animation) is a per-part KEYFRAME
// clip. Retail's `CPhysicsObj::InitDefaults` flags `HasDefaultAnim` for static
// objects with a non-zero DefaultAnimation and plays it every frame
// (`PartArray.Update`, ace-server PhysicsObj.cs:686 + :2031). The static bake
// renders these FROZEN (merged per-surface instanced geometry, no per-part
// nodes), so flags never wave. Common: 0x02000493 (~92k placements) →
// 0x030006cb (2 parts × 90 frames), 0x02000494 → 0x030006ca, 0x020005AC →
// 0x03000751.
//
// === INSTANCED model (perf refinement, 2026-06-23) ===
// Every placement of the same animation DID waves IDENTICALLY in object space —
// only the whole-node WORLD transform differs. So we keep ONE shared mixer +
// clip + "template" (a non-rendered Group of part subgroups) per animation DID,
// advance it ONCE per frame, and COPY the template's per-part local transforms
// onto each (near, live) instance node. That collapses N AnimationMixer.update
// calls down to (unique animation DIDs) — a handful — while each instance still
// gets its own per-part meshes at its own world transform.
//
// Per-part meshes + rest hinge frames come from `fetchBuildingPlacement`; the
// keyframes from `fetchAnimation`. AC Z-up object space (see statics.js anchors),
// so part AFrames apply with no handedness conversion. The part meshes arrive
// with their static frame BAKED in, and an AFrame is absolute in setup space,
// so each part draws as A(t) * inverse(bakeFrame) — see `?animSceneryUnbake`
// (2026-10-23: the doubled frame tore the windmill's sails off the hub).
//
// **`?animScenery` default-ON (`?animScenery=off` escape).** Outdoor placements anchor to
// `scene3d.staticsGroup`; interior (EnvCell) placements pass `worldFrame:true`
// items + an `opts.resolveParent` so the node parents to its cell container
// (inheriting the cell's enter-to-show visibility gate). Eviction is handled by
// the EXISTING LRU (outdoor: removes staticsGroup children by userData.landblockId;
// interior: removes the cell container) — the rAF then detects orphaned nodes
// (top ancestor is no longer the live Scene) and reclaims their instance slot.
// `?animSceneryFps` rate, `?animSceneryMax` build cap, `?animSceneryRadius`
// distance tick-cull.

import * as THREE from "three";
import { meshToGeometryGroups, acToThree } from "./adapter.js";
// T13 (ST3, `?geomBundles`): decode-once via the HBG1 bundle when armed.
import { geomBundlesActive, assembleModels as assembleGeomBundles, bundleToPartGroups, countGeomFallback } from "./geom_bundles.js";
import { surfacePixelsFetcher } from "./bake_worker_client.js";
import { treeWindEnabled, treeWindStrength, treeWindDir, windBakeEnabled } from "./tree_wind.js";
import { buildBboxRig, partBBox, hash01 } from "./wind_rig.js";
// P4.3 fetch-not-synthesize flip (?windBake=on, DEFAULT-OFF). Imported eagerly but
// the SuiteAssetSource is constructed LAZILY and ONLY under windBakeEnabled(), so the
// off-trace never touches suite_assets.js (zero fetch / zero cache mutation — [R]).
import { SuiteAssetSource, ensureSuiteInit } from "./suite_assets.js";
// VFX (Visual-Behavior Suite): the live tree-wind runtime now generates its
// clip through the deformation.windBend component (byte-identical wrapper over
// buildTreeWindClip). archetype #1's MECH-A consumer.
import { windBend } from "./vfx/components/windBend.js";
import { visualEnabled } from "./vfx_catalog.js";
// ?canopySoften (2026-10-07): crown-radial normals for animated foliage parts.
import { softenCanopyGroups } from "./canopy_soften.js";
// ?animSceneryGpu (2026-10-17): the instanced pose is composed in the vertex shader.
import {
  animSceneryGpuEnabled, animInstMaterialFor, poseRowFor, poseRows, writePoseRow,
  flushPoseTable, syncAnimInstMaterials, animSceneryGpuDiag, disposeAnimSceneryGpu, posedMatrixFromRow,
  copyPoseRowFrom,
} from "./anim_scenery_gpu.js";
// ?rustAnimScenery (2026-10-26, DEFAULT ON since 2026-10-26; `=off` escape) — the per-DID
// template pose (mixer step, SetOmega orbit, GPU pose rows) in ONE wasm call
// per frame. Bridge + rationale: scene3d/rust/anim_scenery.js,
// docs/2026-10-26-rust-anim-terrain.md.
import {
  rustAnimSceneryEnabled, rustAnimRegisterGroup, rustAnimUnregisterGroup, rustAnimAdvance,
  rustAnimWriteBack, rustAnimRowWritten, rustAnimRows, rustAnimRowsOk, rustAnimMixerTime,
  rustAnimFallback, rustAnimReset, rustAnimSceneryStats, ANIM_ROW_FLOATS,
} from "./rust/anim_scenery.js";
import { rustFlag } from "./rust/scene_core.js";

const METERS_PER_LANDBLOCK = 192.0;
const DEFAULT_ANIM_FPS = 30.0;
// Bumped 2026-06-26 (user): animate far MORE trees. Nearest-to-player build order (below) means a
// hit cap only drops the FARTHEST trees, and the per-frame work is a transform memcpy bounded by the
// cap, so a big cap + wide cull stays cheap. Both still URL-tunable (?animSceneryMax / ?animSceneryRadius).
const DEFAULT_MAX_ANIMATED = 4096;   // was 512
const DEFAULT_TICK_RADIUS_M = 800.0; // was 140 — distant swaying trees are desirable, not "imperceptible"
function _numFlag(name, def, min) {
  try {
    if (typeof window !== "undefined" && window.location) {
      const v = new URLSearchParams(window.location.search).get(name);
      const n = v == null ? NaN : parseFloat(v);
      if (Number.isFinite(n) && n >= (min ?? 0)) return n;
    }
  } catch (_) { /* default */ }
  return def;
}
let _maxAnimated;
function maxAnimated() {
  if (_maxAnimated === undefined) _maxAnimated = _numFlag("animSceneryMax", DEFAULT_MAX_ANIMATED, 1);
  return _maxAnimated;
}
let _tickRadiusSq;
function tickRadiusSq() {
  if (_tickRadiusSq === undefined) {
    const r = _numFlag("animSceneryRadius", DEFAULT_TICK_RADIUS_M, 0);
    _tickRadiusSq = r > 0 ? r * r : Infinity; // 0 → no cull (tick all)
  }
  return _tickRadiusSq;
}

let _animSceneryFlag;
export function animSceneryEnabled() {
  if (_animSceneryFlag !== undefined) return _animSceneryFlag;
  let on = true; // default-ON (2026-06-23 user directive); ?animScenery=off escape.
  try {
    if (typeof window !== "undefined" && window.location) {
      on = new URLSearchParams(window.location.search)
        .get("animScenery")?.toLowerCase() !== "off";
    }
  } catch (_) { on = true; }
  _animSceneryFlag = on;
  return on;
}

let _animSceneryFps;
function animSceneryFps() {
  if (_animSceneryFps !== undefined) return _animSceneryFps;
  let fps = DEFAULT_ANIM_FPS;
  try {
    if (typeof window !== "undefined" && window.location) {
      const v = new URLSearchParams(window.location.search).get("animSceneryFps");
      const n = v == null ? NaN : parseFloat(v);
      if (Number.isFinite(n) && n > 0) fps = n;
    }
  } catch (_) { /* default */ }
  _animSceneryFps = fps;
  return fps;
}

// ?animSceneryOmega (2026-10-08, DEFAULT ON; `=off` escape) — the retail
// SetOmega ORBIT of the ambient critters. All 8 retail DefaultAnimations that
// carry a SetOmega hook are the flying ambients — butterflies 0x02000493/494
// (~182k placements), seagulls 0x020005AC (~24k), birds 0x020005A9 (~23k),
// 0x020009B3, the insect cloud 0x020004B0 (+ 0x02000490/491). Their parts sit
// 3-36 m off the object origin and the clip only flaps/bobs them; the FLYING
// comes from the frame-0 SetOmega hook: retail stores the axis as
// m_omegaVector (SetOmegaHook::Execute -> CPhysicsObj::set_omega,
// acclient.c:342548 / :316613) and `animate_static_object` grotates the whole
// object by it once per update, NO quantum multiply (acclient.c:321150), with
// updates gated to >= MIN_QUANTUM = 1/30 s (:321170, :784229). The authored
// axes are per-TICK angles (0.535 to 2.2 deg; as rad/s they would be a 3-11
// minute circle), so the orbit is integrated at that 30 Hz reference (OpenAC's
// RetailStaticAnimatingObjectScheduler does the same): a seagull circles its
// 12 m ring in ~5.5 s. Without it every critter hovered in place beating its
// wings at the (correct, 30 fps) clip rate — a stationary bird flapping 4.3 Hz.
//
// 2026-10-08 (owner on the 1070, once the orbit landed: "orbit too fast") —
// the per-tick angle is retail's, but the rate is not fixed in retail: the
// static-animation update runs at most every MIN_QUANTUM (the 30 Hz above) and
// in practice at the client's own update rate, often lower. At the 30 Hz
// ceiling a seagull laps its 12 m ring in 5.5 s (~14 m/s). Default 15 Hz:
// ~11 s a lap (~7 m/s, a soaring gull), butterflies ~1.2 m/s.
// `?animSceneryOmegaHz=<1..60>` tunes it; `window.__animSceneryOmegaHz(v)` live.
export const ANIM_SCENERY_OMEGA_HZ_DEFAULT = 15;
let _omegaHz;
export function animSceneryOmegaHz() {
  if (_omegaHz !== undefined) return _omegaHz;
  let hz = ANIM_SCENERY_OMEGA_HZ_DEFAULT;
  try {
    if (typeof window !== "undefined" && window.location) {
      const v = Number(new URLSearchParams(window.location.search).get("animSceneryOmegaHz"));
      if (Number.isFinite(v) && v > 0) hz = Math.min(60, Math.max(1, v));
    }
  } catch (_) { /* default */ }
  _omegaHz = hz;
  return hz;
}
/** Test seam / live A/B: a number sets the rate (clamped), undefined re-reads the URL. */
export function __setAnimSceneryOmegaHzForTest(v) {
  _omegaHz = v === undefined ? undefined : Math.min(60, Math.max(1, Number(v) || ANIM_SCENERY_OMEGA_HZ_DEFAULT));
}
if (typeof window !== "undefined") {
  window.__animSceneryOmegaHz = (v) => { if (v !== undefined) __setAnimSceneryOmegaHzForTest(v); return animSceneryOmegaHz(); };
}
let _omegaFlag;
export function animSceneryOmegaEnabled() {
  if (_omegaFlag !== undefined) return _omegaFlag;
  let on = true;
  try {
    if (typeof window !== "undefined" && window.location) {
      const v = new URLSearchParams(window.location.search).get("animSceneryOmega")?.toLowerCase();
      if (v != null) on = !(v === "off" || v === "0" || v === "false" || v === "no");
    }
  } catch (_) { on = true; }
  _omegaFlag = on;
  return on;
}
/** Test seam: true/false arms/disarms, undefined re-reads the URL. */
export function __setAnimSceneryOmegaForTest(v) { _omegaFlag = v; }

/**
 * Parse a fetchAnimation `setOmega` getter value into `{ axis, rad }` (unit
 * axis + radians per retail tick), or null when absent / below retail
 * grotate's 2e-4 threshold (Frame::grotate, acclient.c:357422). Pure.
 */
export function parseSetOmega(om) {
  if (!om || om.length !== 3) return null;
  const x = +om[0], y = +om[1], z = +om[2];
  const rad = Math.hypot(x, y, z);
  if (!(rad >= 0.0002)) return null;
  return { axis: new THREE.Vector3(x / rad, y / rad, z / rad), rad };
}

/** Retail static-object orbit advance (radians) for `dt` wall seconds. Pure. */
export function staticOmegaAngleStep(omega, dt) {
  return omega && dt > 0 ? omega.rad * animSceneryOmegaHz() * dt : 0;
}

// ?animSceneryInstanced (default-ON — 2026-07-02 1070 eye-test + A/B; ?animSceneryInstanced=off
// escape restores the per-mesh legacy path) — collapse per-placement part Meshes into one
// InstancedMesh per (setupId, part, surface group). 2026-07-02 GTX-1070 A/B (quality=low
// forest, cap 4096): legacy 8.5 fps / ~1,620 calls → instanced 18-20 fps / ~750 calls with
// ALL 4,096 trees animated in 6 draws (beats even ?animScenery=off at 17 fps — the build
// also deletes per-instance geometry clones and the per-frame Group transform walk).
let _instancedFlag;
export function animSceneryInstancedEnabled() {
  if (_instancedFlag !== undefined) return _instancedFlag;
  let on = true;
  try {
    if (typeof window !== "undefined" && window.location) {
      const v = new URLSearchParams(window.location.search).get("animSceneryInstanced")?.toLowerCase();
      if (v != null) on = !(v === "off" || v === "0" || v === "false" || v === "no");
    }
  } catch (_) { on = true; }
  _instancedFlag = on;
  return on;
}

// ?animSceneryBucketVis (2026-10-17, DEFAULT ON; `=off` escape) — the
// instanced buckets own their `visible`, and the statics cull leaves them be.
//
// THE BUG. Bucket meshes are direct staticsGroup children, so statics.js
// `cullStaticsGroup` frustum-tested them like any instanced static — with the
// cull sphere it CACHES FOREVER on first sight (`userData._cullSphere`, from
// `computeBoundingSphere()` over the instances registered at that moment).
// A bucket grows with every landblock the player visits, so the cached sphere
// covers only the first few placements: live on the 1070 (2026-10-17) all 27
// buckets were `visible:false`, their spheres ~35 km from the player at LB
// 0xE632 — every butterfly, seagull, bird and insect cloud invisible, still
// posed every frame. Buckets are `frustumCulled=false` precisely because their
// instances are scattered (see the header above). Now the cull skips them and
// this module shows a bucket while it has at least one live (non-collapsed)
// instance — an all-collapsed bucket draws only degenerate slots, so hiding it
// is pixel-identical. `=off` restores the statics-cull behaviour.
let _bucketVisFlag;
export function animSceneryBucketVisEnabled() {
  if (_bucketVisFlag !== undefined) return _bucketVisFlag;
  let on = true;
  try {
    if (typeof window !== "undefined" && window.location) {
      const v = new URLSearchParams(window.location.search).get("animSceneryBucketVis")?.toLowerCase();
      if (v != null) on = !(v === "off" || v === "0" || v === "false" || v === "no");
    }
  } catch (_) { on = true; }
  _bucketVisFlag = on;
  return on;
}
/** Test seam: true/false forces, undefined re-reads the URL. */
export function __setAnimSceneryBucketVisForTest(v) { _bucketVisFlag = v; }

// ?animSceneryUnbake (2026-10-23, DEFAULT ON — BUG FIX, changes what is drawn;
// `off`/`0`/`false`/`no` escape) — undo the rest frame the wasm BAKED into each
// part's vertices before the clip's part frame is applied.
//
// THE BUG (owner on the 1070, 2026-10-23, landblock 0x8093 at 16.0N 0.8E: the
// windmill's four sail boards float detached at odd angles round the tower).
// fetchBuildingPlacement (lib.rs triangulate_setup_model_per_part) and the HBG1
// bundle (geom_bundles.js bundleToPartGroups) both hand back part geometry with
// the part's static frame already baked in (idle-anim frame, else the placement
// chain) — right for buildings and doors. A DAT Animation part frame is ABSOLUTE
// in setup space and REPLACES that frame: retail CPartArray::UpdateParts
// (acclient.c:326601) sets part = Frame::combine(objectFrame, animFrame[i]) over
// part-LOCAL GfxObj vertices. Every path here composed the clip frame ON TOP of
// the baked one (object * A(t) * B * v), i.e. the part frame applied twice.
// Windmill sails 0x020003E5 (anim 0x0300061B: 60 frames, 1.5 deg about the hub
// axis per frame): the sails' Default frames are R_y(-90/0/+90/180) about 5.35 m
// out; doubled, all four boards share ONE orientation (parallel) and their
// centres land 0 / 7.6 / 7.6 / 10.7 m from the hub — the owner's still. Every
// DID with an off-origin part was hit: the same arithmetic on a seagull's
// Default frames (0x020005AC, both parts at (0,-12,15), 94 / 157 deg) puts its
// two parts ~25 m apart.
// THE FIX: per part, U = inverse(bake frame) right-multiplies the clip pose:
// object * A(t) * U * (B * v) = object * A(t) * v. B, best source first:
//   1. wasm `fetchSetupPartPose` — the exact frame walk_setup_parts baked
//      (idle anim frame -> static placement chain). NOT on index.html's
//      wasmExports bag today (2026-10-23), so live skips it;
//   2. frame 0 of the placement's default animation (`fetchAnimation(animId)`)
//      — THE LIVE SOURCE. walk_setup_parts' idle frame
//      (lib.rs try_resolve_idle_anim_frame_with_override) is the MotionTable
//      idle anim's frame 0, else — path 2 — `setup.default_animation`'s frame
//      0, and every anim-scenery placement HAS a default animation (that is
//      what `defaultAnimationId` is), so with no MotionTable its animated parts
//      are baked in exactly this frame, never in a placement. (Verifier
//      2026-10-24: undoing the Default placement instead left the butterflies
//      0x02000493 — anim 0x030006CB frame 0 sits 8.6 m / 180 deg from Default
//      — drawn with their two wings up to ~17 m apart; seagull wings 26 deg
//      off.) Wrong only for a setup with a MotionTable idle cycle;
//   3. wasm `fetchSetupPlacementFrames(setup, 0x65)` — the retail static chain
//      0x65 Resting -> 0 -> first (skipped under `placementId=off`);
//   4. the hinge frame (placement 0 -> 1 -> first).
// Parts past the clip's part count never move, so their U only has to be
// consistent (every path seeds them B * U = identity). Identity bake frames get
// U = null and are untouched (byte-identical rows/slots). Before the first tick
// a part shows B * U = identity on the baked mesh = its static rest pose.
// `=off` restores the doubled composition (A/B only).
let _unbakeFlag;
export function animSceneryUnbakeEnabled() {
  if (_unbakeFlag !== undefined) return _unbakeFlag;
  let on = true;
  try {
    if (typeof window !== "undefined" && window.location) {
      const v = new URLSearchParams(window.location.search).get("animSceneryUnbake")?.toLowerCase();
      if (v != null) on = !(v === "off" || v === "0" || v === "false" || v === "no");
    }
  } catch (_) { on = true; }
  _unbakeFlag = on;
  return on;
}
/** Test seam: true/false forces, undefined re-reads the URL. */
export function __setAnimSceneryUnbakeForTest(v) { _unbakeFlag = v; }

const _unbakeStats = { setups: 0, parts: 0, fromPose: 0, fromHinge: 0, poseSource: { partPose: 0, anim0: 0, placement65: 0, none: 0 } };
const _unbakeRestScratch = new THREE.Matrix4();
const _unbakeScaleScratch = new THREE.Vector3();

/** The wasm bake's static placement chain is the retail one (0x65 -> 0 -> first)
 *  unless `placementId=off` (lib.rs parse_placement_id_flag: only that exact
 *  spelling disables it). Read per call: build-time only. */
function _placementChainRetail() {
  try {
    if (typeof window !== "undefined" && window.location) {
      return new URLSearchParams(window.location.search).get("placementId") !== "off";
    }
  } catch (_) { /* default */ }
  return true;
}

/** setupId -> Promise<Float32Array|null> (7 floats per part: ox oy oz qw qx qy qz).
 *  Keyed by setup alone: `animId` is always the setup's own default_animation
 *  (every lib.rs defaultAnimationId producer reads `setup.default_animation`). */
const _bakePoseCache = new Map();
function _fetchBakePose(setupId, wasmExports, animId) {
  if (!animSceneryUnbakeEnabled()) return Promise.resolve(null);
  const hasPose = typeof wasmExports?.fetchSetupPartPose === "function";
  const aid = (animId >>> 0) || 0;
  const hasAnim = aid !== 0 && typeof wasmExports?.fetchAnimation === "function";
  const hasPlacement = typeof wasmExports?.fetchSetupPlacementFrames === "function" && _placementChainRetail();
  if (!hasPose && !hasAnim && !hasPlacement) return Promise.resolve(null);
  let p = _bakePoseCache.get(setupId);
  if (p) return p;
  p = (async () => {
    if (hasPose) {
      try {
        const a = await wasmExports.fetchSetupPartPose(setupId);
        if (a && a.length > 0 && a.length % 7 === 0) {
          _unbakeStats.poseSource.partPose += 1;
          return Float32Array.from(a);
        }
      } catch (_) { /* next source */ }
    }
    if (hasAnim) {
      // Frame 0 of the default animation = walk_setup_parts' idle frame for a
      // setup without a MotionTable (lib.rs try_resolve_idle_anim_frame_with_override
      // path 2). Frame-major layout, 7 floats per part (fetchAnimation).
      try {
        const a = await wasmExports.fetchAnimation(aid);
        const np = a?.numParts | 0;
        const fr = a?.frames; // read BEFORE free()
        try { a?.free?.(); } catch (_) {}
        if (np > 0 && fr && fr.length >= np * 7) {
          const out = new Float32Array(np * 7);
          for (let k = 0; k < np * 7; k++) out[k] = fr[k];
          _unbakeStats.poseSource.anim0 += 1;
          return out;
        }
      } catch (_) { /* next source */ }
    }
    if (hasPlacement) {
      try {
        const r = await wasmExports.fetchSetupPlacementFrames(setupId, 0x65);
        const frames = (typeof r?.takeFrames === "function" ? r.takeFrames() : null) || [];
        try { r?.free?.(); } catch (_) {}
        if (frames.length > 0) {
          const out = new Float32Array(frames.length * 7);
          for (let i = 0; i < frames.length; i++) {
            const f = frames[i];
            out.set([f.ox, f.oy, f.oz, f.qw, f.qx, f.qy, f.qz], i * 7);
            try { f.free?.(); } catch (_) {}
          }
          _unbakeStats.poseSource.placement65 += 1;
          return out;
        }
      } catch (_) { /* hinge fallback */ }
    }
    _unbakeStats.poseSource.none += 1;
    return null;
  })();
  _bakePoseCache.set(setupId, p);
  return p;
}
/** Test seam: the bake-frame source chain (cached per setup until dispose). */
export function __fetchBakePoseForTest(setupId, wasmExports, animId) {
  return _fetchBakePose(setupId >>> 0, wasmExports, animId);
}

/**
 * The matrix taking part `i`'s BAKED vertices back to part-local space — the
 * inverse of the frame baked into them — or null when that frame is identity
 * (nothing to undo) or `?animSceneryUnbake=off`. `bakePose`: 7 floats per
 * part from `_fetchBakePose` (fetchSetupPartPose, else the default animation's
 * frame 0, else the 0x65 placement chain) — preferred; `hinge`: the part's
 * `{x,y,z,qw,qx,qy,qz}` hinge frame (fallback, also for parts past a shorter
 * `bakePose`). Pure apart from diag counters; exported for tests.
 */
export function partUnbakeMatrix(bakePose, hinge, i) {
  if (!animSceneryUnbakeEnabled()) return null;
  let x, y, z, qw, qx, qy, qz;
  if (bakePose && (i + 1) * 7 <= bakePose.length) {
    const b = i * 7;
    x = bakePose[b]; y = bakePose[b + 1]; z = bakePose[b + 2];
    qw = bakePose[b + 3]; qx = bakePose[b + 4]; qy = bakePose[b + 5]; qz = bakePose[b + 6];
    _unbakeStats.fromPose += 1;
  } else if (hinge) {
    x = hinge.x; y = hinge.y; z = hinge.z;
    qw = hinge.qw; qx = hinge.qx; qy = hinge.qy; qz = hinge.qz;
    _unbakeStats.fromHinge += 1;
  } else {
    return null;
  }
  x = +x || 0; y = +y || 0; z = +z || 0;
  qw = Number.isFinite(+qw) ? +qw : 1; qx = +qx || 0; qy = +qy || 0; qz = +qz || 0;
  if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e-6 && Math.abs(qx) + Math.abs(qy) + Math.abs(qz) < 1e-7) {
    return null;
  }
  const q = new THREE.Quaternion(qx, qy, qz, qw);
  if (q.lengthSq() < 1e-12) return null;
  q.normalize();
  _unbakeStats.parts += 1;
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1)).invert();
}

/** setupId -> per-part booleans (U non-null) — animatedScenerySetupDiag. */
const _unbakeBySetup = new Map();

/** Unbake matrices for every part of one setup (null entries = identity). */
function _unbakeMatsFor(bakePose, hinge, partCount, setupId) {
  const out = new Array(partCount).fill(null);
  if (!animSceneryUnbakeEnabled()) return out;
  let any = false;
  for (let i = 0; i < partCount; i++) {
    out[i] = partUnbakeMatrix(bakePose, hinge ? hinge[i] : null, i);
    if (out[i]) any = true;
  }
  const sid = setupId >>> 0;
  if (any && !_unbakeBySetup.has(sid)) _unbakeStats.setups += 1;
  _unbakeBySetup.set(sid, out.map((m) => m !== null));
  return out;
}

// One shared driver per animation DID: { mixer, template, parts:[Group],
// numParts, refCount }. The template is NOT added to the scene — it's a pure
// transform holder the mixer animates; instances copy its part transforms.
const _didGroups = new Map();
// Live instances: { node, parts:[Group], animId, key }. No per-instance mixer.
const _instances = [];
const _builtKeys = new Set(); // dedupe across ring re-bakes.

/**
 * Build a THREE.AnimationClip from a flattened Animation (0x03) bundle.
 *
 * `frames` is the flat Float32Array from `fetchAnimation`, laid out frame-major
 * then part-major, 7 floats per (frame, part):
 * `[origin.x, origin.y, origin.z, quat.w, quat.x, quat.y, quat.z]`. We emit, per
 * part, a VectorKeyframeTrack `part${p}.position` and a QuaternionKeyframeTrack
 * `part${p}.quaternion` (reordering AC wxyz → THREE xyzw), keyed at `f / fps`.
 * The clip targets child objects named `part0`, `part1`, … under the mixer root.
 *
 * Pure + deterministic — unit-tested in test_animated_scenery.mjs. Exported.
 *
 * @param {object} THREE_ the three module (injectable for tests)
 * @param {Float32Array|number[]} frames flat per-(frame,part) [oxyz, qwxyz]
 * @param {number} numParts
 * @param {number} numFrames
 * @param {number} fps
 * @param {object} [opts] `{closedLoop}` — see the duration note below.
 * @returns {object|null} THREE.AnimationClip, or null if degenerate
 */
export function buildSceneryAnimationClip(THREE_, frames, numParts, numFrames, fps, opts) {
  if (!frames || numParts <= 0 || numFrames <= 0) return null;
  const expect = numParts * numFrames * 7;
  if (frames.length < expect) return null;
  const dt = 1.0 / (fps > 0 ? fps : DEFAULT_ANIM_FPS);
  const times = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) times[f] = f * dt;
  const tracks = [];
  for (let p = 0; p < numParts; p++) {
    const pos = new Float32Array(numFrames * 3);
    const quat = new Float32Array(numFrames * 4);
    for (let f = 0; f < numFrames; f++) {
      const base = (f * numParts + p) * 7;
      pos[f * 3] = frames[base];
      pos[f * 3 + 1] = frames[base + 1];
      pos[f * 3 + 2] = frames[base + 2];
      const qw = frames[base + 3];
      const qx = frames[base + 4];
      const qy = frames[base + 5];
      const qz = frames[base + 6];
      // THREE quaternion order is (x, y, z, w).
      quat[f * 4] = qx;
      quat[f * 4 + 1] = qy;
      quat[f * 4 + 2] = qz;
      quat[f * 4 + 3] = qw;
    }
    tracks.push(new THREE_.VectorKeyframeTrack(`part${p}.position`, times, pos));
    tracks.push(new THREE_.QuaternionKeyframeTrack(`part${p}.quaternion`, times, quat));
  }
  if (tracks.length === 0) return null;
  // Loop-duration convention — the two producers differ, so it is EXPLICIT:
  //  - closedLoop (default): the SYNTHETIC wind clip repeats its opening frame as
  //    its closing frame (wind_rig.js: `frame[0] === frame[numFrames-1]`, every
  //    band an integer number of cycles over `(numFrames-1)/fps`), so its period
  //    is (n-1)*dt. Using n*dt would hold the duplicate frame an extra tick.
  //  - closedLoop:false: a DAT 0x03 Animation holds each of its n frames for
  //    1/fps with NO duplicate, so the loop is n*dt. (n-1)*dt gave the final
  //    authored frame zero dwell and ran every cycle one frame short. Matches
  //    the entity-side builder, animation.js `numFrames / framerate`.
  const closedLoop = opts?.closedLoop !== false;
  const duration = Math.max(dt, (closedLoop ? numFrames - 1 : numFrames) * dt);
  return new THREE_.AnimationClip("scenery-default-anim", duration, tracks);
}

/**
 * Place a node at its world transform (AC Z-up). Outdoor scenery `x,y,z` are
 * LB-local metres → world = `lb*192 + local`; interior items carry `worldFrame`
 * (x/y/z already world). Orientation = full AC quaternion (wxyz) when present.
 */
function placeNode(node, p) {
  if (p.worldFrame) {
    node.position.set(p.x || 0, p.y || 0, p.z || 0);
  } else {
    const lbX = (p.landblockId >>> 24) & 0xff;
    const lbY = (p.landblockId >>> 16) & 0xff;
    node.position.set(
      lbX * METERS_PER_LANDBLOCK + (p.x || 0),
      lbY * METERS_PER_LANDBLOCK + (p.y || 0),
      p.z || 0
    );
  }
  if (typeof p.qw === "number") {
    node.quaternion.set(p.qx || 0, p.qy || 0, p.qz || 0, p.qw);
  } else {
    node.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), p.rotationZ || 0);
  }
  const s = typeof p.scale === "number" && p.scale > 0 ? p.scale : 1;
  if (s !== 1) node.scale.setScalar(s);
}

function placementKey(p) {
  return `${(p.landblockId >>> 0).toString(16)}:${p.sourceObjIdx ?? p.source_obj_idx ?? "?"}:${Math.round((p.x || 0) * 8)}:${Math.round((p.y || 0) * 8)}`;
}

/** A node is orphaned (its LB/cell was evicted) when its topmost ancestor is no
 *  longer the live THREE.Scene — covers both staticsGroup-child removal and
 *  cell-container removal from cellsGroup. */
function _isOrphaned(node) {
  if (!node) return true;
  let p = node;
  while (p.parent) p = p.parent;
  return p.isScene !== true;
}

/**
 * Is this node's landblock merely PARKED (warm-park), rather than evicted?
 *
 * ⚠ THE PARK TRAP (`landblock_lru.js` park(), DEFAULT-ON since 2026-07-10).
 * Park detaches an LB's `staticsGroup` children into the pool, disposes
 * NOTHING, and KEEPS the statics baked mark so re-entry is a pure re-attach.
 * Our nodes carry `userData.landblockId`, so they ride into the pool — and
 * `_isOrphaned` cannot tell that apart from a real eviction. Reclaiming a
 * parked node strips its InstancedMesh slots, disposes the legacy path's
 * per-instance geometry and drops its `_builtKeys` mark; unpark then
 * re-attaches a DEAD anchor, and because the baked mark survived park nothing
 * ever re-bakes it — the tree is invisible for the rest of the session.
 *
 * A parked node is detached, hence invisible and un-posed, so simply skipping
 * it is free. When the pool later TRUE-disposes the LB (`disposeParked` →
 * `evict`) the key leaves `parkPool`, this returns false again, and the very
 * next frame reclaims the instance exactly as before — and by then `evict` has
 * cleared `staticsBakedLbs`, so re-entry legitimately re-bakes the trees.
 *
 * Fail-soft `false` (today's behaviour) whenever the LRU isn't reachable —
 * headless tests, capture paths, `?warmPark=off`.
 *
 * Exported purely as a test seam — the rAF reclaim loop that consumes it is
 * module-private and needs a live wasm bake to drive, so
 * `test_animated_scenery_park.mjs` locks the PREDICATE (masking, both facades,
 * fail-soft) and the loop wiring is checked live (see the commit message).
 */
export function _isParkedLb(node) {
  try {
    const lb = node?.userData?.landblockId;
    if (lb == null) return false;
    if (typeof window === "undefined") return false;
    const lru = window.liveScene3d?.landblockLru || window.__landblockLru || null;
    // `isParked` masks the id to an lb-key itself (landblock_lru.js lbKeyOf).
    return lru?.isParked?.(lb >>> 0) === true;
  } catch (_) {
    return false;
  }
}

// Per-frame memo of `_isParkedLb` by landblock id (2026-10-17, cpuframe).
// The rAF reclaim loop asked the LRU once PER INSTANCE per frame, and most
// instances are parked: live 1070 probe, 3,441 instances of which 3,364 sat in
// parked landblocks (77 anchors in the scene). 1070 profile: `_isParkedLb`
// 56.5 ms of 7.25 s. Every anchor of a landblock shares the answer, and
// nothing inside the (synchronous) loop parks or unparks, so one LRU query per
// landblock per frame gives the same result. Cleared at the top of each loop.
const _parkedMemo = new Map();
function _isParkedLbMemo(node) {
  const lb = node?.userData?.landblockId;
  if (lb == null) return false;
  let v = _parkedMemo.get(lb);
  if (v === undefined) {
    v = _isParkedLb(node);
    _parkedMemo.set(lb, v);
  }
  return v;
}

// ?rustAnimSceneryGate (2026-10-26, DEFAULT ON since 2026-10-26; `=off` escape) — the rAF
// loop's per-instance gate without the per-instance pointer chase: lane D's
// share of the work that cannot move to Rust (it reads the three.js graph).
// 1070 profiles (2026-10-23): the loop body is ~0.11-0.14 ms of the ~0.21-0.25
// ms/frame loop, ~3,400 instances, most in parked landblocks. Per instance it
// walked `inst → node → parent…` (`_isOrphaned`) and `inst → node → userData
// → landblockId` (a HeapNumber) into a Map keyed by that number
// (`_isParkedLbMemo`): four dependent loads on objects scattered across the
// heap. A node-profiled laptop run of 3,440 instances (3,360 parked) puts
// ~80 % of the loop on exactly those loads. Same answers, from the instance:
//   - parent: the instance mirrors `node.parent` (`_gp`), kept current by the
//     node's own 'added' / 'removed' events. Every parent change in this
//     codebase dispatches them: three r184 add / remove / attach /
//     removeFromParent / clear, and scene3d/bulk_child_remove.js (the LRU's
//     park / evict path, which dispatches the same events in the same order;
//     its only silent write restores a parent it never really removed). An
//     anchor with no parent is its own root, and anchors are THREE.Group,
//     never a Scene, so it is orphaned.
//   - root / visibility of the parent chain: walked once per distinct parent
//     per frame (every instanced anchor shares staticsGroup); nothing inside
//     the synchronous loop changes the graph or a `visible` flag.
//   - parked: the landblock id is read once at registration (`_glb`; an
//     anchor's userData.landblockId is written once, at build, and never
//     re-assigned — grep-verified 2026-10-26) and resolves to a per-landblock
//     record stamped with the loop's frame, so the LRU is still asked once
//     per landblock per frame.
//   - the parked majority is not even touched: an instance the loop left
//     DETACHED (parent null, the LRU's park), parked and collapsed is marked
//     stable in a flat array parallel to `_instances`. Until an anchor gets an
//     'added' event (the only way out of "detached") or its landblock stops
//     being parked, the loop's whole work for it is "parked → already
//     collapsed → next", so a stable entry whose landblock record still reads
//     parked this frame is skipped from two typed-array reads. Any 'added'
//     since the last frame turns the skip off for one full pass.
// Default ON since 2026-10-26 (exact); `?rustAnimSceneryGate=off` is the escape.
let _gateFlag = null;
export function animSceneryGateEnabled() {
  if (_gateFlag === null) _gateFlag = rustFlag("rustAnimSceneryGate", true);
  return _gateFlag;
}
/** Test seam: true/false forces, undefined re-reads the URL. */
export function __setAnimSceneryGateForTest(v) { _gateFlag = v === undefined ? null : !!v; }

const _gateStats = { tracked: 0, chainWalks: 0, lbQueries: 0, untracked: 0, stableSkips: 0, fullPasses: 0 };
const _lbRecs = new Map(); // landblockId -> { lb, idx, stamp, parked }
const _lbRecList = [];     // idx -> record
function _lbRecOf(lb) {
  let rec = _lbRecs.get(lb);
  if (rec === undefined) {
    rec = { lb, idx: _lbRecList.length, stamp: -1, parked: false };
    _lbRecs.set(lb, rec);
    _lbRecList.push(rec);
  }
  return rec;
}
/** `_isParkedLb(node)` from the landblock id `_isParkedLb` would read. */
function _isParkedLbId(lb) {
  try {
    if (lb == null) return false;
    if (typeof window === "undefined") return false;
    const lru = window.liveScene3d?.landblockLru || window.__landblockLru || null;
    return lru?.isParked?.(lb >>> 0) === true;
  } catch (_) {
    return false;
  }
}
// Flat state parallel to `_instances` (same index; push appends, the loop's
// splice shifts it, dispose clears it). In sync iff `_gxLen === _instances.length`
// (an instance registered with the gate off breaks the sync: no skipping).
const GX_STABLE = 1;
let _gxState = new Uint8Array(1024);
let _gxLb = new Int32Array(1024);
let _gxLen = 0;
let _gateAddedSince = false; // an anchor got 'added' since the last loop
function _gxAppend(rec) {
  if (_gxLen >= _gxState.length) {
    const ns = new Uint8Array(_gxState.length * 2); ns.set(_gxState); _gxState = ns;
    const nl = new Int32Array(_gxLb.length * 2); nl.set(_gxLb); _gxLb = nl;
  }
  _gxState[_gxLen] = 0;
  _gxLb[_gxLen] = rec ? rec.idx : -1;
  _gxLen += 1;
}
/** Registration (attachAnimatedScenery / attachWindTrees, after the node is
 *  parented): mirror the parent and the landblock on the instance. */
function _gateTrack(inst) {
  const node = inst.node;
  if (!node || typeof node.addEventListener !== "function") return;
  // In sync only if every earlier instance was tracked (it is pushed last).
  const inSync = _gxLen === _instances.length - 1;
  inst._gp = node.parent;
  const lb = node.userData ? node.userData.landblockId : undefined;
  inst._glb = lb;
  inst._lbRec = lb == null ? null : _lbRecOf(lb);
  node.addEventListener("added", () => { inst._gp = node.parent; _gateAddedSince = true; });
  node.addEventListener("removed", () => { inst._gp = node.parent; });
  if (inSync) _gxAppend(inst._lbRec);
  _gateStats.tracked += 1;
}
// Single-entry parent cache (every instanced anchor sits under staticsGroup)
// with a per-frame WeakMap behind it (cell containers, re-parented anchors).
let _gateP = null;
let _gatePStamp = -1;
let _gatePRoot = false;
let _gatePVis = true;
const _gateChains = new WeakMap(); // parent -> { stamp, root, vis } (never retains a parent)
function _gateChain(P) {
  if (P === _gateP && _gatePStamp === _poseFrame) return;
  let e = _gateChains.get(P);
  if (e === undefined || e.stamp !== _poseFrame) {
    let root = P;
    while (root.parent) root = root.parent;
    let vis = true;
    for (let o = P; o; o = o.parent) if (o.visible === false) { vis = false; break; }
    if (e === undefined) {
      e = { stamp: _poseFrame, root: root.isScene === true, vis };
      _gateChains.set(P, e);
    } else {
      e.stamp = _poseFrame;
      e.root = root.isScene === true;
      e.vis = vis;
    }
    _gateStats.chainWalks += 1;
  }
  _gateP = P;
  _gatePStamp = _poseFrame;
  _gatePRoot = e.root;
  _gatePVis = e.vis;
}
/** `_isOrphaned(inst.node)`, from the mirrored parent. */
function _gateOrphaned(inst) {
  const P = inst._gp;
  if (P === undefined) { _gateStats.untracked += 1; return _isOrphaned(inst.node); }
  if (!P) return true; // detached: the anchor Group is its own root
  _gateChain(P);
  return !_gatePRoot;
}
/** `_anchorVisible(inst.node)`, the chain above the anchor memoised. */
function _gateAnchorVisible(inst) {
  const node = inst.node;
  if (node.visible === false) return false;
  const P = inst._gp === undefined ? node.parent : inst._gp;
  if (!P) return true;
  _gateChain(P);
  return _gatePVis;
}
/** `_isParkedLbMemo(inst.node)`, from the instance's landblock record. */
function _gateParked(inst) {
  const rec = inst._lbRec;
  if (rec === undefined) return _isParkedLbMemo(inst.node);
  if (rec === null) return false;
  if (rec.stamp !== _poseFrame) {
    rec.parked = _isParkedLb(inst.node);
    rec.stamp = _poseFrame;
    _gateStats.lbQueries += 1;
  }
  return rec.parked;
}

/**
 * Get-or-create the shared driver for an animation DID: fetch the keyframes
 * once, build the clip + a non-rendered template Group of part subgroups, and a
 * single AnimationMixer playing it. Returns the group or null (fail-soft).
 */
async function getOrCreateDidGroup(animId, wasmExports) {
  const existing = _didGroups.get(animId);
  if (existing) return existing;
  let anim;
  try {
    anim = await wasmExports.fetchAnimation(animId);
  } catch (e) {
    console.warn(`[anim-scenery] fetchAnimation(0x${animId.toString(16)}) failed:`, e);
    return null;
  }
  const numParts = anim.numParts | 0;
  const numFrames = anim.numFrames | 0;
  const frames = anim.frames;
  // SetOmega orbit axis — new wasm getter; undefined on a stale pkg (no orbit,
  // today's behaviour). Read BEFORE free().
  let omega = null;
  try { omega = animSceneryOmegaEnabled() ? parseSetOmega(anim.setOmega) : null; } catch (_) { omega = null; }
  anim.free?.();
  if (numParts <= 0 || numFrames <= 0) return null;
  // DAT frames: n frames × 1/fps, no duplicated closing frame → open loop.
  const clip = buildSceneryAnimationClip(
    THREE, frames, numParts, numFrames, animSceneryFps(), { closedLoop: false });
  if (!clip) return null;
  const template = new THREE.Group();
  template.name = `anim-template-0x${animId.toString(16)}`;
  const parts = [];
  for (let i = 0; i < numParts; i++) {
    const g = new THREE.Group();
    g.name = `part${i}`;
    template.add(g);
    parts.push(g);
  }
  const mixer = new THREE.AnimationMixer(template);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();
  const group = {
    mixer, template, parts, numParts, refCount: 0,
    // Retail orbit state: one shared angle per DID (every critter of a DID was
    // loaded with its own placement heading, so they still sit at different
    // points of their circles — as in retail, where they all tick together).
    omega, orbitAngle: 0, orbitQ: new THREE.Quaternion(),
  };
  // ?rustAnimScenery: the kernel advances this group instead of its mixer
  // (the same clip inputs; `_rust` stays unset when it cannot take it).
  if (rustAnimSceneryEnabled()) {
    _rustAdopt(group, action, animId, frames, numParts, numFrames, animSceneryFps(), false);
    // A concurrent call for this DID (two bakes awaiting one setup's shared
    // geometry, or the unawaited cells.js attach) passed the `existing` check
    // while fetchAnimation was in flight and already put ITS group in the map.
    // The set below drops that group (with the flag off it is just garbage),
    // so the kernel must drop it too, or it would keep stepping it and later
    // rows could bind to it. Order: the new group is registered first (the
    // kernel rebinds every row of this DID to it), then the old one goes.
    const prev = _didGroups.get(animId);
    if (prev && prev !== group && prev._rust) {
      rustAnimUnregisterGroup(prev);
      _rustGroupCount -= 1;
    }
  }
  _didGroups.set(animId, group);
  return group;
}

// ?rustAnimScenery bookkeeping: how many live groups the kernel advances.
let _rustGroupCount = 0;
function _rustAdopt(group, action, key, frames, numParts, numFrames, fps, closedLoop) {
  group._action = action;
  if (rustAnimRegisterGroup(group, typeof key === "number" ? key : 0, frames, numParts, numFrames, fps, closedLoop)) {
    _rustGroupCount += 1;
  }
}

/**
 * Advance every shared driver ONCE and write the GPU pose rows. Flag off (or
 * no kernel): each group's mixer + orbit, then `_updateGpuPoseRows` — the
 * code as it was. ?rustAnimScenery: one kernel call, then the template parts
 * / orbit written back and the kernel's rows copied; a group the kernel does
 * not hold still runs its mixer. A kernel failure hands every group back to
 * its mixer (clocks synced) and the JS path continues.
 */
function _advanceDidGroups(dt) {
  if (_rustGroupCount > 0) {
    if (rustAnimAdvance(dt, animSceneryOmegaHz())) {
      for (const g of _didGroups.values()) {
        if (g._rust) { rustAnimWriteBack(g); continue; }
        try { g.mixer.update(dt); } catch (_) {}
        _advanceOrbit(g, dt);
      }
      _updateGpuPoseRows(true);
      return;
    }
    rustAnimFallback(_didGroups.values());
    _rustGroupCount = 0;
  }
  for (const g of _didGroups.values()) {
    try { g.mixer.update(dt); } catch (_) {}
    _advanceOrbit(g, dt);
  }
  _updateGpuPoseRows();
}

/** Advance a DID group's SetOmega orbit (no-op without one). */
function _advanceOrbit(g, dt) {
  if (!g.omega) return;
  g.orbitAngle = (g.orbitAngle + staticOmegaAngleStep(g.omega, dt)) % (Math.PI * 2);
  g.orbitQ.setFromAxisAngle(g.omega.axis, g.orbitAngle);
}

const _orbitQuatScratch = new THREE.Quaternion();
/**
 * The anchor transform this frame. Retail grotate is a GLOBAL rotation
 * (new_q = q_w * q, acclient.c:357422), so the orbit pre-multiplies the
 * placement orientation about the anchor's own origin: the parts, authored
 * off-origin, sweep a circle round the placement point.
 */
function _orbitNodeMatrix(inst, g) {
  if (!g.omega || !inst.baseQuat) return inst.nodeMat;
  const m = inst._orbitMat || (inst._orbitMat = new THREE.Matrix4());
  _orbitQuatScratch.copy(g.orbitQ).multiply(inst.baseQuat);
  return m.compose(inst.node.position, _orbitQuatScratch, inst.node.scale);
}

/**
 * Build ONE animated-scenery instance node (per-part meshes at the placement's
 * world transform). The per-part ANIMATION comes from the shared DID group
 * (copied each frame in the rAF), so the instance carries NO mixer. Returns
 * `{ node, parts, animId }` or null (fail-soft).
 */
async function buildOne(p, wasmExports, materialCache, spFetch) {
  const setupId = (p.objId ?? p.obj_id ?? p.modelId ?? 0) >>> 0;
  const animId = (p.defaultAnimationId >>> 0);
  if (setupId === 0 || animId === 0) return null;

  let bundle;
  try {
    bundle = await wasmExports.fetchBuildingPlacement(setupId);
  } catch (e) {
    console.warn(`[anim-scenery] fetchBuildingPlacement(0x${setupId.toString(16)}) failed:`, e);
    return null;
  }
  const partCount = bundle.partCount | 0;
  if (partCount === 0) { bundle.free?.(); return null; }
  const partMeshes = bundle.takePartMeshes();
  const hinge = (typeof bundle.takePartHingeFrames === "function")
    ? bundle.takePartHingeFrames() : [];
  bundle.free?.();
  // ?animSceneryUnbake: never rejects (null on a stale pkg / failure → hinge fallback).
  const unbake = _unbakeMatsFor(await _fetchBakePose(setupId, wasmExports, animId), hinge, partCount, setupId);

  // INVARIANT: create the shared DID driver only once every fallible fetch has
  // succeeded. It enters `_didGroups` with refCount 0 and its mixer is advanced
  // by the rAF forever; the ONLY reclaim path is an instance dropping the last
  // ref, so a group created before a `return null` below would tick unreachable
  // for the rest of the session.
  const didGroup = await getOrCreateDidGroup(animId, wasmExports);
  if (!didGroup) {
    // takePartMeshes() already moved ownership to JS — free them on this bail-out.
    for (const m of partMeshes) { try { m?.free?.(); } catch (_) {} }
    return null;
  }

  const node = new THREE.Group();
  node.name = `anim-scenery-0x${setupId.toString(16)}`;
  // Tag with the LB so the existing LRU evict (matches userData.landblockId)
  // removes outdoor nodes from staticsGroup on eviction.
  node.userData = { landblockId: (p.landblockId >>> 0), isAnimatedScenery: true };
  placeNode(node, p);

  const parts = [];
  for (let i = 0; i < partCount; i++) {
    const partGroup = new THREE.Group();
    partGroup.name = `part${i}`;
    const h = hinge[i];
    const u = unbake[i];
    if (u) {
      // Rest pose until the first tick = the bake frame (inverse of U), so the
      // baked mesh shows exactly as the frozen static would.
      _unbakeRestScratch.copy(u).invert().decompose(partGroup.position, partGroup.quaternion, _unbakeScaleScratch);
    } else if (h) {
      partGroup.position.set(h.x, h.y, h.z);
      partGroup.quaternion.set(h.qx, h.qy, h.qz, h.qw);
    }
    const wasmMesh = partMeshes[i];
    if (wasmMesh) {
      try {
        const { groups, surfaceDids } = meshToGeometryGroups(wasmMesh);
        softenCanopyGroups(groups);
        for (let g = 0; g < (groups?.length || 0); g++) {
          const grp = groups[g];
          const sid = grp.surfaceDid || surfaceDids?.[g] || 0;
          // eslint-disable-next-line no-await-in-loop
          const mat = await materialCache.get(sid, spFetch);
          if (grp.geometry && mat) {
            const mesh = new THREE.Mesh(grp.geometry, mat);
            // ?animSceneryUnbake: the mesh sits at U under the clip-driven part
            // group, so the group's A(t) lands on part-local vertices.
            if (u) u.decompose(mesh.position, mesh.quaternion, mesh.scale);
            partGroup.add(mesh);
          }
        }
      } catch (e) {
        console.warn(`[anim-scenery] part ${i} mesh build failed:`, e);
      }
      wasmMesh.free?.();
    }
    node.add(partGroup);
    parts.push(partGroup);
  }
  return { node, parts, animId };
}

/**
 * Entry point — build animated instance nodes for every placement carrying a
 * non-zero `defaultAnimationId`. Called from the statics bake (outdoor) and
 * cells.js (interior), which have FILTERED these out of the frozen path so they
 * aren't double-rendered. No-op when `?animScenery` is off or nothing qualifies.
 * Fail-soft + capped. `opts.resolveParent(item)` chooses the THREE.Group to add
 * the node to (default `scene3d.staticsGroup`; cells.js passes the cell container
 * for interior visibility gating).
 *
 * 2026-08-03 coverage-gated peel — returns `{built:number, failed:Placement[]}`
 * (same contract as `attachWindTrees`). INVARIANT: the caller peels these out of
 * the FROZEN path, so anything this function cannot turn into a live animated
 * node must come back in `failed` or it renders NOWHERE. `failed` carries the
 * ORIGINAL placement objects for every over-cap / failed / unbuildable entry;
 * statics.js re-freezes them so a prop is at worst STATIC, never invisible.
 */
export async function attachAnimatedScenery(scene3d, placements, wasmExports, opts) {
  if (!animSceneryEnabled()) return { built: 0, failed: [] };
  if (!scene3d?.staticsGroup || !Array.isArray(placements) || !wasmExports) return { built: 0, failed: [] };
  if (typeof wasmExports.fetchAnimation !== "function"
      || typeof wasmExports.fetchBuildingPlacement !== "function") {
    return { built: 0, failed: placements }; // pre-rebuild pkg — re-freeze static.
  }
  const scripted = placements.filter((p) => ((p?.defaultAnimationId >>> 0) || 0) !== 0);
  if (scripted.length === 0) return { built: 0, failed: [] };
  _rafDisposed = false; // re-arm after a prior dispose if scenery loads again.

  const resolveParent = (typeof opts?.resolveParent === "function") ? opts.resolveParent : null;
  const { getOrCreateMaterialCache } = await import("./statics.js");
  const materialCache = getOrCreateMaterialCache(scene3d);
  if (!materialCache) return { built: 0, failed: placements }; // re-freeze, don't vanish
  const spFetch = surfacePixelsFetcher(wasmExports);

  let built = 0;
  let dropped = 0;
  // Placements that could NOT become a live animated node — re-frozen by the caller.
  const failed = [];
  for (const p of scripted) {
    const key = placementKey(p);
    if (_builtKeys.has(key)) continue;
    if (_instances.length >= maxAnimated()) { failed.push(p); dropped += 1; continue; }
    _builtKeys.add(key);
    // ?animSceneryInstanced: outdoor (staticsGroup-parented) placements take the
    // instanced builder; interior (resolveParent → cell container) placements
    // keep the legacy per-mesh path (cell visibility gating needs real children).
    // Flag OFF ⇒ this branch is never evaluated past the flag read ⇒ byte-identical.
    const useInstanced = animSceneryInstancedEnabled() && !(resolveParent && resolveParent(p));
    // eslint-disable-next-line no-await-in-loop
    const r = await (useInstanced
      ? buildOneInstanced(p, scene3d, wasmExports, materialCache, spFetch)
      : buildOne(p, wasmExports, materialCache, spFetch)
    ).catch((e) => {
      console.warn("[anim-scenery] buildOne threw:", e);
      return null;
    });
    if (r) {
      const parent = (resolveParent && resolveParent(p)) || scene3d.staticsGroup;
      parent.add(r.node);
      const g = _didGroups.get(r.animId);
      if (g) g.refCount += 1;
      if (r.instanced) {
        r.key = key;
        _instances.push(r);
      } else {
        _instances.push({ node: r.node, parts: r.parts, animId: r.animId, key,
          baseQuat: r.node.quaternion.clone() });
      }
      if (animSceneryGateEnabled()) _gateTrack(_instances[_instances.length - 1]);
      _ensureRaf();
      built += 1;
    } else {
      _builtKeys.delete(key); // allow retry on a later bake.
      failed.push(p);
    }
  }
  if (built > 0 || dropped > 0) {
    console.log(`[anim-scenery] built ${built} instances across ${_didGroups.size} anim DIDs` +
      (dropped > 0 ? `; DROPPED ${dropped} over the ${maxAnimated()} cap (?animSceneryMax) → re-frozen` : ""));
  }
  return { built, failed };
}

// ===========================================================================
// ?animSceneryInstanced — instanced DAT-anim scenery (2026-07-02).
//
// The legacy path gives EVERY placement its own part Meshes (per-instance
// geometry clones) → one draw per (placement, part, surface group). All
// placements of a setup share geometry AND (per anim DID) the exact template
// pose, so the whole population collapses to one InstancedMesh per
// (setupId, part, surface group): per frame `instanceMatrix[i] =
// placementMatrix × templatePartPose`, one buffer upload per dirty bucket.
//
// Contracts kept from the legacy path:
//  - The per-placement ANCHOR Group (same name/userData.landblockId) still
//    parents to staticsGroup, so LRU eviction + the orphan-reclaim rAF work
//    unchanged; reclaim swap-removes the instance's slots instead of
//    disposing geometry (bucket geometry is SHARED — never per-instance).
//  - Beyond-radius instances are simply not rewritten (legacy "freeze at last
//    pose"); slots are seeded with the HINGE rest pose so a never-ticked
//    instance is visible, not a zero-matrix degenerate.
//  - Bucket meshes carry NO userData.landblockId (they span LBs — the LRU
//    must never evict them) and frustumCulled=false (instances are scattered
//    far beyond the shared geometry's local bounds).
// Interior (cell-parented) placements stay on the legacy path.
// ===========================================================================

const _UNIT3 = new THREE.Vector3(1, 1, 1);
const _instScratch = new THREE.Matrix4();
const _geomCache = new Map();   // setupId -> Promise<{partCount, parts:[[{geometry,surfaceDid}]], hingeMats:[Matrix4]}|null>
const _geomList = [];           // resolved shared geometries (for dispose)
const _buckets = new Map();     // "setup:part:group" -> Promise<bucket|null>
const _bucketList = [];         // resolved buckets (for dispose/diag)
const _dirtyBuckets = new Set();
// OpenAC comparison 2026-10-04 (perf T9): the dirty slot SPAN per bucket this
// frame, so the flush uploads [min, max] instead of the whole instanceMatrix
// (OpenAC hands the scene only the owners written since the last handover).
const _dirtySpan = new Map(); // bucket -> { min, max } slot indices

function _markDirty(bucket, index) {
  _dirtyBuckets.add(bucket);
  const span = _dirtySpan.get(bucket);
  if (span) {
    if (index < span.min) span.min = index;
    if (index > span.max) span.max = index;
  } else {
    _dirtySpan.set(bucket, { min: index, max: index });
  }
}
let _poseFrame = 0;             // stamps per-DID template pose recompute + bucket dirtying

/** Decode a setup's part geometry ONCE (legacy decodes per placement). */
function _getSharedSetupGeom(setupId, wasmExports, animId) {
  let p = _geomCache.get(setupId);
  if (p) return p;
  p = (async () => {
    // T13 (`?geomBundles`): the decode-once shared geometry comes from the
    // HBG1 bundle when armed — same per-part + hinge shape, memcpy-scale
    // (SPEC pass 4 S4 row 4). A missing payload falls through to the
    // UNCHANGED legacy decode below, counted.
    if (geomBundlesActive()) {
      const res = assembleGeomBundles([setupId >>> 0]);
      if (res && res.byModel.has(setupId >>> 0)) {
        const pr = bundleToPartGroups(res.byModel.get(setupId >>> 0), res.buffer);
        if (pr && pr.parts.length > 0) {
          const parts = [];
          const hingeMats = [];
          for (const part of pr.parts) {
            const h = part.hinge;
            const hm = new THREE.Matrix4();
            hm.compose(
              new THREE.Vector3(h.x, h.y, h.z),
              new THREE.Quaternion(h.qx, h.qy, h.qz, h.qw),
              _UNIT3
            );
            hingeMats.push(hm);
            const groups = [];
            for (const g of part.groups) {
              if (g.geometry) {
                groups.push({ geometry: g.geometry, surfaceDid: g.surfaceDid || 0 });
                _geomList.push(g.geometry);
              }
            }
            parts.push(groups);
          }
          // ?animSceneryUnbake: the bundle bakes the same part frame in.
          const unbakeMats = _unbakeMatsFor(await _fetchBakePose(setupId >>> 0, wasmExports, animId),
            pr.parts.map((part) => part.hinge), pr.parts.length, setupId);
          return { partCount: pr.parts.length, parts, hingeMats, unbakeMats };
        }
      }
      if (res) countGeomFallback(1);
    }
    let bundle;
    try {
      bundle = await wasmExports.fetchBuildingPlacement(setupId);
    } catch (e) {
      console.warn(`[anim-scenery] shared fetchBuildingPlacement(0x${setupId.toString(16)}) failed:`, e);
      return null;
    }
    const partCount = bundle.partCount | 0;
    if (partCount === 0) { bundle.free?.(); return null; }
    const partMeshes = bundle.takePartMeshes();
    const hinge = (typeof bundle.takePartHingeFrames === "function") ? bundle.takePartHingeFrames() : [];
    bundle.free?.();
    const parts = [];
    const hingeMats = [];
    for (let i = 0; i < partCount; i++) {
      const h = hinge[i];
      const hm = new THREE.Matrix4();
      if (h) hm.compose(new THREE.Vector3(h.x, h.y, h.z), new THREE.Quaternion(h.qx, h.qy, h.qz, h.qw), _UNIT3);
      hingeMats.push(hm);
      const groups = [];
      const wasmMesh = partMeshes[i];
      if (wasmMesh) {
        try {
          const r = meshToGeometryGroups(wasmMesh);
          softenCanopyGroups(r.groups);
          for (let g = 0; g < (r.groups?.length || 0); g++) {
            const grp = r.groups[g];
            const sid = grp.surfaceDid || r.surfaceDids?.[g] || 0;
            if (grp.geometry) { groups.push({ geometry: grp.geometry, surfaceDid: sid }); _geomList.push(grp.geometry); }
          }
        } catch (e) {
          console.warn(`[anim-scenery] shared part ${i} mesh build failed:`, e);
        }
        wasmMesh.free?.();
      }
      parts.push(groups);
    }
    const unbakeMats = _unbakeMatsFor(await _fetchBakePose(setupId >>> 0, wasmExports, animId), hinge, partCount, setupId);
    return { partCount, parts, hingeMats, unbakeMats };
  })();
  _geomCache.set(setupId, p);
  return p;
}

// ?animSceneryGpu: give the bucket geometry its constant per-vertex pose row.
// A bucket's geometry is its own (one per setup/part/group) unless one setup
// is placed with two animation DIDs — then the second bucket gets a copy.
function _geometryWithPoseRow(geometry, row) {
  const ud = geometry.userData || (geometry.userData = {});
  let geo = geometry;
  if (ud.__hbAiRow !== undefined && ud.__hbAiRow !== row) {
    geo = geometry.clone();
    _geomList.push(geo);
  }
  const n = geo.getAttribute("position")?.count | 0;
  geo.setAttribute("hbAiPose", new THREE.BufferAttribute(new Float32Array(n).fill(row), 1));
  geo.userData.__hbAiRow = row;
  return geo;
}

function _getOrCreateBucket(scene3d, setupId, partIdx, gIdx, geometry, surfaceDid, materialCache, spFetch, animId, hingeMat, unbake) {
  // GPU buckets are per animation DID too: the pose row rides the geometry.
  const gpu = animSceneryGpuEnabled();
  const key = gpu ? `${setupId}:${animId}:${partIdx}:${gIdx}` : `${setupId}:${partIdx}:${gIdx}`;
  let p = _buckets.get(key);
  if (p) return p;
  p = (async () => {
    const mat = await materialCache.get(surfaceDid, spFetch);
    if (!mat) return null;
    let drawMat = mat;
    let geo = geometry;
    let gpuRow = -1;
    if (gpu) {
      const v = animInstMaterialFor(mat);
      if (v) {
        // ?animSceneryUnbake: the row carries P(t) * U for THIS setup's baked
        // part (its own row — another setup on the DID may bake differently),
        // seeded with the rest pose B * U = identity until the first tick.
        gpuRow = unbake
          ? poseRowFor(animId, partIdx, null, `s${setupId >>> 0}`, unbake)
          : poseRowFor(animId, partIdx, hingeMat);
        geo = _geometryWithPoseRow(geometry, gpuRow);
        drawMat = v;
      }
    }
    const mesh = new THREE.InstancedMesh(geo, drawMat, 128);
    mesh.count = 0;
    mesh.name = `anim-inst-0x${setupId.toString(16)}-p${partIdx}-g${gIdx}`;
    // no landblockId → LRU never evicts. `animGpuRow`: the pose-table row a
    // GPU-posed bucket draws with (?animSceneryGpu), -1 on the CPU path.
    mesh.userData = { isAnimatedSceneryInstanced: true, animGpuRow: gpuRow };
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene3d.staticsGroup.add(mesh);
    // `active`: members not collapsed (?animSceneryBucketVis shows the bucket iff > 0).
    const bucket = { mesh, members: [], capacity: 128, gpu: gpuRow >= 0, active: 0 };
    _bucketList.push(bucket);
    return bucket;
  })();
  _buckets.set(key, p);
  return p;
}

/** members[k] ↔ instanceMatrix slot k (one slot per bucket per instance). */
function _registerSlot(bucket, inst) {
  if (bucket.members.length >= bucket.capacity) {
    const old = bucket.mesh;
    const cap = bucket.capacity * 2;
    const nm = new THREE.InstancedMesh(old.geometry, old.material, cap);
    nm.name = old.name;
    nm.userData = old.userData;
    nm.frustumCulled = false;
    nm.matrixAutoUpdate = false;
    nm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    nm.instanceMatrix.array.set(old.instanceMatrix.array);
    nm.count = old.count;
    nm.visible = old.visible;
    const parent = old.parent;
    if (parent) { parent.add(nm); parent.remove(old); }
    old.dispose(); // frees old instance buffers only — geometry/material shared
    bucket.mesh = nm;
    bucket.capacity = cap;
  }
  const index = bucket.members.length;
  bucket.members.push(inst);
  bucket.mesh.count = bucket.members.length;
  bucket.active += 1; // a new slot is live (registered instances start un-collapsed)
  return index;
}

/** Instanced sibling of buildOne: anchor Group + slots instead of part Meshes. */
async function buildOneInstanced(p, scene3d, wasmExports, materialCache, spFetch) {
  const setupId = (p.objId ?? p.obj_id ?? p.modelId ?? 0) >>> 0;
  const animId = (p.defaultAnimationId >>> 0);
  if (setupId === 0 || animId === 0) return null;
  // Shared geometry FIRST — see the invariant in buildOne: a `_didGroups` entry
  // created before a `return null` is an unreclaimable per-frame mixer.
  const shared = await _getSharedSetupGeom(setupId, wasmExports, animId);
  if (!shared) return null;
  const didGroup = await getOrCreateDidGroup(animId, wasmExports);
  if (!didGroup) return null;

  const node = new THREE.Group();
  node.name = `anim-scenery-0x${setupId.toString(16)}`;
  node.userData = { landblockId: (p.landblockId >>> 0), isAnimatedScenery: true, instanced: true };
  placeNode(node, p);
  node.updateMatrix();
  node.matrixAutoUpdate = false; // placement never moves; rAF writes slots, not the anchor

  const inst = { node, parts: [], animId, key: null, nodeMat: node.matrix.clone(), slots: [], instanced: true,
    baseQuat: node.quaternion.clone() };
  for (let i = 0; i < shared.partCount; i++) {
    const groups = shared.parts[i];
    // ?animSceneryUnbake: U for this part (null = identity bake frame / flag off).
    const unbake = shared.unbakeMats ? shared.unbakeMats[i] || null : null;
    for (let g = 0; g < groups.length; g++) {
      // eslint-disable-next-line no-await-in-loop
      const bucket = await _getOrCreateBucket(scene3d, setupId, i, g, groups[g].geometry, groups[g].surfaceDid,
        materialCache, spFetch, animId, shared.hingeMats[i], unbake);
      if (!bucket) continue;
      const index = _registerSlot(bucket, inst);
      if (bucket.gpu) {
        // ?animSceneryGpu: the slot holds the STATIC placement; the pose row
        // (seeded with this hinge rest pose) supplies the part transform.
        bucket.mesh.setMatrixAt(index, inst.nodeMat);
      } else if (unbake) {
        // Rest pose until first tick: B * U = identity on the baked mesh.
        bucket.mesh.setMatrixAt(index, inst.nodeMat);
      } else {
        _instScratch.multiplyMatrices(inst.nodeMat, shared.hingeMats[i]); // rest pose until first tick
        bucket.mesh.setMatrixAt(index, _instScratch);
      }
      // Record the span too, so a same-frame span flush on this bucket still
      // covers the new slot (perf T9); needsUpdate stays for an immediate
      // whole-buffer upload if a render lands before the next flush.
      _markDirty(bucket, index);
      bucket.mesh.instanceMatrix.needsUpdate = true;
      inst.slots.push({ bucket, index, partIdx: i, unbake });
    }
  }
  // CPU-posed slots left (0 ⇒ the rAF loop has nothing to write per frame).
  inst.cpuSlots = inst.slots.reduce((n, s) => n + (s.bucket.gpu ? 0 : 1), 0);
  return inst;
}

/** The DID's template part poses, composed once per DID per frame. */
function _partMatsFor(g) {
  if (g._poseStamp !== _poseFrame) {
    if (!g._partMats) g._partMats = [];
    for (let j = 0; j < g.parts.length; j++) {
      (g._partMats[j] || (g._partMats[j] = new THREE.Matrix4()))
        .compose(g.parts[j].position, g.parts[j].quaternion, _UNIT3);
    }
    g._poseStamp = _poseFrame;
  }
  return g._partMats;
}

/**
 * ?animSceneryGpu — once per frame, after the mixers + orbits advanced: write
 * each (DID, part) row of the pose table the GPU-posed buckets read.
 */
function _updateGpuPoseRows(rustRows) {
  const rows = poseRows();
  if (rows.length === 0) return;
  // ?rustAnimScenery: rows of kernel-held groups were computed by
  // rustAnimAdvance this frame (row index i = table row i + 1, in lockstep);
  // the kernel wrote a row exactly when this loop would (group present, part
  // in range), so copying it is the same write.
  const kRows = rustRows === true && rustAnimRowsOk() ? rustAnimRows() : null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const g = _didGroups.get(r.animId);
    if (!g) continue;
    if (kRows !== null && g._rust) {
      if (rustAnimRowWritten(i)) copyPoseRowFrom(r.row, kRows, i * ANIM_ROW_FLOATS);
      continue;
    }
    const pm = _partMatsFor(g)[r.partIdx];
    if (!pm) continue;
    // ?animSceneryUnbake: a row with `post` draws P(t) * U (see poseRowFor).
    const m = r.post ? _rowScratch.multiplyMatrices(pm, r.post) : pm;
    writePoseRow(r.row, m, g.omega ? g.orbitQ : null);
  }
  flushPoseTable();
}
const _rowScratch = new THREE.Matrix4();

/**
 * The matrix instance `index` of an animated-scenery bucket is DRAWN with: the
 * slot's instanceMatrix on the CPU path; on a GPU-posed bucket the vertex
 * shader's composition of that static placement with the bucket's pose row
 * (JS mirror). Tests / diag.
 */
export function animSceneryEffectiveMatrixAt(mesh, index, out) {
  const m = out || new THREE.Matrix4();
  mesh.getMatrixAt(index, m);
  const row = mesh.userData?.animGpuRow;
  if (typeof row === "number" && row >= 0) posedMatrixFromRow(m, row, m);
  return m;
}

/**
 * Per-frame slot write: template part poses composed once per DID per frame.
 * GPU-posed slots (?animSceneryGpu) hold the static placement and are only
 * (re)written when `restore` — an instance shown again after a collapse.
 */
function _writeInstancedPose(inst, g, restore) {
  _partMatsFor(g);
  const nodeMat = _orbitNodeMatrix(inst, g);
  for (const s of inst.slots) {
    if (s.bucket.gpu) {
      if (restore) {
        s.bucket.mesh.setMatrixAt(s.index, inst.nodeMat);
        _markDirty(s.bucket, s.index);
      }
      continue;
    }
    const pm = g._partMats[s.partIdx];
    if (!pm) continue;
    _instScratch.multiplyMatrices(nodeMat, pm);
    if (s.unbake) _instScratch.multiply(s.unbake); // ?animSceneryUnbake: N * A(t) * U
    s.bucket.mesh.setMatrixAt(s.index, _instScratch);
    _markDirty(s.bucket, s.index);
  }
}

/**
 * Collapse an instanced anchor's slots to a zero-scale matrix (drawn as
 * nothing) while it must not show: its landblock is PARKED (the slots stay in
 * the shared InstancedMesh, so before this a parked landblock's animated props
 * kept drawing in their last pose — the same ghost class as the static chunk
 * buckets), or its anchor is hidden (`?objRadius`). Idempotent; the loop
 * rewrites the real pose the frame it may show again.
 */
const _ZERO_MAT = new THREE.Matrix4().makeScale(0, 0, 0);
function _collapseInstanced(inst) {
  if (inst.collapsed) return;
  for (const s of inst.slots) {
    s.bucket.mesh.setMatrixAt(s.index, _ZERO_MAT);
    _markDirty(s.bucket, s.index);
    s.bucket.active -= 1;
  }
  inst.collapsed = true;
  _collapseStats.collapses += 1;
}
const _collapseStats = { collapses: 0, restores: 0 };
/** Diag: how often instanced props were collapsed/restored (park, ?objRadius). */
export function animatedSceneryCollapseStats() { return { ..._collapseStats }; }

/** False when the anchor or any ancestor is hidden (visible === false). */
function _anchorVisible(node) {
  for (let o = node; o; o = o.parent) if (o.visible === false) return false;
  return true;
}

/** Orphan reclaim for an instanced anchor: swap-remove each slot. */
function _reclaimInstancedSlots(inst) {
  for (const s of inst.slots) {
    const b = s.bucket;
    if (!inst.collapsed) b.active -= 1;
    const m = b.members;
    const lastIdx = m.length - 1;
    if (lastIdx < 0) continue;
    const last = m[lastIdx];
    if (last !== inst) {
      const ls = last.slots.find((x) => x.bucket === b);
      if (ls) {
        b.mesh.getMatrixAt(ls.index, _instScratch);
        b.mesh.setMatrixAt(s.index, _instScratch);
        ls.index = s.index;
      }
      m[s.index] = last;
    }
    m.pop();
    b.mesh.count = m.length;
    _markDirty(b, s.index);
  }
  inst.slots.length = 0;
}

/** ?animSceneryBucketVis: each bucket draws iff it has a live instance. */
function _applyBucketVisibility() {
  if (!animSceneryBucketVisEnabled()) return;
  for (let i = 0; i < _bucketList.length; i++) {
    const b = _bucketList[i];
    const want = b.active > 0;
    if (b.mesh.visible !== want) b.mesh.visible = want;
  }
}

function _flushDirtyBuckets() {
  for (const b of _dirtyBuckets) {
    const attr = b.mesh.instanceMatrix;
    const span = _dirtySpan.get(b);
    // One contiguous range per bucket (16 floats per matrix). three uploads
    // only the registered ranges and clears them after the upload; with no
    // span recorded it falls back to the whole buffer as before.
    if (span && typeof attr.addUpdateRange === "function") {
      attr.clearUpdateRanges?.();
      attr.addUpdateRange(span.min * 16, (span.max - span.min + 1) * 16);
    }
    attr.needsUpdate = true;
  }
  _dirtyBuckets.clear();
  _dirtySpan.clear();
}

// ===========================================================================
// Tree wind sway (Phase 1, 2026-06-23) — drives the SAME per-part keyframe
// player above with a SYNTHETIC, procedurally-generated wind clip (wind_rig.js)
// instead of a DAT `default_animation`. Non-retail; gated by ?treeWind (default
// OFF). Reuses _didGroups / _instances / _builtKeys / _ensureRaf / placeNode /
// maxAnimated verbatim — the only new machinery is the clip source + the bbox
// base-pivot rig. The rAF copy loop, distance cull, LRU/orphan reclaim, and the
// 512 cap all apply unchanged because a wind instance is just an _instances
// entry whose `animId` is a string key into _didGroups.
// ===========================================================================

// Per-model rig cache: every placement of a setupId shares the same per-part
// geometry → same pivots/weights. Compute the rig once, reuse for all instances.
const _windRigCache = new Map(); // setupId -> rigs[] (from buildBboxRig)

// P4.3 — lazy SuiteAssetSource singleton. Constructed ONLY under windBakeEnabled()
// so the default off-trace never instantiates it (no fetch, no cache mutation → [R]).
let _suiteSource = null;
let _windBakeInertWarned = false; // §B.5 dir/strength-inert warn fires at most once.
function _getSuiteSource(wasmExports) {
  if (!_suiteSource) _suiteSource = new SuiteAssetSource({ wasmExports });
  return _suiteSource;
}

function _unionBox(a, b) {
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), maxZ: Math.max(a.maxZ, b.maxZ),
    cx: 0, cy: 0, cz: 0, // recomputed below
  };
}

/** Shared wind driver per (setupId, phase-bucket): one mixer playing a synthetic
 *  clip, ONE per group, advanced once per rAF (same model as getOrCreateDidGroup). */
function getOrCreateWindGroup(groupKey, numParts, rig, windParams, bakedClip) {
  const existing = _didGroups.get(groupKey);
  if (existing) return existing;
  if (numParts <= 0) return null;
  // P4.3 — prefer the baked phase-bucket frames when present (?windBake=on); else the
  // UNCHANGED live synthesis. bakedClip === undefined on the off-path ⇒ byte-identical.
  let frames, numFrames, fps;
  if (bakedClip) { ({ frames, numFrames, fps } = bakedClip); }
  else           { ({ frames, numFrames, fps } = windBend.buildClip({ numParts, rig }, windParams)); }
  const clip = buildSceneryAnimationClip(THREE, frames, numParts, numFrames, fps);
  if (!clip) return null;
  const template = new THREE.Group();
  template.name = `wind-template-${groupKey}`;
  const parts = [];
  for (let i = 0; i < numParts; i++) {
    const g = new THREE.Group();
    g.name = `part${i}`;
    template.add(g);
    parts.push(g);
  }
  const mixer = new THREE.AnimationMixer(template);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();
  const group = { mixer, template, parts, numParts, refCount: 0 };
  // ?rustAnimScenery: same clip inputs (the synthetic wind clip is closed-loop).
  if (rustAnimSceneryEnabled()) _rustAdopt(group, action, 0, frames, numParts, numFrames, fps, true);
  _didGroups.set(groupKey, group);
  return group;
}

/** Build one wind-tree instance node (per-part meshes at the placement's world
 *  transform) + the per-part bbox rig. Mirrors buildOne; the ANIMATION comes
 *  from the shared wind group (copied each frame), so the node carries no mixer. */
async function buildOneWind(p, wasmExports, materialCache, spFetch) {
  const setupId = (p.modelId ?? p.objId ?? p.obj_id ?? 0) >>> 0;
  if (setupId === 0) return null;

  let bundle;
  try {
    bundle = await wasmExports.fetchBuildingPlacement(setupId);
  } catch (e) {
    console.warn(`[tree-wind] fetchBuildingPlacement(0x${setupId.toString(16)}) failed:`, e);
    return null;
  }
  const partCount = bundle.partCount | 0;
  if (partCount === 0) { bundle.free?.(); return null; }
  const partMeshes = bundle.takePartMeshes();
  const hinge = (typeof bundle.takePartHingeFrames === "function") ? bundle.takePartHingeFrames() : [];
  bundle.free?.();

  const node = new THREE.Group();
  node.name = `wind-tree-0x${setupId.toString(16)}`;
  // Tag with the LB so the existing LRU evict (matches userData.landblockId)
  // removes wind nodes from staticsGroup on eviction.
  node.userData = { landblockId: (p.landblockId >>> 0), isAnimatedScenery: true, isTreeWind: true };
  placeNode(node, p);

  const parts = [];
  const partBoxes = [];
  for (let i = 0; i < partCount; i++) {
    const partGroup = new THREE.Group();
    partGroup.name = `part${i}`;
    let localBox = null;
    const wasmMesh = partMeshes[i];
    if (wasmMesh) {
      try {
        const { groups, surfaceDids } = meshToGeometryGroups(wasmMesh);
        softenCanopyGroups(groups);
        for (let g = 0; g < (groups?.length || 0); g++) {
          const grp = groups[g];
          const sid = grp.surfaceDid || surfaceDids?.[g] || 0;
          // eslint-disable-next-line no-await-in-loop
          const mat = await materialCache.get(sid, spFetch);
          if (grp.geometry && mat) {
            partGroup.add(new THREE.Mesh(grp.geometry, mat));
            const pos = grp.geometry.getAttribute?.("position")?.array;
            if (pos && pos.length) {
              const bb = partBBox(pos);
              localBox = localBox ? _unionBox(localBox, bb) : bb;
            }
          }
        }
      } catch (e) {
        console.warn(`[tree-wind] part ${i} mesh build failed:`, e);
      }
      wasmMesh.free?.();
    }
    // Re-center the union box (the _unionBox merge left cx/cy/cz stale).
    if (localBox) {
      localBox.cx = (localBox.minX + localBox.maxX) / 2;
      localBox.cy = (localBox.minY + localBox.maxY) / 2;
      localBox.cz = (localBox.minZ + localBox.maxZ) / 2;
    }
    partBoxes.push(localBox || partBBox(null));
    node.add(partGroup);
    parts.push(partGroup);
  }

  let rig = _windRigCache.get(setupId);
  if (!rig) {
    rig = buildBboxRig(partBoxes, hinge).rigs;
    _windRigCache.set(setupId, rig);
  }
  return { node, parts, rig, partCount };
}

/**
 * Entry point — build animated wind nodes for tree placements peeled out of the
 * frozen statics bake (statics.js, when ?treeWind=on). No-op when the flag is
 * off, the pkg predates fetchBuildingPlacement, or nothing qualifies. Fail-soft,
 * capped, deduped.
 *
 * P4.3 coverage-gated peel fallback — returns `{built:number, failed:Placement[]}`.
 * `failed` carries the ORIGINAL placement objects (the same ones peeled from
 * `statics`) for every placement that could NOT be turned into a live wind node
 * (build returned null/threw, group degenerate, or over the animated cap). The
 * caller (statics.js) re-adds `failed` to the FROZEN instanced path so a missed
 * wind clip yields a STATIC tree, never a vanished one. When every build
 * succeeds `failed` is empty ⇒ the frozen path is untouched ⇒ byte-identical.
 * The guard early-returns keep `failed` empty (they did nothing before, so they
 * peel nothing back — the off-trace stays [R] byte-identical).
 */
export async function attachWindTrees(scene3d, placements, wasmExports, opts) {
  // 2026-06-27 vanished-trees fix: the statics.js peel removes trees from the
  // FROZEN path under `treeWindEnabled() || visualEnabled()` (visual is default-ON),
  // but this builder previously bailed on `!treeWindEnabled()` and returned an EMPTY
  // `failed`, so the peeled trees were neither animated NOR re-frozen → they vanished.
  // Match this gate to the peel gate so the default (visual-on) path actually builds
  // the wind trees; the can't-build guards below now re-freeze via `failed: placements`
  // so a tree is at worst STATIC, never gone.
  if (!treeWindEnabled() && !visualEnabled()) return { built: 0, failed: [] };
  if (!scene3d?.staticsGroup || !Array.isArray(placements) || !wasmExports) return { built: 0, failed: [] };
  if (typeof wasmExports.fetchBuildingPlacement !== "function") return { built: 0, failed: placements }; // pre-rebuild → re-freeze static
  if (placements.length === 0) return { built: 0, failed: [] };
  _rafDisposed = false; // re-arm after a prior dispose if scenery loads again.

  const resolveParent = (typeof opts?.resolveParent === "function") ? opts.resolveParent : null;
  const { getOrCreateMaterialCache } = await import("./statics.js");
  const materialCache = getOrCreateMaterialCache(scene3d);
  if (!materialCache) return { built: 0, failed: placements }; // re-freeze static, don't vanish
  const spFetch = surfacePixelsFetcher(wasmExports);

  const K = Math.max(1, (opts?.phaseBuckets | 0) || 4);
  const windBase = { dirDeg: treeWindDir(), strength: treeWindStrength() };

  // P4.3 fetch-not-synthesize flip (?windBake=on, DEFAULT-OFF). Construct the suite
  // source + init its base URL ONLY under windBakeEnabled() so the off-trace never
  // touches suite_assets.js (no SuiteAssetSource, no ensureSuiteInit, no fetch → [R]).
  const useBake = windBakeEnabled();
  const suite = useBake ? _getSuiteSource(wasmExports) : null;
  if (suite) {
    ensureSuiteInit(wasmExports);
    // §B.5 — baked clips are dir/strength-AUTHORITATIVE (Option A, §0.2): the header
    // carries no per-param echo, so dirDeg/strength are frozen into the baked frames.
    // The ?treeWindDir/?treeWindStrength URL knobs are therefore INERT under
    // windBake=on; warn ONCE so a knob can't silently desync the consumed clip.
    if (!_windBakeInertWarned && (treeWindDir() !== 135 || treeWindStrength() !== 1)) {
      _windBakeInertWarned = true;
      console.warn("[tree-wind] windBake=on: ?treeWindDir/?treeWindStrength are INERT " +
        "(baked clips are dir/strength-authoritative, baked at 135/1); the URL knobs do not " +
        "affect the consumed sway.");
    }
    // §B.2 pre-warm — kick all distinct setupId fetches once before the build loop so
    // the suite cache is warm by the next LB load (shrinks the one-load-frozen window).
    const warmed = new Set();
    for (const p of placements) {
      const sid = (p.modelId ?? p.objId ?? 0) >>> 0;
      if (sid !== 0 && !warmed.has(sid)) { warmed.add(sid); suite.get(sid, "windclip"); }
    }
  }

  let built = 0;
  let dropped = 0;
  // P4.3 — placements that could NOT become a live wind node. Each entry is the
  // ORIGINAL peeled placement `p`; statics.js re-freezes these so none vanish.
  const failed = [];
  // Build NEAREST-to-player first: if the cap is hit, only the FARTHEST trees drop (→ re-frozen),
  // so whatever you're standing next to always animates. Player pos ≈ the follow camera (AC Z-up world XY).
  let order = placements;
  try {
    const cp = (typeof window !== "undefined" &&
      (window.liveScene3d?.camera || window.liveScene3d?.activeCamera)?.position) || null;
    if (cp) {
      const wx = (p) => p.worldFrame ? (p.x || 0) : (((p.landblockId >>> 24) & 0xff) * METERS_PER_LANDBLOCK + (p.x || 0));
      const wy = (p) => p.worldFrame ? (p.y || 0) : (((p.landblockId >>> 16) & 0xff) * METERS_PER_LANDBLOCK + (p.y || 0));
      order = [...placements].sort((a, b) =>
        ((wx(a) - cp.x) ** 2 + (wy(a) - cp.y) ** 2) - ((wx(b) - cp.x) ** 2 + (wy(b) - cp.y) ** 2));
    }
  } catch (_) { order = placements; }
  for (const p of order) {
    const key = "w:" + placementKey(p);
    if (_builtKeys.has(key)) continue;
    if (_instances.length >= maxAnimated()) { failed.push(p); dropped += 1; continue; }
    _builtKeys.add(key);
    // eslint-disable-next-line no-await-in-loop
    const r = await buildOneWind(p, wasmExports, materialCache, spFetch).catch((e) => {
      console.warn("[tree-wind] buildOneWind threw:", e);
      return null;
    });
    if (!r) { _builtKeys.delete(key); failed.push(p); continue; }

    const setupId = (p.modelId ?? p.objId ?? 0) >>> 0;
    // Deterministic per-instance phase bucket → masks forest lockstep without a
    // per-instance mixer (instances within a bucket still share one driver).
    const bucket = Math.floor(hash01(key) * K) % K;
    const groupKey = `wind:0x${setupId.toString(16)}:${bucket}`;
    const windParams = { ...windBase, phaseOffset: (bucket / K) * 2 * Math.PI };
    // P4.3 — baked (ON) vs synth (OFF, UNCHANGED). The two branches are kept separate
    // (no synth-fallback-inside-ON) so a null/cold suite never builds a synth group that
    // _didGroups would then never replace once the suite warms (the D3 lazy-replace
    // hazard). Under ON, a loading/absent/part-count-mismatched clip → failed.push(p) →
    // statics.js re-freezes this LB's tree; the next LB load animates from the warm bake.
    let g;
    if (useBake) {
      const clip = suite.get(setupId, "windclip"); // sync; null while loading/absent/un-baked
      // PARAM-DRIFT GUARD (§B.3): a baked clip's part count MUST equal the runtime's material-gated
      // part count, else the frame-major frames address the wrong parts — treat a mismatch as a miss.
      if (clip && clip.numParts === r.partCount) {
        g = getOrCreateWindGroup(groupKey, clip.numParts, r.rig, windParams,
          { frames: clip.bucketFrames(bucket), numFrames: clip.numFrames, fps: clip.fps });
      } else {
        // SYNTH FALLBACK (2026-06-26, user: "include many more species"): no baked clip yet
        // (un-baked species, cold cache, or part-count drift) → SYNTHESIZE from the live rig so
        // the tree still sways instead of re-freezing. Synth ≈ bake (the bake IS bit-copied synth),
        // so this is visually equivalent; it also kills the one-load-frozen cold-cache window.
        // The old "re-freeze and wait for the warm bake" purity is traded for "always animate".
        g = getOrCreateWindGroup(groupKey, r.partCount, r.rig, windParams);
      }
    } else {
      g = getOrCreateWindGroup(groupKey, r.partCount, r.rig, windParams);
    }
    if (!g) { _builtKeys.delete(key); failed.push(p); continue; }

    const parent = (resolveParent && resolveParent(p)) || scene3d.staticsGroup;
    parent.add(r.node);
    g.refCount += 1;
    _instances.push({ node: r.node, parts: r.parts, animId: groupKey, key });
    if (animSceneryGateEnabled()) _gateTrack(_instances[_instances.length - 1]);
    _ensureRaf();
    built += 1;
  }
  if (built > 0 || dropped > 0) {
    console.log(`[tree-wind] built ${built} wind-tree instances across ${_didGroups.size} groups` +
      (dropped > 0 ? `; DROPPED ${dropped} over the ${maxAnimated()} cap (?animSceneryMax) → re-frozen` : ""));
  }
  return { built, failed };
}

// Diag counters (probe via animatedSceneryDiag() during a local A/B).
let _tickCalls = 0;
let _lastDt = -1;

// Self-managed rAF driver (mirrors statics.js `_spLoop`). loop.js's per-frame
// `dt` arrives as 0 on the net-drain path, so animated scenery drives its own
// clock off `performance.now()`. Armed when the first instance registers.
let _rafId = 0;
let _rafLastMs = 0;
let _rafDisposed = false;
// Film mode (2026-10-13, ?filmMode=on, DEFAULT OFF): film/runtime/film_clock.js
// routes this clock through the film clock for a stepped take
// (`setSceneryTimeSource(() => filmMs)`), so sway advances by film time — 0
// while the film clock is paused between steps — and restores it with null.
// Never called with the flag off: `_nowMs()` is performance.now() as before.
// The rAF still paces the reads, so film time that advances by more than the
// 0.1 s dt clamp between two rAF callbacks is clamped like a wall-clock stall.
let _sceneryTimeSource = null;
/**
 * @param {(() => number)|null} fn  ms clock for the private rAF driver, or null
 *   for performance.now(). A throwing / non-finite source falls back to it.
 *   Each swap re-bases the driver's last-frame stamp on the new clock, so the
 *   first dt after a swap measures the new clock only (no clamped 0.1 s jump
 *   and no frozen frame from comparing two unrelated time bases).
 */
export function setSceneryTimeSource(fn) {
  if (fn !== null && fn !== undefined && typeof fn !== "function") {
    throw new TypeError("setSceneryTimeSource: expected a function or null");
  }
  _sceneryTimeSource = fn || null;
  _rafLastMs = _nowMs();
}
function _nowMs() {
  if (_sceneryTimeSource !== null) {
    let t = NaN;
    try { t = _sceneryTimeSource(); } catch (_) { t = NaN; }
    if (Number.isFinite(t)) return t;
  }
  return (typeof performance !== "undefined" && performance.now)
    ? performance.now() : _rafLastMs + 16;
}
function _disposeDidGroup(animId) {
  const g = _didGroups.get(animId);
  if (!g) return;
  try { g.mixer.stopAllAction(); } catch (_) {}
  if (g._rust) { rustAnimUnregisterGroup(g); _rustGroupCount -= 1; }
  _didGroups.delete(animId);
}
function _ensureRaf() {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
  if (_rafId || _rafDisposed) return;
  _rafLastMs = _nowMs();
  const loop = () => {
    if (_rafDisposed) { _rafId = 0; return; }
    const now = _nowMs();
    const dt = Math.min(0.1, Math.max(0, (now - _rafLastMs) / 1000)); // clamp 0..0.1s
    _rafLastMs = now;
    _tickCalls += 1;
    _lastDt = dt;
    _poseFrame += 1;
    _parkedMemo.clear();
    // Advance each SHARED DID mixer ONCE (a handful, not one-per-placement),
    // and its retail SetOmega orbit (?animSceneryOmega); ?animSceneryGpu: one
    // pose-table row per (DID, part) instead of a matrix per instance slot.
    // (?rustAnimScenery: all of it in one kernel call.)
    _advanceDidGroups(dt);
    // ?rustAnimSceneryGate: the per-instance gate reads memoised parent-chain
    // and landblock answers (same answers, see `_gateOrphaned`).
    const gate = animSceneryGateEnabled();
    let gx = false;    // the flat state is in sync with _instances
    let skip = false;  // ...and no anchor was re-attached since the last loop
    if (gate) {
      gx = _gxLen === _instances.length;
      skip = gx && !_gateAddedSince;
      _gateAddedSince = false;
      if (!skip) _gateStats.fullPasses += 1;
    }
    // Distance tick-cull: only COPY the animated pose onto instances within the
    // camera radius (now 800 m — distant sway is wanted); beyond it they freeze.
    const radSq = tickRadiusSq();
    let camPos = null;
    if (radSq !== Infinity && typeof window !== "undefined") {
      const cam = window.liveScene3d?.camera || window.liveScene3d?.activeCamera || null;
      camPos = (cam && cam.position) || null;
    }
    // Frame-parity scratch for the distance cull below. `inst.node.position`
    // is AC-frame (placeNode stores LB-absolute AC coords); `camPos` is a
    // three.js-frame vector (camera.js sets it via acToThree). They must be
    // compared in ONE frame or the cull sees a bogus ~34 km gap at every real
    // Dereth location and freezes every prop in its bind pose. Mirror the audio
    // listener-sync fix (index.js D4-NEW-1): rotate the node into three-frame.
    const acThreeScratch = new THREE.Vector3();
    // Iterate backwards so we can splice evicted instances in place.
    for (let i = _instances.length - 1; i >= 0; i--) {
      if (skip && _gxState[i] === GX_STABLE) {
        // ?rustAnimSceneryGate: detached + parked + collapsed last frame and
        // no 'added' since — the loop below would do nothing for it.
        const rec = _lbRecList[_gxLb[i]];
        if (rec.stamp !== _poseFrame) {
          rec.parked = _isParkedLbId(rec.lb);
          rec.stamp = _poseFrame;
          _gateStats.lbQueries += 1;
        }
        if (rec.parked) { _gateStats.stableSkips += 1; continue; }
      }
      const inst = _instances[i];
      if (gx) _gxState[i] = 0;
      if (gate ? _gateOrphaned(inst) : _isOrphaned(inst.node)) {
        // Detached ≠ evicted under warm-park: the pool still intends to
        // re-attach this node. Skip it (it is invisible and un-posed while
        // parked) and reclaim on the tick after the pool true-disposes it.
        // See `_isParkedLb`.
        if (gate ? _gateParked(inst) : _isParkedLbMemo(inst.node)) {
          if (inst.instanced) _collapseInstanced(inst);
          if (gx && inst._gp === null && inst._lbRec) _gxState[i] = GX_STABLE;
          continue;
        }
        if (inst.instanced) _reclaimInstancedSlots(inst); // shared geometry — reclaim slots, dispose nothing
        try { inst.node.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); }); } catch (_) {}
        _builtKeys.delete(inst.key);
        _instances.splice(i, 1);
        if (gx) {
          _gxState.copyWithin(i, i + 1, _gxLen);
          _gxLb.copyWithin(i, i + 1, _gxLen);
          _gxLen -= 1;
        }
        const g = _didGroups.get(inst.animId);
        if (g && --g.refCount <= 0) _disposeDidGroup(inst.animId);
        continue;
      }
      if (inst.instanced) {
        if (!(gate ? _gateAnchorVisible(inst) : _anchorVisible(inst.node))) { _collapseInstanced(inst); continue; }
        if (inst.collapsed) {
          // Showing again: restore the pose now, even past the distance cull
          // below (which would otherwise leave it collapsed indefinitely).
          inst.collapsed = false;
          _collapseStats.restores += 1;
          for (const s of inst.slots) s.bucket.active += 1;
          const g0 = _didGroups.get(inst.animId);
          if (g0) _writeInstancedPose(inst, g0, true);
        }
        // ?animSceneryGpu: every slot is GPU-posed — nothing to write per frame
        // (and no distance cull: the shared row animates them all).
        if (inst.cpuSlots === 0) continue;
      }
      if (camPos) {
        const p = inst.node.position;
        const [tx, ty, tz] = acToThree(p.x, p.y, p.z);
        acThreeScratch.set(tx, ty, tz);
        if (acThreeScratch.distanceToSquared(camPos) > radSq) continue;
      }
      const g = _didGroups.get(inst.animId);
      if (!g) continue;
      if (inst.instanced) { _writeInstancedPose(inst, g); continue; }
      if (g.omega && inst.baseQuat) inst.node.quaternion.copy(g.orbitQ).multiply(inst.baseQuat);
      const n = Math.min(g.parts.length, inst.parts.length);
      for (let j = 0; j < n; j++) {
        inst.parts[j].position.copy(g.parts[j].position);
        inst.parts[j].quaternion.copy(g.parts[j].quaternion);
      }
    }
    _flushDirtyBuckets();
    _applyBucketVisibility();
    syncAnimInstMaterials();
    _rafId = window.requestAnimationFrame(loop);
  };
  _rafId = window.requestAnimationFrame(loop);
}

/** Manual per-frame advance (tests / external drivers). The live app uses the
 *  self-managed rAF. Advances shared mixers + copies onto ALL instances. */
export function tickAnimatedScenery(dt) {
  const d = Number.isFinite(dt) ? dt : 0;
  _poseFrame += 1;
  _advanceDidGroups(d);
  for (const inst of _instances) {
    const g = _didGroups.get(inst.animId);
    if (!g) continue;
    if (inst.instanced) { _writeInstancedPose(inst, g); continue; }
    if (g.omega && inst.baseQuat) inst.node.quaternion.copy(g.orbitQ).multiply(inst.baseQuat);
    const n = Math.min(g.parts.length, inst.parts.length);
    for (let j = 0; j < n; j++) {
      inst.parts[j].position.copy(g.parts[j].position);
      inst.parts[j].quaternion.copy(g.parts[j].quaternion);
    }
  }
  _flushDirtyBuckets();
  _applyBucketVisibility();
  syncAnimInstMaterials();
}

/** Test seam (tools/rust_parity/gen_anim_scenery.mjs): the live shared
 *  drivers, keyed by animation DID (wind groups by their string key).
 *  Read-only by convention. */
export function __animSceneryGroupsForTest() {
  return _didGroups;
}

/** Diagnostic snapshot for the local visual A/B. */
export function animatedSceneryDiag() {
  let maxTime = 0;
  for (const g of _didGroups.values()) {
    // ?rustAnimScenery: a kernel-held group's mixer is not advanced.
    const t = g._rust ? rustAnimMixerTime(g) : g.mixer.time;
    if (t > maxTime) maxTime = t;
  }
  let instanced = 0;
  for (const inst of _instances) if (inst.instanced) instanced += 1;
  let orbitingDids = 0;
  for (const g of _didGroups.values()) if (g.omega) orbitingDids += 1;
  let gpuBuckets = 0;
  for (const b of _bucketList) if (b.gpu) gpuBuckets += 1;
  return {
    instances: _instances.length,
    instanced,
    orbitingDids,
    buckets: _bucketList.length,
    gpuBuckets,
    gpu: animSceneryGpuDiag(),
    bucketsVisible: _bucketList.reduce((n, b) => n + (b.mesh.visible ? 1 : 0), 0),
    bucketsActive: _bucketList.reduce((n, b) => n + (b.active > 0 ? 1 : 0), 0),
    didGroups: _didGroups.size,
    tickCalls: _tickCalls,
    lastDt: _lastDt,
    maxMixerTime: maxTime,
    rafArmed: _rafId !== 0,
    // ?animSceneryUnbake: setups/parts whose baked frame is undone, and where
    // U came from (fetchSetupPartPose vs the hinge fallback).
    unbake: { enabled: animSceneryUnbakeEnabled(), ..._unbakeStats, cachedPoses: _bakePoseCache.size },
    ...(rustAnimSceneryEnabled() ? { rustAnimScenery: { ...rustAnimSceneryStats(), groupsHeld: _rustGroupCount } } : {}),
    ...(animSceneryGateEnabled() ? { gate: { ..._gateStats } } : {}),
  };
}

/**
 * Diag (vistest): how one setup is animated — live instances, and per part
 * whether its baked frame is undone (`?animSceneryUnbake`). The windmill sails
 * 0x020003E5 read `{ instances: 2, unbakeParts: [true,true,true,true,true] }`
 * at landblock 0x8093 (the bake is anim 0x0300061B frame 0, where even the hub,
 * part 1, sits at the origin but already turned 1.5 deg; via fetchSetupPartPose
 * the same frame). Only an identity bake frame reads false.
 */
export function animatedScenerySetupDiag(setupId) {
  const sid = setupId >>> 0;
  let instances = 0;
  const name = `anim-scenery-0x${sid.toString(16)}`;
  for (const inst of _instances) if (inst.node?.name === name) instances += 1;
  const u = _unbakeBySetup.get(sid);
  return { setupId: `0x${sid.toString(16)}`, instances, unbakeParts: u ? u.slice() : null };
}
if (typeof window !== "undefined") {
  try {
    window.__animSceneryDiag = animatedSceneryDiag;
    window.__animScenerySetup = animatedScenerySetupDiag;
  } catch (_) { /* frozen window: diag only */ }
}

/** Tear down all animated scenery (full scene dispose). */
export function disposeAnimatedScenery(_scene3d) {
  _rafDisposed = true;
  if (_rafId && typeof window !== "undefined" && window.cancelAnimationFrame) {
    try { window.cancelAnimationFrame(_rafId); } catch (_) {}
  }
  _rafId = 0;
  for (const inst of _instances) {
    try {
      inst.node.parent?.remove(inst.node);
      inst.node.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
    } catch (_) {}
  }
  for (const g of _didGroups.values()) {
    try { g.mixer.stopAllAction(); } catch (_) {}
    if (g._rust) rustAnimUnregisterGroup(g);
  }
  _instances.length = 0;
  _didGroups.clear();
  _builtKeys.clear();
  rustAnimReset();
  _rustGroupCount = 0;
  _lbRecs.clear();
  _lbRecList.length = 0;
  _gxLen = 0;
  _gateAddedSince = false;
  // Instanced buckets + shared geometry (module-owned, never per-instance).
  for (const b of _bucketList) {
    try { b.mesh.parent?.remove(b.mesh); b.mesh.dispose(); } catch (_) {}
  }
  _bucketList.length = 0;
  _buckets.clear();
  _dirtyBuckets.clear();
  _dirtySpan.clear();
  for (const g of _geomList) {
    try { g.dispose?.(); } catch (_) {}
  }
  _geomList.length = 0;
  _geomCache.clear();
  _windRigCache.clear();
  _bakePoseCache.clear();
  _unbakeBySetup.clear();
  disposeAnimSceneryGpu();
}

// ── INERT diag surface (P4.3 rig byte-identity proof) ────────────────────────
// Read-only mirror of the runtime per-setupId rig cache, for the producer's
// OQ-2 rig-verify pass (tools/bake-windclips.mjs step 7): after one
// attachWindTrees pass with ?treeWind=on, window.__dumpWindRig(did) returns the
// exact `_windRigCache.get(did)` (buildBboxRig().rigs) the live path produced so
// it can be diffed bit-for-bit against the producer's re-composed rig. Guarded
// like the other window.__* diag surfaces; attaches a single read-only function
// and mutates no module state → zero behavior change whether ?treeWind is on or
// off. Returns null for an un-cached DID. Deep-cloned so callers cannot poke the
// live cache entry.
if (typeof window !== "undefined") {
  window.__dumpWindRig = (did) => {
    const rig = _windRigCache.get((did >>> 0));
    if (!rig) return null;
    try {
      return JSON.parse(JSON.stringify(rig));
    } catch (_) {
      return null;
    }
  };
}
