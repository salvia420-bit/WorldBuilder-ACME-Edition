// scene3d/batched_runs.js — a BatchedMesh's visible instances drawn as per-geometry
// INSTANCED runs (`?batchedRuns`, DEFAULT ON, `=off` escape). Perf 2026-10-19.
//
// WHY. three r184 draws a BatchedMesh as ONE `multiDrawElementsWEBGL` with one
// range per visible INSTANCE, and `renderer.info` counts that as one call
// (WebGLIndexedBufferRenderer.renderMultiDraw: `info.update( elementCount, mode, 1 )`).
// Chrome does not have a native multi-draw on Windows: ANGLE's D3D11 backend
// loops over the ranges (`Context11::multiDrawElements` -> MULTI_DRAW_BLOCK,
// renderer_utils.cpp), sets the gl_DrawID uniform before each one
// (`ProgramExecutable::setDrawIDUniform` — the one draw uniform ANGLE does NOT
// cache, unlike base vertex / base instance) and issues a full `drawElements`.
// The dirty uniform makes `StateManager11::applyUniforms` re-upload the stage's
// WHOLE default uniform buffer (`UpdateSubresource`) before every range. All of
// that runs on Chrome's GPU-process main thread (CrGpuMain), which the
// renderer's CPU profile cannot see and `renderer.info` does not count.
// Measured scale (net-review 2026-07-15, settled Holtburg, 1070): 1,921
// `info.calls` vs 5,838 BatchedMesh sub-draws a frame; 17,774 static instances
// over 324 distinct geometries. The 2026-10-06 gpu.angle trace had CrGpuMain 79%
// busy (WebGL 15.2 ms/frame) with the renderer main thread at 98%.
//
// WHAT. Instances of one geometry share its index range, so a bucket's ranges
// repeat. For a bucket that opted in (`markBatchedRuns`) and draws in any order
// (`sortObjects === false`), the draw is regrouped into one INSTANCED range per
// distinct geometry — `multiDrawElementsInstancedWEBGL`, so ANGLE issues one
// D3D11 draw per geometry instead of one per instance:
//   * `installBatchedRunsChunks(THREE)` teaches the batching chunks a second
//     indirect layout. Texel 0 = 0xFFFFFFFF marks it:
//       [marker, runStart_0 .. runStart_{R-1}, ids of run 0, ids of run 1, ...]
//     and draw r / instance i reads the id at runStart_r + i. Any other texel 0
//     is three's own layout (draw i reads ids[i]) — three never writes the
//     marker (ids are < maxInstanceCount), so every other BatchedMesh, the
//     terrain batch's own shader included, is untouched.
//   * `installBatchedRuns(renderer)` wraps `renderBufferDirect`. For an opted-in
//     bucket it reads the multidraw list the bucket's `onBeforeRender` just built
//     (three's, ?statBatchMemo's, the sphere cache's, a slot restore — whichever),
//     groups it by range, writes the run layout into a texture of its own and
//     points `_indirectTexture` at it for the duration of the draw, then hands
//     three's call the run arrays through the patched multi_draw extension.
// Nothing upstream changes: the builders, the memo and its per-camera slots, the
// per-camera indirect textures and their rollback all keep producing and owning
// three's layout. The run layout is derived per draw, keyed by the canonical
// texture (so per camera under ?bmIndirectPerCamera), and re-uploaded only when
// the canonical list actually changed — compared in full, not by texture
// version, because ?bmIndirectPerCamera rolls a version bump back when the ids
// match even if the ranges moved.
//
// OUTPUT. The same (range, instance) pairs are drawn with the same matrices and
// colours; only their order inside one opaque bucket changes, which the depth
// test resolves (a sorted bucket never takes this path). `info.render.triangles`
// stays exact: three sums the canonical counts it was handed.
//
// WHEN IT STEPS ASIDE (three's draw, untouched): the flag or the live seam is
// off; the chunks did not patch (three drift — never draw the run layout through
// an unpatched shader); no WEBGL_multi_draw; the mesh did not opt in or sorts;
// fewer than 2 ranges; no range repeats (nothing to gain); a malformed list.

import * as THREE from "three";

const FLAG = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("batchedRuns") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();

export function batchedRunsEnabled() {
  return FLAG;
}

export const RUN_MARKER = 0xffffffff;

