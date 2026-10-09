// shader_prewarm.js (2026-08-01) — aim every shader warm at the COMPOSER's
// program variant, not the canvas one.
//
// three derives two program-cache-key axes from the render target BOUND AT
// COMPILE TIME (WebGLPrograms.getParameters, three r184 :7493/:7548/:7584):
//   null target  → renderer.toneMapping + outputColorSpace (sRGB) baked in
//   any non-null → NoToneMapping + working-color-space output
// The live world renders exclusively through the pmndrs EffectComposer into a
// HalfFloat inputBuffer (atmosphere_pipeline.js) — the NON-NULL variant. But
// every warm site (boot renderer.compile pass 1/2 in index.js, bake_prewarm's
// guardedCompileAsync and everything routed through it: world bakes, envcells,
// per-spawn rig warm, the archetype matrix) compiled with the CANVAS bound,
// warming programs the world passes never use. The 07-16 walk-stall profile
// (/mnt/wbterminal2/tmp/walk-stall-attrib.json, 1070) shows the result: 43
// programs force-linking mid-walk at 172-849 ms each, getProgramParameter =
// 32.9 % of in-stall self-time — the warms had "done" their job on the wrong
// variant. Same mechanism behind the ~22 s cold-load freeze (the 06-27
// finding: boot compile warms sRGB, composer needs the RT variant).
//
// `?shaderPrewarm=on` (exact-match opt-in per the url-flags.md idiom rule;
// default OFF pending the 1070 walk-stall A/B) binds a shared 1×1 HalfFloat
// dummy target around every renderer.compile. A dummy target is exactly
// equivalent for the program key — getParameters inspects only
// null-vs-non-null (and XR), never size/format — and unlike the composer's
// inputBuffer it exists before the atmosphere pipeline does, so no ordering
// or handle-plumbing is needed. Flag OFF = byte-identical legacy behaviour.
//
// NOTE the boot window: until the atmosphere pipeline is constructed the loop
// falls back to direct-to-canvas renderer.render (index.js ~1001), so
// materials drawn in that window still lazy-compile their canvas variant —
// unchanged from today. Once the composer exists, warmed == live.
// `?wireframe=1` never builds a composer (canvas variant IS live there);
// leave shaderPrewarm off in that mode.
//
// `?linkProbe=on` (independent flag — needed in BOTH arms of the A/B) wraps
// gl.linkProgram + gl.getProgramParameter to split three's cheap
// KHR_parallel_shader_compile COMPLETION_STATUS_KHR ready-polls from forced
// LINK_STATUS waits (the synchronous driver-link flush). Score the walk-stall
// re-run on `window.__linkProbe.summary()`.

import * as THREE from "three";

function _optIn(name) {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      return new URLSearchParams(globalThis.location.search).get(name) === "on";
    }
  } catch (_) {}
  return false;
}

/** True only for an explicit off-form. A typo keeps the default rather than
 *  silently disabling it — the same rule `?statBatchMemo` adopted, for the same
 *  reason: a mistyped flag must not cost a 2-second stall in silence. */
function _optOut(name) {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      return ["off", "0", "false", "no"].includes(
        String(new URLSearchParams(globalThis.location.search).get(name) || "").toLowerCase());
    }
  } catch (_) {}
  return false;
}

