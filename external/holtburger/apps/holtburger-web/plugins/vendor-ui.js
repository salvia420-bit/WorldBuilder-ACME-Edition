/**
 * vendor-ui — Vendor Window plugin (round-trip buy + sell).
 *
 * Mirrors the retail AC "Vendor Window" UI documented in the fandom
 * wiki and acpedia ("Trading", "Merchant", "Buy and Sell Rates"). When
 * the player clicks a vendor, the recv loop surfaces `kind=12
 * VendorOpened` and caches the full vendor state in wasm. This panel:
 *
 *   - shows vendor name + buy/sell rates ("Sells at: 155% | Buys at: 90%")
 *   - lists stock as an icon grid + scrollable list (icon, name, stack, price)
 *   - click an item → buy 1 unit (qty selector + shift-click for stack-buy)
 *   - drag an inventory item → drop on the panel to sell it
 *   - close on ✕ button or Escape
 *
 * Per the wiki, vendor sell rate ("buyMultiplier" on the wire) is what
 * the vendor charges the player (105–500%); buy rate ("sellMultiplier")
 * is what the vendor pays for player items (70–95%). The price column
 * shows `item.value × buyMultiplier`.
 *
 * Icons come from the DAT — each VendorItem carries `iconId`
 * (PublicWeenieDescription.icon_id, 0x06xxxxxx in the texture table).
 * We fetch via `fetch_surface_pixels(iconId)` (existing surface decoder)
 * + render to an offscreen canvas. iconId=0 falls back to an
 * itemType→emoji map for the rare item that has no icon.
 */

const PANEL_ID = "hb-vendor-window";
const STYLE_ID = "hb-vendor-window-styles";

// AC ItemType bits → emoji fallback when iconId resolution fails or
// when iconId=0. Lowest set bit wins (same heuristic as the inventory
// panel).
const ITEM_TYPE_EMOJI = {
  0x01: "⚔",     // MeleeWeapon
  0x02: "🛡",     // Armor
  0x04: "👕",     // Clothing
  0x08: "💍",     // Jewelry
  0x10: "🧬",     // Creature (rare in vendor)
  0x20: "🍞",     // Food
  0x40: "💰",     // Money
  0x80: "📦",     // Misc
  0x100: "🎯",    // MissileWeapon
  0x200: "🏹",    // Container (rare)
  0x400: "🔮",    // Useless
  0x800: "🎒",    // Gem
  0x1000: "📜",   // SpellComponent
  0x2000: "🔑",   // Key
  0x4000: "🍷",   // Reagent (Alchemy)
  0x8000: "🍴",   // PromissoryNote? actually CraftAlchemyBase
  0x10000: "📖",  // Book
  0x20000: "🗒",   // Writable
  0x40000: "💵",  // TradeNote
  0x80000: "🪄",   // ManaStone
  0x100000: "⚗",  // Service
  0x200000: "🎵",  // Salvage
};

function emojiForItemType(itemType) {
  if (!itemType) return "📦";
  // Find lowest set bit.
  const bit = itemType & (~itemType + 1);
  return ITEM_TYPE_EMOJI[bit] || "📦";
}

// Icon cache — keyed by iconId. Value is the data-URL string (or
// `null` while in-flight, or `false` if the fetch failed). Vendors
// reuse the same wcids, so revisits hit cache.
const iconCache = new Map();