const ctl = { off: false };
const stats = {
  draws: 0,           // bucket draws issued as instanced runs
  instances: 0,       // ranges those draws carried (what ANGLE would have looped)
  runs: 0,            // ranges actually issued for them
  rebuilds: 0,        // run layouts (re)derived because the canonical list changed
  uploads: 0,         // of those, layouts that differed from the texture's last one
  noGain: 0,          // opted-in draws whose ranges never repeat (three's draw)
  fallbacks: 0,       // opted-in draws handed back to three (unsupported / malformed)
  errors: 0,
};
// Per-frame totals over EVERY BatchedMesh draw (opted in or not): the honest draw
// count `renderer.info.render.calls` cannot give. `subDraws` = ranges three was
// asked to draw, `issued` = ranges that reached the GL driver after regrouping.
const frame = { frame: -1, batchedCalls: 0, subDraws: 0, issued: 0, last: { batchedCalls: 0, subDraws: 0, issued: 0 } };

const _eligible = new WeakSet();
/** @type {WeakMap<object, object>} canonical indirect texture -> its run state */
const _runState = new WeakMap();
let _chunksPatched = false;
let _pending = null; // the run arrays of the draw in flight (consumed by the patched extension)
const _byStart = new Map();

/** Opt a BatchedMesh in. Only for meshes whose materials use three's batching chunks. */
export function markBatchedRuns(mesh) {
  if (mesh && mesh.isBatchedMesh === true) _eligible.add(mesh);
}
export function isBatchedRunsMarked(mesh) {
  return _eligible.has(mesh);
}

// ---------------------------------------------------------------------------
// The shader half.
// ---------------------------------------------------------------------------
const PARS_ANCHOR = "\tfloat getIndirectIndex( const in int i ) {";
const PARS_FN = `
	// batched_runs.js: texel 0 == 0xFFFFFFFFu marks the instanced RUN layout
	// [marker, runStart_0 .. runStart_R-1, ids grouped by run]; draw r, instance i
	// reads ids[ runStart_r + i ]. Any other head is three's layout: ids[ gl_DrawID ].
	int hbBatchSlot() {
		if ( texelFetch( batchingIdTexture, ivec2( 0 ), 0 ).r == 0xFFFFFFFFu ) {
			return int( getIndirectIndex( gl_DrawID + 1 ) ) + gl_InstanceID;
		}
		return gl_DrawID;
	}
`;
const VERTEX_FROM = "getBatchingMatrix( getIndirectIndex( gl_DrawID ) )";
const VERTEX_TO = "getBatchingMatrix( getIndirectIndex( hbBatchSlot() ) )";
const COLOR_FROM = "getBatchingColor( getIndirectIndex( gl_DrawID ) )";
const COLOR_TO = "getBatchingColor( getIndirectIndex( hbBatchSlot() ) )";

/**
 * Patch three's batching chunks on a ShaderChunk-shaped object. Pure: returns the
 * three patched strings, or null if any anchor is missing (three drift).
 */
export function patchBatchingChunks(chunks) {
  const pars = chunks && chunks["batching_pars_vertex"];
  const vert = chunks && chunks["batching_vertex"];
  const color = chunks && chunks["color_vertex"];
  if (typeof pars !== "string" || typeof vert !== "string" || typeof color !== "string") return null;
  if (pars.includes("hbBatchSlot")) return { pars, vert, color }; // already patched
  const at = pars.indexOf(PARS_ANCHOR);
  if (at < 0 || !vert.includes(VERTEX_FROM) || !color.includes(COLOR_FROM)) return null;
  // The function reads getIndirectIndex, so it goes right after that function's
  // closing brace: the next "\n\t}\n" after the anchor.
  const end = pars.indexOf("\n\t}\n", at);
  if (end < 0) return null;
  const cut = end + "\n\t}\n".length;
  return {
    pars: pars.slice(0, cut) + PARS_FN + pars.slice(cut),
    vert: vert.split(VERTEX_FROM).join(VERTEX_TO),
    color: color.split(COLOR_FROM).join(COLOR_TO),
  };
}

/** Rewrite THREE.ShaderChunk once. Must precede every compile. Returns true if live. */
export function installBatchedRunsChunks(three = THREE, { force = false } = {}) {
  if ((!FLAG && !force) || !three || !three.ShaderChunk) return false;
  if (_chunksPatched) return true;
  const p = patchBatchingChunks(three.ShaderChunk);
  if (!p) {
    // eslint-disable-next-line no-console
    console.info("[batchedRuns] three's batching chunks did not match — instanced runs stay off");
    return false;
  }
  const chunks = /** @type {Record<string, string>} */ (three.ShaderChunk);
  chunks["batching_pars_vertex"] = p.pars;
  chunks["batching_vertex"] = p.vert;
  chunks["color_vertex"] = p.color;
  _chunksPatched = true;
  return true;
}

