// scene3d/webgl_context_recovery.js — WebGL context loss/restore recovery.
//
// Without `preventDefault()` on the canvas `webglcontextlost` event,
// Three.js's WebGLRenderer fails permanently when the browser revokes
// the GL context under VRAM/driver pressure (observed 7× on 1070 with
// `quality=ultra` + cloud RTs + CSM + lensFlare + POM during vendor
// open / paperdoll wield / motion bursts).
//
// What we do:
//   1. preventDefault on `webglcontextlost` so the browser will attempt
//      to restore (with no preventDefault, the context is gone for
//      good and only a page reload recovers).
//   2. Pause the render loop while the context is gone — render() with
//      a lost context throws + spams the console.
//   3. On `webglcontextrestored`:
//        a. Three.js's WebGLRenderer has its own internal listener that
//           clears `WebGLProperties` so every tracked texture/buffer
//           re-uploads on the next render(). We don't need to touch
//           Three-owned GL state directly.
//        b. The post-processing composers
//           (`atmospherePipeline`/`cloudOverlay`) own RenderTargets via
//           pmndrs `EffectComposer`. Three's setSize() short-circuits
//           when size is unchanged, so we bounce setSize(1,1) → (w,h)
//           to force fresh RT allocation.
//        c. `csmState` skip-rebuild cache holds pre-loss cam/sun
//           deltas; invalidate so the next `updateCsm` rebuilds
//           cascades fresh.
//        d. Reset the bound render target back to the canvas.
//   4. Resume the render loop.
//
// Devtools:
//   `window.__loseContext()` / `window.__restoreContext()` use the
//   `WEBGL_lose_context` extension to manually fire the cycle for
//   verification. `window.__webglContextRecoveryHistory()` returns the
//   loss/restore event log.

const HISTORY_CAP = 16;

/**
 * Install canvas `webglcontextlost` + `webglcontextrestored` listeners
 * and expose devtools helpers. Idempotent if called twice — second
 * call short-circuits.
 *
 * @param {Object} opts
 * @param {THREE.WebGLRenderer} opts.renderer — used to find the GL
 *   context for the WEBGL_lose_context extension + reset bound RT.
 * @param {HTMLCanvasElement} opts.canvas — the WebGL canvas; receives
 *   the two event listeners.
 * @param {() => Object|null} opts.getLiveScene3d — lazy accessor so we
 *   can read `atmospherePipeline`/`cloudOverlay`/`csmState` at restore
 *   time (they may be attached after install).
 * @param {() => void} [opts.onPause] — invoked when context lost
 *   (typically pauses the rAF tick).
 * @param {() => void} [opts.onResume] — invoked after subsystem
 *   restore hooks run.
 * @param {(rec: Object) => void} [opts.pushEventRecord] — optional
 *   eventLog hook for the validator surface.
 * @returns {{history: Object[], lossCount: () => number, isLost: () => boolean}}
 */
