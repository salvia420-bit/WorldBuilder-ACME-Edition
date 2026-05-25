// Contracts panel — view of plugins/main-panel.js. Port of retail
// gmContractsUI (layout 0x21000069, 20 elements, 3 image DIDs).
// Bound to F7 (J/F6 is Journal, sibling tab here).
//
// Per the acpedia "Contracts & Journal Panel" page, Contracts are
// repeatable quest assignments accepted from contract NPCs that
// reset on a timer. Player can have N active contracts (typically
// 7 in retail), each with completion status + cooldown.
//
// Layout-port 2026-05-24: wired retail gmContractsUI 0x21000069
// (300×500, 20 elements across 2 top-level subtrees: a 16-child main
// panel + a 2-tab strip sibling). v1 fetch_layout serializes geometry
// only — StateDesc/BaseProperty text content is a follow-on, so the
// per-element labels stay hand-tuned and we wire positions/sizes only.
//
// Element-id map (confirmed by contracts_panel_layout_dump 2026-05-24):
//   0x100005CD — root main panel (300×500)
//     0x100005CE — top-left label (8,8) 80×18  — "Active Contracts" label
//     0x100005D6 — top-right label (160,8) 80×18 — "N / 7" counter
//     0x100005CF — contracts list (type=5 listbox) (8,30) 270×298
//     0x100005D0 — list scrollbar (278,30) 16×298
//     0x100005D8 — detail label 1  (8,332)  56×18
//     0x100005DF — detail value 1  (64,332) 232×18
//     0x100005D9 — detail label 2  (8,352)  56×18
//     0x100005E0 — detail value 2  (64,352) 232×18
//     0x100005DA — detail label 3  (8,372)  120×18
//     0x100005E1 — detail value 3  (124,372) 168×18
//     0x100005DB — detail label 4  (8,392)  120×18
//     0x100005E2 — detail value 4  (124,392) 168×18
//     0x100005DE — detail description body (8,418) 270×52
//     0x100005DD — action button #1 (8,468) 56×32
//     0x100005E3 — action button #2 (64,468) 150×32  — primary "Abandon"
//     0x100005DC — action button #3 (232,468) 60×32 default_state=1 — secondary
//   0x100005D7 — tab strip (type=3 3D bevel) (0,0) 270×20
//     0x100005D1 — tab 1 (0,0)   152×20  — "Journal" (wider, sibling)
//     0x100005D2 — tab 2 (152,0) 118×20  — "Contracts" (current)
//
// Note retail's layout is 500px tall; main-panel's body slot is 337px,
// so the bottom rows (description body + action buttons at y≥418) sit
// below the main-panel body and would be clipped by overflow:hidden.
// We compress the layout vertically by reducing the list area + lifting
// the detail block up so the action buttons land at y≈300 inside the
// 337px body. The relative spacing (gaps between rows) is preserved.
//
// DAT sprites (already extracted under data/ui-sprites/):
//   0x06001AAF — dark mottled background panel (shared with allegiance).
//   0x06004CC2 — gray placeholder spacer.
//   0x06004CCA — gray placeholder spacer (alt).
//
// Contract data not yet exposed by SessionHandle — view shows
// placeholder rows with progress + cooldown columns.

import { setAcText } from "../ui/ac_font.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";

const STYLE_ID = "hb-contracts-view-style";

