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

// Wave F.5 (2026-05-27) — real-data sourcing.
//
// Pre-Wave-F.5 this file shipped `SAMPLE_CONTRACTS` placeholder rows.
// The wasm side now exports `SessionHandle.playerContracts()` which
// returns a `ContractsSnapshotJs` with the actual `ContractTrackerJs`
// rows folded from
// `GameEvent::SendClientContractTracker{Table}` (opcodes 0x0314 /
// 0x0315; see `apps/holtburger-web/src/lib.rs:33990+`). The panel
// subscribes to the `contractsUpdated` bus event (`kind=34` drain)
// and re-renders.
//
// `ContractStage` enum:
//   1 = New  — accepted, no progress yet
//   2 = InProgress — partial progress
//   3 = DoneOrPendingRepeat — completed (check `timeWhenRepeats` for
//       availability)
//   4+ = contract-specific updates (per Chorizite enum)
//
// `timeWhenDone` / `timeWhenRepeats` are server epoch seconds (i64 on
// the wire, surfaced as f64 since JS Number safely covers all AC time
// stamps).

// 7 = retail soft cap (gmContractsUI's header shows "N / 7"); ACE
// `ContractManager.cs:24` has MaxContracts = 100 (the hard cap server
// applies); we surface the retail-style 7 for the panel header.
const CONTRACTS_DISPLAY_CAP = 7;
const CONTRACT_STAGE = Object.freeze({
  New: 1,
  InProgress: 2,
  DoneOrPendingRepeat: 3,
});

// Wave F.5 (2026-05-27) — pull the live contracts snapshot from wasm.
// Returns `{ trackers: ContractTrackerJs[], displayContractId, count }`
// or `null` pre-event.
function fetchContractsSnapshot() {
  const handle = window.__sessionHandle;
  if (typeof handle?.playerContracts !== "function") return null;
  try {
    return handle.playerContracts() ?? null;
  } catch (_) {
    return null;
  }
}

// Stage label for the panel rows. Falls back to "Stage N" for the
// "contract-specific" 4+ values which we don't have specialised
// labels for yet.
function stageLabel(stage) {
  switch (stage) {
    case CONTRACT_STAGE.New: return "New";
    case CONTRACT_STAGE.InProgress: return "Active";
    case CONTRACT_STAGE.DoneOrPendingRepeat: return "Done";
    default: return `Stage ${stage}`;
  }
}

