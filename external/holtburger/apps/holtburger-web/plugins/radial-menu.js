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
  if (!state.overlayEl) {
    // Even when overlay is already null, ensure the global guard + any
    // orphaned submenu DOM (Escape path can leave it) are cleared so
    // container-panel's outside-click handler isn't permanently stuck.
    window.__radialMenuOpen = false;
    try { document.getElementById("hb-radial-submenu")?.remove(); } catch (_) {}
    return;
  }
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
  try { document.getElementById("hb-radial-submenu")?.remove(); } catch (_) {}
  window.__radialMenuOpen = false;
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

// Inline Bonded-confirm overlay used by the Drop action. Owns its own
// capture-phase Escape listener so it preempts the menu's Esc handler.
function confirmBondedDrop(name, onConfirm) {
  const ov = document.createElement("div");
  ov.id = "hb-rm-bonded-confirm";
  ov.style.cssText = "position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);pointer-events:auto;";
  const box = document.createElement("div");
  box.style.cssText = "background:rgba(20,14,8,0.96);border:1px solid var(--hb-border-brass,#8a6f3c);padding:12px 16px;color:var(--hb-text-cream,#f0e8d0);font-family:var(--hb-font-serif,serif);min-width:280px;";
  box.innerHTML = `<div style="margin-bottom:10px;">Drop <b>${(name||"this item").replace(/[<>&]/g,"")}</b>? It is bonded and may be lost.</div>`;
  const yes = document.createElement("button");
  yes.textContent = "Drop";
  yes.style.cssText = "margin-right:8px;";
  const no = document.createElement("button");
  no.textContent = "Cancel";
  box.appendChild(yes); box.appendChild(no);
  ov.appendChild(box);
  function cleanup() {
    document.removeEventListener("keydown", onEsc, true);
    ov.remove();
  }
  function onEsc(ev) {
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cleanup(); }
  }
  yes.addEventListener("click", () => { cleanup(); try { onConfirm(); } catch (_) {} });
  no.addEventListener("click", cleanup);
  document.addEventListener("keydown", onEsc, true);
  document.body.appendChild(ov);
}

function itemTypeIsContainer(invItem) {
  return ((invItem?.itemType >>> 0) & 0x40000000) !== 0;
}

function pickWieldSlotMaskShared(vl) {
  const v = (vl >>> 0) || 0;
  if (v === 0) return 0;
  if ((v & (v - 1)) === 0) return v;
  const P = [0x00100000,0x00200000,0x00400000,0x00800000,0x01000000,0x02000000,0x04000000,0x08000000,0x10000000,0x20000000,0x40000000];
  for (const b of P) if ((v & b) !== 0) return b;
  return v & -v;
}

// Single-bit splitter — used by the Equip submenu when ValidLocations has
// multiple bits set (e.g. rings fit L + R finger).
function enumerateEquipSlots(vl) {
  const v = (vl >>> 0) || 0;
  const out = [];
  const NAMES = {
    0x00100000: "Melee",   0x00200000: "Shield",  0x00400000: "Missile",
    0x00800000: "Ammo",    0x01000000: "Held",    0x02000000: "Two-Handed",
    0x04000000: "Trinket", 0x08000000: "Cloak",
    0x10000000: "Sigil Blue", 0x20000000: "Sigil Yellow", 0x40000000: "Sigil Red",
  };
  for (const bit of Object.keys(NAMES).map((k) => +k)) {
    if ((v & bit) !== 0) out.push({ mask: bit, name: NAMES[bit] });
  }
  return out;
}

