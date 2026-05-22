// Right-side inventory window — port of retail gmInventoryUI (layout
// 0x21000023, 300x362) + gmPaperDollUI (layout 0x21000024, 224x214).
//
// Strategy mirrors the chat panel (PR-L): index.html already has full
// inventory wiring — `#inventory-panel` + `#inv-equipped` + `#inv-pack`
// (line 691-711), `renderInventoryPanel(handle)` (line 6192) re-reads
// SessionHandle.playerInventory() on every kind=11 InventoryUpdated
// ClientEvent and rebuilds the rows with `data-guid`, `data-type-bit`,
// `draggable`. We mirror those rows into a retail-framed panel via
// MutationObserver — no duplicated wasm/inventory code.
//
// Real DAT sprites in use (extracted 2026-05-22 from layout 0x21000023):
//   - 0x06004D0A : 300x362-ish stone/leather backdrop (the panel interior!)
//   - 0x06004CFA : brass title bar strip (276x25)
//   - 0x06004D0B/0C/0D : corner + chrome pieces
//   - 0x06004CC2 : 48x48 placeholder spacer
//
// Layout: 300 wide x 362 tall.
//   - Top 25px: title bar with character name + close button.
//   - Left 224x214 (below title): paperdoll area for equipped items.
//   - Right 60x ~340: narrow bag column (placeholder tabs for now).
//   - Lower 234x ~120: items grid for pack items (32x32 slots).
//   - Bottom 120x14: burden meter (placeholder until equipMask wiring).

const OVERLAY_ID = "hb-inventory";
const WIDTH = 300;
const HEIGHT = 362;
const TITLE_H = 25;
const PAPERDOLL_W = 224;
const PAPERDOLL_H = 214;
const BAG_COL_W = 60;
const SLOT_SIZE = 32;
const GRID_COLS = 7;

