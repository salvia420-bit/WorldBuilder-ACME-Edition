/**
 * vendor-ui — Vendor Window view of the shared main-panel container.
 *
 * Wave 2 PR-CC refactor 2026-05-22: was a standalone floating panel
 * (PANEL_ID="hb-vendor-window" at top:80px / right:16px). Now a
 * registered view of plugins/main-panel.js — the shared right-side
 * pane that already hosts inventory / examine / spellbook / etc.
 *
 * Auto-open is event-driven (no bar slot, no hotkey): the recv loop
 * emits `vendorOpened` (kind=12 VendorOpened) and the mount() arm
 * routes through `window.__mainPanel.pushView("vendor", ctx)` instead
 * of toggling its own panel.hidden flag. The mount returned from the
 * Bar mount() lives for the lifetime of the session and owns the
 * event subscription; the view's mount(bodyEl, ctx) is what runs
 * inside the main-panel body.
 *
 * Preserved wiring (DO NOT regress):
 *   - Buy:  handle.buyFromVendor(vendorGuid, wcid, qty)
 *           wire: GameAction::Buy 0x005F, object_guid = vendor item's wcid
 *   - Sell: handle.sellToVendor(vendorGuid, itemGuid, qty)
 *           wire: GameAction::Sell 0x0060, object_guid = player's item GUID
 *   - Vendor list via `kind=12 VendorOpened` → handle.getVendorState(guid)
 *   - Icons via `__hbWasm.fetch_surface_pixels(iconId)` + canvas → dataURL,
 *     cached module-wide (vendors reuse wcids across visits).
 *   - Item-type emoji fallback when iconId=0 or fetch fails.
 *
 * Preserved fix from commit 4704586's follow-up: no auto-pop examine
 * on selection. Auto-open of the vendor view is server-driven (the
 * ACE handler emits kind=12 only when the player explicitly approaches
 * a Vendor weenie). We never trigger pushView ourselves from a
 * click — that flowed through use_object → ApproachVendor → kind=12.
 *
 * Back-button: vendor auto-pop happens fresh (the user just clicked a
 * vendor in the world), so closing returns to whatever was on the
 * main-panel stack before the auto-push. If the stack was empty, we
 * hide the panel entirely. main-panel.closeView() does this for us
 * by default — no special handling needed in the view.
 */

const STYLE_ID = "hb-vendor-view-styles";
const ROOT_CLASS = "hb-vw-root";

// AC ItemType bit → emoji fallback for icons that don't resolve.
const ITEM_TYPE_EMOJI = {
  0x01: "⚔", 0x02: "🛡", 0x04: "👕", 0x08: "💍",
  0x10: "🧬", 0x20: "🍞", 0x40: "💰", 0x80: "📦",
  0x100: "🎯", 0x200: "🏹", 0x400: "🔮", 0x800: "🎒",
  0x1000: "📜", 0x2000: "🔑", 0x4000: "🍷", 0x8000: "🍴",
  0x10000: "📖", 0x20000: "🗒", 0x40000: "💵", 0x80000: "🪄",
  0x100000: "⚗", 0x200000: "🎵",
};

function emojiForItemType(itemType) {
  if (!itemType) return "📦";
  const bit = itemType & (~itemType + 1);
  return ITEM_TYPE_EMOJI[bit] || "📦";
}

// Icon cache — module-scoped so revisits hit cache across view mounts.
const iconCache = new Map();

