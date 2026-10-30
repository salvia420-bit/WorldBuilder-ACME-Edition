// scene3d/entity_world.js — `?rustEntityWorld` (lane R4, 2026-10-26; DEFAULT OFF, `=on` opts
// in; live seam `window.__entityWorld`). The entity rigs' share of three r184's per-frame scene
// walk — the matrix walk and projectObject — done by code that knows the rig shape, producing the
// SAME values, the SAME render list and the SAME GL call stream.
//
// Lane notes, measurements and the full exactness argument: docs/2026-10-26-rust-entity-walk.md.
// (The flag carries the scene-core "rust" prefix of the brief; the measured Rust variants — Rust-
// written world matrices, a Rust cull — lose in node, so both parts are JS. §3 of the notes.)
//
// WHY. A rig is root → parts (Groups) → surface meshes, ~25 nodes, and at Holtburg ~19 of them are
// visible. three walks every node through the same generic, megamorphic code (Object3D.update-
// MatrixWorld via skip_hidden_matrix's wrapper; projectObject's type ladder, a frustum test,
// WebGLObjects.update's WeakMap lookups and the push). Measured in node at a Holtburg-shaped world
// (tests/rust_entity_world.test.mjs --bench): per visible entity node ~0.48 µs of matrix walk,
// ~0.71 µs of projectObject, ~0.25 µs of sort.
//
// 1. WALK. Each entity rig ROOT gets an own `updateMatrixWorld` (installEntityWorldRoot, from
//    the rig build in entities.js). It runs three's body for the root (with skip_hidden's rule),
//    then walks its plain-Group parts and their plain leaf meshes in one loop with three r184's
//    compose / multiplyMatrices inlined (operation for operation; premises checked against the
//    installed three's source). One shortcut, exact by IEEE arithmetic: a leaf mesh whose local
//    transform is the exact identity — position (+0,+0,+0), quaternion (+0,+0,+0,1), scale
//    (1,1,1), no pivot — gets three's composed identity and its part's world matrix by COPY when
//    that world matrix is clean (no −0, no ±Inf / NaN, checked once per part): P × I === P bit
//    for bit then (docs §4.1). Every other child — sprites, lights, cameras, held items (nested
//    rig roots), SkinnedMesh (own method), anything with an own matrix method, children of
//    meshes — gets `child.updateMatrixWorld(force)` at its position, exactly as three's loop.
//    Same values, written by the same walk at the same moment: nothing differs between walks.
//
// 2. PROJECTION. For the main scene's render only, between three's `renderLists.get` (camera,
//    `_projScreenMatrix` and `_frustum` already final) and `list.finish()` (right after
//    projectObject), the entities group's `children` is a stand-in: one RigPusher per visible real
//    child, in order (projectObject returns at once for a hidden one, with no side effect). three's projectObject reads a node's `visible` first: a RigPusher's `visible`
//    getter mirrors projectObject over its rig in JS and returns true with `children` set to the
//    rig's HOT nodes, in pre-order, interleaved with SegPushers. A SegPusher's `visible` getter
//    pushes its run of COLD meshes into the render list (same object, geometry, material,
//    groupOrder and z — three's own Frustum / Vector4 math on the same matrices) and returns false.
//    So every push lands at its pre-order position and the render list — items, order, pooled
//    render items — is the one three builds; the GL stream follows.
//      COLD: a plain leaf Mesh, one material, that passes visible / layers / frustum, and whose
//            geometry three's WebGLObjects.update has already brought current: the same geometry,
//            the same attribute objects at the same versions, no attribute added or removed, not
//            disposed since, no context restore since. WebGLObjects.update is then a no-op (r184:
//            geometries.get finds it registered, attributes.update finds every version current),
//            so it is skipped — the one piece of three's per-mesh work that is not recomputed.
//            "Brought current" needs TWO hot visits at different `info.render.frame` values that
//            see the same attributes (2026-10-29): three's update is memoised once per frame value
//            and a shadow raster runs it AFTER `frame++`, so the first visit after a raster can be
//            a memo no-op; the second visit's update ran after the first (or after a raster that
//            itself followed the first), so it is current. Cost: a new / changed geometry stays
//            hot one render longer.
//      HOT:  everything else — handed to three at its position (lights keep their push order,
//            first sights and changed geometries get their upload exactly where three makes it).
//            A node whose real groupOrder differs from the entities group's rides in a Carrier
//            (a Group-shaped node with that renderOrder), so three gives it the same groupOrder.
//    Stays off for: another scene, `renderer.sortObjects !== true`, XR presenting, a missing
//    camera (scene.onBeforeRender did not run), the live seam, premise drift (install refuses).
//    E.children is restored in list.finish; a renderer.render `finally` and the next
//    renderLists.get restore it if a throw inside projectObject skipped finish. The restore also
//    drops every reference the stand-in pool holds (targets, hot nodes, carrier and segment slots;
//    2026-10-29), so a despawned rig is never kept reachable — stock's list.finish does the same
//    for its inactive render items.
//    INSTALL: scene3d/index.js calls installEntityWorld(renderer, () => scene, () => entitiesGroup)
//    once the world groups exist (inert with the flag off). The rig build's ensureEntityWorld
//    cannot do it in the client: it gets index.js's scene3dForBuilders, which has no renderer / scene.
//
// FLAGS. `rustFlag("rustEntityWorld", false)`, read once. Live: `window.__entityWorld.walkOff`,
// `.projOff` (A/B without a reload; each falls back to three's path from the next walk/render).

