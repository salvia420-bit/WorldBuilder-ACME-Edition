// corpse-loot-bar — the external-container window: retail
// gmExternalContainerUI (layout 0x21000008) for corpses AND chests.
//
// Retail flow: kill → corpse Container ObjectCreate (ODF Corpse 0x2000) →
// Use (0x0036) → ACE Container.Open → GameEvent::ViewContents (0x0196) →
// client kind=21 ContainerOpened. container-panel.js routes every ground
// container here. Retail draws gmExternalContainerUI as a HORIZONTAL strip
// (RootExternalContainer_Field 800×110 at the bottom: Ext_Container_ItemList
// 784×32 with the horizontal rope scrollbar Ext_ItemListScroll 0x06004C7F),
// closed by its button or by walking out of range
// (gmExternalContainerUI::OnObjectRangeExit / RecvNotice_StopViewingObject).
//
// HUD overhaul 2026-10-05 — "that hud element never fits in the screen
// when we login with the login info in the url":
//   * kit window chrome (hbk-window + trapezoid titlebar + close sprite),
//     draggable + persisted through attachWindowPosition (window id
//     0x10000063 = RootExternalContainer_Field);
//   * sized in HUD units — `calc(96 * var(--hb-hud-vw))`, never `92vw`
//     (vw is NOT divided by the HUD zoom, so the old `min(92vw, 700px)`
//     overflowed whenever the HUD scale was > 1) — and clamped into the
//     HUD viewport after every render, resize and HUD-scale change;
//   * the item strip scrolls horizontally (mouse wheel too);
//   * no click-outside dismissal — it closed the window the moment you
//     pressed on your inventory to drag an item into the chest. Retail
//     closes on range exit: the server's CloseGroundContainer
//     (`containerClosed` bus event) and the corpse-despawn poll do that;
//   * drag & drop through plugins/item_drag.js: drag a cell into the
//     inventory grid / a pack / the paperdoll / the hotbar; drop an
//     inventory item onto the strip to put it in the chest (corpses refuse,
//     as ACE does). Takes are optimistic (ghosted until the server agrees).
//   * double-click / Take / Loot all place items like retail
//     CPlayerSystem::PlaceInBackpack, exactly as radial-menu.js "Take From
//     Container" does (see takeItem). Loot all paces one take per server echo.
//
// Data feed: `handle.getContainerContents(guid)` (GUID list cached
// wasm-side before the kind=21 event) + per-item meta from playerInventory
// → entityManager → getObjectIconId (see resolveItemMeta).

import { setAcText } from "../ui/ac_font.js";
import {
  fetchIconDataUrl as fetchIconDataUrlShared,
  fetchItemIconDataUrl,
  getItemIconImmediate,
  itemIconKey,
} from "../ui/ac_icon_cache.js";
import { attachWindowPosition } from "../ui/ac_window_position.js";
import { makeTitlebar } from "../ui/hud_kit.js";
import {
  uiEffectBadgesEnabled,
  uiEffectIconsFor,
  uiEffectTintCss,
} from "../scene3d/vfx/ui_effects_registry.js";
import { takeInventorySnapshot, decideItemDrop, DROP_TARGET } from "./inventory_helpers.js";
import { resolveContainedItemMeta } from "./contained_item_meta.js";
import { clearsGroundObjectOnFailure, moveFailCloseGroundEnabled } from "./weenie_error_messages.js";
import {
  extNestedPacksEnabled,
  externalContainerView,
  groundContainerRangeEnabled,
  groundContainerRangeVerdict,
  isLandscapeGroundObject,
  landblockToWorld,
} from "./ground_container_rules.js";
import {
  beginItemDrag,
  registerDropZone,
  resolveDropAction,
  executeItemAction,
  planBackpackPlacement,
  pendingOps,
  showItemTooltip,
  hideItemTooltip,
  showItemToast,
  localPlayerGuid,
} from "./item_drag.js";

const OVERLAY_ID = "hb-corpse-loot-bar";
const STYLE_ID = "hb-corpse-loot-bar-style";
const DESPAWN_POLL_MS = 1000;
// RootExternalContainer_Field element id — the persisted window key.
const EXT_WINDOW_ID = 0x10000063;
// Default placement: centred, clear of the bottom toolbar (HUD px).
const DEFAULT_BOTTOM_GAP = 132;
// Loot all — strictly ONE take in flight (2026-10-07). ACE's pickup is a
// busy-guarded state machine (Player_Inventory.cs
// HandleActionPutItemInContainer_Verify): while a pickup is in its Start
// phase (walk-to + crouch) another PutItemInContainer is refused with
// YoureTooBusy + InventoryServerSaveFailed, and only ONE more is accepted
// (queued as NextPickup) once the first item has moved and the player is
// standing back up. The old loop sent the next take on a fixed 700 ms timer
// whether or not the server had answered, so every pickup slower than that
// collided, failed, and stopped the loop. The next take now goes out only
// after the previous one was answered: the item left the container (echo),
// the server refused it (busy → retried, anything else → stop), or the
// ledger gave up waiting.
const LOOT_ALL_NEXT_DELAY_MS = 150;   // after an echo — ACE queues it as NextPickup
const LOOT_ALL_RETRY_DELAY_MS = 900;  // after a "You're too busy" refusal
const LOOT_ALL_MAX_TRIES = 3;         // per item, then it is skipped
const LOOT_ALL_WATCHDOG_MS = 8000;    // > the pending ledger's 6 s TTL
const LOOT_ALL_BUSY_WINDOW_MS = 1500; // a YoureTooBusy this recent explains a failure
const WERR_YOURE_TOO_BUSY = 0x001d;
const SP = "./data/ui-sprites";

let overlayEl = null;
let state = {
  corpseGuid: 0,
  corpseName: "",
  // The OPEN container's loose contents (the item strip). extcontainer-5
  // (`?extNestedPacks`): `packs` = the packs inside the ground object (the
  // container row), `openSub` = the pack the player opened (0 = the ground
  // object), `openGuid` = the container the strip shows, `rootMeta` = the
  // ground object's own meta (the row's first cell).
  items: [],
  packs: [],
  openSub: 0,
  openGuid: 0,
  rootMeta: null,
  counts: new Map(),
  selectedGuid: 0,
  despawnTimer: 0,
  // extcontainer-2: the container has had a world position since it opened
  // (a missing object then means it is gone, not "not arrived yet").
  seen: false,
  // Bug 1: bounded re-poll while listed items are not created yet.
  resolveTimer: 0,
  resolveTries: 0,
  lastLog: "",
};
const RESOLVE_POLL_MS = 250;
const RESOLVE_MAX_TRIES = 12;
let onKeyDownHandler = null;
let windowCtl = null;
let lootAll = null;

