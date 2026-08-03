// corpse-loot-bar — horizontal loot strip for corpse containers (2026-07-02).
//
// Retail-flow: kill → corpse Container ObjectCreate (ODF Corpse bit 0x2000,
// ACE Corpse.cs:56, loot pre-filled server-side by Creature_Death.
// GenerateTreasure) → double-click sends GameAction::Use 0x0036 → ACE
// Container.Open → GameEvent::ViewContents 0x0196 → client kind=21
// ContainerOpened. container-panel.js routes CORPSE containers here (its
// grid keeps chests/bags); this plugin renders the user-requested
// HORIZONTAL bar — the vendor-ui icon-strip pattern (plugins/vendor-ui.js
// `hvb-icon-cell` strip) applied to loot:
//
//   [ Corpse of X ......................... Take | Close ]
//   [ (icon) (icon) (icon) (icon) ...  horizontal strip  ]
//
// Interactions:
//   * single click a cell — select (brass highlight);
//   * DOUBLE-click a cell (or Take on a selection) — loot it into the main
//     pack: `handle.moveItem(itemGuid, localPlayerGuid, 0)` →
//     PutItemInContainer 0x0019 (the exact call radial-menu.js's
//     "Take From Container" uses);
//   * refresh on `playerInventoryChanged` (ACE echoes the inventory update
//     after each take — re-pull getContainerContents);
//   * dismiss on Esc / click-outside / Close / corpse despawn (1 s poll of
//     the entity map — the corpse's TimeToRot delete).
//
// Data feed is container-panel's exactly: `handle.getContainerContents(guid)`
// (GUID list cached wasm-side before the kind=21 event) + per-item meta from
// playerInventory → entityManager → getObjectIconId (see resolveItemMeta).

import { setAcText } from "../ui/ac_font.js";
import { fetchIconDataUrl as fetchIconDataUrlShared } from "../ui/ac_icon_cache.js";
import { takeInventorySnapshot } from "./inventory_helpers.js";

const OVERLAY_ID = "hb-corpse-loot-bar";
const STYLE_ID = "hb-corpse-loot-bar-style";
const DESPAWN_POLL_MS = 1000;