import * as THREE from "three";
import { rustFlag } from "./rust/scene_core.js";
import { skipHiddenWalkMode, skipHiddenMethod } from "./skip_hidden_matrix.js";

let _flag = null;
/** `?rustEntityWorld` (read once; `__setEntityWorldForTest` overrides). */
export function entityWorldEnabled() {
  if (_flag === null) {
    try { _flag = rustFlag("rustEntityWorld", false); } catch (_) { _flag = false; }
  }
  return _flag;
}
/** Test seam: force the flag (`undefined` re-reads it). */
export function __setEntityWorldForTest(on) { _flag = on === undefined ? null : !!on; }

const ctl = { walkOff: false, projOff: false };
const stats = {
  roots: 0, // rig roots with the entity walk installed
  walks: 0, // root walks run by this module
  walkFallbacks: 0, // root walks handed to three (seam off, census, premise drift)
  identity: 0, // leaf meshes served by the identity copy
  unclean: 0, // parts whose world matrix held a −0 / non-finite entry (identity meshes multiplied)
  renders: 0, // main-scene renders projected with the stand-in
  rigs: 0, // rigs projected by a RigPusher
  rigsToThree: 0, // E children handed to three whole (not a plain Group)
  cold: 0, // meshes pushed by a SegPusher
  hot: 0, // nodes handed to three inside a rig
  carriers: 0, // hot nodes that needed a groupOrder carrier
  lateRestores: 0, // stand-in restored outside list.finish (a throw inside projectObject)
  projections: 0, // renderers with the projection installed (index.js; 0 with the flag on = only the walk runs)
  refused: null, // install refusal reason (premise drift)
};
/** Diag snapshot (`window.__entityWorld.stats()`). */
export function entityWorldStats() {
  return { enabled: entityWorldEnabled(), walkOff: ctl.walkOff, projOff: ctl.projOff, ...stats };
}
function _publishDiag() {
  if (typeof window === "undefined" || !window || window.__entityWorld) return;
  try {
    window.__entityWorld = {
      stats: entityWorldStats,
      get walkOff() { return ctl.walkOff; },
      set walkOff(v) { ctl.walkOff = !!v; },
      get projOff() { return ctl.projOff; },
      set projOff(v) { ctl.projOff = !!v; },
    };
  } catch (_) { /* diag only */ }
}
/** Test seam: reset counters and live switches (`{ premises: true }` also re-checks the walk premises). */
export function __resetEntityWorldForTest(o = {}) {
  for (const k of Object.keys(stats)) stats[k] = k === "refused" ? null : 0;
  ctl.walkOff = false;
  ctl.projOff = false;
  if (o.premises === true) _walkPremise = null;
}

const norm = (s) => String(s).replace(/\s+/g, " ");

// ---------------------------------------------------------------------------------------------
// Premises: the three r184 bodies this module reproduces (whitespace-normalised source text).
// ---------------------------------------------------------------------------------------------
export const WALK_PREMISES = Object.freeze({
  compose:
    "const te = this.elements; const x = quaternion._x, y = quaternion._y, z = quaternion._z, w = quaternion._w; " +
    "const x2 = x + x, y2 = y + y, z2 = z + z; const xx = x * x2, xy = x * y2, xz = x * z2; " +
    "const yy = y * y2, yz = y * z2, zz = z * z2; const wx = w * x2, wy = w * y2, wz = w * z2; " +
    "const sx = scale.x, sy = scale.y, sz = scale.z; te[ 0 ] = ( 1 - ( yy + zz ) ) * sx; te[ 1 ] = ( xy + wz ) * sx; " +
    "te[ 2 ] = ( xz - wy ) * sx; te[ 3 ] = 0; te[ 4 ] = ( xy - wz ) * sy; te[ 5 ] = ( 1 - ( xx + zz ) ) * sy; " +
    "te[ 6 ] = ( yz + wx ) * sy; te[ 7 ] = 0; te[ 8 ] = ( xz + wy ) * sz; te[ 9 ] = ( yz - wx ) * sz; " +
    "te[ 10 ] = ( 1 - ( xx + yy ) ) * sz; te[ 11 ] = 0; te[ 12 ] = position.x; te[ 13 ] = position.y; " +
    "te[ 14 ] = position.z; te[ 15 ] = 1; return this;",
  multiplyMatrices:
    "const ae = a.elements; const be = b.elements; const te = this.elements; " +
    "const a11 = ae[ 0 ], a12 = ae[ 4 ], a13 = ae[ 8 ], a14 = ae[ 12 ]; const a21 = ae[ 1 ], a22 = ae[ 5 ], a23 = ae[ 9 ], a24 = ae[ 13 ]; " +
    "const a31 = ae[ 2 ], a32 = ae[ 6 ], a33 = ae[ 10 ], a34 = ae[ 14 ]; const a41 = ae[ 3 ], a42 = ae[ 7 ], a43 = ae[ 11 ], a44 = ae[ 15 ]; " +
    "const b11 = be[ 0 ], b12 = be[ 4 ], b13 = be[ 8 ], b14 = be[ 12 ]; const b21 = be[ 1 ], b22 = be[ 5 ], b23 = be[ 9 ], b24 = be[ 13 ]; " +
    "const b31 = be[ 2 ], b32 = be[ 6 ], b33 = be[ 10 ], b34 = be[ 14 ]; const b41 = be[ 3 ], b42 = be[ 7 ], b43 = be[ 11 ], b44 = be[ 15 ]; " +
    "te[ 0 ] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41; te[ 4 ] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42; " +
    "te[ 8 ] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43; te[ 12 ] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44; " +
    "te[ 1 ] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41; te[ 5 ] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42; " +
    "te[ 9 ] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43; te[ 13 ] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44; " +
    "te[ 2 ] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41; te[ 6 ] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42; " +
    "te[ 10 ] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43; te[ 14 ] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44; " +
    "te[ 3 ] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41; te[ 7 ] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42; " +
    "te[ 11 ] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43; te[ 15 ] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44; return this;",
  updateMatrix:
    "this.matrix.compose( this.position, this.quaternion, this.scale ); const pivot = this.pivot; if ( pivot !== null ) {",
  updateMatrixWorld:
    "if ( this.matrixAutoUpdate ) this.updateMatrix(); if ( this.matrixWorldNeedsUpdate || force ) { " +
    "if ( this.matrixWorldAutoUpdate === true ) { if ( this.parent === null ) { this.matrixWorld.copy( this.matrix ); } " +
    "else { this.matrixWorld.multiplyMatrices( this.parent.matrixWorld, this.matrix ); } } " +
    "this.matrixWorldNeedsUpdate = false; force = true; }",
  updateMatrixWorldChildren:
    "const children = this.children; for ( let i = 0, l = children.length; i < l; i ++ ) { const child = children[ i ]; child.updateMatrixWorld( force ); }",
});