async function fetchIconDataUrl(iconId) {
  return fetchIconDataUrlShared(iconId, "corpse-loot-bar");
}

function fmtGuid(guid) {
  return `0x${(guid >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

// Same resolution chain as container-panel.js — playerInventory first (items
// already owned), entityManager meta second, wasm icon cache last.
//
// `invSnapshot` is ONE `takeInventorySnapshot(handle).inv` array shared by the
// whole refresh pass (see inventory_helpers.takeInventorySnapshot for why a
// per-item playerInventory() ratchets wasm memory).
function resolveItemMeta(guid, invSnapshot) {
  const g = guid >>> 0;
  const handle = window.__sessionHandle;
  try {
    for (const it of invSnapshot ?? []) {
      if ((it.guid >>> 0) === g) {
        return {
          guid: g,
          name: it.name || fmtGuid(g),
          iconId: (it.iconId >>> 0) || 0,
          stackSize: it.stackSize || 1,
          wcid: (it.wcid >>> 0) || 0,
          itemType: (it.itemType >>> 0) || 0,
          uiEffects: (it.uiEffects >>> 0) || 0,
        };
      }
    }
  } catch (_) {}
  try {
    const em = window.liveScene3d?.entityManager;
    const ent = em?.entityMap?.get?.(g) || em?.entityMap?.get?.(String(g)) || null;
    if (ent) {
      const meta = ent.meta || ent;
      return {
        guid: g,
        name: meta.name || ent.name || fmtGuid(g),
        iconId: (meta.iconId >>> 0) || 0,
        stackSize: Math.max(1, Number(meta.stackSize) || 1),
        wcid: (meta.wcid >>> 0) || 0,
        itemType: (meta.itemType >>> 0) || 0,
        uiEffects: (meta.uiEffects >>> 0) || 0,
      };
    }
  } catch (_) {}
  // Bug 1 (2026-10-07): a corpse's items have no rig and are not ours —
  // read them out of the wasm entity store (contained_item_meta.js).
  const stored = resolveContainedItemMeta(handle, g);
  if (stored) return stored;
  // Not created yet (ACE sends ViewContents before the CreateObjects):
  // placeholder, re-polled by refreshContents.
  const iconFromCache = (handle?.getObjectIconId?.(g) >>> 0) || 0;
  return { guid: g, name: fmtGuid(g), iconId: iconFromCache, stackSize: 1, wcid: 0, itemType: 0, uiEffects: 0, unresolved: true };
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      left: 0; top: 0;
      z-index: 66;
      display: none;
      flex-direction: column;
      width: max-content;
      min-width: 260px;
      /* 640 keeps the centred default clear of the right-docked main
         panel on any 16:9 window (HUD space is 1280 wide at every auto
         scale); 96 HUD-vw keeps it on screen in narrow windows. */
      max-width: min(640px, calc(96 * var(--hb-hud-vw, 12.8px)));
      max-height: calc(100 * var(--hb-hud-vh, 7.2px) - 8px);
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; }
    #${OVERLAY_ID} .hbk-titlebar { flex: 0 0 25px; }
    /* Ext_Container_ItemList + Ext_ItemListScroll (0x06004C7F rope). */
    #${OVERLAY_ID} .hclb-strip {
      flex: 0 0 auto;
      min-width: 0;
      display: flex;
      flex-direction: row;
      gap: 2px;
      padding: 6px 6px 3px;
      overflow-x: auto;
      overflow-y: hidden;
      min-height: 41px;
      box-sizing: border-box;
      scrollbar-width: thin;
      scrollbar-color: var(--hbk-gold-dim, #8a7544) #0a0806;
      overscroll-behavior: contain;
    }
    #${OVERLAY_ID} .hclb-strip::-webkit-scrollbar { height: 16px; }
    #${OVERLAY_ID} .hclb-strip::-webkit-scrollbar-track {
      background: url("${SP}/0x06004C7F.png") left center / 32px 16px repeat-x, #0a0806;
    }
    #${OVERLAY_ID} .hclb-strip::-webkit-scrollbar-thumb {
      border: 2px solid transparent; border-radius: 3px;
      background: linear-gradient(180deg, #6b5426, #f3d27a 45%, #b08a3c 70%, #5a4520) padding-box;
    }
    #${OVERLAY_ID} .hclb-strip > .hbk-empty { flex: 1 1 auto; padding: 8px 10px; }
    /* extcontainer-5 — retail m_topContainer (Container 0x10000064) and
       m_containerList (ContainerList 0x10000067): the ground object, then
       the packs inside it, as 36×36 ItemSlot_Backpack cells like the
       inventory's pack column; the open container wears the retail open
       frame. Shown only while the ground object holds a pack. */
    #${OVERLAY_ID} .hclb-packs {
      flex: 0 0 auto;
      display: none;
      flex-direction: row;
      align-items: center;
      min-width: 0;
      padding: 5px 6px 0;
    }
    #${OVERLAY_ID}[data-packs="1"] .hclb-packs { display: flex; }
    #${OVERLAY_ID} .hclb-packlist {
      display: flex;
      flex-direction: row;
      gap: 2px;
      min-width: 0;
      margin-left: 5px;
      padding-left: 5px;
      border-left: 1px solid var(--hbk-gold-deep, #4e3f1f);
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
    }
    #${OVERLAY_ID} .hclb-bag {
      position: relative;
      flex: 0 0 36px;
      width: 36px; height: 36px;
      box-sizing: border-box;
      background: url("./sprites/acsprites/icon-slot-bg.png") 2px 2px / 32px 32px no-repeat;
      image-rendering: pixelated;
      cursor: pointer;
    }
    #${OVERLAY_ID} .hclb-bag:hover { filter: brightness(1.2); }
    #${OVERLAY_ID} .hclb-bag > .hb-islot-icon {
      position: absolute; left: 2px; top: 2px; width: 32px; height: 32px;
      background: transparent center / 100% 100% no-repeat;
      image-rendering: pixelated;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hclb-bag > .hclb-bag-cap {
      position: absolute; left: 28px; top: 3px; width: 5px; height: 30px;
      background: url("${SP}/0x06004D22.png") center / 100% 100% no-repeat;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hclb-bag > .hclb-bag-cap > i {
      position: absolute; left: 0; right: 0; bottom: 0;
      height: var(--cap, 0%);
      background: url("${SP}/0x06004D23.png") center bottom / 5px 30px no-repeat;
    }
    #${OVERLAY_ID} .hclb-bag.is-open::after {
      content: ""; position: absolute; inset: 0; z-index: 3;
      background: url("${SP}/0x06005D9C.png") center / 100% 100% no-repeat;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hclb-bag.is-pending::before {
      content: ""; position: absolute; left: 2px; top: 2px; width: 32px; height: 32px; z-index: 2;
      background: url("${SP}/0x0600109A.png") center / 100% 100% no-repeat;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hbk-footer { justify-content: space-between; padding: 3px 6px; }
    #${OVERLAY_ID} .hclb-count { color: var(--hbk-text-dim, #a8a090); font-size: 11px; white-space: nowrap; }
    #${OVERLAY_ID} .hclb-actions { display: flex; gap: 6px; }
    #${OVERLAY_ID} .hbk-btn-small[disabled] { opacity: 0.45; cursor: default; filter: none; }
  `;
  document.head.appendChild(s);
}

