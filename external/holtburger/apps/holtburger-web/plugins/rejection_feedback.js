// rejection_feedback — Wave D / PR13 (2026-06-06): server-side
// inventory-action rejection UX. Wraps window.__sessionHandle's
// inventory methods to record a 2s-TTL ring of recent actions keyed by
// item GUID; subscribes to kind:13 UseFailed (WeenieError producer) on
// the plugin bus; when a WeenieError lands within the TTL window for an
// item we just acted on, synthesizes an INVENTORY_ACTION_FAILED event
// (semantic name 'inventoryActionFailed' + raw 'kind:48') so plugins
// can subscribe either way. The toast renderer + DOM flash run here.
//
// Also exposes window.__isBusy() — a derived boolean that
// radial-menu.js's Drop/Give/Split rows pre-emptively disable on. The
// busy sources are read live (NOT aggregated into a __busyState
// object): __combatBarState.armedSpellId (cast-windup) and
// window.__bootState (init/ready/in-world/error).
//
// Mouse events only. No wasm modifications. Side-effect import only —
// the inventory plugin pulls this in so the proxy installs at page
// init time.

import { weenieErrorMessage } from "./weenie_error_messages.js";

const STYLE_ID = "hb-rejection-feedback-style";
const RECENT_ACTION_TTL_MS = 2000;
const TOAST_AUTOREMOVE_MS = 2400;

// === Recent-action ring ====================================================
// Map<itemGuid:u32, {action:string, ts:number}>. TTL pruned lazily on
// every record() + lookup(). 2s window keyed on item GUID matches the
// human-perception window for action-to-failure association.
const _recent = new Map();

function _prune(now) {
  for (const [g, e] of _recent) {
    if (now - e.ts > RECENT_ACTION_TTL_MS) _recent.delete(g);
  }
}

function _recordAction(itemGuid, action) {
  const g = (itemGuid >>> 0);
  if (!g) return;
  const now = Date.now();
  _prune(now);
  _recent.set(g, { action, ts: now });
}

function _consumeAnyRecent() {
  // WeenieError doesn't carry an item GUID — it's a global
  // 'something failed' notification. So we attribute it to the
  // most-recently-recorded inventory action within the TTL window. If
  // there is no recent action, we drop the WeenieError on the floor
  // (not all WeenieErrors are inventory-related — e.g. cast / use).
  const now = Date.now();
  _prune(now);
  let best = null;
  let bestGuid = 0;
  for (const [g, e] of _recent) {
    if (!best || e.ts > best.ts) { best = e; bestGuid = g; }
  }
  if (!best) return null;
  _recent.delete(bestGuid);
  return { itemGuid: bestGuid, action: best.action };
}

// === Session-handle Proxy ==================================================
// Wraps the wasm handle so every inventory method records into the
// recent-action ring before delegating. The Proxy's `get` returns a
// bound wrapper for the tracked method set; everything else passes
// through untouched so existing call sites are unaffected.
const TRACKED_METHODS = new Map([
  ["setWielded", 0],          // arg0 = itemGuid
  ["unwieldToPack", 0],
  ["dropItem", 0],
  ["useObject", 0],
  ["moveItem", 0],
  ["putItemInContainer", 0],
  ["splitStackToWield", 0],
  ["splitStackToContainer", 0],
  ["splitStackTo3D", 0],
  ["mergeStacks", 0],
  ["giveObject", 1],           // arg1 = itemGuid (arg0 = target)
  ["sellToVendor", -1],        // multi-item; record each via Uint32Array
  ["addShortcut", 1],          // arg0 = slot, arg1 = itemGuid
  ["removeShortcut", -1],      // no item GUID — slot-only; skip ring
]);

function _wrapHandle(handle) {
  if (!handle || typeof handle !== "object") return handle;
  if (handle.__hbWrappedForRejection) return handle;
  // wasm-bindgen methods are non-enumerable function properties on the
  // exported object; a thin Proxy intercepts `get` and returns a bound
  // wrapper for tracked names. Untracked names fall through to the raw
  // method so the proxy contract is identical for non-instrumented
  // paths.
  const proxy = new Proxy(handle, {
    get(target, prop, receiver) {
      const raw = Reflect.get(target, prop, receiver);
      if (typeof raw !== "function") return raw;
      if (!TRACKED_METHODS.has(prop)) return raw;
      const idx = TRACKED_METHODS.get(prop);
      return function (...args) {
        try {
          if (prop === "sellToVendor") {
            // (vendorGuid, Uint32Array guids, Int32Array amounts)
            const guids = args[1];
            if (guids && typeof guids.length === "number") {
              for (let i = 0; i < guids.length; i++) _recordAction(guids[i] >>> 0, prop);
            }
          } else if (idx >= 0 && args.length > idx) {
            _recordAction(args[idx] >>> 0, prop);
          }
        } catch (_) { /* never block the wire send on instrumentation */ }
        return raw.apply(target, args);
      };
    },
  });
  try { Object.defineProperty(handle, "__hbWrappedForRejection", { value: true }); } catch (_) {}
  return proxy;
}

function _installProxy() {
  const h = window.__sessionHandle;
  if (!h) return false;
  if (h.__hbWrappedForRejection) return true;
  try { window.__sessionHandle = _wrapHandle(h); } catch (_) { return false; }
  return true;
}

