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
//        e. TEXTURE RE-HYDRATION (2026-08-06) — see below.
//   4. Resume the render loop.
//
// TEXTURE RE-HYDRATION — why step 3e exists.
//   Step 3a is the whole problem. Three's restore clears WebGLProperties
//   (three.module.js:16382 via :17055) so every texture re-uploads FROM
//   `image.data` — which is precisely why the 1,332 MB of CPU-side pixel
//   copies the census found (§9 of the 08-05 handoff) cannot simply be
//   released: today a context loss recovers BECAUSE those copies exist, and
//   dropping them would turn a recovered event into a permanently black
//   world (§10, "the blocker that ends the discussion").
//   `texture_rehydrate.js` is the replacement source. Any module that
//   releases a texture's CPU copy registers a way to re-supply it; this
//   handler runs that registry BEFORE `onResume`, i.e. before the frame pump
//   is allowed to call `render()` again. Ordering is the correctness
//   property: `onPause` sets `running = false` and `tick` early-returns on
//   `!running` (index.js:2235-2236), so as long as we do not call `onResume`
//   until the pass settles, NO render can observe a texture with no pixels.
//   The pass is ASYNC and will stall the restore for a beat — accepted and
//   documented in that module; it carries a hard deadline so a wedged decode
//   resumes the pump loudly instead of deadlocking it.
//   NO-OP TODAY: nothing releases a CPU copy yet, so `releasedTextureCount()`
//   is 0 and this handler keeps its original fully-SYNCHRONOUS shape — the
//   async branch is not entered at all.
//
// Devtools:
//   `window.__loseContext()` / `window.__restoreContext()` use the
//   `WEBGL_lose_context` extension to manually fire the cycle for
//   verification. `window.__webglContextRecoveryHistory()` returns the
//   loss/restore event log. `window.__textureRehydrate.stats()` reports the
//   re-hydration registry + its miss counter.

import {
  releasedTextureCount,
  rehydrateReleasedTextures,
  installTextureRehydrateDevtools,
} from "./texture_rehydrate.js";

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
 * @param {number} [opts.rehydrateTimeoutMs] — hard deadline for the texture
 *   re-hydration pass (default `DEFAULT_TIMEOUT_MS`). Past it the frame pump
 *   resumes anyway, loudly. Overridable so the node suite can prove the
 *   no-deadlock property in milliseconds instead of 15 seconds.
 * @returns {{history: Object[], lossCount: () => number, isLost: () => boolean, isRehydrating: () => boolean}}
 */