function zoomOf(el) {
  const z = Number(el?.currentCSSZoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function buildOverlay() {
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "hbk-window";
  overlay.setAttribute("role", "dialog");

  const { bar, title } = makeTitlebar("Corpse", { onClose: () => closeBar() });
  overlay.appendChild(bar);

  // extcontainer-5: the ground object's cell + its packs (see ensureStyles).
  const packRow = document.createElement("div");
  packRow.className = "hclb-packs";
  const topCell = makeBagCell();
  topCell.addEventListener("click", (ev) => { ev.stopPropagation(); openContainer(0); });
  topCell.addEventListener("mouseenter", () => {
    showItemTooltip(topCell, `${state.corpseName || "Container"}\n${bagCountText(state.corpseGuid >>> 0)}`);
  });
  topCell.addEventListener("mouseleave", hideItemTooltip);
  const packList = document.createElement("div");
  packList.className = "hclb-packlist";
  packList.addEventListener("wheel", (ev) => {
    if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX) || packList.scrollWidth <= packList.clientWidth) return;
    packList.scrollLeft += ev.deltaY;
    ev.preventDefault();
  }, { passive: false });
  packRow.append(topCell, packList);
  overlay.appendChild(packRow);

  const strip = document.createElement("div");
  strip.className = "hclb-strip";
  // A vertical wheel scrolls the horizontal strip.
  strip.addEventListener("wheel", (ev) => {
    if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft += ev.deltaY;
    ev.preventDefault();
  }, { passive: false });
  overlay.appendChild(strip);

  const foot = document.createElement("div");
  foot.className = "hbk-footer";
  const count = document.createElement("span");
  count.className = "hclb-count";
  const actions = document.createElement("div");
  actions.className = "hclb-actions";
  const takeBtn = document.createElement("button");
  takeBtn.type = "button";
  takeBtn.className = "hbk-btn-small";
  takeBtn.textContent = "Take";
  takeBtn.title = "Move the selected item into your pack (or double-click it)";
  takeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (state.selectedGuid) takeItem(state.selectedGuid);
  });
  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = "hbk-btn-small";
  allBtn.textContent = "Loot all";
  allBtn.title = "Take every item, one at a time";
  allBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (lootAll) stopLootAll(); else startLootAll();
  });
  actions.append(takeBtn, allBtn);
  foot.append(count, actions);
  overlay.appendChild(foot);

  overlay._titleEl = title;
  overlay._stripEl = strip;
  overlay._countEl = count;
  overlay._takeBtn = takeBtn;
  overlay._allBtn = allBtn;
  overlay._cells = new Map();
  overlay._topCell = topCell;
  overlay._packListEl = packList;
  overlay._bagCells = new Map();
  document.body.appendChild(overlay);

  windowCtl = attachWindowPosition(overlay, {
    windowId: EXT_WINDOW_ID,
    dragHandle: bar,
    ignoreSelector: "button, .hbk-close",
  });

  registerDropZone(overlay, {
    resolve(ev, s) {
      const list = state.items.map((it) => it.guid >>> 0);
      // Drops go into the OPEN container (the ground object or the pack
      // opened in place); a drop on a container-row cell goes into that one.
      const openKey = (state.openGuid || state.corpseGuid) >>> 0;
      const bag = ev.target?.closest?.(".hclb-bag");
      const cell = bag ? null : ev.target?.closest?.(".hb-islot");
      let target;
      if (bag) {
        const bg = (parseInt(bag.dataset.guid, 10) >>> 0) || (state.corpseGuid >>> 0);
        const n = bg === openKey ? list.length : contentsCount(bg);
        target = { kind: DROP_TARGET.EMPTY_CELL, listKey: bg, listKind: "ext", index: n, count: n };
      } else if (cell && cell.dataset.guid) {
        const g = (parseInt(cell.dataset.guid, 10) >>> 0) || 0;
        const at = list.indexOf(g);
        target = {
          kind: DROP_TARGET.ITEM_CELL, listKey: openKey, listKind: "ext",
          index: at >= 0 ? at : list.length, count: list.length,
          item: state.items.find((it) => (it.guid >>> 0) === g) || null,
        };
      } else {
        target = { kind: DROP_TARGET.EMPTY_CELL, listKey: openKey, listKind: "ext", index: list.length, count: list.length };
      }
      const el = bag || cell || strip;
      if (!s) return { el, ok: true, target };
      const action = decideItemDrop({ ...s, split: 0 }, target, { ...extCtx(), canUseWith: () => null });
      return { el, ok: action.op !== "reject", reason: action.message, target };
    },
    async drop(ev, s, hit) {
      const action = await resolveDropAction(s, hit.target, { ctx: extCtx(), anchor: ev });
      if (!action || action.op === "noop") return;
      executeItemAction(action, s);
      render();
    },
  });

  pendingOps.onChange((evt) => {
    if (overlayEl?.dataset.open !== "1") return;
    onLootAllLedger(evt);
    render();
  });

  const reflow = () => {
    if (overlayEl?.dataset.open === "1") requestAnimationFrame(placeWindow);
  };
  window.addEventListener("resize", reflow);
  document.addEventListener("hb-hud-scale-changed", reflow);
  return overlay;
}

function extCtx() {
  return {
    playerGuid: localPlayerGuid(),
    containerName: (key) => {
      const k = (key >>> 0) || 0;
      const pack = k && k !== (state.corpseGuid >>> 0) ? state.packs.find((p) => (p.guid >>> 0) === k) : null;
      return pack?.name || state.corpseName || "container";
    },
  };
}

// An item in the window: the open container's contents or one of the packs.
function metaFor(guid) {
  const g = guid >>> 0;
  return state.items.find((it) => (it.guid >>> 0) === g) || state.packs.find((p) => (p.guid >>> 0) === g) || null;
}