// Item-type-bit → color (mirrors index.html's #inventory-panel cat
// CSS but adapted for our dark backdrop).
const TYPE_COLOR = {
  "0x4":     "#7da6e0",   // Weapon
  "0x2":     "#7dd9a0",   // Armor
  "0x10000": "#c060ff",   // Magic / scroll
  "0x20":    "#f0c060",   // Money / pyreal
};

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-inventory-style";
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 160px;          /* below compass (top:8 + 140 + a bit) */
      right: 8px;
      z-index: 50;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      box-sizing: border-box;
      pointer-events: none;
      font-family: var(--hb-font-serif);
      background: url("./data/ui-sprites/0x06004D0A.png") center/cover no-repeat,
                  linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 6px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 6 / 6px / 0 stretch;
      box-shadow: var(--hb-shadow-panel);
      color: var(--hb-text-cream);
      display: none;
    }
    #${OVERLAY_ID}[data-open="1"] { display: block; }
    /* Title bar — real DAT 0x06004CFA brass strip. */
    #${OVERLAY_ID} .hb-inv-title {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: ${TITLE_H}px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 8px;
      background: url("./data/ui-sprites/0x06004CFA.png") center/100% 100% no-repeat;
      font-size: 11px;
      color: var(--hb-text-cream-bright);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      pointer-events: auto;
      user-select: none;
    }
    #${OVERLAY_ID} .hb-inv-title-name { letter-spacing: 0.04em; }
    #${OVERLAY_ID} .hb-inv-close {
      width: 14px;
      height: 14px;
      background: var(--hb-border-brass);
      color: var(--hb-bg-stone-bottom);
      font-size: 9px;
      line-height: 14px;
      text-align: center;
      cursor: pointer;
      user-select: none;
    }
    #${OVERLAY_ID} .hb-inv-close:hover { background: var(--hb-text-gold); }
    /* Paperdoll area — equipped items positioned at body-slot positions. */
    #${OVERLAY_ID} .hb-inv-paperdoll {
      position: absolute;
      top: ${TITLE_H + 4}px;
      left: 6px;
      width: ${PAPERDOLL_W}px;
      height: ${PAPERDOLL_H}px;
      pointer-events: auto;
    }
    #${OVERLAY_ID} .hb-inv-paperdoll-bg {
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background:
        radial-gradient(ellipse at center, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.8) 100%);
      border: 1px solid var(--hb-border-brass-dim);
    }
    /* Bag column — narrow vertical strip on the right. */
    #${OVERLAY_ID} .hb-inv-bagcol {
      position: absolute;
      top: ${TITLE_H + 4}px;
      right: 6px;
      width: ${BAG_COL_W}px;
      height: ${PAPERDOLL_H}px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 4px;
      pointer-events: auto;
      border: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.35);
    }
    #${OVERLAY_ID} .hb-inv-bagtab {
      width: ${SLOT_SIZE - 4}px;
      height: ${SLOT_SIZE - 4}px;
      background: url("./sprites/acsprites/icon-slot-bg.png") center/100% 100% no-repeat;
      cursor: pointer;
      image-rendering: pixelated;
      opacity: 0.65;
    }
    #${OVERLAY_ID} .hb-inv-bagtab:hover { opacity: 1; }
    #${OVERLAY_ID} .hb-inv-bagtab.selected { opacity: 1; filter: drop-shadow(0 0 3px var(--hb-text-gold)); }
    /* Burden meter under paperdoll. */
    #${OVERLAY_ID} .hb-inv-burden {
      position: absolute;
      top: ${TITLE_H + PAPERDOLL_H + 6}px;
      left: 6px;
      width: ${PAPERDOLL_W}px;
      height: 14px;
      display: flex;
      align-items: center;
      gap: 4px;
      pointer-events: auto;
    }
    #${OVERLAY_ID} .hb-inv-burden-label {
      font-size: 9px;
      color: var(--hb-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    #${OVERLAY_ID} .hb-inv-burden-bar {
      flex: 1;
      height: 8px;
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid var(--hb-border-brass-dim);
      overflow: hidden;
    }
    #${OVERLAY_ID} .hb-inv-burden-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #6abc6a 0%, #d4b330 60%, #c83838 95%);
      transition: width 200ms linear;
    }
    /* Items grid — pack contents below the paperdoll. */
    #${OVERLAY_ID} .hb-inv-items {
      position: absolute;
      top: ${TITLE_H + PAPERDOLL_H + 28}px;
      left: 6px;
      right: 6px;
      bottom: 6px;
      overflow-y: auto;
      pointer-events: auto;
      padding: 4px;
      display: grid;
      grid-template-columns: repeat(${GRID_COLS}, ${SLOT_SIZE}px);
      gap: 2px;
      align-content: start;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--hb-border-brass-dim);
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    #${OVERLAY_ID} .hb-inv-slot {
      position: relative;
      width: ${SLOT_SIZE}px;
      height: ${SLOT_SIZE}px;
      background: url("./sprites/acsprites/icon-slot-bg.png") center/100% 100% no-repeat;
      image-rendering: pixelated;
      cursor: pointer;
      transition: filter 120ms ease;
    }
    #${OVERLAY_ID} .hb-inv-slot:hover { filter: brightness(1.25); }
    #${OVERLAY_ID} .hb-inv-slot.selected {
      filter: drop-shadow(0 0 4px var(--hb-text-gold)) brightness(1.2);
    }
    /* Item icon — colored square keyed by type-bit until we wire
       fetch_surface_pixels for the real icon DID. */
    #${OVERLAY_ID} .hb-inv-icon {
      position: absolute;
      top: 6px; left: 6px;
      width: ${SLOT_SIZE - 12}px;
      height: ${SLOT_SIZE - 12}px;
      border: 1px solid rgba(255, 255, 255, 0.25);
    }
    #${OVERLAY_ID} .hb-inv-stack {
      position: absolute;
      bottom: 1px;
      right: 2px;
      font-size: 8px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.95);
      line-height: 1;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-tip {
      position: absolute;
      bottom: calc(100% + 4px);
      left: 50%;
      transform: translateX(-50%);
      padding: 2px 6px;
      font-size: 10px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: rgba(10, 8, 4, 0.96);
      border: 1px solid var(--hb-border-brass);
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
      z-index: 60;
    }
    #${OVERLAY_ID} .hb-inv-slot:hover .hb-inv-tip { opacity: 1; }
  `;
  document.head.appendChild(style);
}

export const manifest = {
  id: "inventory",
  name: "Inventory",
  icon: "🎒",
  iconHidden: true,
  version: "0.1.0",
  description: "Right-side inventory window (gmInventoryUI 0x21000023)",
};

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  // Title bar
  const titleEl = document.createElement("div");
  titleEl.className = "hb-inv-title";
  const titleName = document.createElement("span");
  titleName.className = "hb-inv-title-name";
  titleName.textContent = "Inventory";
  titleEl.appendChild(titleName);
  const closeBtn = document.createElement("span");
  closeBtn.className = "hb-inv-close";
  closeBtn.textContent = "×";
  closeBtn.title = "Close (F4)";
  closeBtn.addEventListener("click", () => setOpen(false));
  titleEl.appendChild(closeBtn);
  overlay.appendChild(titleEl);

  // Paperdoll backdrop (placeholder — real 2D character model later)
  const paperdoll = document.createElement("div");
  paperdoll.className = "hb-inv-paperdoll";
  const paperdollBg = document.createElement("div");
  paperdollBg.className = "hb-inv-paperdoll-bg";
  paperdoll.appendChild(paperdollBg);
  overlay.appendChild(paperdoll);

  // Bag column — 4 placeholder tabs for now (Main, Bag 1, 2, 3).
  const bagCol = document.createElement("div");
  bagCol.className = "hb-inv-bagcol";
  for (let i = 0; i < 4; i++) {
    const tab = document.createElement("div");
    tab.className = "hb-inv-bagtab" + (i === 0 ? " selected" : "");
    tab.dataset.bag = String(i);
    tab.title = i === 0 ? "Main pack" : `Bag ${i}`;
    tab.addEventListener("click", () => {
      bagCol.querySelectorAll(".hb-inv-bagtab").forEach((t) => t.classList.remove("selected"));
      tab.classList.add("selected");
    });
    bagCol.appendChild(tab);
  }
  overlay.appendChild(bagCol);

  // Burden meter
  const burdenRow = document.createElement("div");
  burdenRow.className = "hb-inv-burden";
  const burdenLbl = document.createElement("span");
  burdenLbl.className = "hb-inv-burden-label";
  burdenLbl.textContent = "Burden";
  burdenRow.appendChild(burdenLbl);
  const burdenBar = document.createElement("div");
  burdenBar.className = "hb-inv-burden-bar";
  const burdenFill = document.createElement("div");
  burdenFill.className = "hb-inv-burden-fill";
  burdenBar.appendChild(burdenFill);
  burdenRow.appendChild(burdenBar);
  const burdenPct = document.createElement("span");
  burdenPct.className = "hb-inv-burden-label";
  burdenPct.textContent = "0%";
  burdenRow.appendChild(burdenPct);
  overlay.appendChild(burdenRow);

  // Items grid (pack contents)
  const itemsGrid = document.createElement("div");
  itemsGrid.className = "hb-inv-items";
  overlay.appendChild(itemsGrid);

  document.body.appendChild(overlay);

  // ── Mirror from index.html's #inv-equipped + #inv-pack ────────────
  function makeSlot(srcLi) {
    const slot = document.createElement("div");
    slot.className = "hb-inv-slot";
    slot.dataset.guid = srcLi.dataset?.guid ?? "";
    const tb = srcLi.dataset?.typeBit ?? "0x0";
    slot.dataset.typeBit = tb;
    const icon = document.createElement("div");
    icon.className = "hb-inv-icon";
    icon.style.background = TYPE_COLOR[tb] || "#444";
    slot.appendChild(icon);
    // Stack count (if the source row has a ×N badge)
    const stack = srcLi.querySelector(".stack");
    if (stack) {
      const s = document.createElement("span");
      s.className = "hb-inv-stack";
      s.textContent = stack.textContent;
      slot.appendChild(s);
    }
    // Tooltip
    const tip = document.createElement("span");
    tip.className = "hb-inv-tip";
    const name = srcLi.querySelector(".name");
    tip.textContent = name?.textContent ?? "(unnamed)";
    slot.appendChild(tip);
    // Forward draggable (vendor sells use the same pattern as the
    // source <li> with draggable=true).
    if (srcLi.getAttribute("draggable") === "true") {
      slot.draggable = true;
      slot.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("application/x-hb-inv-guid", slot.dataset.guid);
        ev.dataTransfer.effectAllowed = "move";
      });
    }
    return slot;
  }

  function rebuild() {
    const equipped = document.getElementById("inv-equipped");
    const pack = document.getElementById("inv-pack");
    // Clear and re-populate. Equipped items will eventually go to paperdoll
    // slot positions; for now they just lead the items grid.
    itemsGrid.innerHTML = "";
    const all = [];
    if (equipped) for (const li of equipped.children) all.push(li);
    if (pack) for (const li of pack.children) all.push(li);
    for (const li of all) {
      itemsGrid.appendChild(makeSlot(li));
    }
  }

  let observers = [];
  function tryHook() {
    const equipped = document.getElementById("inv-equipped");
    const pack = document.getElementById("inv-pack");
    if (!equipped || !pack) return false;
    rebuild();
    for (const list of [equipped, pack]) {
      const o = new MutationObserver(() => rebuild());
      o.observe(list, { childList: true, subtree: false });
      observers.push(o);
    }
    return true;
  }
  let pollTimer = null;
  if (!tryHook()) {
    pollTimer = setInterval(() => {
      if (tryHook()) { clearInterval(pollTimer); pollTimer = null; }
    }, 500);
  }

  // Update title with character name when available.
  function tryName() {
    const sn = document.getElementById("char-name")?.textContent
            || window.__pluginClient?.player?.stats?.name
            || null;
    if (sn) titleName.textContent = `Inventory of ${sn}`;
  }
  tryName();
  const nameRetry = setInterval(tryName, 1000);

  // Show/hide + F4 toggle (retail muscle-memory).
  function setOpen(open) { overlay.dataset.open = open ? "1" : "0"; }
  setOpen(true);
  function onKey(ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (ev.key === "F4") {
      ev.preventDefault();
      setOpen(overlay.dataset.open !== "1");
    }
  }
  window.addEventListener("keydown", onKey);

  return () => {
    window.removeEventListener("keydown", onKey);
    clearInterval(nameRetry);
    if (pollTimer) clearInterval(pollTimer);
    for (const o of observers) o.disconnect();
    overlay.remove();
  };
}
