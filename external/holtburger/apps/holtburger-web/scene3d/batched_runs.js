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
// match even if the ranges moved. (2026-10-22: the compare copies only from the
// first differing entry on, not the whole list; same answer, less copying on a
// moving frame. For buckets on three's early-out, L1 below can skip it.)
//
// OUTPUT. The same (range, instance) pairs are drawn with the same matrices and
// colours; only their order inside one opaque bucket changes, which the depth
// test resolves (a SORTED bucket never regroups: it takes the order-keeping
// builder below). `info.render.triangles` stays exact: three sums the canonical
// counts it was handed.
//
// WHEN IT STEPS ASIDE (three's draw, untouched): the flag or the live seam is
// off; the chunks did not patch (three drift — never draw the run layout through
// an unpatched shader); no WEBGL_multi_draw; the mesh did not opt in; it sorts
// and `?batchedRunsSorted` is off; fewer than 2 ranges; no range repeats
// (unsorted) / no consecutive repeat (sorted) — nothing to gain; a malformed list.
//
// SORTED BUCKETS (`?batchedRunsSorted`, DEFAULT ON, `=off` escape; 2026-10-22,
// improvement hunt B9 second half = findings-round1 `gl-driver-1`). A bucket
// that sorts (`sortObjects === true`: the transparent chunk buckets, whose
// static_batch_x.js mark is unconditional, and three's default) must keep
// three's draw order, so the regrouping above is illegal for it. Its list still
// repeats wherever neighbours in depth share a geometry (a row of one window
// model, one translucent model at one z — three's sort is stable on ties), and
// CONSECUTIVE repeats can be merged without moving a primitive:
// `buildConsecutiveRuns` starts a new run at every change of (start, count) and
// keeps the ids in canonical order, so run r covers canonical entries
// [first_r, first_r + inst_r) and instance i of run r reads ids[first_r + i].
// Same run-layout texture, same patched chunks, same patched extension.
//   Why it is exact [D, from the spec text, read 2026-10-22]. WEBGL_multi_draw:
// the Multi* calls "behave identically to multiple calls to drawArrays,
// drawElements, drawArraysInstanced, and drawElementsInstanced"; ANGLE_multi_draw
// gives the loop, `for(i=0; i<drawcount; i++) if (counts[i]>0)
// DrawElementsInstanced(...)` with gl_DrawID = i. GL ES 3.0.6 §2.9.3 (p.31):
// DrawElementsInstanced "has the same effect as: for (int i = 0; i <
// instanceCount; i++) DrawElementsOneInstance(mode, count, type, indices, i)";
// §2.1 (p.4): "Commands are always processed in the order in which they are
// received ... one primitive must be drawn completely before any subsequent one
// can affect the framebuffer." So the run draw emits, primitive for primitive,
// for r, for i: range r with id ids[first_r + i] — which IS three's sequence,
// for k: range k with id ids[k] — through the same program with the same vertex
// arithmetic (only the slot index differs, and it reads the same id). Blending,
// depth and stencil see the same fragments in the same order. Both loops skip a
// zero-count range. BatchedMesh geometry has no instanced (divisor != 0)
// attribute, so gl_InstanceID moves nothing but the slot. That ANGLE's D3D11
// DrawIndexedInstanced keeps this order is ANGLE's conformance obligation [A].
//   Gain: (n − R) ANGLE ranges per sorted draw. R/n is UNMEASURED: read
// `__batchedRuns.frame()` sortedSubDraws vs sortedIssued and
// `.stats.sortedNoGain` in a town first. The verifier's census (2,022 instances
// walked in 23 sorted buckets, settled Nanto) bounds n from above, not R. Atlas
// translucent buckets copy geometry per member: R == n, they step aside — on a
// read-only scan for a consecutive repeat (`hasConsecutiveRepeat`, 2026-10-23),
// before any copy, build or layout write, so a no-gain draw pays one read of
// the two range arrays and nothing else.
//   Cost: a sorted list changes whenever the camera moves, so each such draw
// that can gain re-derives (O(n): scan to the first repeat + compare + build +
// layout compare) and uploads 1 + R + n texels. The canonical texture three bumped is NOT bound for that draw, so it
// is not uploaded (three uploads a DataTexture at bind, setTexture2D): one
// indirect upload either way, R texels larger [D]. gl-driver-1's "extra upload
// on top of three's" therefore does not apply; the O(n) JS does, next to three's
// own O(n log n) sorted rebuild of the same list.
//   Gate: its own flag rather than riding `?batchedRuns`, so the 1070 can read
// the sorted term alone (`&batchedRunsSorted=off` vs bare) apart from the
// unsorted one (`&batchedRuns=off`). Default ON with an escape only because it
// is order-preserving by construction (above): the same pixels, not an eye-test
// call. harness/glsl_smoke/batched_runs_sorted_smoke.mjs is the GPU proof; if it
// fails, flip FLAG_SORTED's default. Needs the patched chunks, so
// `?batchedRuns=off` turns this off too. Live seam `__batchedRuns.sortedOff`.
//
// L1 — AN O(1) "CANONICAL LIST UNCHANGED" SIGNAL (`?batchedRunsStable`, DEFAULT
// OFF, exact-match on/1/true/yes opt-in; 2026-10-22, handoff L1). The compare is
// O(n) JS per draw. Once a bucket rides three's early-out (`!_visibilityChanged
// && !perObjectFrustumCulled && !sortObjects`: onBeforeRender returns at once,
// BatchedMesh.js onBeforeRender) it is the last per-instance cost that bucket
// pays per draw [D]. The texture version is NOT that signal (the rollback above).
//   Every writer of a bucket's list — `_multiDrawStarts`, `_multiDrawCounts`,
//   `_multiDrawCount`, `_indirectTexture` and its `image.data` — in scene3d/ and
//   three r184, read 2026-10-22:
//     1. three's BatchedMesh.prototype.onBeforeRender (no write on the early-out);
//     2. ?bmIndirectPerCamera, a prototype wrapper: swaps `_indirectTexture` and
//        rolls versions back only for `perObjectFrustumCulled || sortObjects`
//        buckets, and passes the early-out population straight through;
//     3. static_batch_x.js's OWN-property overrides (?statBatchMemo / Sphere /
//        Runs: `_memoBuildSlack`, `_buildFromRuns`, the sphere build,
//        `_memoSlotRestore`), which write without calling the prototype;
//     4. three's setInstanceCount / copy (new arrays and a new texture object);
//     5. nothing else. skip_empty_multidraw.js, the pools, terrain_batch.js,
//        buildings.js and static_atlas.js change membership through three's API
//        (setVisibleAt / addInstance / optimize ... → `_visibilityChanged`) and
//        leave the list to three's rebuild.
//   The signal is a per-mesh write EPOCH:
//     * a prototype hook, installed by installBatchedRuns (index.js runs it after
//       installBatchedIndirectPerCamera, so it is the outermost), wraps every
//       prototype-routed onBeforeRender of a marked mesh. The call is QUIET when
//       the early-out condition held on entry and the texture object, its
//       version, its data array, `_multiDrawCount` and both arrays are the same
//       after it; anything else bumps the epoch. Every call ARMS the mesh;
//     * every renderBufferDirect of a marked mesh consumes the arm first. A draw
//       not preceded by a hook call (an own override that did not reach the
//       prototype, the hook cut out of the chain by a later prototype patch,
//       three's second DoubleSide pass) or a mesh carrying an own onBeforeRender
//       bumps the epoch. three's renderObject and WebGLShadowMap call
//       onBeforeRender / onBeforeShadow right before renderBufferDirect, so an
//       override that wrote is seen at the very next draw;
//     * a draw whose state was verified at epoch E by the same mesh, with the
//       same arrays, count and builder, and whose mesh is still at E, skips the
//       compare (`stats.stableSkips`).
//   Exact under the writer list [D]. What a code audit cannot promise is that no
//   future code writes a list outside an onBeforeRender, hence DEFAULT OFF plus a
//   self-audit: every 64th skip runs the full compare anyway and, on a mismatch,
//   turns the skip off for the session (`stats.stableAuditFails`, one console
//   warning) and re-derives. At today's defaults it is inert (`stableSkips` stays
//   0): every opted-in static bucket is per-object culled (no early-out) and the
//   chunk buckets carry own overrides (3). It pays under handoff P2 (per-object
//   culling off) and for early-out pools once they are marked (pool runs).
//   Shrinks: renderer main thread JS inside renderBufferDirect, O(ranges) → O(1)
//   per such draw. Own-override owners can join: `markBatchedRunsOwnHook(mesh)`
//   once, then `reportBatchedRunsList(mesh, wrote)` on EVERY call of the override
//   (wrote = false only when that call left the list untouched). Nobody does yet.

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