/** Items inside a container in the window (counted at the last refresh, taken items excluded). */
function contentsCount(guid) {
  const g = guid >>> 0;
  if (state.counts.has(g)) return state.counts.get(g);
  try { return Array.from(window.__sessionHandle?.getContainerContents?.(g) || []).length; } catch (_) { return 0; }
}
function bagCapacity(guid) {
  try { return (window.__sessionHandle?.objectIntProperty?.(guid >>> 0, 6) | 0) || 0; } catch (_) { return 0; }
}
function bagCountText(guid) {
  const cap = bagCapacity(guid);
  return `${contentsCount(guid)} / ${cap || "?"} items`;
}

// extcontainer-5: open the ground object (0) or one of its packs in place.
function openContainer(packGuid) {
  const g = (packGuid >>> 0) || 0;
  if ((state.openSub >>> 0) === g) return;
  state.openSub = g;
  state.selectedGuid = 0;
  stopLootAll();
  if (overlayEl) overlayEl._stripEl.scrollLeft = 0;
  refreshContents();
}

// Keep the window on screen: centred above the toolbar until the player
// drags it (attachWindowPosition then owns the saved spot), and always
// clamped into the HUD viewport — the window grows/shrinks with its
// contents, so this runs after every render too.
function placeWindow() {
  const el = overlayEl;
  if (!el || el.dataset.open !== "1") return;
  // HUD px throughout: rects are screen px, style values are HUD px.
  const z = zoomOf(el);
  const vw = window.innerWidth / z;
  const vh = window.innerHeight / z;
  const r = el.getBoundingClientRect();
  const w = r.width / z;
  const h = r.height / z;
  const userPlaced = windowCtl?.getState?.().x != null;
  if (!userPlaced) {
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.left = `${Math.max(4, Math.round((vw - w) / 2))}px`;
    el.style.top = `${Math.max(4, Math.round(vh - h - DEFAULT_BOTTOM_GAP))}px`;
    return;
  }
  const left = r.left / z;
  const top = r.top / z;
  const nl = Math.max(0, Math.min(left, vw - w));
  const nt = Math.max(0, Math.min(top, vh - h));
  if (Math.abs(nl - left) > 0.5 || Math.abs(nt - top) > 0.5) {
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.left = `${nl}px`;
    el.style.top = `${nt}px`;
  }
}

function playerHandle() {
  return window.__sessionHandle ?? window.__pluginClient?._handle ?? null;
}

// The take — retail CPlayerSystem::PlaceInBackpack, shared with
// radial-menu.js "Take From Container" and the ground pickup
// (item_drag.planBackpackPlacement): a matching stack that takes it all is
// merged into (StackableMerge), else PutItemInContainer (0x0019) into the
// open side pack / the main pack / the first side pack with room. ACE does
// not overflow a full main pack by itself (limitToMainPackOnly). Optimistic:
// the cell is ghosted, and a moved item's ghost lands at the front of its
// destination until ACE echoes.
function takeItem(itemGuid) {
  const me = localPlayerGuid();
  const g = (itemGuid >>> 0) || 0;
  if (!me || !g || pendingOps.has(g)) return false;
  const meta = metaFor(g);
  if (!meta) return false;
  const isPack = ((meta.itemType >>> 0) & 0x200) !== 0;
  const action = planBackpackPlacement({ ...meta, isPack });
  if (action.op === "reject") {
    // "<player> is completely full!" — toasted, nothing sent.
    executeItemAction(action, { guid: g, item: meta, owned: false });
    return false;
  }
  const sent = executeItemAction(action, { guid: g, item: meta, owned: false }, {
    stub: action.op === "move"
      ? { name: meta.name, iconId: meta.iconId, stackSize: meta.stackSize || 1, wcid: meta.wcid || 0, itemType: meta.itemType || 0, equipMask: 0 }
      : null,
  });
  if (!sent) {
    // Pre-ledger fallback for a handle without the optimistic methods.
    const handle = playerHandle();
    if (typeof handle?.moveItem === "function") {
      try { handle.moveItem(g, me, 0); return true; } catch (e) { console.warn("[corpse-loot-bar] moveItem failed:", e); }
    }
    return false;
  }
  render();
  return true;
}

// What Loot all takes: the open container's items and — while the ground
// object itself is open — its packs, whole, after the loose items (as before
// extcontainer-5, when packs sat in the strip).
function lootCandidates() {
  const onRoot = !state.openGuid || (state.openGuid >>> 0) === (state.corpseGuid >>> 0);
  return onRoot ? state.items.concat(state.packs) : state.items;
}

function startLootAll() {
  lootAll = { waitGuid: 0, timer: 0, tries: new Map(), skipped: new Set(), lastBusyMs: -Infinity };
  render();
  lootStep();
}
function stopLootAll() {
  if (lootAll?.timer) clearTimeout(lootAll.timer);
  lootAll = null;
  render();
}
function scheduleLootStep(ms) {
  if (!lootAll) return;
  if (lootAll.timer) clearTimeout(lootAll.timer);
  lootAll.timer = setTimeout(lootStep, ms);
}
function lootStep() {
  if (!lootAll) return;
  if (lootAll.timer) { clearTimeout(lootAll.timer); lootAll.timer = 0; }
  if (overlayEl?.dataset.open !== "1") { stopLootAll(); return; }
  const w = lootAll.waitGuid >>> 0;
  const pool = lootCandidates();
  if (w) {
    // One take in flight, never two: while the server has not answered the
    // last one, only the watchdog is re-armed.
    const listed = pool.some((it) => (it.guid >>> 0) === w);
    if (listed && pendingOps.has(w)) {
      scheduleLootStep(LOOT_ALL_WATCHDOG_MS);
      return;
    }
    lootAll.waitGuid = 0;
  }
  const next = pool.find((it) => {
    const g = it.guid >>> 0;
    return !pendingOps.has(g) && !lootAll.skipped.has(g);
  });
  if (!next) {
    // Everything taken, skipped, or in flight from another take (a manual
    // double-click) — finish once nothing takeable is left.
    if (!pool.some((it) => !lootAll.skipped.has(it.guid >>> 0))) {
      const skipped = lootAll.skipped.size;
      stopLootAll();
      if (skipped > 0) {
        showItemToast(`Loot all finished — ${skipped === 1 ? "1 item" : `${skipped} items`} could not be taken.`);
      }
    } else {
      scheduleLootStep(LOOT_ALL_WATCHDOG_MS);
    }
    return;
  }
  const g = next.guid >>> 0;
  const tries = (lootAll.tries.get(g) || 0) + 1;
  if (tries > LOOT_ALL_MAX_TRIES) {
    lootAll.skipped.add(g);
    scheduleLootStep(0);
    return;
  }
  lootAll.tries.set(g, tries);
  lootAll.waitGuid = g;
  if (!takeItem(g)) {
    lootAll.waitGuid = 0;
    lootAll.skipped.add(g);
    scheduleLootStep(LOOT_ALL_NEXT_DELAY_MS);
    return;
  }
  scheduleLootStep(LOOT_ALL_WATCHDOG_MS);
}
// The server answered the awaited take (pending-ledger event).
function onLootAllLedger(evt) {
  if (!lootAll || !evt || (evt.guid >>> 0) !== (lootAll.waitGuid >>> 0)) return;
  if (evt.type === "fail") {
    // ACE refuses a pickup that lands while the previous one is still in its
    // Start phase with YoureTooBusy (sent just before the
    // InventoryServerSaveFailed) — wait for the player to stand back up and
    // try the same item again. Any other refusal (too encumbered, pack full,
    // someone else took it) stops the loop as before.
    if (performance.now() - lootAll.lastBusyMs <= LOOT_ALL_BUSY_WINDOW_MS) {
      scheduleLootStep(LOOT_ALL_RETRY_DELAY_MS);
      return;
    }
    stopLootAll();
    showItemToast(`Loot all stopped — the ${evt.entry?.stub?.name || "item"} could not be taken.`);
    return;
  }
  if (evt.type === "resolve" || evt.type === "expire") {
    // Taken (or the ledger stopped waiting — lootStep re-checks the strip).
    scheduleLootStep(LOOT_ALL_NEXT_DELAY_MS);
  }
}
function onLootAllWeenieError(ev) {
  if (!lootAll) return;
  const p = ev?.detail ?? ev ?? {};
  if (((p.u32Payload >>> 0) || 0) === WERR_YOURE_TOO_BUSY) lootAll.lastBusyMs = performance.now();
}

