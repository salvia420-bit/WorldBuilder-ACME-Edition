// scene3d/program_warm.js — app-level async shader-program warming.
//
// Why this exists (measured 2026-07-08): entering a dense landblock (the
// Marketplace, 0x016C) froze the main thread ~4s. A CPU trace pinned 85% of
// the freeze on a single WebGL call — `getProgramParameter(ACTIVE_UNIFORMS)`
// blocking ~1s per shader program while the driver finished linking. It is a
// FIRST-RENDER stall, not a decode stall (wasm triangulation was ~60ms).
//
// three.js mechanics (three.module.js): `renderer.compile()` → `getProgram()`
// LINKS a program (`gl.linkProgram`, non-blocking under
// KHR_parallel_shader_compile) and returns WITHOUT fetching uniforms. The
// blocking `getUniforms()` → `getProgramParameter(ACTIVE_UNIFORMS)` runs later,
// at the program's FIRST render (`getUniformList`). So if we link ahead and only
// let the object render once the driver reports the link COMPLETE, first-render
// never blocks.
//
// Retail analog (acclient.c): resources are made ready before they are drawn —
// the `constructed_mesh` pre-warm in `CGfxObj::InitLoad`/`CEnvCell::UnPack`
// (gated on `DBCache::IsRunTime()`), and the teleport loading gate
// (`blocking_for_cells`, SmartBox::UseTime :146268) that skips the world update
// until cells are resident. This module is the GPU-program half of that.
//
// Contract:
//   - `warmSubtree(scene3d, object, lbKey)` links `object`'s programs (one
//     non-blocking `compile()`), then registers a per-frame completion poll.
//   - `tickProgramWarm()` (driven from loop.js) polls `program.isReady()`
//     (COMPLETION_STATUS_KHR — non-blocking) and marks `scene3d.prewarmedLbs`
//     when every program in the job is link-complete.
//   - Callers gate REVEAL (first render) on `isLbPrewarmed(...)`. Until then the
//     object stays hidden, so the ~1s link never lands on a visible frame.
//   - FAIL-OPEN: a job force-completes after MAX_WARM_MS so a driver that never
//     reports readiness can never leave the world permanently invisible.

// Fail-open ceiling. If the driver hasn't reported link-complete by here we
// mark prewarmed anyway and accept a possible one-time stall over a hung reveal.
const MAX_WARM_MS = 4000;

// Active warm jobs: { scene3d, lbKey, materials, startedMs, resolve, markLb, reveal }.
const _jobs = [];
// Count of in-flight jobs per lbKey, so readiness can wait on ONE landblock
// (the teleport destination) instead of the whole neighbourhood's warms.
const _pendingByLb = new Map();

function incPending(lbKey) {
  const k = lbKey >>> 0;
  _pendingByLb.set(k, (_pendingByLb.get(k) || 0) + 1);
}
function decPending(lbKey) {
  const k = lbKey >>> 0;
  const n = (_pendingByLb.get(k) || 0) - 1;
  if (n <= 0) _pendingByLb.delete(k);
  else _pendingByLb.set(k, n);
}

/** True while any shader-program warm for `lbKey` is still in flight. */
export function lbWarmPending(lbKey) {
  return (_pendingByLb.get(lbKey >>> 0) || 0) > 0;
}

function ensurePrewarmSet(scene3d) {
  if (!(scene3d.prewarmedLbs instanceof Set)) scene3d.prewarmedLbs = new Set();
  return scene3d.prewarmedLbs;
}

/** True once every program for `lbKey` has reported link-complete. */
export function isLbPrewarmed(scene3d, lbKey) {
  return !!(
    scene3d &&
    scene3d.prewarmedLbs instanceof Set &&
    scene3d.prewarmedLbs.has(lbKey >>> 0)
  );
}

function markPrewarmed(scene3d, lbKey) {
  if (!scene3d || lbKey == null) return;
  ensurePrewarmSet(scene3d).add(lbKey >>> 0);
}

/**
 * Forget an LB's prewarmed flag. Call from the LRU evict path so a later
 * re-bake of the same LB re-warms its (freshly rebuilt) programs instead of
 * revealing them against a stale flag.
 */
