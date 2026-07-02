// Hotbar — port of retail gmFloatyToolbarUI (layout 0x21000070, 18
// elements: 1 root + 16 chrome border/corner pieces + 1 inner content
// frame at 0x1000001B). The retail panel is 310×100 with a 5px brass
// 9-slice frame and reserves a 300×122 content area for slots.
//
// `gmFloatyToolbarUI` inherits from `gmToolbarUI` (LayoutDesc
// 0x21000016) which holds the actual hotbar-slot positions: two rows
// of 9 32×32 slots at y=58 and y=90 (slots A7-AF in row 1, B7-BF in
// row 2). Cross-referenced against acclient.c gmToolbarUI::PostInit +
// InitShortcutArray (2026-05-24).
//
// Behaviour (Wave 3.A 2026-05-28 — real fire wiring shipped):
//   - 9 brass-trim slots numbered 1-9 in a horizontal row (row 1 only;
//     row 2 is a follow-on UX expansion). Slot positions and the outer
//     panel dimensions are now driven by the retail LayoutDesc.
//   - Drag-drop a spell from the Spellbook into a slot (uses the
//     existing `application/x-hb-spell-id` mime — same as combat-bar's
//     spell row drag handler).
//   - Drag-drop an item from the Inventory into a slot (uses the
//     existing `application/x-hb-inv-guid` mime — same as picking.js
//     drag-onto-canvas + target-bar drop handlers).
//   - Click a bound slot to fire the bound spell/item; empty slots
//     are no-ops. Fire path mirrors the combat-bar / target-bar
//     contract:
//       * Spell slot, isSelfTargeted=true   → castUntargetedSpell
//         (combat-bar.js:1330 untargeted branch).
//       * Spell slot, isSelfTargeted=false  → castTargetedSpell on the
//         currently-selected entity (matches retail "arm spell then
//         click target" via the soft-target read from
//         entityManager.getSelectedTarget()). No target → chat hint,
//         no wire packet sent.
//       * Item slot                          → sessionHandle.useObject
//         (target-bar.js:388 useBtn handler).
//   - Number key 1-9 fires the matching slot if it's bound. Suppressed
//     while focused on a text input so chat send is not eaten.
//
// Retail click→fire chain reference: acclient.c:239995
// `gmToolbarUI::UseShortcut(slot, i_bUse)` — branches on target-mode
// (armed-spell + selected-target) vs ItemHolder::UseObject(itemID).

import { resolveLocalBinding, matchesBinding, LOCAL_ACTION_IDS } from "../ui/keymap.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";
import {
  attachFloatyFrame,
  resolveFrameSpritesFromLayout,
  TOOLBAR_FRAME_UI_IDS,
} from "../ui/ac_floaty_frame.js";
import { attachDefaultTopDragHandle, WINDOW_ID } from "../ui/ac_window_position.js";
import { resolveBindingIcon } from "../ui/ac_entity_icon.js";
import { fetchIconDataUrl as fetchIconDataUrlShared } from "../ui/ac_icon_cache.js";
import {
  uiEffectIconsEnabled,
  uiEffectIconsFor,
  uiEffectTintCss,
} from "../scene3d/vfx/ui_effects_registry.js";
import { DropItemFlags, isDropAccepted } from "./drop_item_flags.js";
import { canBindToHotbar } from "./inventory_helpers.js";
import { castSpellViaHandle } from "../ui/ac_cast_spell.js";

const OVERLAY_ID = "hb-hotbar";
const WIDTH = 310;
const HEIGHT = 100;           // Retail two-row default (gmFloatyToolbarUI
                              // 0x10000602: 310×100). The retail panel-
                              // button band that retail draws at y=0..57
                              // lives in `target-bar.js` as a separate
                              // overlay in our impl (P2-36 deviation):
                              // PanelButton_Social/Magic/Skill/Quest/
                              // World/Options + Use/Examine/Sel-Object
                              // all map to the target-bar's TOP row + 9
                              // panel shortcuts. Different overlay,
                              // same content; the top 0..57 band of the
                              // hotbar stays empty.
