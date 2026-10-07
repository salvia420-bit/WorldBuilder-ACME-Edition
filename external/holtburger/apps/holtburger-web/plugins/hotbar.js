// Hotbar — the ONE retail toolbar: gmFloatyToolbarUI (layout 0x21000070)
// framing gmToolbarUI (layout 0x21000016).
//
// HUD overhaul 2026-10-05 — unified toolbar. Before this, the toolbar was
// split across two independently positioned plugins: this file drew a
// 310×132 frame with TWO 9-slot rows at bottom:8px, and target-bar.js drew
// the stance / panel buttons / Use-Target-Examine / Pack band as a second
// overlay at bottom:46px with z-index 49 — 36 px out of line and BEHIND
// this frame's background, so the panel buttons and the pack read as a
// blurry strip ("there are seemingly two hotbars"). Retail has one window:
//
//   gmFloatyToolbarUI root 0x10000602  310×100, 8-piece 5-px frame
//     ToolbarField 0x1000001B at (5,5) — the gmToolbarUI content:
//       y=0..58   combat-mode button, 6 panel buttons, Use | Selected
//                 Object | Examine, Inventory backpack   (target-bar.js)
//       y=58..90  ShortcutBar: 6-px spacer, 9 × 32-px slots, 6-px spacer
//       y=90..122 ShortcutBar2 — CLIPPED by the 100-px default height;
//                 retail reveals it only when the player resizes the
//                 floaty (gmFloatyToolbarUI::ResizeTo persists W/H via
//                 PlayerModule::SetChatWindowOption 0x10000088/89).
//
// So the default is now retail's 310×100 with ONE shortcut row; the
// second row is strictly opt-in (drag the bottom edge down / double-click
// it, or `window.__hotbar.setRowCount(2)`), persisted per browser. This
// file owns the single draggable #hb-hotbar root (attachWindowPosition,
// WINDOW_ID.HOTBAR) and mounts target-bar.js's controls into the same
// ToolbarField, so everything moves together.
//
// Shortcut behaviour (unchanged from Wave 3.A 2026-05-28):
//   - Drag a spell (application/x-hb-spell-id) or an item
//     (application/x-hb-inv-guid) onto a slot to bind it; drag slot↔slot
//     to swap (application/x-hb-hotbar-slot). Server-persisted via
//     AddShortcut/RemoveShortcut, cached in localStorage.
//   - Click a bound slot or press 1-9 to fire it (decideFireAction):
//       * item                    → useObject
//       * self-targeted spell     → cast on self
//       * targeted spell + target → cast on the selected entity
//       * targeted spell, none    → chat hint, no packet
//   - In Magic mode the digits belong to the spell bar (retail per-mode
//     input map) and the slot numbers are drawn ghosted
//     (gmToolbarUI::RecvNotice_SetCombatMode → SetShortcutNum _ghosted).
// Retail click→fire chain: gmToolbarUI::UseShortcut(slot, i_bUse)
// (acclient.c) — armed-spell + selected-target vs ItemHolder::UseObject.

import {
  resolveLocalBinding,
  matchesBinding,
  formatBinding,
  LOCAL_ACTION_IDS,
} from "../ui/keymap.js";
import { getInputFunnel, inputFunnelV2On } from "../ui/input-funnel.js";
import { attachWindowPosition, WINDOW_ID } from "../ui/ac_window_position.js";
import { hudRect, hudViewport, toHudPx } from "../ui/hud_scale.js";
import { resolveBindingIcon } from "../ui/ac_entity_icon.js";
import { fetchIconDataUrl as fetchIconDataUrlShared } from "../ui/ac_icon_cache.js";
import {
  uiEffectBadgesEnabled,
  uiEffectIconsFor,
  uiEffectTintCss,
} from "../scene3d/vfx/ui_effects_registry.js";
import { DropItemFlags, isDropAccepted } from "./drop_item_flags.js";
import { canBindToHotbar } from "./inventory_helpers.js";
import { castSpellViaHandle } from "../ui/ac_cast_spell.js";
import { mountToolbarControls, lookupObjectName, formatTipLabel } from "./target-bar.js";

const OVERLAY_ID = "hb-hotbar";
const TIP_ID = "hb-toolbar-tip";
const SP = "./data/ui-sprites";

// gmFloatyToolbarUI 0x21000070: root 0x10000602 is 310×100; the 5-px frame
// pieces 0x1000062B-32 (unlocked) / 0x10000623-2A (locked) wrap the
// ToolbarField 0x1000001B at (5,5). (data/retail-layouts/0x21000070.json)
const WIDTH = 310;
const FRAME = 5;
// gmToolbarUI 0x21000016 (data/retail-layouts/0x21000016.json): the top
// band is 58 px; ShortcutBar slots 0x100001A7-AF sit at y=58, x=6+32·i,
// 32×32; ShortcutBar2 slots 0x100006B7-BF at y=90.
const TOP_BAND = 58;
const SLOT_SIZE = 32;
const SLOT_X0 = 6;
const SLOTS_PER_ROW = 9;
const ROW_COUNT = 2;                 // slots that exist / persist (server indices 0..17)
const SLOT_COUNT = SLOTS_PER_ROW * ROW_COUNT;

const LS_KEY = "holtburger_hotbar_v1";
const LS_ROWS_KEY = "hb.hotbar.rows.v1";
// One-time reset of the saved toolbar position (HUD overhaul 2026-10-05):
// saves made before unification measured a 132-px frame centred with a
// CSS translateX(-50%) that attachWindowPosition never cleared, so the
// stored x is 155 px off from what the player saw.
const LS_UNIFIED_FLAG = "hb.hotbar.unified.v1";

// Retail frame sprites (element-sprites.txt layout 70) — CSS chrome means
// the frame is correct from the first paint, with no wasm layout fetch.
const FRAME_UNLOCKED = { c: "0x06006129", t: "0x0600612A", l: "0x0600612B", b: "0x0600612C", r: "0x0600612D" };
const FRAME_LOCKED = {
  tl: "0x060074C3", t: "0x060074BF", tr: "0x060074C4", l: "0x060074C0",
  bl: "0x060074C5", b: "0x060074C1", br: "0x060074C6", r: "0x060074C2",
};
const url = (id) => `url("${SP}/${id}.png")`;

// ── Pure helpers (unit-tested in test_toolbar_unified.mjs) ───────────

/** Clamp a persisted / requested row count to 1 or 2. Anything but 2 is 1. */
export function normalizeRowCount(v) {
  return Number(v) === 2 ? 2 : 1;
}

/** Floaty height for N visible shortcut rows: 5 + 58 + 32·N + 5 — 100 for
 *  one row (= the DAT root's 310×100), 132 for two. */
export function toolbarHeightForRows(rows) {
  return FRAME + TOP_BAND + SLOT_SIZE * normalizeRowCount(rows) + FRAME;
}

/** Retail slot origin inside the ToolbarField for flat index i. */
export function slotRect(i) {
  const row = Math.floor(i / SLOTS_PER_ROW);
  const col = i % SLOTS_PER_ROW;
  return { x: SLOT_X0 + col * SLOT_SIZE, y: TOP_BAND + row * SLOT_SIZE, w: SLOT_SIZE, h: SLOT_SIZE, row, col };
}

/** Bottom-edge grip drag → new row count. Half a row (16 HUD px) of
 *  travel commits; down reveals ShortcutBar2, up hides it. */
export function rowsAfterGripDrag(rows, dyHud) {
  const r = normalizeRowCount(rows);
  if (dyHud >= SLOT_SIZE / 2) return 2;
  if (dyHud <= -SLOT_SIZE / 2) return 1;
  return r;
}

/** `isSelfTargeted` from a getSpellRecord() result. serde-wasm-bindgen
 *  hands back a JS **Map** (spellbook.js spellRecordFromWasm, 2026-07-01),
 *  so the old `rec.isSelfTargeted` read was always undefined and every
 *  hotbar spell defaulted to a self-cast — a bound war bolt went out
 *  untargeted. Returns null when the record doesn't say. */
