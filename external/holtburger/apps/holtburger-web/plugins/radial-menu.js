// Wave B3 — right-click context menu (retail's "radial" was internally a
// vertical entry list; we adopt the same pattern). Spawned by
// scene3d/camera.js's onMouseUp when a right-click-no-drag lands on an
// entity, and by the inventory / container / hotbar / paperdoll slots.
//
// Entry-point: window.__openContextMenuFor({source, guid, clientX,
// clientY, ...}) (legacy: window.__openRadialMenuFor(guid, x, y)).
// Closes on: outside click, Escape, entry selection, right-click again.
//
// HUD overhaul 2026-10-05:
//   - kit chrome: `.hbk-window` dark field + gold edge, `.hbk-row` entries
//     with the kit hover/selected treatment, a gold rule under the name,
//     dimmed disabled entries, the ▸ arrow split out of the label.
//   - ZOOM-AWARE placement: `#hb-radial-menu` / `#hb-radial-submenu` are
//     zoomed HUD roots (ui/hud_scale.js), so the screen-px click point is
//     converted with hudPoint(), the box measured in HUD px and placed
//     with the shared `placeNearPointer` rule (hover-tooltip.js), clamped
//     to hudViewport(). Before this the menu opened at (x·s, y·s) — far
//     from the pointer — and could leave the screen at HUD scale > 1.
//     Tall lists (Add To Hotbar ▸ has 18 slots) scroll instead of
//     overflowing the viewport.
//   - keyboard: ↑/↓ (Home/End) move, Enter/Space activate, → opens a
//     submenu, ←/Esc backs out, a letter jumps to the next entry starting
//     with it. Handled keys are swallowed so they don't also walk the
//     character. Typing into the Split Stack field is left alone.
//   - the Bonded-drop confirm uses the shared retail dialog
//     (modal-dialog.js) instead of an unstyled native-button overlay.
//   - fixed: `focusAction: "split"` (shift-click a stack) armed the wrong
//     row — it indexed overlay.children, whose [0] is the header.

import { hudPoint, hudRect, hudViewport, getHudScale } from "../ui/hud_scale.js";
import { placeNearPointer } from "./hover-tooltip.js";
import { modalConfirmCallback } from "./modal-dialog.js";

const OVERLAY_ID = "hb-radial-menu";
const SUBMENU_ID = "hb-radial-submenu";
const STYLE_ID = "hb-radial-menu-style";