async function fetchIconDataUrl(iconId) {
  if (!iconId) return null;
  const cached = iconCache.get(iconId);
  if (cached !== undefined) {
    if (cached instanceof Promise) return cached;
    return cached;
  }
  // Resolve via the wasm surface decoder. Icons are stored as
  // RenderSurface (DAT type 0x06) — same path the 3D world uses for
  // model surface textures, so the existing prefetch graph applies.
  const wasm = window.__hbWasm ?? window.__wasm ?? null;
  if (!wasm?.fetch_surface_pixels) {
    iconCache.set(iconId, false);
    return false;
  }
  const promise = (async () => {
    try {
      const result = await wasm.fetch_surface_pixels(iconId >>> 0);
      if (!result || !result.width || !result.height || !result.pixels?.length) {
        return false;
      }
      // Render to an offscreen canvas → data URL. Pixels come back as
      // RGBA8 in row-major top-down order (Surface decoder convention).
      const canvas = document.createElement("canvas");
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(result.width, result.height);
      img.data.set(result.pixels);
      ctx.putImageData(img, 0, 0);
      const url = canvas.toDataURL("image/png");
      return url;
    } catch (err) {
      console.warn(`[vendor-ui] icon ${iconId} fetch failed:`, err);
      return false;
    }
  })();
  iconCache.set(iconId, promise);
  const url = await promise;
  iconCache.set(iconId, url);
  return url;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // AC-retail aesthetic: dark parchment panel, gold accents, brass
  // header bar. Slightly larger than other hb-panels because the icon
  // grid needs visual breathing room.
  style.textContent = `
    #${PANEL_ID} {
      position: fixed;
      top: 80px;
      right: 16px;
      width: 380px;
      max-height: 78vh;
      background:
        linear-gradient(180deg, rgba(30, 24, 14, 0.97) 0%, rgba(18, 14, 8, 0.97) 100%);
      border: 1px solid #8a7544;
      border-radius: 4px;
      box-shadow:
        0 8px 32px rgba(0, 0, 0, 0.85),
        inset 0 1px 0 rgba(232, 207, 138, 0.15);
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 12px;
      color: #d8d4c4;
      z-index: 1200;
      display: flex;
      flex-direction: column;
      animation: hb-vw-slidein 220ms ease-out;
    }
    @keyframes hb-vw-slidein {
      from { transform: translateY(-8px); opacity: 0; }
      to   { transform: translateY(0); opacity: 1; }
    }
    #${PANEL_ID}[hidden] { display: none !important; }
    #${PANEL_ID}.vw-drag-over { box-shadow: 0 0 0 2px #f0c87c, 0 8px 32px rgba(0,0,0,.85); }
    #${PANEL_ID} .vw-title {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid #8a7544;
      background:
        linear-gradient(180deg, rgba(96, 72, 32, 0.5) 0%, rgba(56, 42, 18, 0.5) 100%);
      border-top-left-radius: 4px;
      border-top-right-radius: 4px;
    }
    #${PANEL_ID} .vw-title-icon { color: #f0c87c; font-size: 14px; }
    #${PANEL_ID} .vw-title-text {
      flex: 1;
      font-weight: 600;
      color: #f0d8a0;
      font-size: 13px;
      letter-spacing: 0.02em;
    }
    #${PANEL_ID} .vw-close {
      cursor: pointer;
      padding: 2px 8px;
      color: #b8b0a0;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 3px;
      font-size: 13px;
      line-height: 1;
    }
    #${PANEL_ID} .vw-close:hover {
      color: #fff;
      background: rgba(232, 207, 138, 0.1);
      border-color: #8a7544;
    }
    #${PANEL_ID} .vw-rates {
      padding: 5px 10px;
      font-size: 11px;
      color: #a8a090;
      border-bottom: 1px solid rgba(138, 117, 68, 0.4);
      display: flex;
      gap: 14px;
      background: rgba(0, 0, 0, 0.18);
    }
    #${PANEL_ID} .vw-rate { display: inline-flex; gap: 5px; align-items: baseline; }
    #${PANEL_ID} .vw-rate-val { color: #f0c87c; font-weight: 600; }
    #${PANEL_ID} .vw-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px;
      font-size: 11px;
      color: #a8a090;
      background: rgba(0, 0, 0, 0.12);
      border-bottom: 1px solid rgba(138, 117, 68, 0.3);
    }
    #${PANEL_ID} .vw-toolbar label { color: #c8c0ac; }
    #${PANEL_ID} .vw-qty {
      width: 48px;
      padding: 1px 4px;
      background: rgba(0,0,0,0.4);
      color: #f0d8a0;
      border: 1px solid #6a5530;
      border-radius: 2px;
      font-family: inherit;
      font-size: 11px;
      text-align: right;
    }
    #${PANEL_ID} .vw-hint { color: #807868; font-style: italic; margin-left: auto; }
    #${PANEL_ID} .vw-items {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
    }
    #${PANEL_ID} .vw-items::-webkit-scrollbar { width: 8px; }
    #${PANEL_ID} .vw-items::-webkit-scrollbar-thumb {
      background: rgba(138, 117, 68, 0.5);
      border-radius: 4px;
    }
    #${PANEL_ID} .vw-item {
      display: grid;
      grid-template-columns: 36px 1fr auto;
      grid-column-gap: 10px;
      align-items: center;
      padding: 5px 10px;
      border-bottom: 1px solid rgba(138, 117, 68, 0.12);
      cursor: pointer;
      transition: background-color 80ms;
    }
    #${PANEL_ID} .vw-item:hover {
      background: linear-gradient(90deg,
        rgba(232, 207, 138, 0.08) 0%,
        rgba(232, 207, 138, 0.02) 100%);
    }
    #${PANEL_ID} .vw-item:active { background: rgba(232, 207, 138, 0.16); }
    #${PANEL_ID} .vw-item.vw-busy { opacity: 0.5; pointer-events: none; }
    #${PANEL_ID} .vw-item.vw-flash { animation: hb-vw-flash 600ms ease-out; }
    @keyframes hb-vw-flash {
      0%   { background: rgba(120, 220, 120, 0.35); }
      100% { background: transparent; }
    }
    #${PANEL_ID} .vw-icon {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid #5a4a28;
      border-radius: 3px;
      font-size: 20px;
      line-height: 1;
      overflow: hidden;
    }
    #${PANEL_ID} .vw-icon img {
      width: 100%;
      height: 100%;
      image-rendering: pixelated;
      object-fit: contain;
    }
    #${PANEL_ID} .vw-item-meta { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    #${PANEL_ID} .vw-item-name {
      color: #f0e8d0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    #${PANEL_ID} .vw-item-sub {
      color: #888070;
      font-size: 10px;
      letter-spacing: 0.02em;
    }
    #${PANEL_ID} .vw-item-stack {
      color: #a8a090;
      font-size: 10px;
      margin-left: 4px;
    }
    #${PANEL_ID} .vw-item-price {
      color: #f0c87c;
      font-variant-numeric: tabular-nums;
      text-align: right;
      font-weight: 600;
      font-size: 12px;
      white-space: nowrap;
    }
    #${PANEL_ID} .vw-item-price-sub {
      color: #807868;
      font-size: 9px;
      font-variant-numeric: tabular-nums;
    }
    #${PANEL_ID} .vw-empty {
      padding: 16px 10px;
      color: #807868;
      font-style: italic;
      text-align: center;
    }
    #${PANEL_ID} .vw-alt {
      padding: 6px 10px;
      font-size: 10px;
      color: #b8a868;
      border-top: 1px solid rgba(138, 117, 68, 0.3);
      background: rgba(0, 0, 0, 0.18);
    }
    #${PANEL_ID} .vw-sell-zone {
      padding: 8px 10px;
      font-size: 11px;
      color: #807868;
      text-align: center;
      background: rgba(0, 0, 0, 0.18);
      border-top: 1px dashed rgba(138, 117, 68, 0.35);
      transition: all 120ms;
    }
    #${PANEL_ID}.vw-drag-over .vw-sell-zone {
      background: rgba(120, 200, 120, 0.18);
      color: #f0f0d0;
      font-weight: 600;
    }
    #${PANEL_ID} .vw-toast {
      position: absolute;
      top: 48px;
      left: 50%;
      transform: translateX(-50%);
      padding: 4px 10px;
      background: rgba(40, 90, 40, 0.95);
      color: #f0f8e0;
      border: 1px solid #6a9a4a;
      border-radius: 3px;
      font-size: 11px;
      pointer-events: none;
      animation: hb-vw-toast 1600ms ease-out;
    }
    #${PANEL_ID} .vw-toast.vw-toast-err {
      background: rgba(120, 40, 40, 0.95);
      border-color: #c06060;
    }
    @keyframes hb-vw-toast {
      0%   { opacity: 0; transform: translate(-50%, -8px); }
      15%  { opacity: 1; transform: translate(-50%, 0); }
      85%  { opacity: 1; transform: translate(-50%, 0); }
      100% { opacity: 0; transform: translate(-50%, -8px); }
    }
  `;
  document.head.appendChild(style);
}