export const PROJECT_PREMISES = Object.freeze([
  // projectObject's head: visible first, then the layers test, then the type ladder.
  "function projectObject( object, camera, groupOrder, sortObjects ) { if ( object.visible === false ) return; " +
    "const visible = object.layers.test( camera.layers ); if ( visible ) { if ( object.isGroup ) { groupOrder = object.renderOrder; } " +
    "else if ( object.isLOD ) { if ( object.autoUpdate === true ) object.update( camera ); } else if ( object.isLightProbeGrid ) {",
  // the mesh branch: frustum test, objects.update, z from the bounding-sphere centre, push.
  "} else if ( object.isMesh || object.isLine || object.isPoints ) { if ( ! object.frustumCulled || _frustum.intersectsObject( object ) ) { " +
    "const geometry = objects.update( object ); const material = object.material; if ( sortObjects ) { " +
    "if ( object.boundingSphere !== undefined ) { if ( object.boundingSphere === null ) object.computeBoundingSphere(); _vector4.copy( object.boundingSphere.center ); } " +
    "else { if ( geometry.boundingSphere === null ) geometry.computeBoundingSphere(); _vector4.copy( geometry.boundingSphere.center ); } " +
    "_vector4 .applyMatrix4( object.matrixWorld ) .applyMatrix4( _projScreenMatrix ); } if ( Array.isArray( material ) ) {",
  "} else if ( material.visible ) { currentRenderList.push( object, geometry, material, groupOrder, _vector4.z, null ); } } } } " +
    "const children = object.children; for ( let i = 0, l = children.length; i < l; i ++ ) { projectObject( children[ i ], camera, groupOrder, sortObjects ); } }",
  // render(): onBeforeRender → frustum → renderLists.get → projectObject → finish, nothing else between.
  "if ( scene.isScene === true ) scene.onBeforeRender( _this, scene, camera, _currentRenderTarget ); currentRenderState = renderStates.get( scene, renderStateStack.length );",
  "_projScreenMatrix.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse ); " +
    "_frustum.setFromProjectionMatrix( _projScreenMatrix, WebGLCoordinateSystem, camera.reversedDepth );",
  "currentRenderList = renderLists.get( scene, renderListStack.length ); currentRenderList.init(); renderListStack.push( currentRenderList );",
  "projectObject( scene, camera, 0, _this.sortObjects ); currentRenderList.finish();",
]);

// ---------------------------------------------------------------------------------------------
// 1. WALK
// ---------------------------------------------------------------------------------------------
const O3D = THREE.Object3D.prototype;
let _walkPremise = null; // { ok, um, umwOrig } once checked
function _bodyOf(fn) {
  const s = norm(Function.prototype.toString.call(fn));
  const i = s.indexOf("{");
  return i < 0 ? "" : s.slice(i + 1).trim();
}
function _walkPremisesOk() {
  if (_walkPremise !== null) return _walkPremise.ok;
  let ok = false;
  let reason = null;
  try {
    const M = THREE.Matrix4.prototype;
    const orig = O3D.__hbSkipHidden || O3D.updateMatrixWorld; // three's own (skip_hidden keeps it)
    const um = _bodyOf(O3D.updateMatrix);
    const umw = _bodyOf(orig);
    if (!_bodyOf(M.compose).startsWith(WALK_PREMISES.compose)) reason = "Matrix4.compose";
    else if (!_bodyOf(M.multiplyMatrices).startsWith(WALK_PREMISES.multiplyMatrices)) reason = "Matrix4.multiplyMatrices";
    else if (!um.startsWith(WALK_PREMISES.updateMatrix) || !um.includes("this.matrixWorldNeedsUpdate = true;")) reason = "Object3D.updateMatrix";
    else if (!umw.startsWith(WALK_PREMISES.updateMatrixWorld) || !umw.includes(WALK_PREMISES.updateMatrixWorldChildren)) reason = "Object3D.updateMatrixWorld";
    else ok = true;
    _walkPremise = { ok, um: O3D.updateMatrix, umwOrig: orig };
  } catch (e) {
    reason = `premise check threw: ${e && e.message}`;
    _walkPremise = { ok: false, um: null, umwOrig: null };
  }
  if (!ok) {
    stats.refused = `walk: three drift (${reason})`;
    // eslint-disable-next-line no-console
    try { console.warn(`[entity_world] ?rustEntityWorld walk refused — ${stats.refused}; three's walk stays in use`); } catch (_) {}
  }
  return ok;
}

