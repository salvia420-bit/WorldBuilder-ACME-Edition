// scene3d/draw_sort_program.js — group opaque draws by shader PROGRAM (perf T10).
//
// OpenAC comparison 2026-10-04 (docs/openac-comparison-2026-10-04/5-perf.md T10):
// OpenAC sorts its groups for state locality and elides redundant binds
// (commit b5b01a89, CPU p50 7.2 -> 6.4 ms). three r184's default opaque sort,
// `painterSortStable` (three.module.js:8107), orders by groupOrder, renderOrder,
// then `material.id` — creation order, which interleaves materials that share a
// program. The frame-cost doc measured 160 program switches per frame against
// 79 distinct programs (2026-08-06-frame-cost-structure-measured.md:69); the
// glue census (§4b) notes that figure PREDATES the BatchedMesh colorTexture fix,
// so whether the interleave still costs anything was unmeasured; it shipped
// opt-in with a live A/B probe, and went DEFAULT-ON 2026-10-05 once the 1070
// probe read 252 -> 153 switches/frame (see drawSortProgramEnabled):
//
//   await window.__drawSort.probe(240)   // { switchesPerFrame, distinctPrograms, sortOn, ... }
//   window.__drawSort.set(true)          // program sort on (no reload, no recompile)
//   await window.__drawSort.probe(240)
//   window.__drawSort.set(false)         // back to three's painterSortStable
//
// The comparator is three's own with ONE key inserted after renderOrder: the
// material's compiled program id. Everything else — groupOrder, renderOrder
// (sky, terrain overlays, decals all rely on it), material.id, materialVariant,
// front-to-back z, the stable id tie-break — keeps its place, so only the
// relative order of DIFFERENT materials at equal renderOrder changes. That is
// already arbitrary (creation order) under the default sort, and opaque draws
// resolve by depth test. The transparent sort is untouched.
//
// Cost: the program id is read through `renderer.properties` (a WeakMap) at most
// once per material per render() call — memoized on the material itself with a
// frame stamp — not twice per comparison. An uncompiled material sorts last within its renderOrder.

let _flag;
/** The program-grouped opaque sort. DEFAULT-ON (2026-10-05); only an explicit
 *  off-form (`?drawSortProgram=off`/`0`/`false`/`no`) disarms it. Measured:
 *  the 1070 live probe 252 -> 153 program switches per frame (-39%), the
 *  comparator +0.09 ms over painterSortStable on the 1,544-item main pass
 *  (after the material-stamped memo), no pixel change beyond an off/off
 *  animation control at Holtburg. */
export function drawSortProgramEnabled() {
  if (_flag !== undefined) return _flag;
  let on = true;
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const v = (new URLSearchParams(window.location.search).get("drawSortProgram") || "").toLowerCase();
      if (v === "off" || v === "0" || v === "false" || v === "no") on = false;
    }
  } catch (_) { on = true; }
  return (_flag = on);
}

/** The opaque comparator for `renderer`. Exported for the regression suite. */
export function makeProgramSort(renderer) {
  const props = renderer.properties;
  const info = renderer.info;
  // The memo lives ON the material (three own-props, never copied by
  // Material.copy/clone or serialized by toJSON), stamped with this
  // comparator's token so two renderers can never read each other's keys.
  // It was a WeakMap: one WeakMap.get per comparison made the comparator ~1.9x
  // three's painterSortStable on the live 1,542-item main pass (1.13 vs
  // 0.62 ms, SwiftShader host, 2026-10-05) — CPU spent on a CPU-bound frame to
  // save GPU binds. Two property reads are near-free on a hit.
  const tok = {};
  function programKey(material) {
    const frame = info.render.frame;
    if (material.__dspTok === tok && material.__dspFrame === frame) return material.__dspKey;
    const p = props.get(material).currentProgram;
    const key = p ? p.id : Number.MAX_SAFE_INTEGER;
    material.__dspTok = tok;
    material.__dspFrame = frame;
    material.__dspKey = key;
    return key;
  }
  return function programSortStable(a, b) {
    if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
    if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
    if (a.material.id !== b.material.id) {
      const pa = programKey(a.material), pb = programKey(b.material);
      if (pa !== pb) return pa - pb;
      return a.material.id - b.material.id;
    }
    if (a.materialVariant !== b.materialVariant) return a.materialVariant - b.materialVariant;
    if (a.z !== b.z) return a.z - b.z;
    return a.id - b.id;
  };
}

/**
 * Install the sort (when armed) and the `window.__drawSort` A/B seam. Never
 * throws: a diag/perf install must not break boot.
 */
export function installDrawSortProgram(renderer) {
  let sort = null;
  let on = false;
  const set = (v) => {
    on = !!v;
    if (on && !sort) sort = makeProgramSort(renderer);
    renderer.setOpaqueSort(on ? sort : null); // null => three's painterSortStable
    return on;
  };
  try { set(drawSortProgramEnabled()); } catch (_) { /* fail-soft */ }

  /**
   * Count real program binds over `frames` DISPLAYED frames (rAF ticks). three
   * already elides a bind of the current program (WebGLState.useProgram), so
   * every `gl.useProgram` that reaches the context is a switch.
   *
   * Frames are rAF ticks, not `info.render.frame`: that counter advances once
   * per `renderer.render()` call, and a composited frame here makes dozens of
   * them (passes, shadow cascades, RT updates) — 38 per frame measured on the
   * default path — so a render()-based "per frame" understated switches by
   * that factor, and on the 1070 the counter was seen not to advance at all
   * (every probe ran to its 60 s timeout). `renderCalls` is kept as a diag.
   */
  const probe = (frames = 240) => new Promise((resolve) => {
    const gl = renderer.getContext();
    const orig = gl.useProgram;
    let switches = 0;
    const seen = new Set();
    gl.useProgram = function (program) {
      switches++;
      seen.add(program);
      return orig.call(this, program);
    };
    const f0 = renderer.info.render.frame;
    const t0 = performance.now();
    let ticks = 0;
    const tick = () => {
      ticks++;
      if (ticks > frames || performance.now() - t0 > 60000) {
        gl.useProgram = orig;
        const df = ticks - 1;
        resolve({
          sortOn: on,
          frames: df,
          renderCalls: renderer.info.render.frame - f0,
          switches,
          switchesPerFrame: df > 0 ? +(switches / df).toFixed(1) : null,
          distinctPrograms: seen.size,
          ms: Math.round(performance.now() - t0),
        });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  if (typeof window !== "undefined") {
    window.__drawSort = { set, get: () => on, probe };
  }
  return on;
}