// ---------------------------------------------------------------------------
// The run builder (pure).
// ---------------------------------------------------------------------------
function _grow(arr, n, Ctor) {
  if (arr && arr.length >= n) return arr;
  let len = arr ? arr.length : 16;
  while (len < n) len *= 2;
  return new Ctor(len);
}
/** `_grow` that keeps the contents (the run arrays grow while being filled). */
function _growKeep(arr, n, Ctor) {
  if (arr.length >= n) return arr;
  const next = _grow(arr, n, Ctor);
  next.set(arr);
  return next;
}

/** Fresh output buffers for `buildRuns` (grown in place as needed). */
export function makeRunBuffers() {
  return {
    r: 0, len: 0,
    starts: new Int32Array(16), counts: new Int32Array(16), inst: new Int32Array(16),
    layout: new Uint32Array(32), entryRun: new Int32Array(16), cursor: new Int32Array(16),
  };
}

/**
 * Group a canonical multidraw list (three's `_multiDrawStarts/_multiDrawCounts`
 * and indirect ids, `n` entries) into one run per distinct range.
 * Fills `out.starts/counts/inst` (R entries) and `out.layout` (1 + R + n
 * entries). Returns R, or -1 if one start appears with two counts (malformed).
 * Within a run the canonical order is kept; runs are in first-seen order.
 */
export function buildRuns(starts, counts, ids, n, out, map = _byStart) {
  map.clear();
  out.entryRun = _grow(out.entryRun, n, Int32Array);
  let r = 0;
  for (let k = 0; k < n; k++) {
    const s = starts[k];
    let ri = map.get(s);
    if (ri === undefined) {
      ri = r++;
      map.set(s, ri);
      if (ri >= out.starts.length) {
        const cap = Math.max(ri + 1, out.starts.length * 2);
        out.starts = _growKeep(out.starts, cap, Int32Array);
        out.counts = _growKeep(out.counts, cap, Int32Array);
        out.inst = _growKeep(out.inst, cap, Int32Array);
      }
      out.starts[ri] = s;
      out.counts[ri] = counts[k];
      out.inst[ri] = 0;
    } else if (out.counts[ri] !== counts[k]) {
      map.clear();
      return -1;
    }
    out.inst[ri] += 1;
    out.entryRun[k] = ri;
  }
  map.clear();
  const len = 1 + r + n;
  out.layout = _grow(out.layout, len, Uint32Array);
  out.cursor = _grow(out.cursor, r, Int32Array);
  const layout = out.layout;
  layout[0] = RUN_MARKER;
  let at = 1 + r;
  for (let ri = 0; ri < r; ri++) {
    layout[1 + ri] = at;
    out.cursor[ri] = at;
    at += out.inst[ri];
  }
  for (let k = 0; k < n; k++) {
    const ri = out.entryRun[k];
    layout[out.cursor[ri]++] = ids[k];
  }
  out.r = r;
  out.len = len;
  return r;
}

// ---------------------------------------------------------------------------
// The draw half.
// ---------------------------------------------------------------------------
function _patchExtension(ext) {
  if (!ext) return false;
  if (ext.__hbBatchedRuns === true) return true;
  const me = ext.multiDrawElementsWEBGL;
  const mei = ext.multiDrawElementsInstancedWEBGL;
  if (typeof me !== "function" || typeof mei !== "function") return false;
  const ma = ext.multiDrawArraysWEBGL;
  const mai = ext.multiDrawArraysInstancedWEBGL;
  ext.multiDrawElementsWEBGL = function (mode, counts, countsOffset, type, offsets, offsetsOffset, drawCount) {
    const p = _pending;
    if (p !== null) {
      _pending = null;
      return mei.call(this, mode, p.counts, 0, type, p.starts, 0, p.inst, 0, p.r);
    }
    return me.call(this, mode, counts, countsOffset, type, offsets, offsetsOffset, drawCount);
  };
  if (typeof ma === "function" && typeof mai === "function") {
    ext.multiDrawArraysWEBGL = function (mode, firsts, firstsOffset, counts, countsOffset, drawCount) {
      const p = _pending;
      if (p !== null) {
        _pending = null;
        return mai.call(this, mode, p.starts, 0, p.counts, 0, p.inst, 0, p.r);
      }
      return ma.call(this, mode, firsts, firstsOffset, counts, countsOffset, drawCount);
    };
  }
  Object.defineProperty(ext, "__hbBatchedRuns", { value: true, configurable: true });
  return true;
}