// Bug 12 (2026-10-07): the retail item composite (ui/ac_icon_compose.js);
// a failed fetch clears the memo so the next refresh retries.
function setCellIcon(cell, it) {
  const iconId = (it.iconId >>> 0) || 0;
  const key = iconId ? itemIconKey(it) : "";
  if (cell._iconKey === key) return;
  cell._iconKey = key;
  cell._iconId = iconId;
  const icon = cell._icon;
  icon.style.backgroundImage = "";
  icon.style.backgroundColor = iconId ? "" : "rgba(60, 50, 34, 0.8)";
  if (!iconId) return;
  const hit = getItemIconImmediate(it);
  if (hit) { icon.style.backgroundImage = `url("${hit}")`; return; }
  fetchItemIconDataUrl(it, "corpse-loot-bar").then((url) => {
    if (cell._iconKey !== key) return;
    if (typeof url !== "string") { cell._iconKey = null; return; }
    icon.style.backgroundImage = `url("${url}")`;
  });
}

function makeCell() {
  const cell = document.createElement("div");
  cell.className = "hb-islot";
  const icon = document.createElement("div");
  icon.className = "hb-islot-icon";
  cell.appendChild(icon);
  cell._icon = icon;
  cell._iconId = -1;
  cell.draggable = true;
  cell.addEventListener("click", (ev) => {
    ev.stopPropagation();
    state.selectedGuid = (parseInt(cell.dataset.guid, 10) >>> 0) || 0;
    render();
  });
  cell.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    takeItem(parseInt(cell.dataset.guid, 10) >>> 0);
  });
  cell.addEventListener("mouseenter", () => showItemTooltip(cell, cell._name || ""));
  cell.addEventListener("mouseleave", hideItemTooltip);
  cell.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const g = (parseInt(cell.dataset.guid, 10) >>> 0) || 0;
    if (!g || typeof window.__openContextMenuFor !== "function") return;
    try {
      window.__openContextMenuFor({
        source: "container-panel",
        guid: g,
        containerGuid: (state.openGuid || state.corpseGuid) >>> 0,
        slotIndex: state.items.findIndex((it) => (it.guid >>> 0) === g),
        name: cell._name || "",
        clientX: ev.clientX,
        clientY: ev.clientY,
      });
    } catch (e) { console.warn("[corpse-loot-bar] context menu failed:", e); }
  });
  cell.addEventListener("dragstart", (ev) => {
    const g = (parseInt(cell.dataset.guid, 10) >>> 0) || 0;
    const it = state.items.find((x) => (x.guid >>> 0) === g);
    if (!it || pendingOps.has(g)) { ev.preventDefault(); return; }
    hideItemTooltip();
    beginItemDrag(ev, {
      guid: g,
      item: { ...it, isPack: ((it.itemType >>> 0) & 0x200) !== 0 },
      owned: false,
      sourceList: { key: (state.openGuid || state.corpseGuid) >>> 0, kind: "ext" },
      sourceIndex: state.items.indexOf(it),
      sourceEl: cell,
    });
  });
  return cell;
}

// extcontainer-5 container-row cell (ItemSlot_Backpack: icon + capacity bar).
function makeBagCell() {
  const cell = document.createElement("div");
  cell.className = "hclb-bag";
  const icon = document.createElement("div");
  icon.className = "hb-islot-icon";
  const cap = document.createElement("div");
  cap.className = "hclb-bag-cap";
  cap.appendChild(document.createElement("i"));
  cell.append(icon, cap);
  cell._icon = icon;
  cell._cap = cap;
  cell._iconId = -1;
  return cell;
}
function setBagCapacity(cell, used, cap) {
  const frac = cap > 0 ? Math.max(0, Math.min(1, used / cap)) : 0;
  cell._cap.style.display = cap > 0 ? "" : "none";
  cell._cap.firstChild.style.setProperty("--cap", `${Math.round(frac * 100)}%`);
}
// A pack inside the ground object: click (or double-click) opens it in
// place — retail never takes a container-list entry on a click; drag it out
// or use the context menu's Take to take the whole pack.
function makePackCell() {
  const cell = makeBagCell();
  cell.draggable = true;
  const guidOf = () => (parseInt(cell.dataset.guid, 10) >>> 0) || 0;
  cell.addEventListener("click", (ev) => { ev.stopPropagation(); openContainer(guidOf()); });
  cell.addEventListener("dblclick", (ev) => { ev.stopPropagation(); ev.preventDefault(); });
  cell.addEventListener("mouseenter", () => showItemTooltip(cell, `${cell._name || "Pack"}\n${bagCountText(guidOf())}`));
  cell.addEventListener("mouseleave", hideItemTooltip);
  cell.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const g = guidOf();
    if (!g || typeof window.__openContextMenuFor !== "function") return;
    try {
      window.__openContextMenuFor({
        source: "container-panel",
        guid: g,
        containerGuid: state.corpseGuid >>> 0,
        slotIndex: state.packs.findIndex((p) => (p.guid >>> 0) === g),
        name: cell._name || "",
        clientX: ev.clientX,
        clientY: ev.clientY,
      });
    } catch (e) { console.warn("[corpse-loot-bar] context menu failed:", e); }
  });
  cell.addEventListener("dragstart", (ev) => {
    const g = guidOf();
    const p = state.packs.find((x) => (x.guid >>> 0) === g);
    if (!p || pendingOps.has(g)) { ev.preventDefault(); return; }
    hideItemTooltip();
    beginItemDrag(ev, {
      guid: g,
      item: { ...p, isPack: true },
      owned: false,
      sourceList: { key: state.corpseGuid >>> 0, kind: "ext" },
      sourceIndex: state.packs.indexOf(p),
      sourceEl: cell,
    });
  });
  return cell;
}