function fmtPrice(n) {
  if (!Number.isFinite(n)) return "?";
  return Math.round(n).toLocaleString();
}

// Short item-type label for the secondary row.
function itemTypeLabel(itemType) {
  if (!itemType) return "";
  const bit = itemType & (~itemType + 1);
  return ({
    0x01: "Melee", 0x02: "Armor", 0x04: "Clothing", 0x08: "Jewelry",
    0x20: "Food", 0x40: "Money", 0x80: "Misc",
    0x100: "Missile", 0x200: "Container", 0x800: "Gem",
    0x1000: "Component", 0x2000: "Key", 0x4000: "Reagent",
    0x10000: "Book", 0x20000: "Writable", 0x40000: "Trade Note",
    0x80000: "Mana Stone",
  })[bit] || "";
}

// Toast helper — flashes a short message in the panel header.
function toast(panel, text, kind = "ok") {
  const t = document.createElement("div");
  t.className = "vw-toast" + (kind === "err" ? " vw-toast-err" : "");
  t.textContent = text;
  panel.appendChild(t);
  setTimeout(() => t.remove(), 1700);
}

let currentState = null;
let currentBuyQty = 1;
let panelHooks = {};

function setItemIcon(iconEl, item) {
  // Synchronous fallback emoji; replace with <img> when fetch lands.
  iconEl.textContent = emojiForItemType(item.itemType);
  if (!item.iconId) return;
  fetchIconDataUrl(item.iconId).then((url) => {
    if (!url) return;
    // Item may have re-rendered; just write the image — the parent
    // container is owned per-row.
    if (!iconEl.isConnected) return;
    iconEl.textContent = "";
    const img = document.createElement("img");
    img.src = url;
    img.alt = item.name || "";
    iconEl.appendChild(img);
  });
}