/** The patched WEBGL_multi_draw for this renderer's CURRENT context, or null. A
 *  restored context brings a new extension object, so this is re-checked per draw. */
function _extensionFor(renderer) {
  const exts = renderer && renderer.extensions;
  if (!exts || typeof exts.has !== "function" || !exts.has("WEBGL_multi_draw")) return null;
  const ext = exts.get("WEBGL_multi_draw");
  return _patchExtension(ext) ? ext : null;
}

function _newState(canon) {
  const st = {
    tex: null, side: 0,
    n: -1, starts: new Int32Array(16), counts: new Int32Array(16), ids: new Uint32Array(16),
    gain: false,
    buf: makeRunBuffers(),
    lastLen: 0, last: new Uint32Array(32),
  };
  // The run texture dies with the canonical one (three's own `_indirectTexture`,
  // or a ?bmIndirectPerCamera camera texture — both dispose through this event).
  try {
    canon.addEventListener("dispose", () => {
      if (st.tex) { try { st.tex.dispose(); } catch (_) { /* fail-soft */ } }
      st.tex = null;
      _runState.delete(canon);
    });
  } catch (_) { /* a texture without events still works; it just is not freed early */ }
  return st;
}

function _sameCanonical(st, starts, counts, ids, n) {
  if (st.n !== n) return false;
  const a = st.starts, b = st.counts, c = st.ids;
  for (let k = 0; k < n; k++) {
    if (a[k] !== starts[k] || b[k] !== counts[k] || c[k] !== ids[k]) return false;
  }
  return true;
}

function _keepCanonical(st, starts, counts, ids, n) {
  st.starts = _grow(st.starts, n, Int32Array);
  st.counts = _grow(st.counts, n, Int32Array);
  st.ids = _grow(st.ids, n, Uint32Array);
  for (let k = 0; k < n; k++) {
    st.starts[k] = starts[k];
    st.counts[k] = counts[k];
    st.ids[k] = ids[k];
  }
  st.n = n;
}

function _ensureTexture(st, canon, len) {
  if (st.tex && st.side * st.side >= len) return st.tex;
  // 25% headroom: the visible count moves a little every frame while walking.
  const side = Math.max(Math.ceil(Math.sqrt(Math.ceil(len * 1.25))), 1);
  if (st.tex) { try { st.tex.dispose(); } catch (_) { /* fail-soft */ } }
  // Same layout as three's `_initIndirectTexture` (RedIntegerFormat /
  // UnsignedIntType, nearest, no mips) — a fresh Source, so it is its own GL texture.
  const t = new THREE.DataTexture(new Uint32Array(side * side), side, side, canon.format, canon.type);
  t.internalFormat = canon.internalFormat;
  st.tex = t;
  st.side = side;
  st.lastLen = 0; // a new texture holds nothing yet
  return t;
}

/**
 * The run state for this draw, or null to let three draw the canonical list.
 * Exported for the regression suite.
 */
export function prepareRunDraw(object) {
  const n = object._multiDrawCount | 0;
  const canon = object._indirectTexture;
  const ids = canon && canon.image && canon.image.data;
  const starts = object._multiDrawStarts;
  const counts = object._multiDrawCounts;
  if (!ids || !starts || !counts || !(ids instanceof Uint32Array)) return null;
  let st = _runState.get(canon);
  if (!st) { st = _newState(canon); _runState.set(canon, st); }
  if (!_sameCanonical(st, starts, counts, ids, n)) {
    _keepCanonical(st, starts, counts, ids, n);
    stats.rebuilds += 1;
    const r = buildRuns(starts, counts, ids, n, st.buf);
    if (r < 0) { st.gain = false; st.n = -1; stats.fallbacks += 1; return null; }
    st.gain = r < n;
    if (st.gain) {
      const buf = st.buf;
      const tex = _ensureTexture(st, canon, buf.len);
      const data = tex.image.data;
      let same = st.lastLen === buf.len;
      if (same) {
        const last = st.last;
        for (let i = 0; i < buf.len; i++) if (last[i] !== buf.layout[i]) { same = false; break; }
      }
      if (!same) {
        data.set(buf.layout.subarray(0, buf.len));
        st.last = _grow(st.last, buf.len, Uint32Array);
        st.last.set(buf.layout.subarray(0, buf.len));
        st.lastLen = buf.len;
        tex.needsUpdate = true;
        stats.uploads += 1;
      }
    }
  }
  if (!st.gain) { stats.noGain += 1; return null; }
  return st;
}

