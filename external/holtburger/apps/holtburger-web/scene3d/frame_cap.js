// scene3d/frame_cap.js — the page's 3D frame-rate cap from a focused /
// background pair (2026-10-19; the VTank options EnableFPSLimit /
// TargetFPSFocused / TargetFPSBackground, RynthAi's Host.SetFpsLimit).
//
// The render loop (index.js init3D) is paced by `window.__setFrameCap(fps)`
// (0 = uncapped) once the 3D scene is up; `?targetFps=N` pins the pace for the
// page and wins — then nothing here calls the setter (`?targetFps=0` pins it
// uncapped). A page driven by automation (navigator.webdriver: headless and
// CDP-driven Chrome — the agent, bench and verify pages) is never capped by
// the policy either, and neither is a page whose window has never had focus
// (the 1070's off-screen bench Chrome is launched with a debugging port but
// no automation switch, and nobody ever clicks into it): the cap starts the
// first time a person focuses the window. So a measurement can't be silently
// held at 60 / 30 fps; `?targetFps=N` still caps it. This module turns a
// policy { enabled, focusedFps, backgroundFps } into that call and follows
// the window's focus the way scene3d/audio/audio_manager.js tracks activity:
// focused = !document.hidden && document.hasFocus(), kept current by
// visibilitychange / window focus / blur. A hidden tab gets no rAF at all, so
// it simply counts as background.
//
// No imports, no timers: the setter appears only with the scene, so the
// caller's own poll calls refresh() (plugins/rynth-vt/display.js, 1 Hz). Never
// throws.

const safe = (fn, dflt = null) => {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch {
    return dflt;
  }
};

/** `?targetFps=N` (N > 0, capped at 240 — the parse scene3d/index.js uses).
 *  0 = no URL pin. */
export function urlFrameCapFps(search) {
  try {
    const raw = parseFloat(new URLSearchParams(search ?? "").get("targetFps") ?? "");
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.min(raw, 240);
  } catch {
    return 0;
  }
}

/** Does the URL name `targetFps` at all? `?targetFps=0` is an explicit
 *  "uncapped" pin: the policy never applies on that page. */
export function urlNamesFrameCap(search) {
  try {
    return new URLSearchParams(search ?? "").has("targetFps");
  } catch {
    return false;
  }
}

/** focused = visible AND the document has focus (no hasFocus() = focused). */
export function documentFocused(doc) {
  if (!doc) return true;
  if (safe(() => doc.hidden === true, false)) return false;
  const hasFocus = safe(() => doc.hasFocus, null);
  if (typeof hasFocus !== "function") return true;
  return safe(() => !!doc.hasFocus(), true);
}

/** A policy → the cap for this focus state (fps; 0 = uncapped). A rate that is
 *  not a positive number leaves the loop uncapped. */
export function frameCapFor(policy, focused) {
  if (!policy || policy.enabled !== true) return 0;
  const n = Number(focused ? policy.focusedFps : policy.backgroundFps);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The cap driver.
 *
 * @param {object} [env]
 * @param {object} [env.win]  window (the setter, location, focus / blur)
 * @param {object} [env.doc]  document (hidden, hasFocus, visibilitychange)
 * @param {(urlFps:number, why:"url"|"automation") => void} [env.onPinned]
 *        called once, the first time a policy would cap the loop while
 *        ?targetFps pins it ("url") or automation drives the page
 * @returns {{ setPolicy(p:object|null):void, refresh():void, status():object, dispose():void }}
 */
export function createFrameCapDriver({ win = globalThis, doc = null, onPinned = null } = {}) {
  const w = win || globalThis;
  const d = doc || safe(() => w.document, null);
  const search = safe(() => w.location.search, "");
  const urlFps = urlFrameCapFps(search);
  const urlPinned = urlFps > 0 || urlNamesFrameCap(search);
  const automated = safe(() => w.navigator?.webdriver === true, false) === true;
  let policy = null;
  let focused = documentFocused(d);
  let everFocused = focused; // a window nobody ever focused (bench / rig) runs uncapped
  let applied = { fps: 0, setter: null }; // what this driver last handed to the setter
  let pinnedSaid = false;
  let disposed = false;

  function apply() {
    if (disposed) return;
    if (urlPinned || automated) {
      if (!pinnedSaid && frameCapFor(policy, true) > 0) {
        pinnedSaid = true;
        safe(() => onPinned?.(urlFps, urlPinned ? "url" : "automation"));
      }
      return;
    }
    const setter = safe(() => w.__setFrameCap, null);
    if (typeof setter !== "function") return; // no 3D loop yet: refresh() retries
    const fps = everFocused ? frameCapFor(policy, focused) : 0;
    // Never capped by us: no policy means nothing to release.
    if (!policy && !(applied.fps > 0)) return;
    if (fps === applied.fps && setter === applied.setter) return;
    safe(() => setter(fps));
    applied = { fps, setter };
  }

  // Activity tracking (audio_manager.js _installActivityTracking).
  const recompute = () => {
    focused = documentFocused(d);
    if (focused) everFocused = true;
    apply();
  };
  const onFocus = () => {
    focused = !safe(() => d?.hidden === true, false);
    if (focused) everFocused = true;
    apply();
  };
  const onBlur = () => {
    focused = false;
    apply();
  };
  safe(() => d?.addEventListener?.("visibilitychange", recompute));
  safe(() => w.addEventListener?.("focus", onFocus));
  safe(() => w.addEventListener?.("blur", onBlur));

  return {
    /** { enabled, focusedFps, backgroundFps } — or null: release a cap this
     *  driver set (logged out / no settings). Applied at once. */
    setPolicy(p) {
      policy = p && typeof p === "object"
        ? { enabled: p.enabled === true, focusedFps: Number(p.focusedFps), backgroundFps: Number(p.backgroundFps) }
        : null;
      apply();
    },
    /** Re-read the focus and re-apply (the setter may have appeared, or been
     *  replaced by a scene re-init). */
    refresh() {
      recompute();
    },
    status() {
      return {
        policy: policy ? { ...policy } : null,
        focused,
        everFocused,
        fps: applied.fps,
        applied: !!applied.setter,
        urlFps,
        pinned: urlPinned || automated,
        automated,
        disposed,
      };
    },
    /** Release the cap this driver set (back to bare rAF) and the listeners. */
    dispose() {
      if (disposed) return;
      const setter = safe(() => w.__setFrameCap, null);
      if (applied.fps > 0 && typeof setter === "function") safe(() => setter(0));
      applied = { fps: 0, setter: null };
      disposed = true;
      safe(() => d?.removeEventListener?.("visibilitychange", recompute));
      safe(() => w.removeEventListener?.("focus", onFocus));
      safe(() => w.removeEventListener?.("blur", onBlur));
    },
  };
}
