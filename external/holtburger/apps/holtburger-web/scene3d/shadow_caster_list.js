// scene3d/shadow_caster_list.js — walk the scene ONCE per shadow raster, not once
// per shadow-casting light (`?shadowCasterList`, DEFAULT ON, `=off` escape).
// Perf 2026-10-07.
//
// WHY. three r184's `WebGLShadowMap.render` calls its private `renderObject(scene,
// …)` once PER LIGHT, and that recursion visits every visible node of the whole
// scene graph (three.module.js :9543 — it recurses `children` unconditionally,
// testing `castShadow` only at mesh leaves). csm.js runs THREE cascade lights, so
// a rastering frame walks the graph three times on top of updateMatrixWorld and
// projectObject. MEASURED (prof3.json, 1070 quality ultra, fighting/running,
// 222 frames — the RP5 static-shadow gate re-rastered on 222/222 of them because
// the player and camera moved): `renderObject` self 605 ms = 2.7 ms/frame, at
// ~12k visible nodes x 3 cascades ≈ 36k visits/frame. Most of those nodes can
// never draw into a shadow map: rig/part Groups, sprites, terrain (castShadow
// false), particles, nameplates.
//
// WHAT. A wrapper on the renderer's `shadowMap.render` (an own property three
// assigns in the WebGLShadowMap constructor). On a frame that rasters, it walks
// the scene once with three's own rules — skip `visible === false` subtrees;
// a node is a CANDIDATE when it is a Mesh/Line/Points, `castShadow` (or
// `receiveShadow` under VSM), and passes `layers.test(camera.layers)` — and
// stops descending at each candidate. Then it hands three a stand-in root whose
// `children` is that candidate list. three's per-light `renderObject` then
// visits only the candidates (and recurses into THEIR subtrees itself, exactly as
// before), doing its own frustum test and draw.
//
// OUTPUT-IDENTICAL. The candidates are pushed in depth-first pre-order and the
// walk stops at the first candidate on every path, so three's recursion from
// each candidate reproduces the original visit order of every drawable node
// below it: same objects, same order, same per-light frustum tests, same
// onBeforeShadow / renderBufferDirect calls. (Depth-only draws are order-free
// anyway; identity of order is a stronger property than the output needs.) The
// stand-in root itself is never drawn — it is a plain Object3D, not a Mesh.
//
// ?shadowStaticCache (fps wave 1, 2026-10-17; the second half of this file)
// runs INSIDE this wrapper, first: for the managed CSM lights it may split a
// raster into a static-only pass, depth blits and a dynamic-only pass (stand-in
// roots over `collectSplit`'s static list and the dynamic root's list). When it
// does not apply it returns false and the single pass below runs as before.
//
// WHEN IT STEPS ASIDE (three's own call with the real scene):
//   * `?shadowCasterList=off`, or the live seam `window.__shadowCasterList.off`;
//   * every early-out three takes before walking (disabled, no update pending,
//     no lights) — so a gated-off frame (RP5) pays nothing for the walk;
//   * the frame `shadowMap.type` changes: three traverses the scene it is given
//     to flag every material for recompilation, and must see the real one.
//
// CONTEXT RESTORE (RENDER restore gap, 2026-10-18 follow-up). three r184's
// onContextRestore -> initGLContext builds a NEW WebGLShadowMap and assigns it
// to `renderer.shadowMap` (WebGLRenderer.js:456/508), carrying over only
// enabled / autoUpdate / needsUpdate / type (:1110-1121). The wrapper sat on
// the dead map, so after a restore ?shadowCasterList and ?shadowStaticCache
// were silently off. A `webglcontextrestored` listener (three's own, registered
// in its constructor, has already swapped the map) wraps the new map and
// carries the dynamic root over; the dead map's wrapper is left unreferenced.

import * as THREE from "three";
// ?swayShadow (2026-10-07): swaying trees cast swaying shadows.
import { applySwayShadow } from "./sway_shadow.js";

const FLAG = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("shadowCasterList") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();

export function shadowCasterListEnabled() {
  return FLAG;
}