async function fetchIconDataUrl(iconId) {
  if (!iconId) return null;
  const cached = iconCache.get(iconId);
  if (cached !== undefined) {
    if (cached instanceof Promise) return cached;
    return cached;
  }
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
      const canvas = document.createElement("canvas");
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(result.width, result.height);
      img.data.set(result.pixels);
      ctx.putImageData(img, 0, 0);
      return canvas.toDataURL("image/png");
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

function fmtPrice(n) {
  if (!Number.isFinite(n)) return "?";
  return Math.round(n).toLocaleString();
}

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

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Layout fills the main-panel body slot. Main-panel owns
  // position/frame/title bar (the gold-trimmed brass chrome). We just
  // render rates + toolbar + scrolling item list + drag-sell band.
  // Keeps the AC parchment-on-stone aesthetic via the shared tokens
  // (--hb-text-cream / --hb-text-gold / --hb-border-brass-*).
  // Compact stylesheet — uses shared hb-* tokens (var(--hb-text-*),
  // var(--hb-border-brass-*), var(--hb-overlay-*)) so the view inherits
  // the AC parchment-on-stone aesthetic from index.html's :root block.
  style.textContent = `
.${ROOT_CLASS}{position:absolute;inset:0;box-sizing:border-box;pointer-events:auto;font-family:var(--hb-font-serif);color:var(--hb-text-cream);display:flex;flex-direction:column;overflow:hidden}
.${ROOT_CLASS}.vw-drag-over{box-shadow:inset 0 0 0 2px var(--hb-text-gold)}
.${ROOT_CLASS} .vw-rates{flex:0 0 auto;padding:5px 8px;font-size:10px;color:var(--hb-text-muted);border-bottom:1px solid var(--hb-border-brass-dim);display:flex;gap:12px;background:var(--hb-overlay-dark)}
.${ROOT_CLASS} .vw-rate{display:inline-flex;gap:4px;align-items:baseline}
.${ROOT_CLASS} .vw-rate-val{color:var(--hb-text-gold);font-weight:600;font-variant-numeric:tabular-nums}
.${ROOT_CLASS} .vw-toolbar{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:3px 8px;font-size:10px;color:var(--hb-text-muted);background:rgba(0,0,0,.12);border-bottom:1px solid var(--hb-border-brass-dim)}
.${ROOT_CLASS} .vw-toolbar label{color:var(--hb-text-label)}
.${ROOT_CLASS} .vw-qty{width:42px;padding:1px 3px;background:var(--hb-overlay-dark-deep);color:var(--hb-text-cream);border:1px solid var(--hb-border-brass-dim);border-radius:var(--hb-radius-tight);font-family:inherit;font-size:10px;text-align:right}
.${ROOT_CLASS} .vw-hint{color:var(--hb-text-muted-3);font-style:italic;margin-left:auto;font-size:9px}
.${ROOT_CLASS} .vw-items{flex:1 1 auto;overflow-y:auto;padding:2px 0;scrollbar-width:thin;scrollbar-color:var(--hb-border-brass) rgba(0,0,0,.5)}
.${ROOT_CLASS} .vw-item{display:grid;grid-template-columns:32px 1fr auto;grid-column-gap:8px;align-items:center;padding:3px 8px;border-bottom:1px solid rgba(138,117,68,.12);cursor:pointer;transition:background-color 80ms}
.${ROOT_CLASS} .vw-item:hover{background:var(--hb-overlay-hover)}
.${ROOT_CLASS} .vw-item:active{background:var(--hb-overlay-active)}
.${ROOT_CLASS} .vw-item.vw-busy{opacity:.5;pointer-events:none}
.${ROOT_CLASS} .vw-item.vw-flash{animation:hb-vw-flash 600ms ease-out}
@keyframes hb-vw-flash{0%{background:rgba(120,220,120,.35)}100%{background:transparent}}
.${ROOT_CLASS} .vw-icon{width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);border:1px solid var(--hb-border-brass-deep);border-radius:var(--hb-radius-inner);font-size:16px;line-height:1;overflow:hidden}
.${ROOT_CLASS} .vw-icon img{width:100%;height:100%;image-rendering:pixelated;object-fit:contain}
.${ROOT_CLASS} .vw-item-meta{min-width:0;display:flex;flex-direction:column;gap:1px}
.${ROOT_CLASS} .vw-item-name{color:var(--hb-text-cream-bright);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;text-shadow:0 1px 0 rgba(0,0,0,.85)}
.${ROOT_CLASS} .vw-item-sub{color:var(--hb-text-muted-2);font-size:9px;letter-spacing:.02em}
.${ROOT_CLASS} .vw-item-stack{color:var(--hb-text-muted);font-size:9px;margin-left:4px}
.${ROOT_CLASS} .vw-item-price{color:var(--hb-text-gold);font-variant-numeric:tabular-nums;text-align:right;font-weight:600;font-size:11px;white-space:nowrap}
.${ROOT_CLASS} .vw-item-price-sub{color:var(--hb-text-muted-3);font-size:8px;font-variant-numeric:tabular-nums}
.${ROOT_CLASS} .vw-empty{padding:16px 10px;color:var(--hb-text-muted-3);font-style:italic;text-align:center;font-size:10px}
.${ROOT_CLASS} .vw-alt{flex:0 0 auto;padding:4px 8px;font-size:9px;color:var(--hb-text-gold-dim);border-top:1px solid var(--hb-border-brass-dim);background:var(--hb-overlay-dark)}
.${ROOT_CLASS} .vw-sell-zone{flex:0 0 auto;padding:5px 8px;font-size:10px;color:var(--hb-text-muted-3);text-align:center;background:var(--hb-overlay-dark);border-top:1px dashed var(--hb-border-brass-dim);transition:all 120ms}
.${ROOT_CLASS}.vw-drag-over .vw-sell-zone{background:rgba(120,200,120,.18);color:var(--hb-text-cream);font-weight:600}
.${ROOT_CLASS} .vw-toast{position:absolute;top:6px;left:50%;transform:translateX(-50%);padding:3px 8px;background:rgba(40,90,40,.95);color:var(--hb-text-cream);border:1px solid #6a9a4a;border-radius:var(--hb-radius-tight);font-size:10px;pointer-events:none;z-index:5;animation:hb-vw-toast 1600ms ease-out}
.${ROOT_CLASS} .vw-toast.vw-toast-err{background:rgba(120,40,40,.95);border-color:#c06060}
@keyframes hb-vw-toast{0%{opacity:0;transform:translate(-50%,-8px)}15%{opacity:1;transform:translate(-50%,0)}85%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;transform:translate(-50%,-8px)}}
  `;
  document.head.appendChild(style);
}