// gmContractsUI 0x21000069 — element_id constants from
// contracts_panel_layout_dump 2026-05-24.
const CONTRACTS_LAYOUT_ID = 0x21000069;
const CONTRACTS_ELEMS = {
  // Main panel root (300×500) — used as the layout coord origin.
  root:           0x100005CD,
  // Top header labels.
  hdrLeftLbl:     0x100005CE,  // "Active Contracts"
  hdrRightLbl:    0x100005D6,  // counter "N / 7"
  // List + scrollbar.
  list:           0x100005CF,  // type=5 listbox (8,30) 270×298
  scrollbar:      0x100005D0,  // (278,30) 16×298
  // Detail rows (4 label/value pairs).
  detLbl1:        0x100005D8,
  detVal1:        0x100005DF,
  detLbl2:        0x100005D9,
  detVal2:        0x100005E0,
  detLbl3:        0x100005DA,
  detVal3:        0x100005E1,
  detLbl4:        0x100005DB,
  detVal4:        0x100005E2,
  // Description body (large text area).
  detDesc:        0x100005DE,
  // Action buttons (row at y=468 in retail).
  actBtn1:        0x100005DD,  // 56×32
  actBtn2:        0x100005E3,  // 150×32 — primary "Abandon"
  actBtn3:        0x100005DC,  // 60×32 default_state=1 — secondary
  // Tab strip (sibling top-level, treated as inset chrome).
  tabStrip:       0x100005D7,
  tabJournal:     0x100005D1,  // 152×20
  tabContracts:   0x100005D2,  // 118×20
};

