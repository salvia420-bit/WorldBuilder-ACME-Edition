// container-panel — floating panel for chests, corpses, salvage bags.
//
// Wave 3 follow-on to PR-HH (2026-05-23 ContainerOpened plumbing). ACE
// fires GameEvent::ViewContents (0x0196) on UseObject(chest/corpse);
// index.html drains `kind=21` and re-emits as the `containerOpened`
// bus event with { stringPayload: name, u32Payload: guid, u32Payload2: count }.
// The wasm side caches the GUID list before pushing the event so
// `handle.getContainerContents(guid)` is fresh at the moment the
// handler runs.
//
// Per-item details (name / icon / value / itemType) are NOT returned
// by getContainerContents — that surfaces Vec<u32> only. We resolve
// each GUID against playerInventory() (for items the player owns that
// sit in this container) then fall back to liveScene3d.entityManager
// (for loose world items / corpse loot). Anything still unresolved
// renders as a `0xGUID` placeholder, matching how the radial-menu
// degrades when entity meta is missing.
//
// Single-panel — opening a new container while one is open replaces
// the previous contents. Esc / close-button / click-outside dismiss.
// Click an item → routes to the existing Examine path (window.__showExamineFor).

import { setAcText } from "../ui/ac_font.js";
import { fetchIconDataUrl as fetchIconDataUrlShared } from "../ui/ac_icon_cache.js";

const OVERLAY_ID = "hb-container-panel";
const STYLE_ID = "hb-container-panel-style";
const GRID_COLS = 6;

let overlayEl = null;
let onKeyDownHandler = null;
let onDocMouseDownHandler = null;

// Wave 15 — icon cache consolidated into `ui/ac_icon_cache.js`. Local
// thin wrapper preserves the historical `[container-panel]` warn label.
async function fetchIconDataUrl(iconId) {
  return fetchIconDataUrlShared(iconId, "container-panel");
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 80px; right: 24px;
      width: 280px; height: 220px;
      z-index: 65;
      display: none;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: rgba(20, 14, 8, 0.94);
      border: 1px solid var(--hb-border-brass);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.6);
      user-select: none;
      box-sizing: border-box;
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; flex-direction: column; }
    #${OVERLAY_ID} .hcp-header {
      flex: 0 0 22px;
      display: flex;
      align-items: center;
      padding: 0 6px 0 8px;
      background: var(--hb-overlay-active);
      border-bottom: 1px solid var(--hb-border-brass);
      color: var(--hb-text-gold);
      font-size: 12px;
      letter-spacing: 0.02em;
    }
    #${OVERLAY_ID} .hcp-title {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-shadow: 0 1px 0 rgba(0,0,0,.85);
    }
    #${OVERLAY_ID} .hcp-close {
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
    #${OVERLAY_ID} .hcp-close:hover {
      background: var(--hb-overlay-hover);
      color: var(--hb-text-cream-bright);
      border-color: var(--hb-border-brass);
    }
    #${OVERLAY_ID} .hcp-body {
      flex: 1 1 auto;
      padding: 6px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0,0,0,.5);
    }
    #${OVERLAY_ID} .hcp-grid {
      display: grid;
      grid-template-columns: repeat(${GRID_COLS}, 36px);
      gap: 4px;
      justify-content: start;
    }
    #${OVERLAY_ID} .hcp-slot {
      width: 36px; height: 36px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid var(--hb-border-brass-dim);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      font-size: 18px; line-height: 1;
      box-sizing: border-box;
      position: relative;
      transition: border-color 80ms, background 80ms;
    }
    #${OVERLAY_ID} .hcp-slot:hover {
      border-color: var(--hb-text-gold);
      background: var(--hb-overlay-hover);
    }
    #${OVERLAY_ID} .hcp-slot img {
      width: 100%; height: 100%;
      image-rendering: pixelated;
      object-fit: contain;
    }
    #${OVERLAY_ID} .hcp-stack {
      position: absolute;
      bottom: 0; right: 0;
      background: rgba(0,0,0,.75);
      color: var(--hb-text-cream-bright);
      font-size: 8px; line-height: 1;
      padding: 1px 2px;
      font-variant-numeric: tabular-nums;
    }
    #${OVERLAY_ID} .hcp-empty {
      padding: 12px 6px;
      text-align: center;
      color: var(--hb-text-muted-3, #807868);
      font-style: italic;
      font-size: 11px;
    }
  `;
  document.head.appendChild(s);
}

function fmtGuid(guid) {
  return `0x${(guid >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function resolveItemMeta(guid) {
  const g = guid >>> 0;
  const handle = window.__sessionHandle;
  if (handle?.playerInventory) {
    try {
      const inv = handle.playerInventory();
      for (const it of inv) {
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
  }
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
  // Third channel: icon cache populated at ViewContents time before the
  // JS spawn gate discards contained items (model_id=0 → no entityMap entry).
  const iconFromCache = (handle?.getObjectIconId?.(g) >>> 0) || 0;
  return { guid: g, name: fmtGuid(g), iconId: iconFromCache, stackSize: 1 };
}

function buildOverlay() {
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  const header = document.createElement("div");
  header.className = "hcp-header";
  const title = document.createElement("div");
  title.className = "hcp-title";
  setAcText(title, "Container", { color: "#f0c87c" });
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "hcp-close";
  closeBtn.title = "Close (Esc)";
  setAcText(closeBtn, "Close");
  closeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    hidePanel();
  });
  header.appendChild(closeBtn);
  overlay.appendChild(header);

  const body = document.createElement("div");
  body.className = "hcp-body";
  const grid = document.createElement("div");
  grid.className = "hcp-grid";
  body.appendChild(grid);
  overlay.appendChild(body);

  overlay.dataset.titleEl = "1";
  overlay._titleEl = title;
  overlay._gridEl = grid;
  overlay._bodyEl = body;

  document.body.appendChild(overlay);
  return overlay;
}

function renderItems(items) {
  if (!overlayEl) return;
  const grid = overlayEl._gridEl;
  const body = overlayEl._bodyEl;
  grid.innerHTML = "";
  const existingEmpty = body.querySelector(".hcp-empty");
  if (existingEmpty) existingEmpty.remove();

  if (!items || items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hcp-empty";
    setAcText(empty, "No contents.", { color: "#807868" });
    body.insertBefore(empty, grid);
    return;
  }

  for (const it of items) {
    const slot = document.createElement("div");
    slot.className = "hcp-slot";
    slot.dataset.guid = String(it.guid);
    slot.textContent = "📦";
    slot.title = it.name;
    if (it.iconId) {
      fetchIconDataUrl(it.iconId).then((url) => {
        if (!url || !slot.isConnected) return;
        slot.textContent = "";
        const img = document.createElement("img");
        img.src = url;
        img.alt = it.name;
        slot.appendChild(img);
      });
    }
    if (it.stackSize > 1) {
      const badge = document.createElement("div");
      badge.className = "hcp-stack";
      setAcText(badge, String(it.stackSize), { color: "#f0e8d0" });
      slot.appendChild(badge);
    }
    slot.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (typeof window.__showExamineFor === "function") {
        window.__showExamineFor(it.guid >>> 0);
      }
    });
    // TODO: right-click → "take from container" once wasm exports a
    // MoveToContainer / GetFromContainer action (mirrors ACE
    // GameAction::MoveItem with container_guid=playerGuid).
    slot.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
    });
    grid.appendChild(slot);
  }
}

