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
    // Advance each SHARED DID mixer ONCE (a handful, not one-per-placement).
    for (const g of _didGroups.values()) {
      try { g.mixer.update(dt); } catch (_) {}
    }
    // Distance tick-cull: only COPY the animated pose onto instances within the
    // camera radius (now 800 m — distant sway is wanted); beyond it they freeze.
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