const SLOT_SIZE = 32;         // Retail per gmToolbarUI::InitShortcutArray.
const SLOTS_PER_ROW = 9;
const ROW_COUNT = 2;
const SLOT_COUNT = SLOTS_PER_ROW * ROW_COUNT;

/** gmFloatyToolbarUI — retail layout that drives the hotbar chrome.
 *  Element-id map confirmed by hotbar_layout_dump 2026-05-24:
 *    0x10000602 — root (310×100, 17 children, 2 states for locked/
 *                 unlocked chrome swap)
 *    0x1000001B — inner content frame (5,5) 300×122 (where toolbar
 *                 buttons + slots nest)
 *    Chrome unlocked: 0x10000623-2A (8 borders/corners)
 *    Chrome locked:   0x1000062B-32 (8 mirrored borders/corners)
 */
const HOTBAR_LAYOUT_ID = 0x21000070;
const HOTBAR_ELEM_ROOT          = 0x10000602;
const HOTBAR_ELEM_CONTENT_FRAME = 0x1000001B;

/** gmToolbarUI — parent layout that gmFloatyToolbarUI nests inside its
 *  content frame. Holds the actual slot positions (per retail
 *  gmToolbarUI::PostInit + InitShortcutArray decomp).
 *
 *  9 row-1 slots at y=58, 32×32, spaced 32px apart starting x=6.
 *  (Row 2 at y=90 is a follow-on — current Holtburger impl is
 *  single-row; mapping the row-2 ids here lets future row-toggle
 *  inherit the same wiring without a redesign.)
 */
