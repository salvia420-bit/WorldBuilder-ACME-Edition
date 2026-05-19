/**
 * vendor-ui — Vendor Window plugin.
 *
 * Mirrors the retail AC "Vendor Window" UI documented in acpedia
 * (`external/acpedia/.../Trading`, `Merchant`, `Buy and Sell Rates`
 * articles). When the player clicks a vendor (Vendor.openTrade() →
 * useObject wire dispatch → ACE responds with GameEvent::ApproachVendor),
 * the recv loop surfaces `kind=12 VendorOpened` and caches the full
 * vendor state in wasm. This plugin pops up a panel showing:
 *
 *   - vendor name + buy/sell rates (e.g. "Buy: 155% | Sell: 90%")
 *   - scrollable item list — each row: name, stack size, computed price
 *     (= item.value × buyMultiplier)
 *   - close button (hides panel; next vendor click re-pops with fresh state)
 *
 * Per acpedia's "Trading" article, vendor sell rate is what the vendor
 * charges the player (typically 105-500%), and buy rate is what the
 * vendor pays for player items (typically 70-95%). The rates apply as
 * multipliers over the item's face value.
 *
 * Deferred to follow-on iterations:
 *   - Drag-drop sell (drag item from inventory → vendor window)
 *   - Drag-drop buy (drag item from vendor → inventory)
 *   - Stack-split slider for partial buys
 *   - "Drag main backpack" sell-all (per "A Perfect Paradox" update)
 *   - Vendor close wire dispatch (Item_StopViewingObjectContents)
 *
 * Today the panel is read-only — shows what the vendor stocks and at
 * what prices. Mirrors the first-cut "let me see the stock" use case.
 */

const PANEL_ID = "hb-vendor-window";
const STYLE_ID = "hb-vendor-window-styles";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Matches the hb-panel idiom from ui/bar.js so the vendor window
  // visually belongs with combat-bar / spellbook / vitals.
  style.textContent = `
    #${PANEL_ID} {
      position: fixed;
      top: 80px;
      right: 16px;
      width: 320px;
      max-height: 70vh;
      background: rgba(20, 22, 28, 0.96);
      border: 1px solid rgba(180, 170, 140, 0.4);
      border-radius: 6px;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.7);
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 12px;
      color: #d8d4c4;
      z-index: 1200;
      display: flex;
      flex-direction: column;
    }
    #${PANEL_ID}[hidden] { display: none !important; }
    #${PANEL_ID} .vw-title {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-bottom: 1px solid rgba(180, 170, 140, 0.25);
      background: rgba(40, 36, 28, 0.6);
      border-top-left-radius: 6px;
      border-top-right-radius: 6px;
    }
    #${PANEL_ID} .vw-title-text {
      flex: 1;
      font-weight: 600;
      color: #e8dfbf;
    }
    #${PANEL_ID} .vw-close {
      cursor: pointer;
      padding: 2px 6px;
      color: #b8b0a0;
      background: transparent;
      border: none;
      font-size: 13px;
    }
    #${PANEL_ID} .vw-close:hover { color: #fff; background: rgba(255,255,255,0.08); border-radius: 3px; }
    #${PANEL_ID} .vw-rates {
      padding: 4px 8px;
      font-size: 11px;
      color: #a8a090;
      border-bottom: 1px solid rgba(180, 170, 140, 0.15);
      display: flex;
      gap: 12px;
    }
    #${PANEL_ID} .vw-rate { display: inline-flex; gap: 4px; }
    #${PANEL_ID} .vw-rate-val { color: #f0c87c; font-weight: 600; }
    #${PANEL_ID} .vw-items {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
    }
    #${PANEL_ID} .vw-item {
      display: grid;
      grid-template-columns: 1fr auto;
      grid-column-gap: 8px;
      padding: 3px 8px;
      border-bottom: 1px solid rgba(180, 170, 140, 0.08);
      cursor: default;
    }
    #${PANEL_ID} .vw-item:hover { background: rgba(255, 255, 255, 0.04); }
    #${PANEL_ID} .vw-item-name { color: #e0d8c0; }
    #${PANEL_ID} .vw-item-stack {
      color: #909088;
      font-size: 10px;
      margin-left: 4px;
    }
    #${PANEL_ID} .vw-item-price {
      color: #f0c87c;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    #${PANEL_ID} .vw-empty {
      padding: 12px 8px;
      color: #807868;
      font-style: italic;
      text-align: center;
    }
    #${PANEL_ID} .vw-alt {
      padding: 4px 8px;
      font-size: 10px;
      color: #b8a868;
      border-top: 1px solid rgba(180, 170, 140, 0.15);
      background: rgba(40, 36, 28, 0.4);
    }
  `;
  document.head.appendChild(style);
}