/** `?shaderPrewarm=off` escapes; anything else (including absent) is ON.
 *
 * DEFAULT FLIPPED 2026-08-06 — this is the walk-stall A/B the flag row has been
 * waiting on since 08-05, run on the 1070 at `?quality=ultra&clouds=on&wxMap=nasa`
 * while moving, with `scene3d/stall_probe.js` armed:
 *
 *   shaderPrewarm=off   p50 49.4  p95 70.8  p99 97.9   MAX 2131 ms   >250ms 5   >1s 1
 *   shaderPrewarm=ON    p50 48.4  p95 67.9  p99 90.6   MAX  369 ms   >250ms 1   >1s 0
 *
 * Steady state barely moves, which is the point: this was never a throughput
 * problem. The stall probe attributed the worst frame outright —
 * `intervalMs 576.2, renderMs 576.1, outsideMs 0.1, linkPrograms 1` — a single
 * synchronous program link INSIDE `renderer.render`. A transcode or a bake would
 * have landed in `outsideMs`; those exist too but are a ~100 ms class
 * (`xu7DecodeMs 67.8` on a 101 ms frame), not the p99.
 *
 * ⚠ n=1 PER ARM on a rare-event metric. The mechanism is confirmed (the 07-16
 * profile in the header above measured 43 programs linking at 172-849 ms each on
 * this same GPU), but MAX and the >1s count are single observations and stalls
 * are sparse by nature — do not treat 2131 -> 369 as a tight bound.
 *
 * ⚠ COST NOT YET MEASURED: prewarming moves link work to boot. Cold-boot time
 * under this default has not been measured on the 1070. If boot regresses
 * materially, `?shaderPrewarm=off` is the one-flag revert.
 */
export const SHADER_PREWARM_ON = !_optOut("shaderPrewarm");
export const LINK_PROBE_ON = _optIn("linkProbe");

let _warmTarget = null;
function _getWarmTarget() {
  if (!_warmTarget) {
    _warmTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    _warmTarget.texture.name = "shader-prewarm-warm-target";
  }
  return _warmTarget;
}

/**
 * Run `fn` (a renderer.compile call) with the warm target bound so the
 * compiled programs carry the composer-path variant key. Restores the
 * previously bound target on every path. Flag OFF (or an unusable renderer)
 * → plain `fn()`, zero behaviour change.
 *
 * @template T
 * @param {any} renderer THREE.WebGLRenderer (or a mock in tests)
 * @param {() => T} fn
 * @returns {T}
 */
export function withWarmTarget(renderer, fn) {
  if (
    !SHADER_PREWARM_ON ||
    !renderer ||
    typeof renderer.setRenderTarget !== "function" ||
    typeof renderer.getRenderTarget !== "function"
  ) {
    return fn();
  }
  const prev = renderer.getRenderTarget();
  let bound = false;
  try {
    renderer.setRenderTarget(_getWarmTarget());
    bound = true;
  } catch (_) {
    /* fail-soft: warm proceeds on the canvas variant (legacy) */
  }
  try {
    return fn();
  } finally {
    if (bound) {
      try {
        renderer.setRenderTarget(prev);
      } catch (_) {}
    }
  }
}

// GL enum values, used only as fallbacks when the context/extension objects
// don't expose them (mocks): LINK_STATUS 0x8B82, COMPLETION_STATUS_KHR 0x91B1.
const _LINK_STATUS_FALLBACK = 0x8b82;
const _COMPLETION_STATUS_KHR = 0x91b1;

/**
 * Install the link-cost probe on the renderer's GL context (`?linkProbe=on`).
 * Idempotent per context. Returns the probe state ({stats, reset, summary})
 * or null when the flag is off / the context is unusable. Also published as
 * `window.__linkProbe`.
 *
 * `{ force: true }` (2026-08-06) bypasses the URL-flag gate for a caller that
 * has already decided it wants the probe. `stall_probe.js` uses it: the whole
 * point of arming that instrument is to price the LINK_STATUS bucket in ms, and
 * requiring the operator to also remember `&linkProbe=on` on a 1070 session
 * they only get to run once is a footgun, not a safety rail. Everything else
 * about the probe is unchanged — same wrap, same counters, same idempotence.
 *
 * @param {any} renderer
 * @param {{force?: boolean}} [opts]
 */
