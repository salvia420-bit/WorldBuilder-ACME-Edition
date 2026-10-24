// plugins/rynth-vt/display.js — the VTank profile's page-level display
// options (2026-10-19; former "Not on web" rows, made live with RynthAi's
// defaults — all ON):
//
//   EnableFPSLimit, TargetFPSFocused / TargetFPSBackground
//       → scene3d/frame_cap.js: the 3D frame rate, at the focused rate while
//         the game window has focus and the background rate while it does
//         not (window.__setFrameCap). A ?targetFps= URL flag wins (=0: pinned
//         uncapped), and an automation-driven page (navigator.webdriver —
//         headless / bench / verify Chrome) is never capped by them: then
//         these do nothing, and the console says so once.
//   ShowTerrainPassability
//       → scene3d/passability_overlay.js (lazy): ground too steep to walk up
//         tinted red around the player, with or without a route (the Route
//         tab's "Steep" switch).
//
// One controller per page (window.__rynthVtDisplay), installed by the
// RynthSuite HUD on mount (plugins/rynth-hud.js, after the page entry
// rs_entry.js), so it works with no bot and with the panel closed. The
// options are the bot layer's VtOptions, else the page session's
// (window.__rynthVt.session() — the vt_bridge.js optionsOf fallback),
// re-resolved at 1 Hz (login, another character, a bot rebind);
// options.onChange applies an edit, a profile switch or another tab's save at
// once. Without options (logged out) the cap this controller set is released
// and the tint hidden. Nothing here throws; every page global is guarded.

import { createFrameCapDriver } from "../../scene3d/frame_cap.js";

/** The option keys this controller follows. */
export const DISPLAY_KEYS = Object.freeze(["EnableFPSLimit", "TargetFPSFocused", "TargetFPSBackground", "ShowTerrainPassability"]);
// The schema defaults (rynth/vt/settings/schema.js), for a row that reads undefined.
// ShowTerrainPassability: default OFF since 2026-10-23 (owner), matching rynth/vt/settings/schema.js.
const DEFAULTS = Object.freeze({ EnableFPSLimit: true, TargetFPSFocused: 60, TargetFPSBackground: 30, ShowTerrainPassability: false });
const KEY_SET = new Set(DISPLAY_KEYS);
const POLL_MS = 1000;
const PASSABILITY_URL = new URL("../../scene3d/passability_overlay.js", import.meta.url).href;

const safe = (fn, dflt = null) => {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch {
    return dflt;
  }
};

/** The VtOptions this page's display follows: the bot layer's, else the page
 *  session's (vt_bridge.js optionsOf). null before a character is known. */
export function displayOptionsOf(win) {
  const vt = safe(() => win.__bot?.vt ?? null);
  return safe(() => vt?.options ?? null) || safe(() => win.__rynthVt?.session?.()?.options ?? null) || null;
}

/**
 * Install (once) and return the page's display controller.
 *
 * @param {object} [win] the page window (tests: a plain object)
 * @param {{ getOptions?: () => object|null, doc?: object,
 *           timers?: { setInterval: Function, clearInterval: Function },
 *           loadPassability?: () => Promise<object>, log?: (m: string) => void }} [opts]
 * @returns {{ refresh(): void, status(): object, dispose(): void, readonly disposed: boolean }}
 */