function renderPackRow() {
  const root = state.corpseGuid >>> 0;
  const open = (state.openGuid || root) >>> 0;
  const top = overlayEl._topCell;
  top.dataset.guid = String(root);
  if (state.rootMeta) setCellIcon(top, state.rootMeta);
  setBagCapacity(top, contentsCount(root), bagCapacity(root));
  top.classList.toggle("is-open", open === root);
  const list = overlayEl._packListEl;
  const cache = overlayEl._bagCells;
  const want = [];
  const used = new Set();
  for (const p of state.packs) {
    const key = String(p.guid >>> 0);
    let cell = cache.get(key);
    if (!cell) { cell = makePackCell(); cache.set(key, cell); }
    cell.dataset.guid = key;
    cell._name = p.name;
    setCellIcon(cell, p);
    setBagCapacity(cell, contentsCount(p.guid), bagCapacity(p.guid));
    cell.classList.toggle("is-open", open === (p.guid >>> 0));
    cell.classList.toggle("is-pending", pendingOps.has(p.guid >>> 0));
    want.push(cell);
    used.add(key);
  }
  for (const [k, el] of cache) {
    if (!used.has(k)) { el.remove(); cache.delete(k); }
  }
  let cur = list.firstChild;
  for (const el of want) {
    if (el === cur) { cur = cur.nextSibling; continue; }
    list.insertBefore(el, cur);
  }
}

function setCellEffects(cell, bits) {
  if (cell._fxBits === bits) return;
  cell._fxBits = bits;
  cell._fx?.remove();
  cell._fx = null;
  if (!bits || !uiEffectBadgesEnabled()) return;
  const fx = uiEffectIconsFor(bits);
  if (!fx.length) return;
  const wrap = document.createElement("span");
  wrap.className = "hb-islot-fx";
  for (const f of fx) {
    const dot = document.createElement("span");
    dot.title = f.name;
    dot.style.backgroundColor = uiEffectTintCss(f.tint) || "";
    wrap.appendChild(dot);
    if (f.iconDid) {
      fetchIconDataUrl(f.iconDid >>> 0).then((url) => {
        if (url && dot.isConnected) { dot.style.backgroundColor = ""; dot.style.backgroundImage = `url("${url}")`; }
      }).catch(() => {});
    }
  }
  cell._fx = wrap;
  cell.appendChild(wrap);
}

function render() {
  if (!overlayEl) return;
  setAcText(overlayEl._titleEl, state.corpseName || "Container", { color: "#f3d27a" });
  const strip = overlayEl._stripEl;
  const cache = overlayEl._cells;
  const n = state.items.length;
  // extcontainer-5: the container row while the ground object holds packs;
  // the count names the pack when one is open.
  const nested = state.packs.length > 0;
  overlayEl.dataset.packs = nested ? "1" : "0";
  if (nested) renderPackRow();
  const openPack = nested && (state.openGuid >>> 0) !== (state.corpseGuid >>> 0)
    ? state.packs.find((p) => (p.guid >>> 0) === (state.openGuid >>> 0)) : null;
  const countText = n === 0 ? "Empty" : (n === 1 ? "1 item" : `${n} items`);
  overlayEl._countEl.textContent = openPack ? `${openPack.name}: ${countText}` : countText;
  overlayEl._takeBtn.disabled = !state.selectedGuid || pendingOps.has(state.selectedGuid);
  overlayEl._allBtn.disabled = n === 0 && !lootAll && !(nested && !openPack);
  overlayEl._allBtn.textContent = lootAll ? "Stop" : "Loot all";

  let empty = strip.querySelector(":scope > .hbk-empty");
  if (!n) {
    for (const el of cache.values()) el.remove();
    cache.clear();
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "hbk-empty";
      empty.textContent = "There is nothing inside.";
      strip.appendChild(empty);
    }
    requestAnimationFrame(placeWindow);
    return;
  }
  empty?.remove();
  const want = [];
  const used = new Set();
  for (const it of state.items) {
    const key = String(it.guid >>> 0);
    let cell = cache.get(key);
    if (!cell) { cell = makeCell(); cache.set(key, cell); }
    cell.dataset.guid = key;
    cell._name = it.stackSize > 1 ? `${it.name} (${it.stackSize})` : it.name;
    setCellIcon(cell, it);
    setCellEffects(cell, (it.uiEffects >>> 0) || 0);
    if (it.stackSize > 1) {
      if (!cell._stack) {
        cell._stack = document.createElement("span");
        cell._stack.className = "hb-islot-stack";
        cell.appendChild(cell._stack);
      }
      setAcText(cell._stack, String(it.stackSize), { color: "#ffffff" });
    } else if (cell._stack) { cell._stack.remove(); cell._stack = null; }
    cell.classList.toggle("is-selected", (it.guid >>> 0) === (state.selectedGuid >>> 0));
    cell.classList.toggle("is-pending", pendingOps.has(it.guid >>> 0));
    want.push(cell);
    used.add(key);
  }
  for (const [k, el] of cache) {
    if (!used.has(k)) { el.remove(); cache.delete(k); }
  }
  let cur = strip.firstChild;
  for (const el of want) {
    if (el === cur) { cur = cur.nextSibling; continue; }
    strip.insertBefore(el, cur);
  }
  requestAnimationFrame(placeWindow);
}