// Format a server epoch in seconds as "HH:MM:SS" countdown remaining
// from `now`. Returns "—" when `epoch_sec <= 0` (server's "not set"),
// "ready" when the countdown is in the past, else "HH:MM:SS".
function formatCountdown(epoch_sec, now_sec) {
  if (!epoch_sec || epoch_sec <= 0) return "—";
  const remaining = Math.floor(epoch_sec - now_sec);
  if (remaining <= 0) return "ready";
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// Wave F.5 follow-on (2026-05-27) — DAT-backed Contract name lookup.
//
// The wasm bundle exposes `prefetchContractTable()` (one-shot async
// load of `ContractTable` 0x0E00001D) + `getContractRecord(id)`
// (synchronous per-id lookup returning the full Contract record).
// Pre-followon the panel shipped `Contract #N` placeholders. Now we
// surface the real `contractName` (e.g. "Jailbreak: Ardent Leader")
// and use `nameNpcStart` + `description` for the detail block.
//
// The prefetch fires once on first call to `projectTracker` (idempotent
// thread-local cache on the wasm side; subsequent calls are no-ops).
// Until the prefetch resolves we keep the placeholder name so the
// initial render isn't blocked on a DAT load.
let contractTablePrefetched = false;
let contractTablePrefetchInFlight = null;
async function ensureContractTablePrefetched() {
  if (contractTablePrefetched) return true;
  if (contractTablePrefetchInFlight) return contractTablePrefetchInFlight;
  if (typeof window?.prefetchContractTable !== "function") return false;
  contractTablePrefetchInFlight = (async () => {
    try {
      await window.prefetchContractTable();
      contractTablePrefetched = true;
      return true;
    } catch (_) {
      return false;
    } finally {
      contractTablePrefetchInFlight = null;
    }
  })();
  return contractTablePrefetchInFlight;
}

function lookupContractRecord(id) {
  if (typeof window?.getContractRecord !== "function") return null;
  try {
    return window.getContractRecord(id >>> 0) ?? null;
  } catch (_) {
    return null;
  }
}

// Project a wasm `ContractTrackerJs` into the shape the row + detail
// renderers consume. After the ContractTable prefetch resolves the
// `name` + `desc` columns flip from `Contract #N` placeholders to the
// real DAT values via `lookupContractRecord(id)`.
function projectTracker(t, now_sec) {
  const id = (t.contractId >>> 0) || 0;
  const stage = (t.stage >>> 0) || 0;
  const done = Number(t.timeWhenDone || 0);
  const repeats = Number(t.timeWhenRepeats || 0);
  const isDone = stage === CONTRACT_STAGE.DoneOrPendingRepeat;
  // DAT-backed name lookup (null if table not prefetched yet).
  const rec = lookupContractRecord(id);
  const name = rec?.name || `Contract #${id}`;
  const npc = rec?.nameNpcStart || rec?.nameNpcEnd || "";
  const desc = rec?.description
    ? `${rec.description}${npc ? ` (NPC: ${npc})` : ""} — stage ${stageLabel(stage)}.`
    : `Contract ${id} — stage ${stageLabel(stage)}.`;
  return {
    id,
    name,
    npc,
    stage,
    stageLabel: stageLabel(stage),
    progress: stageLabel(stage),
    cooldown: isDone ? formatCountdown(repeats, now_sec) : "—",
    complete: isDone,
    timeWhenDone: done,
    timeWhenRepeats: repeats,
    desc,
    descriptionProgress: rec?.descriptionProgress || "",
  };
}

/**
 * Wave F.5 (2026-05-27) — pure helper. Builds the panel's display
 * model from a wasm `ContractsSnapshotJs` (or `null`). Pulled out so
 * `tests/contracts_panel.test.cjs` can exercise the projection
 * + sort + countdown logic without a DOM.
 */
export function buildContractsViewModel(snapshot, now_sec) {
  if (!snapshot) {
    return {
      rows: [],
      count: 0,
      displayCap: CONTRACTS_DISPLAY_CAP,
      displayContractId: 0,
    };
  }
  const rows = [];
  // `snapshot.trackers` is already sorted by contract_id ascending on
  // the wasm side (`apply_player_contracts_full`). Preserve that
  // order for stable rendering across refreshes.
  for (const t of snapshot.trackers || []) {
    rows.push(projectTracker(t, now_sec));
  }
  return {
    rows,
    count: rows.length,
    displayCap: CONTRACTS_DISPLAY_CAP,
    displayContractId: (snapshot.displayContractId >>> 0) || 0,
  };
}

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
    // Pre-event placeholder: "0 / 7" until the first
    // SendClientContractTrackerTable lands (Wave F.5 — refreshed in
    // `rerender()` below).
    setAcText(hdrRightEl, `0 / ${CONTRACTS_DISPLAY_CAP}`);
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
    // Wave F.5 (2026-05-27) — keep selection by contract_id across
    // re-renders so an in-flight Abandon doesn't lose the selection
    // when the server echoes back the delete and the list re-binds.
    let selectedId = 0;
    function selectRow(c, rowEl) {
      selectedId = c.id;
      listEl.querySelectorAll(".hb-contracts-row.selected").forEach((r) => r.classList.remove("selected"));
      rowEl?.classList.add("selected");
      // Wave F.5 follow-on (2026-05-27) — DAT-backed detail rows.
      // `c.npc` is `nameNpcStart` from ContractTable; cell_id (NW
      // 16-bit landblock id) provides a coarse location hint via
      // the start NPC's `location.cellId`. Falls back to "—" when
      // the prefetch hasn't resolved yet or the contract has no
      // start NPC location.
      const rec = lookupContractRecord(c.id);
      const cellId = rec?.locationNpcStart?.cellId || 0;
      const lbId = cellId ? `0x${((cellId >>> 16) & 0xFFFF).toString(16).padStart(4, "0").toUpperCase()}` : "";
      setAcText(detVal1El, c.npc || "—");
      setAcText(detVal2El, lbId || "—");
      setAcText(detVal3El, c.descriptionProgress || c.progress);
      setAcText(detVal4El, c.cooldown);
      setAcText(detDescEl, c.desc);
      actBtn1El.disabled = false;
      // Abandon is only sensible for active contracts; pre-WB stretch
      // we always allow it server-side answers if invalid (no harm).
      actBtn2El.disabled = false;
      actBtn3El.disabled = !c.complete;
    }

    // Wave F.5 (2026-05-27) — re-render the list from
    // `handle.playerContracts()`. Called once at mount and again on
    // every `contractsUpdated` bus event.
    function rerender() {
      const snap = fetchContractsSnapshot();
      const now_sec = Math.floor(Date.now() / 1000);
      const vm = buildContractsViewModel(snap, now_sec);

      setAcText(hdrRightEl, `${vm.count} / ${vm.displayCap}`);

      // Clear existing rows but keep the sticky header.
      const oldRows = listEl.querySelectorAll(".hb-contracts-row, .hb-contracts-empty");
      oldRows.forEach((r) => r.remove());

      if (vm.rows.length === 0) {
        const empty = document.createElement("div");
        empty.className = "hb-contracts-empty";
        setAcText(empty, snap
          ? "No active contracts. Speak with a contract NPC to accept one."
          : "Log in to view contracts.");
        listEl.appendChild(empty);
        // Reset selection + detail block when list goes empty.
        selectedId = 0;
        setAcText(detVal1El, "—");
        setAcText(detVal2El, "—");
        setAcText(detVal3El, "—");
        setAcText(detVal4El, "—");
        setAcText(detDescEl, "Select a contract to view details.");
        actBtn1El.disabled = true;
        actBtn2El.disabled = true;
        actBtn3El.disabled = true;
        return;
      }

      let kept = false;
      for (const c of vm.rows) {
        const row = document.createElement("div");
        row.className = "hb-contracts-row" + (c.complete ? " complete" : "");
        if (selectedId && c.id === selectedId) {
          row.classList.add("selected");
          kept = true;
        }
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
        if (kept && c.id === selectedId) {
          // Refresh detail block from the new row data.
          selectRow(c, row);
        }
      }
      // Selection lost (e.g. abandoned). Clear detail block.
      if (!kept) {
        selectedId = 0;
        setAcText(detVal1El, "—");
        setAcText(detVal2El, "—");
        setAcText(detVal3El, "—");
        setAcText(detVal4El, "—");
        setAcText(detDescEl, "Select a contract to view details.");
        actBtn1El.disabled = true;
        actBtn2El.disabled = true;
        actBtn3El.disabled = true;
      }
    }

    // Wire button clicks.
    actBtn1El.addEventListener("click", () => {
      if (!selectedId) return;
      emit(`[contracts] Map "Contract #${selectedId}" — quest-map waypoint (not wired yet)`);
    });
    actBtn2El.addEventListener("click", () => {
      // Wave F.5 (2026-05-27) — real wire round-trip. Sends
      // `GameAction::AbandonContract` (0x0316). ACE echoes back a
      // `SendClientContractTracker` with `DeleteContract=true` and
      // `rerender()` picks it up via the `contractsUpdated` event.
      if (!selectedId) return;
      const handle = window.__sessionHandle;
      const cid = selectedId;
      if (typeof handle?.abandonContract === "function") {
        try {
          handle.abandonContract(cid >>> 0);
          emit(`[contracts] Abandoning contract #${cid}…`);
        } catch (e) {
          emit(`[contracts] Abandon failed: ${e?.message || e}`);
        }
      } else {
        emit(`[contracts] Abandon unavailable — wasm not connected`);
      }
    });
    actBtn3El.addEventListener("click", () => {
      if (!selectedId) return;
      emit(`[contracts] Mark Redo "Contract #${selectedId}" — request a refresh of the selected daily (game-action not wired yet)`);
    });

    // Wave F.5 (2026-05-27) — subscribe to bus event + initial render.
    const bus = window.__pluginClient?.events;
    let unsubscribe = () => {};
    if (bus && typeof bus.on === "function") {
      const listener = () => {
        try { rerender(); } catch (_) {}
      };
      bus.on("contractsUpdated", listener);
      unsubscribe = () => {
        if (typeof bus.off === "function") bus.off("contractsUpdated", listener);
      };
    }
    rerender();

    // Wave F.5 follow-on (2026-05-27) — kick off the ContractTable
    // DAT prefetch in the background. When it resolves, re-render so
    // the placeholder names flip to the real DAT-backed names. Fire
    // and forget — the panel stays usable even if the prefetch fails.
    (async () => {
      const ok = await ensureContractTablePrefetched();
      if (ok) {
        try { rerender(); } catch (_) {}
      }
    })();

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

    return () => {
      try { unsubscribe(); } catch (_) {}
      root.remove();
    };
  },
};

export const manifest = {
  id: "contracts-panel",
  name: "Contracts",
  icon: "📋",
  iconHidden: true,
  version: "0.3.0",
  description: "Contracts (gmContractsUI 0x21000069 — Wave F.5 wire data + Abandon round-trip)",
};