export function installLinkProbe(renderer, opts = {}) {
  if ((!LINK_PROBE_ON && opts.force !== true) || !renderer || typeof renderer.getContext !== "function") return null;
  let gl;
  try {
    gl = renderer.getContext();
  } catch (_) {
    return null;
  }
  if (!gl || typeof gl.getProgramParameter !== "function") return null;
  if (gl.__linkProbeState) return gl.__linkProbeState;

  let completionPname = _COMPLETION_STATUS_KHR;
  try {
    const ext = typeof gl.getExtension === "function" ? gl.getExtension("KHR_parallel_shader_compile") : null;
    if (ext && typeof ext.COMPLETION_STATUS_KHR === "number") completionPname = ext.COMPLETION_STATUS_KHR;
  } catch (_) {}
  const linkPname = typeof gl.LINK_STATUS === "number" ? gl.LINK_STATUS : _LINK_STATUS_FALLBACK;

  const _now =
    typeof globalThis !== "undefined" && globalThis.performance && typeof globalThis.performance.now === "function"
      ? () => globalThis.performance.now()
      : () => Date.now();

  const _zero = () => ({
    linkProgramCalls: 0,
    // LINK_STATUS reads: the forced-wait bucket. A read on a still-linking
    // program blocks on the driver link; `stallCalls` counts reads >5 ms.
    linkStatus: { calls: 0, ms: 0, worstMs: 0, stallCalls: 0 },
    // COMPLETION_STATUS_KHR reads: three's cheap async ready-poll.
    completion: { calls: 0, ms: 0 },
    other: { calls: 0, ms: 0 },
  });
  let stats = _zero();

  const origLink = gl.linkProgram;
  gl.linkProgram = function (program) {
    stats.linkProgramCalls += 1;
    return origLink.call(this, program);
  };
  const origGet = gl.getProgramParameter;
  gl.getProgramParameter = function (program, pname) {
    const t0 = _now();
    const r = origGet.call(this, program, pname);
    const dt = _now() - t0;
    if (pname === linkPname) {
      stats.linkStatus.calls += 1;
      stats.linkStatus.ms += dt;
      if (dt > stats.linkStatus.worstMs) stats.linkStatus.worstMs = dt;
      if (dt > 5) stats.linkStatus.stallCalls += 1;
    } else if (pname === completionPname) {
      stats.completion.calls += 1;
      stats.completion.ms += dt;
    } else {
      stats.other.calls += 1;
      stats.other.ms += dt;
    }
    return r;
  };

  const state = {
    get stats() {
      return stats;
    },
    reset() {
      stats = _zero();
    },
    summary() {
      const ls = stats.linkStatus;
      return (
        `linkProgram=${stats.linkProgramCalls} | ` +
        `LINK_STATUS ${ls.calls} reads ${ls.ms.toFixed(1)}ms ` +
        `(worst ${ls.worstMs.toFixed(1)}ms, >5ms×${ls.stallCalls}) | ` +
        `COMPLETION_STATUS_KHR ${stats.completion.calls} reads ${stats.completion.ms.toFixed(1)}ms | ` +
        `other ${stats.other.calls} reads ${stats.other.ms.toFixed(1)}ms`
      );
    },
  };
  gl.__linkProbeState = state;
  try {
    if (typeof window !== "undefined") window.__linkProbe = state;
  } catch (_) {}
  // eslint-disable-next-line no-console
  console.info(
    `[shader_prewarm] link probe installed (${opts.force === true ? "forced by caller" : "?linkProbe=on"}) — window.__linkProbe.summary()`,
  );
  return state;
}

// ============================================================================
// Targeted warm helpers (2026-10-09, D2: `?tunnelWorldWarm` in portal_space.js,
// `?pmremPrecompile` in ibl_environment.js). Used only by those two flags.
// ============================================================================
// three r184 keys a program on the target bound at compile time by null vs
// non-null only (getParameters: outputColorSpace + toneMapping; no size/type),
// so a warm binds the right CLASS of target per draw: null for a pass that
// draws to the canvas, the shared 1×1 HalfFloat warm target for anything drawn
// offscreen (composer buffers, PMREM cubeUV / ping-pong, the IBL cube RT).
// A warm only STARTS the link (KHR_parallel_shader_compile links in the GPU
// process); callers poll `programPending` — never getUniforms/LINK_STATUS —
// so nothing here can block the main thread on a link.

