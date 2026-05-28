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
    } else if (bound && bound.itemGuid) {
      // Item icon — generic placeholder (full per-item icon resolution
      // requires hooking through entity-manager's item-icon cache, a
      // follow-on UX polish). The bound-state highlight on the slot
      // border is enough to signal "this slot holds an item".
      icon.style.backgroundImage = "url('./data/ui-sprites/0x06004CC1.png')";
      icon.style.opacity = "1";
    } else {
      icon.style.backgroundImage = "";
      icon.style.opacity = "0";
    }
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

  function fireSlot(idx) {
    const bound = state.slots[idx];
    if (!bound) return;
    const client = ctx?.client ?? window.__pluginClient ?? null;
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
    const action = decideFireAction(bound, {
      isSelfTargeted,
      softTargetGuid: getSoftTargetGuid(),
    });

    switch (action.kind) {
      case "useItem": {
        // Item slot — straight UseObject. Matches target-bar.js:388
        // (Use Selected button) and retail acclient.c:240034
        // `ItemHolder::UseObject(itemID, 0, 0)` (UseShortcut's
        // i_bUse=true branch). ACE handles the rest server-side
        // (potion drink, portal gem teleport, tinker UI open, etc.).
        if (typeof handle?.useObject !== "function") {
          logToChat(`Hotbar ${idx + 1}: not logged in — useObject unavailable`);
          return;
        }
        try {
          handle.useObject(action.itemGuid);
          logToChat(
            `Hotbar ${idx + 1}: use item 0x${action.itemGuid.toString(16).toUpperCase()}`,
          );
        } catch (e) {
          logToChat(`Hotbar ${idx + 1}: useObject failed — ${e?.message ?? e}`);
        }
        return;
      }
      case "castSelf": {
        if (typeof client?.player?.castSpell !== "function") {
          logToChat(`Hotbar ${idx + 1}: not logged in — castSpell unavailable`);
          return;
        }
        try {
          client.player.castSpell(action.spellId, null);
          logToChat(
            `Hotbar ${idx + 1}: cast spell 0x${action.spellId.toString(16).toUpperCase()} on self`,
          );
        } catch (e) {
          logToChat(`Hotbar ${idx + 1}: cast failed — ${e?.message ?? e}`);
        }
        return;
      }
      case "castOnTarget": {
        if (typeof client?.player?.castSpell !== "function") {
          logToChat(`Hotbar ${idx + 1}: not logged in — castSpell unavailable`);
          return;
        }
        try {
          client.player.castSpell(action.spellId, action.targetGuid);
          logToChat(
            `Hotbar ${idx + 1}: cast spell 0x${action.spellId.toString(16).toUpperCase()} on 0x${action.targetGuid.toString(16).toUpperCase()}`,
          );
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
    // Inventory uses "application/x-hb-inv-guid" (per inventory.js:904 and
    // picking.js's canvas-drop give path). The hotbar accepts either kind.
    function dragHasAcceptedType(types) {
      if (!types) return false;
      const arr = Array.from(types);
      return arr.includes("application/x-hb-spell-id")
          || arr.includes("application/x-hb-inv-guid");
    }
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
        state.slots[i] = { spellId: Number(sid) };
        saveState(state);
        renderSlot(i);
        return;
      }
      if (iguid) {
        ev.preventDefault();
        const guid = parseInt(iguid, 10) >>> 0;
        if (guid > 0) {
          state.slots[i] = { itemGuid: guid };
          saveState(state);
          renderSlot(i);
        }
      }
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
