// commerce_window — shared kit-window plumbing for the commerce / crafting /
// reading windows: vendor-ui, trade-panel, salvage-panel, tinker-panel,
// book-panel, house-panel (HUD overhaul 2026-10-05).
//
// Before the overhaul each of those six files hand-rolled its own header,
// "X" button, drag code (or none), Esc listener and z-index, and five of
// them were display:none'd in every ?autoLogin=1 session by the old
// agent-mode allowlist — so nobody noticed that none of them could be moved,
// that two used `vw` units inside a zoomed root, and that the book panel's
// private `.hbk-*` classes collided with the new HUD kit. This module gives
// them one contract:
//
//   • createKitWindow() — a direct <body> child `#hb-…` (so ui/hud_scale.js
//     zooms it and agent-mode keeps it visible) with kit chrome
//     (`hbk-window`, `makeTitlebar`), dragged + persisted through
//     attachWindowPosition (zoom-aware, edge-anchored), sized against the
//     HUD-space viewport (`--hb-hud-vw/vh`, never raw vw/vh).
//   • A shared open-window stack: clicking a window raises it, and Esc
//     (the rebindable "Close Panel / Popover" local action) closes only the
//     TOPMOST one — or the one whose text field has focus. Retail closes
//     floaty windows one at a time the same way (each gm*UI owns its own
//     close; there is no "close everything" key).
//   • Small shared helpers: item icons into `.hbk-slot`s, in-window toasts,
//     inventory drop targets (the `application/x-hb-inv-guid` contract via
//     drop_item_flags.js), player-facing object names, world positions.

import { makeTitlebar } from "../ui/hud_kit.js";
import { attachWindowPosition } from "../ui/ac_window_position.js";
import { resolveLocalBinding, matchesBinding, LOCAL_ACTION_IDS } from "../ui/keymap.js";
import { setAcText } from "../ui/ac_font.js";
import { fetchIconDataUrl } from "../ui/ac_icon_cache.js";
import { isDropAccepted } from "./drop_item_flags.js";

// Retail-ish window ids for the persisted positions. Retail keys floaty
// placement by m_eWindowID; like ui/ac_window_position.js WINDOW_ID we use
// each gm*UI layout's ROOT element id (rendered manifests in
// /mnt/wbterminal2/hud-compare-2026-10-05/retail/m-XX.json), which is
// unique, stable and cannot collide with the synthetic 0xFFFF00xx range.
// Tinkering has no retail window (retail tinkering is item-on-item + a
// confirmation), so it takes a synthetic id well clear of the low
// 0xFFFF0001.. sequence.
export const COMMERCE_WINDOW_ID = Object.freeze({
  VENDOR:  0x100000B7, // gmVendorUI      RootVendor_Field      (layout 0x21000012)
  TRADE:   0x1000007A, // gmSecureTradeUI RootSecureTrade_Field (layout 0x2100000D)
  SALVAGE: 0x10000073, // gmSalvageUI     RootSalvage_Field     (layout 0x2100000C)
  BOOK:    0x1000010D, // gmBookUI        RootBook_Field        (layout 0x21000019)
  HOUSE:   0x100001E5, // gmHouseUI       RootHouse_Field       (layout 0x21000025)
  TINKER:  0xFFFF0020, // synthetic — no retail tinker window
});

// Kit palette for <ac-text> (canvas text can't read CSS vars).
export const KIT_COLOR = Object.freeze({
  gold: "#f3d27a",
  text: "#e8dfc8",
  dim: "#a8a090",
  faint: "#77705f",
  value: "#8aef6d",
  warn: "#ff6a50",
});

const STYLE_ID = "hb-commerce-window-style";
// z-band for these windows: above the docked HUD (main panel / chat /
// hotbar at 50, loot bar 66 sits inside the band) and below the confirm
// modals (salvage-confirm 70, modal-dialog 78/79) so a confirmation for an
// action in one of these windows always paints on top of it.
const Z_BASE = 62;
const Z_SPAN = 6;