export function installVtDisplay(win = globalThis, opts = {}) {
  const w = win || globalThis;
  const o = opts && typeof opts === "object" ? opts : {};
  const prev = safe(() => w.__rynthVtDisplay, null);
  if (prev && prev.__vtDisplay === true && !prev.disposed) return prev;
  const timers = o.timers || {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
  };
  const getOptions = typeof o.getOptions === "function" ? () => safe(() => o.getOptions(), null) : () => displayOptionsOf(w);
  const loadPassability = typeof o.loadPassability === "function" ? o.loadPassability : () => import(PASSABILITY_URL);
  const log = typeof o.log === "function" ? o.log : (m) => {
    try {
      console.log(m);
    } catch {
      /* no console */
    }
  };

  let options = null;
  let unsub = null;
  let disposed = false;
  const steep = { want: false, shown: null, handle: null, loading: null, failed: false };

  const cap = createFrameCapDriver({
    win: w,
    doc: o.doc || null,
    onPinned: (fps, why) => log(`[rynth-vt] ${why === "automation" ? "an automation-driven page (navigator.webdriver)" : `?targetFps=${fps}${fps > 0 ? "" : " (uncapped)"}`} pins the frame rate on this page — the frame-rate limit (EnableFPSLimit, TargetFPSFocused / TargetFPSBackground) is not applied`),
  });

  const read = (key) => {
    const v = options ? safe(() => options.getValue(key)) : null;
    return v === null || v === undefined ? DEFAULTS[key] : v;
  };

  // ── the steep-ground tint ────────────────────────────────────────────────
  function applySteep() {
    if (disposed) return;
    const want = steep.want;
    if (!steep.handle) {
      if (!want || steep.loading || steep.failed) return;
      steep.loading = Promise.resolve()
        .then(loadPassability)
        .then((m) => {
          if (disposed) return;
          steep.handle = m.installPassabilityOverlay(w) || null;
          if (!steep.handle) steep.failed = true;
        })
        .catch((e) => {
          steep.failed = true; // no scene3d on this page (or it failed): no retry every poll
          safe(() => console.warn("[rynth-vt] steep-ground overlay unavailable:", e));
        })
        .finally(() => {
          steep.loading = null;
          if (steep.handle) applySteep();
        });
      return;
    }
    if (steep.shown === want) return;
    steep.shown = want;
    safe(() => steep.handle.setVisible(want));
  }

  // ── options → effects ────────────────────────────────────────────────────
  function apply() {
    if (disposed) return;
    if (!options) {
      cap.setPolicy(null);
      steep.want = false;
    } else {
      cap.setPolicy({
        enabled: read("EnableFPSLimit") === true,
        focusedFps: Number(read("TargetFPSFocused")),
        backgroundFps: Number(read("TargetFPSBackground")),
      });
      steep.want = read("ShowTerrainPassability") === true;
    }
    applySteep();
  }

  const onChange = (evt) => {
    if (!evt) return;
    if (evt.kind === "profile" || (evt.kind === "setting" && KEY_SET.has(evt.key))) apply();
  };

  /** Follow the current character's options (login, a character change, a
   *  bot rebind); re-subscribe when they changed. → true when they did. */
  function bind() {
    const next = getOptions() || null;
    if (next === options) return false;
    if (unsub) safe(() => unsub());
    unsub = null;
    options = next;
    if (options && typeof options.onChange === "function") {
      const off = safe(() => options.onChange(onChange), null);
      unsub = typeof off === "function" ? off : null;
    }
    apply();
    return true;
  }

  function poll() {
    if (disposed) return;
    try {
      if (!bind()) cap.refresh(); // the setter may have appeared with the scene
      if (steep.want && !steep.handle) applySteep();
    } catch (e) {
      safe(() => console.warn("[rynth-vt] display poll failed:", e));
    }
  }

  const timer = timers.setInterval(poll, POLL_MS);
  const handle = {
    __vtDisplay: true,
    get disposed() {
      return disposed;
    },
    /** Re-read the options and re-apply now. */
    refresh() {
      if (disposed) return;
      if (!bind()) apply();
      cap.refresh();
    },
    status() {
      return {
        options: !!options,
        cap: cap.status(),
        steep: {
          want: steep.want,
          loaded: !!steep.handle,
          failed: steep.failed,
          overlay: steep.handle ? safe(() => steep.handle.status(), null) : null,
        },
      };
    },
    /** Release the frame cap (back to bare rAF), drop the tint, unsubscribe. */
    dispose() {
      if (disposed) return;
      disposed = true;
      safe(() => timers.clearInterval(timer));
      if (unsub) safe(() => unsub());
      unsub = null;
      options = null;
      cap.dispose();
      if (steep.handle) safe(() => steep.handle.dispose());
      steep.handle = null;
      steep.shown = null;
      try {
        if (w.__rynthVtDisplay === handle) delete w.__rynthVtDisplay;
      } catch {
        w.__rynthVtDisplay = undefined;
      }
    },
  };
  try {
    w.__rynthVtDisplay = handle;
  } catch {
    /* a frozen window stand-in: the handle still works for this caller */
  }
  bind();
  return handle;
}

export default installVtDisplay;
