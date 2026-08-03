// scene3d/dismember.js — Phase 3 runtime destruction (?dismember — DEFAULT ON, =off escape).
//
// Runtime mesh slicing AND voronoi fracturing of a live entity's setup parts
// via @dgreenheck/three-pinata (vendor/dgreenheck/three-pinata.js, MIT).
//
// DEFAULT ON (owner flip 2026-08-02; comment corrected 2026-08-03 review F10).
// The reader below is `!== "off"`, and scene3d/index.js gates the dynamic
// import on the same shape — so an ABSENT param resolves ON and this module,
// the vendored slicer, `installDismemberDiag()` and the two window hooks
// (`__dismemberTransfer` / `__dismemberCorpseRestore`) all load on the bare
// default URL. Only `?dismember=off` skips the import and pays zero bytes.
// carnage.js pulls the same module in under its own default-ON flag.
//
// Primitives (all callable from window.__diag.dismember):
//   slicePart      plane cut → stump on the rig + severed limb as debris
//   fracturePart   voronoi shatter of a whole part → GIB (crit/finisher)
//   chipPart       impact-clustered voronoi, big fragments welded back onto the
//                  rig, small ones ejected → shell chips fly off mid-fight
//   dislocatePart  persistent joint offset (a few cm + up to ~25°), no sever —
//                  the creature keeps fighting with a limb hanging wrong
//   refractureDebrisNear  progressive destruction: LARGE resting chunks break
//                  down again (gen 0 → MAX_DEBRIS_GEN) when new blows land
//   restoreParts   undoes every one of the above (visual heal / teardown)
//
// Load-bearing facts this module is built on (recon 2026-08-02):
// - Entity part vertices are PART-LOCAL; the rest pose lives on the part
//   THREE.Group. Every part is a direct child of inst.root (flat rig).
// - pack_model_mesh de-indexes geometry, but duplicated positions are
//   BIT-IDENTICAL f32s (same SWVertex through the identity transform), so an
//   exact-equality weld reconstructs the original DAT topology — which is
//   watertight for the vast majority of creature parts (audited: 20/24
//   Olthoi Noble parts perfect, defects are 2-3 boundary edges).
// - Two-sided surfaces emit coincident duplicate back-face triangles; we drop
//   exact-duplicate triangles after welding instead of threading sideKinds
//   through the adapter.
// - Never reparent inst.parts[i]: the AnimationMixer's PropertyBindings hold
//   direct node refs. Stump swap = replace the part Group's CHILDREN in place
//   (same pattern as the appearance hot-swap, entities.js ~10278). Severed
//   debris = fresh meshes parented to entitiesGroup (AC frame, +Z up).
// - Part geometries are AnimationCache-shared across entities — NEVER mutate
//   or dispose them. Everything we create is tagged userData.__disposable.

import * as THREE from "three";

const FLAG = (() => {
  try {
    return new URLSearchParams(window.location.search).get("dismember") !== "off";
  } catch (_e) {
    return false;
  }
})();

export function dismemberEnabled() {
  return FLAG;
}

// Module-owned cap material for cut interiors ("flesh"). Deliberately NOT
// registered in MaterialCache, never tagged __cacheOwned, never disposed —
// same lifetime policy as play_effect_vfx.js's shared burst resources.
const _fleshMaterial = new THREE.MeshStandardMaterial({
  color: 0x6b1414,
  roughness: 0.9,
  metalness: 0.0,
  side: THREE.FrontSide,
});

let _pinataPromise = null;
function _loadPinata() {
  if (!_pinataPromise) _pinataPromise = import("@dgreenheck/three-pinata");
  return _pinataPromise;
}

/* ── exact weld + triangle dedupe ─────────────────────────────────────
 * Input: the part Group's child meshes (non-indexed BufferGeometry, one per
 * surface bucket). Output: one indexed BufferGeometry spanning all buckets,
 * welded by exact f32 position equality, coincident duplicate triangles
 * (double-sided back-face copies) dropped. Positions stay part-local.
 */
export function weldPartGeometry(meshes) {
  const keyToId = new Map();
  const positions = [];
  const normals = [];
  const uvs = [];
  const index = [];
  const seenTri = new Set();
  let srcTris = 0;
  let droppedDup = 0;

  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g?.getAttribute("position");
    if (!pos) continue;
    const nrm = g.getAttribute("normal");
    const uv = g.getAttribute("uv");
    const gIndex = g.getIndex();
    const cornerCount = gIndex ? gIndex.count : pos.count;
    const cornerIds = new Array(cornerCount);
    for (let c = 0; c < cornerCount; c++) {
      const v = gIndex ? gIndex.getX(c) : c;
      const x = pos.getX(v);
      const y = pos.getY(v);
      const z = pos.getZ(v);
      // Exact equality is intentional: duplicated verts are bit-identical.
      const key = x + "|" + y + "|" + z;
      let id = keyToId.get(key);
      if (id === undefined) {
        id = keyToId.size;
        keyToId.set(key, id);
        positions.push(x, y, z);
        normals.push(nrm ? nrm.getX(v) : 0, nrm ? nrm.getY(v) : 0, nrm ? nrm.getZ(v) : 1);
        uvs.push(uv ? uv.getX(v) : 0, uv ? uv.getY(v) : 0);
      }
      cornerIds[c] = id;
    }
    for (let c = 0; c + 2 < cornerCount; c += 3) {
      srcTris++;
      const a = cornerIds[c];
      const b = cornerIds[c + 1];
      const d = cornerIds[c + 2];
      if (a === b || b === d || a === d) continue; // degenerate
      const triKey = [a, b, d].sort((p, q) => p - q).join("_");
      if (seenTri.has(triKey)) {
        droppedDup++; // back-face duplicate of a two-sided surface
        continue;
      }
      seenTri.add(triKey);
      index.push(a, b, d);
    }
  }

  if (index.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(index);
  geom.userData.__disposable = true;
  geom.userData.__dismemberWeld = { srcTris, weldedVerts: keyToId.size, droppedDup };
  return geom;
}