const ctl = { off: false };
const stats = {
  walks: 0,        // rasters served from the candidate list
  passthrough: 0,  // rasters handed to three unchanged (off / type change)
  lastVisited: 0,  // nodes the last walk visited (three visited ~this x lights)
  lastListed: 0,   // candidates handed to three by the last walk
  visited: 0,      // cumulative
  listed: 0,       // cumulative
  reinstalls: 0,   // wrappers put on the new map a context restore built
};

// renderer -> the shadow map its wrapper is on / its restore listener.
const _wrappedMap = new WeakMap();
const _restoreHooks = new WeakMap();

/**
 * three's shadow-visit rules, collecting the first candidate on each path.
 * Returns the number of nodes visited (for the stats only).
 */
function collect(o, camLayers, vsm, out) {
  if (o.visible === false) return 1;
  if ((o.isMesh || o.isLine || o.isPoints) && (o.castShadow || (vsm && o.receiveShadow)) && o.layers.test(camLayers)) {
    out.push(o);
    // The walk already touches every caster each shadow pass: hand a
    // wind-swaying one its sway-aware depth material (once; sway_shadow.js).
    if (o.customDepthMaterial === undefined) applySwayShadow(o);
    return 1;
  }
  let n = 1;
  const ch = o.children;
  for (let i = 0, l = ch.length; i < l; i++) n += collect(ch[i], camLayers, vsm, out);
  return n;
}

/**
 * `collect` for ?shadowStaticCache: the same rules, but the walk does not
 * enter `dynRoot` — it only notes (`found.hit`) that the dynamic root is drawn
 * (every ancestor visible), so its subtree can be collected as the dynamic list.
 */
function collectSplit(o, camLayers, vsm, out, dynRoot, found) {
  if (o.visible === false) return 1;
  if (o === dynRoot) {
    found.hit = true;
    return 1;
  }
  if ((o.isMesh || o.isLine || o.isPoints) && (o.castShadow || (vsm && o.receiveShadow)) && o.layers.test(camLayers)) {
    out.push(o);
    if (o.customDepthMaterial === undefined) applySwayShadow(o);
    return 1;
  }
  let n = 1;
  const ch = o.children;
  for (let i = 0, l = ch.length; i < l; i++) n += collectSplit(ch[i], camLayers, vsm, out, dynRoot, found);
  return n;
}

function standInRoot(name) {
  const r = new THREE.Object3D();
  r.name = name;
  r.matrixAutoUpdate = false;
  r.matrixWorldAutoUpdate = false;
  return r;
}

/**
 * Wrap `renderer.shadowMap.render`. Returns true when installed (or already).
 * @param {THREE.WebGLRenderer|{shadowMap: object}} renderer
 */
export function installShadowCasterList(renderer, { force = false } = {}) {
  if ((!FLAG && !force) || !renderer || !renderer.shadowMap) return false;
  const sm = renderer.shadowMap;
  if (!sm.__hbCasterList && !_wrapShadowMap(renderer, sm, sm.type)) return false;
  _wrappedMap.set(renderer, sm);
  _hookRestore(renderer);
  return true;
}

/** Re-wrap `renderer.shadowMap` once a context restore has replaced it. */
function _hookRestore(renderer) {
  const el = renderer.domElement;
  if (_restoreHooks.has(renderer) || !el || typeof el.addEventListener !== "function") return;
  const onRestored = () => {
    const sm = renderer.shadowMap;
    const old = _wrappedMap.get(renderer);
    if (!sm || sm === old || sm.__hbCasterList) return;
    // lighting.js re-stamps it every gate tick; carried so the first restored
    // raster already has it.
    if (old && old.__hbShadowDynamicRoot && !sm.__hbShadowDynamicRoot) sm.__hbShadowDynamicRoot = old.__hbShadowDynamicRoot;
    // The new map's private `_previousType` is three's constructor default
    // (PCFShadowMap): if the restored type differs, three's first raster
    // re-creates the maps and walks the scene, so it must get the real one.
    if (_wrapShadowMap(renderer, sm, THREE.PCFShadowMap)) {
      _wrappedMap.set(renderer, sm);
      stats.reinstalls += 1;
    }
  };
  try {
    el.addEventListener("webglcontextrestored", onRestored, false);
    _restoreHooks.set(renderer, onRestored);
  } catch (_) { /* no restore re-wrap */ }
}