// `?batchedRunsSorted` — DEFAULT ON, `=off` escape (same idiom as FLAG): order-
// keeping consecutive runs for sorted buckets. See SORTED BUCKETS in the header.
const FLAG_SORTED = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("batchedRunsSorted") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();

export function batchedRunsSortedEnabled() {
  return FLAG && FLAG_SORTED;
}

// `?batchedRunsStable` — DEFAULT ON since 2026-10-23 (owner, ahead of its 1070
// arm), `=off` escape (same idiom as FLAG): the L1 epoch skip of the per-draw
// compare. See L1.
const FLAG_STABLE = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("batchedRunsStable") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();

export function batchedRunsStableEnabled() {
  return FLAG && FLAG_STABLE;
}

export const RUN_MARKER = 0xffffffff;

const ctl = { off: false, sortedOff: false, stableOff: false };
const stats = {
  draws: 0,           // UNSORTED bucket draws issued as instanced runs
  instances: 0,       // ranges those draws carried (what ANGLE would have looped)
  runs: 0,            // ranges actually issued for them
  rebuilds: 0,        // run layouts (re)derived because the canonical list changed (both builders)
  uploads: 0,         // of those, layouts that differed from the texture's last one (both builders)
  noGain: 0,          // opted-in unsorted draws whose ranges never repeat (three's draw)
  fallbacks: 0,       // opted-in draws handed back to three (unsupported / malformed)
  errors: 0,
  // ?batchedRunsSorted — the same counters for SORTED buckets (consecutive runs).
  sortedDraws: 0,     // sorted bucket draws issued as consecutive runs
  sortedInstances: 0, // ranges those draws carried
  sortedRuns: 0,      // ranges actually issued for them
  sortedNoGain: 0,    // opted-in sorted draws with no consecutive repeat (three's draw; read-only scan, nothing derived)
  sortedRebuilds: 0,  // of `rebuilds`, the consecutive builder's (one per moving frame that can gain)
  sortedUploads: 0,   // of `uploads`, the consecutive builder's
  // ?batchedRunsStable (L1).
  stableSkips: 0,     // draws that skipped the O(n) compare on the epoch proof
  stablePoisons: 0,   // draws that found the mesh unarmed / carrying an own override
  stableAudits: 0,    // skips re-checked in full anyway (every STABLE_AUDIT_EVERY-th)
  stableAuditFails: 0, // audits that found the list changed: the skip is off for the session
};
// Per-frame totals over EVERY BatchedMesh draw (opted in or not): the honest draw
// count `renderer.info.render.calls` cannot give. `subDraws` = ranges three was
// asked to draw, `issued` = ranges that reached the GL driver after regrouping.
// `sortedSubDraws` / `sortedIssued` = the same over draws of SORTED meshes only
// (opted in or not) — the population ?batchedRunsSorted can reach, and what it did.
const frame = {
  frame: -1, batchedCalls: 0, subDraws: 0, issued: 0, sortedSubDraws: 0, sortedIssued: 0,
  last: { batchedCalls: 0, subDraws: 0, issued: 0, sortedSubDraws: 0, sortedIssued: 0 },
};