export function spellIsSelfTargeted(rec) {
  if (!rec) return null;
  const top = (rec instanceof Map) ? rec.get("isSelfTargeted") : rec.isSelfTargeted;
  if (typeof top === "boolean") return top;
  const flags = (rec instanceof Map) ? rec.get("flags") : rec.flags;
  const f = (flags instanceof Map) ? flags.get("selfTargeted") : flags?.selfTargeted;
  return typeof f === "boolean" ? f : null;
}

/** Spell display name from a getSpellRecord() result (Map or object). */
function spellRecordName(rec) {
  if (!rec) return null;
  const n = (rec instanceof Map) ? rec.get("name") : rec.name;
  return typeof n === "string" && n ? n : null;
}

// Pure decision helper — given a slot binding + spell metadata + soft-
// target GUID, return the fire-action descriptor the caller should
// dispatch. Factored out of fireSlot() so the test suite can exercise
// the spell-vs-item branching without booting wasm / DOM.
//
// Returns one of:
//   { kind: "none" }
//   { kind: "useItem",         itemGuid }
//   { kind: "castSelf",        spellId }
//   { kind: "castOnTarget",    spellId, targetGuid }
//   { kind: "needTarget",      spellId }      // armed but no selection
//
// `isSelfTargeted` is the spell's per-record flag (spellIsSelfTargeted()).
// When the spell table hasn't loaded yet, pass `true` so the cast
// defaults to self — matches the JSON-catalog default in
// plugins/spellbook.js:165.
export function decideFireAction(bound, { isSelfTargeted, softTargetGuid }) {
  if (!bound) return { kind: "none" };
  if (bound.itemGuid) {
    return { kind: "useItem", itemGuid: (bound.itemGuid >>> 0) };
  }
  if (bound.spellId) {
    if (isSelfTargeted) {
      return { kind: "castSelf", spellId: bound.spellId };
    }
    const g = (softTargetGuid ?? 0) >>> 0;
    if (g === 0) {
      return { kind: "needTarget", spellId: bound.spellId };
    }
    return { kind: "castOnTarget", spellId: bound.spellId, targetGuid: g };
  }
  return { kind: "none" };
}

export const manifest = {
  id: "hotbar",
  name: "Hotbar",
  icon: "1",
  iconHidden: true,
  version: "0.2.0",
  description: "Unified retail toolbar (gmFloatyToolbarUI 0x21000070 + gmToolbarUI 0x21000016): combat mode, panel buttons, selected object, backpack and the 1-9 shortcut row",
};