function buildItems(ctx) {
  const guid = (ctx.guid >>> 0) || 0;
  const source = ctx.source || "scene3d";
  const items = [];
  const ent = getEntity(guid);
  const invItem = getInventoryItem(guid);
  const invEquipMask = (invItem?.equipMask >>> 0) || 0;
  const isEquipped = invItem !== null && invEquipMask !== 0;
  const isInPack = invItem !== null && invEquipMask === 0;
  const handle = window.__sessionHandle ?? window.__pluginClient?._handle;

  // Examine — preserves examine-target.js:921 fromInventory branch by
  // threading {name, fromInventory, srcLi} per source type.
  items.push({
    label: "Examine",
    action: () => {
      if (typeof window.__showExamineFor !== "function") return;
      const fromInventory = source === "inv-grid" || source === "inv-paperdoll" || source === "hotbar";
      const opts = { name: ctx.name || ent?.meta?.name, srcLi: ctx.srcLi };
      if (fromInventory) opts.fromInventory = true;
      else opts.fromEntity = true;
      try { window.__showExamineFor(guid, opts); }
      catch (e) { console.warn("[ctx-menu] examine failed:", e); }
    },
  });
  // Remove Binding pinned at position 0 when source='hotbar' for muscle memory.
  // We insert AFTER Examine so Examine stays the natural top entry for non-hotbar;
  // for hotbar we splice Remove Binding to slot 1 below.

  // Equip submenu — for items with multi-bit ValidLocations show ring options.
  if (typeof handle?.setWielded === "function" && invItem) {
    const vl = (invItem.validLocations >>> 0) || 0;
    const options = enumerateEquipSlots(vl);
    if (vl !== 0 && options.length > 1) {
      items.push({
        label: "Equip ▸",
        children: options.map((o) => ({
          label: `Equip — ${o.name}`,
          action: () => { try { handle.setWielded(guid, o.mask >>> 0); } catch (e) { console.warn("[ctx-menu] equip failed:", e); } },
        })),
      });
    } else if (isInPack && vl !== 0) {
      items.push({
        label: "Equip",
        action: () => { try { handle.setWielded(guid, pickWieldSlotMaskShared(vl)); } catch (e) { console.warn("[ctx-menu] equip failed:", e); } },
      });
    }
  }
  // Unequip — uses Wave A unwieldToPack.
  if (isEquipped && typeof handle?.unwieldToPack === "function") {
    items.push({
      label: "Unequip",
      action: () => { try { handle.unwieldToPack(guid); } catch (e) { console.warn("[ctx-menu] unwield failed:", e); } },
    });
  }
  // Use — for items with itemType USABLE bit or consumable items.
  if (invItem && typeof handle?.useObject === "function") {
    items.push({
      label: "Use",
      action: () => { try { handle.useObject(guid); } catch (e) { console.warn("[ctx-menu] use failed:", e); } },
    });
  }
  // Drop — Attuned blocks; Bonded gets confirm overlay.
  if (invItem && (isInPack || isEquipped) && typeof handle?.dropItem === "function") {
    const attuned = (invItem.attuned >>> 0) !== 0;
    const bonded = (invItem.bonded >>> 0) !== 0;
    items.push({
      label: attuned ? "Drop (attuned)" : "Drop",
      disabled: attuned,
      action: () => {
        if (attuned) return;
        if (bonded) {
          confirmBondedDrop(invItem.name, () => { try { handle.dropItem(guid); } catch (e) { console.warn("[ctx-menu] drop failed:", e); } });
          return;
        }
        try { handle.dropItem(guid); } catch (e) { console.warn("[ctx-menu] drop failed:", e); }
      },
    });
  }
  // Give — disabled-with-tooltip when no target selected.
  if (invItem && typeof handle?.giveObject === "function") {
    const target = (() => { try { return window.liveScene3d?.entityManager?.getSelectedTarget?.() >>> 0; } catch (_) { return 0; } })();
    items.push({
      label: target ? "Give" : "Give (no target)",
      disabled: !target,
      action: () => {
        if (!target) return;
        try { handle.giveObject(target, guid, 1); } catch (e) { console.warn("[ctx-menu] give failed:", e); }
      },
    });
  }
  // Split Stack — INLINE numeric prompt (no modal); count from stackSize.
  const count = (invItem?.stackSize >>> 0) || 0;
  if (invItem && count > 1 && typeof handle?.splitStackTo3D === "function") {
    items.push({
      label: "Split Stack…",
      splitPrompt: { max: count - 1 },
      action: (amount) => {
        const n = Math.max(1, Math.min((amount | 0), count - 1));
        try { handle.splitStackTo3D(guid, n); } catch (e) { console.warn("[ctx-menu] split failed:", e); }
      },
    });
  }
  // Add To Hotbar — flyout 1..18, using opaque __hotbar API.
  if (invItem && window.__hotbar && typeof window.__hotbar.bindItemToSlot === "function") {
    const first = (typeof window.__hotbar.findFirstEmpty === "function") ? window.__hotbar.findFirstEmpty() : null;
    const children = [];
    for (let i = 0; i < 18; i++) {
      const slot = window.__hotbar.getSlot(i);
      const label = `Slot ${i + 1}` + (slot ? (slot.itemGuid ? " (item)" : slot.spellId ? " (spell)" : "") : " (empty)") + (i === first ? " *" : "");
      children.push({
        label,
        action: () => { try { window.__hotbar.bindItemToSlot(i, guid); } catch (e) { console.warn("[ctx-menu] bind failed:", e); } },
      });
    }
    items.push({ label: "Add To Hotbar ▸", children });
  }
  // Open — for containers; routes to the container-panel plugin's public hook.
  if (invItem && itemTypeIsContainer(invItem) && typeof window.__openContainerFor === "function") {
    items.push({
      label: "Open",
      action: () => { try { window.__openContainerFor(guid, invItem.name); } catch (e) { console.warn("[ctx-menu] open failed:", e); } },
    });
  }
  // Source-specific entries.
  if (source === "hotbar") {
    // Remove Binding pinned at position 1 (just after Examine).
    const slotIndex = (ctx.slotIndex | 0);
    items.splice(1, 0, {
      label: "Remove Binding",
      action: () => { try { window.__hotbar?.removeBinding?.(slotIndex); } catch (e) { console.warn("[ctx-menu] remove failed:", e); } },
    });
  }
  if (source === "container-panel") {
    if (typeof handle?.moveItem === "function") {
      items.push({
        label: "Take From Container",
        action: () => {
          const me = (typeof window.getLocalPlayerGuid === "function") ? (window.getLocalPlayerGuid() >>> 0) : 0;
          if (!me) return;
          try { handle.moveItem(guid, me, 0); } catch (e) { console.warn("[ctx-menu] take failed:", e); }
        },
      });
    }
  }
  if (source === "scene3d") {
    // Preserve legacy Trade/Attack actions from the old buildItems.
    const localPlayerGuid = (typeof window.getLocalPlayerGuid === "function") ? (window.getLocalPlayerGuid() >>> 0) : 0;
    if (isPlayer(guid, ent) && guid !== localPlayerGuid && typeof window.__sessionHandle?.openTrade === "function") {
      items.push({ label: "Trade", action: () => { try { window.__sessionHandle.openTrade(guid); } catch (e) { console.warn("[ctx-menu] trade failed:", e); } } });
    }
    const stanceLow = (typeof window.__getCurrentStanceLow === "function") ? (window.__getCurrentStanceLow() >>> 0) : 0;
    if (isCreature(ent) && stanceLow !== 0 && typeof window.__fireAttackOnTarget === "function") {
      items.push({
        label: "Attack",
        action: () => {
          try {
            window.liveScene3d?.entityManager?.setSelectedTarget?.(guid);
            window.__fireAttackOnTarget();
          } catch (e) { console.warn("[ctx-menu] attack failed:", e); }
        },
      });
    }
  }
  return { items, ent };
}