// Layout 0x21000069 is 500px tall; main-panel body is 337px. We compress
// vertically by mapping the retail y-range [0..500] → [0..337] for the
// list area only, while keeping detail/action heights intact and lifting
// them to start right after the list. This keeps all 20 elements visible.
const PANEL_RETAIL_H = 500;
const PANEL_FIT_H = 337;
// Reference-only retail rect for the list pane (0x100005CF): y=30 h=298.
// We pin the detail/action block to the bottom of the 337-px body so the
// list shrinks dynamically; explicit retail Y/H not used in the apply path.
// Detail/action block is the bottom 162px (332..500). We pin that block
// to the bottom of the 337px body so the action buttons stay at the very
// bottom and the list shrinks to fill the remaining space.
const DETAIL_BLOCK_START_RETAIL = 332;
const DETAIL_BLOCK_H = PANEL_RETAIL_H - DETAIL_BLOCK_START_RETAIL; // 168
const DETAIL_BLOCK_START_FIT = PANEL_FIT_H - DETAIL_BLOCK_H; // 169
const Y_OFFSET = DETAIL_BLOCK_START_FIT - DETAIL_BLOCK_START_RETAIL; // -163

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .hb-contracts-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      overflow: hidden;
      background: url("./data/ui-sprites/0x06001AAF.png") repeat;
    }
    /* Tab strip — retail 0x100005D7 (270×20). applyContractsLayout
       overrides per-element x/y/w/h; CSS sets the fallback positions. */
    .hb-contracts-tabs {
      position: absolute;
      top: 0;
      left: 0;
      width: 270px;
      height: 20px;
      box-sizing: border-box;
      display: block;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-contracts-tab {
      position: absolute;
      top: 0;
      height: 20px;
      padding: 0 6px;
      font-size: 10px;
      line-height: 20px;
      color: var(--hb-text-cream-bright);
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--hb-border-brass-dim);
      border-bottom: none;
      cursor: pointer;
      user-select: none;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      box-sizing: border-box;
      text-align: center;
    }
    .hb-contracts-tab:hover { background: var(--hb-overlay-hover); }
    .hb-contracts-tab.active {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    /* Header labels — retail 0x100005CE (left) and 0x100005D6 (right). */
    .hb-contracts-hdr-lbl {
      position: absolute;
      box-sizing: border-box;
      font-size: 10px;
      line-height: 18px;
      pointer-events: none;
    }
    .hb-contracts-hdr-lbl.left  { color: var(--hb-text-cream); }
    .hb-contracts-hdr-lbl.right { color: var(--hb-text-gold); text-align: right; font-variant-numeric: tabular-nums; }
    /* List — retail 0x100005CF (type=5 listbox). applyContractsLayout
       sets explicit left/top/width/height; the list rows + header live
       inside as absolutely-positioned rows from the row template. */
    .hb-contracts-list {
      position: absolute;
      box-sizing: border-box;
      overflow-y: auto;
      padding: 0;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--hb-border-brass-dim);
    }
    /* Scrollbar slot — retail 0x100005D0. Browser-rendered scrollbar
       inside .hb-contracts-list collapses into this column; we render
       this slot as a decorative brass-trim track so the layout-port
       verifier can confirm the slot's geometry. */
    .hb-contracts-scrollbar {
      position: absolute;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.4);
      border-left: 1px solid var(--hb-border-brass-dim);
      pointer-events: none;
    }
    .hb-contracts-list-h {
      display: grid;
      grid-template-columns: 1fr 70px 70px;
      gap: 4px;
      padding: 3px 6px;
      font-size: 9px;
      color: var(--hb-text-cream-bright);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      border-bottom: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.45);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .hb-contracts-row {
      display: grid;
      grid-template-columns: 1fr 70px 70px;
      gap: 4px;
      padding: 3px 6px;
      font-size: 10px;
      line-height: 14px;
      border-bottom: 1px solid rgba(138, 117, 68, 0.18);
      align-items: center;
      cursor: pointer;
    }
    .hb-contracts-row:hover { background: var(--hb-overlay-hover); }
    .hb-contracts-row.selected {
      background: var(--hb-overlay-active);
      border-bottom-color: var(--hb-border-brass);
    }
    .hb-contracts-row .name { color: var(--hb-text-cream); }
    .hb-contracts-row .progress { color: var(--hb-text-numeric-green); text-align: right; font-variant-numeric: tabular-nums; }
    .hb-contracts-row .cooldown { color: var(--hb-text-muted); text-align: right; font-variant-numeric: tabular-nums; font-size: 9px; }
    .hb-contracts-row.complete .progress { color: var(--hb-text-gold); }
    .hb-contracts-empty {
      padding: 18px 12px;
      color: var(--hb-text-muted);
      font-style: italic;
      text-align: center;
      font-size: 10px;
    }
    /* Detail label/value pairs — retail 0x100005D8 / 0x100005DF and
       the 3 sibling pairs. Labels right-aligned with gold tint,
       values cream. */
    .hb-contracts-det-lbl {
      position: absolute;
      box-sizing: border-box;
      font-size: 10px;
      line-height: 18px;
      color: var(--hb-text-gold);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      pointer-events: none;
      padding: 0 4px 0 0;
    }
    .hb-contracts-det-val {
      position: absolute;
      box-sizing: border-box;
      font-size: 10px;
      line-height: 18px;
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.8);
      pointer-events: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* Description body — retail 0x100005DE (270×52). Multi-line. */
    .hb-contracts-det-desc {
      position: absolute;
      box-sizing: border-box;
      padding: 4px 6px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid var(--hb-border-brass-dim);
      font-size: 10px;
      line-height: 14px;
      color: var(--hb-text-cream);
      overflow-y: auto;
      scrollbar-width: thin;
    }
    /* Action buttons — retail 0x100005DD/E3/DC. The middle one (E3,
       150×32) is the primary "Abandon" action; flanking 56×32 and
       60×32 are smaller secondaries. */
    .hb-contracts-btn {
      position: absolute;
      box-sizing: border-box;
      padding: 0 6px;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      line-height: 30px;
      color: var(--hb-text-cream);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      user-select: none;
      text-align: center;
    }
    .hb-contracts-btn:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-contracts-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      filter: grayscale(0.6);
    }
    .hb-contracts-btn.primary { color: var(--hb-text-cream-bright); }
    .hb-contracts-btn.primary:hover { color: var(--hb-text-gold); }
  `;
  document.head.appendChild(style);
}

function emit(text, cat = 0) {
  const log = document.getElementById("chat-log");
  if (!log) return;
  const li = document.createElement("li");
  li.className = `cat-${cat}`;
  li.dataset.cat = String(cat);
  li.textContent = text;
  log.appendChild(li);
}

// Placeholder contracts until SessionHandle.contracts() lands.
const SAMPLE_CONTRACTS = [
  {
    id: 100,
    name: "Aerlinthe Smelting Quest",
    npc: "Talid",
    location: "Wai Jhou",
    reward: "1500 XP",
    progress: "0 / 5",
    cooldown: "—",
    complete: false,
    desc: "Speak with Talid in Wai Jhou; he requires Pyreal nuggets for the colony.",
  },
  {
    id: 101,
    name: "Drudge Hunting",
    npc: "Sergeant Maeli",
    location: "Holtburg Outskirts",
    reward: "2000 XP",
    progress: "10 / 10",
    cooldown: "00:24:11",
    complete: true,
    desc: "Slay 10 drudges in the Holtburg Outskirts. Reward: 2000 XP. Cooldown: 30m.",
  },
  {
    id: 102,
    name: "Daily Rare Pickup",
    npc: "Rotating",
    location: "Various",
    reward: "Rare item",
    progress: "—",
    cooldown: "ready",
    complete: false,
    desc: "Pick up a daily rare from the rotating quest NPC.",
  },
];

// Helper: apply (x,y,w,h) from a LayoutDesc element to a DOM node,
// clearing right/bottom anchors first so explicit left/top win.
function applyBox(el, layoutEl, { yOffset = 0 } = {}) {
  el.style.right = "";
  el.style.bottom = "";
  if (typeof layoutEl.x === "number") el.style.left = `${layoutEl.x}px`;
  if (typeof layoutEl.y === "number") el.style.top = `${layoutEl.y + yOffset}px`;
  if (typeof layoutEl.width === "number") el.style.width = `${layoutEl.width}px`;
  if (typeof layoutEl.height === "number") el.style.height = `${layoutEl.height}px`;
}

// Apply gmContractsUI 0x21000069 layout to the contracts-panel
// sub-elements. The contracts view mounts via user-initiated
// showView("contracts") AFTER wasm is ready, so no retry loop is needed
// (unlike radar / chat-panel which mount during early boot). The
// cached-layout fast path keeps re-opens synchronous.
function applyContractsLayout(refs) {
  const apply = (layout) => {
    if (!layout) return;
    let applied = 0;

    // Tab strip — sibling top-level root 0x100005D7 (270×20 at 0,0).
    const tabStripDesc = findElementById(layout, CONTRACTS_ELEMS.tabStrip);
    if (tabStripDesc && refs.tabsEl) {
      applyBox(refs.tabsEl, tabStripDesc);
      applied += 1;
    }
    // Tabs inside the strip — positions are relative to the strip itself.
    const tabJournalDesc = findElementById(layout, CONTRACTS_ELEMS.tabJournal);
    if (tabJournalDesc && refs.tabJournalEl) {
      applyBox(refs.tabJournalEl, tabJournalDesc);
      applied += 1;
    }
    const tabContractsDesc = findElementById(layout, CONTRACTS_ELEMS.tabContracts);
    if (tabContractsDesc && refs.tabContractsEl) {
      applyBox(refs.tabContractsEl, tabContractsDesc);
      applied += 1;
    }

    // Top header labels.
    const hdrLeftDesc = findElementById(layout, CONTRACTS_ELEMS.hdrLeftLbl);
    if (hdrLeftDesc && refs.hdrLeftEl) {
      applyBox(refs.hdrLeftEl, hdrLeftDesc);
      applied += 1;
    }
    const hdrRightDesc = findElementById(layout, CONTRACTS_ELEMS.hdrRightLbl);
    if (hdrRightDesc && refs.hdrRightEl) {
      applyBox(refs.hdrRightEl, hdrRightDesc);
      applied += 1;
    }

    // List — squeeze the height so the detail block fits inside the
    // 337px body. Retail says (8,30) 270×298 (bottom edge at y=328);
    // we cap at y=DETAIL_BLOCK_START_FIT-4=165 so a 4px gap separates
    // the list from the detail rows.
    const listDesc = findElementById(layout, CONTRACTS_ELEMS.list);
    if (listDesc && refs.listEl) {
      refs.listEl.style.right = "";
      refs.listEl.style.bottom = "";
      if (typeof listDesc.x === "number") refs.listEl.style.left = `${listDesc.x}px`;
      if (typeof listDesc.y === "number") refs.listEl.style.top = `${listDesc.y}px`;
      if (typeof listDesc.width === "number") refs.listEl.style.width = `${listDesc.width}px`;
      // Override height: shrink to fit between top (y=30) and detail block.
      const listMaxH = DETAIL_BLOCK_START_FIT - listDesc.y - 4;
      refs.listEl.style.height = `${listMaxH}px`;
      applied += 1;
    }
    const sbDesc = findElementById(layout, CONTRACTS_ELEMS.scrollbar);
    if (sbDesc && refs.scrollbarEl) {
      refs.scrollbarEl.style.right = "";
      refs.scrollbarEl.style.bottom = "";
      if (typeof sbDesc.x === "number") refs.scrollbarEl.style.left = `${sbDesc.x}px`;
      if (typeof sbDesc.y === "number") refs.scrollbarEl.style.top = `${sbDesc.y}px`;
      if (typeof sbDesc.width === "number") refs.scrollbarEl.style.width = `${sbDesc.width}px`;
      const sbMaxH = DETAIL_BLOCK_START_FIT - sbDesc.y - 4;
      refs.scrollbarEl.style.height = `${sbMaxH}px`;
      applied += 1;
    }

    // Detail rows (4 label/value pairs + description body).
    // Apply with Y_OFFSET so the bottom block sits inside the 337px body.
    const detailIds = [
      [CONTRACTS_ELEMS.detLbl1, refs.detLbl1El],
      [CONTRACTS_ELEMS.detVal1, refs.detVal1El],
      [CONTRACTS_ELEMS.detLbl2, refs.detLbl2El],
      [CONTRACTS_ELEMS.detVal2, refs.detVal2El],
      [CONTRACTS_ELEMS.detLbl3, refs.detLbl3El],
      [CONTRACTS_ELEMS.detVal3, refs.detVal3El],
      [CONTRACTS_ELEMS.detLbl4, refs.detLbl4El],
      [CONTRACTS_ELEMS.detVal4, refs.detVal4El],
      [CONTRACTS_ELEMS.detDesc, refs.detDescEl],
    ];
    for (const [id, el] of detailIds) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      applyBox(el, desc, { yOffset: Y_OFFSET });
      applied += 1;
    }

    // Action buttons (row at retail y=468).
    const btnIds = [
      [CONTRACTS_ELEMS.actBtn1, refs.actBtn1El],
      [CONTRACTS_ELEMS.actBtn2, refs.actBtn2El],
      [CONTRACTS_ELEMS.actBtn3, refs.actBtn3El],
    ];
    for (const [id, el] of btnIds) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      applyBox(el, desc, { yOffset: Y_OFFSET });
      applied += 1;
    }

    try {
      window.__diag?.layout?.onContractsApplied?.({ applied });
    } catch (_) {}
  };
  const cached = getCachedLayout(CONTRACTS_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(CONTRACTS_LAYOUT_ID).then(apply).catch(() => {});
}

export const view = {
  name: "Contracts",
  nameFor: () => "Contracts",
  mount: (parentEl, _ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-contracts-root";

    // ── Tab strip — retail 0x100005D7 (Journal | Contracts) ────────
    const tabsEl = document.createElement("div");
    tabsEl.className = "hb-contracts-tabs";

    const tabJournalEl = document.createElement("button");
    tabJournalEl.type = "button";
    tabJournalEl.className = "hb-contracts-tab";
    setAcText(tabJournalEl, "Journal");
    tabJournalEl.addEventListener("click", () => window.__mainPanel?.showView?.("journal"));
    tabsEl.appendChild(tabJournalEl);

    const tabContractsEl = document.createElement("button");
    tabContractsEl.type = "button";
    tabContractsEl.className = "hb-contracts-tab active";
    setAcText(tabContractsEl, "Contracts");
    tabsEl.appendChild(tabContractsEl);

    root.appendChild(tabsEl);

    // ── Top header labels — retail 0x100005CE + 0x100005D6 ─────────
    const hdrLeftEl = document.createElement("div");
    hdrLeftEl.className = "hb-contracts-hdr-lbl left";
    setAcText(hdrLeftEl, "Active");
    root.appendChild(hdrLeftEl);

    const hdrRightEl = document.createElement("div");
    hdrRightEl.className = "hb-contracts-hdr-lbl right";
    setAcText(hdrRightEl, `${SAMPLE_CONTRACTS.length} / 7`);
    root.appendChild(hdrRightEl);

    // ── List — retail 0x100005CF ───────────────────────────────────
    const listEl = document.createElement("div");
    listEl.className = "hb-contracts-list";
    const head = document.createElement("div");
    head.className = "hb-contracts-list-h";
    head.innerHTML = `<span>Contract</span><span style="text-align:right">Progress</span><span style="text-align:right">Cooldown</span>`;
    listEl.appendChild(head);

    // ── Scrollbar slot — retail 0x100005D0 (decorative) ────────────
    const scrollbarEl = document.createElement("div");
    scrollbarEl.className = "hb-contracts-scrollbar";

    // ── Detail label/value pairs — retail 0x100005D8…0x100005E2 ────
    // Field 1 (56-wide label/232 val): NPC
    const detLbl1El = document.createElement("div");
    detLbl1El.className = "hb-contracts-det-lbl";
    setAcText(detLbl1El, "NPC:");
    const detVal1El = document.createElement("div");
    detVal1El.className = "hb-contracts-det-val";
    setAcText(detVal1El, "—");

    // Field 2 (56-wide label/232 val): Location
    const detLbl2El = document.createElement("div");
    detLbl2El.className = "hb-contracts-det-lbl";
    setAcText(detLbl2El, "Loc:");
    const detVal2El = document.createElement("div");
    detVal2El.className = "hb-contracts-det-val";
    setAcText(detVal2El, "—");

    // Field 3 (120-wide label/168 val): Progress
    const detLbl3El = document.createElement("div");
    detLbl3El.className = "hb-contracts-det-lbl";
    setAcText(detLbl3El, "Progress:");
    const detVal3El = document.createElement("div");
    detVal3El.className = "hb-contracts-det-val";
    setAcText(detVal3El, "—");

    // Field 4 (120-wide label/168 val): Reward / Cooldown
    const detLbl4El = document.createElement("div");
    detLbl4El.className = "hb-contracts-det-lbl";
    setAcText(detLbl4El, "Reward:");
    const detVal4El = document.createElement("div");
    detVal4El.className = "hb-contracts-det-val";
    setAcText(detVal4El, "—");

    // Description body — retail 0x100005DE
    const detDescEl = document.createElement("div");
    detDescEl.className = "hb-contracts-det-desc";
    setAcText(detDescEl, "Select a contract to view details.");

    // ── Action buttons — retail 0x100005DD/E3/DC ───────────────────
    const actBtn1El = document.createElement("button");
    actBtn1El.type = "button";
    actBtn1El.className = "hb-contracts-btn";
    setAcText(actBtn1El, "Map");
    actBtn1El.title = "Show this contract's quest location on the world map (not wired yet)";
    actBtn1El.disabled = true;

    const actBtn2El = document.createElement("button");
    actBtn2El.type = "button";
    actBtn2El.className = "hb-contracts-btn primary";
    setAcText(actBtn2El, "Abandon");
    actBtn2El.title = "Drop the selected contract";
    actBtn2El.disabled = true;

    const actBtn3El = document.createElement("button");
    actBtn3El.type = "button";
    actBtn3El.className = "hb-contracts-btn";
    setAcText(actBtn3El, "Redo");
    actBtn3El.title = "Request a refresh of the selected daily";
    actBtn3El.disabled = true;

    // Selection state + click handlers --------------------------------
    let selected = null;
    function selectRow(c, rowEl) {
      selected = c;
      listEl.querySelectorAll(".hb-contracts-row.selected").forEach((r) => r.classList.remove("selected"));
      rowEl?.classList.add("selected");
      setAcText(detVal1El, c.npc ?? "—");
      setAcText(detVal2El, c.location ?? "—");
      setAcText(detVal3El, c.progress ?? "—");
      setAcText(detVal4El, c.reward ?? c.cooldown ?? "—");
      setAcText(detDescEl, c.desc ?? "");
      actBtn1El.disabled = false;
      actBtn2El.disabled = false;
      actBtn3El.disabled = false;
    }

    if (SAMPLE_CONTRACTS.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hb-contracts-empty";
      setAcText(empty, "No active contracts. Speak with a contract NPC to accept one.");
      listEl.appendChild(empty);
    } else {
      for (const c of SAMPLE_CONTRACTS) {
        const row = document.createElement("div");
        row.className = "hb-contracts-row" + (c.complete ? " complete" : "");
        row.dataset.id = String(c.id);
        const name = document.createElement("span");
        name.className = "name";
        setAcText(name, c.name);
        row.appendChild(name);
        const prog = document.createElement("span");
        prog.className = "progress";
        setAcText(prog, c.progress);
        row.appendChild(prog);
        const cd = document.createElement("span");
        cd.className = "cooldown";
        setAcText(cd, c.cooldown);
        row.appendChild(cd);
        row.addEventListener("click", () => selectRow(c, row));
        listEl.appendChild(row);
      }
    }

    // Wire button clicks (placeholder game-actions — wire in J).
    actBtn1El.addEventListener("click", () => {
      if (!selected) return;
      emit(`[contracts] Map "${selected.name}" — quest-map waypoint (not wired yet)`);
    });
    actBtn2El.addEventListener("click", () => {
      if (!selected) return;
      emit(`[contracts] Abandon "${selected.name}" — drop the selected contract (game-action not wired yet)`);
    });
    actBtn3El.addEventListener("click", () => {
      if (!selected) return;
      emit(`[contracts] Mark Redo "${selected.name}" — request a refresh of the selected daily (game-action not wired yet)`);
    });

    // Append in retail z-order: list/scrollbar first so detail block
    // and buttons overlay on top.
    root.appendChild(listEl);
    root.appendChild(scrollbarEl);
    root.appendChild(detLbl1El);
    root.appendChild(detVal1El);
    root.appendChild(detLbl2El);
    root.appendChild(detVal2El);
    root.appendChild(detLbl3El);
    root.appendChild(detVal3El);
    root.appendChild(detLbl4El);
    root.appendChild(detVal4El);
    root.appendChild(detDescEl);
    root.appendChild(actBtn1El);
    root.appendChild(actBtn2El);
    root.appendChild(actBtn3El);

    parentEl.appendChild(root);

    // Apply retail layout AFTER elements are in the DOM.
    applyContractsLayout({
      tabsEl,
      tabJournalEl,
      tabContractsEl,
      hdrLeftEl,
      hdrRightEl,
      listEl,
      scrollbarEl,
      detLbl1El, detVal1El,
      detLbl2El, detVal2El,
      detLbl3El, detVal3El,
      detLbl4El, detVal4El,
      detDescEl,
      actBtn1El, actBtn2El, actBtn3El,
    });

    return () => { root.remove(); };
  },
};

export const manifest = {
  id: "contracts-panel",
  name: "Contracts",
  icon: "📋",
  iconHidden: true,
  version: "0.2.0",
  description: "Contracts (gmContractsUI 0x21000069 — layout-port 2026-05-24)",
};