/** The shared non-null warm target (1×1 HalfFloat, never drawn into). */
export function getWarmTarget() {
  return _getWarmTarget();
}

/**
 * renderer.compile(root, camera, targetScene) with `target` bound (null = the
 * canvas), restoring the previous target / cube face / mip level on every
 * path. Must run outside renderer.render() (compile resets three's render
 * state). Returns the compiled material Set, or null (no usable renderer, or
 * compile threw — the materials then link at first draw, as before).
 */
export function compileWithTarget(renderer, root, camera, targetScene, target) {
  if (
    !renderer || !root || !camera ||
    typeof renderer.compile !== "function" ||
    typeof renderer.setRenderTarget !== "function" ||
    typeof renderer.getRenderTarget !== "function"
  ) return null;
  const prev = renderer.getRenderTarget();
  let face = 0, mip = 0;
  try {
    face = typeof renderer.getActiveCubeFace === "function" ? renderer.getActiveCubeFace() : 0;
    mip = typeof renderer.getActiveMipmapLevel === "function" ? renderer.getActiveMipmapLevel() : 0;
  } catch (_) { /* defaults */ }
  try {
    renderer.setRenderTarget(target ?? null);
    const set = renderer.compile(root, camera, targetScene ?? null);
    return set && typeof set.forEach === "function" ? set : null;
  } catch (_) {
    return null;
  } finally {
    try { renderer.setRenderTarget(prev, face, mip); } catch (_) { /* best effort */ }
  }
}

/** Every program `material` owns — three keeps one per cache key in
 *  `properties.programs` (a transparent DoubleSide material compiles a Back and
 *  a Front one), not just `currentProgram`. Appends to `out`. */
export function programsOf(renderer, material, out = []) {
  let mp = null;
  try { mp = renderer?.properties?.get?.(material) ?? null; } catch (_) { mp = null; }
  const progs = mp && mp.programs;
  if (progs && typeof progs.forEach === "function") progs.forEach((p) => { if (p) out.push(p); });
  else if (mp && mp.currentProgram) out.push(mp.currentProgram);
  return out;
}

/** Still linking? Non-blocking: three's isReady() polls COMPLETION_STATUS_KHR
 *  (and is `true` from the start without the extension). A program three has
 *  released (usedTimes 0 — deleted) or whose poll throws / returns null (lost
 *  context) counts as done, so a stale entry can never hold anything. */
export function programPending(p) {
  if (!p || typeof p.isReady !== "function") return false;
  if (typeof p.usedTimes === "number" && p.usedTimes <= 0) return false;
  try { return p.isReady() === false; } catch (_) { return false; }
}

/** Drop every program that is no longer pending from `set` (a Set); returns
 *  how many are still linking. */
export function prunePending(set) {
  if (!set || typeof set.forEach !== "function") return 0;
  for (const p of set) if (!programPending(p)) set.delete(p);
  return set.size;
}

const _renderable = (o) => !!o && (o.isMesh || o.isPoints || o.isLine || o.isSprite) && !!o.material;
const _kindBits = (o) => (o.isInstancedMesh ? 1 : 0) | (o.isBatchedMesh ? 2 : 0) | (o.isSkinnedMesh ? 4 : 0);
const _standIns = new WeakMap(); // scene -> stand-in target scene