const ITEM_TYPE_CREATURE = 0x00000010;
const ODF_PLAYER = 0x00000008;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID}, #${SUBMENU_ID} {
      z-index: 80;
      display: flex;
      flex-direction: column;
      min-width: 128px;
      max-width: 260px;
      max-height: calc(100 * var(--hb-hud-vh, 1vh) - 8px);
      padding: 2px 0 3px;
      box-sizing: border-box;
    }
    #${SUBMENU_ID} { z-index: 81; }
    #${OVERLAY_ID} .hb-rm-header {
      flex: 0 0 auto;
      padding: 2px 10px 1px;
      color: var(--hbk-gold-bright);
      font-size: 12px;
      letter-spacing: 0.02em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-shadow: 0 1px 0 #000;
    }
    #${OVERLAY_ID} .hbk-rule { flex: 0 0 auto; margin: 2px 4px 2px; }
    .hb-rm-list {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .hb-rm-list > .hb-rm-item {
      min-height: 19px;
      padding: 0 10px 0 8px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .hb-rm-list > .hb-rm-item:nth-child(even) { background: transparent; }
    .hb-rm-list > .hb-rm-item:hover { background: transparent; }
    .hb-rm-list > .hb-rm-item.is-selected { background: var(--hbk-sel); }
    .hb-rm-list > .hb-rm-item.is-disabled { color: var(--hbk-text-faint); cursor: default; }
    .hb-rm-list > .hb-rm-item.is-disabled.is-selected { background: var(--hbk-hover); color: var(--hbk-text-faint); border-left-color: transparent; }
    .hb-rm-list .hb-rm-arrow { flex: 0 0 auto; color: var(--hbk-gold); font-size: 10px; }
    .hb-rm-list .hb-rm-split { display: flex; align-items: center; gap: 4px; width: 100%; }
    .hb-rm-list .hb-rm-split-input { width: 56px; min-height: 17px; padding: 0 4px; }
  `;
  document.head.appendChild(s);
}

let state = {
  overlayEl: null,
  listEl: null,
  guid: 0,
  items: [],
  rows: [],
  focusIdx: -1,
  sub: null, // { el, rows, items, focusIdx, anchorIdx }
  onKeyDown: null,
  onDocMouseDown: null,
  onContextMenu: null,
};

function closeSubmenu() {
  if (state.sub?.el) {
    try { state.sub.el.remove(); } catch (_) {}
  }
  state.sub = null;
  // Orphans from an older build / an Escape race.
  try { document.getElementById(SUBMENU_ID)?.remove(); } catch (_) {}
}

function closeMenu() {
  if (!state.overlayEl) {
    // Even when overlay is already null, ensure the global guard + any
    // orphaned submenu DOM (Escape path can leave it) are cleared so
    // container-panel's outside-click handler isn't permanently stuck.
    window.__radialMenuOpen = false;
    closeSubmenu();
    return;
  }
  if (state.onKeyDown) document.removeEventListener("keydown", state.onKeyDown, true);
  if (state.onDocMouseDown) document.removeEventListener("mousedown", state.onDocMouseDown, true);
  if (state.onContextMenu) document.removeEventListener("contextmenu", state.onContextMenu, true);
  closeSubmenu();
  state.overlayEl.remove();
  state.overlayEl = null;
  state.listEl = null;
  state.items = [];
  state.rows = [];
  state.focusIdx = -1;
  state.onKeyDown = null;
  state.onDocMouseDown = null;
  state.onContextMenu = null;
  state.guid = 0;
  window.__radialMenuOpen = false;
}

function paintFocus(rows, idx) {
  rows.forEach((r, i) => {
    const on = i === idx;
    r.classList.toggle("is-selected", on);
    if (on) {
      try { r.scrollIntoView({ block: "nearest" }); } catch (_) {}
    }
  });
}

function setFocus(idx) {
  state.focusIdx = idx;
  if (!state.overlayEl) return;
  paintFocus(state.rows, idx);
  const row = state.rows[idx];
  if (row && state.listEl) state.listEl.setAttribute("aria-activedescendant", row.id);
}

/** Next index from `from` stepping `delta`, skipping disabled entries
 *  (wraps; returns `from` when every entry is disabled). */
function stepIndex(items, from, delta) {
  const n = items.length;
  if (n === 0) return -1;
  let i = from < 0 ? (delta > 0 ? -1 : n) : from;
  for (let k = 0; k < n; k++) {
    i = (i + delta + n) % n;
    if (!items[i]?.disabled) return i;
  }
  return from;
}

function moveFocus(delta) {
  if (state.items.length === 0) return;
  setFocus(stepIndex(state.items, state.focusIdx, delta));
}

function activateIndex(idx, { viaKeyboard = false } = {}) {
  const it = state.items[idx];
  const row = state.rows[idx];
  if (!it || !row || it.disabled) return;
  setFocus(idx);
  if (it.splitPrompt) { openSplitPrompt(row, it); return; }
  if (Array.isArray(it.children) && it.children.length > 0) {
    openSubmenu(row, it.children, idx, { focusFirst: viaKeyboard });
    return;
  }
  closeMenu();
  try { it.action(); } catch (e) { console.warn("[radial-menu] action threw:", e); }
}

/** Display text for an entry: the ▸ arrow is drawn separately. */
function entryLabel(it) {
  return String(it.label ?? "").replace(/\s*▸\s*$/, "");
}

function buildRow(it, idx, idPrefix) {
  const row = document.createElement("div");
  row.className = "hbk-row hb-rm-item";
  row.id = `${idPrefix}-${idx}`;
  row.setAttribute("role", "menuitem");
  if (it.disabled) {
    row.classList.add("is-disabled");
    row.setAttribute("aria-disabled", "true");
  }
  const label = document.createElement("span");
  label.className = "hbk-grow";
  label.textContent = entryLabel(it);
  row.appendChild(label);
  if (Array.isArray(it.children) && it.children.length > 0) {
    row.setAttribute("aria-haspopup", "menu");
    const arrow = document.createElement("span");
    arrow.className = "hb-rm-arrow";
    arrow.textContent = "▸";
    row.appendChild(arrow);
  }
  return row;
}

/** Measure a zoomed HUD root and place it beside a HUD-space point. */
function placeAt(el, hx, hy, opts) {
  el.style.left = "0px";
  el.style.top = "0px";
  const s = Number(el.currentCSSZoom) || getHudScale() || 1;
  const r = el.getBoundingClientRect();
  const vp = hudViewport();
  const pos = placeNearPointer(hx, hy, r.width / s, r.height / s, vp.width, vp.height, opts);
  el.style.left = `${Math.round(pos.x)}px`;
  el.style.top = `${Math.round(pos.y)}px`;
  return pos;
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

// Bonded-drop confirm — the shared retail dialog (modal-dialog.js owns
// Enter/Esc, focus and the chrome). The menu is already closed when an
// action runs, so its own Esc handler can't race this one.
function confirmBondedDrop(name, onConfirm) {
  modalConfirmCallback({
    title: "Drop Bonded Item",
    message: `Drop ${name || "this item"}? It is bonded and may be lost.`,
    confirmLabel: "Drop",
    cancelLabel: "Cancel",
    onConfirm: () => { try { onConfirm(); } catch (_) {} },
  });
}

function itemTypeIsContainer(invItem) {
  // Per ACE.Entity/Enum/ItemType.cs: Container = 0x00000200.
  return ((invItem?.itemType >>> 0) & 0x00000200) !== 0;
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
  // HUD overhaul 2026-10-05 — the left/right jewelry pairs (EquipMask
  // WristWearLeft/Right 0x10000/0x20000, FingerWearLeft/Right
  // 0x40000/0x80000) were missing, so the ring case this splitter exists
  // for never produced a flyout. Armor coverage bits stay out on purpose:
  // armor occupies all of its locations at once, it doesn't pick one.
  const NAMES = {
    0x00010000: "Left Wrist", 0x00020000: "Right Wrist",
    0x00040000: "Left Finger", 0x00080000: "Right Finger",
    0x00100000: "Melee",   0x00200000: "Shield",  0x00400000: "Missile",
    0x00800000: "Ammo",    0x01000000: "Held",    0x02000000: "Two-Handed",
    0x04000000: "Trinket", 0x08000000: "Cloak",
    0x10000000: "Blue Aetheria", 0x20000000: "Yellow Aetheria", 0x40000000: "Red Aetheria",
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
          action: () => {
            try { window.__audioOptimistic?.playOptimistic?.(0x8C, guid); } catch (_) {}
            try { handle.setWielded(guid, o.mask >>> 0); } catch (e) { console.warn("[ctx-menu] equip failed:", e); }
          },
        })),
      });
    } else if (isInPack && vl !== 0) {
      items.push({
        label: "Equip",
        action: () => {
          try { window.__audioOptimistic?.playOptimistic?.(0x8C, guid); } catch (_) {}
          try { handle.setWielded(guid, pickWieldSlotMaskShared(vl)); } catch (e) { console.warn("[ctx-menu] equip failed:", e); }
        },
      });
    }
  }
  // Unequip — uses Wave A unwieldToPack.
  if (isEquipped && typeof handle?.unwieldToPack === "function") {
    items.push({
      label: "Unequip",
      action: () => {
        // Wave C / PR10 (2026-06-06): optimistic UnwieldObject sound BEFORE the
        // wire send. Apply agent replicates the matching one-liner at the four
        // other radial-menu action sites:
        //   setWielded (equip) line ~261     -> 0x8C (WieldObject)
        //   setWielded (auto)  line ~267     -> 0x8C (WieldObject)
        //   dropItem           line ~286     -> 0x90 (DropItem)
        //   splitStackTo3D     line ~316     -> 0x90 (DropItem)
        try { window.__audioOptimistic?.playOptimistic?.(0x8D, guid); } catch (_) {}
        try { handle.unwieldToPack(guid); } catch (e) { console.warn("[ctx-menu] unwield failed:", e); }
      },
    });
  }
  // Use — retail ItemHolder::UseObject: inventory.js activateItem wields a
  // weapon, wears armour, opens salvage or enters target mode before it
  // falls back to a plain Use.
  if (invItem && typeof handle?.useObject === "function") {
    items.push({
      label: "Use",
      action: () => {
        try {
          if (window.__inventory?.activateItem?.(guid) === true) return;
          handle.useObject(guid);
        } catch (e) { console.warn("[ctx-menu] use failed:", e); }
      },
    });
  }
  // Drop — Attuned blocks; Bonded gets confirm overlay.
  if (invItem && (isInPack || isEquipped) && typeof handle?.dropItem === "function") {
    const attuned = (invItem.attuned >>> 0) !== 0;
    const bonded = (invItem.bonded >>> 0) !== 0;
    items.push({
      // Wave D / PR13 (2026-06-06): also gate on window.__isBusy() so
      // Drop is unavailable mid-cast / mid-teleport. Attuned remains the
      // primary blocker (label changes to reflect that).
      label: attuned ? "Drop (attuned)" : "Drop",
      disabled: attuned || (typeof window.__isBusy === "function" && window.__isBusy()),
      action: () => {
        if (attuned) return;
        if (typeof window.__isBusy === "function" && window.__isBusy()) return;
        if (bonded) {
          confirmBondedDrop(invItem.name, () => {
            try { window.__audioOptimistic?.playOptimistic?.(0x90, guid); } catch (_) {}
            try { handle.dropItem(guid); } catch (e) { console.warn("[ctx-menu] drop failed:", e); }
          });
          return;
        }
        try { window.__audioOptimistic?.playOptimistic?.(0x90, guid); } catch (_) {}
        try { handle.dropItem(guid); } catch (e) { console.warn("[ctx-menu] drop failed:", e); }
      },
    });
  }
  // Give — disabled-with-tooltip when no target selected.
  if (invItem && typeof handle?.giveObject === "function") {
    const target = (() => { try { return window.liveScene3d?.entityManager?.getSelectedTarget?.() >>> 0; } catch (_) { return 0; } })();
    items.push({
      // Wave D / PR13 (2026-06-06): isBusy gate (cast-windup / boot).
      label: target ? "Give" : "Give (no target)",
      disabled: !target || (typeof window.__isBusy === "function" && window.__isBusy()),
      action: () => {
        if (!target) return;
        if (typeof window.__isBusy === "function" && window.__isBusy()) return;
        try { handle.giveObject(target, guid, 1); } catch (e) { console.warn("[ctx-menu] give failed:", e); }
      },
    });
  }
  // Split Stack — INLINE numeric prompt (no modal); count from stackSize.
  const count = (invItem?.stackSize >>> 0) || 0;
  if (invItem && count > 1 && typeof handle?.splitStackTo3D === "function") {
    items.push({
      label: "Split Stack…",
      // Wave D / PR13 (2026-06-06): isBusy gate. Split Stack had no
      // disabled property before; mirror Drop/Give to keep the trio
      // consistent.
      disabled: (typeof window.__isBusy === "function" && window.__isBusy()),
      splitPrompt: { max: count - 1 },
      action: (amount) => {
        if (typeof window.__isBusy === "function" && window.__isBusy()) return;
        const n = Math.max(1, Math.min((amount | 0), count - 1));
        try { window.__audioOptimistic?.playOptimistic?.(0x90, guid); } catch (_) {}
        try { handle.splitStackTo3D(guid, n); } catch (e) { console.warn("[ctx-menu] split failed:", e); }
      },
    });
  }
  // Add To Hotbar — flyout 1..18, using opaque __hotbar API.
  if (invItem && window.__hotbar && typeof window.__hotbar.bindItemToSlot === "function") {
    const first = (typeof window.__hotbar.findFirstEmpty === "function") ? window.__hotbar.findFirstEmpty() : null;
    const children = [];
    // HUD overhaul 2026-10-05: offer only the visible toolbar slots.
    const n = (typeof window.__hotbar?.slotCount === "function") ? window.__hotbar.slotCount() : 18;
    for (let i = 0; i < n; i++) {
      const slot = window.__hotbar.getSlot(i);
      const what = slot ? (slot.itemGuid ? "item" : slot.spellId ? "spell" : "in use") : "empty";
      const label = `Slot ${i + 1} — ${what}` + (i === first ? " (first free)" : "");
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
          try {
            // Retail PlaceInBackpack (merge / open pack / overflow) —
            // the corpse window's own take (item_drag.placeInBackpack).
            const place = window.__itemDrag?.placeInBackpack;
            if (typeof place === "function") { place(guid); return; }
            handle.moveItem(guid, me, 0);
          } catch (e) { console.warn("[ctx-menu] take failed:", e); }
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
    // Bug 9 (2026-10-07): Attack only for an ATTACK TARGET (retail
    // `ClientCombatSystem::ObjectIsAttackable` — the Reformed Bandit is not
    // one) and only out of peace mode (0x3D); Use for any usable world
    // object (retail double-click = `ItemHolder::UseObject`, every stance).
    const attackable = typeof window.__entityIsAttackableTarget === "function"
      ? window.__entityIsAttackableTarget(guid) === true
      : isCreature(ent);
    const usable = typeof window.__entityIsUsable === "function"
      ? window.__entityIsUsable(guid) === true
      : false;
    if (!invItem && guid !== localPlayerGuid && usable && !attackable
        && typeof handle?.useObject === "function") {
      items.splice(1, 0, {
        label: isCreature(ent) ? "Talk" : "Use",
        action: () => {
          try {
            window.liveScene3d?.entityManager?.setSelectedTarget?.(guid);
            console.info(`[use-or-attack] 0x${(guid >>> 0).toString(16)} use (radial)`);
            handle.useObject(guid);
          } catch (e) { console.warn("[ctx-menu] use failed:", e); }
        },
      });
    }
    if (attackable && stanceLow !== 0 && stanceLow !== 0x3d && typeof window.__fireAttackOnTarget === "function") {
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
    // Rec #194 — Follow entry. handle.pursueEntity drives the auto-
    // follow movement (retail's PursueObject). Available on any
    // non-self target the SessionHandle can resolve; guarded so a
    // stale pkg/ that doesn't ship the export soft-degrades silently.
    if (
      guid !== localPlayerGuid
      && typeof window.__sessionHandle?.pursueEntity === "function"
    ) {
      items.push({
        label: "Follow",
        action: () => {
          try { window.__sessionHandle.pursueEntity(guid >>> 0); }
          catch (e) { console.warn("[ctx-menu] follow failed:", e); }
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
  overlay.className = "hbk-window hb-rm";

  // The thing's name; never a raw guid (dev tooltip only).
  const headerName = ctx.name || ent?.meta?.name || "Item";
  const header = document.createElement("div");
  header.className = "hb-rm-header";
  header.textContent = headerName;
  if (g) header.title = `0x${g.toString(16).toUpperCase().padStart(8, "0")}`;
  overlay.appendChild(header);
  const rule = document.createElement("div");
  rule.className = "hbk-rule";
  overlay.appendChild(rule);

  const list = document.createElement("div");
  list.className = "hb-rm-list hbk-scroll";
  list.setAttribute("role", "menu");
  list.setAttribute("aria-label", headerName);
  overlay.appendChild(list);

  const rows = items.map((it, idx) => {
    const row = buildRow(it, idx, "hb-rm-item");
    row.addEventListener("mouseenter", () => {
      setFocus(idx);
      // Hovering a different entry closes an open flyout (unless it's
      // the entry that owns it).
      if (state.sub && state.sub.anchorIdx !== idx) closeSubmenu();
      if (Array.isArray(it.children) && it.children.length > 0 && !it.disabled && state.sub?.anchorIdx !== idx) {
        openSubmenu(row, it.children, idx, { focusFirst: false });
      }
    });
    row.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (row.querySelector(".hb-rm-split-input")) return;
      activateIndex(idx);
    });
    list.appendChild(row);
    return row;
  });

  // Suppress browser context menu inside the overlay.
  overlay.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ev.stopPropagation(); });

  document.body.appendChild(overlay);
  state.overlayEl = overlay;
  state.listEl = list;
  state.guid = g;
  state.items = items;
  state.rows = rows;
  state.focusIdx = -1;

  // Position: top-left just past the pointer, flipped left/up when it
  // would cross the right/bottom edge — all in HUD px (see header).
  const p = hudPoint({ clientX: Number(ctx.clientX) || 0, clientY: Number(ctx.clientY) || 0 });
  placeAt(overlay, p.x, p.y, { dx: 2, dy: 2, margin: 4 });

  // Auto-expand a target row if the opener requested focus on a specific
  // action (e.g. shift-click on a stack opens the menu pre-armed for Split).
  if (ctx.focusAction === "split") {
    const idx = items.findIndex((it) => it.splitPrompt);
    if (idx >= 0 && !items[idx].disabled) activateIndex(idx);
  }

  state.onKeyDown = (ev) => {
    if (!state.overlayEl) return;
    const inField = ev.target?.classList?.contains?.("hb-rm-split-input");
    if (ev.key === "Escape") {
      ev.preventDefault(); ev.stopPropagation();
      if (state.sub) { const a = state.sub.anchorIdx; closeSubmenu(); setFocus(a); }
      else closeMenu();
      return;
    }
    if (inField) return; // Split Stack field owns its own keys.
    const sub = state.sub;
    const handled = () => { ev.preventDefault(); ev.stopPropagation(); };
    if (sub && sub.focusIdx >= 0) {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        handled();
        sub.focusIdx = stepIndex(sub.items, sub.focusIdx, ev.key === "ArrowDown" ? 1 : -1);
        paintFocus(sub.rows, sub.focusIdx);
        return;
      }
      if (ev.key === "ArrowLeft") { handled(); const a = sub.anchorIdx; closeSubmenu(); setFocus(a); return; }
      if (ev.key === "Enter" || ev.key === " ") { handled(); activateSubmenuIndex(sub.focusIdx); return; }
    }
    switch (ev.key) {
      case "ArrowDown": handled(); moveFocus(1); return;
      case "ArrowUp": handled(); moveFocus(-1); return;
      case "Home": handled(); setFocus(stepIndex(state.items, -1, 1)); return;
      case "End": handled(); setFocus(stepIndex(state.items, state.items.length, -1)); return;
      case "ArrowRight": {
        handled();
        const it = state.items[state.focusIdx];
        if (it && Array.isArray(it.children) && it.children.length > 0 && !it.disabled) {
          openSubmenu(state.rows[state.focusIdx], it.children, state.focusIdx, { focusFirst: true });
        }
        return;
      }
      case "Enter":
      case " ":
        handled();
        if (state.focusIdx >= 0) activateIndex(state.focusIdx, { viaKeyboard: true });
        return;
      default:
        break;
    }
    // Type-ahead: jump to the next entry starting with that letter.
    if (ev.key.length === 1 && /\S/.test(ev.key) && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      const ch = ev.key.toLowerCase();
      const n = state.items.length;
      for (let k = 1; k <= n; k++) {
        const i = (Math.max(state.focusIdx, -1) + k + n) % n;
        const it = state.items[i];
        if (!it.disabled && entryLabel(it).toLowerCase().startsWith(ch)) {
          handled();
          setFocus(i);
          return;
        }
      }
    }
  };
  state.onDocMouseDown = (ev) => {
    if (!state.overlayEl) return;
    if (state.overlayEl.contains(ev.target)) return;
    if (state.sub?.el?.contains(ev.target)) return;
    closeMenu();
  };
  state.onContextMenu = (ev) => {
    if (!state.overlayEl) return;
    if (state.overlayEl.contains(ev.target)) return;
    if (state.sub?.el?.contains(ev.target)) { ev.preventDefault(); return; }
    closeMenu();
  };
  document.addEventListener("keydown", state.onKeyDown, true);
  document.addEventListener("mousedown", state.onDocMouseDown, true);
  document.addEventListener("contextmenu", state.onContextMenu, true);
}

// Split-Stack inline prompt: the row becomes a number field + OK.
function openSplitPrompt(row, it) {
  if (row.querySelector(".hb-rm-split-input")) return;
  closeSubmenu();
  row.textContent = "";
  const wrap = document.createElement("div");
  wrap.className = "hb-rm-split";
  const lbl = document.createElement("span");
  lbl.textContent = "Split";
  const inp = document.createElement("input");
  inp.type = "number";
  inp.min = "1";
  inp.max = String(it.splitPrompt.max);
  inp.value = "1";
  inp.className = "hbk-input hb-rm-split-input";
  inp.setAttribute("aria-label", `Amount to split off (1–${it.splitPrompt.max})`);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hbk-btn-small";
  btn.textContent = "OK";
  wrap.appendChild(lbl);
  wrap.appendChild(inp);
  wrap.appendChild(btn);
  row.appendChild(wrap);
  const confirm = (e) => {
    e?.stopPropagation?.();
    e?.preventDefault?.();
    const n = Math.max(1, Math.min(parseInt(inp.value, 10) || 1, it.splitPrompt.max));
    closeMenu();
    try { it.action(n); } catch (err) { console.warn("[ctx-menu] split action threw:", err); }
  };
  btn.addEventListener("click", confirm);
  inp.addEventListener("click", (e) => e.stopPropagation());
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirm(e);
    // Keep digits / arrows from steering the character while typing.
    else if (e.key !== "Escape") e.stopPropagation();
  });
  try { inp.focus(); inp.select(); } catch (_) {}
}

function activateSubmenuIndex(i) {
  const sub = state.sub;
  const c = sub?.items?.[i];
  if (!c || c.disabled) return;
  closeMenu();
  try { c.action(); } catch (err) { console.warn("[ctx-menu] submenu action threw:", err); }
}

// Flyout submenu (one level deep), placed beside its entry in HUD px:
// right of the menu, or left of it when that would leave the screen.
function openSubmenu(anchorRow, children, anchorIdx, { focusFirst = false } = {}) {
  closeSubmenu();
  const sub = document.createElement("div");
  sub.id = SUBMENU_ID;
  sub.className = "hbk-window hb-rm";
  const list = document.createElement("div");
  list.className = "hb-rm-list hbk-scroll";
  list.setAttribute("role", "menu");
  sub.appendChild(list);
  const rows = children.map((c, i) => {
    const row = buildRow(c, i, "hb-rm-sub");
    row.addEventListener("mouseenter", () => {
      if (!state.sub) return;
      state.sub.focusIdx = i;
      paintFocus(rows, i);
    });
    row.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      activateSubmenuIndex(i);
    });
    list.appendChild(row);
    return row;
  });
  sub.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ev.stopPropagation(); });
  document.body.appendChild(sub);
  state.sub = { el: sub, rows, items: children, focusIdx: -1, anchorIdx };

  const a = hudRect(anchorRow);
  const menu = state.overlayEl ? hudRect(state.overlayEl) : a;
  const s = Number(sub.currentCSSZoom) || getHudScale() || 1;
  sub.style.left = "0px";
  sub.style.top = "0px";
  const r = sub.getBoundingClientRect();
  const w = r.width / s;
  const h = r.height / s;
  const vp = hudViewport();
  const m = 4;
  let x = menu.right + 1;
  if (x + w + m > vp.width) x = menu.left - w - 1;
  x = Math.max(m, Math.min(x, vp.width - w - m));
  let y = a.top - 3;
  y = Math.max(m, Math.min(y, vp.height - h - m));
  sub.style.left = `${Math.round(x)}px`;
  sub.style.top = `${Math.round(y)}px`;

  if (focusFirst) {
    state.sub.focusIdx = stepIndex(children, -1, 1);
    paintFocus(rows, state.sub.focusIdx);
  }
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
  version: "0.2.0",
  description: "Right-click context menu for entity actions (Examine/Wield/Use/Drop/Trade/Attack).",
};