function _wrapShadowMap(renderer, sm, prevType) {
  const orig = sm.render;
  if (typeof orig !== "function") return false;
  const list = [];
  // The stand-in root: never added to a scene, never updated, never drawn.
  const root = new THREE.Object3D();
  root.name = "shadow-caster-list-root";
  root.matrixAutoUpdate = false;
  root.matrixWorldAutoUpdate = false;
  root.children = list;
  let lastType = prevType;
  // ?shadowStaticCache context: three's method, the two walkers, and three
  // stand-in roots (static + dynamic, static only, dynamic only).
  const cacheCtx = {
    renderer, sm, orig, collect, collectSplit,
    roots: { full: standInRoot("shadow-caster-list-full"), stat: standInRoot("shadow-caster-list-static"), dyn: standInRoot("shadow-caster-list-dynamic") },
  };
  sm.render = function (lights, scene, camera) {
    // three's own early-outs first: a frame that does not raster must not pay
    // for the walk.
    if (sm.enabled === false || (sm.autoUpdate === false && sm.needsUpdate === false)
      || !lights || lights.length === 0) {
      return orig.call(this, lights, scene, camera);
    }
    if (ctl.off || !scene || !camera || !camera.layers || sm.type !== lastType) {
      lastType = sm.type;
      stats.passthrough += 1;
      return orig.call(this, lights, scene, camera);
    }
    // Cached statics + dynamic overlay, when it applies (returns false to fall
    // through to the single pass below — off, not applicable, all NORMAL).
    if (shadowStaticCacheRender(cacheCtx, this, lights, scene, camera)) {
      stats.walks += 1;
      return undefined;
    }
    list.length = 0;
    let visited = 0;
    try {
      visited = collect(scene, camera.layers, sm.type === THREE.VSMShadowMap, list);
    } catch (_) {
      list.length = 0;
      stats.passthrough += 1;
      return orig.call(this, lights, scene, camera);
    }
    stats.walks += 1;
    stats.lastVisited = visited;
    stats.lastListed = list.length;
    stats.visited += visited;
    stats.listed += list.length;
    try {
      return orig.call(this, lights, root, camera);
    } finally {
      list.length = 0; // hold no scene references between frames
    }
  };
  Object.defineProperty(sm, "__hbCasterList", { value: { orig, root }, configurable: true });
  if (typeof window !== "undefined") {
    try {
      window.__shadowCasterList = {
        enabled: true,
        stats,
        get off() { return ctl.off; },
        set off(v) { ctl.off = !!v; },
      };
    } catch (_) {}
  }
  return true;
}

/** Test hook: restore three's method (and stop re-wrapping on a restore). */
export function uninstallShadowCasterList(renderer) {
  const onRestored = renderer && _restoreHooks.get(renderer);
  if (onRestored) {
    try { renderer.domElement.removeEventListener("webglcontextrestored", onRestored, false); } catch (_) {}
    _restoreHooks.delete(renderer);
  }
  if (renderer) _wrappedMap.delete(renderer);
  const sm = renderer?.shadowMap;
  const saved = sm && sm.__hbCasterList;
  if (!saved) return;
  sm.render = saved.orig;
  delete sm.__hbCasterList;
  ctl.off = false;
}

export function getShadowCasterListStats() {
  return { ...stats };
}

/** Test seam. */
export function __setShadowCasterListOffForTest(v) { ctl.off = !!v; }