const TOOLBAR_LAYOUT_ID = 0x21000016;
const TOOLBAR_SLOT_IDS_ROW1 = [
  0x100001A7, 0x100001A8, 0x100001A9, 0x100001AA, 0x100001AB,
  0x100001AC, 0x100001AD, 0x100001AE, 0x100001AF,
];
// ShortcutBar2 row — verified against Chorizite UIElementId.cs
// (ShortcutBar2_Shortcut1Button..ShortcutBar2_Shortcut9Button) and
// acclient.c:240892-241012.
const TOOLBAR_SLOT_IDS_ROW2 = [
  0x100006B7, 0x100006B8, 0x100006B9, 0x100006BA, 0x100006BB,
  0x100006BC, 0x100006BD, 0x100006BE, 0x100006BF,
];
const TOOLBAR_SLOT_IDS_BY_ROW = [TOOLBAR_SLOT_IDS_ROW1, TOOLBAR_SLOT_IDS_ROW2];

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-hotbar-style";
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      bottom: 8px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 50;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      box-sizing: border-box;
      pointer-events: none;
      font-family: var(--hb-font-serif);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      box-shadow: var(--hb-shadow-panel);
    }
    /* Pre-FloatyFrame fallback chrome — visible during the brief window
       between mount and resolveFrameSpritesFromLayout completing. The
       8-piece sprite chrome paints over this once loaded. */
    #${OVERLAY_ID}:not(.hb-floaty-framed) {
      border: 5px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 5 / 5px / 0 stretch;
    }
    /* Row container — absolute-positioned so layout-driven slot
       offsets from gmToolbarUI 0x21000016 can place each slot
       exactly. Defaults centre the 9 slots horizontally at the
       vertical mid-line of the 40px-tall single-row variant; the
       retail layout overrides per-slot x/y/w/h after mount via
       applyHotbarLayout(). */
    #${OVERLAY_ID} .hb-hotbar-row {
      position: absolute;
      top: 5px;
      left: 6px;
      right: 6px;
      bottom: 5px;
      pointer-events: auto;
      /* Above FloatyFrame chrome (z-index:1 on its 8 sprite pieces). */
      z-index: 2;
    }
    #${OVERLAY_ID} .hb-hotbar-slot {
      position: absolute;
      width: ${SLOT_SIZE}px;
      height: ${SLOT_SIZE}px;
      top: 0;
      background: url("./sprites/acsprites/icon-slot-bg.png") center/100% 100% no-repeat;
      cursor: pointer;
      user-select: none;
      pointer-events: auto;
      transition: filter 120ms ease;
      image-rendering: pixelated;
    }
    #${OVERLAY_ID} .hb-hotbar-slot:hover {
      filter: brightness(1.2);
    }
    #${OVERLAY_ID} .hb-hotbar-slot.drag-over {
      filter: drop-shadow(0 0 4px rgba(120, 220, 120, 0.95));
    }
    #${OVERLAY_ID} .hb-hotbar-slot.bound .hb-hotbar-slot-icon {
      opacity: 1;
    }
    #${OVERLAY_ID} .hb-hotbar-slot-icon {
      position: absolute;
      top: 4px; left: 4px;
      right: 4px; bottom: 8px;
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
      opacity: 0;
      pointer-events: none;
    }
    /* Number badge bottom-right of each slot. */
    #${OVERLAY_ID} .hb-hotbar-slot-num {
      position: absolute;
      bottom: 0;
      right: 2px;
      font-size: 9px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 0.85);
      pointer-events: none;
      line-height: 1;
    }

    /* Wave C / PR10 (2026-06-06): hotbar slot click-feedback pulse + flag-
       gated radial cooldown overlay. */
    #${OVERLAY_ID} .hb-hotbar-slot.firing {
      transform: scale(1.1); filter: brightness(1.4);
      transition: transform 50ms ease-out, filter 50ms ease-out;
    }
    #${OVERLAY_ID} .hb-hotbar-slot:not(.firing) {
      transition: transform 90ms ease-out, filter 90ms ease-out;
    }
    /* Rec #75 — compensating-transaction failure flash. Red outline
       held for the same 400 ms window the JS uses for the toast +
       roll-back, then removed by the inline setTimeout. */
    #${OVERLAY_ID} .hb-hotbar-slot.hb-hotbar-swap-fail {
      outline: 2px solid rgba(214, 96, 96, 0.95);
      outline-offset: -2px;
      animation: hb-hotbar-swap-fail-flash 400ms ease-out;
    }
    @keyframes hb-hotbar-swap-fail-flash {
      0%   { background-color: rgba(214, 96, 96, 0.55); }
      100% { background-color: rgba(214, 96, 96, 0.0); }
    }

    /* Cooldown overlay — gated behind localStorage hb-hotbar.cooldown-preview.
       TODO(PR10-followup): wire a server cooldown-update event so this can
       fire unconditionally. Today there's no ACE event that surfaces
       item.NextSpellCastTimestamp to the client, so the overlay is flag-only
       and the JS that toggles .cooldown-active is a follow-on. */
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
  `;
  document.head.appendChild(style);
}

const LS_KEY = "holtburger_hotbar_v1";
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
// `isSelfTargeted` is the spell's per-record flag (from
// SessionHandle::getSpellRecord(spellId).isSelfTargeted). When the spell
// table hasn't loaded yet, pass `true` so the cast defaults to self —
// matches the JSON-catalog default in plugins/spellbook.js:165.
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
  version: "0.1.0",
  description: "Bottom-center 1-9 hotbar (gmFloatyToolbarUI 0x21000070)",
};

// Apply retail layout positions for the hotbar overlay + 9 slot
// elements. Mirrors radar.js applyRadarLayout — hotbar mounts during
// early boot via the plugin bar (before `init_resource_source`
// populates window.__hbWasm), so we retry every 2s up to 8 times
// (~16s total) before giving up on the layout fetch.
//
// gmFloatyToolbarUI (0x21000070) drives outer panel dimensions; gm
// ToolbarUI (0x21000016) drives the per-slot row-1 positions. Both
// load in parallel.
function applyHotbarLayout(refs, attempt = 0) {
  const apply = ([floaty, toolbar]) => {
    if (!floaty && !toolbar) {
      if (attempt < 8) {
        setTimeout(() => applyHotbarLayout(refs, attempt + 1), 2000);
      }
      return;
    }
    let applied = 0;
    let slotUpdates = 0;
    // Outer panel — root element 0x10000602 (310×100). Apply WIDTH
    // only; retail's 100px height covers TWO rows of 32×32 slots +
    // the panel buttons + sel-object field (the full retail UI). Our
    // single-row implementation is intentionally 40px tall (one slot
    // row + 5px chrome) — overriding HEIGHT would push the bottom-
    // anchored overlay upward and reveal the slots' empty space.
    // Divergence noted in handoff.
    if (floaty && refs.overlayEl) {
      const root = findElementById(floaty, HOTBAR_ELEM_ROOT);
      if (root && typeof root.width === "number") {
        refs.overlayEl.style.width = `${root.width}px`;
        applied += 1;
      }
      // Content frame 0x1000001B at (5,5) 300×122 — the area where
      // slot grid nests. With FloatyFrame chrome the 5px gutter is
      // owned by the absolutely-positioned sprite divs (TL/T/TR/L/BL/
      // B/BR/R), so the row container starts at (5, 5) instead of
      // (0, 0).
      const content = findElementById(floaty, HOTBAR_ELEM_CONTENT_FRAME);
      if (content && refs.rowEl) {
        refs.rowEl.style.left = "5px";
        refs.rowEl.style.top = "5px";
        if (typeof content.width === "number") refs.rowEl.style.width = `${content.width}px`;
        refs.rowEl.style.right = "";
        refs.rowEl.style.bottom = "";
        applied += 1;
      }
      // P0-3 / task #14 proof — attach retail 8-piece chrome from the
      // DAT. Sprites resolved via the StateDesc emission shipped in
      // task #1 (lib.rs fetch_layout v3). Idempotent via the
      // hb-floaty-framed class so retries don't double-attach.
      if (!refs.overlayEl.classList.contains("hb-floaty-framed")) {
        const sprites = resolveFrameSpritesFromLayout(floaty, TOOLBAR_FRAME_UI_IDS);
        if (sprites) {
          attachFloatyFrame(refs.overlayEl, {
            unlocked: sprites.unlocked,
            locked: sprites.locked,
            cornerSize: 5,
            borderThickness: 5,
            // No windowId yet — toolbar's `m_eWindowID` isn't in
            // WINDOW_ID yet. Wire up when hotbar adopts the window-
            // position adapter (task #15).
          });
          refs.overlayEl.classList.add("hb-floaty-framed");
          applied += 1;
          try {
            window.__diag?.layout?.onHotbarFloatyFrame?.({
              unlocked: sprites.unlocked, locked: sprites.locked,
            });
          } catch (_) {}
        }
      }
    }
    // Per-slot positions — relative to gmToolbarUI's root frame at
    // (0,0). Row 1: y=58, x=6,38,70,102,134,166,198,230,262; each
    // 32×32 (stride 32). Row 2: y=90, same x pattern. Our row
    // container sits at the gmFloaty content-frame origin (5,5 in
    // overlay coords); layout x/y are relative to gmToolbarUI's 0,0
    // which retail nests INSIDE the gmFloaty content frame — so
    // layout (x,y) lands directly on the row container.
    //
    // We DO apply desc.y now (vs the prior single-row "rebase to 0"
    // hack) so row 1 and row 2 sit at the retail-correct vertical
    // positions. The top 0..57 band is reserved for panel buttons
    // (cross-find P2 follow-up; empty until then).
    if (toolbar && refs.slotEls) {
      let flat = 0;
      for (let row = 0; row < TOOLBAR_SLOT_IDS_BY_ROW.length; row++) {
        const ids = TOOLBAR_SLOT_IDS_BY_ROW[row];
        for (let i = 0; i < ids.length; i++, flat++) {
          const slotEl = refs.slotEls[flat];
          if (!slotEl) continue;
          const desc = findElementById(toolbar, ids[i]);
          if (!desc) continue;
          if (typeof desc.x === "number") slotEl.style.left = `${desc.x}px`;
          if (typeof desc.y === "number") slotEl.style.top = `${desc.y}px`;
          if (typeof desc.width === "number") slotEl.style.width = `${desc.width}px`;
          if (typeof desc.height === "number") slotEl.style.height = `${desc.height}px`;
          slotUpdates += 1;
        }
      }
    }
    try {
      window.__diag?.layout?.onHotbarApplied?.({ applied, slotUpdates });
    } catch (_) {}
  };
  const cachedFloaty = getCachedLayout(HOTBAR_LAYOUT_ID);
  const cachedToolbar = getCachedLayout(TOOLBAR_LAYOUT_ID);
  if (cachedFloaty && cachedToolbar) { apply([cachedFloaty, cachedToolbar]); return; }
  Promise.all([
    loadLayout(HOTBAR_LAYOUT_ID),
    loadLayout(TOOLBAR_LAYOUT_ID),
  ]).then(apply).catch(() => {
    // Failure path — neither layout could load. Retry if attempts left.
    if (attempt < 8) {
      setTimeout(() => applyHotbarLayout(refs, attempt + 1), 2000);
    }
  });
}

export function mount(ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  const row = document.createElement("div");
  row.className = "hb-hotbar-row";
  overlay.appendChild(row);

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
      const el = state.slotEls?.[slotIndex];
      if (!el) return;
      el.classList.add("hb-hotbar-swap-fail");
      setTimeout(() => { try { el.classList.remove("hb-hotbar-swap-fail"); } catch (_) {} }, 400);
    } catch (_) {}
  }
  function _swapToast(text) {
    try {
      const ov = state.overlayEl ?? document.getElementById(OVERLAY_ID);
      if (!ov) return;
      const old = ov.querySelector(".hb-hotbar-toast");
      if (old) old.remove();
      const t = document.createElement("div");
      t.className = "hb-hotbar-toast";
      t.style.cssText =
        "position:absolute;left:50%;bottom:-22px;transform:translateX(-50%);" +
        "padding:3px 8px;font-size:10px;background:rgba(20,14,8,0.92);" +
        "border:1px solid var(--hb-border-brass,#b08a4a);color:var(--hb-text-warn,#d6a060);" +
        "pointer-events:none;z-index:5;white-space:nowrap;";
      t.textContent = text;
      ov.appendChild(t);
      setTimeout(() => { try { t.remove(); } catch (_) {} }, 1800);
    } catch (_) {}
  }

  function renderSlot(idx) {
    const el = slotEls[idx];
    const bound = state.slots[idx];
    el.classList.toggle("bound", !!bound);
    const icon = el.querySelector(".hb-hotbar-slot-icon");
    if (!bound) {
      icon.style.backgroundImage = "";
      icon.style.opacity = "0";
      icon.dataset.boundKey = "";
      return;
    }
    // P1-23 (cross-find hotbar-slot-icon-placeholder): resolve the
    // bound spell/item to its real DAT icon via the shared resolver.
    // The compass-disk placeholder paints until the async fetch lands
    // — then the data-URL background replaces it. boundKey guards
    // against races where renderSlot is called repeatedly while the
    // promise is still in flight.
    icon.style.backgroundImage = "url('./data/ui-sprites/0x06004CC1.png')";
    icon.style.opacity = "1";
    const key = bound.spellId
      ? `spell:${bound.spellId}`
      : `item:${bound.itemGuid}`;
    icon.dataset.boundKey = key;
    resolveBindingIcon(bound).then((url) => {
      // Bail if the slot got re-bound while we were fetching.
      if (icon.dataset.boundKey !== key) return;
      if (url) icon.style.backgroundImage = `url("${url}")`;
    }).catch(() => { /* shared helper logs; placeholder stays */ });

    // Track A (?uiEffectIcons, default OFF): UiEffects magic-effect badge for an
    // ITEM binding (potions/wands etc.). Same registry + real icon (0x25000009)
    // + tint fallback as inventory/container. Re-render clears the prior badge.
    // `.hb-hotbar-slot` is position:relative. DOM-only; flag-off no-op.
    const prevFx = el.querySelector(".hb-hotbar-uifx");
    if (prevFx) prevFx.remove();
    if (uiEffectIconsEnabled() && bound.itemGuid) {
      const uiFx = uiEffectIconsFor(_itemUiEffects(bound.itemGuid));
      if (uiFx.length) {
        const fxWrap = document.createElement("span");
        fxWrap.className = "hb-hotbar-uifx";
        fxWrap.style.cssText =
          "position:absolute;top:1px;left:1px;display:flex;gap:2px;pointer-events:none;z-index:4;";
        for (const f of uiFx) {
          const dot = document.createElement("span");
          dot.title = f.name;
          dot.style.cssText =
            "width:11px;height:11px;border-radius:3px;border:1px solid rgba(0,0,0,0.55);" +
            `background:${uiEffectTintCss(f.tint)} center/contain no-repeat;`;
          fxWrap.appendChild(dot);
          if (f.iconDid) {
            fetchIconDataUrlShared(f.iconDid >>> 0).then((url) => {
              if (url && dot.isConnected) dot.style.background = `url("${url}") center/contain no-repeat`;
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

  // Read the soft-target GUID — the most recently clicked entity in the
  // 3D scene (set by picking.js#onPointerDown → entityManager.set
  // SelectedTarget). Mirrors target-bar.js#getSelectedTargetGuid (line
  // 261) and combat-bar.js's armed-spell fire path (which reads the
  // same GUID indirectly via the picking.js click handler).
  function getSoftTargetGuid() {
    try {
      const em = window.liveScene3d?.entityManager;
      return (em?.getSelectedTarget?.() ?? 0) >>> 0;
    } catch {
      return 0;
    }
  }

  // Mirror a single visibility line to the existing chat-log overlay.
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
      if (dirty) { saveState(state); for (let i = 0; i < SLOT_COUNT; i++) renderSlot(i); }
    } catch (_) {}
  }
  setTimeout(migrateClearContainerBindings, 1500);

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
      logToChat(
        `Hotbar ${idx + 1}: cast spell 0x${armed.toString(16).toUpperCase()} on item 0x${bound.itemGuid.toString(16).toUpperCase()}`,
      );
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
    // accessor when available. SessionHandle::getSpellRecord returns
    // null pre-WorldBootstrap and throws when the SpellTable isn't
    // loaded — fall back to true (self-cast) in both cases. This
    // matches the JSON-catalog default in plugins/spellbook.js (the
    // legacy `untargeted` field defaults true when a spell record
    // omits `isSelfTargeted`).
    let isSelfTargeted = true;
    if (bound.spellId) {
      try {
        const rec = handle?.getSpellRecord?.(bound.spellId);
        if (rec && typeof rec.isSelfTargeted === "boolean") {
          isSelfTargeted = rec.isSelfTargeted;
        }
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
          logToChat(
            `Hotbar ${idx + 1}: use item 0x${action.itemGuid.toString(16).toUpperCase()}`,
          );
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
          logToChat(
            `Hotbar ${idx + 1}: cast spell 0x${action.spellId.toString(16).toUpperCase()} on self`,
          );
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
          logToChat(
            `Hotbar ${idx + 1}: cast spell 0x${action.spellId.toString(16).toUpperCase()} on 0x${action.targetGuid.toString(16).toUpperCase()}`,
          );
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
        logToChat(
          `Hotbar ${idx + 1}: spell 0x${action.spellId.toString(16).toUpperCase()} needs a target — click an entity first`,
        );
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
    const rowIdx = Math.floor(i / SLOTS_PER_ROW);
    const colIdx = i % SLOTS_PER_ROW;
    el.dataset.row = String(rowIdx);
    // Default absolute-positioned layout (CSS fallback). The retail
    // layout overrides these via applyHotbarLayout() after mount.
    // Stride: SLOT_SIZE px starting at x=6 (retail x positions
    // 6,38,70,102,...). Row spacing: 32px vertical stride starting at
    // y=58 to mirror retail (panel buttons fill 0..57).
    el.style.left = `${6 + colIdx * SLOT_SIZE}px`;
    el.style.top = `${58 + rowIdx * SLOT_SIZE}px`;

    const icon = document.createElement("div");
    icon.className = "hb-hotbar-slot-icon";
    el.appendChild(icon);

    const num = document.createElement("ac-text");
    num.className = "hb-hotbar-slot-num";
    // Retail draws 1..9 on row 1 only; row 2 is unlabeled (user
    // assigns keys via Options → Controls, so the number isn't
    // meaningful).
    num.textContent = rowIdx === 0 ? String(colIdx + 1) : "";
    el.appendChild(num);

    // Click → fire. Suppress synthetic click immediately after dragend.
    el.addEventListener("click", () => {
      if (el._dragging) return;
      fireSlot(i);
    });

    // Drag-drop MIMEs accepted by hotbar slots:
    //   application/x-hb-spell-id      from spellbook + combat-bar
    //   application/x-hb-inv-guid      from inventory (item bind)
    //   application/x-hb-hotbar-slot   hotbar↔hotbar slot swap (NEW)
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
      // Wave C / PR9 (2026-06-06): iconId-driven Image ghost. The hotbar
      // slot's .hb-hotbar-icon child carries the background-image url;
      // pull it through a new Image so the ghost reads as a 32x32
      // sprite instead of the full slot DOM.
      try {
        const iconEl = el.querySelector?.(".hb-hotbar-icon");
        const bg = iconEl ? getComputedStyle(iconEl).backgroundImage : "";
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
    // Wave C / PR10 (2026-06-06): retail click-feedback pulse. The .firing
    // class triggers a 50ms scale 1.1 + brightness 1.4 then snaps back.
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
        }
      }
    });

    // Right-click → polymorphic context menu. Legacy destructive
    // clear is gone — Remove Binding lives in the menu now.
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

    row.appendChild(el);
    slotEls.push(el);
    renderSlot(i);
  }

  document.body.appendChild(overlay);
  attachDefaultTopDragHandle(overlay, WINDOW_ID.HOTBAR);

  // Apply retail layout positions for the panel + slot row. Mounts
  // via the bar before wasm is ready; the helper handles retries.
  // The hand-tuned defaults (310×40 panel, 32px slot stride) stay in
  // effect if both layouts fail to load.
  applyHotbarLayout({
    overlayEl: overlay,
    rowEl: row,
    slotEls,
  });

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
        fireSlot(slot - 1);
        return;
      }
    }
    // Row 2 — `HOTBAR_R2_1`..`HOTBAR_R2_9`, no default code (null).
    for (let slot = 1; slot <= SLOTS_PER_ROW; slot++) {
      const binding = resolveLocalBinding(LOCAL_ACTION_IDS[`HOTBAR_R2_${slot}`], null);
      if (binding && matchesBinding(ev, binding)) {
        if (digitInMagic(binding)) return;
        fireSlot(SLOTS_PER_ROW + slot - 1);
        return;
      }
    }
  }
  window.addEventListener("keydown", onKey);

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
  try {
    const client = ctx?.client ?? window.__pluginClient;
    client?.events?.on?.("playerInventoryChanged", pruneStaleItemBindings);
    client?.events?.on?.("landblockChanged", () => { inWorld = true; });
    // HUD rec #84 (2026-06-16): toggle the .cooldown-active class on
    // every hotbar slot whenever the wasm side flags a shared-cooldown
    // change. The radial overlay CSS (line 218 / .cooldown-active
    // ::after at line 223) is already in place — the TODO at line
    // 219-222 specifically called out the missing event wiring.
    // Future refinement: per-slot cooldown gating using
    // handle.playerEnchantments() filtered by COOLDOWN bit (0x1000000)
    // matched against each slot's bound spell-id.
    client?.events?.on?.("sharedCooldownChanged", (e) => {
      const active = ((e?.activeCount ?? e?.detail?.activeCount) ?? 0) >>> 0;
      const overlay = document.getElementById(OVERLAY_ID);
      if (!overlay) return;
      for (const slot of overlay.querySelectorAll(".hb-hotbar-slot")) {
        slot.classList.toggle("cooldown-active", active > 0);
      }
    });
  } catch (_) {}
  const reconcileTimer = setInterval(() => {
    reconcileAttempts++;
    if (reconcileWithServer() || reconcileAttempts > 30) {
      clearInterval(reconcileTimer);
    }
  }, 1000);

  // Opaque API for the context menu (Add To Hotbar flyout). All methods
  // return COPIES of slot data to prevent external mutation; binds go
  // through the same RM→ADD pipeline as the drop path.
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
    findFirstEmpty() {
      for (let i = 0; i < SLOT_COUNT; i++) {
        if (!state.slots[i]) return i;
      }
      return null;
    },
  });

  return () => {
    window.removeEventListener("keydown", onKey);
    clearInterval(reconcileTimer);
    overlay.remove();
    try { delete window.__hotbar; } catch (_) { window.__hotbar = undefined; }
  };
}