export function installWebglContextRecovery({
  renderer,
  canvas,
  getLiveScene3d,
  onPause,
  onResume,
  pushEventRecord,
}) {
  if (!canvas || !renderer) {
    throw new Error("installWebglContextRecovery: renderer + canvas required");
  }
  if (canvas.__webglRecoveryInstalled) {
    // eslint-disable-next-line no-console
    console.warn("[webgl-recovery] already installed on this canvas — skipping");
    return canvas.__webglRecoveryHandle;
  }

  const history = [];
  let lostAtMs = null;
  let lossCount = 0;

  function record(state, extra) {
    const ts = (typeof performance !== "undefined" && performance.now)
      ? performance.now() : 0;
    const entry = { state, ts, ...extra };
    history.push(entry);
    if (history.length > HISTORY_CAP) history.shift();
    try {
      if (typeof pushEventRecord === "function") {
        pushEventRecord({ kind: "webgl-context", state, ts, ...extra });
      }
    } catch (_) { /* eventLog is best-effort */ }
  }

  function _onLost(e) {
    // The defining call: tell the browser we want a restore. Without
    // preventDefault the context is unrecoverable.
    e.preventDefault();
    lostAtMs = (typeof performance !== "undefined" && performance.now)
      ? performance.now() : 0;
    lossCount++;
    const live = getLiveScene3d?.();
    if (live) live.__webglContextLost = true;
    record("lost", { count: lossCount });
    try { onPause?.(); } catch (e2) {
      // eslint-disable-next-line no-console
      console.warn("[webgl-recovery] onPause threw:", e2);
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[webgl-recovery] context LOST (loss #${lossCount}); paused render loop, awaiting restore`
    );
  }

  function _onRestored() {
    const downMs = lostAtMs !== null
      ? ((performance?.now?.() ?? 0) - lostAtMs)
      : null;
    // eslint-disable-next-line no-console
    console.warn(
      `[webgl-recovery] context RESTORED after ${downMs?.toFixed?.(0) ?? "?"}ms — rebuilding subsystem GPU state`
    );

    const live = getLiveScene3d?.();
    const w = canvas.clientWidth || canvas.width || 1;
    const h = canvas.clientHeight || canvas.height || 1;

    // Bounce setSize on the post-processing composers to force RT
    // re-allocation. Three's WebGLRenderTarget.setSize() short-
    // circuits when (w, h) matches the current size, so we bounce
    // through (1, 1) first.
    const _bounce = (sub, name) => {
      if (!sub || typeof sub.setSize !== "function") return;
      try {
        sub.setSize(1, 1);
        sub.setSize(w, h);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[webgl-recovery] ${name}.setSize failed:`, e);
      }
    };
    _bounce(live?.atmospherePipeline, "atmospherePipeline");
    _bounce(live?.cloudOverlay, "cloudOverlay");

    // CSM cascade RTs are Three.js DirectionalLight shadow maps;
    // Three auto-restores them. But our skip-rebuild cache holds the
    // pre-loss cam/sun deltas and would early-out of the next
    // updateCsm. Invalidate so the next frame rebuilds cascades.
    try { live?.csmState?.invalidate?.(); } catch (_) {}

    // Belt-and-suspenders: reset Three's RT binding to the canvas.
    try { renderer.setRenderTarget(null); } catch (_) {}

    if (live) live.__webglContextLost = false;
    record("restored", { downMs, count: lossCount });
    try { onResume?.(); } catch (e2) {
      // eslint-disable-next-line no-console
      console.warn("[webgl-recovery] onResume threw:", e2);
    }
  }

  canvas.addEventListener("webglcontextlost", _onLost, false);
  canvas.addEventListener("webglcontextrestored", _onRestored, false);

  if (typeof window !== "undefined") {
    // Devtools helpers — manual loss + restore for the verification
    // cycle. The browser's spec says loseContext() fires
    // `webglcontextlost` synchronously; restoreContext() fires
    // `webglcontextrestored` on the next event-loop turn.
    window.__loseContext = () => {
      const gl = renderer.getContext();
      const ext = gl?.getExtension?.("WEBGL_lose_context");
      if (!ext) return "WEBGL_lose_context extension unavailable";
      ext.loseContext();
      return "loseContext() called — webglcontextlost should have fired";
    };
    window.__restoreContext = () => {
      const gl = renderer.getContext();
      const ext = gl?.getExtension?.("WEBGL_lose_context");
      if (!ext) return "WEBGL_lose_context extension unavailable";
      ext.restoreContext();
      return "restoreContext() called — webglcontextrestored will fire on next turn";
    };
    window.__webglContextRecoveryHistory = () => history.slice();
  }

  const handle = {
    history,
    lossCount: () => lossCount,
    isLost: () => {
      const live = getLiveScene3d?.();
      return !!live?.__webglContextLost;
    },
  };
  canvas.__webglRecoveryInstalled = true;
  canvas.__webglRecoveryHandle = handle;
  return handle;
}