/** Boundary/non-manifold edge audit of an indexed geometry (post-weld). */
export function auditGeometry(geom) {
  const idx = geom.getIndex();
  const edges = new Map();
  for (let i = 0; i + 2 < idx.count; i += 3) {
    const t = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
    for (let e = 0; e < 3; e++) {
      const a = t[e];
      const b = t[(e + 1) % 3];
      const k = a < b ? a + "_" + b : b + "_" + a;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const c of edges.values()) {
    if (c === 1) boundaryEdges++;
    else if (c > 2) nonManifoldEdges++;
  }
  return {
    tris: idx.count / 3,
    verts: geom.getAttribute("position").count,
    edges: edges.size,
    boundaryEdges,
    nonManifoldEdges,
    ...(geom.userData.__dismemberWeld || {}),
  };
}

/* ── debris registry (shape mirrors play_effect_vfx.js _activeBursts) ── */
const DEBRIS_TTL_MS = 20000;
const DEBRIS_GRAVITY = 9.8; // AC frame: -Z, m/s^2
// Raised from 24 for the gib path: one fracturePart() can spawn ~12 pieces, so
// a death gib plus leftovers from the fight must still fit without the LRU
// eating the fresh chunks. Hard ceiling stays modest (each piece is a draw
// call with its own tiny geometry).
const _MAX_ACTIVE_DEBRIS = 40;
/** Bounding-sphere radius (metres) at/above which a resting piece counts as
 *  "large": it registers with the ragdoll/blood environment and stays eligible
 *  for progressive re-fracture. Size, not tri count, is what decides whether a
 *  corpse can drape over a chunk — AC creature parts are 18-60 triangles, so a
 *  tri threshold would classify a whole severed leg as a chip. */
export const LARGE_DEBRIS_RADIUS = 0.18;
/** Below this many triangles there is nothing left worth re-fracturing. */
export const LARGE_DEBRIS_TRIS = 12;
/** Progressive destruction depth: gen 0 (sever/gib) → 1 → 2, then it stops. */
export const MAX_DEBRIS_GEN = 2;
const _activeDebris = new Set();
let _rafId = 0;
let _lastTickMs = 0;

function _entitiesGroup() {
  const ls = window.liveScene3d;
  return ls?.entitiesGroup || null;
}

function _triCountOf(geom) {
  const idx = geom?.getIndex?.();
  if (idx) return idx.count / 3;
  const pos = geom?.getAttribute?.("position");
  return pos ? pos.count / 3 : 0;
}

function _spawnDebris(mesh, opts) {
  const group = _entitiesGroup();
  if (!group) return false;
  if (_activeDebris.size >= _MAX_ACTIVE_DEBRIS) {
    // LRU: evict the oldest so a gib storm cannot grow unbounded.
    const oldest = _activeDebris.values().next().value;
    if (oldest) _disposeDebris(oldest);
  }
  group.add(mesh);
  const tris = _triCountOf(mesh.geometry);
  let size = 0;
  try {
    const g = mesh.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    size = (g.boundingSphere?.radius || 0) * Math.abs(mesh.scale?.x || 1);
  } catch (_e) { /* size stays 0 ⇒ treated as a chip */ }
  _activeDebris.add({
    mesh,
    startMs: performance.now(),
    vel: opts.vel, // THREE.Vector3, entitiesGroup-local (AC frame)
    omegaAxis: opts.omegaAxis, // unit THREE.Vector3
    omegaRad: opts.omegaRad, // rad/s
    floorZ: opts.floorZ,
    resting: false,
    tris,
    size,
    gen: opts.gen || 0,
    // "small" = a chip/late-generation shard: never registers with the
    // ragdoll/blood env, never re-fractures.
    small: !!opts.small || size < LARGE_DEBRIS_RADIUS,
    reported: false,
  });
  _ensureRaf();
  return true;
}

function _disposeDebris(entry) {
  _activeDebris.delete(entry);
  entry.mesh.parent?.remove(entry.mesh);
  if (entry.mesh.geometry?.userData?.__disposable) entry.mesh.geometry.dispose();
  // Materials are either cache-shared or the module flesh material — never ours.
}

const _tickQuat = new THREE.Quaternion();
function _tickDebris(nowMs) {
  _rafId = 0;
  const dt = Math.min(0.05, (nowMs - _lastTickMs) / 1000 || 0.016);
  _lastTickMs = nowMs;
  // Iterate the Set directly — no per-frame `[...spread]` copy. Safe: the only
  // mutation inside the loop is `_disposeDebris(entry)`, and Set iteration is
  // specified to tolerate deletion of the current / already-visited entry.
  // Nothing here ADDS to the set (spawns come from the slice/fracture paths).
  for (const entry of _activeDebris) {
    if (nowMs - entry.startMs > DEBRIS_TTL_MS) {
      _disposeDebris(entry);
      continue;
    }
    if (entry.resting) continue;
    entry.vel.z -= DEBRIS_GRAVITY * dt;
    entry.mesh.position.addScaledVector(entry.vel, dt);
    _tickQuat.setFromAxisAngle(entry.omegaAxis, entry.omegaRad * dt);
    entry.mesh.quaternion.premultiply(_tickQuat);
    if (entry.mesh.position.z <= entry.floorZ) {
      entry.mesh.position.z = entry.floorZ;
      if (entry.vel.z < -0.6) {
        // damped bounce; keep most horizontal motion so it skips then rolls
        entry.vel.z = -entry.vel.z * 0.3;
        entry.vel.x *= 0.8;
        entry.vel.y *= 0.8;
      } else {
        // GROUNDED: roll, don't stop dead. Rolling axis ⊥ travel (up × v)
        // so the spin reads as the piece rolling along its skid direction;
        // friction bleeds speed and spin together until it settles.
        entry.vel.z = 0;
        const sp = Math.hypot(entry.vel.x, entry.vel.y);
        if (sp > 1e-4) {
          entry.omegaAxis.set(-entry.vel.y / sp, entry.vel.x / sp, 0);
          entry.omegaRad = Math.max(entry.omegaRad * 0.985, sp * 3.0);
        }
        const fr = Math.pow(0.35, dt); // ground friction
        entry.vel.x *= fr;
        entry.vel.y *= fr;
        entry.omegaRad *= Math.pow(0.5, dt);
        if (sp < 0.06 && entry.omegaRad < 0.4) {
          entry.resting = true;
          _reportSettled(entry);
        }
      }
    }
  }
  _ensureRaf();
}

function _ensureRaf() {
  if (!_rafId && _activeDebris.size > 0) {
    _rafId = requestAnimationFrame(_tickDebris);
  }
}

/* ── settled-chunk interop (ragdoll_env + blood pools) ─────────────────
 * Both sides are OPTIONAL and feature-detected: this module never hard-imports
 * either one, so a build without them (or with them mid-edit) still severs and
 * gibs exactly the same. A big chunk at rest becomes (a) a body other ragdolls
 * drape over and (b) a spot that pools blood. Chips report neither.
 */
let _ragdollEnvPromise = null;
function _reportSettled(entry) {
  if (entry.small || entry.reported) return;
  entry.reported = true;
  const m = entry.mesh;
  // Deliberately small: a chunk is a bump in the floor, not a wall.
  const radius = Math.min(0.6, Math.max(0.3, entry.size || 0.4));
  // entitiesGroup-local IS the AC frame (+Z up), so the mesh position already
  // reads as AC x/y/z.
  const acX = m.position.x;
  const acY = m.position.y;
  const topZ = m.position.z + radius * 0.5;
  // registerSettledBody ALREADY feeds window.__bloodPools itself, so the pool
  // call here is the FALLBACK for when the env module is missing — calling
  // both unconditionally would burn two decals on one chunk.
  const pool = () => {
    try {
      window.__bloodPools?.(acX, acY, entry.floorZ, radius);
    } catch (_e) { /* blood module is optional */ }
  };
  try {
    if (!_ragdollEnvPromise) _ragdollEnvPromise = import("./ragdoll_env.js");
    _ragdollEnvPromise
      .then((mod) => {
        let ok = false;
        if (typeof mod?.registerSettledBody === "function") {
          try {
            ok = mod.registerSettledBody(acX, acY, topZ, radius) !== false;
          } catch (_e) { ok = false; }
        }
        if (!ok) pool();
      })
      .catch(pool);
  } catch (_e) {
    pool();
  }
}

/* ── slicing ──────────────────────────────────────────────────────────── */

const _mInv = new THREE.Matrix4();
const _m3 = new THREE.Matrix3();
const _vLocalPoint = new THREE.Vector3();
const _vLocalNormal = new THREE.Vector3();
const _vCentroid = new THREE.Vector3();

function _partMeshes(part) {
  return part.children.filter((c) => c.isMesh && c.geometry);
}

/**
 * Slice part `partIndex` of entity `inst` with a world-space plane, swap the
 * proximal fragment into the part Group in place (stump), spawn the distal
 * fragment as ballistic debris. Optionally also detaches the distal chain
 * parts (`opts.chainParts`) as extra debris pieces (hidden on the rig).
 * Returns a result object or null.
 */
export async function slicePart(inst, partIndex, planePointW, planeNormalW, opts = {}) {
  const part = inst?.parts?.[partIndex];
  if (!part) return null;
  const meshes = _partMeshes(part);
  if (meshes.length === 0) return null;

  const { DestructibleMesh, SliceOptions } = await _loadPinata();

  // Identity guard across the await (the R1#9 class): a despawn or same-guid
  // respawn during the pinata load leaves `inst` disposed — mutating its parts
  // would stash disposed originals and attach stumps to a detached rig.
  // dispose() detaches root from its parent, so `!root?.parent` ≡ disposed.
  if (inst._disposed || !inst.root?.parent) return null;

  const merged = weldPartGeometry(meshes);
  if (!merged) return null;

  // World plane → part-local. Root may carry non-uniform objScale, so the
  // normal goes through the inverse-transpose, not the matrix itself.
  part.updateWorldMatrix(true, false);
  _mInv.copy(part.matrixWorld).invert();
  _vLocalPoint.copy(planePointW).applyMatrix4(_mInv);
  _m3.getNormalMatrix(_mInv);
  _vLocalNormal.copy(planeNormalW).applyMatrix3(_m3).normalize();

  const outerMaterial = meshes[0].material;
  const destructible = new DestructibleMesh(merged, outerMaterial, _fleshMaterial);
  let pieces;
  try {
    pieces = destructible.slice(_vLocalNormal.clone(), _vLocalPoint.clone(), new SliceOptions());
  } catch (err) {
    console.warn("[dismember] slice failed:", err);
    merged.dispose();
    return null;
  }
  if (!pieces || pieces.length < 2) {
    // eslint-disable-next-line no-console
    console.debug("[dismember] slice produced", pieces?.length ?? 0, "piece(s) — plane missed the part?");
    merged.dispose();
    return null;
  }

  // three-pinata splits each half into CONNECTED-COMPONENT islands, so a
  // multi-shell part (mandibles, spikes, eyes welded as disjoint shells)
  // yields >2 pieces. Partition EVERY piece by which side of the plane its
  // centroid falls on: the joint-pivot side (part-local origin IS the joint
  // pivot) stays on the rig as the stump; everything else becomes debris.
  const planeD = _vLocalNormal.dot(_vLocalPoint);
  const originSide = -planeD >= 0 ? 1 : -1;
  const stumpPieces = [];
  const severedPieces = [];
  for (const p of pieces) {
    p.geometry.userData.__disposable = true;
    p.geometry.computeBoundingBox();
    p.geometry.boundingBox.getCenter(_vCentroid);
    const side = _vLocalNormal.dot(_vCentroid) - planeD >= 0 ? 1 : -1;
    (side === originSide ? stumpPieces : severedPieces).push(p);
  }
  if (severedPieces.length === 0) {
    // Everything landed on the joint side — nothing to sever; keep the rig.
    // eslint-disable-next-line no-console
    console.debug("[dismember] all", pieces.length, "pieces on the joint side — no sever");
    merged.dispose();
    for (const p of pieces) p.geometry.dispose();
    return null;
  }

  // In-place children swap (mixer bindings on the Group survive untouched).
  // Original meshes are stashed, not disposed — geometry is cache-shared and
  // restoreParts() can resurrect the limb (heals!).
  inst._dismemberStash = inst._dismemberStash || new Map();
  if (!inst._dismemberStash.has(partIndex)) {
    inst._dismemberStash.set(partIndex, meshes);
  }
  for (const m of meshes) part.remove(m);
  stumpPieces.forEach((p, i) => {
    const stumpMesh = new THREE.Mesh(p.geometry, [outerMaterial, _fleshMaterial]);
    stumpMesh.name = `part_${partIndex}_stump_${i}`;
    stumpMesh.userData = { guid: inst.guid, partIndex, __dismemberStump: true };
    part.add(stumpMesh);
  });
  // A stump on an already-dislocated joint keeps hanging wrong.
  _applyDislocations(inst);

  // Severed fragments → debris in entitiesGroup local space (AC frame).
  const group = _entitiesGroup();
  const result = { partIndex, audit: auditGeometry(merged), stumpPieces: stumpPieces.length, debris: 0 };
  merged.dispose();
  if (group) {
    group.updateWorldMatrix(true, false);
    _mInv.copy(group.matrixWorld).invert();
    const rel = new THREE.Matrix4().multiplyMatrices(_mInv, part.matrixWorld);
    const floorZ = (inst.root?.position?.z ?? 0) + 0.02;
    for (const p of severedPieces) {
      const spawned = _spawnSeveredMesh(
        new THREE.Mesh(p.geometry, [outerMaterial, _fleshMaterial]),
        rel.clone(), inst.root.position, floorZ, opts
      );
      if (spawned) result.debris++;
    }

    // Distal chain parts ride along as their own tumbling pieces.
    for (const ci of opts.chainParts || []) {
      const cPart = inst.parts[ci];
      if (!cPart || ci === partIndex || !cPart.visible) continue;
      const cMeshes = _partMeshes(cPart);
      if (cMeshes.length === 0) continue;
      const cGeom = weldPartGeometry(cMeshes);
      if (!cGeom) continue;
      cPart.updateWorldMatrix(true, false);
      const cRel = new THREE.Matrix4().multiplyMatrices(_mInv, cPart.matrixWorld);
      const cMat = cMeshes[0].material;
      if (_spawnSeveredMesh(new THREE.Mesh(cGeom, [cMat, _fleshMaterial]), cRel, inst.root.position, floorZ, opts)) {
        cPart.visible = false; // rig keeps animating it invisibly; restoreParts() flips back
        inst._dismemberHidden = inst._dismemberHidden || new Set();
        inst._dismemberHidden.add(ci);
        result.debris++;
      } else {
        cGeom.dispose();
      }
    }
  }
  return result;
}

function _spawnSeveredMesh(mesh, relMatrix, rootPos, floorZ, opts) {
  // relMatrix === null ⇒ the caller already placed the mesh in the parent
  // (entitiesGroup/AC) frame — the re-fracture path does exactly that.
  if (relMatrix) relMatrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
  const group = _entitiesGroup();
  if (!group) return false;
  // Ejection = RADIAL, horizontal, away from the body — a severed limb should
  // slump off and roll clear, not launch along the (often vertical) slice
  // normal. The original slice-normal impulse left transverse-cut pieces
  // settling INSIDE the creature's silhouette — invisible (2026-08-02 field
  // report: "it was just missing the leg").
  let rx = mesh.position.x - (rootPos?.x ?? mesh.position.x);
  let ry = mesh.position.y - (rootPos?.y ?? mesh.position.y);
  const rl = Math.hypot(rx, ry);
  if (rl > 1e-3) {
    rx /= rl;
    ry /= rl;
  } else {
    const a = Math.random() * Math.PI * 2;
    rx = Math.cos(a);
    ry = Math.sin(a);
  }
  const jitter = (Math.random() - 0.5) * 0.6;
  const cj = Math.cos(jitter);
  const sj = Math.sin(jitter);
  const dx = rx * cj - ry * sj;
  const dy = rx * sj + ry * cj;
  const speedScale = opts.speedScale ?? 1;
  const slide = (opts.critical ? 3.2 : 1.7) * (0.85 + Math.random() * 0.3) * speedScale;
  const up = (opts.critical ? 2.2 : 0.9) * (opts.upScale ?? 1);
  const vel = new THREE.Vector3(dx * slide, dy * slide, up);
  // initial tumble already rolls about the travel-perpendicular axis
  const omegaAxis = new THREE.Vector3(-dy, dx, 0);
  const omegaRad = (opts.critical ? 9 : 5) * (0.8 + Math.random() * 0.4) * speedScale;
  return _spawnDebris(mesh, {
    vel, omegaAxis, omegaRad, floorZ, gen: opts.gen || 0, small: opts.small,
  });
}

/* ── voronoi fracture: gib + chip + progressive re-fracture ───────────
 * three-pinata capability map (v2.0.1, vendored build audited 2026-08-02):
 *   fracture(FractureOptions, onFragment, onComplete)
 *     fractureMethod 'voronoi' | 'simple'   ← we use voronoi (simple = axis
 *       plane splits, blockier and no impact control)
 *     fragmentCount                          ← scaled by part size + crit here
 *     voronoiOptions.mode '3D' | '2.5D'      ← 3D for creature chunks
 *     voronoiOptions.impactPoint/impactRadius← the chip primitive's whole trick
 *     voronoiOptions.seedPoints              ← full manual control (unused)
 *     voronoiOptions.useApproximation        ← left OFF: it warns loudly and
 *                                              produces OVERLAPPING fragments
 *     seed                                    ← per-call, so no two fights match
 *   Fragments are themselves DestructibleMesh (createFragment) with geometry
 *   re-centred on their own centroid and `position` = that centroid pushed
 *   through the source mesh's matrixWorld — which for a freshly constructed
 *   (never added, never updated) DestructibleMesh is the IDENTITY, so the
 *   fragment positions come out in part-local space. That is the property the
 *   whole spawn path below relies on.
 */

/** Fragment count for a part: bigger parts and crits shatter into more. */
export function fragmentCountFor(triCount, opts = {}) {
  const t = triCount || 0;
  const base = t >= 200 ? 9 : t >= 80 ? 7 : t >= 30 ? 5 : 4;
  const n = Math.round((base + (opts.critical ? 3 : 0)) * (opts.scale ?? 1));
  return Math.max(3, Math.min(14, n));
}

/**
 * Chip partition (pure, node-tested): given each fragment's volume, decide
 * which ones fly off as chips and which stay welded to the creature.
 * Rules — never eject the largest, eject at most `maxEject`, and only pieces
 * at or under `ejectFrac` of the total volume; if nothing qualifies but there
 * are ≥2 fragments the single smallest still goes (a chip hit ALWAYS chips).
 */
export function pickChipFragments(volumes, opts = {}) {
  const n = volumes?.length || 0;
  if (n < 2) return { keep: n === 1 ? [0] : [], eject: [] };
  const maxEject = Math.max(1, Math.min(opts.maxEject ?? 2, n - 1));
  const ejectFrac = opts.ejectFrac ?? 0.22;
  const total = volumes.reduce((a, b) => a + b, 0) || 1;
  const order = volumes.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const eject = [];
  for (const e of order) {
    if (eject.length >= maxEject) break;
    if (e.v / total > ejectFrac) break;
    eject.push(e.i);
  }
  if (eject.length === 0) eject.push(order[0].i);
  const ejectSet = new Set(eject);
  const keep = [];
  for (let i = 0; i < n; i++) if (!ejectSet.has(i)) keep.push(i);
  return { keep, eject };
}

function _bboxVolume(geom) {
  geom.computeBoundingBox();
  const b = geom.boundingBox;
  if (!b) return 1e-9;
  const dx = Math.max(b.max.x - b.min.x, 1e-4);
  const dy = Math.max(b.max.y - b.min.y, 1e-4);
  const dz = Math.max(b.max.z - b.min.z, 1e-4);
  return dx * dy * dz;
}

/** World impact point → part-local, or null (uniform seeding). */
function _localImpact(part, pointW) {
  if (!pointW) return null;
  part.updateWorldMatrix(true, false);
  _mInv.copy(part.matrixWorld).invert();
  return new THREE.Vector3().copy(pointW).applyMatrix4(_mInv);
}

async function _fractureGeometry(geom, outerMaterial, o) {
  const { DestructibleMesh, FractureOptions } = await _loadPinata();
  const voronoiOptions = { mode: o.mode || "3D" };
  if (o.impactPoint) {
    voronoiOptions.impactPoint = o.impactPoint;
    if (o.impactRadius) voronoiOptions.impactRadius = o.impactRadius;
  }
  if (o.seedPoints) voronoiOptions.seedPoints = o.seedPoints;
  const fo = new FractureOptions({
    fractureMethod: "voronoi",
    fragmentCount: Math.max(2, o.fragmentCount | 0),
    voronoiOptions,
    seed: o.seed ?? ((Math.random() * 2147483647) | 0),
  });
  const dm = new DestructibleMesh(geom, outerMaterial, _fleshMaterial);
  if (o.sourceMatrix) {
    // Re-fracturing a piece that already lives in the scene: pin matrixWorld to
    // the piece's LOCAL matrix so fragment positions come out in the parent
    // (entitiesGroup/AC) frame, matching the local quaternion createFragment
    // copies. fracture() reads matrixWorld and never recomputes it.
    dm.matrixWorld.copy(o.sourceMatrix);
    if (o.sourceQuat) dm.quaternion.copy(o.sourceQuat);
    if (o.sourceScale) dm.scale.copy(o.sourceScale);
  }
  return dm.fracture(fo);
}

/** entitiesGroup-local matrix of a part (the frame debris lives in). */
function _partRelMatrix(part) {
  const group = _entitiesGroup();
  if (!group) return null;
  group.updateWorldMatrix(true, false);
  part.updateWorldMatrix(true, false);
  return new THREE.Matrix4()
    .multiplyMatrices(new THREE.Matrix4().copy(group.matrixWorld).invert(), part.matrixWorld);
}

/**
 * Blow part `partIndex` apart: voronoi-fracture the whole part, strip its
 * meshes off the rig (stashed — restoreParts() heals it) and eject every
 * fragment as debris. The "big crit / finisher" primitive.
 *
 * opts: { critical, fragmentCount, scale, impactPointW, impactRadius, seed,
 *         speedScale, upScale }
 */
export async function fracturePart(inst, partIndex, opts = {}) {
  const part = inst?.parts?.[partIndex];
  if (!part) return null;
  const meshes = _partMeshes(part);
  if (meshes.length === 0) return null;
  const merged = weldPartGeometry(meshes);
  if (!merged) return null;
  const audit = auditGeometry(merged);
  const outerMaterial = meshes[0].material;
  const count = opts.fragmentCount || fragmentCountFor(audit.tris, opts);

  let frags = null;
  try {
    frags = await _fractureGeometry(merged, outerMaterial, {
      fragmentCount: count,
      seed: opts.seed,
      mode: opts.mode,
      impactPoint: _localImpact(part, opts.impactPointW),
      impactRadius: opts.impactRadius,
    });
  } catch (err) {
    console.warn("[dismember] fracture failed:", err);
    merged.dispose();
    return null;
  }
  merged.dispose();
  if (!frags || frags.length === 0) return null;

  // Identity guard across the fracture await (R1#9 class — see slicePart).
  if (inst._disposed || !inst.root?.parent) {
    for (const f of frags) { try { f.geometry?.dispose?.(); } catch (_) {} }
    return null;
  }

  // Strip the part (stash for restoreParts) — the limb is gone, the rig keeps
  // animating an empty Group so every mixer binding stays valid.
  inst._dismemberStash = inst._dismemberStash || new Map();
  if (!inst._dismemberStash.has(partIndex)) inst._dismemberStash.set(partIndex, meshes);
  for (const m of meshes) part.remove(m);

  const result = { partIndex, requested: count, fragments: frags.length, debris: 0, audit };
  const rel = _partRelMatrix(part);
  if (!rel) {
    for (const f of frags) f.geometry.dispose();
    return result;
  }
  const floorZ = (inst.root?.position?.z ?? 0) + 0.02;
  const t = new THREE.Matrix4();
  for (const f of frags) {
    f.geometry.userData.__disposable = true;
    t.makeTranslation(f.position.x, f.position.y, f.position.z);
    const comp = new THREE.Matrix4().multiplyMatrices(rel, t);
    const spawned = _spawnSeveredMesh(f, comp, inst.root?.position, floorZ, {
      ...opts,
      // A gib is a SPRAY, not a launch: a dozen chunks each carrying the
      // full severed-limb impulse skidded 7m clear of the corpse (measured),
      // which reads as an explosion in a vacuum. Chunks stay in the kill zone.
      speedScale: opts.speedScale ?? (opts.critical ? 0.5 : 0.42),
      upScale: opts.upScale ?? 1.6, // they do pop up, they just don't fly away
      gen: 0,
    });
    if (spawned) result.debris++;
    else f.geometry.dispose();
  }
  return result;
}

/**
 * Knock a CHUNK off a part without severing it: an impact-clustered voronoi
 * with a small fragment count, the big fragments welded straight back onto the
 * rig as the part's new meshes, the small ones ejected as chips. The creature
 * keeps fighting with a visibly cratered shell.
 *
 * opts: { impactPointW, impactRadius, fragmentCount, maxEject, ejectFrac, seed }
 */
export async function chipPart(inst, partIndex, opts = {}) {
  const part = inst?.parts?.[partIndex];
  if (!part) return null;
  const meshes = _partMeshes(part);
  if (meshes.length === 0) return null;
  const merged = weldPartGeometry(meshes);
  if (!merged) return null;
  const outerMaterial = meshes[0].material;

  merged.computeBoundingBox();
  const bb = merged.boundingBox;
  const span = Math.min(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
  let impact = _localImpact(part, opts.impactPointW);
  if (!impact) {
    // No impact point supplied: bite at a random spot on the bbox shell.
    impact = new THREE.Vector3(
      bb.min.x + Math.random() * (bb.max.x - bb.min.x),
      bb.min.y + Math.random() * (bb.max.y - bb.min.y),
      bb.min.z + Math.random() * (bb.max.z - bb.min.z),
    );
  }

  let frags = null;
  try {
    frags = await _fractureGeometry(merged, outerMaterial, {
      fragmentCount: opts.fragmentCount || 5,
      seed: opts.seed,
      impactPoint: impact,
      impactRadius: opts.impactRadius || Math.max(0.02, span * 0.22),
    });
  } catch (err) {
    console.warn("[dismember] chip failed:", err);
    merged.dispose();
    return null;
  }
  merged.dispose();
  if (!frags || frags.length < 2) {
    // Nothing separated — leave the part exactly as it was.
    for (const f of frags || []) f.geometry.dispose();
    return null;
  }

  // Identity guard across the fracture await (R1#9 class — see slicePart).
  if (inst._disposed || !inst.root?.parent) {
    for (const f of frags) { try { f.geometry?.dispose?.(); } catch (_) {} }
    return null;
  }

  const volumes = frags.map((f) => _bboxVolume(f.geometry));
  const { keep, eject } = pickChipFragments(volumes, opts);

  inst._dismemberStash = inst._dismemberStash || new Map();
  if (!inst._dismemberStash.has(partIndex)) inst._dismemberStash.set(partIndex, meshes);
  for (const m of meshes) part.remove(m);
  let keptTris = 0;
  for (const i of keep) {
    const f = frags[i];
    f.geometry.userData.__disposable = true;
    const kept = new THREE.Mesh(f.geometry, [outerMaterial, _fleshMaterial]);
    kept.position.copy(f.position); // fragment geometry is centroid-centred
    kept.name = `part_${partIndex}_chipped_${i}`;
    kept.userData = { guid: inst.guid, partIndex, __dismemberStump: true };
    part.add(kept);
    keptTris += _triCountOf(f.geometry);
  }
  // A chipped part that was already dislocated keeps hanging wrong.
  _applyDislocations(inst);

  const result = { partIndex, fragments: frags.length, kept: keep.length, chips: 0, keptTris };
  const rel = _partRelMatrix(part);
  const floorZ = (inst.root?.position?.z ?? 0) + 0.02;
  const t = new THREE.Matrix4();
  for (const i of eject) {
    const f = frags[i];
    f.geometry.userData.__disposable = true;
    if (!rel) { f.geometry.dispose(); continue; }
    t.makeTranslation(f.position.x, f.position.y, f.position.z);
    const comp = new THREE.Matrix4().multiplyMatrices(rel, t);
    const spawned = _spawnSeveredMesh(f, comp, inst.root?.position, floorZ, {
      critical: false,
      speedScale: 1.4,
      upScale: 2.0,
      gen: 1, // a chip is already a small shard: no further re-fracture
      small: true,
    });
    if (spawned) result.chips++;
    else f.geometry.dispose();
  }
  return result;
}

/**
 * Progressive destruction: shatter LARGE resting debris near an AC-frame point
 * into smaller chunks. Every piece we spawn keeps its geometry, so any piece —
 * severed limb, gib chunk — can be broken down again up to MAX_DEBRIS_GEN.
 * Returns the number of new pieces spawned.
 */
export async function refractureDebrisNear(acPoint, radius = 1.4, opts = {}) {
  if (!acPoint) return 0;
  const r2 = radius * radius;
  const targets = [];
  for (const e of _activeDebris) {
    if (!e.resting || e.small || (e.gen || 0) >= MAX_DEBRIS_GEN) continue;
    if ((e.tris || 0) < LARGE_DEBRIS_TRIS) continue;
    const dx = e.mesh.position.x - acPoint.x;
    const dy = e.mesh.position.y - acPoint.y;
    const dz = e.mesh.position.z - (acPoint.z ?? e.mesh.position.z);
    if (dx * dx + dy * dy + dz * dz <= r2) targets.push(e);
  }
  if (targets.length === 0) return 0;
  let spawned = 0;
  const max = opts.maxTargets ?? 1;
  for (const e of targets.slice(0, max)) spawned += await _refractureEntry(e, opts);
  return spawned;
}

async function _refractureEntry(entry, opts = {}) {
  const mesh = entry.mesh;
  const geom = mesh.geometry;
  if (!geom) return 0;
  const outerMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const gen = (entry.gen || 0) + 1;
  mesh.updateMatrix();
  let frags = null;
  try {
    frags = await _fractureGeometry(geom, outerMaterial, {
      fragmentCount: opts.fragmentCount || (gen >= MAX_DEBRIS_GEN ? 3 : 4),
      seed: opts.seed,
      sourceMatrix: mesh.matrix,
      sourceQuat: mesh.quaternion,
      sourceScale: mesh.scale,
    });
  } catch (err) {
    console.warn("[dismember] re-fracture failed:", err);
    return 0;
  }
  if (!frags || frags.length < 2) {
    for (const f of frags || []) f.geometry.dispose();
    return 0;
  }
  const origin = mesh.position.clone();
  const floorZ = entry.floorZ;
  _disposeDebris(entry); // frees the parent geometry; fracture already read it
  let spawned = 0;
  for (const f of frags) {
    f.geometry.userData.__disposable = true;
    // fragment.position is already parent-local (sourceMatrix trick above)
    const spawnedOk = _spawnSeveredMesh(f, null, origin, floorZ, {
      critical: false,
      speedScale: 0.7,
      upScale: 1.4,
      gen,
      small: gen >= MAX_DEBRIS_GEN,
      preposed: true,
    });
    if (spawnedOk) spawned++;
    else f.geometry.dispose();
  }
  return spawned;
}

/* ── dislocation (visible mis-set joint, creature fights on) ───────────
 * Applied to the part Group's CHILD MESHES, not to the Group itself: the
 * animation mixer and the limp path both write the GROUP transform every
 * frame, while the meshes under it are static. worldMatrix = partMatrix *
 * offsetMatrix is mathematically identical to a post-animation offset applied
 * to the Group, but it needs no ordering guarantee against the entity tick —
 * it simply rides the animation. Part-local origin IS the joint pivot, so a
 * pure mesh rotation swings the limb about its joint.
 * The rAF loop below only RE-ASSERTS (cheap, every few frames) so an appearance
 * hot-swap that rebuilds a part's children cannot silently heal the joint; it
 * parks itself the moment no entity is dislocated.
 */
export const DISLOC_MAX_ANGLE = 0.44; // rad ≈ 25° at severity 1
export const DISLOC_MAX_OFFSET = 0.05; // metres of joint separation at sev 1
const DISLOC_REASSERT_FRAMES = 12;
const _dislocInsts = new Set();
let _dislocRafId = 0;
let _dislocFrames = 0;

function _applyDislocations(inst) {
  const map = inst?._dislocations;
  if (!map || map.size === 0) return 0;
  let n = 0;
  for (const [pi, d] of map) {
    const part = inst.parts?.[pi];
    if (!part) continue;
    for (const c of part.children) {
      if (!c.isMesh) continue;
      c.quaternion.set(d.q[0], d.q[1], d.q[2], d.q[3]);
      c.position.set(d.p[0], d.p[1], d.p[2]);
      n++;
    }
  }
  return n;
}

/**
 * Dislocate (do NOT sever) a joint: the part hangs a few cm out of socket and
 * up to ~25° off-axis, persistently, while the creature keeps fighting.
 * opts: { severity 0..1, chainParts:[i], axis:[x,y,z], rand }
 */
export function dislocatePart(inst, partIndex, opts = {}) {
  const part = inst?.parts?.[partIndex];
  if (!part) return null;
  const sev = Math.max(0, Math.min(1, opts.severity ?? 0.6));
  if (sev <= 0) return null;
  const rand = typeof opts.rand === "function" ? opts.rand : Math.random;
  const map = (inst._dislocations = inst._dislocations || new Map());
  const q = new THREE.Quaternion();
  const axis = new THREE.Vector3();

  const setOne = (pi, scale) => {
    if (!inst.parts?.[pi]) return;
    if (opts.axis) axis.fromArray(opts.axis).normalize();
    else axis.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
    if (axis.lengthSq() < 1e-6) axis.set(0, 0, 1);
    axis.normalize();
    const ang = DISLOC_MAX_ANGLE * sev * scale;
    q.setFromAxisAngle(axis, ang);
    const off = DISLOC_MAX_OFFSET * sev * scale;
    map.set(pi, {
      q: [q.x, q.y, q.z, q.w],
      p: [axis.x * off, axis.y * off, axis.z * off],
      severity: sev * scale,
    });
  };

  setOne(partIndex, 1);
  let s = 0.62; // the rest of the chain hangs progressively less wrong
  for (const ci of opts.chainParts || []) {
    if (ci === partIndex) continue;
    setOne(ci, s);
    s *= 0.62;
  }
  _dislocInsts.add(inst);
  const applied = _applyDislocations(inst);
  _ensureDislocRaf();
  return { partIndex, severity: sev, parts: [...map.keys()], meshes: applied };
}

/** Pop every dislocated joint back into place on this entity. */
export function clearDislocations(inst) {
  const map = inst?._dislocations;
  _dislocInsts.delete(inst);
  if (!map || map.size === 0) return 0;
  let n = 0;
  for (const pi of map.keys()) {
    const part = inst.parts?.[pi];
    if (!part) continue;
    for (const c of part.children) {
      if (!c.isMesh) continue;
      c.quaternion.set(0, 0, 0, 1);
      c.position.set(0, 0, 0);
      n++;
    }
  }
  map.clear();
  return n;
}

function _tickDisloc() {
  _dislocRafId = 0;
  _dislocFrames++;
  if (_dislocFrames % DISLOC_REASSERT_FRAMES === 0) {
    for (const inst of [..._dislocInsts]) {
      const map = inst._dislocations;
      // Entity gone from the scene (root detached) or healed → stop tracking.
      if (!map || map.size === 0 || !inst.parts || !inst.root || !inst.root.parent) {
        _dislocInsts.delete(inst);
        continue;
      }
      _applyDislocations(inst);
    }
  }
  _ensureDislocRaf();
}

function _ensureDislocRaf() {
  if (!_dislocRafId && _dislocInsts.size > 0) {
    _dislocRafId = requestAnimationFrame(_tickDisloc);
  }
}

/** Undo every slice/chip/fracture/hide/dislocation on this entity
 *  (visual heal / teardown hygiene). */
export function restoreParts(inst) {
  clearDislocations(inst);
  if (inst?._dismemberStash) {
    for (const [pi, meshes] of inst._dismemberStash) {
      const part = inst.parts?.[pi];
      if (!part) continue;
      for (const c of _partMeshes(part)) {
        if (c.userData?.__dismemberStump) {
          part.remove(c);
          if (c.geometry?.userData?.__disposable) c.geometry.dispose();
        }
      }
      for (const m of meshes) part.add(m);
    }
    inst._dismemberStash.clear();
  }
  if (inst?._dismemberHidden) {
    for (const ci of inst._dismemberHidden) {
      const p = inst.parts?.[ci];
      if (p) p.visible = true;
    }
    inst._dismemberHidden.clear();
  }
}

/**
 * Carry dismemberment across the corpse handoff: the lootable corpse is a
 * SEPARATE object that spawns with FULL geometry, so a creature that lost a
 * leg mid-fight would get it back as a corpse. Called from entities.js
 * finishReveal (via the window.__dismemberTransfer hook, registered on the
 * default arm — escape is ?dismember=off) right after the ragdoll pose
 * transfer, while the creature instance still exists.
 *
 * Per damaged part on the creature: the corpse part's own meshes are removed
 * and stashed (cache-shared — never disposed; restoreParts on the corpse
 * undoes everything), and the creature's CURRENT meshes for that part —
 * stump meshes, a chip-cratered remainder, or nothing at all for a fully
 * fractured part — are MOVED onto the corpse part. Moving (not cloning) is
 * safe and deliberate: the creature is removed immediately after the reveal,
 * and evacuating the stump meshes beforehand keeps its disposal walk from
 * freeing geometry the corpse now displays. Hidden distal chain parts are
 * mirrored via part.visible.
 *
 * Returns the number of parts altered on the corpse (0 = nothing to carry
 * or rig mismatch — corpse keeps full geometry, the safe fallback).
 */
export function transferDismemberment(fromInst, toInst) {
  if (!fromInst || !toInst?.parts?.length) return 0;
  const nFrom = fromInst.parts?.length ?? 0;
  const stash = fromInst._dismemberStash;
  const hidden = fromInst._dismemberHidden;
  if ((!stash || stash.size === 0) && (!hidden || hidden.size === 0)) return 0;
  if (nFrom !== toInst.parts.length) {
    // eslint-disable-next-line no-console
    console.info(`[dismember] corpse carry-over skipped: rig mismatch (${nFrom} vs ${toInst.parts.length} parts)`);
    return 0;
  }
  let altered = 0;
  if (stash) {
    toInst._dismemberStash = toInst._dismemberStash || new Map();
    for (const [pi] of stash) {
      const src = fromInst.parts[pi];
      const dst = toInst.parts[pi];
      if (!src || !dst) continue;
      const dstOriginals = _partMeshes(dst);
      if (!toInst._dismemberStash.has(pi)) toInst._dismemberStash.set(pi, dstOriginals);
      for (const m of dstOriginals) dst.remove(m);
      for (const m of _partMeshes(src)) {
        src.remove(m);
        dst.add(m); // stump / cratered remainder rides over; may be zero (gib)
      }
      altered++;
    }
  }
  if (hidden) {
    toInst._dismemberHidden = toInst._dismemberHidden || new Set();
    for (const ci of hidden) {
      const p = toInst.parts[ci];
      if (!p) continue;
      p.visible = false;
      toInst._dismemberHidden.add(ci);
      altered++;
    }
  }
  if (altered > 0) {
    // eslint-disable-next-line no-console
    console.info(`[dismember] corpse carry-over: ${altered} part(s) transferred`);
    _archiveCorpseDismemberment(toInst);
  }
  return altered;
}

/* ── corpse dismemberment archive ───────────────────────────────────────
 * Same problem the pose archive solves (ragdoll.js): corpses are removed
 * and re-materialized constantly, and the carried-over stumps/hidden parts
 * died with the instance — a re-spawned corpse grew its limbs back. Archive
 * the stump MESHES per corpse guid: their geometry is untagged __disposable
 * (the archive takes ownership) so the corpse instance's disposal walk
 * can't free what a future re-spawn needs. Bounded + TTL'd; eviction
 * disposes owned geometry.
 */
const CORPSE_DISM_MAX = 32;
const CORPSE_DISM_TTL_MS = 10 * 60 * 1000;
const _corpseDism = new Map(); // guid -> { n, stumps: Map<pi, Mesh[]>, hidden: number[], expiresAt }

/**
 * Drop an archive entry. Ownership rule (round-1 #2): exactly one dispose()
 * per resource, and the archive may only free geometry it still holds ALONE.
 *
 * 2026-08-03 review F2: this used to dispose every `__corpseArchived` geometry
 * unconditionally. But `restoreCorpseDismemberment` re-parents these very Mesh
 * objects onto a live corpse rig and the entry keeps pointing at them, so a
 * cap/TTL eviction freed a BufferGeometry that an on-screen corpse was still
 * rendering (kill 33 creatures inside one decay window and corpse #1's stumps
 * go). A mesh with a parent is displayed by a live rig: hand ownership back to
 * that rig instead (its `_disposeMeshChildren` walk / `restoreParts` frees
 * `__disposable` geometry) and free only the genuinely orphaned ones here.
 */
function _disposeDismEntry(entry) {
  for (const meshes of entry.stumps.values()) {
    for (const m of meshes) {
      const ud = m.geometry?.userData;
      if (!ud?.__corpseArchived) continue;
      if (m.parent) {
        // Still on a rig — transfer ownership, do NOT free.
        ud.__corpseArchived = false;
        ud.__disposable = true;
        continue;
      }
      m.geometry.dispose();
    }
  }
}

function _archiveCorpseDismemberment(inst) {
  const g = Number(inst?.guid) >>> 0;
  if (!g || !inst.parts?.length) return;
  const now = performance.now();
  for (const [k, v] of _corpseDism) {
    if (v.expiresAt < now) {
      _disposeDismEntry(v);
      _corpseDism.delete(k);
    }
  }
  while (_corpseDism.size >= CORPSE_DISM_MAX) {
    const k = _corpseDism.keys().next().value;
    _disposeDismEntry(_corpseDism.get(k));
    _corpseDism.delete(k);
  }
  const stumps = new Map();
  if (inst._dismemberStash) {
    for (const [pi] of inst._dismemberStash) {
      const part = inst.parts[pi];
      if (!part) continue;
      const meshes = _partMeshes(part);
      for (const m of meshes) {
        if (m.geometry?.userData?.__disposable) {
          m.geometry.userData.__disposable = false;
          m.geometry.userData.__corpseArchived = true;
        }
      }
      stumps.set(pi, meshes);
    }
  }
  const hidden = inst._dismemberHidden ? [...inst._dismemberHidden] : [];
  _corpseDism.set(g, { n: inst.parts.length, stumps, hidden, expiresAt: now + CORPSE_DISM_TTL_MS });
}

/**
 * Re-apply archived dismemberment to a freshly re-spawned corpse instance.
 * Returns true when anything was restored.
 */
export function restoreCorpseDismemberment(inst) {
  const g = Number(inst?.guid) >>> 0;
  const entry = g ? _corpseDism.get(g) : null;
  if (!entry) return false;
  const now = performance.now();
  if (entry.expiresAt < now) {
    _disposeDismEntry(entry);
    _corpseDism.delete(g);
    return false;
  }
  if (!inst.parts || inst.parts.length !== entry.n) return false;
  entry.expiresAt = now + CORPSE_DISM_TTL_MS;
  // F2 — re-insert so the cap eviction above is LRU, not FIFO: a corpse that
  // keeps re-materialising must not be evicted ahead of one nobody has seen
  // since it was archived (Map preserves insertion order).
  _corpseDism.delete(g);
  _corpseDism.set(g, entry);
  let altered = 0;
  inst._dismemberStash = inst._dismemberStash || new Map();
  for (const [pi, meshes] of entry.stumps) {
    const part = inst.parts[pi];
    if (!part) continue;
    const originals = _partMeshes(part);
    if (!inst._dismemberStash.has(pi)) inst._dismemberStash.set(pi, originals);
    for (const m of originals) part.remove(m);
    for (const m of meshes) {
      m.parent?.remove(m); // detach from the dead instance's rig if still held
      part.add(m);
    }
    altered++;
  }
  inst._dismemberHidden = inst._dismemberHidden || new Set();
  for (const ci of entry.hidden) {
    const p = inst.parts[ci];
    if (!p) continue;
    p.visible = false;
    inst._dismemberHidden.add(ci);
    altered++;
  }
  if (altered > 0) {
    // eslint-disable-next-line no-console
    console.info(`[dismember] corpse 0x${g.toString(16)}: archived dismemberment restored on re-spawn (${altered} parts)`);
  }
  return altered > 0;
}

/** How many LARGE pieces are lying around at rest and still re-fracturable.
 *  carnage.js uses this to decide whether a "shatter the debris" escalation is
 *  even possible before rolling for it. */
export function restingLargeDebrisCount() {
  let n = 0;
  for (const e of _activeDebris) {
    if (e.resting && !e.small && (e.gen || 0) < MAX_DEBRIS_GEN && (e.tris || 0) >= LARGE_DEBRIS_TRIS) n++;
  }
  return n;
}

/** Snapshot of the debris registry (diag + tests). */
export function debrisStats() {
  let resting = 0;
  let large = 0;
  const byGen = {};
  for (const e of _activeDebris) {
    if (e.resting) resting++;
    if (!e.small) large++;
    byGen[e.gen || 0] = (byGen[e.gen || 0] || 0) + 1;
  }
  return {
    activeDebris: _activeDebris.size,
    cap: _MAX_ACTIVE_DEBRIS,
    resting,
    large,
    byGen,
    dislocatedEntities: _dislocInsts.size,
    ttlMs: DEBRIS_TTL_MS,
  };
}

/* ── console/diag surface ─────────────────────────────────────────────── */

function _findInst(guid) {
  const em = window.liveScene3d?.entityManager;
  if (!em?.entityMap) return null;
  // Accept an EntityInstance directly, any numeric form (signed/unsigned),
  // or a string; last resort scans values (diag-only, O(n) is fine).
  if (guid && typeof guid === "object" && guid.parts) return guid;
  const k = Number(guid) >>> 0;
  const hit = em.entityMap.get(guid) || em.entityMap.get(k);
  if (hit) return hit;
  for (const i of em.entityMap.values()) {
    if ((Number(i.guid) >>> 0) === k) return i;
  }
  return null;
}

/**
 * Install `window.__diag.dismember`. Called lazily from scene3d/index.js on
 * the DEFAULT arm (its gate is `?dismember` !== "off", same as ours), so the
 * hooks below are live unless the escape flag is set.
 */
export function installDismemberDiag() {
  if (!dismemberEnabled()) return;
  // entities.js finishReveal reaches the corpse carry-over through this hook
  // so it never has to import this module (flag-off arm + bare-node suites
  // stay clean — same pattern as window.__carnageOnDeath).
  window.__dismemberTransfer = transferDismemberment;
  // ...and corpse re-spawns restore archived dismemberment through this one.
  window.__dismemberCorpseRestore = restoreCorpseDismemberment;
  const diag = (window.__diag = window.__diag || {});
  diag.dismember = {
    /** Weld+audit a part without slicing: __diag.dismember.audit(guid, 3) */
    audit(guid, partIndex) {
      const inst = _findInst(guid);
      const part = inst?.parts?.[partIndex];
      if (!part) return { error: "no such entity/part" };
      const g = weldPartGeometry(_partMeshes(part));
      if (!g) return { error: "no geometry" };
      const report = auditGeometry(g);
      g.dispose();
      return report;
    },
    /** Audit every part: __diag.dismember.auditAll(guid) */
    auditAll(guid) {
      const inst = _findInst(guid);
      if (!inst?.parts) return { error: "no such entity" };
      return inst.parts.map((_p, i) => ({ part: i, ...this.audit(guid, i) }));
    },
    /**
     * Slice through the part's local bbox center, horizontal-ish plane:
     * __diag.dismember.slice(guid, partIndex, {critical:true, chainParts:[...]})
     */
    async slice(guid, partIndex, opts = {}) {
      const inst = _findInst(guid);
      const part = inst?.parts?.[partIndex];
      if (!part) return { error: "no such entity/part" };
      part.updateWorldMatrix(true, false);
      const box = new THREE.Box3().setFromObject(part);
      const centerW = box.getCenter(new THREE.Vector3());
      const normalW = opts.normalW
        ? new THREE.Vector3().fromArray(opts.normalW).normalize()
        : new THREE.Vector3(0, 1, 0); // three world-up ≈ AC +Z: transverse cut
      return slicePart(inst, partIndex, centerW, normalW, opts);
    },
    /**
     * Blow a part apart into voronoi chunks:
     * __diag.dismember.fracture(guid, partIndex, {critical:true, fragmentCount:10})
     */
    async fracture(guid, partIndex, opts = {}) {
      const inst = _findInst(guid);
      if (!inst?.parts?.[partIndex]) return { error: "no such entity/part" };
      return fracturePart(inst, partIndex, opts);
    },
    /**
     * Knock a chip off a part, keeping it attached:
     * __diag.dismember.chip(guid, partIndex, {fragmentCount:5})
     */
    async chip(guid, partIndex, opts = {}) {
      const inst = _findInst(guid);
      if (!inst?.parts?.[partIndex]) return { error: "no such entity/part" };
      return chipPart(inst, partIndex, opts);
    },
    /**
     * Dislocate a joint (visual only, creature keeps fighting):
     * __diag.dismember.dislocate(guid, partIndex, {severity:0.8, chainParts:[..]})
     */
    dislocate(guid, partIndex, opts = {}) {
      const inst = _findInst(guid);
      if (!inst?.parts?.[partIndex]) return { error: "no such entity/part" };
      return dislocatePart(inst, partIndex, opts);
    },
    /** Pop every dislocated joint back: __diag.dismember.relocate(guid) */
    relocate(guid) {
      const inst = _findInst(guid);
      if (!inst) return { error: "no such entity" };
      return { meshes: clearDislocations(inst) };
    },
    /**
     * Progressive destruction: shatter resting chunks near an entity (or near
     * an explicit AC point): __diag.dismember.refracture(guid, 1.5)
     */
    async refracture(guid, radius = 1.5, opts = {}) {
      let pt = guid;
      if (!(pt && typeof pt === "object" && "x" in pt)) {
        const inst = _findInst(guid);
        if (!inst?.root) return { error: "no such entity" };
        pt = inst.root.position;
      }
      const spawned = await refractureDebrisNear(pt, radius, opts);
      return { spawned, ...debrisStats() };
    },
    restore(guid) {
      const inst = _findInst(guid);
      if (!inst) return { error: "no such entity" };
      restoreParts(inst);
      return { ok: true };
    },
    stats() {
      return debrisStats();
    },
  };
  console.info("[dismember] diag installed (window.__diag.dismember) — default ON, escape ?dismember=off");
}