function toast(root, text, kind = "ok") {
  const t = document.createElement("div");
  t.className = "vw-toast" + (kind === "err" ? " vw-toast-err" : "");
  t.textContent = text;
  root.appendChild(t);
  setTimeout(() => t.remove(), 1700);
}

function setItemIcon(iconEl, item) {
  iconEl.textContent = emojiForItemType(item.itemType);
  if (!item.iconId) return;
  fetchIconDataUrl(item.iconId).then((url) => {
    if (!url) return;
    if (!iconEl.isConnected) return;
    iconEl.textContent = "";
    const img = document.createElement("img");
    img.src = url;
    img.alt = item.name || "";
    iconEl.appendChild(img);
  });
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

// ─────────────────────────────────────────────────────────────────
// View — registered as "vendor" in main-panel
// ─────────────────────────────────────────────────────────────────

export const view = {
  name: "Vendor",
  nameFor: (ctx) => {
    const n = ctx?.vendorName || ctx?.state?.vendorName;
    return n ? n : "Vendor";
  },
  mount: (parentEl, ctx) => doMount(parentEl, ctx),
};

function doMount(parentEl, ctx) {
  ensureStyles();

  // Resolve state — either passed via ctx (preferred, from event arm)
  // or re-fetched lazily from wasm via vendorGuid.
  let state = ctx?.state || null;
  if (!state && ctx?.vendorGuid) {
    const handle = window.__sessionHandle;
    try {
      const raw = handle?.getVendorState?.(ctx.vendorGuid >>> 0);
      if (raw) state = snapshotFromWasm(raw);
    } catch (e) {
      console.warn("[vendor-ui] mount-time getVendorState failed", e);
    }
  }
  if (!state) {
    // Empty placeholder if we somehow got here without state.
    parentEl.innerHTML =
      `<div class="${ROOT_CLASS}"><div class="vw-empty">No vendor state available.</div></div>`;
    return () => { parentEl.innerHTML = ""; };
  }

  let currentBuyQty = 1;

  const root = document.createElement("div");
  root.className = ROOT_CLASS;

  const ratesEl = document.createElement("div");
  ratesEl.className = "vw-rates";
  root.appendChild(ratesEl);

  const toolbar = document.createElement("div");
  toolbar.className = "vw-toolbar";
  toolbar.innerHTML = `
    <label>Qty</label>
    <input type="number" class="vw-qty" min="1" max="9999" value="1" />
    <span class="vw-hint">Shift-click for stack · drag here to sell</span>
  `;
  root.appendChild(toolbar);

  const itemsEl = document.createElement("div");
  itemsEl.className = "vw-items";
  root.appendChild(itemsEl);

  const sellZone = document.createElement("div");
  sellZone.className = "vw-sell-zone";
  sellZone.textContent = "Drop inventory items here to sell";
  root.appendChild(sellZone);

  const altEl = document.createElement("div");
  altEl.className = "vw-alt";
  altEl.hidden = true;
  root.appendChild(altEl);

  parentEl.appendChild(root);

  function render() {
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
  }

  function handleBuyClick(rowEl, item, qty) {
    const handle = window.__sessionHandle;
    if (!handle?.buyFromVendor) {
      toast(root, "buy: no session handle", "err");
      return;
    }
    if (!state?.vendorGuid) return;
    try {
      // object_guid on the wire = vendor item's wcid (PR-CC preserved
      // contract: ACE looks up against the vendor's stock list, not
      // a player-owned guid).
      handle.buyFromVendor(
        state.vendorGuid >>> 0,
        item.wcid >>> 0,
        qty | 0,
      );
      rowEl.classList.add("vw-busy", "vw-flash");
      setTimeout(() => rowEl.classList.remove("vw-busy", "vw-flash"), 700);
      toast(root, `Buying ${qty} × ${item.name || "item"}…`);
    } catch (err) {
      console.warn("[vendor-ui] buy failed", err);
      toast(root, `buy error: ${err.message || err}`, "err");
    }
  }

  function handleSellDrop(itemGuid, qty = 1) {
    const handle = window.__sessionHandle;
    if (!handle?.sellToVendor) {
      toast(root, "sell: no session handle", "err");
      return;
    }
    if (!state?.vendorGuid) return;
    try {
      // object_guid on the wire = player's item GUID (PR-CC preserved
      // contract: ACE removes the item from the player and credits
      // pyreals).
      handle.sellToVendor(
        state.vendorGuid >>> 0,
        itemGuid >>> 0,
        qty | 0,
      );
      toast(root, `Selling item 0x${itemGuid.toString(16)}…`);
    } catch (err) {
      console.warn("[vendor-ui] sell failed", err);
      toast(root, `sell error: ${err.message || err}`, "err");
    }
  }

  // ── Qty input ────────────────────────────────────────────────
  const qtyEl = toolbar.querySelector(".vw-qty");
  const onQty = () => {
    const v = parseInt(qtyEl.value, 10);
    currentBuyQty = Number.isFinite(v) && v > 0 ? Math.min(v, 9999) : 1;
    render();
  };
  qtyEl.addEventListener("input", onQty);

  // ── Drag-drop sell zone ──────────────────────────────────────
  // Inventory <li> sets `text/x-hb-item-guid` on dragstart; on drop
  // we dispatch the sell wire. Listeners bind to the root so the
  // entire panel acts as a sell sink (not just the bottom band).
  const onDragEnter = (ev) => {
    if (ev.dataTransfer?.types?.includes("text/x-hb-item-guid")) {
      ev.preventDefault();
      root.classList.add("vw-drag-over");
    }
  };
  const onDragOver = (ev) => {
    if (ev.dataTransfer?.types?.includes("text/x-hb-item-guid")) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
    }
  };
  const onDragLeave = (ev) => {
    if (ev.target === root) root.classList.remove("vw-drag-over");
  };
  const onDrop = (ev) => {
    root.classList.remove("vw-drag-over");
    const guidStr = ev.dataTransfer?.getData("text/x-hb-item-guid");
    if (!guidStr) return;
    ev.preventDefault();
    const guid = parseInt(guidStr, 10);
    if (!Number.isFinite(guid) || guid === 0) return;
    handleSellDrop(guid, currentBuyQty);
  };
  root.addEventListener("dragenter", onDragEnter);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("dragleave", onDragLeave);
  root.addEventListener("drop", onDrop);

  render();

  // ── Cleanup — fires on view swap (e.g. user F4s to inventory)
  // and on closeView() (main-panel's × or back chevron).
  return () => {
    qtyEl.removeEventListener("input", onQty);
    root.removeEventListener("dragenter", onDragEnter);
    root.removeEventListener("dragover", onDragOver);
    root.removeEventListener("dragleave", onDragLeave);
    root.removeEventListener("drop", onDrop);
    root.remove();
  };
}