// three r184 Matrix4.compose into `te`, operation for operation (WALK_PREMISES.compose).
function _compose(te, p, q, s) {
  const x = q._x, y = q._y, z = q._z, w = q._w;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = s.x, sy = s.y, sz = s.z;
  te[0] = (1 - (yy + zz)) * sx; te[1] = (xy + wz) * sx; te[2] = (xz - wy) * sx; te[3] = 0;
  te[4] = (xy - wz) * sy; te[5] = (1 - (xx + zz)) * sy; te[6] = (yz + wx) * sy; te[7] = 0;
  te[8] = (xz + wy) * sz; te[9] = (yz - wx) * sz; te[10] = (1 - (xx + yy)) * sz; te[11] = 0;
  te[12] = p.x; te[13] = p.y; te[14] = p.z; te[15] = 1;
}
// three r184 Matrix4.multiplyMatrices(a, b) into `te` (every operand read before any store).
function _multiply(te, ae, be) {
  const a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12];
  const a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13];
  const a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
  const a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];
  const b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12];
  const b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13];
  const b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
  const b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];
  te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
  te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
  te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
  te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
  te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
  te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
  te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
  te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
  te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
  te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
  te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
  te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
  te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
  te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
  te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
  te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
}
// No −0, no ±Inf, no NaN: then three's multiplyMatrices(P, I) is P, bit for bit (docs §4.1).
function _clean(e) {
  for (let k = 0; k < 16; k += 1) {
    const v = e[k];
    if (v === 0 ? 1 / v < 0 : !(v - v === 0)) return false;
  }
  return true;
}

/**
 * `?rustEntityWorld`: give an entity rig root the entity walk (entities.js rig build). Only a root
 * that walks like a plain Object3D (no own / class updateMatrixWorld) qualifies; its own
 * `updateMatrix` (visual_ground.js) is kept and called as three would. Returns true when installed.
 */
export function installEntityWorldRoot(root) {
  if (!entityWorldEnabled() || !root || root.isObject3D !== true) return false;
  if (root.updateMatrixWorld === entityRootUpdateMatrixWorld) return true;
  if (Object.prototype.hasOwnProperty.call(root, "updateMatrixWorld") || root.updateMatrixWorld !== O3D.updateMatrixWorld) return false;
  if (!_walkPremisesOk()) return false;
  root.updateMatrixWorld = entityRootUpdateMatrixWorld;
  stats.roots += 1;
  _publishDiag();
  return true;
}

/** True when `root` walks through this module. */
export function entityWorldRootInstalled(root) {
  return !!root && root.updateMatrixWorld === entityRootUpdateMatrixWorld;
}