export function clearPrewarmed(scene3d, lbKey) {
  if (scene3d && scene3d.prewarmedLbs instanceof Set) {
    scene3d.prewarmedLbs.delete(lbKey >>> 0);
  }
}

function collectMaterials(object, out) {
  if (!object) return;
  object.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return;
    const m = o.material;
    if (Array.isArray(m)) {
      for (const s of m) if (s) out.push(s);
    } else if (m) {
      out.push(m);
    }
  });
}

/**
 * Link the shader programs used by `object` (a single Object3D — pass the
 * per-LB parent group), then register a completion-poll job. `object` need not
 * be attached to the scene graph; `compile()` only reads it, and uses
 * `scene3d.scene` for the light/fog context so the warmed program variant
 * matches the eventual render.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.markLb=true] when true, add `lbKey` to
 *   `scene3d.prewarmedLbs` on completion — the signal the per-cell BFS reveal
 *   gate reads. Buildings/statics pass `false`: their warm still counts toward
 *   `pendingWarmCount()` (the teleport gate's readiness) but must not flip the
 *   CELL reveal flag, since cell programs may not be done at the same moment.
 * @returns {Promise<void>} resolves when the job completes (or the fail-open cap).
 */
export function warmSubtree(scene3d, object, lbKey, opts) {
  const markLb = !opts || opts.markLb !== false;
  // Objects to flip visible=true once the warm completes (attach-hidden-then-
  // reveal-on-ready, for layers with no per-frame reveal tick — buildings,
  // statics, entities). Cells use the BFS reveal gate instead.
  const reveal = opts && Array.isArray(opts.reveal) ? opts.reveal : null;
  const renderer = scene3d && scene3d.renderer;
  const camera = scene3d && scene3d.camera;
  const materials = [];
  collectMaterials(object, materials);
  if (!renderer || !camera || !object || materials.length === 0) {
    if (markLb) markPrewarmed(scene3d, lbKey);
    if (reveal) for (const o of reveal) { if (o) o.visible = true; }
    return Promise.resolve();
  }
  // Create + link the programs. NON-BLOCKING: compile()→getProgram() dispatches
  // gl.linkProgram and returns without a uniform fetch. If it throws we fall
  // through to polling anyway (render would lazy-compile).
  try {
    renderer.compile(object, camera, scene3d.scene);
  } catch (_) {
    /* fail-soft */
  }
  const startedMs = typeof performance !== "undefined" ? performance.now() : 0;
  incPending(lbKey);
  return new Promise((resolve) => {
    _jobs.push({
      scene3d,
      lbKey: lbKey >>> 0,
      materials,
      startedMs,
      resolve,
      markLb,
      reveal,
    });
  });
}

function programReady(renderer, material) {
  try {
    const props = renderer.properties;
    if (!props || typeof props.get !== "function") return true; // can't poll → don't hang
    const mp = props.get(material);
    const prog = mp && mp.currentProgram;
    if (!prog) return false; // not linked yet — wait a beat
    if (typeof prog.isReady !== "function") return true;
    return !!prog.isReady(); // getProgramParameter(COMPLETION_STATUS_KHR), non-blocking
  } catch (_) {
    return true; // fail-open
  }
}

/** Per-frame driver — call once from the render loop (loop.js). */
export function tickProgramWarm() {
  if (_jobs.length === 0) return;
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  for (let i = _jobs.length - 1; i >= 0; i--) {
    const job = _jobs[i];
    const renderer = job.scene3d && job.scene3d.renderer;
    let done;
    if (!renderer) {
      done = true;
    } else if (now - job.startedMs > MAX_WARM_MS) {
      done = true; // fail-open
    } else {
      done = true;
      for (const m of job.materials) {
        if (!programReady(renderer, m)) {
          done = false;
          break;
        }
      }
    }
    if (done) {
      _jobs.splice(i, 1);
      decPending(job.lbKey);
      if (job.markLb) markPrewarmed(job.scene3d, job.lbKey);
      if (job.reveal) {
        for (const o of job.reveal) {
          try { if (o) o.visible = true; } catch (_) { /* ignore */ }
        }
      }
      try {
        job.resolve();
      } catch (_) {
        /* ignore */
      }
    }
  }
}

/** Number of in-flight warm jobs (diagnostics / gate readiness heuristics). */
export function pendingWarmCount() {
  return _jobs.length;
}
