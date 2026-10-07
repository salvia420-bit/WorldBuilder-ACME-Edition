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
//   * double-click / Take / Loot all move items into the main pack exactly
//     like radial-menu.js "Take From Container": moveItem(item, player, 0)
//     → PutItemInContainer 0x0019. Loot all paces one take per server echo.
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
import { takeInventorySnapshot, decideItemDrop, DROP_TARGET, MAIN_PACK_KEY, PACKS_KEY } from "./inventory_helpers.js";
import { resolveContainedItemMeta } from "./contained_item_meta.js";
import {
  beginItemDrag,
  registerDropZone,
  resolveDropAction,
  executeItemAction,
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
const LOOT_ALL_STEP_MS = 700;
const SP = "./data/ui-sprites";

let overlayEl = null;
let state = {
  corpseGuid: 0,
  corpseName: "",
  items: [],
  selectedGuid: 0,
  despawnTimer: 0,
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
  document.body.appendChild(overlay);

  windowCtl = attachWindowPosition(overlay, {
    windowId: EXT_WINDOW_ID,
    dragHandle: bar,
    ignoreSelector: "button, .hbk-close",
  });

  registerDropZone(overlay, {
    resolve(ev, s) {
      const list = state.items.map((it) => it.guid >>> 0);
      const cell = ev.target?.closest?.(".hb-islot");
      let target;
      if (cell && cell.dataset.guid) {
        const g = (parseInt(cell.dataset.guid, 10) >>> 0) || 0;
        const at = list.indexOf(g);
        target = {
          kind: DROP_TARGET.ITEM_CELL, listKey: state.corpseGuid >>> 0, listKind: "ext",
          index: at >= 0 ? at : list.length, count: list.length,
          item: state.items.find((it) => (it.guid >>> 0) === g) || null,
        };
      } else {
        target = { kind: DROP_TARGET.EMPTY_CELL, listKey: state.corpseGuid >>> 0, listKind: "ext", index: list.length, count: list.length };
      }
      const el = cell || strip;
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
    if (lootAll && evt?.type === "fail" && evt.guid === lootAll.waitGuid) {
      stopLootAll();
      showItemToast(`Loot all stopped — the ${evt.entry?.stub?.name || "item"} could not be taken.`);
    }
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
    containerName: () => state.corpseName || "container",
  };
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

// The take wire — identical to radial-menu.js's "Take From Container":
// moveItem(itemGuid, localPlayerGuid, 0) → PutItemInContainer (0x0019) into
// the main pack (ACE overflows into side packs). Optimistic: the cell is
// ghosted and a ghost lands at the front of the main pack until ACE echoes.
function takeItem(itemGuid) {
  const me = localPlayerGuid();
  const g = (itemGuid >>> 0) || 0;
  if (!me || !g || pendingOps.has(g)) return false;
  const meta = state.items.find((it) => (it.guid >>> 0) === g);
  if (!meta) return false;
  const isPack = ((meta.itemType >>> 0) & 0x200) !== 0;
  const action = {
    op: "move", guid: g, container: me, placement: 0,
    listKey: isPack ? PACKS_KEY : MAIN_PACK_KEY, index: 0, amount: meta.stackSize || 1,
  };
  const sent = executeItemAction(action, { guid: g, item: meta, owned: false }, {
    stub: { name: meta.name, iconId: meta.iconId, stackSize: meta.stackSize || 1, wcid: meta.wcid || 0, itemType: meta.itemType || 0, equipMask: 0 },
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

function startLootAll() {
  lootAll = { waitGuid: 0, timer: 0 };
  render();
  lootStep();
}
function stopLootAll() {
  if (lootAll?.timer) clearTimeout(lootAll.timer);
  lootAll = null;
  render();
}
function lootStep() {
  if (!lootAll) return;
  if (lootAll.timer) { clearTimeout(lootAll.timer); lootAll.timer = 0; }
  if (overlayEl?.dataset.open !== "1") { stopLootAll(); return; }
  const next = state.items.find((it) => !pendingOps.has(it.guid >>> 0));
  if (!next) {
    // Everything taken or in flight — finish once the strip is empty.
    if (!state.items.length) stopLootAll();
    else lootAll.timer = setTimeout(lootStep, LOOT_ALL_STEP_MS);
    return;
  }
  lootAll.waitGuid = next.guid >>> 0;
  if (!takeItem(next.guid)) { stopLootAll(); return; }
  lootAll.timer = setTimeout(lootStep, LOOT_ALL_STEP_MS);
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
        containerGuid: state.corpseGuid >>> 0,
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
      sourceList: { key: state.corpseGuid >>> 0, kind: "ext" },
      sourceIndex: state.items.indexOf(it),
      sourceEl: cell,
    });
  });
  return cell;
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
  overlayEl._countEl.textContent = n === 0 ? "Empty" : (n === 1 ? "1 item" : `${n} items`);
  overlayEl._takeBtn.disabled = !state.selectedGuid || pendingOps.has(state.selectedGuid);
  overlayEl._allBtn.disabled = n === 0 && !lootAll;
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
  let guids = [];
  try {
    guids = Array.from(handle.getContainerContents(g) || []);
  } catch (e) {
    console.warn("[corpse-loot-bar] getContainerContents failed", e);
  }
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
  try {
    const owned = new Set(snap.inv.map((it) => (it.guid >>> 0)));
    if (owned.size) guids = guids.filter((x) => !owned.has(x >>> 0));
    state.items = guids.map((x) => resolveItemMeta(x, snap.inv));
  } finally {
    snap.free();
  }
  if (!guids.some((x) => (x >>> 0) === (state.selectedGuid >>> 0))) {
    state.selectedGuid = 0;
  }
  // Bug 1: the items' CreateObjects follow the ViewContents, so some may
  // still be placeholders — re-poll a few times until every one resolves.
  const unresolved = state.items.filter((it) => it.unresolved).length;
  const line = `[corpse-loot] 0x${g.toString(16)} listed=${listed} shown=${state.items.length} unresolved=${unresolved}`;
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
  if (lootAll && lootAll.waitGuid && !guids.some((x) => (x >>> 0) === lootAll.waitGuid)) {
    // The awaited item arrived — take the next one promptly.
    if (lootAll.timer) clearTimeout(lootAll.timer);
    lootAll.timer = setTimeout(lootStep, 120);
  }
}

function openFor(corpseGuid, corpseName) {
  const g = (corpseGuid >>> 0) || 0;
  if (!g) return;
  if (!overlayEl) overlayEl = buildOverlay();
  if (state.corpseGuid !== g) {
    stopLootAll();
    overlayEl._stripEl.scrollLeft = 0;
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
  // Auto-close when the corpse despawns (TimeToRot delete → KIND_REMOVE
  // empties the entity map entry). Poll — despawn has no bus event.
  if (state.despawnTimer) clearInterval(state.despawnTimer);
  state.despawnTimer = setInterval(() => {
    if (overlayEl?.dataset.open !== "1") {
      clearInterval(state.despawnTimer);
      state.despawnTimer = 0;
      return;
    }
    try {
      const em = window.liveScene3d?.entityManager;
      if (em?.entityMap && !em.entityMap.has(state.corpseGuid >>> 0)) closeBar();
    } catch (_) {}
  }, DESPAWN_POLL_MS);
}

function closeBar() {
  if (!overlayEl) return;
  const g = state.corpseGuid >>> 0;
  overlayEl.dataset.open = "0";
  hideItemTooltip();
  stopLootAll();
  state.corpseGuid = 0;
  state.selectedGuid = 0;
  if (state.resolveTimer) { clearTimeout(state.resolveTimer); state.resolveTimer = 0; }
  // CM_Inventory::Event_NoLongerViewingContents — only if the wasm build
  // exposes it (it does not yet; ACE then frees the chest on range exit).
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

// Subscribe at module-load (container-panel's poll-for-bus pattern). The
// kind=21 routing itself lives in container-panel.js (it delegates every
// ground container here via window.__corpseLootBar).
let _subscribeTimer = null;
function trySubscribe() {
  const client = window.__pluginClient ?? null;
  if (!client?.events?.on) return false;
  client.events.on("playerInventoryChanged", onInvChanged);
  client.events.on("containerClosed", onContainerClosed);
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
