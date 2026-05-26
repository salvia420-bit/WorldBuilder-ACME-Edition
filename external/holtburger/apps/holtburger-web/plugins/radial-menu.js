// Wave B3 — right-click context menu (retail's "radial" was internally a
// vertical entry list; we adopt the same pattern). Spawned by
// scene3d/camera.js's onMouseUp when a right-click-no-drag lands on an
// entity. Replaces Wave A3's direct __showExamineFor invocation.
//
// Entry-point: window.__openRadialMenuFor(guid, clientX, clientY).
// Closes on: outside click, Escape, entry selection, right-click again.

import { setAcText } from "../ui/ac_font.js";

const OVERLAY_ID = "hb-radial-menu";
const STYLE_ID = "hb-radial-menu-style";

const ITEM_TYPE_CREATURE = 0x00000010;
const ODF_PLAYER = 0x00000008;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      z-index: 80;
      min-width: 100px;
      padding: 2px 0;
      font-family: var(--hb-font-serif);
      background: rgba(20, 14, 8, 0.94);
      border: 1px solid var(--hb-border-brass);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
      user-select: none;
      pointer-events: auto;
    }
    #${OVERLAY_ID} .hb-rm-header {
      padding: 2px 8px 3px;
      border-bottom: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-gold);
      font-size: 11px;
      letter-spacing: 0.02em;
      max-width: 240px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${OVERLAY_ID} .hb-rm-item {
      padding: 2px 12px;
      height: 18px;
      line-height: 18px;
      color: var(--hb-text-cream);
      font-size: 12px;
      cursor: pointer;
    }
    #${OVERLAY_ID} .hb-rm-item:hover,
    #${OVERLAY_ID} .hb-rm-item[data-focus="1"] {
      background: var(--hb-overlay-hover);
      color: var(--hb-text-cream-bright);
    }
    #${OVERLAY_ID} .hb-rm-item[data-focus="1"]:active {
      background: var(--hb-overlay-active);
    }
  `;
  document.head.appendChild(s);
}

let state = {
  overlayEl: null,
  guid: 0,
  items: [],
  focusIdx: -1,
  onKeyDown: null,
  onDocMouseDown: null,
  onContextMenu: null,
};

function closeMenu() {
  if (!state.overlayEl) return;
  if (state.onKeyDown) document.removeEventListener("keydown", state.onKeyDown, true);
  if (state.onDocMouseDown) document.removeEventListener("mousedown", state.onDocMouseDown, true);
  if (state.onContextMenu) document.removeEventListener("contextmenu", state.onContextMenu, true);
  state.overlayEl.remove();
  state.overlayEl = null;
  state.items = [];
  state.focusIdx = -1;
  state.onKeyDown = null;
  state.onDocMouseDown = null;
  state.onContextMenu = null;
  state.guid = 0;
}

function setFocus(idx) {
  state.focusIdx = idx;
  if (!state.overlayEl) return;
  const rows = state.overlayEl.querySelectorAll(".hb-rm-item");
  rows.forEach((r, i) => {
    if (i === idx) r.dataset.focus = "1";
    else delete r.dataset.focus;
  });
}

function moveFocus(delta) {
  if (state.items.length === 0) return;
  let i = state.focusIdx;
  if (i < 0) i = delta > 0 ? 0 : state.items.length - 1;
  else i = (i + delta + state.items.length) % state.items.length;
  setFocus(i);
}

function activateFocused() {
  if (state.focusIdx < 0 || state.focusIdx >= state.items.length) return;
  const item = state.items[state.focusIdx];
  closeMenu();
  try { item.action(); } catch (e) { console.warn("[radial-menu] action threw:", e); }
}

function getEntity(guid) {
  try {
    const em = window.liveScene3d?.entityManager;
    return em?.entityMap?.get?.(guid >>> 0) || null;
  } catch (_) { return null; }
}

function isCreature(ent) {
  const it = (ent?.meta?.itemType >>> 0) || 0;
  if (it && (it & ITEM_TYPE_CREATURE)) return true;
  return ent?.meta?.category === "creature";
}

// Canonical Player marker is the Chorizite-port classifier: WorldObjectManager
// runs canonicalClassify(itemType, objDescFlags, weenieFlags) on kind=1 spawn
// and stores the result on the typed WorldObject. We consult __wom first;
// fall back to ODF_PLAYER bit on meta.objDescFlags if WOM isn't populated.
function isPlayer(guid, ent) {
  try {
    const wo = window.__wom?.get?.(guid >>> 0);
    if (wo && (wo.canonicalObjectClass === "Player" || wo.className === "Player")) return true;
  } catch (_) { /* fall through */ }
  const odf = (ent?.meta?.objDescFlags >>> 0) || 0;
  return (odf & ODF_PLAYER) !== 0;
}

// Cross-reference the 3D-entity guid against the wasm-side inventory
// snapshot — the entity's own meta doesn't carry inventory state
// (equipMask, container), so playerInventory() is the canonical signal
// for "is this thing in my pack/equipped".
function getInventoryItem(guid) {
  try {
    const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
    if (typeof handle?.playerInventory !== "function") return null;
    const g = guid >>> 0;
    const items = handle.playerInventory();
    return items.find((it) => (it.guid >>> 0) === g) || null;
  } catch (_) { return null; }
}

function buildItems(guid) {
  const items = [];
  const ent = getEntity(guid);
  const invItem = getInventoryItem(guid);
  const invEquipMask = (invItem?.equipMask >>> 0) || 0;
  const isEquipped = invItem !== null && invEquipMask !== 0;
  const isInPack = invItem !== null && invEquipMask === 0;

  items.push({
    label: "Examine",
    action: () => {
      if (typeof window.__showExamineFor === "function") window.__showExamineFor(guid);
    },
  });

  if (isInPack && typeof window.__sessionHandle?.wieldFromPack === "function") {
    // Slot hint: prefer the entity meta's equipMask (future PublicWeenieDescription
    // surfaces ValidLocations); fall back to 0 so ACE picks the default slot.
    const slotMask = (ent?.meta?.equipMask >>> 0) || 0;
    items.push({
      label: "Wield",
      action: () => {
        try { window.__sessionHandle.wieldFromPack(guid >>> 0, slotMask); }
        catch (e) { console.warn("[radial-menu] wieldFromPack failed:", e); }
      },
    });
  }

  if (typeof window.__sessionHandle?.useObject === "function") {
    items.push({
      label: "Use",
      action: () => {
        try { window.__sessionHandle.useObject(guid >>> 0); }
        catch (e) { console.warn("[radial-menu] useObject failed:", e); }
      },
    });
  }

  if ((isInPack || isEquipped) && typeof window.__sessionHandle?.dropItem === "function") {
    items.push({
      label: "Drop",
      action: () => {
        try { window.__sessionHandle.dropItem(guid >>> 0); }
        catch (e) { console.warn("[radial-menu] dropItem failed:", e); }
      },
    });
  }

  const localPlayerGuid = (typeof window.getLocalPlayerGuid === "function")
    ? (window.getLocalPlayerGuid() >>> 0)
    : 0;
  if (isPlayer(guid, ent)
      && guid !== localPlayerGuid
      && typeof window.__sessionHandle?.openTrade === "function") {
    items.push({
      label: "Trade",
      action: () => {
        try { window.__sessionHandle.openTrade(guid >>> 0); }
        catch (e) { console.warn("[radial-menu] openTrade failed:", e); }
      },
    });
  }

  const stanceLow = (typeof window.__getCurrentStanceLow === "function")
    ? (window.__getCurrentStanceLow() >>> 0)
    : 0;
  if (isCreature(ent) && stanceLow !== 0 && typeof window.__fireAttackOnTarget === "function") {
    items.push({
      label: "Attack",
      action: () => {
        try {
          window.liveScene3d?.entityManager?.setSelectedTarget?.(guid >>> 0);
          window.__fireAttackOnTarget();
        } catch (e) { console.warn("[radial-menu] attack failed:", e); }
      },
    });
  }

  // Drop/Wield wired via Wave G1, Trade wired via Wave D2 + J2.
  return { items, ent };
}

function openRadialMenuFor(guid, clientX, clientY) {
  closeMenu();
  ensureStyles();
  const g = (guid >>> 0) || 0;
  if (!g) return;
  const { items, ent } = buildItems(g);
  if (items.length === 0) return;

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  const name = ent?.meta?.name || `0x${g.toString(16).toUpperCase().padStart(8, "0")}`;
  const header = document.createElement("div");
  header.className = "hb-rm-header";
  setAcText(header, name);
  overlay.appendChild(header);

  items.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "hb-rm-item";
    setAcText(row, it.label);
    row.addEventListener("mouseenter", () => setFocus(idx));
    row.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      setFocus(idx);
      activateFocused();
    });
    overlay.appendChild(row);
  });

  // Suppress browser context menu inside the overlay.
  overlay.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ev.stopPropagation(); });

  document.body.appendChild(overlay);
  state.overlayEl = overlay;
  state.guid = g;
  state.items = items;
  state.focusIdx = -1;

  // Position: clamp to viewport. If menu would clip the right/bottom
  // edge, render left of / above the cursor.
  const margin = 4;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const rect = overlay.getBoundingClientRect();
  let x = clientX;
  let y = clientY;
  if (x + rect.width + margin > vw) x = Math.max(margin, clientX - rect.width);
  if (y + rect.height + margin > vh) y = Math.max(margin, clientY - rect.height);
  overlay.style.left = `${x}px`;
  overlay.style.top = `${y}px`;

  state.onKeyDown = (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeMenu(); return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); ev.stopPropagation(); moveFocus(1); return; }
    if (ev.key === "ArrowUp")   { ev.preventDefault(); ev.stopPropagation(); moveFocus(-1); return; }
    if (ev.key === "Enter")     { ev.preventDefault(); ev.stopPropagation(); activateFocused(); return; }
  };
  state.onDocMouseDown = (ev) => {
    if (!state.overlayEl) return;
    if (state.overlayEl.contains(ev.target)) return;
    closeMenu();
  };
  state.onContextMenu = (ev) => {
    if (!state.overlayEl) return;
    if (state.overlayEl.contains(ev.target)) return;
    closeMenu();
  };
  document.addEventListener("keydown", state.onKeyDown, true);
  document.addEventListener("mousedown", state.onDocMouseDown, true);
  document.addEventListener("contextmenu", state.onContextMenu, true);
}

if (typeof window !== "undefined") {
  window.__openRadialMenuFor = openRadialMenuFor;
  window.__closeRadialMenu = closeMenu;
}

export const manifest = {
  id: "radial-menu",
  name: "Radial menu",
  icon: "◎",
  iconHidden: true,
  version: "0.1.0",
  description: "Right-click context menu for entity actions (Examine/Wield/Use/Drop/Trade/Attack).",
};