function render(state) {
  currentState = state;
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  const titleEl = panel.querySelector(".vw-title-text");
  const ratesEl = panel.querySelector(".vw-rates");
  const itemsEl = panel.querySelector(".vw-items");
  const altEl = panel.querySelector(".vw-alt");

  titleEl.textContent = state.vendorName || "Vendor";
  const buyPct = Math.round((state.buyMultiplier ?? 1.0) * 100);
  const sellPct = Math.round((state.sellMultiplier ?? 1.0) * 100);
  ratesEl.innerHTML =
    `<span class="vw-rate">Sells at:<span class="vw-rate-val">${buyPct}%</span></span>` +
    `<span class="vw-rate">Buys at:<span class="vw-rate-val">${sellPct}%</span></span>`;

  itemsEl.innerHTML = "";
  const items = state.items ?? [];
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vw-empty";
    empty.textContent = "(no items stocked)";
    itemsEl.appendChild(empty);
  } else {
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "vw-item";
      row.dataset.wcid = String(item.wcid);
      row.dataset.itemGuid = String(item.itemGuid);

      const iconEl = document.createElement("div");
      iconEl.className = "vw-icon";
      setItemIcon(iconEl, item);

      const meta = document.createElement("div");
      meta.className = "vw-item-meta";
      const nameEl = document.createElement("span");
      nameEl.className = "vw-item-name";
      nameEl.textContent = item.name || `wcid 0x${item.wcid.toString(16)}`;
      if (item.stackSize > 1) {
        const stack = document.createElement("span");
        stack.className = "vw-item-stack";
        stack.textContent = `×${item.stackSize}`;
        nameEl.appendChild(stack);
      }
      const sub = document.createElement("span");
      sub.className = "vw-item-sub";
      sub.textContent = itemTypeLabel(item.itemType);
      meta.appendChild(nameEl);
      if (sub.textContent) meta.appendChild(sub);

      const priceCol = document.createElement("div");
      const unit = (item.value ?? 0) * (state.buyMultiplier ?? 1.0);
      const totalForQty = unit * currentBuyQty;
      const price = document.createElement("div");
      price.className = "vw-item-price";
      price.textContent = `${fmtPrice(unit)} p`;
      priceCol.appendChild(price);
      if (currentBuyQty > 1) {
        const sub2 = document.createElement("div");
        sub2.className = "vw-item-price-sub";
        sub2.textContent = `×${currentBuyQty} = ${fmtPrice(totalForQty)} p`;
        priceCol.appendChild(sub2);
      }
      row.title =
        `${item.name} — wcid 0x${item.wcid.toString(16)}\n` +
        `Base value: ${item.value} p\n` +
        `Vendor sells at ${buyPct}% → ${fmtPrice(unit)} p / unit\n` +
        `Click to buy ${currentBuyQty} (shift-click for ${item.stackSize})`;

      row.addEventListener("click", (ev) => {
        const qty = ev.shiftKey && item.stackSize > 1 ? item.stackSize : currentBuyQty;
        handleBuyClick(row, item, qty);
      });

      row.appendChild(iconEl);
      row.appendChild(meta);
      row.appendChild(priceCol);
      itemsEl.appendChild(row);
    }
  }

  if (state.alternateCurrencyWcid && state.alternateCurrencyName) {
    altEl.hidden = false;
    altEl.textContent =
      `Alternate currency: ${state.alternateCurrencyAmount} × ${state.alternateCurrencyName}`;
  } else {
    altEl.hidden = true;
  }

  panel.hidden = false;
}