let overlayEl = null;
let state = {
  corpseGuid: 0,
  corpseName: "",
  items: [],
  selectedGuid: 0,
  despawnTimer: 0,
};
let onKeyDownHandler = null;
let onDocMouseDownHandler = null;

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
// whole refresh pass. It used to call `handle.playerInventory()` itself, i.e.
// once per corpse item on top of refreshContents' own call, and freed none of
// them — a 12-item corpse against a 100-item pack minted 1,300 wasm boxes,
// repeated on every `playerInventoryChanged` (which each Take emits). See
// inventory_helpers.takeInventorySnapshot for why that ratchets wasm memory.
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
        stackSize: 1,
      };
    }
  } catch (_) {}
  const iconFromCache = (handle?.getObjectIconId?.(g) >>> 0) || 0;
  return { guid: g, name: fmtGuid(g), iconId: iconFromCache, stackSize: 1 };
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      left: 50%;
      bottom: 130px;
      transform: translateX(-50%);
      width: min(92vw, 700px);
      z-index: 66;
      display: none;
      flex-direction: column;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: rgba(20, 14, 8, 0.94);
      border: 1px solid var(--hb-border-brass);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.6);
      user-select: none;
      box-sizing: border-box;
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; }
    #${OVERLAY_ID} .hclb-header {
      flex: 0 0 22px;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 6px 0 8px;
      background: var(--hb-overlay-active);
      border-bottom: 1px solid var(--hb-border-brass);
      color: var(--hb-text-gold);
      font-size: 12px;
    }
    #${OVERLAY_ID} .hclb-title {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-shadow: 0 1px 0 rgba(0,0,0,.85);
    }
    #${OVERLAY_ID} .hclb-btn {
      flex: 0 0 auto;
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: inherit;
      font-size: 10px;
      line-height: 1;
      padding: 1px 6px;
      cursor: pointer;
    }
    #${OVERLAY_ID} .hclb-btn:hover {
      background: var(--hb-overlay-hover);
      color: var(--hb-text-cream-bright);
      border-color: var(--hb-border-brass);
    }
    #${OVERLAY_ID} .hclb-strip {
      flex: 1 1 auto;
      display: flex;
      flex-direction: row;
      gap: 4px;
      padding: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      min-height: 56px;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0,0,0,.5);
    }
    #${OVERLAY_ID} .hclb-cell {
      flex: 0 0 44px;
      width: 44px; height: 44px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid var(--hb-border-brass-dim);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      font-size: 20px; line-height: 1;
      box-sizing: border-box;
      position: relative;
      transition: border-color 80ms, background 80ms;
    }
    #${OVERLAY_ID} .hclb-cell:hover {
      border-color: var(--hb-text-gold);
      background: var(--hb-overlay-hover);
    }
    #${OVERLAY_ID} .hclb-cell[data-selected="1"] {
      border-color: var(--hb-text-gold);
      box-shadow: inset 0 0 0 1px var(--hb-text-gold);
    }
    #${OVERLAY_ID} .hclb-cell img {
      width: 100%; height: 100%;
      image-rendering: pixelated;
      object-fit: contain;
    }
    #${OVERLAY_ID} .hclb-stack {
      position: absolute;
      bottom: 0; right: 0;
      background: rgba(0,0,0,.75);
      color: var(--hb-text-cream-bright);
      font-size: 9px; line-height: 1;
      padding: 1px 2px;
      font-variant-numeric: tabular-nums;
    }
    #${OVERLAY_ID} .hclb-empty {
      flex: 1 1 auto;
      align-self: center;
      text-align: center;
      color: var(--hb-text-muted-3, #807868);
      font-style: italic;
      font-size: 11px;
      padding: 14px 0;
    }
  `;
  document.head.appendChild(s);
}

function buildOverlay() {
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  const header = document.createElement("div");
  header.className = "hclb-header";
  const title = document.createElement("div");
  title.className = "hclb-title";
  setAcText(title, "Corpse", { color: "#f0c87c" });
  header.appendChild(title);
  const takeBtn = document.createElement("button");
  takeBtn.type = "button";
  takeBtn.className = "hclb-btn";
  takeBtn.title = "Take selected item";
  setAcText(takeBtn, "Take");
  takeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (state.selectedGuid) takeItem(state.selectedGuid);
  });
  header.appendChild(takeBtn);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "hclb-btn";
  closeBtn.title = "Close (Esc)";
  setAcText(closeBtn, "Close");
  closeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeBar();
  });
  header.appendChild(closeBtn);
  overlay.appendChild(header);

  const strip = document.createElement("div");
  strip.className = "hclb-strip";
  overlay.appendChild(strip);

  overlay._titleEl = title;
  overlay._stripEl = strip;
  document.body.appendChild(overlay);
  return overlay;
}

// The take wire — identical to radial-menu.js's "Take From Container":
// moveItem(itemGuid, localPlayerGuid, 0) → PutItemInContainer (0x0019) into
// the main pack; ACE answers with the pickup + inventory updates, and the
// `playerInventoryChanged` subscription re-pulls the corpse contents.
function takeItem(itemGuid) {
  const handle = window.__sessionHandle;
  const me = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
  const g = (itemGuid >>> 0) || 0;
  if (!handle || !me || !g || typeof handle.moveItem !== "function") return;
  try {
    handle.moveItem(g, me, 0);
  } catch (e) {
    console.warn("[corpse-loot-bar] moveItem failed:", e);
  }
}

function render() {
  if (!overlayEl) return;
  setAcText(overlayEl._titleEl, state.corpseName || "Corpse", { color: "#f0c87c" });
  const strip = overlayEl._stripEl;
  strip.innerHTML = "";
  if (!state.items.length) {
    const empty = document.createElement("div");
    empty.className = "hclb-empty";
    setAcText(empty, "Empty.", { color: "#807868" });
    strip.appendChild(empty);
    return;
  }
  for (const it of state.items) {
    const cell = document.createElement("div");
    cell.className = "hclb-cell";
    cell.dataset.guid = String(it.guid);
    if ((it.guid >>> 0) === (state.selectedGuid >>> 0)) cell.dataset.selected = "1";
    cell.textContent = "\u{1F4E6}";
    cell.title = it.name;
    if (it.iconId) {
      fetchIconDataUrl(it.iconId).then((url) => {
        if (!url || !cell.isConnected) return;
        cell.textContent = "";
        const img = document.createElement("img");
        img.src = url;
        img.alt = it.name;
        cell.appendChild(img);
      });
    }
    if (it.stackSize > 1) {
      const badge = document.createElement("div");
      badge.className = "hclb-stack";
      setAcText(badge, String(it.stackSize), { color: "#f0e8d0" });
      cell.appendChild(badge);
    }
    cell.addEventListener("click", (ev) => {
      ev.stopPropagation();
      state.selectedGuid = it.guid >>> 0;
      for (const c of strip.children) {
        if (c.dataset) c.dataset.selected = c.dataset.guid === String(it.guid) ? "1" : "0";
      }
    });
    cell.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      takeItem(it.guid);
    });
    strip.appendChild(cell);
  }
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
  // (2026-07-02) — the wasm ViewContents snapshot (`latest_container_contents`,
  // src/lib.rs:28229) is NOT pruned when an item is picked up, so a just-taken
  // item lingers in the GUID list. An item in `playerInventory()` is owned
  // (moved out of the corpse into our pack) — filter those out so the strip
  // refreshes to the true remaining contents after each Take. `playerInventory`
  // is owned-items-only (open-corpse contents are NOT in it — verified: taking
  // 1 grows it by exactly 1), so this never hides un-looted corpse items.
  //
  // ONE snapshot serves both the owned-filter and every per-item meta resolve;
  // `free()` runs in a `finally` so a throw inside resolveItemMeta (e.g.
  // getObjectIconId) still releases the boxes.
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
  render();
}

function openFor(corpseGuid, corpseName) {
  const g = (corpseGuid >>> 0) || 0;
  if (!g) return;
  if (!overlayEl) overlayEl = buildOverlay();
  state.corpseGuid = g;
  state.corpseName = corpseName || "Corpse";
  state.selectedGuid = 0;
  refreshContents();
  overlayEl.dataset.open = "1";

  if (!onKeyDownHandler) {
    onKeyDownHandler = (ev) => {
      if (overlayEl?.dataset.open !== "1") return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closeBar();
      }
    };
    document.addEventListener("keydown", onKeyDownHandler, true);
  }
  if (!onDocMouseDownHandler) {
    onDocMouseDownHandler = (ev) => {
      if (!overlayEl || overlayEl.dataset.open !== "1") return;
      if (overlayEl.contains(ev.target)) return;
      if (window.__radialMenuOpen) return;
      closeBar();
    };
    document.addEventListener("mousedown", onDocMouseDownHandler, true);
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
      if (em?.entityMap && !em.entityMap.has(state.corpseGuid >>> 0)) {
        closeBar();
      }
    } catch (_) {}
  }, DESPAWN_POLL_MS);
}

function closeBar() {
  if (!overlayEl) return;
  overlayEl.dataset.open = "0";
  state.corpseGuid = 0;
  state.selectedGuid = 0;
  if (state.despawnTimer) {
    clearInterval(state.despawnTimer);
    state.despawnTimer = 0;
  }
  if (onKeyDownHandler) {
    document.removeEventListener("keydown", onKeyDownHandler, true);
    onKeyDownHandler = null;
  }
  if (onDocMouseDownHandler) {
    document.removeEventListener("mousedown", onDocMouseDownHandler, true);
    onDocMouseDownHandler = null;
  }
}

function onInvChanged() {
  if (overlayEl?.dataset.open === "1" && state.corpseGuid) refreshContents();
}

// Subscribe at module-load (container-panel's poll-for-bus pattern). The
// kind=21 routing itself lives in container-panel.js (it detects corpse vs
// chest and delegates here via window.__corpseLootBar); this module only
// needs the inventory-refresh feed.
let _subscribeTimer = null;
function trySubscribe() {
  const client = window.__pluginClient ?? null;
  if (!client?.events?.on) return false;
  client.events.on("playerInventoryChanged", onInvChanged);
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
  // The delegation surface container-panel.js routes corpse kind=21 events
  // to, plus debug hooks mirroring __openContainerFor / __closeContainerPanel.
  window.__corpseLootBar = { openFor, close: closeBar };
  window.__openCorpseLootBarFor = (guid, name) =>
    openFor(guid >>> 0, name || `Corpse ${fmtGuid(guid)}`);
  window.__closeCorpseLootBar = closeBar;
}

export const manifest = {
  id: "corpse-loot-bar",
  name: "Corpse Loot",
  icon: "\u{1F480}",
  iconHidden: true,
  version: "0.1.0",
  description: "Horizontal corpse-loot bar (vendor-strip pattern) — container-panel routes corpse kind=21 ContainerOpened events here",
};
