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
// First-pass behaviour:
//   - 9 brass-trim slots numbered 1-9 in a horizontal row (row 1 only;
//     row 2 is a follow-on UX expansion). Slot positions and the outer
//     panel dimensions are now driven by the retail LayoutDesc.
//   - Drag-drop a spell from the Spellbook into a slot (uses the
//     existing `application/x-hb-spell-id` mime — same as combat-bar's
//     spell row drag handler).
//   - Click a bound slot to fire the bound spell/item; empty slots
//     are no-ops. Real fire wiring (cast spell / use item) is a
//     follow-on; for now it just logs via the chat-log.
//   - Number key 1-9 fires the matching slot if it's bound.

import { resolveLocalBinding, matchesBinding, LOCAL_ACTION_IDS } from "../ui/keymap.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";

const OVERLAY_ID = "hb-hotbar";
const WIDTH = 310;
const HEIGHT = 40;            // single-row variant; retail's 100 is the
                              // two-row default. Stick to one row until
                              // we expose row-toggle.
const SLOT_SIZE = 30;
const SLOT_COUNT = 9;

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
      border: 5px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 5 / 5px / 0 stretch;
      box-shadow: var(--hb-shadow-panel);
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
  `;
  document.head.appendChild(style);
}

const LS_KEY = "holtburger_hotbar_v1";
function loadState() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || { slots: Array(SLOT_COUNT).fill(null) }; }
  catch (_) { return { slots: Array(SLOT_COUNT).fill(null) }; }
}
function saveState(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (_) {}
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
      // slot grid nests. The retail (5,5) inset is the FRAME WIDTH;
      // our overlay CSS already draws this via `border: 5px solid
      // transparent` + border-image (brass 9-slice). Absolute-
      // positioned children measure from the PADDING edge (inside
      // the border), so we use (0, 0) to land at the same retail
      // anatomy without double-counting the inset.
      const content = findElementById(floaty, HOTBAR_ELEM_CONTENT_FRAME);
      if (content && refs.rowEl) {
        refs.rowEl.style.left = "0px";
        refs.rowEl.style.top = "0px";
        if (typeof content.width === "number") refs.rowEl.style.width = `${content.width}px`;
        // Don't override height — content frame (122) is taller than
        // our single-row variant. Keep our compact height for now.
        refs.rowEl.style.right = "";
        refs.rowEl.style.bottom = "";
        applied += 1;
      }
    }
    // Per-slot positions — relative to gmToolbarUI's root frame at
    // (0,0). Row 1: y=58, x=6,38,70,102,134,166,198,230,262; each
    // 32×32 (stride 32). Our row container sits at the gmFloaty
    // content-frame origin (5,5 in overlay coords), and layout x
    // values are relative to gmToolbarUI's 0,0 which retail nests
    // INSIDE the gmFloaty content frame — so layout x is directly
    // row-relative.
    //
    // y is rebased to 0: retail puts slots at y=58 because rows
    // 0..57 carry panel buttons + sel-object field. Our compact
    // single-row variant lifts slots to the row top.
    if (toolbar && refs.slotEls) {
      for (let i = 0; i < TOOLBAR_SLOT_IDS_ROW1.length; i++) {
        const slotEl = refs.slotEls[i];
        if (!slotEl) continue;
        const desc = findElementById(toolbar, TOOLBAR_SLOT_IDS_ROW1[i]);
        if (!desc) continue;
        if (typeof desc.x === "number") slotEl.style.left = `${desc.x}px`;
        if (typeof desc.width === "number") slotEl.style.width = `${desc.width}px`;
        if (typeof desc.height === "number") slotEl.style.height = `${desc.height}px`;
        // y intentionally NOT applied — keep top:0 from CSS so the
        // single-row variant doesn't carry the 58px panel-button
        // offset from retail.
        slotUpdates += 1;
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

  function renderSlot(idx) {
    const el = slotEls[idx];
    const bound = state.slots[idx];
    el.classList.toggle("bound", !!bound);
    const icon = el.querySelector(".hb-hotbar-slot-icon");
    if (bound && bound.spellId) {
      // Spell icon — try our spell-component icon table; fall back to
      // a generic spell glyph.
      icon.style.backgroundImage = "url('./data/ui-sprites/0x06004CC1.png')"; // compass disk as placeholder
      icon.style.opacity = "1";
    } else {
      icon.style.backgroundImage = "";
      icon.style.opacity = "0";
    }
  }

  function fireSlot(idx) {
    const bound = state.slots[idx];
    if (!bound) return;
    const client = ctx?.client ?? window.__pluginClient ?? null;
    if (bound.spellId && client?.player?.castSpell) {
      try { client.player.castSpell(bound.spellId); } catch (_) {}
    }
    // Mirror to chat for visibility.
    const src = document.getElementById("chat-log");
    if (src) {
      const li = document.createElement("li");
      li.dataset.cat = "0";
      li.className = "cat-0";
      li.textContent = `Hotbar ${idx + 1}: fired ${bound.spellId ? `spell 0x${bound.spellId.toString(16)}` : "(unbound)"}`;
      src.appendChild(li);
    }
  }

  for (let i = 0; i < SLOT_COUNT; i++) {
    const el = document.createElement("div");
    el.className = "hb-hotbar-slot";
    el.dataset.slot = String(i);
    // Default absolute-positioned layout (CSS fallback). The retail
    // layout overrides these via applyHotbarLayout() after mount.
    // Spacing: SLOT_SIZE + 2px gap = 32px stride starting at x=0.
    el.style.left = `${i * (SLOT_SIZE + 2)}px`;

    const icon = document.createElement("div");
    icon.className = "hb-hotbar-slot-icon";
    el.appendChild(icon);

    const num = document.createElement("ac-text");
    num.className = "hb-hotbar-slot-num";
    num.textContent = String(i + 1);
    el.appendChild(num);

    // Click → fire.
    el.addEventListener("click", () => fireSlot(i));

    // Drag-drop: spellbook + combat-bar use mime "application/x-hb-spell-id".
    el.addEventListener("dragenter", (ev) => {
      const types = ev.dataTransfer?.types;
      if (types && Array.from(types).includes("application/x-hb-spell-id")) {
        ev.preventDefault();
        el.classList.add("drag-over");
      }
    });
    el.addEventListener("dragover", (ev) => {
      const types = ev.dataTransfer?.types;
      if (types && Array.from(types).includes("application/x-hb-spell-id")) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
      }
    });
    el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
    el.addEventListener("drop", (ev) => {
      el.classList.remove("drag-over");
      const sid = ev.dataTransfer?.getData("application/x-hb-spell-id");
      if (!sid) return;
      ev.preventDefault();
      state.slots[i] = { spellId: Number(sid) };
      saveState(state);
      renderSlot(i);
    });

    // Right-click → clear slot.
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      state.slots[i] = null;
      saveState(state);
      renderSlot(i);
    });

    row.appendChild(el);
    slotEls.push(el);
    renderSlot(i);
  }

  document.body.appendChild(overlay);

  // Apply retail layout positions for the panel + slot row. Mounts
  // via the bar before wasm is ready; the helper handles retries.
  // The hand-tuned defaults (310×40 panel, 32px slot stride) stay in
  // effect if both layouts fail to load.
  applyHotbarLayout({
    overlayEl: overlay,
    rowEl: row,
    slotEls,
  });

  // Hotbar slot keys 1-9 (default Digit1..Digit9). User-rebindable
  // via Options → Controls → Local Actions. Suppress while focused
  // on a text input (chat send, etc.).
  function onKey(ev) {
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    for (let slot = 1; slot <= SLOT_COUNT; slot++) {
      const binding = resolveLocalBinding(LOCAL_ACTION_IDS[`HOTBAR_${slot}`], `Digit${slot}`);
      if (matchesBinding(ev, binding)) {
        fireSlot(slot - 1);
        return;
      }
    }
  }
  window.addEventListener("keydown", onKey);

  return () => {
    window.removeEventListener("keydown", onKey);
    overlay.remove();
  };
}