export function installWebglContextRecovery({
  renderer,
  canvas,
  getLiveScene3d,
  onPause,
  onResume,
  pushEventRecord,
  rehydrateTimeoutMs,
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
  // `lossCount` doubles as the EPOCH. A re-hydration pass captures it at
  // restore time; if it has moved by the time the pass settles, a SECOND
  // context loss superseded this restore and we must not resume the pump —
  // that loss's own restore owns the resume. This is the no-double-fire
  // invariant.
  let lossCount = 0;
  // Epoch whose restore handler has already run, so a duplicate
  // `webglcontextrestored` for the same loss cannot start a second pass.
  let restoredEpoch = -1;
  let rehydrating = false;

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
    // Duplicate restore for a loss we already handled (a driver that fires the
    // event twice, or `__restoreContext()` called by hand after a real
    // restore). Starting a second pass would double-decode and double-resume.
    if (restoredEpoch === lossCount) {
      // eslint-disable-next-line no-console
      console.warn(
        `[webgl-recovery] duplicate webglcontextrestored for loss #${lossCount} — ignoring`
      );
      return;
    }
    restoredEpoch = lossCount;
    const myEpoch = lossCount;
    const downMs = lostAtMs !== null
      ? ((performance?.now?.() ?? 0) - lostAtMs)
      : null;
    // eslint-disable-next-line no-console
    console.warn(
      `[webgl-recovery] context RESTORED after ${downMs?.toFixed?.(0) ?? "?"}ms — rebuilding subsystem GPU state`
    );

    const live = getLiveScene3d?.();
    // CSS pixels — `setSize` on both composers is a CSS-px API (it forwards
    // to renderer.setSize). `canvas.width/height` is the DRAWING BUFFER
    // (CSS x pixelRatio), so the old fallback silently rescaled the canvas by
    // the pixel ratio whenever clientWidth read 0 (hidden tab / detached
    // canvas at restore time). Same confusion class as the 2026-08-03 cloud
    // composer fix; ask the renderer, which owns the CSS size.
    let w = canvas.clientWidth;
    let h = canvas.clientHeight;
    if (!w || !h) {
      try {
        // `getSize(target)` does `target.set(w, h)` — duck-type it so this
        // leaf module stays THREE-import-free.
        const s = { width: 0, height: 0, set(a, b) { this.width = a; this.height = b; return this; } };
        renderer.getSize?.(s);
        if (s.width > 0 && s.height > 0) { w = s.width; h = s.height; }
      } catch (_) { /* fall through to the 1x1 floor */ }
    }
    w = w || 1;
    h = h || 1;

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

    // ── step 3e: re-supply released CPU pixel copies before the pump runs ──
    // The registry is EMPTY on a page where nothing released anything, which
    // is every page today. Keep the original synchronous shape in that case:
    // no promise, no microtask, byte-for-byte the old behaviour.
    const pending = releasedTextureCount();
    if (pending === 0) {
      record("restored", { downMs, count: lossCount, rehydrated: 0 });
      _resume();
      return;
    }

    // Async from here. `onResume` is deliberately NOT called yet: it is what
    // sets `running = true` (index.js:4938), and `tick` early-returns while
    // that is false (index.js:2235-2236). Holding it is the ordering
    // guarantee — no render() can observe a texture whose pixels are still
    // missing. The cost is a stalled restore; the alternative is a black one.
    rehydrating = true;
    if (live) live.__webglRehydrating = true;
    record("restored", { downMs, count: lossCount, rehydratePending: pending });
    rehydrateReleasedTextures({
      reason: `context-restore #${myEpoch}`,
      ...(Number.isFinite(rehydrateTimeoutMs) ? { timeoutMs: rehydrateTimeoutMs } : {}),
      // A second loss while we are decoding: abandon rather than finish work
      // for a GL context that is already gone again.
      isStale: () => lossCount !== myEpoch,
    })
      .catch((e) => {
        // rehydrateReleasedTextures is documented never to throw; if it does,
        // that is a bug in it and we still must not strand the frame pump.
        // eslint-disable-next-line no-console
        console.error("[webgl-recovery] re-hydration pass threw — resuming anyway:", e);
        return { failed: -1, rehydrated: 0, aborted: false };
      })
      .then((sum) => {
        rehydrating = false;
        if (live) live.__webglRehydrating = false;
        if (lossCount !== myEpoch) {
          // Superseded. The newer loss already paused the pump (or is about
          // to); resuming here would race it back on with a dead context.
          // eslint-disable-next-line no-console
          console.warn(
            `[webgl-recovery] re-hydration for loss #${myEpoch} finished after loss ` +
            `#${lossCount} — NOT resuming; that loss's restore owns the resume`
          );
          record("rehydrate-superseded", { epoch: myEpoch, count: lossCount });
          return;
        }
        record("rehydrated", {
          count: lossCount,
          ok: sum?.rehydrated ?? 0,
          failed: sum?.failed ?? 0,
          ms: sum?.ms ?? 0,
        });
        _resume();
      });
  }

  function _resume() {
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
  // `window.__textureRehydrate` — registry size + the miss counter, on the
  // same console as the loss/restore drivers above.
  installTextureRehydrateDevtools();

  const handle = {
    history,
    lossCount: () => lossCount,
    isLost: () => {
      const live = getLiveScene3d?.();
      return !!live?.__webglContextLost;
    },
    // GL context is back but pixels are still being re-supplied — the frame
    // pump is still parked. Distinct from `isLost`, which tracks the context.
    isRehydrating: () => rehydrating,
  };
  canvas.__webglRecoveryInstalled = true;
  canvas.__webglRecoveryHandle = handle;
  return handle;
}