function refreshContents() {
  const handle = window.__sessionHandle;
  const g = state.corpseGuid >>> 0;
  if (!g || !handle?.getContainerContents) return;
  const contentsOf = (c) => {
    try {
      return Array.from(handle.getContainerContents(c) || []);
    } catch (e) {
      console.warn("[corpse-loot-bar] getContainerContents failed", e);
      return [];
    }
  };
  let guids = contentsOf(g);
  // (2026-07-02) — the wasm ViewContents snapshot (`latest_container_contents`)
  // is NOT pruned when an item is picked up, so a just-taken item lingers in
  // the GUID list. An item in `playerInventory()` is owned (moved out of the
  // container into our pack) — filter those out so the strip shows the true
  // remaining contents. `playerInventory` is owned-items-only, so this never
  // hides un-looted items.
  //
  // ONE snapshot serves both the owned-filter and every per-item meta resolve;
  // `free()` runs in a `finally` so a throw inside resolveItemMeta still
  // releases the boxes.
  const listed = guids.length;
  const snap = takeInventorySnapshot(handle);
  let unresolved = 0;
  try {
    const owned = new Set(snap.inv.map((it) => (it.guid >>> 0)));
    const notOwned = (list) => (owned.size ? list.filter((x) => !owned.has(x >>> 0)) : list);
    guids = notOwned(guids);
    const rootItems = guids.map((x) => resolveItemMeta(x, snap.inv));
    unresolved = rootItems.filter((it) => it.unresolved).length;
    state.counts = new Map([[g, guids.length]]);
    if (extNestedPacksEnabled()) {
      // extcontainer-5: the packs go in the container row; the strip shows
      // the open container — the ground object, or the pack opened in place
      // (its contents came with the chest's ViewContents).
      const packs = externalContainerView({ root: g, rootItems }).packs;
      for (const p of packs) state.counts.set(p.guid >>> 0, notOwned(contentsOf(p.guid >>> 0)).length);
      const wantSub = (state.openSub >>> 0) || 0;
      let subItems = null;
      if (wantSub && packs.some((p) => (p.guid >>> 0) === wantSub)) {
        subItems = notOwned(contentsOf(wantSub)).map((x) => resolveItemMeta(x, snap.inv));
        unresolved += subItems.filter((it) => it.unresolved).length;
      }
      const view = externalContainerView({ root: g, openSub: wantSub, rootItems, subItems });
      // The open pack left the ground object: back to the first container
      // (retail ItemList_OpenFirstContainer), and it stays there.
      if (view.open !== (wantSub || g)) state.openSub = 0;
      state.items = view.items;
      state.packs = view.packs;
      state.openGuid = view.open;
      state.rootMeta = view.packs.length ? resolveItemMeta(g, snap.inv) : null;
    } else {
      state.items = rootItems;
      state.packs = [];
      state.openGuid = g;
      state.rootMeta = null;
    }
  } finally {
    snap.free();
  }
  // Everything the window shows: the open container's items and the packs.
  const shown = state.items.concat(state.packs).map((it) => it.guid >>> 0);
  if (!shown.includes(state.selectedGuid >>> 0)) {
    state.selectedGuid = 0;
  }
  // Bug 1: the items' CreateObjects follow the ViewContents, so some may
  // still be placeholders — re-poll a few times until every one resolves.
  const line = `[corpse-loot] 0x${g.toString(16)} listed=${listed} shown=${state.items.length}` +
    `${state.packs.length ? ` packs=${state.packs.length} open=0x${(state.openGuid >>> 0).toString(16)}` : ""} unresolved=${unresolved}`;
  if (line !== state.lastLog) {
    state.lastLog = line;
    console.info(line);
  }
  if (state.resolveTimer) { clearTimeout(state.resolveTimer); state.resolveTimer = 0; }
  if (unresolved > 0 && state.resolveTries < RESOLVE_MAX_TRIES) {
    state.resolveTries++;
    state.resolveTimer = setTimeout(() => {
      state.resolveTimer = 0;
      if (overlayEl?.dataset.open === "1" && (state.corpseGuid >>> 0) === g) refreshContents();
    }, RESOLVE_POLL_MS);
  }
  render();
  if (lootAll && lootAll.waitGuid && !shown.includes(lootAll.waitGuid >>> 0)) {
    // The awaited item left the container — the server has moved it and is
    // standing the player back up, which is exactly when ACE accepts (queues)
    // the next pickup. Take the next one promptly.
    scheduleLootStep(LOOT_ALL_NEXT_DELAY_MS);
  }
}

function openFor(corpseGuid, corpseName) {
  const g = (corpseGuid >>> 0) || 0;
  if (!g) return;
  if (!overlayEl) overlayEl = buildOverlay();
  if (state.corpseGuid !== g) {
    stopLootAll();
    overlayEl._stripEl.scrollLeft = 0;
    // A new ground object opens on itself (retail SetGroundObject).
    state.openSub = 0;
  }
  state.corpseGuid = g;
  state.corpseName = corpseName || "Container";
  state.selectedGuid = 0;
  state.resolveTries = 0;
  state.lastLog = "";
  overlayEl.dataset.open = "1";
  refreshContents();
  // Place synchronously (offsetWidth forces layout) so the first painted
  // frame is already on screen — no flash at the CSS default corner.
  placeWindow();

  if (!onKeyDownHandler) {
    onKeyDownHandler = (ev) => {
      if (overlayEl?.dataset.open !== "1" || ev.key !== "Escape") return;
      const tag = ev.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || window.__radialMenuOpen) return;
      ev.preventDefault();
      ev.stopPropagation();
      closeBar();
    };
    document.addEventListener("keydown", onKeyDownHandler, true);
  }
  // Once a second (retail's interval): the range check below, or with
  // `?groundContainerRange=off` the old despawn poll (TimeToRot delete →
  // KIND_REMOVE empties the entity map entry).
  state.seen = false;
  if (state.despawnTimer) clearInterval(state.despawnTimer);
  state.despawnTimer = setInterval(() => {
    if (overlayEl?.dataset.open !== "1") {
      clearInterval(state.despawnTimer);
      state.despawnTimer = 0;
      return;
    }
    if (groundContainerRangeEnabled() && typeof window.__sessionHandle?.objectPosition === "function") {
      checkGroundRange();
      return;
    }
    try {
      const em = window.liveScene3d?.entityManager;
      if (em?.entityMap && !em.entityMap.has(state.corpseGuid >>> 0)) closeBar();
    } catch (_) {}
  }, DESPAWN_POLL_MS);
}

