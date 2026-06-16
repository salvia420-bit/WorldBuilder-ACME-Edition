// Loading-screen overlay — modal full-viewport curtain matching the
// retail gmGamePlayUI::LoadScreenLayout aesthetic (brass frame + stone
// background). Shown during zone-cross / portal-space transitions and
// available as a manual show/hide for initial-app-load wiring.
//
// Trigger surfaces (subscribed in mount()):
//   • client.events.on("portalSpaceEntered", …)   — start zone-cross
//   • client.events.on("landblockChanged",   …)   — landblock arrived
//                                                   (auto-hide on first
//                                                    one after a show)
//   • window event `hb:loading-screen-show` detail: { message?, progress? }
//   • window event `hb:loading-screen-hide`
//   • window event `hb:loading-screen-progress` detail: { value, message? }
//
// `portalSpaceEntered` is not yet wired on the JS bus (pass-1 rec #168,
// defer-wasm) — the plugin is forward-compatible: it subscribes
// defensively, so once the wasm side emits the event the overlay
// activates without any further JS work. landblockChanged IS wired
// today (api.js:54), so the auto-hide fires whether the show came
// from a future portalSpaceEntered or a manual host-side call.
//
// Programmatic API:
//   window.__showLoadingScreen({ message?, progress? })
//   window.__hideLoadingScreen()
//   window.__updateLoadingScreen({ value, message? })
//
// References:
//   - acclient.h:56498 gmGamePlayUI
//   - acclient_2013.bndb_pseudo_c.txt:238405 LoadScreenLayout signature
//   - plugins/api.js coverage table (landblockChanged is wired today;
//     portalSpaceEntered is pass-1 rec #168 → defer-wasm)

import { setAcText } from "../ui/ac_font.js";

const OVERLAY_ID = "hb-loading-screen";
const STYLE_ID = "hb-loading-screen-style";

