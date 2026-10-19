// scene3d/depth_band_sort.js — `?depthBandSort` (fps review 2026-10-19, DEFAULT
// OFF; `on` = one band per octave of view depth, `=N` = N bands per octave,
// 0.25-8; live: `window.__depthBandSort.set(n)`, 0 = off).
//
// The opaque comparators (draw_sort_program.js, atmosphere_pipeline.js
// punchPhaseOpaqueSort) order draws by phase, groupOrder, renderOrder, then
// PROGRAM / material — distance only breaks ties inside one material. Under
// reversed-Z the GPU rejects a hidden fragment before shading it (early-Z), but
// only behind depth something nearer has ALREADY written, so a far building
// drawn before the near one that covers it is shaded in full. This inserts a
// coarse depth band between renderOrder and the program key: nearer bands draw
// first, and programs still group inside each band (1-2 m, 2-4 m, … 512-1024 m
// at one band per octave). It trades program switches (renderer main thread and
// CrGpuMain) for overdraw (GPU), and neither side is measured, so it is an A/B
// arm, not a default: `await __drawSort.probe(240)` counts the switches, the
// GPU census times the world pass. Inert under the log depth buffer (every
// program writes gl_FragDepth there, so there is no early-Z to feed) and for
// non-perspective cameras.
//
// HOW. three keys each opaque render item on its clip-space z (bounding-sphere
// centre × projScreenMatrix, no divide), which the project negates under
// reversed-Z (shader_logdepth.js _fixReversedSortKeys). Clip z is affine in view
// depth d: z = −P[10]·d + P[14] (P = the camera's projection matrix), so
// d = (P[14] − z) / P[10], or (P[14] + key) / P[10] for a negated key. Each
// item's band is computed ONCE per sort, before it (a render-list `sort`
// wrapper); the comparators read it as a field while `depthBandsLive` is true.

export const DEPTH_BAND_MIN = 0.25;
export const DEPTH_BAND_MAX = 8;

/** `?depthBandSort` reader (pure): bands per octave, 0 = off (absent, off-forms, garbage). */
export function parseDepthBandSort(search) {
  try {
    const raw = new URLSearchParams(search || "").get("depthBandSort");
    if (raw == null) return 0;
    const v = String(raw).trim().toLowerCase();
    if (v === "on" || v === "true" || v === "yes") return 1;
    if (v === "") return 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(DEPTH_BAND_MAX, Math.max(DEPTH_BAND_MIN, n));
  } catch (_) {
    return 0;
  }
}

/** True only inside a banded sort; the comparators read `item.__hbBand` then. */
export let depthBandsLive = false;

/** The band of a render item's sort key (pure). Depth ≤ 1 m (and behind the eye) is band 0. */
export function depthBandOf(key, p10, p14, negated, perOctave) {
  const d = negated ? (p14 + key) / p10 : (p14 - key) / p10;
  return d > 1 ? Math.floor(Math.log2(d) * perOctave) : 0;
}

const _stats = { sorts: 0, banded: 0, items: 0, skippedLog: 0, skippedOrtho: 0, listWraps: 0 };

/**
 * Wrap `renderer.render` (to know the camera a sort is for) and every render
 * list's `sort` (to band the opaque items first). Never throws. three rebuilds
 * its render lists on a WebGL context restore (initGLContext), so the render
 * wrapper re-wraps whenever `renderer.renderLists` is a new object.
 * @returns {boolean} installed
 */
export function installDepthBandSort(renderer, { perOctave } = {}) {
  try {
    if (!renderer || renderer.__hbDepthBand) return !!renderer?.__hbDepthBand;
    if (!renderer.renderLists || typeof renderer.renderLists.get !== "function" || typeof renderer.render !== "function") return false;
    const st = {
      cam: null,
      lists: null,
      perOctave: perOctave !== undefined ? perOctave : parseDepthBandSort(globalThis.location?.search || ""),
    };
    const render = renderer.render;
    renderer.render = function renderDepthBandCamera(_scene, camera) {
      if (renderer.renderLists !== st.lists && renderer.renderLists) wrapLists(renderer.renderLists);
      const prev = st.cam;
      st.cam = camera;
      try { return render.apply(this, arguments); } finally { st.cam = prev; }
    };
    const prepare = (opaque) => {
      const cam = st.cam;
      if (!cam || !opaque || opaque.length < 2) return false;
      const e = cam.projectionMatrix && cam.projectionMatrix.elements;
      if (!e || e[11] !== -1 || e[10] === 0) { _stats.skippedOrtho += 1; return false; }
      const depth = renderer.state && renderer.state.buffers && renderer.state.buffers.depth;
      if (!depth || typeof depth.getReversed !== "function" || depth.getReversed() !== true) { _stats.skippedLog += 1; return false; }
      const negated = st.lists.__hbRevSortFix === true;
      const p10 = e[10], p14 = e[14], k = st.perOctave;
      for (let i = 0; i < opaque.length; i++) {
        const it = opaque[i];
        it.__hbBand = depthBandOf(it.z, p10, p14, negated, k);
      }
      _stats.banded += 1;
      _stats.items += opaque.length;
      return true;
    };
    const done = new WeakSet();
    function wrapLists(lists) {
      st.lists = lists;
      if (lists.__hbDepthBandGet === true) return;
      const get = lists.get;
      lists.get = function getDepthBanded(scene, depth) {
        const list = get.call(this, scene, depth);
        if (list && !done.has(list) && typeof list.sort === "function") {
          done.add(list);
          const sort = list.sort;
          list.sort = function sortDepthBanded(opaqueSort, transparentSort) {
            _stats.sorts += 1;
            if (st.perOctave > 0 && prepare(this.opaque)) {
              depthBandsLive = true;
              try { return sort.call(this, opaqueSort, transparentSort); } finally { depthBandsLive = false; }
            }
            return sort.call(this, opaqueSort, transparentSort);
          };
        }
        return list;
      };
      lists.__hbDepthBandGet = true;
      _stats.listWraps += 1;
    }
    wrapLists(renderer.renderLists);
    Object.defineProperty(renderer, "__hbDepthBand", { value: st, configurable: true });
    if (typeof window !== "undefined") {
      try {
        window.__depthBandSort = {
          get perOctave() { return st.perOctave; },
          /** Bands per octave (0 = off), clamped like the URL value. No reload, no recompile. */
          set(n) {
            const v = Number(n);
            st.perOctave = Number.isFinite(v) && v > 0 ? Math.min(DEPTH_BAND_MAX, Math.max(DEPTH_BAND_MIN, v)) : 0;
            return st.perOctave;
          },
          stats: () => ({ perOctave: st.perOctave, ..._stats }),
        };
      } catch (_) { /* fail-soft */ }
    }
    return true;
  } catch (_) {
    return false;
  }
}

export function getDepthBandSortStats() {
  return { ..._stats };
}
