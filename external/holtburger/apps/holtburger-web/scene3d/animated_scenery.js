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
import { meshToGeometryGroups } from "./adapter.js";
import { surfacePixelsFetcher } from "./bake_worker_client.js";

const METERS_PER_LANDBLOCK = 192.0;
const DEFAULT_ANIM_FPS = 30.0;
const DEFAULT_MAX_ANIMATED = 512;
const DEFAULT_TICK_RADIUS_M = 140.0;
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
 * @returns {object|null} THREE.AnimationClip, or null if degenerate
 */
export function buildSceneryAnimationClip(THREE_, frames, numParts, numFrames, fps) {
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
  const duration = Math.max(dt, (numFrames - 1) * dt);
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
  anim.free?.();
  if (numParts <= 0 || numFrames <= 0) return null;
  const clip = buildSceneryAnimationClip(THREE, frames, numParts, numFrames, animSceneryFps());
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
  const group = { mixer, template, parts, numParts, refCount: 0 };
  _didGroups.set(animId, group);
  return group;
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

  const didGroup = await getOrCreateDidGroup(animId, wasmExports);
  if (!didGroup) return null;

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
 * for interior visibility gating). Returns the count built.
 */
export async function attachAnimatedScenery(scene3d, placements, wasmExports, opts) {
  if (!animSceneryEnabled()) return 0;
  if (!scene3d?.staticsGroup || !Array.isArray(placements) || !wasmExports) return 0;
  if (typeof wasmExports.fetchAnimation !== "function"
      || typeof wasmExports.fetchBuildingPlacement !== "function") {
    return 0; // pre-rebuild pkg — soft-degrade to frozen.
  }
  const scripted = placements.filter((p) => ((p?.defaultAnimationId >>> 0) || 0) !== 0);
  if (scripted.length === 0) return 0;
  _rafDisposed = false; // re-arm after a prior dispose if scenery loads again.

  const resolveParent = (typeof opts?.resolveParent === "function") ? opts.resolveParent : null;
  const { getOrCreateMaterialCache } = await import("./statics.js");
  const materialCache = getOrCreateMaterialCache(scene3d);
  if (!materialCache) return 0;
  const spFetch = surfacePixelsFetcher(wasmExports);

  let built = 0;
  let dropped = 0;
  for (const p of scripted) {
    const key = placementKey(p);
    if (_builtKeys.has(key)) continue;
    if (_instances.length >= maxAnimated()) { dropped += 1; continue; }
    _builtKeys.add(key);
    // eslint-disable-next-line no-await-in-loop
    const r = await buildOne(p, wasmExports, materialCache, spFetch).catch((e) => {
      console.warn("[anim-scenery] buildOne threw:", e);
      return null;
    });
    if (r) {
      const parent = (resolveParent && resolveParent(p)) || scene3d.staticsGroup;
      parent.add(r.node);
      const g = _didGroups.get(r.animId);
      if (g) g.refCount += 1;
      _instances.push({ node: r.node, parts: r.parts, animId: r.animId, key });
      _ensureRaf();
      built += 1;
    } else {
      _builtKeys.delete(key); // allow retry on a later bake.
    }
  }
  if (built > 0 || dropped > 0) {
    console.log(`[anim-scenery] built ${built} instances across ${_didGroups.size} anim DIDs` +
      (dropped > 0 ? `; DROPPED ${dropped} over the ${maxAnimated()} cap (?animSceneryMax)` : ""));
  }
  return built;
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
    // Advance each SHARED DID mixer ONCE (a handful, not one-per-placement).
    for (const g of _didGroups.values()) {
      try { g.mixer.update(dt); } catch (_) {}
    }
    // Distance tick-cull (task #10): only COPY the animated pose onto instances
    // within the radius of the camera; far ones freeze (imperceptible at range).
    const radSq = tickRadiusSq();
    let camPos = null;
    if (radSq !== Infinity && typeof window !== "undefined") {
      const cam = window.liveScene3d?.camera || window.liveScene3d?.activeCamera || null;
      camPos = (cam && cam.position) || null;
    }
    // Iterate backwards so we can splice evicted instances in place.
    for (let i = _instances.length - 1; i >= 0; i--) {
      const inst = _instances[i];
      if (_isOrphaned(inst.node)) {
        try { inst.node.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); }); } catch (_) {}
        _builtKeys.delete(inst.key);
        _instances.splice(i, 1);
        const g = _didGroups.get(inst.animId);
        if (g && --g.refCount <= 0) _disposeDidGroup(inst.animId);
        continue;
      }
      if (camPos && inst.node.position.distanceToSquared(camPos) > radSq) continue;
      const g = _didGroups.get(inst.animId);
      if (!g) continue;
      const n = Math.min(g.parts.length, inst.parts.length);
      for (let j = 0; j < n; j++) {
        inst.parts[j].position.copy(g.parts[j].position);
        inst.parts[j].quaternion.copy(g.parts[j].quaternion);
      }
    }
    _rafId = window.requestAnimationFrame(loop);
  };
  _rafId = window.requestAnimationFrame(loop);
}

/** Manual per-frame advance (tests / external drivers). The live app uses the
 *  self-managed rAF. Advances shared mixers + copies onto ALL instances. */
export function tickAnimatedScenery(dt) {
  const d = Number.isFinite(dt) ? dt : 0;
  for (const g of _didGroups.values()) {
    try { g.mixer.update(d); } catch (_) {}
  }
  for (const inst of _instances) {
    const g = _didGroups.get(inst.animId);
    if (!g) continue;
    const n = Math.min(g.parts.length, inst.parts.length);
    for (let j = 0; j < n; j++) {
      inst.parts[j].position.copy(g.parts[j].position);
      inst.parts[j].quaternion.copy(g.parts[j].quaternion);
    }
  }
}

/** Diagnostic snapshot for the local visual A/B. */
export function animatedSceneryDiag() {
  let maxTime = 0;
  for (const g of _didGroups.values()) if (g.mixer.time > maxTime) maxTime = g.mixer.time;
  return {
    instances: _instances.length,
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
}