const state = {
  overlayEl: null,
  msgEl: null,
  barFillEl: null,
  shownAt: 0,
  unsubPortal: null,
  unsubLandblock: null,
  hideAfterNextLb: false,
  client: null,
};

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 80;
      display: none;
      align-items: center;
      justify-content: center;
      pointer-events: auto;
      font-family: var(--hb-font-serif, serif);
      background:
        radial-gradient(ellipse at center, rgba(20, 14, 8, 0.92) 0%, rgba(8, 4, 2, 0.98) 70%);
      color: var(--hb-text-cream, #e8d8b0);
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; }
    #${OVERLAY_ID} .hb-ls-frame {
      min-width: 320px;
      max-width: 480px;
      padding: 24px 32px 22px 32px;
      border: 2px solid var(--hb-border-brass, #b08a4a);
      box-shadow:
        0 6px 24px rgba(0, 0, 0, 0.75),
        inset 0 0 24px rgba(0, 0, 0, 0.55);
      background:
        linear-gradient(180deg, rgba(38, 26, 14, 0.95) 0%, rgba(20, 14, 8, 0.95) 100%);
      text-align: center;
    }
    #${OVERLAY_ID} .hb-ls-title {
      font-size: 14px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--hb-text-gold, #d4af37);
      margin: 0 0 14px 0;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--hb-border-brass-dim, rgba(176, 138, 74, 0.4));
    }
    #${OVERLAY_ID} .hb-ls-msg {
      font-size: 12px;
      color: var(--hb-text-cream-bright, #f0e0b8);
      margin: 0 0 14px 0;
      min-height: 1.4em;
    }
    #${OVERLAY_ID} .hb-ls-bar {
      position: relative;
      height: 14px;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-deep, rgba(120, 90, 50, 0.6));
      overflow: hidden;
    }
    #${OVERLAY_ID} .hb-ls-bar-fill {
      position: absolute;
      inset: 0 auto 0 0;
      width: 0%;
      background:
        linear-gradient(180deg,
          var(--hb-text-gold, #d4af37) 0%,
          var(--hb-border-brass, #b08a4a) 100%);
      transition: width 220ms ease-out;
    }
    #${OVERLAY_ID}[data-indeterminate="1"] .hb-ls-bar-fill {
      width: 100%;
      animation: hb-ls-pulse 1500ms ease-in-out infinite;
      transition: none;
    }
    @keyframes hb-ls-pulse {
      0%   { opacity: 0.55; }
      50%  { opacity: 1.0;  }
      100% { opacity: 0.55; }
    }
    #${OVERLAY_ID} .hb-ls-hint {
      font-size: 10px;
      color: var(--hb-text-muted, #b0a080);
      margin-top: 12px;
      font-style: italic;
    }
  `;
  document.head.appendChild(s);
}

function ensureOverlay() {
  if (state.overlayEl) return state.overlayEl;
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Loading");
  overlay.setAttribute("data-open", "0");
  overlay.setAttribute("data-indeterminate", "1");

  const frame = document.createElement("div");
  frame.className = "hb-ls-frame";

  const title = document.createElement("div");
  title.className = "hb-ls-title";
  title.textContent = "Loading…";
  frame.appendChild(title);

  const msg = document.createElement("div");
  msg.className = "hb-ls-msg";
  frame.appendChild(msg);

  const bar = document.createElement("div");
  bar.className = "hb-ls-bar";
  const fill = document.createElement("div");
  fill.className = "hb-ls-bar-fill";
  bar.appendChild(fill);
  frame.appendChild(bar);

  const hint = document.createElement("div");
  hint.className = "hb-ls-hint";
  hint.textContent = "Please wait while the world streams in.";
  frame.appendChild(hint);

  overlay.appendChild(frame);
  document.body.appendChild(overlay);

  state.overlayEl = overlay;
  state.msgEl = msg;
  state.barFillEl = fill;
  return overlay;
}

export function show(opts) {
  const overlay = ensureOverlay();
  const message = opts?.message;
  const progress = opts?.progress;
  if (typeof message === "string") setAcText(state.msgEl, message);
  else setAcText(state.msgEl, "");
  if (typeof progress === "number" && Number.isFinite(progress)) {
    overlay.setAttribute("data-indeterminate", "0");
    state.barFillEl.style.width = `${Math.max(0, Math.min(100, progress * 100))}%`;
  } else {
    overlay.setAttribute("data-indeterminate", "1");
    state.barFillEl.style.width = "100%";
  }
  overlay.dataset.open = "1";
  state.shownAt = Date.now ? Date.now() : 0;
  state.hideAfterNextLb = true;
}

export function update(opts) {
  if (!state.overlayEl || state.overlayEl.dataset.open !== "1") return;
  if (typeof opts?.message === "string") setAcText(state.msgEl, opts.message);
  if (typeof opts?.value === "number" && Number.isFinite(opts.value)) {
    state.overlayEl.setAttribute("data-indeterminate", "0");
    state.barFillEl.style.width = `${Math.max(0, Math.min(100, opts.value * 100))}%`;
  }
}

export function hide() {
  const overlay = state.overlayEl;
  if (!overlay) return;
  if (overlay.dataset.open !== "1") return;
  overlay.dataset.open = "0";
  state.hideAfterNextLb = false;
  setAcText(state.msgEl, "");
  state.barFillEl.style.width = "0%";
}

export const manifest = {
  id: "loading-screen",
  name: "Loading Screen",
  icon: "⌛",
  iconHidden: true,
  version: "0.1.0",
  description: "Modal load-screen overlay for zone-cross / portal-storm transitions (gmGamePlayUI::LoadScreenLayout port).",
};

export function mount(ctx) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  ensureStyles();
  const client = ctx?.client ?? window.__pluginClient ?? null;
  state.client = client;

  // portalSpaceEntered is not on the JS bus today (pass-1 rec #168 →
  // defer-wasm). Subscribe defensively: once that event is wired this
  // plugin starts gating zone-cross transitions without further JS.
  let unsubPortal = null;
  let unsubLb = null;
  try {
    if (typeof client?.events?.on === "function") {
      unsubPortal = client.events.on("portalSpaceEntered", (detail) => {
        show({ message: detail?.zoneName ?? "Crossing portal space…" });
      });
      unsubLb = client.events.on("landblockChanged", () => {
        if (state.hideAfterNextLb) {
          // Tiny grace so the player sees the curtain even on instant
          // intra-LB walks. The transition matters more than the
          // total wall-time.
          setTimeout(() => hide(), 250);
        }
      });
    }
  } catch (e) {
    console.warn("[loading-screen] event subscribe failed:", e);
  }
  state.unsubPortal = unsubPortal;
  state.unsubLandblock = unsubLb;

  function onShowEvent(ev) {
    show(ev?.detail ?? {});
  }
  function onHideEvent() {
    hide();
  }
  function onProgressEvent(ev) {
    update(ev?.detail ?? {});
  }
  window.addEventListener("hb:loading-screen-show", onShowEvent);
  window.addEventListener("hb:loading-screen-hide", onHideEvent);
  window.addEventListener("hb:loading-screen-progress", onProgressEvent);

  return () => {
    window.removeEventListener("hb:loading-screen-show", onShowEvent);
    window.removeEventListener("hb:loading-screen-hide", onHideEvent);
    window.removeEventListener("hb:loading-screen-progress", onProgressEvent);
    try {
      if (typeof state.unsubPortal === "function") state.unsubPortal();
      else if (state.unsubPortal?.off) state.unsubPortal.off();
    } catch (_) {}
    try {
      if (typeof state.unsubLandblock === "function") state.unsubLandblock();
      else if (state.unsubLandblock?.off) state.unsubLandblock.off();
    } catch (_) {}
    state.unsubPortal = null;
    state.unsubLandblock = null;
    state.client = null;
  };
}

if (typeof window !== "undefined") {
  window.__showLoadingScreen = show;
  window.__hideLoadingScreen = hide;
  window.__updateLoadingScreen = update;
}
