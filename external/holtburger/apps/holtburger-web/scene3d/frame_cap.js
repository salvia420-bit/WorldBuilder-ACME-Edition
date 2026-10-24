// scene3d/frame_cap.js — the page's 3D frame-rate cap from a focused /
// background pair (2026-10-19; the VTank options EnableFPSLimit /
// TargetFPSFocused / TargetFPSBackground, RynthAi's Host.SetFpsLimit).
//
// The render loop (index.js init3D) is paced by `window.__setFrameCap(fps)`
// (0 = uncapped) once the 3D scene is up; `?targetFps=N` pins the pace for the
// page and wins — then nothing here calls the setter (`?targetFps=0` pins it
// uncapped). A page driven by automation (navigator.webdriver: headless and
// Playwright-launched Chrome — the local agent and verify pages) is never
// capped by the policy either, and neither is a page whose window has never
// had focus: the cap starts the first time the document has focus.
// 2026-10-20 (improvement hunt recent-rynth-diff-1): neither exemption covers
// the 1070 bench / probe drivers, so they pin `?targetFps=0` instead
// (scripts/perf-worker/lib/bench-url.mjs, on every URL they load). Their
// Chrome is started with only a debugging port (navigator.webdriver false),
// and Playwright's connectOverCDP turns on Emulation.setFocusEmulationEnabled
// for every page it attaches to (playwright-core 1.59.1
// lib/server/chromium/crPage.js:418), so document.hasFocus() is true from the
// first frame although nobody ever clicks into that window — the cap would
// hold every arm at 60 fps. A docked DevTools taking focus blurs the page:
// a manual Performance recording runs at the 30 fps background cap unless the
// page has `?targetFps=0`. This module turns a
// policy { enabled, focusedFps, backgroundFps } into that call and follows
// the window's focus the way scene3d/audio/audio_manager.js tracks activity:
// focused = !document.hidden && document.hasFocus(), kept current by
// visibilitychange / window focus / blur. A hidden tab gets no rAF at all, so
// it simply counts as background.
// 2026-10-24 — OFF-SCREEN = BACKGROUND (owner: "its supposed to be 30 fps
// offscreen limit"). A window parked far outside every monitor (the 1070 test
// Chrome's --window-position=-32000,-32000; Windows also parks a MINIMIZED
// window at -32000) runs at the background rate whatever focus it reports:
// nobody can see it, and CDP focus emulation would otherwise read it focused
// (60) — or, never focused, uncapped. ?targetFps still wins (an uncapped
// timing bench pins 0 on purpose); refresh() re-reads the position at 1 Hz.
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

/** Off-screen: the window's top-left sits beyond -10000 px on either axis — no
 *  monitor reaches that far, so nobody can see it (an off-screen launch, or a
 *  minimized Windows window). No screenX / screenY (node, workers) = on-screen. */
export function windowOffscreen(win) {
  const x = Number(safe(() => win.screenX, 0));
  const y = Number(safe(() => win.screenY, 0));
  return (Number.isFinite(x) && x <= -10000) || (Number.isFinite(y) && y <= -10000);
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
  let everFocused = focused; // a window never focused runs uncapped (a CDP-attached bench reads focused: see the header)
  let offscreen = windowOffscreen(w); // off-screen = the background rate, focused or not (header, 2026-10-24)
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
    const fps = offscreen ? frameCapFor(policy, false) : everFocused ? frameCapFor(policy, focused) : 0;
    // Never capped by us: no policy means nothing to release.
    if (!policy && !(applied.fps > 0)) return;
    if (fps === applied.fps && setter === applied.setter) return;
    safe(() => setter(fps));
    applied = { fps, setter };
  }

  // Activity tracking (audio_manager.js _installActivityTracking).
  const recompute = () => {
    offscreen = windowOffscreen(w);
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
        offscreen,
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