export const COMMERCE_CSS = `
  .hb-cw {
    position: fixed;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    max-width: calc(100 * var(--hb-hud-vw, 1vw) - 8px);
    max-height: calc(100 * var(--hb-hud-vh, 1vh) - 8px);
    z-index: ${Z_BASE};
  }
  .hb-cw[data-open="0"] { display: none !important; }
  .hb-cw.hb-window-dragging { opacity: 0.92; }
  /* Whole-window drop target (vendor sell, trade offer). */
  .hb-cw.is-drop-target {
    box-shadow:
      0 0 0 1px var(--hbk-gold-bright),
      0 0 14px rgba(243, 210, 122, 0.45),
      0 10px 28px rgba(0, 0, 0, 0.7);
  }
  .hb-cw > .hbk-titlebar { flex: 0 0 25px; }
  .hb-cw-body {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* Item cell: 32×32 kit slot + an optional one-line caption (price). */
  .hb-cw-cell {
    display: flex; flex-direction: column; align-items: center;
    width: 38px; gap: 1px; cursor: pointer;
  }
  .hb-cw-cell > .hbk-slot { flex: 0 0 32px; }
  .hb-cw-cell:hover > .hbk-slot { box-shadow: 0 0 0 1px var(--hbk-gold-dim), inset 1px 1px 0 rgba(255,255,255,0.07); }
  .hb-cw-cell > .hb-cw-caption {
    height: 11px; max-width: 38px; overflow: hidden;
    font-size: 10px; line-height: 11px; color: var(--hbk-gold-bright);
    white-space: nowrap; text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .hb-cw-cell.is-unaffordable > .hb-cw-caption { color: var(--hbk-warn); }
  .hbk-slot > .hb-cw-glyph {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; color: var(--hbk-text-faint);
    pointer-events: none;
  }
  .hb-cw-grid {
    display: flex; flex-wrap: wrap; align-content: flex-start;
    gap: 3px 2px; padding: 3px;
  }
  .hb-cw-drop {
    position: relative;
    border: 1px solid #000;
    background: rgba(0, 0, 0, 0.35);
    box-shadow: inset 0 1px 3px #000;
    transition: box-shadow 120ms, background 120ms;
  }
  .hb-cw-drop.is-drop-target {
    background: rgba(243, 210, 122, 0.08);
    box-shadow: inset 0 0 0 1px var(--hbk-gold-bright), 0 0 8px rgba(243, 210, 122, 0.45);
  }
  .hb-cw-hint {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    padding: 6px 10px; text-align: center;
    color: var(--hbk-text-faint); font-style: italic; font-size: 11px;
    pointer-events: none;
  }
  .hb-cw-toast {
    position: absolute; left: 50%; top: 30px; z-index: 5;
    transform: translateX(-50%);
    max-width: 90%;
    padding: 3px 10px;
    background: url("./data/ui-sprites/0x06004CC2.png") repeat, #0b0c10;
    border: 1px solid var(--hbk-gold-dim);
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.8);
    color: var(--hbk-text); font-size: 11px; white-space: nowrap;
    pointer-events: none;
    animation: hb-cw-toast 2200ms ease-out forwards;
  }
  .hb-cw-toast.is-error { border-color: #a0402c; color: #ffd0c0; }
  @keyframes hb-cw-toast {
    0% { opacity: 0; transform: translate(-50%, 4px); }
    10% { opacity: 1; transform: translate(-50%, 0); }
    82% { opacity: 1; }
    100% { opacity: 0; }
  }
  .hb-cw-status {
    min-height: 16px; padding: 2px 8px;
    color: var(--hbk-text-dim); font-size: 11px;
  }
  .hb-cw .hbk-btn ac-text, .hb-cw .hbk-btn-small ac-text,
  .hb-cw .hbk-tab ac-text { pointer-events: none; }
  /* The kit has no ghosted state for the small sprite buttons. */
  .hb-cw .hbk-btn-small:disabled { filter: grayscale(0.7) brightness(0.55); cursor: default; }
  .hb-cw .hbk-btn-small[hidden], .hb-cw .hbk-btn[hidden] { display: none; }
`;

export function ensureCommerceStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = COMMERCE_CSS;
  document.head.appendChild(s);
}

// ─── Open-window stack (z-order + Esc closes topmost) ─────────────────