// === isBusy mirror =========================================================
// Read sources LIVE (no aggregator object):
//   - cast windup: __combatBarState.armedSpellId !== 0
//   - bootState: anything other than 'in-world' or 'ready' is busy
function _isBusy() {
  try {
    const armed = (window.__combatBarState?.armedSpellId >>> 0) || 0;
    if (armed !== 0) return true;
  } catch (_) {}
  try {
    const bs = window.__bootState;
    if (bs && bs !== "in-world" && bs !== "ready") return true;
  } catch (_) {}
  return false;
}
window.__isBusy = _isBusy;

// === Toast + DOM flash =====================================================
function _ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes hb-server-rejected-flash {
      0%   { box-shadow: inset 0 0 0 2px rgba(220, 60, 60, 0.95); background-color: rgba(220, 60, 60, 0.18); }
      80%  { box-shadow: inset 0 0 0 2px rgba(220, 60, 60, 0.40); background-color: rgba(220, 60, 60, 0.06); }
      100% { box-shadow: none; background-color: transparent; }
    }
    .hb-server-rejected {
      animation: hb-server-rejected-flash 400ms ease-out 1;
    }
    .hb-rejection-toast {
      position: fixed;
      left: 50%;
      top: 64px;
      transform: translateX(-50%);
      background: rgba(20, 14, 8, 0.94);
      border: 1px solid #c46;
      color: #ffd0d0;
      padding: 6px 12px;
      font-family: var(--hb-font-serif, serif);
      font-size: 12px;
      z-index: 1000;
      pointer-events: none;
      max-width: 60%;
      text-align: center;
      letter-spacing: 0.02em;
      box-shadow: 0 1px 6px rgba(0,0,0,0.6);
    }
  `;
  document.head.appendChild(s);
}

function _flashSlotForGuid(itemGuid) {
  const g = String(itemGuid >>> 0);
  // Try every plausible DOM surface: items grid, paperdoll, hotbar,
  // container-panel, legacy <li>. data-guid + data-item-guid cover all
  // four current dragstart sources.
  const sels = [
    `[data-guid="${g}"]`,
    `[data-item-guid="${g}"]`,
  ];
  for (const sel of sels) {
    const nodes = document.querySelectorAll(sel);
    for (const n of nodes) {
      n.classList.add("hb-server-rejected");
      setTimeout(() => n.classList.remove("hb-server-rejected"), 420);
    }
  }
}

function _renderToast(message) {
  if (!message) return;
  _ensureStyles();
  const t = document.createElement("div");
  t.className = "hb-rejection-toast";
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), TOAST_AUTOREMOVE_MS);
}

// === Event wiring ==========================================================
// We consume kind:13 (UseFailed / WeenieError) on the plugin bus.
// When a WeenieError fires AND there's a recent recorded action within
// the 2s ring, synthesize 'inventoryActionFailed' + 'kind:48' so any
// plugin can subscribe either way. The toast + flash also fire here.
// Inventory-only WeenieError codes from weenie_error_messages.js — others
// (e.g. movement, casting, tells) are dropped on the floor so a cast
// failure 1s after an unrelated moveItem doesn't poison the toast path.
const INVENTORY_RELATED_CODES = new Set([
  0x001D, 0x001E, 0x0029, 0x0036, 0x003A, 0x0426, 0x0427, 0x0428,
  0x0453, 0x0468, 0x03EE, 0x03EF, 0x03F0, 0x03F3, 0x03F5, 0x04CE,
  0x0510, 0x0514, 0x0515, 0x054D, 0x058A, 0x0594,
]);

function _onWeenieError(evt) {
  // Plugin facade wraps the ClientEvent payload in CustomEvent.detail.
  // Mirror the existing consumer pattern (container-panel.js:460,
  // examine-target.js:986) so the code field reaches us populated.
  const payload = evt?.detail ?? evt ?? {};
  const code = (payload.u32Payload >>> 0) || 0;
  if (!INVENTORY_RELATED_CODES.has(code)) return;
  const recent = _consumeAnyRecent();
  if (!recent) return;
  const substitute = payload.stringPayload || (recent.action ? "that item" : "_");
  const message = weenieErrorMessage(code).replace(/_/g, substitute);
  _renderToast(message);
  _flashSlotForGuid(recent.itemGuid);
  try {
    const client = window.__pluginClient;
    if (client?.events?.emit) {
      const synthetic = {
        kind: 48,
        u32Payload: recent.itemGuid >>> 0,
        u32Payload2: code >>> 0,
        stringPayload: recent.action || "",
      };
      client.events.emit("inventoryActionFailed", synthetic);
      client.events.emit("kind:48", synthetic);
    }
  } catch (_) {}
}

function _attachSubscription() {
  try {
    const client = window.__pluginClient;
    if (!client?.events?.on) return false;
    client.events.on("kind:13", _onWeenieError);
    return true;
  } catch (_) { return false; }
}

// === Boot ==================================================================
// Side-effect install. Both the Proxy wrap AND the bus subscription
// depend on globals that may not exist yet at module-eval time; poll
// until they show, then stop.
let _initTimer = null;
function _tryInit() {
  const proxied = _installProxy();
  const subscribed = _attachSubscription();
  return proxied && subscribed;
}
if (!_tryInit()) {
  _initTimer = setInterval(() => {
    if (_tryInit()) { clearInterval(_initTimer); _initTimer = null; }
  }, 250);
}
_ensureStyles();