function handleBuyClick(rowEl, item, qty) {
  const handle = window.__sessionHandle;
  if (!handle?.buyFromVendor) {
    toast(rowEl.closest(`#${PANEL_ID}`), "buy: no session handle", "err");
    return;
  }
  if (!currentState?.vendorGuid) return;
  try {
    handle.buyFromVendor(
      currentState.vendorGuid >>> 0,
      item.wcid >>> 0,
      qty | 0,
    );
    rowEl.classList.add("vw-busy", "vw-flash");
    setTimeout(() => rowEl.classList.remove("vw-busy", "vw-flash"), 700);
    const panel = rowEl.closest(`#${PANEL_ID}`);
    toast(panel, `Buying ${qty} × ${item.name || "item"}…`);
  } catch (err) {
    console.warn("[vendor-ui] buy failed", err);
    toast(rowEl.closest(`#${PANEL_ID}`), `buy error: ${err.message || err}`, "err");
  }
}

function handleSellDrop(itemGuid, qty = 1) {
  const handle = window.__sessionHandle;
  if (!handle?.sellToVendor) return;
  if (!currentState?.vendorGuid) return;
  try {
    handle.sellToVendor(
      currentState.vendorGuid >>> 0,
      itemGuid >>> 0,
      qty | 0,
    );
    const panel = document.getElementById(PANEL_ID);
    toast(panel, `Selling item 0x${itemGuid.toString(16)}…`);
  } catch (err) {
    console.warn("[vendor-ui] sell failed", err);
    const panel = document.getElementById(PANEL_ID);
    toast(panel, `sell error: ${err.message || err}`, "err");
  }
}

function ensurePanel() {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.hidden = true;
  panel.innerHTML = `
    <div class="vw-title">
      <span class="vw-title-icon">💰</span>
      <span class="vw-title-text">Vendor</span>
      <button type="button" class="vw-close" aria-label="Close (Esc)" title="Close (Esc)">✕</button>
    </div>
    <div class="vw-rates"></div>
    <div class="vw-toolbar">
      <label>Qty</label>
      <input type="number" class="vw-qty" min="1" max="9999" value="1" />
      <span class="vw-hint">Shift-click for stack · drag here to sell</span>
    </div>
    <div class="vw-items"></div>
    <div class="vw-sell-zone">Drop inventory items here to sell</div>
    <div class="vw-alt" hidden></div>
  `;
  document.body.appendChild(panel);

  panel.querySelector(".vw-close").addEventListener("click", () => {
    panel.hidden = true;
  });

  const qtyEl = panel.querySelector(".vw-qty");
  qtyEl.addEventListener("input", () => {
    const v = parseInt(qtyEl.value, 10);
    currentBuyQty = Number.isFinite(v) && v > 0 ? Math.min(v, 9999) : 1;
    // Re-render to update the "×N = M" subline.
    if (currentState) render(currentState);
  });

  // Drag-drop sell zone — accept items from the inventory panel.
  // The inventory <li> sets `text/x-hb-item-guid` on dragstart (see
  // index.html inventory render). On drop, we dispatch a sell wire.
  panel.addEventListener("dragenter", (ev) => {
    if (ev.dataTransfer?.types?.includes("text/x-hb-item-guid")) {
      ev.preventDefault();
      panel.classList.add("vw-drag-over");
    }
  });
  panel.addEventListener("dragover", (ev) => {
    if (ev.dataTransfer?.types?.includes("text/x-hb-item-guid")) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
    }
  });
  panel.addEventListener("dragleave", (ev) => {
    if (ev.target === panel) panel.classList.remove("vw-drag-over");
  });
  panel.addEventListener("drop", (ev) => {
    panel.classList.remove("vw-drag-over");
    const guidStr = ev.dataTransfer?.getData("text/x-hb-item-guid");
    if (!guidStr) return;
    ev.preventDefault();
    const guid = parseInt(guidStr, 10);
    if (!Number.isFinite(guid) || guid === 0) return;
    handleSellDrop(guid, currentBuyQty);
  });

  // Escape to close.
  panelHooks.onKey = (ev) => {
    if (ev.key === "Escape" && !panel.hidden) {
      panel.hidden = true;
    }
  };
  window.addEventListener("keydown", panelHooks.onKey);

  return panel;
}

