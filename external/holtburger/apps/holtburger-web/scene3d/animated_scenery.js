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
// so part AFrames apply with no handedness conversion.
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
  _didGroups.set(animId, group);
  return group;
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
    if (h) {
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
          if (grp.geometry && mat) partGroup.add(new THREE.Mesh(grp.geometry, mat));
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
function _getSharedSetupGeom(setupId, wasmExports) {
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
          return { partCount: pr.parts.length, parts, hingeMats };
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
    return { partCount, parts, hingeMats };
  })();
  _geomCache.set(setupId, p);
  return p;
}

function _getOrCreateBucket(scene3d, setupId, partIdx, gIdx, geometry, surfaceDid, materialCache, spFetch) {
  const key = `${setupId}:${partIdx}:${gIdx}`;
  let p = _buckets.get(key);
  if (p) return p;
  p = (async () => {
    const mat = await materialCache.get(surfaceDid, spFetch);
    if (!mat) return null;
    const mesh = new THREE.InstancedMesh(geometry, mat, 128);
    mesh.count = 0;
    mesh.name = `anim-inst-0x${setupId.toString(16)}-p${partIdx}-g${gIdx}`;
    mesh.userData = { isAnimatedSceneryInstanced: true }; // no landblockId → LRU never evicts
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene3d.staticsGroup.add(mesh);
    const bucket = { mesh, members: [], capacity: 128 };
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
    const parent = old.parent;
    if (parent) { parent.add(nm); parent.remove(old); }
    old.dispose(); // frees old instance buffers only — geometry/material shared
    bucket.mesh = nm;
    bucket.capacity = cap;
  }
  const index = bucket.members.length;
  bucket.members.push(inst);
  bucket.mesh.count = bucket.members.length;
  return index;
}

/** Instanced sibling of buildOne: anchor Group + slots instead of part Meshes. */
async function buildOneInstanced(p, scene3d, wasmExports, materialCache, spFetch) {
  const setupId = (p.objId ?? p.obj_id ?? p.modelId ?? 0) >>> 0;
  const animId = (p.defaultAnimationId >>> 0);
  if (setupId === 0 || animId === 0) return null;
  // Shared geometry FIRST — see the invariant in buildOne: a `_didGroups` entry
  // created before a `return null` is an unreclaimable per-frame mixer.
  const shared = await _getSharedSetupGeom(setupId, wasmExports);
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
    for (let g = 0; g < groups.length; g++) {
      // eslint-disable-next-line no-await-in-loop
      const bucket = await _getOrCreateBucket(scene3d, setupId, i, g, groups[g].geometry, groups[g].surfaceDid, materialCache, spFetch);
      if (!bucket) continue;
      const index = _registerSlot(bucket, inst);
      _instScratch.multiplyMatrices(inst.nodeMat, shared.hingeMats[i]); // rest pose until first tick
      bucket.mesh.setMatrixAt(index, _instScratch);
      // Record the span too, so a same-frame span flush on this bucket still
      // covers the new slot (perf T9); needsUpdate stays for an immediate
      // whole-buffer upload if a render lands before the next flush.
      _markDirty(bucket, index);
      bucket.mesh.instanceMatrix.needsUpdate = true;
      inst.slots.push({ bucket, index, partIdx: i });
    }
  }
  return inst;
}

/** Per-frame slot write: template part poses composed once per DID per frame. */
function _writeInstancedPose(inst, g) {
  if (g._poseStamp !== _poseFrame) {
    if (!g._partMats) g._partMats = [];
    for (let j = 0; j < g.parts.length; j++) {
      (g._partMats[j] || (g._partMats[j] = new THREE.Matrix4()))
        .compose(g.parts[j].position, g.parts[j].quaternion, _UNIT3);
    }
    g._poseStamp = _poseFrame;
  }
  const nodeMat = _orbitNodeMatrix(inst, g);
  for (const s of inst.slots) {
    const pm = g._partMats[s.partIdx];
    if (!pm) continue;
    _instScratch.multiplyMatrices(nodeMat, pm);
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
function _nowMs() {
  return (typeof performance !== "undefined" && performance.now)
    ? performance.now() : _rafLastMs + 16;
}
function _disposeDidGroup(animId) {
  const g = _didGroups.get(animId);
  if (!g) return;
  try { g.mixer.stopAllAction(); } catch (_) {}
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
    // Advance each SHARED DID mixer ONCE (a handful, not one-per-placement),
    // and its retail SetOmega orbit (?animSceneryOmega).
    for (const g of _didGroups.values()) {
      try { g.mixer.update(dt); } catch (_) {}
      _advanceOrbit(g, dt);
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
      const inst = _instances[i];
      if (_isOrphaned(inst.node)) {
        // Detached ≠ evicted under warm-park: the pool still intends to
        // re-attach this node. Skip it (it is invisible and un-posed while
        // parked) and reclaim on the tick after the pool true-disposes it.
        // See `_isParkedLb`.
        if (_isParkedLb(inst.node)) {
          if (inst.instanced) _collapseInstanced(inst);
          continue;
        }
        if (inst.instanced) _reclaimInstancedSlots(inst); // shared geometry — reclaim slots, dispose nothing
        try { inst.node.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); }); } catch (_) {}
        _builtKeys.delete(inst.key);
        _instances.splice(i, 1);
        const g = _didGroups.get(inst.animId);
        if (g && --g.refCount <= 0) _disposeDidGroup(inst.animId);
        continue;
      }
      if (inst.instanced) {
        if (!_anchorVisible(inst.node)) { _collapseInstanced(inst); continue; }
        if (inst.collapsed) {
          // Showing again: restore the pose now, even past the distance cull
          // below (which would otherwise leave it collapsed indefinitely).
          inst.collapsed = false;
          _collapseStats.restores += 1;
          const g0 = _didGroups.get(inst.animId);
          if (g0) _writeInstancedPose(inst, g0);
        }
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
    _rafId = window.requestAnimationFrame(loop);
  };
  _rafId = window.requestAnimationFrame(loop);
}

/** Manual per-frame advance (tests / external drivers). The live app uses the
 *  self-managed rAF. Advances shared mixers + copies onto ALL instances. */
export function tickAnimatedScenery(dt) {
  const d = Number.isFinite(dt) ? dt : 0;
  _poseFrame += 1;
  for (const g of _didGroups.values()) {
    try { g.mixer.update(d); } catch (_) {}
    _advanceOrbit(g, d);
  }
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
}

/** Diagnostic snapshot for the local visual A/B. */
export function animatedSceneryDiag() {
  let maxTime = 0;
  for (const g of _didGroups.values()) if (g.mixer.time > maxTime) maxTime = g.mixer.time;
  let instanced = 0;
  for (const inst of _instances) if (inst.instanced) instanced += 1;
  let orbitingDids = 0;
  for (const g of _didGroups.values()) if (g.omega) orbitingDids += 1;
  return {
    instances: _instances.length,
    instanced,
    orbitingDids,
    buckets: _bucketList.length,
    didGroups: _didGroups.size,
    tickCalls: _tickCalls,
    lastDt: _lastDt,
    maxMixerTime: maxTime,
    rafArmed: _rafId !== 0,
  };
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
  }
  _instances.length = 0;
  _didGroups.clear();
  _builtKeys.clear();
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