const _eligible = new WeakSet();
/** @type {WeakMap<object, object>} canonical indirect texture -> its run state */
const _runState = new WeakMap();
let _chunksPatched = false;
let _pending = null; // the run arrays of the draw in flight (consumed by the patched extension)
const _byStart = new Map();

// Builder of a run state (`st.mode`): which one derived the layout it holds.
const MODE_NONE = 0;
const MODE_GROUPED = 1;     // buildRuns — unsorted buckets
const MODE_CONSECUTIVE = 2; // buildConsecutiveRuns — sorted buckets

// L1 state. `_stable`: marked mesh -> { epoch, armed, ownHook } (a WeakMap, no
// new fields on the node — V8 hidden-class discipline, as ?bmIndirectPerCamera).
/** @type {WeakMap<object, {epoch:number, armed:boolean, ownHook:boolean}>} */
const _stable = new WeakMap();
let _stableOn = false;     // the prototype hook is installed and live
let _stableProto = null;   // { proto, inner, hook } of the installed hook
let _stableBroken = false; // a self-audit failed: no more skips this session
let _auditTick = 0;
let _auditEvery = 64;      // STABLE_AUDIT_EVERY (test seam below)
let _stableWarned = false;

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

/**
 * The ORDER-KEEPING builder (sorted buckets, `?batchedRunsSorted`): merge only
 * CONSECUTIVE entries with the same (start, count) into one run. Same outputs as
 * `buildRuns` — `out.starts/counts/inst` (R entries), `out.layout` (1 + R + n:
 * marker, run starts, then the ids) — but the ids stay in canonical order, so
 * run r, instance i reads canonical entry first_r + i and the GPU sees three's
 * exact (range, id) sequence. A repeated start with another count is simply
 * another run (no grouping, so nothing to contradict). Returns R, or -1 for a
 * malformed list (n out of the arrays' bounds, a negative count — GL rejects
 * the whole multidraw for it, so three's own draw must be the one to see it).
 */
