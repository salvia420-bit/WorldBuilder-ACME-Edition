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

export const SHADER_PREWARM_ON = _optIn("shaderPrewarm");
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
 */
export function installLinkProbe(renderer) {
  if (!LINK_PROBE_ON || !renderer || typeof renderer.getContext !== "function") return null;
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
  console.info("[shader_prewarm] link probe installed (?linkProbe=on) — window.__linkProbe.summary()");
  return state;
}