const _open = [];

function restack() {
  _open.forEach((w, i) => {
    try { w.root.style.zIndex = String(Z_BASE + Math.min(i, Z_SPAN)); } catch (_) {}
  });
}

function activate(win) {
  const i = _open.indexOf(win);
  if (i === _open.length - 1 && i >= 0) return;
  if (i >= 0) _open.splice(i, 1);
  _open.push(win);
  restack();
}

function release(win) {
  const i = _open.indexOf(win);
  if (i >= 0) _open.splice(i, 1);
  restack();
}

/** Topmost open window (exported for tests / diagnostics). */
export function topCommerceWindow() {
  return _open.length ? _open[_open.length - 1] : null;
}

function confirmModalOpen() {
  try {
    return !!document.querySelector(
      '#hb-modal-dialog[data-open="1"], #hb-salvage-confirm[data-open="1"]',
    );
  } catch (_) { return false; }
}

function isEditable(t) {
  if (!t || typeof t !== "object") return false;
  if (t.isContentEditable) return true;
  const tag = String(t.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function onGlobalKeyDown(ev) {
  if (ev.defaultPrevented || _open.length === 0) return;
  let binding = null;
  try { binding = resolveLocalBinding(LOCAL_ACTION_IDS.CLOSE, "Escape"); } catch (_) {}
  const isClose = binding ? matchesBinding(ev, binding) : ev.key === "Escape";
  if (!isClose) return;
  if (confirmModalOpen()) return; // the modal owns Esc while it's up
  const t = ev.target;
  let target = topCommerceWindow();
  if (isEditable(t)) {
    // Typing in one of our windows → that window handles the Esc. Typing
    // anywhere else (chat entry) → not ours.
    const owner = _open.find((w) => w.root.contains(t));
    if (!owner) return;
    target = owner;
  }
  if (!target) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (typeof target.onEscape === "function") {
    try { if (target.onEscape(ev) === true) return; } catch (_) {}
  }
  target.requestClose("escape");
}

let _escBound = false;
function bindEscOnce() {
  if (_escBound || typeof document === "undefined") return;
  _escBound = true;
  document.addEventListener("keydown", onGlobalKeyDown);
}

/**
 * Build a kit floaty window.
 *
 * @param {object} o
 * @param {string} o.id            — DOM id, must start `hb-`.
 * @param {string} o.title         — title text (retail bitmap font).
 * @param {number} o.windowId      — persisted-position key.
 * @param {object} o.defaultPos    — {left,top,right,bottom} CSS strings.
 * @param {string} [o.className]   — extra classes on the root.
 * @param {boolean} [o.kitChrome=true] — false = caller paints its own
 *   frame (book parchment) and supplies `o.titlebar`.
 * @param {{bar:HTMLElement,title:HTMLElement,close:HTMLElement}} [o.titlebar]
 * @param {(reason:string)=>void} [o.onRequestClose] — close button / Esc.
 *   Default: hide the window. Trade routes this to the server.
 * @param {(ev:KeyboardEvent)=>boolean} [o.onEscape] — return true to
 *   consume Esc (e.g. cancel an in-progress edit) instead of closing.
 * @param {()=>void} [o.onHide]   — after the window is hidden.
 */
export function createKitWindow(o) {
  ensureCommerceStyles();
  bindEscOnce();
  const root = document.createElement("div");
  root.id = o.id;
  root.className = ["hb-cw", o.kitChrome === false ? "" : "hbk-window", o.className || ""]
    .filter(Boolean).join(" ");
  root.dataset.open = "0";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", o.title || "");
  root.tabIndex = -1;

  const win = {
    root,
    bar: null,
    titleEl: null,
    closeBtn: null,
    body: null,
    position: null,
    onEscape: o.onEscape,
    isOpen: () => root.dataset.open === "1",
    open() {
      if (root.dataset.open !== "1") root.dataset.open = "1";
      activate(win);
    },
    close() {
      if (root.dataset.open === "0" && !_open.includes(win)) return;
      root.dataset.open = "0";
      release(win);
      if (typeof o.onHide === "function") { try { o.onHide(); } catch (_) {} }
    },
    requestClose(reason = "button") {
      if (typeof o.onRequestClose === "function") o.onRequestClose(reason);
      else win.close();
    },
    setTitle(text) {
      root.setAttribute("aria-label", String(text ?? ""));
      if (win.titleEl) setAcText(win.titleEl, String(text ?? ""), { color: KIT_COLOR.gold, fit: true });
    },
    toast(text, kind = "ok") { showToast(root, text, kind); },
  };

  let tb = o.titlebar;
  if (!tb) tb = makeTitlebar("", { onClose: () => win.requestClose("button") });
  win.bar = tb.bar;
  win.titleEl = tb.title;
  win.closeBtn = tb.close;
  if (win.closeBtn) win.closeBtn.title = "Close (Esc)";
  root.appendChild(win.bar);
  const body = document.createElement("div");
  body.className = "hb-cw-body";
  root.appendChild(body);
  win.body = body;
  win.setTitle(o.title || "");

  document.body.appendChild(root);
  // Raise on any interaction (capture so it runs before child handlers).
  root.addEventListener("pointerdown", () => { if (win.isOpen()) activate(win); }, true);

  try {
    win.position = attachWindowPosition(root, {
      windowId: o.windowId,
      dragHandle: win.bar,
      ignoreSelector: "button, input, select, textarea, a",
      defaultPos: o.defaultPos,
    });
  } catch (e) {
    console.warn(`[${o.id}] attachWindowPosition failed:`, e);
  }
  return win;
}

// ─── Small shared helpers ─────────────────────────────────────────────

export function showToast(root, text, kind = "ok") {
  if (!root || typeof document === "undefined") return;
  const old = root.querySelector(":scope > .hb-cw-toast");
  if (old) old.remove();
  const t = document.createElement("div");
  t.className = "hb-cw-toast" + (kind === "err" ? " is-error" : "");
  t.textContent = String(text ?? "");
  root.appendChild(t);
  setTimeout(() => { try { t.remove(); } catch (_) {} }, 2300);
}

export function getHandle() {
  if (typeof window === "undefined") return null;
  return window.__sessionHandle ?? window.__pluginClient?._handle ?? null;
}

/** One playerInventory() snapshot as plain rows (wasm boxes copied). */
export function inventoryRows() {
  const h = getHandle();
  let inv = [];
  try { inv = h?.playerInventory?.() || []; } catch (_) { inv = []; }
  const out = [];
  for (const i of inv) {
    try {
      out.push({
        guid: i.guid >>> 0, wcid: i.wcid >>> 0, name: i.name || "",
        value: i.value ?? 0, stackSize: i.stackSize ?? 1,
        itemType: i.itemType >>> 0, iconId: i.iconId >>> 0,
        equipMask: i.equipMask >>> 0, containerId: i.containerId >>> 0,
        // vendor-buy-1: the pack-slot class for the room check.
        ...(typeof i.requiresBackpackSlot === "boolean" ? { requiresBackpackSlot: i.requiresBackpackSlot } : {}),
      });
    } catch (_) {}
    try { i.free?.(); } catch (_) {}
  }
  return out;
}

export function findInventoryItem(guid) {
  const g = guid >>> 0;
  if (!g) return null;
  return inventoryRows().find((r) => r.guid === g) || null;
}

/** Player-facing name for any tracked object; never a hex id. */
export function objectDisplayName(guid, fallback = "Unknown item") {
  const g = guid >>> 0;
  if (!g) return fallback;
  const h = getHandle();
  try {
    const n = h?.objectName?.(g);
    if (typeof n === "string" && n.trim()) return n.trim();
  } catch (_) {}
  const inv = findInventoryItem(g);
  if (inv?.name) return inv.name;
  return fallback;
}

export function objectIconId(guid) {
  const g = guid >>> 0;
  if (!g) return 0;
  const h = getHandle();
  try {
    const id = h?.getObjectIconId?.(g) >>> 0;
    if (id) return id;
  } catch (_) {}
  return findInventoryItem(g)?.iconId >>> 0 || 0;
}

/** Hex id for dev tooltips only. */
export function devHex(guid) {
  return `0x${((guid >>> 0) || 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/**
 * Paint an item icon into a `.hbk-slot`. A faint initial shows until (or
 * instead of, when the DAT has no icon) the icon resolves; no emoji.
 */
export function fillSlotIcon(slot, iconId, name) {
  if (!slot) return;
  slot.replaceChildren();
  const glyph = document.createElement("span");
  glyph.className = "hb-cw-glyph";
  glyph.textContent = String(name || "?").trim().charAt(0).toUpperCase() || "?";
  slot.appendChild(glyph);
  const id = iconId >>> 0;
  if (!id) return;
  fetchIconDataUrl(id, "commerce-window").then((url) => {
    if (!url || !slot.isConnected) return;
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.draggable = false;
    glyph.remove();
    slot.prepend(img);
  }).catch(() => {});
}

/** guid carried by an inventory drag (dual-mime, see drop_item_flags.js). */
export function draggedGuid(dt) {
  const s = dt?.getData?.("application/x-hb-inv-guid") || dt?.getData?.("text/x-hb-item-guid") || "";
  const g = parseInt(s, 10) >>> 0;
  return g || 0;
}

/**
 * Wire an element as an inventory drop target. Adds `.is-drop-target`
 * while an acceptable drag hovers (depth-counted so child elements don't
 * flicker it), calls `onDropGuid(guid, ev)` on drop.
 */
export function wireDropTarget(el, flags, onDropGuid, opts = {}) {
  if (!el) return;
  let depth = 0;
  const accepts = (ev) => isDropAccepted(ev.dataTransfer?.types, flags)
    && (typeof opts.enabled !== "function" || opts.enabled());
  el.addEventListener("dragenter", (ev) => {
    if (!accepts(ev)) return;
    ev.preventDefault();
    depth += 1;
    el.classList.add("is-drop-target");
  });
  el.addEventListener("dragover", (ev) => {
    if (!accepts(ev)) return;
    ev.preventDefault();
    // Sources set effectAllowed='move'; a mismatched dropEffect cancels
    // the drop (WHATWG DnD), so always answer "move".
    try { ev.dataTransfer.dropEffect = "move"; } catch (_) {}
  });
  el.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) el.classList.remove("is-drop-target");
  });
  el.addEventListener("drop", (ev) => {
    depth = 0;
    el.classList.remove("is-drop-target");
    // Nested targets (a well inside a window that is itself a target):
    // the innermost handles the drop, the outer ones only clear their
    // highlight — so the event keeps bubbling instead of being stopped.
    if (ev.__hbCwDropHandled) return;
    if (!accepts(ev)) return;
    const g = draggedGuid(ev.dataTransfer);
    if (!g) return;
    ev.preventDefault();
    ev.__hbCwDropHandled = true;
    onDropGuid(g, ev);
  });
}

/** World-frame position of an entity in the live scene, or null. */
export function entityWorldPos(guid) {
  try {
    const em = window.liveScene3d?.entityManager;
    const inst = em?.entityMap?.get?.(guid >>> 0) ?? em?.entityMap?.get?.(String(guid >>> 0));
    const p = inst?.root?.position;
    return p && p.x != null && p.y != null ? p : null;
  } catch (_) { return null; }
}

/** World-frame position of the local player entity (same frame as
 *  entityWorldPos — getLocalPlayerPose() is landblock-local, B4 fix). */
export function localPlayerWorldPos() {
  try {
    const g = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
    return g ? entityWorldPos(g) : null;
  } catch (_) { return null; }
}

export function selectedTargetGuid() {
  try {
    return (window.liveScene3d?.entityManager?.getSelectedTarget?.() ?? 0) >>> 0;
  } catch (_) { return 0; }
}

/** Echo a retail notice into the chat log (retail routes these through
 *  ECM_UI::SendNotice_DisplayStringInfo to the chat window). */
export function chatNotice(text) {
  try { window.__appendChatLine?.(String(text ?? "")); } catch (_) {}
}

/** Kit button with an <ac-text> label. */
export function kitButton(label, cls = "hbk-btn", onClick = null, color = KIT_COLOR.text) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  setAcText(b, label, { color });
  if (onClick) b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(ev); });
  return b;
}