// extcontainer-2 (2026-10-08, `?groundContainerRange`): retail
// gmExternalContainerUI::SetGroundObject (acclient.c:253157) registers an
// object range handler with the container's UseRadius (use radii, 3-D,
// 1 s); out of range, or the object gone (ObjectsInRange :436730), closes
// the window — walking off, a portal and a death teleport all end there.
// Read from the wasm world (works before the 3D rig loads and under
// nullRender). A container the player owns or that sits inside another
// (opened through __openContainerFor) has no range rule.
function checkGroundRange() {
  const h = window.__sessionHandle;
  const g = state.corpseGuid >>> 0;
  if (!g) return;
  let pos = [];
  try { pos = Array.from(h.objectPosition(g) || []); } catch (_) { return; }
  let containerPos = null;
  if (pos.length) {
    const iid = (stype) => {
      try { return (h.objectInstanceIdProperty?.(g, stype) >>> 0) || 0; } catch (_) { return 0; }
    };
    const facts = { landblock: Number(pos[0]) >>> 0, containerId: iid(2), wielderId: iid(3) };
    if (!isLandscapeGroundObject(facts)) return;
    containerPos = landblockToWorld(pos);
    if (containerPos) state.seen = true;
  }
  let playerPos = null;
  try {
    const pose = typeof h.getLocalPlayerPose === "function" ? h.getLocalPlayerPose() : null;
    if (pose) {
      playerPos = landblockToWorld([pose.landblockId, pose.x, pose.y, pose.z]);
      try { pose.free?.(); } catch (_) {}
    }
  } catch (_) {}
  const me = localPlayerGuid();
  if (!playerPos && me) {
    try { playerPos = landblockToWorld(h.objectPosition(me)); } catch (_) {}
  }
  const dims = (guid) => {
    try { return Array.from(h.objectPartDims?.(guid) || []); } catch (_) { return []; }
  };
  let useRadius;
  try { useRadius = h.objectFloatProperty?.(g, 54) ?? undefined; } catch (_) {}
  const verdict = groundContainerRangeVerdict({
    useRadius,
    containerPos,
    playerPos,
    containerDims: dims(g),
    playerDims: me ? dims(me) : [],
    seen: state.seen,
  });
  if (verdict === "close") {
    console.info(`[corpse-loot] 0x${g.toString(16)} out of range — closing`);
    closeBar();
  }
}

function closeBar() {
  if (!overlayEl) return;
  const g = state.corpseGuid >>> 0;
  overlayEl.dataset.open = "0";
  hideItemTooltip();
  stopLootAll();
  state.corpseGuid = 0;
  state.selectedGuid = 0;
  state.openSub = 0;
  state.openGuid = 0;
  state.packs = [];
  if (state.resolveTimer) { clearTimeout(state.resolveTimer); state.resolveTimer = 0; }
  // CM_Inventory::Event_NoLongerViewingContents. Retail closes with a
  // toggle Use (CloseCurrentContainer → ItemHolder::UseObject); with ACE a
  // late Use would re-open the chest, while this notice is idempotent
  // (Player_Use.cs HandleActionNoLongerViewingContents).
  try { if (g) playerHandle()?.noLongerViewingContents?.(g); } catch (_) {}
  if (state.despawnTimer) {
    clearInterval(state.despawnTimer);
    state.despawnTimer = 0;
  }
  if (onKeyDownHandler) {
    document.removeEventListener("keydown", onKeyDownHandler, true);
    onKeyDownHandler = null;
  }
}

function onInvChanged() {
  if (overlayEl?.dataset.open === "1" && state.corpseGuid) refreshContents();
}

// Server CloseGroundContainer (walked out of range / container closed) —
// retail gmExternalContainerUI::RecvNotice_StopViewingObject.
function onContainerClosed(ev) {
  const p = ev?.detail ?? ev ?? {};
  const g = (p.u32Payload >>> 0) || 0;
  if (overlayEl?.dataset.open === "1" && g && g === (state.corpseGuid >>> 0)) closeBar();
}

// use-3 remainder (2026-10-08 follow-ups): a UseDone move failure
// (MotionFailure / ObjectGone / NoObject / CantGetThere) runs retail
// HandleFailureEvent's `ClientUISystem::SetGroundObject(0, 1)`
// (acclient.c:415858-415867, :401643-401687): the open ground container
// closes, the server is told (closeBar sends NoLongerViewingContents — the
// askServer leg) and a selection inside it is dropped (closeBar clears ours).
// Nothing happens when no ground container is open. `?moveFailCloseGround=off`.
function onUseFailedClearGroundObject(ev) {
  const p = ev?.detail ?? ev ?? {};
  if (!clearsGroundObjectOnFailure(p.u32Payload)) return;
  if (!moveFailCloseGroundEnabled()) return;
  if (overlayEl?.dataset.open === "1" && state.corpseGuid) closeBar();
}

// extcontainer-2: the cases the range check would only catch a second
// later, or after the teleport. Retail Handle_VendorInfo calls
// SetGroundObject(0, 1) (acclient.c:403011): opening a vendor closes the
// ground container (and tells the server). A portal and the local death
// leave the container's range.
function closeIfOpenFor(why) {
  if (!groundContainerRangeEnabled()) return;
  if (overlayEl?.dataset.open !== "1" || !state.corpseGuid) return;
  console.info(`[corpse-loot] ${why} — closing`);
  closeBar();
}
function onVendorOpenedCloseGround() { closeIfOpenFor("vendor opened"); }
function onPortalSpaceCloseGround() { closeIfOpenFor("portal space entered"); }
function onDeathCloseGround(ev) {
  const victim = (ev?.detail?.victimGuid ?? 0) >>> 0;
  const local = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
  if (victim && local && victim === local) closeIfOpenFor("local player died");
}

// Subscribe at module-load (container-panel's poll-for-bus pattern). The
// kind=21 routing itself lives in container-panel.js (it delegates every
// ground container here via window.__corpseLootBar).
let _subscribeTimer = null;
function trySubscribe() {
  const client = window.__pluginClient ?? null;
  if (!client?.events?.on) return false;
  client.events.on("playerInventoryChanged", onInvChanged);
  client.events.on("containerClosed", onContainerClosed);
  client.events.on("kind:13", onLootAllWeenieError);
  client.events.on("kind:13", onUseFailedClearGroundObject);
  client.events.on("vendorOpened", onVendorOpenedCloseGround);
  client.events.on("kind:12", onVendorOpenedCloseGround);
  client.events.on("portalSpaceEntered", onPortalSpaceCloseGround);
  client.events.on("death", onDeathCloseGround);
  return true;
}
if (typeof window !== "undefined") {
  if (!trySubscribe()) {
    _subscribeTimer = setInterval(() => {
      if (trySubscribe()) {
        clearInterval(_subscribeTimer);
        _subscribeTimer = null;
      }
    }, 500);
  }
  // The delegation surface container-panel.js routes kind=21 events to,
  // plus debug hooks mirroring __openContainerFor / __closeContainerPanel.
  window.__corpseLootBar = { openFor, close: closeBar, isOpen: () => overlayEl?.dataset.open === "1", current: () => state.corpseGuid >>> 0 };
  window.__openCorpseLootBarFor = (guid, name) =>
    openFor(guid >>> 0, name || `Corpse ${fmtGuid(guid)}`);
  window.__closeCorpseLootBar = closeBar;
}

export const manifest = {
  id: "corpse-loot-bar",
  name: "External Container",
  icon: "\u{1F480}",
  iconHidden: true,
  version: "0.1.0",
  description: "External-container window (retail gmExternalContainerUI) for corpses and chests — container-panel routes kind=21 ContainerOpened events here",
};