/**
 * Compile the materials of `scene` that are new or changed since this warm
 * last compiled them, with `target` bound (see compileWithTarget), in ONE
 * compile() call. One traversal collects the renderables (visible or not —
 * a hidden patch still draws the moment it is shown) and the lights on the
 * visible path; compile() then runs against a stand-in target scene carrying
 * the real scene's fog / environment / environmentRotation and those lights,
 * so the light-count and fog bits of every key match the real draw without a
 * second walk of the world. `opts.seen` (WeakMap material → Set of keys) makes
 * a re-run cheap: a material is compiled again only when its version, its
 * object kind, the scene's light count, fog or environment class changed.
 * `opts.skip(object)` prunes a subtree; `opts.maxNew` caps the materials
 * compiled per call (the rest wait for the next call: `deferred`).
 *
 * @returns {{materials: Set|null, objects: number, compiled: number, deferred: number}}
 */
export function warmSceneMaterials(renderer, scene, camera, target, opts = {}) {
  const out = { materials: null, objects: 0, compiled: 0, deferred: 0 };
  if (!renderer || !scene || !camera) return out;
  const seen = opts.seen instanceof WeakMap ? opts.seen : null;
  const skip = typeof opts.skip === "function" ? opts.skip : null;
  const maxNew = Number.isFinite(opts.maxNew) && opts.maxNew > 0 ? opts.maxNew : Infinity;
  const lights = [];
  const objs = [];
  const picked = new Map(); // material -> its seen key, this call
  const over = new Set(); // materials left for a later call (maxNew)
  const env = scene.environment;
  const fog = scene.fog;
  // Iterative walk (deep worlds): [object, onVisiblePath].
  const stack = [[scene, scene.visible !== false]];
  const pending = [];
  while (stack.length) {
    const [o, vis] = stack.pop();
    if (!o || (skip && o !== scene && skip(o))) continue;
    out.objects += 1;
    if (o.isLight) { if (vis) lights.push(o); }
    else if (_renderable(o)) pending.push(o);
    const ch = o.children;
    if (ch && ch.length) for (let i = ch.length - 1; i >= 0; i--) stack.push([ch[i], vis && ch[i] && ch[i].visible !== false]);
  }
  const ctx = `${lights.length}|${env ? 1 : 0}:${env?.image?.height ?? 0}|${fog ? (fog.isFogExp2 ? 2 : 1) : 0}`;
  for (const o of pending) {
    const list = Array.isArray(o.material) ? o.material : [o.material];
    let take = false;
    for (const m of list) {
      if (!m || !m.isMaterial || picked.has(m)) continue;
      const key = `${_kindBits(o)}|${m.version}|${ctx}`;
      const s = seen && seen.get(m);
      if (s && s.has(key)) continue;
      if (picked.size >= maxNew) { over.add(m); continue; }
      picked.set(m, key);
      take = true;
    }
    if (take) objs.push(o);
  }
  out.deferred = over.size;
  if (objs.length === 0) return out;
  let standIn = _standIns.get(scene);
  if (!standIn) {
    standIn = {
      isScene: true,
      __lights: [],
      get fog() { return scene.fog; },
      get environment() { return scene.environment; },
      get environmentRotation() { return scene.environmentRotation; },
      traverseVisible(cb) { for (const l of this.__lights) cb(l); },
      traverse(cb) { for (const l of this.__lights) cb(l); },
    };
    _standIns.set(scene, standIn);
  }
  standIn.__lights = lights;
  const root = {
    traverse(cb) { for (const o of objs) cb(o); },
    traverseVisible(cb) { for (const o of objs) cb(o); },
  };
  const mats = compileWithTarget(renderer, root, camera, standIn, target);
  standIn.__lights = [];
  if (!mats) return out;
  out.materials = mats;
  out.compiled = mats.size;
  if (seen) {
    // Key on the version AFTER compile: three's two-pass prepare of a
    // transparent DoubleSide material bumps it (side Back/Front + needsUpdate).
    for (const [m, key0] of picked) {
      const key = key0.replace(/^(\d+)\|\d+\|/, `$1|${m.version}|`);
      let s = seen.get(m);
      if (!s || s.size >= 8) { s = new Set(); seen.set(m, s); }
      s.add(key);
    }
  }
  return out;
}