function openContextMenuFor(ctxArg) {
  closeMenu();
  ensureStyles();
  // Back-compat: accept the legacy (guid, x, y) call shape and synthesize
  // a scene3d ctx.
  let ctx;
  if (typeof ctxArg === "object" && ctxArg) ctx = ctxArg;
  else ctx = { source: "scene3d", guid: ctxArg, clientX: arguments[1], clientY: arguments[2] };
  const g = (ctx.guid >>> 0) || 0;
  if (!g && ctx.source !== "hotbar") return;
  const { items, ent } = buildItems(ctx);
  if (items.length === 0) return;
  window.__radialMenuOpen = true;

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  const headerName = ctx.name || ent?.meta?.name || (g ? `0x${g.toString(16).toUpperCase().padStart(8, "0")}` : "Menu");
  const header = document.createElement("div");
  header.className = "hb-rm-header";
  setAcText(header, headerName);
  overlay.appendChild(header);

  items.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "hb-rm-item";
    if (it.disabled) row.dataset.disabled = "1";
    setAcText(row, it.label);
    row.addEventListener("mouseenter", () => setFocus(idx));
    row.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (it.disabled) return;
      // Split-Stack inline prompt: replace the row with a numeric input + Confirm.
      if (it.splitPrompt) {
        if (row.querySelector(".hb-rm-split-input")) return;
        row.innerHTML = "";
        const inp = document.createElement("input");
        inp.type = "number";
        inp.min = "1";
        inp.max = String(it.splitPrompt.max);
        inp.value = "1";
        inp.className = "hb-rm-split-input";
        inp.style.width = "56px";
        const btn = document.createElement("span");
        btn.textContent = "OK";
        btn.style.cssText = "margin-left:6px;cursor:pointer;color:var(--hb-text-gold,#f0c060);";
        row.appendChild(inp); row.appendChild(btn);
        const confirm = (e) => {
          e?.stopPropagation?.();
          e?.preventDefault?.();
          const n = Math.max(1, Math.min(parseInt(inp.value, 10) || 1, it.splitPrompt.max));
          closeMenu();
          try { it.action(n); } catch (err) { console.warn("[ctx-menu] split action threw:", err); }
        };
        btn.addEventListener("click", confirm);
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") confirm(e); });
        inp.focus();
        try { inp.select(); } catch (_) {}
        return;
      }
      // Submenu children: open a flyout to the right.
      if (Array.isArray(it.children) && it.children.length > 0) {
        openSubmenu(row, it.children);
        return;
      }
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
  const cx = (ctx.clientX | 0) || 0;
  const cy = (ctx.clientY | 0) || 0;
  let x = cx;
  let y = cy;
  if (x + rect.width + margin > vw) x = Math.max(margin, cx - rect.width);
  if (y + rect.height + margin > vh) y = Math.max(margin, cy - rect.height);
  overlay.style.left = `${x}px`;
  overlay.style.top = `${y}px`;

  // Auto-expand a target row if the opener requested focus on a specific
  // action (e.g. shift-click on a stack opens the menu pre-armed for Split).
  if (ctx.focusAction === "split") {
    const idx = items.findIndex((it) => it.splitPrompt);
    if (idx >= 0) {
      const row = overlay.children[idx];
      try { row?.dispatchEvent(new MouseEvent("click", { bubbles: true })); } catch (_) {}
    }
  }

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

// Minimal flyout submenu renderer (one level deep).
function openSubmenu(anchorRow, children) {
  const existing = document.getElementById("hb-radial-submenu");
  if (existing) existing.remove();
  const sub = document.createElement("div");
  sub.id = "hb-radial-submenu";
  sub.style.cssText = "position:fixed;z-index:81;min-width:120px;padding:2px 0;background:rgba(20,14,8,0.94);border:1px solid var(--hb-border-brass,#8a6f3c);pointer-events:auto;font-family:var(--hb-font-serif,serif);";
  for (const c of children) {
    const row = document.createElement("div");
    row.className = "hb-rm-item";
    setAcText(row, c.label);
    row.style.cssText = "padding:2px 12px;height:18px;line-height:18px;color:var(--hb-text-cream,#f0e8d0);font-size:12px;cursor:pointer;";
    row.addEventListener("click", (ev) => {
      ev.stopPropagation();
      sub.remove();
      closeMenu();
      try { c.action(); } catch (err) { console.warn("[ctx-menu] submenu action threw:", err); }
    });
    sub.appendChild(row);
  }
  document.body.appendChild(sub);
  const r = anchorRow.getBoundingClientRect();
  sub.style.left = `${r.right + 2}px`;
  sub.style.top = `${r.top}px`;
}

if (typeof window !== "undefined") {
  // New polymorphic entry-point.
  window.__openContextMenuFor = openContextMenuFor;
  // Legacy shim — old scene3d/camera.js callers keep working.
  window.__openRadialMenuFor = (guid, x, y) => openContextMenuFor({ source: "scene3d", guid, clientX: x, clientY: y });
  window.__closeRadialMenu = closeMenu;
  window.__radialMenuOpen = false;
}

export const manifest = {
  id: "radial-menu",
  name: "Radial menu",
  icon: "◎",
  iconHidden: true,
  version: "0.1.0",
  description: "Right-click context menu for entity actions (Examine/Wield/Use/Drop/Trade/Attack).",
};