function fmtPrice(n) {
  // Round to integer pyreal, comma-separate for readability.
  if (!Number.isFinite(n)) return "?";
  return Math.round(n).toLocaleString();
}

function render(state) {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  const titleEl = panel.querySelector(".vw-title-text");
  const ratesEl = panel.querySelector(".vw-rates");
  const itemsEl = panel.querySelector(".vw-items");
  const altEl = panel.querySelector(".vw-alt");

  titleEl.textContent = `Vendor — ${state.vendorName}`;
  const buyPct = Math.round(state.buyMultiplier * 100);
  const sellPct = Math.round(state.sellMultiplier * 100);
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
      const name = document.createElement("span");
      name.className = "vw-item-name";
      name.textContent = item.name || `wcid 0x${item.wcid.toString(16)}`;
      if (item.stackSize > 1) {
        const stack = document.createElement("span");
        stack.className = "vw-item-stack";
        stack.textContent = `×${item.stackSize}`;
        name.appendChild(stack);
      }
      const price = document.createElement("span");
      price.className = "vw-item-price";
      // Acpedia "Trading" article: price = item.value × buyMultiplier
      const unit = item.value * state.buyMultiplier;
      price.textContent = `${fmtPrice(unit)} p`;
      price.title =
        `Base value: ${item.value} p\n` +
        `Vendor sells at ${buyPct}% → ${fmtPrice(unit)} p per item` +
        (item.stackSize > 1 ? `\nFull stack: ${fmtPrice(unit * item.stackSize)} p` : "");
      row.appendChild(name);
      row.appendChild(price);
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

function ensurePanel() {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.hidden = true;
  panel.innerHTML = `
    <div class="vw-title">
      <span class="vw-title-text">Vendor</span>
      <button type="button" class="vw-close" aria-label="Close">✕</button>
    </div>
    <div class="vw-rates"></div>
    <div class="vw-items"></div>
    <div class="vw-alt" hidden></div>
  `;
  document.body.appendChild(panel);
  panel.querySelector(".vw-close").addEventListener("click", () => {
    panel.hidden = true;
  });
  return panel;
}

// ─────────────────────────────────────────────────────────────────
// Plugin manifest + mount
// ─────────────────────────────────────────────────────────────────

export const manifest = {
  id: "vendor-ui",
  name: "Vendor Window",
  icon: "💰",
  iconHidden: true, // event-driven; no icon needed
  version: "0.1.0",
  description: "Vendor trade window — auto-opens on vendor click; shows stock + prices",
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
      // The kind=12 ClientEvent carries:
      //   stringPayload: vendor name (resolved server-side)
      //   u32Payload:    vendor guid
      //   u32Payload2:   item count (informational; we re-fetch via wasm)
      const vendorGuid = (detail.u32Payload ?? detail.u32_payload ?? 0) >>> 0;
      if (!vendorGuid) {
        console.warn("[vendor-ui] kind=12 event without vendor guid; ignoring", detail);
        return;
      }
      const state = handle.getVendorState(vendorGuid);
      if (!state) {
        console.warn(
          `[vendor-ui] kind=12 for guid=0x${vendorGuid.toString(16)} but wasm cache missing — race? Will retry once.`
        );
        // Race-safety: the cache populates in the recv-loop arm BEFORE
        // queued_events.push for kind=12, but be defensive in case JS
        // poll_events drains before wasm finishes the borrow_mut().
        setTimeout(() => {
          const retry = handle.getVendorState(vendorGuid);
          if (retry) {
            render(snapshotFromWasm(retry));
          }
        }, 50);
        return;
      }
      render(snapshotFromWasm(state));
    };

    client.events.on("vendorOpened", onVendorOpened);
    // Backwards-compatible event names some api.js variants emit.
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
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
  };
}

// Snapshot a wasm-bindgen VendorStateJs into a plain JS object so we
// can render + log it without holding the wasm ref. Wasm getters are
// per-access — convert once.
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
// payload. Useful for CSS tweaking without a live ACE.
if (typeof window !== "undefined") {
  window.__vendorUiDebug = (mockState) => {
    ensureStyles();
    ensurePanel();
    render(
      mockState ?? {
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
        ],
      }
    );
  };
}