// ─────────────────────────────────────────────────────────────────
// Bar-slot mount() — owns the kind=12 event subscription and routes
// to main-panel.pushView("vendor", { state }). The view is registered
// separately in index.html via mainPanelPlugin.registerView("vendor",
// vendorUiPlugin.view).
//
// iconHidden — the bar slot is still claimed for the lifetime hook
// (subscribe/teardown), but doesn't render an icon (auto-open is
// server-driven, no user click).
// ─────────────────────────────────────────────────────────────────

export const manifest = {
  id: "vendor-ui",
  name: "Vendor Window",
  icon: "💰",
  iconHidden: true,
  version: "0.3.0",
  description: "Vendor trade view of main-panel — auto-opens on kind=12 VendorOpened",
};

export function mount(ctx) {
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
      const raw = handle.getVendorState(vendorGuid);
      if (!raw) {
        // Race-safety retry (commit e86f23d behaviour preserved).
        setTimeout(() => {
          const retry = handle.getVendorState(vendorGuid);
          if (retry) routeToMainPanel(retry);
        }, 50);
        return;
      }
      routeToMainPanel(raw);
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

  function routeToMainPanel(rawState) {
    const state = snapshotFromWasm(rawState);
    const mp = window.__mainPanel;
    if (!mp?.pushView) {
      console.warn("[vendor-ui] main-panel not mounted; can't push vendor view");
      return;
    }
    mp.pushView("vendor", {
      vendorGuid: state.vendorGuid,
      vendorName: state.vendorName,
      state,
    });
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
  };
}

// Debug helper: pop a synthetic vendor into main-panel from DevTools.
//   __vendorUiDebug()  — fake "Lin the Trader" w/ a handful of stock
//   __vendorUiDebug(state) — explicit snapshot
if (typeof window !== "undefined") {
  window.__vendorUiDebug = (mockState) => {
    const state = mockState ?? {
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
    };
    const mp = window.__mainPanel;
    if (!mp?.pushView) {
      console.warn("[vendor-ui-debug] main-panel not mounted");
      return;
    }
    mp.pushView("vendor", { vendorGuid: state.vendorGuid, vendorName: state.vendorName, state });
  };
}