// One key per DISPLAY frame. `renderer.info.render.frame` is bumped by every
// render() call (the composer makes several a frame), so it would split one
// frame's draws across passes; the document timeline's time is fixed for the
// whole frame (the same key ?particleSharedAlpha uses). Node: no document.
function _frameKey(renderer) {
  try {
    const t = globalThis.document?.timeline?.currentTime;
    if (typeof t === "number") return t;
  } catch (_) { /* fall through */ }
  return renderer && renderer.info && renderer.info.render ? renderer.info.render.frame : 0;
}

function _countFrame(renderer, object, issued) {
  const f = _frameKey(renderer);
  if (f !== frame.frame) {
    frame.last.batchedCalls = frame.batchedCalls;
    frame.last.subDraws = frame.subDraws;
    frame.last.issued = frame.issued;
    frame.frame = f;
    frame.batchedCalls = 0; frame.subDraws = 0; frame.issued = 0;
  }
  frame.batchedCalls += 1;
  frame.subDraws += object._multiDrawCount | 0;
  frame.issued += issued;
}

/** Wrap `renderer.renderBufferDirect`. Returns true when installed (or already).
 *  Installed under `=off` too, as a pure counter: the A/B arm needs the true range
 *  count as much as the default does. Regrouping additionally needs the patched
 *  chunks, which `=off` never installs — so that arm draws exactly as before. */
export function installBatchedRuns(renderer) {
  if (!renderer || typeof renderer.renderBufferDirect !== "function") return false;
  if (renderer.__hbBatchedRuns) return true;
  const orig = renderer.renderBufferDirect;
  renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    if (!object || object.isBatchedMesh !== true) {
      return orig.call(this, camera, scene, geometry, material, object, group);
    }
    let st = null;
    if (!ctl.off && _chunksPatched && object.sortObjects === false && (object._multiDrawCount | 0) > 1 && _eligible.has(object)) {
      try {
        if (_extensionFor(this)) st = prepareRunDraw(object);
        else stats.fallbacks += 1;
      } catch (_) {
        stats.errors += 1;
        st = null;
      }
    }
    if (st === null) {
      _countFrame(this, object, object._multiDrawCount | 0);
      return orig.call(this, camera, scene, geometry, material, object, group);
    }
    const canon = object._indirectTexture;
    const buf = st.buf;
    stats.draws += 1;
    stats.instances += object._multiDrawCount | 0;
    stats.runs += buf.r;
    _countFrame(this, object, buf.r);
    object._indirectTexture = st.tex;
    _pending = buf;
    try {
      return orig.call(this, camera, scene, geometry, material, object, group);
    } finally {
      _pending = null;
      object._indirectTexture = canon;
    }
  };
  Object.defineProperty(renderer, "__hbBatchedRuns", { value: orig, configurable: true });
  if (typeof window !== "undefined") {
    try {
      window.__batchedRuns = {
        enabled: FLAG,
        get chunks() { return _chunksPatched; },
        stats,
        /** Last completed frame: BatchedMesh calls, ranges asked for, ranges issued. */
        frame: () => ({ ...frame.last }),
        get off() { return ctl.off; },
        set off(v) { ctl.off = !!v; },
      };
    } catch (_) { /* diag seam only */ }
  }
  return true;
}

/** Test hook: restore the wrapped method. */
export function uninstallBatchedRuns(renderer) {
  const orig = renderer && renderer.__hbBatchedRuns;
  if (!orig) return;
  renderer.renderBufferDirect = orig;
  delete renderer.__hbBatchedRuns;
  ctl.off = false;
}

export function getBatchedRunsStats() {
  return { ...stats, chunks: _chunksPatched, frame: { ...frame.last } };
}

/** This frame's running totals (read at the end of the frame, e.g. by ?renderDiag). */
export function batchedRunsFrameTotals() {
  return { batchedCalls: frame.batchedCalls, subDraws: frame.subDraws, issued: frame.issued };
}

/** Test seams. */
export function __setBatchedRunsOffForTest(v) { ctl.off = !!v; }
export function __setBatchedRunsChunksForTest(v) { _chunksPatched = !!v; }
export function __pendingForTest() { return _pending; }