// ── Styles ───────────────────────────────────────────────────────────
let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-hotbar-style";
  const L = FRAME_LOCKED;
  const U = FRAME_UNLOCKED;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      /* Centred without transform: attachWindowPosition writes left/top
         (or right/bottom) on drag and never clears a translateX(-50%),
         which made the old hotbar jump half its width on first drag.
         left:50% resolves in HUD space under the zoom, so this centres. */
      left: calc(50% - ${WIDTH / 2}px);
      bottom: 8px;
      z-index: 50;
      width: ${WIDTH}px;
      height: ${toolbarHeightForRows(1)}px;
      box-sizing: border-box;
      background: url("${SP}/0x06004CC2.png") repeat, #0b0c10;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.6);
      font-family: var(--hbk-font, var(--hb-font-serif));
      user-select: none;
      touch-action: none;
      pointer-events: auto;
    }
    #${OVERLAY_ID}.hb-hotbar-rows-2 { height: ${toolbarHeightForRows(2)}px; }
    /* Retail 8-piece frame (gmFloatyToolbarUI 0x1000062B-32 / locked
       0x10000623-2A). Drawn over the field so the backpack's 1-px
       overhang (238 + 63 = 301 > 300) tucks under the right border, as
       in retail. */
    #${OVERLAY_ID}::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 4;
      pointer-events: none;
      background:
        url("${SP}/${U.c}.png") left top / ${FRAME}px ${FRAME}px no-repeat,
        url("${SP}/${U.c}.png") right top / ${FRAME}px ${FRAME}px no-repeat,
        url("${SP}/${U.c}.png") left bottom / ${FRAME}px ${FRAME}px no-repeat,
        url("${SP}/${U.c}.png") right bottom / ${FRAME}px ${FRAME}px no-repeat,
        url("${SP}/${U.t}.png") left top / 100% ${FRAME}px no-repeat,
        url("${SP}/${U.b}.png") left bottom / 100% ${FRAME}px no-repeat,
        url("${SP}/${U.l}.png") left top / ${FRAME}px 100% no-repeat,
        url("${SP}/${U.r}.png") right top / ${FRAME}px 100% no-repeat;
    }
    #${OVERLAY_ID}.is-locked::after {
      background:
        url("${SP}/${L.tl}.png") left top / ${FRAME}px ${FRAME}px no-repeat,
        url("${SP}/${L.tr}.png") right top / ${FRAME}px ${FRAME}px no-repeat,
        url("${SP}/${L.bl}.png") left bottom / ${FRAME}px ${FRAME}px no-repeat,
        url("${SP}/${L.br}.png") right bottom / ${FRAME}px ${FRAME}px no-repeat,
        url("${SP}/${L.t}.png") left top / 100% ${FRAME}px no-repeat,
        url("${SP}/${L.b}.png") left bottom / 100% ${FRAME}px no-repeat,
        url("${SP}/${L.l}.png") left top / ${FRAME}px 100% no-repeat,
        url("${SP}/${L.r}.png") right top / ${FRAME}px 100% no-repeat;
    }
    /* Retail frame cursors (0x21000070 Cursor media): top/side borders
       carry the 4-way move cursor 0x06006119, the bottom border the
       vertical resize cursor 0x06005E66 (= the ShortcutBar2 grip). */
    #${OVERLAY_ID}:not(.is-locked) { cursor: url("${SP}/0x06006119.png") 16 16, move; }
    #${OVERLAY_ID}.hb-window-dragging { cursor: grabbing; }
    /* ToolbarField 0x1000001B — gmToolbarUI's origin. */
    #${OVERLAY_ID} .hb-hotbar-field {
      position: absolute;
      left: ${FRAME}px;
      top: ${FRAME}px;
      width: ${WIDTH - 2 * FRAME}px;
      bottom: ${FRAME}px;
      z-index: 2;
    }
    #${OVERLAY_ID}.hb-hotbar-rows-1 .hb-hotbar-slot[data-row="1"] { display: none; }
    #${OVERLAY_ID} .hb-hotbar-slot {
      position: absolute;
      width: ${SLOT_SIZE}px;
      height: ${SLOT_SIZE}px;
      background: url("./sprites/acsprites/icon-slot-bg.png") center/100% 100% no-repeat;
      cursor: pointer;
      user-select: none;
      image-rendering: pixelated;
      outline: none;
    }
    #${OVERLAY_ID} .hb-hotbar-slot:hover { filter: brightness(1.2); }
    #${OVERLAY_ID} .hb-hotbar-slot:focus-visible {
      box-shadow: inset 0 0 0 1px var(--hbk-gold-bright, #f3d27a);
    }
    #${OVERLAY_ID} .hb-hotbar-slot.drag-over {
      filter: drop-shadow(0 0 4px rgba(243, 210, 122, 0.95));
      box-shadow: inset 0 0 0 1px var(--hbk-gold-bright, #f3d27a);
    }
    #${OVERLAY_ID} .hb-hotbar-slot.drag-reject {
      box-shadow: inset 0 0 0 1px rgba(214, 96, 96, 0.95);
    }
    #${OVERLAY_ID} .hb-hotbar-slot-icon {
      position: absolute;
      top: 1px; left: 1px; right: 1px; bottom: 1px;
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
      opacity: 0;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-hotbar-slot.bound .hb-hotbar-slot-icon { opacity: 1; }
    /* Shortcut number, bottom-right (retail draws 1..9 on the slot). */
    #${OVERLAY_ID} .hb-hotbar-slot-num {
      position: absolute;
      bottom: 0;
      right: 2px;
      line-height: 1;
      pointer-events: none;
      transition: opacity 120ms ease;
    }
    /* gmToolbarUI::RecvNotice_SetCombatMode: numbers ghost in Magic mode
       (the digits drive the spell bar there). */
    #${OVERLAY_ID}.hb-toolbar-magic .hb-hotbar-slot-num { opacity: 0.35; }

    /* Wave C / PR10 (2026-06-06): click-feedback pulse + radial cooldown. */
    #${OVERLAY_ID} .hb-hotbar-slot.firing {
      transform: scale(1.1); filter: brightness(1.4);
      transition: transform 50ms ease-out, filter 50ms ease-out;
    }
    #${OVERLAY_ID} .hb-hotbar-slot:not(.firing) {
      transition: transform 90ms ease-out, filter 90ms ease-out;
    }
    /* Rec #75 — compensating-transaction failure flash. */
    #${OVERLAY_ID} .hb-hotbar-slot.hb-hotbar-swap-fail {
      outline: 2px solid rgba(214, 96, 96, 0.95);
      outline-offset: -2px;
      animation: hb-hotbar-swap-fail-flash 400ms ease-out;
    }
    @keyframes hb-hotbar-swap-fail-flash {
      0%   { background-color: rgba(214, 96, 96, 0.55); }
      100% { background-color: rgba(214, 96, 96, 0.0); }
    }
    #${OVERLAY_ID} .hb-hotbar-slot.cooldown-active::after {
      content: ""; position: absolute; inset: 0; pointer-events: none;
      background: rgba(0,0,0,0.55);
      clip-path: polygon(50% 0, 100% 0, 100% 100%, 0 100%, 0 0, 50% 0);
      animation: hb-hotbar-cd 2500ms linear forwards;
    }
    @keyframes hb-hotbar-cd {
      0%   { clip-path: polygon(50% 50%, 50% 0, 100% 0, 100% 100%, 0 100%, 0 0, 50% 0); }
      25%  { clip-path: polygon(50% 50%, 100% 50%, 100% 100%, 0 100%, 0 0, 50% 0); }
      50%  { clip-path: polygon(50% 50%, 50% 100%, 0 100%, 0 0, 50% 0); }
      75%  { clip-path: polygon(50% 50%, 0 50%, 0 0, 50% 0); }
      100% { clip-path: polygon(50% 50%, 50% 0); }
    }

    /* Bottom-edge grip — retail resizes the floaty to reveal ShortcutBar2. */
    #${OVERLAY_ID} .hb-hotbar-grip {
      position: absolute;
      left: ${FRAME}px; right: ${FRAME}px; bottom: 0;
      height: ${FRAME}px;
      z-index: 5;
      cursor: url("${SP}/0x06005E66.png") 16 16, ns-resize;
    }
    #${OVERLAY_ID} .hb-hotbar-grip:hover {
      background: linear-gradient(180deg, transparent 1px, rgba(243, 210, 122, 0.6) 1px, rgba(243, 210, 122, 0.6) 3px, transparent 3px);
    }
    #${OVERLAY_ID}.is-locked .hb-hotbar-grip { display: none; }

    #${OVERLAY_ID} .hb-hotbar-toast {
      position: absolute; left: 50%; bottom: calc(100% + 4px);
      transform: translateX(-50%);
      padding: 3px 8px; font-size: 11px; white-space: nowrap;
      background: rgba(20, 14, 8, 0.92);
      border: 1px solid var(--hbk-gold-dim, #8a7544);
      color: var(--hbk-warn, #ff6a50);
      pointer-events: none; z-index: 6;
    }

    /* Toolbar tooltip — kit .hbk-tooltip, positioned in HUD px. */
    #${TIP_ID} { white-space: nowrap; }
    #${TIP_ID}[hidden] { display: none; }
    #${TIP_ID} .hb-tip-key { color: var(--hbk-gold-bright, #f3d27a); }
    #${TIP_ID} .hb-tip-sub {
      margin-top: 1px; font-size: 11px; color: var(--hbk-text-dim, #a8a090);
      white-space: normal; max-width: 240px;
    }
  `;
  document.head.appendChild(style);
}

function loadState() {
  const fallback = () => ({ slots: Array(SLOT_COUNT).fill(null) });
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_KEY)) || fallback();
    // Migrate older 9-slot saves to 18 slots — pad with nulls so
    // row 2 starts empty without forcing the user to re-bind row 1.
    if (!Array.isArray(parsed.slots)) parsed.slots = [];
    while (parsed.slots.length < SLOT_COUNT) parsed.slots.push(null);
    return parsed;
  } catch (_) { return fallback(); }
}
function saveState(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (_) {}
}
function loadRowCount() {
  try { return normalizeRowCount(localStorage.getItem(LS_ROWS_KEY)); } catch (_) { return 1; }
}
function saveRowCount(n) {
  try { localStorage.setItem(LS_ROWS_KEY, String(normalizeRowCount(n))); } catch (_) {}
}
function migrateSavedPosition() {
  try {
    if (localStorage.getItem(LS_UNIFIED_FLAG)) return;
    localStorage.removeItem(`hb.window.${(WINDOW_ID.HOTBAR >>> 0).toString(16)}`);
    localStorage.setItem(LS_UNIFIED_FLAG, "1");
  } catch (_) {}
}

// ── Tooltip (one shared kit tooltip for every toolbar control) ───────
// Targets carry `data-tip` and either a text value or an `_hbTip()`
// returning `string | {text, key?, sub?}`. Positioned from hudRect()
// because the tooltip is itself a zoomed `#hb-*` body child: its
// left/top are HUD px, while getBoundingClientRect is screen px.
function createToolbarTooltip(root) {
  let tip = document.getElementById(TIP_ID);
  if (!tip) {
    tip = document.createElement("div");
    tip.id = TIP_ID;
    tip.className = "hbk-tooltip";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
  }
  tip.hidden = true;
  let current = null;
  let timer = 0;

  const resolve = (el) => {
    const f = el._hbTip;
    const v = typeof f === "function" ? f() : (el.dataset.tip || "");
    if (!v) return null;
    return typeof v === "string" ? { text: v } : v;
  };
  function render(info) {
    tip.textContent = "";
    const head = document.createElement("div");
    head.appendChild(document.createTextNode(info.text || ""));
    if (info.key) {
      const k = document.createElement("span");
      k.className = "hb-tip-key";
      k.textContent = ` (${info.key})`;
      head.appendChild(k);
    }
    tip.appendChild(head);
    if (info.sub) {
      const s = document.createElement("div");
      s.className = "hb-tip-sub";
      s.textContent = info.sub;
      tip.appendChild(s);
    }
  }
  function place(el) {
    const r = hudRect(el);
    const vp = hudViewport();
    tip.style.left = "0px";
    tip.style.top = "0px";
    const t = hudRect(tip);
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(4, Math.min(left, vp.width - t.width - 4));
    let top = r.top - t.height - 6;
    if (top < 4) top = r.bottom + 6;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }
  function show(el) {
    const info = resolve(el);
    if (!info || !el.isConnected) { hide(); return; }
    render(info);
    tip.hidden = false;
    place(el);
  }
  function hide() {
    clearTimeout(timer);
    timer = 0;
    current = null;
    tip.hidden = true;
  }
  const targetOf = (ev) => ev.target?.closest?.("[data-tip]");
  const onOver = (ev) => {
    const el = targetOf(ev);
    if (!el || !root.contains(el)) return;
    if (el === current) return;
    current = el;
    clearTimeout(timer);
    // Already showing → retarget instantly; first hover waits a beat.
    if (!tip.hidden) show(el);
    else timer = setTimeout(() => { if (current === el) show(el); }, 350);
  };
  const onOut = (ev) => {
    if (!current) return;
    const to = ev.relatedTarget;
    if (to && current.contains(to)) return;
    if (to && targetOf({ target: to }) && root.contains(to)) return; // onOver retargets
    hide();
  };
  const onFocus = (ev) => {
    const el = targetOf(ev);
    if (!el || !el.matches(":focus-visible")) return;
    current = el;
    show(el);
  };
  root.addEventListener("pointerover", onOver);
  root.addEventListener("pointerout", onOut);
  root.addEventListener("pointerdown", hide, true);
  root.addEventListener("dragstart", hide, true);
  root.addEventListener("focusin", onFocus);
  root.addEventListener("focusout", hide);
  return {
    hide,
    /** Re-render the open tooltip (content changed under the pointer). */
    refresh() { if (current && !tip.hidden) show(current); },
    dispose() {
      hide();
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointerout", onOut);
      root.removeEventListener("pointerdown", hide, true);
      root.removeEventListener("dragstart", hide, true);
      root.removeEventListener("focusin", onFocus);
      root.removeEventListener("focusout", hide);
      tip.remove();
    },
  };
}

export function mount(ctx) {
  ensureStyles();
  migrateSavedPosition();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "toolbar");
  overlay.setAttribute("aria-label", "Toolbar");
  // ToolbarField 0x1000001B — controls + shortcut slots share its origin.
  const field = document.createElement("div");
  field.className = "hb-hotbar-field";
  overlay.appendChild(field);
  const tooltip = createToolbarTooltip(overlay);

  let rowCount = loadRowCount();
  const applyRowClass = () => {
    overlay.classList.toggle("hb-hotbar-rows-1", rowCount === 1);
    overlay.classList.toggle("hb-hotbar-rows-2", rowCount === 2);
  };
  applyRowClass();

  // gmToolbarUI top band (combat mode, panel buttons, Use | Selected |
  // Examine, backpack) — plugins/target-bar.js.
  const controls = mountToolbarControls(field, { root: overlay });

  const state = loadState();
  const slotEls = [];

  // P1-6 follow-up: server-side persistence for hotbar bindings.
  // ACE handler `Player_Character.HandleActionAddShortcut` writes
  // `(index, objectId)` to the Character table — bindings survive
  // logout. We mirror retail UX: spell-bind clear → add ordering.
  // No-op when the wasm session isn't logged in or the bundle
  // predates the addShortcut method (older clients).
  // Rec #75 — return boolean so compensating-transaction guards in the
  // swap path can detect partial failures. Missing wasm export is a
  // no-op success (true) so older bundles still let the optimistic
  // local state-save proceed; an exception thrown by the export is the
  // signal a guard would care about.
  function sendAddShortcut(slotIndex, objectGuid, spellId) {
    try {
      const handle = window.__sessionHandle ?? null;
      if (handle && typeof handle.addShortcut === "function") {
        handle.addShortcut(slotIndex >>> 0, objectGuid >>> 0, spellId >>> 0, 0);
      }
      return true;
    } catch (e) {
      console.warn(`[hotbar] addShortcut(idx=${slotIndex}) failed:`, e);
      return false;
    }
  }
  function sendRemoveShortcut(slotIndex) {
    try {
      const handle = window.__sessionHandle ?? null;
      if (handle && typeof handle.removeShortcut === "function") {
        handle.removeShortcut(slotIndex >>> 0);
      }
      return true;
    } catch (e) {
      console.warn(`[hotbar] removeShortcut(idx=${slotIndex}) failed:`, e);
      return false;
    }
  }

  // Rec #75 — pending-swap guard. Keyed by an unordered pair so a
  // retry-during-pending no-ops instead of double-submitting the
  // 4-step RM/ADD sequence. Cleared once the sequence resolves.
  const _pendingSwaps = new Set();
  function _swapKey(a, b) {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    return `${lo}:${hi}`;
  }
  function _flashSwapFail(slotIndex) {
    try {
      const el = slotEls[slotIndex];
      if (!el) return;
      el.classList.add("hb-hotbar-swap-fail");
      setTimeout(() => { try { el.classList.remove("hb-hotbar-swap-fail"); } catch (_) {} }, 400);
    } catch (_) {}
  }
  function _swapToast(text) {
    try {
      const old = overlay.querySelector(".hb-hotbar-toast");
      if (old) old.remove();
      const t = document.createElement("div");
      t.className = "hb-hotbar-toast";
      t.textContent = text;
      overlay.appendChild(t);
      setTimeout(() => { try { t.remove(); } catch (_) {} }, 1800);
    } catch (_) {}
  }

  function renderSlot(idx) {
    const el = slotEls[idx];
    const bound = state.slots[idx];
    el.classList.toggle("bound", !!bound);
    el.setAttribute("aria-label", slotAriaLabel(idx));
    const icon = el.querySelector(".hb-hotbar-slot-icon");
    if (!bound) {
      icon.style.backgroundImage = "";
      icon.dataset.boundKey = "";
      el.querySelector(".hb-hotbar-uifx")?.remove();
      return;
    }
    // P1-23 (cross-find hotbar-slot-icon-placeholder): resolve the
    // bound spell/item to its real DAT icon via the shared resolver.
    // The compass-disk placeholder paints until the async fetch lands
    // — then the data-URL background replaces it. boundKey guards
    // against races where renderSlot is called repeatedly while the
    // promise is still in flight.
    icon.style.backgroundImage = "url('./data/ui-sprites/0x06004CC1.png')";
    const key = bound.spellId
      ? `spell:${bound.spellId}`
      : `item:${bound.itemGuid}`;
    icon.dataset.boundKey = key;
    resolveBindingIcon(bound).then((u) => {
      // Bail if the slot got re-bound while we were fetching.
      if (icon.dataset.boundKey !== key) return;
      if (u) icon.style.backgroundImage = `url("${u}")`;
    }).catch(() => { /* shared helper logs; placeholder stays */ });

    // Track A (?uiEffectIcons, default OFF): UiEffects magic-effect badge for an
    // ITEM binding (potions/wands etc.). Same registry + real icon (0x25000009)
    // + tint fallback as inventory/container. Re-render clears the prior badge.
    // DOM-only; flag-off no-op.
    const prevFx = el.querySelector(".hb-hotbar-uifx");
    if (prevFx) prevFx.remove();
    if (uiEffectBadgesEnabled() && bound.itemGuid) {
      const uiFx = uiEffectIconsFor(_itemUiEffects(bound.itemGuid));
      if (uiFx.length) {
        const fxWrap = document.createElement("span");
        fxWrap.className = "hb-hotbar-uifx";
        fxWrap.style.cssText =
          "position:absolute;top:1px;left:1px;display:flex;gap:2px;pointer-events:none;z-index:4;";
        for (const f of uiFx) {
          const dot = document.createElement("span");
          dot.style.cssText =
            "width:11px;height:11px;border-radius:3px;border:1px solid rgba(0,0,0,0.55);" +
            `background:${uiEffectTintCss(f.tint)} center/contain no-repeat;`;
          fxWrap.appendChild(dot);
          if (f.iconDid) {
            fetchIconDataUrlShared(f.iconDid >>> 0).then((u) => {
              if (u && dot.isConnected) dot.style.background = `url("${u}") center/contain no-repeat`;
            }).catch(() => {});
          }
        }
        el.appendChild(fxWrap);
      }
    }
  }

  // UiEffects (PropertyInt 18) bitmask for a hotbar-bound item guid, from the
  // live wasm inventory snapshot (InventoryItem.uiEffects). 0 if not found.
  function _itemUiEffects(guid) {
    try {
      const h = window.__sessionHandle;
      if (!h?.playerInventory) return 0;
      const g = guid >>> 0;
      for (const it of h.playerInventory()) {
        if ((it.guid >>> 0) === g) return (it.uiEffects >>> 0) || 0;
      }
    } catch (_) { /* default 0 */ }
    return 0;
  }

  // ── Slot labels / tooltips ─────────────────────────────────────────
  function slotKeyLabel(idx) {
    const row = Math.floor(idx / SLOTS_PER_ROW);
    const n = (idx % SLOTS_PER_ROW) + 1;
    const b = row === 0
      ? resolveLocalBinding(LOCAL_ACTION_IDS[`HOTBAR_${n}`], `Digit${n}`)
      : resolveLocalBinding(LOCAL_ACTION_IDS[`HOTBAR_R2_${n}`], null);
    return b?.code ? formatBinding(b) : "";
  }
  function boundName(bound) {
    if (!bound) return null;
    const handle = window.__sessionHandle ?? null;
    if (bound.spellId) {
      try { return spellRecordName(handle?.getSpellRecord?.(bound.spellId >>> 0)); } catch (_) { return null; }
    }
    if (bound.itemGuid) return lookupObjectName(bound.itemGuid >>> 0);
    return null;
  }
  function slotTip(idx) {
    const bound = state.slots[idx];
    const key = slotKeyLabel(idx);
    const label = `Shortcut ${idx + 1}`;
    if (!bound) return { text: label, key, sub: "Drag a spell or item here" };
    const name = boundName(bound);
    const kind = bound.spellId ? "Spell" : "Item";
    return { text: name || `${kind} shortcut`, key, sub: `${label} · right-click for options` };
  }
  function slotAriaLabel(idx) {
    const key = slotKeyLabel(idx);
    const bound = state.slots[idx];
    const what = bound ? (boundName(bound) || (bound.spellId ? "spell" : "item")) : "empty";
    return formatTipLabel(`Shortcut ${idx + 1}: ${what}`, key);
  }

  // Read the soft-target GUID — the most recently clicked entity in the
  // 3D scene (set by picking.js#onPointerDown → entityManager.set
  // SelectedTarget).
  function getSoftTargetGuid() {
    try {
      const em = window.liveScene3d?.entityManager;
      return (em?.getSelectedTarget?.() ?? 0) >>> 0;
    } catch {
      return 0;
    }
  }

  // Mirror a single visibility line to the existing chat-log overlay (the
  // visible chat panel mirrors it). Failures and "needs a target" hints only:
  // a successful use/cast is silent, like retail (it used to print a debug
  // "Hotbar N: use item 0x…" line into the player's chat on every press).
  // Best-effort — chat-log may not exist pre-login or if chat plugin
  // is unmounted; silently drop in that case.
  function logToChat(text) {
    const src = document.getElementById("chat-log");
    if (!src) return;
    const li = document.createElement("li");
    li.dataset.cat = "0";
    li.className = "cat-0";
    li.textContent = text;
    src.appendChild(li);
  }

  // Migration sweep — clear stale Container bindings from pre-Wave-B saves.
  // Reads the live inventory once on mount; safe to no-op if wasm isn't
  // up yet (we get re-run on reconcile).
  function migrateClearContainerBindings() {
    try {
      const handle = window.__sessionHandle ?? null;
      if (typeof handle?.playerInventory !== "function") return;
      const inv = handle.playerInventory();
      if (!Array.isArray(inv) || inv.length === 0) return;
      let dirty = false;
      for (let i = 0; i < state.slots.length; i++) {
        const b = state.slots[i];
        if (!b?.itemGuid) continue;
        const it = inv.find((x) => (x.guid >>> 0) === (b.itemGuid >>> 0));
        if (!it) continue;
        if (typeof canBindToHotbar === "function") {
          const v = canBindToHotbar(it);
          if (!v.ok) {
            state.slots[i] = null;
            dirty = true;
            sendRemoveShortcut(i);
          }
        }
      }
      // Copy-then-free (2026-08-03): `canBindToHotbar` reads primitives and
      // returns a plain {ok, reason}, and nothing above retains an element,
      // so every box can be released here rather than waiting on the
      // FinalizationRegistry (the wasm high-water mark only ratchets up).
      for (const it of inv) { try { it?.free?.(); } catch (_) {} }
      if (dirty) { saveState(state); for (let i = 0; i < SLOT_COUNT; i++) renderSlot(i); }
    } catch (_) {}
  }
  const migrateTimer = setTimeout(migrateClearContainerBindings, 1500);

  // Armed-spell bridge: if combat-bar has an armed targeted spell AND
  // this slot is an item binding, fire castTargetedSpell(itemGuid, spellId)
  // and emit hbHotbarItemTargeted so combat-bar clears its armed state.
  // This must run BEFORE the normal decideFireAction dispatch.
  function tryFireArmedSpellOnItem(idx) {
    const bound = state.slots[idx];
    if (!bound?.itemGuid) return false;
    const armed = (window.__combatBarState?.armedSpellId >>> 0) || 0;
    if (!armed) return false;
    const client = ctx?.client ?? window.__pluginClient ?? null;
    const handle = window.__sessionHandle ?? null;
    const fire =
      (typeof handle?.castTargetedSpell === "function" && ((g, s) => handle.castTargetedSpell(s, g))) ||
      (typeof client?.player?.castSpell === "function" && ((g, s) => client.player.castSpell(s, g)));
    if (!fire) return false;
    try {
      fire(bound.itemGuid, armed);
      try {
        window.dispatchEvent(new CustomEvent("hbHotbarItemTargeted", {
          detail: { slotIndex: idx, itemGuid: bound.itemGuid, spellId: armed },
        }));
      } catch (_) {}
      return true;
    } catch (e) {
      logToChat(`Hotbar ${idx + 1}: armed-cast failed — ${e?.message ?? e}`);
      return false;
    }
  }

  function fireSlot(idx) {
    const bound = state.slots[idx];
    if (!bound) return;
    const handle = window.__sessionHandle ?? null;

    // Resolve the spell's self-target flag from the wasm SpellTable
    // accessor. getSpellRecord returns null pre-WorldBootstrap and throws
    // when the SpellTable isn't loaded — fall back to true (self-cast) in
    // both cases (spellbook.js legacy `untargeted` default).
    let isSelfTargeted = true;
    if (bound.spellId) {
      try {
        const v = spellIsSelfTargeted(handle?.getSpellRecord?.(bound.spellId));
        if (v != null) isSelfTargeted = v;
      } catch (_) {
        // getSpellRecord throws if SpellTable not loaded — keep default.
      }
    }
    if (tryFireArmedSpellOnItem(idx)) return;
    const action = decideFireAction(bound, {
      isSelfTargeted,
      softTargetGuid: getSoftTargetGuid(),
    });

    switch (action.kind) {
      case "useItem": {
        if (typeof handle?.useObject !== "function") {
          logToChat(`Hotbar ${idx + 1}: not logged in — useObject unavailable`);
          return;
        }
        try {
          handle.useObject(action.itemGuid);
          // Successful fire → clear any armed item set by inventory click /
          // context menu. Keyboard 1-7 taps that resolve to needTarget/none
          // do NOT reach this branch, so muscle-memory taps don't nuke
          // armed state.
          try { window.__inventory?.setArmedItem?.(0); } catch (_) {}
        } catch (e) {
          logToChat(`Hotbar ${idx + 1}: useObject failed — ${e?.message ?? e}`);
        }
        return;
      }
      case "castSelf": {
        try {
          if (!castSpellViaHandle(action.spellId, null)) {
            logToChat(`Hotbar ${idx + 1}: not logged in — castSpell unavailable`);
            return;
          }
          try { window.__inventory?.setArmedItem?.(0); } catch (_) {}
        } catch (e) {
          logToChat(`Hotbar ${idx + 1}: cast failed — ${e?.message ?? e}`);
        }
        return;
      }
      case "castOnTarget": {
        try {
          if (!castSpellViaHandle(action.spellId, action.targetGuid)) {
            logToChat(`Hotbar ${idx + 1}: not logged in — castSpell unavailable`);
            return;
          }
          try { window.__inventory?.setArmedItem?.(0); } catch (_) {}
        } catch (e) {
          logToChat(`Hotbar ${idx + 1}: cast failed — ${e?.message ?? e}`);
        }
        return;
      }
      case "needTarget": {
        // Match retail UX: an armed targeted spell with no selection
        // is a no-op. We surface a hint instead of silently swallowing
        // so the player learns the binding works.
        const name = boundName(bound) || `spell 0x${action.spellId.toString(16).toUpperCase()}`;
        logToChat(`Hotbar ${idx + 1}: ${name} needs a target — click an entity first`);
        return;
      }
      case "none":
      default:
        logToChat(`Hotbar ${idx + 1}: (unbound)`);
    }
  }

  // Reconcile-pause-on-drag — user-driven swaps don't fight server
  // reconcile mid-gesture. 5s cap from last drag.
  let lastDragTs = 0;
  function inDragPauseWindow() {
    return (Date.now() - lastDragTs) < 5000;
  }

  for (let i = 0; i < SLOT_COUNT; i++) {
    const el = document.createElement("div");
    el.className = "hb-hotbar-slot";
    el.dataset.slot = String(i);
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.dataset.tip = "";
    el._hbTip = () => slotTip(i);
    const r = slotRect(i);
    el.dataset.row = String(r.row);
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;

    const icon = document.createElement("div");
    icon.className = "hb-hotbar-slot-icon";
    el.appendChild(icon);

    const num = document.createElement("ac-text");
    num.className = "hb-hotbar-slot-num";
    // Retail draws 1..9 on ShortcutBar; ShortcutBar2 has no default keys
    // (user assigns them via Options → Controls), so it stays unlabeled.
    num.textContent = r.row === 0 ? String(r.col + 1) : "";
    el.appendChild(num);

    // Click → fire. Suppress synthetic click immediately after dragend.
    el.addEventListener("click", () => {
      if (el._dragging) return;
      fireSlot(i);
    });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); if (!ev.repeat) fireSlot(i); }
    });

    // Drag-drop MIMEs accepted by hotbar slots:
    //   application/x-hb-spell-id      from spellbook + combat-bar
    //   application/x-hb-inv-guid      from inventory (item bind)
    //   application/x-hb-hotbar-slot   hotbar↔hotbar slot swap
    // The hotbar-slot MIME is the ONLY accepted swap signal — we do NOT
    // also consume inv-guid for swaps, to prevent cross-consume from
    // trade-panel or canvas drag sources.
    function dragHasAcceptedType(types) {
      // Rec #161 (2026-06-16): MIME list centralized in
      // drop_item_flags.js — SHORTCUT flag covers the spell-id /
      // inv-guid / hotbar-slot triple this slot accepts.
      return isDropAccepted(types, DropItemFlags.SHORTCUT);
    }
    // Hotbar slot is itself a drag source for swap.
    el.draggable = true;
    el.addEventListener("dragstart", (ev) => {
      const b = state.slots[i];
      if (!b) { ev.preventDefault(); return; }
      ev.dataTransfer.setData("application/x-hb-hotbar-slot", String(i));
      ev.dataTransfer.effectAllowed = "move";
      el._dragging = true;
      lastDragTs = Date.now();
      // Wave C / PR9 (2026-06-06): icon-driven drag ghost. (Was querying a
      // non-existent `.hb-hotbar-icon`, so the ghost was always the whole
      // slot DOM — HUD overhaul 2026-10-05.)
      try {
        const bg = getComputedStyle(icon).backgroundImage;
        const m = bg && bg !== "none" ? /url\(["']?([^"')]+)["']?\)/.exec(bg) : null;
        if (m && m[1]) {
          const img = new Image();
          img.src = m[1];
          img.width = 32; img.height = 32;
          ev.dataTransfer.setDragImage(img, 16, 16);
        }
      } catch (_) {}
    });
    el.addEventListener("dragend", () => {
      // 50ms post-dragend so the synthetic click that follows is suppressed.
      setTimeout(() => { el._dragging = false; }, 50);
    });
    // Wave C / PR10 (2026-06-06): retail click-feedback pulse.
    el.addEventListener("click", () => {
      el.classList.add("firing");
      setTimeout(() => el.classList.remove("firing"), 90);
    }, true);
    el.addEventListener("dragenter", (ev) => {
      if (dragHasAcceptedType(ev.dataTransfer?.types)) {
        ev.preventDefault();
        el.classList.add("drag-over");
      }
    });
    el.addEventListener("dragover", (ev) => {
      if (dragHasAcceptedType(ev.dataTransfer?.types)) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
      }
    });
    el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
    el.addEventListener("drop", (ev) => {
      el.classList.remove("drag-over");
      const sid = ev.dataTransfer?.getData("application/x-hb-spell-id");
      const iguid = ev.dataTransfer?.getData("application/x-hb-inv-guid");
      if (sid) {
        ev.preventDefault();
        const spellId = Number(sid);
        // ACE expects "shortcut on top of existing item" to remove the
        // old binding first then add the new one. We mirror that here.
        const prev = state.slots[i];
        if (prev) sendRemoveShortcut(i);
        state.slots[i] = { spellId };
        saveState(state);
        renderSlot(i);
        sendAddShortcut(i, 0, spellId);
        tooltip.refresh();
        return;
      }
      // Hotbar↔hotbar swap: RM→ADD→RM→ADD per Player_Character.cs:252-258.
      const fromSlotStr = ev.dataTransfer?.getData("application/x-hb-hotbar-slot");
      if (fromSlotStr !== "" && fromSlotStr != null) {
        const fromIdx = parseInt(fromSlotStr, 10);
        if (Number.isInteger(fromIdx) && fromIdx !== i && fromIdx >= 0 && fromIdx < SLOT_COUNT) {
          ev.preventDefault();
          // Rec #75 — compensating-transaction guard. Skip if the
          // same pair is already mid-swap (user double-drop). Track
          // per-step success so a server-side reject rolls the local
          // state back, highlights the failing slot, and toasts.
          const swapKey = _swapKey(fromIdx, i);
          if (_pendingSwaps.has(swapKey)) return;
          _pendingSwaps.add(swapKey);
          const a = state.slots[fromIdx];
          const b = state.slots[i];
          const preSlots = state.slots.slice();
          let ok = true;
          if (a) ok = sendRemoveShortcut(fromIdx) && ok;
          if (b) ok = sendRemoveShortcut(i) && ok;
          state.slots[fromIdx] = b || null;
          state.slots[i] = a || null;
          saveState(state);
          renderSlot(fromIdx);
          renderSlot(i);
          if (state.slots[fromIdx]) {
            ok = sendAddShortcut(fromIdx, state.slots[fromIdx].itemGuid || 0, state.slots[fromIdx].spellId || 0) && ok;
          }
          if (state.slots[i]) {
            ok = sendAddShortcut(i, state.slots[i].itemGuid || 0, state.slots[i].spellId || 0) && ok;
          }
          if (!ok) {
            // Server rejected at least one step — roll the local
            // state back so the visual matches what survived.
            state.slots = preSlots;
            saveState(state);
            renderSlot(fromIdx);
            renderSlot(i);
            _flashSwapFail(fromIdx);
            _flashSwapFail(i);
            _swapToast("Swap failed: server rejected change");
          }
          _pendingSwaps.delete(swapKey);
          return;
        }
      }
      if (iguid) {
        ev.preventDefault();
        const guid = parseInt(iguid, 10) >>> 0;
        if (guid > 0) {
          // Validate against canBindToHotbar — rejects Container + Sigil.
          try {
            const handle = window.__sessionHandle ?? null;
            const inv = typeof handle?.playerInventory === "function" ? handle.playerInventory() : [];
            const item = inv.find((x) => (x.guid >>> 0) === guid) || null;
            if (item && typeof canBindToHotbar === "function") {
              const v = canBindToHotbar(item);
              if (!v.ok) {
                el.classList.add("drag-reject");
                setTimeout(() => el.classList.remove("drag-reject"), 250);
                logToChat(`Hotbar ${i + 1}: ${v.reason}`);
                return;
              }
            }
          } catch (_) {}
          const prev = state.slots[i];
          if (prev) sendRemoveShortcut(i);
          state.slots[i] = { itemGuid: guid };
          saveState(state);
          renderSlot(i);
          sendAddShortcut(i, guid, 0);
          tooltip.refresh();
        }
      }
    });

    // Right-click → polymorphic context menu. Legacy destructive
    // clear is gone — Remove Binding lives in the menu now. clientX/Y
    // are SCREEN px; the menu owner converts (ui/hud_scale.js).
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const b = state.slots[i];
      // Empty slots have no menu actions that make sense — skip rather than
      // surface a useless Examine on guid=0.
      if (!b) return;
      const guid = (b?.itemGuid >>> 0) || 0;
      if (typeof window.__openContextMenuFor === "function") {
        try {
          window.__openContextMenuFor({
            source: "hotbar",
            guid,
            slotIndex: i,
            spellId: (b?.spellId | 0) || 0,
            clientX: ev.clientX,
            clientY: ev.clientY,
          });
        } catch (e) { console.warn("[hotbar-rc] context menu failed:", e); }
        return;
      }
      // Legacy fallback: clear (pre-context-menu behaviour).
      const prev = state.slots[i];
      state.slots[i] = null;
      saveState(state);
      renderSlot(i);
      if (prev) sendRemoveShortcut(i);
    });

    field.appendChild(el);
    slotEls.push(el);
  }
  for (let i = 0; i < SLOT_COUNT; i++) renderSlot(i);

  // ── ShortcutBar2 opt-in: bottom-edge grip ──────────────────────────
  const grip = document.createElement("div");
  grip.className = "hb-hotbar-grip";
  grip.dataset.tip = "";
  grip._hbTip = () => ({
    text: rowCount === 2 ? "Hide the second shortcut row" : "Show a second shortcut row",
    sub: "Drag this edge, or double-click it",
  });
  overlay.appendChild(grip);

  function setRowCount(n) {
    const next = normalizeRowCount(n);
    if (next === rowCount) return rowCount;
    rowCount = next;
    saveRowCount(rowCount);
    applyRowClass();
    // A top-anchored toolbar grows downward — keep it on screen.
    try {
      if (overlay.style.top && overlay.style.top !== "auto") {
        const r = hudRect(overlay);
        const vp = hudViewport();
        if (r.bottom > vp.height) overlay.style.top = `${Math.max(0, vp.height - r.height)}px`;
      }
    } catch (_) {}
    tooltip.refresh();
    return rowCount;
  }
  let gripDrag = null;
  grip.addEventListener("pointerdown", (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    gripDrag = { y0: ev.clientY, rows0: rowCount };
    try { grip.setPointerCapture(ev.pointerId); } catch (_) {}
  });
  grip.addEventListener("pointermove", (ev) => {
    if (!gripDrag) return;
    setRowCount(rowsAfterGripDrag(gripDrag.rows0, toHudPx(ev.clientY - gripDrag.y0)));
  });
  const endGrip = (ev) => {
    if (!gripDrag) return;
    gripDrag = null;
    try { grip.releasePointerCapture(ev.pointerId); } catch (_) {}
  };
  grip.addEventListener("pointerup", endGrip);
  grip.addEventListener("pointercancel", endGrip);
  grip.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    setRowCount(rowCount === 2 ? 1 : 2);
  });

  document.body.appendChild(overlay);

  // One draggable window: the frame / spacer area is the handle (retail
  // drags a floaty by its border); every control opts out.
  const windowCtl = attachWindowPosition(overlay, {
    windowId: WINDOW_ID.HOTBAR,
    dragHandle: overlay,
    ignoreSelector: "button, [role='button'], .hb-hotbar-grip",
    onLockChange: (locked) => overlay.classList.toggle("is-locked", !!locked),
  });
  // attachWindowPosition stamps an inline `cursor: move` on the handle;
  // let the stylesheet decide (no move cursor while locked).
  overlay.style.cursor = "";

  // Hotbar slot keys: row 1 = Digit1..Digit9 by default, row 2 = no
  // default binding (retail leaves these unbound — user assigns via
  // Options → Controls → Local Actions). Suppress while focused on a
  // text input (chat send, etc.).
  function onKey(ev) {
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    // Retail per-mode input-map partition (Task C v2, 2026-07-02): in
    // MAGIC stance the number row belongs to `UseSpellSlot_1..9`
    // (MagicCombat map — handled by combat-bar's spell strip), NOT the
    // quickslots. A hotbar binding on a digit yields there; rebound
    // non-digit hotbar keys keep working in every stance.
    const inMagicStance = (() => {
      try { return window.__getCurrentStanceLow?.() === 0x49; } catch (_) { return false; }
    })();
    const digitInMagic = (b) => inMagicStance && /^Digit[1-9]$/.test(b?.code || "");
    // Row 1
    for (let slot = 1; slot <= SLOTS_PER_ROW; slot++) {
      const binding = resolveLocalBinding(LOCAL_ACTION_IDS[`HOTBAR_${slot}`], `Digit${slot}`);
      if (matchesBinding(ev, binding)) {
        if (digitInMagic(binding)) return; // spell strip owns digits in magic
        if (ev.repeat) return; // a held slot key uses the item once
        fireSlot(slot - 1);
        return;
      }
    }
    // Row 2 — `HOTBAR_R2_1`..`HOTBAR_R2_9`, no default code (null).
    for (let slot = 1; slot <= SLOTS_PER_ROW; slot++) {
      const binding = resolveLocalBinding(LOCAL_ACTION_IDS[`HOTBAR_R2_${slot}`], null);
      if (binding && matchesBinding(ev, binding)) {
        if (digitInMagic(binding)) return;
        if (ev.repeat) return;
        fireSlot(SLOTS_PER_ROW + slot - 1);
        return;
      }
    }
  }
  // P-unification (2026-07-28): each quickslot is its own ACTION on the ONE
  // funnel (rebindable via Options → Controls, per-slot dispatch counters in
  // `__diag.input()`), sharing WASD's gate. The retail per-mode input-map
  // partition survives as the action's `when`: in MAGIC stance a digit
  // binding yields to combat-bar's `UseSpellSlot_N`. `?inputFunnelV2=off`
  // restores the single legacy listener, byte-identical.
  const funnelUnbinds = [];
  if (inputFunnelV2On()) {
    const funnel = getInputFunnel();
    const notDigitInMagic = (id, def) => () => {
      const b = resolveLocalBinding(id, def);
      if (!b || !b.code) return false;
      if (!/^Digit[1-9]$/.test(b.code)) return true;
      try { return window.__getCurrentStanceLow?.() !== 0x49; } catch (_) { return true; }
    };
    for (let slot = 1; slot <= SLOTS_PER_ROW; slot++) {
      const id = LOCAL_ACTION_IDS[`HOTBAR_${slot}`];
      const def = `Digit${slot}`;
      const idx = slot - 1;
      funnelUnbinds.push(funnel.bindAction(id, def, () => fireSlot(idx), {
        when: notDigitInMagic(id, def),
        source: "hotbar",
      }));
    }
    for (let slot = 1; slot <= SLOTS_PER_ROW; slot++) {
      const id = LOCAL_ACTION_IDS[`HOTBAR_R2_${slot}`];
      const idx = SLOTS_PER_ROW + slot - 1;
      funnelUnbinds.push(funnel.bindAction(id, null, () => fireSlot(idx), {
        when: notDigitInMagic(id, null),
        source: "hotbar",
      }));
    }
  } else {
    window.addEventListener("keydown", onKey);
  }

  // P1-6 follow-up #2 (task #18): reconcile localStorage cache with the
  // server's authoritative shortcut state once PlayerDescription lands.
  // `playerShortcuts()` returns [] until then; we poll at 1Hz and run
  // exactly one merge on first non-empty result. After reconciliation,
  // per-bind sync (sendAdd/RemoveShortcut) keeps both sides in sync, so
  // no further polling is needed.
  function reconcileWithServer() {
    if (inDragPauseWindow()) return false;
    const handle = window.__sessionHandle ?? null;
    if (!handle || typeof handle.playerShortcuts !== "function") return false;
    const flat = handle.playerShortcuts();
    if (!flat || flat.length === 0) return false;
    // Server is objectGuid-only; we keep local spell bindings + wcid.
    // Build server snapshot first, then merge: server item bindings WIN
    // when objectGuid is present; local spell bindings persist where the
    // server slot is empty (server never sends spell-only on relogin).
    const serverSlots = Array(SLOT_COUNT).fill(null);
    for (let k = 0; k + 2 < flat.length; k += 3) {
      const idx = flat[k] >>> 0;
      const objectGuid = flat[k + 1] >>> 0;
      const packed = flat[k + 2] >>> 0;
      const spellId = packed & 0xFFFF;
      if (idx >= SLOT_COUNT) continue;
      if (spellId > 0) serverSlots[idx] = { spellId };
      else if (objectGuid > 0) serverSlots[idx] = { itemGuid: objectGuid };
    }
    const merged = Array(SLOT_COUNT).fill(null);
    for (let idx = 0; idx < SLOT_COUNT; idx++) {
      const s = serverSlots[idx];
      const l = state.slots[idx];
      if (s) {
        // Persist wcid alongside guid so post-restart objectGuid reuse can
        // be validated against the inventory snapshot's wcid.
        if (s.itemGuid) {
          let wcid = 0;
          try {
            const inv = handle.playerInventory?.() ?? [];
            const it = inv.find((x) => (x.guid >>> 0) === (s.itemGuid >>> 0));
            wcid = (it?.wcid >>> 0) || 0;
          } catch (_) {}
          merged[idx] = { itemGuid: s.itemGuid, wcid };
        } else {
          merged[idx] = s;
        }
      } else if (l?.spellId) {
        merged[idx] = l; // preserve local spell binding (server is item-only)
      }
    }
    state.slots = merged;
    saveState(state);
    for (let i = 0; i < SLOT_COUNT; i++) renderSlot(i);
    return true;
  }

  // Counters hoisted above pruneStaleItemBindings so the bus subscriber
  // can read them without a TDZ risk if the dispatch becomes synchronous.
  let inWorld = false;
  let firstBindAt = 0;
  let reconcileAttempts = 0;
  // pruneStaleItemBindings: 3-gated. Only sweeps when in_world AND we've
  // completed reconcile AND any local binding is old enough AND we have
  // inventory snapshot to compare against.
  function pruneStaleItemBindings() {
    if (!inWorld) return;
    if (reconcileAttempts < 30) return;
    if ((Date.now() - firstBindAt) <= 5000) return;
    const handle = window.__sessionHandle ?? null;
    if (typeof handle?.playerInventory !== "function") return;
    const inv = handle.playerInventory();
    if (!Array.isArray(inv) || inv.length === 0) return;
    let dirty = false;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const b = state.slots[i];
      if (!b?.itemGuid) continue;
      const it = inv.find((x) => (x.guid >>> 0) === (b.itemGuid >>> 0));
      if (it) continue;
      // Stale binding; if wcid known, look for matching wcid on a different guid
      // (post-restart objectGuid reuse).
      if (b.wcid) {
        const alt = inv.find((x) => (x.wcid >>> 0) === (b.wcid >>> 0));
        if (alt) { state.slots[i] = { itemGuid: alt.guid >>> 0, wcid: b.wcid }; dirty = true; continue; }
      }
      state.slots[i] = null;
      dirty = true;
      sendRemoveShortcut(i);
    }
    if (dirty) { saveState(state); for (let i = 0; i < SLOT_COUNT; i++) renderSlot(i); }
  }
  // All bus subscriptions use the plugin facade (same channel index.html
  // emits playerInventoryChanged on); previous wave wrongly used the
  // window DOM event bus and the listener never fired.
  const client = ctx?.client ?? window.__pluginClient;
  const onLandblockChanged = () => { inWorld = true; };
  // HUD rec #84 (2026-06-16): toggle .cooldown-active on every slot when
  // the wasm side flags a shared-cooldown change. Future refinement:
  // per-slot gating via playerEnchantments() COOLDOWN bit (0x1000000)
  // matched against each slot's bound spell-id.
  const onSharedCooldown = (e) => {
    const active = ((e?.activeCount ?? e?.detail?.activeCount) ?? 0) >>> 0;
    for (const slot of slotEls) slot.classList.toggle("cooldown-active", active > 0);
  };
  try {
    client?.events?.on?.("playerInventoryChanged", pruneStaleItemBindings);
    client?.events?.on?.("landblockChanged", onLandblockChanged);
    client?.events?.on?.("sharedCooldownChanged", onSharedCooldown);
  } catch (_) {}
  const reconcileTimer = setInterval(() => {
    reconcileAttempts++;
    if (reconcileWithServer() || reconcileAttempts > 30) {
      clearInterval(reconcileTimer);
    }
  }, 1000);

  // Opaque API for the context menu (Add To Hotbar flyout) and console.
  // All methods return COPIES of slot data to prevent external mutation;
  // binds go through the same RM→ADD pipeline as the drop path.
  window.__hotbar = Object.freeze({
    getSlot(slotIndex) {
      const i = (slotIndex | 0);
      if (i < 0 || i >= SLOT_COUNT) return null;
      const s = state.slots[i];
      return s ? { ...s } : null;
    },
    bindItemToSlot(slotIndex, guid) {
      const i = (slotIndex | 0);
      const g = (guid >>> 0);
      if (i < 0 || i >= SLOT_COUNT || !g) return false;
      const prev = state.slots[i];
      if (prev) sendRemoveShortcut(i);
      state.slots[i] = { itemGuid: g };
      firstBindAt = Date.now();
      saveState(state);
      renderSlot(i);
      sendAddShortcut(i, g, 0);
      return true;
    },
    bindSpellToSlot(slotIndex, spellId) {
      const i = (slotIndex | 0);
      const s = (spellId | 0);
      if (i < 0 || i >= SLOT_COUNT || !s) return false;
      const prev = state.slots[i];
      if (prev) sendRemoveShortcut(i);
      state.slots[i] = { spellId: s };
      saveState(state);
      renderSlot(i);
      sendAddShortcut(i, 0, s);
      return true;
    },
    removeBinding(slotIndex) {
      const i = (slotIndex | 0);
      if (i < 0 || i >= SLOT_COUNT) return false;
      const prev = state.slots[i];
      state.slots[i] = null;
      saveState(state);
      renderSlot(i);
      if (prev) sendRemoveShortcut(i);
      return true;
    },
    /** First empty VISIBLE slot (row 2 only counts while it is shown),
     *  or null when every visible slot is bound. */
    findFirstEmpty() {
      const n = rowCount * SLOTS_PER_ROW;
      for (let i = 0; i < n; i++) {
        if (!state.slots[i]) return i;
      }
      return null;
    },
    /** Number of slots currently shown (9, or 18 with ShortcutBar2). */
    slotCount() { return rowCount * SLOTS_PER_ROW; },
    getRowCount() { return rowCount; },
    setRowCount(n) { return setRowCount(n); },
    setLocked(locked) { windowCtl.setLocked(!!locked); },
    resetPosition() { windowCtl.resetPosition(); },
  });

  return () => {
    window.removeEventListener("keydown", onKey);
    for (const un of funnelUnbinds) { try { un?.(); } catch (_) {} }
    clearInterval(reconcileTimer);
    clearTimeout(migrateTimer);
    try {
      client?.events?.off?.("playerInventoryChanged", pruneStaleItemBindings);
      client?.events?.off?.("landblockChanged", onLandblockChanged);
      client?.events?.off?.("sharedCooldownChanged", onSharedCooldown);
    } catch (_) {}
    controls.dispose();
    tooltip.dispose();
    overlay.remove();
    try { delete window.__hotbar; } catch (_) { window.__hotbar = undefined; }
  };
}