function openContainer(containerGuid, containerName) {
  const g = (containerGuid >>> 0) || 0;
  if (!g) return;
  if (!overlayEl) overlayEl = buildOverlay();
  setAcText(overlayEl._titleEl, containerName || "Container", { color: "#f0c87c" });

  const handle = window.__sessionHandle;
  let guids = [];
  if (handle?.getContainerContents) {
    try {
      const raw = handle.getContainerContents(g);
      guids = Array.from(raw || []);
    } catch (e) {
      console.warn("[container-panel] getContainerContents failed", e);
    }
  }
  const items = guids.map(resolveItemMeta);
  renderItems(items);
  overlayEl.dataset.open = "1";

  if (!onKeyDownHandler) {
    onKeyDownHandler = (ev) => {
      if (overlayEl?.dataset.open !== "1") return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        hidePanel();
      }
    };
    document.addEventListener("keydown", onKeyDownHandler, true);
  }
  if (!onDocMouseDownHandler) {
    onDocMouseDownHandler = (ev) => {
      if (!overlayEl || overlayEl.dataset.open !== "1") return;
      if (overlayEl.contains(ev.target)) return;
      hidePanel();
    };
    document.addEventListener("mousedown", onDocMouseDownHandler, true);
  }
}

function hidePanel() {
  if (!overlayEl) return;
  overlayEl.dataset.open = "0";
  if (onKeyDownHandler) {
    document.removeEventListener("keydown", onKeyDownHandler, true);
    onKeyDownHandler = null;
  }
  if (onDocMouseDownHandler) {
    document.removeEventListener("mousedown", onDocMouseDownHandler, true);
    onDocMouseDownHandler = null;
  }
}

function onContainerOpened(ev) {
  const detail = ev?.detail || {};
  const guid = (detail.u32Payload ?? detail.u32_payload ?? 0) >>> 0;
  if (!guid) return;
  const name = detail.stringPayload || "Container";
  openContainer(guid, name);
}

// Subscribe at module-load. Match radial-menu's pattern: poll for the
// pluginClient bus until it's wired (login-time), then attach.
let _subscribeTimer = null;
function trySubscribe() {
  const client = window.__pluginClient ?? null;
  if (!client?.events?.on) return false;
  client.events.on("containerOpened", onContainerOpened);
  client.events.on("kind:21", onContainerOpened);
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

  // Debug hook — bypass wire, render whatever getContainerContents has
  // cached for `guid` (or "No contents." when nothing). Mirrors
  // window.__vendorBarDebug.
  window.__openContainerFor = (guid, name) => {
    openContainer(guid >>> 0, name || `Container ${fmtGuid(guid)}`);
  };
  window.__closeContainerPanel = hidePanel;
}

export const manifest = {
  id: "container-panel",
  name: "Container",
  icon: "📦",
  iconHidden: true,
  version: "0.1.0",
  description: "Chest / corpse / bag contents panel — auto-opens on kind=21 ContainerOpened",
};