export function buildConsecutiveRuns(starts, counts, ids, n, out) {
  if (!(n >= 0) || !starts || !counts || !ids || n > starts.length || n > counts.length || n > ids.length) return -1;
  let r = 0;
  let ps = 0, pc = 0;
  for (let k = 0; k < n; k++) {
    const s = starts[k], c = counts[k];
    if (c < 0) return -1;
    if (r > 0 && s === ps && c === pc) {
      out.inst[r - 1] += 1;
      continue;
    }
    if (r >= out.starts.length) {
      const cap = Math.max(r + 1, out.starts.length * 2);
      out.starts = _growKeep(out.starts, cap, Int32Array);
      out.counts = _growKeep(out.counts, cap, Int32Array);
      out.inst = _growKeep(out.inst, cap, Int32Array);
    }
    out.starts[r] = s;
    out.counts[r] = c;
    out.inst[r] = 1;
    r++;
    ps = s; pc = c;
  }
  const len = 1 + r + n;
  out.layout = _grow(out.layout, len, Uint32Array);
  const layout = out.layout;
  layout[0] = RUN_MARKER;
  let at = 1 + r;
  for (let ri = 0; ri < r; ri++) {
    layout[1 + ri] = at;
    at += out.inst[ri];
  }
  // The ids, canonical order, right after the header: one contiguous copy.
  if (typeof ids.subarray === "function") layout.set(ids.subarray(0, n), 1 + r);
  else for (let k = 0; k < n; k++) layout[1 + r + k] = ids[k];
  out.r = r;
  out.len = len;
  return r;
}

/**
 * Read-only pre-check for `buildConsecutiveRuns` (2026-10-23, review2
 * `batched-runs-sorted-nogain-cost`): false ONLY when the builder would return
 * R === n — a well-formed list with no consecutive repeat, nothing to gain.
 * true for a repeat and for anything the builder rejects (bounds, a negative
 * count), which stays the builder's call (a fallback). Reads the two range
 * arrays, writes nothing, stops at the first repeat.
 */