function entityRootUpdateMatrixWorld(force) {
  const umw = O3D.updateMatrixWorld;
  const um = O3D.updateMatrix;
  const mode = skipHiddenWalkMode();
  const P0 = _walkPremise;
  // three's walk for this root (and so its subtree): the live seam, the walk census (it must
  // count every node), or the prototype methods are no longer the ones the premises cover.
  if (ctl.walkOff || mode === 2 || P0 === null || P0.ok !== true || um !== P0.um ||
      (umw !== P0.umwOrig && umw !== skipHiddenMethod())) {
    stats.walkFallbacks += 1;
    return umw.call(this, force);
  }
  const skipping = mode === 1;
  // ---- the root: three r184 updateMatrixWorld (skip_hidden's rule first) ----
  if (skipping && this.visible === false && this.parent !== null) {
    this.matrixWorldNeedsUpdate = true;
    return;
  }
  if (this.matrixAutoUpdate) this.updateMatrix();
  if (this.matrixWorldNeedsUpdate || force) {
    if (this.matrixWorldAutoUpdate === true) {
      if (this.parent === null) this.matrixWorld.copy(this.matrix);
      else this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
    }
    this.matrixWorldNeedsUpdate = false;
    force = true;
  }
  stats.walks += 1;
  const rw = this.matrixWorld.elements;
  const parts = this.children;
  for (let i = 0, l = parts.length; i < l; i += 1) {
    const p = parts[i];
    if (p.isGroup !== true || p.updateMatrixWorld !== umw || p.updateMatrix !== um) {
      p.updateMatrixWorld(force);
      continue;
    }
    // ---- a plain Group part: three's body, compose / multiply inlined ----
    if (skipping && p.visible === false) {
      p.matrixWorldNeedsUpdate = true;
      continue;
    }
    let pNeeds = p.matrixWorldNeedsUpdate;
    if (p.matrixAutoUpdate) {
      if (p.pivot !== null) um.call(p);
      else _compose(p.matrix.elements, p.position, p.quaternion, p.scale);
      pNeeds = true;
    }
    let pForce = force;
    if (pNeeds || force) {
      if (p.matrixWorldAutoUpdate === true) _multiply(p.matrixWorld.elements, rw, p.matrix.elements);
      p.matrixWorldNeedsUpdate = false;
      pForce = true;
    }
    const pw = p.matrixWorld.elements;
    let clean = -1; // part world checked lazily, once
    const meshes = p.children;
    for (let j = 0, n = meshes.length; j < n; j += 1) {
      const m = meshes[j];
      if (m.isMesh !== true || m.updateMatrixWorld !== umw || m.updateMatrix !== um || m.children.length !== 0) {
        m.updateMatrixWorld(pForce);
        continue;
      }
      // ---- a plain leaf mesh ----
      if (skipping && m.visible === false) {
        m.matrixWorldNeedsUpdate = true;
        continue;
      }
      let mNeeds = m.matrixWorldNeedsUpdate;
      if (m.matrixAutoUpdate) {
        if (m.pivot !== null) {
          um.call(m);
        } else {
          const mp = m.position, mq = m.quaternion, ms = m.scale;
          if (m.matrixWorldAutoUpdate === true &&
              mp.x === 0 && mp.y === 0 && mp.z === 0 && mq._x === 0 && mq._y === 0 && mq._z === 0 && mq._w === 1 &&
              ms.x === 1 && ms.y === 1 && ms.z === 1 &&
              1 / mp.x > 0 && 1 / mp.y > 0 && 1 / mp.z > 0 && 1 / mq._x > 0 && 1 / mq._y > 0 && 1 / mq._z > 0) {
            if (clean < 0) {
              clean = _clean(pw) ? 1 : 0;
              if (clean === 0) stats.unclean += 1;
            }
            if (clean === 1) {
              // three: compose(+0,+0,+0 / +0,+0,+0,1 / 1,1,1) is the exact identity; P × I is P.
              const te = m.matrix.elements;
              te[0] = 1; te[1] = 0; te[2] = 0; te[3] = 0; te[4] = 0; te[5] = 1; te[6] = 0; te[7] = 0;
              te[8] = 0; te[9] = 0; te[10] = 1; te[11] = 0; te[12] = 0; te[13] = 0; te[14] = 0; te[15] = 1;
              const we = m.matrixWorld.elements;
              we[0] = pw[0]; we[1] = pw[1]; we[2] = pw[2]; we[3] = pw[3]; we[4] = pw[4]; we[5] = pw[5]; we[6] = pw[6]; we[7] = pw[7];
              we[8] = pw[8]; we[9] = pw[9]; we[10] = pw[10]; we[11] = pw[11]; we[12] = pw[12]; we[13] = pw[13]; we[14] = pw[14]; we[15] = pw[15];
              m.matrixWorldNeedsUpdate = false;
              stats.identity += 1;
              continue;
            }
          }
          _compose(m.matrix.elements, mp, mq, ms);
        }
        mNeeds = true;
      }
      if (mNeeds || pForce) {
        if (m.matrixWorldAutoUpdate === true) _multiply(m.matrixWorld.elements, pw, m.matrix.elements);
        m.matrixWorldNeedsUpdate = false;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 2. PROJECTION
// ---------------------------------------------------------------------------------------------
const ALL_LAYERS = new THREE.Layers();
ALL_LAYERS.enableAll();
const _v4 = new THREE.Vector4();

// Shapes projectObject reads: visible, layers, the type flags, renderOrder (Groups), children.
class RigPusher {
  constructor(st) {
    this.st = st;
    this.target = null;
    this.layers = ALL_LAYERS;
    this.isGroup = false;
    this.isLOD = false;
    this.isLightProbeGrid = false;
    this.isLight = false;
    this.isSprite = false;
    this.isMesh = false;
    this.isLine = false;
    this.isPoints = false;
    this.renderOrder = 0;
    this.children = [];
    this.segs = [];
    this.nSeg = 0;
    this.cars = [];
    this.nCar = 0;
  }
  get visible() { return this.st.projectRig(this); }
  set visible(_) { /* never written: three reads it only */ }
  // Inert if it ever reached a walk (it never should: the stand-in lives inside projectObject).
  updateMatrixWorld() {}
}
class SegPusher {
  constructor(st) {
    this.st = st;
    this.layers = ALL_LAYERS;
    this.isGroup = false;
    this.isLOD = false;
    this.isLightProbeGrid = false;
    this.isLight = false;
    this.isSprite = false;
    this.isMesh = false;
    this.isLine = false;
    this.isPoints = false;
    this.renderOrder = 0;
    this.children = [];
    this.items = [];
    this.orders = [];
    this.n = 0;
  }
  get visible() { this.st.pushSeg(this); return false; }
  set visible(_) { /* never written */ }
  updateMatrixWorld() {}
}
class Carrier {
  constructor() {
    this.visible = true;
    this.layers = ALL_LAYERS;
    this.isGroup = true;
    this.isLOD = false;
    this.isLightProbeGrid = false;
    this.isLight = false;
    this.isSprite = false;
    this.isMesh = false;
    this.isLine = false;
    this.isPoints = false;
    this.renderOrder = 0;
    this.children = [null];
  }
  updateMatrixWorld() {}
}

/** The render state of one installed renderer. */
class ProjectionState {
  constructor(renderer, getScene, getEntities) {
    this.renderer = renderer;
    this.getScene = getScene;
    this.getEntities = getEntities;
    this.camera = null; // noted by scene.onBeforeRender, consumed by the next renderLists.get
    this.cameraScene = null;
    this.camUsed = null; // the camera of the render being projected
    this.E = null;
    this.real = null;
    this.standIn = [];
    this.pushers = [];
    this.swapped = false;
    this.list = null;
    this.frameReady = false;
    this.gE = 0;
    this.proj = new THREE.Matrix4();
    this.frustum = new THREE.Frustum();
    this.epoch = 1; // bumped by a context restore / new render lists: every cold record expires
    this.lists = null;
    this.finishWrapped = new WeakSet();
    this.serial = 0; // per main-scene render: the per-geometry validation memo
    this.frame = -1; // renderer.info.render.frame of the render being projected (three's update memo key)
    const self = this;
    // a disposed geometry loses its buffers in three: its record expires (re-noted on three's visit)
    this.onGeometryDispose = function onEntityWorldGeometryDispose(event) {
      const rec = event.target.__hbEw;
      if (rec !== undefined && rec !== null && rec.st === self) rec.ok = false;
    };
  }

  /** scene.onBeforeRender: the camera this render projects with. */
  noteCamera(renderer, scene, camera) {
    if (renderer !== this.renderer) return;
    this.camera = camera;
    this.cameraScene = scene;
    if (renderer.renderLists !== this.lists) this.hookLists();
  }

  hookLists() {
    const lists = this.renderer.renderLists;
    if (!lists || typeof lists.get !== "function") return;
    this.lists = lists;
    this.epoch += 1;
    if (lists.__hbEntityWorld === this) return;
    const get0 = lists.get;
    const self = this;
    lists.get = function hbEntityWorldGet(scene, depth) {
      const list = get0.call(this, scene, depth);
      self.onGet(scene, list);
      return list;
    };
    try { Object.defineProperty(lists, "__hbEntityWorld", { value: this, configurable: true }); } catch (_) { lists.__hbEntityWorld = this; }
  }

  onGet(scene, list) {
    if (this.swapped) { this.restore(); stats.lateRestores += 1; }
    const cam = this.camera;
    this.camera = null; // one render
    if (!entityWorldEnabled() || ctl.projOff || cam === null || this.cameraScene !== scene || !list) return;
    const r = this.renderer;
    if (r.sortObjects !== true || (r.xr && r.xr.enabled === true && r.xr.isPresenting === true)) return;
    let main = null;
    try { main = this.getScene(); } catch (_) { main = null; }
    if (scene !== main) return;
    let E = null;
    try { E = this.getEntities(); } catch (_) { E = null; }
    if (!E || !Array.isArray(E.children) || E.children.length === 0) return;
    if (!this.finishWrapped.has(list)) this.wrapFinish(list);
    // the stand-in: one RigPusher per visible real child, in order (projectObject returns at once
    // for a hidden child — no side effect — so leaving it out changes nothing)
    const real = E.children;
    const sin = this.standIn;
    let n = 0;
    for (let i = 0, l = real.length; i < l; i += 1) {
      const c = real[i];
      if (c.visible === false) continue;
      let rp = this.pushers[n];
      if (rp === undefined) { rp = new RigPusher(this); this.pushers[n] = rp; }
      rp.target = c;
      sin[n] = rp;
      n += 1;
    }
    for (let i = n; i < this.pushers.length; i += 1) this.pushers[i].target = null;
    sin.length = n;
    this.camUsed = cam;
    this.list = list;
    this.frameReady = false;
    this.E = E;
    this.real = real;
    E.children = sin;
    this.swapped = true;
    this.serial += 1;
    this.frame = r.info.render.frame;
    stats.renders += 1;
  }

  restore() {
    if (!this.swapped) return;
    this.E.children = this.real;
    this.swapped = false;
    this.list = null;
    this.real = null;
    this.camUsed = null;
    // projectObject is done with the stand-in (three never reads it again; the render list holds
    // the real objects): drop every reference the pool holds into the rigs — targets, hot nodes,
    // carrier slots, segment items (left only by a throw inside projectObject). Each render
    // clears what it used, so no pusher, carrier or segment keeps a despawned rig reachable
    // (stock: WebGLRenderList.finish nulls its inactive render items the same way).
    const sin = this.standIn;
    for (let i = 0, l = sin.length; i < l; i += 1) {
      const rp = sin[i];
      rp.target = null;
      rp.children.length = 0;
      const cars = rp.cars;
      for (let k = 0, c = rp.nCar; k < c; k += 1) cars[k].children[0] = null;
      rp.nCar = 0;
      const segs = rp.segs;
      for (let s = 0, ns = rp.nSeg; s < ns; s += 1) {
        const seg = segs[s];
        const items = seg.items;
        for (let k = 0, n = seg.n; k < n; k += 1) items[k] = null;
        seg.n = 0;
      }
      rp.nSeg = 0;
    }
    sin.length = 0;
  }

  wrapFinish(list) {
    this.finishWrapped.add(list);
    const fin = list.finish;
    const self = this;
    list.finish = function hbEntityWorldFinish() {
      if (self.swapped && self.list === this) self.restore();
      return fin.call(this);
    };
  }

  /** First rig pusher of a render: three's frustum (same inputs, same code) and the groupOrder
   *  three passes to the entities group's children (projectObject's rules from the scene down). */
  prepareFrame() {
    const cam = this.camUsed;
    this.proj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.proj, THREE.WebGLCoordinateSystem, cam.reversedDepth);
    const chain = [];
    for (let o = this.E; o !== null && o !== undefined; o = o.parent) chain.push(o);
    let g = 0;
    const L = cam.layers;
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const o = chain[i];
      if (o.layers.test(L) && o.isGroup === true) g = o.renderOrder;
    }
    this.gE = g;
    this.frameReady = true;
  }

  /** A RigPusher's `visible`: projectObject over its rig, mirrored; returns three's answer for the pusher. */
  projectRig(rp) {
    const root = rp.target;
    if (!this.swapped || root === null) return false;
    if (root.visible === false) return false; // three: return
    const kids = rp.children;
    kids.length = 0;
    rp.nSeg = 0;
    rp.nCar = 0;
    if (root.isGroup !== true) {
      // not a rig root (debris mesh, sprite, …): three projects it, unchanged (groupOrder gE).
      kids.push(root);
      stats.rigsToThree += 1;
      return true;
    }
    if (!this.frameReady) this.prepareFrame();
    stats.rigs += 1;
    const L = this.camUsed.layers;
    const gE = this.gE;
    const gR = root.layers.test(L) ? root.renderOrder : gE;
    let seg = null;
    let cold = 0;
    const ch = root.children;
    for (let i = 0, l = ch.length; i < l; i += 1) {
      const c = ch[i];
      if (c.visible === false) continue;
      if (c.isGroup !== true) { seg = null; this.addHot(rp, c, gR); continue; }
      const gP = c.layers.test(L) ? c.renderOrder : gR;
      const ms = c.children;
      for (let j = 0, n = ms.length; j < n; j += 1) {
        const m = ms[j];
        if (m.visible === false) continue;
        if (m.isMesh !== true || m.isSkinnedMesh === true || m.isInstancedMesh === true || m.isBatchedMesh === true ||
            m.children.length !== 0 || m.boundingSphere !== undefined || Array.isArray(m.material)) {
          seg = null;
          this.addHot(rp, m, gP);
          continue;
        }
        if (!m.layers.test(L)) continue; // three: no push, no children
        if (m.frustumCulled && !this.frustum.intersectsObject(m)) continue; // three: culled
        if (!this.coldValid(m)) {
          // three runs objects.update for it now (it passes visible / layers / frustum)
          seg = null;
          this.note(m);
          this.addHot(rp, m, gP);
          continue;
        }
        if (!m.material.visible) continue; // three: objects.update (a no-op for it), no push
        if (seg === null) {
          seg = rp.segs[rp.nSeg];
          if (seg === undefined) { seg = new SegPusher(this); rp.segs[rp.nSeg] = seg; }
          rp.nSeg += 1;
          seg.n = 0;
          kids.push(seg);
        }
        seg.items[seg.n] = m;
        seg.orders[seg.n] = gP;
        seg.n += 1;
        cold += 1;
      }
    }
    stats.cold += cold;
    return true;
  }

  addHot(rp, node, g) {
    stats.hot += 1;
    if (g === this.gE) { rp.children.push(node); return; }
    let car = rp.cars[rp.nCar];
    if (car === undefined) { car = new Carrier(); rp.cars[rp.nCar] = car; }
    rp.nCar += 1;
    car.renderOrder = g;
    car.children[0] = node;
    rp.children.push(car);
    stats.carriers += 1;
  }

  /** A SegPusher's `visible`: its cold meshes, pushed exactly as projectObject's mesh branch does. */
  pushSeg(seg) {
    const list = this.list;
    const proj = this.proj;
    if (list === null) return;
    for (let i = 0, n = seg.n; i < n; i += 1) {
      const m = seg.items[i];
      const g = m.geometry;
      _v4.copy(g.boundingSphere.center).applyMatrix4(m.matrixWorld).applyMatrix4(proj);
      list.push(m, g, m.material, seg.orders[i], _v4.z, null);
      seg.items[i] = null;
    }
    seg.n = 0;
  }

  /** three is about to run WebGLObjects.update for `m`: record what it sees for the GEOMETRY
   *  (WebGLObjects keys its work by geometry, so the record lives on it, shared by every mesh
   *  drawing it): its attribute objects with their versions, in key order.
   *
   *  That update can be a memo no-op: three runs it once per `info.render.frame` value, and a
   *  shadow raster runs it AFTER render()'s `frame++` — so a raster in the previous render (or a
   *  throw before `frame++`) leaves the memo at the frame value this visit sees, and three uploads
   *  nothing here. The record is therefore CONFIRMED (coldValid trusts it) only when an earlier note
   *  at ANOTHER frame value — same epoch, not disposed since — saw the same attribute objects at the
   *  same versions: this visit's update then either ran (memo older), or was memoised by a call made
   *  after that earlier note (a later frame value), which uploaded those same attributes. */
  note(m) {
    const g = m.geometry;
    let rec = g.__hbEw;
    if (rec === undefined || rec === null || rec.st !== this) {
      rec = { st: this, epoch: 0, ok: false, serial: -1, valid: false, n: 0, objs: [], vers: [], frame: -1, confirmed: false };
      g.__hbEw = rec;
      try { g.addEventListener("dispose", this.onGeometryDispose); } catch (_) { return; }
    }
    const frame = this.frame;
    const confirmed = rec.ok === true && rec.epoch === this.epoch && rec.frame !== frame && this.sameAttrs(rec, g);
    let ok = true;
    let k = 0;
    const at = g.attributes;
    const objs = rec.objs, vers = rec.vers;
    for (const name in at) {
      const a = at[name];
      if (!a || a.isInterleavedBufferAttribute === true || a.isGLBufferAttribute === true) ok = false;
      objs[k] = a;
      vers[k] = a ? a.version : -1;
      k += 1;
    }
    rec.n = k;
    objs.length = k;
    vers.length = k;
    rec.epoch = this.epoch;
    rec.ok = ok;
    rec.frame = frame;
    rec.confirmed = confirmed && ok;
    rec.serial = -1; // validate afresh at the next look
  }

  /** The geometry holds the record's attribute objects at the recorded versions, same keys, same order. */
  sameAttrs(rec, g) {
    const at = g.attributes;
    const objs = rec.objs, vers = rec.vers, n = rec.n;
    let k = 0;
    for (const name in at) {
      const a = at[name];
      if (k >= n || a !== objs[k] || a.version !== vers[k]) return false;
      k += 1;
    }
    return k === n;
  }

  /** WebGLObjects.update would be a no-op for `m` (see the header, COLD): its geometry was brought
   *  current by three (noted and confirmed), not disposed since, no context restore since, and it
   *  still holds the same attribute objects at the same versions in the same key order (one for-in;
   *  a key added, removed or reordered fails it). Validated once per geometry per render (nothing
   *  between two looks inside one projectObject can change an attribute). */
  coldValid(m) {
    const g = m.geometry;
    const rec = g.__hbEw;
    if (rec === undefined || rec === null || rec.st !== this || rec.ok !== true || rec.confirmed !== true || rec.epoch !== this.epoch || g.boundingSphere === null) return false;
    if (rec.serial === this.serial) return rec.valid;
    const at = g.attributes;
    const objs = rec.objs, vers = rec.vers, n = rec.n;
    let valid = true;
    let k = 0;
    for (const name in at) {
      const a = at[name];
      if (k >= n || a !== objs[k] || a.version !== vers[k]) { valid = false; break; }
      k += 1;
    }
    if (k !== n) valid = false;
    rec.serial = this.serial;
    rec.valid = valid;
    return valid;
  }
}

/** The first PROJECT_PREMISES entry missing from `src` (WebGLRenderer's source), as a refusal reason; null when all hold. */
export function projectPremiseFailure(src) {
  const s = norm(src);
  for (const p of PROJECT_PREMISES) if (!s.includes(norm(p))) return `three drift (WebGLRenderer lacks "${p.slice(0, 60)}…")`;
  return null;
}
function _projectPremisesOk() {
  try {
    return projectPremiseFailure(Function.prototype.toString.call(THREE.WebGLRenderer));
  } catch (e) {
    return `premise check threw: ${e && e.message}`;
  }
}

/**
 * `?rustEntityWorld`: the projection half, for one renderer (scene3d/index.js, after
 * installDrawExec, once the world groups exist — REQUIRED there: the rig build cannot install it in
 * the client; idempotent). `getScene()` → the main scene, `getEntities()` → worldRoot's entities
 * group. Returns the state (or null when the flag is off / the install refused).
 */
export function installEntityWorld(renderer, getScene, getEntities) {
  if (!entityWorldEnabled() || !renderer || typeof getScene !== "function" || typeof getEntities !== "function") return null;
  if (renderer.__hbEntityWorld) return renderer.__hbEntityWorld;
  const why = _projectPremisesOk();
  if (why !== null) {
    stats.refused = `projection: ${why}`;
    // eslint-disable-next-line no-console
    try { console.warn(`[entity_world] ?rustEntityWorld projection refused — ${why}; three's projectObject stays in use`); } catch (_) {}
    return null;
  }
  const st = new ProjectionState(renderer, getScene, getEntities);
  // the camera: scene.onBeforeRender (chained; frame_split's diag wraps whatever it finds)
  const scene = getScene();
  if (!scene || scene.isScene !== true) return null;
  const prev = scene.onBeforeRender;
  scene.onBeforeRender = function hbEntityWorldBeforeRender(r, sc, cam, rt) {
    if (typeof prev === "function") prev.call(this, r, sc, cam, rt);
    st.noteCamera(r, sc, cam);
  };
  st.hookLists();
  // a throw inside projectObject skips list.finish: put the real children back on the way out
  const render0 = renderer.render;
  renderer.render = function hbEntityWorldRender(sc, cam) {
    try {
      return render0.call(this, sc, cam);
    } finally {
      if (st.swapped) { st.restore(); stats.lateRestores += 1; }
    }
  };
  try {
    const el = renderer.domElement;
    if (el && typeof el.addEventListener === "function") el.addEventListener("webglcontextrestored", () => { st.epoch += 1; }, false);
  } catch (_) { /* best effort; new render lists also bump the epoch */ }
  try { Object.defineProperty(renderer, "__hbEntityWorld", { value: st, configurable: true }); } catch (_) { renderer.__hbEntityWorld = st; }
  stats.projections += 1;
  _publishDiag();
  return st;
}

/** Lazy install from the rig build (entities.js), for a scene3d that carries `renderer` and `scene`.
 *  The client's EntityManager gets index.js's scene3dForBuilders, which carries neither, so this is
 *  null there: the client's projection comes from index.js's explicit installEntityWorld line. */
export function ensureEntityWorld(scene3d) {
  if (!entityWorldEnabled() || !scene3d) return null;
  const r = scene3d.renderer;
  if (!r) return null;
  if (r.__hbEntityWorld) return r.__hbEntityWorld;
  if (!scene3d.scene || !scene3d.entitiesGroup) return null;
  return installEntityWorld(r, () => scene3d.scene, () => scene3d.entitiesGroup);
}