// ─────────────────────────────────────────────────────────────────
// Plugin manifest + mount
// ─────────────────────────────────────────────────────────────────

export const manifest = {
  id: "vendor-ui",
  name: "Vendor Window",
  icon: "💰",
  iconHidden: true,
  version: "0.2.0",
  description: "Vendor trade window — auto-opens on vendor click; buy by click, sell by drag",
};

export function mount(ctx) {
  ensureStyles();
  ensurePanel();

  let pollTimer = null;
  let unsubscribe = null;

  function tryHook() {
    const client = ctx?.client ?? window.__pluginClient ?? null;
    const handle = window.__sessionHandle ?? null;
    if (!client?.events?.on || !handle?.getVendorState) {
      return false;
    }

    const onVendorOpened = (ev) => {
      const detail = ev.detail || {};
      const vendorGuid = (detail.u32Payload ?? detail.u32_payload ?? 0) >>> 0;
      if (!vendorGuid) {
        console.warn("[vendor-ui] kind=12 event without vendor guid; ignoring", detail);
        return;
      }
      const state = handle.getVendorState(vendorGuid);
      if (!state) {
        // Race-safety retry (see commit e86f23d).
        setTimeout(() => {
          const retry = handle.getVendorState(vendorGuid);
          if (retry) render(snapshotFromWasm(retry));
        }, 50);
        return;
      }
      render(snapshotFromWasm(state));
    };

    client.events.on("vendorOpened", onVendorOpened);
    client.events.on("kind:12", onVendorOpened);
    client.events.on("VendorOpened", onVendorOpened);

    unsubscribe = () => {
      client.events.off?.("vendorOpened", onVendorOpened);
      client.events.off?.("kind:12", onVendorOpened);
      client.events.off?.("VendorOpened", onVendorOpened);
    };
    return true;
  }

  if (!tryHook()) {
    pollTimer = setInterval(() => {
      if (tryHook()) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 500);
  }

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    if (unsubscribe) unsubscribe();
    if (panelHooks.onKey) window.removeEventListener("keydown", panelHooks.onKey);
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
  };
}

function snapshotFromWasm(state) {
  return {
    vendorGuid: state.vendorGuid,
    vendorName: state.vendorName,
    buyMultiplier: state.buyMultiplier,
    sellMultiplier: state.sellMultiplier,
    alternateCurrencyWcid: state.alternateCurrencyWcid,
    alternateCurrencyAmount: state.alternateCurrencyAmount,
    alternateCurrencyName: state.alternateCurrencyName,
    items: state.items.map((i) => ({
      itemGuid: i.itemGuid,
      wcid: i.wcid,
      name: i.name,
      value: i.value,
      stackSize: i.stackSize,
      itemType: i.itemType,
      iconId: i.iconId,
    })),
  };
}

// Debug helper: pop the panel manually from DevTools with a synthetic
// payload — exercises layout / icon-fallback / buy-stub paths.
if (typeof window !== "undefined") {
  window.__vendorUiDebug = (mockState) => {
    ensureStyles();
    ensurePanel();
    render(
      mockState ?? {
        vendorGuid: 0x10000001,
        vendorName: "Lin the Trader (debug)",
        buyMultiplier: 1.55,
        sellMultiplier: 0.9,
        alternateCurrencyWcid: 0,
        alternateCurrencyAmount: 0,
        alternateCurrencyName: "",
        items: [
          { itemGuid: 1, wcid: 0x010, name: "Bread", value: 5, stackSize: 1, itemType: 0x20, iconId: 0 },
          { itemGuid: 2, wcid: 0x011, name: "Healing Kit", value: 30, stackSize: 1, itemType: 0x80, iconId: 0 },
          { itemGuid: 3, wcid: 0x012, name: "Lockpick", value: 50, stackSize: 5, itemType: 0x80, iconId: 0 },
          { itemGuid: 4, wcid: 0x013, name: "Mana Charge", value: 1200, stackSize: 1, itemType: 0x80, iconId: 0 },
          { itemGuid: 5, wcid: 0x014, name: "Trade Note (100)", value: 100, stackSize: 1, itemType: 0x40000, iconId: 0 },
          { itemGuid: 6, wcid: 0x015, name: "Iron Dagger", value: 80, stackSize: 1, itemType: 0x01, iconId: 0 },
          { itemGuid: 7, wcid: 0x016, name: "Leather Cap", value: 45, stackSize: 1, itemType: 0x02, iconId: 0 },
        ],
      }
    );
  };
}