// ===========================================================================
// ?shadowStaticCache — keep each shadow cascade's STATIC depth in a cache and,
// when only rigs changed, redraw just the rigs on top of it (DEFAULT ON, `=off`
// escape). fps wave 1, 2026-10-17. Lives in this module because it runs inside
// the wrapper above and needs its walk (a separate module would only add a
// boot preload).
// ===========================================================================
//
// WHY. MEASURED on the 1070 (quality ultra, LB 0xE632, player standing still):
// a CSM re-raster is ~1,260 casters / 390 draws / ~12 ms of main thread, and
// it ran on 46% of frames — 60 of 180 frames' triggers were "an entity moved".
// Freezing the re-raster measured 25.8 -> 38.8 fps (forced) / 30.1 -> 37.7
// (idle): the upper bound for this lever. When a rig is the only thing that
// changed, every one of the static draws in that raster (buildings, statics,
// tree buckets, interiors — and the per-instance culling of each batched
// bucket against the shadow camera) reproduces the same depth as last time.
//
// WHAT. Inside the ?shadowCasterList wrapper on `renderer.shadowMap.render`
// (which owns the caster walk), each managed light three is about to raster
// takes one of three modes:
//
//   NORMAL  three's own single pass, static + dynamic casters. Used when the
//           frame's reason includes FRUSTUM (camera/sun refit, indoor flip,
//           single-shadow recentre, CSM error, first raster): static casters
//           depend on the camera too (LOD levels, interior visibility, culls),
//           so nothing is cached while the camera moves. Also for anything not
//           a managed 2D depth map (other lights, VSM, point lights).
//   REFRESH pass 1 draws the static casters alone into the light's own map;
//           its depth is blitted into the light's cache; pass 2 draws the
//           dynamic casters on top. Used for the STATIC reason (the per-cascade
//           ?shadowMaxStale ceiling: sway, streaming, idle limbs) or whenever
//           the cache cannot stand in for this frustum.
//   OVERLAY the cache is blitted into the light's map and pass 2 draws the
//           dynamic casters on top. Used when only rigs changed (the MOVER
//           reason) and the cache was made for exactly this frustum.
//
// Dynamic casters = everything under the registered dynamic root (the
// `entitiesGroup` lighting.js hands over as `shadowMap.__hbShadowDynamicRoot`:
// every rig, held item, projectile, corpse and dismember fragment). Everything
// else is static. Pass 2 runs with `renderer.clear` stubbed out, so three's
// per-light loop draws onto the depth already in the map (depth test LessEqual,
// so the result is min(static, dynamic) — exactly what one combined pass
// writes). Receivers sample `shadow.map.depthTexture` only (csm.js
// csmShadowSampleTexture; three's own PCF uniforms likewise) — the colour
// attachment is never read, so it is left alone.
//
// The blits are three's own `copyTextureToTexture` depth branch
// (blitFramebuffer DEPTH_BUFFER_BIT, NEAREST) between two DepthTexture
// (DepthFormat + UnsignedIntType = DEPTH_COMPONENT24) targets of identical
// size; the scissor test is turned off and the depth mask on before each,
// since a blit honours the scissor box.
//
// THE CACHE IS VALID while: same light map object (three re-creates it on a
// type change; csm.js / lighting.js dispose it — a dispose listener frees the
// cache), same size, same frustum (the shadow camera's projection matrix and
// the light + target world positions, compared exactly — not csm.js's refit
// epsilon), same camera layer mask (three picks casters by it), no WebGL
// context loss/restore since, and no STATIC or FRUSTUM reason since.
// Otherwise REFRESH (or NORMAL) rebuilds it.
//
// WHAT COULD LOOK DIFFERENT. A frame that rasters now draws the same depth a
// full raster would, EXCEPT for static casters that changed since that
// cascade's last static refresh — at most ?shadowMaxStale (12) frames, the
// bound the RP5 gate already gives every caster. In practice: tree-sway and
// animated-scenery shadows refresh every 12 frames while NPCs walk near a
// standing player (they used to refresh on every NPC step); a building that
// finishes streaming in while you stand still gets its shadow up to 12 frames
// later. Rig shadows still track every frame.
//
// MEMORY. One cache per managed light, the size of its map: depth (4 B/texel)
// + an R8 colour attachment three needs for the framebuffer — 2048² ×2 +
// 1024² at the default CSM sizes ≈ 45 MB of VRAM.
//
// Escape hatches: `?shadowStaticCache=off`; live A/B
// `window.__shadowStaticCache.off = true`; it also stands down when
// ?shadowMoverScope=off (no managed lights) or ?shadowCasterList=off (no
// wrapper to run in).