export function hasConsecutiveRepeat(starts, counts, ids, n) {
  if (!(n >= 0) || !starts || !counts || !ids || n > starts.length || n > counts.length || n > ids.length) return true;
  let ps = 0, pc = 0;
  for (let k = 0; k < n; k++) {
    const s = starts[k], c = counts[k];
    if (c < 0 || (k > 0 && s === ps && c === pc)) return true;
    ps = s; pc = c;
  }
  return false;
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
  // Fixed field order — every state has the same shape.
  const st = {
    tex: null, side: 0,
    n: -1, starts: new Int32Array(16), counts: new Int32Array(16), ids: new Uint32Array(16),
    gain: false, mode: MODE_NONE,
    buf: makeRunBuffers(),
    lastLen: 0, last: new Uint32Array(32),
    // L1 stamp: the mesh, its epoch and the list arrays this state was last
    // verified against (obj null = no stamp).
    obj: null, epoch: 0, sArr: null, cArr: null, iArr: null,
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

/**
 * `_sameCanonical` + keep, in one pass: true when the kept copy equals the live
 * list; otherwise the copy is brought up to date FROM THE FIRST DIFFERENCE ON
 * (the equal prefix is already there) and false is returned. Same answer as
 * compare-then-copy-all, fewer writes on a frame where the list moved.
 */
function _syncCanonical(st, starts, counts, ids, n) {
  const m = st.n;
  const lim = m < n ? m : n; // m === -1 (nothing kept) => compare nothing
  let a = st.starts, b = st.counts, c = st.ids;
  let k = 0;
  for (; k < lim; k++) {
    if (a[k] !== starts[k] || b[k] !== counts[k] || c[k] !== ids[k]) break;
  }
  if (k === n && m === n) return true;
  if (a.length < n) { a = st.starts = _growKeep(a, n, Int32Array); }
  if (b.length < n) { b = st.counts = _growKeep(b, n, Int32Array); }
  if (c.length < n) { c = st.ids = _growKeep(c, n, Uint32Array); }
  for (let j = k; j < n; j++) {
    a[j] = starts[j];
    b[j] = counts[j];
    c[j] = ids[j];
  }
  st.n = n;
  return false;
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
 * `sorted` picks the builder (default: the mesh's own `sortObjects === true`):
 * a sorted list gets the order-keeping consecutive runs, never the regrouping.
 * Exported for the regression suite (and pool_runs). A direct call never takes
 * the L1 skip — only the renderBufferDirect wrapper holds the arm proof.
 */
export function prepareRunDraw(object, sorted = object.sortObjects === true) {
  return _prepare(object, sorted === true, null);
}

/** L1: may this draw trust the state's stamp instead of comparing the list? */
function _stableHit(st, rec, object, starts, counts, ids, n, mode) {
  return st.obj === object && st.epoch === rec.epoch && st.n === n && st.mode === mode
    && st.sArr === starts && st.cArr === counts && st.iArr === ids
    && !ctl.stableOff && !_stableBroken;
}

function _prepare(object, sorted, rec) {
  const n = object._multiDrawCount | 0;
  const canon = object._indirectTexture;
  const ids = canon && canon.image && canon.image.data;
  const starts = object._multiDrawStarts;
  const counts = object._multiDrawCounts;
  if (!ids || !starts || !counts || !(ids instanceof Uint32Array)) return null;
  // 2026-10-23 (review2 `batched-runs-sorted-nogain-cost`): a sorted list with
  // no consecutive repeat cannot gain, so it steps aside on a read-only scan
  // BEFORE the compare-and-copy, the build and the layout write — it used to pay
  // all three on every moving draw and then hand three its draw anyway. The atlas
  // translucent buckets are that list for good (one geometry per member: R == n),
  // re-sorted per camera, CSM cascades included. The run state is left as it
  // was: its kept copy still matches the layout it holds, so a later draw that
  // gains compares against it and stays exact. Only the L1 stamp goes (the kept
  // copy is no longer the live list).
  if (sorted && !hasConsecutiveRepeat(starts, counts, ids, n)) {
    const st0 = _runState.get(canon);
    if (st0 !== undefined) st0.obj = null;
    stats.sortedNoGain += 1;
    return null;
  }
  let st = _runState.get(canon);
  if (!st) { st = _newState(canon); _runState.set(canon, st); }
  const mode = sorted ? MODE_CONSECUTIVE : MODE_GROUPED;
  let unchanged = false;
  if (rec !== null && _stableHit(st, rec, object, starts, counts, ids, n, mode)) {
    stats.stableSkips += 1;
    unchanged = true;
    if (++_auditTick >= _auditEvery) {
      // The self-audit: the proof rests on the writer list in the header; if
      // anything outside it ever writes a list, stop trusting the proof.
      _auditTick = 0;
      stats.stableAudits += 1;
      if (!_sameCanonical(st, starts, counts, ids, n)) {
        stats.stableAuditFails += 1;
        _stableBroken = true;
        unchanged = false;
        if (!_stableWarned) {
          _stableWarned = true;
          // eslint-disable-next-line no-console
          console.warn("[batchedRuns] ?batchedRunsStable self-audit: a list changed without an epoch bump — skip disabled for this session");
        }
      }
    }
  }
  if (!unchanged && (!_syncCanonical(st, starts, counts, ids, n) || st.mode !== mode)) {
    stats.rebuilds += 1;
    if (sorted) stats.sortedRebuilds += 1;
    const r = sorted
      ? buildConsecutiveRuns(starts, counts, ids, n, st.buf)
      : buildRuns(starts, counts, ids, n, st.buf);
    if (r < 0) {
      st.gain = false; st.n = -1; st.mode = MODE_NONE; st.obj = null;
      stats.fallbacks += 1;
      return null;
    }
    st.mode = mode;
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
        if (sorted) stats.sortedUploads += 1;
      }
    }
  }
  // Stamp (L1): this state now matches the live list, as of the mesh's epoch.
  if (rec !== null) {
    st.obj = object; st.epoch = rec.epoch; st.sArr = starts; st.cArr = counts; st.iArr = ids;
  } else {
    st.obj = null;
  }
  if (!st.gain) {
    if (sorted) stats.sortedNoGain += 1; else stats.noGain += 1;
    return null;
  }
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
    const last = frame.last;
    last.batchedCalls = frame.batchedCalls;
    last.subDraws = frame.subDraws;
    last.issued = frame.issued;
    last.sortedSubDraws = frame.sortedSubDraws;
    last.sortedIssued = frame.sortedIssued;
    frame.frame = f;
    frame.batchedCalls = 0; frame.subDraws = 0; frame.issued = 0;
    frame.sortedSubDraws = 0; frame.sortedIssued = 0;
  }
  const n = object._multiDrawCount | 0;
  frame.batchedCalls += 1;
  frame.subDraws += n;
  frame.issued += issued;
  if (object.sortObjects === true) {
    frame.sortedSubDraws += n;
    frame.sortedIssued += issued;
  }
}

const _hasOwn = Object.prototype.hasOwnProperty;

/**
 * L1, draw side: consume the mesh's arm (see the header). Runs for EVERY draw of
 * a marked mesh while the hook is live — before any step-aside, so the proof
 * covers the draws that did not regroup too. Returns the mesh's record.
 */
function _stableObserve(object) {
  let rec = _stable.get(object);
  if (rec === undefined) {
    rec = { epoch: 0, armed: false, ownHook: false };
    _stable.set(object, rec);
  }
  if (!rec.armed || (!rec.ownHook && _hasOwn.call(object, "onBeforeRender"))) {
    rec.epoch = (rec.epoch + 1) | 0;
    stats.stablePoisons += 1;
  }
  rec.armed = false;
  return rec;
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
    let rec = null;
    // L1 bookkeeping first, for every draw of a marked mesh (flag off: one
    // boolean read, no lookup).
    if (_stableOn && _eligible.has(object)) {
      try { rec = _stableObserve(object); } catch (_) { stats.errors += 1; rec = null; }
    }
    let st = null;
    // Unsorted: regroup by range. Sorted: consecutive runs, order kept
    // (?batchedRunsSorted). Any other `sortObjects` value: three's draw.
    const so = object.sortObjects;
    const sorted = so === true;
    if (!ctl.off && _chunksPatched && (object._multiDrawCount | 0) > 1
      && (so === false || (sorted && FLAG_SORTED && !ctl.sortedOff)) && _eligible.has(object)) {
      try {
        if (_extensionFor(this)) st = _prepare(object, sorted, rec);
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
    if (sorted) {
      stats.sortedDraws += 1;
      stats.sortedInstances += object._multiDrawCount | 0;
      stats.sortedRuns += buf.r;
    } else {
      stats.draws += 1;
      stats.instances += object._multiDrawCount | 0;
      stats.runs += buf.r;
    }
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
  // L1 (?batchedRunsStable, default ON since 2026-10-23): the prototype hook. Only with the run
  // half live (`?batchedRuns=off` regroups nothing, so there is no compare to skip).
  if (FLAG && FLAG_STABLE) {
    try { installBatchedRunsStable(THREE); } catch (_) { stats.errors += 1; }
  }
  if (typeof window !== "undefined") {
    try {
      window.__batchedRuns = {
        enabled: FLAG,
        sortedEnabled: FLAG && FLAG_SORTED,
        get stableEnabled() { return _stableOn; },
        get stableBroken() { return _stableBroken; },
        get chunks() { return _chunksPatched; },
        stats,
        /** Last completed frame: BatchedMesh calls, ranges asked for, ranges issued
         *  (+ the same two over sorted meshes: sortedSubDraws, sortedIssued). */
        frame: () => ({ ...frame.last }),
        get off() { return ctl.off; },
        set off(v) { ctl.off = !!v; },
        /** Live A/B for ?batchedRunsSorted: sorted buckets back on three's draw. */
        get sortedOff() { return ctl.sortedOff; },
        set sortedOff(v) { ctl.sortedOff = !!v; },
        /** Live A/B for ?batchedRunsStable: back to the full compare every draw. */
        get stableOff() { return ctl.stableOff; },
        set stableOff(v) { ctl.stableOff = !!v; },
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
  ctl.sortedOff = false;
  ctl.stableOff = false;
}

// ---------------------------------------------------------------------------
// L1 — the prototype hook and the own-override cooperation API (see header).
// ---------------------------------------------------------------------------

/**
 * Wrap `BatchedMesh.prototype.onBeforeRender` once with the epoch hook. Called
 * by `installBatchedRuns` under `?batchedRunsStable`; `force` is for the suites.
 * Returns true when live. A mesh that is not marked pays one WeakMap miss.
 */
export function installBatchedRunsStable(three = THREE, { force = false } = {}) {
  if ((!FLAG_STABLE && !force) || !three || !three.BatchedMesh) return false;
  const proto = three.BatchedMesh.prototype;
  if (_stableProto !== null && _stableProto.proto === proto && proto.onBeforeRender === _stableProto.hook) {
    // Still on top of the chain (a re-install after an uninstall that could not unhook).
    _stableOn = true;
    return true;
  }
  // Otherwise wrap whatever the chain is now. A stale hook deeper in it (a later
  // patch wrapped it, then unwrapped to a function below it — or not) only ever
  // arms or bumps too, which is conservative.
  const inner = proto.onBeforeRender;
  if (typeof inner !== "function") return false;
  const hook = function (renderer, scene, camera, geometry, material, group) {
    const rec = _stableOn ? _stable.get(this) : undefined;
    if (rec === undefined) return inner.call(this, renderer, scene, camera, geometry, material, group);
    // three's early-out condition, read on entry (BatchedMesh.onBeforeRender).
    const quiet = this._visibilityChanged === false && this.perObjectFrustumCulled === false && this.sortObjects === false;
    const tex = this._indirectTexture;
    const ver = tex ? tex.version : -1;
    const data = tex && tex.image ? tex.image.data : null;
    const n = this._multiDrawCount;
    const s = this._multiDrawStarts;
    const c = this._multiDrawCounts;
    let ok = false;
    try {
      const ret = inner.call(this, renderer, scene, camera, geometry, material, group);
      ok = true;
      return ret;
    } finally {
      rec.armed = true;
      const tex2 = this._indirectTexture;
      if (!(ok && quiet && tex2 === tex && (tex2 ? tex2.version : -1) === ver
        && (tex2 && tex2.image ? tex2.image.data : null) === data
        && this._multiDrawCount === n && this._multiDrawStarts === s && this._multiDrawCounts === c)) {
        rec.epoch = (rec.epoch + 1) | 0;
      }
    }
  };
  proto.onBeforeRender = hook;
  _stableProto = { proto, inner, hook };
  _stableOn = true;
  return true;
}

/** Test hook: take the hook out (or, if something wrapped over it, leave it in
 *  the chain as a pure pass-through — `_stableOn` false — so nothing skips). */
export function uninstallBatchedRunsStable() {
  const p = _stableProto;
  _stableOn = false;
  if (!p) return;
  if (p.proto.onBeforeRender === p.hook) {
    p.proto.onBeforeRender = p.inner;
    _stableProto = null;
  }
}

/**
 * For the owner of an OWN-property `onBeforeRender` on a marked mesh (today:
 * static_batch_x.js's memo / sphere overrides). After this, the own override no
 * longer disqualifies the mesh from the L1 skip — IF it calls
 * `reportBatchedRunsList(mesh, wrote)` on every call, whichever path it takes.
 */
export function markBatchedRunsOwnHook(mesh) {
  if (!mesh || mesh.isBatchedMesh !== true) return;
  let rec = _stable.get(mesh);
  if (rec === undefined) { rec = { epoch: 0, armed: false, ownHook: false }; _stable.set(mesh, rec); }
  rec.ownHook = true;
}

/**
 * One call of a cooperating own override happened. `wrote === false` ONLY when
 * that call left `_multiDrawStarts/_multiDrawCounts/_multiDrawCount` and the
 * indirect texture (object and data) untouched — a memo hit on the live slot.
 * Anything else (a rebuild, a slot restore, unsure) passes true.
 */
export function reportBatchedRunsList(mesh, wrote = true) {
  const rec = mesh ? _stable.get(mesh) : undefined;
  if (rec === undefined) return;
  rec.armed = true;
  if (wrote !== false) rec.epoch = (rec.epoch + 1) | 0;
}

export function getBatchedRunsStats() {
  return {
    ...stats, chunks: _chunksPatched, sortedEnabled: FLAG && FLAG_SORTED,
    stableOn: _stableOn, stableBroken: _stableBroken, frame: { ...frame.last },
  };
}

/** This frame's running totals (read at the end of the frame, e.g. by ?renderDiag). */
export function batchedRunsFrameTotals() {
  return {
    batchedCalls: frame.batchedCalls, subDraws: frame.subDraws, issued: frame.issued,
    sortedSubDraws: frame.sortedSubDraws, sortedIssued: frame.sortedIssued,
  };
}

/** Test seams. */
export function __setBatchedRunsOffForTest(v) { ctl.off = !!v; }
export function __setBatchedRunsSortedOffForTest(v) { ctl.sortedOff = !!v; }
export function __setBatchedRunsStableOffForTest(v) { ctl.stableOff = !!v; }
export function __setBatchedRunsChunksForTest(v) { _chunksPatched = !!v; }
export function __setStableAuditEveryForTest(n) { _auditEvery = Math.max(1, n | 0); _auditTick = 0; }
export function __resetStableForTest() { _stableBroken = false; _stableWarned = false; _auditTick = 0; _auditEvery = 64; }
export function __stableRecForTest(mesh) { const r = _stable.get(mesh); return r ? { ...r } : null; }
export function __pendingForTest() { return _pending; }