// Raster reasons lighting.js leaves on `light.userData.hbShadowReason` (OR'd
// across frames until a raster consumes them). Duplicated there on purpose —
// lighting.js is loaded by composite-eval tests that cannot resolve imports.
export const SHADOW_REASON_MOVER = 1;
export const SHADOW_REASON_STATIC = 2;
export const SHADOW_REASON_FRUSTUM = 4;

/** `?shadowStaticCache` — default ON; `off`/`0`/`false`/`no` disables. */
export function shadowStaticCacheFlag(search) {
  try {
    const s = search ?? globalThis.location?.search ?? "";
    const v = (new URLSearchParams(s).get("shadowStaticCache") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
}
const SSC_FLAG = shadowStaticCacheFlag();

export function shadowStaticCacheEnabled() {
  return SSC_FLAG;
}

const sscCtl = { off: false, broken: false };
const sscStats = {
  rasters: 0, // wrapper calls that used the cache path
  normal: 0, // light-rasters in NORMAL mode (inside a cache-path call)
  refresh: 0, // light-rasters in REFRESH mode (static pass + save)
  overlay: 0, // light-rasters in OVERLAY mode (blit + dynamics only)
  passthrough: 0, // calls handed back to the single-pass path (all NORMAL)
  blits: 0,
  allocs: 0,
  disposes: 0,
  invalidations: 0, // context loss/restore events
  lastStatic: 0, // static candidates of the last full walk
  lastDynamic: 0, // dynamic candidates of the last raster
  errors: 0,
  lastError: null,
};

// Bumped on WebGL context loss/restore: every cache made before is garbage.
let _gen = 0;
const _states = new WeakMap(); // light -> { rt, valid, gen, mapRef, key }
const _contextHooked = new WeakSet();

const KEY_LEN = 16 + 6 + 2;

function _stateOf(light) {
  let st = _states.get(light);
  if (!st) {
    st = { rt: null, valid: false, gen: -1, layers: 0, mapRef: null, key: new Float64Array(KEY_LEN), _key: new Float64Array(KEY_LEN) };
    _states.set(light, st);
  }
  return st;
}

/** The frustum a raster of `light` would use, flattened (see header). */
function _fillKey(light, out) {
  const sh = light.shadow;
  const pm = sh.camera.projectionMatrix.elements;
  for (let i = 0; i < 16; i += 1) out[i] = pm[i];
  const a = light.matrixWorld.elements;
  out[16] = a[12]; out[17] = a[13]; out[18] = a[14];
  const t = light.target ? light.target.matrixWorld.elements : null;
  out[19] = t ? t[12] : 0; out[20] = t ? t[13] : 0; out[21] = t ? t[14] : 0;
  out[22] = sh.mapSize.x; out[23] = sh.mapSize.y;
  return out;
}

function _keyEq(a, b) {
  for (let i = 0; i < KEY_LEN; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function _disposeCache(st) {
  if (st.rt) {
    // three's deallocateRenderTarget disposes the depth texture with it.
    try { st.rt.dispose(); } catch (_) {}
    sscStats.disposes += 1;
  }
  st.rt = null;
  st.valid = false;
  st.mapRef = null;
}

function _usable(st, light, layersMask) {
  const map = light.shadow.map;
  return st.valid && st.gen === _gen && st.layers === layersMask && !!st.rt && st.mapRef === map && !!map &&
    st.rt.width === map.width && st.rt.height === map.height && _keyEq(st.key, st._key);
}

function _hookContext(renderer) {
  const el = renderer && renderer.domElement;
  if (!el || typeof el.addEventListener !== "function" || _contextHooked.has(el)) return;
  _contextHooked.add(el);
  const bump = () => {
    _gen += 1;
    sscStats.invalidations += 1;
  };
  el.addEventListener("webglcontextlost", bump, false);
  // A restore may land on another backend (Chrome falls back after a GPU
  // process loss): check its first blits again (RENDER restore gap,
  // 2026-10-18 follow-up). The cache targets themselves are reused: three's
  // new WebGLProperties gives them fresh GL objects at the REFRESH that the
  // generation bump forces, as it does for every shadow.map.
  el.addEventListener("webglcontextrestored", () => { bump(); _blitChecks = 0; }, false);
}

/** A light three will raster on this call (its own per-light predicate). */
function _willRaster(light) {
  const sh = light && light.shadow;
  return !!sh && !(sh.autoUpdate === false && sh.needsUpdate === false);
}

/** Every ancestor of `node` up to `root` is visible, and `root` is reached. */
function _drawnUnder(node, root) {
  for (let o = node; o; o = o.parent) {
    if (o.visible === false) return false;
    if (o === root) return true;
  }
  return false;
}

/** Is `node` a descendant of `root` (or root itself)? Visibility ignored. */
function _under(node, root) {
  for (let o = node; o; o = o.parent) if (o === root) return true;
  return false;
}

function _ensureCache(st, light, renderer) {
  const map = light.shadow.map;
  if (st.rt && (st.mapRef !== map || st.rt.width !== map.width || st.rt.height !== map.height)) _disposeCache(st);
  if (!st.rt) {
    const rt = new THREE.WebGLRenderTarget(map.width, map.height, {
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
    });
    rt.texture.name = `${light.name || "light"}.shadowStaticCache.color`;
    const dt = new THREE.DepthTexture(map.width, map.height, THREE.UnsignedIntType);
    dt.format = THREE.DepthFormat;
    dt.name = `${light.name || "light"}.shadowStaticCache`;
    rt.depthTexture = dt;
    st.rt = rt;
    sscStats.allocs += 1;
  }
  if (st.mapRef !== map) {
    // Free the cache with the map it mirrors (csm.js / lighting.js dispose
    // `shadow.map`; three re-creates it on a shadow-type change).
    const onDispose = () => {
      map.removeEventListener("dispose", onDispose);
      if (st.mapRef === map) _disposeCache(st);
    };
    map.addEventListener("dispose", onDispose);
    st.mapRef = map;
  }
  renderer.initRenderTarget(st.rt);
  renderer.initRenderTarget(map);
  return st.rt;
}

// The first blits of a session are checked with gl.getError(): a depth blit
// the driver rejects raises no exception, and an OVERLAY drawn over a map the
// blit never reached would smear rig shadows. Two checks (each a pipeline
// sync, so not more) — then trust the path.
const BLIT_GL_CHECKS = 2;
let _blitChecks = 0;

/** Depth blit src -> dst through three (its state cache stays in sync). */
function _blitDepth(renderer, srcDepth, dstDepth) {
  const state = renderer.state;
  // A blit honours the scissor box (and, on some drivers, the depth mask).
  if (state && typeof state.setScissorTest === "function") state.setScissorTest(false);
  if (state && state.buffers && state.buffers.depth && typeof state.buffers.depth.setMask === "function") {
    state.buffers.depth.setMask(true);
  }
  const gl = _blitChecks < BLIT_GL_CHECKS && typeof renderer.getContext === "function" ? renderer.getContext() : null;
  if (gl && typeof gl.getError === "function") {
    for (let k = 0; k < 8 && gl.getError() !== gl.NO_ERROR; k += 1); // drain earlier errors
  }
  renderer.copyTextureToTexture(srcDepth, dstDepth);
  if (gl && typeof gl.getError === "function") {
    _blitChecks += 1;
    const err = gl.getError();
    if (err !== gl.NO_ERROR) throw new Error(`depth blit raised GL error 0x${(err >>> 0).toString(16)}`);
  }
  sscStats.blits += 1;
}

const _noClear = function () {};

// Scratch (no per-frame allocation).
const _reasons = [];
const _normal = [];
const _refresh = [];
const _overlay = [];
const _pass2 = [];
const _fullList = [];
const _staticList = [];
const _dynList = [];
const _found = { hit: false };

/**
 * Called by the ?shadowCasterList wrapper for a raster call (three's own
 * early-outs already passed). Returns true when it rastered every light three
 * would have, false to let the wrapper run its usual single pass (cache off,
 * not applicable, or every light NORMAL).
 *
 * @param {Object} ctx - from installShadowCasterList: { renderer, sm, orig,
 *   collect, collectSplit, roots: { full, stat, dyn } } (stand-in roots whose
 *   `children` this function points at its lists).
 * @param {Object} smThis - the `this` three's render runs with.
 */
export function shadowStaticCacheRender(ctx, smThis, lights, scene, camera) {
  // Consume this raster's reasons whatever happens below: a mark that sat
  // unread while the cache was off must not linger into a later raster.
  const on = SSC_FLAG && !sscCtl.off && !sscCtl.broken;
  let managed = 0;
  _reasons.length = lights.length;
  for (let i = 0; i < lights.length; i += 1) {
    const l = lights[i];
    _reasons[i] = 0;
    if (!_willRaster(l)) continue;
    const ud = l.userData;
    if (!ud) continue;
    _reasons[i] = ud.hbShadowReason | 0;
    ud.hbShadowReason = 0;
    if (ud.hbShadowManaged === true) managed += 1;
  }
  if (!on || managed === 0) return false;

  const sm = ctx.sm;
  const renderer = ctx.renderer;
  if (sm.type !== THREE.PCFShadowMap && sm.type !== THREE.BasicShadowMap) return false;
  if (!renderer || typeof renderer.copyTextureToTexture !== "function" || typeof renderer.initRenderTarget !== "function") return false;
  const dynRoot = sm.__hbShadowDynamicRoot;
  // Without a dynamic root every rig would be cached as static: stand down.
  if (!dynRoot || !_under(dynRoot, scene)) return false;
  _hookContext(renderer);

  _normal.length = 0;
  _refresh.length = 0;
  _overlay.length = 0;
  try {
    for (let i = 0; i < lights.length; i += 1) {
      const l = lights[i];
      if (!_willRaster(l)) continue;
      const reason = _reasons[i];
      const sh = l.shadow;
      const map = sh.map;
      if (
        l.userData?.hbShadowManaged !== true || l.isPointLight ||
        (map && (map.isWebGLCubeRenderTarget || !map.depthTexture))
      ) {
        _normal.push(l);
        continue;
      }
      const st = _stateOf(l);
      _fillKey(l, st._key);
      if (reason & SHADOW_REASON_FRUSTUM || !map) {
        st.valid = false;
        _normal.push(l);
      } else if (!(reason & SHADOW_REASON_STATIC) && _usable(st, l, camera.layers.mask)) {
        _overlay.push(l);
      } else {
        _refresh.push(l);
      }
    }
  } catch (e) {
    // Nothing rastered yet: stand down and let the caller's plain pass run.
    sscCtl.broken = true;
    sscStats.errors += 1;
    sscStats.lastError = String((e && e.message) || e);
    return false;
  }
  if (_refresh.length === 0 && _overlay.length === 0) {
    sscStats.passthrough += 1;
    return false;
  }

  const camLayers = camera.layers;
  const orig = ctx.orig;
  const roots = ctx.roots;
  const savedRT = renderer.getRenderTarget();
  const savedFace = renderer.getActiveCubeFace();
  const savedMip = renderer.getActiveMipmapLevel();
  const prevClear = renderer.clear;
  let clearSwapped = false;
  const raster = (subset, root) => {
    sm.needsUpdate = true;
    for (let i = 0; i < subset.length; i += 1) subset[i].shadow.needsUpdate = true;
    orig.call(smThis, subset, root, camera);
  };
  try {
    // One walk: the static candidates (only when a pass needs them) and the
    // dynamic candidates (the dynamic root's subtree, when it is drawn).
    _staticList.length = 0;
    _dynList.length = 0;
    _found.hit = false;
    if (_normal.length || _refresh.length) {
      ctx.collectSplit(scene, camLayers, false, _staticList, dynRoot, _found);
      sscStats.lastStatic = _staticList.length;
    } else {
      _found.hit = _drawnUnder(dynRoot, scene);
    }
    if (_found.hit) ctx.collect(dynRoot, camLayers, false, _dynList);
    sscStats.lastDynamic = _dynList.length;
    roots.stat.children = _staticList;
    roots.dyn.children = _dynList;

    // NORMAL — static + dynamic in one pass.
    if (_normal.length) {
      _fullList.length = 0;
      for (let i = 0; i < _staticList.length; i += 1) _fullList.push(_staticList[i]);
      for (let i = 0; i < _dynList.length; i += 1) _fullList.push(_dynList[i]);
      roots.full.children = _fullList;
      raster(_normal, roots.full);
      sscStats.normal += _normal.length;
    }
    // REFRESH — statics alone, then save the depth.
    if (_refresh.length) {
      raster(_refresh, roots.stat);
      for (let i = 0; i < _refresh.length; i += 1) {
        const l = _refresh[i];
        const st = _stateOf(l);
        st.valid = false;
        const rt = _ensureCache(st, l, renderer);
        _blitDepth(renderer, l.shadow.map.depthTexture, rt.depthTexture);
        st.key.set(st._key);
        st.gen = _gen;
        // The camera's layer mask picked the casters (three's renderObject
        // tests it per node): a raster consumed by a layer-masked render must
        // not stand in for the world pass's.
        st.layers = camera.layers.mask;
        st.valid = true;
      }
      sscStats.refresh += _refresh.length;
    }
    // OVERLAY — restore the saved statics.
    for (let i = 0; i < _overlay.length; i += 1) {
      const l = _overlay[i];
      const st = _stateOf(l);
      renderer.initRenderTarget(l.shadow.map);
      _blitDepth(renderer, st.rt.depthTexture, l.shadow.map.depthTexture);
    }
    sscStats.overlay += _overlay.length;
    // Pass 2 — the dynamics on top of the statics already in each map.
    _pass2.length = 0;
    for (let i = 0; i < _refresh.length; i += 1) _pass2.push(_refresh[i]);
    for (let i = 0; i < _overlay.length; i += 1) _pass2.push(_overlay[i]);
    renderer.clear = _noClear;
    clearSwapped = true;
    raster(_pass2, roots.dyn);
    sscStats.rasters += 1;
  } catch (e) {
    // Never leave a half-built map behind: free every cache, stand down for
    // the session (`window.__shadowStaticCache.broken`), and have the caller
    // re-raster these lights the plain way this very frame.
    sscCtl.broken = true;
    sscStats.errors += 1;
    sscStats.lastError = String((e && e.message) || e);
    for (let i = 0; i < lights.length; i += 1) {
      const st = _states.get(lights[i]);
      if (st) _disposeCache(st);
    }
    if (clearSwapped) {
      renderer.clear = prevClear;
      clearSwapped = false;
    }
    for (const l of _normal) l.shadow.needsUpdate = true;
    for (const l of _refresh) l.shadow.needsUpdate = true;
    for (const l of _overlay) l.shadow.needsUpdate = true;
    sm.needsUpdate = true;
    try {
      // eslint-disable-next-line no-console
      console.warn("[shadowStaticCache] disabled for this session:", e);
    } catch (_) {}
    return false;
  } finally {
    if (clearSwapped) renderer.clear = prevClear;
    roots.full.children = _emptyChildren;
    roots.stat.children = _emptyChildren;
    roots.dyn.children = _emptyChildren;
    _fullList.length = 0;
    _staticList.length = 0;
    _dynList.length = 0;
    _pass2.length = 0;
    try { renderer.setRenderTarget(savedRT, savedFace, savedMip); } catch (_) {}
  }
  return true;
}
const _emptyChildren = [];

/** Live A/B + stats seam. */
if (typeof window !== "undefined") {
  try {
    window.__shadowStaticCache = {
      enabled: SSC_FLAG,
      stats: sscStats,
      get off() { return sscCtl.off; },
      set off(v) { sscCtl.off = !!v; },
      get broken() { return sscCtl.broken; },
    };
  } catch (_) {}
}

export function getShadowStaticCacheStats() {
  return { ...sscStats };
}

/** Test seams. */
export function __setShadowStaticCacheOffForTest(v) { sscCtl.off = !!v; }
export function __resetShadowStaticCacheForTest() {
  sscCtl.off = false;
  sscCtl.broken = false;
  _blitChecks = 0;
  for (const k of Object.keys(sscStats)) sscStats[k] = typeof sscStats[k] === "number" ? 0 : null;
}
export function __shadowStaticCacheStateForTest(light) {
  return _states.get(light) || null;
}
